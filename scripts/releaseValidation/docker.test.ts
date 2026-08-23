/**
 * scripts/releaseValidation/docker.ts — unit tests over the pure
 * disposable-container argv builder only. No Docker is invoked here.
 * See docs/database-backup-operations-v1.md's Postgres-17 bundle-restore
 * compatibility note.
 */
import { describe, expect, it } from "vitest";
import { buildStartDisposablePostgresContainerArgs, DEFAULT_DISPOSABLE_POSTGRES_IMAGE, type DisposableContainerParams } from "./docker";

const BASE_PARAMS: DisposableContainerParams = {
  containerName: "test-container",
  runId: "abc123",
  databaseName: "testdb",
  username: "testuser",
  password: "testpass",
  hostPort: 55432,
};

describe("[1] buildStartDisposablePostgresContainerArgs defaults to postgres:16-alpine", () => {
  it("uses DEFAULT_DISPOSABLE_POSTGRES_IMAGE when no image is specified", () => {
    const args = buildStartDisposablePostgresContainerArgs(BASE_PARAMS);
    expect(DEFAULT_DISPOSABLE_POSTGRES_IMAGE).toBe("postgres:16-alpine");
    expect(args[args.length - 1]).toBe("postgres:16-alpine");
    expect(args[args.length - 1]).toBe(DEFAULT_DISPOSABLE_POSTGRES_IMAGE);
  });

  it("uses the caller-supplied image when one is explicitly provided", () => {
    const args = buildStartDisposablePostgresContainerArgs({ ...BASE_PARAMS, image: "postgres:17-alpine" });
    expect(args[args.length - 1]).toBe("postgres:17-alpine");
  });

  it("[3] every field other than the image is unaffected by the image option (container name, ports, credentials all still present)", () => {
    const defaultArgs = buildStartDisposablePostgresContainerArgs(BASE_PARAMS);
    const overriddenArgs = buildStartDisposablePostgresContainerArgs({ ...BASE_PARAMS, image: "postgres:17-alpine" });
    // Identical except for the final (image) element.
    expect(defaultArgs.slice(0, -1)).toEqual(overriddenArgs.slice(0, -1));
    expect(defaultArgs).toContain("test-container");
    expect(defaultArgs).toContain("127.0.0.1:55432:5432");
  });
});
