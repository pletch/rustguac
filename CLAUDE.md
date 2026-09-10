# CLAUDE.md — Project state for rustguac

## What this project is

rustguac is a lightweight Rust replacement for the Apache Guacamole Java webapp. It proxies the Guacamole protocol over WebSockets between web browsers and guacd (the C daemon from guacamole-server). Supports SSH, RDP, VNC, web browser sessions (headless Chromium on Xvnc), and VDI desktop containers (Docker).

## Architecture

- **Rust binary** (`rustguac`) — axum web server, session manager, WebSocket proxy
- **guacd** — built from apache/guacamole-server source, handles SSH/VNC/RDP protocol translation
- **Xvnc + Chromium** — spawned per web-browser session, streamed via VNC through guacd
- **Docker** — VDI containers spawned per-user, connected via RDP through guacd

## Key files

- `src/main.rs` — entry point, CLI (clap), server setup
- `src/api.rs` — REST API endpoints (session CRUD, recordings, admin)
- `src/session.rs` — session state machine, SessionManager
- `src/browser.rs` — Xvnc + Chromium process lifecycle (display allocator, per-session profile dirs)
- `src/vdi/mod.rs` — VdiDriver trait, container types (ContainerSpec, ContainerInfo, ManagedContainer)
- `src/vdi/docker.rs` — Docker-based VDI driver (bollard, unix socket, start/reuse/stop)
- `src/guacd.rs` — TCP connection to guacd, Guacamole protocol handshake
- `src/protocol.rs` — Guacamole wire format parser/encoder
- `src/websocket.rs` — WebSocket <-> guacd TCP bridge, recording tee
- `src/config.rs` — TOML config loading with defaults
- `src/auth.rs` — API key auth middleware (SHA-256, IP allowlists, expiry), role system
- `src/oidc.rs` — OIDC authentication (login, callback, logout, group extraction)
- `src/vault.rs` — Vault/OpenBao KV v2 client for connections (AppRole auth, token renewal)
- `src/db.rs` — SQLite admin database (rusqlite, bundled)
- `static/client.html` — Guacamole JS client with auto-scaling display
- `static/connections.html` — Vault-backed connections UI (folder/entry management, connect)
- `static/recordings.html` — recording playback with auto-scaling
- `static/sessions.html` — session management dashboard
- `dev.sh` — development script (build guacd, run, deps)
- `install.sh` — bare-metal Debian 13 installer (systemd services)
- `Dockerfile` — multi-stage build (guacd + rustguac + runtime)

## Configuration

TOML config file (`config.local.toml` for dev, `--config` flag for production). Key settings: `listen_addr`, `guacd_addr`, `recording_path`, `static_path`, `db_path`, `xvnc_path`, `chromium_path`, `display_range_start/end`.

### Vault / Connections

Optional `[vault]` section enables the Vault-backed connections. Connection entries (SSH/RDP/Web) are stored in Vault KV v2 — credentials never touch disk or the browser.

```toml
[vault]
addr = "https://vault.example.com:8200"
mount = "secret"           # KV v2 mount (default)
base_path = "rustguac"     # base path under mount (default)
role_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
# namespace = "my-ns"      # optional, for Vault Enterprise / OpenBao namespaces
# instance_name = "prod-1" # optional, enables instance-scoped entries
```

`VAULT_SECRET_ID` env var provides the AppRole secret ID.

Vault KV v2 path structure:
- `<base_path>/shared/<folder>/<entry>` — shared across all instances
- `<base_path>/instance/<name>/<folder>/<entry>` — instance-specific
- `<folder>/.config` — folder metadata: `{"allowed_groups":["group1"], "description":"..."}`
- `<base_path>/users/<sanitized_email>` — per-user credential variables

#### Multiple Vault backends (DR)

Optional `[vault_shared]` / `[vault_local]` blocks (same keys as `[vault]`) give
the `shared` / `instance` scopes their own Vault so one being down can't take the
other with it. A bare `[vault]` is unchanged (shared+local both alias it). Secret
IDs: `VAULT_SECRET_ID`, `VAULT_SHARED_SECRET_ID`, `VAULT_LOCAL_SECRET_ID`. Each
backend connects/retries/renews independently; a down backend greys that scope in
the UI. Per-credential scope: a credential variable can be stored shared or local
(location = truth), toggled per-row in My Credentials (hidden with a single
Vault); `user_credentials_default_scope` (default `local`) seeds new ones. Split
an existing single-Vault deployment with `rustguac vault-migrate` (copy subtree +
.config, then add the block + restart — routing is single-source, no read
fallback). Implemented on branch `feature/multi-vault-dr` (see project memory).

### OIDC

Optional `[oidc]` section enables OpenID Connect authentication. Key settings: `issuer_url`, `client_id`, `client_secret`, `redirect_uri`. `OIDC_CLIENT_SECRET` env var can override the config value. `groups_claim` (default: "groups") specifies the JWT claim for group memberships. `extra_scopes` requests additional scopes.

If login fails on the callback with "OIDC state cookie mismatch", the callback logs whether the state cookie was absent vs. present-but-different, the cookie names received, and the Host/X-Forwarded-Host/X-Forwarded-Proto headers to help diagnose. One known cause: running the reverse-proxy→rustguac leg over HTTPS (rustguac serving TLS with the proxy doing `tls_insecure_skip_verify`) can drop the auth cookies — serve rustguac over plain HTTP behind the proxy instead (the browser→proxy leg stays HTTPS, so the `Secure` cookies still work).

Provider discovery is **lazy with retry** (`OidcState::client()` in `src/oidc.rs`). `init_oidc` builds the HTTP client (fatal config errors like a bad CA cert here disable SSO) and makes a best-effort eager `discover_async`; if the provider is unreachable at startup the failure is logged as a warning but SSO stays enabled (`OidcEnabled` is `true` as long as `[oidc]` is configured). Metadata is then discovered on the first `/auth/login` (or `/auth/callback`) and cached, so SSO recovers on its own once the provider comes up — no rustguac restart needed. Concurrent cold-start logins share one discovery via a write lock; the OIDC HTTP client has connect/overall timeouts so discovery can't hang.

`/api/auth/status` reports `oidc_available` (provider metadata discovered/cached) separately from `oidc_enabled` (configured). When enabled-but-not-ready it spawns a background `OidcState::client()` to warm the cache via `OidcHandle` (the live `Option<OidcState>` shared as an Extension; `OidcState::is_ready()` is the cheap read-lock check). `static/index.html` disables the SSO button with a "temporarily unavailable" notice while `oidc_available` is false and polls `/api/auth/status` every 5s, re-enabling it on recovery — so the login page reflects provider state without a reload. Remember: `index.html` is a branded page served from memory, so this needs a rustguac restart to deploy (see in-memory page caching note).

### Roles

4-tier role hierarchy: `admin` (4) > `poweruser` (3) > `operator` (2) > `viewer` (1).
- **admin**: full access, connections folder/entry management
- **poweruser**: ad-hoc session creation + connections connect
- **operator**: connections connect only (no ad-hoc sessions)
- **viewer**: read-only

## Deployment

- **Bare metal**: `sudo ./install.sh` on Debian 13. Installs to `/opt/rustguac`, creates `rustguac` system user with home dir, sets up systemd services.
- **Docker**: `docker build -t rustguac .` — multi-stage, debian:trixie-slim runtime.
- **Remote test machine**: See project memory for connection details. Binary at `/opt/rustguac/bin/rustguac`, config at `/opt/rustguac/config.toml`.

## Build notes

- guacd is built from `../guacamole-server` (apache/guacamole-server)
- Debian 13 ships freerdp3-dev, not freerdp2-dev. guacamole-server 1.6.1+ has FreeRDP 3 auto-detection. Building with `--with-rdp`.
- **Patches required:** guacamole-server needs patches for FreeRDP 3.15+ (Debian 13). See `patches/README.md`. All build scripts apply these automatically.
- Chromium on headless VMs needs: `--in-process-gpu`, `--use-gl=angle`, `--use-angle=swiftshader`, `--disable-gpu-*`, `--disable-dev-shm-usage`
- The `rustguac` system user MUST have a real home directory (`/home/rustguac`) or Chromium's crashpad crashes with `trap int3`.
- Each Chromium session gets an isolated `--user-data-dir` to avoid profile lock conflicts.

### H.264 passthrough (RDP)

Per-connection **H.264** checkbox forwards the RDP server's H.264 stream to the
browser's WebCodecs decoder instead of decoding it in guacd and re-encoding as
JPEG/WebP. Takes guacd from ~100% of a core to ~2% with 1080p video, on both
xrdp and Windows. No environment variables — `enable-h264` is the only switch.

**Windows hosts need host-side settings, and one is non-obvious:** the Group
Policy *"Use WDDM graphics display driver for Remote Desktop Connections"* must
be **Disabled** or hardware H.264 encoding never engages (GPU 3D shows load
while Video Encode stays at 0%). `AVC444ModePreferred=1` is also required *for
hardware encoding*, and makes Windows send AVC444 — which is handled: both
views are forwarded and combined in the browser into full 4:4:4 chroma. Full
details, including verification commands, in `docs/rdp-h264.md`.

**Colour range: the samples are full range, and the signalling may not
survive the browser.** [MS-RDPEGFX Color
Conversion](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/954d7546-6873-4466-95c8-20a7569c43e5)
defines the ARGB-to-AYUV transform as full-range BT.709 clamped to 0...255, and
RDP hosts encode to it. Converting that as limited expands 16-235 to 0-255:
blacks crush, whites clip, chroma over-saturates by 255/224 -- the worse of the
two errors, since clipping destroys information the reverse only compresses.

The SPS is supposed to settle it with `video_full_range_flag`, and **the
hardware decode path is stricter than the software one about how that is
written.** Measured on one browser against two hosts, both NV12: the xrdp fork
(`full_range=1` with primaries/transfer/matrix all BT.709) is reported full,
while Windows (`full_range=1`, *no description*) is reported **limited** and
painted with crushed blacks. Same client, same decoder; the description is the
only difference. Software decode honours the bare flag, which is what made this
take three wrong theories -- and Chrome separately discards the range outright
when a description is *present* and says *unspecified*, so saying less is safer
than saying "unspecified". `tests/h264-vui-range.mjs` pins all four shapes.

**`src/h264_rewrite.rs` fixes it on the wire**, completing the SPS's colour
signalling in either shape seen in the field. Windows declares a range and no
description: the description is added, the range left alone. Stock xrdp 0.10.6
declares nothing at all -- it passes x264 no VUI parameters, and with
`video_format` 5 and no colour description x264 omits the block entirely -- so
full-range BT.709 is written, which is what the transport defines and what the
encoder produced (xrdp names its own conversion `XRDP_yuv444_709fr`). Note this
is the only fix that reaches a stock-xrdp host at all: it sends AVC420, so
`setColorSpace` is never called and `?h264FullRange` is inert there.

A wire-side fix reaches both render paths (`drawImage()` included, which no
client flag can) and every client, needs no configuration, and costs one check
per session: the first SPS decides, and a stream that already carries a
complete description is never examined again. BT.709 is the value Chrome was already assuming and
the one MS-RDPEGFX defines. The splice is checked byte-for-byte against
ffmpeg's `h264_metadata` filter doing the same edit, because a bad bit offset
stops the picture while both ends look healthy.

`src/h264_sps.rs` logs what the host sent, once per session, and the client
reports what it made of it (`event=colour_space`, with the decoder's pixel
format). Read as a pair: the first describes the wire, the second the render,
and a colour fault is a disagreement between them. Recordings are teed upstream
of the rewrite and keep the original stream; `?h264FullRange=on` is the lever
for playback and for any host whose declaration cannot be believed. Full detail
in `docs/rdp-h264.md`.

**AVC444 is two 4:2:0 streams, not High 4:4:4 Predictive profile.**
`RFX_AVC444_BITMAP_STREAM` [encapsulates two
`RFX_AVC420_BITMAP_STREAM`s](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/8131c1bc-1af8-4907-a05a-f72f4581160f),
both ordinary 4:2:0 that any hardware decoder handles -- Chrome's media log
reads `using h264 high / 4:2:0`, `D3D11VideoDecoder`, one instance for both
views. Advice about profile_idc 244 lacking hardware support, and about
browsers falling back to software for "4:4:4", does not apply here and points
at the wrong fix.

**AVC444 4:4:4 combining** (`static/guac/Yuv444.js`) — a WebGL2 shader unpacks
the auxiliary view's packed chroma (both MS-RDPEGFX layouts) and converts to
RGB in one pass, inverting the encoder's chroma filter to recover the one
sample per 2x2 block neither view carries. Frames are copied in the decoder's
own pixel format: `copyTo()` will not convert NV12 (what hardware decoders
give) to I420, so requesting a format throws before anything is copied. Two
runtime overrides, as window global / query param / localStorage:
`h264Chroma444` (off disables combining) and `h264ChromaFilter` (off, or a
0-255 threshold; default 30, from FreeRDP's `CONDITIONAL_CLIP`). Falls back to
4:2:0 on missing WebGL2, a lost context, or an unreadable pixel format.

Combining costs a plane read-back and a plane upload per view, which is what
makes AVC444 dearer than AVC420 and why it scales badly with resolution. Four
things trim it: a main view whose auxiliary view follows is uploaded but never
painted (the `h264` instruction carries a trailing `<paired>` flag, set by
guacd from MS-RDPEGFX LC=0, because only the server knows before the second
access unit arrives); the renderer draws into an `OffscreenCanvas` and hands
the drawing buffer over with `transferToImageBitmap()` rather than being read
back through a second canvas; the two views' `copyTo()` calls are in flight at
once, with only the uploads ordered; and the conversion is scissored to the
regions the server marked valid (both views' regions, unioned, since only one
of them now paints).

**Do not read aux frame size as waste.** With the xrdp fork's
`CHROMA_INTERVAL=N`, an auxiliary picture conveys chroma for everything that
changed across N frames while a main view carries one frame's damage -- so at
N=8 its 17.9KB against the main view's 4.7KB median is ~2.2KB per
frame-equivalent, *cheaper* per unit of change than luma. Chroma pictures
decoding ~1.74x slower for 3.8x the bytes is sublinear and unremarkable. The
comparison is only apples to apples once divided by N.

A fifth, and the only one that moved the needle: `texSubImage2D` uploads only
the rows the damage rects touch, merged and rounded outward (`bandsFor()`, and
`auxV1LumaBands()` for the v1 layout, which scatters an output row across
16-row bands). Rows rather than rectangles because plane rows are contiguous
and the packed chroma layouts address both halves of a row.

**Measure before optimising this further** — `tests/bench/README.md`. The four
downstream changes are worth ~1.1x on their own, not the 2x they look like on
paper: `texSubImage2D` of the six planes is 60-90% of the whole combine (2.1ms
of 3.8ms at 1080p, 7.2ms of 17ms at 4K on an Intel UHD 770) and none of them
touch it, while the conversion they were aimed at costs 15-30us. Banding the
upload is what pays: 2.0x at 4K and 1.8x at 1080p on a typing-shaped damage
list, 1.35x on a window, nothing at all full-screen -- correctly, since there
is nothing to crop. AVC420 is still 1.8-3.6x cheaper than any of it.

**Adaptive suspension was built, removed, and rebuilt in a different shape.**
The 2026-09-08 removal rested on the claim that a chroma picture costs
**1.1-1.4ms at 4MP**, so the gate never fired. That number was wrong: it timed
GPU *submission*, and `tests/bench`, which forces completion, measures ~1.37ms
per megapixel -- about 5.5ms at 4MP, four times the figure that justified
deleting the gate. The design was sound and its instrument lied to it.

What is there now is a **latch, not a controller**, and it gates on the
symptom rather than the cost. It watched the decode backlog from 2026-09-09
and **sync gate timeouts from 2026-09-11**:

* **Symptom, because cost cannot be measured cheaply.** Timing GPU execution
  needs a `gl.finish()` per picture -- stalling the pipeline the gate exists to
  protect -- or timer queries that are not reliably available. A held sync ack
  needs neither and is what the user actually feels.
* **Sync timeouts, not the backlog, because the backlog never grows.** `012`'s
  pacing holds each ack until the backlog is within `MAX_PIPELINE_DEPTH`, so
  guacd slows to the client's pace and the queue stays short: a session
  combining at 6MP felt much slower while every snapshot read `pending=0`.
  Measured at 2992x2000 on one client and host (`sync_hold`): 4:2:0 held 0-3%
  of syncs for a mean of 1.5ms with **no timeouts in thousands**; 4:4:4 held
  10% for a mean of 271ms, max 338ms, **25 timeouts a minute** -- holds
  outlasting the 200ms timer showed the combine blocking the main thread, not
  only the GPU. And a backlog cannot build without timeouts, since every sync
  waits for the queue to drain and gives up at `SYNC_WAIT_TIMEOUT_MS` -- so the
  backlog trigger was removed as redundant. Trips on `COMBINE_TIMEOUT_TRIP` (3)
  timeouts within `COMBINE_TIMEOUT_WINDOW_MS` (10s) while combining.
* **A latch with hysteresis, not a controller.** The old budget's divisor was
  the observed interval between pictures, which is what `012`'s frame-ack
  back-pressure has already throttled the server down to -- and that
  back-pressure reacts to the lag combining causes. It read its own output as
  its input and needed a capped ceiling to stop it hunting. This has no loop:
  it gives up, waits `COMBINE_RECOVER_MS` with no sync timeout at all (in
  either mode), tries again, and after `COMBINE_MAX_TRIPS` stops trying.
  Tripping during a video and resuming afterwards is the expected shape.
* **The trip sets the latch; combining stops at the next main view.** The
  timeout fires from a timer and can land between a paired main view --
  uploaded, deliberately unpainted -- and the auxiliary view that paints it.
  Stopping in between discards that picture, and when it was the connect-time
  keyframe the session looked hung until a resize (`e846367`).
* **The recovery window is long because resyncing is expensive, not because
  flapping is visible.** Only newly painted regions change chroma resolution, so
  a transition is barely perceptible; but the first combine after a gap uploads
  whole planes rather than damaged rows -- the most expensive kind there is --
  and handing that to a client that has just stopped struggling is how a gate
  makes things worse.

An explicit `h264Chroma444` override disables the latch outright: an override
is an instruction, and a latch that fought it would make the A/B it exists for
impossible.

`h264CombineLog` now calls `Yuv444Renderer.finish()` before stamping, so its
combine figure is execution rather than submission -- at the cost of a stall,
which is why it happens only when the flag has asked for numbers.

Still true that the xrdp fork's `CHROMA_INTERVAL` is better placed than any
client-side gate, since it cuts the second decode and the bandwidth too.

`h264CombineLog` reports every 5s, splitting each stage by whether the picture
carried an auxiliary view: **decode** (`decode()` submitted to the frame
arriving in `output()`), **combine** (read-back, upload, conversion, transfer)
and **draw** (ready to painted, which is time in the display's ordered queue
rather than work). Plus the plane read-back wait and counts of the two ways a
frame is given up on (the 1000ms decode watchdog and the 200ms sync gate).
Three stages so that time unaccounted for by one shows up in the next instead
of being inferred -- the client measured 1.2ms of combine while the session ran
at 18.6fps, and only instrumenting the next stage along could say where the
rest went. That split matters against a server sending chroma every
Nth picture: one picture in N costs several times its neighbours, and a mean
across both hides exactly that. Keep it. Three separate theories about AVC444
stutter died on contact with it, and it is what proved the client idle at
1.2ms while the session ran at 18.6fps.

`tests/h264-instruction-format.mjs` round-trips the `h264` instruction through
the real `Guacamole.Parser`, lifting the index expression out of `Client.js`
rather than copying it. `<paired>` trails the variable-length rects, so an
off-by-one there reads a rect coordinate as a boolean -- true for nearly every
rect -- and silently drops the paint of unpaired main views on some servers
only. It covers the older instruction shapes too.

#### Three levers, none of which replaces another

Adaptive suspension does **not** make the AVC420 levers redundant, and the
three sit at levels the others cannot reach:

1. **Whether AVC444 is advertised at all** (`013-rdp-avc420-only`, and the
   HiDPI default from the desktop scale). Clearing `GfxAVC444` is the only one
   of the three that reduces what is *sent and decoded*: one bitstream instead
   of two, so half the bandwidth, half of guacd's copy and queue work, and one
   decode per picture instead of two. It is also the only lever with a quality
   argument behind it rather than a cost one -- at 1.4x or 1.8x a 4:2:0 chroma
   block covers close to one logical pixel, so the density has already bought
   most of what combining recovers.
2. **The per-connection Automatic / Always / Never setting.** Not really a
   chroma switch: Windows offers no H.264 below RDPGFX v10 and FreeRDP emits
   those capability sets only when AVC444 is requested, so Never on a Windows
   host loses H.264 altogether rather than downgrading its chroma. A per-target
   compatibility decision, invisible to the client. It says what the server is
   asked to send, **not** what gets drawn -- Always on a 4K host still paints
   4:2:0 once lever 3 suspends, and is still the correct setting there, because
   it is what keeps H.264 working at all. Do not be tempted to make Always
   disable lever 3: Always is the recommended setting for every Windows target,
   so that would switch the gate off exactly where it earns most. xrdp needs the same lever
   from the other direction -- see [[xrdp-avc444-causes-chop]] in project
   memory, where AVC444 itself causes the chop and only clearing `GfxAVC444`
   fixes it.
3. **The client-side combine gate.** Acts in the decoder's output callback,
   after both access units have already been decoded, so it removes the combine
   and nothing else -- never the decode or the bandwidth, which is why it does
   not replace lever 1. Two parts: a static threshold on framebuffer area
   (`COMBINE_MAX_PIXELS`), and a latch that gives up combining when sync
   acks keep timing out. The threshold is a good prior that avoids a bad
   few seconds at the start of a 4K session; the latch is the safety net under
   it, and the only part that adapts to the client's actual GPU rather than to
   a constant measured on one.

   Neither part measures the combine's cost, deliberately -- see the adaptive
   suspension note above for why that is harder than it looks and what it cost
   the first time.

   `sync_hold` reports the holds once a minute, split by mode (syncs/s, share
   held, mean hold across all syncs and across held ones, max, timeouts), with
   session totals in `describeState()` -- the numbers the timeout trip was set
   from, and the ones to re-measure against if it misfires.

   **The hold cannot see a slow display queue.** `Client.js` acks a sync only
   after `display.flush()` completes, and the decoder's gate runs after that,
   so a stuck queue shows as *fewer syncs with no holds* -- a stalled
   fullscreen session read 2.2 syncs/s, 0 holds, 0 timeouts. So `sync_hold`
   also reports the flush (sync arriving to flush complete): `| flush mean ..
   max .. slow N`, slow being >=100ms. Read a low sync rate next to it: slow
   flushes are the client's display, fast ones are the host sending little.

The benchmark's `AVC420 (no combine)` row therefore **understates** real
AVC420, since every row is fed the same pre-decoded frames and none of them
models the halved decode or the halved bitstream.

#### 012 stands down against a server that paces itself

`012` holds the frame acknowledgement for the amount by which client
processing lag exceeds its target, **minus the spacing the server has already
provided since the previous frame** -- the same subtraction upstream's render
thread makes as `required_wait = processing_lag - time_since_last_frame`.

That subtraction is what lets one guacd serve a Windows host and a
self-pacing xrdp host at once. The xorgxrdp fork's `XORGXRDP_ADAPTIVE_PACE`
steers its *capture* interval from the very acknowledgement round trip `012`
delays, so an additive hold is read upstream as client latency and answered
with a longer capture interval, which shortens the hold, which shortens the
interval -- two controllers driving one frame rate through each other's
sensor, hunting on roughly a one-second cycle. It is the same trap the xrdp
fork's own `ecdb3747` fixed from the other end, when it stopped pacing from a
signal that contained the interval being set.

Crediting the elapsed gap makes `012` a floor rather than a competing
controller: a server that has already spaced its frames past the excess is
held for nothing and keeps sole ownership of the loop, while one that floods
is still throttled by whatever it did not provide. So no per-connection lag
target is needed, and `GUAC_RDP_H264_LAG_TARGET` stays a deployment-wide
default. Pacing belongs at the source anyway -- it is the only place that can
decline to *capture and encode* a frame, and the only place that serves the
native RDP clients rustguac never sees.

#### Black regions on Windows: what is instrumented, and why

Passthrough skips the GDI decode, so `gdi->primary_buffer` — the buffer guacd
encodes from, and the *same memory* as the display layer's pending frame
(`gdi.c`, `current_context->buffer = gdi->primary_buffer`) — holds **no pixels**
for any region delivered as H.264. The picture exists only in the browser. So
anything that makes guacd draw that layer from its own buffer paints black over
a working screen, and an idle Windows desktop has no damage to send that would
repair it. `patch 005`'s full-layer repaint on resize does exactly that, which
is why the fix for `sol1/rustguac#118` (black after resize on the tile path) is
a suspect for the H.264 case rather than a cure — and why `RefreshRect` cannot
undo it, the RDPGFX surface cache ignoring `RefreshRect`.

None of this is visible from either end: guacd believes it sent pixels and the
browser believes it received them. Since the fault appears once in days and
cannot be reproduced on demand, all of the following is on by default and
bounded, rather than being something to switch on afterwards:

- **`patch 014`** — logs the RDPGFX operations `004` cannot see (`CacheToSurface`,
  `SurfaceToCache`, `SurfaceToSurface`, `SolidFill`, `ResetGraphics`,
  `CreateSurface`, `DeleteSurface`), 10 detail lines per 10s plus a summary,
  and warns when a resize flushes the repaint above while passthrough is live.
- **`src/frame_stats.rs`** — watches the wire for *overpaint*: `img`, `copy`,
  `rect`, `cfill`, `size` or `dispose` on a layer that has carried H.264. The
  colour of a `cfill` is logged, since a black fill and a region never painted
  are indistinguishable on screen. Costs nothing until an `h264` instruction is
  seen.
- **`static/guac/H264Decoder.js`** — reports what only the browser knows via
  `Guacamole.H264Decoder.onDiagnostic`: decoder rebuilds, keyframe starvation
  (`keyframe_wait` / `keyframe_resumed` — the decoder holds *every* frame until
  an IDR the server may not send for minutes), abandoned frames, chroma
  fallback.
- **`static/client.html`** — posts those to `POST /api/sessions/{id}/diagnostic`,
  which logs them at WARN, and rides the existing 10s thumbnail capture to
  report `display_black` with an 8x4 grid of which cells are black. That
  transition is the timestamp everything else is read against; full screen
  points at a resize or graphics reset, scattered blocks at cache/copy ops.
- **Paint probes and page state** — every `display_black` report carries the
  decoder's `describeState()` (decoded vs painted counts, last keyframe and
  last paint, pending/queue depth), canvas context-loss state, visibility and
  fullscreen. While black, the decoder's `setProbing()` compares the next few
  decoded pictures with what reads back from the layer (`paint_probe`): a dark
  decode is the decoder, a bright decode that reads back dark is the canvas,
  and a bright one that lands with the screen still black means the rest of
  the layer lost its pixels. `display_black_persists` repeats the state each
  minute, `display_black_cleared` says whether a resize ended it, and
  `page_hidden` / `page_resumed` / `canvas_context_lost` / `_restored` cover
  the client idling. Two field episodes on 2026-09-10 showed **no overpaint
  and no `ResetGraphics`** around the black while H.264 kept arriving, which
  is why the evidence moved to the browser.
- **Every painted keyframe is probed** (`keyframe_probe`), always, as two 8x4
  grids -- the decoder's picture and the layer after -- with `#` black and `G`
  decoder green (zeroed YUV, ~(0,135,0)). A third episode (2026-09-11) found
  the canvas intact, the page visible and every delta landing, with a keyframe
  painted 2.5s before the black and the black cleared by ordinary deltas when
  the host redrew: the frame to suspect was painted before a black-triggered
  probe could start. Black or green in the *decoded* grid is the decoder,
  whatever the host sent; the 10s display check reports `display_green` too,
  since the same session went green minutes later.

Both budgets are per minute and global, so a looping page cannot fill a disk.
guacd defaults to `-L info` and rustguac to `RUST_LOG=info`, so all of it lands
in the journal with no configuration — but the journal must be persistent, or
a fault this rare is gone by the time it is reported.

### Binary blobs

Blob payloads of `h264` and `audio` streams are sent as **binary WebSocket
frames** rather than base64 inside text instructions, which is a quarter of the
wire — measured at 24.3% on an idle desktop capture and 24.9% on a video one.
`img` is deliberately excluded: its blobs feed `DataURIReader`, which wants the
encoded form.

The conversion is in **rustguac, not a guacd patch** (`src/binary_blob.rs`,
applied in `guacd_to_ws`). rustguac tees the raw guacd stream to disk as the
recording, so converting upstream of that tee would turn every recording binary
and take `SessionRecording.js` with it. Order in `guacd_to_ws` is therefore
record, then measure, then convert, then send — recording and `FrameStats` both
still see the text form.

Clients opt in with `binaryBlobs=1` on the WebSocket query, so an older cached
`client.html` or a third-party integration keeps getting base64. The frame is 8
bytes of header (version, type, two reserved, then a little-endian u32 stream
index) followed by the payload; `tests/binary-blob-format.mjs` pins that layout
across the Rust/JS boundary, because a disagreement there fails silently — the
client drops frames it cannot parse and video simply stops while both ends look
healthy. Full rationale in `docs/binary-blobs.md`.

### Native resolution (HiDPI)

Per-connection **Native Resolution** checkbox requests the framebuffer in the
browser's physical pixels rather than its CSS pixels, so text stays sharp on a
HiDPI display. The browser reports `device_pixel_ratio` on connect and the
server decides, since only the entry knows whether the target scales its own UI.

**A resolution change costs ~6 seconds of stalled video**, because it tears
down and rebuilds the browser's hardware H.264 decoder (measured on D3D11 at
2688x1488). So `client.html` debounces resize at 500ms and, more importantly,
skips `sendSize` entirely when the new size rounds to the same mod-16
framebuffer the server already has -- `patch 007-rdp-disp-mod16` rounds both
dimensions down, so any drag inside a 16px band is a no-op on the wire and a
decoder rebuild for nothing. Only the *decision* uses the rounded value; the
size sent is the true one, since the client cannot tell RDP from VNC and a VNC
server does no such rounding. The connect-time fit is exempt -- its repeats are
deliberate, covering a window where the server drops the size silently -- but
it seeds the record so later resizes compare against reality.

**The framebuffer factor and the desktop scale are separate numbers, and used
to be conflated.** The framebuffer takes the browser's true
`devicePixelRatio` (capped by `MAX_NATIVE_FACTOR`), because the client fits
whatever framebuffer arrives into the available CSS area -- so one framebuffer
pixel lands on one physical pixel only when the two agree. Snapping the
framebuffer to 1.8 on a 2.0 display left the client stretching by 1.111, which
measured in the field as a uniformly soft picture with almost no single-pixel
edges: 0.01% of adjacent pixels differing by >100 levels against a native
render's 0.82%. The cost of separating them is a desktop scaled 180% inside a
200% framebuffer drawing its UI ~10% smaller than nominal, which is legible and
adjustable on the host where a resample is neither.

**4:4:4 combining is declined above 4 megapixels** (`COMBINE_MAX_PIXELS` in
`H264Decoder.js`, overridable as `h264CombineMaxPixels`). The combine is a
read-back, six texture uploads and a shader pass per picture, all proportional
to pixels and all contending with the hardware video decoder on the same GPU:
`tests/bench` puts it at ~1.37ms per megapixel, so 4MP is about a third of a
60fps frame. 1080p spends 17% of a frame on it and 1440p 30%; 4K would spend
68% and a 5.5MP native-resolution session 45%, the latter measured in the field
as a frame backlog and sync timeouts.

**Keyed on framebuffer area, deliberately.** The desktop scale was tried first
and is wrong twice over: it only says whether HiDPI scaling was applied, so a
4K display at `devicePixelRatio` 1 slips past it and combines at 8.3MP; and the
cost is not a property of the host at all -- the same picture costs the same
whatever sent it, which is why this was taken for an xrdp problem until a
Windows session was run at native resolution. `?h264Chroma444=on` overrides,
and the declined case logs once saying why. **Re-checked at every main view while
combining** (`chroma_declined`): the framebuffer is resized after connecting, and
a fit that passed through 2240x1648 (3.7MP) as the first auxiliary view arrived
once left combining on at 2992x2000 (6MP) for the whole session -- a marked
slowdown, and the reason a `view=2` keyframe was ever painted at that size.
Only at a **main** view, never between a paired main view and its auxiliary
view: the main view is uploaded unpainted for the auxiliary one to paint, so
stopping in between discards the picture -- and when that is the connect-time
keyframe the session looks hung until a resize brings another.
**And never started until the size has settled** (`COMBINE_SETTLE_MS`, 5s). The
connect-time fit passes through 2240x1648 (3.7MP) for ~4s on the way to
2992x2000; an auxiliary view landing inside that window switched combining on
only for fullscreen to switch it off, and the session that went through that
transition stalled while one that did not, on the same host, did not. Whether
the view landed inside the window was a race -- a reload could make it vanish.
The settle wait takes the window out of play rather than chasing the race.

**`h264CombineLog` cannot see this cost:** it times GPU submission, not
execution, and reports the same work at under a millisecond; use `tests/bench`,
which calls `gl.finish()`.

RDP is asked to scale via `desktopScaleFactor` (patch `011-rdp-dpi-scaling`),
and **the two channels that carry it are not equally capable**. At connection
time only 100/140/180 survive: MS-RDPBCGR restricts `deviceScaleFactor` to
those three, and FreeRDP transposes the pair when synthesising its
single-monitor definition (`libfreerdp/core/settings.c` — the monitor's
`desktopScaleFactor` is filled from `FreeRDP_DeviceScaleFactor` and vice
versa), so only equal values reach the server intact. The display-control
layout has no such problem: `disp.c` builds it directly, nothing transposes it,
and MS-RDPEDISP 2.2.2.2.1 allows `desktopScaleFactor` anywhere in 100-500 while
restricting only `deviceScaleFactor`. So that layout carries the **exact**
percentage alongside the nearest legal device factor, and since the client fits
the display shortly after connecting it is what the session ends up scaled by.
That is what lets a 2.0 display run at 200% rather than the 180% that leaves
its UI 10% smaller than nominal.

The scale is re-sent on every display update — a `MONITOR_LAYOUT` carrying
zeroes resets the session to 100%, which used to undo it a second after connect.

X11 behind xrdp has no per-connection DPI negotiation; scale it inside the
session (`xfconf-query -c xsettings -p /Xft/DPI`). See `docs/xrdp-dpi-scaling.md`
for what an xrdp patch would involve.

## guacamole-server patches

The `patches/` directory contains patches applied to guacamole-server before building. These fix:

1. **Autoconf `-Werror` vs deprecated FreeRDP headers** — FreeRDP 3.15 deprecates `codecs_free()`, breaking `-Werror` compile tests and cascading into missing feature macros.
2. **Deprecated function pointer API** — Replaces `->input->KeyboardEvent()` etc. with `freerdp_input_send_keyboard_event()` safe API.
3. **NULL deref in display channel** — FreeRDP 3.x fires PubSub events before `guac_rdp_disp` is allocated.
4. **H.264 passthrough** (`004-h264-passthrough.patch`) — see `docs/rdp-h264.md`.

To add a new patch: edit `../guacamole-server`, export with `git diff > patches/NNN-description.patch`.

## Session types

- **SSH** — connects guacd directly to target SSH server
- **RDP** — connects guacd directly to target RDP server (same pattern as SSH, no browser spawning)
- **VNC** — connects guacd directly to target VNC server
- **Web** — spawns Xvnc + Chromium, guacd connects via VNC to local Xvnc display
- **VDI** — spawns Docker container with xrdp, guacd connects via RDP to container port 3389

### VDI (Docker containers)

Ephemeral per-user Docker desktop containers. `VdiDriver` trait in `src/vdi/mod.rs` enables downstream forks (JumpboxVDI) to add alternative backends (Nomad, Proxmox).

- Container naming: `rustguac-vdi-{username}` (deterministic, one per user)
- Lifecycle: created on first connect, persists after disconnect for `idle_timeout_mins`, reused on reconnect, destroyed on desktop logout or idle timeout
- Credentials: auto-generated per session (username from OIDC, random hex password), `chpasswd` updates on reuse
- BYO image: any Docker image with xrdp on port 3389 accepting `VDI_USERNAME`/`VDI_PASSWORD` env vars
- Test image: `contrib/vdi-test-image/` (Debian trixie + xrdp + xorgxrdp + xfce4)
- Thumbnails: client captures display screenshot every 10s, shown in connections "Active Sessions"
- Config: `[vdi]` section — `enabled`, `docker_socket`, `default_cpu_limit`, `default_memory_limit`, `ready_timeout_secs`, `idle_timeout_mins`, `allowed_images`, `home_base`
- Requires: `rustguac` user in `docker` group for socket access

## Ports

- 8089: rustguac HTTP/WebSocket
- 4822: guacd
- 6000-6099: Xvnc displays (:100-:199, internal)

## Testing

- `tests/test_browser_session.sh` — spawns Xvnc + Chromium, screenshots with xwd/ImageMagick, asserts non-black pixels
