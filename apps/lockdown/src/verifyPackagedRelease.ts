/**
 * Tether Secure Browser — corrective pass v1.2.1, Task D. "Add an
 * automated packaging assertion that verifies the release application
 * contains the current display-enforcement implementation and version."
 *
 * The Task D root-cause hypothesis this guards against: the physically
 * tested .exe may not have actually contained the source changes it was
 * assumed to (a stale unpacked build, an NSIS install that didn't fully
 * overwrite an older version, a launch from a cached/old shortcut). This
 * module can't rule that specific incident in or out after the fact, but
 * it makes it impossible to silently repeat going forward: `npm run
 * verify:package` (wired into `npm run dist:win`/`npm run pack` below)
 * fails the build if the packaged output's version or compiled IPC
 * surface doesn't match the current source.
 *
 * Pure comparison logic (`verifyPackagedReleaseContents`) is exported and
 * unit-tested without touching the filesystem; the CLI entrypoint below
 * does the actual disk reads and is what `npm run verify:package` runs
 * against a real `release/win-unpacked` (or `--mac`) build.
 */

export type PackagedReleaseVerificationInput = {
  /** apps/lockdown/package.json's own "version" field (source of truth). */
  expectedVersion: string;
  /** The PACKAGED app's package.json contents (resources/app/package.json for an unpacked --dir build). */
  packagedPackageJsonContent: string | null;
  /** The PACKAGED app's compiled dist/shared.js contents. */
  packagedSharedJsContent: string | null;
  /** The PACKAGED app's compiled dist/main.js contents. */
  packagedMainJsContent: string | null;
  /** The PACKAGED app's compiled dist/displayEnforcement.js contents. */
  packagedDisplayEnforcementJsContent: string | null;
};

export type PackagedReleaseVerificationResult = {
  ok: boolean;
  errors: string[];
};

/**
 * Markers that only exist in the corrective-pass v1.2.1 source — chosen
 * so this assertion fails loudly on a build that predates Task C's
 * fail-closed rewrite (e.g. a stale v1.2.0 unpacked directory left over
 * from before this pass), not just on a missing file.
 */
const REQUIRED_MAIN_JS_MARKERS = ["lockdown:set-secure-client-enforcement-state", "lockdown:get-diagnostics-snapshot"];
const REQUIRED_DISPLAY_ENFORCEMENT_JS_MARKERS = ["setEnforcementState", "resolveReadinessGatedDisplayEnforcementState"];

export function verifyPackagedReleaseContents(input: PackagedReleaseVerificationInput): PackagedReleaseVerificationResult {
  const errors: string[] = [];

  if (!input.packagedPackageJsonContent) {
    errors.push("Packaged resources/app/package.json was not found — has the app been packaged (npm run pack / npm run dist:win)?");
  } else {
    let parsedVersion: string | null = null;
    try {
      parsedVersion = (JSON.parse(input.packagedPackageJsonContent) as { version?: unknown }).version as string | null;
    } catch {
      errors.push("Packaged resources/app/package.json could not be parsed as JSON.");
    }
    if (parsedVersion !== input.expectedVersion) {
      errors.push(`Packaged package.json version "${String(parsedVersion)}" does not match the expected source version "${input.expectedVersion}".`);
    }
  }

  if (!input.packagedSharedJsContent) {
    errors.push("Packaged dist/shared.js was not found.");
  } else if (!input.packagedSharedJsContent.includes(`LOCKDOWN_VERSION = "${input.expectedVersion}"`)) {
    errors.push(`Packaged dist/shared.js does not contain LOCKDOWN_VERSION = "${input.expectedVersion}" — the compiled bundle is stale.`);
  }

  if (!input.packagedMainJsContent) {
    errors.push("Packaged dist/main.js was not found.");
  } else {
    for (const marker of REQUIRED_MAIN_JS_MARKERS) {
      if (!input.packagedMainJsContent.includes(marker)) {
        errors.push(`Packaged dist/main.js is missing "${marker}" — the packaged build does not contain the current display-enforcement IPC implementation.`);
      }
    }
  }

  if (!input.packagedDisplayEnforcementJsContent) {
    errors.push("Packaged dist/displayEnforcement.js was not found.");
  } else {
    for (const marker of REQUIRED_DISPLAY_ENFORCEMENT_JS_MARKERS) {
      if (!input.packagedDisplayEnforcementJsContent.includes(marker)) {
        errors.push(`Packaged dist/displayEnforcement.js is missing "${marker}" — the packaged build does not contain the current fail-closed enforcement logic.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/* eslint-disable @typescript-eslint/no-var-requires */
if (require.main === module) {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");

  const releaseDirArg = process.argv[2] ?? path.join(__dirname, "..", "release", "win-unpacked");
  const appDir = path.join(releaseDirArg, "resources", "app");
  const sourcePackageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string };

  function readIfExists(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  }

  const result = verifyPackagedReleaseContents({
    expectedVersion: sourcePackageJson.version,
    packagedPackageJsonContent: readIfExists(path.join(appDir, "package.json")),
    packagedSharedJsContent: readIfExists(path.join(appDir, "dist", "shared.js")),
    packagedMainJsContent: readIfExists(path.join(appDir, "dist", "main.js")),
    packagedDisplayEnforcementJsContent: readIfExists(path.join(appDir, "dist", "displayEnforcement.js")),
  });

  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error(`Packaged release verification FAILED for ${appDir}:`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`Packaged release verification passed for ${appDir} (version ${sourcePackageJson.version}).`);
}
