/**
 * Answer-Development Provenance v1 — deterministic text diff. See
 * docs/answer-development-provenance-v1.md and Part 4 of the spec.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js. Diffing is
 * performed only at autosave/checkpoint boundaries (never per keystroke —
 * see src/lib/answerDevelopment.ts, which calls this only when a
 * checkpoint is actually being considered). Word-token diff with
 * prefix/suffix trimming keeps the typical case (a small localised edit
 * to a long answer) cheap regardless of overall answer length; only the
 * genuinely-changed middle ever needs full alignment.
 */

export type DiffSegmentType = "equal" | "added" | "removed";
export type DiffSegment = { type: DiffSegmentType; text: string };

export type DiffResult = {
  segments: DiffSegment[];
  charactersAdded: number;
  charactersRemoved: number;
  priorLength: number;
  currentLength: number;
  /** (charactersAdded + charactersRemoved) / max(1, priorLength) — used for SUBSTANTIAL_EDIT's ratio leg. */
  changeRatio: number;
  /** charactersRemoved / max(1, priorLength) — used for LARGE_DELETION / MAJOR_REWRITE ("replaced"). */
  removedRatio: number;
};

/** Splits into words AND whitespace runs, in original order — joining every token back together reconstructs the original text exactly. */
export function tokenizeForDiff(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

function commonPrefixLength(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string[], b: string[], aStart: number, bStart: number): number {
  let i = a.length - 1;
  let j = b.length - 1;
  let count = 0;
  while (i >= aStart && j >= bStart && a[i] === b[j]) {
    i--;
    j--;
    count++;
  }
  return count;
}

/**
 * Above this many tokens on EITHER side of the trimmed middle, skip the
 * O(n*m) LCS alignment and fall back to a plain "all old removed, all new
 * added" middle — still gives correct character counts, just without a
 * fine-grained token-level alignment for that rare huge-rewrite case.
 * Bounded by CHECKPOINT_RESPONSE_TEXT_MAX_CHARS in practice, but this
 * keeps worst-case latency bounded regardless.
 */
const MAX_MIDDLE_TOKENS_FOR_LCS = 3000;

/** Classic LCS-based token diff — only ever called on the (usually small) trimmed middle. */
function lcsDiff(a: string[], b: string[]): DiffSegment[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.length > 0 ? [{ type: "added", text: b.join("") }] : [];
  if (m === 0) return a.length > 0 ? [{ type: "removed", text: a.join("") }] : [];
  if (n > MAX_MIDDLE_TOKENS_FOR_LCS || m > MAX_MIDDLE_TOKENS_FOR_LCS) {
    const segments: DiffSegment[] = [];
    if (n > 0) segments.push({ type: "removed", text: a.join("") });
    if (m > 0) segments.push({ type: "added", text: b.join("") });
    return segments;
  }

  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  const pushOrExtend = (type: DiffSegmentType, text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ type, text });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pushOrExtend("equal", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushOrExtend("removed", a[i]);
      i++;
    } else {
      pushOrExtend("added", b[j]);
      j++;
    }
  }
  while (i < n) {
    pushOrExtend("removed", a[i]);
    i++;
  }
  while (j < m) {
    pushOrExtend("added", b[j]);
    j++;
  }
  return segments;
}

/**
 * Diffs two versions of an answer's text. Deterministic, bounded, and
 * cheap for the common case (a small edit to a long answer) via prefix/
 * suffix trimming — only the changed middle is ever fully aligned.
 */
export function diffAnswerText(priorText: string, currentText: string): DiffResult {
  const priorLength = priorText.length;
  const currentLength = currentText.length;
  if (priorText === currentText) {
    return {
      segments: priorText.length > 0 ? [{ type: "equal", text: priorText }] : [],
      charactersAdded: 0,
      charactersRemoved: 0,
      priorLength,
      currentLength,
      changeRatio: 0,
      removedRatio: 0,
    };
  }

  const a = tokenizeForDiff(priorText);
  const b = tokenizeForDiff(currentText);
  const prefixLen = commonPrefixLength(a, b);
  const suffixLen = commonSuffixLength(a, b, prefixLen, prefixLen);

  const prefixTokens = a.slice(0, prefixLen);
  const middleA = a.slice(prefixLen, a.length - suffixLen);
  const middleB = b.slice(prefixLen, b.length - suffixLen);
  const suffixTokens = a.slice(a.length - suffixLen);

  const segments: DiffSegment[] = [];
  if (prefixTokens.length > 0) segments.push({ type: "equal", text: prefixTokens.join("") });
  segments.push(...lcsDiff(middleA, middleB));
  if (suffixTokens.length > 0) segments.push({ type: "equal", text: suffixTokens.join("") });

  let charactersAdded = 0;
  let charactersRemoved = 0;
  for (const seg of segments) {
    if (seg.type === "added") charactersAdded += seg.text.length;
    else if (seg.type === "removed") charactersRemoved += seg.text.length;
  }

  const denominator = Math.max(1, priorLength);
  return {
    segments,
    charactersAdded,
    charactersRemoved,
    priorLength,
    currentLength,
    changeRatio: (charactersAdded + charactersRemoved) / denominator,
    removedRatio: charactersRemoved / denominator,
  };
}

// ---------------------------------------------------------------------------
// Pasted-text retention (Part 3/4) — "whether most pasted material was
// later replaced." Compares the ORIGINALLY PASTED segment's word tokens
// against a LATER checkpoint's full text via longest-common-subsequence
// overlap (not exact substring match, since the surviving portion may no
// longer be contiguous after further edits). Never stores a separate raw
// clipboard field — the pasted segment used here is the text the student
// actually inserted into the answer field, taken from the checkpoint
// diff at paste time.
// ---------------------------------------------------------------------------

export type PasteRetentionResult = {
  pastedLength: number;
  survivingRatio: number;
  replacedRatio: number;
};

function tokenMultisetLcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length > MAX_MIDDLE_TOKENS_FOR_LCS || b.length > MAX_MIDDLE_TOKENS_FOR_LCS) {
    // Fallback for very large inputs: count shared token multiset overlap
    // instead of true LCS — a looser but still meaningful and bounded
    // approximation (order-insensitive, but paste-retention is about
    // "does this content still appear at all," not position).
    const counts = new Map<string, number>();
    for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
    let overlap = 0;
    for (const t of b) {
      const remaining = counts.get(t) ?? 0;
      if (remaining > 0) {
        overlap++;
        counts.set(t, remaining - 1);
      }
    }
    return overlap;
  }
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * How much of a previously-pasted segment still appears (as a subsequence
 * of word tokens) in a later checkpoint's text. A low survivingRatio (high
 * replacedRatio) means the student substantially rewrote what was pasted
 * — a descriptive process observation, never itself evidence of anything.
 */
export function computePasteRetention(pastedText: string, laterText: string): PasteRetentionResult {
  const pastedTokens = tokenizeForDiff(pastedText).filter((t) => t.trim().length > 0);
  const laterTokens = tokenizeForDiff(laterText).filter((t) => t.trim().length > 0);
  const pastedLength = pastedText.length;
  if (pastedTokens.length === 0) {
    return { pastedLength, survivingRatio: 1, replacedRatio: 0 };
  }
  const lcsLength = tokenMultisetLcsLength(pastedTokens, laterTokens);
  const survivingRatio = lcsLength / pastedTokens.length;
  return { pastedLength, survivingRatio, replacedRatio: 1 - survivingRatio };
}
