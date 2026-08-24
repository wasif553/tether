# Configuration Recovery Test Record v1 (Fillable Template)

**Use one copy of this template per configuration-recovery exercise or
real event.** See
[`docs/configuration-and-secrets-recovery-v1.md`](configuration-and-secrets-recovery-v1.md)
for the full recovery framework, and
[`docs/configuration-reconstruction-checklist-v1.md`](configuration-reconstruction-checklist-v1.md)
/
[`docs/configuration-loss-dr-exercise-checklist-v1.md`](configuration-loss-dr-exercise-checklist-v1.md)
for the step-by-step checklists this record supports.

**Do not put secret values in this record** — no passwords, connection
strings, API keys, private keys, or service-role keys, even
redacted-looking ones. Reference environment-variable **names** or
recovery-class labels only, never values.

---

## Identification

| Field | Value |
|---|---|
| Exercise/Test ID | |
| Date/time | |
| Operator role | *(e.g. "Authorised platform owner/operator" — see docs/configuration-and-secrets-recovery-v1.md Section 18)* |
| Source commit | |
| Scenario | *(loss / suspected compromise / clean-environment reconstruction / real event)* |
| Environment | *(disposable local / disposable Vercel project / real Production — real Production only under the DR runbook's Section 23 approval boundary)* |

## Recovery source tested

| Field | Value |
|---|---|
| Recovery source(s) exercised | *(e.g. "synthetic local values generated for this test" — never a real vault name until one is actually approved)* |
| Authoritative recovery source status at time of test | NOT YET SELECTED *(expected — do not silently mark this closed)* |

## Configuration categories tested

*(Check every category this exercise actually covered — do not check one
that was skipped.)*

- [ ] Database connection
- [ ] Authentication (`AUTH_SECRET`)
- [ ] Exam integrity secrets (`EXAM_BINDING_HMAC_SECRET` / `NETWORK_EVIDENCE_SALT`)
- [ ] Evidence storage
- [ ] Secure-client/SEB signing and key encryption
- [ ] Canvas/LTI (if enabled)
- [ ] Optional providers (AI, email, geolocation)
- [ ] Preview/Production separation

## Secrets recovered/reissued (NAMES ONLY)

| Variable name | Recovery class used | Recovered exact value? / Reissued? |
|---|---|---|
| | | |
| | | |

## Values never recorded — confirmation

- [ ] Confirmed no secret VALUE was written anywhere in this record, the
      accompanying checklist, exercise notes, chat, or a commit.
- [ ] Confirmed `npm run config:recovery-audit` was run and its output
      (names/status only) was the only tool output reviewed for this
      exercise — never a raw environment dump.

## Deployment/configuration reconstruction steps performed

*(Reference `docs/configuration-reconstruction-checklist-v1.md`'s
section letters, e.g. "A–D, F, J–L completed; E, G, I skipped — no
Canvas/AI/evidence-storage configured for this exercise.")*

## Validation evidence

| Check | Result |
|---|---|
| `npm run config:recovery-audit` | PASS / FAIL |
| Application boots | YES / NO |
| Authentication works | YES / NO / N/A |
| `GET /api/readiness` shows no dangerous combination | YES / NO |
| No secret exposed as `NEXT_PUBLIC_*` | CONFIRMED / NOT CHECKED |
| Logs spot-checked for credential exposure | CONFIRMED / NOT CHECKED |

## Failures

*(List anything that did not work as expected — including a step that
could not be exercised at all, e.g. "no real Vercel project available in
this environment; command construction verified only.")*

## Corrective actions

| Field | Value |
|---|---|
| Owner | |
| Due date | |
| Retest required? | YES / NO |

## Timing

| Field | Value |
|---|---|
| Start timestamp | |
| End timestamp | |
| Observed recovery duration | *(measured only — see "RTO note" below; never a target)* |

**RTO note:** an observed duration from this exercise MAY later inform a
contractual RTO decision — it is never itself one. Do not describe this
record's duration figure as a committed RTO.

## Result

*(Select one.)*

- [ ] PASS
- [ ] PARTIAL
- [ ] FAIL

## Reviewer/sign-off

| Field | Value |
|---|---|
| Reviewer | |
| Review date | |

## Follow-up items

| Item | Owner | Due date |
|---|---|---|
| | | |
