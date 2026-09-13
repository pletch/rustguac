# rustguac

[![CI](https://github.com/sol1/rustguac/actions/workflows/ci.yml/badge.svg)](https://github.com/sol1/rustguac/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sol1/rustguac)](https://github.com/sol1/rustguac/releases/latest)
[![License](https://img.shields.io/github/license/sol1/rustguac)](LICENSE)
[![Docker](https://img.shields.io/docker/pulls/sol1/rustguac)](https://hub.docker.com/r/sol1/rustguac)

> **Fork notice** — This is a personal fork of [sol1/rustguac](https://github.com/sol1/rustguac) maintained by [@pletch](https://github.com/pletch), with additional fixes and features layered on top of upstream **v1.10.0** (see [Fork changes](#fork-changes)). Badges and install instructions below still point at the upstream project; for canonical releases and commercial support, use the upstream repository.

A lightweight Rust replacement for the Apache Guacamole Java webapp. Browser-based SSH, RDP, VNC, SPICE, Proxmox VE consoles, web browsing, and VDI desktop containers through [guacd](https://github.com/apache/guacamole-server).

No Java. No Tomcat. Single binary + guacd.

## Fork changes

This fork layers the following on top of upstream **v1.10.0**. Everything here
is in `main-fork`; the guacd-side changes live in `patches/` and are applied by
the build scripts.

### RDP H.264 passthrough

Upstream now carries the passthrough base, AVC444 included — it started here
and was merged for v1.10.0 (see [Merged upstream](#merged-upstream)). What
remains below is what has been built on top of it since: the wire-side colour
repair, the per-entry codec offer, dropping the auxiliary view in transit, and
the measurement work that made the browser-side combine affordable.

- **Codec configuration** — the decoder takes its codec string from the
  stream's own sequence parameter set where there is one, falling back to
  `avc1.640034` (High, 5.2); upstream declares a fixed `avc1.640029` (High,
  4.1). **The level is not advisory**: Chrome sizes its hardware decoder from
  it and a stream whose frames exceed it falls back to software *silently*.
  Level 4.1 permits 8192 macroblocks, which holds for 1920x944 and fails for
  2688x1488 — measured decoding in software at roughly twenty times the
  latency, and under AVC444 for two pictures per frame.
- **`hardwareAcceleration: 'prefer-hardware'` reads as a hint and is not one** —
  Chrome reports a configuration carrying it as unsupported outright where no
  hardware decoder exists, rather than falling back, and it fails *after*
  `configure()` returns. So a client without one lost H.264 altogether and lost
  it in the worst shape available: the decoder closed, every frame was then
  held for a keyframe that cured nothing, and since guacd suppresses ordinary
  image operations for a layer carrying H.264, the result was a permanently
  black screen rather than a degraded picture. The decoder asks once and, if
  refused, builds again without asking, then reports
  `decoder_software_fallback` — a session quietly decoding in software is the
  difference between the cost this feature avoids and the cost it was built
  around. Dropping the hint unconditionally is the smaller change and the wrong
  one: it hands the choice to the browser on every client, including the ones
  this path exists for.
- **Colour range** (`src/h264_rewrite.rs`, `src/h264_sps.rs`) — MS-RDPEGFX
  defines the ARGB-to-AYUV transform as full-range BT.709 and hosts encode to
  it, but Chrome's *hardware* decoder ignores a `video_full_range_flag` that
  arrives with no colour description, while its software decoder honours it.
  Windows sends exactly that shape, so its sessions rendered with blacks
  crushed and chroma over-saturated by 255/224, while the xrdp fork — which
  sends the same flag *with* a BT.709 description — rendered correctly. This
  fork completes the signalling on the wire, deciding once per session: a
  description is spliced into an SPS that declares a range without one, and
  full-range BT.709 written into one that declares nothing at all — which is
  what stock xrdp sends, since it passes x264 no VUI parameters and x264 then
  omits the block entirely. Doing it there rather than in
  the client reaches `drawImage()`, which no client-side flag can, and every
  client including third-party ones. Recordings are teed upstream of the
  rewrite and keep the host's original stream, so `?h264FullRange=on` on the
  recording player is the lever for playback. On a live session use the
  `h264FullRange` key in `localStorage` instead: the client builds its URL on
  every launch and relaunch, so a hand-added query param does not survive a
  reconnect, and the window global is read once per decoder generation rather
  than per frame.
- **Per-connection AVC444 request** (`patches/013-rdp-avc420-only.patch`) —
  which H.264 codecs are offered, per entry: **AVC444 + AVC420** (the server
  chooses), **AVC444 + AVC420, never combined**, **AVC444 + AVC420, chroma
  dropped in transit** (the default for new entries; see below), or **AVC420
  only**. Never combined leaves the offer alone and tells the browser to paint
  4:2:0: the second view is still sent and decoded, but each update reaches
  the screen 12-17ms sooner, which suits a target used mainly for typing. AVC444 + AVC420 is required for
  Windows targets: they offer no H.264 below RDPGFX v10, and FreeRDP emits
  those capability sets only when AVC444 is requested, so AVC420 only loses
  H.264 there altogether rather than downgrading its chroma. AVC420 only is
  for xrdp targets where bandwidth or decode work matters more than chroma. This says what the
  server is asked to send, not what the browser draws -- whether the two views
  are combined is decided per picture in the browser. (An Automatic option
  that dropped AVC444 under Native Resolution was removed: on Windows it lost
  H.264 outright. Entries saved with it are treated as AVC444 + AVC420.)
- **Dropping the auxiliary view in transit** (`src/h264_aux_drop.rs`,
  `src/h264_refs.rs`) — removes AVC444's second picture from the wire between
  rustguac and the browser, where the stream proves it can spare it: **13% of
  the H.264 payload on a Windows host, 43% on the xrdp fork**, and one decode
  per picture instead of two. It reaches what nothing else can on a Windows
  target, where AVC444 is not a quality choice but the price of admission —
  `AVC444ModePreferred=1` is what puts the host on its *hardware* encoder, so
  the auxiliary view cannot be declined at the source, while at a
  `devicePixelRatio` of 2 the colour detail it carries is already below one CSS
  pixel. Declining the offer loses hardware encoding and on Windows H.264
  entirely; the combine gate acts only after the bytes have arrived and been
  decoded.

  Nothing is dropped until the stream has answered two questions, parsed from
  the first slice header of each access unit without ever decoding. *Does
  anything surviving predict from a dropped picture?* — a relative reference
  reordering in a main slice is refused outright, and disjoint long-term
  indices between the views are what prove the chains separate. *Is there room
  for the pictures a gap makes the decoder invent?* — H.264 obliges a decoder
  to fill each hole in `frame_num` with an inferred short-term reference, and a
  stream whose `max_num_ref_frames` is entirely consumed by long-term ones has
  nowhere to put it and fails outright. Neither is answerable from the
  connect-time keyframe burst, so the verdict takes about 2.5s; a stream that
  never qualifies is passed through untouched and says in the disconnect
  summary what it was short of. `RUSTGUAC_H264_AUX_DROP=0` is the
  deployment-wide kill switch.

  The client has to be told, because it cannot tell: auxiliary IDRs are
  deliberately kept, and one of those arms the combiner for every main view
  after it — paying a plane read-back and a shader pass per picture to produce
  the ordinary 4:2:0 result `drawImage()` gives almost free, waiting for a view
  that has been removed upstream. Measured at 163 pictures in 10s at 19.0ms of
  copying each, 31% of the main thread. So rustguac sends an `h264-aux`
  instruction carrying 1 or 0 when the state changes, at most twice a session.
- **What the combine actually costs** — not the shader, and not the uploads.
  `VideoFrame.copyTo()`'s *synchronous* half — the driver's texture copy and
  staging map, before the promise exists — is **10ms plus 5ms per megapixel**,
  against under 2ms for the uploads, the shader and the blit together. It hid
  for a long time because the obvious instrument times the promise, which reads
  0.0ms: by then the blocking work is done. The fixed part dominates at the
  sizes banding produces, and was badly underestimated at first: an earlier
  pair of 2.7ms + 6.5ms/MP came from two samples at 4.93MP and 1.72MP, so its
  intercept was extrapolated off a short lever arm. The two models agree to
  0.4ms at 4.93MP and differ threefold at 0.15MP, where eight measured copies
  averaged 11.8ms against a predicted 3.6ms. The
  ImageBitmap handoff, the shader, software-decode fallback and GPU bandwidth
  were each ruled out with a measurement first (see
  [`docs/rdp-h264.md`](docs/rdp-h264.md)).
- **So the copy reads only the damaged rows** — both views, rounded outward to
  16, which is the grid the v1 chroma layout's 16-row tiling needs and a
  superset of what v2 and the chroma planes need, so one band serves both.
  Several bands rather than one bounding span, because a clock in one corner
  and a caret in the other span the whole screen between them; each extra
  `copyTo()` is a fixed stall, so a gap is only worth splitting when it saves
  more transfer than the call costs. Until this, the uploads and the shader
  were banded to the damage while the copy read the whole frame every picture —
  the widest stage of the pipeline feeding the narrowest. On Windows at
  2992x1648 with light typing, main-thread time inside `copyTo()` fell from
  ~77% to 12-17%, and decode with it, from 28-38ms to 1-3ms.
  It only helps where the server declares real damage rects.
- **4:4:4 combining is given up when the copy costs too much** — the gate
  follows the measured cost rather than the resolution. `COMBINE_MAX_PIXELS`
  (4K) is a prior only, a ceiling on what a session may open with before
  anything has been measured; the combine is given up when a busy window
  spends more than `COMBINE_COPY_TRIP_SHARE` (30%) of wall clock inside
  `copyTo()`. Share rather than cost per picture, because many cheap copies
  is the shape that hurts: a session scrolling at 40+ pictures a second and
  12ms each is half the main thread, and blocks the thread mouse events
  arrive on, so drags lose what they are dragging.
  Measuring is legitimate here where it was not for the GPU work: this is a
  wall-clock delta across a synchronous call, not execution needing a
  `gl.finish()` that would stall the pipeline the gate protects. Sync-timeout
  and slow-flush latches sit beneath it as the backstop for congestion the
  share does not explain — the slow-flush one is what first caught a session
  breaking drags, while the gate still required a per-picture threshold and
  declined. It retries after 30
  seconds of quiet, doubling that wait per trip up to eight minutes and easing
  it back as combining holds up, so nothing is ever given up permanently; only
  newly painted regions change chroma resolution, so a transition is gradual
  rather than a flash. An
  explicit `h264Chroma444` override disables every part of it.
- **What else trims the combine** — a main view whose auxiliary view follows is
  uploaded but never painted (that is what `<paired>` carries, set by guacd
  from MS-RDPEGFX LC=0, since only the server knows before the second access
  unit arrives); the renderer draws into an `OffscreenCanvas` and hands over
  the drawing buffer with `transferToImageBitmap()`; the two views' `copyTo()`
  calls are in flight at once; and the uploads are banded to the damaged rows
  like the copy.
- **Frame-acknowledgement back-pressure**
  (`patches/012-rdpgfx-frame-ack-backpressure.patch`) — guacd holds the RDPGFX
  frame acknowledgement by the amount the client's processing lag exceeds its
  target, *minus* the spacing the server has already provided since the
  previous frame. That subtraction makes it a floor rather than a second
  controller: a server that paces itself from the same round trip would read an
  additive hold as client latency and hunt against it on a roughly one-second
  cycle.
- **Runtime overrides for the chroma path** — `h264Chroma444` (off falls back
  to 4:2:0), `h264ChromaFilter` (off, or a 0-255 threshold; default 30),
  `h264CombineMaxPixels` (the 4K prior above), `h264CopyBands` (off copies
  whole planes), `h264FullRange` (force the decoder's range),
  `h264BlackProbes` (on re-enables the black-region probing, off by default
  since its causes were found and fixed — the keyframe probe read back the
  whole framebuffer), `h264KeepBlackKeyframes` (off stops withholding a
  keyframe that decodes black over a stable framebuffer) and
  `h264CombineLog` (per-stage timings every 5s). Each is
  read as a window global, a query param, or a `localStorage` key — but only
  `localStorage` survives a session relaunch, since the client rebuilds its own
  URL, and only `h264Chroma444` and `h264ChromaFilter` are read per picture, so
  they are the two a window global can change mid-session.

### Transport

- **Binary blobs** (`src/binary_blob.rs`, [`docs/binary-blobs.md`](docs/binary-blobs.md))
  — blob payloads of `h264` and `audio` streams are sent as binary WebSocket
  frames instead of base64 inside text instructions. Base64 sends four bytes
  for every three, so this is **roughly a quarter of the wire**: measured at
  24.3% on an idle desktop capture and 24.9% on a video one, both round-tripped
  byte for byte. `img` is deliberately excluded, since its blobs feed
  `DataURIReader`, which wants the encoded form.

  It is a departure from the protocol as specified: the Guacamole protocol is
  defined as text, `.guac` recordings are that same stream on disk, and
  Guacamole's other transport — the HTTP long-polling tunnel, which rustguac
  itself does not serve — could not carry interleaved binary at all. It is
  worth doing because sustained multi-megabit H.264 is a workload the protocol
  was not shaped around: base64 was a reasonable price for keyframes and
  clipboard, and is not one for video.

  The conversion is in rustguac rather than a guacd patch, because rustguac
  tees the raw guacd stream to disk as the session recording; converting
  upstream of that tee would turn every recording binary. Clients opt in with
  `binaryBlobs=1`, so anything older — a cached `client.html`, a third-party
  integration, the recording player — still receives base64.

- **HTTP caching** — nothing was said about caching at all until recently,
  which is the worst of the options: with no `ETag` and no `Cache-Control` a
  browser caches heuristically and never revalidates, so a restart kept serving
  the old page for hours and incognito was the only reliable way to see a
  change. The branded pages are built once at startup into an in-memory map, so
  each is hashed there and served with that `ETag` plus `no-cache` — revalidate,
  not do-not-store, so an unchanged page costs a 304 rather than 136K of
  `client.html`. Tags are content-derived, so a restart that changes nothing
  still answers 304.

  The same pass rewrites asset references to `...?v=<8 hex of the file>`, and
  any URL carrying a `v=` gets a year and `immutable`. Worth doing because
  `client.html` reloads on every session launch *and relaunch*: the 37
  revalidations become one round trip, paid exactly when the link is worst.
  Only a 2xx or 304 gets the long directive — a 404 under a versioned URL is a
  deployment that has gone wrong, and pinning it until next year would outlive
  its cause.

  **The cost is that editing an asset now needs a restart where a reload used
  to do**, since the URL in the HTML and the bytes it names are produced in the
  same startup pass. `RUSTGUAC_NO_ASSET_VERSIONING=1` turns versioning off for
  that reason, leaving everything revalidating as before.

### Display / HiDPI

- **Per-connection Native Resolution** — requests the framebuffer in the
  browser's physical pixels rather than its CSS pixels, so text stays sharp on
  a high-DPI display. Off by default and set per entry, because it is only safe
  where the target also scales its own UI. The framebuffer factor and the
  desktop scale are deliberately separate numbers: the framebuffer takes the
  browser's true `devicePixelRatio` (capped at 3x), because the client fits
  whatever framebuffer arrives into the CSS area it has, so snapping it to a
  legal desktop-scale step leaves the client resampling and the whole picture
  uniformly soft.
- **RDP DPI scaling** (`patches/011-rdp-dpi-scaling.patch`) — a `desktop-scale`
  parameter asking the server to render its desktop at a matching DPI, which
  guacd otherwise cannot do at all: it pins `DesktopScaleFactor` to zero, and
  its `dpi` parameter only rescales the requested dimensions. The two channels
  that carry it are not equally capable: at connection time only 100/140/180
  survive, since MS-RDPBCGR restricts `deviceScaleFactor` to those three and
  FreeRDP transposes the pair when it synthesises a single-monitor definition,
  but the display-control layout is built directly and MS-RDPEDISP allows
  anything in 100-500 — so that layout carries the **exact** percentage, which
  is what the session ends up scaled by. The scale is re-sent on every display
  update, since a monitor layout carrying zeroes resets the session to 100%.
- **Configurable SSH terminal font size** with a **HiDPI fix** — SSH text no
  longer renders oversized on high-DPI displays (SSH DPI pinned to a 96
  baseline; the client auto-scales).

### Input

- **Mouse moves the browser coalesced away are replayed**
  (`static/guac/Mouse.js`) — pointer moves arriving while a handler is running
  are merged into one, so the intermediate positions of a fast drag are
  discarded rather than delayed and the target sees a straight jump where the
  user drew a curve. The client recovers them from `getCoalescedEvents()` and
  sends them in order. Off with `mouseCoalesced` — as `window.__mouseCoalesced`
  or, to survive a reconnect, the `localStorage` key.
- **Pop-out monitor pointer mapping** (`static/guac/MonitorPointer.js`) — a
  pop-out monitor window cannot use `Guacamole.Mouse`, which does not track the
  X axis correctly in a popup, so it maps the pointer itself: the client
  coordinate into the canvas's live on-screen rect as a fraction, then into
  that monitor's pixels and on into the combined framebuffer, re-read on every
  event so it self-recalibrates on a resize. In its own file because inline in
  the page a test could only match source text and hope, and a coordinate
  mapping is exactly the kind that looks right and is off by a term.

### Connections / sessions

- **Per-entry Wake-on-LAN** — sends a magic packet via guacd and polls the
  target before connecting (SSH/RDP/VNC); configurable MAC, broadcast address,
  UDP port, and wait time.
- **Jump-host-aware network allowlist** — with a jump chain configured, the
  per-protocol CIDR allowlist is checked against hop 0, the only host rustguac
  itself dials. The target's name is resolved by the last hop, so resolving it
  locally rejected valid bastion-only names outright.

### OIDC

- **Lazy provider discovery with retry** — if the OIDC provider (e.g. Authelia)
  is unreachable at startup, SSO stays enabled instead of being silently
  disabled until restart; provider metadata is discovered on the first login
  and cached, so SSO recovers automatically once the provider comes up. The
  login page reflects live availability: while the provider is unreachable the
  SSO button is disabled with a "temporarily unavailable" notice and the page
  polls until it recovers (re-enabling the button without a reload).
- **Callback diagnostics** — on a state-cookie mismatch, logs whether the
  cookie was absent vs. present-but-different plus `Host`/`X-Forwarded-*`
  headers, to diagnose reverse-proxy cookie issues.

### UI / admin

- **Onboarding modal close button** to skip the welcome tour entirely.

### Diagnostics

Under passthrough, guacd's own framebuffer holds no pixels for any region
delivered as H.264 — the picture exists only in the browser — so anything that
repaints a layer from that buffer paints black over a working screen, and
neither end can see it: guacd believes it sent pixels and the browser believes
it received them. The fault appeared about once in days, so this was built on
by default rather than as something to enable afterwards.

**Both causes have since been found and fixed** — a keyframe carrying zero
region rects but painted whole, and Windows recreating its surface at the same
size, whose first keyframe decodes black (`keepPictureOverBlackKeyframe()`
withholds it). The wire-side watching below stays on, since it costs one atomic
load per instruction until an `h264` is seen. **The browser-side probing is now
off by default** (`h264BlackProbes` re-enables it): it read the whole
framebuffer back on every painted keyframe, which is the same cost class as the
`copyTo()` above.

- **Wire-level overpaint detection** (`src/frame_stats.rs`) — per-session frame
  lag and H.264 volume, plus a warning when `img`, `copy`, `rect`, `cfill`,
  `size` or `dispose` lands on a layer that has carried H.264. The colour of a
  `cfill` is logged, since a black fill and a region never painted are
  indistinguishable on screen. Costs nothing until an `h264` instruction is
  seen.
- **RDPGFX operation trace** (`patches/014-rdpgfx-op-trace.patch`) — logs the
  surface operations the passthrough patch cannot see (`CacheToSurface`,
  `SurfaceToCache`, `SurfaceToSurface`, `SolidFill`, `ResetGraphics`,
  `CreateSurface`, `DeleteSurface`), and warns when a resize flushes a
  full-layer repaint while passthrough is live.
- **Browser-side reporting** — `POST /api/sessions/{id}/diagnostic` records what
  only the browser knows. Decoder rebuilds, keyframe starvation, abandoned
  frames, chroma fallback and the combine gate's decisions are always reported,
  since each is one line on a state change. The black-region half is behind
  `h264BlackProbes`: the keyframe and paint probes, and — riding the existing
  10s thumbnail capture — a `display_black` report with an 8x4 grid of which
  cells have gone black. That transition is the timestamp everything else is
  read against: full screen points at a resize or a graphics reset, scattered
  blocks at cache or copy operations.
- **Console helpers** — `rustguacFindBlack()` locates black regions on the
  display, `rustguacDumpDraws()` reports what painted a given pixel from a ring
  of recent draws, and `rustguacDumpBlack()` does both in one call;
  `?debug=nofit` suppresses resize requests so opening DevTools cannot repaint
  the region being inspected.

### Docs and tooling

- [`docs/rdp-h264.md`](docs/rdp-h264.md) — H.264 passthrough setup, including
  the non-obvious Windows requirement that the *"Use WDDM graphics display
  driver for Remote Desktop Connections"* policy be **Disabled** or hardware
  encoding never engages.
- [`docs/xrdp-dpi-scaling.md`](docs/xrdp-dpi-scaling.md) — what an xrdp patch
  would need in order to act on the DPI scale factor it already parses,
  validates and then discards.
- [`BUILD-CONTAINER.md`](BUILD-CONTAINER.md) — building, installing and
  updating guacd and rustguac on a deployment container, against the pinned
  guacamole-server commit the patches are verified on.
- **Installer**: guacd's environment lives in `/opt/rustguac/guacd.env`, which
  is created once and never overwritten, so `GUACD_LOG_LEVEL` survives a
  reinstall — the unit files themselves are rewritten every run. The installer
  also warns about existing systemd drop-ins, which silently override the unit
  it just wrote.
- **Benchmark and format tests** — `tests/bench/` measures the combine's GPU
  work with `gl.finish()`, which the client's own `h264CombineLog` did not do
  at the time and so read four times low, deleting an earlier version of the
  combine gate. **It cannot see the dominant cost**, though: it feeds
  pre-decoded frames that already live in system memory, so its `copyTo()` row
  reads 0.29ms against ~14ms in the field, where the frame is a GPU texture and
  pulling its planes out means a driver copy and a staging map. Use
  `h264CombineLog`'s `copy` and `issue` stages for that.

  `tests/h264-copy-band.mjs`, `tests/h264-instruction-format.mjs`,
  `tests/h264-vui-range.mjs`, `tests/h264-aux-instruction.mjs`,
  `tests/h264-hardware-fallback.mjs`, `tests/binary-blob-format.mjs`,
  `tests/mouse-coalesced.mjs` and `tests/monitor-pointer.mjs` pin formats and
  invariants where a disagreement fails silently — the client drops what it
  cannot parse and video simply stops while both ends look healthy, a wrong
  opcode is *ignored* rather than refused and leaves the client combining
  against a view that will never arrive, and a copy band one row short paints a
  row of the previous picture into the middle of this one, which shows on
  moving content and on nothing else.

  `tests/aux-drop-replay.mjs` takes a recording, strips its auxiliary views,
  sets the gaps flag in an implementation deliberately independent of the Rust
  one, decodes both streams with ffmpeg and compares the main pictures — a
  mismatch in picture *count* is checked first, since missing pictures also
  break the positional alignment. The in-crate `aux_drop_over_a_recording`
  covers the half that cannot see: an `h264` whose blobs never arrive hangs a
  browser without corrupting anything.
- `contrib/measure-guacd-cpu.sh`, `contrib/setup-rdp-performance.ps1`.

### Merged upstream

These started here and now ship in upstream rustguac, so they are no longer
fork-specific:

- **H.264 passthrough with AVC444** (upstream as of **v1.10.0**) — the whole
  base of the feature. guacd forwards both views of an AVC444 picture rather
  than dropping the auxiliary one, so Windows hosts can use **hardware**
  encoding, which requires `AVC444ModePreferred=1`; a WebGL2 shader
  (`static/guac/Yuv444.js`) unpacks the auxiliary view's packed chroma — both
  MS-RDPEGFX layouts — and combines the two into full 4:4:4 in a single pass,
  inverting the encoder's chroma filter to recover the one sample per 2x2 block
  that neither view carries. That matters most for text, since ClearType
  antialiases glyphs with per-pixel colour fringes, precisely what 4:2:0
  averages away.

  Merged with it: ordered drawing, so a late frame cannot repaint stale video
  over newer content on a server mixing codecs (`Display.drawH264`, and a
  `<view>` field plus trailing region rects on the `h264` instruction); releasing every decoded frame
  before its deferred draw runs, since holding a `VideoFrame` across a promise
  exhausts the hardware decoder's output-surface pool; rebuilding the decoder
  after a terminal decode error and holding frames to the next keyframe, rather
  than leaving a closed `VideoDecoder` that returns early forever; a bounded
  decode pipeline depth so network round trip and decode time overlap;
  reinstalling the RDPGFX wrappers after the channel reconnect xrdp triggers at
  the login resize; and loading the decoder in the recordings player, so
  passthrough sessions replay as video rather than a black display.

  Measured with 1080p video playing, guacd session CPU over 30s:

  | | decode + re-encode | passthrough |
  |---|---|---|
  | xrdp (AVC420) | ~100% of a core | **2.0%** |
  | Windows 11 (AVC444) | 90.6% of a core | **2.1%** |

- **AVC420-only H.264 passthrough** — the predecessor of the above, which
  worked around AVC444 colour corruption on Windows hosts by disabling AVC444
  outright (upstream as of v1.8.1).
- **Per-entry RDP desktop appearance** — configurable wallpaper, theming, and
  full-window drag (upstream as of v1.8.1).
- **TCP_NODELAY** — Nagle's algorithm disabled on rustguac's TCP sockets.
- **Local-time timestamps** on the admin page.
- **Rendering fixes ported from `fixes-1.6.0`** — the terminal OSC-consume and
  RDP mod-16 guacd patches. The mod-16 one still ships upstream as
  `patches/007-rdp-disp-mod16.patch`; the OSC one went further and is now in
  guacamole-server itself as GUACAMOLE-2213, so upstream dropped its patch on
  the next guacd uplift.

## Architecture

```
Browser (HTML/JS)
    |
    | WebSocket over HTTPS
    v
rustguac (Rust, axum)
    |
    | TLS (Guacamole protocol)
    v
guacd (C, from guacamole-server)
    |
    +---> SSH server
    +---> RDP server
    +---> VNC server
    +---> SPICE server (libvirt/QEMU displays)
    +---> Proxmox VE VM console (SPICE via the PVE spiceproxy API)
    +---> Xvnc + Chromium (web browser sessions)
    +---> Docker container + xrdp (VDI desktop sessions)
```

## Features

### Session types

| Type | Description |
|------|-------------|
| **SSH** | Browser-based terminal with password, private key, or ephemeral keypair auth. SFTP file transfer. |
| **RDP** | Windows/Linux RDP with auto-fit resize, Kerberos NLA, RemoteApp/RAIL, H.264 passthrough, GFX pipeline. |
| **VNC** | Connect to any VNC server (KVM/IPMI consoles, remote desktops, VM displays). |
| **SPICE** | Direct SPICE displays (libvirt/QEMU consoles) with TLS, CA verification, certificate-subject pinning, and SPICE-proxy support. |
| **Proxmox VE** | VM consoles brokered through the Proxmox API. One-time SPICE tickets fetched just-in-time at connect (only the API token is stored), node auto-detected from the VM ID, and SSH-tunnel aware. |
| **Web** | Headless Chromium on Xvnc with native autofill, domain allowlisting, login script automation. |
| **VDI** | Ephemeral Docker desktop containers per user. Persist after disconnect, auto-cleanup on idle. |

### Security & authentication

- **OIDC single sign-on**: Authentik, Google, Okta, Keycloak, or any OpenID Connect provider
- **4-tier role system**: admin, poweruser, operator, viewer with OIDC group mapping
- **API key auth**: SHA-256 hashed keys with IP allowlists and expiry
- **Vault-backed connections**: credentials in HashiCorp Vault or OpenBao KV v2, never reach the browser (see [Requirements](#requirements))
- **TLS everywhere**: HTTPS for clients, TLS between rustguac and guacd
- **CIDR allowlists**: per-protocol network restrictions for session targets
- **Per-entry clipboard control**: disable copy and/or paste for data loss prevention
- **Rate limiting**: per-IP, per-endpoint via tower_governor
- **Session recording**: Guacamole format with playback UI, disk rotation, per-entry limits

### Connectivity

- **Multi-hop SSH tunnels**: chain jump hosts/bastions to reach isolated networks (all session types, including the Proxmox API and console hops)
- **Session sharing**: share tokens for read-only or collaborative access
- **Headless API integration**: create a session over the REST API and hand a browser a ready-to-open URL via a single-use WebSocket ticket, with no OIDC login and no API key in the browser (see [Connecting to a session](docs/api.md#connecting-to-a-session))
- **Encrypted file transfer**: LUKS-encrypted per-session drive storage (RDP), SFTP (SSH)
- **Credential variables**: shared credentials across connections entries

### VDI desktop containers

- **Docker-based**: one container per user, deterministic naming, BYO image
- **Persist after disconnect**: reconnect to the same desktop within idle timeout
- **Logout detection**: desktop logout stops the container, tab close preserves it
- **Session thumbnails**: live preview in the connections, click to reconnect
- **Persistent home directories**: bind-mounted user data survives container restarts
- **Per-entry resource limits**: CPU, memory, idle timeout per connections entry
- **VdiDriver trait**: extensible for downstream forks (Nomad, Proxmox, cloud)

### UI

- **Connections** with folder-based organisation and OIDC group access control
- **Active Sessions** section with live thumbnail previews
- **Session ended overlay** with Reconnect/Close buttons
- **Clipboard panel controls** (Home + Fullscreen)
- **8 built-in themes** with CSS gradient backgrounds, or configure your own
- **Reports page** with session analytics, history, and CSV export

## Requirements

| Component | Status | Notes |
|-----------|--------|-------|
| guacd | Bundled | Built from `apache/guacamole-server`, ships in the .deb and Docker image. No separate install. |
| **Vault or OpenBao** | **Required for the Connections UI** | Stores connection entries and credentials server-side. Without it the Connections page is unavailable and users can only run ad-hoc sessions via the API. Use [`contrib/vault-quickstart.sh`](contrib/vault-quickstart.sh) for one-command setup (auto-detects `vault` or `bao`, supports `--dev` and `--local` modes). |
| OIDC provider | Optional | For SSO. API-key auth works on its own. Authentik/Google/Okta/Keycloak/JumpCloud all tested. |
| Docker | Optional | Only needed for VDI desktop containers. |

### Supported browsers

The client runs in any modern browser (Chrome, Firefox, Edge, Safari, Chromium, Brave). One caveat applies only to **H.264-accelerated RDP**, which is opt-in per connection (the per-entry H.264 toggle, off by default):

- **Standard connections** (SSH, RDP, VNC, web sessions, VDI) work in every modern browser.
- **H.264-accelerated connections** need a browser that can decode H.264 through the WebCodecs API. **Chrome** and **Firefox** work. Open-source **Chromium** and **Brave** builds without the bundled H.264 codec, and older Safari, render a blank display on those connections. Leave H.264 off (the default) for universal browser support, or use Chrome or Firefox where it is enabled.

## Quick start

### Debian 13 (.deb)

Pre-built packages for amd64 and arm64 are available from [Releases](https://github.com/sol1/rustguac/releases):

```bash
sudo apt install ./rustguac_*.deb
/opt/rustguac/bin/rustguac --config /opt/rustguac/config.toml add-admin --name admin
sudo systemctl enable --now rustguac
```

### Docker

```bash
docker pull sol1/rustguac:latest
docker run -d -p 8089:8089 sol1/rustguac:latest
```

For VDI support, mount the Docker socket:

```bash
docker run -d -p 8089:8089 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add $(getent group docker | cut -d: -f3) \
  sol1/rustguac:latest
```

### Other distributions

Pre-built packages are provided for Debian 13. For other distributions, build from source:

```bash
sudo ./install.sh
```

See the [Installation guide](docs/installation.md) for full details including Docker Compose, TLS setup, and development builds.

### VDI setup

VDI requires Docker on the host:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker rustguac
sudo systemctl restart rustguac
```

Add `[vdi]` to your config and create a VDI entry in the connections. See [VDI Desktop Containers](docs/vdi.md) for image requirements and configuration.

## Documentation

### Getting started
- [Installation](docs/installation.md): Debian packages, Docker, bare-metal, development builds
- [Configuration](docs/configuration.md): TOML config reference with all sections
- [Deployment Guide](docs/deployment-guide.md): step-by-step production setup

### Features
- [Roles & Access Control](docs/roles-and-access-control.md): OIDC, roles, group mappings, API tokens
- [Web Browser Sessions](docs/web-sessions.md): autofill, domain allowlisting, login scripts
- [VDI Desktop Containers](docs/vdi.md): Docker desktops, image requirements, persistent homes
- [RDP Video Performance](docs/rdp-video-performance.md): H.264 passthrough, GFX pipeline, xrdp tuning
- [RDP H.264 Passthrough](docs/rdp-h264.md): enabling it, and the Windows host settings it requires
- [Binary Blobs](docs/binary-blobs.md): binary WebSocket frames for h264/audio payloads, and why upstream sends base64
- [Credential Variables](docs/credential-variables.md): shared credentials across entries
- [Reports](docs/reports.md): session analytics, history, CSV export

### Integration & reference
- [Integrations](docs/integrations.md): Vault, LUKS drives, SSH tunnels, Kerberos, HAProxy, Knocknoc
- [NetBox](docs/netbox.md): connections sync via custom fields and webhooks
- [Security](docs/security.md): TLS, rate limiting, headers, audit logging, hardening
- [API Reference](docs/api.md): REST API endpoints, the session connection flow, and headless ws-ticket integration
- [Migration from Apache Guacamole](docs/migration.md): MySQL/MariaDB to Vault

## Commercial support

Commercial support for rustguac is available from [Sol1](https://www.sol1.com.au).

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
