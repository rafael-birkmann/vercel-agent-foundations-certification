"use client";

/**
 * Durable chat session for the browser.
 *
 * - The conversation (UIMessage[]) and the id of the in-flight workflow run
 *   are kept in localStorage under a per-agent key, so the shopping and admin
 *   conversations never mix.
 * - `WorkflowChatTransport` reconnects automatically when a response stream
 *   drops. After a page refresh, `resume` reconnects to the stored run via
 *   `{api}/{runId}/stream` — the server replays the durable stream instead of
 *   starting the work again.
 * - While a response is streaming we only persist messages up to the last
 *   user message. On refresh the in-progress answer is rebuilt from the
 *   replayed stream, so nothing is shown twice.
 */
import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MAX_STORED_MESSAGES = 40;

interface StoredChat<M extends UIMessage> {
  messages: M[];
  activeRunId: string | null;
}

function read<M extends UIMessage>(key: string): StoredChat<M> {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredChat<M>>;
      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        activeRunId:
          typeof parsed.activeRunId === "string" ? parsed.activeRunId : null,
      };
    }
  } catch {
    // Storage blocked or corrupt: start fresh.
  }
  return { messages: [], activeRunId: null };
}

function write<M extends UIMessage>(key: string, value: StoredChat<M>) {
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        ...value,
        messages: value.messages.slice(-MAX_STORED_MESSAGES),
      }),
    );
  } catch {
    // Quota exceeded or storage blocked: the live session still works.
  }
}

function upToLastUserMessage<M extends UIMessage>(messages: M[]): M[] {
  const idx = messages.findLastIndex((m) => m.role === "user");
  return idx === -1 ? [] : messages.slice(0, idx + 1);
}

/** Load the stored session after mount (localStorage isn't available during SSR). */
export function useStoredChat<M extends UIMessage>(storageKey: string) {
  const [session, setSession] = useState<{
    initial: StoredChat<M>;
    key: number;
  } | null>(null);

  useEffect(() => {
    setSession({ initial: read<M>(storageKey), key: 0 });
  }, [storageKey]);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {}
    setSession((s) => ({
      initial: { messages: [], activeRunId: null },
      key: (s?.key ?? 0) + 1,
    }));
  }, [storageKey]);

  return { session, reset };
}

export function usePersistentChat<M extends UIMessage>({
  storageKey,
  api,
  initial,
}: {
  storageKey: string;
  api: string;
  initial: StoredChat<M>;
}) {
  const runIdRef = useRef<string | null>(initial.activeRunId);

  const saveRunId = useCallback(
    (runId: string | null) => {
      runIdRef.current = runId;
      const current = read<M>(storageKey);
      write(storageKey, { ...current, activeRunId: runId });
    },
    [storageKey],
  );

  const transport = useMemo(
    () =>
      new WorkflowChatTransport<M>({
        api,
        onChatSendMessage: (response) => {
          const runId = response.headers.get("x-workflow-run-id");
          if (runId) saveRunId(runId);
        },
        onChatEnd: () => saveRunId(null),
        prepareReconnectToStreamRequest: ({ api: _defaultApi, ...rest }) => {
          const runId = runIdRef.current;
          if (!runId) throw new Error("No active response to reconnect to.");
          return {
            ...rest,
            api: `${api}/${encodeURIComponent(runId)}/stream`,
          };
        },
      }),
    [api, saveRunId],
  );

  const chat = useChat<M>({
    id: storageKey,
    messages: initial.messages,
    transport,
    resume: Boolean(initial.activeRunId),
    experimental_throttle: 50,
    onError: () => {
      // Don't try to resume a broken or expired run on the next load.
      saveRunId(null);
    },
  });

  const { messages, status } = chat;
  const lastSavedCount = useRef(-1);
  useEffect(() => {
    const busy = status === "submitted" || status === "streaming";
    const toSave = busy ? upToLastUserMessage(messages) : messages;
    // Avoid rewriting storage on every streamed token.
    if (busy && toSave.length === lastSavedCount.current) return;
    lastSavedCount.current = busy ? toSave.length : -1;
    write(storageKey, { messages: toSave, activeRunId: runIdRef.current });
  }, [messages, status, storageKey]);

  const stop = useCallback(() => {
    chat.stop();
    saveRunId(null);
  }, [chat, saveRunId]);

  return { ...chat, stop };
}
