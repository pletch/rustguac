#!/usr/bin/env node
/*
 * Stage 0 spike: is deadline-bounded retransmission viable for H.264 over
 * unreliable datagrams, given how rarely an RDP host sends a keyframe?
 *
 * This decides whether the UDP video split is worth building. The appeal of
 * datagrams is that a lost packet stops blocking input, clipboard and control
 * behind it. The catch is that H.264 is not loss-tolerant in any useful sense:
 * a dropped P-frame corrupts the picture until the next IDR, and there is no
 * RDPGFX mechanism to ask a Windows host for one -- `docs/rdp-h264.md` and the
 * decoder's own `keyframe_wait` diagnostic put that wait at minutes. So a
 * "just drop it" transport trades a brief stall for a long corruption, which
 * is a bad trade at any loss rate a user would notice.
 *
 * What is simulated is therefore the middle option: fragment each access unit,
 * NACK the gaps, retransmit until a per-frame deadline, and give up after it.
 * The question the numbers have to answer is how often that deadline is
 * missed, because every miss costs one keyframe interval of corruption.
 *
 * Two policies are reported side by side:
 *
 *   drop     -- past the deadline the access unit is abandoned. Cheap, and
 *               the picture is wrong until the next keyframe.
 *   fallback -- past the deadline it is re-sent reliably. Never corrupts,
 *               but the frame lands late, which is the stall we were trying
 *               to avoid -- so its added latency is the honest cost.
 *
 * Against a TCP baseline: the same losses over one ordered stream, where each
 * one blocks everything behind it for a round trip. That blocked time is what
 * the split is meant to buy back, and it is only worth having if it is large
 * next to the corruption the split introduces.
 *
 * Usage:
 *   node tests/spike/udp-loss-sim.mjs --trace trace.json
 *   node tests/spike/udp-loss-sim.mjs --synthetic      # no recording needed
 *
 * Options:
 *   --loss 0.5,2,5     packet loss rates to sweep, percent
 *   --rtt 30,100       round-trip times to sweep, ms
 *   --deadline 100     how long an access unit may be chased, ms
 *   --burst 4          mean loss burst length in packets (1 = independent)
 *   --mtu 1200         datagram payload bytes
 *   --seed 1           PRNG seed
 *   --json out.json    also write the results as JSON
 */

import { readFile, writeFile } from 'node:fs/promises';

/* ── Options ─────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const nums = (s) => String(s).split(',').map(Number).filter(Number.isFinite);

const TRACE_AT   = opt('trace', null);
const SYNTHETIC  = argv.includes('--synthetic');
const LOSS_RATES = nums(opt('loss', '0.5,2,5'));
const RTTS       = nums(opt('rtt', '30,100'));
const DEADLINE   = Number(opt('deadline', 100));
const BURST      = Number(opt('burst', 4));
const MTU        = Number(opt('mtu', 1200));
const SEED       = Number(opt('seed', 1));
const JSON_AT    = opt('json', null);

/* ── PRNG ────────────────────────────────────────────────────────────
 *
 * Seeded and explicit so a surprising result can be re-run and stepped
 * through rather than argued about. */
function makeRandom(seed) {
    let s = (seed >>> 0) || 1;
    return function random() {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5;  s >>>= 0;
        return s / 4294967296;
    };
}

/* ── Loss model ──────────────────────────────────────────────────────
 *
 * Gilbert-Elliott rather than independent coin flips, because real loss
 * arrives in bursts and bursts are what actually decide this question. A
 * 60KB access unit is 50 datagrams; under independent loss at 2% it almost
 * certainly loses one somewhere, but they are scattered across many access
 * units, and each is a single NACK away from recovery. The same average loss
 * arriving in bursts of four takes out four fragments of one picture at once
 * and leaves its neighbours untouched. Same mean, very different outcome, and
 * assuming independence would flatter the design.
 *
 * Loss happens only in the bad state. Mean burst length B fixes
 * P(bad->good) = 1/B, and the steady-state occupancy fixes P(good->bad).
 */
function makeChannel(random, lossRate, burst) {
    const p = lossRate;
    const toGood = 1 / Math.max(1, burst);
    const toBad = p <= 0 ? 0 : (p * toGood) / Math.max(1e-9, 1 - p);
    let bad = false;
    return function lost() {
        if (bad) {
            if (random() < toGood) bad = false;
            return true;
        }
        if (random() < toBad) {
            bad = true;
            return true;
        }
        return false;
    };
}

/* ── Traces ──────────────────────────────────────────────────────────── */

/*
 * A stand-in until a recording is available, built from the measurements
 * already recorded in CLAUDE.md rather than invented: 1080p at 30fps, a
 * typing-shaped damage list, main-view median 4.7KB against an auxiliary
 * median of 17.9KB, the auxiliary sent every 8th picture as the xrdp fork's
 * CHROMA_INTERVAL does.
 *
 * The keyframe interval is the parameter this spike is most sensitive to and
 * the one a synthetic trace is least able to justify, so it is deliberately
 * set to the *optimistic* end of what a Windows host does -- 60s, where the
 * decoder's keyframe_wait diagnostic has shown minutes. If the design fails
 * here it fails worse in practice.
 */
function syntheticTrace() {
    const random = makeRandom(SEED ^ 0x5eed);
    const FRAMES = 30 * 120;            /* two minutes at 30fps */
    const FRAME_MS = 1000 / 30;
    const CHROMA_INTERVAL = 8;
    const KEYFRAME_MS = 60_000;

    /* Log-normal-ish sizes around the recorded medians: most pictures are
     * small, a few are much larger, which is what a damage-driven encoder
     * produces and what decides fragment counts. */
    const around = (median) =>
        Math.max(200, Math.round(median * Math.exp((random() - 0.5) * 1.6)));

    const units = [];
    let lastKeyframe = -KEYFRAME_MS;
    for (let f = 0; f < FRAMES; f++) {
        const t = Math.round(f * FRAME_MS);
        const keyframe = t - lastKeyframe >= KEYFRAME_MS;
        if (keyframe) lastKeyframe = t;
        const paired = f % CHROMA_INTERVAL === 0;
        units.push({
            t, view: 0, keyframe, paired,
            bytes: keyframe ? around(4700) * 12 : around(4700),
        });
        if (paired)
            units.push({ t, view: 2, keyframe: false, paired: false,
                bytes: around(17900) });
    }
    return {
        source: 'synthetic (CLAUDE.md medians, 60s keyframe interval)',
        units,
        durationMs: Math.round(FRAMES * FRAME_MS),
    };
}

/* ── Simulation ──────────────────────────────────────────────────────── */

/*
 * One access unit's fate.
 *
 * Timing follows the round trip rather than a queue model: the first copy of
 * a fragment lands half an RTT after it is sent, a gap is noticed then, the
 * NACK reaches the server half an RTT later, and its answer arrives half an
 * RTT after that. So retransmission round k lands at (0.5 + k) * rtt, and the
 * deadline allows floor(deadline/rtt - 0.5) of them.
 *
 * Gap detection is assumed immediate, which is optimistic: a real client
 * cannot tell a missing fragment from a late one without either the next
 * fragment arriving or a timer expiring, and the last fragment of a picture
 * has nothing behind it to reveal the gap. Being optimistic is deliberate --
 * a design that fails under a generous model fails under a fair one.
 */
function simulateUnit(unit, { rtt, deadline, lost, mtu }) {
    const fragments = Math.max(1, Math.ceil(unit.bytes / mtu));
    const rounds = Math.max(0, Math.floor(deadline / rtt - 0.5));

    let outstanding = 0;
    let sentBytes = 0;
    for (let i = 0; i < fragments; i++) {
        sentBytes += Math.min(mtu, unit.bytes - i * mtu);
        if (lost()) outstanding++;
    }

    const firstTry = outstanding === 0;
    let retransmitBytes = 0;
    let round = 0;
    while (outstanding > 0 && round < rounds) {
        round++;
        let stillMissing = 0;
        for (let i = 0; i < outstanding; i++) {
            retransmitBytes += mtu;
            if (lost()) stillMissing++;
        }
        outstanding = stillMissing;
    }

    return {
        fragments,
        firstTry,
        recovered: !firstTry && outstanding === 0,
        missed: outstanding > 0,
        /* When it did arrive, relative to the first transmission. */
        latencyMs: outstanding > 0 ? Infinity : (0.5 + round) * rtt,
        sentBytes,
        retransmitBytes,
    };
}

function simulate(trace, { lossRate, rtt, deadline, burst, mtu, seed }) {
    const random = makeRandom(seed);
    const lost = makeChannel(random, lossRate / 100, burst);

    let firstTry = 0, recovered = 0, missed = 0;
    let sentBytes = 0, retransmitBytes = 0, fragments = 0;
    const lateLatencies = [];

    /* Corruption accounting for the `drop` policy. A missed access unit
     * corrupts the sequence whichever view it carried: the two views of an
     * AVC444 picture are one H.264 sequence, so skipping either leaves later
     * pictures referencing data the decoder never received. The picture stays
     * wrong until a keyframe arrives *complete* -- a keyframe that is itself
     * missed does not clear anything, which is the case that turns a bad
     * minute into a bad several minutes. */
    let corruptSince = null;
    const episodes = [];

    /* TCP baseline: every lost datagram stalls the single ordered stream for
     * a round trip, and everything behind it waits -- input included. Stall
     * windows are unioned rather than summed, since losses inside one window
     * are already being waited on. */
    const stalls = [];

    for (const unit of trace.units) {
        const r = simulateUnit(unit, { rtt, deadline, lost, mtu });
        fragments += r.fragments;
        sentBytes += r.sentBytes;
        retransmitBytes += r.retransmitBytes;

        if (r.firstTry) firstTry++;
        else {
            /* Whatever was lost here would, on TCP, have stalled the stream. */
            stalls.push([unit.t, unit.t + rtt]);
            if (r.recovered) { recovered++; lateLatencies.push(r.latencyMs); }
            else missed++;
        }

        if (r.missed) {
            if (corruptSince === null) corruptSince = unit.t;
        } else if (unit.keyframe && corruptSince !== null) {
            episodes.push({ start: corruptSince, end: unit.t });
            corruptSince = null;
        }
    }

    if (corruptSince !== null)
        episodes.push({ start: corruptSince, end: trace.durationMs });

    /* Union the stall windows. */
    stalls.sort((a, b) => a[0] - b[0]);
    let blockedMs = 0, cursor = -Infinity;
    for (const [from, to] of stalls) {
        const start = Math.max(from, cursor);
        if (to > start) { blockedMs += to - start; cursor = to; }
    }

    const corruptMs = episodes.reduce((n, e) => n + (e.end - e.start), 0);
    const units = trace.units.length;

    return {
        lossRate, rtt, units, fragments,
        firstTryPct: (firstTry / units) * 100,
        recoveredPct: (recovered / units) * 100,
        missedPct: (missed / units) * 100,
        retransmitOverheadPct: (retransmitBytes / Math.max(1, sentBytes)) * 100,
        /* drop policy */
        corruptMs,
        corruptPct: (corruptMs / Math.max(1, trace.durationMs)) * 100,
        episodes: episodes.length,
        longestEpisodeMs: episodes.reduce((n, e) => Math.max(n, e.end - e.start), 0),
        /* fallback policy: the late frames become stalls instead of corruption */
        fallbackLateFrames: missed,
        fallbackAddedLatencyMs: missed > 0 ? deadline + rtt : 0,
        /* TCP baseline */
        tcpBlockedMs: blockedMs,
        tcpBlockedPct: (blockedMs / Math.max(1, trace.durationMs)) * 100,
    };
}

/* ── Run ─────────────────────────────────────────────────────────────── */

let trace;
if (TRACE_AT) trace = JSON.parse(await readFile(TRACE_AT, 'utf8'));
else if (SYNTHETIC) trace = syntheticTrace();
else {
    console.error('usage: udp-loss-sim.mjs --trace trace.json | --synthetic');
    console.error('       (produce a trace with tests/spike/guac-h264-trace.mjs)');
    process.exit(2);
}

if (!trace.units || !trace.units.length) {
    console.error(`trace ${TRACE_AT || '(synthetic)'} contains no H.264 access units.`);
    console.error('Was the recording made on an RDP session with H.264 passthrough on?');
    process.exit(1);
}

const keyframes = trace.units.filter((u) => u.keyframe).length;

console.log(`trace:      ${trace.source}`);
console.log(`            ${trace.units.length} access units over`
        + ` ${(trace.durationMs / 1000).toFixed(1)}s, ${keyframes} keyframes`);
console.log(`channel:    Gilbert-Elliott, mean burst ${BURST} packet(s),`
        + ` ${MTU}B datagrams`);
console.log(`deadline:   ${DEADLINE}ms per access unit\n`);

const rows = [];
for (const rtt of RTTS)
    for (const lossRate of LOSS_RATES)
        rows.push(simulate(trace, {
            lossRate, rtt, deadline: DEADLINE, burst: BURST, mtu: MTU, seed: SEED,
        }));

const pct = (n) => n.toFixed(n < 10 ? 2 : 1).padStart(6);
const secs = (ms) => (ms / 1000).toFixed(1).padStart(7);

const perMin = (n) => (n / (trace.durationMs / 60000));

console.log('                    ── recovery ──   ─ drop policy ─  ─ fallback ─  ─ TCP ─');
console.log(' rtt   loss   1st%   ARQ%  miss%   corrupt%  longest   late/min     block%');
console.log('──────────────────────────────────────────────────────────────────────────');
for (const r of rows) {
    console.log(
        `${String(r.rtt).padStart(4)}ms`
        + `${(r.lossRate + '%').padStart(6)}`
        + `${pct(r.firstTryPct)}`
        + `${pct(r.recoveredPct)}`
        + `${pct(r.missedPct)}`
        + `  ${pct(r.corruptPct)}`
        + `  ${secs(r.longestEpisodeMs)}s`
        + `  ${perMin(r.fallbackLateFrames).toFixed(1).padStart(8)}`
        + `  ${pct(r.tcpBlockedPct)}`);
}

/* A deadline shorter than one and a half round trips permits no retransmission
 * at all, which is why the 100ms rows recover nothing. Saying so beats leaving
 * a column of zeroes to be read as a bug. */
for (const rtt of RTTS) {
    if (Math.floor(DEADLINE / rtt - 0.5) < 1)
        console.log(`\nNote: at ${rtt}ms RTT a ${DEADLINE}ms deadline allows zero`
                + ` retransmissions\n      (one round trip needs`
                + ` ${(1.5 * rtt).toFixed(0)}ms). Those rows are the`
                + ` no-ARQ case.`);
}

console.log('\nRetransmit overhead: '
        + rows.map((r) => `${r.lossRate}%@${r.rtt}ms=`
            + `${r.retransmitOverheadPct.toFixed(1)}%`).join('  '));
console.log('\nRead the corrupt% column against the block% column: the first is'
        + '\nwhat the split costs, the second is what it buys back.');

if (JSON_AT) {
    await writeFile(JSON_AT, JSON.stringify({
        trace: trace.source, deadline: DEADLINE, burst: BURST, mtu: MTU,
        seed: SEED, rows,
    }, null, 2));
    console.log(`\nwrote ${JSON_AT}`);
}
