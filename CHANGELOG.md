# Changelog

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
