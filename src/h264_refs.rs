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
//! auxiliary view is 13% of the H.264 traffic against a Windows host and 43%
//! against the xrdp fork, which sends chroma far more often.
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
//! # What the first Windows capture said
//!
//! Measured 2026-09-12, 200 access units: 139 main and 61 auxiliary views, all
//! of them reference pictures — and the two views run on **separate long-term
//! reference chains**. Every inter picture ends with `mmco` 6, marking itself
//! as a long-term reference, and every reordering is
//! `modification_of_pic_nums_idc` 2, naming a long-term picture: main names 0,
//! the auxiliary views name 1. No relative short-term reordering anywhere.
//!
//! Which is the ordinary way to multiplex two independent reference chains
//! into one H.264 sequence, and it means **no surviving slice predicts from a
//! dropped picture**. It also explains v1.8.0: dropping `bitstream[1]` left
//! main's references intact, so the pictures decoded, and the only fault was
//! the LC=2 command being painted.
//!
//! The distinction the first verdict here missed is that idc 0 and 1 carry
//! `abs_diff_pic_num_minus1`, a *relative* step through short-term PicNums
//! that shifts when a picture is removed, while idc 2 carries an absolute
//! `long_term_pic_num` that does not. Reading any reordering as dangerous is
//! what made a droppable stream look undroppable.
//!
//! What is left is `frame_num`, which advances across the auxiliary views and
//! would leave holes: `gaps_in_frame_num_value_allowed_flag` is 0, so the
//! result is not a conforming stream even though it decoded in v1.8.0. That
//! flag is one bit in the SPS, and `crate::h264_rewrite` already edits that
//! structure.
//!
//! # xrdp separates the views differently, and the difference matters
//!
//! The same day, the xrdp fork: 152 main and 48 auxiliary views, all
//! reference pictures, and **no reference list modification anywhere**. Main
//! slices carry no marking either — ordinary short-term references on the
//! default list — while every auxiliary slice carries `mmco` 4 and 6, setting
//! the maximum long-term index and marking itself long-term.
//!
//! That reaches the same place by the opposite route. A P slice's default
//! list-0 ordering is the short-term pictures by descending `PicNum` followed
//! by the long-term ones ascending, so marking each auxiliary picture
//! long-term lifts it out of the short-term set and puts the previous *main*
//! view at index 0. Left short-term it would have been the most recent
//! short-term picture and landed at index 0 itself, which is the fatal case.
//!
//! So the deciding number is `num_ref_idx_l0_active_minus1`: with one entry
//! active, main can only ever reference index 0 and the auxiliary pictures are
//! unreachable; with more, the list reaches them from index 1 and whether any
//! macroblock picks one is below the slice header, where this cannot see.
//! **That field was not recorded in the first captures**, which is why it is
//! read now — the xrdp verdict is not settled until a capture reports it.
//!
//! Two hosts, two schemes, and the one thing they share is that neither leaves
//! an auxiliary picture where a main slice's first reference would land. That
//! is not a coincidence: both encoders have to keep two views from predicting
//! through each other, and the H.264 tools for doing so are few.
//!
//! # What it costs, and the IDR that is still open
//!
//! Re-measured on Windows with the byte counters, 201 access units: the
//! auxiliary view is **13% of the H.264 payload** (559 KiB against main's
//! 3443 KiB, 27 pictures against 174). Not half, which is what this module
//! and `CLAUDE.md` both assumed before anyone counted. Windows sends chroma
//! sparsely, so dropping it is a real saving and a modest one, and the
//! proportion moves with the workload — an earlier capture ran 61 auxiliary
//! pictures in 200.
//!
//! One thing is unresolved, and it came out of an odd `frame_num` delta.
//! **Auxiliary views send IDRs too.** An IDR with `long_term_reference_flag`
//! set marks every other reference unused and claims `LongTermFrameIdx` 0
//! (8.2.5.1), so immediately after an auxiliary IDR the picture at long-term 0
//! is chroma — and the capture shows a main slice naming long-term 0 right
//! there. Either that is main predicting from chroma across a keyframe
//! boundary, or the view attribution at those points is wrong; the counter
//! above is what tells them apart. Dropping an auxiliary IDR would also remove
//! a decoded picture buffer reset the surviving stream is written against,
//! which is a separate problem from the reference itself.
//!
//! Two supporting oddities: Windows' auxiliary slices claim index 1 with
//! `mmco` 6 but never send the `mmco` 4 that raises `MaxLongTermFrameIdx`
//! above the 0 an IDR leaves behind, while xrdp sends both, in that order.
//!
//! # What it costs, and what it took to collect
//!
//! Re-measured with the byte counters: the auxiliary view is **13% of the
//! H.264 payload** on Windows (559 KiB against main's 3443) and **43% on the
//! xrdp fork** (780 KiB against 1007), the difference being how often each
//! host sends chroma. Not half, which is what this module and `CLAUDE.md` both
//! assumed before anyone counted.
//!
//! Getting xrdp there took two goes and a fix at each end. It first read
//! `Unproven` -- main slices took the default reference list and activated two
//! entries, so the auxiliary picture was reachable at index 1 -- and forcing
//! the drop corrupted it, which `tests/aux-drop-replay.mjs` then confirmed
//! against a recording: 12 of 141 main access units undecodable. The fork
//! answered with `f42cc481`, putting both views on explicitly named long-term
//! chains.
//!
//! That passed the reference test and still froze, because the reference test
//! was not the only question. See `no_room_for_inferred_frames`: dropping
//! leaves holes in `frame_num`, the decoder must invent a short-term picture
//! for each, and xrdp's `max_num_ref_frames` of 2 was entirely long-term.
//! `235990e9` declares a third slot, and it works on both hosts.
//!
//! Worth stating plainly, because the obvious reading of the first
//! measurements is that this is not worth building: the drop was provably safe
//! only where it was worth least, and unproven where it was worth most. That
//! was true of the encoders as they stood, and stopped being true when the one
//! encoder we control was changed to suit. Sound reasoning, perishable
//! conclusion -- the shape of the argument outlives the encoders it was made
//! about, so re-check the encoders before reusing it.
//!

use std::collections::BTreeMap;
use std::collections::HashMap;

use crate::h264_sps::{next_start_code, read_sps_prefix, unescape, BitReader};

/// Access units between summaries. The first is early enough to read while a
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

/// Main inter slices to see before deciding: enough to know main's habit of
/// naming its reference rather than one slice's.
///
/// Inter slices rather than access units, because an IDR names no reference
/// and marks nothing -- so this is already the stronger guard against
/// deciding from the connect-time keyframe burst, and a floor on pictures
/// would add only delay. A count of pictures is a bad proxy for elapsed
/// evidence in any case: a quiet Windows desktop sends few of them and sends
/// chroma in about one picture in eight, so a floor that costs a moment on a
/// busy session costs tens of seconds on an idle one.
const MIN_MAIN_INTER_TO_DECIDE: u64 = 10;

/// Auxiliary inter slices to see before deciding.
///
/// The binding condition, and deliberately small. Every auxiliary slice
/// carries the same evidence -- which long-term index it names, and whether
/// that is one main also names -- so a handful settles the shape. On the
/// Windows capture this is reached around the fortieth access unit, against
/// the hundred and fiftieth under the old count.
const MIN_AUX_INTER_TO_DECIDE: u64 = 3;

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
    /// `(memory_management_control_operation, its principal argument)`, in
    /// order. For op 6 — mark the current picture long-term — the argument is
    /// the `long_term_frame_idx` assigned, which is what a later slice names
    /// with a `modification_of_pic_nums_idc` of 2.
    mmco: Vec<(u32, u32)>,
    /// `num_ref_idx_l0_active_minus1 + 1`, the number of list-0 entries a
    /// macroblock in this slice may index.
    ///
    /// It decides whether the default reference list ordering is safe. A P
    /// slice's default list is the short-term pictures by descending PicNum
    /// followed by the long-term ones ascending, so an auxiliary picture that
    /// marked itself long-term sits *after* every short-term picture — out of
    /// reach entirely when only one entry is active, and addressable from
    /// index 1 upwards when more are.
    num_ref_idx_l0_active: u32,
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
    /// Payload bytes seen for this access unit, across all of its blobs.
    bytes: usize,
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
    bytes: u64,
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
    /// Reference list modifications and marking operations, kept per view:
    /// what makes the two views separable is that each names its own
    /// long-term picture and never the other's.
    list_mods_by_view: [BTreeMap<(u32, u32), u64>; 3],
    mmco_by_view: [BTreeMap<(u32, u32), u64>; 3],
    /// Active list-0 entries per view, over the inter slices that have one.
    num_ref_idx_by_view: [BTreeMap<u32, u64>; 3],
    /// Inter slices per view that marked themselves a long-term reference.
    long_term_marked: [u64; 3],
    /// Main slices naming a long-term picture while the most recent IDR was an
    /// auxiliary view.
    ///
    /// Auxiliary views arriving with no paired main view ahead of them — an
    /// MS-RDPEGFX LC=2 command, whose only bitstream is chroma.
    ///
    list_mods: BTreeMap<(u32, u32), u64>,
    mmco: BTreeMap<u32, u64>,
    parse_failures: u64,
    gaps_allowed: Option<bool>,
    max_num_ref_frames: Option<u32>,
    pic_order_cnt_type: Option<u32>,
}

/// Reads the reference structure of a passthrough stream, once enabled.
pub struct NalProbe {
    pending: HashMap<u32, Pending>,
    sps: HashMap<u32, Sps>,
    pps: HashMap<u32, Pps>,
    stats: Stats,
    last_main_frame_num: Option<u32>,
}

impl NalProbe {
    /// A probe for one stream. It reports nothing on its own; the one thing it
    /// says out loud is `verdict`, which `crate::h264_aux_drop` logs once when
    /// it decides.
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
            sps: HashMap::new(),
            pps: HashMap::new(),
            stats: Stats::default(),
            last_main_frame_num: None,
        }
    }

    /// Whether this stream's auxiliary views can be dropped, as far as has
    /// been seen.
    ///
    /// `eager` decides how much corroboration is required before answering
    /// anything but `Undecided`. It does not relax the verdict itself: an
    /// eager assessment asks the same questions of less evidence, and a stream
    /// that fails any of them is refused either way.
    pub fn safety(&self, eager: bool) -> Safety {
        self.stats.safety(eager)
    }

    /// The prose behind `safety`, for logging the decision once.
    pub fn verdict(&self) -> String {
        self.stats.verdict()
    }

    /// What the gate is still waiting for, or `None` if it has what it needs.
    ///
    /// "It seems slow to start dropping" is not a number, and the gate is
    /// otherwise silent until it decides -- so a session that never decides
    /// leaves nothing at all to read. This says which condition is short, with
    /// the counts, so the answer is a measurement rather than a theory about
    /// thresholds.
    pub fn undecided_reason(&self, eager: bool) -> Option<String> {
        if self.stats.safety(eager) != Safety::Undecided {
            return None;
        }
        Some(self.stats.why_undecided(eager))
    }

    /// Reads one chunk of the guacd → browser stream. The chunk always ends on
    /// an instruction boundary (see `guacd_to_ws`), so every instruction start
    /// in it is a real one.
    pub fn observe(&mut self, text: &str) {
        for instr in crate::frame_stats::instruction_starts(text) {
            if let Some(rest) = instr.strip_prefix("4.h264,") {
                self.open(rest);
            } else if let Some(rest) = instr.strip_prefix("4.blob,") {
                self.blob(rest);
            } else if let Some(rest) = instr.strip_prefix("3.end,") {
                self.end(rest);
            }
        }
    }

    /// `h264,<stream>,<layer>,<keyframe>,<x>,<y>,<w>,<h>,<view>,<numrects>,
    /// [<x> <y> <w> <h>]...,<paired>`
    fn open(&mut self, rest: &str) {
        let mut args = crate::frame_stats::elements(rest);
        let Some(index) = args.next().and_then(|v| v.parse::<u32>().ok()) else {
            return;
        };
        args.nth(1); // keyframe, which only the dropper acts on
                     // Past x, y, width and height to the view.
        let view = args
            .nth(4)
            .and_then(|v| v.parse::<u8>().ok())
            .unwrap_or(0)
            .min(2);

        if self.pending.len() >= MAX_PENDING_STREAMS {
            // Streams that never ended. Nothing here is worth recovering, and
            // the alternative is unbounded growth on a long session.
            self.pending.clear();
        }

        self.pending.insert(
            index,
            Pending {
                view,
                bytes: 0,
                buf: Vec::new(),
                done: false,
            },
        );
    }

    /// `blob,<stream>,<base64>`
    fn blob(&mut self, rest: &str) {
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

            // Bytes are counted for every blob, including those of an access
            // unit whose header has already been read: the size of each view
            // is the bandwidth question, and it is the reason for all of this.
            // Counted from the base64 length rather than by decoding, so a
            // picture costs one decode however many blobs it takes.
            pending.bytes += payload.len() / 4 * 3;

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
            self.analyse(index);
        }
    }

    /// `end,<stream>` — the access unit is complete, so a short one that never
    /// reached the buffering threshold is read now.
    fn end(&mut self, rest: &str) {
        let Some(index) = crate::frame_stats::elements(rest)
            .next()
            .and_then(|v| v.parse::<u32>().ok())
        else {
            return;
        };

        if self.pending.get(&index).is_some_and(|p| !p.done) {
            self.analyse(index);
        }
        // Credited here rather than in analyse: the access unit's size is not
        // known until its last blob has arrived, which is usually after its
        // header has been read.
        if let Some(pending) = self.pending.remove(&index) {
            self.stats.views[pending.view as usize].bytes += pending.bytes as u64;
        }
    }

    /// Reads the parameter sets and first slice header out of what has been
    /// buffered for one stream, and folds the result into the statistics.
    fn analyse(&mut self, index: u32) {
        let Some(pending) = self.pending.get_mut(&index) else {
            return;
        };
        pending.done = true;
        let view = pending.view;
        let buf = std::mem::take(&mut pending.buf);

        let mut slice = None;
        for (header, payload) in nal_units(&buf) {
            let nal_ref_idc = (header >> 5) & 3;
            match header & 0x1f {
                7 => {
                    if let Some((id, sps)) = parse_sps(payload) {
                        self.stats.gaps_allowed = Some(sps.gaps_allowed);
                        self.stats.max_num_ref_frames = Some(sps.max_num_ref_frames);
                        self.stats.pic_order_cnt_type = Some(sps.pic_order_cnt_type);
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
        } else {
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
            *self.stats.list_mods_by_view[view as usize]
                .entry(op)
                .or_default() += 1;
        }
        if slice.base_type() != 2 && slice.base_type() != 4 {
            *self.stats.num_ref_idx_by_view[view as usize]
                .entry(slice.num_ref_idx_l0_active)
                .or_default() += 1;
        }
        if slice.mmco.iter().any(|(op, _)| *op == 6) {
            self.stats.long_term_marked[view as usize] += 1;
        }
        for &op in &slice.mmco {
            *self.stats.mmco.entry(op.0).or_default() += 1;
            *self.stats.mmco_by_view[view as usize]
                .entry(op)
                .or_default() += 1;
        }
    }
}

/// Which way a verdict went, without its prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerdictKind {
    NoAux,
    Droppable,
    NoDpbRoom,
    Unproven,
    NotDroppable,
    Contradictory,
}

/// Whether this stream's auxiliary views can be dropped on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Safety {
    /// Not enough seen yet, or no auxiliary view has arrived.
    Undecided,
    /// Nothing surviving a drop predicts from a dropped picture.
    Safe,
    /// Nothing *demonstrably* does, but the slice headers cannot rule it out:
    /// the auxiliary picture sits in a reference list past the index the
    /// encoder is known to use, and whether a macroblock reaches it is in the
    /// slice data. The xrdp fork's shape.
    ///
    /// Kept apart from `Unsafe` because the two need different answers. This
    /// one is settled by proving the negative -- replaying a recording with
    /// the auxiliary views stripped and comparing the decode -- or by lowering
    /// the encoder's active reference count. `Unsafe` is settled by not doing
    /// it.
    Unproven,
    /// Something does, and the headers say so.
    Unsafe,
}

impl Stats {
    /// The structured form of `verdict`, for the dropper to gate on.
    ///
    /// Deliberately the same conditions, and `verdicts_and_safety_agree`
    /// pins that: a gate that drifted from the explanation beside it would
    /// be the worst of both.
    fn safety(&self, eager: bool) -> Safety {
        let aux: u64 = self.views[1].total + self.views[2].total;
        let main_inter = self.views[0].total - self.views[0].idr;
        let aux_inter: u64 = (1..3)
            .map(|v| self.views[v].total - self.views[v].idr)
            .sum();

        // The evidence the verdict reads lives in inter slices: an IDR names
        // no reference and marks nothing, so a connect-time keyframe burst
        // says nothing whatever its length. One of each view is the minimum
        // that can show the two chains are disjoint; the larger figures are
        // corroboration.
        //
        // There is deliberately no floor on the access unit count. Requiring
        // main inter slices is already a stronger guard against deciding from
        // the burst, since those exclude IDRs by construction, and a count of
        // pictures is a bad proxy for elapsed evidence: a quiet desktop sends
        // few of them, so a floor that costs a moment on a busy session costs
        // tens of seconds on an idle one.
        let (min_main, min_aux) = if eager {
            (1, 1)
        } else {
            (MIN_MAIN_INTER_TO_DECIDE, MIN_AUX_INTER_TO_DECIDE)
        };

        if aux == 0 || main_inter < min_main || aux_inter < min_aux {
            return Safety::Undecided;
        }

        // An auxiliary view that has not yet named a reference has told us
        // nothing, and an empty set is disjoint from everything -- so without
        // this, `chains_are_separate` could be satisfied by never having seen
        // what the auxiliary view points at. A non-IDR *I* slice counts toward
        // `aux_inter` and carries no reference information whatever, which is
        // how that would happen in practice.
        //
        // Only when main names its own reference explicitly: where nothing
        // reorders at all, the verdict reasons about the default list order
        // instead and the counts above are the whole of the evidence.
        let main_names_its_own = !self.list_mods_by_view[0].is_empty();
        let aux_has_claimed = self.mmco_by_view[1..]
            .iter()
            .any(|ops| ops.keys().any(|(op, _)| *op == 6 || *op == 3));
        if main_names_its_own && !aux_has_claimed {
            return Safety::Undecided;
        }
        match self.verdict_kind() {
            VerdictKind::Droppable => Safety::Safe,
            VerdictKind::Unproven => Safety::Unproven,
            _ => Safety::Unsafe,
        }
    }

    /// Which of `safety`'s preconditions is not yet met, with the counts.
    fn why_undecided(&self, eager: bool) -> String {
        let aux: u64 = self.views[1].total + self.views[2].total;
        if aux == 0 {
            return format!(
                "no auxiliary view has arrived in {} pictures — an AVC420 \
                 stream, or a host that has not sent chroma yet",
                self.aus
            );
        }

        let main_inter = self.views[0].total - self.views[0].idr;
        let aux_inter: u64 = (1..3)
            .map(|v| self.views[v].total - self.views[v].idr)
            .sum();
        let (min_main, min_aux) = if eager {
            (1, 1)
        } else {
            (MIN_MAIN_INTER_TO_DECIDE, MIN_AUX_INTER_TO_DECIDE)
        };

        let mut missing = Vec::new();
        if main_inter < min_main {
            missing.push(format!("{} of {} main inter slices", main_inter, min_main));
        }
        if aux_inter < min_aux {
            missing.push(format!(
                "{} of {} auxiliary inter slices",
                aux_inter, min_aux
            ));
        }
        if !self.list_mods_by_view[0].is_empty()
            && !self.list_mods_by_view[1..]
                .iter()
                .any(|ops| ops.keys().any(|(idc, _)| *idc == 2))
        {
            missing.push(
                "the auxiliary view has not yet named a long-term reference, \
                 so there is nothing to compare main's against"
                    .into(),
            );
        }

        format!(
            "waiting on {} after {} pictures ({} main, {} auxiliary){}",
            if missing.is_empty() {
                "nothing — this should have decided, which is a bug".to_string()
            } else {
                missing.join(" and ")
            },
            self.aus,
            self.views[0].total,
            aux,
            if eager {
                ""
            } else {
                ". The entry's chroma-drop setting lowers the slice counts to one each"
            }
        )
    }

    /// The verdict as a kind alone, for gating.
    fn verdict_kind(&self) -> VerdictKind {
        self.verdict_full().0
    }

    /// The verdict as prose, for the journal.
    fn verdict(&self) -> String {
        self.verdict_full().1
    }

    /// One decision, two renderings. Split so that the gate the dropper reads
    /// and the sentence a human reads can never disagree.
    fn verdict_full(&self) -> (VerdictKind, String) {
        let aux: u64 = self.views[1].total + self.views[2].total;
        if aux == 0 {
            return (
                VerdictKind::NoAux,
                "no auxiliary views seen — this is an AVC420 stream, or the \
                 host has not sent chroma yet"
                    .into(),
            );
        }

        let aux_reference = self.views[1].reference + self.views[2].reference;
        // A main view following a non-reference auxiliary view is one
        // frame_num further on, not two.
        let main_advances_by_one = self.main_deltas.keys().all(|&delta| delta <= 1);

        if aux_reference == 0 {
            if !main_advances_by_one {
                return (
                    VerdictKind::Contradictory,
                    format!(
                        "CONTRADICTORY — every auxiliary view is non-reference, yet \
                     frame_num advances by more than one between main views \
                     ({}). One of the two readings is wrong; suspect this \
                     parser before the stream",
                        self.main_deltas
                            .iter()
                            .map(|(delta, count)| format!("{} x{}", delta, count))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                );
            }
            return (
                VerdictKind::Droppable,
                "DROPPABLE — every auxiliary view is a non-reference picture \
                    and consumes no frame_num, so no surviving slice can refer \
                    to one. Dropping the view!=0 instructions and clearing the \
                    trailing <paired> flag on their main views would leave a \
                    valid 4:2:0 stream"
                    .into(),
            );
        }

        // The auxiliary views are reference pictures, so the question becomes
        // whether anything that survives actually refers to one.
        //
        // `modification_of_pic_nums_idc` decides it, and its three values are
        // not alike. 0 and 1 carry `abs_diff_pic_num_minus1`, a *relative* step
        // through short-term PicNums: those shift when a picture is removed, so
        // a main slice reaching back past an auxiliary picture by a count would
        // land somewhere else once it was gone. 2 carries `long_term_pic_num`,
        // an absolute index the encoder assigned with `mmco` 6 — unaffected by
        // anything dropped, and the ordinary way to multiplex two independent
        // reference chains into one sequence.
        let short_term: u64 = self.list_mods_by_view[0]
            .iter()
            .filter(|((idc, _), _)| *idc < 2)
            .map(|(_, count)| count)
            .sum();

        let main_long_term: std::collections::BTreeSet<u32> = self.list_mods_by_view[0]
            .keys()
            .filter(|(idc, _)| *idc == 2)
            .map(|(_, value)| *value)
            .collect();
        let aux_long_term: std::collections::BTreeSet<u32> = self.list_mods_by_view[1]
            .keys()
            .chain(self.list_mods_by_view[2].keys())
            .filter(|(idc, _)| *idc == 2)
            .map(|(_, value)| *value)
            .collect();
        // What an auxiliary view *claims*, not just what it reads. Reading a
        // different index from main is not enough: a dropped picture that
        // marked itself with an index main reads would take that index's
        // contents with it. `mmco` 6 assigns one to the current picture and 3
        // assigns one to a short-term picture; both are a claim.
        let aux_marks: std::collections::BTreeSet<u32> = self.mmco_by_view[1..]
            .iter()
            .flat_map(|ops| ops.keys())
            .filter(|(op, _)| *op == 6 || *op == 3)
            .map(|(_, idx)| *idx)
            .collect();

        // Only what an auxiliary view *claims* can matter. Dropping removes
        // the picture, so whatever it read never happens: an auxiliary slice
        // naming main's long-term index is a consumer of main's picture, and
        // removing a consumer is always safe. What would not be safe is main
        // reading an index a dropped picture produced, which is `aux_marks`.
        //
        // Windows does exactly this after a surface recreation. The first
        // auxiliary picture following an IDR has no chain of its own yet, so it
        // names long-term 0 -- main's -- because that is the only long-term
        // picture in the buffer. Testing what it reads condemned the stream
        // 110s into a session on 2026-09-14, at the same moment
        // `h264_black_keyframe_kept` fired: one event, two symptoms.
        let chains_are_separate =
            !main_long_term.is_empty() && main_long_term.is_disjoint(&aux_marks) && short_term == 0;

        // Separate chains are necessary and not sufficient: the decoded
        // picture buffer has to have somewhere to put the pictures a gap
        // makes it invent.
        if chains_are_separate {
            if let Some(reason) = self.no_room_for_inferred_frames() {
                return (VerdictKind::NoDpbRoom, reason);
            }
        }

        if !chains_are_separate {
            let mut reasons = vec![format!(
                "{} of {} auxiliary views are reference pictures",
                aux_reference, aux
            )];
            if short_term > 0 {
                reasons.push(format!(
                    "{} main slices reorder by a relative short-term PicNum \
                     (idc 0/1), which counts backwards through the auxiliary \
                     pictures and would address something else once they were \
                     gone",
                    short_term
                ));
            }
            if !main_long_term.is_disjoint(&aux_marks) {
                reasons.push(format!(
                    "the auxiliary view claims long-term {:?}, which main \
                     reads -- dropping such a picture would take that index's \
                     contents with it",
                    main_long_term.intersection(&aux_marks).collect::<Vec<_>>()
                ));
            }
            if main_long_term.is_empty() && short_term == 0 {
                // No reordering anywhere: main takes the default list. Whether
                // that is safe depends on where the auxiliary pictures sit in
                // it, and marking them long-term is what moves them out of the
                // way -- a P slice's default list is the short-term pictures by
                // descending PicNum first, so an auxiliary picture left
                // short-term would be the most recent of them and land at
                // index 0, while one marked long-term sits after every
                // short-term picture.
                let aux_inter: u64 = (1..3)
                    .map(|v| self.views[v].total - self.views[v].idr)
                    .sum();
                let aux_long_term_marked: u64 = self.long_term_marked[1] + self.long_term_marked[2];
                let main_active_entries: u64 = self.num_ref_idx_by_view[0]
                    .keys()
                    .copied()
                    .max()
                    .unwrap_or(1) as u64;

                if aux_long_term_marked < aux_inter {
                    reasons.push(format!(
                        "main slices take the default reference list and only \
                         {} of {} auxiliary pictures mark themselves long-term, \
                         so an auxiliary picture is the most recent short-term \
                         reference and lands at index 0 of it",
                        aux_long_term_marked, aux_inter
                    ));
                } else if main_active_entries > 1 {
                    return (
                        VerdictKind::Unproven,
                        format!(
                            "UNPROVEN — every auxiliary picture marks itself \
                         long-term (mmco 6), which moves it behind every \
                         short-term picture in the default reference list main \
                         slices use, so index 0 is the previous main view. But \
                         main slices activate up to {} list-0 entries, and from \
                         index 1 that list reaches the auxiliary pictures. \
                         Whether any macroblock actually picks one is below the \
                         slice header and cannot be read here. Settle it with \
                         tests/aux-drop-replay.mjs against a recording, or by \
                         lowering the encoder's num_ref_idx_l0_active_minus1 \
                         where the encoder is yours; \
                         RUSTGUAC_H264_AUX_DROP=force drops anyway",
                            main_active_entries
                        ),
                    );
                } else {
                    return (
                        VerdictKind::Droppable,
                        format!(
                            "DROPPABLE, with one caveat — no slice reorders its \
                         reference list, but every auxiliary picture marks \
                         itself long-term (mmco 6), which places it after every \
                         short-term picture in the default list. Main slices \
                         activate one list-0 entry, which is therefore always \
                         the previous main view, so nothing surviving predicts \
                         from an auxiliary picture. {}",
                            self.frame_num_caveat(main_advances_by_one)
                        ),
                    );
                }
            }
            return (
                VerdictKind::NotDroppable,
                format!(
                    "NOT DROPPABLE as-is — {}. Shedding the auxiliary view \
                 downstream would need the surviving slice headers rewritten, \
                 not merely filtered",
                    reasons.join("; ")
                ),
            );
        }

        // Separate chains. The only thing left is frame_num continuity, since
        // dropping a reference picture leaves a hole where one was expected.

        (
            VerdictKind::Droppable,
            format!(
                "DROPPABLE, with one caveat — the two views run on separate \
             long-term reference chains: main names long-term {:?} and the \
             auxiliary views name {:?}, assigned by mmco 6, with no relative \
             short-term reordering anywhere. So nothing surviving predicts \
             from a dropped picture. {}",
                main_long_term,
                aux_long_term,
                self.frame_num_caveat(main_advances_by_one)
            ),
        )
    }

    /// Whether this stream's decoded picture buffer can hold the frames a
    /// `frame_num` gap obliges a decoder to invent, or `None` if it can.
    ///
    /// Dropping a picture leaves a hole in `frame_num`, and 8.2.5.2 requires a
    /// decoder to fill each one with an inferred *non-existing* frame, marked
    /// **short-term**, running the sliding window as it goes. The sliding
    /// window (8.2.5.3) can only evict short-term pictures. So a stream whose
    /// `max_num_ref_frames` is entirely consumed by long-term references has
    /// nowhere to put one, and the decoder fails rather than degrading.
    ///
    /// Measured 2026-09-12 on the dual-LTR xrdp fork: `max_num_ref_frames` 2,
    /// with long-term 0 held by main and 1 by the auxiliary view. Dropping
    /// began at 21:14:34.654 and Chrome reported a decode error 212ms later,
    /// then held every frame waiting for a keyframe that an idle desktop never
    /// sends -- a permanent freeze. Windows survives the same treatment
    /// because its `max_num_ref_frames` is 3: two long-term and one to spare.
    ///
    /// This is why the separate-chains test was necessary and not sufficient.
    /// It asked whether anything *refers* to a dropped picture, which was the
    /// right question and not the only one; the decoder also has to be able to
    /// account for the ones that are missing.
    fn no_room_for_inferred_frames(&self) -> Option<String> {
        // No gaps, nothing to infer.
        if self.main_deltas.keys().all(|&delta| delta <= 1) {
            return None;
        }

        let long_term: std::collections::BTreeSet<u32> = self
            .list_mods_by_view
            .iter()
            .flat_map(|ops| ops.keys())
            .filter(|(idc, _)| *idc == 2)
            .map(|(_, value)| *value)
            .collect();

        let capacity = self.max_num_ref_frames?;
        if capacity as usize > long_term.len() {
            return None;
        }

        Some(format!(
            "NO ROOM IN THE DECODED PICTURE BUFFER — the reference chains are \
             separate, but max_num_ref_frames is {} and long-term indices {:?} \
             already account for all of it. Dropping a picture leaves a gap in \
             frame_num, and a decoder must fill each gap with an inferred \
             non-existing frame held as a *short-term* reference (8.2.5.2); \
             the sliding window can only evict short-term pictures, so there \
             is nowhere to put one and the decoder fails rather than \
             degrading. Raising the encoder's max_num_ref_frames by one, or \
             renumbering frame_num so no gap is left, is what makes this \
             stream droppable",
            capacity, long_term
        ))
    }

    /// What dropping does to `frame_num`, which is the same question however
    /// the reference chains are arranged.
    fn frame_num_caveat(&self, main_advances_by_one: bool) -> String {
        if main_advances_by_one {
            return "frame_num stays continuous, so there is no caveat at all".into();
        }
        if self.gaps_allowed == Some(true) {
            return "frame_num gaps would open where the auxiliary views were, \
                    and gaps_in_frame_num_value_allowed_flag is 1, so a decoder \
                    is required to tolerate them"
                .into();
        }
        "frame_num gaps would open where the auxiliary views were, and \
         gaps_in_frame_num_value_allowed_flag is 0 — so the result is not a \
         conforming stream, though the flag is one bit in the SPS and \
         h264_rewrite already edits that structure"
            .into()
    }
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
    if nal_ref_idc != 0 {
        if idr {
            r.bit()?; // no_output_of_prior_pics_flag
            r.bit()?; // long_term_reference_flag
        } else if r.bit()? == 1 {
            // adaptive_ref_pic_marking_mode_flag
            loop {
                let op = r.ue()?;
                if op == 0 {
                    break;
                }
                let mut arg = 0;
                if op == 1 || op == 3 {
                    arg = r.ue()?; // difference_of_pic_nums_minus1
                }
                if op == 2 {
                    arg = r.ue()?; // long_term_pic_num
                }
                if op == 3 || op == 6 {
                    arg = r.ue()?; // long_term_frame_idx
                }
                if op == 4 {
                    arg = r.ue()?; // max_long_term_frame_idx_plus1
                }
                mmco.push((op, arg));
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
        num_ref_idx_l0_active: num_ref_idx_l0 + 1,
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
    /// units, alternating the views as an AVC444 host does, with `num_rects`
    /// region rects between `<view>` and the trailing `<paired>` flag.
    ///
    /// The fixture's pictures are ordinary AVC420, so the *content* of any
    /// verdict means nothing here; what this exercises is everything between
    /// the wire and the parser — the element offsets, the blob reassembly, and
    /// the access unit that is only read at `end` because it never reached the
    /// buffering threshold.
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

    /// Builds the statistics a Windows AVC444 capture produces, so the
    /// verdict can be exercised without a host.
    fn windows_shaped_stats() -> Stats {
        let mut stats = Stats {
            gaps_allowed: Some(false),
            ..Default::default()
        };
        stats.views[0].total = 139;
        stats.views[0].reference = 139;
        stats.views[2].total = 61;
        stats.views[2].reference = 61;
        // Main names long-term picture 0, the auxiliary views name 1, each
        // assigned by mmco 6. Measured 2026-09-12 against a Windows host.
        stats.list_mods_by_view[0].insert((2, 0), 136);
        stats.list_mods_by_view[2].insert((2, 1), 58);
        stats.mmco_by_view[0].insert((6, 0), 136);
        stats.mmco_by_view[2].insert((6, 1), 58);
        stats.main_deltas.insert(1, 79);
        stats.main_deltas.insert(2, 53);
        stats
    }

    /// Reference pictures alone do not make an auxiliary view undroppable:
    /// what matters is whether anything surviving names one.
    ///
    /// This is the case the first verdict got wrong. It read any reordering as
    /// dangerous, when `modification_of_pic_nums_idc` 2 is an absolute
    /// long-term index rather than a relative walk through short-term PicNums,
    /// and two disjoint long-term indices are how an encoder keeps two views
    /// on separate reference chains inside one sequence.
    #[test]
    fn separate_long_term_chains_are_droppable() {
        let verdict = windows_shaped_stats().verdict();
        assert!(verdict.starts_with("DROPPABLE"), "{}", verdict);
        assert!(verdict.contains("frame_num gaps"), "{}", verdict);
        assert!(
            verdict.contains("gaps_in_frame_num_value_allowed_flag is 0"),
            "{}",
            verdict
        );
    }

    /// A relative short-term reordering is the dangerous kind, because the
    /// PicNums it counts through shift when a picture is removed.
    #[test]
    fn relative_short_term_reordering_is_not_droppable() {
        let mut stats = windows_shaped_stats();
        stats.list_mods_by_view[0].insert((0, 1), 136);

        let verdict = stats.verdict();
        assert!(verdict.starts_with("NOT DROPPABLE"), "{}", verdict);
        assert!(verdict.contains("short-term PicNum"), "{}", verdict);
    }

    /// An auxiliary view *reading* main's long-term index is fine.
    ///
    /// Dropping removes the auxiliary picture, so whatever it read never
    /// happens -- it is a consumer of main's picture, and removing a consumer
    /// changes nothing for what survives.
    ///
    /// This is not hypothetical. After a surface recreation Windows sends an
    /// IDR, and the first auxiliary picture following it has no chain of its
    /// own yet, so it names long-term 0 because that is the only long-term
    /// picture in the buffer. Testing what an auxiliary view reads condemned a
    /// live stream 110s in, at the same moment the black-keyframe guard fired
    /// on the same surface recreation.
    #[test]
    fn an_auxiliary_view_reading_mains_index_is_still_droppable() {
        let mut stats = windows_shaped_stats();
        stats.list_mods_by_view[2].insert((2, 0), 1);

        assert_eq!(stats.safety(false), Safety::Safe, "{}", stats.verdict());
    }

    /// Main slices taking the default list order are the trap the long-term
    /// scheme avoids: the default puts the most recently decoded reference
    /// first, which in an interleaved stream is the auxiliary view.
    #[test]
    fn the_default_reference_list_is_not_droppable() {
        let mut stats = windows_shaped_stats();
        stats.list_mods_by_view[0].clear();

        let verdict = stats.verdict();
        assert!(verdict.starts_with("NOT DROPPABLE"), "{}", verdict);
        assert!(verdict.contains("default reference list"), "{}", verdict);
    }

    /// The dual-LTR xrdp fork, as measured on 2026-09-12: separate chains,
    /// explicitly named, and a decoded picture buffer with no room to spare.
    fn xrdp_dual_ltr_stats() -> Stats {
        let mut stats = Stats {
            gaps_allowed: Some(false),
            max_num_ref_frames: Some(2),
            ..Default::default()
        };
        stats.views[0].total = 152;
        stats.views[0].reference = 152;
        stats.views[0].idr = 13;
        stats.views[2].total = 48;
        stats.views[2].reference = 48;
        stats.list_mods_by_view[0].insert((2, 0), 139);
        stats.list_mods_by_view[2].insert((2, 1), 35);
        stats.mmco_by_view[0].insert((6, 0), 139);
        stats.mmco_by_view[2].insert((6, 1), 48);
        stats.long_term_marked[0] = 139;
        stats.long_term_marked[2] = 48;
        stats.num_ref_idx_by_view[0].insert(1, 139);
        stats.num_ref_idx_by_view[2].insert(1, 35);
        stats.main_deltas.insert(0, 12);
        stats.main_deltas.insert(1, 103);
        stats.main_deltas.insert(2, 36);
        stats.aus = 200;
        stats
    }

    /// Separate reference chains are necessary and not sufficient.
    ///
    /// This is the case that froze a session. The chains are disjoint and
    /// explicitly named -- the gate said DROPPABLE and it was right about
    /// that -- but max_num_ref_frames is 2 and both slots are long-term, so
    /// the frames a frame_num gap obliges the decoder to invent have nowhere
    /// to go. Chrome errored 212ms after the first drop and then held every
    /// frame waiting for a keyframe that never came.
    #[test]
    fn a_full_decoded_picture_buffer_is_not_droppable() {
        let stats = xrdp_dual_ltr_stats();
        let verdict = stats.verdict();

        assert_eq!(stats.safety(false), Safety::Unsafe, "{}", verdict);
        assert!(verdict.starts_with("NO ROOM"), "{}", verdict);
        assert!(verdict.contains("max_num_ref_frames is 2"), "{}", verdict);
    }

    /// One spare slot is all it takes, which is what Windows has.
    #[test]
    fn one_spare_reference_slot_is_enough() {
        let mut stats = xrdp_dual_ltr_stats();
        stats.max_num_ref_frames = Some(3);

        let verdict = stats.verdict();
        assert_eq!(stats.safety(false), Safety::Safe, "{}", verdict);
        assert!(verdict.starts_with("DROPPABLE"), "{}", verdict);
    }

    /// And a stream that leaves no gap needs no room: the check is about the
    /// frames a gap invents, so no gaps means nothing to account for.
    #[test]
    fn no_gaps_means_no_room_needed() {
        let mut stats = xrdp_dual_ltr_stats();
        stats.main_deltas.clear();
        stats.main_deltas.insert(1, 139);

        assert_eq!(stats.safety(false), Safety::Safe, "{}", stats.verdict());
    }

    /// The statistics an xrdp-fork capture produces: no reordering anywhere,
    /// and every auxiliary picture marking itself long-term.
    fn xrdp_shaped_stats() -> Stats {
        let mut stats = Stats {
            gaps_allowed: Some(false),
            ..Default::default()
        };
        stats.views[0].total = 152;
        stats.views[0].reference = 152;
        stats.views[0].idr = 14;
        stats.views[2].total = 48;
        stats.views[2].reference = 48;
        stats.mmco_by_view[2].insert((4, 1), 48);
        stats.mmco_by_view[2].insert((6, 0), 48);
        stats.long_term_marked[2] = 48;
        stats.num_ref_idx_by_view[0].insert(1, 138);
        stats.num_ref_idx_by_view[2].insert(1, 48);
        stats.main_deltas.insert(0, 13);
        stats.main_deltas.insert(1, 103);
        stats.main_deltas.insert(2, 35);
        stats
    }

    /// The default reference list is safe when the auxiliary pictures have
    /// moved themselves out of it and only one entry is active.
    ///
    /// A P slice's default list is the short-term pictures by descending
    /// PicNum and then the long-term ones, so `mmco` 6 on every auxiliary
    /// picture puts the previous main view at index 0.
    #[test]
    fn a_long_term_aux_behind_one_active_entry_is_droppable() {
        let verdict = xrdp_shaped_stats().verdict();
        assert!(verdict.starts_with("DROPPABLE"), "{}", verdict);
        assert!(verdict.contains("one list-0 entry"), "{}", verdict);
    }

    /// With more entries active the same list reaches the auxiliary pictures,
    /// and whether a macroblock picks one is below the slice header.
    #[test]
    fn more_active_entries_leaves_the_default_list_unproven() {
        let mut stats = xrdp_shaped_stats();
        stats.num_ref_idx_by_view[0].insert(2, 138);

        let verdict = stats.verdict();
        assert!(verdict.starts_with("UNPROVEN"), "{}", verdict);
        assert!(verdict.contains("from index 1"), "{}", verdict);
    }

    /// An auxiliary picture left short-term is the most recent short-term
    /// reference, so the default list puts it at index 0 and main predicts
    /// straight from chroma.
    #[test]
    fn a_short_term_aux_on_the_default_list_is_not_droppable() {
        let mut stats = xrdp_shaped_stats();
        stats.long_term_marked[2] = 0;
        stats.mmco_by_view[2].clear();

        let verdict = stats.verdict();
        assert!(verdict.starts_with("NOT DROPPABLE"), "{}", verdict);
        assert!(verdict.contains("index 0"), "{}", verdict);
    }

    /// Separate chains are not enough on their own: a dropped picture must
    /// also never *claim* an index main reads.
    ///
    /// Reading a different long-term index is not sufficient. An auxiliary
    /// view that marked itself with the index main reads would take that
    /// index's contents with it when dropped, and the reference lists alone
    /// do not show that -- the marking operations do.
    #[test]
    fn an_auxiliary_view_claiming_mains_index_is_not_droppable() {
        let mut stats = windows_shaped_stats();
        stats.mmco_by_view[2].insert((6, 0), 12);

        let verdict = stats.verdict();
        assert_eq!(stats.safety(false), Safety::Unsafe, "{}", verdict);
        assert!(verdict.contains("claims long-term"), "{}", verdict);
    }

    /// Claiming an index main never reads is exactly what both hosts do, and
    /// is fine.
    #[test]
    fn an_auxiliary_view_claiming_its_own_index_is_droppable() {
        let mut stats = windows_shaped_stats();
        stats.mmco_by_view[2].insert((6, 1), 12);

        assert_eq!(stats.safety(false), Safety::Safe, "{}", stats.verdict());
    }

    /// The view is read from the right element, whatever the rect count.
    ///
    /// It sits at index 7 of the instruction and the rects follow the count at
    /// index 8, so an off-by-one here reads a coordinate as a view and the
    /// gate then reasons about the wrong pictures. The dropper guards the
    /// trailing `<paired>` flag separately, since that is the one it acts on.
    #[test]
    fn the_view_is_read_past_the_fixed_arguments() {
        for rects in [0, 1, 9] {
            let mut probe = NalProbe::new();
            probe.observe(&instruction_stream_with(&[0, 2, 0, 2], rects));

            assert_eq!(probe.stats.views[0].total, 2, "{} rects", rects);
            assert_eq!(probe.stats.views[2].total, 2, "{} rects", rects);
            assert_eq!(probe.stats.parse_failures, 0, "{} rects", rects);
        }
    }

    /// An AVC420 stream never reaches a verdict, however much of it goes by.
    ///
    /// Real x264 pictures, all main view, at both corroboration levels: with
    /// no auxiliary view there is nothing the question is even about, so the
    /// answer is `Undecided` rather than safe or unsafe.
    #[test]
    fn an_avc420_stream_never_decides() {
        let mut probe = NalProbe::new();
        probe.observe(&instruction_stream_with(&[0; 16], 2));

        assert!(probe.stats.views[0].total > 0, "pictures were read");
        assert_eq!(probe.stats.views[1].total + probe.stats.views[2].total, 0);

        for eager in [false, true] {
            assert_eq!(
                probe.safety(eager),
                Safety::Undecided,
                "eager={}: {}",
                eager,
                probe.verdict()
            );
        }
        assert!(probe.verdict().starts_with("no auxiliary views seen"));
    }

    /// The gate and the sentence beside it come from one decision.
    ///
    /// They are read by different audiences -- one decides whether to drop
    /// bytes, the other explains it in the journal -- and a disagreement
    /// between them would be invisible until someone compared a log line with
    /// what the session actually did.
    #[test]
    fn verdicts_and_safety_agree() {
        let cases: [(Stats, Safety); 5] = [
            (windows_shaped_stats(), Safety::Safe),
            (xrdp_shaped_stats(), Safety::Safe),
            (
                {
                    let mut s = xrdp_shaped_stats();
                    s.num_ref_idx_by_view[0].insert(2, 138);
                    s
                },
                // Unproven, not Unsafe: the headers cannot rule the reference
                // out, which is a different answer from ruling it in.
                Safety::Unproven,
            ),
            (
                {
                    let mut s = windows_shaped_stats();
                    s.mmco_by_view[2].insert((6, 0), 12);
                    s
                },
                Safety::Unsafe,
            ),
            (
                {
                    let mut s = windows_shaped_stats();
                    s.list_mods_by_view[0].insert((0, 1), 136);
                    s
                },
                Safety::Unsafe,
            ),
        ];

        for (stats, expected) in cases {
            let verdict = stats.verdict();
            assert_eq!(stats.safety(false), expected, "for: {}", verdict);
            assert_eq!(
                stats.safety(true),
                expected,
                "an eager assessment asks the same questions: {}",
                verdict
            );
            assert_eq!(
                verdict.starts_with("DROPPABLE") && !verdict.starts_with("DROPPABLE IN STEADY"),
                expected == Safety::Safe,
                "the prose and the gate disagree: {}",
                verdict
            );
        }
    }

    /// Nothing is decided from the connect-time keyframe burst, and the guard
    /// is the inter-slice count rather than a count of pictures: IDRs are
    /// excluded by construction, so a burst of any length says nothing.
    #[test]
    fn a_burst_of_keyframes_decides_nothing() {
        let mut stats = windows_shaped_stats();
        stats.views[0].idr = stats.views[0].total;
        stats.views[2].idr = stats.views[2].total;

        assert_eq!(stats.safety(false), Safety::Undecided);
        assert_eq!(stats.safety(true), Safety::Undecided, "nor in eager mode");
    }

    /// An auxiliary view that has never *claimed* a long-term index is not yet
    /// evidence that it claims none of main's.
    ///
    /// An empty set is disjoint from everything, so without this the
    /// separate-chains test would be satisfied having seen nothing at all
    /// about what the auxiliary view produces -- and a non-IDR I slice counts
    /// as an auxiliary inter slice while marking nothing, which is how that
    /// arises in practice rather than in theory.
    #[test]
    fn an_auxiliary_view_that_has_claimed_nothing_decides_nothing() {
        let mut stats = windows_shaped_stats();
        stats.mmco_by_view[2].clear();

        assert_eq!(stats.safety(false), Safety::Undecided);
        assert_eq!(stats.safety(true), Safety::Undecided, "nor in eager mode");

        // And it resolves as soon as one arrives.
        stats.mmco_by_view[2].insert((6, 1), 1);
        assert_eq!(stats.safety(true), Safety::Safe);
    }

    /// Where nothing reorders at all the verdict reasons about the default
    /// list order, so the counts are the whole of the evidence and the guard
    /// above must not hold such a stream hostage.
    #[test]
    fn a_default_list_stream_still_reaches_a_verdict() {
        let mut stats = xrdp_shaped_stats();
        stats.aus = 200;
        assert_ne!(
            stats.safety(false),
            Safety::Undecided,
            "{}",
            stats.verdict()
        );
    }
}
