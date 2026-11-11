"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { CheckCircle2, PackageCheck, ShoppingCart } from "lucide-react";
import type { InferUITools, UIMessage, UIToolInvocation } from "ai";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCart } from "@/components/cart-provider";
import { cn } from "@/lib/utils";
import type { ShoppingTools } from "@/lib/tools";
import type { ProductSummary } from "@/lib/agent-types";
import { ToolNotice, WorkingIndicator } from "./chat-common";

type Inv<K extends keyof ShoppingTools> = UIToolInvocation<ShoppingTools[K]>;

export type ShoppingUIMessage = UIMessage<
  unknown,
  never,
  InferUITools<ShoppingTools>
>;

const SERVICE_ERROR =
  "The store didn't respond in time. Ask me to try again in a moment.";

// ---------------------------------------------------------------------------
// searchProducts
// ---------------------------------------------------------------------------

function ProductTile({ product }: { product: ProductSummary }) {
  return (
    <li>
      <Link
        href={product.url}
        className="group block overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="relative aspect-square overflow-hidden bg-secondary">
          {product.image && (
            <Image
              src={product.image}
              alt=""
              fill
              sizes="(min-width: 768px) 12rem, 45vw"
              className="object-cover transition-transform duration-300 group-hover:scale-105"
            />
          )}
        </div>
        <div className="p-2.5">
          <p className="line-clamp-2 text-xs font-medium leading-snug text-foreground">
            {product.name}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {product.priceFormatted}
          </p>
        </div>
      </Link>
    </li>
  );
}

export function ProductSearchPart({ part }: { part: Inv<"searchProducts"> }) {
  const [expanded, setExpanded] = useState(false);

  if (part.state === "input-streaming" || part.state === "input-available") {
    const q = part.input?.query;
    return (
      <WorkingIndicator
        label={q ? `Searching for “${q}”…` : "Browsing the catalog…"}
      />
    );
  }
  if (part.state === "output-error") {
    return <ToolNotice title="Search failed">{SERVICE_ERROR}</ToolNotice>;
  }
  if (part.state !== "output-available") return null;

  const result = part.output;
  if (!result.ok) {
    return (
      <ToolNotice tone="info" title="Couldn't run that search">
        <p>{result.message}</p>
        {"validCategories" in result && result.validCategories && (
          <p className="mt-1">
            Categories: {result.validCategories.join(", ")}
          </p>
        )}
      </ToolNotice>
    );
  }

  const label = [
    result.query ? `“${result.query}”` : null,
    result.category ? `in ${result.category}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  if (result.products.length === 0) {
    return (
      <ToolNotice tone="info" title="No matching products">
        Nothing matched {label || "that search"}.
      </ToolNotice>
    );
  }

  const visible = expanded ? result.products : result.products.slice(0, 6);
  const searchHref = `/search?${new URLSearchParams({
    ...(result.query ? { q: result.query } : {}),
    ...(result.category ? { category: result.category } : {}),
  })}`;

  return (
    <section aria-label={`Product results ${label}`} className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {result.count} {result.count === 1 ? "product" : "products"}
        {label ? ` for ${label}` : ""}
        {result.hasMore ? " (more available)" : ""}
      </p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {visible.map((p) => (
          <ProductTile key={p.id} product={p} />
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {result.products.length > 6 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Show fewer" : `Show all ${result.products.length}`}
          </Button>
        )}
        <Button asChild variant="ghost" size="sm">
          <Link href={searchHref}>Open in search</Link>
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// getProductDetails
// ---------------------------------------------------------------------------

function StockBadge({
  stock,
  error,
}: {
  stock: { stock: number; inStock: boolean; lowStock: boolean } | null;
  error: string | null;
}) {
  if (!stock) {
    return (
      <Badge variant="outline" title={error ?? undefined}>
        Availability unknown
      </Badge>
    );
  }
  if (!stock.inStock) return <Badge variant="destructive">Out of stock</Badge>;
  if (stock.lowStock)
    return (
      <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
        Only {stock.stock} left
      </Badge>
    );
  return (
    <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
      In stock · {stock.stock} available
    </Badge>
  );
}

export function ProductDetailsPart({
  part,
}: {
  part: Inv<"getProductDetails">;
}) {
  const { addToCart } = useCart();
  const [imageIndex, setImageIndex] = useState(0);
  const [added, setAdded] = useState(false);

  if (part.state === "input-streaming" || part.state === "input-available") {
    return <WorkingIndicator label="Looking up product details…" />;
  }
  if (part.state === "output-error") {
    return (
      <ToolNotice title="Couldn't load this product">{SERVICE_ERROR}</ToolNotice>
    );
  }
  if (part.state !== "output-available") return null;

  const result = part.output;
  if (!result.ok) {
    return (
      <ToolNotice tone="info" title="Product not found">
        {result.message}
      </ToolNotice>
    );
  }

  const { product, stock } = result;
  const images = product.images.length ? product.images : [];
  const canBuy = stock ? stock.inStock : true;

  return (
    <article
      aria-label={product.name}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      {images.length > 0 && (
        <div className="relative aspect-[4/3] bg-secondary">
          <Image
            src={images[imageIndex] ?? images[0]}
            alt={product.name}
            fill
            sizes="(min-width: 768px) 26rem, 90vw"
            className="object-cover"
          />
        </div>
      )}
      {images.length > 1 && (
        <div className="flex gap-2 px-3 pt-3" role="group" aria-label="Product images">
          {images.map((src, i) => (
            <button
              key={src}
              type="button"
              onClick={() => setImageIndex(i)}
              aria-label={`Show image ${i + 1} of ${images.length}`}
              aria-pressed={i === imageIndex}
              className={cn(
                "relative size-12 overflow-hidden rounded-md border",
                i === imageIndex ? "border-foreground" : "border-border",
              )}
            >
              <Image src={src} alt="" fill sizes="48px" className="object-cover" />
            </button>
          ))}
        </div>
      )}
      <div className="space-y-3 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-snug">{product.name}</h3>
            <p className="text-xs capitalize text-muted-foreground">
              {product.category.replace(/-/g, " ")}
            </p>
          </div>
          <p className="shrink-0 text-sm font-semibold">{result.priceFormatted}</p>
        </div>
        <StockBadge stock={stock} error={result.stockError} />
        <p className="text-sm leading-relaxed text-muted-foreground">
          {product.description}
        </p>
        {product.tags.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Tags">
            {product.tags.map((tag) => (
              <li key={tag}>
                <Badge variant="secondary" className="font-normal">
                  {tag}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            disabled={!canBuy}
            onClick={() => {
              addToCart(product, 1);
              setAdded(true);
            }}
          >
            {added ? (
              <CheckCircle2 className="size-4" aria-hidden="true" />
            ) : (
              <ShoppingCart className="size-4" aria-hidden="true" />
            )}
            {canBuy ? (added ? "Added to cart" : "Add to cart") : "Out of stock"}
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={result.url}>View product page</Link>
          </Button>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// getAllCategories
// ---------------------------------------------------------------------------

export function CategoriesPart({ part }: { part: Inv<"getAllCategories"> }) {
  if (part.state === "input-streaming" || part.state === "input-available") {
    return <WorkingIndicator label="Checking categories…" />;
  }
  if (part.state === "output-error") {
    return <ToolNotice title="Couldn't load categories">{SERVICE_ERROR}</ToolNotice>;
  }
  if (part.state !== "output-available" || !part.output.ok) return null;
  return (
    <nav aria-label="Store categories">
      <ul className="flex flex-wrap gap-1.5">
        {part.output.categories.map((c) => (
          <li key={c.slug}>
            <Link
              href={`/search?category=${encodeURIComponent(c.slug)}`}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs transition-colors hover:bg-secondary"
            >
              {c.name}
              <span className="text-muted-foreground">{c.productCount}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// returnOrder
// ---------------------------------------------------------------------------

export function ReturnOrderPart({ part }: { part: Inv<"returnOrder"> }) {
  if (part.state === "input-streaming" || part.state === "input-available") {
    return (
      <WorkingIndicator
        label={
          part.input?.orderId
            ? `Filing a return for order ${part.input.orderId}…`
            : "Preparing your return…"
        }
      />
    );
  }
  if (part.state === "output-error") {
    return (
      <ToolNotice title="Return not filed">
        We couldn't reach the returns service, so nothing was filed. Please try
        again in a moment.
      </ToolNotice>
    );
  }
  if (part.state !== "output-available") return null;

  const result = part.output;
  if (!result.ok) {
    return (
      <ToolNotice
        tone={result.code === "already_in_progress" ? "info" : "error"}
        title={
          result.code === "already_in_progress"
            ? "Return already in progress"
            : "Return not filed"
        }
      >
        {result.message}
      </ToolNotice>
    );
  }

  return (
    <section
      aria-label={`Return for order ${result.orderId}`}
      className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <PackageCheck className="size-4 text-emerald-600" aria-hidden="true" />
        Return filed for order {result.orderId}
      </p>
      <ul className="space-y-0.5 text-muted-foreground">
        {result.items.map((item) => (
          <li key={item.productId}>
            {item.quantity} × {item.name ?? item.productId}
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Estimated refund</dt>
        <dd className="font-medium">{result.estimatedRefundFormatted}</dd>
        <dt className="text-muted-foreground">Confirmation to</dt>
        <dd>{result.notifyEmail}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">{result.nextSteps}</p>
    </section>
  );
}
