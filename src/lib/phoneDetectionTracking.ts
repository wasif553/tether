/**
 * Strengthened phone detection — candidate tracking, confidence bands and
 * geometry checks. See docs/phone-detection-calibration-v1.md and
 * docs/on-device-ai-integrity-detection-v1.md.
 *
 * Pure, dependency-free, deterministic: no DOM, no TensorFlow, no camera.
 * Operates entirely on plain numbers and normalized (0-1) bounding boxes
 * the caller derives from the real `<video>`/canvas elements and the
 * on-device object detector (see src/app/student/exams/[id]/page.tsx and
 * src/lib/cameraObjectDetector.ts).
 *
 * Design goal (see the user-supplied decision model): a single global
 * confidence threshold cannot distinguish "an angled phone near the
 * bottom edge" from "a calculator/hand/dark book" — both often score in
 * a similar mid-confidence range from a single full-frame pass. This
 * module instead tracks CANDIDATES across several ticks and several
 * spatial sources (full frame + crops, see phoneMultiScaleCrops.ts), and
 * only turns a candidate into a warning once it is either clearly
 * confident, or persistently and spatially consistently observed. It
 * never guarantees zero false positives — see the "Known limitations"
 * section of docs/phone-detection-calibration-v1.md.
 */

export const PHONE_DETECTION_ALGORITHM_VERSION = "phone-detection-v2-multiscale-1";

// ---------------------------------------------------------------------------
// Confidence bands (Part 5)
// ---------------------------------------------------------------------------

/**
 * These starting values were calibrated against the EXISTING single
 * global threshold this repo already ships (PHONE_CONFIDENCE_THRESHOLD =
 * 0.45 in cameraIntegrityDetection.ts), not invented independently: STRONG
 * sits comfortably above it (clear, unambiguous "cell phone" detections
 * that already fired instantly under the old single-threshold rule keep
 * doing so here), MODERATE starts below it (this is the new recall this
 * feature adds — angled/edge/small candidates that would previously never
 * have reached 0.45 at all on a single full-frame pass, but are real once
 * confirmed spatially/temporally across several ticks and/or a
 * second-stage verification crop), and WEAK is the floor below which a
 * detection is treated as noise and never even retained as an
 * observation. This repo has no labelled fixture/hardware evaluation
 * harness run yet (see docs/phone-detection-calibration-v1.md, "Known
 * limitations") — these are principled starting points to calibrate
 * further from real `sesAiCameraDebug` observations, not the result of
 * such a calibration.
 */
export const PHONE_CONFIDENCE_STRONG = 0.65;
export const PHONE_CONFIDENCE_MODERATE = 0.32;
export const PHONE_CONFIDENCE_WEAK = 0.18;

export type PhoneConfidenceBand = "strong" | "moderate" | "weak" | "none";

export function phoneConfidenceBand(score: number): PhoneConfidenceBand {
  if (score >= PHONE_CONFIDENCE_STRONG) return "strong";
  if (score >= PHONE_CONFIDENCE_MODERATE) return "moderate";
  if (score >= PHONE_CONFIDENCE_WEAK) return "weak";
  return "none";
}

// ---------------------------------------------------------------------------
// Geometry — normalized (0-1, origin top-left) boxes in ORIGINAL-frame space
// ---------------------------------------------------------------------------

export type NormalizedBox = { x: number; y: number; width: number; height: number };

export function boxArea(box: NormalizedBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

/** Intersection-over-union of two normalized boxes. 0 when they don't overlap or either is degenerate. */
export function boxIoU(a: NormalizedBox, b: NormalizedBox): number {
  const areaA = boxArea(a);
  const areaB = boxArea(b);
  if (areaA <= 0 || areaB <= 0) return 0;
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (intersection <= 0) return 0;
  return intersection / (areaA + areaB - intersection);
}

/** Euclidean distance between box centres, in normalized units. */
export function boxCenterDistance(a: NormalizedBox, b: NormalizedBox): number {
  const cxA = a.x + a.width / 2;
  const cyA = a.y + a.height / 2;
  const cxB = b.x + b.width / 2;
  const cyB = b.y + b.height / 2;
  return Math.hypot(cxA - cxB, cyA - cyB);
}

/** 0..1 — 1 means identical area, 0 means either box is degenerate or the areas are wildly different. */
export function boxSizeSimilarity(a: NormalizedBox, b: NormalizedBox): number {
  const areaA = boxArea(a);
  const areaB = boxArea(b);
  if (areaA <= 0 || areaB <= 0) return 0;
  return Math.min(areaA, areaB) / Math.max(areaA, areaB);
}

// ---------------------------------------------------------------------------
// Plausibility checks (Part 9) — conservative geometry, not a phone-shape
// assumption. Phones can be portrait, landscape, tilted, cased, or seen
// from the side — this only rejects boxes that are geometrically
// nonsensical (degenerate, absurdly small/large, or an extreme sliver).
// ---------------------------------------------------------------------------

/** A candidate smaller than this fraction of the frame area is treated as noise (a distant speck), not a phone. */
export const MIN_CANDIDATE_AREA_RATIO = 0.0006;
/** A candidate larger than this fraction of the frame area is implausible for a hand-held phone at typical exam camera distance. */
export const MAX_CANDIDATE_AREA_RATIO = 0.55;
/** Longest-side/shortest-side ratio above this is a degenerate sliver, not a plausible object of any orientation. */
export const MAX_CANDIDATE_ASPECT_RATIO = 7;

export function isPlausiblePhoneGeometry(box: NormalizedBox): boolean {
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.width) || !Number.isFinite(box.height)) {
    return false;
  }
  if (box.width <= 0 || box.height <= 0) return false;
  const area = boxArea(box);
  if (area < MIN_CANDIDATE_AREA_RATIO || area > MAX_CANDIDATE_AREA_RATIO) return false;
  const longSide = Math.max(box.width, box.height);
  const shortSide = Math.min(box.width, box.height);
  if (shortSide <= 0) return false;
  if (longSide / shortSide > MAX_CANDIDATE_ASPECT_RATIO) return false;
  return true;
}

/** How much of a candidate's box actually lies within the visible [0,1] frame — a crop-mapped box can extend past it. */
export function visibleAreaEstimate(box: NormalizedBox): number {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(1, box.x + box.width);
  const y1 = Math.min(1, box.y + box.height);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

/** Part 8 — a box touching (within `marginRatio` of) any frame edge is not automatically rejected, only flagged for stricter confirmation. */
export function touchesFrameEdge(box: NormalizedBox, marginRatio = 0.03): boolean {
  return (
    box.x <= marginRatio ||
    box.y <= marginRatio ||
    box.x + box.width >= 1 - marginRatio ||
    box.y + box.height >= 1 - marginRatio
  );
}

// ---------------------------------------------------------------------------
// Cross-source merge (avoid counting the same phone twice when it's seen
// in both the full frame and an overlapping crop this tick)
// ---------------------------------------------------------------------------

export type PhoneDetectionSource = "full_frame" | "lower_crop" | "edge_crop" | "verification_crop";

export type PhoneObservation = {
  box: NormalizedBox;
  score: number;
  source: PhoneDetectionSource;
};

/** Greedy highest-score-first merge: keeps the highest-scoring box in each overlapping cluster, discards the rest. */
export function dedupeObservations(observations: PhoneObservation[], iouThreshold = 0.3): PhoneObservation[] {
  const sorted = [...observations].sort((a, b) => b.score - a.score);
  const kept: PhoneObservation[] = [];
  for (const candidate of sorted) {
    const overlapsKept = kept.some((k) => boxIoU(k.box, candidate.box) >= iouThreshold);
    if (!overlapsKept) kept.push(candidate);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Temporal candidate tracking (Part 6/7)
// ---------------------------------------------------------------------------

/** A missed frame doesn't immediately drop a track; an absence this long does. */
export const TRACK_MAX_MISSED_FRAMES = 3;
/** How many of the most recent eligible ticks are considered for the moderate 3-of-5 confirmation rule. */
export const TRACK_CONFIRM_WINDOW = 5;
/** Moderate candidates confirm once observed in at least this many of the last TRACK_CONFIRM_WINDOW eligible ticks. */
export const TRACK_CONFIRM_MODERATE_COUNT = 3;
/** Edge-touching moderate candidates need one additional confirming observation beyond the normal moderate rule. */
export const TRACK_CONFIRM_MODERATE_EDGE_COUNT = TRACK_CONFIRM_MODERATE_COUNT + 1;
/** Matching thresholds for "this detection is the same physical candidate as that track." */
export const TRACK_MATCH_MIN_IOU = 0.12;
export const TRACK_MATCH_MAX_CENTER_DISTANCE = 0.22;
/** Part 14 performance control — a hard ceiling independent of TRACK_MAX_MISSED_FRAMES expiry, so a burst of noisy candidates on a struggling device can never grow the tracked set unboundedly. */
export const MAX_ACTIVE_PHONE_TRACKS = 6;

export type PhoneCandidateTrack = {
  id: string;
  box: NormalizedBox;
  latestScore: number;
  latestBand: PhoneConfidenceBand;
  latestSource: PhoneDetectionSource;
  touchesEdge: boolean;
  visibleArea: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  missedFrames: number;
  /** Sliding window of the last TRACK_CONFIRM_WINDOW eligible ticks: true = this track had a >=moderate observation that tick. */
  recentEligibleWindow: boolean[];
  verificationOutcome: "unverified" | "raised" | "lowered";
  confirmedLocalWarning: boolean;
};

export type PhoneTrackerUpdateResult = {
  tracks: PhoneCandidateTrack[];
  /** Tracks that just transitioned into a confirmed local warning this tick (Part 7 — "activation"). */
  newlyConfirmed: PhoneCandidateTrack[];
  /** Tracks that were confirmed before this tick and now have no confirmed candidate anywhere (Part 7 — "recovery"). */
  anyConfirmedActive: boolean;
};

let trackIdCounter = 0;
function nextTrackId(): string {
  trackIdCounter += 1;
  return `phone-track-${trackIdCounter}`;
}

/**
 * Stateful, but framework-free — a plain class exactly like the existing
 * DetectionCooldownTracker in cameraIntegrityDetection.ts, so it composes
 * the same way: owned by a component-level ref, driven by explicit method
 * calls, unit-testable without a browser.
 */
export class PhoneCandidateTracker {
  private tracks = new Map<string, PhoneCandidateTrack>();

  /** Camera restart (Part 6) — clears all tracks unconditionally; the caller is responsible for calling this on generation change. */
  reset(): void {
    this.tracks.clear();
  }

  getTracks(): PhoneCandidateTrack[] {
    return [...this.tracks.values()];
  }

  hasConfirmedWarning(): boolean {
    return [...this.tracks.values()].some((t) => t.confirmedLocalWarning);
  }

  /**
   * One tracking step. `observations` must already be deduped
   * (dedupeObservations) and geometry-filtered (isPlausiblePhoneGeometry)
   * by the caller — this function only matches/confirms, it does not
   * re-validate geometry.
   */
  update(observations: PhoneObservation[], nowMs: number): PhoneTrackerUpdateResult {
    const matchedTrackIds = new Set<string>();
    const newlyConfirmed: PhoneCandidateTrack[] = [];

    for (const observation of observations) {
      const band = phoneConfidenceBand(observation.score);
      if (band === "none") continue; // below WEAK — not even an observation

      const existing = this.findMatchingTrack(observation.box, matchedTrackIds);
      const edge = touchesFrameEdge(observation.box);
      const visibleArea = visibleAreaEstimate(observation.box);

      const track: PhoneCandidateTrack = existing ?? {
        id: nextTrackId(),
        box: observation.box,
        latestScore: 0,
        latestBand: "none",
        latestSource: observation.source,
        touchesEdge: edge,
        visibleArea,
        firstSeenAtMs: nowMs,
        lastSeenAtMs: nowMs,
        missedFrames: 0,
        recentEligibleWindow: [],
        verificationOutcome: "unverified",
        confirmedLocalWarning: false,
      };

      track.box = observation.box;
      track.latestScore = observation.score;
      track.latestBand = band;
      track.latestSource = observation.source;
      track.touchesEdge = edge;
      track.visibleArea = visibleArea;
      track.lastSeenAtMs = nowMs;
      track.missedFrames = 0;

      const eligibleThisTick = band === "strong" || band === "moderate";
      track.recentEligibleWindow = [...track.recentEligibleWindow, eligibleThisTick].slice(-TRACK_CONFIRM_WINDOW);

      const wasConfirmed = track.confirmedLocalWarning;
      track.confirmedLocalWarning = this.decideConfirmation(track);
      if (track.confirmedLocalWarning && !wasConfirmed) newlyConfirmed.push(track);

      this.tracks.set(track.id, track);
      matchedTrackIds.add(track.id);
    }

    // Unmatched tracks this tick: age them, drop after too many misses (Part 6/7 recovery).
    for (const track of this.tracks.values()) {
      if (matchedTrackIds.has(track.id)) continue;
      track.missedFrames += 1;
      track.recentEligibleWindow = [...track.recentEligibleWindow, false].slice(-TRACK_CONFIRM_WINDOW);
      if (track.missedFrames > TRACK_MAX_MISSED_FRAMES) {
        this.tracks.delete(track.id);
        continue;
      }
      // Recovery: a confirmed warning clears once the track has gone
      // quiet for TRACK_MAX_MISSED_FRAMES straight ticks — the track
      // itself may briefly outlive the warning to tolerate one more
      // reappearance before fully expiring.
      if (track.missedFrames >= TRACK_MAX_MISSED_FRAMES) {
        track.confirmedLocalWarning = false;
      }
    }

    // Part 14 performance control — enforce the hard track-count ceiling by
    // dropping the lowest-priority tracks (unconfirmed first, then lowest
    // score) rather than letting a noisy tick grow the set unboundedly.
    if (this.tracks.size > MAX_ACTIVE_PHONE_TRACKS) {
      const overflow = [...this.tracks.values()]
        .sort((a, b) => {
          if (a.confirmedLocalWarning !== b.confirmedLocalWarning) return a.confirmedLocalWarning ? 1 : -1;
          return a.latestScore - b.latestScore;
        })
        .slice(0, this.tracks.size - MAX_ACTIVE_PHONE_TRACKS);
      for (const track of overflow) this.tracks.delete(track.id);
    }

    return { tracks: this.getTracks(), newlyConfirmed, anyConfirmedActive: this.hasConfirmedWarning() };
  }

  /** Second-stage verification (Part 10) result applied to a specific track — strengthens or weakens, never an irreversible single-frame decision. */
  applyVerification(trackId: string, verificationDetectedPhone: boolean, verificationScore: number): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    if (verificationDetectedPhone && phoneConfidenceBand(verificationScore) === "strong") {
      track.latestBand = "strong";
      track.verificationOutcome = "raised";
      track.confirmedLocalWarning = this.decideConfirmation(track);
    } else if (!verificationDetectedPhone) {
      track.verificationOutcome = "lowered";
      // A failed verification demotes, but the tracker's normal temporal
      // rules still govern confirmation — this alone never instantly
      // clears an already-confirmed warning, it just stops it from
      // gaining any further confirmation credit until re-observed.
    }
    this.tracks.set(trackId, track);
  }

  private decideConfirmation(track: PhoneCandidateTrack): boolean {
    if (track.latestBand === "strong") {
      // Quick activation — mirrors the previous single-frame-confirm
      // behaviour for clear, unambiguous detections (Part 2/7).
      return true;
    }
    if (track.latestBand === "moderate") {
      const requiredCount = track.touchesEdge ? TRACK_CONFIRM_MODERATE_EDGE_COUNT : TRACK_CONFIRM_MODERATE_COUNT;
      const eligibleCount = track.recentEligibleWindow.filter(Boolean).length;
      return eligibleCount >= requiredCount;
    }
    return track.confirmedLocalWarning; // weak alone never newly confirms, but doesn't retroactively un-confirm either
  }

  private findMatchingTrack(box: NormalizedBox, alreadyMatched: Set<string>): PhoneCandidateTrack | null {
    let best: PhoneCandidateTrack | null = null;
    let bestIoU = 0;
    for (const track of this.tracks.values()) {
      if (alreadyMatched.has(track.id)) continue;
      const iou = boxIoU(track.box, box);
      const centerDistance = boxCenterDistance(track.box, box);
      if (iou >= TRACK_MATCH_MIN_IOU || centerDistance <= TRACK_MATCH_MAX_CENTER_DISTANCE) {
        if (iou >= bestIoU) {
          bestIoU = iou;
          best = track;
        }
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Second-stage verification helpers (Part 10)
// ---------------------------------------------------------------------------

/** Bounded to one verification attempt per tick (Part 14 performance controls) — the caller enforces the "per tick" part; this only decides eligibility. */
export function shouldRunSecondStageVerification(band: PhoneConfidenceBand): boolean {
  return band === "moderate";
}

/** Expands a candidate box with surrounding context before re-cropping and re-running the detector on it, clamped to stay within the frame. */
export function expandCandidateBoxForVerification(box: NormalizedBox, marginRatio = 0.6): NormalizedBox {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const width = Math.min(1, box.width * (1 + marginRatio * 2));
  const height = Math.min(1, box.height * (1 + marginRatio * 2));
  const x = Math.max(0, Math.min(1 - width, cx - width / 2));
  const y = Math.max(0, Math.min(1 - height, cy - height / 2));
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// Evidence tiers (Part 12)
// ---------------------------------------------------------------------------

export type PhoneEvidenceTier =
  | "OBSERVED_CANDIDATE"
  | "CONFIRMED_LOCAL_WARNING"
  | "BACKEND_REVIEW_EVENT"
  | "EVIDENCE_FRAME_ELIGIBLE";

/**
 * Derives the current evidence tier for a track. `backendEventAccepted`
 * means the backend integrity event for this confirmation was actually
 * created (cooldown allowed it); evidence upload additionally requires
 * capture to be enabled AND the current camera generation to still be
 * valid AND the candidate to still be present (Part 12).
 */
export function phoneEvidenceTier(
  track: Pick<PhoneCandidateTrack, "confirmedLocalWarning" | "latestBand">,
  backendEventAccepted: boolean,
  evidenceCaptureEnabled: boolean,
  generationValid: boolean,
  candidateStillPresent: boolean,
): PhoneEvidenceTier | null {
  if (!track.confirmedLocalWarning) {
    return track.latestBand !== "none" ? "OBSERVED_CANDIDATE" : null;
  }
  if (!backendEventAccepted) return "CONFIRMED_LOCAL_WARNING";
  if (!evidenceCaptureEnabled || !generationValid || !candidateStillPresent) return "BACKEND_REVIEW_EVENT";
  return "EVIDENCE_FRAME_ELIGIBLE";
}
