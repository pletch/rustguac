#!/usr/bin/env node
/*
 * Pins the framebuffer fit in client.html (#251).
 *
 * Our guacd rounds the RDP size down to a multiple of 16
 * (patches/007-rdp-disp-mod16, deliberately, against H.264's green band), so
 * a 1710-wide window gets a 1696-wide desktop and the uniform fit leaves a
 * 14px strip. applyFill() decides what happens to that strip, and the two
 * rules it carries are exactly the ones pletch asked for on #251: a
 * pixel-exact picture (scale x devicePixelRatio == 1) is never stretched,
 * because any resampling would soften text; a picture that is already being
 * resampled fills a gap of at most 2.5% on each axis, because that costs no
 * sharpness; a bigger gap is a real aspect mismatch and keeps the letterbox.
 *
 * The function lives inline in static/client.html, so it is lifted out of
 * the page text here and run on a stand-in element. If it moves or is
 * renamed this test says so rather than silently testing nothing.
 *
 * Usage: node tests/client-fit.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(root, 'static/client.html'), 'utf8');

function lift(name) {
    const start = html.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name}() must exist in client.html`);
    let i = html.indexOf('{', start), depth = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) break;
    }
    return html.slice(start, i + 1);
}

const fillMax = html.match(/var FILL_MAX = ([0-9.]+);/);
assert.ok(fillMax, 'FILL_MAX must be defined in client.html');

const ctx = { fillX: 1, fillY: 1 };
vm.createContext(ctx);
vm.runInContext(`var FILL_MAX = ${fillMax[1]};\n${lift('applyFill')}\n${lift('fitScale')}\n${lift('devicePx')}`, ctx);

function fit(w, h, availW, availH, pixelExact) {
    const el = { style: {} };
    vm.runInContext('fillX = 1; fillY = 1;', ctx);
    ctx.applyFill(el, w, h, availW, availH, pixelExact);
    return { fillX: ctx.fillX, fillY: ctx.fillY, transform: el.style.transform || '' };
}

// 1696 drawn into 1710: a 0.8% shortfall.
let r = fit(1696, 960, 1710, 960, /* pixelExact */ true);
assert.equal(r.fillX, 1, 'a pixel-exact picture is never stretched');
assert.equal(r.fillY, 1);
assert.equal(r.transform, '', 'no transform on a pixel-exact picture');

r = fit(1696, 960, 1710, 960, false);
assert.ok(Math.abs(r.fillX - 1710 / 1696) < 1e-9, 'a resampled picture fills a small horizontal gap');
assert.equal(r.fillY, 1, 'the height already matched');
assert.match(r.transform, /^scale\(/, 'the fill is applied as a transform');

// Both axes short by a little: both filled.
r = fit(1696, 944, 1710, 960, false);
assert.ok(r.fillX > 1 && r.fillY > 1);

// A 10% gap is an aspect mismatch, not rounding: letterbox, no stretch.
r = fit(1536, 960, 1710, 960, false);
assert.equal(r.fillX, 1, 'a gap over 2.5% keeps the letterbox');
assert.equal(r.fillY, 1);

// Nothing to fill when the picture already fits or overflows.
r = fit(1710, 960, 1710, 960, false);
assert.equal(r.fillX, 1); assert.equal(r.fillY, 1);
r = fit(1800, 960, 1710, 960, false);
assert.equal(r.fillX, 1, 'never shrink through the fill');

// The threshold itself: exactly 2.5% fills, just over does not.
r = fit(1000, 1000, 1025, 1000, false);
assert.ok(r.fillX > 1, '2.5% is still a rounding gap');
r = fit(1000, 1000, 1026, 1000, false);
assert.equal(r.fillX, 1, 'over 2.5% is not');

// The uniform fit. Both axes rounded down: min() picks the smaller
// shortfall and would scale up by it, resampling the whole picture. Within
// FILL_MAX of one framebuffer pixel per physical pixel, it takes that instead.
const exactEnough = (scale, dpr) => Math.abs(scale * dpr - 1) < 0.002;
let s = ctx.fitScale(1700, 1000, 1696, 992, 1);
assert.equal(s, 1, '1696x992 in 1700x1000 is drawn 1:1, not at 1.0024');
s = ctx.fitScale(1440, 789, 1792, 976, 1.25);
assert.equal(s, 1 / 1.25, 'Native Resolution at 1.25 stays pixel-exact');
s = ctx.fitScale(1710, 1074, 2128, 1328, 1.25);
assert.ok(exactEnough(s, 1.25), 'and at 1710x1074');
s = ctx.fitScale(1700, 1000, 3392, 2000, 2);
assert.equal(s, 0.5, 'an exact fit is left alone');

// Outside the band, the plain fit stands.
s = ctx.fitScale(1920, 1080, 1024, 768, 1);
assert.equal(s, 1080 / 768, 'a framebuffer much smaller than the window still scales up');
s = ctx.fitScale(1600, 900, 1920, 1080, 1);
assert.equal(s, 900 / 1080, 'one larger than the window still scales down');
s = ctx.fitScale(1700, 1000, 1696, 992, 2);
assert.equal(s, Math.min(1700 / 1696, 1000 / 992),
    'a CSS-sized framebuffer on a 2x display is resampled anyway and keeps its fit');

// Centering margins land on whole device pixels.
assert.equal(ctx.devicePx(2.5, 1), 3);
assert.equal(ctx.devicePx(2.5, 2), 2.5, 'half a CSS pixel is a whole device pixel at 2x');
assert.equal(ctx.devicePx(7.3, 1.25), 7.2);

console.log('client-fit: ok');
