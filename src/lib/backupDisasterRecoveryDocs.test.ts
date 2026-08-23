/**
 * Tether Backup & Disaster Recovery Package v1 — see
 * docs/backup-and-disaster-recovery-runbook-v1.md.
 *
 * Static regression guard over documentation content (mirrors
 * src/lib/pilotUiTerminology.test.ts's and
 * src/lib/retentionExecutionSafetyDocs.test.ts's own pattern: read real
 * files on disk, normalise line-wrapping, assert on substrings/regex).
 * Locks the critical governance claims from this pass so a future edit
 * can't silently reintroduce an overstated, invented, or unsafe claim.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const runbook = read("docs/backup-and-disaster-recovery-runbook-v1.md");
const runbookFlat = runbook.replace(/\s+/g, " ");
const restoreTestRecord = read("docs/restore-test-record-v1.md");
const drChecklist = read("docs/dr-exercise-checklist-v1.md");
const drChecklistFlat = drChecklist.replace(/\s+/g, " ");
const backupVerifyRunbook = read("docs/production-backup-restore-runbook.md");
const privacyPackage = read("docs/privacy-and-evidence-retention-v1.md");
const ndbProcedure = read("docs/australian-incident-ndb-procedure-v1.md");

describe("[1] Supabase Free-plan baseline does not claim automatic backups", () => {
  it("states the Free plan does not include automatic database backups, and Tether does not rely on any", () => {
    expect(runbookFlat).toMatch(/does\s+not include automatic database backups/i);
    expect(runbookFlat).toMatch(/Tether does not currently rely on any\s+provider-managed Production database backup/i);
  });

  it("states there is no scheduled, verified Production database-backup cadence", () => {
    expect(runbookFlat).toMatch(/Tether currently has no documented, verified, scheduled Production\s+database-backup cadence/i);
  });

  it("marks this as a PRE-PILOT BACKUP GATE", () => {
    expect(runbook).toMatch(/\*\*PRE-PILOT BACKUP GATE\.\*\*/);
  });
});

describe("[2] no numerical RPO/RTO commitment is stated", () => {
  it("all four RPO/RTO metrics are marked not yet committed or verified", () => {
    for (const metric of ["Database RPO", "Database RTO", "Evidence RPO", "Full-service RTO"]) {
      expect(runbook).toMatch(new RegExp(`\\| ${metric} \\| \\*\\*NOT YET CONTRACTUALLY COMMITTED OR VERIFIED\\*\\*`));
    }
  });

  it("the candidate/measured RPO/RTO fields table exists but is left blank in this pass", () => {
    expect(runbookFlat).toMatch(/Candidate pilot RPO \(database\)/i);
    expect(runbookFlat).toMatch(/left blank in this pass/i);
  });

  it("does not state a specific number of hours/days as an RPO or RTO commitment", () => {
    expect(runbook).not.toMatch(/RPO (is|of) \d+/i);
    expect(runbook).not.toMatch(/RTO (is|of) \d+/i);
  });
});

describe("[3] backup:verify is documented as verification of an existing dump, not backup creation", () => {
  it("the runbook states backup:verify does not create a backup", () => {
    expect(runbookFlat).toMatch(/does \*\*not\*\* create a backup;/i);
    expect(runbookFlat).toMatch(/accepts an existing database dump file/i);
  });

  it("the source sub-runbook itself states the same distinction", () => {
    expect(backupVerifyRunbook).toMatch(/Does not:\*\* create the backup itself/i);
  });

  it("the runbook calls it a strong verification control, not a scheduling/creation system", () => {
    expect(runbookFlat).toMatch(/This is a strong\s+verification control\. It is not a backup\s+scheduling\/creation system/i);
  });
});

describe("[4] restoreRehearsal is disposable/non-production only", () => {
  it("the runbook states the restore rehearsal is structurally incapable of targeting Production", () => {
    expect(runbookFlat).toMatch(/is \*\*structurally\s+incapable\*\* of targeting Production for its restore\s+rehearsal/i);
  });

  it("references the shared requireDisposableDatabaseUrl guard reused from release:validate", () => {
    expect(runbookFlat).toMatch(/requireDisposableDatabaseUrl.{0,40}npm run release:validate/i);
  });

  it("the DR checklist requires proving the destination is non-production before proceeding, and stops otherwise", () => {
    expect(drChecklist).toMatch(/destination cannot be proven non-production/i);
  });
});

describe("[5] database backups do not cover Supabase Storage object bytes", () => {
  it("states this as a locked, capitalised claim", () => {
    expect(runbookFlat).toMatch(/Supabase database backups do not restore Storage\s+object bytes/i);
  });

  it("clarifies the database may contain metadata but never the object bytes", () => {
    expect(runbookFlat).toMatch(/database backup may contain \*metadata\* referencing a storage object,\s+never the object's actual bytes/i);
    expect(runbookFlat).toMatch(/but the actual camera\/screen-share evidence bytes are a \*\*separate\*\*\s+recovery domain/i);
  });
});

describe("[6] database and evidence-byte recovery are separate", () => {
  it("Section 10 explicitly separates the row-recovery domain from the bytes-recovery domain", () => {
    expect(runbook).toMatch(/## 10\. Evidence metadata vs evidence bytes/);
    expect(runbookFlat).toMatch(/recovered, if at all, as part of the \*\*database\*\*\s+recovery domain/i);
    expect(runbookFlat).toMatch(/recovered, if at all, as part of the\s+\*\*evidence-storage\*\* recovery domain/i);
  });

  it("principle 8 states database and Storage-object recovery are separate domains", () => {
    expect(runbookFlat).toMatch(/\*\*Database recovery and Storage-object recovery are separate\s+domains\.\*\*/i);
  });
});

describe("[7] real evidence archive project remains a pre-pilot gate", () => {
  it("states no real archive project has been provisioned", () => {
    expect(runbookFlat).toMatch(/no real archive Supabase\s+project has been provisioned, no archive credentials are configured in\s+Vercel, and no Production evidence has ever been archived/i);
  });

  it("marks this ARCHITECTURALLY IMPLEMENTED BUT NOT ACTIVATED, and a PRE-PILOT EVIDENCE-RECOVERY GATE", () => {
    expect(runbookFlat).toMatch(/ARCHITECTURALLY IMPLEMENTED, BUT CLOUD RECOVERY PATH NOT YET ACTIVATED\s+OR TESTED/i);
    expect(runbook).toMatch(/\*\*PRE-PILOT EVIDENCE-RECOVERY GATE\*\*/);
  });
});

describe("[8] archive metadata reconstruction after DB rollback remains manual", () => {
  it("states no automated relational reconstruction exists", () => {
    expect(runbookFlat).toMatch(/does \*\*not\*\* claim any automated\s+reconstruction exists/i);
    expect(runbookFlat).toMatch(/relational-metadata reconstruction from archive\s+manifests is \*\*not implemented\*\*/i);
  });

  it("requires manual investigation/reconciliation for the orphaned-object scenario", () => {
    expect(runbookFlat).toMatch(/\*\*MANUAL INVESTIGATION \/ RECONCILIATION\s+REQUIRED\*\*/i);
  });
});

describe("[9] Vercel Hobby recovery does not assume paid-plan rollback capability", () => {
  it("states the current plan is Hobby and does not assume Pro/Enterprise-only rollback", () => {
    expect(runbookFlat).toMatch(/on the\s+\*\*Hobby\*\* team plan/i);
    expect(runbookFlat).toMatch(/does not state a specific\s+Pro\/Enterprise-only instant-rollback capability as available, since it\s+has not been independently verified on Hobby/i);
  });
});

describe("[10] known-good Git commit is an application recovery source", () => {
  it("states GitHub/Git history is the primary source of truth for code recovery", () => {
    expect(runbookFlat).toMatch(/GitHub \(`wasif553\/tether`\) is the primary source of\s+truth for application code/i);
  });

  it("the application recovery sequence starts with identifying a known-good commit", () => {
    expect(runbookFlat).toMatch(/Identify the known-good commit/i);
  });
});

describe("[11] no Production restore automation is created", () => {
  it("states no Production restore proceeds without explicit human sign-off", () => {
    expect(runbookFlat).toMatch(/\*\*No Production restore proceeds without explicit\s+sign-off from restore\s+approval authority/i);
  });

  it("states DR is human-authorised, not automatic", () => {
    expect(runbookFlat).toMatch(/\*\*DR is human-authorised, not automatic\.\*\*/i);
  });

  it("the DR checklist explicitly excludes 'restore directly into Production' as a routine exercise type", () => {
    expect(drChecklist).toMatch(/"Restore directly into Production" is not a routine\s+exercise type and\s+does not appear above/i);
  });
});

describe("[12] restore test record prohibits secrets", () => {
  it("the restore test record explicitly forbids secret values", () => {
    expect(restoreTestRecord).toMatch(/Do not put secret values in this record/i);
  });

  it("the DR checklist requires confirming no secret values were written into exercise records", () => {
    expect(drChecklist).toMatch(/Confirmed no secret \*\*values\*\* were written into this checklist/i);
  });
});

describe("[13] DR checklist has fail-closed stop conditions", () => {
  it("states 'fail closed' explicitly", () => {
    expect(drChecklist).toMatch(/\*\*Fail closed\.\*\*/);
  });

  it("lists all required stop conditions", () => {
    const required = [
      "Backup source cannot be identified",
      "Checksum/format verification fails",
      "recovery point is ambiguous",
      "cannot be proven non-production",
      "healthy Production without explicit disaster",
      "credential ownership is unclear",
      "same failure domain where separation is required",
      "Legal/privacy hold status is unknown",
      "contacting a real student or institution unexpectedly",
    ];
    for (const phrase of required) {
      expect(drChecklistFlat).toMatch(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    }
  });
});

describe("[14] RPO and RTO are measured in the restore record but not promised", () => {
  it("the restore test record's RPO/RTO fields are explicitly measured-only", () => {
    expect(restoreTestRecord).toMatch(/RPO measured.{0,10}\|.{0,10}\*\(only after this test actually produces a number/i);
    expect(restoreTestRecord).toMatch(/RTO measured.{0,10}\|.{0,10}\*\(only after this test actually produces a number/i);
  });

  it("the DR checklist states RPO/RTO are measured only, never a pre-committed target", () => {
    expect(drChecklist).toMatch(/measured only, never a pre-committed target/i);
  });
});

describe("[15] retention reconciliation after restore is required", () => {
  it("Section 29 states a restore is not privacy-neutral and forbids immediate broad deletion", () => {
    expect(runbookFlat).toMatch(/This is important — a restore is not privacy-neutral/i);
    expect(runbookFlat).toMatch(/do not immediately run broad deletion/i);
  });

  it("the restore test record has a retention-reconciliation-required field", () => {
    expect(restoreTestRecord).toMatch(/Retention reconciliation required\?/i);
  });
});

describe("[16] active hold handling is represented", () => {
  it("Section 29 requires preserving anything subject to an active hold", () => {
    expect(runbookFlat).toMatch(/Preserve anything subject to an active\s+incident, legal, or academic hold — never destroy it as part of\s+"cleaning up" the restore/i);
  });

  it("the restore test record has a legal/academic-hold field", () => {
    expect(restoreTestRecord).toMatch(/Legal\/academic hold present\?/i);
  });

  it("the DR checklist stops if hold status is unknown when affected data could be overwritten", () => {
    expect(drChecklistFlat).toMatch(/STOP if legal\/privacy hold status is unknown when affected data could\s+be overwritten or deleted/i);
  });
});

describe("[17] Incident/NDB cross-reference exists", () => {
  it("the runbook's Section 30 cross-references the NDB procedure", () => {
    expect(runbook).toMatch(/## 30\. Incident\/NDB coordination/);
    expect(runbookFlat).toMatch(/docs\/australian-incident-ndb-procedure-v1\.md/);
  });

  it("the NDB procedure cross-references the DR runbook back", () => {
    expect(ndbProcedure).toMatch(/docs\/backup-and-disaster-recovery-runbook-v1\.md/);
  });
});

describe("[18] service reopening requires validation", () => {
  it("states 'no automatic reopening' explicitly", () => {
    expect(runbook).toMatch(/\*\*No automatic reopening\.\*\*/);
  });

  it("requires restore approval authority to explicitly approve reopening", () => {
    expect(runbookFlat).toMatch(/restore approval authority \(Section 16\) explicitly\s+approves reopening/i);
  });

  it("the DR checklist's reopening section also requires no automatic reopening", () => {
    expect(drChecklist).toMatch(/\*\*No automatic reopening\.\*\*/);
  });
});

describe("[19] Storage/evidence sample verification is represented", () => {
  it("the restore test record requires sample evidence + SHA-256 verification", () => {
    expect(restoreTestRecord).toMatch(/Sample primary evidence available\?/i);
    expect(restoreTestRecord).toMatch(/SHA-256 matches\?/i);
  });

  it("the runbook's post-restore validation requires accessible evidence bytes for a sample, not just metadata", () => {
    expect(runbookFlat).toMatch(/required\s+evidence bytes are actually accessible for a sample of\s+assets, not merely their metadata rows/i);
  });
});

describe("[20] Secure Browser installer/release artifact recovery is represented", () => {
  it("has a dedicated Section 14 covering installer/hash/signing/release-notes recovery", () => {
    expect(runbook).toMatch(/## 14\. Secure Browser release artifact recovery/);
    expect(runbook).toMatch(/\*\*PRE-PILOT RELEASE-ARTIFACT BACKUP GATE\*\*/);
  });

  it("does not claim the browser is rebuilt or modified by this runbook", () => {
    expect(runbookFlat).toMatch(/This runbook does not rebuild, resign, or modify the Secure Browser\s+installer/i);
  });
});

describe("[TETHER_DR_SECURE_BROWSER_RELEASE_METADATA_CORRECTION] Secure Browser release-metadata boundary", () => {
  it("[1] recognises the apps/lockdown native source version is v1.7.6", () => {
    expect(runbookFlat).toMatch(/The native client source itself currently identifies as\s+\*\*v1\.7\.6\*\* \(`LOCKDOWN_VERSION = "1\.7\.6"` in\s+`apps\/lockdown\/src\/shared\.ts`\)/i);
  });

  it("[2] recognises distribution/release-candidate metadata is stale at v1.7.4", () => {
    expect(runbookFlat).toMatch(/`src\/lib\/tetherReleaseMetadata\.ts` — the release-candidate\/\s+distribution metadata actually served to clients — still identifies\s+the current release candidate as \*\*v1\.7\.4\*\*/i);
  });

  it("[3] recognises docs/tether-release-management.md is stale at v1.7.2", () => {
    expect(runbookFlat).toMatch(/`docs\/tether-release-management\.md` — the release-management\s+document's own release table — still identifies \*\*v1\.7\.2\*\*/i);
  });

  it("[4] calls this a release-metadata reconciliation gap, not merely a hash issue", () => {
    expect(runbookFlat).toMatch(/the authoritative release-artifact record has not\s+yet been reconciled after the subsequent native-client releases/i);
    expect(runbook).toMatch(/\*\*PRE-PILOT SECURE-BROWSER RELEASE-METADATA RECONCILIATION\s+GATE\*\*/);
  });

  it("[5] does not claim these are conflicting hashes for the same installer version", () => {
    expect(runbookFlat).toMatch(/\*\*This is not merely a hash mismatch for one installer\.\*\*/i);
    expect(runbookFlat).toMatch(/these are three different version numbers from three different\s+sources/i);
    expect(runbook).not.toMatch(/differ between `docs\/tether-release-management\.md`'s release\s*\ntable and the `CURRENT_INSTALLER_SHA256`/i);
  });

  it("[6] requires the authoritative release record to include version, filename, SHA-256, provenance, acceptance, signing, notes, and artifact location", () => {
    const requiredFields = [
      "\\*\\*exact version\\*\\*",
      "\\*\\*installer filename\\*\\*",
      "\\*\\*SHA-256\\*\\*",
      "\\*\\*source/build provenance\\*\\*",
      "\\*\\*physical acceptance status\\*\\*",
      "\\*\\*code-signing status\\*\\*",
      "\\*\\*release notes\\*\\*",
      "\\*\\*recoverable artifact location\\*\\*",
    ];
    for (const field of requiredFields) {
      expect(runbookFlat).toMatch(new RegExp(field, "i"));
    }
  });

  it("[7] treats release-metadata reconciliation and artifact backup as two separate pre-pilot gates", () => {
    expect(runbookFlat).toMatch(/Two related but distinct gates follow from this — do not conflate\s+them/i);
    expect(runbook).toMatch(/\*\*PRE-PILOT SECURE-BROWSER RELEASE-METADATA RECONCILIATION\s+GATE\*\*/);
    expect(runbook).toMatch(/\*\*PRE-PILOT RELEASE-ARTIFACT BACKUP GATE\*\*/);
  });

  it("[8] the DR checklist verifies a retrieved installer against the authoritative SHA-256 before considering artifact recovery successful", () => {
    expect(drChecklistFlat).toMatch(/Retrieved installer's SHA-256 matches the authoritative release\s+record\?/i);
    expect(drChecklistFlat).toMatch(/matches\s+the single record established by the reconciliation gate above/i);
  });

  it("does not modify apps/lockdown, copy an installer, or update release-metadata constants", () => {
    expect(drChecklistFlat).toMatch(/this exercise does not modify\s+`apps\/lockdown`, copy an installer, or update release-metadata\s+constants/i);
    expect(runbookFlat).toMatch(/does not update any release-metadata constant/i);
  });
});

describe("[21] existing production-backup-restore-runbook is cross-linked rather than discarded", () => {
  it("the sub-runbook still exists and is not deleted", () => {
    expect(backupVerifyRunbook.length).toBeGreaterThan(500);
  });

  it("the sub-runbook now identifies itself as the detailed database-backup-verification sub-runbook", () => {
    expect(backupVerifyRunbook).toMatch(/This is the detailed, technical database-backup-verification\s+sub-runbook/i);
  });

  it("the sub-runbook links forward to the umbrella DR runbook", () => {
    expect(backupVerifyRunbook).toMatch(/docs\/backup-and-disaster-recovery-runbook-v1\.md/);
  });

  it("the umbrella runbook links back to the sub-runbook and does not restate its exact tool mechanics as new claims", () => {
    expect(runbookFlat).toMatch(/docs\/production-backup-restore-runbook\.md/);
  });

  it("the sub-runbook's own safety-guarantee wording is preserved, not weakened", () => {
    expect(backupVerifyRunbook).toMatch(/Does not, under any circumstance, connect this tool's restore\s+rehearsal to Production/i);
  });

  it("the privacy package's backup-boundary section no longer calls the DR runbook 'not yet written'", () => {
    const section21Match = privacyPackage.match(/## 21\. Backup\/deletion boundary[\s\S]*?(?=\n## 22\.)/);
    expect(section21Match).not.toBeNull();
    expect(section21Match![0]).toMatch(/docs\/backup-and-disaster-recovery-runbook-v1\.md/);
    expect(section21Match![0]).not.toMatch(/not yet\s+written/i);
  });
});

describe("no secret values appear anywhere in this documentation package", () => {
  const FORBIDDEN = [/SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S/i, /DATABASE_URL\s*=\s*postgres/i, /AUTH_SECRET\s*=\s*\S/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  for (const [name, content] of [
    ["runbook", runbook],
    ["restore test record", restoreTestRecord],
    ["DR checklist", drChecklist],
  ] as const) {
    it(`${name} contains no secret-looking assigned values`, () => {
      for (const pattern of FORBIDDEN) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

describe("no invented RPO/RTO contractual commitment or fabricated recovery guarantee", () => {
  it("never claims Production restore has actually been tested", () => {
    expect(runbook).not.toMatch(/Production restore has been (successfully )?tested/i);
  });

  it("never claims the separate archive project currently exists", () => {
    expect(runbook).not.toMatch(/the (separate )?archive project (currently exists|has been provisioned)\b/i);
  });
});
