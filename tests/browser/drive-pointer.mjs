#!/usr/bin/env node
/*
 * Drives real pointer input at the pop-out monitor harness through the
 * debugger, with the main thread deliberately blocked, so that the coalesced
 * replay is exercised against the browser's own getCoalescedEvents().
 *
 * The node tests feed it events shaped the way the code expects. This checks
 * the assumption underneath them: that the browser merges moves at all when
 * the thread is busy, and that what it hands back replays in order and inside
 * the monitor it belongs to.
 *
 * Needs a Chrome listening on a debugging port and the harness server:
 *   node tests/browser/serve.mjs
 *   node tests/browser/drive-pointer.mjs [--port 9333]
 */

const args = process.argv.slice(2);
const portAt = args.indexOf('--port');
const port = portAt === -1 ? 9333 : +args[portAt + 1];

async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
    let next = 1;
    const waiting = new Map();
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && waiting.has(msg.id)) {
            const { ok, bad } = waiting.get(msg.id);
            waiting.delete(msg.id);
            msg.error ? bad(new Error(msg.error.message)) : ok(msg.result);
        }
    };
    return (method, params = {}) => new Promise((ok, bad) => {
        const id = next++;
        waiting.set(id, { ok, bad });
        ws.send(JSON.stringify({ id, method, params }));
    });
}

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const browser = await connect(version.webSocketDebuggerUrl);
const { targetId } = await browser('Target.createTarget',
        { url: 'http://127.0.0.1:8099/monitor-pointer.html' });
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = await connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);

await page('Runtime.enable');
await new Promise((r) => setTimeout(r, 1200));

const read = async (expression) => JSON.parse((await page('Runtime.evaluate',
        { expression, returnByValue: true })).result.value);

let failures = 0;
const check = (name, ok, detail = '') => {
    if (ok) console.log(`  ok   ${name}`);
    else { failures++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
};

console.log('pop-out monitor pointer, real browser');

/* Press, then drag across the canvas while the main thread is busy, then
 * release. The block is what makes the browser coalesce. */
await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 130,
        button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });

page('Runtime.evaluate', { expression: 'window.__block(150)' });
const moves = [];
for (let i = 0; i < 60; i++)
    moves.push(page('Input.dispatchMouseEvent', { type: 'mouseMoved',
            x: 150 + i * 10, y: 130 + i * 4, buttons: 1,
            button: 'left', pointerType: 'mouse' }));
await Promise.all(moves);

await new Promise((r) => setTimeout(r, 700));
await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 740, y: 366,
        button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
await new Promise((r) => setTimeout(r, 300));

const sent = await read('JSON.stringify(window.__sent)');
const maxCoalesced = await read('JSON.stringify(window.__maxCoalesced)');

console.log(`  (the browser merged up to ${maxCoalesced} moves into one event;`
        + ` ${sent.length} states were sent)`);

check('the browser really did coalesce', maxCoalesced > 1,
        `max coalesced was ${maxCoalesced} -- the thread was not busy enough, so`
        + ' this run proves nothing either way');

check('real pointer input produced states', sent.length > 0);

check('every position lands inside this monitor',
        sent.every((s) => s.x >= 2560 && s.x <= 2560 + 1920
                       && s.y >= 0 && s.y <= 1080),
        JSON.stringify(sent.slice(0, 3)));

check('the drag replays in order',
        sent.filter((s) => s.left)
            .every((s, i, a) => i === 0 || s.x >= a[i - 1].x),
        'positions went backwards, so the replay ran out of order');

check('no two consecutive states are identical',
        sent.every((s, i) => i === 0
                || JSON.stringify(s) !== JSON.stringify(sent[i - 1])),
        'the repeat suppression let a duplicate through');

check('the release is reported with no button held',
        sent.length > 0 && sent[sent.length - 1].left === false,
        JSON.stringify(sent[sent.length - 1]));

await browser('Target.closeTarget', { targetId });
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
