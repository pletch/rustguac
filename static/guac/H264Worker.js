/*
 * Worker host for the H.264 decoder.
 *
 * Runs Guacamole.H264Decoder off the main thread, so that the one genuinely
 * blocking step in the pipeline -- VideoFrame.copyTo()'s synchronous half,
 * measured at ~6.5ms per megapixel plus a 5-10ms stall per call -- no longer
 * runs on the thread the browser dispatches input to. Nothing in the browser
 * can move input off that thread: there is no worker-side pointer or keyboard
 * event, and the element the listeners are attached to stays in the document
 * whatever is done with the canvas. So the work moves instead, and the main
 * thread is left free to answer the events as they arrive rather than
 * coalescing them behind a copy.
 *
 * What crosses back is one ImageBitmap per painted picture, transferred rather
 * than copied. The main thread draws it into the layer when the display queue
 * reaches it, which is what keeps H.264 painted in stream order relative to
 * the img, copy and rect operations around it.
 *
 * Copyright (C) 2026 Sol1 Pty Ltd. Licensed under Apache 2.0.
 */

/* The decoder and the renderer are loaded on init rather than at the top of
 * this file, because their URLs carry the content hash the page was built
 * with and only the page knows it. Importing them unversioned would let a
 * worker run last week's decoder against this week's page. So the namespace
 * they declare is reached through self, once they are in. */

/**
 * The hosted decoder, once init has built it.
 *
 * @type {?Object}
 */
var decoder = null;

/**
 * The framebuffer size most recently pushed from the main thread. The combine
 * gate's area threshold and its settle clock both read it; a worker has no
 * display to ask.
 *
 * @type {number}
 */
var fbWidth = 0;
var fbHeight = 0;

/**
 * Runtime overrides as the page last saw them. The main thread reads the
 * window globals, the query string and localStorage -- none of which a worker
 * can reach -- and pushes a snapshot whenever one changes, so that setting
 * window.__h264Chroma444 from the console still takes effect mid-session.
 *
 * @type {!Object.<string, *>}
 */
var overrides = {};

/**
 * The picture paintFrame() has taken and the next ready message will carry,
 * or null. It is held for the moment between the two because the decoder
 * finishes a frame and announces it as two steps, and transferring at the
 * first would leave the second describing something that had already gone.
 *
 * @type {?ImageBitmap}
 */
var handover = null;

/**
 * How often the worker pushes its state string to the main thread, in
 * milliseconds. describeState() is read synchronously over there -- it goes
 * into every diagnostic report -- so it cannot be a round trip, and is cached
 * from the last push instead.
 *
 * @constant
 * @type {number}
 */
var STATE_INTERVAL_MS = 5000;

var lastStatePush = 0;

/**
 * Pushes the decoder's state string, at most every STATE_INTERVAL_MS unless
 * forced -- a diagnostic is worth a fresh one, a frame is not.
 *
 * @param {boolean} [force]
 */
function pushState(force) {

    if (!decoder || !decoder.describeState)
        return;

    var now = Date.now();
    if (!force && now - lastStatePush < STATE_INTERVAL_MS)
        return;

    lastStatePush = now;

    try {
        postMessage({ t : 'state', text : decoder.describeState() });
    } catch (e) {
        /* A state string is never worth failing a session over. */
    }

}

/**
 * The host this worker presents to the decoder. Everything here is either a
 * value the main thread pushed or a worker equivalent of something the
 * document would have provided.
 *
 * @type {!Object}
 */
var workerHost = {

    /* There is no display queue here to paint in order, so a frame is
     * finished as soon as it is ready and the ordering is left to the main
     * thread, which has the queue and the layer both. */
    autoDraw : true,

    getWidth : function () {
        return fbWidth;
    },

    getHeight : function () {
        return fbHeight;
    },

    createCanvas : function (width, height) {
        return new OffscreenCanvas(width, height);
    },

    override : function (name) {
        return overrides[name];
    },

    /**
     * Takes the finished picture and hands it to the main thread.
     *
     * Returns true rather than a canvas: the probes want to read back the
     * layer the picture landed on, and the layer is on the other thread. They
     * are off by default, and what they diagnose -- a black or green display
     * -- has since been traced to its two causes, so the worker path simply
     * does without them rather than paying a readback to keep them.
     */
    paintFrame : function (frameState, snapshot) {

        if (!snapshot)
            return false;

        /* The combine path renders offscreen and already hands its drawing
         * buffer over as an ImageBitmap, which is exactly what transfers.
         * Taking it means the decoder must not close it; say so. */
        if (typeof ImageBitmap !== 'undefined'
                && snapshot instanceof ImageBitmap) {
            handover = snapshot;
            frameState.snapshotTaken = true;
            return true;
        }

        /* The 4:2:0 path snapshots into a pooled OffscreenCanvas. Handing the
         * drawing buffer over empties the canvas without freeing it, so the
         * pool keeps working and nothing is copied. */
        handover = snapshot.transferToImageBitmap();
        return true;

    }

};

/**
 * Announces a finished frame, with whatever picture it produced. One message
 * per frame, painted or not: the main thread has a display task blocked on
 * every frame submitted, and a frame that produced nothing must still release
 * it or the queue behind it stalls.
 *
 * @param {number} token
 */
function announce(token) {

    var bitmap = handover;
    handover = null;

    try {
        /* The bitmap rides in the message and is named in the transfer list:
         * the list is what makes it a move rather than a copy, and the message
         * is how the other side reaches it. */
        if (bitmap)
            postMessage({ t : 'ready', token : token, picture : bitmap },
                    [bitmap]);
        else
            postMessage({ t : 'ready', token : token, picture : null });
    } catch (e) {
        /* A picture that cannot be transferred is a picture the main thread
         * will never draw, but the task still has to be released or every
         * frame behind it stalls. */
        try {
            postMessage({ t : 'ready', token : token, picture : false });
        } catch (ignore) {
            /* Nothing left to try. */
        }
        if (bitmap) {
            try {
                bitmap.close();
            } catch (ignore) {
                /* Already gone. */
            }
        }
    }

    pushState(false);

}

onmessage = function (event) {

    var msg = event.data;
    if (!msg)
        return;

    switch (msg.t) {

        /* Load the decoder and the renderer at the versioned URLs the page
         * was built with, then construct against this host. */
        case 'init':

            fbWidth = msg.width || 0;
            fbHeight = msg.height || 0;
            overrides = msg.overrides || {};

            try {

                importScripts.apply(null, msg.scripts);

                var Guacamole = self.Guacamole;

                /* Diagnostics are a page-level concern -- client.html posts
                 * them to the server -- so they are forwarded rather than
                 * handled here. */
                Guacamole.H264Decoder.onDiagnostic = function (name, detail) {
                    pushState(true);
                    postMessage({ t : 'diag', event : name, detail : detail });
                };

                decoder = new Guacamole.H264Decoder(null, workerHost);

                postMessage({ t : 'ready-init' });

            } catch (e) {
                postMessage({
                    t     : 'init-failed',
                    error : (e && e.message) ? e.message : String(e)
                });
            }

            break;

        case 'decode':

            if (!decoder) {
                postMessage({ t : 'ready', token : msg.token, picture : false });
                return;
            }

            fbWidth = msg.width;
            fbHeight = msg.height;
            if (msg.overrides)
                overrides = msg.overrides;

            /* The token the main thread allocated is the one that comes back,
             * so the decoder's own timestamp token is not used here -- the
             * frame may be refused outright, and the display task waiting on
             * it still has to be released under the name it was filed under.
             */
            (function (token) {
                decoder.decode(null, msg.x, msg.y, msg.w, msg.h, msg.nal,
                        msg.keyFrame, msg.rects, function () {
                            announce(token);
                        }, msg.view, msg.paired);
            }(msg.token));

            break;

        /* The sync gate. The callback is already asynchronous on the main
         * thread -- it is the ack guacd paces on -- so answering it across a
         * message costs the round trip and nothing else. The 200ms timeout
         * that bounds it stays here, with the backlog it is timing. */
        case 'flush':

            (function (id) {
                if (!decoder) {
                    postMessage({ t : 'flushed', id : id });
                    return;
                }
                decoder.waitForPending(function () {
                    postMessage({ t : 'flushed', id : id });
                }, msg.flushMs);
            }(msg.id));

            break;

        case 'overrides':
            overrides = msg.overrides || {};
            break;

        case 'size':
            fbWidth = msg.width;
            fbHeight = msg.height;
            break;

        case 'probing':
            if (decoder)
                decoder.setProbing(msg.on);
            break;

        case 'reset':
            if (decoder)
                decoder.reset();
            break;

        case 'destroy':
            if (decoder)
                decoder.destroy();
            decoder = null;
            close();
            break;

    }

};
