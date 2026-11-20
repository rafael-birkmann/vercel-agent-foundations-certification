import { getRun } from "workflow/api";
import {
  RETURN_PROGRESS_NAMESPACE,
  type ReturnProgress,
} from "@/lib/agent-types";
import type { ReturnOrderWorkflowResult } from "@/lib/workflows/return-flow";

/**
 * Progress of a background return, polled by the return card in the shopping
 * chat. Read-only: it inspects an existing run and never starts or repeats
 * work. Only return-workflow runs are served, so this can't be used to look
 * at chat or admin runs.
 */

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const headers = { "cache-control": "no-store" };

const running: ReturnProgress = {
  stage: "running",
  returnId: null,
  decision: null,
  refundAmount: null,
  currency: null,
  notes: null,
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!RUN_ID.test(runId)) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers });
  }

  const run = getRun<ReturnOrderWorkflowResult>(runId);
  const exists = await run.exists.catch(() => false);
  const name = exists ? await run.workflowName.catch(() => "") : "";
  if (!exists || !name.includes("returnOrderWorkflow")) {
    return Response.json({ error: "not_found" }, { status: 404, headers });
  }

  const status = await run.status;

  if (status === "completed") {
    const result = await run.returnValue;
    const progress: ReturnProgress = {
      stage: "completed",
      returnId: result.returnId,
      // Only report a decision once the store has actually finished.
      decision: result.status === "completed" ? result.decision : null,
      refundAmount: result.refundAmount,
      currency: result.currency,
      notes: result.notes,
    };
    return Response.json(progress, { headers });
  }

  if (status === "failed" || status === "cancelled") {
    return Response.json({ ...running, stage: "failed" } satisfies ReturnProgress, {
      headers,
    });
  }

  // Still running: has the return been filed with the store yet?
  let returnId: string | null = null;
  try {
    const readable = run.getReadable<{ returnId: string }>({
      namespace: RETURN_PROGRESS_NAMESPACE,
    });
    if ((await readable.getTailIndex()) >= 0) {
      const reader = readable.getReader();
      const first = await reader.read();
      await reader.cancel().catch(() => {});
      returnId = first.value?.returnId ?? null;
    }
  } catch {
    returnId = null;
  }

  return Response.json(
    returnId ? { ...running, stage: "awaiting_decision", returnId } : running,
    { headers },
  );
}
