# Open Glean, your second brain on Hydra DB

Open Glean is the AI workspace over [Hydra DB](https://hydradb.com). Ask a question
across your memories, files, and connected apps. Open Glean retrieves the context,
writes the answer, and cites its sources.

This is the open-source code for Open Glean. The Next.js server proxies requests to
the official [`@hydradb/sdk`](https://www.npmjs.com/package/@hydradb/sdk). Keys
are held in an encrypted, httpOnly session cookie and used server-side, never in
the browser. You can also run it yourself with your own Hydra DB key.

![Open Glean](public/static/images/logos/hydradb-white.png)

## Features

- **Ask**: one composer. Each question retrieves context from your Hydra
  database and streams an answer with inline citations, a sources panel, and
  optional web search (OpenRouter's web plugin).
- **Deep Research**: for questions one query cannot answer. Open Glean plans a DAG
  of sub-questions, runs each level against Hydra in parallel, writes a finding
  per branch, dedupes sources into one numbered citation list, then writes the
  answer. A timeline shows the plan and live progress.
- **Scope switching**: pick the database and collections a query searches, from
  the top bar. Retrieval fans out across every selected collection.
- **Context**: your memories, files, saved webpages, and connector-synced
  knowledge, in one place.
- **Collections**: scope a query to one collection (sub-tenant), or open a
  single collection to search within it.
- **Mindmap**: the knowledge graph Hydra builds from your context.
- **Integrations**: connect Hydra's connectors, verify credentials, discover
  resources, and start syncing, without leaving the app.
- **Bring your own model**: any OpenAI-compatible endpoint. A searchable
  OpenRouter model picker with favourites is built in.

## Getting started

```bash
npm ci
npm run dev
```

Copy `.env.example` to `.env.local` and set at least `OPEN_GLEAN_SESSION_SECRET`.
Everything else is optional. Without a Hydra key, the app shows a connect screen
and asks for one.

Open http://localhost:3000, then:

1. **Connect**: paste your Hydra DB API key (create one at
   [app.hydradb.com/keys](https://app.hydradb.com)) and pick a database.
2. **Add a model**: in Settings, paste an OpenRouter (or other OpenAI-compatible)
   key and pick a model. It only writes answers; search works without it.
3. **Ask away**, or add context first from the Context page (files, notes, URLs).

## Running with Docker

```bash
docker build -t open-glean .
docker run -p 3000:3000 \
  -e OPEN_GLEAN_SESSION_SECRET=your-random-16-char-secret \
  -e HYDRA_API_KEY=your-hydra-key \
  -e OPENROUTER_API_KEY=your-openrouter-key \
  -e OPEN_GLEAN_LLM_MODEL=google/gemini-3.7-flash \
  -e MONGODB_URI=mongodb://your-mongo-host:27017 \
  open-glean
```

The image uses Next.js standalone output, so it ships only the runtime files
and the dependencies the build uses. It runs as a non-root user.

## How it works

```
Browser ──► Next.js proxy (/api/hydra/*) ──► @hydradb/sdk ──► api.hydradb.com
        └─► /api/llm/chat (streaming + web plugin) ─► your LLM provider
```

- All Hydra calls go through the typed SDK, which handles auth, retries, and
  envelope parsing.
- Conversations persist to MongoDB when reachable (see env), with a localStorage
  fallback. Non-secret settings stay in the browser.
- Web search is served by your LLM provider's web plugin (OpenRouter). Its
  citations appear alongside the Hydra sources.

## Environment & key security

API keys are **not stored in the browser**. When you connect in Settings, the
key is verified server-side and stored in an AES-256-GCM-encrypted, httpOnly
session cookie; every proxied request resolves it on the server. Nothing
key-shaped is inlined into the JS bundle, localStorage, or any client state.

A stored key is also **pinned to the endpoint it was stored with**. A request
may only choose the LLM base URL when it supplies its own API key. Otherwise a
caller could pair an attacker-controlled URL with the server's key and have it
sent there in an `Authorization` header.

| Variable | Purpose |
| --- | --- |
| `OPEN_GLEAN_SESSION_SECRET` | **Required in production.** Any random 16+ char string. Encrypts the key session cookie. |
| `HYDRA_API_KEY` | Optional deployment-level shared key: when set, no user key is needed at all |
| `HYDRA_BASE_URL` | Optional default backend URL (defaults to https://api.hydradb.com) |
| `HYDRA_DEFAULT_DATABASE` | Optional default tenant. Requests with no explicit database scope to this one. |
| `MONGODB_URI` | Chat persistence. A MongoDB connection string, or a bare DocumentDB cluster endpoint (auto-detected via `.docdb.*.amazonaws.com`). |
| `MONGODB_DB` | Database name for chats (defaults to `open_glean`). |
| `OPENROUTER_API_KEY` | Optional server-level LLM key. When set, users need not enter their own. |
| `OPEN_GLEAN_LLM_MODEL` | Default answer model id, e.g. `openai/gpt-4o-mini`. No built-in default. Without it (or a per-user model), answers are unavailable. |
| `OPEN_GLEAN_LLM_BASE_URL` | Optional OpenAI-compatible endpoint for the server-level key (defaults to OpenRouter) |
| `OPEN_GLEAN_ALLOW_PRIVATE_LLM_URL` | Allow an LLM base URL on a private or loopback address, for a local model such as Ollama or LM Studio. Off by default. It permits plaintext `http:` on a private address only. A public host still requires `https:`, and non-http schemes are rejected. |
| `MONGODB_PROXY_KEY` | Shared secret for the Lambda proxy. The Lambda reads the same value as `PROXY_KEY`; the two names must match. |
| `OPEN_GLEAN_MAX_CONCURRENT_RESEARCH` | Concurrent Deep Research runs per instance (default 3). Each run costs many LLM and retrieval calls |

> **DocumentDB does not support IAM database authentication.** The IAM token
> path in the code cannot authenticate against Amazon DocumentDB. `AWS_REGION`,
> `AWS_IAM_USER_ARN` and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are read
> by that path and are listed here only to describe what it expects. For
> DocumentDB, use a standard MongoDB connection string or the Lambda proxy.

## Stack

Next.js 16, React 19, Tailwind CSS v4, and `@hydradb/sdk`. No other runtime
dependency for data or AI.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Read NOTICE: connector logos are third-party trademarks and are not covered by
the Apache grant.