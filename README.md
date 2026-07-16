# md-log-mcp

[![npm version](https://img.shields.io/npm/v/md-log-mcp)](https://www.npmjs.com/package/md-log-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-com.md--log%2Fmd--log--mcp-1f6feb)](https://registry.modelcontextprotocol.io/v0/servers?search=md-log)
[![License: MIT](https://img.shields.io/npm/l/md-log-mcp)](./LICENSE)
[![Node](https://img.shields.io/node/v/md-log-mcp)](https://nodejs.org)

> **Review the report, not the diff.** An MCP server that lets your AI coding agent — **Claude Code, Claude Desktop, Codex, Cursor** — save its work and analysis as immutable, versioned **Markdown reports** into [**md-log**](https://md-log.com), a human-in-the-loop review & archive layer for **"vibe coding."** You then read and **stylus-annotate** (S-Pen / Apple Pencil) those reports on web, phone, and tablet — every save a new immutable version.

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that lets **Claude Code**
(and other agents) save `.md` files — text **and** embedded screenshots together — straight into
**md-log**, a human-in-the-loop review & archive layer for vibe coding. The agent writes a report
**by path** (`my-project/2026-07-07-error-report.md`); missing folders are auto-created, images are
uploaded and their references rewritten to `asset://` links, and every save becomes an immutable new
version. The same report is then readable, editable, and stylus-annotatable (S-Pen / Apple Pencil
where supported) on a phone or tablet, and on the web.

md-log is a **hosted service** at **https://app.md-log.com** — you don't run any server yourself.
This package is just the connector: a **thin authenticated HTTP client** that validates POSIX paths,
orchestrates asset uploads, maps errors to stable agent codes, and forwards everything to the hosted
md-log service — the single authority for auth, storage, versioning and quota. All you need is a
Personal Access Token from the web app.

## Stack

- **@modelcontextprotocol/sdk** (TypeScript) — one `McpServer` (15 tools), two transports.
- **stdio transport** (`md-log-mcp`) — JSON-RPC over stdin/stdout; the default local mode (so stdout
  is reserved for the protocol; logs go to stderr). PAT from env.
- **Streamable HTTP transport** (`md-log-mcp-http`) — the remote mode: agents connect by URL with no
  local install; the PAT is taken **per request** from the `Authorization` header. See
  [Remote (Streamable HTTP) mode](#remote-streamable-http-mode).
- **TypeScript**, bundled with **tsup** to ESM `dist/server.js` (stdio) + `dist/http.js` (HTTP).
  Runtime deps: the MCP SDK and **zod** (input schemas). Node's built-in `fetch`/`http` are the only
  network layers — no web framework.
- **PAT auth** — a md-log Personal Access Token sent to the backend as `Authorization: Bearer`.

## Requirements

- Node **22+**
- A **Personal Access Token** (PAT) minted in the md-log web app (**Settings → Tokens**; shown once)

That's it — the md-log service itself is hosted at `https://app.md-log.com`; there is nothing to
install or self-host.

## Tools (15)

Every tool returns dual output — a human-readable `content[].text` and a machine-readable
`structuredContent` — and validates the POSIX path (NFC-normalize; reject `..`/`.`, control chars,
empty/whitespace segments, backslashes, reserved names; enforce 255-byte name / 1024-byte path
limits; require `.md` for files) **before** any backend call. All requests hit the base URL in
`MDLOG_API_BASE_URL` (which already includes `/api/v1`).

| Tool | What it does |
| ---- | ------------ |
| **`save_markdown`** ⭐ | The headline tool. Create or overwrite a `.md` by path (force last-writer-wins); missing folders auto-created. Optionally uploads embedded images first (each given as `data_base64` **or** a local `file_path`) and rewrites each `placeholder` in the content to an `asset://<key>` link. Accepts `commit_message` — a recommended 1-2 line change summary shown in the version history. |
| `upload_asset` | Upload one image (reserve → presigned PUT → complete) and return an `asset://<key>` reference to embed as `![alt](asset://<key>)`. Provide the image as **either** `data_base64` (inline base64) **or** `file_path` (a local file the server reads) — exactly one; with `file_path`, `filename` defaults to the basename and `content_type` is inferred from the extension (png/jpg/jpeg/gif/webp/avif). |
| `append_to_markdown` | Append to an existing file with optimistic concurrency (GET current → concat → conditional PUT with `base_version_no`). Auto-retries once on conflict, then surfaces `CONFLICT`. Accepts `commit_message` — a recommended 1-2 line change summary shown in the version history. |
| `update_markdown` | Replace a file's content. Pass `expected_version` for optimistic concurrency (mismatch → `CONFLICT`); omit it to force LWW. Accepts `commit_message` — a recommended 1-2 line change summary shown in the version history. |
| `get_markdown` | Read a file's content by path (materializes inline content or a presigned content URL for large docs). Pass `version` (a `version_no` from `list_versions`) to read an old immutable version. |
| `list_versions` | List a file's immutable version history, newest first (`version_no`, `commit_message`, author, `registered_at`, size). |
| `delete_markdown` | Soft-delete a file. Requires `confirm:true` (otherwise `VALIDATION`); resolves the path to a document key first. |
| `create_folder` | `mkdir -p` — create every missing segment; already-existing folders count as success. |
| `list_folders` | Return the full folder tree. |
| `list_files` | List the documents and immediate subfolders inside a folder path. |
| `search_markdown` | Search by TITLE (substring) + BODY full-text (current versions; whole-word match, ranked, body hits include a snippet). |
| `move_markdown` | Move and/or rename a `.md` by path (`from_path` → `to_path`); destination folders auto-created; the document KEEPS its key, so version history and reviewers' annotations survive. |
| `move_folder` | Move a folder (whole subtree) under a new parent (`new_parent_path` empty/omitted = root); parent auto-created; cyclic moves rejected server-side. |
| `rename_folder` | Rename a folder in place (descendant paths rewritten server-side). |
| `delete_folder` | Delete a folder. Requires `confirm:true`; by default only an EMPTY folder is deleted — pass `cascade:true` to soft-delete the whole subtree (`rm -r`). |

### Error codes surfaced to the agent

Backend failures return `{ isError: true, content:[{type:"text", ...}] }` with a mapped code in
`structuredContent.error.code`:

`NOT_FOUND` · `CONFLICT` (carries the server head `{server_version_no, server_checksum, …}` in
`detail`) · `UNAUTHORIZED` · `RATE_LIMITED` · `QUOTA_EXCEEDED` · `BACKEND_UNAVAILABLE` ·
`VALIDATION` · `FOLDER_EXISTS` (swallowed as success by `create_folder`) · `ERROR`.

## Authentication

The MCP/PC lane authenticates with a **Personal Access Token** (`mdlog_pat_…`) — minted once in the
web app's **Settings** and supplied via env. The client attaches it as `Authorization: Bearer <PAT>`
(plus `X-API-Token` for compatibility) on every request. The backend is the single source of truth
for auth and quota.

| Variable | Required | Example | Notes |
| -------- | -------- | ------- | ----- |
| `MDLOG_API_BASE_URL` | yes | `https://app.md-log.com/api/v1` | The hosted service base, **including** `/api/v1`. No version suffix is appended; a trailing slash is stripped. |
| `MDLOG_PAT` | yes | `mdlog_pat_xxxxxxxxxxxxxxxxxxxxxxxx` | Bearer PAT. **Store it securely (OS keychain) — never commit it.** |

The server fails fast at startup with a clear message if either var is missing or the base URL is
malformed.

## Build

```bash
npm install
npm run build      # tsup → dist/server.js (ESM, Node 22)
npm run typecheck  # tsc --noEmit (optional)
```

## Smoke test

`scripts/smoke.mjs` spawns the **built** server over stdio (MCP SDK `Client` +
`StdioClientTransport`), then runs `initialize` → `tools/list` → `save_markdown` (a small report
embedding a tiny `data:` PNG) → `get_markdown` (reads it back, checks the marker) →
`search_markdown` — printing PASS/FAIL per step and exiting non-zero on any failure. Run it against
a **live** backend with a real PAT:

```bash
npm run build
MDLOG_API_BASE_URL="http://localhost:8080/api/v1" \
MDLOG_PAT="mdlog_pat_xxxx" \
node scripts/smoke.mjs        # or: npm run smoke
```

## MCP client config

> 📄 **연결 가이드 (HTML)** — [md-log.com/guides/customer-guide.html](https://www.md-log.com/guides/customer-guide.html): md-log 웹 앱에서 발급받은 **MCP 키(PAT)** 와 고정 서비스 주소(`https://app.md-log.com/api/v1`)만으로 `npx` 연결 (Claude Code · Desktop · Codex · Cursor). 빌드·레포 불필요.

Mint the PAT in the web app's **Settings → Tokens**, store it securely, then add the server to your
`~/.claude.json` (user-scoped) **or** a project-local `.mcp.json`. No install or build step — `npx`
fetches the published package. **Never commit a PAT.**

```jsonc
{
  "mcpServers": {
    "md-log": {
      "command": "npx",
      "args": ["-y", "md-log-mcp"],
      "env": {
        "MDLOG_API_BASE_URL": "https://app.md-log.com/api/v1",
        "MDLOG_PAT": "mdlog_pat_xxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

> **Mint & secure the PAT.** Create it in the web **Settings → Tokens** (it is shown only once) and
> keep it out of version control — prefer the OS keychain. On macOS, for example:
>
> ```bash
> security add-generic-password -a "$USER" -s md-log-pat -w "mdlog_pat_xxxx"
> export MDLOG_PAT="$(security find-generic-password -a "$USER" -s md-log-pat -w)"
> ```
>
> If a PAT leaks, revoke it in the web app and mint a new one.

## Remote (Streamable HTTP) mode

The second bin, **`md-log-mcp-http`**, serves the **same 15 tools** over MCP's
[Streamable HTTP transport](https://modelcontextprotocol.io/docs/concepts/transports) — a single
`POST /mcp` endpoint — so agents connect by **URL with no local install**. Use it when you want to
host the connector centrally (a container / small VM behind a TLS reverse proxy) instead of every
user running `npx`.

How it differs from stdio:

- **PAT per request.** The token is **not** read from env; each request carries its own
  `Authorization: Bearer <mdlog_pat_…>` header, so **one endpoint serves many users** — each with
  their own md-log token. (`MDLOG_PAT` is ignored in this mode.)
- **Stateless.** A fresh client + server per request; no session store (replica / autoscale friendly).
- **No local files.** The `file_path` image source is **refused** (it would read the *server's* disk);
  send images inline as `data_base64`. Everything else is identical.

### Run it

```bash
npm run build
MDLOG_API_BASE_URL="https://app.md-log.com/api/v1" \
node dist/http.js            # or: npm run start:http
# → md-log-mcp-http ready — POST http://127.0.0.1:8787/mcp
```

### Configuration (env)

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `MDLOG_API_BASE_URL` | yes | — | Hosted md-log base, **including** `/api/v1`. |
| `MDLOG_HTTP_HOST` | no | `127.0.0.1` | Bind interface. Localhost-only by default; set `0.0.0.0` **only** behind a TLS reverse proxy. |
| `MDLOG_HTTP_PORT` | no | `8787` | TCP port. |
| `MDLOG_HTTP_PATH` | no | `/mcp` | The MCP endpoint path. |
| `MDLOG_HTTP_ALLOWED_ORIGINS` | no | *(none)* | Comma-separated browser `Origin` allowlist (DNS-rebinding defense). A request that **carries** an `Origin` not on the list is `403`d; non-browser clients (no `Origin`) are always allowed. |
| `MDLOG_HTTP_ALLOWED_HOSTS` | no | *(none)* | Optional comma-separated `Host` allowlist (extra DNS-rebinding defense). |
| `MDLOG_HTTP_MAX_BODY_BYTES` | no | `33554432` (32 MiB) | Max request body (base64 images inflate ~33%). |

**Security posture** (per the MCP spec): binds to `127.0.0.1` by default, requires a Bearer token on
every MCP request, validates `Origin` against the allowlist to defeat DNS-rebinding, and caps the body
size. A `GET /health` liveness probe (no auth) returns `{"status":"ok"}`. `GET`/`DELETE` on the MCP
endpoint return `405` (stateless: no standalone SSE stream, no session to terminate).

### Connect an agent by URL

```jsonc
{
  "mcpServers": {
    "md-log": {
      "type": "http",
      "url": "https://your-host.example/mcp",
      "headers": { "Authorization": "Bearer mdlog_pat_xxxxxxxxxxxxxxxxxxxxxxxx" }
    }
  }
}
```

> Client config shape varies (Claude Code / Cursor / etc.) — the essentials are the endpoint **URL**
> and an `Authorization: Bearer <PAT>` header. Always terminate TLS in front of a public deployment;
> the PAT rides on every request.

## Scripts

- `npm run build` — bundle to `dist/server.js` (stdio) + `dist/http.js` (Streamable HTTP) (tsup, ESM, Node 22).
- `npm run dev` — rebuild on change (`tsup --watch`).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run smoke` — stdio smoke test against a live backend (needs env + a build).
- `npm run smoke:http` — **backend-free** HTTP-transport smoke test (handshake + auth/origin/file_path guards).
- `npm start` — run the built stdio server (`node dist/server.js`).
- `npm run start:http` — run the built HTTP server (`node dist/http.js`).
