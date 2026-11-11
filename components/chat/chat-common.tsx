"use client";

import type { ChatStatus } from "ai";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Inline "working on it" row for a running tool or a pending response. */
export function WorkingIndicator({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <Shimmer>{label}</Shimmer>
    </div>
  );
}

/** A friendly, non-technical failure note shown in place of a tool result. */
export function ToolNotice({
  tone = "error",
  title,
  children,
}: {
  tone?: "error" | "info";
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-2 rounded-lg border p-3 text-sm",
        tone === "error"
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-muted/40",
      )}
    >
      <AlertCircle
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-foreground">{title}</p>
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

/** Banner for a failed chat request (network, server or model failure). */
export function ChatErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <ToolNotice title="Something went wrong">
      <p>{message}</p>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={onRetry}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Try again
        </Button>
      )}
    </ToolNotice>
  );
}

export function ChatComposer({
  status,
  onSend,
  onStop,
  placeholder,
  label,
}: {
  status: ChatStatus;
  onSend: (text: string) => void;
  onStop: () => void;
  placeholder: string;
  label: string;
}) {
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || busy) return;
    onSend(text);
    setInput("");
  };

  return (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputBody>
        <PromptInputTextarea
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          placeholder={placeholder}
          aria-label={label}
          maxLength={2000}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <span className="px-2 text-xs text-muted-foreground" aria-live="polite">
            {status === "submitted"
              ? "Sending…"
              : status === "streaming"
                ? "Responding…"
                : ""}
          </span>
        </PromptInputTools>
        <PromptInputSubmit
          status={status}
          onStop={onStop}
          disabled={!busy && !input.trim()}
        />
      </PromptInputFooter>
    </PromptInput>
  );
}

export function ChatEmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-2 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-secondary text-foreground">
        {icon}
      </div>
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
