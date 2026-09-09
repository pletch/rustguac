#!/usr/bin/env node
/*
 * Round-trips the `h264` instruction through the client's own parser.
 *
 * The <paired> flag added for AVC444 trails the region rects, because those are
 * variable in number. That makes its index arithmetic the one part of the wire
 * format that can be wrong silently: an off-by-one reads a rect coordinate as a
 * boolean, which is true for almost every rect and would leave the client
 * skipping the paint of main views that have no auxiliary view behind them --
 * a picture that never appears, on some servers only, with nothing logged.
 *
 * So the instruction is built exactly as guac_h264_write_arg() builds it, parsed
 * with the real Guacamole.Parser, and the expression Client.js actually ships is
 * lifted out of the file and evaluated against the result. Copying the
 * expression into this test instead would let the two drift apart, which is the
 * failure this is meant to catch.
 *
 * Usage: node tests/h264-instruction-format.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* The parser is a browser script assigning onto a global. */
const Guacamole = {};
const parserSource = await readFile(resolve(root, 'static/guac/Parser.js'), 'utf8');
new Function('Guacamole', parserSource + '\nreturn Guacamole;')(Guacamole);

if (typeof Guacamole.Parser !== 'function')
    throw new Error('Guacamole.Parser did not load');

/* ---- the expression Client.js ships, lifted from the file ---- */

const clientSource = await readFile(resolve(root, 'static/guac/Client.js'), 'utf8');

const pairedExpr = clientSource.match(
        /var paired = ([\s\S]*?);\n/);
if (!pairedExpr)
    throw new Error('could not find the `var paired = ...` expression in '
            + 'Client.js — if it was renamed or reshaped, update this test '
            + 'rather than deleting it');

const numRectsExpr = clientSource.match(
        /var numRects = (parameters\.length[^;]*);/);
if (!numRectsExpr)
    throw new Error('could not find the `var numRects = ...` expression');

const readPaired = new Function('parameters',
        `var numRects = ${numRectsExpr[1]};
         var paired = ${pairedExpr[1]};
         return { numRects: numRects, paired: paired };`);

/* ---- the encoder, as guac_h264_write_arg() writes it ---- */

function instruction(args) {
    return args.map((a) => `${String(a).length}.${a}`).join(',') + ';';
}

function h264Instruction({ view = 0, rects = [], paired = null, legacy = null }) {

    const args = ['h264', 7, 1, 1, 0, 0, 1920, 1080];

    if (legacy === 'no-view')       // an older guacd, before <view>
        return instruction(args);

    args.push(view);

    if (legacy === 'no-rects')      // before <numrects>
        return instruction(args);

    args.push(rects.length);
    for (const r of rects)
        args.push(r.x, r.y, r.width, r.height);

    if (paired !== null)
        args.push(paired ? 1 : 0);

    return instruction(args);

}

/* ---- run ---- */

function parse(text) {
    const parser = new Guacamole.Parser();
    let seen = null;
    parser.oninstruction = (opcode, params) => { seen = { opcode, params }; };
    parser.receive(text, true);
    if (!seen) throw new Error('parser produced no instruction for: ' + text);
    return seen;
}

const R1 = [{ x: 10, y: 20, width: 30, height: 40 }];
const R3 = [
    { x: 1, y: 2, width: 3, height: 4 },
    { x: 5, y: 6, width: 7, height: 8 },
    { x: 9, y: 10, width: 11, height: 12 }
];

const cases = [
    ['no rects, paired',            { rects: [],  paired: true },  0, true],
    ['no rects, not paired',        { rects: [],  paired: false }, 0, false],
    ['1 rect, paired',              { rects: R1,  paired: true },  1, true],
    ['3 rects, paired',             { rects: R3,  paired: true },  3, true],
    ['3 rects, not paired',         { rects: R3,  paired: false }, 3, false],
    ['aux view, 3 rects, paired=0', { view: 2, rects: R3, paired: false }, 3, false],
    /* Older servers: the flag is simply absent, and must read as false rather
     * than picking up a rect coordinate. */
    ['guacd without <paired>',      { rects: R3, paired: null },   3, false],
    ['guacd without <numrects>',    { legacy: 'no-rects' },        0, false],
    ['guacd without <view>',        { legacy: 'no-view' },         0, false]
];

let failures = 0;

for (const [name, spec, expectRects, expectPaired] of cases) {

    const text = h264Instruction(spec);
    const { params } = parse(text);

    /* Client.js reads `parameters` as the arguments after the opcode. */
    const got = readPaired(params);

    const ok = got.numRects === expectRects && got.paired === expectPaired;
    if (!ok) failures++;

    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(28)}`
            + ` numRects=${got.numRects} (want ${expectRects})`
            + ` paired=${got.paired} (want ${expectPaired})`);

}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
