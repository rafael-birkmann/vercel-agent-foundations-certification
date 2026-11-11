/**
 * Store admin chat workflow — one durable run per chat turn.
 *
 * Before the agent starts, application code (a step, not the model) reads
 * the persistent memory file from the admin sandbox and injects it into the
 * instructions. Every model call and tool call (back-office reads, sandbox
 * bash, memory writes) is a retryable workflow step.
 */
import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type UIMessage } from "ai";
import { getWritable } from "workflow";
import { writeStreamError } from "./stream-error";
import { ADMIN_MODEL, buildAdminInstructions } from "../agent";
import { adminTools } from "../admin-tools";
import { readMemoryFile } from "../sandbox";
import { DATA_DIR, MEMORY_PATH } from "../sandbox-paths";

async function loadAdminMemory(): Promise<string | null> {
  "use step";
  return readMemoryFile();
}
loadAdminMemory.maxRetries = 2;

export async function adminChatWorkflow(messages: UIMessage[]) {
  "use workflow";

  let memory: string | null = null;
  let memoryError: string | null = null;
  try {
    memory = await loadAdminMemory();
  } catch (error) {
    // Degrade gracefully: the agent still works, it just says memory is off.
    memoryError =
      error instanceof Error ? error.message.slice(0, 200) : "unknown error";
  }

  const agent = new WorkflowAgent({
    model: ADMIN_MODEL,
    instructions: buildAdminInstructions({
      memory,
      memoryError,
      memoryPath: MEMORY_PATH,
      dataDir: DATA_DIR,
      now: new Date().toISOString(),
    }),
    tools: adminTools,
    stopWhen: isStepCount(25),
    maxRetries: 3,
  });

  const writable = getWritable<ModelCallStreamPart>();
  await agent.stream({
    messages: await convertToModelMessages(messages),
    writable,
    onError: async ({ error }) => {
      await writeStreamError(writable, error, "employee");
    },
  });
}
