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

**Gated on client processing lag, with the backlog as a backstop.** The signal
that matters is how far behind the *client* is, and the backlog cannot see it:
it counts frames still held by guacd, so a frame is invisible there the moment
it reaches the socket, however long the browser then takes to decode and draw
it. On a fast link the queue drains to nothing while the client falls steadily
further behind — and an acknowledgement sent then reports a drained pipeline to
a server that is in fact outrunning the viewer.

`guac_client_get_processing_lag()` is the round trip of the Guacamole `sync`
handshake. It ends at the client after the frame has been processed, and
`user-handlers.c` subtracts an estimate of network round-trip time before
storing it, so what remains is the client's own inability to keep up: decode
cost, compositing, an AVC444 chroma combine. None of that is observable by the
RDP server, and because the network component is already removed, an absolute
threshold is meaningful on a WAN as well as a LAN.

The render thread already waits this same value out before sending the next
frame (`display-render-thread.c`, capped at `GUAC_DISPLAY_MAX_LAG_COMPENSATION`
= 500ms). Gating acknowledgement on it makes the upstream and downstream halves
of the pipeline agree, instead of leaving guacd to absorb the difference in its
own queue until the drop cap discards frames.

Note that FreeRDP cannot report a truthful `queueDepth` — it hardcodes
`QUEUE_DEPTH_UNAVAILABLE` (`rdpgfx_main.c:1149`), with
`SUSPEND_FRAME_ACKNOWLEDGEMENT` as the only alternative. Depth-based flow
control would therefore require patching FreeRDP rather than guacd; delaying
the acknowledgement is the lever available here.

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
| `src/libguac/display-layer.c` | Implement it — main-view frames under `h264_queue_lock` |
| `src/protocols/rdp/rdp.h` | Add `orig_end_frame` |
| `src/protocols/rdp/channels/rdpgfx.c` | Wrap `EndFrame`, hold the ack while clients are behind by lag or backlog |

**Counting is per frame of video, not per queue entry.** An AVC444 picture is
queued as two access units, a main view and the auxiliary view refining its
chroma, so a raw queue length counts the same second of video twice and the
target would mean half as much under AVC444 as under AVC420 — engaging
backpressure at a depth never intended and throttling a stream that was keeping
up. `guac_display_layer_h264_backlog()` therefore counts main-view entries
only, which also keeps the target meaningful if the view count ever changes.

**The lag hold is proportional and computed once, not polled.** Processing lag
is recalculated only when a sync response arrives, a sync is only sent when the
render thread has a frame to flush, and against a lockstep server no further
frame is captured until this acknowledgement goes out. Polling for the lag to
fall therefore blocks the signal it is waiting for, and every hold runs to the
cap no matter how the client is doing — measured as a collapse to 2.1fps under
a 500ms cap, which is just 1000/cap. Holding for the excess (`lag - target`)
instead closes the loop across frames: further behind means proportionally
longer, and as the client catches up the hold shrinks and the rate recovers.
The backlog keeps its poll loop, since the render thread drains it on another
thread while we wait.

**Tuning.** Acknowledgement is held for the amount by which client processing
lag exceeds `GUAC_RDP_H264_LAG_TARGET` (default 50ms), and additionally while
more than `GUAC_RDP_H264_BACKLOG_TARGET` (default 32) frames of video are
queued. Either gate is disabled by setting it to `0`; with both at `0` the hook
returns before taking any lock.

`GUAC_RDP_H264_ACK_MAX_DELAY` (default 400ms) bounds a client that has stopped
draining, not one that is merely behind — the proportional hold already covers
"behind". Sizing it for the latter was measured as a mistake: at 100ms every
frame of ordinary heavy content clamped, the hold became constant rather than
proportional, and the loop could not converge because it was forbidden from
slowing below 1000/cap. Against a lockstep server the cap is still a frame rate
floor (2.5fps at 400ms), but it is now only reached under genuine overload.

**Measured behaviour** against xrdp with xorgxrdp in lockstep, once the hold was
proportional and the cap sized at 400ms — the loop is bimodal and recovers:

| | light content | heavy content |
|---|---|---|
| frame rate | 30.0–30.2 fps | 11–12 fps |
| xorgxrdp send→ack | 18–20ms (max 33) | 74–79ms (max 405) |
| blocked callbacks /100 | 1–7 | 295–355 |
| client rtt mean | 1–8ms | 265–324ms |

It clamps under load and releases when the load drops (12 → 6.4 in transition →
30 sustained → back to 11), which is the distinction between back-pressure and a
runaway. Under light load `idle` tracks xrdp's own `h264_frame_interval` with
`blocked` near zero: the server's frame interval is then the binding constraint
rather than the client, which is the condition that makes a hand-tuned interval
removable.

This is a backstop, not a rate controller, and that distinction sets the value.
The target was originally 4, reasoned from 60fps as "a little over 60ms of
buffered video". Measured against a real xrdp session at ~16fps it was *below*
the depth a healthy client runs at, and tripped continuously: a hold every 5–6
frames, 15–145ms each, ~22% of wall-clock spent deliberately stalled. Frames
arrived in bursts separated by stalls — visibly choppy, while the backlog it
was reacting to was never dangerous. A target inside the working range makes
things worse than no throttling at all.

The value must sit above the depth a healthy session reaches and below the
120-frame drop cap. Both it and `GUAC_RDP_H264_ACK_MAX_DELAY` (default 500ms)
read an environment variable of the same name at first use, so they can be
swept from `guacd.env` with a service restart instead of a rebuild. A target of
`0` disables holding entirely, leaving the drop cap as the only limit — the
control to compare against when deciding whether backpressure earns its place.

The target is resolved *before* the backlog is queried, so `0` costs nothing.
Querying takes `h264_queue_lock`, which the render thread needs to drain the
queue, and doing that once per frame is not free — the same hot-path contention
patch 004 hit by accident. A disabled backstop must be genuinely disabled. The wait is capped at `GUAC_RDP_H264_ACK_MAX_DELAY` (500ms) and
abandoned if the client stops running: an unbounded stall is indistinguishable
to the server from a client that has gone away, so a pathologically slow client
must cost frame rate rather than the session. The render thread drains the
queue on its own, so blocking here does not prevent the backlog from clearing.

**Installed like `SurfaceCommand`**, by testing what is currently installed
rather than a once-only flag: `gdi_graphics_pipeline_init()` reinstalls its own
`EndFrame` on every RDPGFX reconnect (xrdp's login resize causes one), so a
once-only guard would silently stop applying backpressure for the rest of the
session.

**Not a replacement for a sane source frame rate.** Back-pressure reacts to
lag; it does not search for the rate that minimises cost per frame. A client's
per-frame cost is not constant — pushed past its comfortable rate it enters a
region where decode queueing and GPU contention make each frame more expensive,
so throughput falls while latency climbs. The loop then holds longer, chasing an
operating point that moved because of its own input rate. It still converges,
but to a worse point than it started from, because nothing in it knows the lower
rate was cheaper per frame.

Measured by halving xrdp's `h264_frame_interval` from 33ms to 16ms, on the same
client and content class, with this patch active throughout:

| | interval 33 | interval 16 |
|---|---|---|
| frame rate | 30.0–30.2 fps | 24.7–29.5 fps |
| blocked callbacks /100 | 1–7 | 130–172 |
| client rtt mean | 1–8ms | 77–111ms |
| client rtt max | 11–36ms | 317–543ms |

Fewer frames delivered, for more than an order of magnitude more latency. The
low round trip under the 33ms cap meant the client was comfortable at 30fps, not
that it had capacity for 60. So the server's frame interval and this patch do
different jobs: the interval selects the operating point, back-pressure absorbs
deviation around it. Removing the interval on the grounds that back-pressure
makes it redundant makes things worse.

**Scope — this throttles frame rate, not bitrate.** Whether the server also
lowers its quantiser is a decision its own encoder makes from its own view of
the link, and that view is of the guacd↔server leg, which is typically a LAN.
Influencing it means feeding the server an end-to-end figure instead of the
LAN one it measures. The MS-RDPBCGR network auto-detect PDUs are the obvious
route, but `rdpAutoDetect` is not hookable the way `EndFrame` is: in the client
role FreeRDP's responses are sent by static functions called directly from
`autodetect.c`, and the public callbacks fire on *receive* or in the server
role, with `ClientBandwidthMeasureResult` arriving only after the PDU is
serialised. Substituting a figure means patching FreeRDP, not guacd.

## 013-rdp-avc420-only.patch

**Problem:** there is no way to ask for AVC420. `enable-h264` sets `GfxH264` and
`GfxAVC444` together, so every H.264 connection advertises AVC444 and takes
whatever the server picks.

That default exists for Windows, and is right for it: FreeRDP emits the RDPGFX
V10 capability sets only when `GfxAVC444` is set, and Windows offers no H.264
at all below V10 (verified by advertising AVC420 alone at V8.1 and receiving
only CLEARCODEC and CAPROGRESSIVE). But it is not right everywhere. AVC444
encodes each picture as two views, so the client pays a second decode per
frame, plus a per-frame WebGL2 combine if it recovers the 4:4:4 chroma rather
than discarding it — measured at ~290ms of client-side round trip on a 4 MP
display, which no amount of server-side pacing can shorten.

Against a client rendering at 2x scale that buys little. A 4:2:0 chroma block
covers a single logical pixel at that density, so most of what 4:4:4 offers has
already been paid for in pixels. Native Resolution and AVC444 largely purchase
the same thing, and running both purchases it twice.

**Mechanism: an `avc444` connection parameter, defaulting to automatic.**
The right answer differs per target rather than per guacd — a Windows entry
wants AVC444 forced on whatever its scale, while an xrdp entry beside it does
not — so the decision is carried per connection: `1` always advertises, `0`
never, and absent defers to the desktop scale. rustguac exposes it per entry as
Automatic / Always / Never.

`GUAC_RDP_DISABLE_AVC444` still sets the deployment-wide default for
connections that do not specify (`1` never, `0` always), and is overridden by
any connection that does.

**The automatic rule is keyed on whether the session is HiDPI.** rustguac sets
`desktop-scale` to 140 or 180 only when Native Resolution is enabled *and* the
browser reported a HiDPI device pixel ratio (`src/api.rs`), so a non-zero scale
is already a per-connection signal that the client is rendering in physical
pixels. AVC444 is advertised at 100% or unset, and not above it — the density
has bought most of the chroma already, and the decoder being asked to do twice
the work is the same one drawing four times the pixels.

`GUAC_RDP_DISABLE_AVC444` overrides in both directions: `1` never advertises
AVC444, `0` always does. Forcing it on is what a Windows host needs, since it
offers no H.264 below RDPGFX V10 and only `GfxAVC444` causes those sets to be
emitted.

Whichever way the decision goes, what happens next is the server's choice, and
the two differ:

- **xrdp** selects H.264 from the V8.1 set via `AVC420_ENABLED`, then
  `xrdp_mm_egfx_caps_avc444()` has no case for V8.1 and returns 0 — so that
  connection gets AVC420 while other clients on the same session still
  negotiate AVC444 for themselves. Per-connection, no `sesman.ini` change.
- **Windows** offers nothing below V10, so H.264 is lost entirely and the
  session falls back to the tile path.

Hence the automatic rule covers the case where the trade is clearly worth it —
a HiDPI client, which is also the expensive one — and a Windows entry overrides
it to Always.

| File | Change |
|------|--------|
| `src/protocols/rdp/settings.c` | `avc444` argument, and `guac_rdp_avc444_enabled()` guarding `GfxAVC444` on both the FreeRDP 2 and 3 paths |
| `src/protocols/rdp/settings.h` | `avc444` setting, `GUAC_RDP_AVC444_AUTO`, `GUAC_RDP_AVC444_SCALE_THRESHOLD` |

Precedence is per-connection setting, then `GUAC_RDP_DISABLE_AVC444`, then the
desktop scale.
| `src/protocols/rdp/channels/rdpgfx.c` | Correct the caps-confirm warning, which named an unimplemented variable |

**Not done via `AVC_THINCLIENT`.** That flag (0x40) is the protocol's own way
to ask for AVC420, but it is advisory, FreeRDP attaches it only from capability
version 10.3 onward, and xrdp ignores it outright —
`XR_RDPGFX_CAPS_FLAG_AVC_THINCLIENT` is defined in `xrdp/xrdp_egfx.h` and used
nowhere. Clearing `GfxAVC444` is structural instead: the V10+ sets are never
advertised, so AVC444 is not a codec the server can select.

The warning corrected here previously suggested `GUAC_RDP_H264_CAPS_FILTER=1`,
which was never implemented — the string appeared only inside that log message.

---

## 014-rdpgfx-op-trace.patch — RDPGFX surface-operation trace

Diagnostics only; changes no rendering behaviour. Written to catch an
intermittent fault: parts of a Windows session going black after minutes of
being idle, restored only by resizing. It is not reproducible on demand, so the
logging has to be cheap enough to leave enabled and specific enough to identify
the cause from a single occurrence.

**What it records.** H.264 passthrough deliberately skips the GDI decode
(`004`), so `gdi->primary_buffer` — the buffer guacd encodes from — holds no
pixels for any region the server delivered as H.264, however correct that
region looks in the browser, which painted it from its own decoder. Every
RDPGFX operation that copies pixels between surfaces, stores them in the cache,
or restores them from it therefore reads or writes a buffer guacd knows to be
blank, and can move black over a working picture. Which of them a given host
uses is otherwise invisible: `004` logs surface *commands* only.

| Operation | Logged |
|-----------|--------|
| `ResetGraphics`, `CreateSurface`, `DeleteSurface` | Always (rare, and a reset is what a desktop switch — lock screen, UAC — looks like on the wire) |
| `SolidFill`, `SurfaceToSurface`, `CacheToSurface` | First of the session, then per-operation while passthrough is active — capped at 10 lines per 10s so the detail survives being left on |
| `SurfaceToCache` | First of the session |
| All four counts | Summarised at INFO every 10s, alongside the number of H.264 frames passed through undecoded |

`gdi.c` additionally warns when a desktop resize flushes the full-layer repaint
added by `005` while passthrough is active — that repaint is encoded from the
blank buffer, and `RefreshRect` cannot undo it because the RDPGFX surface cache
ignores `RefreshRect`. See `sol1/rustguac#118`.

| File | Change |
|------|--------|
| `src/protocols/rdp/rdp.h` | Per-connection original callbacks and operation counts |
| `src/protocols/rdp/channels/rdpgfx.c` | Seven logging wrappers, installed with the same identity guard as `004` |
| `src/protocols/rdp/gdi.c` | Warn when a resize repaint is flushed from a buffer passthrough left blank |
