# Live Proctoring v1 — Design Audit

**Status: DESIGN ONLY. No code has been implemented, no schema has been changed, and no migrations exist for anything described in this document.** This is a design audit produced by inspecting the current codebase, intended to inform a future product/engineering decision — not a description of a shipped or in-progress feature.

**Key facts this document establishes up front:**

- SES's current camera-related features (Camera Monitoring v1, Persistent Camera Preview v1) are **entirely local to the student's browser** — the student's `MediaStream` never leaves their device today. Nothing about live proctoring exists yet.
- Live Proctoring v1, as scoped here (live camera + live screen viewing by authorised proctors, nothing recorded), is a **major new subsystem** — real-time media transport, a new permission model, a new consent framework, and new vendor/sub-processor exposure — not an incremental extension of existing camera monitoring.
- **Nothing is recorded or stored in v1** under this design: no video, no screen footage, no screenshots, no thumbnails, no audio, at any point, under any field name.
- The recommended future architecture is a **managed WebRTC SFU provider** (e.g. LiveKit Cloud, Daily, Twilio Video, Agora) behind a thin SES-owned abstraction — not a self-hosted media server, and not peer-to-peer WebRTC.
- **Recommendation: defer implementation until after the first controlled pilot**, unless a confirmed pilot partner has stated live proctoring as a hard requirement.

Scope note: this document is scope-only. No routes, provider SDKs, environment variables, or schema changes accompany it.

---

## 1. Executive Summary

Live Proctoring v1 — authorised proctors viewing a student's live camera and screen during an exam, with nothing recorded — is a **materially different subsystem** from anything SES has today. Every existing "camera" feature (Camera Monitoring v1, Persistent Camera Preview v1) is **local-only**: the student's browser holds a `MediaStream` that never leaves their device. Live proctoring requires that stream to reach a second person's browser in real time, which needs media transport infrastructure SES does not have and Vercel's serverless model cannot provide.

The recommended path is: use a **managed WebRTC SFU provider** behind a **thin SES-owned abstraction**, keep SES's own backend responsible only for access control, token minting, and metadata/audit logging, and treat this as a genuinely new product surface requiring its own consent flow, permission model, and operational muscle — not an extension of `requireCamera`.

**Recommendation:** defer to **after** the first controlled pilot unless a confirmed pilot partner requires it. If built, start with **Option A (managed SFU)**, in the phased sequence in Part 15, and resolve the Phase 0 decisions before any code is written.

---

## 2. Current Architecture Findings

**Camera permission today:** `startCamera()` in `src/app/student/exams/[id]/page.tsx:412-431` calls `navigator.mediaDevices.getUserMedia({ video: true, audio: false })` directly from the student's browser. This happens twice in the student flow: once at the pre-exam gate, and (via `handleRestoreCamera`) if the stream drops mid-exam. The resulting `MediaStream` is held in `cameraStreamRef` (`useRef<MediaStream | null>`, line 185) — a plain client-side object reference, never transmitted anywhere.

**Persistent camera preview today:** `examVideoRef` (line 197) is a second `<video>` element rendered as a fixed-position widget during the exam. A `useEffect` (lines 478-482) re-attaches `cameraStreamRef.current` to whichever `<video>` DOM node currently exists (gate view or exam view, expanded or minimized) — this is DOM plumbing only. Minimizing (`toggleCameraPreviewMinimized`, line 486) is explicitly local `useState`, never touching the stream or reporting any event.

**Camera heartbeat today:** a `setInterval` (lines 435-461) polls `cameraStreamRef.current.getVideoTracks()[0].readyState` every `cameraHeartbeatIntervalSeconds` (10-300s, `src/lib/secureExam.ts:23`). It never sends video frames anywhere — it inspects the local track object's state (`live`/`muted`) and, on failure, calls `reportIntegrityEvent("CAMERA_HEARTBEAT_MISSED")`, which is an HTTP POST of a JSON event record (type/severity/message/timestamp), not media.

**Real-time media infrastructure:** **none exists.** No WebSocket server, no WebRTC (`RTCPeerConnection`), no SFU client library, no signalling server, no TURN/STUN config. `package.json` has zero real-time media dependencies. This is a from-scratch subsystem.

**Role enum today:** `enum Role { LECTURER, STUDENT, PLATFORM_ADMIN }` (`prisma/schema.prisma:10-14`). No `PROCTOR` value exists.

**Route protection pattern today:** `src/proxy.ts` gates entire path prefixes (`/lecturer/*`, `/student/*`, `/platform/*`) by `session.user.role` only — coarse-grained, role-based, no per-resource assignment concept at the middleware layer. Per-resource authorization happens inside each route handler.

**Resource ownership pattern today:** every lecturer-facing route (exam edit, evidence report, integrity review) checks **single ownership**: `exam.createdById === session.user.id` (see `getOwnedExam` in `src/app/api/exams/[id]/route.ts:50-79`, and the identical check in `buildEvidenceReport`, `src/lib/evidenceReport.ts:108`). There is **no existing concept of shared or delegated access** to a lecturer's exam anywhere in the codebase — no co-teacher, no TA, no reviewer role. `PLATFORM_ADMIN` is the only bypass, and it bypasses institution scoping entirely, not ownership specifically.

**Institution scoping today:** `src/lib/institutionScope.ts` is a single choke point. `assertSameInstitution(session, resourceInstitutionId)` throws `InstitutionAccessError` (mapped to a generic 403, never confirming a cross-institution resource's existence) unless the caller is `PLATFORM_ADMIN`. `requireInstitutionId(session)` throws loudly rather than silently scoping to nothing if a session lacks `institutionId`. Every new proctoring route must call this exact pattern.

**Course/enrolment/assignment scoping today:** `Exam.courseId` (nullable — null means legacy institution-wide visibility), `Exam.assignmentMode` (`COURSE` | `SELECTED_STUDENTS`), `CourseEnrollment` (course + user + role), `ExamAssignment` (exam + student, only meaningful under `SELECTED_STUDENTS`). The full check sequence lives in `POST /api/exams/[id]/start` and is mirrored read-only in `GET /api/exams/[id]/access-check`: institution match → course enrolment/assignment → published → availability window → access code.

**Access-code enforcement today:** `Exam.accessCodeHash` (bcrypt, never plaintext) + `accessCodeRequired` boolean, checked only inside `start`, never re-checked on resume of an existing submission.

**Availability windows today:** `Exam.availableFrom`/`availableUntil`, both nullable (unset = no restriction), computed against `new Date()` server-side.

**Proctor visibility constraint implication:** because there is no existing delegated-access primitive, live proctoring is the **first feature to require sharing a single lecturer resource (an exam) with a second, distinct user identity for a purpose other than exam ownership.** This is a genuinely new authorization dimension, not a variation of an existing one.

**What current architecture cannot support without new infrastructure:**
- No mechanism for one browser's `MediaStream` to reach another browser or server (no signalling, no SFU, no TURN/STUN).
- No persistent/long-running server process — Vercel serverless functions are short-lived request/response, unsuitable for holding media sessions.
- No multi-viewer broadcast primitive of any kind (not even a WebSocket for text).
- No delegated/shared-access permission model on any resource.
- No session/room lifecycle concept (start/end/reconnect) beyond the existing `Submission.status` state machine, which models exam progress, not connection state.

---

## 3. Build-vs-Buy Comparison

### Option A — Managed WebRTC SFU service (LiveKit Cloud, Daily, Twilio Video, Agora)

- **Setup complexity:** low-to-medium. Provider issues an SDK + server-side token-minting library; SES writes a thin Node wrapper.
- **Fastest pilot path:** yes — this is the only option that could plausibly reach a pilot in weeks rather than months.
- **SDK integration effort:** moderate. React client SDKs exist for all four; SES would add camera + screen publish (student side) and multi-track subscribe (proctor side) as new client code, isolated from the existing exam-taking UI.
- **Multiple viewers/proctors:** all four natively support many subscribers per published track — this is exactly what an SFU is for.
- **Camera + screen tracks:** all four support publishing a screen-share track alongside camera as a second track; this is standard SFU functionality, not a stretch feature.
- **Short-lived room tokens:** all four issue JWT-style room/participant tokens with expiry — this is the standard access-control primitive at the media layer.
- **10-40 students, 1-3 proctors:** well within stated capabilities of all four at reasonable list-price tiers; none of them would consider this a large deployment.
- **Data residency:** varies by provider and plan; some offer region selection, some don't on lower tiers. **Must be checked against the specific provider's current terms before any commitment** — this document does not assert a specific provider's current residency options because that changes over time and by contract tier.
- **Sub-processor/privacy implications:** using any of these makes the vendor a data sub-processor for live video/audio. This requires disclosure in the student privacy notice and, per institution, may require the institution's own approval (see `docs/network-evidence-and-ip-location.md`'s geolocation-provider pre-activation checklist as a template for this kind of vendor gate — the same pattern should apply here).
- **Pricing model:** all four bill on some combination of participant-minutes, bandwidth/egress, and/or track count — **exact current pricing must be checked on the vendor's site at decision time**; do not treat any number in this document as a quote.
- **Operational reliability:** provider SLA-backed; SES has no infrastructure to keep up.
- **Developer effort:** small relative to Options B/C — this is the entire reason a managed SFU exists.
- **Vendor lock-in risk:** real, but bounded if the vendor SDK is isolated behind an internal interface (Part 9) rather than called from student/proctor UI components directly.
- **What SES must still build internally regardless:** access control, token minting tied to SES's own exam/course/assignment rules, room/session metadata, audit logging, proctor assignment UI, incident flagging, consent flow, privacy notice updates, evidence-report integration (metadata only). The vendor never sees SES's institution/course/enrolment model — SES must translate "is this proctor allowed to view this student in this exam" into a token grant every time.

### Option B — Self-hosted SFU (LiveKit self-hosted, mediasoup, Janus)

- **Infrastructure required:** a dedicated, long-running media server process (not a serverless function), plus TURN/STUN servers for NAT traversal, plus TLS certificates on a stable domain, plus a hosting environment that isn't Vercel (a VM, container platform, or Kubernetes cluster).
- **Why not on Vercel serverless:** Vercel functions are stateless, short-lived, and cannot hold a persistent UDP/media socket across the duration of an exam session — this is a fundamental mismatch, not a configuration problem.
- **TURN/STUN:** required for any student behind restrictive NAT/firewall (common on campus networks) — this is itself another piece of infrastructure to run and monitor.
- **TLS/domain:** a dedicated subdomain with valid certificates, separate deployment/rotation process from the Next.js app.
- **Monitoring/observability:** SES would need to build or adopt media-specific monitoring (packet loss, jitter, room health) that doesn't exist in the current stack at all.
- **Scaling:** SFU capacity scales with concurrent tracks, not simple request count — a different scaling model than the current Vercel + Supabase pilot-scale setup documented in `docs/concurrent-exam-pilot-capacity.md`.
- **Upgrades/security patching:** an ongoing operational burden with no current owner on this team.
- **DevOps burden:** high, and orthogonal to the skills invested so far in this codebase (Next.js + Prisma + Vercel + Supabase).
- **Operational cost:** likely cheaper per-minute at large scale, but requires paying for that scale continuously (idle capacity) rather than the pay-as-you-go model of a managed provider — usually **not** cheaper at pilot scale (10-40 students).
- **Data control advantage:** real — no third party ever touches the media stream.
- **No managed video sub-processor:** simplifies the privacy/sub-processor story, at the cost of everything above.
- **Suitability for an early commercial pilot:** poor. This is infrastructure investment appropriate for a mature product with proven demand and dedicated ops capacity, not a first live-proctoring release.

### Option C — Direct peer-to-peer WebRTC

- **Lower infrastructure cost:** true for the simplest case (one student, one viewer).
- **Reduced vendor dependency:** true, but signalling (the process of exchanging connection offers/answers between peers) is still required — SES would need *some* server-side mechanism to introduce peers, even without media transport. This is not "zero infrastructure," it's "infrastructure for signalling only."
- **Poor scaling with multiple proctors:** peer-to-peer WebRTC is fundamentally point-to-point. Supporting 2-3 proctors watching one student requires either a mesh topology (student's browser opens a separate connection and uploads its stream once per viewer) or the student manually relaying — mesh is the realistic option.
- **Mesh bandwidth/CPU cost:** in a mesh, the student's **upload** bandwidth and CPU cost scale linearly with the number of simultaneous viewers (camera track × N proctors + screen track × N proctors). A student with 3 proctors watching would need to encode and upload 6 concurrent streams from their own device — this degrades quickly on typical home/campus upload bandwidth and is the core reason mesh topologies don't scale past a handful of participants.
- **Why this fails the stated requirement:** "more than one proctor may be assigned to an exam" directly conflicts with peer-to-peer's weakness. This option is **only** viable if usage is capped to one active viewer per student at any given time (i.e., proctors take turns, never simultaneously viewing the same student) — a real constraint the product would have to accept, not a minor caveat.
- **Verdict:** not recommended given the explicit multi-proctor requirement.

### Cross-cutting conclusions (all options)

- **Vercel serverless cannot host persistent media connections itself** — this constrains every option, including a from-scratch build, and is why "just add WebRTC to the existing Next.js API routes" is not a viable design regardless of vendor choice.
- **Some external media infrastructure is required regardless of option** — even self-hosted (Option B) means infrastructure external to the current Vercel+Supabase deployment, and even peer-to-peer (Option C) needs a signalling channel.
- **Next.js API routes should not stream the camera/screen media** — they should only ever handle token issuance, metadata, and event logging; the actual media path goes directly between the student's browser, the SFU (or peer), and the proctor's browser, never through the SES Next.js server.

---

## 4. Recommended Architecture (10-40 students, 1-3 proctors)

**Use a managed SFU provider (Option A) behind an SES-owned provider abstraction.** Rationale:

- It is the only option that plausibly supports a pilot timeline.
- It natively satisfies the multi-proctor requirement that breaks Option C.
- It avoids the DevOps investment of Option B, which is disproportionate to a 10-40 student pilot.
- Isolating the vendor SDK behind an interface (Part 9) means switching providers later — if pricing, residency, or reliability concerns emerge — is a contained change, not a rewrite.

**High-level architecture (text diagram):**

```
Student browser (or Tether Secure Browser)
  │  camera track + screen track (published)
  ▼
WebRTC SFU provider (managed, e.g. LiveKit/Daily/Twilio/Agora)
  │  room/session media routing, multi-subscriber fan-out
  ▼
Proctor dashboard (subscribes to assigned student rooms only)

                    ┌─────────────────────────────┐
                    │        SES backend           │
                    │ (Next.js API routes, Vercel)│
                    └─────────────────────────────┘
                    validates exam/session/proctor permissions
                    (institution → course/assignment → exam →
                     ProctorAssignment)
                    issues short-lived student/proctor media
                    tokens (via SFU provider's server SDK)
                    logs metadata/audit events
                    (LiveProctoringSession, ProctoringAccessLog)
                    NEVER touches video/screen/audio bytes
                    NEVER stores video/screen/audio
```

The SES backend never sits in the media path — it only ever calls the SFU provider's server-side API to create rooms/tokens and receives status webhooks (e.g., "track started," "participant disconnected") to update `LiveProctoringSession` metadata.

---

## 5. Data Model Proposal (schema additions only — not implemented)

### Role: do not add a global `PROCTOR` role as the primary mechanism

**Recommendation:** Add `PROCTOR` to the `Role` enum **only if** the platform needs standalone dedicated proctor accounts who are not also lecturers — a person whose only job is proctoring, with no exam-authoring capability. If added, `PROCTOR` controls broad platform-level eligibility ("this account type is allowed to appear in a proctor-dashboard route at all"), but it must **never** be the sole gate on what a proctor can see.

**Always add `ProctorAssignment` regardless**, because a global role answers "can this person ever proctor," not "can this person proctor *this* exam." Without exam-level assignment, a `PROCTOR`-role or `LECTURER`-role user would default to seeing every exam in the institution — a serious over-broad-access risk, especially across departments/courses within one institution. This mirrors the existing lesson from `ExamAssignment`/`CourseEnrollment`: SES already treats "can act on the institution" and "can act on this specific exam" as two separate, both-required checks, and proctoring should follow the same pattern.

A lecturer who owns/manages an exam can act as its proctor without a separate `ProctorAssignment` row (ownership already implies visibility), but a *different* lecturer or a dedicated proctor account needs an explicit assignment.

```
model ProctorAssignment {
  id            String       @id @default(cuid())
  institutionId String
  examId        String
  userId        String
  role          ProctorRole  // LEAD_PROCTOR | PROCTOR | VIEW_ONLY_PROCTOR
  createdById   String       // the lecturer who granted this assignment
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt

  @@unique([examId, userId])
  @@index([examId])
  @@index([userId])
  @@index([institutionId])
}
```

Rules:
- A lecturer may create/revoke `ProctorAssignment` rows only for exams where `exam.createdById === session.user.id` (or, later, a co-owner model — out of scope here) — same pattern as `getOwnedExam`.
- A proctor (whether `PROCTOR` role or a lecturer acting as proctor) may only view exams where a `ProctorAssignment` row exists for them, enforced identically to `assertSameInstitution` — a dedicated helper (e.g. `assertProctorAssigned`) should be the single choke point, following the existing `institutionScope.ts` pattern exactly.
- Cross-institution assignment is forbidden: `ProctorAssignment.institutionId` must match both the exam's institution and the assigned user's institution — reject at creation time, not just at read time.
- `ProctorAssignment` never grants grading rights (`Answer.score`/`feedback` writes) or exam-editing rights (`PATCH /api/exams/[id]`) — those remain gated purely by the existing `LECTURER` + ownership check. A `PROCTOR`-role user with an assignment can view; a `LECTURER` who is also assigned can additionally edit/grade because they already have that right independently.

### `LiveProctoringSession` — persisted, metadata-only

**Recommendation: persist it**, not keep it purely ephemeral in the SFU provider's own state, because:
- Reconnect/resume needs a durable record of "this student's session existed and was in state X" independent of the SFU's own (often short-TTL) room state.
- The evidence report and audit trail need something to join against after the exam ends and the SFU room is torn down.
- It gives SES a place to record `cameraStatus`/`screenStatus` transitions without depending on the vendor's own dashboard/logs, which keeps the vendor swappable (Part 9).

```
model LiveProctoringSession {
  id             String                    @id @default(cuid())
  institutionId  String
  examId         String
  submissionId   String
  studentId      String
  provider       String                    // e.g. "livekit" — matches provider abstraction key
  providerRoomId String
  status         LiveProctoringStatus      // WAITING | LIVE | DISCONNECTED | ENDED
  cameraStatus   LiveProctoringTrackStatus // NOT_STARTED | LIVE | STOPPED | ERROR
  screenStatus   LiveProctoringTrackStatus // NOT_STARTED | LIVE | STOPPED | ERROR
  startedAt      DateTime?
  endedAt        DateTime?
  createdAt      DateTime                  @default(now())
  updatedAt      DateTime                  @updatedAt

  @@unique([submissionId])
  @@index([examId])
  @@index([studentId])
  @@index([institutionId])
}
```

Explicitly: **metadata only.** No media content, no screenshots, no thumbnails, no recording URLs, no audio/video blobs — none of those fields exist in this model by design, and none should ever be added to it in v1.

### `ProctoringAccessLog` — staff accountability, kept separate from student integrity events

```
model ProctoringAccessLog {
  id            String               @id @default(cuid())
  institutionId String
  examId        String
  submissionId  String?
  studentId     String?
  proctorUserId String
  action        ProctoringAccessAction // VIEW_EXAM_DASHBOARD | VIEW_STUDENT_LIVE_SESSION |
                                        // FLAG_INCIDENT | ADD_NOTE | LEFT_SESSION
  metadata      Json?
  createdAt     DateTime             @default(now())

  @@index([examId])
  @@index([proctorUserId])
  @@index([createdAt])
}
```

This is deliberately a **separate table from `IntegrityEvent`**: normal proctor viewing behavior must never be conflated with a student integrity signal. Mixing them would corrupt the existing risk-score calculation (`src/lib/integrityRisk.ts`, which sums severity weights purely over `IntegrityEvent` rows) with staff-activity noise, and would misrepresent "a proctor opened this student's stream" as something that counts against the student.

### `ProctoringIncident` — recommend a separate model, not overloading `IntegrityEvent`

A proctor's manual flag ("I observed something suspicious while watching this student live") is qualitatively different from an automated browser-signal event (`WINDOW_BLUR`, `COPY_ATTEMPT`, etc.) — it's a human judgment call made in real time, often without a precise reproducible trigger, and it should carry a human-authored note by default. Representing it as a new `IntegrityEventType` value would force it through the CSV/analytics/risk-score pipeline built for structured signal types, which isn't the right fit for free-text human observations.

```
model ProctoringIncident {
  id            String   @id @default(cuid())
  institutionId String
  examId        String
  submissionId  String
  studentId     String
  proctorUserId String
  severity      IntegritySeverity  // reuse existing enum for consistency
  note          String
  createdAt     DateTime @default(now())

  @@index([examId])
  @@index([submissionId])
}
```

If cross-cutting reporting later needs a unified timeline (integrity events + incidents together), build that as a read-time merge in the evidence report, not a shared table — keeps each source's write path and validation independent.

### New enum values requiring migration

`ProctorRole`, `LiveProctoringStatus`, `LiveProctoringTrackStatus`, `ProctoringAccessAction` are all **new enums**, and `Role.PROCTOR` (if chosen) is a new value on an **existing** enum. All of these require a schema migration (`prisma migrate` in a real environment, applied via the documented production DDL process in `docs/network-evidence-and-ip-location.md`'s "Production deployment" section as a template — generate SQL via `prisma migrate diff --from-empty --to-schema-datamodel` and apply manually in production per that existing pattern, never `prisma db push` against production). **Not implemented here — flagged only.**

---

## 6. Role and Permission Proposal

| Concern | Mechanism |
|---|---|
| "Can this account type ever act as a proctor?" | `Role.PROCTOR` (if added) or `Role.LECTURER` |
| "Can this specific person proctor this specific exam?" | `ProctorAssignment` row, always required (except exam owner) |
| "Can this proctor grade?" | Only if they independently hold `Role.LECTURER` **and** exam ownership/co-management — `ProctorAssignment` alone never grants this |
| "Can this proctor edit the exam?" | Same — never granted by `ProctorAssignment` alone |
| Cross-institution boundary | `institutionScope.ts` pattern, unchanged, applied identically to every new proctoring route |

Global role controls *eligibility for the UI surface to exist at all*; assignment controls *which specific exam's data that UI surface may show*. Relying on the global role alone would mean any proctor-role account could see every exam in the institution by simply visiting the URL — an unacceptable over-broad grant given how granular the existing course/assignment model already is.

---

## 7. Student Consent / Privacy Design

**A new, explicit setting: `Exam.secureSettings.liveProctoringEnabled` (boolean, default `false`).** This must **not** be inferred from `requireCamera` — a student today can be asked to keep a local camera preview on (a much lower-invasiveness feature already shipped) without any expectation that a person is watching live. Silently reusing `requireCamera` for the new meaning would retroactively change what every existing camera-required exam means to students, which is unacceptable. Screen sharing must be its own flag too (e.g. `liveScreenShareRequired`), since a lecturer might in principle want live camera without screen (though the product default should likely require both together for actual proctoring value — a Phase 0 decision, not assumed here).

**Student consent screen — visually distinct from the existing camera-monitoring checklist**, not an added bullet point on it. Recommended plain-language anchor text:

> "Your camera and screen may be viewed live by authorised proctors during this exam. This session is not recorded in v1."

Must also state, on the same screen:
- **Who may view it:** named/counted authorised proctors assigned to this specific exam (not "anyone at the institution").
- **When viewing starts:** from the moment the student's live session becomes `LIVE` (i.e., after explicit consent + camera/screen grants succeed), not from exam page load.
- **When viewing ends:** at submission or session end — should be phrased so students understand the boundary precisely.
- **Nothing is recorded in v1** — repeated here, not just in a footnote.
- **Screen sharing is required** and **camera sharing is required** (both, explicitly, if the product requires both).
- **What happens if either stops:** camera/screen loss produces a status event and proctor alert; it does not silently end the exam, but does end live proctoring coverage until restored (see Part 8 for the exact behavior).
- **Access/integrity events may still be logged** — i.e., the existing Camera Monitoring v1 / Secure Exam Mode v1 event pipeline continues to operate alongside live proctoring, not replaced by it.
- **The lecturer/institution makes the final academic decision** — same disclaimer principle as `EVIDENCE_DISCLAIMER` in `src/lib/evidenceReport.ts`.

**Recommended governance layering:**
- **Institution-level opt-in** before any lecturer at that institution can enable `liveProctoringEnabled` on an exam — analogous to the `GEOLOCATION_PROVIDER` pre-activation checklist pattern in `docs/network-evidence-and-ip-location.md`, since live proctoring is a comparable step-change in data sensitivity and sub-processor exposure.
- **Exam-level opt-in** by the lecturer, per exam (not a global lecturer setting).
- **Student acknowledgement per attempt** — every time a student starts (not resumes an already-live) a live-proctored exam, not a one-time platform-level consent.
- **Updated student privacy notice** at `/privacy/student-exam-notice` naming the SFU vendor and describing what's transmitted (not stored).
- **Proctor access logging visible to institution/platform admins** — `ProctoringAccessLog` should be queryable by admins, mirroring `PlatformAuditLog`'s existing purpose.
- Explicitly forbidden regardless of consent: no hidden viewing, no silent recording, no AI misconduct decision, no face recognition, no gaze tracking, no biometric identity verification — none of these appear anywhere in this design, and none should be added under a "v1.1" label without a fresh, separate privacy review.

---

## 8. What Happens If Screen Share / Camera Fails or Is Denied

**Screen share denied/fails before exam start (when required):**
- The student must **not** enter the live-proctored exam.
- Show: *"This exam requires screen sharing. Please share your full screen to continue."*
- Do **not** silently downgrade to camera-only, and do **not** silently fall back to plain Secure Exam Mode (no live proctoring) — either of those would misrepresent the exam's actual proctoring state to the student, the lecturer, and (implicitly) any downstream academic integrity review.
- Do **not** create a `LiveProctoringSession` row that looks `LIVE` when it isn't — record only that entry was attempted and blocked (a metadata/integrity signal), never a fabricated "live" status.

**Screen share starts, then stops mid-exam:**
- Notify the student clearly and immediately (visible banner, not just a log entry).
- Update `LiveProctoringSession.screenStatus` to `STOPPED` and reflect this on the proctor dashboard's connection-state indicator for that student.
- Record a `SCREEN_SHARE_STOPPED` status event (Part 11).
- Surface this to the assigned proctor(s) as a reviewable incident, not a silent gap.
- Do **not** auto-submit the exam — mirrors the existing principle that camera loss never blocks or force-ends an exam (`docs/secure-exam-threat-model.md`).
- Do **not** block autosave — answer-saving must remain independent of proctoring session health, exactly as it is independent of camera health today.
- Do **not** silently continue rendering the student as "fully proctored" on the dashboard — the UI must show the degraded state honestly.

**Camera fails or is denied (live-proctoring context):** identical principle — a live-proctored exam requiring camera cannot start without it; on mid-exam failure, record metadata only (never attempt a video frame capture as a "fallback screenshot," which would be recording by another name and directly violates the no-recording rule).

---

## 9. Student UX Design

**Pre-exam flow:**
1. Student opens exam from dashboard or the existing safe deep link (`/student/exams/join/[examId]`) — no changes needed here, live proctoring is a downstream gate, not a new entry point.
2. Existing checks apply unchanged: login → institution → course/enrolment/assignment → published → schedule window → access code.
3. **New:** live proctoring notice (Part 7), visually distinct from the existing camera checklist.
4. Student explicitly acknowledges live camera/screen viewing (a real, logged consent action — e.g., a checkbox + button, not implied by clicking "Start").
5. Student enables camera (existing `getUserMedia` flow, reused).
6. Student shares screen (**new** — the browser's `getDisplayMedia()` API, which does not exist anywhere in the codebase today and would need its own permission-denial handling, distinct from camera denial).
7. Student enters the live-proctored exam only once both grants succeed and the SES backend confirms a `LiveProctoringSession` reached `LIVE`.

**During the exam**, the student must always be able to see, at a glance:
- Whether live proctoring is active (not just "camera required" — a status distinct from the existing local-preview widget).
- Whether camera sharing is currently active.
- Whether screen sharing is currently active.
- Connected/disconnected state (network-level to the SFU, separate from camera/screen device state).
- The existing local camera preview (Persistent Camera Preview v1) can and should remain — it's still useful feedback even though the same stream is now also being viewed live, and removing it would be a regression.
- A clear, immediate alert if camera or screen sharing stops.
- Answers/autosave continue regardless of proctoring connection state.
- **No misleading "secure"/"live" indicator when streams are actually disconnected** — this is a correctness requirement, not a cosmetic one: a green "proctoring active" badge showing while the underlying stream is dead would be actively harmful (false confidence for the institution, false sense of being unwatched for the student — both bad).

---

## 10. Proctor Dashboard Design

**Route:** `/proctor/exams/[examId]` — a new top-level area, following the same directory-per-role convention as `/lecturer/*` and `/student/*`, gated in `src/proxy.ts` the same way (a new `pathname.startsWith("/proctor")` branch checking role **and** — critically, unlike the existing three branches — a per-exam `ProctorAssignment` check that middleware alone cannot fully express, so the route handler/page must still re-verify assignment server-side, matching the existing pattern where middleware does coarse role gating and route handlers do the fine-grained resource check).

**Dashboard contents:** exam title/course/schedule; live proctoring status; assigned proctors; student roster split into active/waiting/disconnected/submitted; per-student camera/screen status; risk/event indicators (reusing existing `IntegrityEvent`/risk-score data, not duplicating it); search/filter; a live-view panel for a selected student; flag-incident and add-note actions; an event timeline; the proctor access log (visible to lead proctor/lecturer only, not every assigned proctor, to keep the accountability layer itself accountable); and a persistent, unambiguous **"not recorded" label** on the live-view panel itself — not just in a help page.

**Student live-view panel:** camera stream tile, screen stream tile, student name/email, submission status, camera/screen connection status, latest integrity events (read-only feed from existing `IntegrityEvent` data), flag-incident button, add-note button.

**Hard rules (mirroring the existing ownership/institution patterns exactly):**
- A proctor cannot edit the exam unless they are also the lecturer/owner (or, later, co-manager) — this falls out naturally from never letting `ProctorAssignment` alone satisfy the existing `getOwnedExam` check.
- A proctor cannot grade unless they independently hold grading permission — same reasoning.
- A proctor cannot see exams they aren't assigned to, or exams outside their institution — `assertProctorAssigned` + `assertSameInstitution`, both required, following the existing "always both checks" pattern from course/assignment scoping.
- A proctor never sees `accessCodeHash`, and never sees `correctAnswer` before whatever review state the product defines as appropriate (today, `correctAnswer` is already scoped out of every student-facing response; the same discipline must extend to proctor-facing responses, which is new attack surface since proctors are a new audience for exam-adjacent data).
- Every dashboard view and live-session view is written to `ProctoringAccessLog` — accountability by default, not opt-in.

---

## 11. Media Provider Abstraction Design

```
// src/lib/proctoring/provider.ts (interface sketch — not implemented)

interface ProctoringProvider {
  createRoom(input: { examId: string; submissionId: string; studentId: string }): Promise<{ roomId: string }>;
  createStudentToken(input: { roomId: string; studentId: string; submissionId: string }): Promise<{ token: string; expiresAt: Date }>;
  createProctorToken(input: { roomId: string; proctorUserId: string; scope: "view" }): Promise<{ token: string; expiresAt: Date }>;
  endRoom(input: { roomId: string }): Promise<void>;
  getRoomStatus(input: { roomId: string }): Promise<{ status: "waiting" | "live" | "ended" }>;
}
```

**Implementations:**
- `StubProctoringProvider` — the only implementation that ships before Phase 3. It must **never fake a live video state**: `createRoom`/`createStudentToken`/`createProctorToken` should either throw a clear "not configured" error or return a status that the UI renders as "Live media provider is not configured" — never a placeholder video, never a synthetic "connected" badge. This matters because a fake-live UI during early development could be mistaken for a real capability by anyone glancing at a demo.
- `LiveKitProvider` / `DailyProvider` / `TwilioVideoProvider` / `AgoraProvider` — future, one per chosen vendor, each implementing the same interface, selected via a single config value (e.g. `PROCTORING_PROVIDER` env var) so the rest of the codebase never branches on vendor identity.

**Hard rules:**
- Media never routes through Next.js API routes — API routes only ever call `createRoom`/`createStudentToken`/`createProctorToken`/`endRoom`/`getRoomStatus`, all of which return metadata/tokens, never media bytes.
- All tokens short-lived (minutes, not hours) and single-purpose.
- A student token can **publish only their own** camera/screen tracks — never subscribe to anyone else's.
- A proctor token can **subscribe only to rooms/students they're assigned to** — enforced by SES before minting the token (the token itself is scoped to one room by the provider's own token semantics, but SES must never mint a token for a room the caller isn't authorized to see).
- A proctor token **does not publish media in v1** — no two-way audio/video from proctor to student; that's an explicitly separate future decision (does a proctor need to talk to a student mid-exam? Not assumed here).

---

## 12. Security and Access-Control Design

All of the following are **mandatory**, and every one of them already has a direct precedent in the current codebase that the new code must match, not merely resemble:

- Institution boundary remains hard — `assertSameInstitution`, unchanged, applied to every new proctoring route.
- Proctor must belong to the same institution as the exam — enforced at `ProctorAssignment` creation **and** at every read.
- Proctor can only access exams they're assigned to proctor — `assertProctorAssigned`, new helper, same choke-point discipline as `institutionScope.ts`.
- Lecturer can manage proctors only for exams they own/manage — reuses `getOwnedExam`.
- Platform admin access must be carefully considered and **audit-logged** — platform admins already bypass institution scoping (`isPlatformAdmin`); for live proctoring specifically, even a platform admin viewing a live student stream should hit `ProctoringAccessLog`, since "support/ops bypass" and "watching a student's live camera" are not equivalent levels of intrusion, even when both are technically permitted.
- Student can only publish their own camera/screen tracks; cannot subscribe to any other student — enforced by the provider abstraction issuing publish-only, self-scoped student tokens.
- Proctor token cannot access unassigned rooms; must be scoped to one exam/one student room; short-lived; no global proctor media token, ever.
- No unauthenticated media access — every token mint requires an authenticated SES session first.
- No open redirect through live proctoring routes — reuse `isSafeJoinCallbackUrl`-style strict-path validation if any new deep-link-style entry point is added for proctors (e.g. a direct link to a specific student's live view); do not introduce a new unvalidated redirect pattern.
- Course assignment, access code, and schedule windows **still apply** — live proctoring is an additional gate layered on top of the existing `start`/`access-check` chain, never a replacement or shortcut past it.

**Proctor-facing and student-facing APIs must never expose:** `passwordHash`, `accessCodeHash`, `correctAnswer` before the appropriate review state, network evidence unless the caller is authorized for it (today, gated to exam owner/platform admin — proctors are a new audience needing the same explicit gate), students from other courses/exams/institutions, unrelated submissions, vendor secrets (API keys, admin credentials), or room admin tokens (only scoped view/publish tokens should ever reach a client).

---

## 13. Integrity Events and Audit Logging Design

**Student/session status events** (new `IntegrityEventType` values, or — better — a parallel enum on `LiveProctoringSession`/its own event log, to avoid diluting the existing risk-score model with connection-status noise that isn't a browser-behavior signal in the same sense as `WINDOW_BLUR`):

`LIVE_PROCTORING_JOINED`, `LIVE_PROCTORING_DISCONNECTED`, `CAMERA_STREAM_STARTED`, `CAMERA_STREAM_STOPPED`, `SCREEN_SHARE_STARTED`, `SCREEN_SHARE_STOPPED`, `SCREEN_SHARE_DENIED`, `PROCTORING_SESSION_ENDED`.

**Recommendation:** these should live as `LiveProctoringSession` status transitions (queryable history, e.g. a lightweight append-only `LiveProctoringSessionEvent` table or a JSON transitions log on the session row) rather than as new `IntegrityEventType` enum values feeding `computeRiskScore`. Reasoning: `src/lib/integrityRisk.ts`'s severity-weight model was designed for behavioral signals (copy/paste, tab-switch, fullscreen exit) where frequency and severity map to suspicion. Connection-status events (camera dropped because a laptop went to sleep, screen share stopped because of an OS permission dialog) are not inherently suspicious in the same way, and blending them into the same weighted sum risks systematically inflating risk scores for students with flaky hardware/networks — a fairness problem, not just a modeling nicety.

**Staff access logs** (`ProctoringAccessLog.action`): `VIEW_EXAM_DASHBOARD`, `VIEW_STUDENT_LIVE_SESSION`, `FLAG_INCIDENT`, `ADD_NOTE`, `LEFT_SESSION`.

**Non-negotiable:** proctor access logs stay in a separate table from student integrity events (already reflected in the schema proposal above); normal proctor viewing must never appear as a student misconduct signal; no video content, screen images, audio, thumbnails, or snapshots are ever logged, in either table, under any field name.

**Migration note:** any new enum (`ProctorRole`, `LiveProctoringStatus`, `LiveProctoringTrackStatus`, `ProctoringAccessAction`, and optionally new `IntegrityEventType`/new dedicated event-type values if that path is chosen instead) requires a schema migration. Recommended strategy when the time comes: follow the existing additive-migration discipline used for every prior feature in this codebase (Camera Monitoring v1, Course/Enrolment v1, Multi-Tenant v1) — new nullable columns/new enum values only, backfill scripts where needed, generate SQL via `prisma migrate diff --from-empty --to-schema-datamodel` and apply manually in production per `docs/network-evidence-and-ip-location.md`'s existing pattern, never `prisma db push` against production. **Not implemented here — flagged only.**

---

## 14. Data Retention Design

Because v1 is live-only by explicit requirement:

**Never store:** camera footage, screen footage, audio, screenshots, thumbnails. **Never enable:** vendor cloud recording, vendor automatic recording — this must be an explicit, verified-off configuration on whichever SFU provider is chosen (most commercial providers default recording to *off* but make it easy to enable per-room; the SES provider abstraction should make it structurally impossible to accidentally pass a "record: true" flag, e.g. by simply never exposing that parameter in the `ProctoringProvider` interface at all).

**Allowed metadata:** session start/end time, connection status transitions, camera/screen status, "proctor viewed this session" log entries, proctor incident notes, proctor flags, disconnect events.

**Recommendation:** short retention for proctoring metadata by default (e.g. aligned to the institution's existing academic-integrity review window, not indefinite), with institution-level retention configuration deferred to a later release (mirrors how `docs/known-limitations.md` already flags "institution-level retention settings later" as a known gap for other data types). A clear, written deletion/retention policy should exist before this ships, even for metadata-only data, since it still includes staff activity logs that touch student records.

---

## 15. Cost Model and Pilot-Scale Estimate

**No vendor pricing was found in the local repository or docs** — none of the existing docs reference a video/SFU vendor's pricing. All figures below are **formulas with clearly labelled approximate placeholders**, not quotes.

**Core formula:**
```
participant-minutes = students × exam duration (minutes) × average concurrent viewers per student
```

Where "average concurrent viewers per student" depends on the proctor-viewing model chosen:
- **All students as thumbnails, always:** every proctor subscribes to every student's camera + screen continuously → viewers per student ≈ number of proctors on duty (1-3).
- **Selected students in detail, others idle:** most of the time, 0 proctors actively viewing a given student's detail feed, only occasional spot-checks — dramatically lower participant-minutes, but likely still requires low-res thumbnail feeds for the "all students" overview, which is its own (smaller) per-student cost.
- **Only flagged/disconnected students:** lowest cost, but arguably lowest live-proctoring value — a product/policy tradeoff, not just a cost one.

**Worked formula examples (approximate, illustrative only — not vendor quotes):**

| Students | Proctors | Exam length | Model | Approx. participant-minutes |
|---|---|---|---|---|
| 10 | 1 | 60 min | all-thumbnails | 10 × 60 × 1 = 600 |
| 25 | 2 | 60 min | all-thumbnails | 25 × 60 × 2 = 3,000 |
| 40 | 3 | 120 min | all-thumbnails | 40 × 120 × 3 = 14,400 |

Each student also publishes **two tracks** (camera + screen) regardless of how many proctors view — this roughly **doubles** the publish-side bandwidth/track-count cost versus a camera-only design, independent of the viewer-side participant-minute formula above; many providers price publish (ingest) and subscribe (egress/view) differently, so this doubling should be modelled as a separate cost line, not folded into the viewer-minutes number.

**Likely bandwidth sensitivity:** screen-share tracks (especially at higher resolution/frame rate for legibility of on-screen text) are typically more bandwidth-intensive than a small camera tile — this is a real cost and reliability variable, not just a cosmetic one, and argues for the proctor dashboard defaulting to lower-resolution/lower-framerate screen tiles in the overview, with a higher-quality feed only when a proctor opens a student's detail view (an operational decision, not assumed as implemented here).

**Support/ops burden:** during every live exam window, someone needs to be reachable for "my screen share stopped and I can't restart it" / "the proctor dashboard shows me as disconnected but I'm still here" style incidents — this is a genuinely new, exam-time-critical support surface that doesn't exist for the current fully-local camera preview (where a dropped preview never affects proctor-side visibility because there is no proctor-side visibility yet).

**Why full recording would be far more expensive and is correctly out of scope for v1:** recording requires ongoing storage cost that scales with total exam-hours × number of tracks × resolution/bitrate (potentially large, and indefinitely accruing unless actively deleted), plus encryption-at-rest, plus access-control on stored media (a much higher-stakes leak surface than live-only viewing), plus its own separate retention/legal review. Nothing in this design proposes any of that, and Part 17 explicitly defers it to a hypothetical future Phase 5.

---

## 16. Risk Register

| # | Risk | Severity | Likelihood | Mitigation | Owner |
|---|---|---|---|---|---|
| 1 | Privacy — live camera/screen viewing is materially more invasive than local-only preview | High | Certain (inherent to the feature) | Explicit, distinct consent flow (Part 7); institution + exam opt-in gates; honest wording throughout product surfaces | Product/Privacy |
| 2 | Consent — student notice not sufficiently explicit or conflated with existing camera checklist | High | Medium | Visually distinct consent screen (Part 7); per-attempt acknowledgement, not one-time | Product |
| 3 | Vendor/sub-processor risk | Medium-High | Certain (any Option A vendor is a sub-processor) | Institution-level pre-activation checklist (mirroring `docs/network-evidence-and-ip-location.md` pattern); privacy notice disclosure | Legal/Privacy |
| 4 | Data residency risk | Medium | Depends on vendor/plan | Confirm residency terms per-vendor at Phase 0 before commitment; do not assume | Legal/Ops |
| 5 | Browser permission friction (camera + screen share, two separate OS/browser prompts) | Medium | High | Clear pre-exam instructions; explicit denial messaging (Part 8); do not silently degrade | Product/Support |
| 6 | Screen-share interruption mid-exam | Medium | Medium-High (screen share is more prone to accidental stop than camera, e.g. switching monitors) | Status event + proctor alert (Part 8/13); never auto-submit | Engineering |
| 7 | Camera interruption mid-exam | Medium | Medium (same class of risk as today's Camera Monitoring v1, already observed) | Reuse existing heartbeat/status pattern, extended to live session state | Engineering |
| 8 | Student network bandwidth (two published tracks, sustained for full exam) | Medium | Medium-High for weaker home/campus connections | Lower default screen-share resolution/framerate; clear "check your connection" guidance pre-exam | Engineering/Support |
| 9 | Proctor workload (watching many live feeds is fatiguing and error-prone) | Medium | High at scale (1 proctor : many students) | Recommend a documented max students-per-proctor ratio (Phase 0 decision); thumbnail + detail-view model, not mandatory full-attention-on-all | Product/Ops |
| 10 | False confidence — live proctoring is not cheat-proof | High (reputational + academic-integrity) | Certain if wording is unclear | Enforce the banned-word list throughout every product surface and doc; explicit "not cheat-proof" framing, matching existing `docs/secure-exam-threat-model.md` tone | Product |
| 11 | Accessibility/accommodation concerns (camera/screen requirements may conflict with disability accommodations) | Medium-High | Medium | Institution-level policy for accommodation exceptions; needs its own decision before Phase 0 sign-off, not addressed by engineering alone | Institution/Policy |
| 12 | Support burden during live exams | Medium | High (new, real-time-critical support surface) | Staffed support window during every live-proctored exam; documented escalation path | Ops/Support |
| 13 | Cost overrun from participant-minute/media usage | Medium | Medium (formulas in Part 15 are estimates, not commitments) | Usage monitoring/alerting on the SFU provider dashboard; a per-exam cost ceiling policy | Finance/Ops |
| 14 | Reputational risk if wording is unclear ("surveillance," "cheat-proof," etc.) | High | Medium if not actively enforced | Explicit banned-word list; review pass on every UI string before ship | Product/Legal |
| 15 | Security risk from overbroad media tokens | High | Low if the abstraction (Part 11) is followed correctly | Short-lived, single-purpose, self-scoped tokens only; no global proctor token, ever | Engineering |
| 16 | Cross-institution data leakage | High | Low (existing `institutionScope.ts` pattern is mature) | Apply the exact same choke-point pattern to every new proctoring route; explicit tests | Engineering |
| 17 | Operational risk if SFU provider fails mid-exam | High | Low-Medium (provider-dependent) | Fallback plan: exam continues without live proctoring (never auto-fails the student); clear incident communication | Ops/Engineering |
| 18 | Tether Secure Browser vs normal-browser differences for screen sharing | Medium | Medium (Tether is Electron-based; `getDisplayMedia` behavior can differ from a standard browser) | Explicit test matrix entry for both environments before any pilot (Phase 4) | Engineering |
| 19 | Legal/policy risk if institution has not opted in | High | Low if the institution-level gate (Part 7) is enforced correctly | Hard gate in code, not just a policy document — mirrors the `GEOLOCATION_PROVIDER` pre-activation pattern | Engineering/Legal |
| 20 | Future recording scope creep | High (long-term trust risk) | Medium (a natural "just add recording" request once live viewing exists) | Explicit no-go list (Part 18) documented and referenced in every future related design; recording requires its own full separate review (Phase 5), never a quiet addition | Product/Legal |

---

## 17. Implementation Sequencing Recommendation

**Phase 0 — Product/legal/vendor decision (no code):** decide build timing relative to first pilot; confirm whether a pilot partner actually requires this; choose managed SFU vs self-hosted vs constrained peer-to-peer (recommendation: managed SFU); confirm privacy notice + institution consent design; confirm data residency/sub-processor acceptance; confirm pricing model against real vendor quotes; confirm audio in/out of scope; confirm whether proctors can message students.

**Phase 1 — Schema and permission foundation:** `ProctorAssignment`, `ProctoringAccessLog`, exam-level `liveProctoringEnabled` (+ screen-share flag), institution-level opt-in flag. **No real media yet — stub provider only.** Tests for access control (institution, assignment, ownership-vs-assignment distinction) — this phase is pure extension of patterns that already exist and already have test coverage precedent (`src/lib/courseEnrolmentExamAssignment.test.ts` as a direct model).

**Phase 2 — Student live-proctoring gate:** explicit consent screen; camera permission (reused); screen-share permission (new); `LiveProctoringSession` metadata creation/transitions; no live proctor dashboard yet unless a provider is actually configured (stub provider means the feature is visibly "not configured," never silently fake). Tests for permission denial and status events.

**Phase 3 — Proctor dashboard and provider integration:** real managed SFU integration; short-lived tokens; live camera/screen tiles; multi-proctor support; status alerts; incident flags; access logs. **No recording**, structurally enforced by the provider abstraction never exposing a record flag.

**Phase 4 — Pilot hardening:** load test at 10/25/40 students; test 1 and 3 proctors; weak-network test; screen-share stop/restart; camera stop/restart; normal browser and Tether Secure Browser (flagged as its own risk in Part 16, item 18); privacy notice and audit-log review; incident-review workflow test.

**Phase 5 — Optional future recording module (explicitly separate, not v1):** its own design document, its own consent model, its own retention policy, its own storage/encryption/access-logging design, its own pricing model, its own legal/privacy review. Nothing in Phases 0-4 should make this easier to slip in accidentally — the provider abstraction's interface (Part 11) deliberately has no recording-related method, which is itself a guardrail against scope creep.

---

## 18. Explicit No-Go Items for v1

No video recording. No screen recording. No audio recording. No screenshots. No thumbnails persisted as image data (a live low-res *stream* tile in the UI is not the same as a stored thumbnail — the distinction must be preserved in both code and language). No cloud recording. No hidden camera access. No hidden screen access. No face recognition. No gaze tracking. No biometric verification. No AI cheating decision. No automatic misconduct finding. No proctor access without assignment. No cross-institution proctor visibility. No global media admin token. No media streaming through Next.js API routes. No claim of being cheat-proof. No silent downgrade from live-proctored to non-proctored mode.

---

## 19. Product-Owner Decision Checklist Before Implementation

1. Should Live Proctoring v1 be built before or after the first normal controlled pilot?
2. Is live camera + screen viewing required by a confirmed pilot partner (not a hypothetical future one)?
3. Which media architecture is chosen — managed SFU, self-hosted SFU, or constrained peer-to-peer?
4. Which specific vendor (if managed) or self-hosted stack (if not) is approved?
5. Is the chosen vendor approved as a sub-processor by the institution(s) involved?
6. Are the vendor's data residency terms acceptable to those institutions?
7. Is institution-level opt-in required before any lecturer can enable this? (Recommendation: yes.)
8. Is exam-level opt-in required in addition to institution-level? (Recommendation: yes.)
9. Is student acknowledgement required per exam attempt, or is a one-time platform consent acceptable? (Recommendation: per attempt.)
10. Is audio included or excluded in v1? (Not assumed in this document — camera + screen only, per the stated requirements; audio would need its own consent language and cost line.)
11. Can proctors message students during a live session? (Not assumed — affects both the provider abstraction (Part 11's "proctor token does not publish media" rule) and the UX design.)
12. Can proctors flag incidents only, or also add free-text notes? (This document assumes both are needed — `ProctoringIncident.note` and `ProctoringAccessLog` `ADD_NOTE` action both exist in the proposal.)
13. How many students can one proctor reasonably supervise? (No number is assumed here — this is a policy decision with real workload/quality implications, flagged in Risk #9.)
14. What is the actual pilot concurrency target — 10, 25, or 40 students, and how many proctors?
15. What is the maximum acceptable cost per exam attempt, given the participant-minute formula in Part 15?
16. What exactly happens if screen sharing fails mid-exam — is the current recommendation (notify, log, never auto-submit) acceptable, or does policy require something stricter (e.g., auto-flag for mandatory review)?
17. What happens if the SFU provider itself goes down mid-exam — does the exam continue without live proctoring, or is there a stricter fallback policy?
18. How long should proctoring metadata logs be retained?
19. Who can view `ProctoringAccessLog` — institution admins only, platform admins only, or both?
20. Is recording explicitly and permanently out of scope for v1 (yes, per this document), with any future recording work requiring a fresh, separate design and privacy review?

---

## 20. Clear Recommendation

**Defer Live Proctoring v1 until after the first controlled pilot**, unless a confirmed pilot partner has stated it as a hard requirement — this is a genuinely new subsystem (real-time media, a new permission model, a new consent framework, new vendor/sub-processor exposure) layered on top of a product that has just reached controlled-pilot readiness on its existing, already-substantial feature set. Shipping it prematurely risks both engineering quality (rushing a security- and privacy-sensitive subsystem) and product trust (the framing risk in Risk Register item 14 is real: getting the language wrong on a feature this invasive could damage credibility with exactly the institutions SES needs for its first pilots).

**If building anyway:** start with **Option A, managed SFU**, behind the abstraction in Part 11, following the phased sequence in Part 17 exactly — Phase 1 (schema/permissions, stub provider) can and should ship independently of vendor selection, since it's pure extension of proven patterns already in this codebase.

**Decisions required before any code is written:** all twenty items in Part 19's checklist, but especially #1 (timing), #2 (is it actually required), #3-6 (architecture + vendor + sub-processor approval), and #7-9 (consent governance) — these are not engineering decisions and cannot be defaulted by whoever implements Phase 1.
