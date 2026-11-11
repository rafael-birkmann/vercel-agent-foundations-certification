/**
 * Shopping chat workflow — one durable run per chat turn.
 *
 * The client owns the conversation history and sends the full UIMessage[]
 * with each turn. WorkflowAgent turns every model call and every tool call
 * into a workflow step, so transient failures are retried and an
 * interrupted run continues from its last completed step. Output goes to the
 * run's durable stream, which clients can re-read after a disconnect or a
 * page refresh (see app/api/chat/[id]/stream).
 */
import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type UIMessage } from "ai";
import { getWritable } from "workflow";
import { writeStreamError } from "./stream-error";
import { SHOPPING_INSTRUCTIONS, SHOPPING_MODEL } from "../agent";
import { shoppingTools } from "../tools";

export async function shoppingChatWorkflow(messages: UIMessage[]) {
  "use workflow";

  const agent = new WorkflowAgent({
    model: SHOPPING_MODEL,
    instructions: SHOPPING_INSTRUCTIONS,
    tools: shoppingTools,
    stopWhen: isStepCount(8),
    maxRetries: 3,
  });

  const writable = getWritable<ModelCallStreamPart>();
  await agent.stream({
    messages: await convertToModelMessages(messages),
    writable,
    onError: async ({ error }) => {
      await writeStreamError(writable, error, "shopper");
    },
  });
}
