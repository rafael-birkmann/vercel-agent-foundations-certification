/**
 * Shapes of the values our agent tools return.
 *
 * Pure type module: imported by the server-side tools (to type their return
 * values) and by the client chat components (to render tool parts as
 * generative UI). Never import runtime code from here.
 */
import type { Product, StockInfo } from "./types";

/** Every tool result is either `ok: true` with data or `ok: false` with a reason. */
export type ToolFailure = {
  ok: false;
  /** Machine-readable reason, useful for the UI. */
  code:
    | "not_found"
    | "invalid_input"
    | "not_eligible"
    | "already_in_progress"
    | "unavailable";
  /** Human-readable explanation, safe to show to the end user. */
  message: string;
};

// ---------------------------------------------------------------------------
// Shopping agent
// ---------------------------------------------------------------------------

export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  category: string;
  price: number;
  currency: string;
  priceFormatted: string;
  image: string | null;
  /** Relative storefront URL, e.g. `/products/black-pullover-hoodie`. */
  url: string;
}

export type SearchProductsResult =
  | {
      ok: true;
      query: string | null;
      category: string | null;
      page: number;
      limit: number;
      count: number;
      hasMore: boolean;
      products: ProductSummary[];
    }
  | (ToolFailure & { validCategories?: string[] });

export type CategoriesResult =
  | {
      ok: true;
      categories: { slug: string; name: string; productCount: number }[];
    }
  | ToolFailure;

export type ProductDetailsResult =
  | {
      ok: true;
      product: Product;
      priceFormatted: string;
      url: string;
      /** `null` when the live stock lookup failed. */
      stock: StockInfo | null;
      stockError: string | null;
    }
  | ToolFailure;

export type ReturnOrderResult =
  | {
      ok: true;
      status: "filed";
      orderId: string;
      /** Workflow run that is processing the return in the background. */
      returnRequestId: string;
      items: { productId: string; name: string | null; quantity: number }[];
      /** Masked customer email the confirmation goes to. */
      notifyEmail: string;
      estimatedRefund: number;
      estimatedRefundFormatted: string;
      nextSteps: string;
    }
  | (ToolFailure & { orderStatus?: string; returnRequestId?: string });

/** Stream namespace the return workflow publishes "filed" progress on. */
export const RETURN_PROGRESS_NAMESPACE = "progress";

/** Live state of a background return, served by GET /api/returns/[runId]. */
export interface ReturnProgress {
  stage: "running" | "awaiting_decision" | "completed" | "failed";
  returnId: string | null;
  decision: "approved" | "rejected" | "needs_info" | null;
  /** Cents. */
  refundAmount: number | null;
  currency: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Admin agent
// ---------------------------------------------------------------------------

/** Where a back-office tool saved the full dataset inside the admin sandbox. */
export interface SandboxDataFile {
  path: string | null;
  /** Set when the dataset could not be written to the sandbox. */
  error: string | null;
}

export type BackOfficeResult<TRow, TMeta> =
  | {
      ok: true;
      meta: TMeta;
      /** Total rows fetched from the API. */
      rowCount: number;
      /** Rows included inline (capped to keep the model context small). */
      rows: TRow[];
      truncated: boolean;
      sandboxFile: SandboxDataFile;
      notes: string[];
    }
  | ToolFailure;

export interface BashResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export type SaveMemoryResult =
  | { ok: true; saved: string; path: string; totalEntries: number }
  | ToolFailure;
