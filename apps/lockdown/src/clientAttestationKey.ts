/**
 * Tether System Check and Exam Readiness v1 — security hardening pass.
 * See docs/tether-system-check-v1.md, "Genuine client attestation".
 *
 * A signed challenge/response alone only proves the SERVER's own
 * signature round-tripped intact — it never proves the responder is a
 * genuine packaged Tether Secure Browser instance, since any browser
 * (including an ordinary Chrome tab) can echo a challenge back with
 * self-reported facts. This is the mirror image of
 * TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY on the server side: an
 * Ed25519 PRIVATE key baked into every packaged build at compile time
 * (not fetched at runtime, not generated per-installation, never
 * exposed to any network-reachable surface or to renderer JavaScript).
 * The matching PUBLIC key is configured server-side as
 * TETHER_CLIENT_ATTESTATION_PUBLIC_KEY (see .env.example).
 *
 * A plain browser tab has no way to obtain this private key — it is
 * never served over HTTP, never present in the web app's bundle, and
 * only exists inside this locally-installed native application's own
 * compiled output. Extracting it would require reverse-engineering the
 * packaged binary, not merely opening DevTools and defining
 * `window.sesLockdown` — the same class of protection any
 * embedded/baked application secret provides (cheat-resistant, not
 * cheat-proof, exactly like every other native signal in this codebase
 * — see docs/lockdown-browser-known-limitations.md).
 *
 * Used ONLY from main.ts — never exposed to the renderer via preload.
 * The renderer may request a SIGNATURE (via IPC) but never sees this
 * key material itself.
 */
import crypto from "crypto";

// This exact keypair's PUBLIC half must be configured server-side as
// TETHER_CLIENT_ATTESTATION_PUBLIC_KEY for every environment this build
// is expected to authenticate against — see .env.example. Rotating this
// key requires a new packaged release AND a corresponding server
// configuration update; see docs/tether-system-check-v1.md, "Key
// rotation".
const CLIENT_ATTESTATION_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOR5UYp+JfJjcZACUuzP7feAx/W3XWUst5xu5f12O+Vv
-----END PRIVATE KEY-----
`;

/**
 * Signs an arbitrary UTF-8 string with the embedded client-attestation
 * private key. Callers build the canonical string to sign — see
 * buildSystemCheckAttestationPayload in main.ts, which binds the
 * challenge nonce together with the natively-gathered facts so the
 * server can verify neither was tampered with after signing.
 */
export function signWithClientAttestationKey(data: string): string {
  const signature = crypto.sign(null, Buffer.from(data, "utf8"), CLIENT_ATTESTATION_PRIVATE_KEY_PEM);
  return signature.toString("base64");
}
