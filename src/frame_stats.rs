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

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Instant;

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
}

/// Live frame telemetry for one session. Shared between the session and both
/// halves of its WebSocket proxy.
pub struct FrameStats {
    inner: Mutex<Inner>,
    started: Instant,
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
    pub uptime_secs: u64,
}

impl FrameStats {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            started: Instant::now(),
        }
    }

    /// Account for a chunk of guacd → browser traffic.
    ///
    /// `text` always ends on an instruction boundary (see `guacd_to_ws`), so
    /// every instruction start in it is a real one.
    pub fn observe_to_browser(&self, text: &str) {
        let mut sync_timestamps: Vec<i64> = Vec::new();
        let mut h264: Vec<bool> = Vec::new();

        for instr in instruction_starts(text) {
            if let Some(rest) = instr.strip_prefix("4.sync,") {
                if let Some((ts, _)) = next_element(rest) {
                    if let Ok(ts) = ts.parse::<i64>() {
                        sync_timestamps.push(ts);
                    }
                }
            } else if let Some(rest) = instr.strip_prefix("4.h264,") {
                // h264,<stream>,<layer>,<keyframe>,... — the third argument is
                // the keyframe flag.
                h264.push(nth_element(rest, 2).map(|v| v != "0").unwrap_or(false));
            }
        }

        let mut inner = self.inner.lock().unwrap();
        inner.bytes_to_browser += text.len() as u64;

        for is_keyframe in h264 {
            inner.h264_frames += 1;
            if is_keyframe {
                inner.h264_keyframes += 1;
            }
        }

        let now = Instant::now();
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
            uptime_secs: self.started.elapsed().as_secs(),
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
}
