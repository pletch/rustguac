#!/usr/bin/env node
/*
 * Pins the fallback when a hardware-accelerated configuration is refused.
 *
 * hardwareAcceleration 'prefer-hardware' reads as a hint and is not one:
 * Chrome reports a configuration carrying it as unsupported outright where no
 * hardware decoder exists. Without a fallback that is not a slower session, it
 * is no session at all -- configure() fails asynchronously, the decoder
 * closes, every frame is then held waiting for a keyframe that cures nothing,
 * and since guacd suppresses ordinary image operations for a layer carrying
 * H.264 the screen goes black and stays black.
 *
 * That is a bad failure to rediscover, and an easy one to undo: the hint reads
 * like a preference, so restoring it looks harmless. Hence a test rather than
 * a comment.
 *
 * Usage: node tests/h264-hardware-fallback.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'static/guac/H264Decoder.js'), 'utf8');

/**
 * A decoder against a VideoDecoder that behaves as Chrome does on a machine
 * with no hardware decoder: a configuration asking for one is accepted and
 * then fails asynchronously, exactly as it does in the field.
 */
function mounted({ refuseHardware = true } = {}) {

    const configures = [];
    const errors = [];
    let sink = null;

    const canvas = () => ({
        getContext : () => ({ drawImage() {}, clearRect() {},
                              getImageData: () => ({ data: new Uint8ClampedArray(4) }) })
    });

    const sandbox = {
        console : { log() {}, info() {}, warn: (...a) => errors.push(a.join(' ')),
                    error: (...a) => errors.push(a.join(' ')) },
        document : { createElement: canvas },
        window : { localStorage: null, location: { search: '' } },
        setTimeout, clearTimeout, Date, performance,
        URLSearchParams, Math, Object,
        EncodedVideoChunk : class { constructor(o) { Object.assign(this, o); } },
        VideoDecoder : class {
            constructor(init) { this.state = 'unconfigured'; sink = init; }
            configure(cfg) {
                configures.push(cfg);
                this.state = 'configured';
                /* Chrome accepts the call and reports the refusal through the
                 * error callback, which is what makes this hard to see. */
                if (refuseHardware
                        && cfg.hardwareAcceleration === 'prefer-hardware')
                    setTimeout(() => {
                        this.state = 'closed';
                        sink.error(new Error('Unsupported configuration. Check '
                                + 'isConfigSupported() prior to calling '
                                + 'configure().'));
                    }, 0);
            }
            decode() {}
            close() { this.state = 'closed'; }
            reset() {}
        }
    };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'H264Decoder.js' });

    const display = { getWidth: () => 1500, getHeight: () => 831 };
    const decoder = new sandbox.Guacamole.H264Decoder(display);

    return { decoder, configures, errors, sandbox };
}

/* An Annex B access unit: SPS, PPS, then an IDR slice. Enough for the codec
 * string and for the decoder to treat it as a keyframe. */
const keyframe = new Uint8Array([
    0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x20,
    0, 0, 0, 1, 0x68, 0xce,
    0, 0, 0, 1, 0x65, 0x88
]).buffer;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const test = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('H.264 hardware fallback');

await test('hardware is asked for first', async () => {
    const m = mounted({ refuseHardware: false });
    m.decoder.decode(null, 0, 0, 1500, 831, keyframe, true, null, () => {}, 0, false);
    assert.equal(m.configures.length, 1);
    assert.equal(m.configures[0].hardwareAcceleration, 'prefer-hardware',
            'the path this feature exists for must not be given away by default');
});

await test('a refusal is answered by configuring without the hint', async () => {
    const m = mounted();
    m.decoder.decode(null, 0, 0, 1500, 831, keyframe, true, null, () => {}, 0, false);
    assert.equal(m.configures[0].hardwareAcceleration, 'prefer-hardware');

    await sleep(20);

    /* The rebuild happens on the next frame, as it does for any decoder error. */
    m.decoder.decode(null, 0, 0, 1500, 831, keyframe, true, null, () => {}, 0, false);

    assert.equal(m.configures.length, 2, 'it must try again at all');
    assert.equal(m.configures[1].hardwareAcceleration, undefined,
            'and must not ask for hardware the browser has already refused');
    assert.equal(m.configures[1].codec, m.configures[0].codec,
            'the codec is not what was refused and must not change');
});

await test('it is asked for once, not alternately for ever', async () => {
    const m = mounted();
    for (let i = 0; i < 5; i++) {
        m.decoder.decode(null, 0, 0, 1500, 831, keyframe, true, null, () => {}, 0, false);
        await sleep(5);
    }
    const asked = m.configures.filter(c => c.hardwareAcceleration === 'prefer-hardware');
    assert.equal(asked.length, 1,
            `asked for hardware ${asked.length} times; the latch must hold`);
});

await test('and it says so, because a software decode is worth knowing about', async () => {
    const m = mounted();
    m.decoder.decode(null, 0, 0, 1500, 831, keyframe, true, null, () => {}, 0, false);
    await sleep(20);
    assert.ok(m.errors.some(e => /no hardware decoder/.test(e)),
            'the fallback must be visible, not merely a slow session');
});

await test('a frame is never stranded by the refusal', async () => {
    /* The display holds a blocked task per frame submitted. One that is never
     * released stalls every frame behind it, which is the same black screen by
     * another route. */
    const m = mounted();
    let released = 0;
    for (let i = 0; i < 3; i++)
        m.decoder.decode(null, 0, 0, 1500, 831, keyframe, true, null,
                () => released++, 0, false);
    await sleep(20);
    assert.ok(released >= 3, `only ${released} of 3 tasks were released`);
});

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
