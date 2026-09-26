# Changelog

## 1.1.0 — MCP SDK v2 (spec 2026-07-28)

Migrated the embedded MCP server from the v1 SDK (`@modelcontextprotocol/sdk`) to the **v2 package line** (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`, pinned at 2.1.0) and the current protocol revision.

### Changed

- **Dual-era serving**: modern **2026-07-28** clients are served per request; **2025-11-25** clients keep working, statelessly, from the same endpoint (both eras verified against the official v2 client in the smoke suite).
- **Stateless transport**: the session map is gone — no `mcp-session-id` is issued, stale/bogus session headers are ignored, `GET /mcp` returns `405` (session-scoped SSE streams removed), and every request stands alone (port-hot-restart tolerance is now structural).
- **Response shape (legacy clients)**: single-message **SSE** (`event: message` / `data: …`) instead of always-plain JSON. Per the Streamable HTTP spec a POST client must accept both `application/json` and `text/event-stream` — JSON-only `Accept` gets `406` with an actionable error. Responses remain single-frame and curl-friendly.
- **Security hardening**: localhost **Host/Origin validation** now fronts the MCP paths (rejects forged `Host` / non-local `Origin` with `403`, DNS-rebinding protection). Requests without an `Origin` header (curl, CLI agents) are unaffected.

### Added

- `docs/research/` — deep research on the v2 migration path plus a reproducible dual-era spike (`docs/research/spike/`).

### Requirements

- Unchanged: VS Code ^1.120.0, Node >= 20 (v2 SDK floor is Node 20).

## 1.0.0 — Initial public release

First public release of **Jupyter VS Code MCP** — an HTTP MCP server that exposes Jupyter notebook operations in VS Code to any MCP-compatible AI agent.

### Highlights

- **Network-only transport**: Streamable HTTP (MCP spec 2025-11-25) served in-process by the extension at `127.0.0.1:9123` (`/mcp`, legacy `/sse`, `GET /health`). Plain-JSON responses — no stdio, no absolute paths, minimal clients work with `curl`. Multiple concurrent agent sessions supported.
- **18 tools** covering notebook discovery, cell reading/editing/insertion/deletion, execution, output retrieval, kernel status/interrupt/restart, variable inspection, and pip package management.
- **Stable cell IDs**: every cell gets a persistent `#NB-xxxxxxxx` ID stored in the standard nbformat 4.5 `id` field — survives edits, index shifts, sibling insert/delete, save/reload. IDs are never recycled; bare 8-hex shorthand accepted.
- **Non-blocking execution**: `jupyter_run_cells` starts asynchronously and returns immediately; poll with `jupyter_wait_until_idle` or `jupyter_get_status`.
- **Kernel intelligence**: type-aware variable reports (DataFrame/Series/ndarray-aware), live kernel probing for real Python version/platform, native kernel picker integration.
- **Kernel-side package management**: `jupyter_install_packages` runs pip inside the kernel's own interpreter — including remote runtimes such as Colab VMs — with version specs, `--upgrade`, and post-install verification with honest failure reporting.
- **Honest errors**: actionable hints for missing kernels, stale IDs, busy kernels, and failed installs (real pip error tail).

### Requirements

- VS Code ^1.120.0 with the `ms-toolsai.jupyter` extension
- Node.js >= 20 (for building from source)
