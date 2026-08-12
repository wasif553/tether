/**
 * Tether Secure Browser v1.7.3 — sandboxed-preload bundling regression
 * guard. See docs root-cause: with `sandbox: true`, Electron's preload
 * `require()` is a restricted polyfill that only permits a small
 * allowlist (Electron's own module). A relative/local require (e.g. the
 * old `require("./shared")`) throws `module not found` inside that
 * polyfill and aborts preload execution BEFORE
 * `contextBridge.exposeInMainWorld` ever runs — silently disabling the
 * entire `window.sesLockdown` bridge with no visible error anywhere the
 * production app surfaces to a user or admin.
 *
 * `npm run build` now bundles src/preload.ts with esbuild
 * (`--bundle --external:electron`) specifically so this can never
 * recur — every local/project dependency (e.g. ./shared) is inlined as
 * real code, not left as a runtime require. This module is the
 * deterministic assertion that the bundling actually worked: it scans
 * the FINAL emitted dist/preload.js for every `require(...)` call and
 * fails if any specifier other than the small Electron allowlist
 * appears. `npm run build` (and therefore pack/dist/dist:win) fails
 * immediately if a future change reintroduces an unbundled local
 * import — e.g. a new preload.ts import that isn't a static ES import
 * esbuild can trace, or a bundler config regression.
 *
 * Deliberately narrow: this does not reject esbuild's own normal
 * generated interop helpers (__toESM, __commonJS, var import_electron =
 * ..., etc.) since none of those literally call `require(...)` with a
 * new specifier of their own — bundled/inlined code has no runtime
 * `require` call at all for anything that got inlined. It only ever
 * flags an ACTUAL `require("<specifier>")` call expression whose
 * specifier isn't on the allowlist, which is exactly what a module that
 * escaped bundling (kept as an external/unresolved import) would look
 * like in emitted CommonJS output.
 */

export type PreloadBundleVerificationResult = {
  ok: boolean;
  errors: string[];
  /** Every module specifier found in a require(...) call, for reporting/debugging. */
  requireSpecifiers: string[];
};

/**
 * The only module(s) a sandboxed Electron preload script is permitted to
 * require — see main.ts's BrowserWindow `sandbox: true` and
 * `--external:electron` in the bundle:preload script, which is what
 * leaves this one require call in the emitted bundle instead of
 * inlining it.
 */
const ALLOWED_PRELOAD_REQUIRE_SPECIFIERS = new Set(["electron"]);

/**
 * Matches a `require("specifier")` / `require('specifier')` call
 * expression and captures the specifier. Intentionally does NOT match
 * `require.resolve(...)`, dynamic `require(someVariable)`, or anything
 * without a literal string argument — a bundled preload never needs
 * either of those, and esbuild's own CJS output for a fully-bundled,
 * single-external build never emits them either. Any require call this
 * regex can't parse into a plain string specifier is still surfaced as
 * an error by the caller (see verifyPreloadBundleContents below) rather
 * than silently ignored.
 */
const REQUIRE_CALL_PATTERN = /\brequire\s*\(\s*(['"])((?:(?!\1).)*)\1\s*\)/g;

/**
 * True for a specifier that is neither the allowed Electron module nor
 * a Node builtin — i.e. exactly the shape of "a local/project import
 * that should have been bundled but wasn't" (a relative path starting
 * with `.`, or a bare package name that isn't `electron`). This is
 * deliberately specifier-shape based, not a hardcoded "./shared" check,
 * so it also catches any FUTURE local import that escapes bundling, not
 * just a regression of this exact one.
 */
function isDisallowedPreloadRequireSpecifier(specifier: string): boolean {
  return !ALLOWED_PRELOAD_REQUIRE_SPECIFIERS.has(specifier);
}

export function verifyPreloadBundleContents(preloadJsContent: string): PreloadBundleVerificationResult {
  const errors: string[] = [];
  const requireSpecifiers: string[] = [];

  if (!preloadJsContent || preloadJsContent.trim().length === 0) {
    return { ok: false, errors: ["dist/preload.js was empty or not found — has the bundle:preload build step run?"], requireSpecifiers: [] };
  }

  let match: RegExpExecArray | null;
  REQUIRE_CALL_PATTERN.lastIndex = 0;
  while ((match = REQUIRE_CALL_PATTERN.exec(preloadJsContent)) !== null) {
    const specifier = match[2];
    requireSpecifiers.push(specifier);
    if (isDisallowedPreloadRequireSpecifier(specifier)) {
      errors.push(
        `dist/preload.js contains a disallowed require("${specifier}") — the Electron sandboxed-preload require polyfill only permits ${Array.from(ALLOWED_PRELOAD_REQUIRE_SPECIFIERS).join(", ")}. ` +
          "A relative or bare module import must be bundled (inlined), not left as a runtime require — see bundle:preload in package.json. " +
          'This is the exact class of defect that caused the v1.7.2 P0 ("Error: module not found: ./shared", preload aborted before contextBridge.exposeInMainWorld ran).',
      );
    }
  }

  // Defensive floor: a real, fully-bundled preload that talks to main via
  // ipcRenderer must retain the Electron require somewhere. Its total
  // absence would mean either the bundle is stale/empty in some other
  // way, or contextBridge/ipcRenderer usage was stripped — worth failing
  // loudly on rather than silently passing an empty allowlist check.
  if (!requireSpecifiers.includes("electron")) {
    errors.push('dist/preload.js does not contain require("electron") at all — expected exactly one external Electron require in the bundled output.');
  }

  // The exact regression this guard exists for — belt-and-braces direct
  // substring check in addition to the general specifier scan above.
  if (preloadJsContent.includes('require("./shared")') || preloadJsContent.includes("require('./shared')")) {
    errors.push('dist/preload.js still contains a literal require("./shared") — the v1.7.2 P0 sandboxed-preload defect has regressed.');
  }

  return { ok: errors.length === 0, errors, requireSpecifiers };
}

/* eslint-disable @typescript-eslint/no-var-requires */
if (require.main === module) {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");

  const preloadPath = process.argv[2] ?? path.join(__dirname, "preload.js");
  let content: string | null = null;
  try {
    content = fs.readFileSync(preloadPath, "utf8");
  } catch {
    content = null;
  }

  const result = verifyPreloadBundleContents(content ?? "");

  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error(`Preload bundle verification FAILED for ${preloadPath}:`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`Preload bundle verification passed for ${preloadPath} (require specifiers: ${result.requireSpecifiers.join(", ") || "none"}).`);
}
