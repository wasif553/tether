/**
 * Australian Incident + NDB Procedure v1 — see
 * docs/australian-incident-ndb-procedure-v1.md.
 *
 * Static regression guard over documentation content (mirrors
 * src/lib/pilotUiTerminology.test.ts's and
 * src/lib/retentionExecutionSafetyDocs.test.ts's own pattern: read real
 * files on disk, normalise line-wrapping, assert on substrings/regex).
 * Locks the critical governance claims from this pass so a future edit
 * can't silently reintroduce an overstated or invented claim.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const procedure = read("docs/australian-incident-ndb-procedure-v1.md");
const procedureFlat = procedure.replace(/\s+/g, " ");
const assessmentRecord = read("docs/data-breach-assessment-record-v1.md");
const assessmentRecordFlat = assessmentRecord.replace(/\s+/g, " ");
const notificationTemplate = read("docs/data-breach-notification-template-v1.md");
const registerTemplate = read("docs/privacy-incident-register-template-v1.md");
const privacyPackage = read("docs/privacy-and-evidence-retention-v1.md");

describe("not every data breach is NDB-notifiable / applicability is conditional", () => {
  it("states not every privacy incident is a data breach, and not every data breach is an eligible data breach", () => {
    expect(procedureFlat).toMatch(/Not every privacy incident is a data breach/i);
    expect(procedureFlat).toMatch(/Not every data breach is an eligible data breach/i);
  });

  it("never claims Tether must notify OAIC for every breach", () => {
    expect(procedure).not.toMatch(/Tether must notify OAIC for every breach/i);
  });

  it("states NDB statutory applicability must be confirmed for the relevant entity and incident", () => {
    expect(procedureFlat).toMatch(/NDB statutory applicability must be confirmed for the relevant entity\s+and incident/i);
  });

  it("does not claim Tether is definitely subject to the Privacy Act/NDB scheme, and does not claim exemption", () => {
    expect(procedureFlat).toMatch(/does \*\*not\*\* claim Tether is definitely subject to the Privacy Act\/NDB scheme, and does \*\*not\*\* claim Tether is exempt/i);
  });
});

describe("30-day assessment clock is a maximum, not a waiting period", () => {
  it("states 30 calendar days is a maximum and not a target/entitlement to wait", () => {
    expect(procedureFlat).toMatch(/30 calendar days is a maximum, not a target and not an entitlement to wait/i);
  });

  it("does not state an organisation always gets 30 days before notifying", () => {
    expect(procedure).not.toMatch(/always gets 30 days before notifying/i);
  });

  it("does not normalise extensions past the 30-day maximum", () => {
    expect(procedureFlat).toMatch(/does not normalise extensions/i);
  });

  it("the assessment record template captures the 30-calendar-day statutory maximum date field", () => {
    expect(assessmentRecord).toMatch(/30-calendar-day statutory maximum date/i);
  });
});

describe("confirmed eligible breach notification is as soon as practicable", () => {
  it("OAIC notification requirement uses 'as soon as practicable', not automatic/default", () => {
    expect(procedureFlat).toMatch(/a statement is provided to the OAIC \*\*as soon as practicable\*\*/i);
  });

  it("individual notification requirement uses 'as soon as practicable'", () => {
    expect(procedureFlat).toMatch(/individuals at risk of serious harm are notified \*\*as soon as\s+practicable\*\*/i);
  });
});

describe("serious harm is assessed via checklist, not automatically scored", () => {
  it("explicitly states the serious-harm section is a checklist for human judgement, not an automated score", () => {
    expect(procedureFlat).toMatch(/A documented \*\*checklist for human judgement\*\*, not an automated score/i);
  });

  it("explicitly rejects a numeric threshold that legally determines serious harm", () => {
    expect(procedureFlat).toMatch(/not a numeric threshold that purports to legally determine serious\s+harm/i);
  });
});

describe("remedial action is considered as a distinct, load-bearing factor", () => {
  it("has a dedicated Remedial action section", () => {
    expect(procedure).toMatch(/## 15\. Remedial action/);
  });

  it("states remedial action that prevents likely serious harm makes the breach not eligible", () => {
    expect(procedureFlat).toMatch(/If remedial\s+action genuinely prevents the likely risk of serious harm, the incident\s+is a data breach but not an eligible data breach/i);
  });

  it("the assessment record template captures whether remedial action could prevent likely serious harm", () => {
    expect(assessmentRecord).toMatch(/Could remedial action prevent the likely risk of serious harm/i);
  });
});

describe("institution/customer coordination is separate from statutory NDB notification", () => {
  it("explicitly states contractual incident notification is separate from statutory NDB notification", () => {
    expect(procedureFlat).toMatch(/\*\*Contractual incident notification is separate from statutory NDB\s+notification\*\*/i);
  });

  it("states an institution may need notifying even where the NDB threshold is not established", () => {
    expect(procedureFlat).toMatch(/even where the NDB\s+statutory threshold has not been established/i);
  });
});

describe("multi-entity responsibility is determined per incident, not assumed", () => {
  it("has a dedicated Multi-entity incidents section", () => {
    expect(procedure).toMatch(/## 22\. Multi-entity incidents/);
  });

  it("states Tether does not automatically own either the assessment or notification role", () => {
    expect(procedureFlat).toMatch(/Do not assume Tether\s+automatically owns either role/i);
  });

  it("states the institution does not automatically own either role either", () => {
    expect(procedureFlat).toMatch(/Do not assume the institution\s+automatically owns either role either/i);
  });

  it("requires documenting the decision and rationale for which entity notifies", () => {
    expect(procedureFlat).toMatch(/Document the decision and rationale/i);
  });
});

describe("no invented legal entity/contact anywhere in the incident package", () => {
  const FORBIDDEN = [/Tether Pty Ltd/i, /privacy@tether/i, /\bABN\s*\d/i, /registered office at/i];

  for (const [name, content] of [
    ["procedure", procedure],
    ["assessment record", assessmentRecord],
    ["notification template", notificationTemplate],
    ["register template", registerTemplate],
  ] as const) {
    it(`${name} contains no fabricated company/ABN/registered-office/contact details`, () => {
      for (const pattern of FORBIDDEN) {
        expect(content).not.toMatch(pattern);
      }
    });
  }

  it("the notification template explicitly refuses to invent entity/contact details", () => {
    const flat = notificationTemplate.replace(/\s+/g, " ");
    expect(flat).toMatch(/never invented, never carried forward from a placeholder/i);
  });
});

describe("no automated OAIC/student/institution notification exists or is built", () => {
  it("has a dedicated 'No live incident automation' section", () => {
    expect(procedure).toMatch(/## No live incident automation/);
  });

  it("explicitly lists automatic OAIC, individual, and institution notification as not built", () => {
    const flat = procedureFlat;
    expect(flat).toMatch(/does \*\*not\*\* build: automatic\s+OAIC notification, automatic student\/individual notification, automatic\s+institution notification/i);
  });

  it("states the notification decision is made by a human and is never automated", () => {
    expect(procedureFlat).toMatch(/This decision is\s+made by a human with notification decision authority.*it\s+is never automated/i);
  });
});

describe("no secrets are invited into incident templates", () => {
  it("the assessment record explicitly forbids secrets/passwords/tokens", () => {
    expect(assessmentRecord).toMatch(/Do not put secrets in this record/i);
  });

  it("the register template explicitly forbids secrets/passwords/tokens", () => {
    expect(registerTemplate).toMatch(/Do NOT include sensitive secrets\/passwords\/token values/i);
  });
});

describe("the privacy package links to the new procedure instead of saying it's unwritten", () => {
  it("Section 23 links to docs/australian-incident-ndb-procedure-v1.md", () => {
    expect(privacyPackage).toMatch(/\[`docs\/australian-incident-ndb-procedure-v1\.md`\]/);
  });

  it("Section 23 no longer says the procedure is not yet written", () => {
    const section23Match = privacyPackage.match(/## 23\. Security incident cross-reference[\s\S]*?(?=\n## 24\.)/);
    expect(section23Match).not.toBeNull();
    expect(section23Match![0]).not.toMatch(/not yet\s+written/i);
  });

  it("links to all three supporting templates", () => {
    expect(privacyPackage).toMatch(/data-breach-assessment-record-v1\.md/);
    expect(privacyPackage).toMatch(/data-breach-notification-template-v1\.md/);
    expect(privacyPackage).toMatch(/privacy-incident-register-template-v1\.md/);
  });
});

describe("the four statutory notification content fields are represented", () => {
  it("the notification template's required-fields table includes entity name, entity contact, breach description, kinds of information, and recommended steps", () => {
    const flat = notificationTemplate.replace(/\s+/g, " ");
    expect(flat).toMatch(/Organisation\/entity name/i);
    expect(flat).toMatch(/Entity contact details/i);
    expect(flat).toMatch(/Description of the breach/i);
    expect(flat).toMatch(/Kinds of information involved/i);
    expect(flat).toMatch(/Recommended steps affected individuals should take/i);
  });

  it("the template is marked DRAFT — do not send without incident authority/legal review", () => {
    expect(notificationTemplate).toMatch(/DRAFT — DO NOT SEND WITHOUT INCIDENT AUTHORITY \/ LEGAL REVIEW WHERE\s*\nREQUIRED/i);
  });

  it("the template does not include an automatic admission of liability", () => {
    expect(notificationTemplate).toMatch(/contains no automatic admission of liability/i);
  });
});

describe("severity is explicitly an operations classification, not a legal determination", () => {
  it("states severity does not by itself determine eligible breach, serious harm, or OAIC notification", () => {
    expect(procedureFlat).toMatch(/It does not, by itself, determine\s+whether an incident is an eligible data breach, whether serious harm\s+exists, or whether OAIC notification is required/i);
  });
});

describe("[TETHER_AUSTRALIAN_NDB_LEGAL_PROCESS_CORRECTION_V1] remedial action vs. eligible-breach exception", () => {
  it("[1] effective remedial action can make a data breach non-eligible (not an exception applied afterward)", () => {
    expect(procedureFlat).toMatch(/If remedial\s+action genuinely prevents the likely risk of serious harm, the incident\s+is a data breach but not an eligible data breach/i);
    expect(procedureFlat).toMatch(/Effective\s+remedial action may mean a data breach is \*\*not\*\* an eligible data\s+breach in the first place/i);
  });

  it("[2] never says an already-eligible breach becomes non-notifiable merely because remedial action succeeded", () => {
    expect(procedure).not.toMatch(/Not every eligible data breach\s*\n?\s*automatically requires notifying OAIC/i);
    expect(procedureFlat).toMatch(/This document does not say a confirmed eligible\s+breach can be left unnotified because remedial action happened to\s+work/i);
  });

  it("keeps statutory exceptions conceptually separate from remedial action", () => {
    expect(procedureFlat).toMatch(/a distinct concept —\s+statutory exceptions, Section 24, are kept\s+separate from remedial action throughout this document/i);
  });
});

describe("[TETHER_AUSTRALIAN_NDB_LEGAL_PROCESS_CORRECTION_V1] suspected-eligible-breach trigger is not automatic", () => {
  it("[3] ordinary unauthorised access/disclosure alone does not automatically create the 'suspected eligible breach' label", () => {
    expect(procedureFlat).toMatch(/do not automatically apply the "suspected eligible data breach"\s+label to every ordinary data breach/i);
  });

  it("[4] the statutory assessment trigger is worded as reasonable grounds to suspect an eligible breach may have occurred", () => {
    expect(procedureFlat).toMatch(/triggered specifically\s+when Tether becomes aware of \*\*reasonable grounds to suspect that the\s+incident may have been an eligible data breach\*\*/i);
  });

  it("distinguishes a (possible) data breach — which always triggers triage/remedial action/coordination — from the narrower statutory trigger", () => {
    expect(procedureFlat).toMatch(/A \(possible or confirmed\) data breach, established by Section 12,\s+always triggers:\*\* ongoing privacy-impact triage, serious-harm\s+consideration/i);
    expect(procedureFlat).toMatch(/regardless of whether the incident ultimately turns\s+out to be an eligible data breach/i);
  });

  it("distinguishes voluntary/conservative assessment from the statutory trigger itself", () => {
    expect(procedureFlat).toMatch(/this document distinguishes that voluntary,\s+conservative choice from the\s+statutory trigger itself/i);
  });

  it("does not require certainty about serious harm before starting the assessment", () => {
    expect(procedureFlat).toMatch(/Do not require certainty about serious harm before starting the\s+assessment/i);
  });
});

describe("[TETHER_AUSTRALIAN_NDB_LEGAL_PROCESS_CORRECTION_V1] 30-day assessment remains a maximum, and notification remains as-soon-as-practicable", () => {
  it("[5] the assessment obligation remains 'reasonable and expeditious' with a 30-calendar-day maximum", () => {
    expect(procedureFlat).toMatch(/The assessment must be \*\*reasonable and expeditious\*\*\. \*\*30 calendar/i);
  });

  it("[6] if reasonable grounds to believe an eligible breach already exist, notification proceeds as soon as practicable rather than waiting out 30 days", () => {
    expect(procedureFlat).toMatch(/If reasonable grounds to BELIEVE an eligible breach already\s+exist/i);
    expect(procedureFlat).toMatch(/the procedure\s+moves to notification \(Sections 18–20\) as soon as practicable, rather\s+than continuing to run out an assessment/i);
  });
});

describe("[TETHER_AUSTRALIAN_NDB_LEGAL_PROCESS_CORRECTION_V1] law-enforcement involvement does not authorise delay on its own", () => {
  it("[7] states law-enforcement/ACSC involvement does not, by itself, authorise any delay to statutory notification", () => {
    expect(procedureFlat).toMatch(/\*\*Law enforcement\/ACSC involvement does not, by itself, authorise any\s+delay to statutory notification/i);
  });

  it("explicitly forbids self-authorised delay solely because law enforcement is involved", () => {
    expect(procedureFlat).toMatch(/an ordinary Tether\s+operating entity must \*\*not\*\* self-authorise a delay to statutory\s+notification solely because law enforcement or a cyber agency is\s+involved/i);
  });

  it("[8] represents the s 26WQ / OAIC declaration boundary accurately — the Commissioner decides, not Tether", () => {
    expect(procedureFlat).toMatch(/whether the OAIC\s+should be asked to make a declaration under s 26WQ of the Privacy Act/i);
    expect(procedureFlat).toMatch(/The\s+Commissioner may make such a declaration, including after considering\s+relevant advice from an enforcement body or the Australian Signals\s+Directorate \(ASD\)/i);
    expect(procedureFlat).toMatch(/this is the Commissioner's decision, not\s+Tether's own/i);
  });

  it("no longer describes a law-enforcement delay as a 'recognised, narrow exception' granted by this document itself", () => {
    expect(procedure).not.toMatch(/this is a recognised,\s*\n?\s*narrow exception, not a default extension/i);
  });

  it("Section 21's institution-notification rule no longer implies an automatic entitlement to delay for law enforcement", () => {
    expect(procedureFlat).toMatch(/does\s+not, by itself, create\s+an entitlement to postpone\s+institution notification/i);
  });
});

describe("[TETHER_AUSTRALIAN_NDB_LEGAL_PROCESS_CORRECTION_V1] jointly-held multi-entity assessment and notification", () => {
  it("[9] jointly held information permits a coordinated single assessment", () => {
    expect(procedureFlat).toMatch(/only one entity needs to perform the NDB assessment\*\* on behalf of\s+the group/i);
  });

  it("[10] jointly held information permits a coordinated single notification, as a separate decision", () => {
    expect(procedureFlat).toMatch(/\(separately\) \*\*only one entity needs to perform the\s+NDB notification\*\* for that jointly-held breach/i);
  });

  it("does not apply the jointly-held shortcut merely because two entities each separately hold different records about the same person", () => {
    expect(procedureFlat).toMatch(/Do not assume the\s+jointly-held rule applies merely because two entities each hold\s+different records about the same person/i);
  });

  it("[11] no entity automatically escapes responsibility because another entity might act", () => {
    expect(procedureFlat).toMatch(/If nobody actually performs the required assessment or\s+notification, "responsibility was shared between entities" is not a\s+defence/i);
  });

  it("the assessment record template captures jointly-held status and both the assessment and notification owners", () => {
    expect(assessmentRecord).toMatch(/Jointly held affected information\?/i);
    expect(assessmentRecord).toMatch(/Assessment entity\/owner/i);
    expect(assessmentRecord).toMatch(/Notification entity\/owner/i);
  });
});

describe("[TETHER_NDB_ASSESSMENT_CLOCK_TEMPLATE_FINAL_FIX] voluntary assessment does not create or reset the statutory clock", () => {
  it("[1] the template explicitly states a conservative/voluntary assessment does not itself create or reset the statutory clock", () => {
    expect(assessmentRecordFlat).toMatch(/\*\*A conservative\/voluntary assessment \(below\) does NOT itself create or\s+reset a statutory s 26WH assessment clock\.\*\*/i);
  });

  it("the voluntary-assessment fields are a distinct subsection from the statutory-trigger fields, not the same field", () => {
    expect(assessmentRecord).toMatch(/### Statutory trigger/);
    expect(assessmentRecord).toMatch(/### Conservative\/voluntary assessment \(separate from the statutory trigger\)/);
  });

  it("a YES on the voluntary-assessment field is explicitly stated to change nothing about the statutory-trigger fields", () => {
    expect(assessmentRecordFlat).toMatch(/A YES here, on its own, changes nothing about the statutory trigger\s+fields above/i);
  });

  it("the main procedure states a voluntary assessment does not itself create or reset a statutory clock", () => {
    expect(procedureFlat).toMatch(/a voluntary assessment does not itself\s+create or reset a statutory clock/i);
  });
});

describe("[TETHER_NDB_ASSESSMENT_CLOCK_TEMPLATE_FINAL_FIX] statutory clock starts from actual awareness of reasonable grounds to suspect an eligible breach", () => {
  it("[2] the template's statutory-trigger field asks about reasonable grounds to suspect an eligible breach, not a voluntary choice", () => {
    expect(assessmentRecord).toMatch(/Reasonable grounds to suspect there may have been an eligible data breach\?/i);
    expect(assessmentRecord).toMatch(/Statutory assessment trigger confirmed\?/i);
  });

  it("[TETHER_NDB_AWARENESS_DATE_FINAL_CORRECTION 1] the trigger awareness date/time field uses entity awareness of grounds/information, not mere existence of the grounds", () => {
    expect(assessmentRecordFlat).toMatch(/the earliest date\/time the relevant entity became aware of grounds or\s+information sufficient to create reasonable grounds to suspect there\s+may have been an eligible data breach/i);
  });

  it("[TETHER_NDB_AWARENESS_DATE_FINAL_CORRECTION 2] the trigger is not automatically the incident-occurrence date", () => {
    expect(assessmentRecordFlat).toMatch(/Do not use the incident date merely because the underlying\s+facts existed then if the entity was not yet aware of them/i);
  });

  it("[TETHER_NDB_AWARENESS_DATE_FINAL_CORRECTION 4] later formal classification/escalation cannot move an earlier actual-awareness date forward", () => {
    expect(assessmentRecordFlat).toMatch(/do not\s+move the date later merely because the incident was formally\s+classified or escalated later/i);
  });

  it("the main procedure's 30-day clock section starts the clock from actual awareness of the grounds causing suspicion", () => {
    expect(procedureFlat).toMatch(/the assessment clock starts \*\*the day after the\s+entity became aware of the grounds\/information that caused the\s+suspicion\*\*/i);
  });
});

describe("[TETHER_NDB_ASSESSMENT_CLOCK_TEMPLATE_FINAL_FIX] later reclassification cannot reset the statutory clock", () => {
  it("[3] the template states the statutory clock is never reset by a later reclassification", () => {
    expect(assessmentRecordFlat).toMatch(/never from the date someone later labelled an assessment "statutory,"\s+and never reset\s+by a later reclassification/i);
  });

  it("[TETHER_NDB_AWARENESS_DATE_FINAL_CORRECTION 5] later discovery of earlier actual awareness requires correcting the date backward to that actual-awareness date", () => {
    expect(assessmentRecordFlat).toMatch(/correct the\s+trigger-awareness date to that earlier actual-awareness date/i);
  });

  it("[TETHER_NDB_AWARENESS_DATE_FINAL_CORRECTION 3] objective existence of logs/evidence without awareness does not by itself set the recorded awareness date", () => {
    expect(assessmentRecordFlat).toMatch(/do not backdate it merely to when the incident or evidence objectively\s+existed without entity awareness/i);
  });

  it("does not leave the date at a later formal-classification date once an earlier actual-awareness date is established", () => {
    expect(assessmentRecordFlat).toMatch(/do not leave it at a later\s+formal-classification date once an earlier actual-awareness date is\s+established/i);
  });

  it("the main procedure's 30-day clock section states this date cannot be reset by a later reclassification", () => {
    expect(procedureFlat).toMatch(/\*\*This date cannot be\s+reset by a later reclassification\.\*\*/i);
  });

  it("the main procedure states the clock is calculated from the actual date the entity became aware of the statutory grounds, not their mere objective existence", () => {
    expect(procedureFlat).toMatch(/the clock is calculated from\s+the \*actual date the entity became aware\* of the statutory grounds —/i);
    expect(procedureFlat).toMatch(/never from the mere objective\s+existence of those grounds\/facts before\s*\n?anyone at the entity knew of them/i);
  });
});

describe("[TETHER_NDB_AWARENESS_DATE_FINAL_CORRECTION] entity-awareness framing preserved end to end", () => {
  it("[6] the voluntary assessment remains a distinct, separate track after this wording correction", () => {
    expect(assessmentRecord).toMatch(/### Statutory trigger/);
    expect(assessmentRecord).toMatch(/### Conservative\/voluntary assessment \(separate from the statutory trigger\)/);
    expect(assessmentRecordFlat).toMatch(/does NOT itself create or\s+reset a statutory s 26WH assessment clock/i);
  });

  it("the statutory clock still starts the day after entity awareness (Section 16 preserved)", () => {
    expect(procedureFlat).toMatch(/the assessment clock starts \*\*the day after the\s+entity became aware of the grounds\/information that caused the\s+suspicion\*\*/i);
  });

  it("30-day maximum and as-soon-as-practicable notification remain intact after this correction", () => {
    expect(procedureFlat).toMatch(/\*\*30 calendar\s+days is a maximum, not a target and not an entitlement to wait that\s+long\*\*/i);
    expect(procedureFlat).toMatch(/a statement is provided to the OAIC \*\*as soon as practicable\*\*/i);
  });

  it("later administrative reclassification still cannot reset the clock (Section 16 preserved)", () => {
    expect(procedureFlat).toMatch(/\*\*This date cannot be\s+reset by a later reclassification\.\*\*/i);
  });
});

describe("[TETHER_NDB_ASSESSMENT_CLOCK_TEMPLATE_FINAL_FIX] template has separate voluntary-assessment and statutory-trigger dates", () => {
  it("[4] the template has a distinct 'Voluntary assessment start date/time' field, separate from the statutory trigger awareness date", () => {
    expect(assessmentRecord).toMatch(/Voluntary assessment start date\/time/i);
    expect(assessmentRecord).toMatch(/trigger awareness date\/time/i);
  });

  it("the two date fields live in different subsections of the template", () => {
    const statutorySection = assessmentRecord.match(/### Statutory trigger[\s\S]*?(?=\n### Conservative)/);
    const voluntarySection = assessmentRecord.match(/### Conservative\/voluntary assessment[\s\S]*$/);
    expect(statutorySection).not.toBeNull();
    expect(voluntarySection).not.toBeNull();
    expect(statutorySection![0]).toMatch(/trigger awareness date\/time/i);
    expect(statutorySection![0]).not.toMatch(/Voluntary assessment start date\/time/i);
    expect(voluntarySection![0]).toMatch(/Voluntary assessment start date\/time/i);
    expect(voluntarySection![0]).not.toMatch(/trigger awareness date\/time/i);
  });
});

describe("[TETHER_NDB_ASSESSMENT_CLOCK_TEMPLATE_FINAL_FIX] 30-day maximum and as-soon-as-practicable notification remain intact", () => {
  it("[5] the 30-calendar-day maximum statement remains present and unweakened", () => {
    expect(procedureFlat).toMatch(/\*\*30 calendar\s+days is a maximum, not a target and not an entitlement to wait that\s+long\*\*/i);
    expect(assessmentRecord).toMatch(/30-calendar-day statutory maximum date/i);
  });

  it("[6] as-soon-as-practicable notification wording remains present for both OAIC and individual notification", () => {
    expect(procedureFlat).toMatch(/a statement is provided to the OAIC \*\*as soon as practicable\*\*/i);
    expect(procedureFlat).toMatch(/individuals at risk of serious harm are notified \*\*as soon as\s+practicable\*\*/i);
  });
});
