/*
 * Pointer handling for a pop-out monitor window.
 *
 * These windows do not use Guacamole.Mouse -- it does not track the X axis
 * correctly in a popup -- so they map the pointer themselves: the raw client
 * coordinate into the canvas's live on-screen rect as a 0..1 fraction, then
 * into this monitor's native pixels and on into the combined framebuffer.
 * Fraction-based and read from getBoundingClientRect() on every event, so it
 * self-recalibrates on any resize rather than caching a scale that goes stale.
 *
 * It lives in its own file because the alternative is untestable. There is no
 * way to open one of these windows without a live multi-monitor session, so
 * inline in the page the only thing a test could do is match the source text
 * and hope -- and the two things most worth checking here are a coordinate
 * mapping and a suppression rule, which are exactly the kind that look right
 * and are off by a term.
 *
 * Copyright (C) 2026 Sol1 Pty Ltd. Licensed under Apache 2.0.
 */

var Guacamole = Guacamole || {};

/**
 * Attaches pointer, wheel and context-menu handling to a pop-out monitor's
 * canvas.
 *
 * @constructor
 * @param {!Element} canvas
 *     The canvas this monitor is drawn on, in the pop-out window's document.
 *
 * @param {!function(): ?Object} getRect
 *     This monitor's rectangle within the combined framebuffer, as
 *     {left, top, width, height}, or null if the layout does not have one yet.
 *     Called per event rather than captured, because the layout changes under
 *     a running window.
 *
 * @param {!function(!Object)} sendState
 *     Called with a plain mouse state -- {x, y, left, middle, right, up, down}
 *     -- to be forwarded to the session.
 */
Guacamole.MonitorPointer = function MonitorPointer(canvas, getRect, sendState) {

    /**
     * The last state sent, as a key, so the same one is not sent twice.
     *
     * Guacamole.Mouse drops an unchanged position inside move(); this path has
     * no such check and needs one, because the coalesced replay below delivers
     * the dispatched position and the mousemove that follows delivers it
     * again. Keyed on the buttons as well as the position: a press and a
     * release happen at one place and are not repeats of each other.
     *
     * @private
     * @type {?string}
     */
    var lastSent = null;

    /**
     * Maps an event's client coordinate into the combined framebuffer and
     * sends it, unless it is a repeat of what was last sent.
     *
     * @private
     * @param {!Object} ev
     */
    function pointer(ev) {

        var rect = getRect();
        if (!rect)
            return;

        var cr = canvas.getBoundingClientRect();
        var fx = cr.width > 0 ? (ev.clientX - cr.left) / cr.width : 0;
        var fy = cr.height > 0 ? (ev.clientY - cr.top) / cr.height : 0;
        if (fx < 0) fx = 0; else if (fx > 1) fx = 1;
        if (fy < 0) fy = 0; else if (fy > 1) fy = 1;

        var state = {
            x      : rect.left + fx * rect.width,
            y      : rect.top + fy * rect.height,
            left   : (ev.buttons & 1) !== 0,
            middle : (ev.buttons & 4) !== 0,
            right  : (ev.buttons & 2) !== 0,
            up     : false,
            down   : false
        };

        var key = state.x + ',' + state.y + ',' + ev.buttons;
        if (key !== lastSent) {
            lastSent = key;
            sendState(state);
        }

        if (ev.preventDefault)
            ev.preventDefault();

    }

    /* Replay the moves the browser merged away during a drag, on the same
     * terms as Guacamole.Mouse does for the main display: a busy main thread
     * discards pointer movement rather than delaying it, and a dragged
     * scrollbar thumb is dropped rather than lagged. Additive -- the mousemove
     * listener below is unchanged and still delivers every position it did,
     * and the one they both deliver is dropped by the check above.
     *
     * Feature-detected on the event rather than on PointerEvent, because a
     * pop-out window is a realm of its own: the constructor the page that
     * opened it can see is not the one that made this event. */
    canvas.addEventListener('pointermove', function (ev) {

        if (ev.pointerType !== 'mouse' || !ev.buttons)
            return;

        if (!Guacamole.Mouse.coalescedMovement
                || typeof ev.getCoalescedEvents !== 'function')
            return;

        var merged = ev.getCoalescedEvents();
        if (!merged || merged.length <= 1)
            return;

        var events = Guacamole.Mouse.sampleCoalesced(merged);
        for (var i = 0; i < events.length; i++)
            pointer(events[i]);

    });

    canvas.addEventListener('mousedown', pointer);
    canvas.addEventListener('mousemove', pointer);
    canvas.addEventListener('mouseup', pointer);

    canvas.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
    });

    /* Scroll wheel -> momentary up/down button. */
    canvas.addEventListener('wheel', function (ev) {

        var rect = getRect();
        if (!rect)
            return;

        var cr = canvas.getBoundingClientRect();
        var fx = cr.width > 0 ? (ev.clientX - cr.left) / cr.width : 0;
        var fy = cr.height > 0 ? (ev.clientY - cr.top) / cr.height : 0;
        if (fx < 0) fx = 0; else if (fx > 1) fx = 1;
        if (fy < 0) fy = 0; else if (fy > 1) fy = 1;

        var dir = ev.deltaY < 0 ? 'up' : 'down';

        /* Two states, not one mutated between the sends. Sending the same
         * object twice and changing it in between only works while every
         * consumer copies it synchronously -- client.html does, by wrapping it
         * in a Guacamole.Mouse.State -- and silently sends the wrong thing to
         * one that does not. A momentary button press is exactly the shape
         * where that would be missed, since the second state is the one that
         * survives. */
        function wheelState(pressed) {
            var state = {
                x : rect.left + fx * rect.width,
                y : rect.top + fy * rect.height,
                left : false, middle : false, right : false,
                up : false, down : false
            };
            state[dir] = pressed;
            return state;
        }

        sendState(wheelState(true));
        sendState(wheelState(false));

        /* Sent behind pointer()'s back, so what it last saw is no longer what
         * the session last got. */
        lastSent = null;

        ev.preventDefault();

    }, { passive : false });

};
