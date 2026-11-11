/**
 * Store admin agent chat endpoint (employees only). Each turn starts one
 * durable workflow run (lib/workflows/admin-chat-flow.ts).
 */
import { adminTools } from "@/lib/admin-tools";
import { isAdminSession } from "@/lib/admin-session";
import { startChatTurn } from "@/lib/chat-route";
import { adminChatWorkflow } from "@/lib/workflows/admin-chat-flow";

export const maxDuration = 300;

export async function POST(request: Request) {
  if (!(await isAdminSession())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return startChatTurn({
    request,
    tools: adminTools,
    workflow: adminChatWorkflow,
  });
}
