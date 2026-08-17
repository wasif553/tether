import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Lecturer exam configuration UI — corrective pass. Physical/local
 * testing (TETHER_CLIENT_REQUIRED_DISABLED=false,
 * TETHER_SECURE_CLIENT_DIAGNOSTICS_ENABLED=true) showed the lecturer
 * exam page still rendered "Tether Secure Client" / "Planned for
 * examinations requiring stronger device controls." / "Disabled in
 * production v1." / "Single-display enforcement unavailable" — even
 * though the underlying availability flag (secureClientAvailability.ts,
 * already covered by secureClientAvailability.test.ts) was correctly
 * reporting tetherClientRequiredAvailable: true. The root cause was
 * entirely in this page and its pure UI-state helpers
 * (resolveDisplayRequirementUiState et al. in secureClientPolicy.ts,
 * see secureClientPolicy.test.ts) never having been extended to know
 * about Tether at all — TETHER_CLIENT_REQUIRED was never offered as a
 * delivery-mode option in the first place.
 *
 * No jsdom/React-Testing-Library infrastructure exists in this repo
 * (see other *.test.ts files for the same convention) — these assert
 * directly on the page's source text, mirroring
 * apps/lockdown/src/ipcChain.test.ts's approach for the same reason.
 */
const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("lecturer exam page — Tether Secure Browser delivery option", () => {
  it("offers 'Tether Secure Browser — required' with the exact required description and wiring", () => {
    expect(pageSource).toMatch(/value:\s*"TETHER_CLIENT_REQUIRED"/);
    expect(pageSource).toMatch(/title:\s*"Tether Secure Browser — required"/);
    expect(pageSource).toMatch(/desc:\s*"Students must open this examination in Tether Secure Browser\."/);
    expect(pageSource).toMatch(/disabled:\s*!exam\.secureClientAvailability\.tetherClientRequiredAvailable/);
  });

  it("offers 'Tether Secure Browser — optional' (renamed from the old 'Tether Secure Client' title)", () => {
    expect(pageSource).toMatch(/title:\s*"Tether Secure Browser — optional"/);
    expect(pageSource).toMatch(/disabled:\s*!exam\.secureClientAvailability\.tetherClientOptionalAvailable/);
  });

  it("never shows 'Compatibility validation required' for either Tether option — Tether is the validated first-party client, unlike SEB", () => {
    const tetherRequiredBlock = pageSource.slice(pageSource.indexOf('value: "TETHER_CLIENT_REQUIRED"'), pageSource.indexOf('value: "TETHER_CLIENT_OPTIONAL"'));
    expect(tetherRequiredBlock).toMatch(/needsValidationNotice:\s*false/);
  });
});

describe("lecturer exam page — stale copy removed (Task 4)", () => {
  it("never shows the old 'Tether Secure Client' radio-card title", () => {
    expect(pageSource).not.toMatch(/title:\s*"Tether Secure Client"/);
  });

  it("never claims Tether is 'Planned for examinations requiring stronger device controls.'", () => {
    expect(pageSource).not.toMatch(/Planned for examinations requiring stronger device controls\./);
  });

  it("never shows the stale 'Disabled in production v1.' fallback text", () => {
    expect(pageSource).not.toMatch(/Disabled in production v1\./);
  });

  it("never claims 'Safe Exam Browser will enforce' the display restriction (Tether is now the mechanism, not exclusively SEB)", () => {
    expect(pageSource).not.toMatch(/Safe Exam Browser will enforce/);
  });

  it("the Single display required copy uses the exact required Tether-facing wording", () => {
    expect(pageSource).toMatch(/Tether Secure Browser checks Windows display topology before and during the examination\./);
  });
});

describe("lecturer exam page — display requirement availability wired for Tether (Task 1/3)", () => {
  it("resolveDisplayRequirementUiState is called with both Tether availability booleans, not just SEB's", () => {
    const callSite = pageSource.slice(
      pageSource.indexOf("const displayRequirementUiState = resolveDisplayRequirementUiState({"),
      pageSource.indexOf("const displayRequirementUiState = resolveDisplayRequirementUiState({") + 500,
    );
    expect(callSite).toMatch(/tetherClientRequiredAvailable:\s*exam\.secureClientAvailability\.tetherClientRequiredAvailable/);
    expect(callSite).toMatch(/tetherClientOptionalAvailable:\s*exam\.secureClientAvailability\.tetherClientOptionalAvailable/);
  });

  it("resolveDeliveryModeForSingleDisplayRequired (the auto-switch-on-click handler) is also called with both Tether booleans", () => {
    const callSite = pageSource.slice(
      pageSource.indexOf("const { deliveryMode, changed } = resolveDeliveryModeForSingleDisplayRequired({"),
      pageSource.indexOf("const { deliveryMode, changed } = resolveDeliveryModeForSingleDisplayRequired({") + 700,
    );
    expect(callSite).toMatch(/tetherClientRequiredAvailable:\s*exam\.secureClientAvailability\.tetherClientRequiredAvailable/);
    expect(callSite).toMatch(/tetherClientOptionalAvailable:\s*exam\.secureClientAvailability\.tetherClientOptionalAvailable/);
  });

  it("isDisplayPolicySaveBlocked (the pre-save guard) is also called with both Tether booleans", () => {
    const callSite = pageSource.slice(pageSource.indexOf("isDisplayPolicySaveBlocked({"), pageSource.indexOf("isDisplayPolicySaveBlocked({") + 500);
    expect(callSite).toMatch(/tetherClientRequiredAvailable:\s*exam\.secureClientAvailability\.tetherClientRequiredAvailable/);
    expect(callSite).toMatch(/tetherClientOptionalAvailable:\s*exam\.secureClientAvailability\.tetherClientOptionalAvailable/);
  });

  it("the red validation-error banner never singles out Safe Exam Browser only — it must not contradict a valid Tether required + single display selection", () => {
    const bannerBlock = pageSource.slice(
      pageSource.indexOf("Single display required needs a display-aware exam client."),
      pageSource.indexOf("Single display required needs a display-aware exam client.") + 400,
    );
    expect(bannerBlock).toMatch(/Tether Secure Browser —\s+required/);
  });
});

describe("lecturer exam page — standard-duration save refreshes accommodation data (migration review fix)", () => {
  const handleSaveDurationBlock = pageSource.slice(
    pageSource.indexOf("async function handleSaveDuration()"),
    pageSource.indexOf("function handleOpenAddAccommodation()"),
  );

  it("handleSaveDuration exists and is isolated in the expected source region", () => {
    expect(handleSaveDurationBlock.length).toBeGreaterThan(0);
    expect(handleSaveDurationBlock).toMatch(/async function handleSaveDuration\(\)/);
  });

  it("on a successful PATCH, calls loadExam before loadTimeAccommodations (server/pure resolver stays authoritative, never a client recomputation)", () => {
    const successBranch = handleSaveDurationBlock.slice(handleSaveDurationBlock.indexOf("if (res.ok) {"));
    const loadExamIndex = successBranch.indexOf("await loadExam(");
    const loadAccommodationsIndex = successBranch.indexOf("await loadTimeAccommodations();");
    expect(loadExamIndex).toBeGreaterThan(-1);
    expect(loadAccommodationsIndex).toBeGreaterThan(-1);
    expect(loadAccommodationsIndex).toBeGreaterThan(loadExamIndex);
  });

  it("does NOT recompute effective duration client-side inside handleSaveDuration itself — no resolveEffectiveExamDurationMins call in this function", () => {
    expect(handleSaveDurationBlock).not.toMatch(/resolveEffectiveExamDurationMins/);
  });

  it("on a FAILED PATCH, neither loadExam nor loadTimeAccommodations is called — failure never reloads as though the save succeeded", () => {
    const failureBranch = handleSaveDurationBlock.slice(handleSaveDurationBlock.indexOf("} else {"));
    expect(failureBranch).not.toMatch(/await loadExam\(/);
    expect(failureBranch).not.toMatch(/await loadTimeAccommodations\(\)/);
    expect(failureBranch).toMatch(/setDurationMessage/);
  });

  it("loadTimeAccommodations itself always re-fetches from the server (GET /api/exams/[id]/time-accommodations) rather than recomputing client-side", () => {
    const loaderBlock = pageSource.slice(
      pageSource.indexOf("async function loadTimeAccommodations()"),
      pageSource.indexOf("async function loadTimeAccommodations()") + 400,
    );
    expect(loaderBlock).toMatch(/fetch\(`\/api\/exams\/\$\{id\}\/time-accommodations`\)/);
  });
});

describe("lecturer exam page — Controlled AI commercial completion pass (Section 3/4)", () => {
  const controlledAiSectionStart = pageSource.indexOf(
    '<h3 className="text-sm font-medium">Tether Controlled AI</h3>',
  );
  const controlledAiSectionEnd = pageSource.indexOf("Screen-share evidence");
  const controlledAiSection = pageSource.slice(controlledAiSectionStart, controlledAiSectionEnd);

  it("labels the permitted-resources checkbox 'External AI tools', not the old bare 'AI tools'", () => {
    expect(pageSource).toMatch(/>\s*External AI tools\s*</);
  });

  it("the External AI tools helper text distinguishes it from Tether Controlled AI without claiming a technical block", () => {
    expect(pageSource).toMatch(/permits AI tools outside Tether Controlled AI/);
    expect(pageSource.replace(/\s+/g, " ")).toMatch(/policy statement, not a technical block/);
  });

  it("uses the commercial name 'Tether Controlled AI' as the section heading (not the old internal 'AI Brainstorming Assistance' heading)", () => {
    expect(controlledAiSectionStart).toBeGreaterThan(-1);
    expect(pageSource).not.toMatch(/<h3 className="text-sm font-medium">AI Brainstorming Assistance<\/h3>/);
  });

  it("the primary Controlled AI control is a simple Off / Controlled guidance choice mapped to the existing DISABLED/BRAINSTORM_ONLY values — no new schema enum", () => {
    expect(controlledAiSection).toMatch(/aiAssistanceMode:\s*"DISABLED"/);
    expect(controlledAiSection).toMatch(/aiAssistanceMode:\s*"BRAINSTORM_ONLY"/);
    expect(controlledAiSection).toMatch(/>\s*Off\s*</);
    expect(controlledAiSection).toMatch(/>\s*Controlled guidance\s*</);
  });

  it("shows the concise policy summary before the advanced settings when Controlled guidance is enabled", () => {
    const summaryIndex = controlledAiSection.indexOf("Controlled guidance enabled");
    const detailsIndex = controlledAiSection.indexOf("Advanced Controlled AI settings");
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(detailsIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeLessThan(detailsIndex);
  });

  it("puts the detailed limits and capability toggles behind an 'Advanced Controlled AI settings' progressive disclosure", () => {
    expect(controlledAiSection).toMatch(/<details[^>]*>[\s\S]*<summary[^>]*>\s*Advanced Controlled AI settings\s*<\/summary>/);
  });

  it("keeps every existing advanced control inside the disclosure — three numeric limits and four capability checkboxes, values unchanged", () => {
    const detailsStart = controlledAiSection.indexOf("Advanced Controlled AI settings");
    const detailsBlock = controlledAiSection.slice(detailsStart);
    expect(detailsBlock).toMatch(/aiAssistanceMaxPromptsPerQuestion/);
    expect(detailsBlock).toMatch(/aiAssistanceMaxPromptsPerAttempt/);
    expect(detailsBlock).toMatch(/aiAssistanceMaxResponseCharacters/);
    expect(detailsBlock).toMatch(/aiAssistanceAllowConceptExplanations/);
    expect(detailsBlock).toMatch(/aiAssistanceAllowAnswerPlanning/);
    expect(detailsBlock).toMatch(/aiAssistanceAllowReasoningFeedback/);
    expect(detailsBlock).toMatch(/aiAssistanceAllowProgrammingConceptHelp/);
    expect(detailsBlock).toMatch(/min=\{1\}\s*\n\s*max=\{20\}/);
    expect(detailsBlock).toMatch(/min=\{1\}\s*\n\s*max=\{100\}/);
    expect(detailsBlock).toMatch(/min=\{200\}\s*\n\s*max=\{4000\}/);
  });

  it("the Tether Controlled AI section never references aiToolsAllowed — changing Controlled AI mode never silently mutates the independent external-AI-tools setting", () => {
    expect(controlledAiSection).not.toMatch(/aiToolsAllowed/);
  });

  it("no longer shows the old 'Enable AI brainstorming assistance' checkbox label", () => {
    expect(pageSource).not.toMatch(/Enable AI brainstorming assistance/);
  });
});
