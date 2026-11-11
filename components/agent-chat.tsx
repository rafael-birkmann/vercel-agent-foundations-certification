"use client";

/**
 * Storefront shopping chat, connected to the shopping agent at /api/chat.
 *
 * Messages stream in from a durable workflow run; tool results render as
 * product cards (generative UI). The session survives refreshes and dropped
 * connections (see use-persistent-chat.ts).
 */
import { Bot, MessageSquarePlus } from "lucide-react";
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
  ChatComposer,
  ChatEmptyState,
  ChatErrorBanner,
  WorkingIndicator,
} from "@/components/chat/chat-common";
import {
  CategoriesPart,
  ProductDetailsPart,
  ProductSearchPart,
  ReturnOrderPart,
  type ShoppingUIMessage,
} from "@/components/chat/shopping-parts";
import {
  usePersistentChat,
  useStoredChat,
} from "@/components/chat/use-persistent-chat";

const STORAGE_KEY = "ship-it-shop:shopping-chat";
const API = "/api/chat";

const SUGGESTIONS = [
  "What hoodies do you have?",
  "Show me gifts under $30",
  "What categories do you sell?",
  "I'd like to return an order",
];

export function AgentChat() {
  const { session, reset } = useStoredChat<ShoppingUIMessage>(STORAGE_KEY);

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <WorkingIndicator label="Loading chat…" />
      </div>
    );
  }
  return (
    <ShoppingChatSession
      key={session.key}
      initial={session.initial}
      onReset={reset}
    />
  );
}

function ShoppingChatSession({
  initial,
  onReset,
}: {
  initial: { messages: ShoppingUIMessage[]; activeRunId: string | null };
  onReset: () => void;
}) {
  const { messages, sendMessage, status, stop, error, regenerate } =
    usePersistentChat<ShoppingUIMessage>({
      storageKey: STORAGE_KEY,
      api: API,
      initial,
    });

  const send = (text: string) => sendMessage({ text });
  const last = messages.at(-1);
  const awaitingFirstToken =
    status === "submitted" ||
    (status === "streaming" && last?.role === "assistant" && last.parts.length === 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {messages.length > 0 && (
        <div className="flex justify-end border-b px-2 py-1">
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
            New chat
          </Button>
        </div>
      )}

      <Conversation className="flex-1" aria-label="Shopping assistant conversation">
        <ConversationContent className="gap-6">
          {messages.length === 0 && (
            <ChatEmptyState
              icon={<Bot className="size-5" aria-hidden="true" />}
              title="Hi! I'm the Ship It Shop assistant."
              description="I can find products, explain the details, and help you return an order."
            >
              <Suggestions className="w-full">
                {SUGGESTIONS.map((s) => (
                  <Suggestion key={s} suggestion={s} onClick={send} />
                ))}
              </Suggestions>
            </ChatEmptyState>
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
                    case "tool-searchProducts":
                      return <ProductSearchPart key={key} part={part} />;
                    case "tool-getProductDetails":
                      return <ProductDetailsPart key={key} part={part} />;
                    case "tool-getAllCategories":
                      return <CategoriesPart key={key} part={part} />;
                    case "tool-returnOrder":
                      return <ReturnOrderPart key={key} part={part} />;
                    default:
                      return null;
                  }
                })}
              </MessageContent>
            </Message>
          ))}

          {awaitingFirstToken && <WorkingIndicator label="Thinking…" />}

          {status === "error" && (
            <ChatErrorBanner
              message={
                error?.message?.includes("temporarily unavailable")
                  ? error.message
                  : "The assistant couldn't respond. Please try again."
              }
              onRetry={() => regenerate()}
            />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t p-3">
        <ChatComposer
          status={status}
          onSend={send}
          onStop={stop}
          placeholder="Ask about products or returns…"
          label="Message the shopping assistant"
        />
      </div>
    </div>
  );
}
