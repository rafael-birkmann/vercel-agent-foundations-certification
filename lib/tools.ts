/**
 * Shopping agent tools (customer-facing).
 *
 * Every `execute` is a workflow step (`"use step"`): it runs with full
 * Node.js access, its result is persisted in the workflow event log, and it
 * is retried automatically on transient failures. Inputs are validated by the
 * zod schemas before the step runs.
 *
 * This module must never import admin capabilities (back-office data,
 * sandbox, memory). Those live in `lib/admin-tools.ts`.
 */
import { tool } from "ai";
import { z } from "zod";
import { start } from "workflow/api";
import { HookConflictError } from "workflow/errors";
import {
  getCategories,
  getOrder,
  getProductById,
  getProductStock,
  getProducts,
} from "./api";
import { formatPrice } from "./format";
import {
  apiFailureOrThrow,
  maskEmail,
  redactSecrets,
} from "./tool-helpers";
import type {
  CategoriesResult,
  ProductDetailsResult,
  ProductSummary,
  ReturnOrderResult,
  SearchProductsResult,
} from "./agent-types";
import type { Product } from "./types";
import { returnOrderWorkflow } from "./workflows/return-flow";

function toSummary(product: Product): ProductSummary {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    category: product.category,
    price: product.price,
    currency: product.currency,
    priceFormatted: formatPrice(product.price, product.currency),
    image: product.images[0] ?? null,
    url: `/products/${product.slug}`,
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export async function searchProductsStep(input: {
  query?: string;
  category?: string;
  page?: number;
  limit?: number;
}): Promise<SearchProductsResult> {
  "use step";
  const query = input.query?.trim() || undefined;
  const category = input.category?.trim().toLowerCase() || undefined;
  const page = input.page ?? 1;
  const limit = input.limit ?? 12;

  try {
    // Validate the category against live store data, not a fixed list.
    if (category) {
      const categories = await getCategories();
      const valid = categories.map((c) => String(c.slug));
      if (!valid.includes(category)) {
        return {
          ok: false,
          code: "invalid_input",
          message: `"${category}" is not a store category.`,
          validCategories: valid,
        };
      }
    }

    // Ask for one extra item so we can tell whether another page exists.
    const products = await getProducts({
      search: query,
      category,
      page,
      limit: Math.min(limit + 1, 100),
    });
    const pageItems = products.slice(0, limit);
    return {
      ok: true,
      query: query ?? null,
      category: category ?? null,
      page,
      limit,
      count: pageItems.length,
      hasMore: products.length > limit,
      products: pageItems.map(toSummary),
    };
  } catch (error) {
    return apiFailureOrThrow(error, {
      notFound: "No products matched that search.",
    });
  }
}

export async function getAllCategoriesStep(): Promise<CategoriesResult> {
  "use step";
  try {
    const categories = await getCategories();
    return {
      ok: true,
      categories: categories.map((c) => ({
        slug: String(c.slug),
        name: c.name,
        productCount: c.productCount,
      })),
    };
  } catch (error) {
    return apiFailureOrThrow(error, { notFound: "No categories found." });
  }
}

export async function getProductDetailsStep(input: {
  product: string;
}): Promise<ProductDetailsResult> {
  "use step";
  const idOrSlug = input.product.trim();
  let product: Product;
  try {
    product = await getProductById(idOrSlug);
  } catch (error) {
    return apiFailureOrThrow(error, {
      notFound: `We couldn't find a product called "${idOrSlug}". Try searching the catalog instead.`,
    });
  }

  // Stock is live and optional: a failed lookup shouldn't hide the product.
  let stock: Awaited<ReturnType<typeof getProductStock>> | null = null;
  let stockError: string | null = null;
  try {
    stock = await getProductStock(product.id);
  } catch (error) {
    stockError = redactSecrets(
      `Live stock is unavailable right now${error instanceof Error ? ` (${error.message})` : ""}.`,
    );
  }

  return {
    ok: true,
    product,
    priceFormatted: formatPrice(product.price, product.currency),
    url: `/products/${product.slug}`,
    stock,
    stockError,
  };
}

export async function returnOrderStep(input: {
  orderId: string;
  reason: string;
  items?: { productId: string; quantity: number }[];
}): Promise<ReturnOrderResult> {
  "use step";
  const orderId = input.orderId.trim();

  // 1. Look up the order and check it is eligible before starting anything.
  let order: Awaited<ReturnType<typeof getOrder>>;
  try {
    order = await getOrder(orderId);
  } catch (error) {
    return apiFailureOrThrow(error, {
      notFound: `We couldn't find order ${orderId}. Please double-check the order number.`,
    });
  }

  if (order.status !== "fulfilled" && order.status !== "delivered") {
    return {
      ok: false,
      code: "not_eligible",
      orderStatus: order.status,
      message:
        order.status === "cancelled"
          ? `Order ${orderId} was cancelled, so there is nothing to return.`
          : `Order ${orderId} is "${order.status}" and hasn't been fulfilled yet, so it can't be returned.`,
    };
  }

  // 2. Resolve which items to return (default: the whole order).
  const orderItems = new Map(order.items.map((i) => [i.productId, i]));
  const requested =
    input.items && input.items.length > 0
      ? input.items
      : order.items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity,
        }));
  for (const item of requested) {
    const line = orderItems.get(item.productId);
    if (!line) {
      return {
        ok: false,
        code: "invalid_input",
        message: `Product ${item.productId} is not part of order ${orderId}. It contains: ${order.items
          .map((i) => `${i.product?.name ?? i.productId} (${i.productId})`)
          .join(", ")}.`,
      };
    }
    if (item.quantity > line.quantity) {
      return {
        ok: false,
        code: "invalid_input",
        message: `Order ${orderId} only has ${line.quantity} × ${line.product?.name ?? item.productId}.`,
      };
    }
  }

  const estimatedRefund = requested.reduce(
    (sum, item) =>
      sum + (orderItems.get(item.productId)?.unitPrice ?? 0) * item.quantity,
    0,
  );

  // 3. Start the durable return workflow and return immediately. The token
  //    makes the start idempotent: a retried step, a double-click, or a
  //    reconnecting client can't file a second return for the same order
  //    while the first one is still running.
  let returnRequestId: string;
  try {
    const run = await start(
      returnOrderWorkflow,
      [{ orderId, reason: input.reason.trim(), items: requested }],
      { experimental_hook: { token: `return-order:${orderId}` } },
    );
    returnRequestId = run.runId;
  } catch (error) {
    if (HookConflictError.is(error)) {
      return {
        ok: false,
        code: "already_in_progress",
        returnRequestId: error.conflictingRunId,
        message: `A return for order ${orderId} is already being processed. You'll get an email when it's decided.`,
      };
    }
    throw error;
  }

  return {
    ok: true,
    status: "filed",
    orderId,
    returnRequestId,
    items: requested.map((i) => ({
      productId: i.productId,
      name: orderItems.get(i.productId)?.product?.name ?? null,
      quantity: i.quantity,
    })),
    notifyEmail: maskEmail(order.email),
    estimatedRefund,
    estimatedRefundFormatted: formatPrice(estimatedRefund, order.currency),
    nextSteps:
      "We're notifying you by email and pre-authorizing the refund now. The store reviews returns within a few minutes and emails the decision.",
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const searchProductsInput = z.object({
  query: z
    .string()
    .max(100)
    .optional()
    .describe(
      "Free-text search (name, description, tags). Omit to browse the whole catalog.",
    ),
  category: z
    .string()
    .max(50)
    .optional()
    .describe(
      "Category slug from getAllCategories, e.g. 'hoodies'. Omit for all categories.",
    ),
  page: z.number().int().min(1).max(50).optional().describe("1-based page."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe("Results per page (default 12)."),
});

export const searchProducts = tool({
  description:
    "Search or browse the Ship It Shop catalog by text and/or category. Results are shown to the shopper as product cards with images, prices and links.",
  inputSchema: searchProductsInput,
  execute: searchProductsStep,
});

export const getAllCategories = tool({
  description:
    "List the store's current product categories (slug, name, product count). Use it to discover valid category filters.",
  inputSchema: z.object({}),
  execute: getAllCategoriesStep,
});

export const getProductDetails = tool({
  description:
    "Get full details for one product: description, price, images, tags and live stock. Accepts a product id (e.g. 'hoodie_001') or slug (e.g. 'black-pullover-hoodie'). Shown to the shopper as a rich product card.",
  inputSchema: z.object({
    product: z
      .string()
      .min(1)
      .max(100)
      .describe("Product id or slug, taken from search results."),
  }),
  execute: getProductDetailsStep,
});

export const returnOrder = tool({
  description:
    "File a return for a customer's order. Looks up the order, then starts a background process that notifies the customer, pre-authorizes the refund and files the return with the store. Only call this once the shopper has given an order number and a reason.",
  inputSchema: z.object({
    orderId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,40}$/, "Order ids are letters/numbers only")
      .describe("The order number, e.g. '11111'."),
    reason: z
      .string()
      .min(3)
      .max(500)
      .describe("The shopper's reason for the return, in their words."),
    items: z
      .array(
        z.object({
          productId: z.string().min(1).max(60),
          quantity: z.number().int().min(1).max(99),
        }),
      )
      .max(20)
      .optional()
      .describe(
        "Specific items to return. Omit to return the whole order.",
      ),
  }),
  execute: returnOrderStep,
});

export const shoppingTools = {
  searchProducts,
  getAllCategories,
  getProductDetails,
  returnOrder,
};

export type ShoppingTools = typeof shoppingTools;
