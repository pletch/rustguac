#!/usr/bin/env node
/*
 * Pins the recovery of coalesced pointer movement.
 *
 * This path only runs when the browser has already discarded something: moves
 * merged away behind a busy main thread. That makes it close to untestable by
 * using the application -- the case it exists for is the one you cannot
 * reliably produce, and when it is broken the symptom is a drag that feels
 * slightly worse, which is what it felt like before. So the behaviour is
 * pinned here instead.
 *
 * Three things matter and none of them is obvious from reading it. The
 * dispatched position must be replayed along with the merged ones, or a
 * browser that fires no compatibility mousemove leaves the pointer one event
 * behind for the whole drag. Nothing may be replayed unless a button is held,
 * or an idle pointer multiplies a session's upstream mouse traffic for
 * movement nobody can perceive. And the existing mousemove listener must keep
 * working exactly as it did, because touch reaches it as compatibility events
 * and a counter it shares is what swallows them.
 *
 * Usage: node tests/mouse-coalesced.mjs
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
    'static/guac/Mouse.js'
].map((f) => readFile(join(root, f), 'utf8')));

/**
 * A Guacamole.Mouse on a fake element, with the listeners it attached and the
 * mousemove events it emitted both reachable.
 */
function mounted({ globals = {}, pointerEvents = true } = {}) {

    const listeners = {};
    const element = {
        offsetLeft : 0,
        offsetTop  : 0,
        offsetParent : null,
        addEventListener : (name, fn) => { (listeners[name] ||= []).push(fn); }
    };

    const sandbox = {
        console : { log() {}, warn() {}, error() {} },
        document : {
            body : {},
            documentElement : {},
            /* Only the CSS3 cursor probe in the constructor wants this. */
            createElement : () => ({ style: { cursor: '' } })
        },
        setTimeout, clearTimeout, Math, Array, Object
    };
    sandbox.window = Object.assign(sandbox, globals);
    if (pointerEvents)
        sandbox.PointerEvent = class { getCoalescedEvents() { return []; } };

    vm.createContext(sandbox);
    for (const src of sources)
        vm.runInContext(src, sandbox);

    const mouse = new sandbox.Guacamole.Mouse(element);
    const moves = [];
    mouse.onEach(['mousemove'], (e) => moves.push([e.state.x, e.state.y]));

    return {
        sandbox, mouse, moves, listeners,
        fire : (name, event) => (listeners[name] || []).forEach((fn) => fn(event)),
        has  : (name) => !!listeners[name]
    };
}

/** A DOM event, near enough: the suppression path cancels what it swallows. */
function domEvent(props) {
    return Object.assign({
        stopPropagation() {},
        preventDefault() {},
        returnValue : true
    }, props);
}

/** A pointermove carrying the positions the browser merged into it. */
function pointerMove(positions, { buttons = 1, pointerType = 'mouse' } = {}) {
    const merged = positions.map(([x, y]) => ({ clientX: x, clientY: y }));
    const last = merged[merged.length - 1];
    return domEvent({
        pointerType, buttons,
        clientX : last.clientX,
        clientY : last.clientY,
        getCoalescedEvents : () => merged
    });
}

let failures = 0;
const test = (name, fn) => {
    try { fn(); console.log(`  ok   ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('coalesced pointer movement');

test('a drag replays every position the browser merged away', () => {
    const m = mounted();
    m.fire('pointermove', pointerMove([[10, 10], [20, 22], [30, 35], [40, 50]]));
    assert.deepEqual(m.moves.map(p => [...p]),
            [[10, 10], [20, 22], [30, 35], [40, 50]]);
});

test('the dispatched position is replayed too, not assumed to follow', () => {
    /* A browser that fires no compatibility mousemove would otherwise leave
     * the pointer one event behind for the length of the drag. */
    const m = mounted();
    m.fire('pointermove', pointerMove([[1, 1], [9, 9]]));
    assert.deepEqual([...m.moves[m.moves.length - 1]], [9, 9]);
});

test('and the mousemove that follows it is not sent twice', () => {
    const m = mounted();
    const move = pointerMove([[1, 1], [9, 9]]);
    m.fire('pointermove', move);
    m.fire('mousemove', domEvent({ clientX: 9, clientY: 9 }));
    assert.equal(m.moves.length, 2, 'the repeat is dropped as unchanged');
});

test('a hover replays nothing', () => {
    const m = mounted();
    m.fire('pointermove', pointerMove([[1, 1], [5, 5], [9, 9]], { buttons: 0 }));
    assert.equal(m.moves.length, 0);
});

test('touch is left to the handling it already has', () => {
    const m = mounted();
    m.fire('pointermove', pointerMove([[1, 1], [9, 9]], { pointerType: 'touch' }));
    assert.equal(m.moves.length, 0);
});

test('a move that merged nothing is left alone', () => {
    const m = mounted();
    m.fire('pointermove', pointerMove([[7, 7]]));
    assert.equal(m.moves.length, 0, 'the mousemove listener delivers this one');
});

test('the mousemove listener still delivers on its own', () => {
    const m = mounted();
    m.fire('mousemove', domEvent({ clientX: 3, clientY: 4 }));
    assert.deepEqual([...m.moves[0]], [3, 4]);
});

test('synthetic events after touch are still swallowed, and still counted', () => {
    const m = mounted();

    m.fire('touchstart', domEvent({}));

    /* Whatever the counter is set to, a real pointermove must not sneak past
     * it -- and must not decrement it either, or the listener that is counting
     * is left counting the wrong thing. */
    m.fire('pointermove', pointerMove([[1, 1], [9, 9]]));
    assert.equal(m.moves.length, 0, 'a drag must not slip past the counter');

    for (let i = 0; i < m.mouse.touchMouseThreshold; i++)
        m.fire('mousemove', domEvent({ clientX: i, clientY: i }));
    assert.equal(m.moves.length, 0, 'the synthetic events are swallowed');

    m.fire('mousemove', domEvent({ clientX: 50, clientY: 60 }));
    assert.deepEqual([...m.moves[0]], [50, 60], 'and normal service resumes');
});

test('a flood is sampled to a bounded number, keeping the last', () => {
    const m = mounted();
    const max = m.sandbox.Guacamole.Mouse.COALESCED_MAX;
    /* From 1, not 0: a mouse starts at (0,0) and move() drops a position it
     * is already at, which would cost this test its first sample for reasons
     * that have nothing to do with sampling. */
    const flood = [];
    for (let i = 1; i <= max * 8; i++)
        flood.push([i, i * 2]);

    m.fire('pointermove', pointerMove(flood));

    assert.equal(m.moves.length, max, `expected ${max}, got ${m.moves.length}`);
    assert.deepEqual([...m.moves[m.moves.length - 1]],
            flood[flood.length - 1], 'the last position is where the pointer is');
    assert.deepEqual([...m.moves[0]], flood[0], 'and the first is where it was');

    /* Monotonic, so the path still reads as a path. */
    for (let i = 1; i < m.moves.length; i++)
        assert.ok(m.moves[i][0] > m.moves[i - 1][0], 'sampled out of order');
});

test('the override switches it off, and the mousemove path is untouched', () => {
    const m = mounted({ globals: { __mouseCoalesced: false } });
    assert.equal(m.has('pointermove'), false, 'no listener is attached at all');
    m.fire('mousemove', domEvent({ clientX: 3, clientY: 4 }));
    assert.deepEqual([...m.moves[0]], [3, 4]);
});

test('a browser without pointer events keeps the behaviour it had', () => {
    const m = mounted({ pointerEvents: false });
    assert.equal(m.has('pointermove'), false);
    m.fire('mousemove', domEvent({ clientX: 3, clientY: 4 }));
    assert.deepEqual([...m.moves[0]], [3, 4]);
});

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
