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

## 004-h264-display-worker.patch

**Feature:** H.264 passthrough via guac_display worker integration. When the RDP server sends AVC420 encoded frames (H.264), the raw NAL units are passed through to the browser's WebCodecs VideoDecoder instead of being decoded server-side and re-encoded as JPEG/PNG/WebP.

**AVC420 only — AVC444 is deliberately disabled.** The passthrough forwards a single H.264 bitstream per surface command. AVC420 carries a complete YUV420 frame, which WebCodecs decodes directly. AVC444 instead splits the image across two bitstreams (`bitstream[0]` luma/main view + `bitstream[1]` auxiliary chroma) to reconstruct YUV444; the passthrough only forwards `bitstream[0]`, so a Windows host that negotiated AVC444 renders as a corrupted luma+chroma split — two blocks with green and magenta casts. We therefore advertise `GfxH264` **without** `GfxAVC444`/`GfxAVC444v2` so the server always uses AVC420. (RemoteFX/RFX is unaffected — it is a separate codec path and renders correctly.) Properly supporting AVC444 would require decoding both bitstreams and recombining the chroma planes in the browser (e.g. a second VideoDecoder + a WebGL merge shader), which is not implemented.

**Architecture:** The SurfaceCommand callback intercepts H.264 data and stores it on the display layer. During the normal frame flush cycle (`guac_display_plan_apply`), the H.264 data is sent to clients as a custom `h264` instruction before worker threads start encoding. All IMG operations for the H.264 layer are skipped, eliminating the decode→re-encode overhead.

This approach avoids the socket contention issue that occurred when H.264 was sent directly from FreeRDP's SurfaceCommand callback thread, which raced with guac_display's worker threads writing to the same socket.

**Files patched:**

| File | Fix |
|------|-----|
| `src/libguac/display-priv.h` | Add H.264 buffer fields to `guac_display_layer` (data, length, keyframe, rect) |
| `src/libguac/guacamole/display.h` | Add `guac_display_layer_set_h264()` public API |
| `src/libguac/display-layer.c` | Implement `guac_display_layer_set_h264()` with lock management |
| `src/libguac/display-layer-list.c` | Free H.264 data in layer cleanup |
| `src/libguac/display-plan.c` | Send H.264 data during plan apply, skip IMG ops for H.264 layers |
| `src/protocols/rdp/channels/rdpgfx.c` | Wrap SurfaceCommand to store H.264 on display layer after GDI decode |
| `src/protocols/rdp/settings.c` | Enable GfxH264 (AVC420) in FreeRDP settings; leave GfxAVC444 disabled (see AVC420-only note above) |

**Requires:** RDP server with H.264 support (xrdp with x264, or Windows with AVC hardware encoder). Browser must support WebCodecs VideoDecoder (Chrome/Edge 94+, Firefox 130+).

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

## 011-h264-skip-decode.patch

**Status: experimental / unmeasured in production.** Requires `004`.

**Problem:** `004` skips the JPEG/PNG/WebP re-encode but still runs the full software H.264 decode — `guac_rdp_gfx_surface_command()` always calls the original GDI handler, which reaches `avc420_decompress()`. Those pixels are then discarded, because `guac_display_plan_apply()` suppresses every IMG operation for the layer. Profiling a 1080p xrdp session (guacd session child, `top -H`, cumulative CPU) found:

| Thread | Share | Work |
|---|---|---|
| `display-render` | ~50% | dirty-region diffing + plan building on discarded pixels |
| `rdp-worker` ×3 | ~50% | FreeRDP client thread + libavcodec decode threads |
| `display-wrk` ×2 | ~0.2% | image encoding (correctly eliminated by `004`) |

The decode is software: Debian's libfreerdp3 is built `WITH_VAAPI=OFF` (VAAPI decode is off by default upstream; the nearby `ON` default is `WITH_VAAPI_H264_ENCODING`, encoder-only and unused by guacd as a client).

**Why the decode could not simply be removed:** it is load-bearing. `004` drives the flush by walking `plan->ops`, and `display-flush.c` only calls `guac_display_plan_apply()` when the plan is non-NULL — and `guac_display_plan_create()` returns NULL when nothing is dirty. So decode → dirty pixels → plan ops → flush. Dropping the decode alone stalls the H.264 stream entirely.

**Architecture:** The flush moves out of `guac_display_plan_apply()` into `guac_display_end_multiple_frames()`, where it runs regardless of whether a plan was produced. It is placed *before* `plan_apply()` so it still writes to the socket while the worker threads are provably idle — the `defer_frame` check earlier in the same function has already established that the ops FIFO is empty and `active_workers` is zero, and `plan_apply()` is what enqueues the work that wakes them. This preserves the socket-contention fix that motivated `004`'s placement. Layers are found by walking `display->pending_frame.layers` (the pending frame write lock is already held there) instead of `plan->ops`, and a per-layer `h264_active` flag replaces the `h264_layers[8]` array, also removing its silent 8-layer cap.

**Frame signalling:** with the decode skipped, `guac_rdp_gdi_end_paint()` never runs, so nothing would mark the display modified and the queued frames would sit unsent. The wrapper therefore raises `rdp_client->gdi_modified` — exactly the flag `end_paint` would have raised — rather than calling `guac_display_render_thread_notify_modified()` directly. This matters: EGFX has no explicit frame boundary (`guac_rdp_gdi_surface_frame_marker` serves the legacy surface-bits path), so `gdi_modified` batched by the main RDP event loop is the only pacing signal. Notifying per surface command instead keeps `FRAME_MODIFIED` permanently set at 60fps, which stops the render thread's frame-accumulation loop from settling and delays every flush until `GUAC_DISPLAY_RENDER_THREAD_MAX_FRAME_DURATION` (100ms) — observed in testing as heavily laggy keyboard and window interaction despite correct, much-reduced CPU.

**Frame boundaries:** `guac_client_end_multiple_frames()` — which emits the `sync` instruction — is sent only by a display worker thread (`display-worker.c`), and workers only run if an operation was enqueued. That enqueue is gated on `frame_nonempty`, which `PFW_LFW_guac_display_frame_complete()` sets only when layer pixels actually changed. With the decode skipped there are never any pixel changes, so without care no `sync` is ever sent. That is fatal on the client: `Client.js`'s `sync` handler is what calls `display.flush()`, and the client's own sync reply (which feeds `guac_client_get_processing_lag()`) is inside that callback — so no sync means nothing renders *and* guacd's lag estimate inflates, making the render thread wait longer still. `PFW_guac_display_flush_h264()` therefore returns whether it sent anything, and `display-flush.c` ORs that into `frame_nonempty` so an H.264-only frame still enqueues the NOP that produces a frame boundary.

**Enabling:** opt-in via `GUAC_RDP_H264_SKIP_DECODE=1` in guacd's environment, so a single build can be A/B tested. Unset, behaviour is identical to `004`. Only H.264 surface commands are skipped; RemoteFX, planar, and progressive commands are always decoded normally.

**Known risk — mixed codecs.** With `order = ["H.264", "RFX"]` in `gfx.toml`, a server may emit RemoteFX surface commands alongside H.264. `plan_apply` skips *all* ops for a layer that had H.264 sent, so RFX regions in such a frame would be dropped. This hazard exists in `004` today and is not introduced here, but skipping the decode makes it more likely to be noticed. Test a session that falls back to RFX before relying on this. A proper fix would skip only ops overlapping the H.264 rect.

**Related client-side bug (not fixed here):** `static/recordings.html` does not load `H264Decoder.js`, so `Client.js`'s `h264` handler throws `TypeError` on `Guacamole.H264Decoder.isSupported()` when replaying a recording of an H.264 session. Recording itself is unaffected — `src/websocket.rs` tees the raw guacd instruction stream, so the `h264` instructions are captured correctly.

**Files patched:**

| File | Change |
|------|-----|
| `src/libguac/display-priv.h` | Declare `PFW_guac_display_flush_h264()`; add `h264_active` to `guac_display_layer` |
| `src/libguac/display-plan.c` | Add `PFW_guac_display_flush_h264()`; remove the `plan->ops` scan; skip ops via `h264_active` |
| `src/libguac/display-flush.c` | Call the flush before `plan_apply()`, outside the `plan != NULL` guard |
| `src/protocols/rdp/channels/rdpgfx.c` | Add `guac_rdp_h264_skip_decode()`; conditionally skip the GDI decode; notify the render thread |

## 012-h264-avc444-diagnostic.patch

**Status: diagnostic only — not a fix.** Requires `004`. Independent of `011`.

**Problem:** A Windows 11 target negotiated the RDPGFX channel successfully but never sent a single AVC surface command, leaving guacd on the full decode→re-encode path (measured: `display-wrk` encoder threads at 63% of session CPU, versus ~0.2% on a working xrdp session).

**Suspected cause:** FreeRDP cannot advertise the `RDPGFX_CAPVERSION_10` capability set with AVC420 only. In `rdpgfx_send_caps_advertise_pdu()` the V10 caps set is emitted only when `GfxH264` is unset or `GfxAVC444` is set:

```c
if (!freerdp_settings_get_bool(..., FreeRDP_GfxH264) ||
    freerdp_settings_get_bool(..., FreeRDP_GfxAVC444))
```

`004` sets `GfxH264 = TRUE` and `GfxAVC444 = FALSE` (see its AVC420-only note), so that condition is false and only V8/V8.1 is advertised. The three reachable states are:

| `GfxH264` | `GfxAVC444` | Advertised |
|---|---|---|
| true | false ← `004` | V8/8.1 with AVC420 only, **no V10** |
| true | true | V8/8.1 + V10 with AVC444 |
| false | any | V8/8.1 + V10 with `AVC_DISABLED` |

The hypothesis — **unconfirmed** — is that Windows 11 declines H.264 when the client offers no V10 caps set, falling back to progressive/clear. xrdp is unaffected because it is content with V8.1.

**Two diagnostics:**

- `GUAC_RDP_H264_AVC444=1` advertises AVC444, restoring the V10 caps set. **The display will render incorrectly while this is set** — the passthrough forwards only `bitstream[0]`, giving the split luma/chroma image with green and magenta casts described under `004`. It is for reading logs, not the screen. A `WARNING` is logged whenever it takes effect.
- Every GFX surface command now logs its codec ID at `TRACE`, not just H.264 ones. Without this a server sending no H.264 is indistinguishable from one mixing H.264 with progressive/clear. Relevant MS-RDPEGFX IDs: 8=CAVIDEO(RFX), 9=CLEARCODEC, 10=PLANAR, 11=AVC420, 13=AVC444, 15=AVC444v2, 16=PROGRESSIVE, 17=PROGRESSIVE_V2.

**If the hypothesis is confirmed,** there is no cheap fix: carrying AVC444 through the passthrough requires decoding both bitstreams and recombining the chroma planes in the browser (a second `VideoDecoder` plus a WebGL merge shader). Until then H.264 passthrough is effectively an xrdp feature.

**Files patched:**

| File | Change |
|------|-----|
| `src/protocols/rdp/settings.c` | Add `guac_rdp_h264_avc444_diagnostic()`; drive `GfxAVC444` from it at both the FreeRDP 3 and FreeRDP 2 sites |
| `src/protocols/rdp/channels/rdpgfx.c` | Log `cmd->codecId` for every surface command at `TRACE` |

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
