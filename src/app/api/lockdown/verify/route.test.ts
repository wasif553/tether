import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/lockdown/verify", () => {
  it("returns ok with no secrets", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.ok).toBe(true);
    expect(data.app).toBe("safe-exam-system");
    expect(data.lockdownSupported).toBe(true);
    expect(typeof data.minVersion).toBe("string");

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(process.env.DATABASE_URL ?? "__none__");
    expect(serialized).not.toContain(process.env.AUTH_SECRET ?? "__none__");
  });
});
