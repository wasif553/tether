# Privacy Incident Register Template v1

**One row per incident.** Maintain this register (spreadsheet or
equivalent, access-restricted to authorised administrators) alongside
the per-incident `docs/data-breach-assessment-record-v1.md` copies — the
register is the summary/index; the assessment record is the detail. See
`docs/australian-incident-ndb-procedure-v1.md`, Section 26.

**Do NOT include sensitive secrets/passwords/token values in this
register** — no credential material, even redacted-looking, in any
column. If a column would naturally invite that (e.g. "root cause"),
describe the category of weakness, not the exploitable specifics.

## Columns

| Column | Description |
|---|---|
| Incident ID | |
| Detected at | |
| Awareness at | The 30-day-clock reference point (procedure Section 16) — may differ from "detected at" |
| Reported by | |
| Severity | SEV-1 / SEV-2 / SEV-3 / SEV-4 (procedure Section 6 — operations classification only, not a legal conclusion) |
| Institution | |
| Incident type | |
| Data classes | From the assessment record's "Information involved" checklist |
| Individuals affected estimate | |
| Containment status | |
| NDB assessment required | YES / NO / LEGAL REVIEW REQUIRED |
| 30-day deadline | Only populated if a suspected-eligible-breach assessment was opened |
| Assessment status | |
| Eligible breach decision | Not a data breach / Data breach, not likely serious harm / Serious harm prevented by remedial action / Eligible data breach / Legal determination required |
| Notification owner | Which entity is notifying, if applicable (procedure Section 22) |
| Institution notified | Date/time — contractual notification, separate from statutory (procedure Section 21) |
| OAIC notified | Date/time, if applicable |
| Individuals notified | Date/time, if applicable |
| Root cause | Category-level description only — no exploitable specifics |
| Corrective action | With owner and target date (procedure Section 28) |
| Closed at | |
| Review owner | |

## Notes

- Every incident that reaches triage (procedure Section 11) gets a row,
  including one ultimately assessed as "not a data breach" — the
  conclusion and its reasoning stay reviewable later.
- This register does not itself enforce the 30-day clock — the
  assessment record and the assessment owner (procedure Section 7) do
  that; this register is where the deadline is visible at a glance
  across all open incidents.
