/*
 * Controlled A/B for the H.264 decoder worker, pasted into the client's
 * DevTools console.
 *
 * The first comparison of the two hosts was not controlled: the windows came
 * from whatever was happening on screen at the time, so the worker looked
 * worse on throughput and there was no way to tell that from the workload
 * being different. This drives the session itself -- the same deterministic
 * pointer path, the same number of events, on the same schedule, for the same
 * duration -- so the two runs differ in one thing.
 *
 * Run it twice:
 *
 *   localStorage.setItem('h264Worker','on');  localStorage.setItem('h264CombineLog','on');
 *   -- relaunch the session from Connections, then paste this --
 *
 *   localStorage.setItem('h264Worker','off');
 *   -- relaunch again, paste again --
 *
 * A relaunch is required either way: both flags are read once, when the
 * decoder and the page are built. A console global does nothing.
 *
 * It only moves the pointer. No clicks, no keys, nothing that changes the
 * remote machine.
 */
(async function workerAB() {

    var DURATION_MS = 60000;   // one minute of identical work per arm
    var EVENT_HZ    = 120;     // pointer moves a second, scheduled by clock

    var client = window.__guac_client;
    if (!client || !client.getDisplay)
        throw new Error('no Guacamole client on this page -- is this a /client/ tab?');

    var display = client.getDisplay();
    var element = display.getElement();
    var decoder = client._h264Decoder;

    if (!decoder)
        throw new Error('no H.264 decoder yet -- let the session paint once, then re-run');

    /* A disconnected session sits behind an overlay and still answers every
     * question asked of it: the client object is there, the decoder is there,
     * describeState() returns the counts it had when the tunnel died. Driving
     * one produces a full set of confident zeroes. Checked here because it
     * happened -- twenty seconds of input into a dead session, and the
     * conclusion drawn was that the workload did not damage the screen. */
    var overlay = document.getElementById('disconnected-overlay');
    if (overlay && getComputedStyle(overlay).display !== 'none')
        throw new Error('this session is disconnected -- reconnect and re-run');

    function submitted() {
        var m = decoder.describeState().match(/submitted=(\d+)/);
        return m ? +m[1] : 0;
    }

    var onWorker = !!(window.Guacamole.H264DecoderProxy
            && decoder instanceof window.Guacamole.H264DecoderProxy);

    /* ---- capture what the instruments say, without losing the console ---- */

    var captured = [];
    var origLog = console.log.bind(console);
    console.log = function () {
        var s = Array.prototype.join.call(arguments, ' ');
        if (/main_thread|H\.264 over|chroma_suspended|chroma_resumed|sync_hold/.test(s))
            captured.push(s);
        return origLog.apply(null, arguments);
    };

    /* ---- the workload: a fixed path, on the clock ---- */

    var rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height)
        throw new Error('the display has no size on screen');

    /* A zig-zag that crosses the whole surface, so damage lands at both ends
     * of the frame rather than in one place -- the shape that stresses the
     * copy hardest. Deterministic: the same i gives the same point. */
    function pointAt(i) {
        var t = (i % 240) / 240;                 // one sweep every two seconds
        var band = Math.floor(i / 240) % 2;      // alternate top and bottom
        var x = rect.left + rect.width  * (0.08 + 0.84 * (t < 0.5 ? t * 2 : 2 - t * 2));
        var y = rect.top  + rect.height * (band ? 0.86 : 0.08)
                          + rect.height * 0.06 * Math.sin(i / 7);
        return { x: Math.round(x), y: Math.round(y) };
    }

    function move(p) {
        element.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, cancelable: true, view: window,
            clientX: p.x, clientY: p.y, buttons: 0
        }));
    }

    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    console.info('[ab] ' + (onWorker ? 'WORKER' : 'MAIN THREAD') + ' arm: '
            + (DURATION_MS / 1000) + 's, ' + EVENT_HZ + ' moves/s. Leave the tab '
            + 'focused and do not touch the mouse.');

    var picturesAtStart = submitted();
    var started = performance.now();
    var interval = 1000 / EVENT_HZ;
    var intended = Math.floor(DURATION_MS / interval);
    var sent = 0;

    /* Scheduled against the clock rather than by sleeping a fixed amount, so a
     * blocked thread shows up as events it could not deliver rather than as a
     * quietly longer run. That shortfall is itself a measurement. */
    while (performance.now() - started < DURATION_MS) {
        var due = started + sent * interval;
        if (performance.now() >= due) { move(pointAt(sent)); sent++; }
        else await sleep(1);
    }

    await sleep(6000);          // let the last reporting window close
    console.log = origLog;

    /* ---- read the instruments back ---- */

    function sum(re, idx) {
        var total = 0;
        captured.forEach(function (l) {
            var m = l.match(re);
            if (m) total += parseFloat(m[idx]);
        });
        return total;
    }

    var windows = captured.filter(function (l) { return /main_thread mode=/.test(l); });

    var out = {
        arm            : onWorker ? 'worker' : 'main',
        framebuffer    : display.getWidth() + 'x' + display.getHeight(),
        devicePixelRatio: window.devicePixelRatio,
        seconds        : +((performance.now() - started) / 1000).toFixed(1),

        movesIntended  : intended,
        movesDelivered : sent,
        moveShortfall  : +(100 * (1 - sent / intended)).toFixed(1) + '%',

        reportWindows  : windows.length,
        blockedMs      : +sum(/blocked (\d+)ms/, 1).toFixed(0),
        longTasks      : +sum(/in (\d+) long tasks/, 1).toFixed(0),
        h264OutputMs   : +sum(/h264 output (\d+)ms/, 1).toFixed(0),
        h264OutputCalls: +sum(/h264 output \d+ms over (\d+) callbacks/, 1).toFixed(0),
        h264DrawMs     : +sum(/h264 draw (\d+)ms/, 1).toFixed(0),
        slowInput      : +sum(/input delay (\d+) slow events/, 1).toFixed(0),
        maxInputDelayMs: Math.max.apply(null, [0].concat(captured.map(function (l) {
                            var m = l.match(/input delay .*max (\d+)ms/);
                            return m ? +m[1] : 0; }))),

        combining      : /combining=true/.test(decoder.describeState()),
        suspensions    : captured.filter(function (l) { return /chroma_suspended/.test(l); }).length,
        state          : decoder.describeState()
    };

    /* Share of the run spent in the decoder's output callback -- the number the
     * whole exercise is about. Zero on the worker by construction. */
    out.outputShare = (100 * out.h264OutputMs / (out.seconds * 1000)).toFixed(1) + '%';

    /* How much work the arm actually saw. The first comparison of the two
     * hosts failed on exactly this: the windows were not carrying the same
     * load and nothing in the output said so. Compare these between the two
     * runs before comparing anything else -- if they differ much, the rest is
     * not a comparison. */
    out.pictures = submitted() - picturesAtStart;
    out.picturesPerSecond = +(out.pictures / out.seconds).toFixed(1);

    if (!out.pictures)
        console.warn('[ab] NO PICTURES DECODED during this run. The session was '
                + 'idle or the workload damaged nothing -- these numbers measure '
                + 'nothing and must not be compared.');
    if (!out.reportWindows)
        console.warn('[ab] no main_thread lines: this build has no '
                + 'MainThreadLoad (it is on the worker branch), or '
                + 'h264CombineLog/h264MainThreadLog was not set before the '
                + 'session was launched.');

    console.info('[ab] ---------- ' + out.arm.toUpperCase() + ' ----------');
    console.table([out]);
    console.info('[ab] paste this back:');
    console.info(JSON.stringify(out, null, 1));
    return out;

}());
