# Network Evidence and IP-Based Location

**Feature:** Academic Integrity Network Evidence v1  
**Status:** Shipped in v1 (local DB; production DDL required before deploying)

---

## What this feature does

When a student opens an exam and when they submit it, Safe Exam System
records a `NetworkEvidence` row containing:

| Field | Description |
|-------|-------------|
| `source` | `EXAM_START` or `EXAM_SUBMIT` |
| `ipAddress` | Client IP extracted from request headers |
| `ipHash` | HMAC-SHA256 of IP with server-side salt (for comparison without exposing raw IP in logs) |
| `userAgent` | Full user-agent string |
| `browserName` | Lightweight parsed browser name (e.g. Chrome, Firefox, Edge) |
| `osName` | OS name (e.g. Windows, macOS, iOS) |
| `deviceType` | `desktop`, `mobile`, or `tablet` |
| `country`, `region`, `city`, `timezone` | IP-based geolocation (UNAVAILABLE in v1 without a provider) |
| `locationAccuracy` | `IP_APPROXIMATE` or `UNAVAILABLE` |
| `vpnOrProxySignal` | Boolean; true if provider flags a VPN/proxy |
| `networkChanged` | True if IP at EXAM_SUBMIT differs from IP at EXAM_START |

Evidence is **fire-and-forget** — capture never blocks exam start or submission.

---

## Critical language rules

Use | Do NOT use
----|----------
Network evidence | Exact location
Approximate IP-based location | GPS location
Integrity signal | Cheating detected
Needs review | Proof of cheating
Evidence for lecturer review | Student tracking

---

## What this feature does NOT do

- Does not use GPS/geolocation from the browser
- Does not block students based on IP or location
- Does not auto-determine misconduct
- Does not expose IP address to other students
- Does not require a paid external API in v1

---

## Architecture

### IP extraction (`src/lib/networkEvidence.ts`)

Priority order:
1. `cf-connecting-ip` — Cloudflare edge; already client IP
2. `x-forwarded-for` — first public (non-private) IP in the list
3. `x-real-ip` — nginx reverse proxy

Private/loopback IPs are filtered out. Returns `null` if nothing usable.

### IP hashing

`hashIp(ip)` uses HMAC-SHA256 with the `NETWORK_EVIDENCE_SALT` environment
variable. If the variable is absent, a random per-process salt is used
(consistent within one server process, changes on restart). Set
`NETWORK_EVIDENCE_SALT` to a stable secret in production for persistent
pseudonymised comparison.

### Geolocation (`src/lib/ipGeolocation.ts`)

In v1, `geolocateIp()` returns `UNAVAILABLE` unless `GEOLOCATION_PROVIDER`
is set. To add a provider:

1. Set `GEOLOCATION_PROVIDER=<name>` in the environment
2. Add a branch in `ipGeolocation.ts` that catches all errors and returns
   `UNAVAILABLE` on failure — the provider must never throw
3. Map the response to `GeoResult` fields and set `locationAccuracy: "IP_APPROXIMATE"`

Never make geolocation required. The exam flow must continue even if the
provider is unavailable, rate-limited, or slow.

### Evidence report integration

`buildEvidenceReport()` in `src/lib/evidenceReport.ts` fetches
`networkEvidence` in the same query as integrity events, assembles the
`networkEvidence` section of `EvidenceReport`, and passes it through to
the JSON and CSV evidence routes. The lecturer evidence page
(`/lecturer/submissions/[id]/evidence`) renders a Network Evidence card
with the review signal and per-field breakdown.

### Review signal

| Signal | Condition |
|--------|-----------|
| `Normal` | Same country at start and submit; no IP change |
| `Needs review` | IP changed between start and submit (same country or unknown) |
| `High review signal` | Different country at start vs. submit |

Country comparison only applies when `locationAccuracy: "IP_APPROXIMATE"`.
With `UNAVAILABLE`, country is null and comparison is skipped.

---

## Production deployment

Before deploying to production, apply the `NetworkEvidence` table DDL
via the Supabase SQL Editor. Generate the SQL with:

```
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

Copy only the `CREATE TABLE "NetworkEvidence"` statement and its indexes.
Do NOT run `prisma db push` against production.

Also set in Vercel environment variables:

- `NETWORK_EVIDENCE_SALT` — a random 32-character hex string
- `GEOLOCATION_PROVIDER` — leave unset (or `none`) for v1

---

## Privacy and data minimisation

- Raw IP address is stored for lecturer review; it is never included in
  student-facing API responses
- The privacy notice at `/privacy/student-exam-notice` explains what is
  recorded and why
- IP is retained as long as the submission exists (cascades on deletion)
- No video, no image, no GPS data is collected by this feature
- Network evidence is visible only to the exam's owner and platform admins

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `NETWORK_EVIDENCE_SALT` | Random per-process | HMAC salt for IP hashing |
| `GEOLOCATION_PROVIDER` | `none` | Geolocation provider name; unset = UNAVAILABLE |

---

## Known limitations (v1)

- Geolocation is not available in v1 without configuring a provider
- IP location may be inaccurate for VPNs, mobile networks, campus NAT,
  and ISP routing
- Heartbeat evidence (mid-exam network checks) is deferred to v2
- No automated flagging based on network evidence — lecturer review only
