/**
 * Store admin agent tools (employee-facing, admin-only).
 *
 * - Back-office tools are strictly read-only. Each one returns a compact
 *   preview to the model and writes the full dataset as JSON into the admin
 *   sandbox, where the `bash` tool can aggregate and join it.
 * - `bash` executes inside the isolated Vercel Sandbox (no network, no
 *   secrets) — never on the application server.
 * - `saveMemory` appends to the persistent memory file in the same sandbox.
 *
 * Every `execute` is a durable workflow step (`"use step"`).
 *
 * Only `lib/workflows/admin-chat-flow.ts` may import this module.
 */
import { tool } from "ai";
import { z } from "zod";
import {
  getBackOfficeReturns,
  getBackOfficeSales,
  getBackOfficeStock,
  getBackOfficeSupportTickets,
} from "./api";
import { formatPrice } from "./format";
import {
  apiFailureOrThrow,
  containsSecret,
  redactSecrets,
  truncate,
} from "./tool-helpers";
import {
  appendMemoryEntry,
  MEMORY_PATH,
  runInSandbox,
  writeDataFile,
} from "./sandbox";
import { getAllCategoriesStep, searchProductsInput, searchProductsStep } from "./tools";
import type {
  BackOfficeResult,
  BashResult,
  SandboxDataFile,
  SaveMemoryResult,
} from "./agent-types";
import type {
  BackOfficeDateRangeMeta,
  BackOfficeSalesMeta,
  BackOfficeStockMeta,
  StockEntry,
} from "./types";

const PREVIEW_ROWS = 30;

type ToolCtx = { toolCallId: string };

/** Save the full dataset to the sandbox; failures are reported, not fatal. */
async function saveDataset(
  kind: string,
  toolCallId: string,
  payload: unknown,
): Promise<SandboxDataFile> {
  try {
    const path = await writeDataFile(
      `${kind}-${toolCallId.slice(-8)}`,
      payload,
    );
    return { path, error: null };
  } catch (error) {
    return {
      path: null,
      error: redactSecrets(
        `Could not save to sandbox: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
}

function preview<T>(rows: T[]) {
  return {
    rows: rows.slice(0, PREVIEW_ROWS),
    truncated: rows.length > PREVIEW_ROWS,
  };
}

const dateParam = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/,
    "Use YYYY-MM-DD or an ISO 8601 datetime",
  );

// ---------------------------------------------------------------------------
// Back-office steps
// ---------------------------------------------------------------------------

async function getSupportTicketsStep(
  input: Parameters<typeof getBackOfficeSupportTickets>[0],
  { toolCallId }: ToolCtx,
): Promise<BackOfficeResult<Record<string, unknown>, BackOfficeDateRangeMeta>> {
  "use step";
  try {
    const { data, meta } = await getBackOfficeSupportTickets(input);
    const sandboxFile = await saveDataset("support-tickets", toolCallId, {
      filters: input,
      meta,
      data,
    });
    const { rows, truncated } = preview(
      data.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        category: t.category,
        assignee: t.assignee,
        relatedOrderId: t.relatedOrderId,
        createdAt: t.createdAt,
        lastMessageAt: t.lastMessageAt,
        messagePreview: truncate(t.messagePreview, 160).text,
      })),
    );
    return {
      ok: true,
      meta,
      rowCount: data.length,
      rows,
      truncated,
      sandboxFile,
      notes: [
        `Limit ${input?.limit ?? 25} (API default 25, max 500); raise it if counts may be cut off.`,
        ...(input?.assignee ? ["Unassigned tickets are excluded when filtering by assignee."] : []),
      ],
    };
  } catch (error) {
    return apiFailureOrThrow(error, { notFound: "No support tickets found." });
  }
}

async function getReturnsHistoryStep(
  input: Parameters<typeof getBackOfficeReturns>[0],
  { toolCallId }: ToolCtx,
): Promise<BackOfficeResult<Record<string, unknown>, BackOfficeDateRangeMeta>> {
  "use step";
  try {
    const { data, meta } = await getBackOfficeReturns(input);
    const sandboxFile = await saveDataset("returns", toolCallId, {
      filters: input,
      meta,
      data,
    });
    const { rows, truncated } = preview(
      data.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        status: r.status,
        decision: r.decision,
        reason: r.reason,
        items: r.items,
        refundAmount: r.refundAmount,
        refundFormatted:
          r.refundAmount != null ? formatPrice(r.refundAmount) : null,
        order: r.order ?? null,
        createdAt: r.createdAt,
      })),
    );
    return {
      ok: true,
      meta,
      rowCount: data.length,
      rows,
      truncated,
      sandboxFile,
      notes: [
        `Limit ${input?.limit ?? 25} (API default 25, max 500). Use limit 500 for rate calculations.`,
        "Returns history covers roughly the last 180 days.",
      ],
    };
  } catch (error) {
    return apiFailureOrThrow(error, { notFound: "No returns found." });
  }
}

async function getInventoryStockStep(
  input: Parameters<typeof getBackOfficeStock>[0] & { allPages?: boolean },
  { toolCallId }: ToolCtx,
): Promise<BackOfficeResult<Record<string, unknown>, BackOfficeStockMeta>> {
  "use step";
  const { allPages, ...params } = input ?? {};
  try {
    let { data, meta } = await getBackOfficeStock(params);
    const all: StockEntry[] = [...data];
    // Optionally walk every page (bounded) so joins see the full inventory.
    let pagesFetched = 1;
    while (allPages && meta.pagination.hasNextPage && pagesFetched < 20) {
      ({ data, meta } = await getBackOfficeStock({
        ...params,
        page: meta.pagination.page + 1,
      }));
      all.push(...data);
      pagesFetched++;
    }
    const sandboxFile = await saveDataset("inventory", toolCallId, {
      filters: input,
      meta,
      pagesFetched,
      data: all,
    });
    const { rows, truncated } = preview(
      all.map((s) => ({
        productId: s.productId,
        name: s.product.name,
        category: s.product.category,
        stock: s.stock,
        inStock: s.inStock,
        lowStock: s.lowStock,
        updatedAt: s.updatedAt,
      })),
    );
    return {
      ok: true,
      meta,
      rowCount: all.length,
      rows,
      truncated,
      sandboxFile,
      notes: [
        "lowStock means 1–5 units on hand.",
        allPages
          ? `Fetched ${pagesFetched} page(s).`
          : meta.pagination.hasNextPage
            ? `More pages exist (page ${meta.pagination.page} of ${meta.pagination.totalPages}); pass page or allPages: true.`
            : "All matching rows fetched.",
      ],
    };
  } catch (error) {
    return apiFailureOrThrow(error, {
      notFound: "No inventory found for those products.",
    });
  }
}

async function getSalesAnalyticsStep(
  input: Parameters<typeof getBackOfficeSales>[0],
  { toolCallId }: ToolCtx,
): Promise<BackOfficeResult<Record<string, unknown>, BackOfficeSalesMeta & { revenueFormatted: string }>> {
  "use step";
  try {
    const { data, meta } = await getBackOfficeSales(input);
    const sandboxFile = await saveDataset("sales", toolCallId, {
      filters: input,
      meta,
      data,
    });
    const { rows, truncated } = preview(
      data.map((r) => ({
        productId: r.productId,
        name: r.product.name,
        category: r.product.category,
        unitPrice: r.product.price,
        unitsSold: r.unitsSold,
        ordersCount: r.ordersCount,
        revenue: r.revenue,
        revenueFormatted: formatPrice(r.revenue, r.currency),
      })),
    );
    return {
      ok: true,
      meta: {
        ...meta,
        revenueFormatted: formatPrice(meta.totals.revenue, meta.currency),
      },
      rowCount: data.length,
      rows,
      truncated,
      sandboxFile,
      notes: [
        "Rows are sorted by unitsSold descending. Revenue is in cents.",
        "Sales data covers roughly the last 180 days.",
      ],
    };
  } catch (error) {
    return apiFailureOrThrow(error, {
      notFound: input?.productId
        ? `Product ${input.productId} does not exist.`
        : "No sales data found.",
    });
  }
}

async function adminSearchProductsStep(
  input: z.infer<typeof searchProductsInput>,
  { toolCallId }: ToolCtx,
) {
  "use step";
  const result = await searchProductsStep(input);
  if (!result.ok) return result;
  const sandboxFile = await saveDataset("catalog", toolCallId, result);
  return { ...result, sandboxFile };
}

async function adminCategoriesStep() {
  "use step";
  return getAllCategoriesStep();
}

// ---------------------------------------------------------------------------
// Sandbox + memory steps
// ---------------------------------------------------------------------------

async function bashStep(input: {
  command: string;
  timeoutSeconds?: number;
}): Promise<BashResult> {
  "use step";
  const started = Date.now();
  // Infrastructure errors (sandbox unavailable) throw and are retried by the
  // step; a non-zero exit code is a normal result the model can react to.
  const result = await runInSandbox(
    input.command,
    (input.timeoutSeconds ?? 60) * 1000,
  );
  const stdout = truncate(redactSecrets(result.stdout), 12_000);
  const stderr = truncate(redactSecrets(result.stderr), 4_000);
  return {
    command: input.command,
    exitCode: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    durationMs: Date.now() - started,
  };
}

async function saveMemoryStep(input: {
  note: string;
  kind: "preference" | "correction" | "business_context";
}): Promise<SaveMemoryResult> {
  "use step";
  const note = input.note.replace(/\s+/g, " ").trim();
  if (containsSecret(note)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "That note contains a credential, so it was not saved.",
    };
  }
  const date = new Date().toISOString().slice(0, 10);
  const entry = `- [${date}] (${input.kind}) ${note}`;
  try {
    const totalEntries = await appendMemoryEntry(entry);
    return { ok: true, saved: entry, path: MEMORY_PATH, totalEntries };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Memory file is full")) {
      return { ok: false, code: "unavailable", message: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const adminTools = {
  getSupportTickets: tool({
    description:
      "Read support tickets (read-only). Filter by created date range, status, priority, category, assignee and limit. Full results are saved to the sandbox.",
    inputSchema: z.object({
      from: dateParam.optional().describe("Start (inclusive). Default: 30 days before `to`."),
      to: dateParam.optional().describe("End. Default: now."),
      status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      category: z
        .enum(["shipping", "returns", "product_quality", "sizing", "billing", "payment", "account", "other"])
        .optional(),
      assignee: z.string().min(1).max(50).optional().describe("Staff username, e.g. 'alex'."),
      limit: z.number().int().min(1).max(500).optional().describe("1–500, default 25."),
    }),
    execute: getSupportTicketsStep,
  }),

  getReturnsHistory: tool({
    description:
      "Read historical customer returns (read-only) with items, decision, refund amount and order summary. Filter by date range, status, decision and limit. Full results are saved to the sandbox.",
    inputSchema: z.object({
      from: dateParam.optional().describe("Start (inclusive). Default: 30 days before `to`."),
      to: dateParam.optional().describe("End. Default: now."),
      status: z.enum(["pending", "processing", "completed"]).optional(),
      decision: z.enum(["approved", "rejected", "needs_info"]).optional(),
      limit: z.number().int().min(1).max(500).optional().describe("1–500, default 25."),
    }),
    execute: getReturnsHistoryStep,
  }),

  getInventoryStock: tool({
    description:
      "Read current inventory levels (read-only). Filter by productIds, lowStock (1–5 units) and inStock; paginated (page, limit up to 200). Set allPages to fetch every page. Full results are saved to the sandbox.",
    inputSchema: z.object({
      productIds: z.array(z.string().min(1).max(60)).max(100).optional(),
      lowStock: z.boolean().optional(),
      inStock: z.boolean().optional(),
      page: z.number().int().min(1).max(100).optional(),
      limit: z.number().int().min(1).max(200).optional().describe("1–200, default 50."),
      allPages: z.boolean().optional().describe("Fetch all pages (bounded)."),
    }),
    execute: getInventoryStockStep,
  }),

  getSalesAnalytics: tool({
    description:
      "Read sales totals by product for a date range (read-only): units sold, orders and revenue (cents), sorted by units sold. Optionally restrict to one productId. Full results are saved to the sandbox.",
    inputSchema: z.object({
      from: dateParam.optional().describe("Start (inclusive). Default: 30 days before `to`."),
      to: dateParam.optional().describe("End. Default: now."),
      productId: z.string().min(1).max(60).optional(),
    }),
    execute: getSalesAnalyticsStep,
  }),

  searchProducts: tool({
    description:
      "Search the product catalog by text and/or category to identify products (ids, names, prices). Results are saved to the sandbox.",
    inputSchema: searchProductsInput,
    execute: adminSearchProductsStep,
  }),

  getAllCategories: tool({
    description: "List the store's product categories with product counts.",
    inputSchema: z.object({}),
    execute: adminCategoriesStep,
  }),

  bash: tool({
    description:
      "Run a bash command in the isolated admin sandbox (cwd /vercel/sandbox). Tools: node, python3, jq, sqlite3. No network, no credentials. Use it to compute aggregates/joins over JSON files saved by the other tools in /vercel/sandbox/data.",
    inputSchema: z.object({
      command: z.string().min(1).max(8000).describe("The bash script to run."),
      timeoutSeconds: z.number().int().min(1).max(120).optional().describe("Default 60."),
    }),
    execute: bashStep,
  }),

  saveMemory: tool({
    description:
      "Save one durable fact to the admin memory file so it's available in future conversations: an employee preference, a correction, or business context. Never save secrets or volatile store numbers.",
    inputSchema: z.object({
      note: z.string().min(3).max(500).describe("One concise, self-contained fact."),
      kind: z.enum(["preference", "correction", "business_context"]),
    }),
    execute: saveMemoryStep,
  }),
};

export type AdminTools = typeof adminTools;
