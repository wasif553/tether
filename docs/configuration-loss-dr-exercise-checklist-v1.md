# Configuration-Loss DR Exercise Checklist v1

**Exercise scenario:**

- Source code remains recoverable from Git.
- The current operator laptop / local `.env` is considered **lost**.
- The current deployment's environment configuration is assumed
  **unavailable**.
- **No Production data is destroyed** by this exercise — it never
  touches a real database, a real Vercel project's actual environment
  variables, or a real Supabase project.
- The operator must reconstruct a **disposable/local** configuration
  using only the canonical register
  (`scripts/configurationRecovery/register.ts`) and **synthetic**
  recovery material generated specifically for the test.

See
[`docs/configuration-and-secrets-recovery-v1.md`](configuration-and-secrets-recovery-v1.md)
for the full framework and
[`docs/configuration-recovery-test-record-v1.md`](configuration-recovery-test-record-v1.md)
for the record this checklist feeds. Use one copy per exercise.

**Fail closed.** Any STOP CONDITION below halts the exercise at that
point.

---

## A. Preparation

- [ ] Exercise/Test ID assigned, matching the Configuration Recovery
      Test Record copy used alongside this checklist.
- [ ] Confirmed this exercise will use SYNTHETIC values only, generated
      specifically for this test — never a copy of any real `.env` file
      that might contain real credentials.
- [ ] Disposable target confirmed (local Postgres container, throwaway
      directory) — never a real Vercel/Supabase project.

**STOP if a real credential would be involved at any point.**

## B. Scenario declaration

- [ ] Loss scenario narrated: which configuration is assumed lost
      (typically: everything — laptop and deployment both unavailable).
- [ ] Confirmed this is Scenario A (loss, not compromise) OR Scenario B
      (suspected compromise) per
      `docs/configuration-and-secrets-recovery-v1.md` Section 6 — the
      exercise narrative should say which, since the correct response
      differs.

## C. Register consultation

- [ ] `scripts/configurationRecovery/register.ts` consulted for the
      variables relevant to this exercise's scope.
- [ ] `npm run config:recovery-audit` run BEFORE reconstruction begins,
      confirming the register/template are structurally sound
      (baseline check, not itself the recovery).

## D. Decision points

*(Work through each relevant item using its own recovery class — see the
register.)*

- [ ] **Exact-value preservation** — for any `PRESERVE_EXACT_VALUE` item
      in scope, decided: is the exact synthetic value recoverable in
      this exercise, or is this exercise explicitly testing the
      "genuinely lost" branch?
- [ ] **Provider reissue** — for any `ROTATE_OR_REISSUE`/`PROVIDER_LOOKUP`
      item in scope, a synthetic replacement generated and the
      documented rotation impact acknowledged.
- [ ] **Config reconstruction** — for any `RECONSTRUCT_CONFIGURATION`
      item, rebuilt from documented defaults/known values, never
      invented arbitrarily.
- [ ] **Optional module omission** — decided which optional
      integrations (Canvas/LTI, AI, geolocation, evidence storage) are
      IN scope for this exercise vs. deliberately omitted; omitted ones
      recorded as such, not silently skipped.
- [ ] **Compromise vs loss** — reconfirmed per item B above; a
      `PRESERVE_EXACT_VALUE` item under a COMPROMISE scenario is never
      simply restored to its old value — see Section 6, Scenario B.
- [ ] **Escalation** — decided whether this exercise's findings warrant
      escalating a real gap (e.g. "we actually could not reconstruct X
      without reading old config") as a follow-up item, not just closing
      the exercise silently.

## E. Reconstruction (synthetic, disposable only)

- [ ] Disposable local Postgres container started (never Production).
- [ ] Synthetic values generated for the in-scope secret classes (at
      minimum, per
      `docs/configuration-and-secrets-recovery-v1.md`'s own synthetic
      exercise record: database connection, `AUTH_SECRET`,
      `EXAM_BINDING_HMAC_SECRET`, `NETWORK_EVIDENCE_SALT`, one evidence-
      storage configuration in local/synthetic-safe mode, one optional
      provider key represented by a fake value, one asymmetric keypair
      generated fresh for the test if practical).
- [ ] Temporary environment file/holder used only for the duration of
      the exercise.

**STOP if a real credential is discovered mixed into the synthetic
material at any point — do not proceed with it.**

## F. Validation

- [ ] Application/tooling validated against the disposable/local
      infrastructure only.
- [ ] `npm run config:recovery-audit` re-run — confirms structural
      soundness of whatever configuration state resulted.
- [ ] Confirmed no secret value entered Git (git status/diff reviewed).
- [ ] Confirmed no secret value entered the Configuration Recovery Test
      Record or any exercise note.

## G. Cleanup

- [ ] Temporary/synthetic recovery material deleted.
- [ ] Disposable container(s) removed.
- [ ] `git status --short` confirms nothing stray was left in the
      repository.

**STOP if cleanup cannot be confirmed — do not close the exercise with
synthetic material still lying around.**

## H. Closeout

- [ ] Configuration Recovery Test Record completed.
- [ ] Result recorded: PASS / PARTIAL / FAIL.
- [ ] `CONFIGURATION_RECOVERY_SYNTHETIC_EXERCISE: PASS / PARTIAL / FAIL`
      stated explicitly — and explicitly NOT described as a Production
      recovery test.
- [ ] Findings and follow-up items recorded.

---

## Stop conditions (summary)

- A real credential would be involved at any point.
- A real Production database, Vercel project, or Supabase project would
  be contacted.
- Synthetic material is discovered to actually be, or contain, a real
  credential.
- Cleanup cannot be confirmed complete.
- A secret value is about to be written into this checklist, the test
  record, or any exercise note.
