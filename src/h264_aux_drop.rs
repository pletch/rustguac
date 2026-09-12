//! Drops an AVC444 stream's auxiliary chroma view on the way to the browser,
//! where the stream proves it can be dropped.
//!
//! # What this is for
//!
//! The combine gate in `H264Decoder.js` gives up 4:4:4 by discarding the
//! auxiliary view *after* decoding it, so it removes the main-thread cost and
//! nothing else: both views have already crossed the link, and both have been
//! decoded. This removes them from the wire instead, which is the same picture
//! for less bandwidth and one decode per picture rather than two.
//!
//! It is an alternative to the never-combine setting rather than a replacement
//! for it: never-combine works on any stream, this one only where the encoder
//! has kept the two views' references apart.
//!
//! # Why it needs a gate
//!
//! The two views are one H.264 sequence sharing one decoded picture buffer, so
//! dropping access units is safe only if nothing surviving predicts from one.
//! `crate::h264_refs` reads that out of the slice headers, and the answer
//! differs by host: Windows names its references explicitly with disjoint
//! long-term indices and is provably safe; the xrdp fork relies on the default
//! list ordering and activates two entries, which reaches the auxiliary
//! picture at index 1. So this is decided per stream, from that stream, and a
//! host it cannot prove anything about is left alone.
//!
//! Nothing is dropped until `Safety::Safe`, which needs 150 access units —
//! past the connect-time keyframe burst, which is not representative of
//! anything.
//!
//! # What it does, in order
//!
//! 1. **Waits.** Everything passes through while the probe accumulates.
//! 2. **Arms.** Once the stream proves itself, every SPS from that point gets
//!    `gaps_in_frame_num_value_allowed_flag` set. Dropping a reference picture
//!    turns every `frame_num` it consumed into a hole, and with the flag clear
//!    a decoder is entitled to treat that as a broken stream; with it set the
//!    standard requires it to infer the missing pictures and carry on.
//! 3. **Starts at a keyframe.** Not before: the decoder must have seen an SPS
//!    permitting gaps before the first gap reaches it, and in Annex B the
//!    in-band parameter sets are what govern.
//! 4. **Drops** the `h264`, `blob` and `end` instructions of every non-IDR
//!    auxiliary view, and clears the trailing `<paired>` flag on main views so
//!    the client paints them instead of holding them for a view that is no
//!    longer coming.
//!
//! # What it deliberately does not drop
//!
//! **Auxiliary IDRs.** An IDR with `long_term_reference_flag` set marks every
//! other reference unused and claims `LongTermFrameIdx` 0 (8.2.5.1), so it is
//! a buffer reset the surviving stream is written against, and a Windows
//! capture shows a main slice naming long-term 0 immediately after one. That
//! interaction is unresolved. They are two pictures in two hundred, so keeping
//! them costs almost nothing and removes the question: an auxiliary view that
//! arrives is decoded and never painted, exactly as before.
//!
//! Dropping is also safe upstream. guacd calls `guac_client_free_stream`
//! immediately after writing the blobs, so no acknowledgement is expected for
//! a stream that is swallowed here and no flow control depends on one.
//!
//! # Where it sits
//!
//! In `guacd_to_ws`, after the recording tee — so recordings keep the full
//! 4:4:4 stream and `SessionRecording.js` is unaffected — and before the
//! colour rewrite and the binary blob splitter.
//!
//! `RUSTGUAC_H264_AUX_DROP=0` turns it off, and `=force` extends it to the
//! streams the headers cannot clear.
//!
//! # Forcing
//!
//! `Safety::Unproven` is not `Safety::Unsafe`. It means the auxiliary picture
//! sits in a reference list past the index the encoder is known to use, and
//! that the slice headers cannot say whether a macroblock reaches it -- the
//! xrdp fork's shape, where main slices take the default list and activate two
//! entries because the *auxiliary* slices need two to reach their own chain.
//!
//! `=force` drops on those streams as well. It does **not** extend to
//! `Unsafe`, which is a stream whose headers say outright that main predicts
//! from chroma; forcing there would be asking for a broken picture.
//!
//! Forcing is for finding out. The two ways to actually settle such a stream
//! are `tests/aux-drop-replay.mjs`, which strips the auxiliary views from a
//! recording and compares the decode against the original, and lowering the
//! encoder's `num_ref_idx_l0_active_minus1` where the encoder is yours.

use std::borrow::Cow;
use std::collections::HashSet;

use crate::h264_refs::{NalProbe, Safety};

/// Stream indices whose remaining instructions are being swallowed. Bounded so
/// a stream that never ends cannot grow it without limit.
const MAX_DROPPED_STREAMS: usize = 256;

/// How far the probe's own decision is trusted before the first drop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Accumulating. Everything passes through untouched.
    Deciding,
    /// Proved safe. SPSes are being rewritten to permit gaps, and the next
    /// main-view keyframe starts the drop.
    Armed,
    /// Dropping.
    Dropping,
    /// Proved unsafe, or switched off. Never looks again.
    Off,
}

/// Removes the auxiliary view from a stream that has proved it can spare it.
pub struct AuxDropper {
    probe: NalProbe,
    /// Whether to drop on streams the headers leave `Unproven`. Never extends
    /// to `Unsafe`.
    force: bool,
    state: State,
    dropped_streams: HashSet<u32>,
    /// Auxiliary pictures dropped, and the payload bytes they carried.
    dropped_pictures: u64,
    dropped_bytes: u64,
    /// Auxiliary IDRs kept, which is the part that is deliberately not done.
    kept_idrs: u64,
    /// Main views whose `<paired>` flag was cleared.
    unpaired: u64,
    /// Set at the keyframe that started the drop, so the caller can say so
    /// once. Arming and engaging are separated by however long the host takes
    /// to send its next keyframe, which on a quiet Windows desktop can be a
    /// long time and is the difference between "will drop" and "is dropping".
    engaged: bool,
}

impl AuxDropper {
    pub fn new() -> Self {
        let setting = std::env::var("RUSTGUAC_H264_AUX_DROP").unwrap_or_default();
        let setting = setting.trim();
        let enabled = !matches!(setting, "0" | "off" | "false" | "no");
        let force = matches!(setting, "force" | "unproven");

        Self {
            probe: NalProbe::for_gating(),
            force,
            state: if enabled { State::Deciding } else { State::Off },
            dropped_streams: HashSet::new(),
            dropped_pictures: 0,
            dropped_bytes: 0,
            kept_idrs: 0,
            unpaired: 0,
            engaged: false,
        }
    }

    /// Reads one chunk of the guacd → browser stream, returning what should be
    /// sent in its place and any lines to log.
    ///
    /// The chunk always ends on an instruction boundary (see `guacd_to_ws`),
    /// so every instruction start in it is a real one, and an instruction is
    /// never split across two calls.
    pub fn process<'a>(&mut self, text: &'a str) -> (Cow<'a, str>, Vec<String>) {
        let mut lines = self.probe.observe(text);

        if self.state == State::Off {
            return (Cow::Borrowed(text), lines);
        }

        if self.state == State::Deciding {
            let safety = self.probe.safety();
            let forced = self.force && safety == Safety::Unproven;

            match safety {
                Safety::Undecided => return (Cow::Borrowed(text), lines),
                Safety::Unproven if !forced => {
                    self.state = State::Off;
                    lines.push(format!(
                        "auxiliary view will NOT be dropped on this stream; the \
                         slice headers cannot rule out a reference to it, and \
                         RUSTGUAC_H264_AUX_DROP=force is what says to try \
                         anyway — {}",
                        self.probe.verdict()
                    ));
                    return (Cow::Borrowed(text), lines);
                }
                Safety::Safe | Safety::Unproven => {
                    self.state = State::Armed;
                    lines.push(format!(
                        "auxiliary view {} on this stream; permitting \
                         frame_num gaps and waiting for a keyframe to start — \
                         {}",
                        if forced {
                            "is being dropped BY FORCE, unproven"
                        } else {
                            "can be dropped"
                        },
                        self.probe.verdict()
                    ));
                }
                Safety::Unsafe => {
                    self.state = State::Off;
                    lines.push(format!(
                        "auxiliary view will NOT be dropped on this stream — {}",
                        self.probe.verdict()
                    ));
                    return (Cow::Borrowed(text), lines);
                }
            }
        }

        let filtered = self.filter(text);
        if self.engaged {
            self.engaged = false;
            lines.push("keyframe reached; auxiliary view is now being dropped".into());
        }
        (filtered, lines)
    }

    /// Rewrites one chunk, borrowing it unchanged when nothing needed doing --
    /// which is most chunks even while dropping, since only some carry an
    /// auxiliary view.
    fn filter<'a>(&mut self, text: &'a str) -> Cow<'a, str> {
        let mut out: Option<String> = None;

        for instr in crate::frame_stats::instruction_starts(text) {
            let action = self.classify(instr);

            match (&mut out, &action) {
                // Still identical to the input: nothing copied yet.
                (None, Action::Keep) => {}
                (None, _) => {
                    // First edit in this chunk: copy what came before it.
                    // `instr` is a suffix of `text`, so its length gives the
                    // offset of this instruction directly.
                    let taken = text.len() - instr.len();
                    let mut buf = String::with_capacity(text.len());
                    buf.push_str(&text[..taken]);
                    out = Some(buf);
                }
                _ => {}
            }

            if let Some(buf) = out.as_mut() {
                match action {
                    Action::Keep => buf.push_str(instr_slice(instr)),
                    Action::Drop => {}
                    Action::Replace(ref s) => buf.push_str(s),
                }
            }
        }

        match out {
            Some(buf) => Cow::Owned(buf),
            None => Cow::Borrowed(text),
        }
    }

    /// What to do with one instruction.
    fn classify(&mut self, instr: &str) -> Action {
        if let Some(rest) = instr.strip_prefix("4.h264,") {
            return self.classify_h264(rest);
        }

        if let Some(rest) = instr.strip_prefix("4.blob,") {
            if let Some(index) = leading_index(rest) {
                if self.dropped_streams.contains(&index) {
                    // Counted from the base64 length rather than by decoding:
                    // the saving is what is not sent, and that is this.
                    if let Some(payload) = crate::frame_stats::elements(rest).nth(1) {
                        self.dropped_bytes += (payload.len() / 4 * 3) as u64;
                    }
                    return Action::Drop;
                }
            }
            return Action::Keep;
        }

        if let Some(rest) = instr.strip_prefix("3.end,") {
            if let Some(index) = leading_index(rest) {
                if self.dropped_streams.remove(&index) {
                    return Action::Drop;
                }
            }
            return Action::Keep;
        }

        Action::Keep
    }

    /// `h264,<stream>,<layer>,<keyframe>,<x>,<y>,<w>,<h>,<view>,<numrects>,
    /// [<x> <y> <w> <h>]...,<paired>`
    fn classify_h264(&mut self, rest: &str) -> Action {
        // Indices, counted from the first element after the opcode:
        //   0 stream, 1 layer, 2 keyframe, 3 x, 4 y, 5 width, 6 height,
        //   7 view, 8 numrects, then 4 per rect, then paired.
        let args: Vec<&str> = crate::frame_stats::elements(rest).collect();
        if args.len() < 9 {
            return Action::Keep;
        }

        let Ok(index) = args[0].parse::<u32>() else {
            return Action::Keep;
        };
        let keyframe = args[2] == "1";
        let view: u8 = args[7].parse().unwrap_or(0);

        if view != 0 {
            if keyframe {
                // Deliberately kept; see the module documentation.
                self.kept_idrs += 1;
                return Action::Keep;
            }
            if self.state != State::Dropping {
                return Action::Keep;
            }
            if self.dropped_streams.len() >= MAX_DROPPED_STREAMS {
                self.dropped_streams.clear();
            }
            self.dropped_streams.insert(index);
            self.dropped_pictures += 1;
            return Action::Drop;
        }

        // A main view. Armed becomes Dropping at the first keyframe, so the
        // decoder has seen an SPS permitting gaps before the first gap.
        if self.state == State::Armed && keyframe {
            self.state = State::Dropping;
            self.engaged = true;
        }

        if self.state != State::Dropping {
            return Action::Keep;
        }

        // `<paired>` promises an auxiliary view that is no longer coming, and
        // a client that believes it holds the main view's paint waiting for
        // one. It trails the rects, which vary in number.
        let Ok(num_rects) = args[8].parse::<usize>() else {
            return Action::Keep;
        };
        let paired_at = 9 + num_rects * 4;
        if args.get(paired_at).copied() != Some("1") {
            return Action::Keep;
        }

        let mut args = args;
        args[paired_at] = "0";
        self.unpaired += 1;
        Action::Replace(encode_instruction("h264", &args))
    }

    /// What the session saved, for the disconnect log.
    pub fn summary(&self) -> Option<String> {
        if self.dropped_pictures == 0 {
            return None;
        }
        Some(format!(
            "dropped {} auxiliary pictures ({} KiB), kept {} auxiliary \
             keyframes, unpaired {} main views",
            self.dropped_pictures,
            self.dropped_bytes / 1024,
            self.kept_idrs,
            self.unpaired
        ))
    }

    /// Whether an SPS crossing now should be given permission to skip
    /// `frame_num` values. True from the moment the stream proves itself, so
    /// the permission is always older than the first gap.
    pub fn wants_frame_num_gaps(&self) -> bool {
        matches!(self.state, State::Armed | State::Dropping)
    }
}

enum Action {
    Keep,
    Drop,
    Replace(String),
}

/// One instruction, up to and including its terminating `;`.
///
/// `instruction_starts` yields a suffix of the chunk rather than a single
/// instruction, so the terminator has to be found again to copy just this one.
fn instr_slice(instr: &str) -> &str {
    match instr.find(';') {
        Some(_) => {
            let mut rest = instr;
            let mut taken = 0;
            loop {
                let Some(dot) = rest.find('.') else {
                    return instr;
                };
                let Ok(len) = rest[..dot].parse::<usize>() else {
                    return instr;
                };
                let end = dot + 1 + len;
                if end >= rest.len() {
                    return instr;
                }
                taken += end + 1;
                let separator = rest.as_bytes()[end];
                rest = &rest[end + 1..];
                if separator == b';' {
                    return &instr[..taken];
                }
            }
        }
        None => instr,
    }
}

fn leading_index(rest: &str) -> Option<u32> {
    crate::frame_stats::elements(rest).next()?.parse().ok()
}

fn encode_instruction(opcode: &str, args: &[&str]) -> String {
    let mut out = String::with_capacity(16 + args.iter().map(|a| a.len() + 6).sum::<usize>());
    out.push_str(&format!("{}.{}", opcode.len(), opcode));
    for arg in args {
        out.push_str(&format!(",{}.{}", arg.len(), arg));
    }
    out.push(';');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One `h264` instruction, built as guac_h264_write_arg() builds it.
    fn h264(index: u32, keyframe: bool, view: u8, rects: usize, paired: bool) -> String {
        let mut args = vec![
            index.to_string(),
            "0".into(),
            u8::from(keyframe).to_string(),
            "0".into(),
            "0".into(),
            "1920".into(),
            "1080".into(),
            view.to_string(),
            rects.to_string(),
        ];
        for r in 0..rects {
            args.extend([r.to_string(), "0".into(), "16".into(), "16".into()]);
        }
        args.push(u8::from(paired).to_string());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        encode_instruction("h264", &refs)
    }

    fn blob(index: u32, payload: &str) -> String {
        encode_instruction("blob", &[&index.to_string(), payload])
    }

    fn end(index: u32) -> String {
        encode_instruction("end", &[&index.to_string()])
    }

    /// A dropper already past its gate, so the filtering can be tested without
    /// feeding it two hundred access units of real bitstream.
    fn dropping() -> AuxDropper {
        let mut d = AuxDropper::new();
        d.state = State::Dropping;
        d
    }

    #[test]
    fn an_auxiliary_picture_goes_with_its_blobs_and_its_end() {
        let mut d = dropping();
        let text = format!(
            "{}{}{}{}{}{}",
            h264(7, false, 0, 0, false),
            blob(7, "bWFpbg=="),
            end(7),
            h264(8, false, 2, 0, false),
            blob(8, "YXV4"),
            end(8)
        );

        let (out, _) = d.process(&text);
        assert!(out.contains("4.h264,1.7"), "{}", out);
        assert!(out.contains("bWFpbg=="), "{}", out);
        assert!(!out.contains("4.h264,1.8"), "{}", out);
        assert!(!out.contains("YXV4"), "{}", out);
        assert_eq!(out.matches("3.end").count(), 1, "{}", out);
        assert_eq!(d.dropped_pictures, 1);
    }

    /// A main view promising a pair that will not arrive would be held unpainted
    /// forever, so the flag has to be cleared -- past the rects, which vary.
    #[test]
    fn the_paired_flag_is_cleared_past_the_rects() {
        for rects in [0, 1, 9] {
            let mut d = dropping();
            let text = h264(3, false, 0, rects, true);
            let (out, _) = d.process(&text);

            assert_ne!(out, text.as_str(), "{} rects: not rewritten", rects);
            assert_eq!(d.unpaired, 1, "{} rects", rects);

            // The rects themselves must survive the rebuild untouched.
            let expected = h264(3, false, 0, rects, false);
            assert_eq!(out, expected.as_str(), "{} rects", rects);
        }
    }

    /// An auxiliary keyframe is a buffer reset the surviving stream is written
    /// against, and the interaction is unresolved. It stays.
    #[test]
    fn an_auxiliary_keyframe_is_kept() {
        let mut d = dropping();
        let text = format!(
            "{}{}{}",
            h264(9, true, 2, 0, false),
            blob(9, "aQ=="),
            end(9)
        );

        let (out, _) = d.process(&text);
        assert_eq!(out, text.as_str());
        assert_eq!(d.kept_idrs, 1);
        assert_eq!(d.dropped_pictures, 0);
    }

    /// Nothing is touched before the stream has proved itself.
    #[test]
    fn nothing_is_dropped_while_deciding() {
        let mut d = AuxDropper::new();
        let text = format!(
            "{}{}{}",
            h264(4, false, 2, 0, false),
            blob(4, "eA=="),
            end(4)
        );

        let (out, _) = d.process(&text);
        assert!(matches!(out, Cow::Borrowed(_)), "should not even copy");
        assert_eq!(out, text.as_str());
    }

    /// Armed waits for a keyframe, so the decoder has seen an SPS permitting
    /// gaps before the first gap reaches it.
    #[test]
    fn arming_waits_for_a_keyframe() {
        let mut d = AuxDropper::new();
        d.state = State::Armed;

        let delta = format!(
            "{}{}",
            h264(1, false, 0, 0, false),
            h264(2, false, 2, 0, false)
        );
        let (out, _) = d.process(&delta);
        assert_eq!(out, delta.as_str(), "a delta must not start the drop");
        assert_eq!(d.dropped_pictures, 0);

        let key = h264(3, true, 0, 0, false);
        d.process(&key);
        assert_eq!(d.state, State::Dropping);

        let aux = h264(4, false, 2, 0, false);
        let (out, _) = d.process(&aux);
        assert_eq!(out, "", "{}", out);
        assert_eq!(d.dropped_pictures, 1);
    }

    /// Instructions this knows nothing about pass through byte for byte, and a
    /// chunk needing no edit is never copied.
    #[test]
    fn unrelated_instructions_are_untouched() {
        let mut d = dropping();
        let text = format!(
            "4.sync,13.1700000000000;{}5.blob2,3.abc;",
            h264(5, false, 0, 2, false)
        );

        let (out, _) = d.process(&text);
        assert!(matches!(out, Cow::Borrowed(_)), "no edit, no copy");
        assert_eq!(out, text.as_str());
    }

    /// The env var is the kill switch, and off means never looking.
    #[test]
    fn the_kill_switch_disables_it() {
        let mut d = AuxDropper::new();
        d.state = State::Off;

        let text = format!("{}{}", h264(6, false, 2, 0, false), blob(6, "eA=="));
        let (out, _) = d.process(&text);
        assert_eq!(out, text.as_str());
        assert_eq!(d.dropped_pictures, 0);
    }

    /// Several instructions in one chunk, with the edit in the middle: the
    /// prefix before the first edit has to be copied exactly once.
    #[test]
    fn an_edit_mid_chunk_keeps_both_sides() {
        let mut d = dropping();
        let text = format!(
            "{}{}{}{}{}",
            h264(1, false, 0, 0, false),
            blob(1, "YQ=="),
            h264(2, false, 2, 0, false),
            blob(2, "Yg=="),
            h264(3, false, 0, 0, false),
        );

        let (out, _) = d.process(&text);
        let expected = format!(
            "{}{}{}",
            h264(1, false, 0, 0, false),
            blob(1, "YQ=="),
            h264(3, false, 0, 0, false),
        );
        assert_eq!(out, expected.as_str());
    }
}
