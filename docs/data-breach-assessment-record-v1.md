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

## Data breach determination

*(A broader, earlier question than eligibility — see procedure Section
12/13. YES or POSSIBLE here is what triggers serious-harm consideration,
remedial action, institution coordination, and documentation below —
it does NOT by itself mean the statutory "suspected eligible breach"
trigger has been met; that is assessed separately, below.)*

| Field | Value |
|---|---|
| Data breach / possible data breach? | YES / POSSIBLE / NO |
| Reasoning | |

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

*(This is the statutory trigger, distinct from "data breach /
possible data breach?" above — see procedure Section 13. It asks
whether there are reasonable grounds to suspect the incident MAY BE an
*eligible* data breach specifically — including a real possibility of
likely serious harm not clearly prevented by remedial action — not
merely whether a data breach of some kind occurred. Do not answer YES
here automatically just because "data breach / possible data breach?"
above was YES.)*

**A conservative/voluntary assessment (below) does NOT itself create or
reset a statutory s 26WH assessment clock.** The statutory clock, where
it applies, only ever starts the day after the entity **became aware**
of grounds or information sufficient to create reasonable grounds to
suspect there may have been an eligible data breach — never from the
date someone later labelled an assessment "statutory," and never reset
by a later reclassification.

**"Became aware" is about the entity's actual knowledge, not the
underlying facts' objective existence.** It is not the date the
incident occurred, or the date relevant logs/evidence objectively came
into being, if nobody at the entity was aware of them yet. It is also
not the date a formal classification, escalation, or board/CEO briefing
happened, if appropriate personnel already had the relevant grounds or
information earlier than that.

If later review establishes that the entity was actually aware of the
relevant grounds/information earlier than first recorded, **correct the
trigger-awareness date to that earlier actual-awareness date** — do
not backdate it merely to when the incident or evidence objectively
existed without entity awareness, and do not leave it at a later
formal-classification date once an earlier actual-awareness date is
established. The trigger-awareness field below is corrected to the
actual awareness date; it is never treated as newly starting on the
date of the correction itself.

### Statutory trigger

| Field | Value |
|---|---|
| Reasonable grounds to suspect there may have been an eligible data breach? | YES / NO / UNCERTAIN |
| Reasoning (why this does, or doesn't, meet the "reasonable grounds to suspect" threshold — certainty about serious harm is NOT required, but a plausible basis for suspecting it is) | |
| Statutory assessment trigger confirmed? | YES / NO / LEGAL REVIEW REQUIRED |
| If YES — trigger awareness date/time: the earliest date/time the relevant entity became aware of grounds or information sufficient to create reasonable grounds to suspect there may have been an eligible data breach. Do not use the incident date merely because the underlying facts existed then if the entity was not yet aware of them; equally, do not move the date later merely because the incident was formally classified or escalated later. (See the clock-reset note above.) | |
| If YES — assessment-clock start date (day after the trigger awareness date/time above) | |
| If YES — 30-calendar-day statutory maximum date | |
| Assessment status (updated as it proceeds) | |
| Blockers | |

### Conservative/voluntary assessment (separate from the statutory trigger)

| Field | Value |
|---|---|
| Conservative/voluntary assessment being conducted even though the statutory trigger is not established? | YES / NO |
| Reason for conducting it anyway (e.g. genuine doubt, awaiting legal review) | |
| Voluntary assessment start date/time | |

*(A YES here, on its own, changes nothing about the statutory trigger
fields above — it neither satisfies nor substitutes for "reasonable
grounds to suspect there may have been an eligible data breach." If the
statutory trigger is later confirmed while a voluntary assessment is
already underway, complete the "Statutory trigger" fields above using
the actual trigger-awareness date, which may predate the voluntary
assessment's own start date.)*

## Assessment outcome

*(Select one.)*

- [ ] Not a data breach
- [ ] Data breach, not likely serious harm
- [ ] Serious harm prevented by remedial action
- [ ] Eligible data breach
- [ ] Legal determination required

## Multi-entity coordination (if applicable)

*(See procedure Section 22. Do not assume the jointly-held rule applies
merely because Tether and an institution each separately hold some
overlapping information about the same person — it applies to the same
affected information genuinely held jointly, e.g. a shared record or a
dataset one entity manages on the other's behalf.)*

| Field | Value |
|---|---|
| Jointly held affected information? | YES / NO / UNCERTAIN |
| Assessment entity/owner | *(who is performing the NDB assessment — Tether, the institution, or agreed jointly; do not invent an entity name — name the actual party)* |
| Notification entity/owner | *(who will notify, if required — a separate coordination decision from the above; see procedure Section 22 item 3)* |
| Rationale | |

## Notification

| Field | Value |
|---|---|
| Notification required? | YES / NO / PENDING |
| Which entity will notify? | *(Tether / institution / jointly — matches "Notification entity/owner" above; see procedure Section 22 for multi-entity incidents; do not assume by default)* |
| OAIC notified date/time | |
| Individuals notified date/time | |
| Institution notified date/time (contractual — separate from the above; see procedure Section 21) | |

## Closure

| Field | Value |
|---|---|
| Corrective actions | |
| Review owner | |
| Closure date | |
