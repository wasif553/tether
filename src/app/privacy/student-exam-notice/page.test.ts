/**
 * Tether Privacy + Evidence Retention Package v1 — see
 * docs/privacy-and-evidence-retention-v1.md.
 *
 * Static regression guard over the student-facing exam privacy notice
 * (mirrors src/lib/pilotUiTerminology.test.ts's own pattern: read the
 * real source file on disk, normalise JSX line-wrapping, assert on
 * substrings/regex). This locks the corrected claims in place so a
 * future edit can't silently reintroduce an obsolete or inaccurate
 * statement without a test failing.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PAGE_PATH = "src/app/privacy/student-exam-notice/page.tsx";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

// \s+ -> single space tolerates the source's own JSX line-wrapping
// splitting a multi-word phrase across lines.
const content = read(PAGE_PATH).replace(/\s+/g, " ");

describe("student exam privacy notice — corrected/locked claims", () => {
  it("[1] never claims lockdown browser is a future/planned option", () => {
    expect(content).not.toMatch(/lockdown (mode|browser) (is|requires).{0,80}planned as a future option/i);
    expect(content).not.toMatch(/planned as a future option/i);
  });

  it("[2] represents Tether Secure Browser as an existing, currently available exam mode", () => {
    expect(content).toMatch(/Tether Secure Browser/);
    expect(content).toMatch(/some exams require.{0,20}tether secure browser/i);
    // Not framed as future/planned.
    expect(content).not.toMatch(/tether secure browser.{0,80}(planned|coming soon|not yet available|future release)/i);
  });

  it("[3] camera monitoring does not claim continuous video recording/storage", () => {
    expect(content).toMatch(/continuously record or store video/i);
  });

  it("[4] optional camera evidence frames are accurately disclosed as a separate, further opt-in setting", () => {
    expect(content).toMatch(/camera evidence frame/i);
    expect(content).toMatch(/separately.{0,40}enabled camera evidence frames/i);
    // The base feature must not claim images are *never* stored — only that it doesn't store them itself.
    expect(content).not.toMatch(/camera monitoring.{0,120}(never|does not|no) (store|stores|storing) (an )?image.{0,80}(ever|under any circumstances)/i);
  });

  it("[5] no facial recognition, face comparison, or biometric template claims", () => {
    expect(content).toMatch(/use facial recognition, compare your face to anything, or create a biometric template/i);
    expect(content).not.toMatch(/\bwe use facial recognition\b/i);
  });

  it("[6] no automatic misconduct determination — human review boundary is explicit", () => {
    expect(content).toMatch(/does not automatically determine academic misconduct/i);
    expect(content).toMatch(/make an automatic misconduct decision/i);
  });

  it("[7] screen-share audio is explicitly not captured", () => {
    expect(content).toMatch(/microphone\s*and system audio are never captured/i);
  });

  it("[8] no continuous screen recording/streaming claim", () => {
    expect(content).toMatch(/screen is never continuously recorded, saved as a video, or streamed anywhere/i);
  });

  it("[9] optional screen-share still evidence is disclosed", () => {
    expect(content).toMatch(/may save a limited number of still frames of your screen for review/i);
  });

  it("[10] network evidence discloses IP address, hashing, and approximate location without overstating precision", () => {
    expect(content).toMatch(/IP address/i);
    expect(content).toMatch(/hashed \(scrambled\) version/i);
    expect(content).toMatch(/Approximate country, region, and city/i);
    expect(content).toMatch(/SES does not use GPS location/i);
  });

  it("[11] human-review boundary is present as its own explicit section", () => {
    expect(content).toMatch(/Who makes assessment decisions/i);
    expect(content).toMatch(/institution and your lecturer remain responsible for any assessment/i);
  });

  it("[12] a retention section exists and does not promise automatic enforcement", () => {
    expect(content).toMatch(/How long is exam integrity evidence kept/i);
    expect(content).toMatch(/Retention is set by your institution and applicable requirements/i);
    // Must not claim retention/deletion happens automatically without qualification.
    expect(content).not.toMatch(/automatically deleted after \d+ days/i);
  });

  it("[13] no fabricated company/legal-entity/privacy-contact details", () => {
    expect(content).not.toMatch(/privacy@tether/i);
    expect(content).not.toMatch(/Tether Pty Ltd/i);
    expect(content).not.toMatch(/\bABN\b/);
    // Contact wording stays institution-first.
    expect(content).toMatch(/contact your lecturer or your institution/i);
  });

  it("[14] never claims all IP addresses are only ever stored hashed", () => {
    expect(content).not.toMatch(/(all|every) IP address(es)?.{0,40}(only|ever).{0,20}hash/i);
    expect(content).not.toMatch(/IP address(es)? (is|are) only (ever )?stored (as a hash|hashed)/i);
    // The raw IP address must actually be disclosed, not silently omitted.
    expect(content).toMatch(/Your IP address at exam open/i);
  });
});
