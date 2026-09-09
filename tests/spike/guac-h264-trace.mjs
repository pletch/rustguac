#!/usr/bin/env node
/*
 * Extracts an H.264 access-unit trace from a `.guac` session recording.
 *
 * A recording is the raw guacd -> browser instruction stream, so it already
 * contains everything the loss simulator needs and nothing has to be
 * instrumented to get it: `h264` announces each access unit with its keyframe
 * flag and view, the `blob` instructions that follow carry its bytes, and the
 * `sync` timestamps say when each frame was drawn.
 *
 * Reading a real recording matters more than it sounds. The distribution of
 * access-unit sizes is what decides how many datagrams a picture fragments
 * into, and therefore how likely it is that at least one of them is lost --
 * and that distribution is nothing like uniform. A main view carries one
 * frame's damage while an auxiliary view carries chroma for N frames of it,
 * and a keyframe is an order of magnitude larger than either. Guessing those
 * proportions would decide the answer before the simulation ran.
 *
 * Usage:
 *   node tests/spike/guac-h264-trace.mjs <recording.guac> [--json out.json]
 *
 * Output is a JSON trace: { source, units: [{t, view, keyframe, bytes,
 * paired, layer}], syncs, durationMs }.
 */

import { readFile, writeFile } from 'node:fs/promises';

/* ── Guacamole wire parsing ──────────────────────────────────────────────
 *
 * The format is `LENGTH.VALUE` elements separated by `,` and terminated by
 * `;`, where LENGTH counts Unicode codepoints rather than bytes or UTF-16
 * units. Base64 blobs are ASCII so the distinction never bites there, but a
 * clipboard instruction carrying an emoji sits in the same stream and would
 * desynchronise a parser that counted wrong -- taking every instruction after
 * it with it. Counting codepoints costs nothing here and removes the whole
 * class of failure. */
/*
 * Advances `count` codepoints from UTF-16 index `start`, returning the index
 * just past them, or -1 if the string ends first.
 *
 * Walking indices rather than materialising an array of characters is not a
 * micro-optimisation: a recording of a video session runs to hundreds of
 * megabytes, and Array.from() on a string that size exceeds the maximum array
 * length outright. This costs one pass and no allocation.
 */
function advance(text, start, count) {
    let i = start;
    for (let n = 0; n < count; n++) {
        if (i >= text.length) return -1;
        const c = text.charCodeAt(i);
        i += (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) ? 2 : 1;
    }
    return i;
}

function* instructions(text) {
    let i = 0;
    while (i < text.length) {
        const elements = [];
        for (;;) {
            const dot = text.indexOf('.', i);
            if (dot < 0) return;
            const length = parseInt(text.slice(i, dot), 10);
            if (!Number.isFinite(length) || length < 0) return;
            const start = dot + 1;
            const end = advance(text, start, length);
            if (end < 0 || end >= text.length) return;
            elements.push(text.slice(start, end));
            const sep = text[end];
            i = end + 1;
            if (sep === ';') break;
            if (sep !== ',') return;
        }
        if (elements.length) yield elements;
    }
}

/* Decoded length of a base64 payload, without decoding it. */
function base64Bytes(s) {
    if (!s) return 0;
    let padding = 0;
    if (s.endsWith('==')) padding = 2;
    else if (s.endsWith('=')) padding = 1;
    return Math.floor((s.length * 3) / 4) - padding;
}

export async function traceFromRecording(path) {
    const text = await readFile(path, 'utf8');

    const units = [];
    const syncs = [];

    /* Access units still being filled by `blob` instructions, keyed by the
     * stream index the `h264` instruction opened. */
    const open = new Map();

    /* Frame time comes from the `sync` handshake, which is the only clock in
     * the stream. Instructions between two syncs all belong to the frame the
     * second one closes, so an access unit is stamped with the sync that
     * follows it -- not the one before, which is when the *previous* frame
     * was done. */
    let pendingUnits = [];
    let firstSync = null;
    let lastSync = null;

    for (const args of instructions(text)) {
        const opcode = args[0];

        if (opcode === 'h264') {
            const index = parseInt(args[1], 10);
            const numRects = args.length > 9 ? parseInt(args[9], 10) : 0;
            const pairedAt = 10 + numRects * 4;
            open.set(index, {
                layer: parseInt(args[2], 10),
                keyframe: parseInt(args[3], 10) !== 0,
                view: args.length > 8 ? parseInt(args[8], 10) : 0,
                paired: args.length > pairedAt
                    ? parseInt(args[pairedAt], 10) !== 0 : false,
                bytes: 0,
            });
        }
        else if (opcode === 'blob') {
            const unit = open.get(parseInt(args[1], 10));
            if (unit) unit.bytes += base64Bytes(args[2]);
        }
        else if (opcode === 'end') {
            const index = parseInt(args[1], 10);
            const unit = open.get(index);
            if (unit) {
                open.delete(index);
                pendingUnits.push(unit);
            }
        }
        else if (opcode === 'sync') {
            const t = parseInt(args[1], 10);
            if (!Number.isFinite(t)) continue;
            if (firstSync === null) firstSync = t;
            lastSync = t;
            syncs.push(t - firstSync);
            for (const unit of pendingUnits) {
                unit.t = t - firstSync;
                units.push(unit);
            }
            pendingUnits = [];
        }
    }

    return {
        source: path,
        units,
        syncs,
        durationMs: lastSync !== null && firstSync !== null
            ? lastSync - firstSync : 0,
    };
}

/* ── CLI ─────────────────────────────────────────────────────────────── */

const invokedDirectly = process.argv[1]
        && process.argv[1].endsWith('guac-h264-trace.mjs');

if (invokedDirectly) {
    const path = process.argv[2];
    if (!path) {
        console.error('usage: guac-h264-trace.mjs <recording.guac> [--json out.json]');
        process.exit(2);
    }

    const trace = await traceFromRecording(path);

    const main = trace.units.filter((u) => u.view === 0);
    const aux = trace.units.filter((u) => u.view !== 0);
    const keys = trace.units.filter((u) => u.keyframe);

    const median = (xs) => {
        if (!xs.length) return 0;
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
    };
    const kb = (n) => (n / 1024).toFixed(1) + 'KB';

    console.log(`recording:     ${path}`);
    console.log(`duration:      ${(trace.durationMs / 1000).toFixed(1)}s`
            + ` over ${trace.syncs.length} frames`);
    console.log(`access units:  ${trace.units.length}`
            + ` (${main.length} main, ${aux.length} auxiliary,`
            + ` ${keys.length} keyframes)`);
    if (main.length)
        console.log(`main view:     median ${kb(median(main.map((u) => u.bytes)))}`
                + `, max ${kb(Math.max(...main.map((u) => u.bytes)))}`);
    if (aux.length)
        console.log(`auxiliary:     median ${kb(median(aux.map((u) => u.bytes)))}`
                + `, max ${kb(Math.max(...aux.map((u) => u.bytes)))}`);

    /* The interval between keyframes is the single most important number the
     * simulation consumes: it is how long a picture stays corrupt after an
     * unrecoverable loss. Reporting it here means a recording can be sanity
     * checked before anything is concluded from it. */
    if (keys.length >= 2) {
        const gaps = [];
        for (let i = 1; i < keys.length; i++) gaps.push(keys[i].t - keys[i - 1].t);
        console.log(`keyframe gap:  median ${(median(gaps) / 1000).toFixed(1)}s`
                + `, max ${(Math.max(...gaps) / 1000).toFixed(1)}s`);
    } else {
        console.log('keyframe gap:  n/a -- fewer than two keyframes in this recording');
    }

    const jsonAt = process.argv.includes('--json')
        ? process.argv[process.argv.indexOf('--json') + 1] : null;
    if (jsonAt) {
        await writeFile(jsonAt, JSON.stringify(trace));
        console.log(`\nwrote ${jsonAt}`);
    }
}
