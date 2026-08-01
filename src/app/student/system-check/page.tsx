"use client";

/**
 * Tether System Check and Exam Readiness v1 — see
 * docs/tether-system-check-v1.md.
 *
 * A technical-readiness check, not an integrity/misconduct feature: every
 * result is one of "ready" / "needs attention" / "not checked" /
 * "cannot continue" — never an accusation, and nothing here creates a
 * Submission or an IntegrityEvent. Runs a reduced set of checks in an
 * ordinary browser (Part 3) and the full set inside Tether Secure
 * Browser (Part 4). All readiness computation goes through the single
 * shared module src/lib/systemCheck/readiness.ts — nothing here
 * recomputes an overall status itself.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { isRunningInLockdownBrowser } from "@/lib/lockdownDetection";
import { buildTetherDashboardDeepLink } from "@/lib/tetherLaunch";
import { ensureRegisteredInstallation } from "@/lib/secureClient/installationClient";
import { classifyFrameQuality, computeLuminanceVariance } from "@/lib/cameraIntegrityDetection";
import {
  computeOverallStatus,
  TETHER_ONLY_CHECK_IDS,
  isRequiredCheck,
  classifyGetUserMediaError,
  evaluateCameraCheck,
  evaluateMicrophoneCheck,
  evaluateNetworkCheck,
  type SystemCheckId,
  type CheckResultState,
} from "@/lib/systemCheck/readiness";

type CheckDisplay = { status: CheckResultState; reasonCode: string | null };
type RunState = Partial<Record<SystemCheckId, CheckDisplay>>;

const CHECK_ORDER: SystemCheckId[] = [
  "authentication",
  "secureClient",
  "clientVersion",
  "operatingSystem",
  "bridge",
  "displayTopology",
  "network",
  "clock",
  "camera",
  "microphone",
];

const CHECK_LABELS: Record<SystemCheckId, string> = {
  authentication: "Sign-in",
  secureClient: "Tether Secure Browser session",
  clientVersion: "Tether Secure Browser version",
  operatingSystem: "Operating system",
  displayTopology: "Display setup",
  camera: "Camera",
  microphone: "Microphone",
  network: "Network connection",
  clock: "Device clock",
  bridge: "Secure browser connection",
};

const STATUS_LABELS: Record<CheckResultState, string> = {
  PASS: "Ready",
  WARNING: "Needs attention",
  BLOCKED: "Cannot continue",
  NOT_CHECKED: "Not checked",
};

const STATUS_STYLES: Record<CheckResultState, string> = {
  PASS: "bg-green-100 text-green-800",
  WARNING: "bg-amber-100 text-amber-800",
  BLOCKED: "bg-red-100 text-red-800",
  NOT_CHECKED: "bg-gray-100 text-gray-600",
};

const OVERALL_HEADLINES: Record<"READY" | "READY_WITH_WARNINGS" | "NOT_READY", string> = {
  READY: "This computer is ready",
  READY_WITH_WARNINGS: "Ready, with items to review",
  NOT_READY: "This computer is not ready yet",
};

/**
 * Corrective pass — distinguishes "Chrome genuinely cannot run the four
 * Tether-only checks" (expected, not a device failure) from "something
 * this browser COULD check actually failed" (e.g. camera permission
 * denied). Overall status stays NOT_READY either way — this only picks
 * which non-alarming headline to show; it never overrides the real
 * aggregated state (see computeOverallStatus in readiness.ts).
 */
function isIncompleteOnlyDueToMissingNativeChecks(inTether: boolean, results: RunState): boolean {
  if (inTether) return false;
  for (const id of CHECK_ORDER) {
    if (TETHER_ONLY_CHECK_IDS.has(id)) continue;
    if (results[id]?.status === "BLOCKED") return false;
  }
  return true;
}

/** Plain-language result + correction copy — no raw JSON, stack traces, Electron/GraphQL terminology, or policy hashes ever shown here. */
function describeCheck(id: SystemCheckId, display: CheckDisplay | undefined): { message: string; correction: string | null } {
  const status = display?.status ?? "NOT_CHECKED";
  const reason = display?.reasonCode ?? null;

  if (status === "NOT_CHECKED") {
    if (TETHER_ONLY_CHECK_IDS.has(id)) {
      return { message: "Not checked in this browser.", correction: "Open this page in Tether Secure Browser to check this." };
    }
    return { message: "Not checked yet.", correction: null };
  }

  switch (id) {
    case "authentication":
      return status === "PASS" ? { message: "You're signed in.", correction: null } : { message: "Your sign-in could not be confirmed.", correction: "Sign in again and retry." };
    case "secureClient":
      if (status === "PASS") return { message: "Your Tether Secure Browser was verified.", correction: null };
      if (reason === "REPLAY") return { message: "This verification attempt was already used.", correction: "Retry the check to get a fresh one." };
      if (reason === "EXPIRED" || reason === "VERIFICATION_EXPIRED" || reason === "NOT_YET_VALID") {
        return { message: "The verification took too long and expired.", correction: "Retry the check." };
      }
      if (reason === "CHALLENGE_FAILED" || reason === "VERIFICATION_FAILED") {
        return { message: "Your Tether Secure Browser could not be verified.", correction: "Check your connection and retry." };
      }
      if (reason === "ATTESTATION_UNAVAILABLE") {
        return { message: "This Tether Secure Browser installation is too old to verify.", correction: "Download and install the latest version, then retry." };
      }
      if (reason === "ATTESTATION_FAILED" || reason === "CLIENT_ATTESTATION_INVALID" || reason === "INSTALLATION_SIGNATURE_INVALID") {
        return { message: "Your Tether Secure Browser could not be verified.", correction: "Restart Tether Secure Browser and retry." };
      }
      if (reason === "INSTALLATION_UNAVAILABLE") {
        return { message: "This computer could not be registered with Tether Secure Browser.", correction: "Restart Tether Secure Browser and retry." };
      }
      if (reason === "INSTALLATION_NOT_ACTIVE") {
        return { message: "This computer's Tether Secure Browser registration is no longer active.", correction: "Restart Tether Secure Browser to register this computer again." };
      }
      return { message: "A verified Tether Secure Browser session could not be confirmed.", correction: "Retry the check." };
    case "clientVersion":
      if (status === "PASS") return { message: "Your Tether Secure Browser version is supported.", correction: null };
      if (status === "WARNING") return { message: "Your reported version could not be recognised.", correction: "Restart Tether Secure Browser and retry." };
      return { message: "Your Tether Secure Browser version is out of date.", correction: "Download and install the latest version, then retry." };
    case "operatingSystem":
      if (status === "PASS") return { message: "Windows is supported.", correction: null };
      return { message: "This operating system is not currently supported.", correction: "Tether Secure Browser currently supports Windows only." };
    case "displayTopology":
      if (status === "PASS") return { message: "A single display was detected.", correction: null };
      return { message: "An additional, duplicated, or extended display was detected.", correction: "Disconnect the additional display and retry." };
    case "bridge":
      if (status === "PASS") return { message: "Your secure browser connection is available.", correction: null };
      return { message: "Your Tether Secure Browser installation appears incomplete.", correction: "Reinstall Tether Secure Browser and retry." };
    case "network":
      if (status === "PASS") return { message: "Your connection looks good.", correction: null };
      if (status === "WARNING") return { message: "Your connection is slower than usual.", correction: "A slow connection may cause delays during your exam." };
      return { message: "Some required services could not be reached.", correction: "Check your internet connection and retry." };
    case "clock":
      if (status === "PASS") return { message: "Your device clock is accurate.", correction: null };
      if (status === "WARNING") return { message: "Your device clock is off by a small amount.", correction: "Set your device to update its date and time automatically." };
      return { message: "Your device clock is significantly different from the server.", correction: "Update your device's date and time, then retry." };
    case "camera":
      if (status === "PASS") return { message: "Your camera is working.", correction: null };
      if (status === "WARNING" && reason === "LIGHTING_TOO_LOW") return { message: "Lighting is too low to confirm your camera clearly.", correction: "Move to a better-lit area and retry." };
      if (status === "WARNING") return { message: "Camera visibility is temporarily uncertain.", correction: "Make sure your camera lens is not covered and retry." };
      if (reason === "PERMISSION_DENIED") return { message: "Camera permission was denied.", correction: "Allow camera access in your browser settings and retry." };
      if (reason === "NO_DEVICE") return { message: "No camera was found.", correction: "Connect a camera and retry." };
      if (reason === "DEVICE_BUSY") return { message: "Your camera is being used by another application.", correction: "Close other apps using your camera and retry." };
      return { message: "Your camera stream could not be started.", correction: "Retry, or restart your device if this continues." };
    case "microphone":
      if (status === "PASS") return { message: "Your microphone is working.", correction: null };
      if (reason === "PERMISSION_DENIED") return { message: "Microphone permission was denied.", correction: "Allow microphone access in your browser settings and retry." };
      if (reason === "NO_DEVICE") return { message: "No microphone was found.", correction: "Connect a microphone and retry." };
      if (reason === "DEVICE_BUSY") return { message: "Your microphone is being used by another application.", correction: "Close other apps using your microphone and retry." };
      return { message: "Your microphone stream could not be started.", correction: "Retry, or restart your device if this continues." };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function guessBrowserPlatform(): string | null {
  if (typeof navigator === "undefined") return null;
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const raw = uaData?.platform || navigator.platform || navigator.userAgent;
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("win")) return "win32";
  if (lower.includes("mac")) return "darwin";
  if (lower.includes("linux") || lower.includes("cros")) return "linux";
  return null;
}

const NETWORK_ENDPOINTS = ["/api/auth/session", "/api/version", "/api/readiness", "/api/tether/system-check/ping"] as const;
const CHECK_TIMEOUT_MS = 8_000;

/**
 * Corrective pass — first-time SYSTEM_CHECK secure-client verification
 * (see docs/tether-system-check-v1.md, "System-check secure-client
 * verification"). Requests a short-lived signed challenge, gathers real
 * native facts via the existing window.sesLockdown bridge (feature-
 * detected — an older packaged install simply won't expose
 * getClientVersion/getOperatingSystemInfo, in which case those two
 * fields stay null and the server-side signature/context checks still
 * run without them), and asks the server to verify. The returned
 * {status} IS the server's own PASS/BLOCKED decision — this function
 * never reads or trusts any "verified" value it computed itself.
 */
/**
 * Security hardening pass — see docs/tether-system-check-v1.md,
 * "Genuine client attestation". `window.sesLockdown.attestSystemCheck`
 * (not the individually-callable getClientVersion/getOperatingSystemInfo/
 * getDisplayTopology used elsewhere on this page for display purposes)
 * is the ONLY source of the facts submitted here — it returns a
 * signature computed entirely inside the Electron main process using an
 * embedded key this page never sees, bound to exactly the facts
 * main.ts itself gathered. This function never constructs or trusts a
 * "verified" boolean itself — the server's response is authoritative.
 */
async function verifySecureClient(): Promise<{ display: CheckDisplay; verificationId: string | null }> {
  try {
    const installationId = await ensureRegisteredInstallation();
    if (!installationId) {
      return { display: { status: "BLOCKED", reasonCode: "INSTALLATION_UNAVAILABLE" }, verificationId: null };
    }

    const challengeRes = await withTimeout(
      fetch("/api/tether/system-check/secure-client/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId }),
      }),
      CHECK_TIMEOUT_MS,
    );
    if (!challengeRes.ok) return { display: { status: "BLOCKED", reasonCode: "CHALLENGE_FAILED" }, verificationId: null };
    const { challenge, signature: challengeSignature } = await challengeRes.json();

    if (typeof window.sesLockdown?.attestSystemCheck !== "function") {
      // An older packaged install (pre-1.5.0) doesn't expose this yet —
      // never falls back to unsigned self-reported facts.
      return { display: { status: "BLOCKED", reasonCode: "ATTESTATION_UNAVAILABLE" }, verificationId: null };
    }
    const attestation = await withTimeout(window.sesLockdown.attestSystemCheck(challenge.nonce), CHECK_TIMEOUT_MS).catch(() => null);
    if (!attestation) {
      return { display: { status: "BLOCKED", reasonCode: "ATTESTATION_FAILED" }, verificationId: null };
    }

    const verifyRes = await withTimeout(
      fetch("/api/tether/system-check/secure-client/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge,
          challengeSignature,
          clientType: "TETHER_SECURE_CLIENT",
          installationSignature: attestation.signature,
          clientVersion: attestation.clientVersion,
          platform: attestation.platform,
          displayTopologyClassification: attestation.displayTopologyClassification,
        }),
      }),
      CHECK_TIMEOUT_MS,
    );
    const body = await verifyRes.json().catch(() => null);
    if (verifyRes.ok && body?.verified) {
      return {
        display: { status: "PASS", reasonCode: "SYSTEM_CHECK_VERIFIED" },
        verificationId: typeof body.verificationId === "string" ? body.verificationId : null,
      };
    }
    const reason = typeof body?.reason === "string" ? body.reason : "VERIFICATION_FAILED";
    return { display: { status: "BLOCKED", reasonCode: reason }, verificationId: null };
  } catch {
    return { display: { status: "BLOCKED", reasonCode: "VERIFICATION_FAILED" }, verificationId: null };
  }
}

export default function SystemCheckPage() {
  const [inTether, setInTether] = useState<boolean | null>(null);
  const [config, setConfig] = useState<{ mode: string; validityHours: number; minimumSupportedVersion: string; serverTimeMs: number } | null>(null);
  const [latest, setLatest] = useState<{ overallStatus: string; checkedAt: string; expiresAt: string; expired: boolean } | null | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunState>({});
  const [progressIndex, setProgressIndex] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hasRunOnce, setHasRunOnce] = useState(false);

  const runningRef = useRef(false);
  const activeStreamsRef = useRef<MediaStream[]>([]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInTether(isRunningInLockdownBrowser());
  }, []);

  useEffect(() => {
    fetch("/api/tether/system-check/config")
      .then((r) => (r.ok ? r.json() : null))
      .then(setConfig)
      .catch(() => setConfig(null));
    fetch("/api/tether/system-check/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setLatest(d?.run ?? null))
      .catch(() => setLatest(null));
  }, []);

  const stopAllTracks = useCallback(() => {
    for (const stream of activeStreamsRef.current) {
      for (const track of stream.getTracks()) track.stop();
    }
    activeStreamsRef.current = [];
  }, []);

  // Page navigation / unmount must stop active camera and microphone tracks.
  useEffect(() => stopAllTracks, [stopAllTracks]);

  async function checkCamera(): Promise<CheckDisplay> {
    let stream: MediaStream | null = null;
    try {
      stream = await withTimeout(navigator.mediaDevices.getUserMedia({ video: true }), CHECK_TIMEOUT_MS);
      activeStreamsRef.current.push(stream);
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 400));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 320;
      canvas.height = video.videoHeight || 240;
      const ctx = canvas.getContext("2d");
      let producedFrame = false;
      let quality: "ok" | "blocked" | "dark" | null = null;
      if (ctx && canvas.width > 0 && canvas.height > 0) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        producedFrame = true;
        const { avgLuminance, variance } = computeLuminanceVariance(data);
        quality = classifyFrameQuality(avgLuminance, variance);
      }
      const evaluation = evaluateCameraCheck({ errorClass: null, streamProducedFrame: producedFrame, frameQuality: quality });
      return { status: evaluation.status, reasonCode: evaluation.reasonCode };
    } catch (err) {
      const name = err instanceof Error ? err.name : err instanceof DOMException ? err.name : null;
      const errorClass = classifyGetUserMediaError(name);
      const evaluation = evaluateCameraCheck({ errorClass: errorClass ?? "UNKNOWN_ERROR", streamProducedFrame: false, frameQuality: null });
      return { status: evaluation.status, reasonCode: evaluation.reasonCode };
    } finally {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        activeStreamsRef.current = activeStreamsRef.current.filter((s) => s !== stream);
      }
    }
  }

  async function checkMicrophone(): Promise<CheckDisplay> {
    let stream: MediaStream | null = null;
    try {
      stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), CHECK_TIMEOUT_MS);
      activeStreamsRef.current.push(stream);
      const started = stream.getAudioTracks().some((t) => t.readyState === "live");
      const evaluation = evaluateMicrophoneCheck({ errorClass: null, streamStarted: started });
      return { status: evaluation.status, reasonCode: evaluation.reasonCode };
    } catch (err) {
      const name = err instanceof Error ? err.name : null;
      const errorClass = classifyGetUserMediaError(name);
      const evaluation = evaluateMicrophoneCheck({ errorClass: errorClass ?? "UNKNOWN_ERROR", streamStarted: false });
      return { status: evaluation.status, reasonCode: evaluation.reasonCode };
    } finally {
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        activeStreamsRef.current = activeStreamsRef.current.filter((s) => s !== stream);
      }
    }
  }

  async function checkNetwork(): Promise<{ display: CheckDisplay; clientTimeMs: number }> {
    let reachableCount = 0;
    let totalLatency = 0;
    let latencySamples = 0;
    let clientTimeMs = Date.now();
    for (const endpoint of NETWORK_ENDPOINTS) {
      const start = Date.now();
      try {
        const res = await withTimeout(fetch(endpoint, { cache: "no-store" }), CHECK_TIMEOUT_MS);
        const end = Date.now();
        if (res.ok) {
          reachableCount++;
          totalLatency += end - start;
          latencySamples++;
        }
        if (endpoint === "/api/tether/system-check/ping" && res.ok) {
          clientTimeMs = end;
        }
      } catch {
        // Counted as unreachable below.
      }
    }
    const allReachable = reachableCount === NETWORK_ENDPOINTS.length;
    const approxLatencyMs = latencySamples > 0 ? Math.round(totalLatency / latencySamples) : null;
    const evaluation = evaluateNetworkCheck({ allEndpointsReachable: allReachable, approxLatencyMs });
    return { display: { status: evaluation.status, reasonCode: evaluation.reasonCode }, clientTimeMs };
  }

  const run = useCallback(async () => {
    if (runningRef.current) return; // multiple clicks must not start overlapping checks
    runningRef.current = true;
    setRunning(true);
    setSaveError(null);
    stopAllTracks(); // clear stale media state from any prior attempt
    setResults({});
    setProgressIndex(0);
    setHasRunOnce(true);

    const nextResults: RunState = {};
    const tether = isRunningInLockdownBrowser();
    let clientVersionRaw: string | null = null;
    let operatingSystemRaw: string | null = null;
    let operatingSystemVersionRaw: string | null = null;
    let displayTopologyClassification: string | null = null;
    let bridgeCapabilities: { getClientVersion: boolean; getOperatingSystemInfo: boolean; getDisplayTopology: boolean; getSecureClientCapabilities: boolean } | null = null;
    let clientTimeMsForClock = Date.now();
    // Corrective pass — first-time SYSTEM_CHECK secure-client
    // verification. Set once the challenge/verify round trip succeeds;
    // passed through to POST /runs so the server can re-verify ownership
    // and status itself rather than trusting this variable directly.
    let systemCheckVerificationId: string | null = null;

    for (let i = 0; i < CHECK_ORDER.length; i++) {
      const id = CHECK_ORDER[i];
      setProgressIndex(i + 1);
      try {
        if (id === "authentication") {
          nextResults.authentication = { status: "PASS", reasonCode: "AUTHENTICATED" };
        } else if (id === "secureClient") {
          const verification = tether ? await verifySecureClient() : null;
          if (verification) {
            nextResults.secureClient = verification.display;
            systemCheckVerificationId = verification.verificationId;
          } else {
            nextResults.secureClient = { status: "NOT_CHECKED", reasonCode: "TETHER_NOT_DETECTED" };
          }
        } else if (id === "clientVersion") {
          if (tether && typeof window.sesLockdown?.getClientVersion === "function") {
            clientVersionRaw = await withTimeout(window.sesLockdown.getClientVersion(), CHECK_TIMEOUT_MS).catch(() => window.sesLockdown?.version ?? null);
          } else if (tether) {
            clientVersionRaw = window.sesLockdown?.version ?? null;
          }
          nextResults.clientVersion = { status: "NOT_CHECKED", reasonCode: tether ? "PENDING_SERVER_EVALUATION" : "TETHER_NOT_DETECTED" };
        } else if (id === "operatingSystem") {
          if (tether && typeof window.sesLockdown?.getOperatingSystemInfo === "function") {
            const info = await withTimeout(window.sesLockdown.getOperatingSystemInfo(), CHECK_TIMEOUT_MS).catch(() => null);
            operatingSystemRaw = info?.platform ?? null;
            operatingSystemVersionRaw = info?.release ?? null;
          } else {
            operatingSystemRaw = guessBrowserPlatform();
          }
          nextResults.operatingSystem = { status: "NOT_CHECKED", reasonCode: "PENDING_SERVER_EVALUATION" };
        } else if (id === "bridge") {
          if (tether && typeof window.sesLockdown?.getSecureClientCapabilities === "function") {
            bridgeCapabilities = await withTimeout(window.sesLockdown.getSecureClientCapabilities(), CHECK_TIMEOUT_MS).catch(() => null);
          }
          nextResults.bridge = { status: "NOT_CHECKED", reasonCode: tether ? "PENDING_SERVER_EVALUATION" : "TETHER_NOT_DETECTED" };
        } else if (id === "displayTopology") {
          if (tether && typeof window.sesLockdown?.getDisplayTopology === "function") {
            const topo = await withTimeout(window.sesLockdown.getDisplayTopology(), CHECK_TIMEOUT_MS).catch(() => null);
            displayTopologyClassification = topo?.classification ?? null;
          }
          nextResults.displayTopology = { status: "NOT_CHECKED", reasonCode: tether ? "PENDING_SERVER_EVALUATION" : "TETHER_NOT_DETECTED" };
        } else if (id === "network") {
          const { display, clientTimeMs } = await checkNetwork();
          nextResults.network = display;
          clientTimeMsForClock = clientTimeMs;
        } else if (id === "clock") {
          // Authoritative comparison happens server-side (POST /runs) —
          // this is only a placeholder until that response arrives.
          nextResults.clock = { status: "NOT_CHECKED", reasonCode: "PENDING_SERVER_EVALUATION" };
        } else if (id === "camera") {
          nextResults.camera = await checkCamera();
        } else if (id === "microphone") {
          nextResults.microphone = await checkMicrophone();
        }
      } catch {
        // One failed check must never halt the whole sequence — record a
        // safe, non-throwing fallback and continue.
        nextResults[id] = { status: id === "authentication" ? "BLOCKED" : "NOT_CHECKED", reasonCode: "CHECK_FAILED" };
      }
      setResults({ ...nextResults });
    }

    // Persist server-side — the server recomputes authentication,
    // secureClient, clientVersion, operatingSystem, displayTopology,
    // bridge, and clock authoritatively; camera/microphone/network are
    // trusted as self-reported (see route doc comment).
    try {
      const res = await fetch("/api/tether/system-check/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceClientType: tether ? "TETHER_SECURE_CLIENT" : "BROWSER",
          clientVersion: clientVersionRaw,
          operatingSystem: operatingSystemRaw,
          operatingSystemVersion: operatingSystemVersionRaw,
          secureClientSessionId: null,
          systemCheckVerificationId,
          clientTimeMs: clientTimeMsForClock,
          displayTopologyClassification,
          bridgeCapabilities,
          results: {
            camera: nextResults.camera ?? { status: "NOT_CHECKED" },
            microphone: nextResults.microphone ?? { status: "NOT_CHECKED" },
            network: nextResults.network ?? { status: "NOT_CHECKED" },
          },
        }),
      });
      if (!res.ok) {
        setSaveError("Your result could not be saved, but the checks above reflect this computer right now.");
      } else {
        const body = await res.json();
        if (body?.run?.results) {
          setResults(body.run.results as RunState);
        }
        setLatest({
          overallStatus: body.run.overallStatus,
          checkedAt: body.run.checkedAt,
          expiresAt: body.run.expiresAt,
          expired: false,
        });
      }
    } catch {
      setSaveError("Your result could not be saved, but the checks above reflect this computer right now.");
    }

    runningRef.current = false;
    setRunning(false);
  }, [stopAllTracks]);

  const overall = computeOverallStatus(results);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">Check this computer</h1>
      <p className="mt-2 text-sm text-gray-600">
        This check helps prevent technical interruptions during your final examination by confirming your computer, Tether
        Secure Browser installation, and permissions are ready in advance.
      </p>
      <p className="mt-2 rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-600">
        No photo or audio recording is stored. Your camera and microphone are only used briefly to confirm they work, and
        are never saved.
        {config && ` A result stays current for ${config.validityHours} hours.`}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-gray-500">
        <span>Current browser: {inTether ? "Tether Secure Browser" : "Ordinary web browser"}</span>
        {inTether && <span>Tether version: {typeof window !== "undefined" ? (window.sesLockdown?.version ?? "unknown") : "unknown"}</span>}
      </div>

      {inTether === false && (
        <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <p>A complete check requires Tether Secure Browser. This page can still confirm sign-in and connectivity now.</p>
          <a href={buildTetherDashboardDeepLink()} className="mt-2 inline-block rounded bg-black px-3 py-1.5 text-sm text-white">
            Open Tether Secure Browser
          </a>
        </div>
      )}

      {latest && (
        <div className="mt-3 rounded border border-gray-200 p-3 text-xs text-gray-600">
          <p>
            Last check: {new Date(latest.checkedAt).toLocaleString()} — {latest.overallStatus.replaceAll("_", " ").toLowerCase()}
            {latest.expired ? " (expired)" : ""}
          </p>
          <p>Expires: {new Date(latest.expiresAt).toLocaleString()}</p>
        </div>
      )}

      <button
        onClick={() => void run()}
        disabled={running}
        className="mt-4 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {running ? `Checking… (${progressIndex}/${CHECK_ORDER.length})` : hasRunOnce ? "Retry check" : "Run system check"}
      </button>

      {saveError && <p className="mt-2 text-sm text-amber-700">{saveError}</p>}

      <div className="mt-4 space-y-2">
        {CHECK_ORDER.map((id) => {
          const display = results[id];
          const { message, correction } = describeCheck(id, display);
          const status = display?.status ?? "NOT_CHECKED";
          return (
            <div key={id} className="rounded border border-gray-200 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {CHECK_LABELS[id]}
                  {!isRequiredCheck(id) && <span className="ml-1 text-xs text-gray-400">(optional)</span>}
                </span>
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[status]}`}>{STATUS_LABELS[status]}</span>
              </div>
              <p className="mt-1 text-xs text-gray-600">{message}</p>
              {correction && <p className="mt-0.5 text-xs text-gray-500">{correction}</p>}
            </div>
          );
        })}
      </div>

      {hasRunOnce && !running && (
        <div className="mt-4 rounded border border-gray-200 p-3 text-center">
          {/* Corrective pass — Chrome cannot run the four Tether-only
              checks; that is an expected, non-alarming incompleteness,
              not a device failure, and must never be presented with the
              same red/technical-error tone as a genuine BLOCKED result.
              The underlying overall status stays NOT_READY either way —
              only this headline differs. */}
          {isIncompleteOnlyDueToMissingNativeChecks(Boolean(inTether), results) ? (
            <>
              <p className="text-base font-medium">Web checks completed</p>
              <p className="mt-1 text-sm text-gray-600">Open Tether Secure Browser to complete the required computer checks.</p>
            </>
          ) : (
            <p className="text-base font-medium">{OVERALL_HEADLINES[overall]}</p>
          )}
        </div>
      )}

      <div className="mt-4 flex justify-between">
        <Link href="/student" className="text-sm underline">
          Return to dashboard
        </Link>
        {/* Registered Tether Devices and Revocation UI v1. */}
        <Link href="/student/tether-devices" className="text-sm underline">
          Registered computers
        </Link>
      </div>
    </div>
  );
}
