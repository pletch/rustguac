/*
 * What the main thread is doing, and what that costs the person using it.
 *
 * The decoder can now be hosted on a worker, and every instrument this project
 * already has would report that as an improvement whether or not it was one:
 * h264CombineLog and sync_hold both run beside the decoder, so moving the
 * decoder moves them, and they would show the same work getting cheaper by
 * being measured somewhere less contended. Nothing measured the thread the
 * work was moved off, which is the only thread the change is about.
 *
 * So this measures the main thread, from the page, identically in both modes:
 *
 *   - how much of it is unavailable, from the long-task observer. This is the
 *     headline: a blocked main thread is one that cannot answer an event.
 *
 *   - what H.264 painting costs on it, which is the whole picture in the local
 *     mode and one blit in the worker mode. The difference between those two
 *     numbers is what was moved.
 *
 *   - what input actually got. Delay comes from the event-timing observer --
 *     `processingStart - startTime` is the wait before a handler ran, which is
 *     exactly what a blocked thread adds. Fidelity comes from counting the
 *     moves the browser coalesced away, because a drag does not degrade
 *     gracefully: the intermediate positions of a drag are discarded rather
 *     than delayed, and a scrollbar thumb is lost rather than slow.
 *
 * Off unless h264MainThreadLog or h264CombineLog asks for it -- one flag for
 * the numbers on both sides of the boundary, since the comparison needs both.
 *
 * Copyright (C) 2026 Sol1 Pty Ltd. Licensed under Apache 2.0.
 */

var Guacamole = Guacamole || {};

/**
 * Main-thread occupancy and input cost, reported periodically while asked for.
 *
 * @namespace
 */
Guacamole.MainThreadLoad = (function defineMainThreadLoad() {

    /**
     * How often the window is reported and reset, in milliseconds. The same
     * five seconds h264CombineLog uses, so the two line up when read together.
     *
     * @private
     * @constant
     * @type {number}
     */
    var REPORT_MS = 5000;

    /**
     * A task holding the main thread for longer than this is a long task, by
     * the specification's definition, and everything past it is time an event
     * could not be answered in.
     *
     * @private
     * @constant
     * @type {number}
     */
    var LONG_TASK_MS = 50;

    /**
     * The shortest event the event-timing observer will report. 16ms is the
     * smallest it accepts, and is about a frame: anything under it is not a
     * delay anyone can feel, and asking for everything would report most of a
     * session.
     *
     * @private
     * @constant
     * @type {number}
     */
    var EVENT_THRESHOLD_MS = 16;

    /**
     * A pointer move arriving this long after the previous one, while a button
     * is held, is a candidate gap in a drag. Two frames: one is ordinary
     * jitter.
     *
     * It is only counted as a gap if the move that ends it carries merged
     * positions -- see the handler. A gap on its own says nothing: the
     * commonest cause by far is a hand that stopped moving, and counting those
     * made the column disagree with everything beside it. Measured on a
     * Windows client 2026-09-13, the worker path reported six drag gaps up to
     * 585ms in a window whose main thread was blocked for 0ms and which
     * recorded no slow input events at all -- three instruments in one line,
     * two of them right.
     *
     * @private
     * @constant
     * @type {number}
     */
    var DRAG_GAP_MS = 33;

    var active = false;
    var mode = 'main';
    var windowStart = 0;
    var timer = null;
    var counters = null;

    /**
     * A fresh window. Every field is a count or a sum of milliseconds, so that
     * the report divides rather than infers.
     *
     * @private
     */
    function newWindow() {
        return {
            longTasks    : 0,
            blockedMs    : 0,
            longestMs    : 0,

            draws        : 0,
            drawMs       : 0,
            drawMaxMs    : 0,

            decodes      : 0,
            decodeMs     : 0,
            decodeMaxMs  : 0,

            moves        : 0,
            coalesced    : 0,
            dragMoves    : 0,
            dragGaps     : 0,
            dragGapMaxMs : 0,

            slowEvents   : 0,
            delaySumMs   : 0,
            delayMaxMs   : 0
        };
    }

    function now() {
        return (typeof performance !== 'undefined' && performance.now)
                ? performance.now() : Date.now();
    }

    function pct(part, whole) {
        return whole > 0 ? (100 * part / whole).toFixed(1) + '%' : '0%';
    }

    /**
     * Starts a performance observer, or returns false where the browser has no
     * such entry type. Both of these are Chromium-only at the time of writing,
     * and a browser without them still runs the session -- it just cannot be
     * measured, which is worth saying once rather than failing.
     *
     * @private
     * @param {!Object} options - Passed to observe().
     * @param {!function(!Object)} handler - Called per entry.
     * @returns {boolean}
     */
    function observe(options, handler) {

        if (typeof PerformanceObserver === 'undefined')
            return false;

        var supported = PerformanceObserver.supportedEntryTypes;
        if (supported && supported.indexOf(options.type) === -1)
            return false;

        try {
            new PerformanceObserver(function (list) {
                var entries = list.getEntries();
                for (var i = 0; i < entries.length; i++)
                    handler(entries[i]);
            }).observe(options);
            return true;
        } catch (e) {
            return false;
        }

    }

    function report() {

        var elapsed = now() - windowStart;
        var c = counters;

        counters = newWindow();
        windowStart = now();

        /* A window with nothing in it is a session with no video and no
         * input, which is worth no line at all. Slow events count: a window
         * whose only content is input arriving late is the one most worth
         * reporting, and leaving it out made exactly that case silent. */
        if (!c.longTasks && !c.draws && !c.moves && !c.slowEvents
                && !c.decodes)
            return;

        var parts = [];

        parts.push('mode=' + mode);
        parts.push('over ' + (elapsed / 1000).toFixed(1) + 's');

        parts.push('blocked ' + c.blockedMs.toFixed(0) + 'ms in ' + c.longTasks
                + ' long tasks (' + pct(c.blockedMs, elapsed) + ', longest '
                + c.longestMs.toFixed(0) + 'ms)');

        parts.push('h264 output ' + c.decodeMs.toFixed(0) + 'ms over '
                + c.decodes + ' callbacks (' + pct(c.decodeMs, elapsed) + ', '
                + (c.decodes ? (c.decodeMs / c.decodes).toFixed(2) : '0')
                + 'ms mean, ' + c.decodeMaxMs.toFixed(1) + 'ms max)');

        parts.push('h264 draw ' + c.drawMs.toFixed(0) + 'ms over ' + c.draws
                + ' pictures (' + pct(c.drawMs, elapsed) + ', '
                + (c.draws ? (c.drawMs / c.draws).toFixed(2) : '0') + 'ms mean, '
                + c.drawMaxMs.toFixed(1) + 'ms max)');

        parts.push('pointer ' + c.moves + ' moves, ' + (c.coalesced - c.moves)
                + ' coalesced away (' + pct(c.coalesced - c.moves, c.coalesced)
                + '), ' + c.dragMoves + ' dragging with ' + c.dragGaps
                + ' gaps (max ' + c.dragGapMaxMs.toFixed(0) + 'ms)');

        parts.push('input delay ' + c.slowEvents + ' slow events, mean '
                + (c.slowEvents ? (c.delaySumMs / c.slowEvents).toFixed(1) : '0')
                + 'ms, max ' + c.delayMaxMs.toFixed(0) + 'ms');

        console.log('[rustguac] main_thread ' + parts.join(' | '));

    }

    return {

        /**
         * Whether anything is being measured. Read on the painting path once
         * per picture, so it is a property rather than a call.
         *
         * @type {boolean}
         */
        active : false,

        /**
         * Begins measuring, if the page has asked for it.
         *
         * @param {Object} [reader]
         *     Something with an override(name) method. Defaults to the
         *     decoder's own direct host, which is where these flags are read
         *     from everywhere else.
         */
        start : function (reader) {

            if (active)
                return;

            reader = reader || (Guacamole.H264Decoder
                    && Guacamole.H264Decoder.directHost
                    && Guacamole.H264Decoder.directHost(null));

            if (!reader)
                return;

            var wanted = reader.override('h264MainThreadLog');
            if (wanted === undefined)
                wanted = reader.override('h264CombineLog');
            if (!wanted)
                return;

            active = true;
            this.active = true;
            counters = newWindow();
            windowStart = now();

            var haveTasks = observe({ type : 'longtask', buffered : false },
                function (entry) {
                    counters.longTasks++;
                    var blocking = entry.duration - LONG_TASK_MS;
                    counters.blockedMs += blocking > 0 ? blocking : 0;
                    if (entry.duration > counters.longestMs)
                        counters.longestMs = entry.duration;
                });

            var haveEvents = observe({
                    type              : 'event',
                    durationThreshold : EVENT_THRESHOLD_MS,
                    buffered          : false
                }, function (entry) {
                    /* The wait before the handler ran, which is what a blocked
                     * thread adds and what the rest of the entry's duration is
                     * not. */
                    var delay = entry.processingStart - entry.startTime;
                    if (!(delay > 0))
                        return;
                    counters.slowEvents++;
                    counters.delaySumMs += delay;
                    if (delay > counters.delayMaxMs)
                        counters.delayMaxMs = delay;
                });

            if (!haveTasks || !haveEvents)
                console.warn('[rustguac] main_thread: this browser reports'
                        + (haveTasks ? '' : ' no long tasks')
                        + (haveTasks || haveEvents ? '' : ' and')
                        + (haveEvents ? '' : ' no event timing')
                        + '; those columns will read zero');

            timer = setInterval(report, REPORT_MS);

            console.log('[rustguac] main_thread: measuring, reporting every '
                    + (REPORT_MS / 1000) + 's');

        },

        /**
         * Names where the decoder is hosted, so a report says which of the two
         * it is a measurement of.
         *
         * @param {!string} name - 'worker' or 'main'.
         */
        setMode : function (name) {
            mode = name;
        },

        /**
         * Charges main-thread time to the H.264 painting path.
         *
         * This is the number the whole exercise turns on: in the local mode it
         * is the decode's snapshot blitted into the layer, and in the worker
         * mode it is one blit of a bitmap that arrived ready. Everything else
         * that used to sit between those two -- the plane read-back above all
         * -- is either here or on the other thread, and this says which.
         *
         * @param {!number} ms
         */
        /**
         * Charges main-thread time to the decoder's output callback, which is
         * where the combine runs and therefore what a worker actually removes.
         * Never called when the decoder is hosted on one -- that time is not
         * this thread's.
         *
         * @param {!number} ms
         */
        noteDecodeWork : function (ms) {
            if (!active)
                return;
            counters.decodes++;
            counters.decodeMs += ms;
            if (ms > counters.decodeMaxMs)
                counters.decodeMaxMs = ms;
        },

        noteDraw : function (ms) {
            if (!active)
                return;
            counters.draws++;
            counters.drawMs += ms;
            if (ms > counters.drawMaxMs)
                counters.drawMaxMs = ms;
        },

        /**
         * Watches an element's pointer moves, passively and without taking
         * part in input handling -- Guacamole.Mouse keeps its own listeners
         * and its own behaviour, and this must not change either.
         *
         * getCoalescedEvents() is the point: it returns the moves the browser
         * merged into the one that was dispatched. Their count against the
         * dispatch count is the fidelity a drag actually got.
         *
         * @param {!Element} element
         */
        watchInput : function (element) {

            if (!active || !element || !element.addEventListener)
                return;

            /* Null rather than zero: a timestamp is a valid zero, and using
             * it as the sentinel swallowed the gap after the first move of a
             * drag -- which is the one a drag is most likely to lose. */
            var lastMoveAt = null;

            element.addEventListener('pointermove', function (e) {

                var merged = e.getCoalescedEvents
                        ? (e.getCoalescedEvents().length || 1) : 1;

                counters.moves++;
                counters.coalesced += merged;

                /* Dragging is where the loss is felt, so it is counted apart:
                 * a video degrades gracefully under the same load and a drag
                 * does not. */
                if (e.buttons) {

                    counters.dragMoves++;

                    var at = now();
                    if (lastMoveAt !== null) {

                        var gap = at - lastMoveAt;

                        /* A gap is only movement that was lost if the pointer
                         * was moving through it, and the merged positions are
                         * the proof: the browser has just handed over the
                         * moves it did not dispatch. One position after a long
                         * silence is a pointer that was standing still, which
                         * is not a fault and must not be counted as one. */
                        if (gap > DRAG_GAP_MS && merged > 1) {
                            counters.dragGaps++;
                            if (gap > counters.dragGapMaxMs)
                                counters.dragGapMaxMs = gap;
                        }

                    }
                    lastMoveAt = at;

                }

                else
                    lastMoveAt = null;

            }, { passive : true, capture : true });

        },

        /**
         * Stops measuring and reports whatever the last window held.
         */
        stop : function () {
            if (!active)
                return;
            report();
            clearInterval(timer);
            timer = null;
            active = false;
            this.active = false;
        }

    };

}());
