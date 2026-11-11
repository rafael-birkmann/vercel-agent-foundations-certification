/**
 * Shopping agent chat endpoint. Each turn starts one durable workflow run
 * (lib/workflows/chat-flow.ts) and streams it back to the storefront chat.
 */
import { startChatTurn } from "@/lib/chat-route";
import { shoppingTools } from "@/lib/tools";
import { shoppingChatWorkflow } from "@/lib/workflows/chat-flow";

export const maxDuration = 300;

export async function POST(request: Request) {
  return startChatTurn({
    request,
    tools: shoppingTools,
    workflow: shoppingChatWorkflow,
  });
}
