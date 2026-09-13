#!/usr/bin/env node
/*
 * Pins the message contract between the H.264 decoder proxy and the worker
 * that hosts the decoder.
 *
 * The proxy (`static/guac/H264DecoderProxy.js`) and the worker
 * (`static/guac/H264Worker.js`) are separate files talking past each other
 * through postMessage, and nothing at build time connects the two. A
 * disagreement there does not fail loudly. The proxy has a display task
 * blocked on every frame it submits, so a reply it does not recognise -- a
 * renamed field, a picture posted in the transfer list but not in the message
 * body, a frame answered under the decoder's token rather than the proxy's --
 * stalls that task and every frame behind it, and the session goes still while
 * both ends look healthy. The sync gate fails the same way: an acknowledgement
 * that is never sent stops the session outright.
 *
 * So both halves are exercised against scripted counterparts, and then against
 * each other. WebCodecs is deliberately not involved: what is being pinned is
 * the boundary, not the decode.
 *
 * Usage: node tests/h264-worker-protocol.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

/* ── Enough of a browser for either side to load ─────────────────────── */

/** An ImageBitmap that can say whether it was closed, and whether it was
 *  moved rather than copied -- the two things the handover has to get right. */
class FakeImageBitmap {
    constructor(tag) {
        this.tag = tag;
        this.closed = false;
        this.detached = false;
    }
    close() {
        if (this.detached)
            throw new Error('closed a bitmap that had been transferred away');
        this.closed = true;
    }
}

class FakeOffscreenCanvas {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.transfers = 0;
    }
    getContext() { return { drawImage() {}, clearRect() {}, getImageData() {} }; }
    transferToImageBitmap() {
        this.transfers++;
        return new FakeImageBitmap('from-canvas');
    }
}

/* Structured clone, near enough: anything named in the transfer list is moved
 * (and marked, so a later close here is a test failure), everything else is
 * passed by reference, which is all these messages need. */
function deliver(message, transfer) {
    for (const item of transfer || [])
        if (item instanceof FakeImageBitmap) item.detached = false;
    return message;
}
function markTransferred(transfer) {
    for (const item of transfer || [])
        if (item instanceof FakeImageBitmap) item.moved = true;
}

/** Loads H264Worker.js into its own context, with the decoder it imports
 *  replaced by whatever the caller scripts. */
async function loadWorker({ decoderFactory, onPost }) {

    const source = await readFile(join(root, 'static/guac/H264Worker.js'), 'utf8');

    const sandbox = {
        OffscreenCanvas : FakeOffscreenCanvas,
        ImageBitmap     : FakeImageBitmap,
        console         : { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, Date,
        postMessage : (msg, transfer) => { markTransferred(transfer); onPost(msg, transfer); },
        close       : () => {},
        importScripts : (...urls) => {
            sandbox.self.Guacamole = { H264Decoder: decoderFactory() };
            sandbox.imported = urls;
        }
    };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'H264Worker.js' });

    return {
        send : (msg) => sandbox.onmessage({ data: msg }),
        sandbox
    };
}

/** Loads H264DecoderProxy.js (and the real H264Decoder.js beside it, for the
 *  direct host it reads overrides through) into its own context, with Worker
 *  replaced by whatever the caller scripts. */
async function loadProxy({ onPost, display, globals = {} }) {


    const decoderSrc = await readFile(join(root, 'static/guac/H264Decoder.js'), 'utf8');
    const proxySrc = await readFile(join(root, 'static/guac/H264DecoderProxy.js'), 'utf8');

    let workerHandle = null;

    const sandbox = {
        console : { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, Date, JSON, Object, performance,
        URLSearchParams,
        ImageBitmap : FakeImageBitmap,
        OffscreenCanvas : FakeOffscreenCanvas,
        VideoDecoder : function () {},
        document : { createElement: () => new FakeOffscreenCanvas(1, 1) },
        Worker : function (url) {
            this.url = url;
            this.postMessage = (msg, transfer) => { markTransferred(transfer); onPost(msg, transfer); };
            this.terminate = () => { this.terminated = true; };
            workerHandle = this;
        }
    };
    sandbox.window = globals;
    globals.localStorage = null;
    globals.location = { search: '' };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(decoderSrc, sandbox, { filename: 'H264Decoder.js' });
    vm.runInContext(proxySrc, sandbox, { filename: 'H264DecoderProxy.js' });

    const proxy = new sandbox.Guacamole.H264DecoderProxy(
            display, ['/guac/Yuv444.js?v=1', '/guac/H264Decoder.js?v=1'],
            '/guac/H264Worker.js?v=1');

    return {
        proxy,
        sandbox,
        reply : (msg) => workerHandle.onmessage({ data: msg }),
        fail  : (e) => workerHandle.onerror(e),
        get terminated() { return workerHandle.terminated; }
    };
}

/** A layer that records what was blitted onto it. */
function fakeLayer() {
    const draws = [];
    return {
        draws,
        getCanvas : () => ({ getContext: () => ({
            drawImage : (...args) => draws.push(args)
        }) })
    };
}

const display = { getWidth: () => 1920, getHeight: () => 1080 };

/* ── The proxy's half ────────────────────────────────────────────────── */

test('proxy announces itself with the scripts the worker must import', async () => {
    const posted = [];
    await loadProxy({ onPost: (m) => posted.push(m), display });
    assert.equal(posted[0].t, 'init');
    assert.deepEqual([...posted[0].scripts],
            ['/guac/Yuv444.js?v=1', '/guac/H264Decoder.js?v=1']);
    assert.equal(posted[0].width, 1920);
    assert.equal(posted[0].height, 1080);
});

test('proxy transfers the access unit rather than copying it', async () => {
    const posted = [];
    const { proxy } = await loadProxy({ onPost: (m, t) => posted.push([m, t]), display });
    const nal = new ArrayBuffer(64);
    proxy.decode(fakeLayer(), 0, 0, 320, 240, nal, true, null, () => {}, 0, false);
    const [msg, transfer] = posted[1];
    assert.equal(msg.t, 'decode');
    assert.equal(msg.nal, nal);
    assert.equal(transfer.length, 1, 'the access unit must be in the transfer list');
    assert.equal(transfer[0], nal, 'and must be the buffer itself, not a copy');
});

test('proxy pushes the framebuffer size with every frame', async () => {
    const posted = [];
    let w = 1920;
    const { proxy } = await loadProxy({
        onPost: (m) => posted.push(m),
        display: { getWidth: () => w, getHeight: () => 1080 }
    });
    proxy.decode(fakeLayer(), 0, 0, 1, 1, new ArrayBuffer(8), true, null, () => {}, 0, false);
    w = 2992;
    proxy.decode(fakeLayer(), 0, 0, 1, 1, new ArrayBuffer(8), false, null, () => {}, 0, false);
    assert.equal(posted[1].width, 1920);
    assert.equal(posted[2].width, 2992);
});

test('proxy sends overrides only when they change', async () => {
    const posted = [];
    const globals = { __h264Chroma444: false };
    const { proxy } = await loadProxy({ onPost: (m) => posted.push(m), display, globals });
    const submit = () => proxy.decode(fakeLayer(), 0, 0, 1, 1,
            new ArrayBuffer(8), true, null, () => {}, 0, false);

    assert.deepEqual({ ...posted[0].overrides }, { h264Chroma444: false },
            'init must carry what the page saw');
    submit();
    assert.equal(posted[1].overrides, null, 'unchanged overrides are not resent');

    globals.__h264Chroma444 = true;
    submit();
    assert.deepEqual({ ...posted[2].overrides }, { h264Chroma444: true },
            'a window global set mid-session must reach the worker');
});

test('proxy draws the picture the worker sent, rect by rect, then closes it', async () => {
    const { proxy, reply } = await loadProxy({ onPost: () => {}, display });
    const layer = fakeLayer();
    const rects = [{ x: 4, y: 8, width: 16, height: 32 }];
    let ready = false;

    const token = proxy.decode(layer, 0, 0, 320, 240, new ArrayBuffer(8),
            false, rects, () => { ready = true; }, 0, false);

    const picture = new FakeImageBitmap('combined');
    reply({ t: 'ready', token, picture });

    assert.ok(ready, 'the display task must be released when the frame arrives');
    assert.equal(layer.draws.length, 0, 'nothing is painted before the queue reaches it');

    proxy.drawDecoded(token);
    assert.deepEqual(layer.draws, [[picture, 4, 8, 16, 32, 4, 8, 16, 32]]);
    assert.ok(picture.closed, 'the bitmap owns GPU memory until it is closed');
});

test('proxy paints the whole picture where the server sent no rects', async () => {
    const { proxy, reply } = await loadProxy({ onPost: () => {}, display });
    const layer = fakeLayer();
    const token = proxy.decode(layer, 7, 9, 320, 240, new ArrayBuffer(8),
            false, null, () => {}, 0, false);
    const picture = new FakeImageBitmap('whole');
    reply({ t: 'ready', token, picture });
    proxy.drawDecoded(token);
    assert.deepEqual(layer.draws, [[picture, 7, 9]]);
});

test('a frame that produced no picture still releases its task', async () => {
    const { proxy, reply } = await loadProxy({ onPost: () => {}, display });
    const layer = fakeLayer();
    let ready = false;
    const token = proxy.decode(layer, 0, 0, 1, 1, new ArrayBuffer(8), false,
            null, () => { ready = true; }, 1, false);

    reply({ t: 'ready', token, picture: null });
    assert.ok(ready, 'an auxiliary view paints nothing and must still unblock');

    proxy.drawDecoded(token);
    assert.equal(layer.draws.length, 0);
});

test('a worker that fails releases every frame and every sync waiting on it', async () => {
    const { proxy, reply, fail } = await loadProxy({ onPost: () => {}, display });
    const released = [];
    proxy.decode(fakeLayer(), 0, 0, 1, 1, new ArrayBuffer(8), true, null,
            () => released.push('a'), 0, false);
    proxy.decode(fakeLayer(), 0, 0, 1, 1, new ArrayBuffer(8), false, null,
            () => released.push('b'), 0, false);

    let acked = false;
    proxy.waitForPending(() => { acked = true; });

    fail(new Error('worker gone'));

    assert.deepEqual(released, ['a', 'b'], 'every blocked display task must be released');
    assert.ok(acked, 'an acknowledgement that is never sent stops the session');
});

test('the sync acknowledgement is sent even if the worker never answers', async () => {
    const posted = [];
    const { proxy, sandbox } = await loadProxy({ onPost: (m) => posted.push(m), display });
    let acked = false;
    proxy.waitForPending(() => { acked = true; }, 4);

    const flush = posted[posted.length - 1];
    assert.equal(flush.t, 'flush');
    assert.equal(flush.flushMs, 4, 'the flush time the gate reads must cross too');
    assert.ok(!acked, 'it waits first');

    await new Promise(r => setTimeout(r,
            sandbox.Guacamole.H264DecoderProxy.FLUSH_TIMEOUT_MS + 50));
    assert.ok(acked, 'a silent worker must not be able to stop the session');
});

test('decode after destroy releases its task rather than stranding it', async () => {
    const { proxy } = await loadProxy({ onPost: () => {}, display });
    proxy.destroy();
    let ready = false;
    const token = proxy.decode(fakeLayer(), 0, 0, 1, 1, new ArrayBuffer(8),
            true, null, () => { ready = true; }, 0, false);
    assert.equal(token, null);
    assert.ok(ready);
});

/* ── The worker's half ───────────────────────────────────────────────── */

/** A decoder that behaves as the real one's contract says: it calls the host's
 *  paintFrame for anything it paints, then the onReady it was given. */
function scriptedDecoder(behaviour = {}) {
    const Ctor = function (display, host) {
        Ctor.host = host;
        this.decode = (layer, x, y, w, h, nal, key, rects, onReady, view) => {
            if (behaviour.paint !== false)
                host.paintFrame({ token: 1, rects, x, y },
                        behaviour.snapshot ? behaviour.snapshot()
                                : new FakeOffscreenCanvas(w, h));
            onReady();
            return 1;
        };
        this.waitForPending = (cb) => setTimeout(cb, 1);
        this.describeState = () => 'h264=scripted';
        this.setProbing = (on) => { Ctor.probing = on; };
        this.reset = () => { Ctor.reset = true; };
        this.destroy = () => { Ctor.destroyed = true; };
    };
    Ctor.onDiagnostic = null;
    Ctor.directHost = () => ({});
    return Ctor;
}

test('worker imports exactly the scripts it was given, then reports ready', async () => {
    const posted = [];
    const w = await loadWorker({
        decoderFactory: () => scriptedDecoder(),
        onPost: (m) => posted.push(m)
    });
    w.send({ t: 'init', scripts: ['/a.js?v=1', '/b.js?v=2'], width: 800, height: 600, overrides: {} });
    assert.deepEqual(w.sandbox.imported, ['/a.js?v=1', '/b.js?v=2']);
    assert.ok(posted.some(m => m.t === 'ready-init'));
});

test('worker answers under the proxy token, with the picture in the message body', async () => {
    const posted = [];
    const w = await loadWorker({
        decoderFactory: () => scriptedDecoder(),
        onPost: (m, t) => posted.push([m, t])
    });
    w.send({ t: 'init', scripts: [], width: 800, height: 600, overrides: {} });
    posted.length = 0;

    w.send({ t: 'decode', token: 4242, x: 0, y: 0, w: 320, h: 240,
             nal: new ArrayBuffer(8), keyFrame: true, rects: null, view: 0 });

    const [msg, transfer] = posted.find(([m]) => m.t === 'ready');
    assert.equal(msg.token, 4242, 'the proxy files frames under its own token');
    assert.ok(msg.picture instanceof FakeImageBitmap,
            'the picture must ride in the message, not only in the transfer list');
    assert.equal(transfer.length, 1);
    assert.equal(transfer[0], msg.picture,
            'and must be in the transfer list, or it is copied');
});

test('worker takes the combine path bitmap rather than letting it be closed', async () => {
    const posted = [];
    const bitmap = new FakeImageBitmap('combined');
    const w = await loadWorker({
        decoderFactory: () => scriptedDecoder({ snapshot: () => bitmap }),
        onPost: (m, t) => posted.push([m, t])
    });
    w.send({ t: 'init', scripts: [], width: 800, height: 600, overrides: {} });

    const frameState = { token: 1, rects: null, x: 0, y: 0 };
    const host = w.sandbox.self.Guacamole.H264Decoder.host;
    host.paintFrame(frameState, bitmap);
    assert.ok(frameState.snapshotTaken,
            'the decoder must be told not to close a bitmap that is in flight');
});

test('worker reports no picture for a view that paints nothing', async () => {
    const posted = [];
    const w = await loadWorker({
        decoderFactory: () => scriptedDecoder({ paint: false }),
        onPost: (m) => posted.push(m)
    });
    w.send({ t: 'init', scripts: [], width: 800, height: 600, overrides: {} });
    w.send({ t: 'decode', token: 7, x: 0, y: 0, w: 1, h: 1,
             nal: new ArrayBuffer(8), keyFrame: false, rects: null, view: 1 });

    const ready = posted.find(m => m.t === 'ready');
    assert.equal(ready.token, 7);
    assert.equal(ready.picture, null);
});

test('worker answers a flush under its id', async () => {
    const posted = [];
    const w = await loadWorker({
        decoderFactory: () => scriptedDecoder(),
        onPost: (m) => posted.push(m)
    });
    w.send({ t: 'init', scripts: [], width: 800, height: 600, overrides: {} });
    w.send({ t: 'flush', id: 99, flushMs: 3 });
    await new Promise(r => setTimeout(r, 20));
    assert.ok(posted.some(m => m.t === 'flushed' && m.id === 99));
});

test('worker answers a flush even before it has a decoder', async () => {
    const posted = [];
    const w = await loadWorker({ decoderFactory: () => scriptedDecoder(), onPost: (m) => posted.push(m) });
    w.send({ t: 'flush', id: 1 });
    assert.ok(posted.some(m => m.t === 'flushed' && m.id === 1),
            'a sync arriving before init must still be acknowledged');
});

test('worker releases a frame that arrives before it has a decoder', async () => {
    const posted = [];
    const w = await loadWorker({ decoderFactory: () => scriptedDecoder(), onPost: (m) => posted.push(m) });
    w.send({ t: 'decode', token: 3, x: 0, y: 0, w: 1, h: 1, nal: new ArrayBuffer(8) });
    assert.ok(posted.some(m => m.t === 'ready' && m.token === 3 && !m.picture));
});

test('worker forwards the framebuffer size and the overrides it is pushed', async () => {
    const w = await loadWorker({ decoderFactory: () => scriptedDecoder(), onPost: () => {} });
    w.send({ t: 'init', scripts: [], width: 800, height: 600, overrides: { h264Chroma444: false } });
    const host = w.sandbox.self.Guacamole.H264Decoder.host;
    assert.equal(host.getWidth(), 800);
    assert.equal(host.override('h264Chroma444'), false);

    w.send({ t: 'size', width: 2992, height: 2000 });
    assert.equal(host.getWidth(), 2992);

    w.send({ t: 'overrides', overrides: { h264Chroma444: true } });
    assert.equal(host.override('h264Chroma444'), true);
});

test('worker host creates offscreen canvases and declines the display queue', async () => {
    const w = await loadWorker({ decoderFactory: () => scriptedDecoder(), onPost: () => {} });
    w.send({ t: 'init', scripts: [], width: 8, height: 8, overrides: {} });
    const host = w.sandbox.self.Guacamole.H264Decoder.host;
    assert.ok(host.createCanvas(16, 32) instanceof FakeOffscreenCanvas);
    assert.equal(host.autoDraw, true,
            'a worker has no display queue, so it finishes frames itself');
});

test('worker forwards diagnostics and pushes the state they are read beside', async () => {
    const posted = [];
    const w = await loadWorker({ decoderFactory: () => scriptedDecoder(), onPost: (m) => posted.push(m) });
    w.send({ t: 'init', scripts: [], width: 8, height: 8, overrides: {} });
    w.sandbox.self.Guacamole.H264Decoder.onDiagnostic('chroma_declined', 'because');
    assert.ok(posted.some(m => m.t === 'diag' && m.event === 'chroma_declined'
            && m.detail === 'because'));
    assert.ok(posted.some(m => m.t === 'state' && m.text === 'h264=scripted'),
            'describeState is read synchronously on the other side, so it is pushed');
});

/* ── The two of them, against each other ─────────────────────────────── */

/** A proxy and a worker wired to each other, with the real init message the
 *  proxy sends from its own constructor -- before, in this harness, the worker
 *  it is addressed to exists. A real Worker queues messages posted to it
 *  before it has finished starting, so this does too; dropping them instead
 *  would leave the worker with no decoder and quietly test nothing. */
async function connected(behaviour) {

    let worker = null;
    const queued = [];

    const proxyHost = await loadProxy({
        onPost : (m, t) => {
            if (worker) worker.send(deliver(m, t));
            else queued.push(deliver(m, t));
        },
        display
    });

    worker = await loadWorker({
        decoderFactory : () => scriptedDecoder(behaviour),
        onPost : (m, t) => proxyHost.reply(deliver(m, t))
    });

    for (const message of queued)
        worker.send(message);

    return { proxyHost, worker };

}


test('a frame crosses both ways and lands on the layer it was submitted for', async () => {

    const { proxyHost, worker } = await connected();

    const layer = fakeLayer();
    let ready = false;
    const token = proxyHost.proxy.decode(layer, 0, 0, 320, 240,
            new ArrayBuffer(32), true, [{ x: 0, y: 0, width: 320, height: 240 }],
            () => { ready = true; }, 0, false);

    assert.ok(ready, 'the round trip must release the display task');
    proxyHost.proxy.drawDecoded(token);
    assert.equal(layer.draws.length, 1, 'and the picture must land on the layer');
    assert.deepEqual([...layer.draws[0].slice(1)], [0, 0, 320, 240, 0, 0, 320, 240]);
});

test('every frame submitted is answered exactly once', async () => {

    const { proxyHost, worker } = await connected();

    const answers = new Array(50).fill(0);
    const tokens = [];
    for (let i = 0; i < 50; i++)
        tokens.push(proxyHost.proxy.decode(fakeLayer(), 0, 0, 64, 64,
                new ArrayBuffer(16), i === 0, null,
                () => { answers[i]++; },
                i % 3 === 0 ? 1 : 0, false));

    assert.equal(new Set(tokens).size, 50, 'tokens must not repeat');
    for (let i = 0; i < 50; i++)
        assert.equal(answers[i], 1,
                `frame ${i} was answered ${answers[i]} times`);
});

/* ── Run ─────────────────────────────────────────────────────────────── */

console.log('H.264 worker protocol');
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`  ok   ${name}`);
    } catch (e) {
        failures++;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
