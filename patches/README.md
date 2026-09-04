# guacamole-server patches

These patches are applied to the [apache/guacamole-server](https://github.com/apache/guacamole-server) source tree before building guacd. They fix compilation and runtime issues when building against FreeRDP 3.x on Debian 13 (Trixie).

## 001-freerdp3-debian13.patch

**Problem:** guacamole-server 1.6.1 fails to compile against FreeRDP 3.15+ (as shipped in Debian 13) due to:

1. **Autoconf feature detection failure** — FreeRDP 3.15 marks `codecs_free()` as deprecated. The `-Werror` flag in `configure.ac` causes all compile-time feature-detection tests to fail, cascading into 10+ undefined macros and wrong `#ifdef` code paths.

2. **Deprecated function pointer API** — FreeRDP 3.x deprecates direct struct member access for `->input->KeyboardEvent()`, `->input->MouseEvent()`, etc. behind `WITH_FREERDP_DEPRECATED`. The safe replacement functions are `freerdp_input_send_keyboard_event()`, `freerdp_input_send_mouse_event()`, etc.

3. **NULL pointer dereference in display channel** — FreeRDP 3.x fires PubSub `ChannelConnected` events before `guac_rdp_disp` is allocated, causing a segfault when the callback writes to `disp->requested_width` (offset 0x18 of NULL).

**Files patched:**

| File | Fix |
|------|-----|
| `configure.ac` | Add `-Wno-error=deprecated-declarations` to both FreeRDP 2.x and 3.x PKG_CHECK_MODULES blocks so autoconf feature detection works |
| `src/protocols/rdp/Makefile.am` | Add `-Wno-error=deprecated-declarations` to all three CFLAGS targets |
| `src/protocols/rdp/tests/Makefile.am` | Same for test CFLAGS |
| `src/protocols/rdp/keyboard.c` | Replace `->input->KeyboardEvent()`, `->input->UnicodeKeyboardEvent()`, `->input->SynchronizeEvent()` with safe API functions |
| `src/protocols/rdp/input-queue.c` | Replace all `->input->MouseEvent()` calls with `freerdp_input_send_mouse_event()` |
| `src/protocols/rdp/channels/disp.c` | Add NULL guards in `guac_rdp_disp_channel_connected()` and `guac_rdp_disp_channel_disconnected()` |

## 002-kerberos-nla.patch

**Feature:** Adds Kerberos NLA authentication support to guacd's RDP protocol, based on [GUACAMOLE-2057](https://issues.apache.org/jira/browse/GUACAMOLE-2057) ([PR #581](https://github.com/apache/guacamole-server/pull/581)). This allows RDP connections to use Kerberos instead of NTLM for NLA, which is required as Microsoft phases out NTLM.

Three new connection parameters:

| Parameter | Values | FreeRDP3 Setting |
|-----------|--------|------------------|
| `auth-pkg` | `""` (negotiate), `"kerberos"`, `"ntlm"` | `FreeRDP_AuthenticationPackageList` |
| `kdc-url` | KDC server URL (optional) | `FreeRDP_KerberosKdcUrl` |
| `kerberos-cache` | Path to ccache file (optional) | `FreeRDP_KerberosCache` |

**Files patched:**

| File | Fix |
|------|-----|
| `src/protocols/rdp/settings.h` | Add `guac_rdp_auth_package` enum, add `auth_pkg`, `kdc_url`, `kerberos_cache` fields to `guac_rdp_settings` |
| `src/protocols/rdp/settings.c` | Add connection parameter parsing, FreeRDP3 settings push, memory cleanup |

**Differences from upstream PR #581:**
- Dropped FreeRDP2 code path (not needed on Debian 13)
- Fixed `guac_strdup()` leak in `freerdp_settings_set_string()` calls (FreeRDP3 copies internally)
- Fixed typos ("NTML" -> "NTLM", "negotiatoin" -> "negotiation")

**Requires:** FreeRDP 3.x built with Kerberos support (`-DWITH_KRB5=ON`). Debian 13's `freerdp3-dev` includes this by default.

## 003-null-guard-and-config-h.patch

**Problem:** Two related issues causing RDP display resize to silently fail:

1. **Missing `config.h` include** — Several RDP channel source files and `input.c` do not include `config.h`, so `ENABLE_COMMON_SSH` is undefined in those compilation units. This causes the `guac_rdp_client` struct to have a different layout (missing 3 SSH pointer fields = 24 bytes), making all field accesses after the `#ifdef ENABLE_COMMON_SSH` block read/write wrong memory offsets. Specifically, `rdp_client->disp` reads NULL (actually the `recording` field), so RDP display resizing silently fails.

2. **Early size instructions** — Browser may send `size` instructions before the RDP connection is fully established, causing NULL pointer dereferences in the resize handler.

**Files patched:**

| File | Fix |
|------|-----|
| `src/protocols/rdp/channels/common-svc.c` | Add `#include "config.h"` |
| `src/protocols/rdp/channels/disp.c` | Add `#include "config.h"`, add NULL guard in `guac_rdp_disp_set_size()` |
| `src/protocols/rdp/channels/pipe-svc.c` | Add `#include "config.h"` |
| `src/protocols/rdp/channels/rdpei.c` | Add `#include "config.h"` |
| `src/protocols/rdp/channels/rdpgfx.c` | Add `#include "config.h"` |
| `src/protocols/rdp/input.c` | Add `#include "config.h"`, add NULL guard in `guac_rdp_user_size_handler()` |

## 004-h264-passthrough.patch

**Feature:** end-to-end H.264. When an RDP server sends H.264 over the Graphics Pipeline, the raw NAL units are forwarded to the browser's WebCodecs `VideoDecoder` instead of being decoded by guacd and re-encoded as JPEG/PNG/WebP.

Measured with 1080p video playing, guacd session CPU over 30s:

| | decode + re-encode | passthrough |
|---|---|---|
| xrdp (AVC420) | ~100% of a core | **2.0%** |
| Windows 11 (AVC444) | 90.6% of a core | **2.1%** |

**How it works.** `guac_rdp_gfx_surface_command()` wraps FreeRDP's SurfaceCommand handler, copies the NAL data out of `cmd->extra` before the original handler can free it, and skips the GDI decode entirely for commands it captured. The frames are queued on the display layer and sent during the frame flush as a custom `h264` instruction:

```
h264 <stream> <layer> <keyframe> <x> <y> <width> <height>
     <view> <numrects> [<x> <y> <width> <height>]...
```

Region rects identify which parts of the decoded picture are valid — the picture is always full-surface sized, so a server encoding only part of the screen leaves the rest holding nothing meaningful. A count of zero means the whole picture is valid.

**AVC444.** Windows only offers H.264 when the client advertises the AVC444 capability: FreeRDP emits the RDPGFX V10 capability sets only when `GfxAVC444` is set, and Windows offers nothing below V10 (verified by advertising AVC420 alone at V8.1 and receiving zero H.264 — only CLEARCODEC and CAPROGRESSIVE). AVC444 is therefore always advertised, and AVC444 streams are handled rather than avoided.

An AVC444 picture is split across two views inside **one** H.264 sequence — FreeRDP decodes both through the same `H264_CONTEXT`. Both views must therefore reach the client's decoder, in order; dropping either leaves later pictures referencing data it never received, which renders as blocky wrongly-coloured macroblocks and reports **no decode error**, since what arrives is well formed. The `view` field marks which is which:

| view | meaning | drawn |
|------|---------|-------|
| 0 | AVC420, or the main view of AVC444 | yes |
| 1 | AVC444 auxiliary chroma, v1 layout | no |
| 2 | AVC444 auxiliary chroma, v2 layout | no |

The client decodes every view and draws view 0, combining the auxiliary view's chroma into it for full 4:4:4 (`static/guac/Yuv444.js`); it falls back to drawing view 0 alone, at 4:2:0 chroma, where WebGL2 is unavailable. On the test host auxiliary views were 3.6% of frames.

**Threading.** The frame queue has its own lock, deliberately **not** the display's `pending_frame.lock`. The render thread holds that one across the whole flush including image encoding, so queueing under it blocked the protocol thread — which for RDP is the thread that sends `RDPGFX_FRAME_ACKNOWLEDGE`, and a server throttles when frames go unacknowledged. The NAL copy happens before locking, and the flush detaches the queue and sends outside it.

**Frame signalling.** Two non-obvious requirements, both of which stall the stream if missed:

- Signal via `rdp_client->gdi_modified`, not a direct `notify_modified()`. EGFX has no explicit frame boundary, so per-surface-command notifies keep `FRAME_MODIFIED` permanently set and every flush waits out `MAX_FRAME_DURATION` (100ms).
- An H.264-only frame must count toward `frame_nonempty`, or no NOP is enqueued, no worker runs, and `sync` is never sent — which stops `display.flush()` client-side and inflates `guac_client_get_processing_lag()`.

**Keyframes** are detected as an IDR slice (NAL type 5) only. Treating an SPS (type 7) as sufficient marks ordinary delta frames as keyframes, and handing a decoder a delta labelled `key` makes it discard queued work.

**Configuration:** none. Passthrough follows the per-connection `enable-h264` argument, which rustguac sets from the connection entry. There are no environment variables.

**Requires:** a server sending H.264 over RDPGFX, and a browser with WebCodecs (Chrome/Edge 94+, Firefox 130+). See `docs/rdp-h264.md` for the Windows host settings, which are not optional.

**Files patched:**

| File | Change |
|------|-----|
| `src/libguac/guacamole/display.h` | `guac_display_layer_set_h264()`, view constants |
| `src/libguac/display-priv.h` | H.264 frame queue and its lock on the layer |
| `src/libguac/display-layer.c` | Queue frames without blocking on the display lock |
| `src/libguac/display-layer-list.c` | Init/destroy the queue lock; free queued frames |
| `src/libguac/display-plan.c` | Send queued frames during flush; walk pending-frame layers |
| `src/libguac/display-flush.c` | Count H.264-only frames toward frame_nonempty |
| `src/protocols/rdp/channels/rdpgfx.c` | Capture NAL data, skip the GDI decode, forward both AVC444 views |
| `src/protocols/rdp/rdp.h` | Store the original SurfaceCommand/CapsConfirm callbacks |
| `src/protocols/rdp/settings.c` | Advertise GfxH264 and GfxAVC444 when enable-h264 is set |
| `src/protocols/rdp/settings.h` | `enable_h264` connection parameter |

## 005-rdp-resize-dirty-flush.patch

**Problem:** After a dynamic RDP display resize (browser window resized,
`resize-method=display-update`), regions of the desktop render as solid black
until something repaints them. `guac_rdp_gdi_desktop_resize()` resizes the
FreeRDP GDI buffer and the guac display layer but never marks the layer dirty,
so `guac_display_layer_close_raw()` flushes nothing and the client keeps its
stale/blank canvas for the resized layer. See [sol1/rustguac#118](https://github.com/sol1/rustguac/issues/118) (reported by @Bails309, who diagnosed the root cause and supplied the fix).

**Fix:** In `guac_rdp_gdi_desktop_resize()`, after the layer resize and before
`guac_display_layer_close_raw()`:

1. Mark the entire layer dirty (`guac_rect_init(&current_context->dirty, ...)`) so a full repaint is flushed to the client.
2. Issue a `RefreshRect` for the full new desktop so the server re-sends authoritative pixels (legacy bitmap update path).

**Scope:** Fixes the legacy bitmap update path, which is rustguac's default
(`enable_gfx` defaults to false). The RDPGFX surface cache ignores
`RefreshRect`, so GFX sessions are not addressed by this patch; in practice
GFX sessions have not reproduced the artifact.

**Files patched:**

| File | Fix |
|------|-----|
| `src/protocols/rdp/gdi.c` | Mark layer dirty + `RefreshRect` after resize in `guac_rdp_gdi_desktop_resize()` |

## 007-rdp-disp-mod16.patch

**Problem:** When the negotiated RDP display dimensions aren't a multiple of 16,
the H.264 graphics pipeline (16x16 macroblocks) pads encoded frames with all-zero
YUV macroblocks. The chroma plane straddling the real/padding boundary contaminates
the bottom-most real chroma row, which after client-side bilinear scaling spreads
into a saturated green band (`YUV(0,0,0)` -> RGB ~ `#008700`) along the bottom edge.
Mod-2 rounding (the upstream default) is insufficient — the whole bottom 16-row
macroblock strip is affected.

**Fix:** In `guac_rdp_disp_set_size()`, round both width and height down to a
multiple of 16 (replacing the existing "width must be even" mod-2 rounding). Costs
up to 15px of unused canvas margin, avoidable by sizing the viewport so the
requested height is already mod-16.

Ported from [pletch/guacamole-server@b28bdac](https://github.com/pletch/guacamole-server/commit/b28bdac0) (`fixes-1.6.0`). Complements `005-rdp-resize-dirty-flush.patch`: 005 fixes black regions on the legacy bitmap path, 007 fixes the green band on the H.264/GFX path.

**Files patched:**

| File | Fix |
|------|-----|
| `src/protocols/rdp/channels/disp.c` | Round display dimensions down to mod-16 in `guac_rdp_disp_set_size()` |

## 008-spice-protocol.patch

**Feature:** Adds native SPICE protocol support (`libguac-client-spice`), vendored from the upstream PR [apache/guacamole-server#688](https://github.com/apache/guacamole-server/pull/688) ([GUACAMOLE-261](https://issues.apache.org/jira/browse/GUACAMOLE-261)). Enables connecting to SPICE displays (e.g. Proxmox VE / QEMU consoles). Requires `libspice-client-glib-2.0-dev` (>= 0.38) at build time; guacd is configured `--with-spice`.

Vendored as the diff of the PR branch against its merge-base with our pinned guacd. The PR's incidental, non-SPICE change to `src/terminal/terminal.c` (SSH terminal keyboard-modifier handling) is **excluded** here: it is unrelated to SPICE and conflicted with our pinned base. The bundled `guacclip` tool is included in the source but not built (`--disable-guacclip`, matching how we treat guacenc/guaclog); see [sol1/rustguac#181](https://github.com/sol1/rustguac/issues/181) for a possible future clipboard-audit feature.

**Files patched:** new `src/protocols/spice/*` and `src/guacclip/*` trees, plus additive hooks in `configure.ac`, `Makefile.am`, `src/libguac/*` (protocol constants, user handlers, rect), and per-protocol `input.c`.

## 009-spice-empty-port.patch

**Bug:** For TLS-only SPICE (e.g. Proxmox VE consoles) rustguac sends an empty `port` connect arg so guacd connects via `tls-port`. `guac_spice_session_configure()` set the spice-gtk `port` property whenever `settings->port != NULL`, but the parsed value for an omitted arg is an empty string (non-NULL), so spice-gtk logged `GSpice: Invalid port value` on every channel while parsing `""`.

**Fix:** Only set the plain `port` when it is non-empty (`settings->port[0] != '\0'`), so TLS-only connections use `tls-port` cleanly with no warning.

**Files patched:** `src/protocols/spice/auth.c`.

## 010-rdp-multimonitor.patch

**Feature:** Adds RDP multi-monitor support. A `secondary-monitors` arg enables it; the Display Update module (`channels/disp.c`) tracks a per-monitor layout (tiled left-to-right, top-aligned, with RDP-valid geometry) and sends the full `DISPLAY_CONTROL_MONITOR_LAYOUT` array via `SendMonitorLayout` instead of a single monitor. The RDP host extends the desktop across the monitors and streams one combined framebuffer, so no client-side compositing is needed (unlike SPICE). guacd advertises `secondary-monitors` on user join and publishes the `multimon-layout` layer parameter so a multi-monitor client can split the framebuffer into per-monitor windows. Reuses the protocol-agnostic client machinery added with `008`.

**Files patched:** `src/protocols/rdp/settings.{c,h}`, `src/protocols/rdp/channels/disp.{c,h}`, `src/protocols/rdp/input.c`, `src/protocols/rdp/user.c`.

## Applying patches

Patches are applied automatically by all build scripts (`build-deb.sh`, `build-rpm.sh`, `install.sh`, `dev.sh`, `Dockerfile`). To apply manually:

```bash
cd ../guacamole-server
git apply ../rustguac/patches/001-freerdp3-debian13.patch
```

To check if patches are already applied:

```bash
cd ../guacamole-server
git apply --check ../rustguac/patches/001-freerdp3-debian13.patch 2>&1 || echo "Already applied or conflict"
```

## Adding new patches

1. Make changes in the `../guacamole-server` working tree
2. Export: `cd ../guacamole-server && git diff > ../rustguac/patches/NNN-description.patch`
3. Patches are applied in numeric order by the build scripts

## 011-rdp-dpi-scaling.patch

**Feature:** a `desktop-scale` RDP parameter, sent to the server as
`desktopScaleFactor` so the remote session renders its UI at a matching DPI.

Without it, asking for a framebuffer in physical rather than logical pixels —
which is what makes text render sharply on a HiDPI display — produces a desktop
whose every icon and glyph is half the size it should be. guacd had no way to
request DPI scaling at all: `channels/disp.c` pins `DesktopScaleFactor` and
`DeviceScaleFactor` to 0, and the existing `dpi` parameter only rescales the
requested width and height, which `settings.c` skips whenever an explicit width
and height are supplied.

**How it works.** `desktop-scale` is parsed as a percentage and validated
against the 100–500 range of MS-RDPBCGR 2.2.1.3.2. When non-zero,
`guac_rdp_push_settings()` sets `FreeRDP_DesktopScaleFactor` to it and
`FreeRDP_DeviceScaleFactor` to a legal companion value; FreeRDP writes both
into the client core data (`gcc.c`). Zero, the default, leaves FreeRDP's
defaults alone and the session behaves exactly as before.

**Only 100, 140 and 180 work,** for two compounding reasons, and
`guac_rdp_normalize_desktop_scale()` snaps the request to the nearest of them.

MS-RDPBCGR 2.2.1.3.2 already restricts `deviceScaleFactor` to those three, and
a server discards the desktop factor along with an out-of-range device factor
rather than degrading. On top of that, **FreeRDP transposes the pair** when it
synthesises the single-monitor definition that every windowed session uses
(`libfreerdp/core/settings.c`, introduced in `401f81683` and present through
3.x):

```c
const UINT32 desktopScaleFactor = get(FreeRDP_DeviceScaleFactor);   /* reads Device */
const UINT32 deviceScaleFactor  = get(FreeRDP_DesktopScaleFactor);  /* reads Desktop */
...
monitor.attributes.desktopScaleFactor = desktopScaleFactor;
monitor.attributes.deviceScaleFactor  = deviceScaleFactor;
```

So any pair of differing values reaches the server backwards: a request for
200%/100% arrives as `deviceScaleFactor=200`, which is illegal, and the whole
pair is dropped. Setting both factors to the *same* value is immune to the
transposition — which is exactly why FreeRDP's own `/scale` accepts only these
three and sets both at once. `static/client.html` snaps its framebuffer factor
to match (1.4 or 1.8), so the extra pixels and the session scaling agree and
physical sizes stay correct.

**Scope.** RDP only, and Windows-only in practice. An X11 desktop behind xrdp
has no per-connection DPI negotiation; scaling there has to be arranged inside
the session (for example via `xfconf-query -c xsettings -p
/Gdk/WindowScalingFactor`, or `Xft.dpi` for non-integer factors).

**Client side.** `static/client.html` sends `desktop_scale` on the connect
request, and only when it actually asked for a device-pixel framebuffer — see
`localStorage.rgNativeRes`, which is off by default.

## 012-rdpgfx-frame-ack-backpressure.patch

**Problem:** H.264 passthrough has no adaptive quality, because guacd is not
the encoder.

Everywhere else it is. `guac_display_suggest_quality()` scales JPEG/WebP
quality from 90 down to 30 as client processing lag rises from 20ms to 80ms,
and the render thread waits that lag out before starting the next frame
(`display-worker.c`, `display-render-thread.c`). Both read the same signal: the
round trip of the Guacamole `sync` handshake.

In passthrough guacd re-encodes nothing, so there is no quality to lower. The
RDP server keeps sending at whatever rate it chose, frames pile up on the
layer's H.264 queue, and at 120 frames `guac_display_layer_set_h264()` drops
the oldest. A drop breaks the decoder's reference chain, so every later frame
is discarded until the next IDR — the overload surfaces as a stall seconds
after the moment that caused it, and costs far more than slowing down would
have.

**Mechanism:** the party that *can* slow down is the server, and MS-RDPEGFX
already provides the lever. A server applies flow control to unacknowledged
graphics frames, and FreeRDP sends `RDPGFX_FRAME_ACKNOWLEDGE` from
`rdpgfx_recv_end_frame_pdu()` immediately after `context->EndFrame` returns.
Wrapping `EndFrame` therefore controls when the acknowledgement goes out.

Patch 004 found this by accident and from the wrong side: queueing frames under
the display-level `pending_frame.lock` blocked the same thread, and the
resulting throttle looked like a low source frame rate rather than a stall in
guacd. This patch does it deliberately and with a bound.

| File | Change |
|------|--------|
| `src/libguac/guacamole/display.h` | Declare `guac_display_layer_h264_backlog()` |
| `src/libguac/display-layer.c` | Implement it — queue length under `h264_queue_lock` |
| `src/protocols/rdp/rdp.h` | Add `orig_end_frame` |
| `src/protocols/rdp/channels/rdpgfx.c` | Wrap `EndFrame`, hold the ack while clients are behind |

**Tuning.** Acknowledgement is held while more than `GUAC_RDP_H264_BACKLOG_TARGET`
(4) frames are queued — a little over 60ms of video at 60fps, enough to absorb
an ordinary burst without the server noticing, and far short of the 120-frame
drop cap. The wait is capped at `GUAC_RDP_H264_ACK_MAX_DELAY` (500ms) and
abandoned if the client stops running: an unbounded stall is indistinguishable
to the server from a client that has gone away, so a pathologically slow client
must cost frame rate rather than the session. The render thread drains the
queue on its own, so blocking here does not prevent the backlog from clearing.

**Installed like `SurfaceCommand`**, by testing what is currently installed
rather than a once-only flag: `gdi_graphics_pipeline_init()` reinstalls its own
`EndFrame` on every RDPGFX reconnect (xrdp's login resize causes one), so a
once-only guard would silently stop applying backpressure for the rest of the
session.

**Scope — this throttles frame rate, not bitrate.** Whether the server also
lowers its quantiser is a decision its own encoder makes from its own view of
the link, and that view is of the guacd↔server leg, which is typically a LAN.
Influencing it means answering the MS-RDPBCGR network auto-detect PDUs with an
end-to-end figure instead (`rdpAutoDetect`'s `RTTMeasureResponse` and
`ClientBandwidthMeasureResult` are hookable the same way) — a separate patch.
