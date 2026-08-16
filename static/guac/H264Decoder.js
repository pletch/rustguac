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

        decoder = new VideoDecoder({
            output: function(frame) {
                self.framesDecoded++;

                var now = performance.now();
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

                try {
                    var pos = pendingPositions[frame.timestamp];
                    delete pendingPositions[frame.timestamp];
                    if (pos && pos.t !== undefined) {
                        var latency = performance.now() - pos.t;
                        self.lastDecodeLatency = latency;
                        if (latency > self.peakDecodeLatency)
                            self.peakDecodeLatency = latency;
                        decodeLatencySum += latency;
                        decodeLatencyCount++;
                    }
                    if (pos && pos.layer) {
                        var canvas = pos.layer.getCanvas();
                        var ctx = canvas.getContext('2d');

                        // Draw only the regions the server marked valid. The
                        // decoded picture spans the whole surface, so blitting
                        // all of it would overwrite areas delivered via other
                        // codecs (CAPROGRESSIVE, CLEARCODEC) on servers that
                        // mix them within a frame.
                        if (pos.rects) {
                            for (var r = 0; r < pos.rects.length; r++) {
                                var rect = pos.rects[r];
                                ctx.drawImage(frame,
                                        rect.x, rect.y, rect.width, rect.height,
                                        rect.x, rect.y, rect.width, rect.height);
                            }
                        }

                        // No regions given: the entire picture is valid
                        else
                            ctx.drawImage(frame, pos.x, pos.y);
                    }
                } finally {
                    // CRITICAL: always close VideoFrame to release GPU memory
                    frame.close();
                    self.framesClosed++;
                    pendingDecodes--;
                    resolveIfIdle();
                }
            },
            error: function(e) {
                self.framesDropped++;
                pendingDecodes--;
                resolveIfIdle();
                console.error('[rustguac] H.264 decode error:', e.message);
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
    this.decode = function(layer, x, y, width, height, nalData, isKeyFrame, rects) {

        ensureDecoder(width, height);

        if (!decoder || decoder.state === 'closed')
            return;

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
            pendingPositions[timestamp] = {
                layer: layer,
                x: x,
                y: y,
                rects: (rects && rects.length) ? rects : null,
                t: performance.now()
            };
            pendingDecodes++;
            timestamp += 33333; // ~30fps in microseconds

            decoder.decode(chunk);
            self.chunksSubmitted++;
        } catch (e) {
            self.framesDropped++;
            console.error('[rustguac] H.264 chunk error:', e.message);
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
        pendingPositions = {};
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
                    gapsOver100ms : gapsOver100
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
        pendingPositions = {};
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
