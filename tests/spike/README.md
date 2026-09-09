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

### What it says so far (synthetic trace, pending a real recording)

The `drop` policy is not viable at any loss rate tested. With a 60s keyframe
interval — the *optimistic* end of Windows behaviour — a 0.17% miss rate
leaves the session corrupt 87% of the time, because one miss costs a minute.
That is not a tuning problem; it is what a rare IDR does to an unreliable
transport, and it is why "just drop late frames" has to be ruled out early.

Deadline-bounded ARQ *does* work, but only with headroom over the round trip:

| RTT | deadline | missed | corrupt | TCP blocked |
|-----|----------|--------|---------|-------------|
| 30ms | 250ms | 0.00% | 0.0% | 3.0% |
| 30ms | 100ms | 1.01% | 98.0% | 3.5% |
| 100ms | 250ms | 1.01% | 98.0% | 10.1% |

At 30ms with a 250ms deadline every loss is recovered, nothing corrupts, and
TCP would have blocked 3% of the session — that 3% is the whole prize. Halve
the deadline, or triple the RTT, and it collapses. A deadline shorter than
1.5x RTT permits no retransmission at all.

**Provisional conclusion: the fallback path is mandatory, not an optimisation,
and the deadline must be roughly 8x RTT.** Since `fallback` costs nothing when
ARQ is succeeding, the sane design is ARQ with reliable fallback and no drop
policy at all.

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
