/**
 * Fix exam publish redirect origin handling — see
 * docs/deployment-vercel-supabase.md and src/lib/appOrigin.ts.
 *
 * Pure unit tests only — no Prisma/DB, no browser, no network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveInternalRedirectOrigin } from "./appOrigin";

describe("resolveInternalRedirectOrigin", () => {
  const originalAppUrl = process.env.APP_URL;

  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  });

  it("3. derives the origin from the request URL, in server code", () => {
    const origin = resolveInternalRedirectOrigin("https://tether-murex.vercel.app/api/lti/launch");
    expect(origin).toBe("https://tether-murex.vercel.app");
  });

  it("5. ignores process.env.APP_URL entirely — it never reads it, even when APP_URL is set to something else", () => {
    process.env.APP_URL = "https://stale-preview-abc123.vercel.app";
    const origin = resolveInternalRedirectOrigin("https://current-deployment-xyz789.vercel.app/api/lti/launch");
    expect(origin).toBe("https://current-deployment-xyz789.vercel.app");
    expect(origin).not.toBe(process.env.APP_URL);
  });

  it("works for a fresh Vercel Preview URL just as well as production or localhost", () => {
    expect(resolveInternalRedirectOrigin("https://tether-git-feature-branch-team.vercel.app/x")).toBe(
      "https://tether-git-feature-branch-team.vercel.app",
    );
    expect(resolveInternalRedirectOrigin("http://localhost:3001/x")).toBe("http://localhost:3001");
  });

  it("drops the path, query string, and hash — only the origin is kept", () => {
    const origin = resolveInternalRedirectOrigin(
      "https://tether-murex.vercel.app/api/lti/launch?foo=bar#section",
    );
    expect(origin).toBe("https://tether-murex.vercel.app");
  });
});
