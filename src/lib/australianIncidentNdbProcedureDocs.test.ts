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
const notificationTemplate = read("docs/data-breach-notification-template-v1.md");
const registerTemplate = read("docs/privacy-incident-register-template-v1.md");
const privacyPackage = read("docs/privacy-and-evidence-retention-v1.md");

describe("not every data breach is NDB-notifiable / applicability is conditional", () => {
  it("states not every breach requires OAIC notification", () => {
    expect(procedureFlat).toMatch(/not every data breach is a notifiable/i);
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

  it("states Tether does not automatically own the notification obligation", () => {
    expect(procedureFlat).toMatch(/Do not assume Tether automatically owns the\s+notification obligation/i);
  });

  it("states the institution does not automatically own it either", () => {
    expect(procedureFlat).toMatch(/Do not assume the institution automatically\s+owns it either/i);
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
