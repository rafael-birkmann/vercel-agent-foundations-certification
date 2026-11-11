/**
 * Shared route-handler logic for both chat agents.
 *
 * POST  -> validate the client's UIMessage[] and start one durable workflow
 *          run for the turn; stream its output and return the run id in
 *          `x-workflow-run-id` so the client can reconnect later.
 * GET   -> reconnect to an existing run's durable stream from a UI chunk
 *          cursor (`startIndex`), without starting new work.
 */
import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import {
  createUIMessageStreamResponse,
  safeValidateUIMessages,
  type ToolSet,
  type UIMessage,
} from "ai";
import { getRun, start } from "workflow/api";

const MAX_MESSAGES = 60;
const MAX_BODY_BYTES = 400_000;

export async function startChatTurn({
  request,
  tools,
  workflow,
}: {
  request: Request;
  tools: ToolSet;
  workflow: (messages: UIMessage[]) => Promise<unknown>;
}): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json(
      { error: "Conversation is too long. Start a new chat." },
      { status: 413 },
    );
  }

  let body: { messages?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validates structure and every tool part against *this* agent's tool
  // schemas, so one agent's tool calls can't be smuggled into the other.
  const validated = await safeValidateUIMessages({
    messages: body.messages,
    tools: tools as never,
  });
  if (!validated.success) {
    return Response.json(
      { error: "Invalid messages.", details: validated.error.message },
      { status: 400 },
    );
  }
  const messages = validated.data.slice(-MAX_MESSAGES);
  if (messages.at(-1)?.role !== "user") {
    return Response.json(
      { error: "The last message must come from the user." },
      { status: 400 },
    );
  }

  const run = await start(workflow, [messages]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
    headers: { "x-workflow-run-id": run.runId },
  });
}

export async function resumeChatStream({
  request,
  runId,
  workflowName,
}: {
  request: Request;
  runId: string;
  /** Only runs of this workflow may be read through this endpoint. */
  workflowName: string;
}): Promise<Response> {
  const startIndex = Number(
    new URL(request.url).searchParams.get("startIndex") ?? "0",
  );
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    return Response.json(
      { error: "startIndex must be a non-negative integer" },
      { status: 400 },
    );
  }

  const run = getRun(runId);
  try {
    if (!(await run.exists)) {
      return Response.json({ error: "Run not found" }, { status: 404 });
    }
    const name = await run.workflowName;
    if (!name.includes(workflowName)) {
      return Response.json({ error: "Run not found" }, { status: 404 });
    }
  } catch {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  // Raw model-call parts and UI chunks don't map 1:1, so always replay the
  // raw stream from 0 and skip the UI chunks the client already has.
  const stream = run
    .getReadable({ startIndex: 0 })
    .pipeThrough(
      createModelCallToUIChunkTransform({ uiStartIndex: startIndex }),
    );

  return createUIMessageStreamResponse({
    stream,
    headers: { "x-workflow-run-id": runId },
  });
}
