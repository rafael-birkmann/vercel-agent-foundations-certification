# Ship It Shop — Store Agents

Two AI agents built on the Ship It Shop storefront (Vercel Agent Foundations Certification):

| | Shopping agent | Store admin agent |
| --- | --- | --- |
| Audience | Customers | Employees (password-protected) |
| Where | Robot icon in the storefront header (side panel) | `/admin` (password `letmeinadminagent`) |
| API | `POST /api/chat`, `GET /api/chat/[id]/stream` | `POST /api/admin/chat`, `GET /api/admin/chat/[id]/stream` |
| Workflow | `lib/workflows/chat-flow.ts` | `lib/workflows/admin-chat-flow.ts` |
| Tools | `lib/tools.ts` | `lib/admin-tools.ts` |
| Model (default) | `anthropic/claude-haiku-5.5` | `anthropic/claude-sonnet-5.5` |

Built with **AI SDK 7** (`WorkflowAgent`, `useChat`), **AI Elements**, **Workflow SDK** (durable runs), **Vercel Sandbox** and **Vercel AI Gateway**, on Next.js 16 / React 19.

## Setup

Prerequisites: Node.js 22+ (LTS), pnpm, the Vercel CLI, and a Vercel project created from the template (AI Gateway needs a team with a payment method on file).

```bash
pnpm install
vercel link                 # pick the team + project you deployed
vercel env pull .env.local  # BYPASS_SECRET, API_BASE_URL, VERCEL_OIDC_TOKEN
pnpm dev                    # http://localhost:3000
```

The OIDC token in `.env.local` expires after about 12 hours. Run `vercel env pull .env.local` again when model calls or sandbox commands start failing with auth errors.

Useful while developing:

```bash
npx workflow web               # local dashboard for workflow runs, steps, retries
npx workflow inspect runs
```

### Environment variables

All of these are server-only. None use the `NEXT_PUBLIC_` prefix except the site URL. See `.env.example`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `BYPASS_SECRET` | Yes | Store API deployment-protection bypass. Sent only from server code. Never shown to the model or the browser. |
| `API_BASE_URL` | No | Store API base URL. Defaults to `https://vercel-agentic-swag-store-api.vercel.app/api`. |
| `VERCEL_OIDC_TOKEN` | Locally | Authenticates AI Gateway and Vercel Sandbox. Pulled by `vercel env pull`. Provided automatically on Vercel. |
| `AI_GATEWAY_API_KEY` | No | Alternative AI Gateway credential (set it for Development, Preview and Production in Vercel). |
| `SHOPPING_AGENT_MODEL` / `ADMIN_AGENT_MODEL` | No | Override the AI Gateway model ids. Any model that supports tool calling works. |
| `ADMIN_SANDBOX_NAME` | No | Name of the persistent admin sandbox. Default `ship-it-shop-admin`. |
| `RETURN_FLOW_SIMULATE_FAILURE` | No | Set to `1` to make the first "file return" attempt fail, to see durable retries. |
| `NEXT_PUBLIC_SITE_URL` | No | Public URL for metadata. |

## Architecture

```
Browser (useChat + WorkflowChatTransport, AI Elements)
   │  POST /api/chat           ← full UIMessage[] for the turn
   ▼
Route handler ── validates messages against this agent's tool schemas
   │  start(workflow, [messages])  → x-workflow-run-id header
   ▼
"use workflow"  WorkflowAgent  ── each model call = step
                     │          ── each tool call  = "use step" (retried, persisted)
                     ▼
               durable run stream ──► response (and GET …/[runId]/stream on reconnect)
```

### Durability (Workflow SDK)

- **One workflow run per chat turn.** The client owns the history and sends it with each turn. `WorkflowAgent` runs every model call and every tool `execute` (`"use step"`) as a workflow step. Transient failures are retried. Completed steps are recorded in the event log and are never re-executed when a run resumes.
- **Reconnects without duplicates.** The POST response carries `x-workflow-run-id`. `WorkflowChatTransport` reconnects automatically when a stream drops, using a UI-chunk cursor. After a page refresh, the client restores the conversation from `localStorage` and resumes the stored run through `/api/chat/[runId]/stream`. That endpoint replays the durable stream; it never starts new work. While a response is streaming, the client saves only the messages up to the last user message, so the replay rebuilds the answer exactly once. Stream endpoints only serve runs of their own workflow: an admin run id returns 404 on the shopping endpoint.
- **Visible failures.** If a model call still fails after retries, an `onError` step writes an error part to the stream, so the chat shows the failure instead of ending silently. Tool failures come back to the model as tool errors, and the UI renders them in a failed state.

### Shopping agent

Tools (`lib/tools.ts`), all validated with zod:

- `searchProducts`: text and/or category search, paginated. With no query it browses the whole catalog. The category is validated against live `getCategories()` data.
- `getAllCategories`: current categories from the store API. There is no hard-coded list.
- `getProductDetails`: product by id or slug, plus a live stock lookup. If the stock lookup fails, the product still shows with "availability unknown".
- `returnOrder`: looks up the order and checks eligibility (exists, fulfilled, items belong to the order). It then **starts `returnOrderWorkflow` in the background and confirms immediately**. Starting is idempotent per order through a start-hook token (`return-order:{orderId}`): a retry or double-submit can't file a second return while one is running.

Return workflow (`lib/workflows/return-flow.ts`): `lookupOrder` → `notifyCustomer` → `preauthorize` → `fileReturn` (with a workflow webhook as the API callback) → wait for the decision callback, falling back to polling `GET /returns/{id}` → `notifyDecision`. Each side effect is its own step, so retrying a failed `fileReturn` never re-sends the notification or re-authorizes the refund. After filing, the workflow publishes the store's return id on a `progress` stream. `GET /api/returns/[runId]` reads the run (read-only, return runs only) and reports `running` → `awaiting_decision` → `completed` (with the decision and refund) or `failed`, and the return card in the chat polls it to show live status. In production the webhook callback URL is rewritten to the public production domain, because the per-deployment host is behind Vercel Authentication and the store's callback would get a 401. Deterministic errors (not found, ineligible, validation) throw `FatalError` to skip retries. To try it, use `RETURN_FLOW_SIMULATE_FAILURE=1`, then check `npx workflow inspect steps --runId <id>`.

Generative UI (`components/chat/shopping-parts.tsx`): product grids with images, formatted prices and links to `/products/[slug]`; a rich product card (image gallery, live stock badge, description, tags, add-to-cart, product page link); category chips; and a return confirmation card. Every tool shows a loading state and a friendly failure or not-found state.

Demo orders: `11111`, `22222`, `33333` are returnable; `44444` (paid) and `55555` (cancelled) are rejected.

### Store admin agent

- **Access control:** `/admin` and `/api/admin/*` are gated by `proxy.ts`, and the admin route handlers re-check the session. The session cookie path is `/`, so the cookie reaches the admin API. The admin agent has its own workflow, tools, endpoint and client storage key. None of its capabilities are reachable from the shopping agent.
- **Read-only back-office tools** (`lib/admin-tools.ts`): `getSupportTickets`, `getReturnsHistory`, `getInventoryStock` (with `allPages`), `getSalesAnalytics`, plus catalog `searchProducts` / `getAllCategories`. All starter API filters are supported. Each tool returns metadata and a capped preview to the model, and writes the **full dataset as JSON into the sandbox** (`/vercel/sandbox/data/*.json`).
- **Vercel Sandbox computation:** the `bash` tool runs `bash -lc` in one named, persistent sandbox (`lib/sandbox.ts`). Network policy is `deny-all`, and no environment variables or credentials are passed in. The image has node, python3, jq and sqlite3. The agent is told to compute every aggregate or join there, e.g. return rate per product or low-stock top sellers. The UI shows the command, a running state, stdout/stderr and the exit code (failures in red).
- **Persistent memory:** `/vercel/sandbox/memory/MEMORY.md` lives in the same persistent sandbox. At the start of each admin run, a workflow step (application code, not the model) reads the file and injects it into the system prompt. If no memory exists, the prompt says so. If the sandbox can't be read, the agent proceeds and says memory is unavailable. The agent appends entries with `saveMemory` (preference / correction / business context), which refuses notes containing configured secrets. Store numbers are always re-fetched; memory holds context only.

### Secrets

The bypass secret, admin password and OIDC token are only read in server code. Tool outputs and sandbox output pass through `redactSecrets()`. The sandbox has no credentials and no network. Both agents' instructions forbid revealing configuration.

## Project structure

```
app/api/chat/…                 shopping agent POST + stream resume
app/api/admin/chat/…           admin agent POST + stream resume (auth-checked)
lib/agent.ts                   models + instructions (admin prompt includes memory)
lib/tools.ts                   shopping tools (steps)
lib/admin-tools.ts             admin tools (steps): back office, bash, saveMemory
lib/sandbox.ts                 persistent Vercel Sandbox: memory, data files, bash
lib/chat-route.ts              shared start / resume route logic
lib/workflows/chat-flow.ts     shopping WorkflowAgent
lib/workflows/admin-chat-flow.ts  admin WorkflowAgent (loads memory first)
lib/workflows/return-flow.ts   durable return workflow
components/agent-chat.tsx      storefront chat (AI Elements)
components/admin-agent-chat.tsx admin chat (AI Elements)
components/chat/               persistent chat hook + generative UI parts
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Dev server |
| `pnpm build` | Production build (`/` static, `/products/[param]` SSG, `/search` dynamic) |
| `pnpm start` | Serve the production build |

`pnpm lint` is wired to ESLint, but ESLint isn't installed. There is no test framework.

## Deployment

Push to the Vercel-connected repository. In the Vercel project, make sure `BYPASS_SECRET` and `API_BASE_URL` are set (the Deploy button pre-fills them). AI Gateway and Sandbox authenticate with OIDC automatically. Workflows run on Vercel's managed Workflow backend with no extra configuration.
