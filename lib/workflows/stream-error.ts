/**
 * Surface a failed agent run to the chat instead of ending silently.
 *
 * WorkflowAgent calls `onError` (after retries are exhausted) before it
 * closes the run's stream, so we write an `error` part that the UI renders.
 */
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { redactSecrets } from "../tool-helpers";

export async function writeStreamError(
  writable: WritableStream<ModelCallStreamPart>,
  error: unknown,
  audience: "shopper" | "employee",
) {
  "use step";
  const detail = (error instanceof Error ? error.message : String(error))
    // Drop the internal 'Step "step//…" failed after N retries:' prefix.
    .replace(/^"?Step\s+\\?"[^"]*\\?"\s+failed after \d+ retries:\s*/, "")
    .replace(/"$/, "");
  console.error(`[agent:${audience}] run failed:`, redactSecrets(detail));
  const message =
    audience === "shopper"
      ? "Sorry, the shopping assistant is temporarily unavailable. Please try again in a moment."
      : `The admin agent failed after retrying: ${redactSecrets(detail).slice(0, 300)}`;
  const writer = writable.getWriter();
  try {
    await writer.write({ type: "error", error: new Error(message) } as ModelCallStreamPart);
  } finally {
    writer.releaseLock();
  }
}
