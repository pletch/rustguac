//! Reads the reference structure out of an AVC444 stream's slice headers, to
//! settle whether the auxiliary chroma view can be dropped on the way to the
//! browser.
//!
//! # The question
//!
//! The combine gate in `H264Decoder.js` removes the *cost* of 4:4:4 by
//! discarding the auxiliary view after decoding it. What it cannot remove is
//! the bandwidth, because the bytes have already crossed the link, nor the
//! second decode. On the WAN leg between rustguac and the browser — which is
//! where the constraint usually sits, guacd being local to rustguac — the
//! auxiliary view is roughly half of the H.264 traffic against a Windows host,
//! which sends chroma with every picture.
//!
//! Asking the host for AVC420 instead is the existing lever, and against
//! Windows it does not work: `rdpgfx_main.c` emits the RDPGFX v10 capability
//! sets only when AVC444 is requested (`!GfxH264 || GfxAVC444`), and at v10 the
//! only AVC-related flag is `AVC_DISABLED`. So the protocol offers
//! AVC420-at-v8.1, AVC-off-at-v10 and AVC444-at-v10, and a Windows host that
//! wants H.264 at all must be asked for AVC444. Which leaves dropping the
//! auxiliary view downstream as the only place the saving could come from.
//!
//! # Why it is not obviously safe
//!
//! The two views are **one H.264 sequence sharing one decoded picture buffer**,
//! not two streams multiplexed together. FreeRDP's `avc444_decompress` feeds
//! both bitstreams to the same `H264_CONTEXT` through the same `Decompress`,
//! `patch 004` says so in as many words, and our own client is the positive
//! proof: `H264Decoder.js` holds a single `VideoDecoder` and interleaves both
//! views into it, which two independent sequences would break at the first IDR.
//!
//! Dropping access units out of a single sequence is safe only if nothing that
//! survives depends on them. Three things decide it, and all three are written
//! in the slice headers:
//!
//! 1. **`nal_ref_idc` on auxiliary slices.** Zero means the picture is never
//!    stored as a reference, and a picture that is never stored can never be
//!    referred to. That alone would settle it.
//! 2. **Whether `frame_num` advances across an auxiliary view.** A reference
//!    picture consumes a `frame_num`; a non-reference one does not. So the
//!    delta between consecutive *main* views says the same thing from the other
//!    side, and disagreeing with (1) means this parser is misreading the
//!    headers rather than that the stream is unusual.
//! 3. **`ref_pic_list_modification` in main slices.** The default reference
//!    list is ordered by descending `PicNum`, which in an interleaved stream
//!    puts the *auxiliary* picture first — so a working encoder must be
//!    reordering past it, by a `PicNum` that would no longer exist once the
//!    auxiliary view is dropped. `memory_management_control_operation` is read
//!    for the same reason from the other direction: an encoder that marks each
//!    auxiliary picture unused as soon as it has served its purpose would keep
//!    them out of main's lists by construction.
//!
//! Plus `gaps_in_frame_num_value_allowed_flag`, which says whether a decoder is
//! even required to tolerate the holes dropping would leave.
//!
//! # It has been done before, and what went wrong was not this
//!
//! Upstream sol1 **v1.8.0 shipped exactly this configuration**: it negotiated
//! `GfxAVC444 = TRUE` and its AVC444 branch copied `bitstream[0]` alone,
//! dropping the auxiliary view before the browser ever saw it. v1.8.1
//! (`4bcac32`) changed it to `GfxAVC444 = FALSE`, which is where the present
//! AVC420 lever comes from — and, unknown at the time, is what stops a Windows
//! host engaging hardware H.264 encoding at all.
//!
//! The symptom that drove that change was *not* a broken reference chain. It
//! was recorded as "two blocks with green and magenta casts": v1.8.0 read no
//! `LC` at all, so an MS-RDPEGFX LC=2 command — chroma in `bitstream[0]`, no
//! luma anywhere — was forwarded and painted as an image. Packed chroma drawn
//! as YUV is green and magenta. A shattered reference chain looks like
//! smearing or nothing, not like a recognisable chroma plane, so the pictures
//! were decoding.
//!
//! That is real evidence the drop is viable, and it is weaker than it looks on
//! three counts, all of which this probe can speak to: v1.8.0 still ran the
//! GDI decode (`orig(context, cmd)`), so guacd held real pixels and the layer
//! had another source of paint; the fault was diagnosed as a colour bug and
//! fixed quickly, so nobody watched a long session for slow reference drift;
//! and it says nothing about xrdp, whose fork interleaves chroma on a
//! `CHROMA_INTERVAL` and need not structure its references the same way.
//!
//! It also settles one thing outright: **LC=2 commands are real on Windows**.
//! A downstream drop has to lose the whole command for those, not merely its
//! auxiliary half, which is why the unpaired auxiliary view is counted here.
//!
//! # What this is
//!
//! A probe, not a feature. It is off unless `RUSTGUAC_H264_NAL_PROBE` is set,
//! costs nothing when off, parses only the first few hundred bytes of each
//! access unit when on, and writes to the journal. It answers the question
//! against a real host and then its answer decides whether anything is built.
//!
//! `RUSTGUAC_H264_NAL_PROBE=1` gives the default 40 per-picture detail lines
//! and then summaries; a number larger than one sets the detail count.

use std::collections::BTreeMap;
use std::collections::HashMap;

use crate::h264_sps::{next_start_code, read_sps_prefix, unescape, BitReader};

/// Detail lines before the probe falls back to summaries alone.
const DEFAULT_DETAIL_AUS: u64 = 40;

/// Access units between summaries. The first is early enough to read while a
/// session is still being set up; the rest are for confirming that what the
/// early one saw holds once the session is doing real work.
const FIRST_SUMMARY_AUS: u64 = 200;
const SUMMARY_INTERVAL_AUS: u64 = 2000;

/// How much of an access unit is buffered before its slice header is read.
/// The header sits within a few dozen bytes of the first VCL NAL, behind at
/// most an access unit delimiter, an SEI, an SPS and a PPS on a keyframe.
const AU_PREFIX_BYTES: usize = 2048;

/// Enough of an access unit to reach its first slice header, past the
/// parameter sets a keyframe carries.
const AU_ENOUGH_BYTES: usize = 768;

/// Cap on part-assembled access units held at once, so a stream that never
/// ends cannot grow the map without limit.
const MAX_PENDING_STREAMS: usize = 256;

/// Region rects to count past when reaching the trailing `<paired>` flag,
/// beyond which the instruction is taken as malformed rather than walked.
const MAX_RECTS: usize = 4096;

/// The fields of a sequence parameter set a slice header cannot be read
/// without.
#[derive(Clone, Copy)]
struct Sps {
    log2_max_frame_num: u32,
    pic_order_cnt_type: u32,
    log2_max_poc_lsb: u32,
    delta_pic_order_always_zero: bool,
    frame_mbs_only: bool,
    separate_colour_plane: bool,
    chroma_array_type: u32,
    gaps_allowed: bool,
    max_num_ref_frames: u32,
}

/// The fields of a picture parameter set a slice header cannot be read without.
#[derive(Clone, Copy)]
struct Pps {
    sps_id: u32,
    bottom_field_pic_order_in_frame_present: bool,
    num_ref_idx_l0_default_active_minus1: u32,
    num_ref_idx_l1_default_active_minus1: u32,
    weighted_pred: bool,
    weighted_bipred_idc: u32,
    redundant_pic_cnt_present: bool,
}

/// What one access unit's first slice says about the reference structure.
struct Slice {
    nal_ref_idc: u8,
    idr: bool,
    slice_type: u32,
    frame_num: u32,
    /// `(modification_of_pic_nums_idc, its argument)`, in order, for list 0.
    /// Empty when the slice took the default ordering.
    list_mods: Vec<(u32, u32)>,
    /// `memory_management_control_operation` values, in order.
    mmco: Vec<u32>,
    long_term_reference: bool,
}

impl Slice {
    /// The slice type without the "every slice in this picture is this type"
    /// offset of 5.
    fn base_type(&self) -> u32 {
        self.slice_type % 5
    }

    fn type_name(&self) -> &'static str {
        match self.base_type() {
            0 => "P",
            1 => "B",
            2 => "I",
            3 => "SP",
            4 => "SI",
            _ => "?",
        }
    }
}

/// An access unit being assembled from the blobs of one stream.
struct Pending {
    view: u8,
    keyframe: bool,
    /// The trailing `<paired>` flag: an auxiliary view for this same picture
    /// follows immediately (MS-RDPEGFX LC=0).
    paired: bool,
    buf: Vec<u8>,
    /// Set once the slice header has been read, so the remaining blobs of a
    /// large picture are ignored rather than buffered.
    done: bool,
}

/// Counts for one view.
#[derive(Default)]
struct ViewStats {
    total: u64,
    reference: u64,
    idr: u64,
    slice_types: BTreeMap<&'static str, u64>,
}

/// The probe's accumulated answer.
#[derive(Default)]
struct Stats {
    aus: u64,
    /// Indexed by view: 0 main, 1 auxiliary v1, 2 auxiliary v2.
    views: [ViewStats; 3],
    /// `frame_num` deltas between consecutive main views, modulo the wrap.
    /// A stream whose auxiliary views are non-reference shows 1 here; one
    /// whose auxiliary views are reference pictures shows 2.
    main_deltas: BTreeMap<u32, u64>,
    /// `frame_num` of an auxiliary view minus that of the main view before it.
    aux_offsets: BTreeMap<u32, u64>,
    main_with_list_mod: u64,
    aux_with_list_mod: u64,
    /// Auxiliary views arriving with no paired main view ahead of them — an
    /// MS-RDPEGFX LC=2 command, whose only bitstream is chroma.
    ///
    /// Worth counting because it is the case that broke this in v1.8.0, which
    /// requested AVC444 and forwarded bitstream[0] without reading LC: against
    /// a Windows host that put the chroma picture on the wire as an image, and
    /// the browser painted it. A downstream drop has to lose the whole command
    /// for these, not merely its auxiliary half.
    aux_unpaired: u64,
    list_mods: BTreeMap<(u32, u32), u64>,
    mmco: BTreeMap<u32, u64>,
    parse_failures: u64,
    gaps_allowed: Option<bool>,
    max_num_ref_frames: Option<u32>,
}

/// Reads the reference structure of a passthrough stream, once enabled.
pub struct NalProbe {
    detail_aus: u64,
    pending: HashMap<u32, Pending>,
    sps: HashMap<u32, Sps>,
    pps: HashMap<u32, Pps>,
    stats: Stats,
    last_main_frame_num: Option<u32>,
    /// Whether the most recent main view declared an auxiliary view to follow,
    /// so one arriving without it can be recognised as a chroma-only command.
    last_main_paired: bool,
    next_summary: u64,
}

impl NalProbe {
    /// A probe, or `None` when `RUSTGUAC_H264_NAL_PROBE` is unset or off.
    ///
    /// Returning `None` rather than a disabled probe is what keeps the cost at
    /// zero: the caller holds an `Option` and never enters the instruction
    /// scan, which is the same shape `FrameStats` uses for its own watch.
    pub fn new() -> Option<Self> {
        let raw = std::env::var("RUSTGUAC_H264_NAL_PROBE").ok()?;
        let value = raw.trim();
        let detail_aus = match value {
            "" | "0" | "off" | "false" | "no" => return None,
            "1" | "on" | "true" | "yes" => DEFAULT_DETAIL_AUS,
            other => other.parse::<u64>().ok()?,
        };

        Some(Self::with_detail(detail_aus))
    }

    fn with_detail(detail_aus: u64) -> Self {
        Self {
            detail_aus,
            pending: HashMap::new(),
            sps: HashMap::new(),
            pps: HashMap::new(),
            stats: Stats::default(),
            last_main_frame_num: None,
            last_main_paired: false,
            next_summary: FIRST_SUMMARY_AUS,
        }
    }

    /// Reads one chunk of the guacd → browser stream, returning the lines to
    /// log. The chunk always ends on an instruction boundary (see
    /// `guacd_to_ws`), so every instruction start in it is a real one.
    pub fn observe(&mut self, text: &str) -> Vec<String> {
        let mut lines = Vec::new();

        for instr in crate::frame_stats::instruction_starts(text) {
            if let Some(rest) = instr.strip_prefix("4.h264,") {
                self.open(rest);
            } else if let Some(rest) = instr.strip_prefix("4.blob,") {
                self.blob(rest, &mut lines);
            } else if let Some(rest) = instr.strip_prefix("3.end,") {
                self.end(rest, &mut lines);
            }
        }

        if self.stats.aus >= self.next_summary {
            self.next_summary = self.stats.aus + SUMMARY_INTERVAL_AUS;
            lines.extend(self.stats.summary());
        }

        lines
    }

    /// `h264,<stream>,<layer>,<keyframe>,<x>,<y>,<w>,<h>,<view>,<numrects>,
    /// [<x> <y> <w> <h>]...,<paired>`
    fn open(&mut self, rest: &str) {
        let mut args = crate::frame_stats::elements(rest);
        let Some(index) = args.next().and_then(|v| v.parse::<u32>().ok()) else {
            return;
        };
        let keyframe = args.nth(1).and_then(|v| v.parse::<u32>().ok()) == Some(1);
        // Past x, y, width and height to the view.
        let view = args
            .nth(4)
            .and_then(|v| v.parse::<u8>().ok())
            .unwrap_or(0)
            .min(2);

        // <paired> trails the rects because they vary in number, so reaching it
        // means counting past them. Guarded against an absurd count, which
        // would otherwise be a long walk over a truncated instruction.
        let num_rects = args
            .next()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|n| *n <= MAX_RECTS)
            .unwrap_or(0);
        let paired = args
            .nth(num_rects * 4)
            .and_then(|v| v.parse::<u32>().ok())
            .is_some_and(|v| v != 0);

        if self.pending.len() >= MAX_PENDING_STREAMS {
            // Streams that never ended. Nothing here is worth recovering, and
            // the alternative is unbounded growth on a long session.
            self.pending.clear();
        }

        self.pending.insert(
            index,
            Pending {
                view,
                keyframe,
                paired,
                buf: Vec::new(),
                done: false,
            },
        );
    }

    /// `blob,<stream>,<base64>`
    fn blob(&mut self, rest: &str, lines: &mut Vec<String>) {
        let mut args = crate::frame_stats::elements(rest);
        let Some(index) = args.next().and_then(|v| v.parse::<u32>().ok()) else {
            return;
        };
        let Some(payload) = args.next() else {
            return;
        };

        let ready = {
            let Some(pending) = self.pending.get_mut(&index) else {
                return;
            };
            if pending.done {
                return;
            }

            use base64::Engine as _;
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(payload) else {
                return;
            };

            let room = AU_PREFIX_BYTES.saturating_sub(pending.buf.len());
            pending
                .buf
                .extend_from_slice(&bytes[..room.min(bytes.len())]);
            pending.buf.len() >= AU_ENOUGH_BYTES || pending.buf.len() >= AU_PREFIX_BYTES
        };

        if ready {
            self.analyse(index, lines);
        }
    }

    /// `end,<stream>` — the access unit is complete, so a short one that never
    /// reached the buffering threshold is read now.
    fn end(&mut self, rest: &str, lines: &mut Vec<String>) {
        let Some(index) = crate::frame_stats::elements(rest)
            .next()
            .and_then(|v| v.parse::<u32>().ok())
        else {
            return;
        };

        if self.pending.get(&index).is_some_and(|p| !p.done) {
            self.analyse(index, lines);
        }
        self.pending.remove(&index);
    }

    /// Reads the parameter sets and first slice header out of what has been
    /// buffered for one stream, and folds the result into the statistics.
    fn analyse(&mut self, index: u32, lines: &mut Vec<String>) {
        let Some(pending) = self.pending.get_mut(&index) else {
            return;
        };
        pending.done = true;
        let view = pending.view;
        let keyframe = pending.keyframe;
        let paired = pending.paired;
        let buf = std::mem::take(&mut pending.buf);

        let mut slice = None;
        for (header, payload) in nal_units(&buf) {
            let nal_ref_idc = (header >> 5) & 3;
            match header & 0x1f {
                7 => {
                    if let Some((id, sps)) = parse_sps(payload) {
                        self.stats.gaps_allowed = Some(sps.gaps_allowed);
                        self.stats.max_num_ref_frames = Some(sps.max_num_ref_frames);
                        self.sps.insert(id, sps);
                    }
                }
                8 => {
                    if let Some((id, pps)) = parse_pps(payload) {
                        self.pps.insert(id, pps);
                    }
                }
                nal_type @ (1 | 5) => {
                    slice = parse_slice(payload, nal_ref_idc, nal_type == 5, &self.sps, &self.pps);
                    break;
                }
                _ => {}
            }
        }

        let Some(slice) = slice else {
            self.stats.parse_failures += 1;
            return;
        };

        self.stats.aus += 1;
        let n = self.stats.aus;

        // Read before the update below: an auxiliary view never declares a
        // pair of its own, so what makes it chroma-only is the absence of a
        // paired main view *ahead* of it.
        let chroma_only = view != 0 && !self.last_main_paired;

        let stats = &mut self.stats.views[view as usize];
        stats.total += 1;
        if slice.nal_ref_idc != 0 {
            stats.reference += 1;
        }
        if slice.idr {
            stats.idr += 1;
        }
        *stats.slice_types.entry(slice.type_name()).or_default() += 1;

        // Any SPS will do: both views of an AVC444 picture share one sequence,
        // so they share its frame_num width. Four is the smallest the standard
        // allows, and only reached if no SPS has been seen yet.
        let wrap = 1u32
            << self
                .sps
                .values()
                .next()
                .map(|s| s.log2_max_frame_num)
                .unwrap_or(4);

        if view == 0 {
            if let Some(prev) = self.last_main_frame_num {
                let delta = (slice.frame_num + wrap - prev) % wrap;
                *self.stats.main_deltas.entry(delta).or_default() += 1;
            }
            self.last_main_frame_num = Some(slice.frame_num);
            if !slice.list_mods.is_empty() {
                self.stats.main_with_list_mod += 1;
            }
            self.last_main_paired = paired;
        } else {
            if chroma_only {
                self.stats.aux_unpaired += 1;
            }
            self.last_main_paired = false;
            if let Some(main) = self.last_main_frame_num {
                let offset = (slice.frame_num + wrap - main) % wrap;
                *self.stats.aux_offsets.entry(offset).or_default() += 1;
            }
            if !slice.list_mods.is_empty() {
                self.stats.aux_with_list_mod += 1;
            }
        }

        for &op in &slice.list_mods {
            *self.stats.list_mods.entry(op).or_default() += 1;
        }
        for &op in &slice.mmco {
            *self.stats.mmco.entry(op).or_default() += 1;
        }

        if n <= self.detail_aus {
            let mods = if slice.list_mods.is_empty() {
                "-".to_string()
            } else {
                slice
                    .list_mods
                    .iter()
                    .map(|(idc, value)| format!("idc{}:{}", idc, value))
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            let mmco = if slice.mmco.is_empty() {
                "-".to_string()
            } else {
                slice
                    .mmco
                    .iter()
                    .map(|op| op.to_string())
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            lines.push(format!(
                "au={} view={} stream={} {}nal_ref_idc={} type={} frame_num={} listmod={} mmco={}{}",
                n,
                view_name(view),
                index,
                if keyframe { "keyframe " } else { "" },
                slice.nal_ref_idc,
                slice.type_name(),
                slice.frame_num,
                mods,
                mmco,
                if slice.long_term_reference {
                    " long_term_reference"
                } else if view == 0 && paired {
                    " paired"
                } else if chroma_only {
                    " chroma-only"
                } else {
                    ""
                },
            ));
        }
    }
}

fn view_name(view: u8) -> &'static str {
    match view {
        0 => "main",
        1 => "aux-v1",
        _ => "aux-v2",
    }
}

impl Stats {
    /// The whole point of the exercise: what has been seen, and what it means
    /// for dropping the auxiliary view.
    fn summary(&self) -> Vec<String> {
        let mut lines = Vec::new();

        lines.push(format!(
            "summary after {} access units ({} unreadable)",
            self.aus, self.parse_failures
        ));

        for (view, stats) in self.views.iter().enumerate() {
            if stats.total == 0 {
                continue;
            }
            let types = stats
                .slice_types
                .iter()
                .map(|(name, count)| format!("{} x{}", name, count))
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!(
                "  {:<6} {} pictures: {} reference, {} non-reference, {} IDR  [{}]",
                view_name(view as u8),
                stats.total,
                stats.reference,
                stats.total - stats.reference,
                stats.idr,
                types
            ));
        }

        lines.push(format!(
            "  frame_num delta between consecutive main views: {}",
            histogram(&self.main_deltas)
        ));
        lines.push(format!(
            "  aux frame_num minus preceding main: {}",
            histogram(&self.aux_offsets)
        ));
        lines.push(format!(
            "  ref_pic_list_modification: {} main, {} aux; ops {}",
            self.main_with_list_mod,
            self.aux_with_list_mod,
            if self.list_mods.is_empty() {
                "none".to_string()
            } else {
                self.list_mods
                    .iter()
                    .map(|((idc, value), count)| format!("idc{}:{} x{}", idc, value, count))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ));
        lines.push(format!(
            "  aux views with no paired main view (LC=2, chroma only): {}",
            self.aux_unpaired
        ));
        lines.push(format!(
            "  memory_management_control_operation: {}",
            histogram(&self.mmco)
        ));
        lines.push(format!(
            "  SPS: gaps_in_frame_num_value_allowed_flag={} max_num_ref_frames={}",
            self.gaps_allowed
                .map(|v| u8::from(v).to_string())
                .unwrap_or_else(|| "?".into()),
            self.max_num_ref_frames
                .map(|v| v.to_string())
                .unwrap_or_else(|| "?".into()),
        ));

        lines.push(format!("  VERDICT: {}", self.verdict()));
        lines
    }

    /// Reads the three questions in the order that short-circuits: a
    /// non-reference auxiliary view settles it on its own, because a picture
    /// that is never stored can never be referred to.
    fn verdict(&self) -> String {
        let aux: u64 = self.views[1].total + self.views[2].total;
        if aux == 0 {
            return "no auxiliary views seen — this is an AVC420 stream, or the \
                    host has not sent chroma yet"
                .into();
        }

        let aux_reference = self.views[1].reference + self.views[2].reference;
        // A main view following a non-reference auxiliary view is one
        // frame_num further on, not two.
        let main_advances_by_one = self.main_deltas.keys().all(|&delta| delta <= 1);

        if aux_reference == 0 {
            if !main_advances_by_one {
                return format!(
                    "CONTRADICTORY — every auxiliary view is non-reference, yet \
                     frame_num advances by more than one between main views \
                     ({}). One of the two readings is wrong; suspect this \
                     parser before the stream",
                    histogram(&self.main_deltas)
                );
            }
            return "DROPPABLE — every auxiliary view is a non-reference picture \
                    and consumes no frame_num, so no surviving slice can refer \
                    to one. Dropping the view!=0 instructions and clearing the \
                    trailing <paired> flag on their main views would leave a \
                    valid 4:2:0 stream"
                .into();
        }

        let mut reasons = vec![format!(
            "{} of {} auxiliary views are reference pictures",
            aux_reference, aux
        )];
        if !main_advances_by_one {
            reasons.push(
                "they consume frame_num slots, so dropping them opens \
                          gaps in the sequence"
                    .into(),
            );
        }
        if self.main_with_list_mod > 0 {
            reasons.push(format!(
                "{} main slices reorder their reference list by PicNum, which \
                 counts backwards through the auxiliary pictures",
                self.main_with_list_mod
            ));
        }
        if self.gaps_allowed == Some(false) && !main_advances_by_one {
            reasons.push(
                "and gaps_in_frame_num_value_allowed_flag is 0, so a \
                          decoder is not required to tolerate the result"
                    .into(),
            );
        }

        format!(
            "NOT DROPPABLE as-is — {}. Shedding the auxiliary view downstream \
             would need the surviving slice headers rewritten (frame_num, and \
             the reference list modifications that address the dropped \
             pictures), not merely filtered",
            reasons.join("; ")
        )
    }
}

fn histogram<K: std::fmt::Display>(counts: &BTreeMap<K, u64>) -> String {
    if counts.is_empty() {
        return "none".into();
    }
    counts
        .iter()
        .map(|(value, count)| format!("{} x{}", value, count))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Walks the NAL units of an Annex B stream, yielding each one's header byte
/// and its payload (the header byte excluded).
fn nal_units(annexb: &[u8]) -> impl Iterator<Item = (u8, &[u8])> {
    let mut i = 0usize;
    std::iter::from_fn(move || {
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
            if byte & 0x80 != 0 {
                i = header + 1;
                continue;
            }

            let end = next_start_code(annexb, header + 1).unwrap_or(annexb.len());
            i = end;
            return Some((byte, &annexb[header + 1..end]));
        }
        None
    })
}

/// The `seq_parameter_set_id` and reference-structure fields of one SPS.
fn parse_sps(payload: &[u8]) -> Option<(u32, Sps)> {
    let rbsp = unescape(payload);
    let mut r = BitReader::new(&rbsp);

    let prefix = read_sps_prefix(&mut r)?;

    let log2_max_frame_num = r.ue()? + 4;
    let pic_order_cnt_type = r.ue()?;
    let mut log2_max_poc_lsb = 0;
    let mut delta_pic_order_always_zero = false;
    if pic_order_cnt_type == 0 {
        log2_max_poc_lsb = r.ue()? + 4;
    } else if pic_order_cnt_type == 1 {
        delta_pic_order_always_zero = r.bit()? == 1;
        r.se()?; // offset_for_non_ref_pic
        r.se()?; // offset_for_top_to_bottom_field
        let cycle = r.ue()?;
        if cycle > 255 {
            return None;
        }
        for _ in 0..cycle {
            r.se()?;
        }
    }

    let max_num_ref_frames = r.ue()?;
    let gaps_allowed = r.bit()? == 1;
    r.ue()?; // pic_width_in_mbs_minus1
    r.ue()?; // pic_height_in_map_units_minus1
    let frame_mbs_only = r.bit()? == 1;
    if !frame_mbs_only {
        r.bit()?; // mb_adaptive_frame_field_flag
    }

    Some((
        prefix.seq_parameter_set_id,
        Sps {
            log2_max_frame_num,
            pic_order_cnt_type,
            log2_max_poc_lsb,
            delta_pic_order_always_zero,
            frame_mbs_only,
            separate_colour_plane: prefix.separate_colour_plane,
            chroma_array_type: prefix.chroma_array_type,
            gaps_allowed,
            max_num_ref_frames,
        },
    ))
}

/// The `pic_parameter_set_id` and slice-header-shaping fields of one PPS.
///
/// Stops at `redundant_pic_cnt_present_flag`: everything past it belongs to the
/// optional extension, which no field this probe reads depends on.
fn parse_pps(payload: &[u8]) -> Option<(u32, Pps)> {
    let rbsp = unescape(payload);
    let mut r = BitReader::new(&rbsp);

    let id = r.ue()?;
    let sps_id = r.ue()?;
    r.bit()?; // entropy_coding_mode_flag
    let bottom_field_pic_order_in_frame_present = r.bit()? == 1;

    let num_slice_groups_minus1 = r.ue()?;
    if num_slice_groups_minus1 > 0 {
        let map_type = r.ue()?;
        match map_type {
            0 => {
                for _ in 0..=num_slice_groups_minus1 {
                    r.ue()?; // run_length_minus1
                }
            }
            2 => {
                for _ in 0..num_slice_groups_minus1 {
                    r.ue()?; // top_left
                    r.ue()?; // bottom_right
                }
            }
            3..=5 => {
                r.bit()?; // slice_group_change_direction_flag
                r.ue()?; // slice_group_change_rate_minus1
            }
            6 => {
                let units = r.ue()?;
                // Bits per entry: ceil(log2(num_slice_groups_minus1 + 1)).
                let bits = 32 - num_slice_groups_minus1.leading_zeros();
                for _ in 0..units {
                    r.bits(bits)?;
                }
            }
            _ => {}
        }
    }

    let num_ref_idx_l0_default_active_minus1 = r.ue()?;
    let num_ref_idx_l1_default_active_minus1 = r.ue()?;
    let weighted_pred = r.bit()? == 1;
    let weighted_bipred_idc = r.bits(2)?;
    r.se()?; // pic_init_qp_minus26
    r.se()?; // pic_init_qs_minus26
    r.se()?; // chroma_qp_index_offset
    r.bit()?; // deblocking_filter_control_present_flag
    r.bit()?; // constrained_intra_pred_flag
    let redundant_pic_cnt_present = r.bit()? == 1;

    Some((
        id,
        Pps {
            sps_id,
            bottom_field_pic_order_in_frame_present,
            num_ref_idx_l0_default_active_minus1,
            num_ref_idx_l1_default_active_minus1,
            weighted_pred,
            weighted_bipred_idc,
            redundant_pic_cnt_present,
        },
    ))
}

/// Reads one slice header as far as `dec_ref_pic_marking()`, which is the last
/// thing here that says anything about references.
///
/// Everything between `frame_num` and the reference list modification has to be
/// walked exactly — including the weighted prediction tables, whose size
/// depends on both the PPS and the SPS's chroma format — because the fields are
/// variable-length and there is no resynchronisation. A wrong turn anywhere
/// yields plausible nonsense rather than an error, which is why
/// `tests/fixtures` holds a real encoder's stream to check the walk against.
fn parse_slice(
    payload: &[u8],
    nal_ref_idc: u8,
    idr: bool,
    sps_by_id: &HashMap<u32, Sps>,
    pps_by_id: &HashMap<u32, Pps>,
) -> Option<Slice> {
    let rbsp = unescape(payload);
    let mut r = BitReader::new(&rbsp);

    r.ue()?; // first_mb_in_slice
    let slice_type = r.ue()?;
    let pps_id = r.ue()?;

    let pps = *pps_by_id.get(&pps_id)?;
    let sps = *sps_by_id.get(&pps.sps_id)?;

    if sps.separate_colour_plane {
        r.bits(2)?; // colour_plane_id
    }

    let frame_num = r.bits(sps.log2_max_frame_num)?;

    let mut field_pic = false;
    if !sps.frame_mbs_only {
        field_pic = r.bit()? == 1;
        if field_pic {
            r.bit()?; // bottom_field_flag
        }
    }

    if idr {
        r.ue()?; // idr_pic_id
    }

    if sps.pic_order_cnt_type == 0 {
        r.bits(sps.log2_max_poc_lsb)?; // pic_order_cnt_lsb
        if pps.bottom_field_pic_order_in_frame_present && !field_pic {
            r.se()?; // delta_pic_order_cnt_bottom
        }
    } else if sps.pic_order_cnt_type == 1 && !sps.delta_pic_order_always_zero {
        r.se()?; // delta_pic_order_cnt[0]
        if pps.bottom_field_pic_order_in_frame_present && !field_pic {
            r.se()?; // delta_pic_order_cnt[1]
        }
    }

    if pps.redundant_pic_cnt_present {
        r.ue()?; // redundant_pic_cnt
    }

    let base_type = slice_type % 5;
    let is_b = base_type == 1;
    let is_p = base_type == 0 || base_type == 3;
    let is_intra = base_type == 2 || base_type == 4;

    if is_b {
        r.bit()?; // direct_spatial_mv_pred_flag
    }

    let mut num_ref_idx_l0 = pps.num_ref_idx_l0_default_active_minus1;
    let mut num_ref_idx_l1 = pps.num_ref_idx_l1_default_active_minus1;
    if (is_p || is_b) && r.bit()? == 1 {
        // num_ref_idx_active_override_flag
        num_ref_idx_l0 = r.ue()?;
        if is_b {
            num_ref_idx_l1 = r.ue()?;
        }
    }

    // ref_pic_list_modification()
    let mut list_mods = Vec::new();
    if !is_intra {
        read_list_modification(&mut r, &mut list_mods)?;
    }
    if is_b {
        // List 1's modifications are recorded alongside list 0's: either list
        // reaching back past an auxiliary picture is the same problem.
        read_list_modification(&mut r, &mut list_mods)?;
    }

    // pred_weight_table()
    if (pps.weighted_pred && is_p) || (pps.weighted_bipred_idc == 1 && is_b) {
        read_pred_weight_table(&mut r, sps.chroma_array_type, num_ref_idx_l0)?;
        if is_b {
            read_pred_weight_table(&mut r, sps.chroma_array_type, num_ref_idx_l1)?;
        }
    }

    // dec_ref_pic_marking()
    let mut mmco = Vec::new();
    let mut long_term_reference = false;
    if nal_ref_idc != 0 {
        if idr {
            r.bit()?; // no_output_of_prior_pics_flag
            long_term_reference = r.bit()? == 1;
        } else if r.bit()? == 1 {
            // adaptive_ref_pic_marking_mode_flag
            loop {
                let op = r.ue()?;
                if op == 0 {
                    break;
                }
                if op == 1 || op == 3 {
                    r.ue()?; // difference_of_pic_nums_minus1
                }
                if op == 2 {
                    r.ue()?; // long_term_pic_num
                }
                if op == 3 || op == 6 {
                    r.ue()?; // long_term_frame_idx
                }
                if op == 4 {
                    r.ue()?; // max_long_term_frame_idx_plus1
                }
                mmco.push(op);
                if mmco.len() > 32 {
                    return None;
                }
            }
        }
    }

    Some(Slice {
        nal_ref_idc,
        idr,
        slice_type,
        frame_num,
        list_mods,
        mmco,
        long_term_reference,
    })
}

/// One `ref_pic_list_modification` list, appending `(idc, argument)` pairs.
fn read_list_modification(r: &mut BitReader, out: &mut Vec<(u32, u32)>) -> Option<()> {
    if r.bit()? == 0 {
        return Some(());
    }
    loop {
        let idc = r.ue()?;
        if idc == 3 {
            return Some(());
        }
        let value = r.ue()?;
        out.push((idc, value));
        if out.len() > 64 {
            return None;
        }
    }
}

/// Walks one `pred_weight_table()`, which carries nothing this probe wants but
/// stands between the reference list modification and `dec_ref_pic_marking()`.
fn read_pred_weight_table(
    r: &mut BitReader,
    chroma_array_type: u32,
    num_ref_idx_active_minus1: u32,
) -> Option<()> {
    r.ue()?; // luma_log2_weight_denom
    if chroma_array_type != 0 {
        r.ue()?; // chroma_log2_weight_denom
    }

    // Bounded by the standard at 31; a larger value is a misread header, and
    // looping on it would walk off the end of a truncated buffer.
    if num_ref_idx_active_minus1 > 31 {
        return None;
    }

    for _ in 0..=num_ref_idx_active_minus1 {
        if r.bit()? == 1 {
            r.se()?; // luma_weight
            r.se()?; // luma_offset
        }
        if chroma_array_type != 0 && r.bit()? == 1 {
            for _ in 0..2 {
                r.se()?; // chroma_weight
                r.se()?; // chroma_offset
            }
        }
    }

    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real x264 stream, not a hand-built one: the whole risk in this module
    /// is that its walk through the slice header disagrees with an encoder's,
    /// and a fixture written by the same understanding that reads it would
    /// agree with itself no matter how wrong both were.
    ///
    /// High profile with B frames and three reference frames, so the walk has
    /// to cross the scaling-list branch, the B-slice fields and both reference
    /// lists. The expectations below are ffmpeg's, read out of
    /// `-bsf:v trace_headers`, which prints each syntax element by name.
    const CLIP: &[u8] = include_bytes!("../tests/fixtures/x264-high-bframes.264");

    /// `(nal_ref_idc, slice type, frame_num)` for the first pictures of CLIP,
    /// in decode order, exactly as trace_headers reports them.
    ///
    /// The pattern is the one the probe exists to recognise: a non-reference
    /// picture (`nal_ref_idc` 0) shares its frame_num with the reference
    /// picture that follows, because it consumes no slot. An auxiliary chroma
    /// view that behaved like this could be dropped.
    const EXPECTED: &[(u8, &str, u32)] = &[
        (3, "I", 0),
        (2, "P", 1),
        (2, "B", 2),
        (0, "B", 3),
        (2, "P", 3),
        (2, "B", 4),
        (0, "B", 5),
        (2, "P", 5),
        (0, "B", 6),
        (2, "P", 6),
        (2, "P", 7),
        (2, "P", 8),
        (2, "P", 9),
        (2, "B", 10),
        (0, "B", 11),
        (2, "P", 11),
    ];

    /// Reads CLIP the way the probe reads an access unit, and checks every
    /// slice header against ffmpeg.
    #[test]
    fn slice_headers_agree_with_ffmpeg() {
        let mut sps = HashMap::new();
        let mut pps = HashMap::new();
        let mut seen = Vec::new();

        for (header, payload) in nal_units(CLIP) {
            let nal_ref_idc = (header >> 5) & 3;
            match header & 0x1f {
                7 => {
                    let (id, parsed) = parse_sps(payload).expect("SPS should parse");
                    sps.insert(id, parsed);
                }
                8 => {
                    let (id, parsed) = parse_pps(payload).expect("PPS should parse");
                    pps.insert(id, parsed);
                }
                nal_type @ (1 | 5) => {
                    let slice = parse_slice(payload, nal_ref_idc, nal_type == 5, &sps, &pps)
                        .expect("slice header should parse");
                    seen.push((slice.nal_ref_idc, slice.type_name(), slice.frame_num));
                }
                _ => {}
            }
        }

        assert!(
            seen.len() >= EXPECTED.len(),
            "fixture yielded only {} slices",
            seen.len()
        );
        assert_eq!(&seen[..EXPECTED.len()], EXPECTED);
    }

    /// The SPS fields the slice walk depends on, against trace_headers.
    #[test]
    fn sps_fields_agree_with_ffmpeg() {
        let (_, sps) = nal_units(CLIP)
            .find(|(header, _)| header & 0x1f == 7)
            .and_then(|(_, payload)| parse_sps(payload))
            .expect("fixture should carry an SPS");

        assert_eq!(sps.log2_max_frame_num, 4, "log2_max_frame_num_minus4 = 0");
        assert!(!sps.gaps_allowed, "gaps_in_frame_num_allowed_flag = 0");
        assert!(sps.frame_mbs_only);
        assert_eq!(sps.chroma_array_type, 1, "4:2:0");
    }

    /// A non-reference picture consuming no frame_num is the signature the
    /// verdict turns on, so it is asserted directly rather than left implicit
    /// in the table above.
    #[test]
    fn non_reference_pictures_consume_no_frame_num() {
        for pair in EXPECTED.windows(2) {
            let (ref_idc, _, frame_num) = pair[0];
            let (_, _, next_frame_num) = pair[1];
            if ref_idc == 0 {
                assert_eq!(
                    frame_num, next_frame_num,
                    "a non-reference picture should share its frame_num with \
                     the picture after it"
                );
            }
        }
    }

    /// Builds the instruction stream guacd would send for a run of access
    /// units, alternating the views as an AVC444 host does.
    ///
    /// The fixture's pictures are ordinary AVC420, so the *content* of the
    /// verdict means nothing here; what this exercises is everything between
    /// the wire and the parser — the element offsets that locate <view>, the
    /// blob reassembly, and the access unit that is only read at `end`
    /// because it never reached the buffering threshold.
    fn instruction_stream(views: &[u8]) -> String {
        instruction_stream_with(views, 0)
    }

    /// As above, with `num_rects` region rects between `<view>` and the
    /// trailing `<paired>` flag, and every main view declaring a pair.
    ///
    /// The rects are what make `<paired>` hard to find: it trails a
    /// variable-length list, so an off-by-one reads a rect coordinate as a
    /// boolean — true for nearly every rect — and the probe would then call
    /// every chroma-only command paired. `tests/h264-instruction-format.mjs`
    /// guards the same arithmetic on the client side.
    fn instruction_stream_with(views: &[u8], num_rects: usize) -> String {
        use base64::Engine as _;

        let mut params = Vec::new();
        let mut slices = Vec::new();
        for (header, payload) in nal_units(CLIP) {
            let mut nal = vec![0, 0, 0, 1, header];
            nal.extend_from_slice(payload);
            match header & 0x1f {
                7 | 8 => params.extend_from_slice(&nal),
                1 | 5 => slices.push(nal),
                _ => {}
            }
        }

        let mut out = String::new();
        for (i, view) in views.iter().enumerate() {
            let mut au = Vec::new();
            if i == 0 {
                au.extend_from_slice(&params);
            }
            au.extend_from_slice(&slices[i % slices.len()]);

            let index = 10 + i;
            let args: Vec<String> = [
                "h264".to_string(),
                index.to_string(),
                "0".to_string(),              // layer
                u8::from(i == 0).to_string(), // keyframe
                "0".into(),                   // x
                "0".into(),                   // y
                "128".into(),                 // width
                "96".into(),                  // height
                view.to_string(),
                num_rects.to_string(),
            ]
            .into_iter()
            .chain((0..num_rects).flat_map(|r| [r + 1, r + 2, 16, 16].map(|v| v.to_string())))
            .chain(std::iter::once(u8::from(*view == 0).to_string()))
            .collect();
            for arg in args {
                out.push_str(&format!("{}.{},", arg.len(), arg));
            }
            out.pop();
            out.push(';');

            let payload = base64::engine::general_purpose::STANDARD.encode(&au);
            out.push_str(&format!(
                "4.blob,{}.{},{}.{};",
                index.to_string().len(),
                index,
                payload.len(),
                payload
            ));
            out.push_str(&format!("3.end,{}.{};", index.to_string().len(), index));
        }
        out
    }

    /// The wire side: instructions in, one detail line per access unit out,
    /// with the views read from the right element.
    #[test]
    fn reads_views_off_the_wire() {
        let mut probe = NalProbe::with_detail(8);
        let lines = probe.observe(&instruction_stream(&[0, 2, 0, 2, 0, 2]));

        assert_eq!(
            lines.len(),
            6,
            "one detail line per access unit: {:#?}",
            lines
        );
        assert!(lines[0].contains("view=main"), "{}", lines[0]);
        assert!(lines[0].contains("keyframe"), "{}", lines[0]);
        assert!(lines[1].contains("view=aux-v2"), "{}", lines[1]);

        assert_eq!(probe.stats.views[0].total, 3);
        assert_eq!(probe.stats.views[2].total, 3);
        assert_eq!(probe.stats.parse_failures, 0);
    }

    /// A stream with no auxiliary view says so rather than returning a verdict
    /// about nothing — the shape an AVC420 host produces.
    #[test]
    fn an_avc420_stream_reaches_no_verdict() {
        let mut probe = NalProbe::with_detail(0);
        probe.observe(&instruction_stream(&[0, 0, 0, 0]));

        let summary = probe.stats.summary().join("\n");
        assert!(summary.contains("no auxiliary views seen"), "{}", summary);
    }

    /// `<paired>` is found past the rects, not among them.
    #[test]
    fn the_paired_flag_is_read_past_the_rects() {
        for rects in [0, 1, 7] {
            let mut probe = NalProbe::with_detail(4);
            let lines = probe.observe(&instruction_stream_with(&[0, 2, 0, 2], rects));

            assert!(
                lines[0].contains(" paired"),
                "{} rects: {}",
                rects,
                lines[0]
            );
            assert!(
                !lines[1].contains("chroma-only"),
                "{} rects: {}",
                rects,
                lines[1]
            );
            assert_eq!(
                probe.stats.aux_unpaired, 0,
                "{} rects: auxiliary views followed a paired main view",
                rects
            );
        }
    }

    /// An auxiliary view with no paired main view ahead of it is the LC=2
    /// command that v1.8.0 forwarded and the browser painted. A run of them
    /// with no main view at all is the shape a chroma-only refresh takes.
    #[test]
    fn a_chroma_only_command_is_counted_as_unpaired() {
        let mut probe = NalProbe::with_detail(4);
        let lines = probe.observe(&instruction_stream_with(&[2, 2], 3));

        assert!(lines[0].contains("chroma-only"), "{}", lines[0]);
        assert_eq!(probe.stats.aux_unpaired, 2);
    }

    /// The probe is off unless asked for, and that is what keeps it free.
    #[test]
    fn disabled_without_the_env_var() {
        // Not std::env::set_var: tests share a process, and a probe built here
        // would leak into any other test reading the environment.
        assert!(matches!(
            std::env::var("RUSTGUAC_H264_NAL_PROBE").ok().as_deref(),
            None | Some("") | Some("0")
        ));
        assert!(NalProbe::new().is_none());
    }
}
