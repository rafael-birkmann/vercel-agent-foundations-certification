"use client";

import type { InferUITools, UIMessage, UIToolInvocation } from "ai";
import {
  BookmarkCheck,
  CheckCircle2,
  Loader2,
  Terminal,
  XCircle,
} from "lucide-react";
import {
  Tool,
  ToolContent,
  ToolHeader,
} from "@/components/ai-elements/tool";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AdminTools } from "@/lib/admin-tools";
import { ToolNotice } from "./chat-common";

export type AdminUIMessage = UIMessage<unknown, never, InferUITools<AdminTools>>;

type Inv<K extends keyof AdminTools> = UIToolInvocation<AdminTools[K]>;

const TITLES: Record<string, string> = {
  getSupportTickets: "Support tickets",
  getReturnsHistory: "Returns history",
  getInventoryStock: "Inventory levels",
  getSalesAnalytics: "Sales analytics",
  searchProducts: "Catalog search",
  getAllCategories: "Categories",
};

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatRange(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const { from, to } = meta as { from?: string; to?: string };
  if (!from || !to) return null;
  return `${dateFmt.format(new Date(from))} – ${dateFmt.format(new Date(to))}`;
}

function filtersSummary(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([k, v]) => v !== undefined && v !== null && k !== "from" && k !== "to",
  );
  if (entries.length === 0) return null;
  return entries
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join(" · ");
}

/** Compact preview table for the first rows of a back-office result. */
function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;
  const columns = Object.keys(rows[0])
    .filter((c) => {
      const v = rows[0][c];
      return v === null || ["string", "number", "boolean"].includes(typeof v);
    })
    .slice(0, 6);
  const shown = rows.slice(0, 8);
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Preview of fetched rows</caption>
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} className="border-t">
              {columns.map((c) => (
                <td key={c} className="max-w-48 truncate whitespace-nowrap px-2 py-1">
                  {row[c] === null || row[c] === undefined ? "—" : String(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <p className="border-t px-2 py-1 text-xs text-muted-foreground">
          Showing {shown.length} of {rows.length} preview rows.
        </p>
      )}
    </div>
  );
}

type DataPart =
  | Inv<"getSupportTickets">
  | Inv<"getReturnsHistory">
  | Inv<"getInventoryStock">
  | Inv<"getSalesAnalytics">
  | Inv<"searchProducts">
  | Inv<"getAllCategories">;

/** Back-office and catalog lookups: collapsible card with a short summary. */
export function DataToolPart({
  name,
  type,
  part,
}: {
  name: string;
  type: `tool-${string}`;
  part: DataPart;
}) {
  const title = TITLES[name] ?? name;
  const running =
    part.state === "input-streaming" || part.state === "input-available";

  let summary: React.ReactNode = null;
  let body: React.ReactNode = null;

  if (running) {
    summary = <Shimmer>{`Fetching ${title.toLowerCase()}…`}</Shimmer>;
  } else if (part.state === "output-error") {
    summary = <span className="text-destructive">Lookup failed after retrying.</span>;
    body = <p className="text-xs text-destructive">{part.errorText}</p>;
  } else if (part.state === "output-available") {
    const out = part.output as Record<string, unknown> & { ok: boolean };
    if (!out.ok) {
      summary = <span className="text-muted-foreground">{String(out.message)}</span>;
    } else if ("rowCount" in out) {
      const range = formatRange(out.meta);
      summary = (
        <span>
          {String(out.rowCount)} rows{range ? ` · ${range}` : ""}
        </span>
      );
      const file = out.sandboxFile as { path: string | null; error: string | null };
      body = (
        <>
          <PreviewTable rows={out.rows as Record<string, unknown>[]} />
          {file?.path && (
            <p className="text-xs text-muted-foreground">
              Full dataset saved to sandbox: <code>{file.path}</code>
            </p>
          )}
          {file?.error && <p className="text-xs text-destructive">{file.error}</p>}
        </>
      );
    } else if ("products" in out) {
      const products = out.products as { name: string; priceFormatted: string }[];
      summary = <span>{products.length} products</span>;
      body = (
        <p className="text-xs text-muted-foreground">
          {products.map((p) => `${p.name} (${p.priceFormatted})`).join(", ") || "No matches."}
        </p>
      );
    } else if ("categories" in out) {
      const cats = out.categories as { name: string; productCount: number }[];
      summary = <span>{cats.length} categories</span>;
      body = (
        <p className="text-xs text-muted-foreground">
          {cats.map((c) => `${c.name} (${c.productCount})`).join(", ")}
        </p>
      );
    }
  }

  const filters = filtersSummary(part.input);

  return (
    <Tool className="mb-0 bg-card">
      <ToolHeader title={title} type={type as never} state={part.state} />
      <div className="px-3 pb-2 text-xs text-muted-foreground" aria-live="polite">
        {summary}
      </div>
      <ToolContent className="space-y-2 border-t px-3 py-2">
        {filters && <p className="text-xs text-muted-foreground">Filters: {filters}</p>}
        {body}
      </ToolContent>
    </Tool>
  );
}

/** Sandbox command: terminal-style block with running / success / failure states. */
export function BashPart({ part }: { part: Inv<"bash"> }) {
  const command = part.input?.command ?? "";
  const running =
    part.state === "input-streaming" || part.state === "input-available";
  const result = part.state === "output-available" ? part.output : null;
  const failed =
    part.state === "output-error" || (result !== null && result.exitCode !== 0);

  return (
    <section
      aria-label="Sandbox command"
      className={cn(
        "overflow-hidden rounded-md border bg-zinc-950 text-zinc-100",
        failed && "border-destructive/60",
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs">
        <span className="flex items-center gap-1.5 text-zinc-300">
          <Terminal className="size-3.5" aria-hidden="true" />
          Sandbox computation
        </span>
        <span aria-live="polite" className="flex items-center gap-1">
          {running && (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Running…
            </>
          )}
          {result && !failed && (
            <>
              <CheckCircle2 className="size-3.5 text-emerald-400" aria-hidden="true" />
              Exit 0 · {(result.durationMs / 1000).toFixed(1)}s
            </>
          )}
          {failed && (
            <>
              <XCircle className="size-3.5 text-red-400" aria-hidden="true" />
              {result ? `Failed · exit ${result.exitCode}` : "Sandbox error"}
            </>
          )}
        </span>
      </header>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-zinc-300">
        <span className="select-none text-zinc-500">$ </span>
        {command}
      </pre>
      {result && (result.stdout || result.stderr) && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-zinc-800 px-3 py-2 font-mono text-xs">
          {result.stdout}
          {result.stderr && <span className="text-red-300">{result.stderr}</span>}
        </pre>
      )}
      {part.state === "output-error" && (
        <p className="border-t border-zinc-800 px-3 py-2 font-mono text-xs text-red-300">
          {part.errorText}
        </p>
      )}
    </section>
  );
}

export function SaveMemoryPart({ part }: { part: Inv<"saveMemory"> }) {
  if (part.state === "input-streaming" || part.state === "input-available") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        <Shimmer>Saving to memory…</Shimmer>
      </p>
    );
  }
  if (part.state === "output-error") {
    return <ToolNotice title="Couldn't save to memory">{part.errorText}</ToolNotice>;
  }
  if (part.state !== "output-available") return null;
  if (!part.output.ok) {
    return <ToolNotice title="Not saved to memory">{part.output.message}</ToolNotice>;
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
      <BookmarkCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        <Badge variant="secondary" className="mr-1.5 font-normal">
          Saved to memory
        </Badge>
        {part.input.note}
      </span>
    </div>
  );
}
