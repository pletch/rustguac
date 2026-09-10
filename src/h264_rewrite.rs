//! Makes an RDP host's colour range legible to the browser.
//!
//! An SPS that declares `video_full_range_flag = 1` and no colour description
//! is honoured by Chrome's software decoder and ignored by its hardware one.
//! Measured on one browser against two hosts, both decoding to NV12:
//!
//! | host | SPS | reported |
//! |---|---|---|
//! | xrdp fork | `full_range=1`, primaries/transfer/matrix all BT.709 | full |
//! | Windows | `full_range=1`, no description | **limited** |
//!
//! Same client, same hardware path; the description is the only difference.
//! A Windows session therefore renders with blacks crushed to zero and chroma
//! over-saturated by 255/224, and neither end can see it: the host declared
//! the range, and the browser reports limited.
//!
//! This gives Windows the shape xrdp already has, by splicing a BT.709
//! description into the SPS on its way past. That fixes both render paths at
//! once — including `drawImage()`, which no client-side flag can reach — and
//! every client, including third-party ones. See `crate::h264_sps` for the
//! bit-level work and the measurements.
//!
//! Recordings are teed upstream of this and keep the host's original stream,
//! which is what a recording should be. Playback of a Windows recording is
//! subject to the same fault, and `?h264FullRange=on` is the lever there.

use base64::Engine as _;
use std::collections::HashSet;

/// What has been decided about this session's stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// No SPS seen yet, so every video blob is examined.
    Undecided,
    /// This stream's SPS needs a description, and each one is rewritten.
    Rewriting,
    /// This stream needs nothing. Nothing is examined again — which is the
    /// case for xrdp, for any host that already describes its colour, and for
    /// every session with no passthrough at all.
    PassThrough,
}

/// Splices a colour description into the SPS of one session's H.264 stream.
pub struct SpsRewriter {
    state: State,
    /// Stream indices opened by an `h264` instruction. `audio` is deliberately
    /// not tracked: its blobs are not video and decoding them to look for a
    /// start code would be work for nothing.
    h264_streams: HashSet<u32>,
}

impl Default for SpsRewriter {
    fn default() -> Self {
        Self::new()
    }
}

impl SpsRewriter {
    pub fn new() -> Self {
        Self {
            state: State::Undecided,
            h264_streams: HashSet::new(),
        }
    }

    /// Rewrites the SPS in any video blob in `text`, returning the new run of
    /// instructions — or `None` when nothing needed changing, which is the
    /// common case and copies nothing.
    ///
    /// `text` must end on an instruction boundary, as `guacd_to_ws`
    /// guarantees. Anything malformed stops the scan and leaves the remainder
    /// untouched: a blob that cannot be parsed is passed through, never
    /// dropped, since losing one loses a picture.
    pub fn rewrite(&mut self, text: &str) -> Option<String> {
        if self.state == State::PassThrough {
            return None;
        }

        let mut out: Option<String> = None;
        // Start of text not yet copied into `out`.
        let mut pending = 0usize;
        let mut pos = 0usize;

        while pos < text.len() {
            let instruction_start = pos;

            let Some((opcode, mut next, mut terminator)) = crate::binary_blob::element(text, pos)
            else {
                break;
            };

            let mut args: Vec<&str> = Vec::new();
            while terminator == b',' && args.len() < 2 {
                match crate::binary_blob::element(text, next) {
                    Some((value, after, term)) => {
                        args.push(value);
                        next = after;
                        terminator = term;
                    }
                    None => break,
                }
            }

            // Walk off the end: an `h264` instruction carries region rects
            // beyond the arguments read above.
            while terminator == b',' {
                match crate::binary_blob::element(text, next) {
                    Some((_, after, term)) => {
                        next = after;
                        terminator = term;
                    }
                    None => break,
                }
            }

            if terminator != b';' {
                break;
            }
            let instruction_end = next;
            pos = instruction_end;

            let index = args.first().and_then(|a| a.parse::<u32>().ok());

            match (opcode, index) {
                ("h264", Some(index)) => {
                    self.h264_streams.insert(index);
                }
                ("end", Some(index)) => {
                    self.h264_streams.remove(&index);
                }
                ("blob", Some(index)) if self.h264_streams.contains(&index) => {
                    let Some(payload) = args.get(1) else { continue };
                    let Some(replacement) = self.rewritten_payload(payload) else {
                        continue;
                    };

                    let out = out.get_or_insert_with(String::new);
                    out.push_str(&text[pending..instruction_start]);
                    out.push_str(&format!(
                        "4.blob,{}.{},{}.{};",
                        args[0].len(),
                        args[0],
                        replacement.len(),
                        replacement
                    ));
                    pending = instruction_end;
                }
                _ => {}
            }
        }

        let mut out = out?;
        out.push_str(&text[pending..]);
        Some(out)
    }

    /// Returns the base64 of a rewritten access unit, or `None` to leave the
    /// blob alone.
    fn rewritten_payload(&mut self, payload: &str) -> Option<String> {
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload) else {
            // The browser's decoder is no worse at this than ours.
            return None;
        };

        let Some(sps) = crate::h264_sps::find_sps_range(&bytes) else {
            // No SPS in this blob: a non-keyframe, or a continuation. Says
            // nothing about the stream, so the state is left as it is.
            return None;
        };

        if self.state == State::Undecided {
            let signal = crate::h264_sps::parse_sps(&bytes[sps.clone()])?;
            self.state = if signal.needs_description() {
                State::Rewriting
            } else {
                State::PassThrough
            };
        }

        if self.state != State::Rewriting {
            return None;
        }

        let spliced = crate::h264_sps::complete_colour_signalling(&bytes[sps.clone()])?;

        let mut rebuilt = Vec::with_capacity(bytes.len() + spliced.len());
        rebuilt.extend_from_slice(&bytes[..sps.start]);
        rebuilt.extend_from_slice(&spliced);
        rebuilt.extend_from_slice(&bytes[sps.end..]);

        Some(base64::engine::general_purpose::STANDARD.encode(&rebuilt))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An access unit whose SPS declares full range and no colour description
    /// — the Windows shape.
    const BARE: &str = "AAAAAWdkAAus2UGCabIAAAMAAgAAAwBkHihTLAAAAAABaOvjywAAAAFliIQA";

    /// The same with a BT.709 description already present — the xrdp shape.
    const COMPLETE: &str = "AAAAAWdkAAus2UGCabgICAoAAAMAAgAAAwBkHihTLAAAAAABaOvjywAAAAFliIQA";

    fn blob(index: u32, payload: &str) -> String {
        format!(
            "4.blob,{}.{},{}.{};",
            index.to_string().len(),
            index,
            payload.len(),
            payload
        )
    }

    /// Pulls the blob payload back out of a run of instructions.
    fn payload_of(text: &str) -> String {
        let at = text.find("4.blob,").expect("a blob");
        let (_, next, _) = crate::binary_blob::element(text, at).unwrap();
        let (_, after, _) = crate::binary_blob::element(text, next).unwrap();
        let (payload, _, _) = crate::binary_blob::element(text, after).unwrap();
        payload.to_string()
    }

    fn decoded_signal(payload: &str) -> crate::h264_sps::ColourSignal {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .expect("valid base64");
        crate::h264_sps::find_sps(&bytes).expect("an SPS")
    }

    #[test]
    fn splices_a_description_into_a_bare_sps() {
        let mut r = SpsRewriter::new();
        assert_eq!(
            r.rewrite("4.h264,1.7,1.0,1.0;"),
            None,
            "nothing to rewrite yet"
        );

        let out = r.rewrite(&blob(7, BARE)).expect("rewritten");
        let signal = decoded_signal(&payload_of(&out));

        assert!(signal.full_range, "the declared range survives");
        assert_eq!(signal.primaries, Some(1));
        assert_eq!(signal.transfer, Some(1));
        assert_eq!(signal.matrix, Some(1));
        assert!(signal.is_actionable(), "which is the point");
    }

    /// The other NALs of the access unit must come through untouched: the
    /// slice data is the picture, and losing a byte of it loses the frame.
    #[test]
    fn the_rest_of_the_access_unit_is_preserved() {
        let mut r = SpsRewriter::new();
        r.rewrite("4.h264,1.7,1.0,1.0;");
        let out = r.rewrite(&blob(7, BARE)).expect("rewritten");

        let before = base64::engine::general_purpose::STANDARD
            .decode(BARE)
            .unwrap();
        let after = base64::engine::general_purpose::STANDARD
            .decode(payload_of(&out))
            .unwrap();

        // Everything from the PPS start code onward is byte-identical.
        let pps = before
            .windows(5)
            .position(|w| w == [0, 0, 0, 1, 0x68])
            .unwrap();
        let pps_after = after
            .windows(5)
            .position(|w| w == [0, 0, 0, 1, 0x68])
            .unwrap();
        assert_eq!(before[pps..], after[pps_after..], "PPS and slice survive");
    }

    /// An xrdp stream must not be touched, and must stop being examined.
    #[test]
    fn a_described_stream_is_passed_through_and_then_ignored() {
        let mut r = SpsRewriter::new();
        r.rewrite("4.h264,1.7,1.0,1.0;");

        assert_eq!(r.rewrite(&blob(7, COMPLETE)), None, "nothing to do");
        assert_eq!(r.state, State::PassThrough);
        // And the decision sticks: a later blob is not decoded at all.
        assert_eq!(
            r.rewrite(&blob(7, BARE)),
            None,
            "decided, and not revisited"
        );
    }

    /// Keyframes recur, so the rewrite has to keep applying.
    #[test]
    fn every_later_keyframe_is_rewritten_too() {
        let mut r = SpsRewriter::new();
        r.rewrite("4.h264,1.7,1.0,1.0;");
        r.rewrite(&blob(7, BARE)).expect("first");

        let out = r.rewrite(&blob(7, BARE)).expect("and the next");
        assert!(decoded_signal(&payload_of(&out)).is_actionable());
    }

    #[test]
    fn blobs_of_other_streams_are_left_alone() {
        let mut r = SpsRewriter::new();
        // An img stream carrying bytes that would parse as an access unit.
        let text = format!("3.img,1.4,1.1,1.0,9.image/png,1.0,1.0;{}", blob(4, BARE));
        assert_eq!(r.rewrite(&text), None);
    }

    /// Indices are reused once a stream ends.
    #[test]
    fn a_recycled_index_is_no_longer_video() {
        let mut r = SpsRewriter::new();
        r.rewrite("4.h264,1.7,1.0,1.0;3.end,1.7;");
        assert_eq!(r.rewrite(&blob(7, BARE)), None);
    }

    /// Neighbouring instructions must survive the splice intact, since the
    /// rewrite rebuilds the run around the blob it replaces.
    #[test]
    fn surrounding_instructions_are_preserved() {
        let mut r = SpsRewriter::new();
        r.rewrite("4.h264,1.7,1.0,1.0;");

        let text = format!("4.sync,3.123;{}5.mouse,1.4,1.5;", blob(7, BARE));
        let out = r.rewrite(&text).expect("rewritten");

        assert!(out.starts_with("4.sync,3.123;"), "{out}");
        assert!(out.ends_with("5.mouse,1.4,1.5;"), "{out}");
        assert!(decoded_signal(&payload_of(&out)).is_actionable());
    }

    /// The splice must leave a stream a decoder still accepts. A bad bit
    /// offset or a missed emulation-prevention byte does not fail loudly --
    /// the picture simply stops, with both ends looking healthy.
    ///
    /// Checked against ffmpeg's own `h264_metadata` bitstream filter doing the
    /// same edit, which is an implementation that shares no code and no
    /// author with this one: if the two write the same SPS byte for byte, the
    /// splice is right. Then both are decoded, to confirm the result is a
    /// stream and not merely a plausible one. Skipped where ffmpeg is absent.
    ///
    /// Note that the edit legitimately *changes the decode*: with
    /// `matrix_coefficients` absent a decoder falls back to BT.601, and
    /// writing 1 declares BT.709. That is the correct value here -- MS-RDPEGFX
    /// defines the transform as BT.709, and Chrome already reports `bt709` for
    /// these streams, so it is a no-op for the client this serves -- but it is
    /// why the pixels are not asserted equal.
    #[test]
    fn the_splice_matches_ffmpegs_own_rewrite() {
        use std::process::Command;

        let ffmpeg = |args: &[&str]| -> bool {
            Command::new("ffmpeg")
                .args(args)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };

        if !ffmpeg(&["-version"]) {
            eprintln!("SKIP: needs ffmpeg");
            return;
        }

        let dir = std::env::temp_dir().join(format!("rustguac-splice-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = |name: &str| dir.join(name).to_string_lossy().into_owned();

        // Full-range samples declaring the range and nothing else: the shape
        // this exists to repair.
        assert!(
            ffmpeg(&[
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=1280x720:rate=10:duration=1",
                "-c:v",
                "libx264",
                "-profile:v",
                "high",
                "-pix_fmt",
                "yuv420p",
                "-color_range",
                "pc",
                "-x264-params",
                "fullrange=on",
                "-bsf:v",
                "h264_metadata=video_full_range_flag=1",
                &path("original.h264"),
            ]),
            "encode failed"
        );

        // The same edit, by ffmpeg.
        assert!(
            ffmpeg(&[
                "-v",
                "error",
                "-y",
                "-i",
                &path("original.h264"),
                "-c:v",
                "copy",
                "-bsf:v",
                "h264_metadata=colour_primaries=1:transfer_characteristics=1:\
matrix_coefficients=1",
                &path("reference.h264"),
            ]),
            "reference rewrite failed"
        );

        let original = std::fs::read(path("original.h264")).expect("read");
        let reference = std::fs::read(path("reference.h264")).expect("read");

        let ours = {
            let range = crate::h264_sps::find_sps_range(&original).expect("an SPS");
            let before = crate::h264_sps::parse_sps(&original[range.clone()]).expect("parses");
            assert!(
                before.full_range && before.needs_description(),
                "the fixture is the shape under test: {before:?}"
            );
            crate::h264_sps::complete_colour_signalling(&original[range]).expect("rewritten")
        };

        let theirs = {
            let range = crate::h264_sps::find_sps_range(&reference).expect("an SPS");
            reference[range].to_vec()
        };

        assert_eq!(
            ours, theirs,
            "our SPS differs from ffmpeg's:\n  ours   {ours:02x?}\n  theirs {theirs:02x?}"
        );

        let spliced = crate::h264_sps::parse_sps(&ours).expect("parses");
        assert!(spliced.full_range, "the declared range survives");
        assert!(
            spliced.is_actionable(),
            "which is the point of the exercise"
        );

        // And it is still a decodable stream, not merely a plausible one.
        for name in ["original.h264", "reference.h264"] {
            assert!(
                ffmpeg(&[
                    "-v",
                    "error",
                    "-y",
                    "-i",
                    &path(name),
                    "-frames:v",
                    "3",
                    "-pix_fmt",
                    "rgb24",
                    "-f",
                    "rawvideo",
                    &path("out.rgb")
                ]),
                "decode failed for {name}"
            );
            let pixels = std::fs::read(path("out.rgb")).expect("pixels");
            assert_eq!(pixels.len(), 1280 * 720 * 3 * 3, "three 720p frames");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The stock-xrdp shape: x264 with no VUI parameters set, so the whole
    /// video_signal_type block is absent. Checked against ffmpeg's
    /// h264_metadata writing the same three fields plus the range, which is an
    /// implementation sharing no code with this one. Skipped without ffmpeg.
    #[test]
    fn writing_the_whole_signal_type_matches_ffmpeg() {
        use std::process::Command;

        let ffmpeg = |args: &[&str]| -> bool {
            Command::new("ffmpeg")
                .args(args)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };

        if !ffmpeg(&["-version"]) {
            eprintln!("SKIP: needs ffmpeg");
            return;
        }

        let dir = std::env::temp_dir().join(format!("rustguac-signal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = |name: &str| dir.join(name).to_string_lossy().into_owned();

        // No colour options at all -- x264's defaults, which is what stock
        // xrdp 0.10.6 hands it.
        assert!(
            ffmpeg(&[
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=640x480:rate=10:duration=1",
                "-c:v",
                "libx264",
                "-profile:v",
                "high",
                "-pix_fmt",
                "yuv420p",
                &path("plain.h264"),
            ]),
            "encode failed"
        );

        assert!(
            ffmpeg(&[
                "-v",
                "error",
                "-y",
                "-i",
                &path("plain.h264"),
                "-c:v",
                "copy",
                "-bsf:v",
                "h264_metadata=video_full_range_flag=1:colour_primaries=1:\
transfer_characteristics=1:matrix_coefficients=1",
                &path("reference.h264"),
            ]),
            "reference rewrite failed"
        );

        let plain = std::fs::read(path("plain.h264")).expect("read");
        let reference = std::fs::read(path("reference.h264")).expect("read");

        let range = crate::h264_sps::find_sps_range(&plain).expect("an SPS");
        let before = crate::h264_sps::parse_sps(&plain[range.clone()]).expect("parses");
        assert!(
            before.vui_present && !before.video_signal_type_present,
            "the fixture is the shape under test: {before:?}"
        );

        let ours = crate::h264_sps::complete_colour_signalling(&plain[range]).expect("rewritten");
        let theirs = {
            let range = crate::h264_sps::find_sps_range(&reference).expect("an SPS");
            reference[range].to_vec()
        };

        assert_eq!(
            ours, theirs,
            "our SPS differs from ffmpeg's:\n  ours   {ours:02x?}\n  theirs {theirs:02x?}"
        );

        let spliced = crate::h264_sps::parse_sps(&ours).expect("parses");
        assert!(spliced.full_range);
        assert!(spliced.is_actionable());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn undecodable_payloads_are_passed_through_not_dropped() {
        let mut r = SpsRewriter::new();
        r.rewrite("4.h264,1.7,1.0,1.0;");
        let text = blob(7, "!!!not base64!!!");
        assert_eq!(r.rewrite(&text), None, "left for the browser to reject");
    }

    /// A blob carrying no SPS says nothing about the stream, so it must not
    /// settle the decision -- the first blob of a session is often a
    /// continuation, and deciding on it would leave every keyframe unrewritten.
    #[test]
    fn a_blob_without_an_sps_does_not_decide_the_stream() {
        let mut r = SpsRewriter::new();
        r.rewrite("4.h264,1.7,1.0,1.0;");

        let slice =
            base64::engine::general_purpose::STANDARD.encode([0, 0, 0, 1, 0x41, 0x9a, 0x12, 0x34]);
        assert_eq!(r.rewrite(&blob(7, &slice)), None);
        assert_eq!(r.state, State::Undecided, "still undecided");

        let out = r
            .rewrite(&blob(7, BARE))
            .expect("and the keyframe still lands");
        assert!(decoded_signal(&payload_of(&out)).is_actionable());
    }
}
