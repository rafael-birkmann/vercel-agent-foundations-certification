/**
 * Admin sandbox: one persistent, named Vercel Sandbox shared by the admin
 * agent's computation (bash) and its long-term memory file.
 *
 * - Persistent: the filesystem is snapshotted when the sandbox stops and
 *   restored when it resumes, so memory survives across conversations.
 * - Isolated: commands run in a Firecracker microVM, never on the app server
 *   or a developer machine. Network egress is denied and no credentials or
 *   environment variables are passed in, so agent-written code can only see
 *   the data files we explicitly write into it.
 *
 * Server-only. Admin-only: never import this from the shopping agent.
 */
import { Sandbox } from "@vercel/sandbox";
import { DATA_DIR, MEMORY_PATH, SANDBOX_ROOT } from "./sandbox-paths";

export { DATA_DIR, MEMORY_PATH, SANDBOX_ROOT };

const SANDBOX_NAME = process.env.ADMIN_SANDBOX_NAME ?? "ship-it-shop-admin";
const MEMORY_HEADER = "# Store admin agent memory\n\n";
const MAX_MEMORY_BYTES = 16_000;

export async function getAdminSandbox(): Promise<Sandbox> {
  return Sandbox.getOrCreate({
    name: SANDBOX_NAME,
    persistent: true,
    networkPolicy: "deny-all",
    // Idle sessions stop (and snapshot) after this; the next call resumes.
    timeout: 15 * 60 * 1000,
    resources: { vcpus: 2 },
    tags: { app: "ship-it-shop", role: "admin-agent" },
    onCreate: async (sbx) => {
      await sbx.runCommand({
        cmd: "mkdir",
        args: ["-p", DATA_DIR, `${SANDBOX_ROOT}/memory`],
      });
    },
  });
}

/** Read the memory file; `null` when nothing has been saved yet. */
export async function readMemoryFile(): Promise<string | null> {
  const sandbox = await getAdminSandbox();
  const buffer = await sandbox.readFileToBuffer({ path: MEMORY_PATH });
  if (!buffer) return null;
  // Drop the file's markdown title; the entries are what the agent needs.
  const body = buffer
    .toString("utf8")
    .replace(/^# Store admin agent memory\s*/, "")
    .trim();
  return body ? body : null;
}

/** Append one memory entry. Returns the number of entries afterwards. */
export async function appendMemoryEntry(entry: string): Promise<number> {
  const sandbox = await getAdminSandbox();
  const existing =
    (await sandbox.readFileToBuffer({ path: MEMORY_PATH }))?.toString(
      "utf8",
    ) ?? MEMORY_HEADER;
  const next = `${existing.replace(/\s*$/, "\n")}${entry}\n`;
  if (Buffer.byteLength(next) > MAX_MEMORY_BYTES) {
    throw new Error(
      "Memory file is full. Ask an employee to review and prune it before saving more.",
    );
  }
  await sandbox.writeFiles([{ path: MEMORY_PATH, content: next }]);
  return next.split("\n").filter((line) => line.startsWith("- ")).length;
}

/** Write a JSON dataset into the sandbox for later computation. */
export async function writeDataFile(
  name: string,
  data: unknown,
): Promise<string> {
  const sandbox = await getAdminSandbox();
  const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const path = `${DATA_DIR}/${safeName}.json`;
  await sandbox.writeFiles([
    { path, content: JSON.stringify(data, null, 2) },
  ]);
  return path;
}

export async function runInSandbox(
  command: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const sandbox = await getAdminSandbox();
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", command],
    cwd: SANDBOX_ROOT,
    timeoutMs,
  });
  const [stdout, stderr] = await Promise.all([
    result.stdout(),
    result.stderr(),
  ]);
  return { exitCode: result.exitCode, stdout, stderr };
}
