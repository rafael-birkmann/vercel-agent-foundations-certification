/**
 * Reconnect to an admin chat run (employees only). Only admin workflow runs
 * can be read here, and admin runs can't be read through the shopping
 * endpoint.
 */
import { isAdminSession } from "@/lib/admin-session";
import { resumeChatStream } from "@/lib/chat-route";

export const maxDuration = 300;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAdminSession())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  return resumeChatStream({
    request,
    runId: id,
    workflowName: "adminChatWorkflow",
  });
}
