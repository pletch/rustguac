//! Per-session frame timing telemetry.
//!
//! Step 1 of adaptive quality: measure what the browser is actually keeping up
//! with, so later steps have something to adapt *on*.
//!
//! The signal is the Guacamole `sync` handshake. guacd ends every logical frame
//! with `sync,<timestamp>[,<frames>]`; the client replies `sync,<timestamp>`
//! once that frame has been rendered — and, in this fork, once the H.264
//! decoder has drained (`Client.js` gates the reply on
//! `_h264Decoder.waitForPending`). The round trip is therefore render lag, not
//! merely network RTT, and it is the same quantity guacd feeds into
//! `guac_display_suggest_quality()` for the tile path.
//!
//! What guacd cannot see is the H.264 passthrough path, which it does not
//! encode and so cannot throttle. Counting H.264 frames alongside the lag is
//! what lets us tell "the browser is behind" from "the browser is behind *and*
//! we are in passthrough", which is the case guacd currently has no answer for.
//!
//! Scanning is deliberately cheap: one pass over each chunk looking only at
//! instruction starts, and only for the two opcodes that matter. Blob payloads
//! — the bulk of the bytes — are never parsed.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Maximum unacknowledged frames tracked before the oldest are dropped.
///
/// A client that has stopped acking entirely would otherwise grow this without
/// bound. 512 frames is far past the point where any adaptation decision would
/// already have been made.
const MAX_PENDING: usize = 512;

/// Weight of each new sample in the lag EWMA. Low enough that a single slow
/// frame does not swing the average, high enough to follow a sustained change
/// within a second or two of frames.
const LAG_EWMA_ALPHA: f64 = 0.15;

/// Detailed overpaint lines allowed per `OVERPAINT_LOG_WINDOW`.
///
/// The fault this exists to catch appears once in days, so the logging has to
/// survive being left on; a session that legitimately mixes codecs would
/// otherwise write a line per tile forever. Twenty lines is enough to see the
/// shape of one episode, and the periodic summary keeps counting after that.
const OVERPAINT_LOG_LIMIT: u32 = 20;

/// The window over which `OVERPAINT_LOG_LIMIT` applies.
const OVERPAINT_LOG_WINDOW: Duration = Duration::from_secs(60);

/// Minimum spacing between overpaint summary lines.
const OVERPAINT_SUMMARY_INTERVAL: Duration = Duration::from_secs(30);

/// What is known about a layer that has carried H.264.
struct H264Layer {
    frames: u64,
    keyframes: u64,
    /// When the most recent access unit for this layer went out, which is what
    /// says whether an overpaint landed on a live picture or a stalled one.
    last_frame: Instant,
}

/// Bookkeeping for drawing instructions that land on a layer H.264 owns.
#[derive(Default)]
struct Overpaint {
    /// Count per opcode, for the summary and the snapshot.
    counts: BTreeMap<&'static str, u64>,
    total: u64,
    /// Detailed lines emitted in the current window, and when it opened.
    logged_in_window: u32,
    window_started: Option<Instant>,
    last_summary: Option<Instant>,
    /// Value of `total` when the last summary was emitted, so a quiet period
    /// produces no line at all.
    summarised_total: u64,
}

/// A frame sent to the browser and awaiting its `sync` reply.
struct PendingFrame {
    /// guacd's frame timestamp, the correlation key for the ack.
    timestamp: i64,
    sent_at: Instant,
}

#[derive(Default)]
struct Inner {
    pending: VecDeque<PendingFrame>,
    frames_sent: u64,
    frames_acked: u64,
    /// Acks whose timestamp matched no tracked frame — a duplicate reply, or a
    /// frame already evicted by MAX_PENDING.
    unmatched_acks: u64,
    max_outstanding: u32,
    last_lag_ms: u32,
    max_lag_ms: u32,
    ewma_lag_ms: f64,
    h264_frames: u64,
    h264_keyframes: u64,
    bytes_to_browser: u64,
    bytes_to_guacd: u64,
    /// Layers that have carried at least one H.264 access unit, keyed by layer
    /// index. guacd holds no pixels of its own for these, so anything else it
    /// draws there is drawing over a picture only the browser has.
    h264_layers: HashMap<i32, H264Layer>,
    overpaint: Overpaint,
}

/// Live frame telemetry for one session. Shared between the session and both
/// halves of its WebSocket proxy.
pub struct FrameStats {
    inner: Mutex<Inner>,
    started: Instant,
    /// Whether any H.264 access unit has been seen on this session. Read
    /// without the lock on every chunk, so that a session with no passthrough
    /// pays nothing for the overpaint scan.
    h264_seen: std::sync::atomic::AtomicBool,
}

impl Default for FrameStats {
    fn default() -> Self {
        Self::new()
    }
}

/// A point-in-time copy of the counters, for the API and for end-of-session
/// logging.
#[derive(Debug, Clone, Serialize)]
pub struct FrameStatsSnapshot {
    pub frames_sent: u64,
    pub frames_acked: u64,
    /// Frames sent but not yet acked — the browser's current backlog.
    pub outstanding: u32,
    pub max_outstanding: u32,
    pub unmatched_acks: u64,
    /// Round trip of the most recent acked frame, in milliseconds.
    pub last_lag_ms: u32,
    pub max_lag_ms: u32,
    /// Exponentially weighted mean lag — the value adaptation should act on,
    /// since single frames are noisy.
    pub avg_lag_ms: u32,
    pub h264_frames: u64,
    pub h264_keyframes: u64,
    pub bytes_to_browser: u64,
    pub bytes_to_guacd: u64,
    /// Drawing instructions guacd sent for a layer that H.264 was passing
    /// through. Any non-zero value here is worth explaining; see
    /// `FrameStats::observe_to_browser`.
    pub overpaint_ops: u64,
    /// The same total, split by opcode.
    pub overpaint_by_op: BTreeMap<String, u64>,
    pub uptime_secs: u64,
}

impl FrameStats {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            started: Instant::now(),
            h264_seen: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Account for a chunk of guacd → browser traffic.
    ///
    /// `text` always ends on an instruction boundary (see `guacd_to_ws`), so
    /// every instruction start in it is a real one.
    ///
    /// Returns any lines the caller should log. They report *overpaint*:
    /// ordinary drawing instructions — an image, a copy, a solid fill, a
    /// resize — sent for a layer that H.264 is passing through. guacd does not
    /// decode passthrough video, so its own copy of that layer holds no pixels
    /// for the regions the browser is painting from its decoder; anything else
    /// it draws there is drawn from a buffer it never filled, and lands on the
    /// screen as black. Nothing else in the stack can see this happen: guacd
    /// believes it is sending pixels and the browser believes it is receiving
    /// them.
    pub fn observe_to_browser(&self, text: &str) -> Option<Vec<String>> {
        let mut sync_timestamps: Vec<i64> = Vec::new();
        let mut h264: Vec<(i32, bool)> = Vec::new();
        let mut draws: Vec<Draw<'_>> = Vec::new();

        // Scanning for draws costs nothing until the session has actually
        // passed an access unit through, which most never do.
        let watching = self.h264_seen.load(std::sync::atomic::Ordering::Relaxed);

        for instr in instruction_starts(text) {
            if let Some(rest) = instr.strip_prefix("4.sync,") {
                if let Some((ts, _)) = next_element(rest) {
                    if let Ok(ts) = ts.parse::<i64>() {
                        sync_timestamps.push(ts);
                    }
                }
            } else if let Some(rest) = instr.strip_prefix("4.h264,") {
                // h264,<stream>,<layer>,<keyframe>,... — the second argument is
                // the layer, the third the keyframe flag.
                let layer = nth_element(rest, 1)
                    .and_then(|v| v.parse::<i32>().ok())
                    .unwrap_or(0);
                h264.push((
                    layer,
                    nth_element(rest, 2).map(|v| v != "0").unwrap_or(false),
                ));
            } else if watching {
                if let Some(draw) = Draw::parse(instr) {
                    draws.push(draw);
                }
            }
        }

        if !h264.is_empty() && !watching {
            self.h264_seen
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }

        let mut inner = self.inner.lock().unwrap();
        inner.bytes_to_browser += text.len() as u64;

        let now = Instant::now();
        for (layer, is_keyframe) in h264 {
            inner.h264_frames += 1;
            if is_keyframe {
                inner.h264_keyframes += 1;
            }
            let entry = inner.h264_layers.entry(layer).or_insert(H264Layer {
                frames: 0,
                keyframes: 0,
                last_frame: now,
            });
            entry.frames += 1;
            if is_keyframe {
                entry.keyframes += 1;
            }
            entry.last_frame = now;
        }

        let logs = inner.note_overpaint(&draws, now);

        for timestamp in sync_timestamps {
            inner.frames_sent += 1;
            if inner.pending.len() >= MAX_PENDING {
                inner.pending.pop_front();
            }
            inner.pending.push_back(PendingFrame {
                timestamp,
                sent_at: now,
            });
            let outstanding = inner.pending.len() as u32;
            if outstanding > inner.max_outstanding {
                inner.max_outstanding = outstanding;
            }
        }

        logs
    }

    /// Account for a chunk of browser → guacd traffic.
    pub fn observe_to_guacd(&self, text: &str) {
        let mut acks: Vec<i64> = Vec::new();
        for instr in instruction_starts(text) {
            if let Some(rest) = instr.strip_prefix("4.sync,") {
                if let Some((ts, _)) = next_element(rest) {
                    if let Ok(ts) = ts.parse::<i64>() {
                        acks.push(ts);
                    }
                }
            }
        }

        let mut inner = self.inner.lock().unwrap();
        inner.bytes_to_guacd += text.len() as u64;

        let now = Instant::now();
        for timestamp in acks {
            // The client acks the newest frame it has finished, so everything
            // queued before the match is superseded rather than lost.
            let matched = inner
                .pending
                .iter()
                .position(|frame| frame.timestamp == timestamp);
            let Some(index) = matched else {
                inner.unmatched_acks += 1;
                continue;
            };

            let sent_at = inner.pending[index].sent_at;
            inner.pending.drain(..=index);

            let lag_ms = now
                .saturating_duration_since(sent_at)
                .as_millis()
                .min(u32::MAX as u128) as u32;
            inner.frames_acked += 1;
            inner.last_lag_ms = lag_ms;
            if lag_ms > inner.max_lag_ms {
                inner.max_lag_ms = lag_ms;
            }
            inner.ewma_lag_ms = if inner.frames_acked == 1 {
                lag_ms as f64
            } else {
                LAG_EWMA_ALPHA * lag_ms as f64 + (1.0 - LAG_EWMA_ALPHA) * inner.ewma_lag_ms
            };
        }
    }

    pub fn snapshot(&self) -> FrameStatsSnapshot {
        let inner = self.inner.lock().unwrap();
        FrameStatsSnapshot {
            frames_sent: inner.frames_sent,
            frames_acked: inner.frames_acked,
            outstanding: inner.pending.len() as u32,
            max_outstanding: inner.max_outstanding,
            unmatched_acks: inner.unmatched_acks,
            last_lag_ms: inner.last_lag_ms,
            max_lag_ms: inner.max_lag_ms,
            avg_lag_ms: inner.ewma_lag_ms.round() as u32,
            h264_frames: inner.h264_frames,
            h264_keyframes: inner.h264_keyframes,
            bytes_to_browser: inner.bytes_to_browser,
            bytes_to_guacd: inner.bytes_to_guacd,
            overpaint_ops: inner.overpaint.total,
            overpaint_by_op: inner
                .overpaint
                .counts
                .iter()
                .map(|(op, count)| ((*op).to_string(), *count))
                .collect(),
            uptime_secs: self.started.elapsed().as_secs(),
        }
    }
}

/// A drawing instruction that names a layer, captured while scanning a chunk.
///
/// Only the opcode and the arguments needed to describe the operation in a log
/// line are kept, and they borrow from the chunk rather than being copied: a
/// session that mixes codecs legitimately can emit thousands of these a second,
/// and almost all of them turn out to target a layer nobody is passing H.264
/// through.
struct Draw<'a> {
    op: &'static str,
    layer: i32,
    /// Operation-specific detail, already formatted as protocol elements.
    args: [&'a str; 4],
}

impl<'a> Draw<'a> {
    /// Parses the drawing instructions that can put pixels on a layer, or
    /// change what the layer shows. Returns `None` for anything else, which is
    /// most of the stream.
    fn parse(instr: &'a str) -> Option<Draw<'a>> {
        // Argument positions are counted from the first element after the
        // opcode, and follow the Guacamole protocol's instruction definitions.
        let (op, rest, layer_at, args_at) = if let Some(rest) = instr.strip_prefix("3.img,") {
            // img,<stream>,<mask>,<layer>,<mime>,<x>,<y>
            ("img", rest, 2usize, [4usize, 5, usize::MAX, usize::MAX])
        } else if let Some(rest) = instr.strip_prefix("4.copy,") {
            // copy,<srclayer>,<x>,<y>,<w>,<h>,<mask>,<dstlayer>,<dstx>,<dsty>
            ("copy", rest, 6, [7, 8, 0, usize::MAX])
        } else if let Some(rest) = instr.strip_prefix("4.rect,") {
            // rect,<layer>,<x>,<y>,<w>,<h>
            ("rect", rest, 0, [1, 2, 3, 4])
        } else if let Some(rest) = instr.strip_prefix("5.cfill,") {
            // cfill,<mask>,<layer>,<r>,<g>,<b>,<a> — the colour matters: a fill
            // with zero components is what a black rectangle looks like on the
            // wire, and is indistinguishable on screen from one never painted.
            ("cfill", rest, 1, [2, 3, 4, 5])
        } else if let Some(rest) = instr.strip_prefix("4.size,") {
            // size,<layer>,<w>,<h> — a resize clears the browser's canvas, so
            // it blanks the layer whether or not anything is drawn afterwards.
            ("size", rest, 0, [1, 2, usize::MAX, usize::MAX])
        } else if let Some(rest) = instr.strip_prefix("7.dispose,") {
            ("dispose", rest, 0, [usize::MAX; 4])
        } else {
            return None;
        };

        let layer = nth_element(rest, layer_at)?.parse::<i32>().ok()?;

        let mut args = [""; 4];
        for (slot, at) in args.iter_mut().zip(args_at) {
            if at != usize::MAX {
                *slot = nth_element(rest, at).unwrap_or("");
            }
        }

        Some(Draw { op, layer, args })
    }

    /// The operation as one log line, given what is known about the layer.
    fn describe(&self, layer: &H264Layer, now: Instant) -> String {
        format!(
            "{} on layer {} [{}] — layer has carried {} H.264 frames \
             ({} keyframes), last {}ms ago",
            self.op,
            self.layer,
            self.args
                .iter()
                .filter(|arg| !arg.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join(","),
            layer.frames,
            layer.keyframes,
            now.saturating_duration_since(layer.last_frame).as_millis(),
        )
    }
}

impl Inner {
    /// Records the drawing instructions that landed on a layer H.264 owns, and
    /// returns the lines worth logging.
    ///
    /// Rate limited in two stages, because the fault being chased is rare but
    /// its symptom is not self-limiting: a bounded number of fully detailed
    /// lines per window, then a periodic summary that keeps counting. A session
    /// left running for a week must not be able to fill a disk, and an episode
    /// that happens once must not be summarised away to nothing.
    fn note_overpaint(&mut self, draws: &[Draw<'_>], now: Instant) -> Option<Vec<String>> {
        let mut logs: Vec<String> = Vec::new();

        for draw in draws {
            let Some(layer) = self.h264_layers.get(&draw.layer) else {
                continue;
            };

            self.overpaint.total += 1;
            *self.overpaint.counts.entry(draw.op).or_insert(0) += 1;

            let window_open = match self.overpaint.window_started {
                Some(started) if now.saturating_duration_since(started) < OVERPAINT_LOG_WINDOW => {
                    true
                }
                _ => {
                    self.overpaint.window_started = Some(now);
                    self.overpaint.logged_in_window = 0;
                    true
                }
            };

            if window_open && self.overpaint.logged_in_window < OVERPAINT_LOG_LIMIT {
                self.overpaint.logged_in_window += 1;
                logs.push(draw.describe(layer, now));
            }
        }

        // Summarise only when something has happened since the last summary,
        // and never more often than the interval.
        let due = match self.overpaint.last_summary {
            Some(at) => now.saturating_duration_since(at) >= OVERPAINT_SUMMARY_INTERVAL,
            None => true,
        };

        if due && self.overpaint.total > self.overpaint.summarised_total {
            self.overpaint.last_summary = Some(now);
            self.overpaint.summarised_total = self.overpaint.total;
            logs.push(format!(
                "overpaint totals: {}",
                self.overpaint
                    .counts
                    .iter()
                    .map(|(op, count)| format!("{op}={count}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            ));
        }

        if logs.is_empty() {
            None
        } else {
            Some(logs)
        }
    }
}

/// Yield each instruction start in `text` as a slice running to the end of the
/// buffer (callers only ever inspect the opcode and the first few arguments).
///
/// Instruction boundaries are found by walking element length prefixes rather
/// than by splitting on `;`, because an element *value* may contain a `;` —
/// clipboard text, for instance. Walking is also the cheaper option: each
/// element is skipped by its declared length, so a multi-megabyte blob payload
/// costs one jump rather than a scan.
///
/// `text` always ends on an instruction boundary (see `guacd_to_ws`). If a
/// malformed element is hit anyway, iteration stops rather than guessing.
fn instruction_starts(text: &str) -> impl Iterator<Item = &str> {
    InstructionStarts { rest: text }
}

struct InstructionStarts<'a> {
    rest: &'a str,
}

impl<'a> Iterator for InstructionStarts<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<&'a str> {
        if self.rest.is_empty() {
            return None;
        }

        let start = self.rest;
        let mut cursor = start;
        loop {
            match split_element(cursor) {
                Some((_, rest, b';')) => {
                    self.rest = rest;
                    break;
                }
                Some((_, rest, _)) => cursor = rest,
                None => {
                    // Malformed or truncated: yield what we have and stop, so a
                    // bad chunk costs telemetry rather than looping.
                    self.rest = "";
                    break;
                }
            }
        }

        Some(start)
    }
}

/// Split one `LENGTH.VALUE` element off the front, returning the value, the
/// remainder past the separator, and the separator itself (`,` or `;`).
/// `None` if the element is malformed or truncated.
fn split_element(data: &str) -> Option<(&str, &str, u8)> {
    let dot = data.find('.')?;
    let len: usize = data[..dot].parse().ok()?;
    let value_start = dot + 1;
    let value_end = value_start.checked_add(len)?;
    if value_end > data.len() || !data.is_char_boundary(value_end) {
        return None;
    }
    let terminator = match data.as_bytes().get(value_end) {
        Some(&sep @ (b',' | b';')) => sep,
        _ => return None,
    };
    Some((
        &data[value_start..value_end],
        &data[value_end + 1..],
        terminator,
    ))
}

/// The value and remainder of the leading element, discarding the separator.
fn next_element(data: &str) -> Option<(&str, &str)> {
    split_element(data).map(|(value, rest, _)| (value, rest))
}

/// The element `index` positions along, skipping those before it.
fn nth_element(data: &str, index: usize) -> Option<&str> {
    let mut rest = data;
    for _ in 0..index {
        rest = next_element(rest)?.1;
    }
    next_element(rest).map(|(value, _)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_lag_across_the_sync_handshake() {
        let stats = FrameStats::new();
        stats.observe_to_browser("4.sync,13.1700000000000,1.1;");
        let snap = stats.snapshot();
        assert_eq!(snap.frames_sent, 1);
        assert_eq!(snap.outstanding, 1);

        stats.observe_to_guacd("4.sync,13.1700000000000;");
        let snap = stats.snapshot();
        assert_eq!(snap.frames_acked, 1);
        assert_eq!(snap.outstanding, 0);
        assert_eq!(snap.unmatched_acks, 0);
    }

    #[test]
    fn ack_supersedes_older_unacked_frames() {
        let stats = FrameStats::new();
        stats.observe_to_browser("4.sync,1.1,1.1;4.sync,1.2,1.1;4.sync,1.3,1.1;");
        assert_eq!(stats.snapshot().outstanding, 3);

        // Client skipped ahead: acking frame 3 clears 1 and 2 with it.
        stats.observe_to_guacd("4.sync,1.3;");
        let snap = stats.snapshot();
        assert_eq!(snap.outstanding, 0);
        assert_eq!(snap.frames_acked, 1);
    }

    #[test]
    fn unmatched_ack_is_counted_not_matched() {
        let stats = FrameStats::new();
        stats.observe_to_browser("4.sync,1.1,1.1;");
        stats.observe_to_guacd("4.sync,1.9;");
        let snap = stats.snapshot();
        assert_eq!(snap.unmatched_acks, 1);
        assert_eq!(snap.frames_acked, 0);
        assert_eq!(snap.outstanding, 1);
    }

    #[test]
    fn counts_h264_frames_and_keyframes() {
        let stats = FrameStats::new();
        // h264,<stream>,<layer>,<keyframe>,<x>,<y>,<w>,<h>
        stats.observe_to_browser("4.h264,1.5,1.0,1.1,1.0,1.0,4.1920,4.1080;");
        stats.observe_to_browser("4.h264,1.5,1.0,1.0,1.0,1.0,4.1920,4.1080;");
        let snap = stats.snapshot();
        assert_eq!(snap.h264_frames, 2);
        assert_eq!(snap.h264_keyframes, 1);
    }

    #[test]
    fn embedded_semicolon_does_not_fabricate_frames() {
        let stats = FrameStats::new();
        // Clipboard payload containing something that looks like a sync.
        stats.observe_to_browser("9.clipboard,1.0,23.x;4.sync,13.9999999999;;");
        assert_eq!(stats.snapshot().frames_sent, 0);
    }

    #[test]
    fn ignores_instructions_we_do_not_track() {
        let stats = FrameStats::new();
        stats.observe_to_browser("3.img,1.1,1.2,1.0,9.image/png,1.0,1.0;4.blob,1.1,4.AAAA;");
        let snap = stats.snapshot();
        assert_eq!(snap.frames_sent, 0);
        assert_eq!(snap.h264_frames, 0);
        assert!(snap.bytes_to_browser > 0);
    }

    #[test]
    fn overpaint_is_reported_only_for_layers_carrying_h264() {
        let stats = FrameStats::new();

        // Before any H.264, an image on layer 0 is just an image.
        assert!(stats
            .observe_to_browser("3.img,1.1,1.2,1.0,9.image/png,1.0,1.0;")
            .is_none());

        stats.observe_to_browser("4.h264,1.5,1.0,1.1,1.0,1.0,4.1920,4.1080;");

        // An image on a layer H.264 owns is drawn from a buffer guacd never
        // filled, and must be reported.
        let logs = stats
            .observe_to_browser("3.img,1.1,1.2,1.0,9.image/png,1.0,1.0;")
            .expect("overpaint on the H.264 layer should be reported");
        assert!(logs.iter().any(|line| line.starts_with("img on layer 0")));

        // Another layer is unaffected.
        assert!(stats
            .observe_to_browser("3.img,1.1,1.2,1.1,9.image/png,1.0,1.0;")
            .is_none());

        let snap = stats.snapshot();
        assert_eq!(snap.overpaint_ops, 1);
        assert_eq!(snap.overpaint_by_op.get("img"), Some(&1));
    }

    #[test]
    fn black_fill_and_resize_of_an_h264_layer_are_reported() {
        let stats = FrameStats::new();
        stats.observe_to_browser("4.h264,1.5,1.0,1.1,1.0,1.0,4.1920,4.1080;");

        let logs = stats
            .observe_to_browser("5.cfill,1.2,1.0,1.0,1.0,1.0,3.255;4.size,1.0,4.1920,4.1080;")
            .expect("a fill and a resize on the H.264 layer should be reported");

        assert!(logs.iter().any(|line| line.starts_with("cfill on layer 0")));
        assert!(logs.iter().any(|line| line.starts_with("size on layer 0")));
    }
}
