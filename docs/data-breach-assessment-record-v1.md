# Data Breach Assessment Record v1 (Fillable Template)

**Use one copy of this template per incident.** See
`docs/australian-incident-ndb-procedure-v1.md` for the full procedure
this record supports — this template does not itself explain the
process, only captures its outputs.

**This template does not determine the legal outcome.** Every field
below records a factual observation or a human decision made under the
procedure; filling in a field is not the same as that field's content
being legally correct or final. Fields marked "LEGAL REVIEW REQUIRED"
are a legitimate, expected outcome, not a failure to complete the
template.

**Do not put secrets in this record** — no passwords, API keys, session
tokens, or private key material, even redacted-looking ones. Reference
where such material lived/was rotated, never the material itself.

---

## Identification

| Field | Value |
|---|---|
| Incident ID | |
| Date/time detected | |
| Date/time Tether became aware | (may differ from detected — e.g. reported by a provider some time after their own detection; this is the reference point for the 30-day clock, Section 16 of the procedure) |
| Reporter | |
| Incident lead | |
| Assessment owner | |
| Affected institution(s) | |
| Systems affected | |

## Incident description

*(Factual narrative — what is currently known, stated as known; what is
still being assessed, stated as still being assessed. No speculation
presented as fact — see the procedure's Section 5.)*

## Information involved

*(Check all that plausibly apply; refine as the assessment proceeds.)*

- [ ] Names
- [ ] Student identifiers
- [ ] Emails
- [ ] Answers
- [ ] Grades
- [ ] Integrity events
- [ ] Raw IP / network evidence
- [ ] Camera stills
- [ ] Screen-share stills
- [ ] Authentication/session data
- [ ] AI-assistance records
- [ ] Other: ______

| Field | Value |
|---|---|
| Estimated number of individuals | |
| Estimated number of records | |

## What happened?

| Question | Answer |
|---|---|
| Unauthorised access? | YES / NO / UNKNOWN |
| Unauthorised disclosure? | YES / NO / UNKNOWN |
| Loss (with likely unauthorised access/disclosure)? | YES / NO / UNKNOWN |
| How was it contained? | |

## Remedial action

| Question | Answer |
|---|---|
| Could remedial action prevent the likely risk of serious harm? | YES / NO / PARTIAL |
| What remedial action was taken, and when? | |
| Why does (or doesn't) it prevent the likely risk of serious harm? | *(a factual, defensible conclusion — not a technicality; see procedure Section 15)* |

## Serious-harm factors considered

*(Use the checklist in the procedure's Section 14 — record the factors
actually weighed and the reasoning, not only a conclusion.)*

- Kind/sensitivity of the information:
- Information exposed in combination:
- Security protections in place / were they compromised:
- Who obtained or could plausibly obtain it:
- Nature of potential harm (identity theft/fraud, reputational, psychological, discrimination, physical safety):
- Likelihood of actual misuse:
- Could this unfairly affect a student specifically (integrity-evidence context)?:
- Vulnerability of affected individuals:
- Duration/accessibility of exposure:
- Effect of remedial action already completed:

## NDB scheme applicability

| Field | Value |
|---|---|
| NDB scheme applicable to the relevant entity? | YES / NO / LEGAL REVIEW REQUIRED |
| Reason | |

## Suspected eligible breach?

| Field | Value |
|---|---|
| Suspected eligible breach? | YES / NO |
| If YES — assessment-clock start date (day after awareness) | |
| If YES — 30-calendar-day statutory maximum date | |
| Assessment status (updated as it proceeds) | |
| Blockers | |

## Assessment outcome

*(Select one.)*

- [ ] Not a data breach
- [ ] Data breach, not likely serious harm
- [ ] Serious harm prevented by remedial action
- [ ] Eligible data breach
- [ ] Legal determination required

## Notification

| Field | Value |
|---|---|
| Notification required? | YES / NO / PENDING |
| Which entity will notify? | *(Tether / institution / jointly — see procedure Section 22 for multi-entity incidents; do not assume by default)* |
| OAIC notified date/time | |
| Individuals notified date/time | |
| Institution notified date/time (contractual — separate from the above; see procedure Section 21) | |

## Closure

| Field | Value |
|---|---|
| Corrective actions | |
| Review owner | |
| Closure date | |
