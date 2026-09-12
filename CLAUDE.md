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

### HTTP caching

Nothing was said about caching until 2026-09-12, which is the worst of the
options: with no `ETag` and no `Cache-Control` a browser caches heuristically
and does not revalidate, so a restart kept serving the old page for hours and
incognito was the only reliable way to see a change.

**HTML revalidates; assets are content-addressed.** The branded pages are built
once at startup into an in-memory map, so each is hashed there too and served
with that `ETag` plus `no-cache` -- the revalidate directive, not do-not-store,
so an unchanged page costs a 304 rather than 136K of `client.html` or 255K of
`connections.html`. Tags are content-derived, not boot-derived: a restart that
changes nothing still answers 304.

The same pass rewrites `src="/guac/Client.js"` to `...?v=<8 hex of the file>`
(`version_assets`), and `asset_cache_control` gives any URL carrying a `v=`
query a year and `immutable`. That is worth doing because `client.html` reloads
on every session launch *and relaunch*, and the WAN leg is browser-to-proxy
HTTP/2 -- so the 37 revalidations are one round trip rather than 37, but it is
a round trip paid exactly when the link is worst. Only a 2xx or 304 gets the
long directive; a 404 under a versioned URL is a deployment that has gone
wrong, and pinning it until next year would outlive its cause.

**The cost is that editing an asset now needs a restart, where a reload used to
be enough** -- the URL in the HTML and the bytes it names are produced in the
same startup pass, so a JS edit is invisible until the hash is recomputed.
`RUSTGUAC_NO_ASSET_VERSIONING=1` turns versioning off for that reason, leaving
everything revalidating as before. This supersedes the older note that
`static/guac/*.js` edits need no rebuild: they still need no *rebuild*, but
they do now need a restart.

Query-string versioning rather than hashed filenames because there is no build
step to rename anything, and the startup rewrite already existed for branding.
The old caution about proxies refusing to cache URLs with queries has not been
true for many years.

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
makes AVC444 dearer than AVC420. **The read-back is almost all of it, and it
is not where it was looked for.** `VideoFrame.copyTo()`'s *synchronous* half --
the D3D11 array-texture copy and staging map, before the promise exists --
measured 2026-09-12 at ~6.5ms per megapixel plus a 5-10ms per-call stall,
against under 2ms for the uploads, the shader and the blit together. It used
to scale with resolution; since both views' copies are limited to the damaged
rows it scales with damage. Four things trim it: a main view whose auxiliary
view follows is uploaded but never painted (the `h264` instruction carries a
trailing `<paired>` flag, set by
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

A fifth: `texSubImage2D` uploads only the rows the damage rects touch, merged
and rounded outward (`bandsFor()`, and `auxV1LumaBands()` for the v1 layout,
which scatters an output row across 16-row bands). Rows rather than rectangles
because plane rows are contiguous and the packed chroma layouts address both
halves of a row.

And a sixth, which is the one that mattered: **`copyTo()` reads only those
rows too** (`copyBandsFor()`, rounded outward to 16 -- exactly what
`auxV1LumaBands()` does to reach the v1 layout's bands, and a superset of the
v2 layout's one-to-one rows and both layouts' chroma at `y >> 1`, which is why
one band serves both views). Until then the narrowest stage of the pipeline
was fed by the widest: the uploads and the shader were limited to the damage
while the copy read the whole frame every picture. On a Windows host at
2992x1648 with light typing, main-thread time inside `copyTo()` went from ~77%
to ~16%, and `decode` from 28-38ms to 1-4ms behind it.

**Several bands, not one span.** A single bounding span is defeated by
anything scattered -- a clock in one corner and a caret in the other span the
whole screen between them, and a desktop reliably has both. Each extra
`copyTo()` is a fixed stall (~3ms), so two regions are worth separating only
when the gap saves more transfer than the call costs: `minWorthwhileGap()`
derives that from the width (~309 rows at 2992 wide, asking a gap to save
twice what it costs), and `COPY_BAND_MAX_BANDS` caps it at four by closing the
cheapest gaps first.

**It only fires where the server declares real damage**, and the alignment it
needs differs by chroma layout. FreeRDP's `general_ChromaV1ToYUV444` walks the
v1 layout's 16-row tiles *relative to the rect* while the packing shader
anchors them at frame row 0: after a 16k-row offset the full-frame walk stands
at `uY = 8k` and the rect-relative walk needs `uY_rect + roi->top / 2`, so the
two coincide exactly when, and only when, the top is a multiple of 16.
`general_ChromaV2ToYUV444` has no tiling and no counters -- every row is
computed from the absolute frame row -- so it needs only an even top. Both
address chroma columns at `roi->left / 2` and `/ 4` and select destination
phases on `4x+0` / `4x+2`, so both want a 4-aligned left.

The fork declared a single full-frame rect on both views until 2026-09-12, on
that invariant; it now rounds the damage rects outward to that grid instead
(vertical 16 for v1, 2 for v2, horizontal 4 for both) and gives the same list
to both views, which also keeps main's even chroma rows and aux's odd rows
refreshing from one frame. `XRDP_GFX_AVC444_FULL_RECTS=1` is the kill switch,
and `~/aa444work/aa444map` quantifies the chroma error if the alignment is ever
in doubt.

**An auxiliary view's declared rects must cover what it carries, not what the
frame changed.** Under `CHROMA_INTERVAL=N` accel-assist accumulates damage
across the skipped frames, so declaring only the current frame's leaves stale
chroma wherever the screen changed in between -- fresh luma over old chroma,
which reads as colour ghosting and is masked at high damage, where the client
uploads whole planes anyway. How much this costs depends on whether the damage
moves: glxgears animates one region, so its accumulated union is barely larger
than one frame (`aux copied 37%` against `main copied 34%`), while a pointer
dragged across a desktop would spread it.

Measured on xrdp with glxgears at 2992x1648 once both were fixed: the auxiliary
copy fell from 29.3ms to 12.6ms, per-picture copy from 22.4ms to 17.0ms, and
throughput rose from ~30 to ~41 pictures a second.

**Every xrdp capture showing 97-99% damage was a maximized VS Code window**,
and the arithmetic settles it: 1920x1047 of a 1920x1072 screen is 97.67%,
against a measured mean of 97% and max of 99%. An Electron/Chromium window
repaints its whole surface on any change, a blinking caret included, so what
looked like an idle desktop was one application damaging almost the entire
screen a few times a second. Minimising it drops declared damage to 2%, and the
client then bands **100% of both views** at `copied 3%`, for 0.6-0.7% of the
main thread against the 4-7% the same idle desktop cost unbanded. That is the
positive confirmation, not merely the absence of damage: xrdp declares real
fine-grained rects and the banding consumes them.

So **xorgxrdp is honest** -- it forwards what X reports, and X was reporting a
genuine full-surface repaint. One rect throughout, in every regime measured, so
`MAX_CAPTURE_RECTS` and its extents collapse were never entered and remain
irrelevant. Banding works on xrdp for ordinary desktop content; what it cannot
do is help while one application owns the screen and repaints all of it, which
is a property of the application rather than of the server. The glxgears
figures read the same way once seen in this light: 33-34% was the size of the
window it animated, not some lesser quantity of damage.

**Three xrdp captures in a row were mislabelled by what was on screen** --
glxgears read as desktop work, a scroll tail read as idle, and a maximized
Electron app read as an idle desktop. The instrument was right every time and
the label was not, so before drawing anything from a damage figure, establish
what was actually on the screen and how large it was. The client's `span` and
`damage` are merged *row* coverage, so a single large window saturates both.

**`tests/bench` cannot see the dominant cost, by construction.** Its
`copyTo()` row reads 0.29ms at 1080p against ~14ms in the field, because it
feeds pre-decoded frames that already live in system memory; a frame from a
hardware decoder is a D3D11 array texture, and pulling its planes out means a
texture copy and a staging map the bench never performs. Everything below is a
true measurement of the wrong thing. Do not conclude from it that the
read-back is cheap -- that is what hid the real cost for months.
`h264CombineLog`'s `copy` and `issue` stages measure it live, and split
`issue` into `allocationSize()` (0.0ms), the buffer pool (0.0ms) and
`copyTo()` (all of it).

**Measure before optimising the rest** — `tests/bench/README.md`. The four
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

* **Symptom, because *GPU* cost cannot be measured cheaply.** Timing GPU
  execution needs a `gl.finish()` per picture -- stalling the pipeline the gate
  exists to protect -- or timer queries that are not reliably available. A held
  sync ack needs neither and is what the user actually feels. That reasoning
  still holds, and it is exactly why it does **not** apply to
  `COMBINE_COPY_TRIP_SHARE` (lever 3): `copyTo()`'s prologue is blocking
  main-thread time, so timing it is a wall-clock delta across a synchronous
  call -- exact, free, on a path already paying it. The old argument was about
  GPU work, and the dominant cost turned out not to be GPU work.
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
* **And slow flushes, because at 2MP the client keeps up but sets the pace.**
  Same video, 1920x1072, xrdp fork host: 4:2:0 ran at **54.7 syncs/s with a
  0.6ms mean flush**; 4:4:4 at **33-41/s with 16-22ms** (14ms even at
  1920x896) -- and **no hold and no timeout in either mode**, so the timeout
  trip could never see a 40% frame-rate cost. A 10s window while combining
  with at least `COMBINE_FLUSH_MIN_SYNCS` (100) syncs and a mean flush over
  `COMBINE_FLUSH_TRIP_MS` (8ms) also trips the latch. The minimum count keeps a
  static desktop (a few syncs/s) combining, which is where full chroma is worth
  having.
* **A latch with hysteresis, not a controller.** The old budget's divisor was
  the observed interval between pictures, which is what `012`'s frame-ack
  back-pressure has already throttled the server down to -- and that
  back-pressure reacts to the lag combining causes. It read its own output as
  its input and needed a capped ceiling to stop it hunting. This has no loop:
  it gives up, waits `COMBINE_RECOVER_MS` of **quiet** -- under
  `QUIET_SYNCS_PER_SECOND` (10) and no sync timeout -- tries again, and after
  `COMBINE_MAX_TRIPS` stops trying. Quiet, not merely clean: 4:2:0 never
  flushes slowly, so "30s clean" resumed mid-video, tripped a window later and
  spent every trip on one video. Tripping during a video and resuming once it
  has stopped is the expected shape.
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

1. **Whether AVC444 is advertised at all** (`013-rdp-avc420-only`, set per
   connection -- lever 2 below). Clearing `GfxAVC444` is the only one
   of the three that reduces what is *sent and decoded*: one bitstream instead
   of two, so half the bandwidth, half of guacd's copy and queue work, and one
   decode per picture instead of two. It is also the only lever with a quality
   argument behind it rather than a cost one -- at 1.4x or 1.8x a 4:2:0 chroma
   block covers close to one logical pixel, so the density has already bought
   most of what combining recovers.
2. **The per-connection codec offer: AVC444 + AVC420, that pair never
   combined, or AVC420 only** (stored as `avc444` true/false plus
   `h264_combine`, which reaches client.html through `SessionInfo` as
   `h264_no_combine` and sets the `h264Chroma444` window override before the
   decoder exists -- combining is the only one of the three levers the server
   never sees; the first is the default; an
   Automatic option that dropped AVC444 under HiDPI was removed 2026-09-11 --
   on Windows it lost H.264 outright, and the combine cost it guarded against
   is now judged in the browser by area and measured flush; unset entries are
   sent as AVC444 + AVC420, never as guacd's empty/auto value). Not really a
   chroma switch: Windows offers no H.264 below RDPGFX v10 and FreeRDP emits
   those capability sets only when AVC444 is requested, so AVC420 only on a Windows
   host loses H.264 altogether rather than downgrading its chroma. A per-target
   compatibility decision, invisible to the client. It says what the server is
   asked to send, **not** what gets drawn -- AVC444 + AVC420 on a 4K host still paints
   4:2:0 once lever 3 suspends, and is still the correct setting there, because
   it is what keeps H.264 working at all. Do not be tempted to make AVC444 + AVC420
   disable lever 3: it is the recommended setting for every Windows target,
   so that would switch the gate off exactly where it earns most. xrdp needs the same lever
   from the other direction -- see [[xrdp-avc444-causes-chop]] in project
   memory, where AVC444 itself causes the chop and only clearing `GfxAVC444`
   fixes it.
3. **The client-side combine gate.** Acts in the decoder's output callback,
   after both access units have already been decoded, so it removes the combine
   and nothing else -- never the decode or the bandwidth, which is why it does
   not replace lever 1. Three parts, in the order they act:

   * `COMBINE_MAX_PIXELS`, a static threshold on framebuffer area, raised to
     4K on 2026-09-12. A prior only -- a ceiling on the worst case a session
     may open with before anything has been measured. It was 4MP, set against
     the shader and the uploads, which were later measured at under 2ms
     together; it was declining to combine on sessions costing ~9ms a picture.
   **What the gate protects is input as much as frame rate**, which was not
   part of its design. `client.sendMouseState()` runs synchronously in the DOM
   handler, on the thread `copyTo()` blocks, and the browser coalesces the
   `mousemove` events that pile up behind it -- so the intermediate positions
   of a drag are lost, not merely delayed. Observed 2026-09-12 on xrdp at
   1920x1080: dragging a VS Code scrollbar repeatedly lost the thumb, and
   stopped doing so the moment the gate suspended combining. Only 2.07MP, but
   scrolling repaints the whole editor pane, so banding declines and the copies
   go back to whole planes twice a picture. A video degrades gracefully under
   the same load; a drag does not, which is why the thresholds are worth more
   than their frame-rate justification suggests.

   * `COMBINE_COPY_TRIP_SHARE` -- 30% of wall clock spent inside `copyTo()`
     over a busy window, and **the only copy condition**. A mean-per-picture
     threshold sat beside it until 2026-09-12, both required; that was wrong,
     and the case that showed it is the one the gate most needs to catch.
     xrdp at 1920x1080 dragging a VS Code scrollbar ran 39-47 pictures a
     second at 12ms each -- 46-60% of the main thread, drags losing the
     thumb -- while the per-picture figure sat under any sane threshold and
     vetoed the trip. Many cheap copies is the shape that hurts, and per
     picture is blind to it. The near-idle desktop it was added to protect
     (33-38ms a picture) needs no protecting: 4.6% share declines on its own.
     Measured shares -- Windows idle 4.6%, Windows typing 17-19%, video ~45%,
     xrdp scrolling 46-60%, glxgears 70% -- all land on the right side of 30%
     unaided. The pathological case per picture would have caught, one
     enormous copy against an idle session, exceeds `SYNC_WAIT_TIMEOUT_MS`
     and the sync-timeout latch takes it.
   **Combining costs latency and main-thread occupancy, not frame rate**,
   which is why the frame-rate framing this gate was first built on kept
   stepping over it. Measured across one suspension, xrdp at 1920x1080 with
   VS Code scrolling: 211 pictures in 5s while combining against 207 after --
   the rate is unchanged, the server was never the limiter and the client kept
   up either way. What changed was `copyTo()` from 52% of the main thread to
   nothing, `draw` (decoded to painted) from 12.9ms to **0.3ms**, `decode`
   luma from 3.1ms to 0.5ms and chroma from **15.5ms to 0.9ms** -- the same
   decoder doing the same work, so that was never decode cost but output
   callbacks queued behind a blocked main thread. A drag feels exactly that
   and a video does not.

   **The flush latch caught the first real input case and the copy gate did
   not**, which is what removed the per-picture condition. xrdp at 1920x1080,
   dragging a VS Code scrollbar: `mean flush 30.0ms over 128 syncs in 10s`.
   **Syncs are not pictures** -- guacd batches several `h264` instructions into
   one frame, so 12.8 syncs a second was 39-47 pictures a second, and reading
   the sync rate as the picture rate put the first estimate of this case out by
   a factor of three in both directions. `h264CombineLog` settled it: 12ms a
   picture, 46-60% share. The share was never the problem; the per-picture
   veto was.

   **A gap remains.** The flush latch needs 100 syncs in 10s and got 128. A
   session at eight syncs a second with a 25% share is caught by neither --
   under the share threshold, under the latch's minimum. Same shape as the copy
   window that used to be discarded for having too few pictures, and not yet
   fixed here.

   * The sync-timeout and slow-flush latches, as the safety net beneath both.
     Their minimums are what decides which fires: the sync-timeout latch has
     none (3 timeouts in 10s), the copy gate needs 30 pictures in 10s, the
     flush latch 100 syncs. So a session degraded to a few frames a second --
     fullscreen video at high resolution, say -- is caught by the
     sync-timeout latch first and the copy gate at the next window boundary,
     while the flush latch may never reach its minimum at all.

   The middle one *does* measure the cost, and legitimately -- see the
   adaptive suspension note above for why that is the opposite of the mistake
   made in September rather than a repeat of it. The area threshold and the
   latches still do not, deliberately.

   `sync_hold` reports the holds once a minute, split by mode (syncs/s, share
   held, mean hold across all syncs and across held ones, max, timeouts), with
   session totals in `describeState()` -- the numbers the timeout trip was set
   from, and the ones to re-measure against if it misfires. **It reports only
   a window containing a sync timeout** unless `h264CombineLog` asks for all of
   them: it was the last always-on periodic reporter in the file, once a minute
   for the life of every session, where everything else speaks on a state
   change.

   **The recovery window doubles each trip** (`COMBINE_RECOVER_MS` 30s, capped
   at `COMBINE_RECOVER_MAX_MS`, 8 minutes) **and eases by one doubling per
   `COMBINE_BACKOFF_DECAY_MS` (5 minutes) of combining without a trip**, so
   30s-60s-120s-240s-480s on the way up and the same steps back down. Without
   the decay the backoff is monotonic for the life of the session and a video
   at lunchtime leaves an eight-minute wait in front of an unrelated trip that
   evening -- the cap's fault again, only softer. One doubling per clean
   stretch rather than a reset, so a session that trips just often enough to
   keep clearing the bar still backs off overall. Unlike the cap's forgiveness
   this is reachable, because nothing is terminal: a backed-off session always
   resumes eventually and can accrue the clean time, where under the cap
   combining never restarted so the clock never ran. There is no attempt
   limit. A cap
   on attempts was tried first, on the sound reasoning that a client recovering
   from transient load and one that cannot sustain the combine look identical
   sample by sample -- but a permanent latch was the wrong instrument for it:
   it condemned the rest of the session for a workload that had passed, and
   bounded re-probing no better than backing off. Re-probing costs a
   whole-plane resync (`suspendCombining` leaves `resyncNeeded` set) plus a
   copy window spent combining at a price the client cannot afford, since the
   gate needs that long to trip again -- about a quarter of the session at 30s
   between attempts, a few per cent at eight minutes. Flapping itself is
   nearly invisible, since only newly painted regions change chroma
   resolution; the resync is the cost, not the appearance.

   **Probing is the only signal there is.** A suspended session paints 4:2:0,
   which never times out and never flushes slowly, so nothing in that state can
   report that the video has ended -- and `QUIET_SYNCS_PER_SECOND` cannot
   either at a framebuffer where both modes run below it, which is every
   session large enough to trip. So it has to be paid occasionally; the backoff
   is what makes it rare and `COMBINE_PROBE_WINDOW_MS` (2s, 8 pictures) is what
   makes it short. The first window after a resume uses those instead of the
   full 10s and 30: the whole of a probe is spent combining at a price the
   client cannot afford, and ten seconds of that on sustained video is a
   visible stutter on a timer, far worse to watch than its share of the session
   suggests. It can be short because the answer is not a close one -- a session
   that cannot sustain the combine copies whole planes at ~42ms a picture
   against a 20ms line. What is left is one resync picture per attempt, since
   resuming leaves `resyncNeeded` set.

   **A copy window is never discarded for having too few pictures**, only held
   open until it has them. Discarding meant a session below three pictures a
   second -- an ordinary rate at a large framebuffer, and exactly where the
   combine hurts -- never reached a verdict and combined indefinitely at
   whatever it cost.

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

**First cause found (2026-09-11): a keyframe with zero region rects, painted
whole.** Mid-session, with no resize, Windows sent an IDR whose
`numRegionRects` was 0; `keyframe_probe` read its decoded picture as 100%
decoder green (zeroed YUV -- uninitialised content), and the client painted it
over the whole screen, because it read "no rects" as "whole picture valid". In
MS-RDPEGFX the region rects are the areas that *changed*, and FreeRDP's
`avc420_decompress` copies and invalidates only those -- zero rects changes
nothing. The client now tells an absent list (older guacd: whole picture) from
an empty one (decode for references, paint nothing, report `h264_undisplayed`).
**Second cause, the main one: Windows recreating its surface at the same size.**
guacd's patch-014 trace put `DeleteSurface`+`CreateSurface 2992x2000` over a
2992x2000 surface 2-4s before *both* black episodes that day (12:35:40,
15:03:45), and those were the only same-size recreations -- every other one was
a resize, after which Windows repaints everything. The new surface is empty, its
first keyframe (full-screen rect) decodes black, and Windows then repaints only
what it thinks changed. It is the same Windows behaviour as sol1/rustguac#118,
whose reporter proved that `SuppressOutput` off/on and `RefreshRect` do **not**
make Windows re-stream the surface -- so do not try that again. #118 was fixed by
re-sending pixels the client side already had; under passthrough those are in
the browser, so `keepPictureOverBlackKeyframe()` withholds a keyframe decoded
>=98% black when the framebuffer has kept its size for 5s (decoded for its
references, not painted; `h264_black_keyframe_kept`), and Windows' partial
repaint lands on the old picture. `h264KeepBlackKeyframes=off` disables it.

Both budgets are per minute and global, so a looping page cannot fill a disk.
guacd defaults to `-L info` and rustguac to `RUST_LOG=info`, so all of it lands
in the journal with no configuration — but the journal must be persistent, or
a fault this rare is gone by the time it is reported.

**The browser-side probing is off by default since 2026-09-12**
(`h264BlackProbes` to bring it back — it gates the keyframe probe, the delta
probes, the episode trigger, and client.html's periodic black and green display
checks). It was on before the fault because the fault could not be reproduced;
both causes have since been found and fixed, and the cost was not small:
`probeKeyframe()` ran on every painted keyframe and sampled the layer through
`sampleGrid()`, which `drawImage()`s the **whole framebuffer** into a
`willReadFrequently` canvas — a full GPU-to-CPU readback, ~19.7MB at 2992x1648,
in the same class as the `copyTo()` cost the rest of this section is about.
`src/frame_stats.rs` is unchanged: it is one relaxed atomic load per
instruction until an `h264` is seen, which is cheap enough to leave watching.

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

**4:4:4 combining is declined above 4K** (`COMBINE_MAX_PIXELS` in
`H264Decoder.js`, overridable as `h264CombineMaxPixels`) **and given up when
the copy costs too much** (`COMBINE_COPY_TRIP_SHARE`, 30% of wall clock spent
inside `copyTo()` over a busy window).

The threshold was 4MP until 2026-09-12, on the reasoning that the combine is a
read-back, six texture uploads and a shader pass, all proportional to pixels.
The uploads and the shader are proportional to pixels and are also under 2ms
together; the read-back is `copyTo()`'s synchronous half, and once it is
limited to the damaged rows it is not a function of the framebuffer at all. A
4.93MP Windows session doing desktop work copies 3-5% of its planes and spends
~9ms a picture, which the old threshold declined outright. What it was right
about was full-screen video, which damages every row and costs ~42ms a
picture -- and that the measured gate catches within a window, on any
resolution, without being told.

**The area threshold is keyed on framebuffer area, deliberately.** The desktop
scale was tried first and is wrong twice over: it only says whether HiDPI scaling was applied, so a
4K display at `devicePixelRatio` 1 slips past it and combines at 8.3MP; and the
cost is not a property of the host at all -- the same picture costs the same
whatever sent it, which is why this was taken for an xrdp problem until a
Windows session was run at native resolution. `window.__h264Chroma444 = true`
overrides (or the `h264Chroma444` key in localStorage -- a query parameter is
read but unreachable on a live session, since client.html rebuilds its own URL
on every launch and relaunch),
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
