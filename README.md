# Jupyter VS Code MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-HTTP-blue)](https://modelcontextprotocol.io)

VS Code extension that exposes Jupyter notebook operations as **MCP tools over plain HTTP** — one portable URL for every AI coding agent. No absolute paths, no `node` command, no stdio wiring.

Point any MCP client at the URL, and the agent can explore, edit, run, and debug notebooks in your live editor session: it sees the same cells you see, talks to the same kernel your notebook uses (local **or remote** — Colab included), and every action lands in the real VS Code UI.

## Features

### Notebook editing with stable cell handles
- Every cell is identified by a single uniform scheme: `#NB-xxxxxxxx`, persisted in the standard nbformat 4.5 cell id. It survives edits, insert/delete of other cells, index shifts, save/reopen, extension reloads — even copying the file to another machine.
- IDs are never recycled after a delete: new cells always get fresh random IDs. `jupyter_get_summary` assigns IDs to any cell that lacks one (e.g. hand-created in the UI), so every reported handle is immediately reusable.
- Indices are **0-based everywhere** (summary, sources, run ranges, outputs) — no mixed conventions.

### Non-blocking execution control
- `jupyter_run_cells` *starts* execution and returns immediately; poll with `jupyter_wait_until_idle` or snapshot with `jupyter_get_status`. No blind sleeps, no MCP timeouts on long cells.
- Kernel-readiness guard: running against a dead/absent kernel returns actionable hints instead of wedging.
- `jupyter_interrupt_kernel` aborts the current run while keeping all variables.

### Kernel intelligence (Copilot-grade)
- `jupyter_get_variables` — type-aware variable reports: DataFrame/Series as `{shape, columns[:8], head(2)}`, ndarray as `{shape, dtype}`, containers with `length`, scalars as short reprs. Uses the official Jupyter variables view API when available, else a silent kernel probe that never touches the execution count. Optional document-symbol filtering hides internal noise only when symbols are actually available.
- `jupyter_get_pip_packages` — environment inventory (name + version) from the active kernel environment.
- `jupyter_install_packages` — pip runs **inside the kernel's own interpreter**, so packages land in the runtime the notebook actually uses — remote VMs like Colab included, never the local host. Supports version specs and `--upgrade`, verifies each spec resolves afterwards, and reports honest failures (with pip's real output tail) instead of pretending success.
- `jupyter_get_status` probes the live kernel for real Python version/platform rather than trusting stale metadata.
- `jupyter_select_kernel` opens VS Code's native kernel picker when no kernel is active.

### Network-only MCP transport
- Streamable HTTP (MCP spec **2026-07-28** for modern clients; **2025-11-25** clients are served statelessly from the same endpoint) — single-message responses, so a minimal client works with nothing but `curl` (`Accept: application/json, text/event-stream`; one `event: message` frame per response).
- Endpoints: `POST /mcp` (plus legacy `/sse`), `GET /health` for liveness + version probing. Localhost Host/Origin validation guards the MCP paths (DNS-rebinding hardening).
- Stateless serving: no session ids — unlimited concurrent agents, every request standalone, stale session headers ignored (`GET /mcp` returns `405` by design).

### Honest reporting
Errors carry context and next-step hints: missing kernel → boot guidance, stale ID → refresh via summary, failed pip install → real pip error tail, busy kernel → explicit deferral note instead of silently empty results.

## Tools

| Tool | Description |
|------|-------------|
| `jupyter_list_open_notebooks` | Open notebooks with URIs, paths, cell counts, dirty flags |
| `jupyter_get_summary` | Compact map: stable IDs, kinds, exec status, output mimes, previews |
| `jupyter_get_cell_source` | One cell's source by ID or 0-based index; line pagination |
| `jupyter_edit_cell` | Replace source; ID stays valid afterwards |
| `jupyter_insert_cell` / `jupyter_delete_cell` | Structure edits at 0-based positions; fresh non-recyclable IDs |
| `jupyter_save_notebook` | Persist `.ipynb` to disk |
| `jupyter_create_notebook` | Create empty `.ipynb` on disk + open it in the editor |
| `jupyter_run_cells` | Non-blocking start: index range `[start,end)` or ordered ID list |
| `jupyter_wait_until_idle` | Poll until idle or timeout; returns completed cells + success flags |
| `jupyter_get_status` | Instant snapshot: kernelStatus, live runtime info, running cells, dirty state |
| `jupyter_interrupt_kernel` | Abort current execution, keep variables |
| `jupyter_restart_kernel` | Full restart (clears variables) |
| `jupyter_get_outputs` | Outputs inline (short text) or artifact files under `.jupyter-mcp/artifacts/` |
| `jupyter_get_variables` | Type-aware kernel variable report |
| `jupyter_get_pip_packages` | Installed package inventory of the kernel environment |
| `jupyter_install_packages` | Kernel-side pip install with version specs + post-install verification |
| `jupyter_select_kernel` | Open the native kernel picker, report resulting state |

## Stable Cell IDs

Every cell gets a random persistent ID (`#NB-xxxxxxxx`) written to the standard nbformat 4.5 cell id field — the same slot the platform itself reads and round-trips through save/load. The ID is immune to position changes, content edits, sibling inserts/deletes, and reopen cycles. Prefer IDs over indices; call `jupyter_get_summary` to discover them (it also backfills missing IDs onto cells created outside the tools).

Bare 8-hex input (`abcd1234`) is accepted as shorthand for `#NB-abcd1234`.

## Compatible Agents

Any MCP client speaking HTTP works. Common configs:

Claude Code, Cursor, Windsurf, Cline, Copilot:

```json
{
  "mcpServers": {
    "jupyter-vscode-mcp": {
      "url": "http://localhost:9123/mcp"
    }
  }
}
```

OpenCode, Kilo Code:

```json
{
  "mcp": {
    "jupyter-vscode-mcp": {
      "type": "remote",
      "url": "http://localhost:9123/mcp",
      "enabled": true
    }
  }
}
```

Run **"Jupyter VS Code MCP: Show MCP Configuration"** from the command palette → pick your agent → snippet copied to clipboard.

## Install & Run

Download the latest `.vsix` from [Releases](https://github.com/hadiproz/jupyter-vscode-mcp/releases), then:

```bash
code --install-extension jupyter-vscode-mcp-<version>.vsix
```

1. Open any `.ipynb` — the server auto-starts on `127.0.0.1:9123` (status bar shows state; click to toggle).
2. Add the URL config above to your agent.
3. Probe liveness anytime: `curl http://localhost:9123/health`.

Settings: `jupyter-vscode-mcp.mcpPort` (default 9123, hot-applied), `jupyter-vscode-mcp.autoStart` (default true).

## Recommended Workflow

```
jupyter_list_open_notebooks   → pick notebook
jupyter_get_summary           → stable #NB-* IDs, exec state        (0-based)
jupyter_get_cell_source       → read only what you need
jupyter_edit_cell             → IDs stay valid after edits
jupyter_run_cells             → starts async, returns immediately
jupyter_wait_until_idle       → blocks until done (or poll get_status)
jupyter_get_outputs           → inline short text, artifact files for big/binary
jupyter_get_variables         → inspect kernel state after runs
```

## Architecture

```
AI agent ──HTTP/JSON-RPC──▶ VS Code extension (in-process http server :9123)
                                 │ vscode.* APIs + ms-toolsai.jupyter public API
                                 ▼
                     notebook cells, outputs, kernel status
```

Kernel interactions use the documented `ms-toolsai.jupyter` public API (`kernel.executeCode`, interrupt/restart commands, variables/pip listing commands) with command fallbacks; execution tracking relies on `workspace.onDidChangeNotebookDocument`.

## Development

```bash
npm install
npm run compile      # typecheck
npm run lint
npm run build        # esbuild bundle
npm run smoke        # local protocol smoke test (vscode stubbed)
npx @vscode/vsce package
```

## References

- [Model Context Protocol](https://modelcontextprotocol.io) — Streamable HTTP transport, spec 2026-07-28 (2025-11-25 clients served statelessly)
- [microsoft/vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat) (MIT) — variable summarization, truncation budgets, and symbol-filtering patterns
- [SMARK OpenCode IDE Bridge](https://github.com/SMARK2022/opencode/tree/dev-smark/sdks/vscode) — kernel pre-checks via Jupyter public API, interrupt/restart command fallbacks, event-based completion tracking
- [kriss-spy/opencode-jupyter](https://github.com/kriss-spy/opencode-jupyter) — original HTTP bridge concept

## License

MIT
