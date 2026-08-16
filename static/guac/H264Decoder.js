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
     * If the backlog has drained, fire and clear all flush resolvers.
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
     * Releases any ImageBitmap still held awaiting its draw task. Frames live
     * here between decode and draw, so discarding the map without closing them
     * leaks GPU memory.
     *
     * @private
     */
    function releaseHeldFrames() {
        for (var key in pendingFrames) {
            var frameState = pendingFrames[key];
            if (frameState && frameState.bitmap) {
                try {
                    frameState.bitmap.close();
                } catch (e) {
                    /* Already closed */
                }
            }
        }
        pendingFrames = {};
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

                var frameState = pendingFrames[frame.timestamp];

                /* The draw task already gave up on this frame, or it belongs
                 * to a decoder that has since been replaced. */
                if (!frameState) {
                    frame.close();
                    return;
                }

                if (frameState.watchdog) {
                    clearTimeout(frameState.watchdog);
                    frameState.watchdog = null;
                }

                /* An auxiliary AVC444 view is not an image. It had to be
                 * decoded to keep the sequence's reference chain intact, but
                 * drawing it would paint packed chroma data over the screen. */
                if (frameState.view !== 0) {
                    frame.close();
                    if (frameState.onReady)
                        frameState.onReady();
                    return;
                }

                /* Snapshot to an ImageBitmap and release the VideoFrame at
                 * once, rather than holding it until the draw task runs. A
                 * hardware decoder has a small pool of output surfaces and an
                 * open VideoFrame holds one, so holding frames until their
                 * scheduled draw exhausts that pool as soon as the display
                 * queue falls behind: the decoder stalls, which delays the
                 * draws, which holds more frames. An ImageBitmap has no such
                 * pool, at the cost of one copy per frame. */
                createImageBitmap(frame).then(function(bitmap) {

                    frame.close();

                    if (frameState.settled) {
                        bitmap.close();
                        return;
                    }

                    frameState.bitmap = bitmap;
                    if (frameState.onReady)
                        frameState.onReady();

                }).catch(function() {

                    try {
                        frame.close();
                    } catch (e) {
                        /* Already closed */
                    }

                    if (frameState.onReady)
                        frameState.onReady();

                });

            },

            error: function(e) {

                console.error('[rustguac] H.264 decode error:', e.message);

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

        decoder.configure({
            codec: 'avc1.640029', // High profile, level 4.1
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
     * @returns {?number}
     *     A token identifying this frame, to be passed to drawDecoded(), or
     *     null if it could not be submitted.
     */
    this.decode = function(layer, x, y, width, height, nalData, isKeyFrame,
            rects, onReady, view) {

        ensureDecoder(width, height);

        /* No decoder at all: the caller's task must still be released, or the
         * display queue stalls behind a frame that will never arrive. */
        if (!decoder || decoder.state === 'closed') {
            if (onReady) onReady();
            return null;
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
                view: view || 0,
                onReady: onReady,
                bitmap: null,
                settled: false,
                watchdog: null
            };

            pendingDecodes++;

            frameState.watchdog = setTimeout(function() {
                frameState.watchdog = null;
                if (!frameState.bitmap && frameState.onReady)
                    frameState.onReady();
            }, DECODE_WATCHDOG_MS);

            decoder.decode(chunk);
            return token;

        } catch (e) {
            console.error('[rustguac] H.264 chunk error:', e.message);
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

        if (frameState.watchdog) {
            clearTimeout(frameState.watchdog);
            frameState.watchdog = null;
        }

        var bitmap = frameState.bitmap;
        if (!bitmap) {
            settle(frameState);
            return;
        }

        try {

            if (frameState.layer) {

                var ctx = frameState.layer.getCanvas().getContext('2d');

                /* Draw only the regions the server marked valid. The decoded
                 * picture spans the whole surface, so blitting all of it would
                 * overwrite areas delivered via other codecs on a server that
                 * mixes them within a frame. */
                if (frameState.rects) {
                    for (var r = 0; r < frameState.rects.length; r++) {
                        var rect = frameState.rects[r];
                        ctx.drawImage(bitmap,
                                rect.x, rect.y, rect.width, rect.height,
                                rect.x, rect.y, rect.width, rect.height);
                    }
                }

                /* No regions given: the entire picture is valid */
                else
                    ctx.drawImage(bitmap, frameState.x, frameState.y);

            }

        } finally {
            bitmap.close();
            settle(frameState);
        }

    };

    /**
     * Waits for pending decodes to drain, then invokes the callback. Used to
     * gate the Guacamole sync response so that guacd receives accurate
     * backpressure from the client's decode speed.
     *
     * @param {function} callback
     *     Called when the backlog is within the allowed pipeline depth.
     */
    this.waitForPending = function(callback) {

        if (pendingDecodes <= MAX_PIPELINE_DEPTH || !decoder
                || decoder.state === 'closed') {
            callback();
            return;
        }

        var waitingOn = pendingDecodes;
        var resolved = false;

        var timer = setTimeout(function() {
            if (!resolved) {
                resolved = true;
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
                callback();
            }
        });

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
