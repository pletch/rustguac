/*
 * The copy band decides which rows of a decoded frame are pulled out of the
 * GPU, and it must always be a superset of the rows the renderer then uploads
 * -- which are computed independently, by bandsFor() in Yuv444.js, straight
 * from the same rects. A band one row short does not fail: it uploads a row
 * of the previous picture's pixels into the middle of this one, which reads
 * as a faint horizontal tear on moving content and nothing at all on a static
 * desktop.
 *
 * So both functions are lifted out of the real sources rather than copied
 * here, and checked against each other over the shapes a server actually
 * sends.
 */

import { readFileSync } from 'fs';

function lift(file, name, start) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const from = src.indexOf(start);
    if (from < 0)
        throw new Error('cannot find ' + name + ' in ' + file);

    /* Brace-match from the function's opening brace to its close. */
    let depth = 0, i = src.indexOf('{', from), begin = i;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(from, i + 1);
}

const copyBandSrc = lift('../static/guac/H264Decoder.js', 'copyBandFor',
        'function copyBandFor(rects, planeH)');
const bandsForSrc = lift('../static/guac/Yuv444.js', 'bandsFor',
        'function bandsFor(rects, shift, planeHeight)');
const mergeSrc = lift('../static/guac/Yuv444.js', 'merge',
        'function merge(bands, planeHeight)');

/* Read from the sources too, so changing one cannot quietly leave this test
 * checking the old value. */
const consts = {};
for (const [file, names] of [
    ['../static/guac/H264Decoder.js',
        ['COPY_BAND_ALIGN', 'COPY_BAND_MAX_SPAN', 'COPY_BAND_MAX_RECTS']],
    ['../static/guac/Yuv444.js', ['BAND_LIMIT', 'MAX_CLIP_RECTS']],
]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const n of names) {
        const m = src.match(new RegExp('var ' + n + ' = ([0-9.]+);'));
        if (!m) throw new Error('cannot find ' + n + ' in ' + file);
        consts[n] = Number(m[1]);
    }
}

const align = consts.COPY_BAND_ALIGN;

const scope = {};
new Function('scope', 'override', 'noteBand', 'MAX_CLIP_RECTS',
        'COPY_BAND_ALIGN', 'COPY_BAND_MAX_SPAN', 'COPY_BAND_MAX_RECTS',
        'BAND_LIMIT', `
    ${copyBandSrc}
    ${bandsForSrc}
    ${mergeSrc}
    scope.copyBandFor = copyBandFor;
    scope.bandsFor = bandsFor;
`)(scope, () => undefined, () => {}, consts.MAX_CLIP_RECTS, align,
   consts.COPY_BAND_MAX_SPAN, consts.COPY_BAND_MAX_RECTS, consts.BAND_LIMIT);

const { copyBandFor, bandsFor } = scope;

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  ' + detail : ''));
    if (!ok) failures++;
}

/* A caret, a scrolled window, a full-screen repaint, a band at the very
 * bottom, and an odd-numbered origin that must round down to an even one. */
const cases = [
    ['caret',            [{ y: 800, height: 18 }], 1648],
    ['two rects',        [{ y: 12, height: 30 }, { y: 900, height: 40 }], 1648],
    ['odd origin',       [{ y: 801, height: 17 }], 1648],
    ['top edge',         [{ y: 0, height: 5 }], 1648],
    ['bottom edge',      [{ y: 1640, height: 8 }], 1648],
    ['whole picture',    [{ y: 0, height: 1648 }], 1648],
    ['tall and thin',    [{ y: 1, height: 1646 }], 1648],
    ['single row',       [{ y: 823, height: 1 }], 1648],
];

for (const [name, rects, planeH] of cases) {

    const band = copyBandFor(rects, planeH);

    if (!band) {
        /* Declining is always safe -- the whole frame is copied. */
        check(name + ' (declined, copies whole frame)', true);
        continue;
    }

    const y0 = band.y0, y1 = band.y0 + band.h;

    const aligned = (y0 % align === 0) && (y0 % 2 === 0);
    check(name + ` origin ${align}-aligned`, aligned, `y0=${y0}`);

    const inside = y0 >= 0 && y1 <= planeH;
    check(name + ' inside the plane', inside, `[${y0},${y1}) of ${planeH}`);

    /* Every luma row the renderer will upload must have been copied. */
    const luma = bandsFor(rects, 0, planeH);
    check(name + ' luma bands exist', luma !== null,
            'a banded copy with no bands to upload it into is thrown away');
    const lumaOk = (luma || []).every(b => b.y0 >= y0 && b.y1 <= y1);
    check(name + ' covers the luma bands', lumaOk,
            JSON.stringify(luma) + ` vs [${y0},${y1})`);

    /* And every chroma row, which is a luma row halved -- so the copy's
     * origin must halve exactly, or the chroma planes shear by half a row. */
    const halfH = (planeH + 1) >> 1;
    const chroma = bandsFor(rects, 1, halfH);
    check(name + ' chroma bands exist', chroma !== null);
    const chromaOk = (chroma || []).every(
            b => b.y0 >= (y0 >> 1) && b.y1 <= (y1 >> 1));
    check(name + ' covers the chroma bands', chromaOk,
            JSON.stringify(chroma) + ` vs [${y0 >> 1},${y1 >> 1})`);
}

/* No regions means the whole picture is valid, and there is nothing to
 * narrow to. */
check('null rects declines', copyBandFor(null, 1648) === null);
check('empty rects declines', copyBandFor([], 1648) === null);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
