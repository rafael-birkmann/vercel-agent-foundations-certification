"use client";

/**
 * Store admin chat, connected to the admin agent at /api/admin/chat.
 *
 * Separate storage key, endpoint, workflow and tool set from the shopping
 * chat. Shows back-office lookups, sandbox commands and memory saves inline.
 */
import { MessageSquarePlus, ShieldCheck } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Button } from "@/components/ui/button";
import {
  BashPart,
  DataToolPart,
  SaveMemoryPart,
  type AdminUIMessage,
} from "@/components/chat/admin-parts";
import {
  ChatComposer,
  ChatEmptyState,
  ChatErrorBanner,
  WorkingIndicator,
} from "@/components/chat/chat-common";
import {
  usePersistentChat,
  useStoredChat,
} from "@/components/chat/use-persistent-chat";

const STORAGE_KEY = "ship-it-shop:admin-chat";
const API = "/api/admin/chat";

const SUGGESTIONS = [
  "Which products had the highest return rate in the last 30 days?",
  "Which low-stock items are also top sellers?",
  "Summarize this week's revenue",
  "Show open urgent support tickets",
  "What were yesterday's top sellers?",
];

export function AdminAgentChat() {
  const { session, reset } = useStoredChat<AdminUIMessage>(STORAGE_KEY);
  if (!session) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <WorkingIndicator label="Loading chat…" />
      </div>
    );
  }
  return (
    <AdminChatSession key={session.key} initial={session.initial} onReset={reset} />
  );
}

function AdminChatSession({
  initial,
  onReset,
}: {
  initial: { messages: AdminUIMessage[]; activeRunId: string | null };
  onReset: () => void;
}) {
  const { messages, sendMessage, status, stop, error, regenerate } =
    usePersistentChat<AdminUIMessage>({ storageKey: STORAGE_KEY, api: API, initial });

  const send = (text: string) => sendMessage({ text });
  const last = messages.at(-1);
  const awaitingFirstToken =
    status === "submitted" ||
    (status === "streaming" && last?.role === "assistant" && last.parts.length === 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <p className="text-xs text-muted-foreground">Read-only access · computations run in Vercel Sandbox</p>
        {messages.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              stop();
              onReset();
            }}
          >
            <MessageSquarePlus className="size-4" aria-hidden="true" />
            New conversation
          </Button>
        )}
      </div>

      <Conversation className="flex-1" aria-label="Admin agent conversation">
        <ConversationContent className="gap-6">
          {messages.length === 0 && (
            <ChatEmptyState
              icon={<ShieldCheck className="size-5" aria-hidden="true" />}
              title="Store operations assistant"
              description="Ask about support tickets, returns, inventory and sales. Tell me your preferences and I'll remember them for next time."
            />
          )}

          {messages.map((message) => (
            <Message key={message.id} from={message.role}>
              <MessageContent className="w-full group-[.is-user]:w-fit">
                {message.parts.map((part, i) => {
                  const key = `${message.id}-${i}`;
                  switch (part.type) {
                    case "text":
                      return message.role === "user" ? (
                        <p key={key} className="whitespace-pre-wrap">
                          {part.text}
                        </p>
                      ) : (
                        <MessageResponse key={key}>{part.text}</MessageResponse>
                      );
                    case "tool-bash":
                      return <BashPart key={key} part={part} />;
                    case "tool-saveMemory":
                      return <SaveMemoryPart key={key} part={part} />;
                    case "tool-getSupportTickets":
                    case "tool-getReturnsHistory":
                    case "tool-getInventoryStock":
                    case "tool-getSalesAnalytics":
                    case "tool-searchProducts":
                    case "tool-getAllCategories":
                      return (
                        <DataToolPart
                          key={key}
                          name={part.type.slice(5)}
                          type={part.type}
                          part={part}
                        />
                      );
                    default:
                      return null;
                  }
                })}
              </MessageContent>
            </Message>
          ))}

          {awaitingFirstToken && <WorkingIndicator label="Investigating…" />}

          {status === "error" && (
            <ChatErrorBanner
              message={error?.message || "The admin agent couldn't respond."}
              onRetry={() => regenerate()}
            />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="flex flex-col gap-3 border-t p-3">
        {messages.length === 0 && (
          <Suggestions>
            {SUGGESTIONS.map((s) => (
              <Suggestion key={s} suggestion={s} onClick={send} />
            ))}
          </Suggestions>
        )}
        <ChatComposer
          status={status}
          onSend={send}
          onStop={stop}
          placeholder="Ask the admin agent…"
          label="Message the admin agent"
        />
      </div>
    </div>
  );
}
