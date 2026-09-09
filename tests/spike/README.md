# Stage 0 spikes — is the UDP video split worth building?

Two questions gate the WebTransport work. Neither is answered by writing the
transport and seeing how it feels, because both failure modes are rare enough
to survive a demo and common enough to ruin a deployment.

## (a) Loss recovery — `udp-loss-sim.mjs`

The appeal of datagrams is that a lost packet stops blocking input, clipboard
and control behind it. The catch is that H.264 is not loss-tolerant in any
useful sense: a dropped P-frame corrupts the picture until the next IDR, and
**there is no RDPGFX mechanism to ask a Windows host for one** — `docs/rdp-h264.md`
and the decoder's own `keyframe_wait` diagnostic put that wait at minutes.

So the design under test is deadline-bounded retransmission: fragment each
access unit into datagrams, NACK the gaps, retransmit until a per-frame
deadline, give up after it. Two policies past the deadline are reported side
by side — `drop` (abandon it, and be wrong until the next keyframe) and
`fallback` (re-send it reliably, and be late) — against a TCP baseline where
every loss blocks the whole ordered stream for a round trip.

    node tests/spike/udp-loss-sim.mjs --synthetic
    node tests/spike/udp-loss-sim.mjs --trace trace.json --deadline 250

Loss is modelled as Gilbert-Elliott rather than independent coin flips,
because bursts are what decide the question. A 60KB access unit is 50
datagrams; scattered single losses are each one NACK from recovery, while the
same mean arriving in bursts of four takes out four fragments of one picture
and leaves its neighbours untouched. Assuming independence would flatter the
design.

### What it says, on a real Windows capture

Measured from a 339s RDP session against a Windows host (`windows-run.guac`,
3470 access units, 15.3MB of H.264). Two facts from the recording itself
decide most of what follows.

**Windows sent five keyframes, all inside the first 2.12 seconds, then none
for the remaining 337.** That is the documented behaviour finally measured
rather than inferred, and it is fatal to the drop policy: an access unit
abandoned at any point after the first two seconds leaves the picture wrong
until the session ends. The simulator reports exactly that -- 96% of the
session corrupt even at 0.5% loss, longest episode 326 seconds.

**The size distribution is extremely skewed.** 72% of access units fit in a
single 1200-byte datagram, but the largest is 305 datagrams and the top 2% of
units carry 37% of all bytes. Loss exposure is concentrated almost entirely in
that tail: the tiny majority are one-datagram all-or-nothing, and the rare
large ones are near-certain to lose a fragment under burst loss.

At a 250ms deadline, ARQ recovers everything up to 2% loss:

| RTT | loss | deadline | missed | corrupt | TCP blocked |
|-----|------|----------|--------|---------|-------------|
| 30ms | 0.5% | 250ms | 0.00% | 0.0% | 0.12% |
| 30ms | 2%   | 250ms | 0.00% | 0.0% | 0.53% |
| 30ms | 5%   | 250ms | 0.32% | 83.1% | 1.38% |
| 30ms | 2%   | 100ms | 0.35% | 97.0% | 0.59% |

**But look at the last column, because it is the whole case for doing this.**
Head-of-line blocking costs 0.12-0.59% of the session at plausible loss rates
-- a fifth of a second per minute. That is what the fragmentation layer, the
NACK protocol, the cross-channel ordering gate and the reliable fallback would
be bought for.

The reason is in the workload: this capture runs at **0.36 Mbps and 45
datagrams per second**, a mostly-idle desktop with 6% of its seconds carrying
real damage. Few packets means few losses means little blocking. It is not the
case `CLAUDE.md` describes as taking guacd to 100% of a core -- sustained 1080p
video at two orders of magnitude more traffic, where the same loss rate
produces proportionally more head-of-line stalls and the prize is
correspondingly larger.

**So the spike has answered its question and raised a sharper one.** The
mechanism works: ARQ with reliable fallback and a deadline of roughly 8x RTT
recovers everything at LAN latencies, and the drop policy must never be built.
Whether it is *worth* building depends entirely on a workload this recording
does not contain. Before Stage 3, capture a sustained-video session and re-run;
if head-of-line blocking there is still under 1%, the honest answer is that
Stages 1-2 are the whole project.

### Feeding it a real recording — `guac-h264-trace.mjs`

The simulator is most sensitive to two inputs a synthetic trace cannot
justify: the distribution of access-unit sizes (which sets fragment counts,
and so loss exposure) and the keyframe interval (which sets what a miss
costs). Both come free from a `.guac` recording, since it is the raw guacd
stream:

    node tests/spike/guac-h264-trace.mjs recording.guac --json trace.json
    node tests/spike/udp-loss-sim.mjs --trace trace.json

Only sizes, timings and flags are read — no pixels, no payload — so the
extracted trace carries no session content and is safe to move around. Running
the extractor next to the recording and moving only the JSON is the better
habit.

The recording that matters is an **RDP session against a Windows host with
H.264 passthrough on**, long enough to contain at least two keyframes. xrdp
recordings will understate the problem badly: the fork sends keyframes far
more often, so corruption episodes are short and the drop policy looks
survivable when it is not.

## (b) WebTransport reach — not yet built

Measure handshake success from real client networks before committing:
corporate egress filters UDP/443 more than one would like, and Caddy cannot
proxy WebTransport today ([caddy#7669](https://github.com/caddyserver/caddy/pull/7669)
is unmerged), so the QUIC listener has to be reachable directly. If reach is
poor, Stage 1's WebSocket fallback stops being a safety net and becomes the
common path — which changes what Stage 3 is worth.
