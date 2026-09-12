# H.264 passthrough for RDP

rustguac can forward an RDP server's H.264 stream straight to the browser's
WebCodecs decoder instead of having guacd decode it and re-encode the pixels as
JPEG/WebP. With 1080p video playing, that takes guacd from roughly a full CPU
core down to about 2% of one — measured on both xrdp and Windows 11.

Enable it per connection with the **H.264** checkbox on the entry. There is no
server-side configuration and no environment variables.

## What the server has to send

Passthrough only engages when the server actually sends H.264 over the RDPGFX
Graphics Pipeline. Both AVC420 and AVC444 work.

- **xrdp** — set a GFX codec order listing H.264 in `/etc/xrdp/gfx.toml`. Nothing
  else is needed; xrdp sends AVC420 and passthrough applies to every frame.
- **Windows** — needs the host settings below. Without them Windows sends
  CLEARCODEC and CAPROGRESSIVE instead, and guacd falls back to decoding and
  re-encoding. The display is still correct, just far more expensive.

## Windows 11 host settings

These are not optional, and two of them are non-obvious. Verified on Windows 11
Pro with an NVIDIA RTX 3070.

### 1. Disable the WDDM display driver for Remote Desktop

Group Policy → Computer Configuration → Administrative Templates → Windows
Components → Remote Desktop Services → Remote Desktop Session Host → Remote
Session Environment → **"Use WDDM graphics display driver for Remote Desktop
Connections"** → **Disabled**. Reboot.

**This is what allows hardware H.264 encoding to engage at all.** With the WDDM
driver in place, the session runs on the GPU for rendering but never reaches the
encoder: Task Manager shows GPU 3D under load while **Video Encode stays at 0%**
and `nvidia-smi encodersessions` reports nothing. Setting the registry values
below without also disabling WDDM changes nothing — the policy is accepted and
has no effect.

Note this changes the display pipeline, so check dynamic resize and
multi-monitor behaviour after enabling it.

### 2. Prefer AVC 4:4:4

```
HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services
    AVC444ModePreferred = 1   (DWORD)
```

Counter-intuitively this is required **for hardware encoding**, not for image
quality: setting it to 0 on the test host stopped NVENC entirely and fell back
to software encoding. Windows then sends AVC444, which rustguac handles — both
views are forwarded to the browser and combined there into full 4:4:4 chroma,
so leaving this on costs nothing in image quality and is what makes hardware
encoding engage.

### 3. Raise the frame rate cap

```
HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations
    DWMFRAMEINTERVAL = 15   (DWORD)   # 60fps; default is 30
```

### 4. Hardware encoding policy

```
HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services
    AVCHardwareEncodePreferred = 1   (DWORD)
    bEnumerateHWBeforeSW       = 1   (DWORD)
```

`contrib/setup-rdp-performance.ps1` applies items 2–4; item 1 is a Group Policy
change and must be made separately. Run the script with `-Report` first to see
what is already configured.

### What you do *not* need

The **"Prioritize H.264/AVC 444 Graphics Mode for Remote Desktop Connections"**
policy does not need to be Disabled. It was used during development to force
AVC420, but rustguac handles AVC444 directly now, and on the test host Windows
ignored the client's AVC420 request regardless — it confirmed RDPGFX capability
version 10.7 with the `AVC_THINCLIENT` flag set and sent AVC444 anyway.

## Verifying

After connecting, on the Windows host: Task Manager → Performance → GPU →
**Video Encode** should be non-zero during activity. If it reads 0%, hardware
encoding is not engaged — check the WDDM policy first.

On the rustguac host, with `GUACD_LOG_LEVEL=trace` in `/opt/rustguac/guacd.env`:

```bash
# Which codecs the server is sending. 11 = AVC420, 14/15 = AVC444(v2).
# 8 = CLEARCODEC and 9 = CAPROGRESSIVE mean H.264 is not being used.
journalctl -u rustguac-guacd --since '1 min ago' | grep "TRACE:" \
  | grep -oP 'codec=\K[0-9]+' | sort -n | uniq -c

# The RDPGFX capability version the server confirmed
journalctl -u rustguac-guacd --since '2 min ago' | grep "RDPGFX capability version"

# guacd CPU with the workload running
./contrib/measure-guacd-cpu.sh
```

`display-wrk` near zero in that last output is the sign that passthrough is
working: it means image encoding is not happening.

In the browser console, `__h264.stats()` reports decoder health —
`avgDecodeLatencyMs` in the low single digits, `framesDropped` and `gcLeaks` at
zero, `auxViewsDecoded` counting AVC444 auxiliary views.

## When the whole picture looks soft

Before blaming the codec, check that the client is not resampling. In the
browser console on the client tab:

```js
__guac_client.getDisplay().getScale() * devicePixelRatio
```

**1.0** means one framebuffer pixel per physical pixel. Anything else is a
resample, and it softens text, icons and images uniformly — which a codec does
not do. Measured on a Windows session at 2.016, the picture contained almost no
single-pixel edges at all: 0.01% of adjacent pixels differing by more than 100
levels, against 0.82% for the same page rendered natively, with the sharpest
transition anywhere reaching 114 where native reached 194.

The fix is the entry's **Native Resolution (HiDPI)** checkbox, which asks for
the framebuffer in physical pixels. Note it multiplies the pixels the host
encodes and the browser decodes by the square of the ratio.

### Asking for the exact DPI scaling

MS-RDPBCGR restricts `deviceScaleFactor` to 100, 140 or 180. Pairing a
framebuffer sized for a 2.0 display with 180% scaling draws the UI about 10%
smaller than nominal — sharp, but small.

The protocol is not the whole obstacle: `desktopScaleFactor` is legal from 100
to 500. FreeRDP transposes the pair when it synthesises the single-monitor
definition (`libfreerdp/core/settings.c`, the monitor's `desktopScaleFactor`
filled from `FreeRDP_DeviceScaleFactor` and vice versa), so any unequal pair
reaches the server backwards and an out-of-range device factor makes it discard
both. Equal values are the only ones that survive that path, which is what
`guac_rdp_normalize_desktop_scale` snaps to.

**The display-control channel is not subject to that.** `disp.c` builds the
`DISPLAY_CONTROL_MONITOR_LAYOUT` itself and hands it straight to the channel,
so nothing transposes it, and MS-RDPEDISP 2.2.2.2.1 likewise restricts only
`DeviceScaleFactor`. The layout therefore carries the exact percentage —
`DesktopScaleFactor = 200` beside `DeviceScaleFactor = 180` — and since the
client fits the display to the browser window shortly after connecting, that
layout is what the session ends up scaled by. The connection-time core data
still goes out snapped and is overridden a moment later.

An xrdp target is unaffected either way: xrdp parses the scale factors and
drops them unused (`docs/xrdp-dpi-scaling.md`), so a session script setting
`/Gdk/WindowScalingFactor` or `/Xft/DPI` remains the only thing scaling that
desktop.

### 4:4:4 combining is declined above 4 megapixels

An AVC444 stream above `COMBINE_MAX_PIXELS` is decoded but painted at 4:2:0.
The combine is a plane read-back, six texture uploads and a shader pass per
picture, all proportional to pixels and all contending with the hardware video
decoder on the same GPU. From `tests/bench` it costs about **1.37 ms per
megapixel**:

| framebuffer | combine | share of a 60fps frame |
|---|---|---|
| 1080p (2.1 MP) | 2.8 ms | 17% |
| 1440p (3.7 MP) | 5.1 ms | 30% |
| native HiDPI (5.5 MP) | 7.5 ms | 45% |
| 4K (8.3 MP) | 11.4 ms | 68% |

The 5.5 MP row is not theoretical — it showed up as a frame backlog 8-11 deep
and repeated sync timeouts, with `h264CombineLog` still reporting the combine
at under a millisecond because it times submission rather than execution.

**Keyed on framebuffer area rather than the desktop scale**, which was the
first thing tried and is wrong twice over. The scale only says whether HiDPI
scaling was applied, so a 4K display at `devicePixelRatio` 1 slips past it and
combines at the most expensive size there is. And the cost is not a property of
the host: the same picture costs the same to combine whatever sent it, which is
why this was taken for an xrdp problem until a Windows session was run at
native resolution.

`?h264Chroma444=on` overrides, `?h264CombineMaxPixels=` moves the line for a
faster or slower GPU, and the declined case logs once saying why.

### And a latch under it, for when the threshold is wrong

The threshold is a constant measured on one GPU, so it cannot know the client
it is running on. Under it sits a latch: if the decode backlog stays over
`MAX_PIPELINE_DEPTH * 3` for two seconds while combining, the session gives up
combining for good and reports it:

```
Client diagnostic: gave up 4:4:4 combining: 9 frames pending for 2.1s ...
  event=chroma_suspended
```

It gates on the **backlog**, not on the combine's measured cost, because
measuring GPU execution needs a `gl.finish()` per picture — stalling the
pipeline the gate protects — or timer queries that are not reliably available.
A healthy session sits at or below `MAX_PIPELINE_DEPTH`; a drowning one was
measured in the field at 8–11 with sync timeouts alongside.

It is **one-way** on purpose. An earlier version measured the combine against a
frame budget whose divisor was the observed interval between pictures — which
is what `012`'s frame-ack back-pressure has already throttled the server to,
and that back-pressure reacts to the lag combining causes. It read its own
output as its input. A latch has no loop.

A backlog caused by something else — a slow link, a struggling decoder — gives
up chroma for nothing. That is the accepted cost: a little colour resolution,
no frames, and `?h264Chroma444=on` brings it back. Setting that override also
disables the gate entirely, since an override is an instruction rather than a
preference.

**It resumes once the load passes.** After the backlog has stayed within
`MAX_PIPELINE_DEPTH` for 30 seconds, combining is tried again
(`chroma_resumed`), up to three times per session; after the third it stays off
for good. Tripping during a video and resuming afterwards is the expected
shape — heavy video is exactly where 4:2:0 chroma costs least and where the
combine costs most, and reading text afterwards is where the aux stream earns
its keep.

The long recovery window is not about hiding a visible flap; there barely is
one, since only newly painted regions change chroma resolution. It is about the
**resync**: the first combine after a gap uploads whole planes rather than
damaged rows, which is the most expensive kind of combine there is, and
delivering that to a client that has only just stopped struggling is how a gate
makes things worse. Three attempts then draws the line between a desktop that
had a video playing and a client that simply cannot sustain the combine — sample
by sample the two look identical, and only time separates them.

**`h264CombineLog` cannot measure this.** It brackets GPU submission, not
execution — there is no `gl.finish()` in the render path — and reports the same
work at under a millisecond. Use `tests/bench`, which forces completion, before
concluding the combine is cheap.

### Is it the combine, or the handoff? (investigation)

The field numbers do not add up to what `tests/bench` measures. At 1920x1072
against the xrdp fork, 4:2:0 ran at 54.7 syncs/s with a 0.6ms mean flush and
4:4:4 at 33-41/s with 16-22ms. Part of that ratio is an accounting artifact --
the 4:2:0 path snapshots the `VideoFrame` into a 2D canvas inside the decoder's
output callback, so its pixel copy is already paid before flush begins, while
the combine path only *submits* GPU work there and the result is first needed
inside flush. But the sync rate cannot be an artifact: 54.7/s to 33-41/s is
6-12ms per frame, against a benched combine of ~2.8ms at 2.06MP.

The same slowdown appears on an RTX 3070 and an Intel 770. Those differ by
roughly 8x in memory bandwidth and the NVIDIA part decodes on a separate
engine, so agreement between them rules out shader cost, GPU bandwidth, and
contention between the two hardware decodes and the combine. What survives is
what is *not* GPU throughput: CPU-side driver staging (which is what
`texSubImage2D` already is), and synchronous GPU-to-CPU transfers.

That points at a boundary the 4:2:0 path never crosses. The combine's output is
a GPU-resident `ImageBitmap` produced by the renderer's own WebGL2 context, and
it is consumed by `drawImage()` into the display layer's 2D context. If the
driver cannot share that surface, the blit is a readback -- area-proportional,
vendor-independent, and invisible to every existing instrument. And it would
not shrink with damage: `render()` scissors the conversion to the damage rects,
but `transferToImageBitmap()` hands over the **whole drawing buffer** every
frame. At 1920x1072 that is 8.2MB crossing the boundary to repaint a caret,
which is also why banding the plane uploads measured 2.0x in the bench and much
less in the field.

**What is instrumented.** Under `h264CombineLog`, a fourth stage `paint` times
the `drawImage()` calls in `drawDecoded()` -- the boundary crossing itself --
split by which kind of surface crossed it (`bitmap` from the renderer, `canvas`
from the 4:2:0 snapshot) rather than by chroma. It is reported against two
denominators, because which one the cost tracks says what it is: steady per
damaged megapixel means the blit, steady per buffer megapixel means the
handoff. `sync_hold` additionally splits its flush figure by what actually
painted during each sync (`| by paint: bitmap ..., canvas ..., idle ...`),
since the mode a sync is charged to says only whether combining was on. `idle`
is the floor -- a sync that painted nothing -- and whatever it costs is the
display's own work.

**The control is `h264PaintViaSnapshot`.** An unpaired main view is an ordinary
4:2:0 picture that happens to be travelling the combine path, so with this set
it is snapshotted exactly as the 4:2:0 path snapshots it, skipping
`render()` for that picture only. Its planes are already uploaded, so an
auxiliary view behind it still combines correctly. That gives both handoffs on
one stream, one host, one session, differing in nothing else. Against the xrdp
fork's `CHROMA_INTERVAL=N`, N-1 pictures in N are unpaired, so the sample is
large.

Read it as:

* `paint` slow for `bitmap`, fast for `canvas`, on the same stream -- the cost
  is the context boundary, and no amount of shader or upload work will touch
  it. The fix is to size the drawing buffer to the union of the damage rects
  and blit at that offset, so the handoff scales with damage like everything
  else already does.
* `paint` similar for both, with flush still slow -- the cost is downstream of
  the blit, in the display's own queue.
* `paint` fast for both -- the cost is upstream, in `copyTo()` and the plane
  uploads, and the bench is simply understating them on this hardware.

Set the overrides as a window global (`window.__h264PaintViaSnapshot = true`)
to flip them mid-session without a reload, or in `localStorage` to have them
survive one. Not as a query parameter: the client relaunches its own URL, so a
hand-added parameter is gone at the next reconnect.

#### Result: it is not the handoff, and `flush` was never measuring the display

Measured at 1920x1072 against the xrdp fork with `CHROMA_INTERVAL=8`, combining
forced on, over three 5s windows:

```
  decode  chroma 35 mean 14.4 max 50.7  |  luma 274 mean 6.1 max 43.4
  combine chroma 35 mean  0.5 max  0.9  |  luma 239 mean 0.3 max 1.0
  draw    chroma 35 mean 12.5 max 33.1  |  luma 239 mean 15.1 max 57.5
  paint   bitmap 274 mean  0.0 max  0.4 0.01ms/MP  |  canvas none
  read-back wait mean 0.0 max 0.1
sync_hold: 2090 syncs (34.8/s) held 3 (0%) timeouts 0
           | flush mean 19.9ms max 89ms | by paint: bitmap 2088 mean 19.9ms
```

**The handoff is free.** `paint` is 0.0ms mean, 0.4ms max, 0.01ms/MP against
either denominator. The ImageBitmap crosses into the display's 2D context at
no measurable cost, so the driver is sharing the surface, not reading it back.
The bounding-box change that would have followed is not worth making, and the
vendor-independence that pointed here has a duller explanation: nothing on this
path is GPU-bound at all.

**The combine is also cheap in situ** -- 0.3-0.5ms with `gl.finish()` forcing
completion, against the bench's ~1.37ms/MP (~2.8ms at this size). No
contradiction: the bench measures full-frame damage, and a real desktop's
damage is small, which is exactly what the banded uploads and the scissored
conversion were built for. The bench is a worst case, not a typical one.

**And `flush` was measuring the wrong thing.** The stack that produced these
numbers runs `recordHold` <- `waitForPending` <- `displaySyncComplete` <-
`Frame.flush` <- `__flush_frames` <- `Task.unblock` <- `__display_h264_ready`
<- the combine's own promise. The display's flush *completes inside the
decoder's unblock*: a frame carrying H.264 blocks its display task until the
picture is available, so `flush mean 19.9ms` is how long the display waited for
the decoder, not how long the display took to draw.

That matters beyond this investigation. `COMBINE_FLUSH_TRIP_MS` gives up
combining when the mean flush exceeds 8ms -- but the signal it reads is
dominated by decode latency, and suspending the combine does not remove a
single decode (lever 3 removes the combine and nothing else). The latch is
tripping on something it cannot fix. Whether that is still a useful proxy is an
open question, not a settled bug: AVC444 does mean two access units per
picture, so combining correlates with the decode load even though it does not
cause it.

**What is left unexplained is `draw`:** 12.5-19.8ms from the `VideoFrame`
arriving in `output()` to the paint, of which the combine is 0.5ms, the
read-back wait 0.0ms and the paint 0.0ms. Roughly 12-18ms is unaccounted for.
A `queue` stage now splits it -- `onReady` is wrapped to stamp when the
picture actually became available, so `draw` minus `queue` is the asynchronous
chain and `queue` is time spent in the display's ordered queue behind frames
that were not ready yet.

**Next measurement:** the same three stages with `window.__h264Chroma444 =
false` on the same session and host. `false` is an override like any other, so
the latch stays out of the way and the comparison is clean. If `decode` and
`queue` are what grow between the two runs, the cost is the second access unit
and the pipelining around it, and the client-side combine gate is aimed at the
wrong thing.

## Colour range

The samples an RDP host sends are **full range**. [MS-RDPEGFX Color
Conversion](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/954d7546-6873-4466-95c8-20a7569c43e5)
defines the ARGB-to-AYUV transform as full-range BT.709 with the components
clamped to 0...255, and Microsoft's RDP 10 AVC announcement requires decoders
to support "BT.709 Full Range color conversion".

Converting those as limited range expands 16-235 to 0-255: blacks crush to
zero, whites clip, and chroma over-saturates by 255/224. It looks punchier and
is wrong — and it is the more damaging of the two mistakes, since clipping
destroys information that the opposite error merely compresses.

The stream is supposed to prevent that by carrying `video_full_range_flag = 1`
in the SPS. **Chrome honours that flag in every shape but one.** Measured
2026-09-09, and pinned by `tests/h264-vui-range.mjs`:

| `video_full_range_flag` | colour description | `colorSpace.fullRange` | 16,16,16 painted as |
|---|---|---|---|
| 1 | absent | `true` | 15,17,14 |
| 1 | present, 2/2 (unspecified) | **`false`** | **0,1,0** |
| 1 | present, 1/1 (BT.709) | `true` | 14,17,14 |
| 0 | present, 1/1 (BT.709) | `false` | 13,16,13 |

A colour description that is *present* and says *unspecified* makes Chrome
discard the whole `video_signal_type` and fall back to limited BT.709. Leaving
the description out altogether does not.

**That table is software decode, and the hardware path is stricter.** Measured
on one browser against two hosts, both decoding to NV12:

| host | SPS | Chrome reports |
|---|---|---|
| xrdp fork | `full_range=1`, primaries/transfer/matrix all BT.709 | full |
| Windows | `full_range=1`, **no description** | **limited** |

Same client, same hardware decoder; the description is the only difference. So
a bare range flag — which the software decoder honours — is ignored once
D3D11/VAAPI is in the path. That is why Windows renders with crushed blacks
while xrdp does not, and why signalling the range in the fork
(`xrdp_accel_assist_vaapi.c`, `video_signal_type_present_flag` through
`matrix_coefficients`) visibly fixed the colour there.

It is invisible from both ends: the host declared the range, the client reports
limited, and neither can see the disagreement. It also applies to `drawImage()`
as much as to the shader, since both read the same reported colour space, so no
client-side flag can reach the AVC420 path.

### The fix: rustguac completes the SPS

`src/h264_rewrite.rs` completes the SPS's colour signalling, in either of the
two shapes seen in the field: a declared range with no description (Windows), or
no `video_signal_type` at all (stock xrdp, whose x264 defaults omit it). The
first has its description added and its declared range left alone; the second
gets full-range BT.709 written, because that is what the transport defines and
what the encoder actually produced. It fixes both render paths and every
client, including third-party ones, and needs no configuration.

Cheap by construction: the first SPS decides. A stream that already carries a
description is never examined again, so xrdp and every non-passthrough session
pay one check per connection and nothing after it.

BT.709 is not a guess — MS-RDPEGFX defines the transform as BT.709, and Chrome
already reported `bt709` for these streams, so the value is the one the decoder
was assuming anyway. The splice is verified byte-for-byte against ffmpeg's own
`h264_metadata` bitstream filter performing the same edit
(`the_splice_matches_ffmpegs_own_rewrite`), because a bad bit offset or a
missed emulation-prevention byte does not fail loudly: the picture stops while
both ends look healthy.

Recordings are teed upstream of the rewrite and keep the host's original
stream, which is what a recording should be. Playing back a Windows recording
is subject to the original fault; `?h264FullRange=on` is the lever there.

### Diagnosing it

rustguac reads the first SPS of every passthrough session and logs what it
found, once per session (`src/h264_sps.rs`):

```bash
journalctl -u rustguac --since '5 min ago' | grep 'H.264 colour'
```

```
H.264 colour: video_full_range_flag=1 colour_primaries=2 (unspecified) \
  transfer=2 (unspecified) matrix=1 (BT.709) — UNUSABLE: ...
```

A second line says what the browser made of it, reported by the client:

```
Client diagnostic: full range, BT.709; decoder gave NV12 frames  event=colour_space
```

The two together are the whole picture — the first describes the wire, the
second the render — and a colour fault is a disagreement between them. `NV12`
means hardware decode and `I420` software, which matters because the two honour
different things.

Outcomes and fixes:

* **`NO SIGNAL TYPE`** — the SPS says nothing about colour at all. Stock xrdp
  0.10.6 does this: it passes x264 no VUI parameters, and with `video_format`
  at 5 and no colour description x264 omits the whole block. Its samples are
  full-range BT.709 regardless — xrdp names its own conversion
  `XRDP_yuv444_709fr` — so the browser's fallback to limited crushes the
  blacks. Full-range BT.709 is spliced in.
* **`NO DESCRIPTION`** — rustguac splices one in and logs `splicing a BT.709
  description into the SPS`. The client line should then read `full range`.
  This is the Windows case, and it is confirmed working end to end:

  ```
  H.264 colour: video_full_range_flag=1 colour_primaries=absent ... NO DESCRIPTION: ...
  H.264 colour: splicing a BT.709 description into the SPS ...
  Client diagnostic: full range, BT.709; decoder gave NV12 frames  event=colour_space
  ```
* **`UNUSABLE`** (description present, unspecified) — not rewritten, since
  replacing 2 with 1 would assert a colourimetry the host declined to claim.
  Fix it at the encoder.
* **`full_range=0`, usable** — the host is declaring limited range. If its
  samples are nevertheless full range, as MS-RDPEGFX requires, nothing on the
  wire can be believed and the client has to be told. Set the `h264FullRange`
  key in localStorage: on a live session that is the only form that survives,
  since the client builds `/client/{id}?name=...` itself on every launch and
  relaunch and drops anything added by hand. `?h264FullRange=on` works on the
  recording player, whose URL nothing rewrites. `window.__h264FullRange` is
  read once per decoder generation, behind the same latch as the colour-space
  report, so setting it mid-session does nothing until the decoder is rebuilt.
  The console then logs `(FORCED -- frame reported limited)`.
* **`usable`, and the client reports the matching range** — the colour is
  right, and a picture that still looks wrong is not a range problem.

## Recording

Session recordings capture the raw stream, so a recording of an H.264 session
contains `h264` instructions and needs the same WebCodecs decoder to play back.
