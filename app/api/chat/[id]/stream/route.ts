/**
 * Reconnect to an in-progress (or finished) shopping chat run after a
 * dropped connection or a page refresh. Never starts new work.
 */
import { resumeChatStream } from "@/lib/chat-route";

export const maxDuration = 300;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return resumeChatStream({
    request,
    runId: id,
    workflowName: "shoppingChatWorkflow",
  });
}
