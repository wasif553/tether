/**
 * Tether startup/deep-link routing v1 — pure decision logic. Deliberately
 * free of any Electron import (no `app`, no `Store`) so this runs under
 * plain vitest/node — main.ts is the thin Electron-touching glue that
 * calls these functions.
 *
 * Fixes the confirmed physical-testing bug: a normal launch (Start Menu,
 * desktop shortcut, installed .exe — no deep-link argv) opened directly
 * into whatever exam a PREVIOUS deep-link launch had used, instead of the
 * Tether Home/Dashboard. The previous `buildLoadUrl` in main.ts persisted
 * every deep-linked examId to electron-store as `lastExamId` and, on any
 * launch with no examId of its own, silently fell back to that stored
 * value — forever, across every future normal launch, until a different
 * deep link happened to overwrite it. That fallback predates this
 * package's v1.7.x version line entirely (introduced by "Tether
 * launch/install flow v1", long before the mid-exam monitoring work) — it
 * is not a regression from any recent change, just a latent bug that
 * physical testing had not previously exercised.
 *
 * The fix removes the persisted fallback outright: resolveStartupLoadUrl
 * takes no store parameter and therefore cannot read state left over from
 * an earlier launch. `examId` is null on a launch with no deep link
 * (normal Start Menu/shortcut/exe launch, a second-instance activation
 * with no deep-link argv, or a malformed deep link that carries no
 * examId) and always resolves to the plain dashboard route — never a
 * previous exam.
 */
import { buildTetherLaunchPath, isDeepLinkArg } from "./shared";

/**
 * The canonical Tether Home/Dashboard route in the web app (see
 * src/app/student/page.tsx in the main repo) — not invented here; this is
 * the same route the pre-existing (correct) "no examId, no stored
 * fallback" branch already used before the persisted-fallback bug was
 * introduced.
 */
export const TETHER_HOME_PATH = "/student";

/**
 * The ONE function that decides what URL a Tether launch loads —
 * `examId` present -> that exact exam's Tether launch flow;
 * `examId` null/empty -> the Home/Dashboard, always, regardless of any
 * previous launch. No persisted state is consulted, so a stale deep link,
 * submission id, exam id, or launch-manifest id from a prior session can
 * never become the next default startup target (Required behaviour C/D).
 */
export function resolveStartupLoadUrl(examId: string | null, sesBaseUrl: string): string {
  if (examId) return `${sesBaseUrl}${buildTetherLaunchPath(examId)}`;
  return `${sesBaseUrl}${TETHER_HOME_PATH}`;
}

/**
 * Extracts `examId` from a deep-link URL (`tether://...?examId=...` or
 * `ses://...?examId=...`). Never logs or returns the full URL — only the
 * bounded examId value, matching parseExamIdFromDeepLink's original
 * doc comment in main.ts. Returns null for a malformed URL or one with no
 * examId query param — both cases must resolve to Home via
 * resolveStartupLoadUrl above, never to some other fallback.
 */
export function parseExamIdFromDeepLinkUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("examId");
  } catch {
    return null;
  }
}

/** Finds the first deep-link-shaped argv entry (`tether://...` / `ses://...`), if any — used both at cold-start (process.argv) and on a second-instance activation (the new instance's argv). */
export function findDeepLinkArg(argv: string[]): string | null {
  return argv.find((a) => isDeepLinkArg(a)) ?? null;
}

/** Cold-start convenience: resolves the examId (if any) a fresh process should open, straight from its own argv — never from any persisted store. */
export function resolveInitialExamIdFromArgv(argv: string[]): string | null {
  const deepLinkArg = findDeepLinkArg(argv);
  return deepLinkArg ? parseExamIdFromDeepLinkUrl(deepLinkArg) : null;
}
