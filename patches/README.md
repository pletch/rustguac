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

**CONFIRMED (2026-08-15)** against a Windows 11 target. With `004`'s default AVC420-only advertisement, the session logged zero AVC surface commands. Setting `GUAC_RDP_H264_AVC444=1` to restore the V10 caps set produced, over the same workload:

| Codec | Count | Share |
|---|---|---|
| 9 — CAPROGRESSIVE | 7256 | 50.5% |
| 15 — AVC444v2 | 3352 | 23.3% |
| 8 — CLEARCODEC | 2006 | 14.0% |
| 10 — PLANAR | 1248 | 8.7% |
| 0 — UNCOMPRESSED | 466 | 3.2% |
| 11 — AVC420 | 50 | 0.3% |

So Windows 11 declines H.264 entirely unless the client advertises V10. xrdp is unaffected because it is content with V8.1.

**The same data shows Windows mixes codecs heavily** — only ~24% of surface commands are H.264, with Progressive alone accounting for half. Supporting Windows therefore needs *both* AVC444 decoding in the browser (a second `VideoDecoder` for `bitstream[1]` plus a WebGL chroma merge) *and* per-rect operation suppression in `guac_display_plan_apply()` (currently all ops for an H.264 layer are skipped, so mixed frames would lose their Progressive regions). Even then the ceiling is roughly a quarter of the encode work, against the near-total elimination measured on xrdp. Until both exist, H.264 passthrough is an xrdp feature and the H.264 checkbox has no effect on Windows targets.

**Three diagnostics:**

- `guac_rdp_push_settings()` logs the graphics flags it actually received at `INFO`: `RDP graphics settings: gfx=enabled, h264=disabled`. Without it there is no way to tell from guacd's logs whether a session that never sees H.264 was never asked for it or asked and declined — rustguac always sends `enable-h264` with an explicit `true`/`false` (`src/guacd.rs:397`), so libguac's `Parameter "..." omitted` DEBUG message never appears for it and cannot be used to check.

- `GUAC_RDP_H264_AVC444=1` advertises AVC444, restoring the V10 caps set. **The display will render incorrectly while this is set** — the passthrough forwards only `bitstream[0]`, giving the split luma/chroma image with green and magenta casts described under `004`. It is for reading logs, not the screen. A `WARNING` is logged whenever it takes effect.
- Every GFX surface command now logs its codec ID at `TRACE`, not just H.264 ones. Without this a server sending no H.264 is indistinguishable from one mixing H.264 with progressive/clear. MS-RDPEGFX IDs in decimal (`RDPGFX_CODECID_*` in `freerdp/channels/rdpgfx.h`): 0=UNCOMPRESSED, 3=CAVIDEO(RFX), 8=CLEARCODEC, 9=CAPROGRESSIVE, 10=PLANAR, 11=AVC420, 12=ALPHA, 13=CAPROGRESSIVE_V2, 14=AVC444, 15=AVC444v2.

**RESOLVED — Windows 11 can be made to send AVC420.** The two required settings pull in opposite directions, which is why this is not obvious:

1. **guacd must advertise AVC444** (`GUAC_RDP_H264_AVC444=1`). Without the V10 caps set Windows offers no H.264 at all, and FreeRDP can only reach V10 via `GfxAVC444`.
2. **Windows must not *prefer* AVC444** — set `AVC444ModePreferred = 0` under `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services` and reboot. Note `contrib/setup-rdp-performance.ps1` sets this to **1**, which is what causes Windows to pick AVC444v2.

Advertise the capability; decline the preference. Measured on the same Windows 11 target and workload:

| Codec | 444 preferred (=1) | 444 not preferred (=0) |
|---|---|---|
| 9 — CAPROGRESSIVE | 7256 | 4094 |
| 15 — AVC444v2 | 3352 | **0** |
| 11 — AVC420 | 50 | **1404** |
| 8 — CLEARCODEC | 2006 | 766 |
| 10 — PLANAR | 1248 | 0 |
| 0 — UNCOMPRESSED | 466 | 318 |

AVC420 is fully supported by `004`'s passthrough, so no browser-side AVC444 work is needed.

**Remaining caveat:** only ~21% of surface commands are AVC420; CAPROGRESSIVE is still 62%. So the CPU saving on Windows is far smaller than on xrdp, and the mixed-codec hazard described under `011` becomes live rather than theoretical — frames carrying both AVC420 and Progressive will lose their Progressive regions, because `guac_display_plan_apply()` skips all operations for a layer that had H.264 sent. Per-rect operation suppression is required before this is safe to enable on Windows.

**Files patched:**

| File | Change |
|------|-----|
| `src/protocols/rdp/settings.c` | Add `guac_rdp_h264_avc444_diagnostic()`; drive `GfxAVC444` from it at both the FreeRDP 3 and FreeRDP 2 sites |
| `src/protocols/rdp/channels/rdpgfx.c` | Log `cmd->codecId` for every surface command at `TRACE` |

## 013-h264-per-rect-suppression.patch

**Problem:** `004` suppresses **every** image operation for a layer that had H.264 sent this frame:

```c
if (display_layer->h264_active) { op++; continue; }
```

That is correct only when the server encodes the whole surface as H.264, as xrdp does. Windows mixes codecs heavily within a frame — a Windows 11 host was measured at 21% AVC420 against 62% CAPROGRESSIVE, 12% CLEARCODEC and 5% UNCOMPRESSED (see `012`). Every progressive/clear region arriving in a frame that also carried H.264 was discarded, producing visibly stale and corrupted areas of the desktop.

**Fix:** track the regions actually covered by the H.264 frames sent for a layer, and suppress only operations that intersect them. Regions are recorded in `guac_display_plan_flush_h264()` as each frame is sent, deduplicated (servers commonly send many frames covering the same rect), and capped at `GUAC_DISPLAY_LAYER_MAX_H264_RECTS` (32) with any excess merged into the last slot — over-suppressing slightly rather than losing track of a covered region.

This is also correct in the `011` skip-decode case: with the decode skipped, no pixels are written for H.264 regions, so no operations are generated for them and nothing is suppressed unnecessarily.

**Files patched:**

| File | Change |
|------|-----|
| `src/libguac/display-priv.h` | Replace `h264_active` with `h264_rects[]` + `h264_rect_count`; add `GUAC_DISPLAY_LAYER_MAX_H264_RECTS` |
| `src/libguac/display-plan.c` | Record each sent frame's region; suppress operations by intersection instead of per-layer |

## 014-h264-region-rects.patch

**Problem:** An H.264 picture is always full-surface sized, but `RDPGFX_AVC420_BITMAP_STREAM` carries a `meta.numRegionRects`/`regionRects` list identifying which parts of it are actually valid. `004` discards `meta` entirely and forwards only `cmd->left/top/width/height`, and the client then blits the whole picture:

```js
ctx.drawImage(frame, pos.x, pos.y);   /* three-arg form: entire frame */
```

On xrdp that is correct — it encodes the whole surface as H.264, so the valid region *is* the whole picture. On a server that mixes codecs it is not: Windows encodes only part of the screen as H.264, so every H.264 frame repainted the full surface and destroyed the CAPROGRESSIVE and CLEARCODEC regions delivered moments earlier. FreeRDP itself honours the distinction, unioning only `regionRects` into `surface->invalidRegion`.

This is what produced the corrupted areas on Windows that `013` did not fix — `013` governs what guacd *withholds*, whereas the damage came from the client *overwriting*.

**Fix:** carry the region rects end to end.

- `rdpgfx.c` converts `meta.regionRects` from `RECTANGLE_16` (left/top/right/bottom) to `guac_rect` and passes them to `guac_display_layer_set_h264()`, which copies them onto the queued frame (FreeRDP frees the originals when the surface command returns).
- The `h264` instruction gains a trailing region list:

  ```
  h264 <stream> <layer> <keyframe> <x> <y> <width> <height>
       <numrects> [<x> <y> <width> <height>]...
  ```

  A count of zero means the whole picture is valid, so servers encoding the full surface are unaffected.
- `H264Decoder.js` draws once per region with the nine-argument `drawImage`, clipping source and destination alike, and falls back to the whole-picture blit when no regions are given.
- `013`'s suppression now tracks these precise regions rather than the whole surface bounds, so non-H.264 operations are suppressed far less often.

**Client-side files** (not part of this patch, but required together): `static/guac/Client.js` parses the trailing rects; `static/guac/H264Decoder.js` clips drawing to them. Both are served live, but browsers cache them — force-reload after deploying.

**Files patched:**

| File | Change |
|------|-----|
| `src/libguac/display-priv.h` | Add `rects`/`num_rects` to `guac_h264_frame` |
| `src/libguac/guacamole/display.h` | `guac_display_layer_set_h264()` takes region rects |
| `src/libguac/display-layer.c` | Copy region rects onto the queued frame; free them |
| `src/libguac/display-layer-list.c` | Free region rects during layer cleanup |
| `src/libguac/display-plan.c` | Send the region list; track precise regions for suppression |
| `src/protocols/rdp/channels/rdpgfx.c` | Convert and forward `meta.regionRects` for AVC420 and AVC444 |

## 016-h264-suppress-switch.patch / 017-h264-suppress-img-only.patch

**Problem:** `013`'s suppression over-fired. Dragging a window containing video left stale rectangles along the path it travelled. Confirmed by `016`, which adds `GUAC_H264_SUPPRESS=0` to disable suppression entirely — with it off, the artefacts disappear.

Two distinct causes, both fixed by `017`:

1. **`COPY` and `RECT` operations were being suppressed.** Suppression exists solely to avoid re-encoding regions the H.264 stream already carries, and only `IMG` operations encode anything. A window drag is expressed as copies; dropping those discards real content and saves nothing. `017` restricts suppression to `GUAC_DISPLAY_PLAN_OPERATION_IMG`.

2. **Regions were accumulated across every H.264 frame in a flush.** A flush may carry several frames, so a moving window's regions unioned into the swept path — suppressing everything underneath and leaving the vacated areas stale. The client draws the frames in order, so only the last determines the final state of the H.264 area; regions covered solely by earlier frames must still receive their image updates. `017` retains only the most recent frame's regions.

`GUAC_H264_SUPPRESS=0` is retained as a diagnostic. With suppression off the display is still correct — image operations are drawn after the H.264 frames of the same guacd frame, so they win — merely more expensive, which forfeits the entire benefit of the passthrough on mixed-codec servers.

## 018-h264-suppress-mixed-frames.patch

**Superseded by `022`, which narrows this to the regions the other codec actually painted.** The whole-layer disable described below now applies only when a frame exceeds the region tracking limit.

**Problem:** suppression assumes the H.264 stream is the sole source of truth for the regions it covers. That holds for a server encoding the whole surface as H.264 (xrdp), but not for one painting other content over the same area. Opening the Windows Start menu across a video region produced stale rectangles: the menu arrives as CAPROGRESSIVE, lands inside an H.264 region, and its image operations were suppressed. `017` cannot address this — the overlap is genuine rather than an artefact of accumulation.

**Fix:** disable suppression for any frame that also carried non-H.264 content. `rdpgfx.c` calls `guac_display_layer_mark_mixed_codec()` for every surface command whose codec is not AVC420/AVC444/AVC444v2; the flush transfers that flag into the frame being built and clears the accumulator.

The test is **per frame, not per session**, deliberately. A per-session flag would be simpler, but `gfx.toml` commonly lists `order = ["H.264", "RFX"]`, so a single RFX command would permanently forfeit suppression on an otherwise all-H.264 xrdp session — the configuration where suppression delivers its largest benefit. Per frame, such a session keeps suppression on every frame that is purely H.264.

The flag is set without holding the pending frame lock. It only ever transitions 0 → 1 within a frame and is reset under the lock during the flush, so the worst outcome of a race is suppression being disabled one frame later than it might have been; taking the write lock for every non-H.264 surface command would cost far more.

**Practical effect on Windows:** with CAPROGRESSIVE at ~62% of surface commands, most frames are mixed, so suppression will rarely engage there and the encode saving is correspondingly small. That is the correct trade — suppression on Windows could only ever save ~21% of the encode work, and had by this point produced four separate correctness defects.

**Files patched:**

| File | Change |
|------|-----|
| `src/libguac/display-priv.h` | Add `h264_mixed_pending` / `h264_mixed_frame` to the layer |
| `src/libguac/guacamole/display.h` | Add `guac_display_layer_mark_mixed_codec()` |
| `src/libguac/display-layer.c` | Implement the marker |
| `src/libguac/display-plan.c` | Consume the flag per frame; gate suppression on it |
| `src/protocols/rdp/channels/rdpgfx.c` | Mark the layer for every non-H.264 surface command |

## 019-h264-keyframe-idr-only.patch

**Problem:** `004` treated an access unit as a keyframe if it contained NAL type 5 **or type 7**:

```c
if (nal_type == 5 || nal_type == 7)
    return 1;
```

Type 5 is an IDR slice — genuinely independently decodable. Type 7 is an SPS, a parameter set that encoders routinely repeat alongside ordinary inter-coded frames. Any such frame was therefore flagged as a keyframe, and that flag becomes the WebCodecs chunk type on the client:

```js
type: isKeyFrame ? 'key' : 'delta'
```

Handing a decoder a delta frame labelled `'key'` is a specification violation. Chrome responds by discarding queued work — which drops already-allocated `VideoFrame`s before they ever reach the output callback and its `frame.close()`. That produces both the console warning

> A VideoFrame was garbage collected without being closed. Applications should call close() on frames when done with them to prevent stalls.

and a visible stall until a genuine sync point arrives. The two were reported as reliably co-occurring, which generic GC pressure would not explain.

**Fix:** require an actual IDR slice. `guac_rdp_h264_is_keyframe()` now returns non-zero only for type 5, and additionally reports a bitmask of every NAL type encountered, logged at `TRACE` as `nal_types=0x...`, so the stream's real structure is visible. Bit 5 set means IDR, bit 7 SPS, bit 8 PPS, bit 1 non-IDR slice.

**If nothing renders after this**, the server is not sending IDRs at all and is relying on recovery points instead; the `nal_types` mask will show it (bit 5 never set), and the keyframe gate in `004` would then need rethinking rather than reverting to the old test.

**Files patched:** `src/protocols/rdp/channels/rdpgfx.c`

## 020-h264-queue-drop-logging.patch

**Diagnostic.** The H.264 frame queue is capped at 120 frames and silently discarded the oldest beyond that. Since dropping any frame breaks the reference chain until the next keyframe, a drop is a plausible cause of a visible freeze — but there was no way to tell whether it was happening. Logs at `DEBUG` when a frame is dropped and how deep the queue was.

**Files patched:** `src/libguac/display-layer.c`

## 021-h264-lock-wait-diagnostics.patch

**Diagnostic.** `guac_display_layer_set_h264()` acquires the display's `pending_frame.lock` write lock, which the render thread holds for the whole flush — including `guac_display_plan_apply()`, which dispatches image encoding. The RDP thread therefore blocks inside `set_h264`, and that is the same thread that sends `RDPGFX_FRAME_ACKNOWLEDGE`; late acknowledgements cause the server's MS-RDPEGFX flow control to throttle, which presents as a low source frame rate rather than as a stall in guacd.

Times the acquisition and logs at `DEBUG` when it exceeds 10ms. Read with:

```bash
journalctl -u rustguac-guacd --since '2 min ago' | grep "DEBUG:" \
  | grep -oP 'H.264 set blocked \K[0-9]+' | sort -n | uniq -c | tail
```

Note that guacd messages are journalled three times; filter on the level prefix before counting anything.

**Files patched:** `src/libguac/display-layer.c`

## 022-h264-mixed-codec-regions.patch

**Problem:** `018` disables suppression for the entire layer whenever a frame carries any non-H.264 content. That is far broader than the defect it fixed. xrdp's `gfx.toml` commonly lists `order = ["H.264", "RFX"]`, so an xrdp session emitting even one RFX or uncompressed command per frame loses suppression on every frame — restoring the full JPEG/WebP encoding cost that `011` exists to eliminate. This was observed as guacd CPU returning to pre-`011` levels on an otherwise unchanged xrdp session.

The actual requirement is only that non-H.264 content not be suppressed **where it lands**. `013`/`014` already track regions per frame, so the same machinery answers the narrower question.

**Fix:** record the region of every non-H.264 surface command instead of a bare flag. `guac_display_layer_mark_mixed_codec()` now takes a `guac_rect` and appends it (de-duplicated) to a per-layer pending array; the flush drains that array into the frame being built; `guac_display_plan_apply()` suppresses an IMG operation only if it falls within an H.264 region **and** intersects none of the mixed regions.

A Windows Start menu opened over a video still renders — its CAPROGRESSIVE region is exempt — while the video area around it stays suppressed. An xrdp session with a small RFX region per frame keeps suppression everywhere else.

**Locking.** The regions are written by the protocol thread and read by the render thread, so unlike `018`'s single flag they need real mutual exclusion; a torn read would yield a bogus rectangle and, if it under-covered, a permanently stale region — exactly the class of bug this exists to prevent. The lock is a new per-layer `mixed_rect_lock`, deliberately **not** the display's `pending_frame.lock`: the render thread holds that one across the whole flush, so taking it per surface command would block the RDP thread and delay EGFX frame acknowledgement (see `021`). `mixed_rect_lock` is held only for the few instructions needed to append or drain.

**Overflow.** Beyond 32 distinct regions in a frame, suppression is disabled for the whole layer for that frame — i.e. it degrades to `018`'s behaviour. A frame painting that many distinct regions with another codec has little left for H.264 to cover, so there is scant saving to protect.

**Files patched:**

| File | Change |
|------|-----|
| `src/libguac/display-priv.h` | Replace `h264_mixed_pending` with `mixed_rects_pending` / count / overflow; add `mixed_rects`, `mixed_rect_count`, `mixed_rect_lock` |
| `src/libguac/guacamole/display.h` | `guac_display_layer_mark_mixed_codec()` gains a `guac_rect` parameter |
| `src/libguac/display-layer.c` | Record regions under the new lock; de-duplicate; flag overflow |
| `src/libguac/display-layer-list.c` | Init/destroy `mixed_rect_lock` |
| `src/libguac/display-plan.c` | Drain regions per frame; add `guac_display_layer_mixed_covers()`; extend the suppression test |
| `src/protocols/rdp/channels/rdpgfx.c` | Pass the surface command's rect when marking |

## 023-h264-queue-lock-decouple.patch

**Problem:** `guac_display_layer_set_h264()` took the display's `pending_frame.lock` write lock to append a frame to the queue. The render thread holds that same lock for the entire flush, including `guac_display_plan_apply()`, which dispatches image encoding to the worker threads. The protocol thread therefore blocked inside `set_h264` for as long as the flush took.

For RDP that protocol thread is the one processing EGFX PDUs, and FreeRDP sends `RDPGFX_FRAME_ACKNOWLEDGE` synchronously from `rdpgfx_recv_end_frame_pdu()` **after** `context->EndFrame` returns. Blocking it therefore delays frame acknowledgement, and MS-RDPEGFX flow control limits how many unacknowledged frames a server will have outstanding. The result presents as a low frame rate *from the server* — which is why measurement kept showing a clean, lossless pipeline carrying only ~21fps, and why the same client and browser were flawless against xrdp: on xrdp the flush has almost nothing to encode, so the lock is barely held.

**Fix:** give the queue its own lock. The queued fields (`h264_queue`, `h264_queue_tail`, `h264_queue_length`) need no coordination with the rest of the pending frame — the queue is a separate list, appended by the protocol thread and consumed at flush.

- `set_h264` allocates and copies the NAL data *before* taking any lock, then holds `h264_queue_lock` only long enough to append and enforce the 120-frame cap.
- The cap-drop warning moved outside the lock; logging can block on I/O and this lock is on the path of every surface command.
- The flush detaches the whole queue under the lock and sends outside it, so socket writes never block the protocol thread either.

**This supersedes the diagnostic in `021`** — there is no longer a pending-frame-lock acquisition in `set_h264` to time. `021` remains in the series only because later patches build on its context lines.

**Files patched:**

| File | Change |
|------|-----|
| `src/libguac/display-priv.h` | Add `h264_queue_lock`; document why it is not `pending_frame.lock` |
| `src/libguac/display-layer.c` | Build the frame outside any lock; append under the queue lock; log drops after unlocking |
| `src/libguac/display-plan.c` | Detach the queue under the lock, send outside it; drop the unlocked empty-queue pre-check |
| `src/libguac/display-layer-list.c` | Init/destroy `h264_queue_lock` |

## 024-h264-stall-location.patch

**Diagnostic.** Sessions against Windows freeze for ~6 seconds at a time. Measurement narrowed it considerably: the browser is idle and loses nothing (`gcLeaks` 0, one 105ms long task in a whole session, 1.6ms decodes), no socket is backpressured (`Send-Q` 0 on both the guacd->rustguac and rustguac->browser legs), and guacd's flush sizes stay at 1-2 frames throughout -- so no frames were queued during a stall. guacd was idle, not busy: nothing arrived to send.

That leaves two possibilities, needing opposite fixes: the server stopped sending, or guacd's RDP thread stopped taking commands off the wire. This patch separates them.

- **Inter-arrival gap.** Logs at `DEBUG` when 500ms or more passes between surface commands, measured as each is taken off the wire. A gap here means the server sent nothing.
- **GDI decode duration.** Logs at `DEBUG` when the original FreeRDP handler takes 50ms or more. That handler calls `BeginPaint`/`EndPaint`, which take the display's `pending_frame` write lock -- the lock the render thread holds across a flush. `023` removed that dependency from the H.264 queueing path, but every **non-H.264** surface command still passes through here, and on Windows that is ~62% of them (CAPROGRESSIVE). This thread also sends `RDPGFX_FRAME_ACKNOWLEDGE`, so time spent blocked here throttles the server.

xrdp never enters the second path, which is consistent with it being unaffected.

**Reading it:**

```bash
journalctl -u rustguac-guacd --since '3 min ago' | grep "DEBUG:" \
  | grep -E "since the previous surface command|GDI decode of codec"
```

Long GDI decodes immediately before each arrival gap mean guacd stalled the server. Arrival gaps with no long decode mean the server paused on its own.

**Files patched:** `src/protocols/rdp/channels/rdpgfx.c`

## 025-h264-avc444-no-passthrough.patch

**Problem:** `004` captured AVC444 and AVC444v2 commands and forwarded `bitstream[0]`. AVC444 splits the image across two bitstreams -- `bitstream[0]` is the main view, `bitstream[1]` an auxiliary view from which full-resolution chroma is reconstructed -- so forwarding the first alone renders half the screen green and half pink.

`012` worked around this by advertising the AVC444 capability (Windows offers no H.264 at all without the RDPGFX V10 caps, which FreeRDP reaches only via `GfxAVC444`) while relying on `AVC444ModePreferred=0` on the host to make Windows decline it and send AVC420. That makes correct rendering depend on a registry value on a machine we do not control. It resurfaced the moment the Windows host's graphics pipeline changed: disabling the WDDM Remote Desktop display driver (needed there to get NVENC engaged at all) changed the negotiation and Windows chose AVC444 again.

**Fix:** never capture AVC444. Those commands fall through to the normal GDI decode and are re-encoded as images, so they render correctly at CPU cost. A host that negotiates AVC444 for any reason now loses the passthrough for those commands instead of displaying garbage. Logged once per connection at `WARNING`, naming the registry value that restores AVC420.

The mixed-codec test in the same function narrowed to `codecId != AVC420` to match: AVC444 is H.264 but is no longer passed through, so the images it produces must be exempt from suppression like any other codec's.

**Files patched:** `src/protocols/rdp/channels/rdpgfx.c`

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
