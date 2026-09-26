# MCP SDK v2 Migration Research

**Date:** 2026-09-27
**Scope:** Upgrade path from `@modelcontextprotocol/sdk` v1 to the v2 package line
(`@modelcontextprotocol/server` / `@modelcontextprotocol/node`) and the MCP spec
revision `2026-07-28`, plus a general toolchain freshness review
(VS Code, code-server, TypeScript, ESLint, vsce).

**Method:** desk research (official spec/SDK docs, npm registry, GitHub releases)
plus an **empirical spike** — a runnable port of `src/mcpServer.ts` onto v2,
validated end-to-end with the official v2 client. Spike artifacts live in
[`docs/research/spike/`](./spike/) (see [Appendix A](#appendix-a-spike-artifacts)).

---

## 1. Executive summary

| Question | Answer |
|---|---|
| Is the spec current? | **2026-07-28** is the current MCP revision (RC 2026-05-21, final 2026-07-28). `2025-11-25` is now *Final*. Deprecation policy guarantees ≥12 months for anything phased out. |
| Is TS SDK v2 stable? | **Yes.** v2.0.0 shipped 2026-07-27 alongside the spec; **v2.1.0 (2026-09-23)** is the current stable line and passes the official conformance suite. Maintainers still describe it as "settling" (temporary PR throttling, a handful of open minor bugs) — stable, but early-stable. |
| Is v1 dead? | No. v1 (`@modelcontextprotocol/sdk`, latest **1.30.1**) receives bug fixes + security updates **≥6 months after v2's release** → support horizon ≈ **2027-01-27**. But v1 tops out at protocol `2025-11-25`; the new revision is v2-only. |
| Migration effort for *this* repo? | **Small–medium** (~half a day incl. tests). The spike proved the target shape: delete the session map, swap ~40 lines of transport wiring for `createMcpHandler` + `toNodeHandler`, keep all 18 tools and their exact behavior. |
| Recommended? | **Yes — adopt v2, but on a schedule, not this week.** Plan Phase 1 for Q4 2026, **complete before ≈2027-01-27** (v1 security horizon). Stay on v1 in the meantime; it is fully functional and covered. |
| Most efficient shape? | **Option B** (§4): v2 `createMcpHandler` in default **stateless** mode (serves *both* eras from one endpoint), **low-level `setRequestHandler`** with the existing raw JSON-Schema `TOOLS` array (no zod rewrite), existing `node:http` server + `/health` + localhost guards. |

**Spike result: 16/16 checks passed** — legacy handshake, modern-era connection,
tool dispatch, error shapes, Accept negotiation (SSE / 406), and security guards all verified
against real v2.1.0 packages (§5).

---

## 2. Where this project stands today

| Aspect | Current state |
|---|---|
| MCP SDK | `@modelcontextprotocol/sdk@^1.30.0` (v1 line; resolved 1.30.x) |
| Wire protocol | `2025-11-25` (README claims it explicitly) |
| Transport | Hand-rolled `node:http` server, `StreamableHTTPServerTransport`, **sessionful** (`sessionIdGenerator: randomUUID`, `Map<string, transport>`), `enableJsonResponse: true` (plain JSON) |
| Endpoints | `POST/GET/DELETE /mcp` (+ legacy alias `/sse`), `GET /health`, custom 404 hint JSON |
| Tool registration | Low-level `setRequestHandler(ListToolsRequestSchema / CallToolRequestSchema, …)` + hand-written raw JSON-Schema `TOOLS` array (18 tools); **no zod dependency**; handlers do their own lenient arg extraction (`str()`/`num()` helpers) and return `isError` content on failures |
| Security posture | Bound to `127.0.0.1`; `Access-Control-Allow-Origin: *`; no host/origin validation (loopback binding is the only boundary; residual DNS-rebinding exposure) |
| Build | esbuild `--format=cjs --platform=node`, `tsc` for type-check (TS 5.9.3, `module/moduleResolution: Node16`), eslint 10 + typescript-eslint 8 |
| Engines | `vscode: ^1.120.0`, `node: >=20` |
| Tests | `npm run smoke` — 13 checks over raw HTTP against a stubbed `JupyterApi` (baseline **13/13 PASS** on 2026-09-27) |
| Bundle | `mcpServer` bundle ≈ 636 KB unminified / **≈ 300 KB minified** (v1) |

Key observation: **the server holds no per-session state.** All notebook state lives
in `JupyterApi` (the extension). The session map exists only to route follow-up
requests to the same `Server` instance — pure transport plumbing. This is exactly
what v2's stateless serving replaces.

---

## 3. Protocol & SDK landscape (as of 2026-09-27)

### 3.1 Spec timeline

| Revision | Status | Headline changes |
|---|---|---|
| 2025-11-25 | Final (previous) | OIDC discovery, icons metadata, sampling tool-calling, experimental Tasks, JSON Schema 2025-12 dialect default |
| **2026-07-28** | **Current** | Stateless core, per-request version declaration, `server/discover` (no `initialize` in the modern era), `_meta` envelope per request, Multi Round-Trip Requests (SEP-2322), MCP Apps, Tasks moved to extension `io.modelcontextprotocol/tasks` (SEP-2663), extensions framework, auth hardening, formal ≥12-month deprecation policy |

Publication is not a switch-off: 2025-11-25 servers keep working; anything
deprecated stays in the spec for at least 12 months.

### 3.2 TypeScript SDK

| | v1 (current here) | v2 (target) |
|---|---|---|
| Package | `@modelcontextprotocol/sdk` (monolith) | `@modelcontextprotocol/server` + `@modelcontextprotocol/node` (+ `/client`, `/express`, `/hono`, `/fastify`, `/codemod`, `/server-legacy`) |
| Latest | **1.30.1** (2026-09-23) | **2.1.0** (2026-09-23); 2.0.0 stable since 2026-07-27 |
| Protocol ceiling | `2025-11-25` (`LATEST_PROTOCOL_VERSION` — bumping v1 alone cannot speak 2026-07-28) | Serves **both eras** from one entry (modern opt-in per request; legacy by default) |
| Module format | Dual | **ESM-first, CJS build ships too** — `require()` resolves natively (verified in spike) |
| Runtime | Node ≥18-ish era | Node ≥20 (ours: engines ≥20, VS Code ext host ≈ Node 22/24, code-server Node 24.x) — OK |
| Schema style | Zod shapes / raw JSON at low level | Low-level `setRequestHandler(method, …)` unchanged in spirit; high-level `registerTool` needs Standard Schema **with JSON** (zod ≥4.2) |
| Support | Bugfix + security ≥6 months after v2 release (≈**2027-01-27**) | Active line |
| Migration tooling | — | `npx @modelcontextprotocol/codemod@2.1.0 v1-to-v2 .` (import paths, symbol renames, schema→method-string handler form, package.json); manual review still required |
| HTTP entry | `StreamableHTTPServerTransport` (manual session wiring) | **`createMcpHandler(factory, opts)`** → web-standard `fetch` handler; **`toNodeHandler(handler)`** for `node:http` |

**Ecosystem reality check:** as of late Sep 2026 most of the deployed fleet is still
on the 2025 era ([upstream tracking issue, 2026-09-25](https://github.com/cesteral/mcp-open-advertising/issues/241));
v2 maintainers are temporarily limiting PRs "while v2 settles after the 2026-07-28
spec release" and a few minor `[v2]` bugs remain open. None of this blocks adoption,
but it argues for **pinning exact versions initially and letting 2.1.x patches roll
before relaxing the range**.

---

## 4. Options analysis

| Option | What | Effort | Risk | Benefit | Verdict |
|---|---|---|---|---|---|
| **A. Stay v1** (status quo + patch bumps) | Bump to 1.30.1, no code change | Trivial | Zero short-term; **support ends ≈2027-01**; permanently locked out of 2026-07-28 | Time | Acceptable **until Phase 1**; not a destination |
| **B. v2 stateless minimal** ⭐ | `@modelcontextprotocol/server` + `/node`; `createMcpHandler` (default `legacy: 'stateless'`) + `toNodeHandler`; keep low-level `setRequestHandler` + raw `TOOLS`; keep `/health`, 404 hint, loopback; add localhost host/origin guards; delete session map | **~0.5 day** (incl. smoke updates) | Low — spike proved parity; behavior deltas known (§5.3) | Both eras from one endpoint, −~70 lines of session plumbing, DNS-rebinding hardening, future-proof, curl-friendly single-message responses | **Recommended** |
| **C. v2 sessionful hybrid** | Keep v1-style sessionful legacy wiring via `isLegacyRequest` routing in front of a `legacy: 'reject'` modern handler (or `NodeStreamableHTTPServerTransport`) | 1–2 days | Medium (two serving paths to maintain) | Only needed if a critical client rejects stateless responses | Fallback if client verification fails; do **not** build by default |
| **D. v2 idiomatic rewrite** | Option B + `registerTool` with zod v4 schemas for all 18 tools + `responseMode` tuning | 2–3 days | Behavior change: SDK-level validation would replace the repo's hand-rolled "honest error" `isError` responses (e.g. missing `path` becomes a protocol-level validation error, not a content error) | Input validation, typed callbacks, idiomatic docs alignment | **Defer.** Conflicts with the documented "honest reporting" design; revisit separately if desired |

**Why B is the efficient one:** it is the *subtractive* migration — the repo's
session lifecycle code is the main thing v2 deletes, and nothing in this project's
behavior (tools, JSON content, error style) needs to change.

### 4.1 Target shape (sketch)

```ts
import * as http from 'node:http';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';

private createHandler() {
  return createMcpHandler(() => {
    const server = new Server({ name: 'jupyter-mcp-vscode', version: this.version },
                              { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));
    server.setRequestHandler('tools/call', async (req) =>
      this.handleToolCall(req.params.name, req.params.arguments));
    return server;
  }, { legacy: 'stateless' });   // default; serves 2025-era + 2026-07-28 per request
}

async start() {
  const handler = this.createHandler();
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  this.httpServer = http.createServer((req, res) => {
    // CORS headers + OPTIONS, /health, 404 hint — unchanged
    if (pathname === '/mcp' || pathname === '/sse' || pathname === '/') {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      void nodeHandler(req, res);
      return;
    }
    // …
  }).listen(this.port, '127.0.0.1');
}
```

`stop()` becomes: `await handler.close()` + close the HTTP server —
no transport iteration, no map clearing.

---

## 5. Spike: empirical validation

### 5.1 Environment

- Packages: `@modelcontextprotocol/server@2.1.0`, `@modelcontextprotocol/node@2.1.0`,
  `@modelcontextprotocol/client@2.1.0` (installed **without** `hono` — its optional
  peer was not needed for the plain-`node:http` path).
- Node v22.22.3; esbuild 0.28.2 (repo's own binary) for the bundle check.
- Port of `McpServerManager`'s wiring with a 3-tool stub, run against the same
  check style as `test/local-smoke.mjs`.

### 5.2 Results — 16/16 PASS

| # | Check | Result | Notes |
|---|---|---|---|
| 1 | `GET /health` → 200 JSON | ✅ | Custom route coexists with handler |
| 2 | Unknown path → 404 with `/mcp` hint | ✅ | Existing UX preserved |
| 3 | `initialize` @ `2025-11-25` → 200, version echoed | ✅ | `content-type: text/event-stream` by default when Accept allows SSE |
| 4 | `notifications/initialized` accepted | ✅ | 200/202 |
| 5 | `tools/list` (raw JSON-Schema `TOOLS`) | ✅ | Low-level `setRequestHandler('tools/list')` works unchanged in spirit |
| 6 | Bogus `mcp-session-id` header → still 200 | ✅ | **Delta:** v1 returned 404; stateless ignores it (lenient — good) |
| 7 | `tools/call` roundtrip | ✅ | Content shape identical |
| 8 | Missing required arg → `isError` content ("Missing path") | ✅ | **No SDK-level validation** on low-level path — repo's honest-error behavior preserved |
| 9 | Unknown tool → `isError` + "Available tools:" | ✅ | Preserved |
| 10 | `GET /mcp` → **405** | ⚠️ delta | Stateless legacy: GET/DELETE session ops are 405 (v1 sessionful offered an SSE stream on GET) |
| 11 | Forged `Host: evil.example.com` → **403** | ✅ | DNS-rebinding hardening (tested via raw HTTP — `fetch()` forbids Host overrides) |
| 12 | Guards: evil `Origin` → 403; localhost Origin → 200; **no Origin → 200** | ✅ | CLI agents (no Origin header) unaffected |
| 13 | JSON-only `Accept` → **406** "Client must accept both application/json and text/event-stream" | ⚠️ delta | Spec requirement — the earlier spike assertion was too weak (it only checked `content-type`). Compliant clients (both media types) get single-message SSE; `responseMode: 'json'` does **not** apply to the legacy leg (verified separately) |
| 14 | Official v2 `Client`, `versionNegotiation: { mode: 'auto' }` → **era = modern**, `tools/list` OK | ✅ | **2026-07-28 served from this endpoint** |
| 15 | Official v2 `Client`, default options → **era = legacy**, `tools/list` OK | ✅ | **2025-11-25 clients served from the same endpoint** |
| 16 | `initialize` offering `2026-07-28` → downgraded to `2025-11-25` | ✅ | Correct: modern era never uses `initialize`; it is advertised via `server/discover` + per-request `_meta` envelope |

### 5.3 Behavior deltas vs. current v1 implementation

| Behavior | v1 (today) | v2 stateless | Impact / action |
|---|---|---|---|
| `mcp-session-id` on initialize | Generated & required | **Absent** (stateless) | Spec-legal; update smoke assertions + README wording ("stateless; any request standalone"). Clients that *require* a session id are rare — verify in Phase 1 client matrix (§8); Option C is the fallback |
| Stale/bogus session id | 404 `Session not found` | Ignored → 200 | Smoke test #13 must be rewritten (assert lenient behavior instead) |
| `GET /mcp` | SSE stream (session-scoped) | **405** | POST-only agents unaffected; note in CHANGELOG |
| Response `content-type` | Always JSON (`enableJsonResponse: true`) | **Single-message SSE** for spec-compliant Accept (both media types); JSON-only Accept → `406`; modern leg defaults to JSON unless mid-call notifications | Both shapes are legal Streamable HTTP; smoke parses both; README curl bullet reworded |
| Session map / `onsessioninitialized` | ~70 lines | **Deleted** | Net simplification |
| Host/Origin validation | None (loopback only) | 403 on forged Host / non-local Origin | Security improvement; keep explicit CORS headers for browser clients |
| Bundle size (unminified, repo's own smoke build) | ≈ 636 KB (v1) | ≈ **838 KB** (v2) | ≈ +200 KB unminified (≈ +150–200 KB minified in the VSIX) — measured post-migration; acceptable |
| `hono` | — | Optional peer of `@modelcontextprotocol/node` | **Not required** for the plain-`node:http` path (verified: spike ran and bundled without it) |

### 5.4 Build/tooling checks

- **esbuild `--format=cjs` bundling of v2: works.** v2 ships a real CJS build
  (`require` condition → `dist/*.cjs`); bundled entry loads and constructs a handler
  under plain `require()`. No ESM migration of the extension needed.
- **`tsconfig` `module/moduleResolution: Node16`: compatible** — honors the package
  `exports` map and resolves `d.cts` types for our CJS sources. No tsconfig change
  required.
- Codemod applicability: our `setRequestHandler(ListToolsRequestSchema, …)` form maps
  directly onto the codemod's schema→method-string table; running
  `npx @modelcontextprotocol/codemod@2.1.0 v1-to-v2 .` at the package root is still
  the recommended first step (it also rewrites `package.json`), then fix any
  `@mcp-codemod-error` markers manually. Given the small surface (~6 import lines +
  2 handlers), a hand migration is equally viable.

---

## 6. Dependency freshness review

| Package | Repo (today) | Latest (2026-09-27) | Recommendation |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.30.0` | 1.30.1 | **Phase 1:** replace with `@modelcontextprotocol/server@2.1.0` + `@modelcontextprotocol/node@2.1.0` (pin exact initially; relax to `^2.1.0` after a patch cycle) |
| `typescript` | `^5.9.3` | 7.0.2 (GA 2026-07-08, Go-native) | **Stay on 5.9.3 for Phase 1.** Safe upgrade: **6.0.3** — but `typescript-eslint@8.70.1` peer range is `>=4.8.4 <6.1.0`, and **TS 7 has no programmatic API until 7.1** (plan: Beta 2026-10-06, RC 2026-11-10, stable **2026-11-24**). Revisit TS 7 after 7.1 + typescript-eslint support |
| `eslint` | `^10.9.1` | 10.11.0 | Range already covers; `npm update` at will |
| `typescript-eslint` | `^8.68.0` | 8.70.1 | Update (needed if moving to TS 6.0.x) |
| `@types/vscode` | `1.120.0` (exact pin) | 1.138.0 | **Keep 1.120.0** — matches `engines.vscode ^1.120.0` (widest reach, incl. code-server ≥4.120). Bump only when adopting new APIs, and raise `engines` in the same commit |
| `@types/node` | `^24.13.3` | 26.6.3 | Keep 24.x — types should track the runtime family we support (ext host ≈ Node 22/24). No functional impact |
| `@vscode/vsce` | `^3.9.2` | 4.0.0 | Optional Phase 2. **vsce 4 requires dev-machine Node ≥22** (sandbox/CI OK at v22.22.3 — verify release CI) |
| `esbuild` | `^0.28.2` | 0.28.2 | Already current |
| `zod` | *(not a direct dep)* | 4.6.5 | Stays transitive (bundled by `@modelcontextprotocol/server`) — add as direct dep **only** if we later adopt `registerTool` (Option D) |
| `hono` | — | 4.13.9 | Optional peer of `/node` — **not needed** for our path (spike verified) |

---

## 7. Platform constraints: VS Code & code-server

| Fact | Detail | Implication |
|---|---|---|
| VS Code stable | **1.138** (2026-09-16); ext host Node ≈ 22/24 (Electron 43 era, Node 24.20 observed on 1.139-insiders) | `engines.node >=20` and SDK v2's Node ≥20 floor are satisfied everywhere |
| `engines.vscode ^1.120.0` ↔ code-server | code-server versions track Code (`4.138.0` ↔ Code `1.138.0`, released 2026-09-19; ships **Node 24.x**) | Any code-server ≥ 4.120 runs this extension; no engines change needed |
| ESM extensions | VS Code ≥1.100 supports `"type": "module"` extensions in the Node ext host | **No action** — we bundle to CJS and v2 ships CJS; staying CJS is the lower-risk choice for Marketplace packaging |
| Endpoint topology | Server binds `127.0.0.1` on the machine running the VS Code/code-server **host** | In code-server/remote setups, an MCP client only reaches the URL if it runs **on that same host** (e.g. the code-server terminal). Browser-side or laptop-side agents need SSH port-forwarding or a future configurable bind address + auth token. Document this in README; do **not** expose the port beyond loopback without auth (the MCP endpoint has no authentication — it can drive kernels) |
| Security hardening | v2 guards (`localhostHostValidation` / `localhostOriginValidation`) reject forged Host (DNS rebinding) and non-local Origins while still allowing Origin-less CLI clients | Adopt in Phase 1 (current code relies on loopback binding alone + `ACAO: *`) |

---

## 8. Recommended phased plan

### Phase 0 — now (no code change)
1. Land this research in the repo. ✔ (this document)
2. Track the deadline: **migrate before ≈2027-01-27** (v1 security horizon).

### Phase 1 — MCP v2 migration (target: Q4 2026)
> Branch recipe: `arena/…` session branch → single PR.

1. **Deps:** remove `@modelcontextprotocol/sdk`; add
   `@modelcontextprotocol/server@2.1.0` + `@modelcontextprotocol/node@2.1.0` (exact pins).
2. **Codemod (optional but cheap):** `npx @modelcontextprotocol/codemod@2.1.0 v1-to-v2 .`
   from the package root; resolve any `@mcp-codemod-error` markers.
3. **Rewrite `McpServerManager`:**
   - Replace `createServer()`+transport wiring with `createMcpHandler(factory, { legacy: 'stateless' })` + `toNodeHandler` (§4.1).
   - Delete the `transports` map, `sessionIdGenerator`/`onsessioninitialized`, session 404 branch, `transport.onclose`, `stop()` transport loop → `handler.close()`.
   - Keep `/health`, the 404 hint, CORS headers, loopback bind.
   - Add `localhostHostValidation()` + `localhostOriginValidation()` in front of the MCP paths.
   - Keep low-level `setRequestHandler('tools/list' | 'tools/call', …)` and the raw `TOOLS` array **as-is** (Option B; do not introduce zod here).
4. **Update `test/local-smoke.mjs`:**
   - Accept stateless responses: no `mcp-session-id`; bogus-session → 200 (lenient).
   - SSE-aware body parsing for all MCP responses (or send `Accept: application/json`).
   - Keep: health, 404 hint, tools/list count (18), dispatch, `isError` shapes.
   - Add: forged-Host → 403 (raw HTTP), evil Origin → 403, and — if we add
     `@modelcontextprotocol/client` as a devDependency — the dual-era pair
     (auto → `modern`, default → `legacy`) from the spike.
5. **Docs:** README — protocol line becomes *"Streamable HTTP, spec 2026-07-28 (serves 2025-11-25 clients statelessly)"*; rewrite the session-persistence bullet as stateless tolerance; reword the plain-JSON claim (legacy responses are single-message SSE; JSON-only `Accept` → 406); document `GET /mcp → 405`; add code-server/loopback topology note (§7); CHANGELOG entry.
6. **Client verification matrix** (the only genuinely open risk — stateless responses):
   | Client | Era | Verify |
   |---|---|---|
   | curl (JSON Accept) | legacy | init/tools/list/tools/call roundtrip |
   | curl (SSE Accept) | legacy | same |
   | v2 SDK `Client` default | legacy | connect + listTools |
   | v2 SDK `Client` `mode:'auto'` | modern | connect + listTools |
   | Claude Code / Cursor / Copilot MCP client | whichever they speak | connect + one real tool call against a live notebook |
   If a production client fails **only** because it demands a session id, fall back
   to **Option C** (documented hybrid, `isLegacyRequest` + sessionful legacy leg) —
   expected to be unnecessary.
7. **Build gates:** `npm run lint && npm run compile && npm run smoke && npm run build`;
   check minified bundle size (expect ≈ +0.7 MB) and VSIX contents; package with `vsce package`.
8. Release as a minor version; monitor v2 patch releases (2.1.x) for the first cycle.

### Phase 2 — toolchain (independent, same quarter if desired)
- `typescript` → **6.0.3** + `typescript-eslint` → 8.70.1 (lint-safe ceiling today);
  `eslint` update; optional `@vscode/vsce` → 4.0.0 after CI Node ≥22 check.
- **Do not** move to TypeScript 7.x before **7.1** (stable API planned 2026-11-24)
  and explicit typescript-eslint support — lint breaks otherwise.

### Phase 3 — later (optional, benefit-driven)
- Re-evaluate `registerTool` + zod (Option D) only if we want SDK-level input
  validation — accepting the error-shape change deliberately.
- TS 7.1+/8 once typescript-eslint supports it (10× faster type-checks are real).
- Configurable bind host + token auth for remote/code-server topologies (§7).
- Re-check ecosystem era adoption (are mainstream agents speaking 2026-07-28 yet?)
  before considering `legacy: 'reject'` — **not recommended before 2027**.

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A mainstream MCP client requires session ids (breaks on stateless) | Low (stateless is spec-legal & long-supported) | High for that client | Client matrix in Phase 1 §8.6; fallback = Option C hybrid |
| v2 early-stable defect hits us | Low–medium (minor open `[v2]` bugs; PR throttling "while it settles") | Medium | Pin exact 2.1.0; follow 2.1.x patches; smoke suite covers our surface |
| Clients relying on `GET /mcp` SSE stream | Low (POST-centric agents dominate) | Low | Documented 405; sessionful fallback if ever needed |
| Legacy responses switched from always-JSON to single-message SSE (JSON-only `Accept` → 406) | Certain (post-migration) | Low | Spec-compliant clients must accept/handle SSE anyway; smoke parses both shapes; README/CHANGELOG reworded to match reality |
| Bundle +~0.7 MB minified | Certain | Low | Marketplace handles it; re-measure at Phase 1 step 7 |
| v1 support ends before we migrate | Certain ≈2027-01-27 | Medium | Hard deadline tracked in Phase 0 |
| Exposing the port beyond loopback (misconfig in remote setups) | Medium (docs gap) | **High** (unauthenticated kernel control) | README topology warning (§7); future token auth (Phase 3) |
| TS 7 / toolchain pressure during migration | Medium | Low | Phase separation: migrate SDK first on TS 5.9.3; toolchain later (§8 Phase 2) |

---

## 10. References

**Spec**
- MCP spec releases (2026-07-28 final): https://github.com/modelcontextprotocol/modelcontextprotocol/releases
- Versioning (Draft/Current/Final): https://modelcontextprotocol.io/docs/learn/versioning
- 2026-07-28 changes overview: https://stacktr.ee/blog/mcp-2026-spec-changes

**TypeScript SDK v2**
- Repo (main = v2, "v2 is the stable release line"): https://github.com/modelcontextprotocol/typescript-sdk
- Upgrade guide v1→v2: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md
- Supporting 2026-07-28: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md
- Protocol versions (eras, `server/discover`, `versionNegotiation`): https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md
- Serve over HTTP (`createMcpHandler`): https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html
- Beta announcement (split packages, wire opt-in): https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/
- Codemod: https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/codemod

**Registry (queried 2026-09-27)**
- `@modelcontextprotocol/sdk` latest 1.30.1; `@modelcontextprotocol/server|node|client` 2.1.0
- `typescript` latest 7.0.2 / 6.0.3 highest 6.0.x; `typescript-eslint` 8.70.1 peer `<6.1.0`
- `@types/vscode` 1.138.0; `eslint` 10.11.0; `@vscode/vsce` 4.0.0 (Node ≥22); `zod` 4.6.5

**Platform**
- VS Code 1.138 release notes (2026-09-16): https://code.visualstudio.com/updates/v1_138
- code-server releases (4.138.0 ↔ Code 1.138.0): https://github.com/coder/code-server/releases
- code-server Node requirement (24.x): https://coder.com/docs/code-server/npm
- TS 7 GA + no programmatic API until 7.1 (schedule): https://muhittincamdali.com/en/blog/typescript-7-go-derleyici-gecis-karari/

**Ecosystem**
- Fleet still largely on the 2025 era (2026-09-25): https://github.com/cesteral/mcp-open-advertising/issues/241

---

## Appendix A: spike artifacts

Located in [`docs/research/spike/`](./spike/) (committed to this branch):

| File | Purpose |
|---|---|
| `spike.mjs` | Full dual-era server spike (16 checks) — port of `McpServerManager` wiring onto `createMcpHandler` + `toNodeHandler` |
| `guardtest.cjs` | Standalone localhost Host/Origin guard matrix (forged Host → 403, evil Origin → 403, no Origin → 200) |

Run (Node ≥20):

```bash
cd docs/research/spike
npm init -y
npm i @modelcontextprotocol/server@2.1.0 @modelcontextprotocol/node@2.1.0 @modelcontextprotocol/client@2.1.0
node spike.mjs      # expect: ALL SPIKE CHECKS PASSED
node guardtest.cjs  # expect: forged Host 403 / evil Origin 403 / others 200
```

**Baseline captured on 2026-09-27 (pre-migration):** `npm ci && npm run smoke`
→ 13/13 PASS on `@modelcontextprotocol/sdk` v1.30.x, protocol `2025-11-25`.
