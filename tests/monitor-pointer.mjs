#!/usr/bin/env node
/*
 * Pins pointer handling in the pop-out monitor windows.
 *
 * These windows cannot be opened without a live multi-monitor session, so
 * until this logic was lifted out of client.html the only thing a test could
 * do was match the source text. The two things most worth checking here are a
 * coordinate mapping and a suppression rule, and both are the kind that look
 * right in a diff and are off by a term.
 *
 * The mapping matters because it is not Guacamole.Mouse's -- these windows map
 * the pointer themselves, from the canvas's live on-screen rect into this
 * monitor's slice of the combined framebuffer, and a wrong offset there sends
 * every click to the wrong head. The suppression matters because it is the one
 * place on this branch where something that used to happen no longer does:
 * this path used to send unconditionally and now drops a repeat of what it
 * last sent.
 *
 * Usage: node tests/monitor-pointer.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sources = await Promise.all([
    'static/guac/Namespace.js',
    'static/guac/Event.js',
    'static/guac/Position.js',
    'static/guac/Mouse.js',
    'static/guac/MonitorPointer.js'
].map((f) => readFile(join(root, f), 'utf8')));

/**
 * A monitor pointer on a fake canvas, with what it sent and the listeners it
 * attached both reachable.
 *
 * The canvas sits at (100, 50) on screen and is 800x400 there, while the
 * monitor it shows is 1920x1080 native at (2560, 0) in the combined
 * framebuffer -- a second head, offset, and scaled down on screen. Deliberately
 * none of those numbers are the same, so a mapping that drops a term or uses
 * the wrong rect cannot land on the right answer by luck.
 */
function mounted({ rect = { left: 2560, top: 0, width: 1920, height: 1080 } } = {}) {

    const sent = [];
    const listeners = {};

    const canvas = {
        addEventListener : (name, fn) => { (listeners[name] ||= []).push(fn); },
        getBoundingClientRect : () => ({ left: 100, top: 50, width: 800, height: 400 })
    };

    const sandbox = {
        console : { log() {}, warn() {}, error() {} },
        document : { body: {}, documentElement: {},
                     createElement: () => ({ style: { cursor: '' } }) },
        Math, Object, Array,
        PointerEvent : class { getCoalescedEvents() { return []; } }
    };
    sandbox.window = sandbox;
    sandbox.window.localStorage = null;
    sandbox.window.location = { search: '' };

    vm.createContext(sandbox);
    for (const src of sources)
        vm.runInContext(src, sandbox);

    let current = rect;
    sandbox.Guacamole.MonitorPointer(canvas, () => current,
            (state) => sent.push(state));

    return {
        sandbox, sent, listeners,
        setRect : (r) => { current = r; },
        fire : (name, ev) => (listeners[name] || []).forEach((fn) => fn(ev)),
        has  : (name) => !!listeners[name]
    };
}

/** A DOM-ish event at a screen position. */
function at(clientX, clientY, buttons = 0, extra = {}) {
    return Object.assign({
        clientX, clientY, buttons,
        preventDefault() { this.defaultPrevented = true; }
    }, extra);
}

/** A pointermove carrying the positions the browser merged into it. */
function merged(positions, { buttons = 1, pointerType = 'mouse' } = {}) {
    const events = positions.map(([x, y]) => at(x, y, buttons));
    const last = events[events.length - 1];
    return at(last.clientX, last.clientY, buttons, {
        pointerType, getCoalescedEvents : () => events
    });
}

let failures = 0;
const test = (name, fn) => {
    try { fn(); console.log(`  ok   ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('pop-out monitor pointer');

/* ── The mapping ─────────────────────────────────────────────────────── */

test('the centre of the canvas is the centre of that monitor', () => {
    const m = mounted();
    m.fire('mousemove', at(100 + 400, 50 + 200));
    assert.deepEqual([m.sent[0].x, m.sent[0].y], [2560 + 960, 540]);
});

test('the origin of the canvas is the origin of that monitor', () => {
    const m = mounted();
    m.fire('mousemove', at(100, 50));
    assert.deepEqual([m.sent[0].x, m.sent[0].y], [2560, 0],
            "a second head's offset must be added, not assumed to be zero");
});

test('a position outside the canvas is clamped to it', () => {
    const m = mounted();
    m.fire('mousemove', at(-500, -500));
    assert.deepEqual([m.sent[0].x, m.sent[0].y], [2560, 0]);
    m.fire('mousemove', at(99999, 99999));
    assert.deepEqual([m.sent[1].x, m.sent[1].y], [2560 + 1920, 1080]);
});

test('the layout is read per event, not captured when the window opened', () => {
    const m = mounted();
    m.fire('mousemove', at(500, 250));
    m.setRect({ left: 0, top: 1080, width: 3840, height: 2160 });
    m.fire('mousemove', at(500, 250));
    assert.notDeepEqual([m.sent[0].x, m.sent[0].y], [m.sent[1].x, m.sent[1].y],
            'a monitor moved in the layout must move on the wire');
});

test('nothing is sent while the layout has no rectangle for this monitor', () => {
    const m = mounted({ rect: null });
    m.fire('mousemove', at(500, 250));
    m.fire('wheel', at(500, 250, 0, { deltaY: -1 }));
    assert.equal(m.sent.length, 0);
});

/* ── The buttons ─────────────────────────────────────────────────────── */

test('the button mask is decoded, not passed through', () => {
    const m = mounted();
    /* DOM buttons: 1 left, 2 RIGHT, 4 middle -- which is not the order the
     * Guacamole state uses, and transposing the middle and right is the
     * classic way to get this wrong. */
    m.fire('mousedown', at(500, 250, 1));
    m.fire('mousedown', at(500, 250, 2));
    m.fire('mousedown', at(500, 250, 4));
    assert.deepEqual(m.sent.map(s => [s.left, s.middle, s.right]),
            [[true, false, false], [false, false, true], [false, true, false]]);
});

/* ── The suppression ─────────────────────────────────────────────────── */

test('the same state is not sent twice', () => {
    const m = mounted();
    m.fire('mousemove', at(500, 250));
    m.fire('mousemove', at(500, 250));
    m.fire('mousemove', at(500, 250));
    assert.equal(m.sent.length, 1);
});

test('a press and a release at one position are not repeats of each other', () => {
    const m = mounted();
    m.fire('mousedown', at(500, 250, 1));
    m.fire('mousemove', at(500, 250, 1));
    m.fire('mouseup', at(500, 250, 0));
    assert.deepEqual(m.sent.map(s => s.left), [true, false],
            'the move between them is the repeat; the release is not');
});

test('the wheel clears the suppression it sends behind the back of', () => {
    const m = mounted();
    m.fire('mousemove', at(500, 250));
    const before = m.sent.length;

    m.fire('wheel', at(500, 250, 0, { deltaY: -1 }));
    assert.equal(m.sent.length, before + 2, 'a wheel click is press then release');
    assert.equal(m.sent[before].up, true);
    assert.equal(m.sent[before + 1].up, false);

    /* Without the reset this position is still what pointer() thinks it last
     * sent, and the pointer would go silent at the spot the user scrolled. */
    m.fire('mousemove', at(500, 250));
    assert.equal(m.sent.length, before + 3,
            'the position the wheel moved away from must be sendable again');
});

test('the wheel direction follows the sign of the delta', () => {
    const m = mounted();
    m.fire('wheel', at(500, 250, 0, { deltaY: -1 }));
    m.fire('wheel', at(500, 250, 0, { deltaY: 1 }));
    assert.deepEqual(m.sent.map(s => [s.up, s.down]),
            [[true, false], [false, false], [false, true], [false, false]]);
});

/* ── The coalesced replay ────────────────────────────────────────────── */

test('a drag replays every position the browser merged away', () => {
    const m = mounted();
    m.fire('pointermove', merged([[200, 100], [300, 150], [400, 200], [500, 250]]));
    assert.equal(m.sent.length, 4);
    assert.deepEqual([m.sent[0].x, m.sent[0].y], [2560 + 240, 135]);
    assert.deepEqual([m.sent[3].x, m.sent[3].y], [2560 + 960, 540]);
});

test('and the mousemove that follows it is not sent again', () => {
    const m = mounted();
    m.fire('pointermove', merged([[200, 100], [500, 250]]));
    m.fire('mousemove', at(500, 250, 1));
    assert.equal(m.sent.length, 2);
});

test('a hover replays nothing', () => {
    const m = mounted();
    m.fire('pointermove', merged([[200, 100], [500, 250]], { buttons: 0 }));
    assert.equal(m.sent.length, 0);
});

test('touch is left to the handling it already has', () => {
    const m = mounted();
    m.fire('pointermove', merged([[200, 100], [500, 250]], { pointerType: 'touch' }));
    assert.equal(m.sent.length, 0);
});

test('a move that merged nothing is left to the mousemove listener', () => {
    const m = mounted();
    m.fire('pointermove', merged([[500, 250]]));
    assert.equal(m.sent.length, 0);
});

test('a flood is bounded by the same rule the main display uses', () => {
    const m = mounted();
    const max = m.sandbox.Guacamole.Mouse.COALESCED_MAX;
    const flood = [];
    for (let i = 1; i <= max * 8; i++) flood.push([100 + i, 50 + i]);
    m.fire('pointermove', merged(flood));
    assert.equal(m.sent.length, max);
});

test('the override switches the replay off and leaves the rest alone', () => {
    const m = mounted();
    m.sandbox.Guacamole.Mouse.coalescedMovement = false;
    m.fire('pointermove', merged([[200, 100], [500, 250]]));
    assert.equal(m.sent.length, 0, 'no replay');
    m.fire('mousemove', at(500, 250, 1));
    assert.equal(m.sent.length, 1, 'and the ordinary path still works');
});

/* ── The rest of the contract ────────────────────────────────────────── */

test('the context menu is suppressed, or right-click never reaches the host', () => {
    const m = mounted();
    assert.ok(m.has('contextmenu'));
    const ev = at(500, 250, 2);
    m.fire('contextmenu', ev);
    assert.ok(ev.defaultPrevented);
});

test('the browser is stopped from acting on what it is given', () => {
    const m = mounted();
    const move = at(500, 250, 1);
    m.fire('mousemove', move);
    assert.ok(move.defaultPrevented, 'or the popup selects and drags its own canvas');
    const wheel = at(500, 250, 0, { deltaY: -1 });
    m.fire('wheel', wheel);
    assert.ok(wheel.defaultPrevented, 'or the popup scrolls itself');
});

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
