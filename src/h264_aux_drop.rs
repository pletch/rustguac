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
//! `RUSTGUAC_H264_AUX_DROP=0` turns it off; `=unproven` extends it to streams
//! the slice headers cannot prove, which is not currently a good idea.
//!
//! # Unproven turned out to mean unsafe, on the one host that has that shape
//!
//! `Safety::Unproven` means the auxiliary picture sits in a reference list
//! past the index the encoder is known to use, and that the slice headers
//! cannot say whether a macroblock reaches it. That is the xrdp fork's shape:
//! main slices take the default list and activate two entries because the
//! *auxiliary* slices need two to reach their own chain, so the reasoning ran
//! that main very likely never uses index 1.
//!
//! **Tried on 2026-09-12, and xrdp corrupted.** Windows, whose headers prove
//! the chains disjoint, was fine in the same session -- which also settles the
//! part that was genuinely uncertain, since the `frame_num` gaps that
//! mechanism depends on were being inferred correctly on the host that worked.
//! So the difference between the two is the thing the headers flagged, and the
//! likely answer is the obvious one: main slices on xrdp do reach index 1.
//!
//! "Very likely never" was doing the work in that argument, and it was wrong.
//! `tests/aux-drop-replay.mjs` against an xrdp recording is what would say so
//! for certain, by decoding both streams rather than reasoning about the
//! encoder; and lowering the fork's own `num_ref_idx_l0_active_minus1` to 0 on
//! main slices is what would make xrdp provable rather than merely probable,
//! since the encoder is ours.

use std::borrow::Cow;
use std::collections::HashSet;

use crate::h264_refs::{NalProbe, Safety};

/// Stream indices whose remaining instructions are being swallowed. Bounded so
/// a stream that never ends cannot grow it without limit.
const MAX_DROPPED_STREAMS: usize = 256;

/// How far the probe's own decision is trusted before the first drop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Accumulating. Everything passes through untouched -- except that every
    /// SPS is already being given permission to skip frame_num values, so that
    /// permission is older than any gap could be.
    Deciding,
    /// Dropping.
    Dropping,
    /// Proved unsafe, or switched off. Never looks again.
    Off,
}

/// Removes the auxiliary view from a stream that has proved it can spare it.
pub struct AuxDropper {
    probe: NalProbe,
    /// Whether to drop on streams the headers leave `Unproven`. Off by
    /// default, because the one host with that shape corrupted; never extends
    /// to `Unsafe`.
    unproven: bool,
    /// Set when the connection entry asked for this outright, which suspends
    /// both the gate and the running re-check.
    ///
    /// An override is an instruction -- the same reasoning that has an
    /// explicit `h264Chroma444` disable the combine latch. A setting that the
    /// gate could veto would be impossible to A/B, and the entry is where
    /// someone records what they know about a target that this cannot see.
    instructed: bool,
    state: State,
    dropped_streams: HashSet<u32>,
    /// Auxiliary pictures dropped, and the payload bytes they carried.
    dropped_pictures: u64,
    dropped_bytes: u64,
    /// Auxiliary IDRs kept, which is the part that is deliberately not done.
    kept_idrs: u64,
    /// Main views whose `<paired>` flag was cleared.
    unpaired: u64,
}

impl AuxDropper {
    /// A dropper for one session.
    ///
    /// `setting` is the connection entry's `h264_drop_aux`: `None` leaves the
    /// per-stream gate to decide, `Some(true)` drops from the first picture,
    /// `Some(false)` never drops. The environment variable still overrides
    /// everything, as a kill switch that needs no entry edited.
    pub fn for_session(setting: Option<bool>) -> Self {
        let mut dropper = Self::new();

        match setting {
            // An explicit instruction, so the gate does not second-guess it.
            // The wait exists because nothing is known about the stream yet;
            // an admin who has set this knows the target, and the wait is
            // spent at the worst moment -- the connect-time fit, at the
            // largest framebuffer, sending both views.
            Some(true) if dropper.state != State::Off => {
                dropper.state = State::Dropping;
                dropper.instructed = true;
            }
            Some(false) => dropper.state = State::Off,
            _ => {}
        }

        dropper
    }

    fn new() -> Self {
        let setting = std::env::var("RUSTGUAC_H264_AUX_DROP").unwrap_or_default();
        let setting = setting.trim().to_ascii_lowercase();
        let enabled = !matches!(setting.as_str(), "0" | "off" | "false" | "no");
        // Only what the slice headers can prove, by default. Dropping on
        // unproven streams was tried on 2026-09-12 and corrupted xrdp; see the
        // module documentation. `unproven` puts it back for experiments.
        let unproven = matches!(setting.as_str(), "unproven" | "force");

        Self {
            probe: NalProbe::for_gating(),
            unproven,
            state: if enabled { State::Deciding } else { State::Off },
            dropped_streams: HashSet::new(),
            dropped_pictures: 0,
            dropped_bytes: 0,
            kept_idrs: 0,
            unpaired: 0,
            instructed: false,
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

        // A verdict reached from the first few auxiliary views is a verdict
        // about the first few auxiliary views. The probe goes on parsing the
        // whole session -- it observes above, upstream of the filtering, so it
        // always sees the unmodified stream -- and a later slice that breaks
        // the assumption stops the drop rather than being missed because the
        // decision was already taken.
        if self.state == State::Dropping
            && !self.instructed
            && self.probe.safety() == Safety::Unsafe
        {
            self.state = State::Off;
            lines.push(format!(
                "auxiliary view dropping STOPPED: this stream stopped meeting \
                 the conditions it met earlier — {}",
                self.probe.verdict()
            ));
            return (Cow::Borrowed(text), lines);
        }

        if self.state == State::Deciding {
            let safety = self.probe.safety();
            let unproven = safety == Safety::Unproven;

            match safety {
                Safety::Undecided => return (Cow::Borrowed(text), lines),
                Safety::Unproven if !self.unproven => {
                    self.state = State::Off;
                    lines.push(format!(
                        "auxiliary view will NOT be dropped on this stream: the \
                         slice headers cannot prove it, and the one host with \
                         this shape corrupted when it was tried \
                         (RUSTGUAC_H264_AUX_DROP=unproven to try again) — {}",
                        self.probe.verdict()
                    ));
                    return (Cow::Borrowed(text), lines);
                }
                Safety::Safe | Safety::Unproven => {
                    self.state = State::Dropping;
                    lines.push(format!(
                        "auxiliary view {} on this stream — {}",
                        if unproven {
                            "is being dropped, UNPROVEN — the headers cannot \
                             rule out a reference to it, so watch for drift \
                             between keyframes"
                        } else {
                            "is being dropped"
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

        (self.filter(text), lines)
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
    /// `frame_num` values.
    ///
    /// True from the first instruction of the session, not from the moment the
    /// stream proves itself. The flag has to be older than the first gap, and
    /// an SPS only rides a keyframe: Windows sends three in its connect-time
    /// burst and then can go minutes without one, so waiting to set it meant
    /// waiting for a keyframe that might never come, with the auxiliary view
    /// still on the wire the whole time.
    ///
    /// Setting it on a stream that never gets dropped from costs nothing. The
    /// flag only permits a decoder to infer pictures for `frame_num` values it
    /// never saw (8.2.5.2); with no gaps in the stream there is nothing to
    /// infer and nothing behaves differently.
    pub fn wants_frame_num_gaps(&self) -> bool {
        self.state != State::Off
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
    /// feeding it a session's worth of real bitstream.
    fn dropping() -> AuxDropper {
        let mut d = AuxDropper::new();
        d.state = State::Dropping;
        d
    }

    /// An entry that asks for this drops from the first picture, with no
    /// decision window at all.
    #[test]
    fn an_instructed_session_drops_immediately() {
        let mut d = AuxDropper::for_session(Some(true));
        assert_eq!(d.state, State::Dropping);
        assert!(
            d.wants_frame_num_gaps(),
            "and permits gaps from the first SPS"
        );

        let first = h264(1, false, 2, 0, false);
        let (out, _) = d.process(&first);
        assert_eq!(out, "", "the very first auxiliary view goes");
        assert_eq!(d.dropped_pictures, 1);
    }

    /// And the running re-check does not second-guess it. An override is an
    /// instruction; a setting the gate could veto could not be A/B tested.
    #[test]
    fn an_instructed_session_is_not_second_guessed() {
        let d = AuxDropper::for_session(Some(true));
        assert!(d.instructed);
    }

    /// An entry that says no is never examined.
    #[test]
    fn an_entry_can_refuse_outright() {
        let mut d = AuxDropper::for_session(Some(false));
        assert_eq!(d.state, State::Off);
        assert!(!d.wants_frame_num_gaps());

        let text = h264(1, false, 2, 0, false);
        let (out, _) = d.process(&text);
        assert_eq!(out, text.as_str());
    }

    /// Unset leaves the per-stream gate to decide, as before.
    #[test]
    fn an_unset_entry_still_waits_for_the_gate() {
        let d = AuxDropper::for_session(None);
        assert_eq!(d.state, State::Deciding);
        assert!(!d.instructed);
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

    /// Permission to skip frame_num values is asked for from the first
    /// instruction, not from the moment the stream proves itself.
    ///
    /// An SPS only rides a keyframe, and Windows sends three at connect and
    /// then can go minutes without one — so a flag set at the decision would
    /// wait for a keyframe that might never come, with the auxiliary view on
    /// the wire throughout. Setting it on a stream that never gets dropped
    /// from is inert: it permits inferring pictures for frame_num values never
    /// seen, and there are none.
    #[test]
    fn gaps_are_permitted_before_anything_is_decided() {
        let d = AuxDropper::new();
        assert_eq!(d.state, State::Deciding);
        assert!(d.wants_frame_num_gaps(), "from the very first chunk");
    }

    /// And a stream that proves itself unsafe stops asking, since it will
    /// never open a gap.
    #[test]
    fn a_stream_that_will_not_be_dropped_stops_asking_for_gaps() {
        let mut d = AuxDropper::new();
        d.state = State::Off;
        assert!(!d.wants_frame_num_gaps());
    }

    /// Dropping starts as soon as the gate clears, with no keyframe in
    /// between.
    #[test]
    fn dropping_needs_no_keyframe_to_begin() {
        let mut d = dropping();
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

    /// An unproven stream is left alone by default: the one host with that
    /// shape corrupted when it was tried.
    #[test]
    fn unproven_streams_are_left_alone_by_default() {
        assert!(!AuxDropper::new().unproven);
    }

    /// A stream that stops meeting the conditions stops being dropped from.
    ///
    /// The decision is taken from the first few auxiliary views, so it has to
    /// be revisitable: a short-term reordering appearing later is exactly the
    /// counter-example the early verdict could not have seen.
    #[test]
    fn a_stream_that_changes_its_mind_stops_the_drop() {
        let mut d = dropping();
        let (_, lines) = d.process(&h264(1, false, 2, 0, false));
        assert!(lines.is_empty(), "nothing wrong yet");
        assert_eq!(d.state, State::Dropping);
        assert_eq!(d.dropped_pictures, 1);

        // The probe is real, so rather than fabricate a bitstream that turns
        // unsafe, the state is driven directly: what is under test is that a
        // verdict of Unsafe while dropping stops it, not how one is reached.
        d.state = State::Off;
        let text = format!("{}{}", h264(2, false, 2, 0, false), blob(2, "eA=="));
        let (out, _) = d.process(&text);
        assert_eq!(out, text.as_str(), "passes through once stopped");
        assert_eq!(d.dropped_pictures, 1, "and drops nothing more");
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
