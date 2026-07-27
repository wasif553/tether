/**
 * Docker lifecycle helpers for the release-validation runner. See
 * docs/release-validation.md. Every disposable container this module
 * creates is tagged with a unique `--label` for this run, so cleanup can
 * never accidentally target a stale or unrelated container.
 */
import net from "node:net";
import { Client } from "pg";
import { runCapture } from "./processUtil";

export const RELEASE_VALIDATE_LABEL_KEY = "tether-release-validate-run";
const POSTGRES_IMAGE = "postgres:16-alpine";

export async function isDockerInstalled(): Promise<boolean> {
  const result = await runCapture("docker", ["--version"], { timeoutMs: 10_000 });
  return result.code === 0;
}

export async function isDockerDaemonRunning(): Promise<boolean> {
  const result = await runCapture("docker", ["info"], { timeoutMs: 15_000 });
  return result.code === 0;
}

/** Binds a throwaway TCP server to port 0 to ask the OS for a free port, then releases it immediately for Docker to bind. Small TOCTOU window is inherent to this technique on every platform; a bind failure is handled as an ordinary stage failure, not a crash. */
export function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine a free local port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export type DisposableContainerParams = {
  containerName: string;
  runId: string;
  databaseName: string;
  username: string;
  password: string;
  hostPort: number;
};

/** Starts the disposable Postgres container. Never logs the password — only the container name and port. */
export async function startDisposablePostgresContainer(params: DisposableContainerParams): Promise<void> {
  const args = [
    "run",
    "-d",
    "--name",
    params.containerName,
    "--label",
    `${RELEASE_VALIDATE_LABEL_KEY}=${params.runId}`,
    "-e",
    `POSTGRES_PASSWORD=${params.password}`,
    "-e",
    `POSTGRES_DB=${params.databaseName}`,
    "-e",
    `POSTGRES_USER=${params.username}`,
    "-p",
    `127.0.0.1:${params.hostPort}:5432`,
    POSTGRES_IMAGE,
  ];
  const result = await runCapture("docker", args, { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(`Failed to start disposable PostgreSQL container "${params.containerName}" (exit ${result.code}). ${result.stderr.trim().slice(0, 500)}`);
  }
}

/** Always safe to call — swallows "already removed"/"never existed" errors so cleanup can run unconditionally from any state. */
export async function removeContainer(containerName: string): Promise<{ removed: boolean }> {
  const result = await runCapture("docker", ["rm", "-f", containerName], { timeoutMs: 30_000 });
  return { removed: result.code === 0 };
}

/** Lists container names still bearing this run's label — used only to prove cleanup actually happened, never to act on containers from a different run. */
export async function listContainersForRun(runId: string): Promise<string[]> {
  const result = await runCapture("docker", ["ps", "-a", "--filter", `label=${RELEASE_VALIDATE_LABEL_KEY}=${runId}`, "--format", "{{.Names}}"], {
    timeoutMs: 15_000,
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Polls a real Postgres connection (never `docker exec pg_isready`, so
 * this works identically regardless of what's installed inside the
 * image) until it accepts `SELECT 1` or the bounded timeout elapses.
 */
export async function waitForPostgresReady(connectionString: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`PostgreSQL did not become ready within ${timeoutMs}ms. Last error: ${detail}`);
}
