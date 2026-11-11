/**
 * Server-only helpers shared by the shopping and admin tool sets.
 *
 * Error policy for tools that run as workflow steps:
 * - Expected, deterministic failures (404 not found, 400/422 validation)
 *   are returned as `{ ok: false, ... }` values so the model can explain
 *   them — retrying would not change the outcome.
 * - Transient failures (network errors, 5xx, 429) are re-thrown so the
 *   workflow step retries them. If every retry fails, WorkflowAgent hands
 *   the error text to the model as a tool error, and the UI renders the
 *   failed state instead of inventing a successful result.
 */
import { ApiRequestError } from "./api";
import { ADMIN_PASSWORD } from "./admin-auth";
import type { ToolFailure } from "./agent-types";

const SECRET_VALUES = (): string[] =>
  [process.env.BYPASS_SECRET, ADMIN_PASSWORD, process.env.VERCEL_OIDC_TOKEN]
    .filter((v): v is string => typeof v === "string" && v.length >= 6);

/** Strip any configured secret value from a string before it leaves the server. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of SECRET_VALUES()) {
    out = out.split(secret).join("[redacted]");
  }
  return out.replace(
    /x-vercel-protection-bypass=[^&\s"']+/gi,
    "x-vercel-protection-bypass=[redacted]",
  );
}

/** True when the text contains a configured secret (used to refuse saving it). */
export function containsSecret(text: string): boolean {
  return SECRET_VALUES().some((secret) => text.includes(secret));
}

/**
 * Map an error from the store API into a tool failure value, or re-throw it
 * when it is transient so the surrounding step is retried.
 */
export function apiFailureOrThrow(
  error: unknown,
  context: { notFound: string },
): ToolFailure {
  if (error instanceof ApiRequestError) {
    if (error.status === 404) {
      return { ok: false, code: "not_found", message: context.notFound };
    }
    if (error.status === 400 || error.status === 422) {
      return {
        ok: false,
        code: "invalid_input",
        message: redactSecrets(
          `The store rejected the request: ${error.message}`,
        ),
      };
    }
    // 0 (network), 429 and 5xx fall through to a retryable throw.
    throw new Error(
      redactSecrets(
        `Store API temporarily unavailable (${error.status || "network error"}): ${error.message}`,
      ),
    );
  }
  throw new Error(
    redactSecrets(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
}

/** Truncate long text (stdout, notes) so tool outputs stay small. */
export function truncate(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`,
    truncated: true,
  };
}

/** `jane.doe@example.com` -> `j*******@example.com` */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "the email on file";
  return `${user[0]}${"*".repeat(Math.max(user.length - 1, 3))}@${domain}`;
}
