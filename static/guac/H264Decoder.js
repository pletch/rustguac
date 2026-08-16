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
     * Monotonic timestamp counter for EncodedVideoChunk (microseconds).
     *
     * @private
     * @type {number}
     */
    var timestamp = 0;

    /**
     * Number of frames submitted to the decoder but not yet output.
     *
     * @private
     * @type {number}
     */
    var pendingDecodes = 0;

    /**
     * Maximum number of frames allowed to remain in flight (submitted to the
     * decoder but not yet painted) when acknowledging a Guacamole sync. A depth
     * of 0 forces the sync ack to wait for every frame to fully decode and
     * paint, serializing network RTT and async decode time on every frame and
     * causing severe input lag. Allowing a shallow pipeline overlaps RTT with
     * decode while keeping the backlog bounded, so guacd backpressure still
     * applies once the queue exceeds this depth.
     *
     * @private
     * @constant
     * @type {number}
     */
    var MAX_PIPELINE_DEPTH = 2;

    /**
     * Safety timeout (ms) for the sync gate. If pending decodes do not drain
     * within this window the sync is acked anyway, preventing a permanent
     * stall if the decoder wedges. Kept short: it is a pure safety net, not a
     * throttle, so a healthy decoder never reaches it.
     *
     * @private
     * @constant
     * @type {number}
     */
    var SYNC_WAIT_TIMEOUT_MS = 200;

    /**
     * How long a scheduled draw task may wait for its frame before giving up,
     * in milliseconds. Generous, because it is a stall-breaker rather than a
     * throttle: a healthy decoder returns frames in single-digit milliseconds.
     *
     * @private
     * @constant
     * @type {number}
     */
    var DECODE_WATCHDOG_MS = 1000;

    /**
     * Timestamp of the last sync-timeout warning, for rate-limiting the log
     * so a struggling decoder cannot flood the console (heavy logging on the
     * main thread itself worsens decode/paint latency).
     *
     * @private
     * @type {number}
     */
    var lastTimeoutWarn = 0;

    /**
     * Per-frame draw positions keyed by chunk timestamp. The VideoDecoder
     * output callback uses this to draw each frame at the correct position,
     * avoiding shared mutable state between concurrent decodes.
     *
     * @private
     * @type {Object.<number, {layer: Guacamole.Display.VisibleLayer, x: number, y: number}>}
     */
    var pendingPositions = {};

    /**
     * Callbacks waiting for all pending decodes to complete (used by
     * waitForPending to gate the Guacamole sync response).
     *
     * @private
     * @type {function[]}
     */
    var flushResolvers = [];

    /**
     * Total frames decoded.
     *
     * @type {number}
     */
    /* Expose the most recently constructed decoder for console diagnostics.
     * client.html holds its Guacamole.Client in function scope, so
     * client._h264Decoder is not reachable from the console. */
    if (typeof window !== 'undefined') {
        window.__h264 = this;
        window.__h264Instances = (window.__h264Instances || 0) + 1;
        this.instanceNumber = window.__h264Instances;
        if (window.__h264Instances > 1) {
            console.warn('[rustguac] H.264 decoder instance #'
                + window.__h264Instances + ' created. Earlier instances still '
                + 'hold a VideoDecoder; frames in flight on those are never '
                + 'closed.');
        }
    }

    /**
     * Counters for the path between the h264 instruction arriving and the
     * chunk reaching the decoder. Incremented by Client.js. guacd's flush rate
     * and framesDecoded disagreed by roughly 2x, and framesDropped was zero,
     * so frames are being lost before the decoder rather than by it.
     */
    this.instructionsReceived = 0;
    this.streamsEnded = 0;
    this.emptyStreams = 0;
    this.chunksSubmitted = 0;

    /**
     * Inter-frame arrival timing. A steady 21fps and a bursty 21fps produce
     * identical frame counts but look very different: frames painted at uneven
     * intervals judder regardless of the average rate. Deltas are measured
     * between successive decoder outputs, which is the point at which a frame
     * is painted.
     */
    var lastOutputTime = 0;

    /**
     * Time of the first decoder output since the current rate() sample began.
     *
     * Gaps are only recorded between successive outputs, so silence at either
     * end of a sample window is invisible to them: a stream that delivers one
     * clean burst and then stops reports a healthy mean gap and no long gaps
     * at all, while the frame rate collapses. Recording where the first and
     * last outputs fell within the window makes that shape explicit instead of
     * leaving it to be inferred from a contradiction between the two.
     */
    var firstOutputTime = 0;
    var gapCount = 0;
    var gapSum = 0;
    var gapMin = Infinity;
    var gapMax = 0;
    var gapsOver100 = 0;
    var gapSquares = 0;

    /**
     * Frames for which close() was actually reached. If this tracks
     * framesDecoded exactly, this decoder is not leaking VideoFrames and any
     * "garbage collected without being closed" warning originates elsewhere --
     * most likely a second decoder instance left behind by a reconnect.
     */
    this.framesClosed = 0;

    this.framesDecoded = 0;

    /**
     * VideoFrames that this decoder received and that were garbage collected
     * while still open. framesDecoded and framesClosed agreeing proves only
     * that every frame reaching the end of the output callback was closed; it
     * cannot prove a frame was never dropped on some other path. This counts
     * the actual condition Chrome warns about, so the warning can be
     * attributed rather than inferred.
     *
     * A FinalizationRegistry is the only way to observe this: any container
     * holding the frames to check them later would itself keep them alive.
     * The held value must not reference the frame, so it carries only a small
     * record of the frame's identity and whether close() was reached.
     *
     * @type {number}
     */
    this.gcLeaks = 0;

    /**
     * Number of times a draw task gave up waiting for its frame. Any non-zero
     * value means frames are being lost between submission and output, which
     * would otherwise stall the display queue.
     *
     * @type {number}
     */
    this.watchdogFires = 0;

    /**
     * Number of decoded frames that could not be snapshotted to an
     * ImageBitmap. Non-zero means frames are being lost at the copy step.
     *
     * @type {number}
     */
    this.bitmapFailures = 0;

    var frameRegistry = (typeof FinalizationRegistry !== 'undefined')
        ? new FinalizationRegistry(function(state) {
            if (!state.closed) {
                self.gcLeaks++;
                console.warn('[rustguac] LEAK: VideoFrame ts=' + state.ts
                        + ' was garbage collected without close(). This frame '
                        + 'came from the rustguac H.264 decoder. Total leaked: '
                        + self.gcLeaks);
            }
        })
        : null;

    /**
     * Long main-thread tasks observed during this session. A freeze has two
     * possible causes that look identical to the viewer: the browser is busy
     * and cannot paint, or nothing is arriving to paint. These separate them.
     * If a freeze coincides with a long task, it is this machine; if the main
     * thread stays idle through the freeze, the frames are not being sent.
     *
     * @type {number}
     */
    this.longTasks = 0;
    this.longTaskMs = 0;
    this.maxLongTaskMs = 0;

    if (typeof PerformanceObserver !== 'undefined') {
        try {
            new PerformanceObserver(function(list) {
                var entries = list.getEntries();
                for (var i = 0; i < entries.length; i++) {
                    self.longTasks++;
                    self.longTaskMs += entries[i].duration;
                    if (entries[i].duration > self.maxLongTaskMs)
                        self.maxLongTaskMs = entries[i].duration;
                }
            }).observe({ entryTypes: ['longtask'] });
        } catch (e) {
            /* longtask is not observable in every browser; not fatal */
        }
    }

    /**
     * Number of VideoDecoder objects created. Should be exactly 1 for the
     * lifetime of a session -- more means decoders are being replaced, and a
     * replaced decoder that was not closed holds GPU resources and may still
     * deliver frames to this callback.
     *
     * @type {number}
     */
    this.decoderInstances = 0;

    /**
     * Total frames dropped or errored.
     *
     * @type {number}
     */
    this.framesDropped = 0;

    /**
     * Total number of sync responses that were delayed waiting for H.264
     * decode completion.
     *
     * @type {number}
     */
    this.syncsGated = 0;

    /**
     * Peak decode queue depth seen during this session.
     *
     * @type {number}
     */
    this.peakQueueDepth = 0;

    /**
     * Decode latency of the most recent frame: milliseconds from submitting
     * the chunk to decoder.decode() until its decoded frame arrived in the
     * output callback. This isolates browser-side decode cost (and any
     * decoder reordering, e.g. B-frames) from server-side encoder latency:
     * if this stays small but motion-to-photon lag is high, the buffering is
     * upstream of the browser (the xrdp H.264 encoder).
     *
     * @type {number}
     */
    this.lastDecodeLatency = 0;

    /**
     * Peak per-frame decode latency seen this session, in milliseconds.
     *
     * @type {number}
     */
    this.peakDecodeLatency = 0;

    /**
     * Running sum and count of per-frame decode latencies, used to report a
     * session average in stats().
     *
     * @private
     * @type {number}
     */
    var decodeLatencySum = 0;
    var decodeLatencyCount = 0;

    /**
     * Reference to this for closures.
     */
    var self = this;

    /**
     * Marks a pending decode as finished exactly once, whatever its outcome:
     * drawn, failed, or abandoned. pendingDecodes gates the Guacamole sync
     * response, so a decode that is never settled leaves the client reporting
     * a backlog forever and every sync waiting out its timeout.
     *
     * @private
     */
    function settle(pos) {
        if (!pos || pos.settled)
            return;
        pos.settled = true;
        pendingDecodes--;
        resolveIfIdle();
    }

    /**
     * If pendingDecodes has reached zero, fire and clear all flush resolvers.
     *
     * @private
     */
    function resolveIfIdle() {
        if (pendingDecodes <= 0 && flushResolvers.length > 0) {
            var resolvers = flushResolvers;
            flushResolvers = [];
            for (var i = 0; i < resolvers.length; i++)
                resolvers[i]();
        }
    }

    /**
     * Initialise the VideoDecoder if not already done.
     *
     * @private
     * @param {number} width - Expected frame width.
     * @param {number} height - Expected frame height.
     */
    function ensureDecoder(width, height) {

        if (decoder && configured)
            return;

        if (typeof VideoDecoder === 'undefined') {
            console.warn('[rustguac] WebCodecs VideoDecoder not available');
            return;
        }

        /* Release any decoder being replaced. reset() clears the configured
         * flag, so a later decode() reaches this point with a live decoder
         * still assigned; overwriting it without closing leaks its GPU
         * resources and leaves a second decoder able to deliver frames into
         * this same callback. Nothing calls reset() today, which is why the
         * counters have stayed clean, but the path exists. */
        if (decoder && decoder.state !== 'closed') {
            try {
                decoder.close();
                console.warn('[rustguac] Replacing an open H.264 decoder; '
                        + 'closing the previous one.');
            } catch (e) {
                /* Already in an error state */
            }
        }

        self.decoderInstances++;

        decoder = new VideoDecoder({
            output: function(frame) {
                self.framesDecoded++;

                /* Registered before anything else can throw. The state object
                 * is what the registry hands back after the frame is
                 * collected; it deliberately holds no reference to the frame
                 * itself, which would prevent the collection being observed. */
                var frameState = { closed: false, ts: frame.timestamp };
                if (frameRegistry)
                    frameRegistry.register(frame, frameState);

                var now = performance.now();
                if (!firstOutputTime) firstOutputTime = now;
                if (lastOutputTime) {
                    var gap = now - lastOutputTime;
                    gapCount++;
                    gapSum += gap;
                    gapSquares += gap * gap;
                    if (gap < gapMin) gapMin = gap;
                    if (gap > gapMax) gapMax = gap;
                    if (gap > 100) gapsOver100++;
                }
                lastOutputTime = now;

                var pos = pendingPositions[frame.timestamp];

                if (pos && pos.t !== undefined) {
                    var latency = performance.now() - pos.t;
                    self.lastDecodeLatency = latency;
                    if (latency > self.peakDecodeLatency)
                        self.peakDecodeLatency = latency;
                    decodeLatencySum += latency;
                    decodeLatencyCount++;
                }

                /* Snapshot to an ImageBitmap and release the VideoFrame at
                 * once, rather than holding it until the draw task runs.
                 *
                 * A hardware decoder has a small pool of output surfaces, and
                 * an open VideoFrame holds one. Holding frames until their
                 * scheduled draw exhausts that pool as soon as the display
                 * queue falls even slightly behind, which stalls the decoder,
                 * which delays the draws, which holds more frames -- decode
                 * latency measured 437ms average against 1.6ms before, with 56
                 * frames pinned and a main thread that was completely idle.
                 *
                 * An ImageBitmap is an ordinary GPU-backed resource with no
                 * such pool, so any number can be held while ordering is
                 * preserved. The cost is one copy per frame. */
                if (pos) {

                    createImageBitmap(frame).then(function(bitmap) {

                        frame.close();
                        frameState.closed = true;
                        self.framesClosed++;

                        if (pos.watchdog) {
                            clearTimeout(pos.watchdog);
                            pos.watchdog = null;
                        }

                        /* The draw task already gave up on this frame */
                        if (pos.settled) {
                            bitmap.close();
                            return;
                        }

                        pos.bitmap = bitmap;
                        if (pos.onReady)
                            pos.onReady();

                    }).catch(function(e) {

                        try {
                            frame.close();
                            frameState.closed = true;
                            self.framesClosed++;
                        } catch (e2) { /* already closed */ }

                        self.bitmapFailures++;
                        if (pos.onReady)
                            pos.onReady();

                    });

                }

                /* The draw task already ran and gave up on this frame (its
                 * watchdog fired). Release it; the decode was settled then, so
                 * the accounting must not be touched again here. */
                else {
                    frame.close();
                    frameState.closed = true;
                    self.framesClosed++;
                }

            },
            error: function(e) {

                self.framesDropped++;
                console.error('[rustguac] H.264 decode error:', e.message);

                /* A VideoDecoder error is terminal for everything queued on it:
                 * those frames will never reach the output callback. Each has a
                 * blocked task holding the display queue, and the display
                 * renders frames in order, so leaving them blocked stalls the
                 * entire display permanently -- the screen freezes on whatever
                 * was last painted. Unblock them all. */
                for (var key in pendingPositions) {
                    var pos = pendingPositions[key];
                    if (pos && pos.onReady)
                        pos.onReady();
                }

            }
        });

        // Configure for H.264 High Profile, Level 4.1 (matches xrdp)
        // Let the decoder auto-detect level from the SPS NAL in the stream
        decoder.configure({
            codec: 'avc1.640029', // High profile, level 4.1
            hardwareAcceleration: 'prefer-hardware',
            optimizeForLatency: true
        });

        configured = true;
        console.log('[rustguac] H.264 WebCodecs decoder initialised (' + width + 'x' + height + ')');
    }

    /**
     * Decode a complete H.264 NAL unit buffer and render to the given layer.
     *
     * @param {!Guacamole.Display.VisibleLayer} layer
     *     The layer to draw the decoded frame to.
     * @param {number} x - X position on the layer.
     * @param {number} y - Y position on the layer.
     * @param {number} width - Frame width.
     * @param {number} height - Frame height.
     * @param {!ArrayBuffer} nalData - Raw H.264 NAL unit data (Annex B format).
     * @param {boolean} isKeyFrame - Whether this contains an IDR/keyframe.
     * @param {Array} [rects]
     *     The regions of the decoded picture that are actually valid, each
     *     {x, y, width, height} in surface coordinates. An H.264 picture is
     *     always full-surface sized, but a server that mixes codecs encodes
     *     only part of the screen as H.264, leaving the rest of the picture
     *     holding no meaningful content. Drawing the whole picture in that
     *     case overwrites regions delivered via other codecs. Omit or leave
     *     empty when the entire picture is valid, as with servers that encode
     *     the full surface.
     */
    this.decode = function(layer, x, y, width, height, nalData, isKeyFrame,
            rects, onReady) {

        ensureDecoder(width, height);

        /* No decoder at all: the caller's task must still be unblocked, or the
         * display queue stalls behind a frame that will never arrive. */
        if (!decoder || decoder.state === 'closed') {
            if (onReady) onReady();
            return null;
        }

        // Track peak queue depth for diagnostics
        if (decoder.decodeQueueSize > self.peakQueueDepth)
            self.peakQueueDepth = decoder.decodeQueueSize;

        try {
            var chunk = new EncodedVideoChunk({
                type: isKeyFrame ? 'key' : 'delta',
                timestamp: timestamp,
                data: nalData
            });

            // Store per-frame position (and submit time, for decode-latency
            // measurement) before submitting to decoder
            var token = timestamp;

            pendingPositions[token] = {
                layer: layer,
                x: x,
                y: y,
                rects: (rects && rects.length) ? rects : null,
                t: performance.now(),
                onReady: onReady,
                bitmap: null
            };
            pendingDecodes++;
            timestamp += 33333; // ~30fps in microseconds

            /* Safety net. The scheduled draw task blocks the display queue
             * until this frame is decoded, so anything that loses a frame
             * without reporting an error -- a decoder reset, a dropped chunk --
             * would stall the display indefinitely. Unblocking after a
             * generous delay costs one skipped frame instead. */
            (function(rec) {
                rec.watchdog = setTimeout(function() {
                    rec.watchdog = null;
                    if (!rec.bitmap) {
                        self.watchdogFires++;
                        if (rec.onReady) rec.onReady();
                    }
                }, DECODE_WATCHDOG_MS);
            })(pendingPositions[token]);

            decoder.decode(chunk);
            self.chunksSubmitted++;
            return token;

        } catch (e) {
            self.framesDropped++;
            console.error('[rustguac] H.264 chunk error:', e.message);
            if (onReady) onReady();
            return null;
        }
    };

    /**
     * Draws the frame decoded for the given token, then releases it. Called
     * from the display's task queue so that the frame is painted in the same
     * order the instruction stream specified, rather than whenever decode
     * finished.
     *
     * Safe to call with a token that has no decoded frame -- the decode may
     * have failed, or the decoder may have been reset -- in which case nothing
     * is drawn.
     *
     * @param {number} token
     *     The token returned by decode().
     */
    this.drawDecoded = function(token) {

        if (token === null || token === undefined)
            return;

        var pos = pendingPositions[token];
        if (!pos)
            return;

        delete pendingPositions[token];

        if (pos.watchdog) {
            clearTimeout(pos.watchdog);
            pos.watchdog = null;
        }

        var bitmap = pos.bitmap;

        /* Nothing decoded for this token -- the watchdog released the task, or
         * the decoder errored. Settle it so the sync gate does not wait on a
         * frame that will never arrive. */
        if (!bitmap) {
            settle(pos);
            return;
        }

        try {
            if (pos.layer) {
                var canvas = pos.layer.getCanvas();
                var ctx = canvas.getContext('2d');

                // Draw only the regions the server marked valid. The decoded
                // picture spans the whole surface, so blitting all of it would
                // overwrite areas delivered via other codecs (CAPROGRESSIVE,
                // CLEARCODEC) on servers that mix them within a frame.
                if (pos.rects) {
                    for (var r = 0; r < pos.rects.length; r++) {
                        var rect = pos.rects[r];
                        ctx.drawImage(bitmap,
                                rect.x, rect.y, rect.width, rect.height,
                                rect.x, rect.y, rect.width, rect.height);
                    }
                }

                // No regions given: the entire picture is valid
                else
                    ctx.drawImage(bitmap, pos.x, pos.y);
            }
        } finally {
            bitmap.close();
            settle(pos);
        }

    };

    /**
     * Wait for all pending decodes to complete, then invoke the callback.
     * Used to gate the Guacamole sync response so that guacd receives
     * accurate backpressure from the client's decode speed.
     *
     * Includes a short safety timeout (SYNC_WAIT_TIMEOUT_MS) to prevent a
     * permanent stall if the decoder enters an unexpected state.
     *
     * @param {function} callback - Called when all pending decodes are done.
     */
    this.waitForPending = function(callback) {
        // Ack as soon as the backlog is within the allowed pipeline depth.
        // Gating strictly on <= 0 serializes network RTT and async decode
        // time on every frame, causing severe input lag.
        if (pendingDecodes <= MAX_PIPELINE_DEPTH || !decoder || decoder.state === 'closed') {
            callback();
            return;
        }

        self.syncsGated++;
        var waitStart = performance.now();
        var waitingOn = pendingDecodes;

        var resolved = false;
        var timer = setTimeout(function() {
            if (!resolved) {
                resolved = true;
                // Rate-limit: at most one warning per second, so a wedged
                // decoder cannot flood the console (which would itself add jank).
                var now = performance.now();
                if (now - lastTimeoutWarn > 1000) {
                    lastTimeoutWarn = now;
                    console.warn('[rustguac] H.264: sync wait timeout (' + waitingOn + ' frames pending), forcing flush');
                }
                callback();
            }
        }, SYNC_WAIT_TIMEOUT_MS);

        flushResolvers.push(function() {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                var elapsed = (performance.now() - waitStart).toFixed(1);
                if (elapsed > 16) // only log if wait was > 1 frame (~16ms)
                    console.log('[rustguac] H.264: sync gated ' + elapsed + 'ms (' + waitingOn + ' frames)');
                callback();
            }
        });
    };

    /**
     * Closes any decoded frames still held awaiting their draw task. Frames
     * now live in pendingPositions between decode and draw, so discarding that
     * map without closing them leaks GPU memory -- the exact condition
     * gcLeaks exists to detect.
     *
     * @private
     */
    function releaseHeldFrames() {
        for (var key in pendingPositions) {
            var pos = pendingPositions[key];
            if (pos && pos.bitmap) {
                try {
                    pos.bitmap.close();
                } catch (e2) {
                    /* Already closed */
                }
            }
        }
        pendingPositions = {};
    }

    /**
     * Reset the decoder (e.g. after reconnection or error recovery).
     * The next frame must be a keyframe.
     */
    this.reset = function() {
        if (decoder && decoder.state !== 'closed') {
            try {
                decoder.reset();
                configured = false;
                timestamp = 0;
                console.log('[rustguac] H.264 decoder reset');
            } catch (e) {
                // Decoder may be in error state
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
     * Return current decoder statistics for console debugging.
     * Usage: open browser console and run:
     *   client._h264Decoder.stats()
     *
     * @returns {Object} Decoder statistics.
     */
    /**
     * Measures the rate at which frames are actually being decoded and drawn,
     * sampled over the given interval. This is the number to compare against
     * guacd's flush rate: if guacd reports ~30 flushes/sec and this reports
     * ~30, the client is keeping up and any choppiness is in compositing or in
     * the source itself; if this is markedly lower, frames are being lost here.
     *
     * Usage: __h264.rate(5).then(console.log)
     *
     * @param {number} [seconds=5] - Sampling interval.
     * @returns {Promise<Object>} Resolves to the measured rates.
     */
    this.rate = function(seconds) {

        var interval = (seconds || 5) * 1000;
        var startDecoded = self.framesDecoded;
        var startDropped = self.framesDropped;
        // lastOutputTime must be reset too, or the first gap recorded is
        // measured from the last frame BEFORE sampling began -- which for an
        // idle session is arbitrarily large and skews mean, stdDev and max.
        lastOutputTime = 0;
        firstOutputTime = 0;
        var sampleStart = performance.now();
        gapCount = 0; gapSum = 0; gapSquares = 0;
        gapMin = Infinity; gapMax = 0; gapsOver100 = 0;

        var startInstr = self.instructionsReceived;
        var startEnded = self.streamsEnded;
        var startSubmitted = self.chunksSubmitted;

        return new Promise(function(resolve) {
            setTimeout(function() {
                var secs = interval / 1000;
                resolve({
                    instrPerSec   : +((self.instructionsReceived - startInstr) / secs).toFixed(1),
                    endedPerSec   : +((self.streamsEnded - startEnded) / secs).toFixed(1),
                    submittedPerSec: +((self.chunksSubmitted - startSubmitted) / secs).toFixed(1),
                    decodedPerSec : +((self.framesDecoded - startDecoded) / secs).toFixed(1),
                    droppedPerSec : +((self.framesDropped - startDropped) / secs).toFixed(1),
                    emptyStreams  : self.emptyStreams,
                    queueDepth    : decoder ? decoder.decodeQueueSize : 0,
                    peakQueueDepth: self.peakQueueDepth,
                    avgLatencyMs  : decodeLatencyCount
                        ? +(decodeLatencySum / decodeLatencyCount).toFixed(1) : 0,
                    peakLatencyMs : +self.peakDecodeLatency.toFixed(1),

                    // Arrival regularity. meanGapMs should equal
                    // 1000/decodedPerSec; a stdDev approaching or exceeding
                    // the mean means frames arrive in bursts, which judders
                    // regardless of the average rate.
                    meanGapMs     : gapCount ? +(gapSum / gapCount).toFixed(1) : 0,
                    stdDevGapMs   : gapCount
                        ? +Math.sqrt(Math.max(0,
                            gapSquares / gapCount
                            - (gapSum / gapCount) * (gapSum / gapCount))).toFixed(1)
                        : 0,
                    minGapMs      : gapMin === Infinity ? 0 : +gapMin.toFixed(1),
                    maxGapMs      : +gapMax.toFixed(1),
                    gapsOver100ms : gapsOver100,

                    // Where the frames actually fell within the window. A
                    // burst followed by silence and a genuinely steady stream
                    // produce the same mean gap; these tell them apart.
                    // activeSpanMs well below windowMs means the stream
                    // stopped rather than slowed.
                    windowMs      : +(performance.now() - sampleStart).toFixed(0),
                    activeSpanMs  : (firstOutputTime && lastOutputTime)
                        ? +(lastOutputTime - firstOutputTime).toFixed(0) : 0,
                    idleAtStartMs : firstOutputTime
                        ? +(firstOutputTime - sampleStart).toFixed(0)
                        : +(performance.now() - sampleStart).toFixed(0),
                    idleAtEndMs   : lastOutputTime
                        ? +(performance.now() - lastOutputTime).toFixed(0) : 0
                });
            }, interval);
        });

    };

    this.stats = function() {
        var s = {
            instanceNumber: self.instanceNumber,
            totalInstances: (typeof window !== 'undefined') ? window.__h264Instances : 1,
            framesDecoded: self.framesDecoded,
            framesClosed: self.framesClosed,
            leaked: self.framesDecoded - self.framesClosed,

            /* Frames proven collected while open. If Chrome warns about
             * garbage-collected VideoFrames while this stays 0, the frames it
             * is warning about are not ours. */
            gcLeaks: self.gcLeaks,
            watchdogFires: self.watchdogFires,
            bitmapFailures: self.bitmapFailures,
            decoderInstances: self.decoderInstances,

            /* Main-thread blocking. A freeze with no long tasks is not a
             * rendering problem on this machine. */
            longTasks: self.longTasks,
            longTaskMs: +self.longTaskMs.toFixed(0),
            maxLongTaskMs: +self.maxLongTaskMs.toFixed(0),
            framesDropped: self.framesDropped,
            syncsGated: self.syncsGated,
            pendingDecodes: pendingDecodes,
            decodeQueueSize: decoder ? decoder.decodeQueueSize : 0,
            peakQueueDepth: self.peakQueueDepth,
            lastDecodeLatencyMs: +self.lastDecodeLatency.toFixed(1),
            avgDecodeLatencyMs: decodeLatencyCount
                ? +(decodeLatencySum / decodeLatencyCount).toFixed(1) : 0,
            peakDecodeLatencyMs: +self.peakDecodeLatency.toFixed(1),
            decoderState: decoder ? decoder.state : 'none'
        };
        console.table(s);
        return s;
    };

    /**
     * Close and release the decoder.
     */
    this.destroy = function() {
        if (decoder && decoder.state !== 'closed') {
            try {
                decoder.close();
            } catch (e) {
                // Ignore
            }
        }
        decoder = null;
        configured = false;
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
