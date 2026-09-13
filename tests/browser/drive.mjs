#!/usr/bin/env node
/*
 * Drives a Chrome already listening on a debugging port: opens the replay
 * harness, waits for it to finish, and prints what the page saw.
 *
 * Chrome rather than a headless runner because the question this answers is a
 * GPU question. A software decode puts its frames in system memory, which is
 * what makes tests/bench's copyTo() row read 0.29ms against ~14ms in the
 * field, so the decode path is reported first and every timing below it is
 * void unless that line says hardware.
 *
 * Usage: node tests/browser/drive.mjs <url> [--port 9333] [--timeout 180]
 */

const args = process.argv.slice(2);
const url = args[0];

/* indexOf returns -1 when the flag is absent, and args[-1 + 1] is the url --
 * so an absent --port silently became the port. */
function flag(name, fallback) {
    const at = args.indexOf(name);
    return at === -1 ? fallback : +args[at + 1];
}

const port = flag('--port', 9333);
const timeoutS = flag('--timeout', 180);

if (!url) {
    console.error('usage: drive.mjs <url> [--port N] [--timeout S]');
    process.exit(2);
}

/** One CDP session over a websocket, with id-matched replies. */
async function connect(wsUrl) {

    const ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });

    let next = 1;
    const waiting = new Map();
    const listeners = [];

    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && waiting.has(msg.id)) {
            const { ok, bad } = waiting.get(msg.id);
            waiting.delete(msg.id);
            msg.error ? bad(new Error(msg.error.message)) : ok(msg.result);
        }
        else if (msg.method)
            listeners.forEach((fn) => fn(msg));
    };

    return {
        ws,
        on   : (fn) => listeners.push(fn),
        send : (method, params = {}) => new Promise((ok, bad) => {
            const id = next++;
            waiting.set(id, { ok, bad });
            ws.send(JSON.stringify({ id, method, params }));
        })
    };
}

const browserWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`))
        .json()).webSocketDebuggerUrl;
const browser = await connect(browserWs);

/* What Chrome thinks of its own graphics stack, before anything is measured. */
const info = await browser.send('SystemInfo.getInfo').catch(() => null);
if (info) {
    const status = info.gpu?.featureStatus || {};
    console.log('=== Chrome graphics ===');
    for (const key of ['video_decode', 'webgl2', 'gpu_compositing', 'vulkan', 'opengl'])
        if (status[key]) console.log(`  ${key.padEnd(16)} ${status[key]}`);
    const dev = info.gpu?.devices?.[0];
    if (dev) console.log(`  device           ${dev.vendorString || dev.vendorId} ${dev.deviceString || dev.deviceId}`);
    if (info.gpu?.driverBugWorkarounds?.length)
        console.log(`  workarounds      ${info.gpu.driverBugWorkarounds.length}`);
}

/* A fresh tab for the harness. */
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = await connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);

await page.send('Runtime.enable');
await page.send('Log.enable');
await page.send('Page.enable');

/* The decoder may be on a worker, and a worker's console goes to the worker's
 * own target rather than the page's. Without this the half of the session
 * being tested is the silent half. */
await page.send('Target.setAutoAttach', {
    autoAttach : true, waitForDebuggerOnStart : false, flatten : true
});

const console_ = [];
page.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || [])
                .map((a) => a.value ?? a.description ?? '').join(' ');
        const where = msg.sessionId ? 'worker' : 'page  ';
        console_.push(where + ' ' + text);
        if (/rustguac|ERROR|WARN|main_thread/.test(text))
            console.log('  ' + where + ' ' + text);
    }
    else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error')
        console.log('  PAGE ERROR ' + msg.params.entry.text);

    /* A newly attached worker says nothing until told to. */
    else if (msg.method === 'Target.attachedToTarget') {
        const sid = msg.params.sessionId;
        const send = (method) => page.ws.send(JSON.stringify({
            id : 100000 + Math.floor(Math.random() * 100000),
            sessionId : sid, method, params : {}
        }));
        send('Runtime.enable');
        send('Log.enable');
        console.log('  [attached to ' + msg.params.targetInfo.type + ']');
    }
});

console.log(`\n=== replaying ${url} ===`);
await page.send('Page.navigate', { url });

const started = Date.now();
let done = null;

while ((Date.now() - started) / 1000 < timeoutS) {
    await new Promise((r) => setTimeout(r, 2000));
    const { result } = await page.send('Runtime.evaluate', {
        expression : `JSON.stringify({
            done: !!window.__done, error: window.__error || null,
            mode: window.__mode, hardware: window.__hardware,
            progress: window.__progress || null, state: window.__state || null })`,
        returnByValue : true
    });
    const snap = JSON.parse(result.value);
    if (snap.error) { console.log('\nPAGE ERROR: ' + snap.error); done = snap; break; }
    if (snap.done) { done = snap; break; }
}

const { result: tail } = await page.send('Runtime.evaluate', {
    expression : 'JSON.stringify(window.__replayLog || [])', returnByValue : true
});

console.log('\n=== result ===');
console.log(done ? JSON.stringify(done, null, 2) : 'TIMED OUT');
console.log('\n=== page log tail ===');
console.log(JSON.parse(tail.value).slice(-25).join('\n'));

await browser.send('Target.closeTarget', { targetId });
process.exit(0);
