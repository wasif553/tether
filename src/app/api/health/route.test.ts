import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns ok status and a database check, without exposing secrets", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.status).toBe("ok");
    expect(["ok", "error"]).toContain(data.database);
    expect(typeof data.timestamp).toBe("string");

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(process.env.DATABASE_URL ?? "__none__");
  });
});
