/*
 * Main-thread facade for an H.264 decoder running on a worker.
 *
 * Presents the same surface as Guacamole.H264Decoder, so that Display.js,
 * Client.js and client.html cannot tell which side of the thread boundary the
 * decoder is on. What it keeps here is the half that cannot leave: the layers,
 * the display queue that paints them in stream order, and the page's view of
 * the runtime overrides.
 *
 * Copyright (C) 2026 Sol1 Pty Ltd. Licensed under Apache 2.0.
 */

var Guacamole = Guacamole || {};

/**
 * A decoder hosted on a worker, addressed as though it were local.
 *
 * Decoding, combining and the plane read-back all happen on the worker; one
 * ImageBitmap per painted picture is transferred back and drawn here, into the
 * layer, at the point in the display queue the instruction stream put it. The
 * main thread's share of a picture is that one drawImage() and nothing else.
 *
 * @constructor
 * @param {!Guacamole.Display} display
 *     The display whose layers decoded frames are painted into.
 *
 * @param {!Array.<string>} scripts
 *     URLs the worker must import before it can build a decoder -- the
 *     renderer and the decoder, at the versioned URLs this page was built
 *     with. Passed in rather than hard-coded because only the page knows the
 *     content hashes, and a worker importing them unversioned would be free to
 *     run a stale decoder against a fresh page.
 *
 * @param {!string} workerUrl
 *     The worker's own URL, versioned on the same terms.
 */
Guacamole.H264DecoderProxy = function H264DecoderProxy(display, scripts,
        workerUrl) {

    /**
     * Override names the worker needs. Read here, where the window globals,
     * the query string and localStorage actually are, and pushed across
     * whenever one changes -- so that setting window.__h264Chroma444 from the
     * console still takes effect mid-session, which is the whole point of
     * having them.
     *
     * @private
     * @constant
     * @type {!Array.<string>}
     */
    var OVERRIDE_NAMES = [
        'h264BlackProbes',
        'h264Chroma444',
        'h264ChromaFilter',
        'h264CombineLog',
        'h264CombineMaxPixels',
        'h264CopyBands',
        'h264FullRange',
        'h264KeepBlackKeyframes'
    ];

    /**
     * The main thread's own reader for those, which is the direct host's --
     * same sources, same precedence, same caching of the two that cannot
     * change without a reload.
     *
     * @private
     */
    var reader = Guacamole.H264Decoder.directHost(null);

    /**
     * The override snapshot last sent, as JSON, so that a picture carries a
     * new one only when something actually changed.
     *
     * @private
     * @type {string}
     */
    var sentOverrides = null;

    /**
     * Reads the current overrides, or null if they are unchanged since the
     * last time they were sent.
     *
     * @private
     * @returns {?Object.<string, *>}
     */
    function changedOverrides() {

        var current = {};
        for (var i = 0; i < OVERRIDE_NAMES.length; i++) {
            var value = reader.override(OVERRIDE_NAMES[i]);
            if (value !== undefined)
                current[OVERRIDE_NAMES[i]] = value;
        }

        var encoded = JSON.stringify(current);
        if (encoded === sentOverrides)
            return null;

        sentOverrides = encoded;
        return current;

    }

    /**
     * Frames submitted and not yet drawn, by the token handed to the caller.
     * The worker holds its own state for each; what is kept here is only what
     * painting needs and a worker cannot hold -- the layer, and where on it
     * the picture goes.
     *
     * @private
     * @type {!Object.<number, !Object>}
     */
    var pending = {};

    /**
     * The next token. The worker's own tokens are its business; a frame is
     * filed and answered under this one, because a frame the decoder refuses
     * outright still has a display task waiting on it here.
     *
     * @private
     * @type {number}
     */
    var nextToken = 1;

    /**
     * Sync waits outstanding, by id.
     *
     * @private
     */
    var flushes = {};
    var nextFlush = 1;

    /**
     * The worker's last pushed state string. describeState() is read
     * synchronously -- it goes into every diagnostic report -- so it is
     * answered from here rather than made a round trip.
     *
     * @private
     * @type {string}
     */
    var state = 'h264=worker starting';

    /**
     * Whether the worker is gone, by failure or by destroy(). Nothing is sent
     * to a dead worker, and everything waiting on one is released.
     *
     * @private
     * @type {boolean}
     */
    var dead = false;

    var worker = new Worker(workerUrl);

    worker.postMessage({
        t         : 'init',
        scripts   : scripts,
        width     : display.getWidth(),
        height    : display.getHeight(),
        overrides : changedOverrides() || {}
    });

    /**
     * Releases every frame and every sync wait outstanding, which is what a
     * worker that has stopped answering leaves behind. A display task that is
     * never unblocked stalls every frame behind it, and a sync that is never
     * answered stops the session dead, so this is the one thing that must
     * happen on every failure path.
     *
     * @private
     */
    function releaseAll() {

        var tokens = Object.keys(pending);
        for (var i = 0; i < tokens.length; i++) {
            var frame = pending[tokens[i]];
            delete pending[tokens[i]];
            closePicture(frame);
            if (frame.onReady)
                frame.onReady();
        }

        var ids = Object.keys(flushes);
        for (var f = 0; f < ids.length; f++) {
            var flush = flushes[ids[f]];
            delete flushes[ids[f]];
            if (flush.timer)
                clearTimeout(flush.timer);
            flush.callback();
        }

    }

    /**
     * Closes a frame's picture, if it still holds one. An ImageBitmap owns GPU
     * memory until it is closed and belongs to no pool.
     *
     * @private
     * @param {!Object} frame
     */
    function closePicture(frame) {

        if (!frame.picture)
            return;

        try {
            frame.picture.close();
        } catch (ignore) {
            /* Already closed. */
        }

        frame.picture = null;

    }

    worker.onerror = function (e) {
        console.error('[rustguac] H.264 worker failed:',
                e && e.message ? e.message : e);
        dead = true;
        releaseAll();
    };

    worker.onmessage = function (event) {

        var msg = event.data;
        if (!msg)
            return;

        switch (msg.t) {

            case 'ready':

                var frame = pending[msg.token];
                if (!frame)
                    return;

                /* Transferred, not copied: what arrives is the drawing
                 * buffer the worker rendered into, moved rather than cloned.
                 */
                frame.picture = msg.picture || null;
                frame.ready = true;

                if (frame.onReady)
                    frame.onReady();

                break;

            case 'diag':
                if (Guacamole.H264Decoder.onDiagnostic)
                    Guacamole.H264Decoder.onDiagnostic(msg.event, msg.detail);
                break;

            case 'state':
                state = msg.text;
                break;

            case 'flushed':

                var flush = flushes[msg.id];
                if (!flush)
                    return;

                delete flushes[msg.id];
                if (flush.timer)
                    clearTimeout(flush.timer);
                flush.callback();

                break;

            case 'init-failed':
                console.error('[rustguac] H.264 worker could not start:',
                        msg.error);
                dead = true;
                releaseAll();
                break;

        }

    };

    /**
     * Submits an access unit for decoding. Same contract as the local
     * decoder's: the caller gets a token back at once, and is told through
     * onReady when the frame is available to be drawn.
     */
    this.decode = function (layer, x, y, width, height, nalData, isKeyFrame,
            rects, onReady, view, paired) {

        if (dead) {
            if (onReady) onReady();
            return null;
        }

        var token = nextToken++;

        pending[token] = {
            layer   : layer,
            x       : x,
            y       : y,
            rects   : (rects && rects.length) ? rects : null,
            onReady : onReady,
            picture : null,
            ready   : false
        };

        try {
            worker.postMessage({
                t         : 'decode',
                token     : token,
                x         : x,
                y         : y,
                w         : width,
                h         : height,
                nal       : nalData,
                keyFrame  : !!isKeyFrame,
                rects     : rects,
                view      : view || 0,
                paired    : !!paired,
                width     : display.getWidth(),
                height    : display.getHeight(),
                overrides : changedOverrides()
            }, [nalData]);
        } catch (e) {
            console.error('[rustguac] H.264: could not hand a frame to the'
                    + ' worker:', e && e.message ? e.message : e);
            delete pending[token];
            if (onReady) onReady();
            return null;
        }

        return token;

    };

    /**
     * Draws the picture the worker produced for the given token, at the point
     * in the display queue the instruction stream put it.
     *
     * This is the main thread's whole share of a picture. Everything that used
     * to happen here -- the decode, the plane read-back, the uploads, the
     * shader -- happens on the worker now, and what is left is one blit the
     * compositor does on the GPU.
     */
    this.drawDecoded = function (token) {

        if (token === null || token === undefined)
            return;

        var frame = pending[token];
        if (!frame)
            return;

        delete pending[token];

        if (!frame.picture || !frame.layer) {
            closePicture(frame);
            return;
        }

        try {

            var ctx = frame.layer.getCanvas().getContext('2d');

            /* Draw only the regions the server marked valid. The decoded
             * picture spans the whole surface, so blitting all of it would
             * overwrite areas delivered via other codecs on a server that
             * mixes them within a frame. */
            if (frame.rects) {
                for (var r = 0; r < frame.rects.length; r++) {
                    var rect = frame.rects[r];
                    ctx.drawImage(frame.picture,
                            rect.x, rect.y, rect.width, rect.height,
                            rect.x, rect.y, rect.width, rect.height);
                }
            }

            /* No regions given: the entire picture is valid */
            else
                ctx.drawImage(frame.picture, frame.x, frame.y);

        } catch (e) {
            console.error('[rustguac] H.264: could not draw a worker picture:',
                    e && e.message ? e.message : e);
        } finally {
            closePicture(frame);
        }

    };

    /**
     * Holds the sync acknowledgement until the worker's backlog is short
     * enough, exactly as the local decoder does -- the gate and its 200ms
     * timeout live over there, with the backlog they are timing.
     *
     * The extra safety timer here is for the worker being gone rather than
     * busy: an ack that is never sent stops the session, and a worker that has
     * stopped answering would otherwise do exactly that.
     */
    this.waitForPending = function (callback, flushMs) {

        if (dead) {
            callback();
            return;
        }

        var id = nextFlush++;

        var record = flushes[id] = {
            callback : callback,
            timer    : null
        };

        record.timer = setTimeout(function () {
            if (flushes[id]) {
                delete flushes[id];
                console.warn('[rustguac] H.264: worker did not answer a sync'
                        + ' wait; acknowledging without it');
                callback();
            }
        }, Guacamole.H264DecoderProxy.FLUSH_TIMEOUT_MS);

        worker.postMessage({ t : 'flush', id : id, flushMs : flushMs });

    };

    /**
     * The worker's state string as it was last pushed. Read synchronously by
     * every diagnostic report, so it cannot be a round trip; the worker
     * refreshes it every few seconds and on every diagnostic, which is when it
     * is read.
     */
    this.describeState = function () {
        return state;
    };

    this.setProbing = function (on) {
        if (!dead)
            worker.postMessage({ t : 'probing', on : !!on });
    };

    this.reset = function () {
        if (dead)
            return;
        worker.postMessage({ t : 'reset' });
        releaseAll();
    };

    this.destroy = function () {
        if (dead)
            return;
        dead = true;
        try {
            worker.postMessage({ t : 'destroy' });
        } catch (ignore) {
            /* Already gone. */
        }
        releaseAll();
        worker.terminate();
    };

};

/**
 * How long a sync wait may go unanswered before the acknowledgement is sent
 * anyway, in milliseconds. Generously longer than the worker's own 200ms gate:
 * this is not a second opinion on the backlog, it is the answer to a worker
 * that has stopped speaking, and a session stops dead without it.
 *
 * @constant
 * @type {number}
 */
Guacamole.H264DecoderProxy.FLUSH_TIMEOUT_MS = 2000;

/**
 * Whether a decoder can be hosted on a worker here.
 *
 * @returns {boolean}
 */
Guacamole.H264DecoderProxy.isSupported = function isSupported() {
    return typeof Worker !== 'undefined'
            && typeof OffscreenCanvas !== 'undefined'
            && typeof OffscreenCanvas.prototype.transferToImageBitmap
                    === 'function';
};
