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
  /** Tether Windows Lockdown Hardening v1 — the PACKAGED app's compiled dist/processDetection.js contents. */
  packagedProcessDetectionJsContent: string | null;
  /** Mid-exam remote-session monitoring v1 — the PACKAGED app's compiled dist/remoteSessionMonitor.js contents. */
  packagedRemoteSessionMonitorJsContent: string | null;
  /** Windows taskbar icon fix v1.7.1 — the SOURCE assets/icon.ico bytes (before packaging). */
  sourceIconIcoBuffer: Buffer | null;
  /** Windows taskbar icon fix v1.7.1 — the SOURCE electron-builder.yml contents. */
  electronBuilderYmlContent: string | null;
  /** Windows taskbar icon fix v1.7.1 — the PACKAGED resources/app/assets/icon.ico bytes, used by the BrowserWindow runtime icon. */
  packagedIconIcoBuffer: Buffer | null;
  /**
   * Windows taskbar icon fix v1.7.1 — the icon resolutions actually
   * embedded (RT_GROUP_ICON) in the packaged app's own .exe, read back
   * with `resedit` (see embedWindowsIcon.ts). This is the strongest
   * possible check that "the packaged executable contains a non-generic
   * icon configuration": it inspects the real PE resource data, not
   * source config that a build could have failed to apply. `null` means
   * the .exe could not be found/read/parsed.
   */
  packagedExeIconResolutions: number[] | null;
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
const REQUIRED_MAIN_JS_MARKERS = [
  "lockdown:set-secure-client-enforcement-state",
  "lockdown:get-diagnostics-snapshot",
  // Tether Windows Lockdown Hardening v1 — fails loudly on a stale
  // pre-v1.7.0 build that predates this pass's Electron hardening.
  "lockdown:run-preflight-scan",
  "findUnsafeCommandLineSwitch",
  // Destroyed-window crash fix v1.7.1 — fails loudly on a stale pre-1.7.1
  // build that still has the unguarded reportAuditFactBestEffort/
  // restoreLockdownControls that could throw "Object has been destroyed"
  // on the closed event.
  "performLockdownRestoration",
  // Windows taskbar icon fix v1.7.1 — fails loudly on a stale build that
  // predates app.setAppUserModelId(...) and the BrowserWindow runtime
  // icon path being set.
  "setAppUserModelId(",
  "LOCKDOWN_ICON_PATH",
  // Mid-exam remote-session monitoring v1 — fails loudly on a stale
  // pre-1.7.2 build that predates RemoteSessionMonitor's ACTIVE-lifecycle
  // wiring and shutdown cleanup integration (see main.ts: the same
  // lockdown:set-lockdown-exam-active handler that starts/stops
  // ProcessDetection now also starts/stops RemoteSessionMonitor, and the
  // window "closed" handler calls remoteSessionMonitor.stop() alongside
  // processDetection.stop()). Anchored on `.RemoteSessionMonitor(` rather
  // than `new RemoteSessionMonitor(` — tsc's CommonJS output prefixes an
  // imported class with a generated module alias (e.g.
  // `remoteSessionMonitor_1.RemoteSessionMonitor(`), so a literal `new
  // RemoteSessionMonitor(` never appears in the compiled bundle even
  // though the current source is present.
  ".RemoteSessionMonitor(",
  "remoteSessionMonitor.setExamActive(active)",
  "remoteSessionMonitor.stop()",
];
const REQUIRED_DISPLAY_ENFORCEMENT_JS_MARKERS = ["setEnforcementState", "resolveReadinessGatedDisplayEnforcementState"];
const REQUIRED_PROCESS_DETECTION_JS_MARKERS = [
  "runPreflightScan",
  "setExamActive",
  // v1.7.2 poll-serialization fix — the corrected in-flight assignment
  // (pollOnceNow()'s own promise, never a `.finally()`-wrapped one).
  "this.scanInFlight = this.pollOnceNow();",
];
/**
 * v1.7.2 poll-serialization fix — this EXACT fragment only ever appears
 * in the OLD buggy assignment (`this.scanInFlight = run.finally(...)`),
 * never in prose (comments describing the fix quote `.finally()` and
 * `this.scanInFlight === run` separately, never this exact assignment
 * statement together) — a packaged build that still contains it has the
 * stale, silently-self-freezing poll loop.
 */
const FORBIDDEN_PROCESS_DETECTION_JS_MARKER = "this.scanInFlight = run.finally(";

// Mid-exam remote-session monitoring v1 — RemoteSessionMonitor itself:
// the class, its ACTIVE-lifecycle entrypoint, its configurable interval
// (proves interval configuration is actually wired, not hardcoded),
// its transition-deduplication logic (imported from the pure
// remoteSessionMonitorLogic module — proves dedup ships, not just the
// class shell), and its cleanup method.
const REQUIRED_REMOTE_SESSION_MONITOR_JS_MARKERS = [
  "class RemoteSessionMonitor",
  "setExamActive(active)",
  "resolveRemoteSessionMonitorIntervalSeconds",
  "computeRemoteSessionMonitorTransitions",
  "stop() {",
];

/**
 * Windows taskbar icon fix v1.7.1 — every resolution Windows expects a
 * well-formed app icon to provide (taskbar, Alt-Tab, Explorer, Start
 * Menu tile scaling, ...).
 */
const REQUIRED_ICON_RESOLUTIONS = [16, 24, 32, 48, 64, 128, 256];

/**
 * Parses just enough of the ICO container format (ICONDIR followed by
 * ICONDIRENTRY records — see the Microsoft ICO file spec) to list the
 * resolutions actually present, and to reject anything that isn't a real
 * ICO outright: a genuine ICO always starts with reserved=0, type=1
 * (bytes 00 00 01 00), which a PNG (89 50 4E 47 ...) or any other format
 * simply renamed to .ico can never satisfy. Returns null for anything
 * that fails that structural check.
 */
function parseIcoResolutions(buffer: Buffer): number[] | null {
  if (buffer.length < 6) return null;
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return null;
  const count = buffer.readUInt16LE(4);
  if (count === 0 || buffer.length < 6 + count * 16) return null;
  const resolutions: number[] = [];
  for (let i = 0; i < count; i++) {
    const width = buffer.readUInt8(6 + i * 16);
    resolutions.push(width === 0 ? 256 : width);
  }
  return resolutions;
}

function checkResolutionList(resolutions: number[] | null, label: string, errors: string[], notFoundMessage?: string): void {
  if (resolutions == null) {
    errors.push(notFoundMessage ?? `${label} was not found.`);
    return;
  }
  // ICO/PE convention: a stored width/height of 0 means 256.
  const normalized = resolutions.map((size) => (size === 0 ? 256 : size));
  const missing = REQUIRED_ICON_RESOLUTIONS.filter((size) => !normalized.includes(size));
  if (missing.length > 0) {
    errors.push(`${label} is missing required resolution(s): ${missing.join(", ")} (found: ${normalized.join(", ")}).`);
  }
}

function checkIcoBuffer(buffer: Buffer | null, label: string, errors: string[]): void {
  if (!buffer) {
    errors.push(`${label} was not found.`);
    return;
  }
  const resolutions = parseIcoResolutions(buffer);
  if (resolutions === null) {
    errors.push(`${label} is not a valid multi-resolution ICO file (failed the ICO header check — it may be a PNG or another format renamed to .ico).`);
    return;
  }
  checkResolutionList(resolutions, label, errors);
}

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
  } else {
    if (!input.packagedSharedJsContent.includes(`LOCKDOWN_VERSION = "${input.expectedVersion}"`)) {
      errors.push(`Packaged dist/shared.js does not contain LOCKDOWN_VERSION = "${input.expectedVersion}" — the compiled bundle is stale.`);
    }
    // Windows taskbar icon fix v1.7.1 — the stable AppUserModelID is
    // configured with the correct, non-conflicting identifier.
    if (!input.packagedSharedJsContent.includes('TETHER_APP_USER_MODEL_ID = "com.tether.securebrowser"')) {
      errors.push('Packaged dist/shared.js does not contain TETHER_APP_USER_MODEL_ID = "com.tether.securebrowser" — the stable AppUserModelID is missing or stale.');
    }
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

  if (!input.packagedProcessDetectionJsContent) {
    errors.push("Packaged dist/processDetection.js was not found.");
  } else {
    for (const marker of REQUIRED_PROCESS_DETECTION_JS_MARKERS) {
      if (!input.packagedProcessDetectionJsContent.includes(marker)) {
        errors.push(`Packaged dist/processDetection.js is missing "${marker}" — the packaged build does not contain the current Windows lockdown hardening logic.`);
      }
    }
    if (input.packagedProcessDetectionJsContent.includes(FORBIDDEN_PROCESS_DETECTION_JS_MARKER)) {
      errors.push(
        "Packaged dist/processDetection.js still contains the v1.7.2-fixed poll-serialization bug " +
          '("this.scanInFlight = run.finally(...)") — a `.finally()`-wrapped promise never equals the ' +
          "promise it was called on, so the in-flight guard never clears and during-exam process " +
          "detection silently freezes at its first scan result for the rest of the exam.",
      );
    }
  }

  if (!input.packagedRemoteSessionMonitorJsContent) {
    errors.push("Packaged dist/remoteSessionMonitor.js was not found — has the app been packaged since the mid-exam remote-session monitoring feature was added?");
  } else {
    for (const marker of REQUIRED_REMOTE_SESSION_MONITOR_JS_MARKERS) {
      if (!input.packagedRemoteSessionMonitorJsContent.includes(marker)) {
        errors.push(`Packaged dist/remoteSessionMonitor.js is missing "${marker}" — the packaged build does not contain the current mid-exam remote-session monitoring logic.`);
      }
    }
  }

  // Windows taskbar icon fix v1.7.1 — the source icon asset exists and is
  // a genuine full-resolution ICO.
  checkIcoBuffer(input.sourceIconIcoBuffer, "Source assets/icon.ico", errors);

  // electron-builder configuration actually references the icon (both
  // for the NSIS installer, which reads win.icon directly, and for the
  // BrowserWindow runtime icon, which needs it bundled into `files`). Not
  // checked here: signAndEditExecutable — it is intentionally `false`;
  // see electron-builder.yml's own comment and embedWindowsIcon.ts for
  // why the installed app .exe's icon is instead embedded by a separate
  // `npm run embed:icon` step, verified below directly against the
  // packaged .exe's real PE resources rather than against config text.
  if (!input.electronBuilderYmlContent) {
    errors.push("electron-builder.yml was not found.");
  } else {
    if (!/icon:\s*assets\/icon\.ico/.test(input.electronBuilderYmlContent)) {
      errors.push("electron-builder.yml's win config does not reference assets/icon.ico.");
    }
    if (!/^\s*-\s*assets\/icon\.ico\s*$/m.test(input.electronBuilderYmlContent)) {
      errors.push("electron-builder.yml's files list does not bundle assets/icon.ico for the BrowserWindow runtime icon.");
    }
  }

  // The packaged resources include the runtime icon asset the
  // BrowserWindow constructor needs (dev and packaged builds resolve it
  // through the same relative path — see LOCKDOWN_ICON_PATH in main.ts).
  checkIcoBuffer(input.packagedIconIcoBuffer, "Packaged resources/app/assets/icon.ico", errors);

  // The packaged executable's own PE resources actually contain a
  // non-generic, full-resolution icon — the strongest possible check,
  // since it inspects the real compiled/packaged binary rather than
  // config that a build could have failed to apply (e.g. embed:icon
  // never ran, or ran against a stale/wrong .exe).
  checkResolutionList(
    input.packagedExeIconResolutions,
    "Packaged app .exe icon resource (RT_GROUP_ICON)",
    errors,
    "Packaged app .exe was not found or contained no icon group (RT_GROUP_ICON) — has npm run embed:icon been run (it is part of npm run dist:win)?",
  );

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

  function readBufferIfExists(filePath: string): Buffer | null {
    try {
      return fs.readFileSync(filePath);
    } catch {
      return null;
    }
  }

  /**
   * Windows taskbar icon fix v1.7.1 — reads back the icon resolutions
   * actually embedded in the packaged app's own .exe (the same file
   * embedWindowsIcon.ts targets: the single non-uninstaller .exe directly
   * under the unpacked release directory, a sibling of resources/app
   * rather than inside it), using `resedit` (pure JS PE resource reader —
   * no winCodeSign/native-binary dependency, unlike electron-builder's
   * own signAndEditExecutable path). Returns null if the .exe can't be
   * found, read, or parsed, or has no icon group at all.
   */
  function readPackagedExeIconResolutions(unpackedDir: string): number[] | null {
    try {
      const exeCandidates = fs
        .readdirSync(unpackedDir)
        .filter((name: string) => name.endsWith(".exe") && !name.toLowerCase().startsWith("uninstall"));
      if (exeCandidates.length !== 1) return null;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { NtExecutable, NtExecutableResource, Resource } = require("resedit") as typeof import("resedit");
      const data = fs.readFileSync(path.join(unpackedDir, exeCandidates[0]));
      const exe = NtExecutable.from(data);
      const res = NtExecutableResource.from(exe);
      const iconGroups = Resource.IconGroupEntry.fromEntries(res.entries);
      if (iconGroups.length === 0) return null;
      return iconGroups[0].icons.map((icon) => icon.width);
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
    packagedProcessDetectionJsContent: readIfExists(path.join(appDir, "dist", "processDetection.js")),
    packagedRemoteSessionMonitorJsContent: readIfExists(path.join(appDir, "dist", "remoteSessionMonitor.js")),
    sourceIconIcoBuffer: readBufferIfExists(path.join(__dirname, "..", "assets", "icon.ico")),
    electronBuilderYmlContent: readIfExists(path.join(__dirname, "..", "electron-builder.yml")),
    packagedIconIcoBuffer: readBufferIfExists(path.join(appDir, "assets", "icon.ico")),
    packagedExeIconResolutions: readPackagedExeIconResolutions(releaseDirArg),
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
