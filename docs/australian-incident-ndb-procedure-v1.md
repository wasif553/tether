# Tether Australian Privacy Incident + Notifiable Data Breach Procedure v1

**This is an internal incident-response governance document, not legal
advice and not a compliance certification.** It is written to support an
APP-aligned (Australian Privacy Principles) incident-response approach,
informed by current OAIC guidance on the Notifiable Data Breaches (NDB)
scheme (Privacy Act 1988, Part IIIC) as the governance baseline. It does
not reproduce OAIC guidance or Privacy Act text; it states how Tether's
actual operations, systems, and decisions relate to that scheme.

**NDB statutory applicability must be confirmed for the relevant entity
and incident.** Tether's legal entity/company structure and final
customer contracts are not yet settled as of this pass. This document
does **not** claim Tether is definitely subject to the Privacy Act/NDB
scheme, and does **not** claim Tether is exempt from it — both are
determinations that depend on facts (entity structure, turnover,
contract terms, the nature of a specific incident) not yet fixed, and
neither this document nor any individual following it may make that
determination unilaterally. Where this document says "Tether," read it
as "the operating entity providing the Tether platform," whichever
entity that turns out to be.

This document follows `docs/privacy-and-evidence-retention-v1.md` and
`docs/institution-privacy-responsibilities-v1.md` as its governance
predecessors and does not reopen or restate their completed content
except where directly relevant to incident response.

---

## Incident response flow (overview)

This is the operational sequence the numbered sections below implement.
It is a **sequence, not a set of automatic gates** — each arrow is a
human decision point (Sections 7/18), and an incident can exit the flow
early at several points (e.g. "not a data breach" at Personal
Information Involved?, or "not eligible" after Remedial Action).

```
DETECT
  ↓
RECORD                              (Section 26 register entry opens)
  ↓
CONTAIN                             (Section 9 — never destroys evidence)
  ↓
PRESERVE EVIDENCE                   (Section 10)
  ↓
ASSESS SCOPE                        (Section 11 — initial triage)
  ↓
PERSONAL INFORMATION INVOLVED? ──── NO ──→ close as operational-only (Section 11)
  ↓ YES
REMEDIAL ACTION                     (Section 15 — as available, ongoing)
  ↓
NDB APPLICABILITY GATE              (Section 17 — YES / NO / LEGAL REVIEW)
  ↓
SUSPECTED ELIGIBLE BREACH? ──────── NO ──→ record conclusion, close (Section 18)
  ↓ YES (where NDB scheme applies)
30-DAY ASSESSMENT TRACK             (Section 16 — maximum, not a target)
  ↓
ELIGIBLE BREACH? ─────────────────  NO (remedial action prevented harm,
  ↓ YES                                  or no likely serious harm) ──→ record, close (Section 18)
NOTIFY IF REQUIRED                  (Sections 19–20 — as soon as practicable)
  ↓
RECOVER
  ↓
POST-INCIDENT REVIEW                (Section 27)
  ↓
CORRECTIVE ACTION                   (Section 28)
```

Institution coordination (Section 21/22) and external-provider handling
(Section 23) run **alongside** this flow from the point scope is
credibly established, not only at the end.

---

## 1. Purpose

This procedure exists so that, when a suspected privacy or security
incident occurs, Tether has a single, consistent, human-led process to:

1. detect, record, and contain the incident without destroying the
   evidence needed to assess it;
2. determine, factually, what personal information (if any) was
   involved;
3. assess — never assume — whether the incident is a data breach, a
   suspected eligible data breach, or a confirmed eligible data breach
   under the NDB scheme, where that scheme applies;
4. assess serious harm using a documented, human-judgement checklist,
   never an automated score;
5. coordinate with affected institutions separately from any statutory
   notification obligation;
6. notify OAIC and/or affected individuals only where that is actually
   required, as soon as practicable, never automatically; and
7. record every significant decision for later review.

## 2. Scope

Applies to any suspected compromise, loss, misuse, or unauthorised
access/disclosure involving personal information Tether holds or
processes — student, lecturer, or institution-staff data across the
standalone Tether exam platform (session/account data, submitted
answers, integrity evidence, network evidence, secure-client/session
evidence, and any other data category documented in
`docs/tether-data-and-privacy-register.md`). It does not itself cover
purely operational outages with no personal-information exposure (those
remain covered by existing platform-support escalation, e.g.
`docs/tether-pilot-support-runbook.md`), though Section 6 (severity)
notes that an outage can turn into a privacy incident if it involves
exposure.

This document governs **process**, not product behaviour. It does not
change exam integrity collection, Secure Browser, evidence capture, or
any other product feature — see Section 13 (No live incident
automation).

## 3. Important legal/applicability boundary

- This document is **not legal advice**. Any specific incident may
  require input from qualified legal counsel before a final statutory
  determination (NDB applicability, eligible-breach status, or
  notification) is made.
- **Not every incident is a data breach.** Not every data breach is a
  notifiable ("eligible") data breach. **Not every eligible data breach
  automatically requires notifying OAIC** — remedial action can prevent
  the likely risk of serious harm, in which case notification is not
  required (Section 15).
- Statutory NDB assessment/notification is performed **where the NDB
  scheme applies** to the relevant entity and incident — this document
  does not assume it always does, and does not assume it never does.
- **Contractual customer-notification obligations may apply
  independently of the statutory NDB threshold.** An institution may
  need to be told about an incident under Tether's contract with that
  institution even where the statutory NDB threshold has not been
  established, or has been assessed as not met. Section 21 keeps these
  two obligations explicitly separate.

## 4. Definitions

These summarise how the terms are used in this document; see Section 3
for the boundary on legal determination.

- **Security/privacy incident** — an event involving possible
  compromise, loss, misuse, or unauthorised access/disclosure (or
  suspected unauthorised access/disclosure) of personal information, or
  any event that could plausibly lead to one. The entry point to this
  entire procedure — every suspected case starts here, before any
  determination is made about what kind of incident it is.
- **Data breach** — unauthorised access to, or unauthorised disclosure
  of, personal information, or loss of personal information in
  circumstances where unauthorised access or disclosure is likely to
  occur.
- **Suspected eligible data breach** — a state in which there are
  reasonable grounds to *suspect* (not yet confirmed) that an eligible
  data breach may have occurred. Where the NDB scheme applies, this
  state starts a mandatory assessment that must be reasonable and
  expeditious, with a **30-calendar-day maximum** to complete it
  (Section 16) — not a 30-day waiting period before anything can happen
  (Section 17).
- **Eligible data breach** — where the NDB scheme applies, a data breach
  that satisfies all three of: (a) unauthorised access/disclosure of
  personal information, or a qualifying loss of it; (b) a reasonable
  person would conclude the access/disclosure/loss is likely to result
  in serious harm to one or more individuals; and (c) remedial action
  has **not** prevented that likely risk of serious harm.
- **Confirmed eligible data breach** — an eligible data breach that has
  actually been determined (Section 17), with no statutory exception
  applying. Triggers notification (Sections 19–20) as soon as
  practicable.
- **Serious harm** — assessed via the checklist in Section 14, never an
  automated score; see that section for the factors considered.
- **Remedial action** — action taken (by Tether, an institution, or both)
  that, before serious harm results, prevents the likely risk of serious
  harm from a data breach — the deciding factor between "eligible data
  breach" and "data breach, but not eligible."

## 5. Incident principles

Every person acting under this procedure follows these principles,
which resolve ambiguity when a specific step is unclear:

1. **Protect individuals first.** Reversible harm to Tether's own
   operations is always secondary to a real, ongoing risk to a real
   person.
2. **Contain without destroying evidence.** Containment (Section 9) and
   evidence preservation (Section 10) happen together — never sacrifice
   the ability to assess an incident in order to make it "go away"
   faster. See Section 9's own explicit warning.
3. **Minimise further disclosure.** Every additional person who sees
   incident details who does not need to is additional exposure —
   follow need-to-know access (below) throughout, not only in the
   initial response.
4. **Preserve reliable timestamps/logs.** `PlatformAuditLog` and any
   other timestamped evidence are the backbone of the 30-day clock
   (Section 16) and the eventual assessment record (Section 12) — do
   not overwrite, rotate away, or lose them mid-incident.
5. **Need-to-know access.** Incident details, especially before triage
   is complete, are shared only with people who need them to do their
   part of the response — not broadcast internally "to be safe."
6. **Factual communication only.** Every internal and external
   communication about an incident states only what is actually known,
   attributed to its source, with uncertainty stated as uncertainty —
   never speculation presented as fact.
7. **No premature blame.** Incident response is about the individuals
   affected and the facts of what happened — not about identifying who
   to blame, especially not before triage is complete.
8. **No premature "eligible breach" conclusion.** Every stage of
   assessment (Sections 11–15) is evidence-based and sequential — do not
   skip to "this is/isn't an eligible breach" before the preceding
   assessment steps are actually done.
9. **Legal/statutory applicability must be confirmed**, not assumed, for
   the relevant entity and incident (Section 3) — every assessment
   record (Section 12's template) has an explicit field for this rather
   than a silent assumption either way.
10. **Academic-integrity evidence remains confidential even during
    incident response.** Camera stills, screen-share stills, and
    integrity-review content are still governed by
    `docs/privacy-and-evidence-retention-v1.md`'s access-control rules
    (Section 16 of that document) during an incident — responders follow
    the same need-to-know, authorised-reviewer boundary as ordinary
    operation; an incident does not create a blanket exception.

## 6. Incident severity levels

**Severity is an internal OPERATIONS classification only.** It exists to
route urgency and resourcing. **It does not, by itself, determine
whether an incident is an eligible data breach, whether serious harm
exists, or whether OAIC notification is required** — those are separate,
evidence-based assessments (Sections 11–18) that a low-severity incident
can still trigger, and a high-severity incident can still fail to
trigger (e.g. if remedial action prevents likely serious harm). The
examples below are illustrative starting points for triage, not
automatic classification rules.

| Level | Name | Illustrative examples |
|---|---|---|
| SEV-1 | CRITICAL | Credible large-scale exposure of personal information; an active attacker with ongoing access; a privileged/service-role credential compromise; cross-tenant (cross-institution) data exposure; evidence-storage images exposed publicly; suspected database exfiltration. |
| SEV-2 | HIGH | Confirmed unauthorised access with a limited, bounded scope; a compromised staff/lecturer/admin account; an evidence-storage bucket exposed with a known, bounded set of affected objects. |
| SEV-3 | MODERATE | A suspected, contained privacy incident that still requires a full assessment before its scope or impact is known. |
| SEV-4 | LOW | A minor incident with no confirmed unauthorised personal-information access and low foreseeable harm (e.g. a misdirected internal email caught and recalled before being opened). |

Severity may be revised up or down as triage (Section 11) proceeds —
initial severity is a starting estimate, not a fixed label.

## 7. Roles and decision authority

This document deliberately does **not** name specific individuals — role
assignment is an institutional/operational decision to be made before
external pilot, and recorded as a pre-pilot gate (Section 31). The
*roles* themselves:

- **Reporter** — whoever first notices or is told about a possible
  incident. Any team member can be a reporter; reporting is never
  gatekept (Section 8).
- **Incident lead** — the person coordinating a specific incident end to
  end: triage, containment coordination, assessment record ownership,
  and the point of contact for institution coordination (Section 21).
  One incident lead per incident.
- **Assessment owner** — owns the suspected-eligible-breach assessment
  (Section 13) and the 30-day clock (Section 16) once one is opened. May
  be the same person as the incident lead.
- **Notification decision authority** — the person(s) who may actually
  approve sending a notification (individual, OAIC, or institution).
  **No notification (Section 18) is sent without this explicit
  authority signing off** — this is the human checkpoint that Section 13
  (No live incident automation) exists to protect.
- **Legal/privacy review** — engaged whenever Section 3's applicability
  boundary, Section 15's eligible-breach determination, or Section 17's
  notification decision needs a determination this document itself
  cannot make.

## 8. How incidents are reported internally

Any team member who notices, suspects, or is told about a possible
incident reports it immediately — reporting is never blocked on being
certain it's real. A false alarm costs little; a delayed real incident
costs a great deal. **PRE-PILOT GATE** — the specific internal reporting
channel (a dedicated inbox, chat channel, or on-call rotation) is an
operational decision not yet finalised; until it is, report through
whatever channel reaches the incident lead role fastest, and record that
channel's existence as a known gap (Section 31).

## 9. Immediate containment

Containment stops ongoing harm — revoking a compromised credential,
disabling a compromised account, closing an exposed storage object to
public access, or isolating an affected system.

**Containment must never silently destroy forensic evidence required
for the assessment (Section 10).** Before taking an irreversible
containment action (e.g. deleting a resource rather than merely
disabling access to it), capture what Section 10 needs first, if doing
so does not meaningfully delay stopping active harm. When the two
conflict — active, ongoing harm versus evidence preservation — stopping
the harm wins, but the incident lead records what was lost and why
(Section 12's record has a field for this).

## 10. Evidence preservation

Before or alongside containment, preserve:

- relevant `PlatformAuditLog` rows (export/copy them — do not rely on
  querying them live indefinitely, since operational retention/rotation
  policy for logs is Class C, target 90 days per
  `docs/privacy-and-evidence-retention-v1.md` Section 18, and an
  incident is exactly the kind of active investigation that should
  place a hold on relevant rows — see Section 19 of that document);
- any provider-side incident notice or timeline (Section 23);
- screenshots/exports of the actual affected state (a public bucket
  listing, an unauthorised-access log line, an error report) **before**
  remediating it away;
- system/application logs covering the incident window, to the extent
  they exist and are accessible;
- a timeline of who did what, when, as the response happens — not
  reconstructed afterward from memory.

This is preservation for the assessment record (Section 12), not a
demand for exhaustive forensic imaging beyond what this pass's tooling
supports — Tether's current logging/audit surface is
`PlatformAuditLog` plus whatever provider-side logs Vercel/Supabase
expose; this document does not claim more forensic capability exists
than actually does.

## 11. Initial triage

Once contained (or containment is underway), the incident lead
establishes, factually:

- what system(s)/data were involved;
- an initial severity estimate (Section 6);
- whether personal information appears to be involved at all — if
  clearly not, the incident may be closed as operational-only, recorded
  in the register (Section 27/`docs/privacy-incident-register-template-v1.md`)
  for completeness, and this procedure's remaining sections do not
  apply;
- if personal information may be involved, proceed to Section 12.

## 12. Personal-information impact assessment

Using `docs/data-breach-assessment-record-v1.md`, document factually:

- what happened (unauthorised access, unauthorised disclosure, or loss —
  Section 4's definitions);
- which data categories from `docs/tether-data-and-privacy-register.md`
  are involved (names, student identifiers, emails, answers, grades,
  integrity events, network/IP evidence, camera stills, screen-share
  stills, authentication/session data, AI-assistance records, or
  other);
- an estimated number of individuals and records affected — a working
  estimate, refined as the assessment proceeds, not a final figure on
  day one;
- which institution(s)' data is involved (Section 21/22).

## 13. Suspected eligible-breach assessment

Once Section 12 establishes that personal information was plausibly
subject to unauthorised access, unauthorised disclosure, or a qualifying
loss, the incident becomes a **suspected eligible data breach**, and —
**where the NDB scheme applies to the relevant entity** (Section 3) —
this opens the mandatory assessment obligation and starts the clock
(Section 16). If NDB applicability is not yet confirmed, note that
explicitly in the assessment record rather than guessing either way, and
escalate to legal/privacy review (Section 7) to resolve it in parallel
with the rest of the assessment — do not let an unresolved applicability
question stall containment, preservation, or institution coordination,
which proceed regardless.

## 14. Serious-harm assessment

A documented **checklist for human judgement**, not an automated score
and not a numeric threshold that purports to legally determine serious
harm. Consider, for the specific incident:

- the kind and sensitivity of the personal information involved;
- whether information was exposed in combination (e.g. an identity plus
  contact details plus an assessment record is more sensitive combined
  than any one piece alone);
- what security protections (access control, encryption in transit/at
  rest, authentication) were in place around the exposed information,
  and whether any of those protections were themselves compromised (e.g.
  a compromised key protecting otherwise-encrypted data is a materially
  different situation from data that was never protected by that key at
  all);
- who obtained, or could plausibly have obtained, the information —
  a named individual, an unknown external party, or nobody beyond an
  internal log line nobody read;
- the nature of the potential harm (identity theft/fraud risk,
  reputational harm, psychological harm, discrimination, physical safety
  risk);
- the likelihood the information will actually be misused, not merely
  the theoretical possibility;
- whether assessment or integrity evidence exposure could unfairly
  affect a student specifically (e.g. camera-evidence exposure
  suggesting misconduct to someone outside the authorised review chain)
  — a harm category specific to Tether's own data categories, alongside
  the general ones above;
- the vulnerability of the affected individuals (e.g. minors, if
  applicable to a given institution's student population);
- how long the information was exposed and how accessible it was during
  that window;
- what remedial action has already been completed and its actual effect
  (feeds directly into Section 15).

Record the factors actually considered and the reasoning — not just a
yes/no conclusion — in the assessment record.

## 15. Remedial action

Remedial action is anything that, before serious harm results, removes
or reduces the likely risk of serious harm from a data breach —
revoking exposed credentials before they're used, recovering an exposed
document before it's viewed by anyone unauthorised, or securing an
exposed bucket before any unauthorised access occurred. **If remedial
action genuinely prevents the likely risk of serious harm, the incident
is a data breach but not an eligible data breach** (Section 4) — this is
not a technicality to be leaned on selectively; it must be a factual,
defensible conclusion documented with the evidence for it (what was
done, when, and why it actually prevented the risk — not merely reduced
inconvenience).

## 16. 30-day statutory assessment clock

**Where the NDB scheme applies** and a suspected eligible data breach
exists (Section 13), the assessment clock starts **the day after the
entity became aware of the grounds/information that caused the
suspicion** — not the date of the incident itself if awareness came
later, and not the date containment finished.

The assessment must be **reasonable and expeditious**. **30 calendar
days is a maximum, not a target and not an entitlement to wait that
long** — if the assessment can reasonably be completed sooner, it
should be. The operational incident record captures:

- awareness date/time (the clock start reference point);
- assessment start date (may be same day as awareness);
- statutory maximum completion date (awareness date + 30 calendar days);
- assessment owner (Section 7);
- current status, updated as the assessment proceeds, not only at the
  end;
- blockers, if any, and what is being done about them.

**If the assessment cannot reasonably be completed within 30 days,
document why, document the reasonable steps actually taken, and
escalate immediately for legal/privacy review** — this document does
not normalise extensions or treat 30 days as routinely insufficient.

## 17. NDB applicability decision

Recorded explicitly in the assessment record, never left implicit:

- **Does the NDB scheme apply to the relevant entity for this
  incident?** YES / NO / LEGAL REVIEW REQUIRED, with the reason. This
  reuses Section 3's boundary — "legal review required" is an entirely
  legitimate, expected outcome while Tether's entity structure is
  unsettled, not a failure of this procedure.
- If YES (or while LEGAL REVIEW REQUIRED is pending, treated as YES for
  the purpose of not missing a deadline): proceed through Sections
  13–16.
- If NO: the statutory NDB path does not apply to this specific
  incident/entity, but **institution/contractual notification (Section
  21) is assessed independently and separately** — a "NO" here is never
  itself a reason to skip institution coordination.

## 18. Notification decision

The outcome of Sections 13–17, recorded as one of:

- **not a data breach**;
- **data breach, not likely serious harm**;
- **serious harm prevented by remedial action** (Section 15) — a data
  breach, but not an eligible one;
- **eligible data breach** — confirmed per Section 4's three criteria;
- **legal determination required** — the assessment could not be
  concluded without legal/privacy review input (Section 7).

Only an **eligible data breach**, with no applicable statutory
exception, proceeds to notification (Sections 19–20). **This decision is
made by a human with notification decision authority (Section 7) — it
is never automated.** No automatic OAIC notification, automatic
individual/student notification, automatic institution notification, or
automatic legal determination exists anywhere in this repository, and
none is built by this document (see "No live incident automation"
below, after Section 32).

## 19. OAIC notification requirements

Where an eligible data breach is confirmed (Section 18) and no exception
applies, a statement is provided to the OAIC **as soon as practicable**
— not automatically, not by default, and not for every breach (Section
3). The statement should describe, at minimum, based on current OAIC
guidance: the organisation/entity involved; a description of the breach;
the kinds of information concerned; and recommended steps individuals
should take. `docs/data-breach-notification-template-v1.md` is the
drafting template for this content — it is filled in by a human with
notification decision authority, never sent automatically, and requires
legal review where the specifics warrant it (marked directly on the
template).

## 20. Individual notification requirements

Where an eligible data breach is confirmed (Section 18) and no exception
applies, individuals at risk of serious harm are notified **as soon as
practicable**, using the same drafting template
(`docs/data-breach-notification-template-v1.md`). Depending on the
incident and the institution relationship (Section 21), this
notification may be sent by Tether, by the affected institution, or
jointly — determined case by case (Section 22), never assumed by
default.

## 21. Institution/customer coordination

**Contractual incident notification is separate from statutory NDB
notification** — an institution may need to be told about an incident
under Tether's contract with that institution even where the NDB
statutory threshold has not been established, or has been assessed as
not met.

**Target controlled-pilot rule:** potential exposure of one
institution's student data should be escalated to that institution's
nominated incident contact promptly after credible scope is established
(Section 12), subject to any active security or law-enforcement
constraint that requires a short delay (Section 24). **PRE-PILOT
CONTRACT GATE** — an exact notification SLA (e.g. "within N hours") is
not invented here; it is set by the actual customer contract, not yet
finalised. Until a contract sets one, "promptly after credible scope is
established" is the operating standard, recorded per-incident with the
actual elapsed time for later review.

## 22. Multi-entity incidents

Tether typically processes institutional/student data **in conjunction
with** an institution — a breach involving that data may implicate both
Tether's systems and the institution's own. When this happens:

1. **Determine which entities hold the affected information** — Tether
   only, the institution only, or both (e.g. data that both platforms
   independently store, such as a student's name and email).
2. **Immediately notify/coordinate with the affected institution**
   according to Section 21's rule and the actual contract/process, once
   credible scope is established — this step happens regardless of who
   turns out to own the statutory notification obligation.
3. **Determine which entity has statutory notification responsibility**
   for this specific incident. Current OAIC guidance notes that where a
   breach involves multiple entities, generally only one entity needs to
   perform the NDB notification, and the entity with the most direct
   relationship with the affected individuals may be best placed — but
   **this must be determined for the actual incident**, not assumed from
   a general rule. **Do not assume Tether automatically owns the
   notification obligation. Do not assume the institution automatically
   owns it either.**
4. **Avoid duplicate or inconsistent notifications** — once
   responsibility is determined, coordinate so affected individuals
   receive one clear notification, not two different accounts of the
   same incident from two different senders.
5. **Document the decision and rationale** in the assessment record —
   which entity notifies, why, and what the other entity's role was
   (e.g. providing facts, reviewing content, or standing down because
   the counterpart entity is notifying).

## 23. External technical providers

Applies to an incident reported by, or discovered via, an external
provider Tether relies on — currently Vercel (hosting), Supabase
(database + evidence storage), Anthropic (optional AI features), the
transactional email provider, and, if ever activated, an IP-geolocation
provider (`docs/privacy-and-evidence-retention-v1.md` Section 24's
subprocessor register). **This document does not invent any of these
providers' own breach-notification terms or timelines** — those are
governed by Tether's actual agreement with each provider, not stated
here.

Procedure when a provider reports (or Tether otherwise discovers via a
provider) a possible incident:

1. **Preserve the provider's notice** — the original communication, its
   timestamp, and its stated scope, verbatim.
2. **Confirm impacted Tether resources/data** — a provider's own
   assessment of "what was affected" is a starting point, not
   necessarily the full picture from Tether's side; verify against
   Tether's own records (which institutions/exams/data classes actually
   live in the affected resource).
3. **Determine institutions/data classes affected**, using Section 12's
   assessment approach.
4. **Record the provider's own timeline** (when they detected it, when
   they notified Tether, what they've told Tether they've done) as part
   of the assessment record.
5. **Perform Tether's own impact/NDB assessment** (Sections 11–18) — a
   provider incident does not skip this procedure.
6. **Coordinate with the affected institution(s)** per Section 21/22.
7. **Do not assume the provider's own notification (to Tether, or to
   anyone else) discharges Tether's or the institution's own
   obligations** — a provider notifying Tether that an incident occurred
   is not the same as Tether notifying affected individuals or OAIC,
   and does not substitute for either.

## 24. Law enforcement / cyber agency escalation

For an incident that may involve criminal conduct (e.g. unauthorised
system access, credential theft, extortion), the incident lead
(Section 7) considers escalation to the Australian Cyber Security
Centre (ACSC) and/or law enforcement as appropriate to the incident's
nature and severity, alongside — not instead of — this procedure's
privacy assessment. **PRE-PILOT GATE** — a specific escalation contact
and decision owner for this step is an operational detail not yet
finalised; record its absence as a known gap (Section 31) rather than
inventing one. Where law enforcement involvement genuinely requires a
short delay to individual/OAIC notification (e.g. to avoid compromising
an active investigation), document that constraint and the delay it
causes explicitly in the assessment record — this is a recognised,
narrow exception, not a default extension (Section 16 already prohibits
normalising extensions generally).

## 25. Communications control

During an active incident:

- All external communication (to institutions, individuals, OAIC, or
  the public) is approved by notification decision authority (Section
  7) before it goes out — no ad hoc communication from whoever happens
  to be handling a piece of the response.
- Internal communication follows need-to-know (Section 5) — status
  updates to people who need them to do their job, not broad internal
  announcements while facts are still being established.
- Communication is factual only (Section 5) — what is known, what is
  still being assessed, and what has been done; never speculation, and
  never a premature "this is/isn't an eligible breach" conclusion
  (Section 5) stated as settled before it actually is.

## 26. Incident recordkeeping

Every incident that reaches Section 11 (triage) or beyond gets:

- an entry in `docs/privacy-incident-register-template-v1.md` (summary,
  status, key dates);
- a completed (or in-progress) `docs/data-breach-assessment-record-v1.md`
  once personal information is confirmed or plausibly involved
  (Section 12 onward);
- preserved evidence per Section 10, referenced from the assessment
  record rather than duplicated into it.

Recordkeeping is **not** optional for a "small" incident — even an
incident later assessed as "not a data breach" gets a register entry
recording that conclusion and its reasoning, so the decision is
reviewable later.

## 27. Post-incident review

Once an incident is contained, assessed, and (if applicable) notified,
the incident lead runs a post-incident review covering: what happened,
how it was detected, how effective containment and preservation were,
whether the assessment timeline (including the 30-day clock, if opened)
was met and why/why not, whether institution coordination worked as
intended, and what should change. This is a **factual review, not a
blame exercise** (Section 5).

## 28. Corrective actions

Corrective actions from the post-incident review are recorded against
the incident in the register (Section 26), each with an owner and a
target date. Corrective actions may be technical (e.g. a specific access
control defect), procedural (e.g. this document itself needs a
correction), or contractual (e.g. an institution notification SLA needs
to actually be settled — Section 21's pre-pilot gate). This document
does not itself track corrective-action completion beyond the register
— that remains an operational follow-up.

## 29. Privacy/retention implications

An incident may itself create privacy/retention obligations distinct
from ordinary operation:

- Evidence preserved under Section 10 for the incident (audit-log
  exports, screenshots, provider notices) is itself personal
  information in some cases and should be handled with the same
  access-control discipline as any other sensitive record (Section 5,
  principle 10) — not left in an ad hoc, unrestricted location.
- Where Section 19's legal/academic-integrity-hold concept
  (`docs/privacy-and-evidence-retention-v1.md` Section 19) applies to
  records relevant to an active incident/investigation, place a hold on
  those records through the same manual process described there — an
  incident is exactly the kind of "active investigation" that
  justifies one. **This document does not itself implement or expand
  that hold mechanism** — see the cross-reference above for the actual
  process.
- Once an incident is closed and any hold is released, the affected
  records return to their ordinary retention schedule
  (`docs/privacy-and-evidence-retention-v1.md` Section 18) — this
  document does not create a separate, incident-specific retention
  category.

## 30. Testing/exercises

**PRE-PILOT GATE** — no incident-response tabletop exercise or drill has
been run against this procedure as of this pass. Before external
institutional pilot, running at least one tabletop exercise against a
realistic Tether-specific scenario (see "Illustrative Tether-specific
incident scenarios" after Section 32) is recommended to validate that
the roles (Section 7), reporting path
(Section 8), and 30-day clock tracking (Section 16) actually work in
practice, not only on paper.

## 31. Pre-pilot gaps

Consolidated from the sections above:

1. **Roles not yet assigned to named individuals** — Section 7. Role
   *definitions* exist; specific people do not yet.
2. **Internal reporting channel not yet finalised** — Section 8.
3. **Institution contractual notification SLA not yet set** — Section
   21. **PRE-PILOT CONTRACT GATE.**
4. **Law enforcement/ACSC escalation contact/decision owner not yet
   finalised** — Section 24.
5. **No tabletop exercise run against this procedure yet** — Section 30.
6. **Legal entity, privacy officer, and legal counsel not yet
   registered** — inherited from
   `docs/privacy-and-evidence-retention-v1.md` Section 27 item 6; this
   document does not invent any of them (see the header boundary above).
7. **NDB statutory applicability itself unresolved** for Tether's
   eventual entity structure — Section 3/17; this is the load-bearing
   gap every other gap in this list sits downstream of.

## 32. Version control

| Version | Date | Change |
|---|---|---|
| v1 | 2026-08-23 | Initial procedure: this document, `docs/data-breach-assessment-record-v1.md`, `docs/data-breach-notification-template-v1.md`, `docs/privacy-incident-register-template-v1.md`, and the Section 23 update to `docs/privacy-and-evidence-retention-v1.md` (`compliance/australian-incident-ndb-procedure-v1` branch). No schema, migration, or evidence-collection behaviour changed. No live notification automation added. |

---

## No live incident automation

This document, and this pass generally, does **not** build: automatic
OAIC notification, automatic student/individual notification, automatic
institution notification, an automatic legal determination, automatic
serious-harm scoring, automatic data deletion, or automated shutdown of
production. Every decision point above (Sections 13, 15, 17, 18, 19, 20,
22) is a human judgement call made by a named role (Section 7), recorded
in the templates below — not a system that acts on its own. Where a
Tether feature already performs an *operational* action relevant to
containment (e.g. revoking a compromised session or credential through
existing account/session-management routes), that is ordinary product
functionality invoked deliberately by a person during containment
(Section 9) — it is not incident-response automation, and this document
does not change or extend what that functionality does.

---

## Illustrative Tether-specific incident scenarios

These are **illustrative starting points for triage discussion**, not
pre-classifications of NDB-notifiability, severity, or serious harm —
every scenario still goes through the full assessment (Sections 11–18)
before any of those conclusions are reached. Each includes immediate
containment, evidence to preserve, institution coordination, and the
assessment questions triage should start with.

### A. Student camera evidence accidentally visible to another institution

- **Immediate containment:** revoke/correct the access-control defect
  that allowed cross-institution visibility (see
  `src/lib/institutionScope.ts`'s scoping pattern,
  `docs/privacy-and-evidence-retention-v1.md` Section 16); confirm no
  further cross-institution reads are possible.
- **Evidence to preserve:** which evidence-asset id(s) were viewed, by
  whom, when — the `VIEW_AI_CAMERA_EVIDENCE_FRAME` `PlatformAuditLog`
  entries are the direct source (Section 16 of the privacy package).
- **Institution coordination:** both the owning institution (whose
  student's evidence was exposed) and the viewing institution (whose
  user viewed it) need to be part of the picture — see Section 22.
- **Assessment questions:** how many evidence assets, how many
  students, how many viewers; was viewing accidental/incidental or
  could it have been repeated/deliberate; does the viewed content
  (a camera still) meet the sensitivity/combination factors in Section
  14.

### B. Supabase database credentials compromised

- **Immediate containment:** rotate the compromised credential
  immediately (service-role key or database connection credentials);
  confirm rotation actually revokes the old credential's access.
- **Evidence to preserve:** how the compromise was discovered, the
  credential's access scope, any provider-side access logs Supabase
  can supply for the credential's lifetime.
- **Institution coordination:** this is a platform-wide, potentially
  cross-institution exposure — Section 22's multi-entity process
  applies across every institution whose data the credential could
  reach, not just one.
- **Assessment questions:** was the credential actually used by an
  unauthorised party (evidence of use, not just possibility); what data
  classes were reachable with that credential's privileges; how long was
  it exposed.

### C. Evidence-storage object made publicly accessible

- **Immediate containment:** correct the bucket/object visibility
  setting immediately; confirm no further public access is possible.
- **Evidence to preserve:** which object(s)/key(s), the window during
  which they were public, and — if the storage provider exposes
  access/request logs — whether any request actually occurred during
  that window (this materially affects Section 14's "who obtained, or
  could plausibly have obtained" factor).
- **Institution coordination:** identify which institution(s)' evidence
  the exposed object(s) belong to via `IntegrityEvidenceAsset.kind` /
  `institutionId` — Section 21/22.
- **Assessment questions:** was this camera evidence, screen-share
  evidence, or another asset kind (Section 14's sensitivity factor);
  how many objects; was the exposure window long enough for indexing by
  a search engine or automated scanner.

### D. Lecturer accesses another institution's exam evidence due to an authorization defect

- **Immediate containment:** fix the authorization defect; confirm the
  specific access path is closed.
- **Evidence to preserve:** the specific route/query involved, the
  `PlatformAuditLog` entries for what was actually accessed, and
  whether the defect is isolated or systemic (i.e. could other
  lecturers have exploited the same defect, deliberately or not).
- **Institution coordination:** both institutions again, as in scenario
  A — Section 22.
- **Assessment questions:** was access limited to viewing, or did it
  also permit review-status changes/comments (a materially different
  and more serious scope); how many submissions/students were reachable.

### E. Raw network/IP evidence accidentally included in an inappropriate export

- **Immediate containment:** recall/restrict the export if still
  possible; confirm no further copies were made or shared onward.
- **Evidence to preserve:** what the export contained (which
  `NetworkEvidence` rows — raw IP, hash, or both — see
  `docs/privacy-and-evidence-retention-v1.md` Section 11), who received
  it, and when.
- **Institution coordination:** the institution(s) whose students'
  network evidence was in the export — Section 21.
- **Assessment questions:** did the export leave Tether's/the
  institution's control entirely, or was it contained within an
  authorised recipient who should not have had it in that form; is raw
  IP alone (without other identifying context) likely to cause serious
  harm on its own, or only in combination with other exposed data
  (Section 14).

### F. Student account takeover exposes only that student's own assessment

- **Immediate containment:** lock/reset the compromised account; revoke
  active sessions for it.
- **Evidence to preserve:** how the takeover occurred (credential
  stuffing, phishing, etc., to the extent determinable), what the
  attacker actually did while in the account (viewed vs. modified
  answers, submitted on the student's behalf).
- **Institution coordination:** the one institution the student belongs
  to — a single-institution, single-individual scenario, simpler than
  A–E, but still goes through full assessment.
- **Assessment questions:** is this "the individual's own data being
  exposed to an attacker" (still a data breach — unauthorised access to
  that student's personal information occurred) or does it also expose
  anyone else's data; could the takeover have affected the academic
  integrity of that student's own attempt (a product/academic-integrity
  question for the institution, separate from the privacy assessment).

### G. Secure Browser signing/update infrastructure compromise (future relevance)

Code signing for the Secure Browser/lockdown client is currently
deferred (`docs/tether-windows-code-signing-plan.md`) — this scenario is
included for future relevance, not because signing infrastructure exists
today.

- **Immediate containment:** revoke the compromised signing
  key/infrastructure access immediately; halt distribution of any
  build signed after the suspected compromise point.
- **Evidence to preserve:** build/release timestamps, what was signed
  and distributed during the exposure window, any available
  distribution/download logs.
- **Institution coordination:** every institution using the affected
  client version — this is a platform-wide, high-severity scenario by
  nature (illustratively SEV-1, Section 6), though the actual severity
  and eligible-breach determination still follow the full assessment.
- **Assessment questions:** was this a signing-key compromise (enabling
  malicious builds to appear legitimate) or a distribution-channel
  compromise (a different, generally narrower exposure); is personal
  information actually implicated at all, or is this primarily a
  software-integrity incident that only becomes a privacy incident if a
  malicious build was actually installed and used to access personal
  information.

### H. Anthropic/AI-provider incident involving assessment prompts (optional AI feature)

Only relevant where AI-assisted draft marking or Controlled AI
Brainstorming Assistance is enabled for the affected exam(s) — both are
lecturer-enabled, off by default
(`docs/privacy-and-evidence-retention-v1.md` Section 6).

- **Immediate containment:** follow Section 23's external-provider
  procedure — preserve the provider's notice, confirm impacted Tether
  resources.
- **Evidence to preserve:** which exams/submissions had the affected AI
  feature enabled during the incident window, and what data those
  features send (question text, student prompts/answers submitted for
  AI processing — Section 24 of the privacy package's subprocessor
  register).
- **Institution coordination:** the institution(s) whose exams used the
  affected feature during the incident window — Section 21/23.
- **Assessment questions:** does the provider's own incident actually
  expose Tether-submitted content, or only the provider's broader
  infrastructure with no evidence Tether's data was affected; if
  content was exposed, does it include personal information beyond the
  assessment content itself (Section 14).
