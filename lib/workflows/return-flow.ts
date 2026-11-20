/**
 * Durable return workflow.
 *
 * Started (fire-and-forget) by the shopping agent's `returnOrder` tool, so
 * the chat confirms the return immediately while this keeps running.
 *
 * Every side effect is its own step. The workflow event log records each
 * completed step, so when a later step fails and is retried — or the
 * function crashes and the run is replayed — completed steps are NOT
 * executed again: the customer is notified once and the refund is
 * pre-authorized once, even if filing the return needs several attempts.
 */
import {
  FatalError,
  createWebhook,
  getStepMetadata,
  getWritable,
  sleep,
} from "workflow";
import {
  ApiRequestError,
  createReturn,
  getOrder,
  getReturn,
  notifyReturnInProcess,
  preauthorizeRefund,
} from "../api";
import type { Return } from "../types";
import { RETURN_PROGRESS_NAMESPACE } from "../agent-types";

export interface ReturnOrderInput {
  orderId: string;
  reason: string;
  items: { productId: string; quantity: number }[];
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function lookupOrder(orderId: string) {
  "use step";
  try {
    const order = await getOrder(orderId);
    if (order.status !== "fulfilled" && order.status !== "delivered") {
      throw new FatalError(
        `Order ${orderId} is ${order.status}; it cannot be returned.`,
      );
    }
    return { id: order.id, total: order.total, currency: order.currency };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      throw new FatalError(`Order ${orderId} not found.`);
    }
    throw error; // transient: retry
  }
}

async function notifyCustomer(orderId: string) {
  "use step";
  await notifyReturnInProcess(orderId);
  return { notifiedAt: new Date().toISOString() };
}

async function preauthorize(orderId: string) {
  "use step";
  try {
    const auth = await preauthorizeRefund(orderId);
    return { id: auth.id, amount: auth.amount, currency: auth.currency };
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      (error.status === 404 || error.status === 422)
    ) {
      throw new FatalError(`Refund pre-authorization rejected: ${error.message}`);
    }
    throw error;
  }
}

/**
 * The webhook URL is built from VERCEL_URL (the per-deployment host), which
 * Vercel Authentication protects, so the store's callback would get a 401 in
 * production. Use the public production domain there instead. Previews and
 * local runs keep the original URL (and fall back to polling).
 */
function publicCallbackUrl(callback: string): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (process.env.VERCEL_ENV !== "production" || !host) return callback;
  const url = new URL(callback);
  url.protocol = "https:";
  url.host = host;
  return url.toString();
}

async function fileReturn(input: ReturnOrderInput & { callback: string }) {
  "use step";
  // Opt-in failure injection to demonstrate retries without repeated side
  // effects: the first attempt fails, the retry succeeds, and the notify /
  // pre-authorize steps above are not run again.
  const { attempt } = getStepMetadata();
  if (process.env.RETURN_FLOW_SIMULATE_FAILURE === "1" && attempt === 1) {
    throw new Error("Simulated transient failure while filing the return");
  }
  try {
    const ret = await createReturn({
      orderId: input.orderId,
      items: input.items,
      reason: input.reason,
      callback: publicCallbackUrl(input.callback),
    });
    return pickReturn(ret);
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      (error.status === 400 || error.status === 404 || error.status === 422)
    ) {
      throw new FatalError(`The store rejected the return: ${error.message}`);
    }
    throw error;
  }
}
fileReturn.maxRetries = 5;

/**
 * Publish the store's return id on the run's "progress" stream, so
 * GET /api/returns/[runId] can show "waiting for a decision" while the run is
 * still going.
 */
async function publishFiled(returnId: string) {
  "use step";
  const writer = getWritable<{ returnId: string }>({
    namespace: RETURN_PROGRESS_NAMESPACE,
  }).getWriter();
  try {
    await writer.write({ returnId });
  } finally {
    writer.releaseLock();
  }
}

/** Re-read the return from the API (never trust the webhook body itself). */
async function fetchReturnStatus(returnId: string) {
  "use step";
  return pickReturn(await getReturn(returnId));
}

async function notifyDecision(ret: ReturnType<typeof pickReturn>) {
  "use step";
  // In production this would email the customer.
  console.log(
    `[returnOrder] 📧 told customer the return ${ret.id} for order ${ret.orderId} was ${ret.decision ?? ret.status}`,
  );
}

function pickReturn(ret: Return) {
  return {
    id: ret.id,
    orderId: ret.orderId,
    status: ret.status,
    decision: ret.decision,
    refundAmount: ret.refundAmount,
    notes: ret.notes,
  };
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function returnOrderWorkflow(input: ReturnOrderInput) {
  "use workflow";

  const order = await lookupOrder(input.orderId);
  const notification = await notifyCustomer(order.id);
  const refundAuth = await preauthorize(order.id);

  // The store API POSTs its decision to this URL. Register the webhook before
  // handing out its URL so an early callback can't be missed.
  const webhook = createWebhook();
  await webhook.getConflict();

  const filed = await fileReturn({ ...input, callback: webhook.url });
  await publishFiled(filed.id);

  // Wait for the decision callback (usually 15–60s), but don't rely on it:
  // locally the API can't reach a localhost callback URL, so fall back to
  // polling the return status.
  const callback = await Promise.race([
    webhook.then(() => "callback" as const),
    sleep("3m").then(() => "timeout" as const),
  ]);

  let latest = await fetchReturnStatus(filed.id);
  for (let i = 0; i < 10 && latest.status !== "completed"; i++) {
    await sleep("30s");
    latest = await fetchReturnStatus(filed.id);
  }

  if (latest.status === "completed") {
    await notifyDecision(latest);
  }

  return {
    orderId: order.id,
    returnId: filed.id,
    notifiedAt: notification.notifiedAt,
    refundAuthorizationId: refundAuth.id,
    decisionSource: callback,
    status: latest.status,
    decision: latest.decision,
    refundAmount: latest.refundAmount,
    currency: order.currency,
    notes: latest.notes,
  };
}

export type ReturnOrderWorkflowResult = Awaited<
  ReturnType<typeof returnOrderWorkflow>
>;
