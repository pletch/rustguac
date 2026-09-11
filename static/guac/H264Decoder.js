/*
 * H.264 decoder for Guacamole using the WebCodecs API.
 * Decodes H.264 NAL units received via the "h264" instruction and
 * renders decoded frames to a Guacamole Display layer.
 *
 * Copyright (C) 2026 Sol1 Pty Ltd. Licensed under Apache 2.0.
 */

var Guacamole = Guacamole || {};

/**
 * H.264 video decoder that uses the WebCodecs VideoDecoder API for
 * hardware-accelerated decoding of H.264 NAL units received from guacd.
 *
 * Frames are not drawn from the decoder's output callback. They are drawn from
 * a task scheduled on the display's queue at the point the instruction
 * arrived, so that decoded video is painted in stream order rather than
 * whenever decode happens to finish. See Guacamole.Display.drawH264().
 *
 * @constructor
 * @param {!Guacamole.Display} display
 *     The Guacamole display to render decoded frames to.
 */
Guacamole.H264Decoder = function H264Decoder(display) {

    /**
     * The WebCodecs VideoDecoder instance, or null if not yet initialised
     * or if WebCodecs is not supported.
     *
     * @private
     * @type {?VideoDecoder}
     */
    var decoder = null;

    /**
     * Whether the decoder has been configured with codec parameters.
     *
     * @private
     * @type {boolean}
     */
    var configured = false;

    /**
     * The codec string most recently configured, so that a change is logged
     * once rather than on every decoder rebuild.
     *
     * @private
     * @type {?string}
     */
    var lastCodec = null;

    /**
     * Whether the next access unit submitted must be a keyframe. Set after a
     * terminal decoder error, since a rebuilt decoder holds no reference
     * frames and a delta frame would only error it again immediately.
     *
     * @private
     * @type {boolean}
     */
    var needsKeyFrame = false;

    /**
     * Monotonic timestamp counter for EncodedVideoChunk (microseconds). Also
     * serves as the token identifying each submitted frame.
     *
     * @private
     * @type {number}
     */
    var timestamp = 0;

    /**
     * Number of frames submitted to the decoder but not yet painted.
     *
     * @private
     * @type {number}
     */
    var pendingDecodes = 0;

    /**
     * Maximum number of frames allowed to remain in flight when acknowledging
     * a Guacamole sync. A depth of 0 forces the sync ack to wait for every
     * frame to fully decode and paint, serializing network RTT and async
     * decode time on every frame and causing severe input lag. Allowing a
     * shallow pipeline overlaps RTT with decode while keeping the backlog
     * bounded, so guacd backpressure still applies beyond this depth.
     *
     * @private
     * @constant
     * @type {number}
     */
    var MAX_PIPELINE_DEPTH = 2;

    /**
     * Default framebuffer area, in pixels, up to which AVC444 views are
     * combined into 4:4:4. See combineMaxPixels().
     *
     * @private
     * @constant
     * @type {!number}
     */
    var COMBINE_MAX_PIXELS = 4000000;

    /**
     * How long a session that gave up combining must stay quiet -- under
     * QUIET_SYNCS_PER_SECOND, with no sync gate timeout -- before it tries
     * combining again, in milliseconds.
     *
     * Long, because the point is to distinguish "the video ended" from "the
     * video paused between scenes". Resuming is not free: the first combine
     * after a gap uploads whole planes rather than the damaged rows, which is
     * the most expensive kind of combine there is, and delivering that spike to
     * a client that has just stopped struggling is how a gate makes things
     * worse. The flapping itself is nearly invisible -- only newly painted
     * regions change chroma resolution -- so the cost being avoided here is the
     * resync, not the appearance.
     *
     * @private
     * @constant
     * @type {!number}
     */
    var COMBINE_RECOVER_MS = 30000;

    /**
     * How many times a session may give up and resume before giving up for
     * good.
     *
     * A client recovering from a transient load looks the same, sample by
     * sample, as one that simply cannot sustain the combine. The difference is
     * only visible over time, and this is what draws the line: three trips is
     * a client that keeps failing, not a desktop that had a video playing.
     *
     * @private
     * @constant
     * @type {!number}
     */
    var COMBINE_MAX_TRIPS = 3;

    /**
     * Safety timeout (ms) for the sync gate. If pending decodes do not drain
     * within this window the sync is acked anyway, preventing a permanent
     * stall if the decoder wedges.
     *
     * @private
     * @constant
     * @type {number}
     */
    var SYNC_WAIT_TIMEOUT_MS = 200;

    /**
     * How long a scheduled draw task may wait for its frame before giving up,
     * in milliseconds. The task blocks the display queue until its frame
     * arrives, so a frame lost without an error being reported would stall the
     * display indefinitely; skipping one frame is the lesser cost. Generous,
     * because a healthy decoder returns frames in single-digit milliseconds.
     *
     * @private
     * @constant
     * @type {number}
     */
    var DECODE_WATCHDOG_MS = 1000;

    /**
     * Timestamp of the last sync-timeout warning, for rate-limiting the log so
     * a struggling decoder cannot flood the console (heavy logging on the main
     * thread itself worsens decode and paint latency).
     *
     * @private
     * @type {number}
     */
    var lastTimeoutWarn = 0;

    /**
     * When each diagnostic event was last reported, keyed by event name.
     *
     * Diagnostics go to the server and end up in its journal, so they are
     * deduplicated here as well as rate limited there: the conditions being
     * reported (a decoder waiting for a keyframe, frames being abandoned) last
     * for as long as the fault does, and would otherwise report on every frame
     * for the duration.
     *
     * @private
     * @type {Object.<string, number>}
     */
    var diagLastSent = {};

    /**
     * Minimum spacing between reports of the same diagnostic event, in ms.
     *
     * @private
     * @constant
     * @type {number}
     */
    var DIAG_INTERVAL_MS = 30000;

    /**
     * Reports a diagnostic observation to whatever the page has installed as
     * Guacamole.H264Decoder.onDiagnostic, if anything, and to the console
     * either way.
     *
     * What the decoder knows -- that it rebuilt itself, that it is holding
     * every frame until a keyframe the server may not send for minutes, that
     * it gave up on frames -- is invisible from the server, and a console
     * message is no use for a fault that appears once in days on someone
     * else's machine. This is how it reaches the session log.
     *
     * @private
     * @param {!string} event
     *     Short machine-readable event name.
     *
     * @param {!string} detail
     *     Human-readable description.
     *
     * @param {boolean} [always]
     *     Send even if this event was reported within DIAG_INTERVAL_MS. Used
     *     for one-shot transitions, which are meaningful individually.
     */
    function diagnostic(event, detail, always) {

        var now = nowMs();
        if (!always && diagLastSent[event]
                && now - diagLastSent[event] < DIAG_INTERVAL_MS)
            return;

        diagLastSent[event] = now;
        console.warn('[rustguac] H.264 ' + event + ': ' + detail);

        var sink = Guacamole.H264Decoder.onDiagnostic;
        if (sink) {
            try { sink(event, detail); }
            catch (e) { /* a broken sink must not break decoding */ }
        }

    }

    /**
     * Counts of abandoned frames already reported, so that each report covers
     * only what has happened since the last one.
     *
     * @private
     */
    var diagReportedWatchdog = 0;
    var diagReportedSync = 0;

    /**
     * When the decoder started holding frames for want of a keyframe, and how
     * many it has dropped since. A decoder in this state paints nothing at all
     * while the server has no reason to send a keyframe unprompted, so the
     * duration is the length of time the screen was frozen.
     *
     * @private
     */
    var keyframeWaitSince = 0;
    var keyframeWaitDropped = 0;

    /**
     * Running counts of what the decoder has done with the stream, and when it
     * last did each, for getState().
     *
     * A display gone black while frames still arrive has three possible
     * explanations -- nothing is being decoded, the decoder is producing black,
     * or its pictures are painted and do not stay -- and the page can only
     * tell them apart by asking the decoder what it has been doing.
     *
     * @private
     */
    var counts = {
        submitted: 0,
        keyframes: 0,
        decoded: 0,
        painted: 0,
        lastPaintAt: 0,
        lastKeyframeAt: 0,
        lastKeyframePaintAt: 0
    };

    /**
     * How many paint probes remain for the current black-display episode, or 0
     * if the page is not asking for them. See setProbing().
     *
     * @private
     * @type {!number}
     */
    var probesLeft = 0;

    /**
     * When the last delta-frame probe ran. Keyframes are not counted here:
     * probeKeyframe() reports every one of them regardless.
     *
     * @private
     * @type {!number}
     */
    var lastProbeAt = 0;

    /**
     * Probes allowed per black-display episode, and the minimum spacing of
     * probes on delta frames, in milliseconds. Every probe is a diagnostic,
     * and the page budgets those at ten a minute across all events.
     *
     * @private
     * @constant
     */
    var PROBES_PER_EPISODE = 6;
    var PROBE_DELTA_INTERVAL_MS = 10000;

    /**
     * Small canvas that probed regions are downscaled into for reading back.
     *
     * @private
     * @type {?HTMLCanvasElement}
     */
    var probeCanvas = null;

    /**
     * Mean Rec. 709 luma of a region of an image, and the fraction of it that
     * is black, sampled by downscaling it to 32x32.
     *
     * @private
     * @returns {?{mean: number, dark: number}}
     *     Null if the region is empty or cannot be read.
     */
    function sampleLuma(source, x, y, width, height) {

        if (width <= 0 || height <= 0)
            return null;

        if (!probeCanvas) {
            probeCanvas = document.createElement('canvas');
            probeCanvas.width = 32;
            probeCanvas.height = 32;
        }

        var ctx = probeCanvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, 32, 32);
        ctx.drawImage(source, x, y, width, height, 0, 0, 32, 32);

        var data = ctx.getImageData(0, 0, 32, 32).data;
        var sum = 0, dark = 0, n = data.length / 4;
        for (var i = 0; i < data.length; i += 4) {
            var luma = 0.2126 * data[i] + 0.7152 * data[i + 1]
                    + 0.0722 * data[i + 2];
            sum += luma;
            if (luma < 8)
                dark++;
        }

        return { mean: sum / n, dark: dark / n };

    }

    /**
     * Whether an RGB sample is the green a decoder paints from zeroed YUV
     * planes: Y=U=V=0 converts to roughly (0, 135, 0). A hardware decoder shows
     * it for macroblocks it concealed or decoded from a missing reference.
     *
     * @private
     */
    function isDecoderGreen(r, g, b) {
        return g >= 48 && r * 3 < g && b * 3 < g;
    }

    /**
     * Summarises a region of an image as an 8x4 grid: '#' for a cell over 90%
     * black, 'G' for one over 50% decoder green, '.' otherwise; plus the
     * region's mean luma and its black and green fractions. Sampled by
     * downscaling to 64x32, so each cell is 8x8 samples.
     *
     * @private
     * @returns {?{grid: string, mean: number, black: number, green: number}}
     *     Null if the region is empty.
     */
    function sampleGrid(source, x, y, width, height) {

        if (width <= 0 || height <= 0)
            return null;

        if (!gridCanvas) {
            gridCanvas = document.createElement('canvas');
            gridCanvas.width = 64;
            gridCanvas.height = 32;
        }

        var ctx = gridCanvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, 64, 32);
        ctx.drawImage(source, x, y, width, height, 0, 0, 64, 32);
        var data = ctx.getImageData(0, 0, 64, 32).data;

        var rows = [], sum = 0, black = 0, green = 0;
        for (var cy = 0; cy < 4; cy++) {
            var row = '';
            for (var cx = 0; cx < 8; cx++) {
                var cellBlack = 0, cellGreen = 0;
                for (var py = cy * 8; py < cy * 8 + 8; py++) {
                    for (var px = cx * 8; px < cx * 8 + 8; px++) {
                        var i = (py * 64 + px) * 4;
                        var r = data[i], g = data[i + 1], b = data[i + 2];
                        var luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                        sum += luma;
                        if (luma < 8) cellBlack++;
                        else if (isDecoderGreen(r, g, b)) cellGreen++;
                    }
                }
                black += cellBlack;
                green += cellGreen;
                row += cellBlack > 57 ? '#' : cellGreen > 32 ? 'G' : '.';
            }
            rows.push(row);
        }

        return {
            grid: rows.join('/'),
            mean: sum / 2048,
            black: black / 2048,
            green: green / 2048
        };

    }

    /**
     * Canvas that sampleGrid() downscales into.
     *
     * @private
     * @type {?HTMLCanvasElement}
     */
    var gridCanvas = null;

    /**
     * Reports every painted keyframe as two grids: the picture the decoder
     * produced, and the layer after it was drawn.
     *
     * Always on, unlike the paint probes, because the keyframe is the suspect:
     * in the field a keyframe was painted 2.5s before the display was found
     * black, so a probe that starts only once black is seen always misses the
     * frame that caused it. Keyframes are rare (about a dozen a session), and
     * each probe is two small read-backs.
     *
     * Black or green cells in the decoded grid mean the decoder produced them,
     * whatever the host sent. A clean decoded grid over a black layer grid
     * means only the rects were drawn and the rest was already black.
     *
     * @private
     */
    function probeKeyframe(frameState, snapshot, layerCanvas) {

        var fbWidth = display ? display.getWidth() : layerCanvas.width;
        var fbHeight = display ? display.getHeight() : layerCanvas.height;

        var w = Math.min(snapshot.width, fbWidth - frameState.x);
        var h = Math.min(snapshot.height, fbHeight - frameState.y);

        var decoded, landed;
        try {
            decoded = sampleGrid(snapshot, 0, 0, w, h);
            landed = sampleGrid(layerCanvas, 0, 0, fbWidth, fbHeight);
        }
        catch (e) {
            diagnostic('keyframe_probe', 'probe failed: ' + e.message, true);
            return;
        }

        if (!decoded || !landed)
            return;

        var rectArea = 0;
        if (frameState.rects)
            for (var r = 0; r < frameState.rects.length; r++)
                rectArea += frameState.rects[r].width
                        * frameState.rects[r].height;

        function fmt(sample) {
            return 'grid ' + sample.grid + ' luma ' + sample.mean.toFixed(0)
                    + ' black ' + (sample.black * 100).toFixed(0)
                    + '% green ' + (sample.green * 100).toFixed(0) + '%';
        }

        diagnostic('keyframe_probe', 'view=' + frameState.view + ' ' + w
                + 'x' + h + '@' + frameState.x + ',' + frameState.y + ' '
                + (frameState.rects ? 'rects=' + frameState.rects.length
                    + ' covering ' + (100 * rectArea / (w * h)).toFixed(0)
                    + '%' : 'whole')
                + '; decoded ' + fmt(decoded)
                + '; layer after ' + fmt(landed), true);

    }

    /**
     * Compares a decoded picture with what the layer holds after it was drawn
     * there, over the region painted, and reports both.
     *
     * This is what separates the explanations for a black display: a dark
     * picture means the decoder is producing black; a bright picture that
     * reads back dark from the layer means drawing onto the layer is not
     * taking; a bright picture that lands and a display that stays black means
     * the rest of the layer lost its pixels and only damage is being repaired.
     *
     * @private
     */
    function probePaint(frameState, snapshot, layerCanvas) {

        var sw = snapshot.width, sh = snapshot.height;
        var sx, sy, lx, ly, w, h;

        // With rects, snapshot and layer share coordinates; without, the whole
        // snapshot lands at the frame's offset.
        if (frameState.rects) {
            var x0 = Infinity, y0 = Infinity, x1 = 0, y1 = 0;
            for (var r = 0; r < frameState.rects.length; r++) {
                var rect = frameState.rects[r];
                x0 = Math.min(x0, rect.x);
                y0 = Math.min(y0, rect.y);
                x1 = Math.max(x1, rect.x + rect.width);
                y1 = Math.max(y1, rect.y + rect.height);
            }
            sx = lx = Math.max(0, x0);
            sy = ly = Math.max(0, y0);
            w = Math.min(x1, sw) - sx;
            h = Math.min(y1, sh) - sy;
        }
        else {
            sx = sy = 0;
            lx = frameState.x;
            ly = frameState.y;
            w = sw;
            h = sh;
        }

        var decoded, landed;
        try {
            decoded = sampleLuma(snapshot, sx, sy, w, h);
            landed = sampleLuma(layerCanvas, lx, ly, w, h);
        }
        catch (e) {
            diagnostic('paint_probe', 'probe failed: ' + e.message, true);
            return;
        }

        if (!decoded || !landed)
            return;

        function fmt(sample) {
            return 'luma ' + sample.mean.toFixed(0) + ' ('
                    + (sample.dark * 100).toFixed(0) + '% black)';
        }

        diagnostic('paint_probe', (frameState.keyFrame ? 'keyframe' : 'delta')
                + ' view=' + frameState.view + ' ' + w + 'x' + h + '@' + lx
                + ',' + ly + (frameState.rects
                    ? ' rects=' + frameState.rects.length : ' whole')
                + ': decoded ' + fmt(decoded) + ', layer after paint '
                + fmt(landed) + '; layer ' + layerCanvas.width + 'x'
                + layerCanvas.height, true);

    }

    /**
     * Reports frames given up on, if any have been since the last report. Both
     * counters are also consumed by the console stats block, which may be off,
     * so this tracks what it has reported rather than resetting them.
     *
     * @private
     */
    function reportAbandoned() {

        var watchdog = watchdogFires - diagReportedWatchdog;
        var sync = syncTimeouts - diagReportedSync;

        if (watchdog <= 0 && sync <= 0)
            return;

        diagReportedWatchdog = watchdogFires;
        diagReportedSync = syncTimeouts;

        diagnostic('frames_abandoned', watchdog + ' frame(s) past the '
                + DECODE_WATCHDOG_MS + 'ms decode watchdog, ' + sync
                + ' sync gate timeout(s). Damage carried by an abandoned '
                + 'frame is never repainted: the server only sends it once.');

    }

    /**
     * Per-frame state keyed by token, from submission until the frame is drawn
     * or abandoned.
     *
     * @private
     * @type {Object.<number, Object>}
     */
    var pendingFrames = {};

    /**
     * Callbacks waiting for pending decodes to drain, used by waitForPending
     * to gate the Guacamole sync response.
     *
     * @private
     * @type {function[]}
     */
    var flushResolvers = [];

    /**
     * If the backlog is back within the pipeline depth, fire and clear all
     * flush resolvers.
     *
     * The threshold has to be the one waitForPending() gates on. Releasing
     * only at zero meant that once the backlog exceeded the depth it had to
     * drain completely to let a sync through, and a session decoding
     * continuously never reaches zero -- so every sync waited out its full
     * 200ms timeout instead. That reports ~200ms of processing lag upstream
     * whatever the client is actually doing, which guacd answers by holding
     * frame acknowledgements and a self-pacing server answers by stretching
     * its capture interval. The symptom is a stuttering session whose client
     * is not in fact behind, and a console full of sync wait timeouts.
     *
     * It bites AVC444 first because a picture is two access units there, so
     * the backlog is twice as deep for the same frame rate and far less
     * likely to touch zero between frames -- which looks like AVC444 being
     * expensive rather than like a threshold mismatch.
     *
     * @private
     */
    function resolveIfIdle() {
        if (pendingDecodes <= MAX_PIPELINE_DEPTH && flushResolvers.length > 0) {
            var resolvers = flushResolvers;
            flushResolvers = [];
            for (var i = 0; i < resolvers.length; i++)
                resolvers[i]();
        }
    }

    /**
     * Marks a pending decode as finished exactly once, whatever its outcome:
     * drawn, failed, or abandoned. pendingDecodes gates the sync response, so
     * a decode that is never settled leaves the client reporting a backlog
     * forever and every sync waiting out its timeout.
     *
     * @private
     * @param {!Object} frameState
     *     The per-frame state to settle.
     */
    function settle(frameState) {
        if (!frameState || frameState.settled)
            return;
        frameState.settled = true;
        pendingDecodes--;
        resolveIfIdle();
    }

    /**
     * How long the framebuffer must keep one size before combining may start,
     * in milliseconds.
     *
     * The size changes several times in the first seconds of a session -- the
     * connect-time fit, then fullscreen -- and one of those steps (2240x1648,
     * 3.7MP) sits under COMBINE_MAX_PIXELS for about four seconds on the way
     * to 2992x2000 (6MP). An auxiliary view arriving inside it switched
     * combining on only for fullscreen to switch it off again, and a session
     * that went through that transition stalled -- one that did not, on the
     * same host, did not. Whether the first auxiliary view landed inside the
     * window was a race, which is why a reload could make it go away. Waiting
     * for the size to settle takes the window out of play.
     *
     * @private
     * @constant
     * @type {!number}
     */
    var COMBINE_SETTLE_MS = 5000;

    /**
     * The framebuffer size last seen, as "WxH", and when it last changed.
     *
     * @private
     */
    var lastFramebufferSize = '';
    var framebufferChangedAt = 0;

    /**
     * Notes the framebuffer's current size, restarting the settle clock if it
     * has changed. Called for every decoded picture: a string compare.
     *
     * @private
     */
    function noteFramebufferSize() {
        if (!display)
            return;
        var size = display.getWidth() + 'x' + display.getHeight();
        if (size !== lastFramebufferSize) {
            lastFramebufferSize = size;
            framebufferChangedAt = nowMs();
        }
    }

    /**
     * Whether the framebuffer has kept its size for COMBINE_SETTLE_MS. An
     * explicit h264Chroma444=on skips the wait, as it skips every other gate.
     *
     * @private
     * @returns {!boolean}
     */
    function framebufferSettled() {
        if (override('h264Chroma444') === true)
            return true;
        return framebufferChangedAt !== 0
                && nowMs() - framebufferChangedAt >= COMBINE_SETTLE_MS;
    }

    /**
     * Fraction of a keyframe's decoded picture that must be black for it to be
     * withheld, and how long the framebuffer must have kept its size first.
     * See keepPictureOverBlackKeyframe().
     *
     * @private
     * @constant
     */
    var BLACK_KEYFRAME_FRACTION = 0.98;
    var BLACK_KEYFRAME_STABLE_MS = 5000;

    /**
     * Whether a keyframe about to be painted should be withheld instead,
     * leaving the picture already on screen in place.
     *
     * Windows sometimes deletes and recreates its RDPGFX surface at the same
     * size, mid-session, with no resize. The new surface is empty, so its
     * first keyframe decodes black and covers the whole screen -- and Windows
     * then repaints only what it thinks changed, trusting the client still to
     * hold the rest. Both black-display episodes of 2026-09-11 were exactly
     * that (guacd logged Delete+CreateSurface 2992x2000 over 2992x2000 2-4s
     * before each), and they were the only same-size recreations that day.
     *
     * It is the same Windows behaviour as sol1/rustguac#118, where a resize
     * reallocated the surface and left regions unpainted. The evidence there
     * rules out asking Windows to repaint: a guacd patch sending
     * SuppressOutput off/on and RefreshRect after each resize fired and the
     * black stayed, since Windows does not re-stream its surface cache for
     * either. What fixed it was re-sending pixels the client side already had
     * (patch 005). Under passthrough guacd has none, but the browser does: it
     * is still showing the right picture when the black keyframe arrives. So
     * the keyframe is decoded -- later pictures reference it -- and not
     * painted, and the regions Windows does repaint land on the old picture,
     * which is what Windows assumes the client is showing.
     *
     * Not while the size is changing: after a resize or at connect, Windows
     * repaints everything, and what is on screen is the wrong size anyway.
     * The cost of being wrong is a genuinely black screen shown late, until
     * the next update arrives. h264KeepBlackKeyframes=off disables this.
     *
     * @private
     * @returns {!boolean}
     */
    function keepPictureOverBlackKeyframe(frameState, snapshot) {

        if (!frameState.keyFrame || override('h264KeepBlackKeyframes') === false)
            return false;

        if (!framebufferChangedAt
                || nowMs() - framebufferChangedAt < BLACK_KEYFRAME_STABLE_MS)
            return false;

        var sample;
        try {
            sample = sampleGrid(snapshot, 0, 0, snapshot.width, snapshot.height);
        }
        catch (e) {
            return false;
        }

        if (!sample || sample.black < BLACK_KEYFRAME_FRACTION)
            return false;

        diagnostic('h264_black_keyframe_kept', 'withheld a keyframe decoded '
                + (sample.black * 100).toFixed(0) + '% black with the '
                + 'framebuffer unchanged for '
                + ((nowMs() - framebufferChangedAt) / 1000).toFixed(0)
                + 's: most likely Windows recreating its surface. Keeping the '
                + 'picture on screen; h264KeepBlackKeyframes=off paints it',
                true);

        return true;

    }

    /**
     * Whether combining is currently given up. See suspendCombining().
     *
     * @private
     * @type {!boolean}
     */
    var combineLatchedOff = false;

    /**
     * When the last sync gate timeout happened, in ms, or 0 if none has. A
     * suspended session resumes only once COMBINE_RECOVER_MS have passed
     * without one.
     *
     * @private
     * @type {!number}
     */
    var lastSyncTimeoutAt = 0;

    /**
     * How many times combining has been given up this session.
     *
     * @private
     * @type {!number}
     */
    var combineTrips = 0;

    /**
     * Sync timeouts, in ms, charged to combining within the last
     * COMBINE_TIMEOUT_WINDOW_MS.
     *
     * @private
     * @type {!number[]}
     */
    var recentSyncTimeouts = [];

    /**
     * Sync gate timeouts within COMBINE_TIMEOUT_WINDOW_MS that give up
     * combining.
     *
     * Measured at 2992x2000 on the same client and host: 4:2:0 held 0-3% of
     * syncs for a mean of 1.5ms, with no timeouts in thousands; 4:4:4 held 10%
     * for a mean of 271ms, with 25 timeouts a minute -- about four per window.
     * Held syncs outlasted the 200ms timer by up to 140ms, so the combine was
     * blocking the main thread, not only the GPU.
     *
     * @private
     * @constant
     */
    var COMBINE_TIMEOUT_TRIP = 3;
    var COMBINE_TIMEOUT_WINDOW_MS = 10000;

    /**
     * Counts a sync gate timeout, giving up combining when enough land close
     * together while it is on.
     *
     * **Why sync timeouts and not the decode backlog**, which is what this
     * gate watched first. 012's pacing holds each ack until the backlog is
     * within MAX_PIPELINE_DEPTH, so guacd slows to the client's pace and the
     * queue stays short: a client that is merely slow never builds a backlog,
     * and a session combining at 6MP felt much slower while every snapshot
     * read pending=0. The cost lands on the sync gate instead. And a backlog
     * cannot build without timeouts -- every sync waits for the queue to
     * drain and gives up after SYNC_WAIT_TIMEOUT_MS if it does not -- so this
     * also trips before a backlog gate would, on a client that is drowning.
     *
     * **Deliberately a latch and not a controller.** An earlier version
     * measured the combine against a frame budget whose divisor was the
     * interval between pictures, which is what 012's back-pressure has already
     * throttled the server to -- so it read its own output as its input and
     * had to be kept from hunting. This gives up once, one way, and resumes
     * only after COMBINE_RECOVER_MS clear, at most COMBINE_MAX_TRIPS times.
     *
     * **And it gates on the symptom, not the cost.** Measuring the combine
     * means timing GPU execution, which needs a gl.finish() per picture --
     * stalling the pipeline this protects -- or timer queries that are not
     * reliably available. A held ack needs neither and is what the user feels.
     *
     * The cost of being wrong is bounded: timeouts caused by something else --
     * a slow link, a struggling decoder -- give up chroma for nothing, which
     * loses a little colour resolution and no frames.
     *
     * @private
     * @param {!string} mode
     *     '444' if the ack was held while combining, '420' otherwise.
     */
    function noteSyncTimeout(mode) {

        /* The operator is driving this by hand: an override is an
         * instruction, not a preference, and a gate that fought it would make
         * the comparison it exists for impossible. */
        if (override('h264Chroma444') !== undefined)
            return;

        var now = nowMs();

        /* Any timeout, combining or not, says the client is not clear of load,
         * and so holds off a resume. */
        lastSyncTimeoutAt = now;

        if (mode !== '444' || !combining || combineLatchedOff)
            return;

        recentSyncTimeouts.push(now);
        while (recentSyncTimeouts.length
                && now - recentSyncTimeouts[0] > COMBINE_TIMEOUT_WINDOW_MS)
            recentSyncTimeouts.shift();

        if (recentSyncTimeouts.length < COMBINE_TIMEOUT_TRIP)
            return;

        suspendCombining(COMBINE_TIMEOUT_TRIP + ' sync gate timeouts in '
                + ((now - recentSyncTimeouts[0]) / 1000).toFixed(1) + 's');

    }

    /**
     * Gives up combining until the load that caused it has passed, counting
     * the trip. Shared by the two trips: sync gate timeouts (the client cannot
     * keep up at all) and slow flushes (it keeps up, but sets the frame rate).
     *
     * Only the latch is set here. Combining stops at the next main view, where
     * the output callback re-checks chroma444Enabled(): a trip can land between
     * a paired main view -- uploaded, deliberately unpainted -- and the
     * auxiliary view that paints it. Stopping in between discards that
     * picture, and if it is a keyframe nothing repaints the screen.
     *
     * @private
     * @param {!string} reason
     *     What tripped it, for the diagnostic.
     */
    function suspendCombining(reason) {

        combineLatchedOff = true;
        combineTrips++;
        recentSyncTimeouts = [];
        flushWindow = null;

        diagnostic('chroma_suspended', 'gave up 4:4:4 combining: ' + reason
                + ' -- the client is setting the frame rate. Painting 4:2:0'
                + (combineTrips >= COMBINE_MAX_TRIPS
                    ? ' for the rest of the session, having given up '
                        + combineTrips + ' times'
                    : ' until the session has been quiet (under '
                        + QUIET_SYNCS_PER_SECOND + ' syncs/s, no timeouts) for '
                        + (COMBINE_RECOVER_MS / 1000) + 's')
                + '; ?h264Chroma444=on forces it back on', true);

    }

    /**
     * Mean flush time, in ms, above which a busy window while combining gives
     * combining up; the window's length; and the syncs it must hold to count.
     *
     * Measured at 1920x1072 on one client, playing the same video against the
     * xrdp fork: 4:2:0 ran at 54.7 syncs/s with a mean flush of 0.6ms; 4:4:4
     * at 33-41/s with 16-22ms, and 14ms even at 1920x896. No sync was held and
     * none timed out in either mode, so the timeout trip could never see it:
     * the client kept up, it just set a frame rate 40% lower. 8ms sits more
     * than ten times above the one and well under the other.
     *
     * The minimum count keeps a static desktop combining. It sends a few
     * syncs a second, well under 100 in a window, and its full chroma is what
     * combining is for; only motion is worth giving it up for.
     *
     * @private
     * @constant
     */
    var COMBINE_FLUSH_TRIP_MS = 8;
    var COMBINE_FLUSH_WINDOW_MS = 10000;
    var COMBINE_FLUSH_MIN_SYNCS = 100;

    /**
     * The flush window in progress while combining, or null.
     *
     * @private
     * @type {?{start: number, syncs: number, sumMs: number}}
     */
    var flushWindow = null;

    /**
     * Counts one sync's flush while combining, and gives combining up at the
     * end of a busy window whose mean flush is over COMBINE_FLUSH_TRIP_MS.
     *
     * @private
     */
    function noteCombineFlush(flushMs) {

        if (override('h264Chroma444') !== undefined || !combining
                || combineLatchedOff || typeof flushMs !== 'number') {
            flushWindow = null;
            return;
        }

        var now = nowMs();
        if (!flushWindow)
            flushWindow = { start: now, syncs: 0, sumMs: 0 };

        flushWindow.syncs++;
        flushWindow.sumMs += flushMs;

        if (now - flushWindow.start < COMBINE_FLUSH_WINDOW_MS)
            return;

        var mean = flushWindow.sumMs / flushWindow.syncs;
        var syncs = flushWindow.syncs;
        var span = now - flushWindow.start;
        flushWindow = null;

        if (syncs >= COMBINE_FLUSH_MIN_SYNCS && mean > COMBINE_FLUSH_TRIP_MS)
            suspendCombining('mean flush ' + mean.toFixed(1) + 'ms over '
                    + syncs + ' syncs in ' + (span / 1000).toFixed(0)
                    + 's, over the ' + COMBINE_FLUSH_TRIP_MS + 'ms a '
                    + 'combining client is expected to stay within');

    }

    /**
     * Syncs per second at or under which the session counts as quiet, for
     * resuming. See maybeResumeCombining().
     *
     * @private
     * @constant
     * @type {!number}
     */
    var QUIET_SYNCS_PER_SECOND = 10;

    /**
     * When the session was last busier than QUIET_SYNCS_PER_SECOND, measured
     * over one-second buckets; and the bucket in progress.
     *
     * @private
     */
    var lastBusyAt = 0;
    var busyBucket = null;

    /**
     * Counts a sync towards the busy/quiet measure.
     *
     * @private
     */
    function noteActivity() {
        var now = nowMs();
        if (!busyBucket || now - busyBucket.start >= 1000) {
            if (busyBucket && busyBucket.syncs > QUIET_SYNCS_PER_SECOND)
                lastBusyAt = now;
            busyBucket = { start: now, syncs: 0 };
        }
        busyBucket.syncs++;
    }

    /**
     * Lets a suspended session try combining again, once it has gone
     * COMBINE_RECOVER_MS without a sync gate timeout. Checked on every sync,
     * which is where a timeout would show. Resuming only clears the latch:
     * combining itself restarts at the next auxiliary view, through the same
     * area check as at connect.
     *
     * @private
     */
    function maybeResumeCombining() {

        if (!combineLatchedOff || combineTrips >= COMBINE_MAX_TRIPS)
            return;

        var now = nowMs();

        /* Not merely timeout-free: 4:2:0 never times out and never flushes
         * slowly, so that alone would resume in the middle of the video that
         * tripped it, trip again a window later, and spend every trip on one
         * video. Quiet is what says the motion has passed. */
        if (now - lastSyncTimeoutAt < COMBINE_RECOVER_MS
                || now - lastBusyAt < COMBINE_RECOVER_MS)
            return;

        combineLatchedOff = false;

        diagnostic('chroma_resumed', 'resuming 4:4:4 combining: quiet, with no '
                + 'sync gate timeout, for ' + (COMBINE_RECOVER_MS / 1000) + 's ('
                + combineTrips + ' of ' + COMBINE_MAX_TRIPS
                + ' attempts used)', true);

    }

    /**
     * Cancels a frame's decode watchdog, if it is still armed.
     *
     * @private
     * @param {object} frameState
     *     The frame's pending state, or null.
     */
    function clearWatchdog(frameState) {
        if (frameState && frameState.watchdog) {
            clearTimeout(frameState.watchdog);
            frameState.watchdog = null;
        }
    }

    /**
     * Canvases available for reuse as frame snapshots. A snapshot is held from
     * decode until its draw task runs, so several are live at once and one
     * shared canvas will not do. Allocating a fresh canvas per frame instead
     * would churn a 1080p-sized buffer at frame rate.
     *
     * @private
     * @type {HTMLCanvasElement[]}
     */
    var canvasPool = [];

    /**
     * Maximum number of canvases to retain for reuse. The pipeline holds only a
     * few frames at a time; canvases beyond this are dropped for collection
     * rather than kept alive indefinitely after a burst.
     *
     * @private
     * @constant
     * @type {number}
     */
    var MAX_CANVAS_POOL = 8;

    /**
     * Returns a canvas of the given size, reusing a pooled one where possible.
     *
     * @private
     * @param {number} width - Required width, in pixels.
     * @param {number} height - Required height, in pixels.
     * @returns {!HTMLCanvasElement}
     */
    function acquireCanvas(width, height) {

        var canvas = canvasPool.pop();
        if (!canvas)
            canvas = document.createElement('canvas');

        /* Assigning either dimension clears the canvas, so only resize when the
         * size actually differs; the frame is about to overwrite it anyway. */
        if (canvas.width !== width)
            canvas.width = width;
        if (canvas.height !== height)
            canvas.height = height;

        return canvas;

    }

    /**
     * Returns a canvas to the pool for reuse.
     *
     * @private
     * @param {HTMLCanvasElement} canvas - The canvas to release.
     */
    function releaseCanvas(canvas) {
        if (canvas && canvasPool.length < MAX_CANVAS_POOL)
            canvasPool.push(canvas);
    }

    /**
     * Releases a frame's snapshot, whatever kind it is. The 4:2:0 path
     * snapshots into a pooled canvas; the combine path renders offscreen and
     * hands the drawing buffer over as an ImageBitmap, which owns GPU memory
     * until it is closed and belongs to no pool.
     *
     * @private
     * @param {HTMLCanvasElement|ImageBitmap} snapshot - The snapshot, if any.
     */
    function releaseSnapshot(snapshot) {

        if (!snapshot)
            return;

        if (typeof ImageBitmap !== 'undefined'
                && snapshot instanceof ImageBitmap) {
            try {
                snapshot.close();
            } catch (ignore) {
                /* Already closed */
            }
            return;
        }

        releaseCanvas(snapshot);

    }

    /**
     * Combines the two views of an AVC444 picture into 4:4:4, or null when the
     * stream carries no auxiliary view, the browser cannot support it, or it
     * has been switched off. Created lazily, on first sight of an auxiliary
     * view, so an AVC420 stream never allocates a GL context.
     *
     * @private
     * @type {Guacamole.Yuv444Renderer}
     */
    var yuv444 = null;

    /**
     * Whether 4:4:4 combining has been ruled out for this stream, so it is not
     * attempted again on every frame.
     *
     * @private
     * @type {!boolean}
     */
    var yuv444Unavailable = false;

    /**
     * Whether the renderer has been told this stream's colour space. Applied
     * from the first main-view frame and not revisited: a decoder replaced
     * mid-session re-runs this, but the stream's signalling does not change
     * frame to frame, and reading it per frame would be pure overhead.
     *
     * @private
     * @type {!boolean}
     */
    var colorSpaceApplied = false;

    /**
     * Whether the current stream is being combined to 4:4:4. False until an
     * auxiliary view actually arrives: an AVC420 stream has no second view to
     * combine, and reading planes back costs a copy per frame that would buy
     * nothing there.
     *
     * @private
     * @type {!boolean}
     */
    var combining = false;


    /**
     * Whether the picture currently being combined had to upload whole planes
     * because the textures were stale. Such a picture is the most expensive
     * kind of combine there is, so it is not representative of what combining
     * costs in the steady state and is left out of the diagnostic.
     *
     * @private
     * @type {!boolean}
     */
    var combineResynced = false;

    /**
     * Whether the renderer's textures no longer hold the previous picture, so
     * the next combine must upload whole planes rather than the damaged rows.
     *
     * Banded upload assumes every row outside the damage still holds what it
     * held last picture. That stops being true the moment a picture is painted
     * without being combined: the screen moved on and the textures did not.
     *
     * @private
     * @type {!boolean}
     */
    var resyncNeeded = true;

    /**
     * Work already done for the current picture's main view, carried across to
     * the auxiliary view that completes it so the gate is charged once per
     * picture rather than once per view.
     *
     * @private
     * @type {!number}
     */
    var combineWorkMs = 0;

    /**
     * Per-picture combine cost, split by whether the picture carried an
     * auxiliary view. Off unless h264CombineLog is set.
     *
     * The gate averages every picture into one figure, which is the right
     * input for deciding whether combining is affordable but the wrong one
     * for finding a stutter. A server sending chroma every Nth picture makes
     * one picture in N several times dearer than its neighbours, and a mean
     * taken across both hides exactly that: throughput looks healthy while
     * the session hitches N times a second. Splitting the two says whether a
     * long tail lives in the chroma pictures or is spread across all of them
     * -- the first is the combine's fault and can be gated, the second is the
     * decode's and cannot.
     *
     * @private
     */
    var stats = null;

    /**
     * Events since the last diagnostic report: plane read-backs and the two
     * ways a frame can be given up on.
     *
     * The read-back wait is the gap this instrument was missing. Combine cost
     * is deliberately timed as work and not wait, so that the gate cannot feed
     * on its own backlog -- which also means a slow copyTo(), a GPU-to-CPU
     * transfer at HiDPI rather than the memcpy a software decoder makes it,
     * does not appear in it at all. The wait includes queueing behind earlier
     * pictures on purpose: that is what a backlog looks like from here.
     *
     * @private
     */
    var copyWait = null;
    var watchdogFires = 0;
    var syncTimeouts = 0;

    /**
     * Records one sample against a named stage, split by whether the picture
     * carried an auxiliary view, and reports every few seconds. Cheap enough
     * to leave in the path: one comparison when off.
     *
     * Three stages between the wire and the screen, so that time unaccounted
     * for by one is visible in the next rather than inferred:
     *
     *   decode   decode() submitted to the frame arriving in output(). The
     *            decoder's own cost plus anything queued inside it. An
     *            auxiliary view is coded full-frame while a main view codes
     *            damage only, so this is where that asymmetry would show.
     *   combine  read-back, plane upload, conversion and transfer.
     *   draw     the frame being ready to it reaching the layer, which is
     *            time spent in the display's ordered task queue rather than
     *            doing work.
     *
     *   paint    the blit from the snapshot into the display's layer. Split
     *            by which kind of surface crossed that boundary rather than
     *            by chroma: the 4:2:0 path hands over a 2D canvas, the
     *            combine path a GPU-resident ImageBitmap produced by a
     *            different (WebGL2) context. If that second handoff is a
     *            readback rather than a texture share it is area-proportional
     *            and vendor-independent, which is the shape the field numbers
     *            have -- so this is reported per megapixel as well as per
     *            picture, since a readback's cost tracks pixels and a texture
     *            share's does not.
     *
     * @private
     * @param {!string} stage - 'decode', 'combine', 'draw' or 'paint'.
     * @param {!(boolean|string)} variant - Whether the picture carried an
     *                                      auxiliary view, or an explicit
     *                                      bucket name for stages not split
     *                                      that way.
     * @param {!number} ms - The sample.
     * @param {number} [pixels] - Pixels this sample covered, where the stage
     *                            has a meaningful area. Reported as ms/MP.
     */
    function recordStat(stage, variant, ms, pixels) {

        if (!override('h264CombineLog'))
            return;

        var now = nowMs();

        if (!stats)
            stats = { since: now };

        var key = stage + ':' + (typeof variant === 'string' ? variant
                : (variant ? 'chroma' : 'luma'));
        var bucket = stats[key]
                || (stats[key] = { n: 0, sum: 0, max: 0, px: 0 });

        bucket.n++;
        bucket.sum += ms;
        bucket.px += pixels || 0;
        if (ms > bucket.max)
            bucket.max = ms;

        if (now - stats.since < 5000)
            return;

        function one(b) {
            if (!b || !b.n)
                return 'none';
            return b.n + ' mean ' + (b.sum / b.n).toFixed(1)
                    + ' max ' + b.max.toFixed(1)
                    + (b.px ? ' ' + (b.sum / (b.px / 1e6)).toFixed(2)
                        + 'ms/MP' : '');
        }

        var lines = ['[rustguac] H.264 over '
                + ((now - stats.since) / 1000).toFixed(1) + 's, ms:'];

        ['decode', 'combine', 'draw'].forEach(function(name) {
            lines.push('  ' + (name + '     ').slice(0, 8)
                    + 'chroma ' + one(stats[name + ':chroma'])
                    + '  |  luma ' + one(stats[name + ':luma']));
        });

        /* Split by handoff rather than by chroma -- see recordStat(). */
        function perMP(b) {
            return (b && b.px)
                ? (b.sum / (b.px / 1e6)).toFixed(2) + 'ms/MP' : 'none';
        }

        lines.push('  paint   bitmap ' + one(stats['paint:bitmap'])
                + '  |  canvas ' + one(stats['paint:canvas']));
        lines.push('          per buffer MP: bitmap '
                + perMP(stats['paintbuf:bitmap'])
                + '  |  canvas ' + perMP(stats['paintbuf:canvas']));

        var tail = [];
        if (copyWait && copyWait.n)
            tail.push('read-back wait mean '
                    + (copyWait.sum / copyWait.n).toFixed(1) + ' max '
                    + copyWait.max.toFixed(1));
        if (watchdogFires || syncTimeouts)
            tail.push('GIVEN UP: ' + watchdogFires + ' watchdog, '
                    + syncTimeouts + ' sync timeout');
        if (tail.length)
            lines.push('  ' + tail.join('  |  '));

        console.log(lines.join('\n'));

        stats = null;
        copyWait = null;
        watchdogFires = 0;
        syncTimeouts = 0;

    }

    /**
     * A monotonic clock in milliseconds, falling back where performance is
     * absent.
     *
     * @private
     * @returns {!number}
     */
    /**
     * Forces the renderer's outstanding GPU work to complete, so that the
     * combine timing that follows measures execution rather than submission.
     *
     * Costs a pipeline stall, so it happens only when h264CombineLog has asked
     * for numbers. Without it the log reports the combine at well under a
     * millisecond while tests/bench, which does force completion, measures
     * ~1.37ms per megapixel for the same work -- a discrepancy that has twice
     * been read as the combine being cheap.
     *
     * @private
     */
    function finishForTiming() {
        if (yuv444 && yuv444.finish && override('h264CombineLog'))
            yuv444.finish();
    }

    function nowMs() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
    }


    /**
     * Serialises the work that follows plane read-back. Both views of a
     * picture write into the same set of textures, and the auxiliary view
     * refines what the main view uploaded, so the uploads have to happen in
     * decode order -- out of order, one picture's chroma is combined into
     * another's luma.
     *
     * Only the uploads are ordered, not the copies themselves. Each copyTo()
     * is issued as soon as its frame arrives, into a buffer of its own, and
     * this chain merely waits for it in turn. Chaining the call instead left
     * the two views of a picture strictly sequential, so every picture paid
     * two round trips to the GPU end to end rather than overlapping them.
     *
     * @private
     * @type {!Promise}
     */
    var copyChain = Promise.resolve();

    /**
     * Whether a main view has been uploaded and deferred, awaiting the
     * auxiliary view that will paint the picture, and the regions that main
     * view declared valid -- null meaning the whole picture.
     *
     * The two views carry separate region rects, and the picture they combine
     * to is valid wherever either one says it is. While both views painted,
     * each painted its own; with the main view's paint dropped, its regions
     * would go unpainted unless they are carried over to the view that does
     * paint.
     *
     * @private
     */
    var deferredMain = false;
    var deferredMainRects = null;

    /**
     * Buffers available for reuse when reading planes back out of a frame,
     * keyed by byte length. A 1080p I420 frame is about 3MB, so allocating one
     * per frame would churn heavily at frame rate.
     *
     * @private
     * @type {!Object.<number, ArrayBuffer[]>}
     */
    var bufferPool = {};

    /**
     * Maximum buffers to retain per size.
     *
     * @private
     * @constant
     * @type {!number}
     */
    var MAX_BUFFER_POOL = 4;

    /**
     * Returns a buffer of at least the given size, reusing a pooled one where
     * possible.
     *
     * @private
     * @param {!number} size - Required size, in bytes.
     * @returns {!Uint8Array}
     */
    function acquireBuffer(size) {
        var pool = bufferPool[size];
        if (pool && pool.length)
            return pool.pop();
        return new Uint8Array(size);
    }

    /**
     * Returns a buffer to the pool.
     *
     * @private
     * @param {Uint8Array} buffer - The buffer to release.
     */
    function releaseBuffer(buffer) {
        if (!buffer)
            return;
        var pool = bufferPool[buffer.length];
        if (!pool)
            pool = bufferPool[buffer.length] = [];
        if (pool.length < MAX_BUFFER_POOL)
            pool.push(buffer);
    }

    /**
     * Returns the 4:4:4 renderer, creating it on first use. Returns null if the
     * browser cannot provide one, having recorded that so the attempt is not
     * repeated.
     *
     * @private
     * @returns {Guacamole.Yuv444Renderer}
     */
    function ensureYuv444() {

        if (yuv444 || yuv444Unavailable)
            return yuv444;

        if (typeof Guacamole.Yuv444Renderer === 'undefined'
                || !Guacamole.Yuv444Renderer.isSupported()) {
            diagnostic('chroma_unavailable', '4:4:4 combining unavailable '
                    + '(needs WebGL2 and VideoFrame.copyTo); AVC444 will '
                    + 'render at 4:2:0', true);
            yuv444Unavailable = true;
            return null;
        }

        yuv444 = new Guacamole.Yuv444Renderer();
        colorSpaceApplied = false;

        if (!yuv444.supported) {
            yuv444 = null;
            yuv444Unavailable = true;
            return null;
        }

        console.log('[rustguac] H.264: combining AVC444 views to 4:4:4');
        return yuv444;

    }

    /**
     * Overrides already read from the query string or localStorage, by name.
     * Neither source can change without a reload, so each is read once.
     *
     * @private
     * @type {!Object.<string, *>}
     */
    var storedOverrides = {};

    /**
     * Reads a runtime override, from a window global, a query parameter, or
     * localStorage, in that order. The last two exist because the devices
     * where these paths behave differently -- phones and tablets -- are the
     * ones with no console to set a global from.
     *
     * @private
     * @param {!string} name - The override's name.
     * @returns {*} The override's value, or undefined if unset.
     */
    function override(name) {

        if (typeof window === 'undefined')
            return undefined;

        if (window['__' + name] !== undefined)
            return window['__' + name];

        /* The window global above is a property read and is checked every
         * time, so setting one still takes effect mid-session -- which is the
         * point of these, since one build is meant to compare 4:2:0, combined
         * and combined-plus-filtered without a reload.
         *
         * The query string and localStorage cannot change without a reload,
         * and reading them is not free: URLSearchParams parses the whole query
         * on construction and localStorage is a synchronous, disk-backed read.
         * On the combine path this ran twice per picture -- 60 times a second
         * on the main thread -- for a value that was fixed before the first
         * frame arrived. */
        if (name in storedOverrides)
            return storedOverrides[name];

        var value = null;

        try {
            value = new URLSearchParams(window.location.search).get(name);
            if (value === null && window.localStorage)
                value = window.localStorage.getItem(name);
        } catch (e) {
            /* Storage can be blocked outright; the global still works. */
        }

        if (value === null || value === undefined)
            return (storedOverrides[name] = undefined);

        /* '0' is deliberately not in that list: it is a valid threshold for
         * h264ChromaFilter, and an override that takes a number has to be
         * able to take zero. It still switches a boolean override off, since
         * callers coerce, and 0 is falsy. */
        if (value === 'off' || value === 'false')
            return (storedOverrides[name] = false);
        if (value === 'on' || value === 'true')
            return (storedOverrides[name] = true);

        var number = parseFloat(value);
        return (storedOverrides[name] = isNaN(number) ? true : number);

    }

    /**
     * Whether 4:4:4 combining is switched on. Overridable at runtime as
     * window.__h264Chroma444 = false, as ?h264Chroma444=off on the client's
     * URL, or as the h264Chroma444 key in localStorage, to compare against the
     * 4:2:0 path.
     *
     * @private
     * @returns {!boolean}
     */
    function chroma444Enabled() {

        /* An explicit override always wins: it is how a session is compared
         * against the other setting, and a policy that could not be overridden
         * would make that comparison impossible. */
        var value = override('h264Chroma444');
        if (value !== undefined)
            return !!value;

        /* Given up for now by suspendCombining(). */
        if (combineLatchedOff)
            return false;

        /* Decided from the framebuffer's area, because that is what the cost
         * is a function of. The combine is a plane read-back, six texture
         * uploads and a shader pass per picture, all proportional to pixels
         * and all contending with the hardware video decoder on the same GPU,
         * so at high resolution it costs frame rate rather than buying
         * chroma -- and by then a 4:2:0 chroma block already covers close to
         * one logical pixel, so there is little left to recover.
         *
         * Not the desktop scale, which was the first thing tried: that only
         * says whether HiDPI scaling was applied, so a 4K display at a device
         * pixel ratio of 1 slips past it and combines at 8.3 megapixels, the
         * most expensive case there is. It is also not a property of the host
         * -- the same picture costs the same to combine whatever sent it,
         * which is why this was mistaken for an xrdp problem before a Windows
         * session was run at native resolution. */
        var pixels = display ? display.getWidth() * display.getHeight() : 0;

        /* Nothing sized yet: combine, and let the next picture decide once
         * the display has been sized. */
        if (!pixels)
            return true;

        var limit = combineMaxPixels();
        var combine = pixels <= limit;

        /* Once, and only where the answer is no -- ensureYuv444() already
         * announces the yes. A session painting 4:2:0 from an AVC444 stream
         * looks like a fault otherwise, and this is the line that says it was
         * a decision. */
        if (!combine && !chromaDeclineLogged) {
            chromaDeclineLogged = true;
            console.log('[rustguac] H.264: not combining AVC444 -- '
                    + display.getWidth() + 'x' + display.getHeight() + ' is '
                    + (pixels / 1e6).toFixed(1) + 'MP, over the '
                    + (limit / 1e6).toFixed(1) + 'MP the combine is worth its '
                    + 'GPU cost at; ?h264Chroma444=on overrides');
        }

        return combine;

    }

    /**
     * Whether the decision not to combine has been reported. The gate is
     * consulted on every auxiliary view until combining starts, so the line
     * would otherwise repeat for the life of the session.
     *
     * @private
     * @type {!boolean}
     */
    var chromaDeclineLogged = false;

    /**
     * The framebuffer area, in pixels, up to which AVC444 views are combined.
     *
     * From tests/bench on an Intel UHD 770, where the combine costs about
     * 1.37ms per megapixel (2.46ms at 1080p, 12.93ms at 4K, banded upload,
     * whole-screen damage). Four megapixels is therefore roughly a third of a
     * 60fps frame budget: 1080p spends 17% of a frame on it and 1440p 30%,
     * while 4K would spend 68% and a 5.5MP native-resolution session 45% --
     * which was measured in the field as a frame backlog and sync timeouts.
     *
     * Overridable as window.__h264CombineMaxPixels, ?h264CombineMaxPixels= on
     * the client's URL, or the h264CombineMaxPixels key in localStorage, since
     * the figure comes from one GPU and a faster or slower one moves the line.
     *
     * @private
     * @returns {!number}
     */
    function combineMaxPixels() {
        var value = override('h264CombineMaxPixels');
        return (typeof value === 'number' && value > 0)
            ? value : COMBINE_MAX_PIXELS;
    }

    /**
     * Whether the renderer is to be given full range (true), limited (false),
     * or left to follow the frame. Set as window.__h264FullRange, as
     * ?h264FullRange=off on the client's URL, or as the h264FullRange key in
     * localStorage.
     *
     * Exists because a stream's own signalling does not always survive the
     * browser: Chrome discards video_full_range_flag when the SPS names an
     * explicitly unspecified colour_primaries or transfer, reporting limited
     * for a host that said full and painting it with crushed blacks. See
     * Yuv444Renderer.setColorSpace(), and `H.264 colour:` in rustguac's
     * journal for which case a given host is in.
     *
     * @private
     * @returns {boolean}
     */
    function fullRangeOverride() {
        return override('h264FullRange');
    }

    /**
     * Whether the encoder's chroma filter is undone as part of combining, and
     * with what threshold. The auxiliary view carries three of every four
     * chroma samples; the fourth is left as the mean of its 2x2 block by the
     * encoder and has to be solved for.
     *
     * Kept separate from chroma444Enabled() because it is the newer and less
     * certain half: it multiplies the main view's chroma by four, so if a host
     * turns out not to average that sample the error is amplified rather than
     * corrected. Overridable at runtime as window.__h264ChromaFilter = false,
     * which leaves plain 4:4:4 combining in place, so one build can compare
     * 4:2:0, combined, and combined-plus-filtered without a reload. Setting it
     * to a number overrides the threshold instead of switching the filter off;
     * that constant is inherited from FreeRDP rather than specified anywhere,
     * and is the part of this least backed by evidence. Also settable as
     * ?h264ChromaFilter= on the URL or from localStorage -- see override().
     *
     * @private
     * @returns {!(number|boolean)}
     */

    /**
     * Reports one whole picture's combine cost to the diagnostic.
     *
     * Once per picture rather than once per view: a main view accumulates and
     * the auxiliary view that refines it closes the picture out, or the next
     * main view does when none followed. Splitting a picture across two
     * samples would halve every figure it reports.
     *
     * @private
     * @param {!number} ms - Wall time the picture's combine work took.
     */
    function flushCombineCost(hadAux) {

        var ms = combineWorkMs;
        var resynced = combineResynced;

        combineWorkMs = 0;
        combineResynced = false;

        if (ms <= 0)
            return;

        /* A picture that had to resync uploaded whole planes, so it says
         * nothing about the steady state. */
        if (!resynced)
            recordStat('combine', hadAux, ms);

    }


    function chromaFilter() {
        var value = override('h264ChromaFilter');
        if (value === undefined || value === true)
            return 30;
        if (typeof value === 'number')
            return value;
        return false;
    }

    /**
     * Reads the three planes out of a decoded frame and hands them to the
     * renderer, then renders and snapshots the result.
     *
     * A main view whose auxiliary view is still to come is uploaded but not
     * rendered: the auxiliary view is about to re-render the same picture with
     * real chroma, so rendering here would draw the 4:2:0 version of a picture
     * that is overwritten microseconds later -- a shader pass and a blit per
     * picture, thrown away. The server says which pictures those are
     * (MS-RDPEGFX LC=0), since only it knows before the second access unit
     * arrives. Its regions are carried over to the view that does paint.
     *
     * The frame is held across copyTo(), which is asynchronous and has no
     * synchronous equivalent -- there is no other way to reach the raw planes,
     * and the auxiliary view's planes are not an image, so drawing it through a
     * canvas would give colour-converted nonsense. The close is therefore in a
     * finally on the chained promise, and the draw task's watchdog still covers
     * a copy that never settles at all.
     *
     * @private
     * @param {!VideoFrame} frame - The decoded frame. Closed by this function.
     * @param {!object} frameState - The frame's pending state.
     */
    function combineFrame(frame, frameState) {

        var renderer = yuv444;
        var view = frameState.view;
        var rect = frame.codedRect || null;

        /* Copied in whatever format the decoder produced, with no format
         * option at all. Asking for I420 looks like the tidier choice -- one
         * layout for the renderer to handle -- but copyTo() only converts
         * between a narrow set of formats, and NV12 to I420 is not among
         * them. A hardware decoder on Windows hands back NV12, so requesting
         * I420 there throws before a single frame is copied.
         *
         * The two formats differ only in whether the chroma samples are in
         * one interleaved plane or two, which the renderer can address either
         * way, so taking what the decoder gives costs nothing. */
        var format = frame.format || '';
        var interleaved = (format.indexOf('NV12') === 0);
        var planar = (format.indexOf('I420') === 0);

        /* The coded frame rather than the visible one: the v1 chroma layout
         * pads the auxiliary view to a multiple of 16 rows and addresses that
         * padding, so cropping to the visible rect would drop rows the combine
         * reads. */
        var options = rect
            ? { rect: { x: 0, y: 0, width: rect.width, height: rect.height } }
            : {};

        var planeW = rect ? rect.width : frame.codedWidth;
        var planeH = rect ? rect.height : frame.codedHeight;
        var pictureW = frame.displayWidth;
        var pictureH = frame.displayHeight;

        var buffer = null;
        var size = 0;

        try {

            if (!interleaved && !planar)
                throw new Error('decoded frame is ' + (format || 'an unknown'
                        + ' format') + ', which carries no YUV planes');

            size = frame.allocationSize(options);
            buffer = acquireBuffer(size);

        } catch (e) {

            console.error('[rustguac] H.264: cannot size frame planes:',
                    e.message);

            /* Whatever stopped the copy will stop the next one too, and this
             * frame is already lost. Falling back here rather than only in
             * the copy's catch matters: without it every later frame takes
             * this same path, is neither combined nor drawn, and the display
             * stays black for the rest of the session. */
            combining = false;
            yuv444Unavailable = true;

            try { frame.close(); } catch (ignore) { /* already closed */ }
            if (frameState.onReady) frameState.onReady();
            return;

        }

        /* Issued here rather than inside the chain, so that the two views of
         * a picture are in flight at once; only what follows is ordered. */
        var copy;
        try {
            copy = frame.copyTo(buffer, options);
        } catch (e) {
            copy = Promise.reject(e);
        }

        /* The chain below is this copy's real error handler, but it may not
         * attach for some time, and a rejection with nothing attached yet is
         * reported as unhandled. */
        copy.catch(function() { /* handled by the chain */ });

        var copyIssuedAt = nowMs();

        copyChain = copyChain.then(function() {
            return copy;
        }).then(function(layout) {

            /* Times the work, not the wait. The awaits above queue behind
             * whatever else is in flight, so including them would measure the
             * backlog and feed the suspension decision with its own output. */
            var startedAt = nowMs();

            if (override('h264CombineLog')) {
                if (!copyWait)
                    copyWait = { n: 0, sum: 0, max: 0 };
                var waited = startedAt - copyIssuedAt;
                copyWait.n++;
                copyWait.sum += waited;
                if (waited > copyWait.max)
                    copyWait.max = waited;
            }

            /* A main view opens a picture, so anything still accumulated
             * belongs to the previous one -- which evidently carried no
             * auxiliary view, or that view would have closed it. Done before
             * this picture's uploads so the resync flag they may set is not
             * charged to the picture before it. */
            if (view === 0)
                flushCombineCost(false);

            /* NV12 has two planes rather than three; a null V plane is how
             * the renderer is told the chroma is interleaved into U. */
            var y = new Uint8Array(buffer.buffer,
                    buffer.byteOffset + layout[0].offset);
            var u = new Uint8Array(buffer.buffer,
                    buffer.byteOffset + layout[1].offset);
            var v = interleaved ? null : new Uint8Array(buffer.buffer,
                    buffer.byteOffset + layout[2].offset);

            var strides = interleaved
                ? [layout[0].stride, layout[1].stride]
                : [layout[0].stride, layout[1].stride, layout[2].stride];

            if (view === 0) {

                /* Adopt whatever the decoder says this stream is, once. The
                 * 4:2:0 path never reaches the shader -- the browser draws
                 * that VideoFrame and applies its colour space itself -- so
                 * converting here on an assumption is how the two paths come
                 * out different colours on the same session. */
                if (!colorSpaceApplied && renderer.setColorSpace) {

                    /* Reported rather than logged to the console, so it lands
                     * in the journal beside the `H.264 colour:` line rustguac
                     * reads out of the SPS (src/h264_sps.rs). The two together
                     * are the whole question: the first says what the host
                     * declared, this says what the browser made of it, and a
                     * disagreement between them is invisible in either alone.
                     * A colour fault reported hours later has both. */
                    diagnostic('colour_space',
                            renderer.setColorSpace(frame.colorSpace,
                                fullRangeOverride())
                            + '; decoder gave ' + (frame.format || 'unknown')
                            + ' frames', true);

                    colorSpaceApplied = true;
                }

                /* This view's own regions, not the union built below: a
                 * region the other view did not update has no new samples in
                 * this plane either, and uploading over it would replace
                 * valid rows with the same rows. */
                if (resyncNeeded)
                    combineResynced = true;

                renderer.uploadLuma(y, u, v, strides, pictureW, pictureH,
                        resyncNeeded ? null : frameState.rects);

            }
            else {

                if (resyncNeeded)
                    combineResynced = true;

                renderer.uploadAux(y, u, v, strides, planeW, planeH, view,
                        resyncNeeded ? null : frameState.rects);

            }

            /* An auxiliary view paints the picture its main view did not, so
             * it paints both views' regions. A null list on either side means
             * that view called the whole picture valid, which the union of the
             * two must then be as well. */
            if (view !== 0 && deferredMain) {

                frameState.rects =
                    (!deferredMainRects || !frameState.rects) ? null
                        : deferredMainRects.concat(frameState.rects);

                deferredMain = false;
                deferredMainRects = null;

            }

            /* Nothing more to do for a main view that an auxiliary view is
             * about to refine: its planes are uploaded, and the auxiliary
             * view's render reads them. Its draw task is released below with
             * no snapshot, which draws nothing -- the picture is painted once,
             * by the task immediately behind this one.
             *
             * The cost of being wrong is one skipped picture: if that
             * auxiliary view then fails to combine, this update is not painted
             * at all rather than painted at 4:2:0, and the screen catches up
             * on the next update. Every path that can fail there also
             * abandons combining, so it is one picture, not a permanent
             * regression -- and the server only sets the flag when it has
             * already queued both views. */
            if (view === 0 && frameState.paired) {
                deferredMain = true;
                deferredMainRects = frameState.paint ? frameState.rects : [];
                finishForTiming();
                combineWorkMs += nowMs() - startedAt;
                return;
            }

            /* Whole planes have now been uploaded for whichever views this
             * picture carries, so the textures match the screen again and the
             * next picture may go back to uploading only its damaged rows. */
            resyncNeeded = false;

            /* A main view that paints its own picture leaves nothing for a
             * later auxiliary view to inherit. Cleared here rather than only
             * on consumption, so that a picture whose auxiliary view never
             * arrived cannot hand its regions to an unrelated one. */
            if (view === 0) {
                deferredMain = false;
                deferredMainRects = null;
            }

            /* The control for the handoff measurement. An unpaired main view
             * is an ordinary 4:2:0 picture that happens to be travelling the
             * combine path, so it can be snapshotted exactly as the 4:2:0
             * path snapshots it -- same decode, same content, same session,
             * same host, differing only in which kind of surface reaches the
             * display. If `paint` is slow for a bitmap and fast for a canvas
             * on the very same stream, the cost is the context boundary and
             * not the combine.
             *
             * The planes have already been uploaded, so an auxiliary view
             * behind this one still combines against them correctly; only
             * this picture's own paint changes. Main views only: an auxiliary
             * view carries packed chroma, which is not a picture and cannot
             * be blitted.
             *
             * Off by default. Settable as ?h264PaintViaSnapshot= on the URL
             * or from localStorage -- see override(). */
            if (view === 0 && override('h264PaintViaSnapshot')) {

                if (frameState.paint && !frameState.settled) {
                    var plain = acquireCanvas(pictureW, pictureH);
                    plain.getContext('2d').drawImage(frame, 0, 0);
                    frameState.canvas = plain;
                    frameState.viaRenderer = false;
                }

                finishForTiming();
                combineWorkMs += nowMs() - startedAt;
                return;

            }

            /* A main view with no auxiliary view behind it renders on its own
             * as an ordinary 4:2:0 picture, exactly as a luma-only (LC=1)
             * update does for FreeRDP. */
            var rendered = renderer.render(view === 0 ? 0 : view,
                    chromaFilter(), frameState.rects);

            /* Nothing to snapshot means the renderer has given up -- a lost
             * context, most likely. Returning alone would leave every frame
             * from here on blank, so drop the whole path. */
            if (!rendered) {
                combining = false;
                yuv444Unavailable = true;
                return;
            }

            /* The watchdog may have released this frame's task while the
             * copy was in flight, in which case drawDecoded() has already run
             * and nothing will ever paint this picture -- keeping it would
             * leak the bitmap's GPU memory. */
            if (frameState.settled) {
                releaseSnapshot(rendered);
                return;
            }

            /* The renderer hands over its drawing buffer whole, so there is no
             * copy to make here and no size to choose. That matters for the v1
             * chroma layout, which pads the auxiliary view to a multiple of 16
             * rows: the bitmap is the size the renderer drew at, which is the
             * main view's, not this frame's taller one. Copying at the frame's
             * size instead left a blank strip below the picture, blitted over
             * the bottom of the display whenever the server sent no rects. */
            frameState.canvas = rendered;
            frameState.viaRenderer = true;

            finishForTiming();
            combineWorkMs += nowMs() - startedAt;

            /* An auxiliary view completes the picture it refines, so the gate
             * is charged here for both views at once -- suspending drops both.
             * A main view cannot know whether one follows, so it only
             * accumulates; the next main view closes it out if none did. */
            if (view !== 0)
                flushCombineCost(true);

        }).catch(function(e) {

            console.error('[rustguac] H.264: 4:4:4 combine failed:',
                    e && e.message ? e.message : e);

            /* One failure is usually terminal for this path -- an unsupported
             * pixel format does not become supported later -- so fall back
             * rather than failing once per frame for the rest of the session. */
            combining = false;
            yuv444Unavailable = true;
            combineWorkMs = 0;
            combineResynced = false;

        }).then(function() {

            try {
                frame.close();
            } catch (ignore) {
                /* Already closed */
            }

            releaseBuffer(buffer);

            /* The copy has settled, one way or the other; there is nothing
             * left for the watchdog to cover. */
            clearWatchdog(frameState);

            if (frameState.onReady)
                frameState.onReady();

        });

    }

    /**
     * Releases any frame snapshot still held awaiting its draw task. Snapshots
     * live here between decode and draw, so discarding the map without
     * reclaiming them throws away the pool's canvases and leaks the GPU memory
     * behind any combined frame's ImageBitmap.
     *
     * @private
     */
    function releaseHeldFrames() {

        /* Nothing will paint the deferred main view's regions now, and holding
         * them would apply one picture's regions to another. */
        deferredMain = false;
        deferredMainRects = null;
        combineWorkMs = 0;
        combineResynced = false;

        /* Whatever is uploaded no longer corresponds to what is on screen, so
         * the next combine uploads whole planes. */
        resyncNeeded = true;

        for (var key in pendingFrames) {
            var frameState = pendingFrames[key];
            if (frameState && frameState.canvas) {
                releaseSnapshot(frameState.canvas);
                frameState.canvas = null;
            }
        }
        pendingFrames = {};
    }

    /**
     * The codec string to configure the decoder with, when no sequence
     * parameter set has been seen yet. High profile at level 5.2, which
     * covers every picture size this decoder is asked for, rather than the
     * level 4.1 that used to be hardcoded here.
     *
     * The level in a codec string is not advisory: Chrome sizes its hardware
     * decoder from it, and a stream whose frames exceed the declared level
     * silently falls back to software, because hardwareAcceleration is a
     * preference rather than a requirement. Level 4.1 permits 8192
     * macroblocks, so it holds for 1920x944 (7080) and fails for 2688x1488
     * (15624) -- which decoded in software at roughly twenty times the
     * latency, and under AVC444 for two pictures per frame.
     *
     * @private
     * @constant {string}
     */
    var DEFAULT_CODEC = 'avc1.640034';

    /**
     * Reads the codec string out of a sequence parameter set, if the given
     * access unit carries one.
     *
     * The three bytes following an SPS NAL header are profile_idc,
     * constraint_flags and level_idc, which are exactly the three bytes of an
     * avc1 codec string. Taking them from the stream keeps the decoder's
     * configuration in step with whatever the server chose, and the server
     * does vary it: the level follows the picture size, so one session's
     * stream may be 4.2 and the next 5.1.
     *
     * @private
     * @param {!ArrayBuffer} nalData
     *     A complete access unit in Annex B format.
     *
     * @returns {?string}
     *     The codec string, or null if this access unit carries no SPS.
     */
    function codecFromSps(nalData) {

        var bytes = new Uint8Array(nalData);
        var i;

        /* Annex B start codes are three or four bytes; scanning for the
         * three-byte form finds both, since the four-byte form ends with it. */
        for (i = 0; i + 4 < bytes.length; i++) {

            if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1)
                continue;

            /* nal_unit_type is the low five bits of the header byte. 7 is a
             * sequence parameter set. */
            if ((bytes[i + 3] & 0x1F) !== 7)
                continue;

            if (i + 6 >= bytes.length)
                return null;

            return 'avc1.'
                + ('0' + bytes[i + 4].toString(16)).slice(-2)
                + ('0' + bytes[i + 5].toString(16)).slice(-2)
                + ('0' + bytes[i + 6].toString(16)).slice(-2);

        }

        return null;

    }

    /**
     * Initialise the VideoDecoder if not already done.
     *
     * @private
     * @param {number} width - Expected frame width.
     * @param {number} height - Expected frame height.
     * @param {ArrayBuffer} [nalData]
     *     The access unit about to be decoded, read for its sequence
     *     parameter set if it carries one.
     */
    function ensureDecoder(width, height, nalData) {

        /* A decoder that has hit a terminal error is left closed. Treating it
         * as usable because `configured` is still set means every later frame
         * is dropped and nothing is drawn again -- and since guacd suppresses
         * ordinary image operations for a layer carrying an H.264 stream, that
         * is a permanently black screen rather than a degraded one. */
        if (decoder && configured && decoder.state !== 'closed')
            return;

        if (typeof VideoDecoder === 'undefined') {
            console.warn('[rustguac] WebCodecs VideoDecoder not available');
            return;
        }

        /* Release any decoder being replaced. reset() clears the configured
         * flag, so a later decode() can reach this point with a live decoder
         * still assigned; overwriting it without closing leaks its GPU
         * resources and leaves a second decoder able to deliver frames here. */
        if (decoder && decoder.state !== 'closed') {
            try {
                decoder.close();
            } catch (e) {
                /* Already in an error state */
            }
        }

        decoder = new VideoDecoder({

            output: function(frame) {

                var frameState = null;
                var canvas = null;

                /* Everything touching the frame runs inside this try, so that
                 * the close in the finally covers every path out -- including
                 * one thrown from acquiring the snapshot canvas. A frame that
                 * escapes without being closed holds one of the hardware
                 * decoder's output surfaces until the collector runs, and
                 * enough of them stall decoding outright. */
                try {

                    frameState = pendingFrames[frame.timestamp];

                    /* The draw task already gave up on this frame, or it
                     * belongs to a decoder that has since been replaced. */
                    if (!frameState)
                        return;

                    /* Submitted to arrived. Stamped before anything else here
                     * so no work of ours is counted as the decoder's. */
                    frameState.decodedAt = nowMs();
                    counts.decoded++;
                    noteFramebufferSize();
                    if (frameState.submittedAt)
                        recordStat('decode', frameState.view !== 0,
                                frameState.decodedAt - frameState.submittedAt);

                    /* The decision to combine is made from the framebuffer's
                     * area at the time, and the framebuffer is resized after
                     * connecting: a fit that passed through 2240x1648 (3.7MP)
                     * switched combining on, and it stayed on at 2992x2000
                     * (6MP), where it costs ~8ms of GPU per picture. So
                     * re-check it while combining -- a multiply and a cached
                     * lookup -- but only on a main view, where a picture
                     * begins. A paired main view has already been uploaded
                     * and deliberately not painted, leaving its auxiliary
                     * view to paint the picture; stopping between the two
                     * throws that picture away. When it is the connect-time
                     * keyframe, nothing else repaints the screen and the
                     * session looks hung until a resize brings another one.
                     *
                     * Stopping here leaves this main view to the 4:2:0 path
                     * below, which paints it, and its auxiliary view to the
                     * block after, which declines it. Resuming, should the
                     * framebuffer shrink again, uploads whole planes, since
                     * what was uploaded no longer matches the screen. */
                    if (combining && frameState.view === 0
                            && !chroma444Enabled()) {
                        combining = false;
                        resyncNeeded = true;

                        /* Suspended by the sync gate, which has reported it
                         * already; this is only where it takes effect.
                         *
                         * Otherwise say which of the other two reasons it
                         * was. The override is read per picture, so it can
                         * stop combining at any point in a session, and
                         * blaming the framebuffer for it sends whoever reads
                         * the line looking at the wrong thing. */
                        if (!combineLatchedOff) {

                            var declineOverride = override('h264Chroma444');

                            diagnostic('chroma_declined', declineOverride
                                    !== undefined
                                ? 'stopped 4:4:4 combining: the h264Chroma444 '
                                    + 'override is off'
                                : 'stopped 4:4:4 combining: the framebuffer '
                                    + 'grew to ' + display.getWidth() + 'x'
                                    + display.getHeight() + ', over the '
                                    + (combineMaxPixels() / 1e6).toFixed(1)
                                    + 'MP it is worth its cost at',
                                true);

                        }
                    }

                    /* An auxiliary view means this is an AVC444 stream, so
                     * its chroma can be recovered. Switch over for the frames
                     * that follow; this one cannot be combined, because the
                     * main view it refines went through the 4:2:0 path and its
                     * planes were never uploaded. */
                    if (frameState.view !== 0 && !combining) {

                        /* Not before the size has settled; see
                         * COMBINE_SETTLE_MS. The next auxiliary view after it
                         * has asks again. */
                        if (chroma444Enabled() && framebufferSettled()
                                && ensureYuv444())
                            combining = true;

                        /* Not an image on its own: drawing packed chroma would
                         * paint garbage over the screen. Leave canvas null so
                         * nothing is drawn, but release the task below. */
                        return;

                    }

                    /* Both views go through the combiner: the main one renders
                     * as an ordinary 4:2:0 picture and uploads the planes the
                     * auxiliary one then refines. It closes the frame and
                     * releases the task itself, since it must do both after an
                     * asynchronous plane copy. */
                    if (combining) {
                        var handed = frame;
                        combineFrame(handed, frameState);
                        /* Ownership passes only once the call has returned; a
                         * synchronous throw leaves the frame ours to close,
                         * which the finally below then does. */
                        frame = null;
                        return;
                    }

                    /* Snapshot to a canvas and release the VideoFrame before
                     * returning, rather than holding it until the draw task
                     * runs. Holding frames until their scheduled draw exhausts
                     * the surface pool as soon as the display queue falls
                     * behind: the decoder stalls, which delays the draws,
                     * which holds more frames.
                     *
                     * The copy is synchronous, and deliberately so.
                     * Snapshotting via createImageBitmap() leaves the frame
                     * open across a promise, and any path where that promise
                     * neither resolves nor rejects orphans the frame with its
                     * surface still held. Closing in a finally, with no await
                     * in between, removes the window rather than narrowing
                     * it. */
                    /* Nothing will be painted, so there is nothing to copy.
                     * The finally below closes the frame and releases the
                     * task, which drawDecoded() then settles. */
                    if (!frameState.paint)
                        return;

                    canvas = acquireCanvas(frame.displayWidth,
                            frame.displayHeight);

                    canvas.getContext('2d').drawImage(frame, 0, 0);
                    frameState.canvas = canvas;
                    frameState.viaRenderer = false;

                } catch (e) {

                    console.error('[rustguac] H.264 snapshot failed:',
                            e.message);

                    releaseCanvas(canvas);
                    if (frameState)
                        frameState.canvas = null;

                } finally {

                    /* Null when combineFrame() took ownership: it closes the
                     * frame once its plane copy has settled, and releases the
                     * task itself. */
                    if (frame) {

                        /* Cleared here rather than on the way in, because the
                         * combine path holds the frame across an asynchronous
                         * copyTo() that nothing else times out: clearing the
                         * watchdog before handing the frame over would leave a
                         * copy that never settles holding the ordered display
                         * queue with nothing able to release it.
                         * combineFrame() clears it once the copy settles. */
                        clearWatchdog(frameState);

                        frame.close();

                    }

                    /* Released here rather than after the try, because the
                     * early returns above exit the function once this finally
                     * has run -- they do not fall through to code following
                     * the block. Releasing there left every AVC444 auxiliary
                     * view's draw task blocked forever, its watchdog having
                     * been cleared above, and the display queue is ordered, so
                     * the first auxiliary frame stopped the display for good.
                     *
                     * Ordered after the close deliberately: this runs the
                     * display queue synchronously and may draw several frames,
                     * by which point the frame's surface is back in the
                     * decoder's pool. */
                    if (frame && frameState && frameState.onReady)
                        frameState.onReady();

                }

            },

            error: function(e) {

                console.error('[rustguac] H.264 decode error:', e.message);

                diagnostic('decoder_rebuild', 'decode error: ' + e.message
                        + '. Every queued frame is discarded and nothing is '
                        + 'painted until the next keyframe.', true);

                /* Terminal: the decoder is now closed and will never accept
                 * another chunk. Force ensureDecoder() to build a replacement,
                 * and hold frames until the next keyframe, the earliest point
                 * a fresh decoder can produce a picture at all. */
                configured = false;
                needsKeyFrame = true;

                /* A VideoDecoder error is terminal for everything queued on
                 * it: those frames will never reach the output callback. Each
                 * holds a blocked task on the display queue, and the display
                 * renders frames in order, so leaving them blocked freezes the
                 * display on whatever was last painted. */
                for (var key in pendingFrames) {
                    var frameState = pendingFrames[key];
                    if (frameState && frameState.onReady)
                        frameState.onReady();
                }

            }

        });

        var codec = (nalData && codecFromSps(nalData)) || DEFAULT_CODEC;

        if (codec !== lastCodec) {
            console.info('[rustguac] H.264: decoding as ' + codec);
            lastCodec = codec;
        }

        decoder.configure({
            codec: codec,
            hardwareAcceleration: 'prefer-hardware',
            optimizeForLatency: true
        });

        configured = true;

    }

    /**
     * Submits a complete H.264 access unit for decoding. The frame is not
     * drawn here; the caller schedules the draw and is notified via onReady
     * once the frame is available, or once it is known that it cannot be.
     *
     * @param {!Guacamole.Display.VisibleLayer} layer
     *     The layer to draw the decoded frame to.
     *
     * @param {number} x - X position on the layer.
     * @param {number} y - Y position on the layer.
     * @param {number} width - Frame width.
     * @param {number} height - Frame height.
     *
     * @param {!ArrayBuffer} nalData
     *     Raw H.264 NAL unit data, in Annex B format.
     *
     * @param {boolean} isKeyFrame
     *     Whether this access unit contains an IDR slice.
     *
     * @param {Array} [rects]
     *     The regions of the decoded picture that are valid, each
     *     {x, y, width, height} in surface coordinates. An H.264 picture is
     *     always full-surface sized, but a server encoding only part of the
     *     screen leaves the rest holding no meaningful content. Omit when the
     *     entire picture is valid.
     *
     * @param {function} [onReady]
     *     Called once the frame is ready to draw, or cannot be produced.
     *
     * @param {number} [view=0]
     *     Which view this access unit carries: 0 is a displayable picture,
     *     non-zero an AVC444 auxiliary chroma view, which is decoded for its
     *     references but never drawn.
     *
     * @param {boolean} [paired=false]
     *     Whether an auxiliary chroma view for this same picture follows
     *     immediately. Only a main view can be paired, and only the server
     *     knows: the auxiliary view is a separate access unit that has not
     *     arrived yet. When it is combined, a paired main view is uploaded but
     *     never painted, since the auxiliary view repaints the same picture.
     *
     * @returns {?number}
     *     A token identifying this frame, to be passed to drawDecoded(), or
     *     null if it could not be submitted.
     */
    this.decode = function(layer, x, y, width, height, nalData, isKeyFrame,
            rects, onReady, view, paired) {

        ensureDecoder(width, height, nalData);

        /* No decoder at all: the caller's task must still be released, or the
         * display queue stalls behind a frame that will never arrive. */
        if (!decoder || decoder.state === 'closed') {
            if (onReady) onReady();
            return null;
        }

        /* Recovering from a terminal error. A rebuilt decoder holds no
         * reference frames, so a delta would error it again at once and
         * recovery would never converge; wait for the next IDR instead. */
        if (needsKeyFrame) {
            if (!isKeyFrame) {

                /* Held, not painted. Nothing on screen changes until the
                 * server happens to send a keyframe, and an idle desktop
                 * gives it no reason to. */
                if (!keyframeWaitSince)
                    keyframeWaitSince = nowMs();
                keyframeWaitDropped++;

                if (nowMs() - keyframeWaitSince > 2000)
                    diagnostic('keyframe_wait', 'holding every frame for want '
                            + 'of a keyframe: ' + keyframeWaitDropped
                            + ' dropped over '
                            + ((nowMs() - keyframeWaitSince) / 1000).toFixed(1)
                            + 's. The picture is frozen until the server sends '
                            + 'one, which an idle desktop may not do.');

                if (onReady) onReady();
                return null;
            }
            needsKeyFrame = false;
            console.warn('[rustguac] H.264: decoder rebuilt, resuming at'
                    + ' keyframe');

            if (keyframeWaitSince) {
                diagnostic('keyframe_resumed', 'keyframe arrived after '
                        + ((nowMs() - keyframeWaitSince) / 1000).toFixed(1)
                        + 's and ' + keyframeWaitDropped + ' dropped frame(s)',
                        true);
                keyframeWaitSince = 0;
                keyframeWaitDropped = 0;
            }
        }

        try {

            var chunk = new EncodedVideoChunk({
                type: isKeyFrame ? 'key' : 'delta',
                timestamp: timestamp,
                data: nalData
            });

            var token = timestamp;
            timestamp += 33333; // ~30fps in microseconds

            var frameState = pendingFrames[token] = {
                layer: layer,
                x: x,
                y: y,
                rects: (rects && rects.length) ? rects : null,

                /* An empty list, unlike an absent one, says no region of the
                 * picture changed: decode it for its references, paint none
                 * of it. See drawDecoded(). */
                paint: !(rects && rects.length === 0),
                view: view || 0,
                paired: !!paired,
                onReady: onReady,
                canvas: null,
                settled: false,
                watchdog: null
            };

            frameState.submittedAt = nowMs();
            frameState.keyFrame = !!isKeyFrame;
            pendingDecodes++;

            counts.submitted++;
            if (isKeyFrame) {
                counts.keyframes++;
                counts.lastKeyframeAt = frameState.submittedAt;
            }

            frameState.watchdog = setTimeout(function() {
                frameState.watchdog = null;
                if (!frameState.canvas) {
                    watchdogFires++;
                    reportAbandoned();
                    if (frameState.onReady) frameState.onReady();
                }
            }, DECODE_WATCHDOG_MS);

            decoder.decode(chunk);
            return token;

        } catch (e) {

            console.error('[rustguac] H.264 chunk error:', e.message);

            /* The frame may already have been registered and counted before
             * the throw. Returning null means drawDecoded() will never be
             * called for it, so nothing else will ever settle it, and an
             * unsettled decode holds pendingDecodes above zero permanently:
             * resolveIfIdle() then never fires again and every subsequent sync
             * waits out its full timeout. Undo the registration here.
             *
             * frameState is undefined if the throw came from constructing the
             * chunk, before anything was registered. */
            if (frameState) {
                clearWatchdog(frameState);
                delete pendingFrames[token];

                /* A snapshot already taken for this frame would otherwise be
                 * stranded outside the pool, since no draw task will run. */
                if (frameState.canvas) {
                    releaseSnapshot(frameState.canvas);
                    frameState.canvas = null;
                }

                settle(frameState);
            }

            if (onReady) onReady();
            return null;

        }

    };

    /**
     * Draws the frame decoded for the given token, then releases it. Called
     * from the display's task queue so that frames are painted in the order
     * the instruction stream specified, rather than whenever decode finished.
     *
     * Safe to call with a token that has no decoded frame: the decode may have
     * failed, or the watchdog may have released the task early, in which case
     * nothing is drawn.
     *
     * @param {number} token
     *     The token returned by decode().
     */
    this.drawDecoded = function(token) {

        if (token === null || token === undefined)
            return;

        var frameState = pendingFrames[token];
        if (!frameState)
            return;

        delete pendingFrames[token];

        clearWatchdog(frameState);

        /* A picture whose region list was sent empty changed nothing on
         * screen. Reported because it is rare and was, painted whole, the
         * cause of the black-display episodes: a keyframe of uninitialised
         * content that the server never meant to show. */
        if (!frameState.paint) {
            diagnostic('h264_undisplayed', (frameState.keyFrame ? 'keyframe'
                    : 'delta') + ' view=' + frameState.view + ' with no '
                    + 'region rects: decoded for its references, not painted');
            if (frameState.canvas) {
                releaseSnapshot(frameState.canvas);
                frameState.canvas = null;
            }
            settle(frameState);
            return;
        }

        var snapshot = frameState.canvas;
        if (!snapshot) {
            settle(frameState);
            return;
        }

        /* A black keyframe over a stable framebuffer: keep what is on screen.
         * See keepPictureOverBlackKeyframe(). */
        if (keepPictureOverBlackKeyframe(frameState, snapshot)) {
            frameState.canvas = null;
            releaseSnapshot(snapshot);
            settle(frameState);
            return;
        }

        /* Ready to painted: time in the display's ordered queue, not work. */
        if (frameState.decodedAt)
            recordStat('draw', frameState.view !== 0,
                    nowMs() - frameState.decodedAt);

        try {

            if (frameState.layer) {

                var ctx = frameState.layer.getCanvas().getContext('2d');

                /* Timed, because this is where a GPU-resident ImageBitmap
                 * from the renderer's own WebGL2 context crosses into the
                 * display's 2D one. The combine's own work is submitted, not
                 * executed, by the time it gets here, so a driver that cannot
                 * share the surface pays for both the execution and a
                 * readback right on this line -- inside the display's flush,
                 * where `sync_hold` sees it as a slow flush and
                 * `h264CombineLog` sees it not at all. */
                var paintedAt = nowMs();
                var paintedPx = 0;

                /* Draw only the regions the server marked valid. The decoded
                 * picture spans the whole surface, so blitting all of it would
                 * overwrite areas delivered via other codecs on a server that
                 * mixes them within a frame. */
                if (frameState.rects) {
                    for (var r = 0; r < frameState.rects.length; r++) {
                        var rect = frameState.rects[r];
                        ctx.drawImage(snapshot,
                                rect.x, rect.y, rect.width, rect.height,
                                rect.x, rect.y, rect.width, rect.height);
                        paintedPx += rect.width * rect.height;
                    }
                }

                /* No regions given: the entire picture is valid */
                else {
                    ctx.drawImage(snapshot, frameState.x, frameState.y);
                    paintedPx += (snapshot.width || 0)
                            * (snapshot.height || 0);
                }

                /* The same time against two denominators, because which one
                 * it is proportional to says what it is. render() scissors
                 * the conversion to the damage, but transferToImageBitmap()
                 * hands over the entire drawing buffer whatever the damage
                 * was -- so a cost that holds steady per damaged megapixel is
                 * the blit, and one that holds steady per buffer megapixel is
                 * the handoff, and only the second would explain a session
                 * that stays slow while typing. */
                var bufferPx = (snapshot.width || 0) * (snapshot.height || 0);
                var paintMs = nowMs() - paintedAt;

                var source = frameState.viaRenderer ? 'bitmap' : 'canvas';
                paintedSinceSync[source]++;
                recordStat('paint', source, paintMs, paintedPx);
                recordStat('paintbuf', source, paintMs, bufferPx);

                counts.painted++;
                counts.lastPaintAt = nowMs();
                if (frameState.keyFrame)
                    counts.lastKeyframePaintAt = counts.lastPaintAt;

                if (frameState.keyFrame)
                    probeKeyframe(frameState, snapshot,
                            frameState.layer.getCanvas());

                else if (probesLeft > 0 && counts.lastPaintAt - lastProbeAt
                        >= PROBE_DELTA_INTERVAL_MS) {
                    probesLeft--;
                    lastProbeAt = counts.lastPaintAt;
                    probePaint(frameState, snapshot,
                            frameState.layer.getCanvas());
                }

            }

        } finally {
            frameState.canvas = null;
            releaseSnapshot(snapshot);
            settle(frameState);
        }

    };

    /**
     * How long sync acknowledgements are held waiting for decodes, split by
     * whether the picture was being combined into 4:4:4 at the time.
     *
     * The hold is the throttle itself: guacd paces frames on the ack, so a
     * client that is slow but not drowning shows up here -- as acks held
     * longer -- and never as a growing backlog, which is all the combine latch
     * watches. These are the numbers a gate on sluggishness would need, and
     * they are collected before anything acts on them because a normal hold on
     * a large framebuffer is not zero and has not been measured.
     *
     * `total` runs for the session and goes into describeState(); `window`
     * is reported and reset once a minute as `sync_hold`.
     *
     * @private
     */
    function newHoldStats() {
        function flushBucket() {
            return { flushes: 0, flushSumMs: 0, flushMaxMs: 0, flushSlow: 0 };
        }
        function mode() {
            var m = flushBucket();
            m.syncs = 0;
            m.held = 0;
            m.sumMs = 0;
            m.maxMs = 0;
            m.timeouts = 0;
            /* The same flush, also charged to whichever kind of surface was
             * blitted into the display during it -- see paintedSinceSync. */
            m.flushBy = { bitmap: flushBucket(), canvas: flushBucket(),
                          idle: flushBucket() };
            return m;
        }
        return { '420': mode(), '444': mode() };
    }

    /**
     * Adds one flush sample to a bucket.
     *
     * @private
     */
    function addFlush(bucket, flushMs) {
        bucket.flushes++;
        bucket.flushSumMs += flushMs;
        bucket.flushMaxMs = Math.max(bucket.flushMaxMs, flushMs);
        if (flushMs >= FLUSH_SLOW_MS)
            bucket.flushSlow++;
    }

    /**
     * How many pictures of each handoff kind were blitted into the display
     * since the last sync was accounted for.
     *
     * The mode a sync is charged to says only whether combining was on, which
     * conflates two things the field numbers cannot separate: the combine's
     * cost, and the cost of handing a GPU-resident ImageBitmap to a 2D canvas.
     * A session can be combining and still paint through the 4:2:0 snapshot
     * path -- every unpaired main view does so under h264PaintViaSnapshot --
     * so what actually crossed into the display is recorded here and the
     * flush charged to it.
     *
     * A sync during which both kinds painted is charged to `bitmap`: it is
     * the suspect, and attributing a mixed flush to the cheap path would hide
     * exactly the case being looked for.
     *
     * @private
     * @type {!Object.<string, number>}
     */
    var paintedSinceSync = { bitmap: 0, canvas: 0 };

    /**
     * A display flush at least this long, in milliseconds, is counted as slow.
     * At 60fps a frame is 16.7ms; this is six of them.
     *
     * @private
     * @constant
     * @type {!number}
     */
    var FLUSH_SLOW_MS = 100;
    var holdTotal = newHoldStats();
    var holdWindow = newHoldStats();
    var holdWindowStart = 0;

    /**
     * How often the window above is reported, in milliseconds.
     *
     * @private
     * @constant
     * @type {!number}
     */
    var HOLD_REPORT_INTERVAL_MS = 60000;

    /**
     * Records one sync acknowledgement's hold, and reports the window if a
     * minute has passed. Reporting from here rather than from a timer means a
     * session sending no frames reports nothing, and nothing outlives the
     * decoder.
     *
     * @private
     */
    function recordHold(mode, ms, timedOut, flushMs) {

        noteActivity();
        if (mode === '444')
            noteCombineFlush(flushMs);

        var src = paintedSinceSync.bitmap ? 'bitmap'
                : (paintedSinceSync.canvas ? 'canvas' : 'idle');
        paintedSinceSync.bitmap = 0;
        paintedSinceSync.canvas = 0;

        [holdTotal[mode], holdWindow[mode]].forEach(function(stats) {
            if (typeof flushMs === 'number') {
                addFlush(stats, flushMs);
                addFlush(stats.flushBy[src], flushMs);
            }
            stats.syncs++;
            if (ms > 0) {
                stats.held++;
                stats.sumMs += ms;
                stats.maxMs = Math.max(stats.maxMs, ms);
            }
            if (timedOut)
                stats.timeouts++;
        });

        var now = nowMs();
        if (!holdWindowStart) {
            holdWindowStart = now;
            return;
        }

        var elapsed = now - holdWindowStart;
        if (elapsed < HOLD_REPORT_INTERVAL_MS)
            return;

        diagnostic('sync_hold', 'last ' + (elapsed / 1000).toFixed(0) + 's at '
                + (display ? display.getWidth() + 'x' + display.getHeight()
                    : '?') + ': ' + describeHolds(holdWindow, elapsed), true);

        holdWindow = newHoldStats();
        holdWindowStart = now;

    }

    /**
     * One mode's holds as text: syncs and their rate, how many were held at
     * all, the mean hold across every sync (the throttle's average cost per
     * frame) and across the held ones, the longest, and timeouts.
     *
     * @private
     */
    function describeHolds(stats, elapsedMs) {
        var parts = [];
        ['420', '444'].forEach(function(mode) {
            var s = stats[mode];
            if (!s.syncs)
                return;
            parts.push((mode === '444' ? '4:4:4' : '4:2:0') + ' ' + s.syncs
                    + ' syncs'
                    + (elapsedMs ? ' (' + (s.syncs * 1000 / elapsedMs)
                        .toFixed(1) + '/s)' : '')
                    + ' held ' + s.held + ' ('
                    + (100 * s.held / s.syncs).toFixed(0) + '%)'
                    + ' mean ' + (s.sumMs / s.syncs).toFixed(1) + 'ms'
                    + (s.held ? ' mean-held ' + (s.sumMs / s.held).toFixed(1)
                        + 'ms' : '')
                    + ' max ' + s.maxMs.toFixed(0) + 'ms'
                    + ' timeouts ' + s.timeouts
                    + (s.flushes ? ' | flush mean '
                        + (s.flushSumMs / s.flushes).toFixed(1) + 'ms max '
                        + s.flushMaxMs.toFixed(0) + 'ms slow '
                        + s.flushSlow : '')
                    + describeFlushSplit(s));
        });
        return parts.length ? parts.join('; ') : 'no syncs';
    }

    /**
     * The same flushes again, split by what was blitted into the display
     * during them. `idle` is a sync that painted nothing, and is the floor
     * the other two are read against: whatever it costs is the display's own
     * work rather than the handoff's.
     *
     * @private
     */
    function describeFlushSplit(s) {

        var parts = [];

        ['bitmap', 'canvas', 'idle'].forEach(function(src) {
            var b = s.flushBy[src];
            if (!b.flushes)
                return;
            parts.push(src + ' ' + b.flushes + ' mean '
                    + (b.flushSumMs / b.flushes).toFixed(1) + 'ms max '
                    + b.flushMaxMs.toFixed(0) + 'ms slow ' + b.flushSlow);
        });

        return parts.length ? ' | by paint: ' + parts.join(', ') : '';

    }

    /**
     * Waits for pending decodes to drain, then invokes the callback. Used to
     * gate the Guacamole sync response so that guacd receives accurate
     * backpressure from the client's decode speed.
     *
     * @param {function} callback
     *     Called when the backlog is within the allowed pipeline depth.
     *
     * @param {number} [flushMs]
     *     How long the display took to flush this sync's frame, from the sync
     *     arriving to the flush completing. The ack waits for the flush before
     *     it ever reaches this gate, so a display queue that is slow holds
     *     acks where the hold above cannot see it -- measured in the field as
     *     2.2 syncs/s with no holds while the screen stopped updating. Reported
     *     beside the hold in `sync_hold`.
     */
    this.waitForPending = function(callback, flushMs) {

        /* Charged to the mode the ack was held under, which is the one whose
         * cost is being measured -- a combine switched off mid-hold still
         * caused it. */
        var mode = combining ? '444' : '420';

        maybeResumeCombining();

        if (pendingDecodes <= MAX_PIPELINE_DEPTH || !decoder
                || decoder.state === 'closed') {
            recordHold(mode, 0, false, flushMs);
            callback();
            return;
        }

        var waitingOn = pendingDecodes;
        var resolved = false;
        var heldSince = nowMs();

        var timer = setTimeout(function() {
            if (!resolved) {
                resolved = true;
                recordHold(mode, nowMs() - heldSince, true, flushMs);
                noteSyncTimeout(mode);
                syncTimeouts++;
                reportAbandoned();
                var now = performance.now();
                if (now - lastTimeoutWarn > 1000) {
                    lastTimeoutWarn = now;
                    console.warn('[rustguac] H.264: sync wait timeout ('
                            + waitingOn + ' frames pending), forcing flush');
                }
                callback();
            }
        }, SYNC_WAIT_TIMEOUT_MS);

        flushResolvers.push(function() {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                recordHold(mode, nowMs() - heldSince, false, flushMs);
                callback();
            }
        });

    };

    /**
     * Describes the decoder's state in one line of key=value pairs, for the
     * page to attach to a report of the display going black.
     *
     * @returns {!string}
     */
    this.describeState = function() {

        var now = nowMs();
        function ago(at) {
            return at ? Math.round(now - at) + 'ms' : 'never';
        }

        return 'decoder=' + (decoder ? decoder.state : 'none')
                + ' configured=' + configured
                + ' needsKeyFrame=' + needsKeyFrame
                + (keyframeWaitSince
                    ? ' keyframeWait=' + ago(keyframeWaitSince) : '')
                + ' pending=' + pendingDecodes
                + ' queue=' + (decoder && decoder.decodeQueueSize !== undefined
                    ? decoder.decodeQueueSize : '?')
                + ' combining=' + combining
                + ' submitted=' + counts.submitted
                + ' decoded=' + counts.decoded
                + ' painted=' + counts.painted
                + ' keyframes=' + counts.keyframes
                + ' lastPaint=' + ago(counts.lastPaintAt)
                + ' lastKeyframe=' + ago(counts.lastKeyframeAt)
                + ' lastKeyframePaint=' + ago(counts.lastKeyframePaintAt)
                + ' watchdog=' + watchdogFires
                + ' syncTimeouts=' + syncTimeouts
                + ' holds[' + describeHolds(holdTotal, 0) + ']';

    };

    /**
     * Starts or stops probing painted delta frames. While on, a delta at most
     * every PROBE_DELTA_INTERVAL_MS is compared with what reached the layer and
     * reported as `paint_probe` diagnostics, up to PROBES_PER_EPISODE. The page
     * turns it on when it sees the display go black, and off when it recovers.
     *
     * @param {!boolean} on
     */
    this.setProbing = function(on) {
        probesLeft = on ? PROBES_PER_EPISODE : 0;
        lastProbeAt = 0;
    };

    /**
     * Resets the decoder, e.g. after reconnection or error recovery. The next
     * frame submitted must be a keyframe.
     */
    this.reset = function() {

        if (decoder && decoder.state !== 'closed') {
            try {
                decoder.reset();
                configured = false;
                needsKeyFrame = true;
                timestamp = 0;
            } catch (e) {
                /* Decoder may be in an error state */
            }
        }

        pendingDecodes = 0;
        releaseHeldFrames();

        var resolvers = flushResolvers;
        flushResolvers = [];
        for (var i = 0; i < resolvers.length; i++)
            resolvers[i]();

    };

    /**
     * Closes and releases the decoder.
     */
    this.destroy = function() {

        if (decoder && decoder.state !== 'closed') {
            try {
                decoder.close();
            } catch (e) {
                /* Ignore */
            }
        }

        decoder = null;
        configured = false;
        needsKeyFrame = false;

        if (yuv444) {
            yuv444.destroy();
            yuv444 = null;
        }
        combining = false;
        bufferPool = {};
        pendingDecodes = 0;
        releaseHeldFrames();

        var resolvers = flushResolvers;
        flushResolvers = [];
        for (var i = 0; i < resolvers.length; i++)
            resolvers[i]();

    };

};

/**
 * Check if the browser supports H.264 decoding via WebCodecs.
 *
 * @returns {boolean}
 *     true if WebCodecs VideoDecoder is available and supports H.264.
 */
Guacamole.H264Decoder.isSupported = function isSupported() {
    return typeof VideoDecoder !== 'undefined';
};

/**
 * Sink for decoder diagnostics, or null. Called as onDiagnostic(event, detail)
 * with a short event name and a description, no more than once per event every
 * 30 seconds (transitions excepted). The page is expected to forward these to
 * the server; a fault that appears once in days is not going to be caught in
 * anyone's console.
 *
 * @type {?function(string, string)}
 */
Guacamole.H264Decoder.onDiagnostic = null;

