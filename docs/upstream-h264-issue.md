# H.264 passthrough: Windows hosts negotiate no H.264 at all, and guacd still decodes every frame

Two independent defects in the H.264 passthrough on `main` (v1.9.9) mean that, on
Windows RDP hosts, the feature currently does nothing — and where it does engage,
it delivers roughly half the saving it should. Both are in
`patches/004-h264-display-worker.patch`.

I introduced the first one myself in 4bcac32, so this is a self-report; the fix
turned out to need more than reverting it.

## 1. `GfxAVC444 = FALSE` disables H.264 entirely on Windows

4bcac32 ("fix(rdp): force AVC420 for H.264 passthrough") sets
`FreeRDP_GfxAVC444 = FALSE` while keeping `FreeRDP_GfxH264 = TRUE`, intending to
make the client advertise AVC420-only. That is not what the combination does.

FreeRDP gates the **entire** RDPGFX V10+ capability block on this condition
(`channels/rdpgfx/client/rdpgfx_main.c:254`, in `rdpgfx_send_caps_advertise_pdu`):

```c
if (!freerdp_settings_get_bool(settings, FreeRDP_GfxH264) ||
    freerdp_settings_get_bool(settings, FreeRDP_GfxAVC444))
{
    /* ... emit CAPVERSION_10, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7 ... */
}
```

With `GfxH264=TRUE` and `GfxAVC444=FALSE` the expression is `!TRUE || FALSE` →
**false**, so no V10-series capability set is sent. The client advertises only
V8 and V8.1, the latter carrying `RDPGFX_CAPS_FLAG_AVC420_ENABLED`.

(Note that *inside* that block, `GfxAVC444=FALSE` is exactly how you ask for
AVC420 — it sets `RDPGFX_CAPS_FLAG_AVC_DISABLED` on the V10 capsets. The setting
only means "AVC420, please" when the block is emitted at all, which the same
setting prevents.)

Windows will not offer H.264 at V8.1. It negotiates V8.1 without H.264 and falls
back to CLEARCODEC and CAPROGRESSIVE — which guacd decodes and re-encodes as
JPEG/WebP, i.e. exactly the cost the feature exists to avoid. The display is
correct, so the regression is invisible unless you measure CPU or inspect the
codecs on the wire.

**Verified** on Windows 11 Pro with guacd at trace level, counting `codec=`
in the guacd trace over one minute of 1080p video:

| Setting | codec 8 (CLEARCODEC) | codec 9 (CAPROGRESSIVE) | H.264 (11 / 14 / 15) |
|---|---|---|---|
| `GfxAVC444 = FALSE` (current `main`) | 4050 | 1447 | **0** |
| `GfxAVC444 = TRUE` | 0 | 0 | all frames (codec 15) |

**xrdp is unaffected**, which is why this went unnoticed: xrdp accepts AVC420 at
V8.1 and never needed the V10 capsets. Anyone testing only against xrdp sees a
fully working feature.

## 2. The server-side H.264 decode is never skipped

`patches/004` wraps the GFX `SurfaceCommand` callback to capture the NAL data,
then unconditionally calls through to the original handler:

```c
/* patches/004-h264-display-worker.patch — the comment states the behaviour */
 * The original handler is always called to perform GDI decoding, which
...
    if (orig != NULL)
        result = orig(context, cmd);
```

So guacd still runs the full software H.264 decode for every frame; only the
*re-encode* to JPEG/WebP is skipped. Decode and re-encode are roughly comparable
in cost, so about half the potential saving is left on the table even on xrdp
where the feature does engage.

**This is structural, not an oversight, and `docs/rdp-video-performance.md` is
straightforward about it** — "guacd copies the raw H.264 NAL data *and also runs
the normal GDI decode (for frame sync)*". That is an accurate description of the
current design. The queued frames are sent by walking the display plan:

```c
for (int i = 0; i < plan->length && h264_layer_count < 8; i++) {
    guac_display_layer* layer = plan->ops[i].layer;
    if (layer->h264_queue == NULL) continue;
```

which makes the decode the clock that drives everything else: the decode dirties
pixels, dirty pixels produce plan operations, a non-empty plan is what causes
`guac_display_plan_apply()` to run, and that is what flushes the H.264 queue.
Delete the decode from that design and `guac_display_plan_create()` returns NULL,
`plan_apply` never runs, and *no H.264 is sent at all*. So this is not a line to
remove — it is a sequencing dependency to replace, which is what makes it a
patch rather than a deletion, and three separate things have to move (below).

Skipping the decode is what takes guacd from a heavily-utilized core to near-idle. It
does mean the server no longer holds a pixel copy of the surface, which has
consequences for anything that reads back the framebuffer.  This may be an intentional
choice anticipating some need for the pixel copy in a future feature.

## Why the original AVC444 fix was needed, and what it should have been

4bcac32 was fixing a real bug: with AVC444 advertised, Windows sends two H.264
bitstreams per frame (main/luma view + auxiliary chroma view) and the passthrough
forwarded only `bitstream[0]`, producing the green/magenta split.

Selectively forwarding one view cannot work, and this is worth recording because
it is not obvious: in FreeRDP's `avc444_decompress`, **both bitstreams are
decoded through the same `H264_CONTEXT`**. They are one H.264 sequence with
alternating views, not two independent streams. Dropping either one breaks
reference frames for the other — and the decoder reports no error, because what
arrives is well-formed. The corruption is silent.

The fix is to forward both views, tagged, and let the client decode both through
one `VideoDecoder`. The auxiliary view carries the chroma samples the main view
lacks, so the browser combines the two into true 4:4:4 rather than drawing the
main view alone at 4:2:0 (see below).

## Proposed fix

Branch: `pletch/rustguac@upstream/h264-avc444-passthrough` — cut from `main`
at v1.9.9 and carrying only this work, two commits, no unrelated fork changes.
Consolidated patch `patches/004-h264-passthrough.patch` replaces
`004-h264-display-worker.patch`.

- Consolidates `004` plus the development patches into **one** patch, no
  environment variables and no configuration beyond the existing per-connection
  `enable-h264` checkbox.
- Restores `GfxAVC444 = TRUE` (with a comment explaining the FreeRDP gate, since
  the setting reads as the opposite of what it does).
- Skips the GDI decode for H.264 commands only; RemoteFX, planar and progressive
  still decode normally, so a mixed-codec session stays correct.
- Replaces the frame-sequencing the decode used to provide, in three places:
  `PFW_guac_display_flush_h264()` walks `display->pending_frame.layers` from
  `guac_display_end_multiple_frames()` instead of walking the plan (a
  passthrough layer has no plan); `frame_nonempty || h264_sent` enqueues the
  end-of-frame NOP so a `sync` is still sent, without which `display.flush()`
  stalls client-side; and `rdp_client->gdi_modified` is raised where
  `guac_rdp_gdi_end_paint()` would have, since with no decode nothing else
  marks the display modified. That last one is deliberately the flag rather
  than a direct `notify_modified()` — the RDP event loop batches it per message
  batch, and notifying per surface command pins `FRAME_MODIFIED` set at high
  frame rates, delaying every flush to the 100 ms `MAX_FRAME_DURATION`.
- Updates `docs/rdp-video-performance.md`, whose description of the pipeline
  the above makes obsolete.
- Extends the `h264` instruction with a `view` field so both AVC444 views reach
  the browser:
  ```
  h264 <stream> <layer> <keyframe> <x> <y> <width> <height>
       <view> <numrects> [<x> <y> <width> <height>]...
  ```
  view 0 = displayable (AVC420, or the AVC444 main view), 1 = AVC444 chroma v1,
  2 = AVC444 chroma v2. An auxiliary view must be decoded but must not be drawn.

Also on the branch: `docs/rdp-h264.md` (the Windows host settings below, plus
how to verify what a server is actually sending), a rewritten `004` section in
`patches/README.md`, `contrib/measure-guacd-cpu.sh`, an extended
`contrib/setup-rdp-performance.ps1`, and — as its own commit — a one-line fix
loading the decoder in `recordings.html`, without which recordings of H.264
sessions play back blank.

### AVC444 4:4:4 reconstruction in the browser

`static/guac/Yuv444.js` unpacks the auxiliary view's packed chroma (both
MS-RDPEGFX layouts) and converts to RGB in a single WebGL2 pass, inverting the
encoder's chroma filter to recover the one sample per 2x2 block that neither view
carries. This matters for text: at 4:2:0 the subpixel-antialiased (ClearType)
edges Windows sends lose colour resolution and read as fringed.

Two implementation notes that cost real time:

- Frames must be copied in **the decoder's own pixel format**. `VideoFrame.copyTo()`
  will not convert NV12 — what hardware decoders produce — to I420; requesting a
  format throws from `allocationSize()` before anything is copied. This presented
  as a black screen only on machines with hardware decode.
- The path falls back to 4:2:0 on missing WebGL2, a lost GL context, or a pixel
  format it cannot read, so a failure degrades quality instead of the session.

Two runtime overrides exist for diagnosis (window global / query param /
localStorage): `h264Chroma444` (off disables combining) and `h264ChromaFilter`
(off, or a 0–255 threshold; default 30, from FreeRDP's `CONDITIONAL_CLIP`).

### Measurements

guacd CPU, 1080p video playing, sampled per-thread over 30s:

| Host | Before | After |
|---|---|---|
| xrdp (AVC420) | ~100% of a core | **2.0%** |
| Windows 11 (AVC444v2) | 90.6% of a core | **2.1%** |

On the consolidated branch, a Windows session measured 3.9% of a core total,
with the encoder threads (`display-wrk`) at 0.05 CPU-seconds out of 1.17 — 77%
of what remains is `rdp-worker` doing channel and copy work. `display-wrk`
near zero is the meaningful signal: no image encoding is happening. The 2.1% and
3.9% figures are from different sessions with uncontrolled workloads, so I would
not read the difference between them as significant.

Browser-side over a full Windows session: 3799 frames decoded, 3799 closed, 0
leaked, 0 watchdog fires, average decode latency 1.4 ms, peak queue depth 3.

## Windows host requirements (relevant to anyone reproducing this)

Hardware H.264 encoding will not engage on Windows until the Group Policy **"Use
WDDM graphics display driver for Remote Desktop Connections"** is set to
**Disabled** (Computer Configuration → Administrative Templates → Windows
Components → Remote Desktop Services → Remote Desktop Session Host → Remote
Session Environment), followed by a reboot.

This one cost a lot of time. With the WDDM driver active the session renders on
the GPU but never reaches the encoder: Task Manager shows GPU 3D under load while
**Video Encode stays flat at 0%** and `nvidia-smi encodersessions` reports
nothing. The registry values below are accepted and have no effect until WDDM is
disabled. Verified on Windows 11 Pro with an RTX 3070.

Also required, under
`HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services`:

- `AVC444ModePreferred = 1` — counter-intuitively needed **for hardware
  encoding**, not for quality; setting it to 0 stopped NVENC on the test host.
  This is why Windows sends AVC444 and why handling both views matters.
- `AVCHardwareEncodePreferred = 1`, `bEnumerateHWBeforeSW = 1`

Note that disabling the WDDM driver changes the display pipeline, so dynamic
resize and multi-monitor behaviour are worth re-checking.

## Caveats

- The AVC444 **v1** chroma path (`view 1`) is implemented but untested — neither
  xrdp nor Windows 11 produced it; Windows sent AVC444 **v2** exclusively, as a
  whole-screen command with no mixed-codec regions.
- Windows ignores `RDPGFX_CAPS_FLAG_AVC_THINCLIENT`: with it set the host still
  confirmed capability version 10.7 (flags `0x42`) and sent AVC444 regardless.
  There is no way to ask a Windows host for AVC420 specifically.
- The client-side debug instrumentation used to find these problems (an h264
  case in the draw-op ring, `?debug=nofit`, a black-region finder) is
  deliberately **not** on the branch; it lives on my fork if it is wanted.

## Environment

guacd built from apache/guacamole-server `6719b20d`, FreeRDP 3.x on Debian 13,
Windows 11 Pro + RTX 3070, and xrdp with VAAPI-accelerated encoding. rustguac
branch based on `main` at v1.9.9 (6cfe341); no rebase outstanding. The patch
itself has been built and run from that fork continuously; it is unchanged on
this branch.
