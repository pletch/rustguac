#!/usr/bin/env node
/*
 * Pins what the main-thread instrument reports.
 *
 * This is the instrument the worker decoder will be judged by, and the
 * instruments in this project have a history of being confidently wrong: a
 * benchmark that could not see the dominant cost by construction, a combine
 * log that timed GPU submission and reported the work at a quarter of its
 * price, a damage figure that was right three times running while the label on
 * it was wrong. An instrument that is only ever read in a browser, beside the
 * change it is measuring, is one nobody can contradict.
 *
 * So the arithmetic is checked here, against numbers whose answers are known:
 * blocking time is what a long task costs past the 50ms it is allowed, input
 * delay is the wait before a handler ran and not the duration of the handler,
 * and the coalesced count is the moves the browser merged away rather than the
 * moves it delivered.
 *
 * Usage: node tests/main-thread-load.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(join(root, 'static/guac/MainThreadLoad.js'), 'utf8');

function make({ flags = {}, entryTypes = ['longtask', 'event'] }) {
    const logs = [];
    const observers = [];
    const sandbox = {
        console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
        performance: { now: () => sandbox.__now },
        Date,
        setInterval: (fn) => { sandbox.__tick = fn; return 1; },
        clearInterval: () => {},
        PerformanceObserver: class {
            static supportedEntryTypes = entryTypes;
            constructor(cb) { this.cb = cb; }
            observe(opts) { observers.push({ opts, cb: this.cb }); }
        }
    };
    sandbox.__now = 0;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'MainThreadLoad.js' });
    sandbox.Guacamole.H264Decoder = { directHost: () => ({ override: (n) => flags[n] }) };
    return { sandbox, logs, observers,
        feed: (type, entry) => observers.filter(o => o.opts.type === type)
                .forEach(o => o.cb({ getEntries: () => [entry] })) };
}

console.log('main-thread instrument');

let fails = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); } catch (e) { fails++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

t('stays off with no flag', () => {
    const { sandbox } = make({ flags: {} });
    sandbox.Guacamole.MainThreadLoad.start();
    assert.equal(sandbox.Guacamole.MainThreadLoad.active, false);
});

t('h264CombineLog alone turns it on', () => {
    const { sandbox } = make({ flags: { h264CombineLog: true } });
    sandbox.Guacamole.MainThreadLoad.start();
    assert.equal(sandbox.Guacamole.MainThreadLoad.active, true);
});

t('h264MainThreadLog off beats h264CombineLog on', () => {
    const { sandbox } = make({ flags: { h264MainThreadLog: false, h264CombineLog: true } });
    sandbox.Guacamole.MainThreadLoad.start();
    assert.equal(sandbox.Guacamole.MainThreadLoad.active, false);
});

t('counts blocking time past the 50ms a long task is allowed', () => {
    const h = make({ flags: { h264MainThreadLog: true } });
    const M = h.sandbox.Guacamole.MainThreadLoad;
    M.start();
    h.feed('longtask', { duration: 130 });
    h.feed('longtask', { duration: 60 });
    h.sandbox.__now = 5000;
    h.sandbox.__tick();
    const line = h.logs.find(l => l.includes('main_thread mode='));
    assert.ok(line.includes('blocked 90ms in 2 long tasks'), line);
    assert.ok(line.includes('longest 130ms'), line);
    assert.ok(line.includes('(1.8%'), line);
});

t('counts the moves the browser coalesced away', () => {
    const h = make({ flags: { h264MainThreadLog: true } });
    const M = h.sandbox.Guacamole.MainThreadLoad;
    M.start();
    let handler = null;
    M.watchInput({ addEventListener: (n, fn) => { if (n === 'pointermove') handler = fn; } });
    // Four dispatches carrying ten real moves between them.
    handler({ buttons: 1, getCoalescedEvents: () => new Array(4) });
    h.sandbox.__now = 100;
    handler({ buttons: 1, getCoalescedEvents: () => new Array(3) });
    handler({ buttons: 0, getCoalescedEvents: () => new Array(2) });
    handler({ buttons: 0, getCoalescedEvents: () => new Array(1) });
    h.sandbox.__now = 5000;
    h.sandbox.__tick();
    const line = h.logs.find(l => l.includes('main_thread mode='));
    assert.ok(line.includes('pointer 4 moves, 6 coalesced away (60.0%)'), line);
    assert.ok(line.includes('2 dragging with 1 gaps (max 100ms)'), line);
});

t('input delay is the wait before the handler ran', () => {
    const h = make({ flags: { h264MainThreadLog: true } });
    h.sandbox.Guacamole.MainThreadLoad.start();
    h.feed('event', { startTime: 10, processingStart: 130, duration: 140 });
    h.feed('event', { startTime: 200, processingStart: 220, duration: 40 });
    h.sandbox.__now = 5000;
    h.sandbox.__tick();
    const line = h.logs.find(l => l.includes('main_thread mode='));
    assert.ok(line.includes('input delay 2 slow events, mean 70.0ms, max 120ms'), line);
});

t('draw time is charged per picture', () => {
    const h = make({ flags: { h264MainThreadLog: true } });
    const M = h.sandbox.Guacamole.MainThreadLoad;
    M.start();
    M.noteDraw(2); M.noteDraw(8); M.noteDraw(0.5);
    h.sandbox.__now = 5000;
    h.sandbox.__tick();
    const line = h.logs.find(l => l.includes('main_thread mode='));
    assert.ok(line.includes('h264 draw 11ms over 3 pictures'), line);
    assert.ok(line.includes('3.50ms mean, 8.0ms max'), line);
});

t('an idle window says nothing', () => {
    const h = make({ flags: { h264MainThreadLog: true } });
    h.sandbox.Guacamole.MainThreadLoad.start();
    h.logs.length = 0;
    h.sandbox.__now = 5000;
    h.sandbox.__tick();
    assert.equal(h.logs.filter(l => l.includes('main_thread mode=')).length, 0);
});

t('says so when the browser cannot report', () => {
    const h = make({ flags: { h264MainThreadLog: true }, entryTypes: [] });
    h.sandbox.Guacamole.MainThreadLoad.start();
    assert.ok(h.logs.some(l => l.startsWith('WARN') && l.includes('no long tasks')
            && l.includes('no event timing')), h.logs.join('\n'));
});

t('the mode is named in the line', () => {
    const h = make({ flags: { h264MainThreadLog: true } });
    const M = h.sandbox.Guacamole.MainThreadLoad;
    M.start(); M.setMode('worker'); M.noteDraw(1);
    h.sandbox.__now = 5000; h.sandbox.__tick();
    assert.ok(h.logs.find(l => l.includes('main_thread mode=worker')));
});

console.log(fails ? `\n${fails} failure(s)` : '\nall passed');
process.exit(fails ? 1 : 0);
