/**
 * Windows taskbar icon fix v1.7.1.
 *
 * electron-builder's own icon/version-resource embedding
 * (`win.signAndEditExecutable: true`, which shells out through its
 * bundled `app-builder` helper binary's `rcedit` subcommand) turned out
 * to unconditionally reach for the `winCodeSign` vendor archive on this
 * build host, even with no code-signing certificate configured — and
 * that archive contains macOS-targeted files with symlinks that 7-Zip
 * cannot extract without Windows Developer Mode or an elevated shell
 * (`ERROR: Cannot create symbolic link : A required privilege is not
 * held by the client.`). That's the same constraint the pre-existing
 * `asar: false` setting already documents for a different electron-
 * builder step; verified directly by invoking `app-builder rcedit`
 * standalone, which hits the identical winCodeSign download regardless
 * of any electron-builder.yml setting.
 *
 * The standalone `rcedit` package (a small, genuinely self-contained
 * wrapper around Electron's own rcedit.exe/rcedit-x64.exe, with no
 * signing/winCodeSign dependency at all — verified separately) does the
 * same job without that problem. This script runs it directly against
 * the unpacked app produced by `electron-builder --win --dir`, BEFORE
 * the NSIS installer step packages that same directory — see the
 * `dist:win` script in package.json, which runs this between the `--dir`
 * build and a second `--prepackaged` invocation that produces the
 * installer from the now icon-patched unpacked directory.
 */
import path from "node:path";
import fs from "node:fs";
import { rcedit } from "rcedit";

async function main(): Promise<void> {
  const unpackedDir = process.argv[2] ?? path.join(__dirname, "..", "release", "win-unpacked");
  const iconPath = path.join(__dirname, "..", "assets", "icon.ico");

  if (!fs.existsSync(unpackedDir)) {
    console.error(`embedWindowsIcon: ${unpackedDir} does not exist — run "electron-builder --win --dir" first.`);
    process.exit(1);
  }
  if (!fs.existsSync(iconPath)) {
    console.error(`embedWindowsIcon: ${iconPath} does not exist.`);
    process.exit(1);
  }

  const exeCandidates = fs.readdirSync(unpackedDir).filter((name) => name.endsWith(".exe") && !name.toLowerCase().startsWith("uninstall"));
  if (exeCandidates.length !== 1) {
    console.error(`embedWindowsIcon: expected exactly one non-uninstaller .exe in ${unpackedDir}, found: ${exeCandidates.join(", ") || "(none)"}.`);
    process.exit(1);
  }

  const exePath = path.join(unpackedDir, exeCandidates[0]);
  await rcedit(exePath, { icon: iconPath });
  console.log(`embedWindowsIcon: embedded ${iconPath} into ${exePath}.`);
}

main().catch((err) => {
  console.error("embedWindowsIcon: FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
