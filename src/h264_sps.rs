//! Reads the colour signalling out of an H.264 sequence parameter set.
//!
//! The picture a passthrough session paints depends on two things the wire
//! carries and nothing else logs: whether the samples are full range, and
//! whether the stream says so in a form the browser will accept.
//!
//! The second half is the trap. Chrome honours `video_full_range_flag` in
//! every shape but one: a colour description that is *present* and says
//! *unspecified* makes it discard the whole `video_signal_type` and fall back
//! to limited-range BT.709. Leaving the description out entirely does not.
//! Measured 2026-09-09 against x264 streams whose SPS was parsed by hand, and
//! pinned by `tests/h264-vui-range.mjs`:
//!
//! | `full_range` | colour description | `colorSpace.fullRange` | 16,16,16 painted as |
//! |---|---|---|---|
//! | 1 | absent | `true` | 15,17,14 |
//! | 1 | present, 2/2 (unspecified) | `false` | **0,1,0** |
//! | 1 | present, 1/1 (BT.709) | `true` | 14,17,14 |
//! | 0 | present, 1/1 (BT.709) | `false` | 13,16,13 |
//!
//! So a host that encodes full-range BT.709, as MS-RDPEGFX specifies, and
//! declares it beside an *unspecified* primaries value is rendered exactly as
//! though it had declared limited: blacks crushed to zero, chroma
//! over-saturated by 255/224. Saying less would have worked. Both ends believe
//! they are correct, and the only way to tell that case from a host that
//! genuinely signals limited is to read the SPS — which is what this does,
//! once per stream, at the first keyframe.
//!
//! The xrdp fork writes all four values (`xrdp_accel_assist_vaapi.c`), which is
//! why signalling the range there visibly fixed the colour.

/// What an SPS says about colour, as far as it says anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColourSignal {
    /// Whether the SPS carries a VUI at all. Without one there is nowhere to
    /// put colour signalling short of synthesising the whole block, which no
    /// encoder feeding this proxy makes necessary.
    pub vui_present: bool,
    pub video_signal_type_present: bool,
    pub full_range: bool,
    /// Present only when `colour_description_present_flag` was set.
    pub primaries: Option<u8>,
    pub transfer: Option<u8>,
    pub matrix: Option<u8>,
}

impl ColourSignal {
    /// Whether a browser will act on `full_range`, hardware decode included.
    ///
    /// Needs a description that is both present and specified, and the two
    /// ways of failing that need different fixes:
    ///
    /// * **Absent** — honoured by Chrome's software decoder and ignored by its
    ///   hardware one. Confirmed against a Windows host, which sends exactly
    ///   this and rendered with crushed blacks until a description was spliced
    ///   in. `crate::h264_rewrite` repairs it in flight.
    /// * **Present and "unspecified" (2)** — makes Chrome discard the whole
    ///   `video_signal_type` on either path. Not repairable from here:
    ///   replacing 2 with 1 asserts a colourimetry the host declined to claim,
    ///   so it has to be fixed at the encoder.
    pub fn is_actionable(&self) -> bool {
        self.video_signal_type_present
            && matches!(self.primaries, Some(p) if p != 2)
            && matches!(self.transfer, Some(t) if t != 2)
    }

    /// Whether the missing half is one this proxy can supply.
    pub fn needs_description(&self) -> bool {
        self.vui_present && self.primaries.is_none()
    }

    /// A one-line summary for the journal, saying what the browser will do
    /// with it rather than only what it contains.
    pub fn describe(&self) -> String {
        if !self.video_signal_type_present {
            return if self.vui_present {
                "NO SIGNAL TYPE: the SPS says nothing about colour, so the \
                 browser assumes limited-range BT.709 and renders a full-range \
                 host with crushed blacks. Full-range BT.709 is spliced in on \
                 the way past — MS-RDPEGFX defines the transform, and stock \
                 xrdp names its own conversion 709fr"
            } else {
                "no VUI in the SPS at all — the browser assumes limited-range \
                 BT.709. Not repaired here: synthesising a whole VUI is more \
                 surgery than any encoder seen in the field calls for"
            }
            .to_string();
        }

        let fmt = |v: Option<u8>| match v {
            None => "absent".to_string(),
            Some(2) => "2 (unspecified)".to_string(),
            Some(1) => "1 (BT.709)".to_string(),
            Some(other) => other.to_string(),
        };

        format!(
            "video_full_range_flag={} colour_primaries={} transfer={} matrix={} — {}",
            u8::from(self.full_range),
            fmt(self.primaries),
            fmt(self.transfer),
            fmt(self.matrix),
            if self.is_actionable() {
                "usable, so the browser will honour the range"
            } else if self.needs_description() {
                "NO DESCRIPTION: a hardware decoder ignores a bare range flag, \
                 so this renders a full-range host with crushed blacks. A \
                 BT.709 description is spliced in on the way past"
            } else {
                "UNUSABLE: an explicitly unspecified primaries or transfer \
                 makes Chrome discard the range flag and assume limited, which \
                 renders a full-range host with crushed blacks. Not repairable \
                 here — replacing it would assert a colourimetry the host \
                 declined to claim — so fix it at the encoder"
            }
        )
    }
}

/// Reads bits big-endian, with the exp-Golomb codings the SPS is written in.
///
/// Shared with `crate::h264_refs`, which reads slice headers out of the same
/// streams: the two parsers walk different syntax structures but the same
/// bit-level codings, and a second copy of these four methods is a second
/// place for an off-by-one to live.
pub(crate) struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BitReader<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub(crate) fn bit(&mut self) -> Option<u32> {
        let byte = self.data.get(self.pos >> 3)?;
        let bit = (byte >> (7 - (self.pos & 7))) & 1;
        self.pos += 1;
        Some(u32::from(bit))
    }

    pub(crate) fn bits(&mut self, count: u32) -> Option<u32> {
        // Every field read here is at most 32 bits wide; a wider read is a bug
        // in the caller rather than something to handle.
        debug_assert!(count <= 32);
        let mut value = 0u32;
        for _ in 0..count {
            value = (value << 1) | self.bit()?;
        }
        Some(value)
    }

    /// Unsigned exp-Golomb.
    pub(crate) fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0u32;
        while self.bit()? == 0 {
            zeros += 1;
            // A run this long is corrupt data, not a large value: the largest
            // legal codeword is 32 bits.
            if zeros > 32 {
                return None;
            }
        }
        if zeros == 0 {
            return Some(0);
        }
        Some((1u32 << zeros) - 1 + self.bits(zeros)?)
    }

    /// Signed exp-Golomb.
    pub(crate) fn se(&mut self) -> Option<i32> {
        let k = self.ue()?;
        Some(if k % 2 == 0 {
            -((k / 2) as i32)
        } else {
            k.div_ceil(2) as i32
        })
    }
}

/// Strips emulation prevention bytes: 00 00 03 in the payload means 00 00.
pub(crate) fn unescape(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut i = 0;
    while i < nal.len() {
        if i + 2 < nal.len() && nal[i] == 0 && nal[i + 1] == 0 && nal[i + 2] == 3 {
            out.push(0);
            out.push(0);
            i += 3;
        } else {
            out.push(nal[i]);
            i += 1;
        }
    }
    out
}

/// Parses the colour signalling out of one SPS NAL payload (without its header
/// byte). Returns None if the SPS is malformed or truncated.
pub fn parse_sps(payload: &[u8]) -> Option<ColourSignal> {
    parse_rbsp(&unescape(payload)).map(|parsed| parsed.signal)
}

/// Rewrites an SPS payload with `gaps_in_frame_num_value_allowed_flag` set, or
/// `None` if it is already set or the SPS cannot be read.
///
/// Needed by `crate::h264_aux_drop`. Dropping an auxiliary view removes a
/// reference picture, and every `frame_num` it consumed becomes a hole in the
/// sequence. With this flag clear a decoder is entitled to treat that as a
/// broken stream; with it set, the standard requires it to infer the missing
/// pictures (8.2.5.2) and carry on. The encoders seen here all clear it,
/// because none of them intends anything to be dropped.
///
/// Unlike the colour splice this changes no lengths — one bit, in place — but
/// it still goes back through `escape()`, because flipping a bit can create a
/// `00 00 00` or `00 00 01` sequence that must be escaped to stay parseable.
pub fn allow_frame_num_gaps(payload: &[u8]) -> Option<Vec<u8>> {
    let mut rbsp = unescape(payload);
    let parsed = parse_rbsp(&rbsp)?;

    let byte = parsed.gaps_bit / 8;
    let mask = 0x80u8 >> (parsed.gaps_bit % 8);
    if rbsp.get(byte)? & mask != 0 {
        return None;
    }

    rbsp[byte] |= mask;
    Some(escape(&rbsp))
}

/// Where colour signalling can be spliced into an SPS, and what is missing.
///
/// The two sites need different edits, and both occur in the field: Windows
/// declares a range and no description, while stock xrdp writes neither --
/// x264's defaults omit the whole `video_signal_type` block, since with
/// `video_format` at 5 and no colour description there is nothing to carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpliceSite {
    /// `video_signal_type_present_flag` is 0 and sits at this bit. The whole
    /// block has to be written: format, range, and the description.
    SignalType(usize),
    /// The block is present but `colour_description_present_flag` is 0, at this
    /// bit. Only the description is missing.
    Description(usize),
    /// Nothing to add -- already complete, already explicitly unspecified, or
    /// no VUI to put it in.
    Nowhere,
}

/// Parses an unescaped SPS, also reporting the bit position of
/// `colour_description_present_flag` — which is where a description has to be
/// spliced in, and is not recoverable from the parsed values.
///
/// The position is `None` when the walk never reached that flag, which is the
/// case for an SPS with no VUI or no `video_signal_type`.
/// What the SPS says before `log2_max_frame_num_minus4`, for the readers that
/// need it: `chroma_array_type` sizes the weighted prediction tables a slice
/// header has to be walked past, and `seq_parameter_set_id` is what a PPS
/// names.
pub(crate) struct SpsPrefix {
    pub(crate) seq_parameter_set_id: u32,
    pub(crate) chroma_array_type: u32,
    /// Set only by the 4:4:4 high profiles, and the reason a slice header
    /// carries a `colour_plane_id`.
    pub(crate) separate_colour_plane: bool,
}

/// Walks an SPS RBSP from its first byte up to `log2_max_frame_num_minus4`.
///
/// Shared with `crate::h264_refs` rather than copied into it: the high-profile
/// chroma format and the optional scaling lists are the fiddliest part of the
/// walk and the part whose cost of drifting is silent — both readers would
/// still return values, just from the wrong bits.
pub(crate) fn read_sps_prefix(r: &mut BitReader) -> Option<SpsPrefix> {
    let profile_idc = r.bits(8)?;
    r.bits(8)?; // constraint flags + reserved
    r.bits(8)?; // level_idc
    let seq_parameter_set_id = r.ue()?;

    // The high profiles carry a chroma format and optional scaling lists that
    // have to be walked past to reach the fields below.
    let mut chroma_array_type = 1;
    let mut separate_colour_plane = false;
    if matches!(
        profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        let chroma_format_idc = r.ue()?;
        chroma_array_type = chroma_format_idc;
        if chroma_format_idc == 3 {
            // separate_colour_plane_flag: with the planes coded separately
            // there is no chroma to weight, and ChromaArrayType is 0.
            separate_colour_plane = r.bit()? == 1;
            if separate_colour_plane {
                chroma_array_type = 0;
            }
        }
        r.ue()?; // bit_depth_luma_minus8
        r.ue()?; // bit_depth_chroma_minus8
        r.bit()?; // qpprime_y_zero_transform_bypass_flag
        if r.bit()? == 1 {
            let lists = if chroma_format_idc == 3 { 12 } else { 8 };
            for i in 0..lists {
                if r.bit()? == 1 {
                    let size = if i < 6 { 16 } else { 64 };
                    let mut last = 8i32;
                    let mut next = 8i32;
                    for _ in 0..size {
                        if next != 0 {
                            next = (last + r.se()? + 256).rem_euclid(256);
                        }
                        if next != 0 {
                            last = next;
                        }
                    }
                }
            }
        }
    }

    Some(SpsPrefix {
        seq_parameter_set_id,
        chroma_array_type,
        separate_colour_plane,
    })
}

/// What one SPS says, and the two places it can be edited.
struct Parsed {
    signal: ColourSignal,
    splice: SpliceSite,
    /// Bit offset of `gaps_in_frame_num_value_allowed_flag` within the RBSP.
    gaps_bit: usize,
}

fn parse_rbsp(rbsp: &[u8]) -> Option<Parsed> {
    let mut r = BitReader::new(rbsp);

    read_sps_prefix(&mut r)?;

    r.ue()?; // log2_max_frame_num_minus4
    let pic_order_cnt_type = r.ue()?;
    if pic_order_cnt_type == 0 {
        r.ue()?; // log2_max_pic_order_cnt_lsb_minus4
    } else if pic_order_cnt_type == 1 {
        r.bit()?; // delta_pic_order_always_zero_flag
        r.se()?; // offset_for_non_ref_pic
        r.se()?; // offset_for_top_to_bottom_field
        let cycle = r.ue()?;
        // Bounded by the standard at 255; anything larger is corrupt input and
        // would otherwise be a long loop over a truncated buffer.
        if cycle > 255 {
            return None;
        }
        for _ in 0..cycle {
            r.se()?;
        }
    }

    r.ue()?; // max_num_ref_frames
    let gaps_bit = r.pos;
    r.bit()?; // gaps_in_frame_num_value_allowed_flag
    r.ue()?; // pic_width_in_mbs_minus1
    r.ue()?; // pic_height_in_map_units_minus1
    if r.bit()? == 0 {
        r.bit()?; // mb_adaptive_frame_field_flag
    }
    r.bit()?; // direct_8x8_inference_flag
    if r.bit()? == 1 {
        r.ue()?; // frame_crop_left_offset
        r.ue()?; // frame_crop_right_offset
        r.ue()?; // frame_crop_top_offset
        r.ue()?; // frame_crop_bottom_offset
    }

    if r.bit()? == 0 {
        // vui_parameters_present_flag = 0
        return Some(Parsed {
            signal: ColourSignal {
                vui_present: false,
                video_signal_type_present: false,
                full_range: false,
                primaries: None,
                transfer: None,
                matrix: None,
            },
            splice: SpliceSite::Nowhere,
            gaps_bit,
        });
    }

    if r.bit()? == 1 {
        // aspect_ratio_info_present_flag
        if r.bits(8)? == 255 {
            r.bits(16)?; // sar_width
            r.bits(16)?; // sar_height
        }
    }
    if r.bit()? == 1 {
        r.bit()?; // overscan_appropriate_flag
    }

    let signal_type_flag_bit = r.pos;
    if r.bit()? == 0 {
        // video_signal_type_present_flag = 0 -- the whole block is missing,
        // which is what stock xrdp's x264 defaults produce.
        return Some(Parsed {
            signal: ColourSignal {
                vui_present: true,
                video_signal_type_present: false,
                full_range: false,
                primaries: None,
                transfer: None,
                matrix: None,
            },
            splice: SpliceSite::SignalType(signal_type_flag_bit),
            gaps_bit,
        });
    }

    r.bits(3)?; // video_format
    let full_range = r.bit()? == 1;

    let description_flag_bit = r.pos;
    let (primaries, transfer, matrix) = if r.bit()? == 1 {
        (
            Some(r.bits(8)? as u8),
            Some(r.bits(8)? as u8),
            Some(r.bits(8)? as u8),
        )
    } else {
        (None, None, None)
    };

    Some(Parsed {
        signal: ColourSignal {
            vui_present: true,
            video_signal_type_present: true,
            full_range,
            primaries,
            transfer,
            matrix,
        },
        splice: if primaries.is_some() {
            SpliceSite::Nowhere
        } else {
            SpliceSite::Description(description_flag_bit)
        },
        gaps_bit,
    })
}

/// Writes bits big-endian, for splicing an SPS back together.
struct BitWriter {
    data: Vec<u8>,
    bits: usize,
}

impl BitWriter {
    fn new(capacity: usize) -> Self {
        Self {
            data: Vec::with_capacity(capacity),
            bits: 0,
        }
    }

    fn bit(&mut self, value: u32) {
        if self.bits.is_multiple_of(8) {
            self.data.push(0);
        }
        if value & 1 == 1 {
            let at = self.data.len() - 1;
            self.data[at] |= 1 << (7 - (self.bits % 8));
        }
        self.bits += 1;
    }

    fn bits_of(&mut self, value: u32, count: u32) {
        for i in (0..count).rev() {
            self.bit((value >> i) & 1);
        }
    }
}

/// Re-inserts emulation prevention bytes: any 00 00 00/01/02/03 in the payload
/// becomes 00 00 03 followed by that byte.
fn escape(rbsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rbsp.len() + 4);
    let mut zeros = 0usize;
    for &byte in rbsp {
        if zeros >= 2 && byte <= 3 {
            out.push(3);
            zeros = 0;
        }
        out.push(byte);
        if byte == 0 {
            zeros += 1;
        } else {
            zeros = 0;
        }
    }
    out
}

/// Completes an SPS's colour signalling, returning the rewritten NAL payload.
///
/// Two shapes are repaired, both seen in the field:
///
/// * **A range with no description** (Windows). Chrome's hardware decoder
///   ignores a bare `video_full_range_flag`, so the description is added and
///   the declared range is left alone.
/// * **No `video_signal_type` at all** (stock xrdp, whose x264 defaults omit
///   the block). Full-range BT.709 is written, because that is what the
///   transport defines and what the encoder actually produced -- xrdp names its
///   own conversion `XRDP_yuv444_709fr`.
///
/// Returns `None` when the SPS is malformed, or when it needs no help — it
/// already carries a description, or carries no `video_signal_type` for one to
/// sit beside. Inventing a range for a stream that declares none is not this
/// function's business: it only makes an existing declaration legible.
///
/// **Why this is worth doing rather than telling the client.** Chrome's
/// hardware decode path acts on `video_full_range_flag` only when a colour
/// description accompanies it. Measured on one browser against two hosts:
/// xrdp, which writes `full_range=1` with primaries/transfer/matrix all
/// BT.709, is reported as full range; Windows, which writes `full_range=1`
/// with no description at all, is reported as limited and painted with
/// crushed blacks. Software decode honours both, which is why this took three
/// wrong theories to find.
///
/// Making the second look like the first fixes it for every client and both
/// render paths at once — including `drawImage()`, which no flag of ours can
/// reach — and it is what the stream meant in the first place. BT.709 is not a
/// guess: MS-RDPEGFX defines the transform as BT.709, and `matrix_coefficients`
/// is the value the decoder was already assuming.
pub fn complete_colour_signalling(payload: &[u8]) -> Option<Vec<u8>> {
    let rbsp = unescape(payload);
    let site = parse_rbsp(&rbsp)?.splice;

    let mut w = BitWriter::new(rbsp.len() + 8);
    let mut r = BitReader::new(&rbsp);

    let flag_at = match site {
        SpliceSite::Nowhere => return None,
        SpliceSite::SignalType(at) | SpliceSite::Description(at) => at,
    };

    for _ in 0..flag_at {
        w.bit(r.bit()?);
    }

    // The flag itself, now set.
    w.bit(1);

    if let SpliceSite::SignalType(_) = site {
        // The whole block, which was absent. video_format 5 is "unspecified",
        // which is what x264 already meant by omitting it and is the only value
        // here that asserts nothing extra.
        w.bits_of(5, 3); // video_format
        w.bits_of(1, 1); // video_full_range_flag
        w.bit(1); // colour_description_present_flag
    }

    // BT.709 three times over.
    w.bits_of(1, 8); // colour_primaries
    w.bits_of(1, 8); // transfer_characteristics
    w.bits_of(1, 8); // matrix_coefficients

    // The flag being replaced, then everything after it verbatim. The tail
    // includes rbsp_trailing_bits; shifting it is harmless, since the stop bit
    // travels with it and trailing zeroes are padding either way.
    r.bit()?;
    while let Some(bit) = r.bit() {
        w.bit(bit);
    }

    Some(escape(&w.data))
}

/// Finds the first SPS in an Annex B byte stream and parses it.
///
/// Access units from guacd arrive with start codes, and one blob may carry
/// several NALs; only the first SPS is of interest.
pub fn find_sps(annexb: &[u8]) -> Option<ColourSignal> {
    find_sps_range(annexb).and_then(|range| parse_sps(&annexb[range]))
}

/// Byte range of the first SPS *payload* in an Annex B stream — the NAL header
/// byte excluded, so the range is what `parse_sps` and `add_colour_description`
/// take, and what a rewritten SPS replaces.
pub fn find_sps_range(annexb: &[u8]) -> Option<std::ops::Range<usize>> {
    let mut i = 0usize;
    while i + 4 < annexb.len() {
        let header = if annexb[i..].starts_with(&[0, 0, 0, 1]) {
            i + 4
        } else if annexb[i..].starts_with(&[0, 0, 1]) {
            i + 3
        } else {
            i += 1;
            continue;
        };

        // Bit 8 is forbidden_zero_bit; a set one means this is not a NAL
        // header and the match was three bytes of payload.
        let byte = annexb[header];
        if byte & 0x80 == 0 && byte & 0x1f == 7 {
            let end = next_start_code(annexb, header + 1).unwrap_or(annexb.len());
            return Some(header + 1..end);
        }

        i = header + 1;
    }
    None
}

pub(crate) fn next_start_code(data: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && (data[i + 2] == 1 || data[i + 2] == 3) {
            if data[i + 2] == 1 {
                return Some(i);
            }
            // An escape, not a boundary.
            i += 3;
            continue;
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real SPS payloads from libx264, kept as bytes rather than built here:
    /// the point of this parser is to agree with an encoder, and a fixture
    /// written by the same understanding that reads it proves nothing.
    ///
    /// Produced by `ffmpeg -c:v libx264 -profile:v high` with the colour
    /// options named, and cross-checked field by field against an independent
    /// parser before being pasted in.
    /// `full_range=1` beside an explicit "unspecified" (2) primaries and
    /// transfer — the one shape Chrome discards.
    const FULL_RANGE_UNSPECIFIED: &[u8] = &[
        0x64, 0x00, 0x0b, 0xac, 0xd9, 0x41, 0x82, 0x69, 0xb8, 0x10, 0x10, 0x0a, 0x00, 0x00, 0x03,
        0x00, 0x02, 0x00, 0x00, 0x03, 0x00, 0x64, 0x1e, 0x28, 0x53, 0x2c, 0x00,
    ];

    /// `full_range=1` with a complete BT.709 description — the shape Chrome
    /// honours, and what the xrdp fork writes.
    const FULL_RANGE_COMPLETE: &[u8] = &[
        0x64, 0x00, 0x0b, 0xac, 0xd9, 0x41, 0x82, 0x69, 0xb8, 0x08, 0x08, 0x0a, 0x00, 0x00, 0x03,
        0x00, 0x02, 0x00, 0x00, 0x03, 0x00, 0x64, 0x1e, 0x28, 0x53, 0x2c, 0x00,
    ];

    /// `full_range=0` with a complete BT.709 description.
    const LIMITED_RANGE_COMPLETE: &[u8] = &[
        0x64, 0x00, 0x0b, 0xac, 0xd9, 0x41, 0x82, 0x69, 0xa8, 0x08, 0x08, 0x0a, 0x00, 0x00, 0x03,
        0x00, 0x02, 0x00, 0x00, 0x03, 0x00, 0x64, 0x1e, 0x28, 0x53, 0x2c, 0x00,
    ];

    /// `full_range=1` with no colour description at all, which Chrome does
    /// honour — the asymmetry that makes saying nothing safer than saying
    /// "unspecified".
    const FULL_RANGE_NO_DESCRIPTION: &[u8] = &[
        0x64, 0x00, 0x0b, 0xac, 0xd9, 0x41, 0x82, 0x69, 0xb2, 0x00, 0x00, 0x03, 0x00, 0x02, 0x00,
        0x00, 0x03, 0x00, 0x64, 0x1e, 0x28, 0x53, 0x2c, 0x00,
    ];

    /// A VUI carrying no `video_signal_type` at all.
    const NO_SIGNAL_TYPE: &[u8] = &[
        0x64, 0x00, 0x0c, 0xac, 0xd9, 0x41, 0x41, 0xfb, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10,
        0x00, 0x00, 0x03, 0x01, 0x40, 0xf1, 0x42, 0x99, 0x60, 0x00,
    ];

    #[test]
    fn reads_a_complete_full_range_description() {
        let sps = parse_sps(FULL_RANGE_COMPLETE).expect("parses");
        assert!(sps.video_signal_type_present);
        assert!(sps.full_range);
        assert_eq!(sps.primaries, Some(1));
        assert_eq!(sps.transfer, Some(1));
        assert_eq!(sps.matrix, Some(1));
        assert!(sps.is_actionable());
    }

    #[test]
    fn reads_a_complete_limited_range_description() {
        let sps = parse_sps(LIMITED_RANGE_COMPLETE).expect("parses");
        assert!(sps.video_signal_type_present);
        assert!(!sps.full_range);
        assert_eq!(sps.primaries, Some(1));
        assert!(sps.is_actionable());
    }

    /// The case that renders a full-range host with crushed blacks while both
    /// ends believe they agree: the flag is there, and unusable.
    #[test]
    fn full_range_beside_unspecified_primaries_is_not_actionable() {
        let sps = parse_sps(FULL_RANGE_UNSPECIFIED).expect("parses");
        assert!(sps.video_signal_type_present);
        assert!(sps.full_range, "the flag is set");
        assert_eq!(sps.primaries, Some(2), "and unusable beside this");
        assert_eq!(sps.transfer, Some(2));
        assert!(!sps.is_actionable());
        assert!(
            !sps.needs_description(),
            "it has a description; it is the wrong one"
        );
        assert!(sps.describe().contains("UNUSABLE"));
    }

    /// Absent and unspecified both fail, and are fixed differently: this one
    /// is ours to repair, the other the encoder's.
    #[test]
    fn full_range_with_no_colour_description_needs_one() {
        let sps = parse_sps(FULL_RANGE_NO_DESCRIPTION).expect("parses");
        assert!(sps.video_signal_type_present);
        assert!(sps.full_range);
        assert_eq!(sps.primaries, None);
        assert_eq!(sps.transfer, None);
        assert!(
            !sps.is_actionable(),
            "a hardware decoder ignores a bare range flag"
        );
        assert!(sps.needs_description(), "and this one we can supply");
        assert!(sps.describe().contains("NO DESCRIPTION"));
    }

    #[test]
    fn reads_an_absent_video_signal_type() {
        let sps = parse_sps(NO_SIGNAL_TYPE).expect("parses");
        assert!(sps.vui_present, "there is a VUI, just no colour in it");
        assert!(!sps.video_signal_type_present);
        assert!(!sps.is_actionable());
        assert!(sps.needs_description(), "and it is ours to supply");
        assert!(sps.describe().contains("NO SIGNAL TYPE"));
    }

    /// Stock xrdp 0.10.6: x264 is given no VUI parameters, so with
    /// video_format 5 and no colour description it omits the whole
    /// video_signal_type block. The samples are full-range BT.709 all the same
    /// -- xrdp names its own conversion XRDP_yuv444_709fr -- so the browser's
    /// fallback to limited crushes the blacks.
    #[test]
    fn writes_the_whole_signal_type_when_the_sps_omits_it() {
        let rewritten = complete_colour_signalling(NO_SIGNAL_TYPE).expect("rewritten");
        let sps = parse_sps(&rewritten).expect("still parses");

        assert!(sps.video_signal_type_present, "the block is now there");
        assert!(sps.full_range, "declared full, which is what xrdp encodes");
        assert_eq!(sps.primaries, Some(1));
        assert_eq!(sps.transfer, Some(1));
        assert_eq!(sps.matrix, Some(1));
        assert!(sps.is_actionable(), "and the browser will act on it");

        // Only the colour block was added; the sequence header ahead of the
        // VUI cannot have moved.
        assert_eq!(rewritten[..8], NO_SIGNAL_TYPE[..8]);

        for window in rewritten.windows(3) {
            assert!(
                window != [0, 0, 0] && window != [0, 0, 1] && window != [0, 0, 2],
                "unescaped sequence in the rewritten SPS: {rewritten:02x?}"
            );
        }
    }

    #[test]
    fn finds_the_sps_in_an_access_unit() {
        // AUD, then the SPS, as an encoder emits them.
        let mut stream = vec![
            0x00, 0x00, 0x00, 0x01, 0x09, 0x10, 0x00, 0x00, 0x00, 0x01, 0x67,
        ];
        stream.extend_from_slice(FULL_RANGE_COMPLETE);
        stream.extend_from_slice(&[0x00, 0x00, 0x00, 0x01, 0x68, 0xeb, 0xe3, 0xcb]);

        let sps = find_sps(&stream).expect("found");
        assert!(sps.full_range);
        assert!(sps.is_actionable());
    }

    #[test]
    fn ignores_a_stream_with_no_sps() {
        assert!(find_sps(&[0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x00]).is_none());
        assert!(find_sps(&[]).is_none());
        assert!(find_sps(&[0xff; 64]).is_none());
    }

    #[test]
    fn adds_a_bt709_description_to_a_bare_range_flag() {
        let rewritten = complete_colour_signalling(FULL_RANGE_NO_DESCRIPTION).expect("rewritten");

        let sps = parse_sps(&rewritten).expect("still parses");
        assert!(sps.video_signal_type_present);
        assert!(sps.full_range, "the range it declared survives");
        assert_eq!(sps.primaries, Some(1));
        assert_eq!(sps.transfer, Some(1));
        assert_eq!(sps.matrix, Some(1));
        assert!(sps.is_actionable());

        // Three bytes of description, plus the flag, spliced into the middle.
        assert!(
            rewritten.len() >= FULL_RANGE_NO_DESCRIPTION.len() + 3,
            "grew by the description"
        );
    }

    /// The rewrite must preserve everything ahead of the splice, or the
    /// decoder gets a different picture size, profile or reference count and
    /// the stream stops decoding rather than merely looking wrong.
    #[test]
    fn the_rewrite_changes_nothing_but_the_description() {
        let rewritten = complete_colour_signalling(FULL_RANGE_NO_DESCRIPTION).expect("rewritten");

        // Everything before the VUI is byte-identical: the splice is far
        // enough in that the leading bytes cannot have moved.
        assert_eq!(
            rewritten[..8],
            FULL_RANGE_NO_DESCRIPTION[..8],
            "the sequence header is untouched"
        );
    }

    #[test]
    fn an_sps_that_needs_no_help_is_left_alone() {
        // Already complete.
        assert!(complete_colour_signalling(FULL_RANGE_COMPLETE).is_none());
        assert!(complete_colour_signalling(LIMITED_RANGE_COMPLETE).is_none());
        // Present but unspecified: it has a description, and replacing 2 with
        // 1 would be asserting a colourimetry the host declined to claim.
        assert!(complete_colour_signalling(FULL_RANGE_UNSPECIFIED).is_none());
        // NO_SIGNAL_TYPE is now repaired, not left alone -- see
        // writes_the_whole_signal_type_when_the_sps_omits_it.
    }

    #[test]
    fn a_malformed_sps_is_not_rewritten() {
        for len in 0..FULL_RANGE_NO_DESCRIPTION.len() {
            let _ = complete_colour_signalling(&FULL_RANGE_NO_DESCRIPTION[..len]);
        }
        assert!(complete_colour_signalling(&[]).is_none());
        assert!(complete_colour_signalling(&[0xff; 40]).is_none());
    }

    /// Emulation prevention has to survive the splice: shifting the tail by 25
    /// bits can create a 00 00 00 that was not there before, and a decoder
    /// reading that as a start code loses the rest of the SPS.
    #[test]
    fn the_rewrite_re_escapes_the_payload() {
        let rewritten = complete_colour_signalling(FULL_RANGE_NO_DESCRIPTION).expect("rewritten");

        for window in rewritten.windows(3) {
            assert!(
                window != [0, 0, 0] && window != [0, 0, 1] && window != [0, 0, 2],
                "unescaped sequence in the rewritten SPS: {rewritten:02x?}"
            );
        }
    }

    /// Truncation must end the parse, not spin or panic. Every prefix of a
    /// real SPS is tried, since a short read can cut anywhere.
    /// The gaps flag is set, and nothing else in the SPS moves.
    ///
    /// Checked against ffmpeg's own reading rather than by parsing it back
    /// here: a bit offset that is wrong in the same way in both the writer and
    /// the reader agrees with itself perfectly.
    #[test]
    fn setting_the_gaps_flag_matches_ffmpegs_reading() {
        use std::process::Command;

        let run = |args: &[&str]| -> Option<String> {
            let out = Command::new("ffmpeg").args(args).output().ok()?;
            Some(String::from_utf8_lossy(&out.stderr).into_owned())
        };

        if run(&["-version"]).is_none() {
            eprintln!("SKIP: needs ffmpeg");
            return;
        }

        let dir = std::env::temp_dir().join(format!("rustguac-gaps-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let clip = dir.join("in.264");

        assert!(Command::new("ffmpeg")
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=128x96:rate=10:duration=1",
                "-pix_fmt",
                "yuv420p",
                "-c:v",
                "libx264",
                "-profile:v",
                "high",
                "-f",
                "h264",
            ])
            .arg(&clip)
            .status()
            .expect("ffmpeg")
            .success());

        let annexb = std::fs::read(&clip).expect("clip");
        let range = find_sps_range(&annexb).expect("an SPS");

        // x264 clears it, which is what makes this worth doing at all.
        let trace = |path: &std::path::Path| -> String {
            run(&[
                "-v",
                "trace",
                "-i",
                &path.to_string_lossy(),
                "-c",
                "copy",
                "-bsf:v",
                "trace_headers",
                "-f",
                "null",
                "-",
            ])
            .unwrap_or_default()
        };
        assert!(
            trace(&clip)
                .contains("gaps_in_frame_num_allowed_flag                              0 = 0"),
            "the fixture should start with the flag clear"
        );

        let rewritten = allow_frame_num_gaps(&annexb[range.clone()]).expect("a flag to set");
        assert_eq!(
            rewritten.len(),
            range.len(),
            "one bit in place should not change the payload length"
        );

        let mut patched = annexb.clone();
        patched.splice(range.clone(), rewritten);
        let out = dir.join("out.264");
        std::fs::write(&out, &patched).expect("write");

        let after = trace(&out);
        assert!(
            after.contains("gaps_in_frame_num_allowed_flag                              1 = 1"),
            "ffmpeg should read the flag as set:\n{}",
            after
        );

        // Everything else must survive, or the picture does not. Compared
        // past the "[trace_headers @ 0x...]" prefix, whose address differs
        // between runs.
        let field_line = |trace: &str, field: &str| -> Option<String> {
            trace
                .lines()
                .find(|l| l.contains(field))
                .and_then(|l| l.split_once("] "))
                .map(|(_, rest)| rest.to_owned())
        };
        let before_trace = trace(&clip);
        for field in [
            "log2_max_frame_num_minus4",
            "pic_width_in_mbs_minus1",
            "pic_height_in_map_units_minus1",
        ] {
            assert_eq!(
                field_line(&before_trace, field),
                field_line(&after, field),
                "{} moved",
                field
            );
        }

        // A second pass has nothing to do.
        assert!(allow_frame_num_gaps(&patched[range]).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncation_is_not_fatal() {
        for len in 0..FULL_RANGE_COMPLETE.len() {
            let _ = parse_sps(&FULL_RANGE_COMPLETE[..len]);
        }
    }
}
