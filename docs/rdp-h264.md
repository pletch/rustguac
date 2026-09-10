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
  wire can be believed and the client has to be told: `?h264FullRange=on` on
  the client URL (also `window.__h264FullRange` or the `h264FullRange` key in
  localStorage). The console then logs `(FORCED -- frame reported limited)`.
* **`usable`, and the client reports the matching range** — the colour is
  right, and a picture that still looks wrong is not a range problem.

## Recording

Session recordings capture the raw stream, so a recording of an H.264 session
contains `h264` instructions and needs the same WebCodecs decoder to play back.
