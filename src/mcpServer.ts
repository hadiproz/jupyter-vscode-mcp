import * as http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { JupyterApi } from './jupyterApi';
import { randomUUID } from 'crypto';

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
}

const NOTEBOOK_URI = {
  uri: { type: 'string', description: 'Optional URI/path of the notebook. Defaults to the active one.' },
};
const CELL_REF = {
  id: { type: 'string', description: 'Stable cell ID (e.g., #NB-xxxxxxxx).' },
  index: { type: 'number', description: 'Zero-based cell index (fallback).' },
};

const TOOLS: Tool[] = [
  {
    name: 'jupyter_list_open_notebooks',
    description: 'List all currently open Jupyter notebooks in VS Code.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'jupyter_get_summary',
    description:
      'Compact notebook overview: path, cell count, runtime, kernel status, dirty state and cells with stable #NB-* IDs (persisted in the nbformat cell id), types, exec status, output mime types and first-line preview. Call this FIRST to explore structure — it also assigns IDs to any cell missing one. All indices are 0-based.',
    inputSchema: { type: 'object', properties: { ...NOTEBOOK_URI } },
  },
  {
    name: 'jupyter_get_cell_source',
    description:
      "Read one cell's source by stable ID (preferred) or 0-based index. Supports line pagination for large cells.",
    inputSchema: {
      type: 'object',
      properties: { ...CELL_REF, ...NOTEBOOK_URI, offset: { type: 'number', description: 'Start line (0-based).' }, limit: { type: 'number', description: 'Number of lines.' } },
    },
  },
  {
    name: 'jupyter_run_cells',
    description:
      'START execution of code cells (non-blocking). Targets: 0-based index range [start,end) OR list of stable IDs; runs sequentially in listed order. Returns immediately with started cells — follow with jupyter_wait_until_idle then jupyter_get_outputs.',
    inputSchema: {
      type: 'object',
      properties: {
        ...NOTEBOOK_URI,
        start: { type: 'number', description: 'Range start index (0-based, inclusive).' },
        end: { type: 'number', description: 'Range end index (exclusive).' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Stable cell IDs to execute in order.' },
      },
    },
  },
  {
    name: 'jupyter_wait_until_idle',
    description:
      'Wait until the kernel finishes all running cells (polls up to timeoutSec, default 45, cap 300). Returns idle=true with completed-cell results, or idle=false with still-running cells so you can poll again. Use after jupyter_run_cells instead of blind sleeps. Keep individual waits short (<= client MCP timeout) and re-poll rather than issuing one long wait.',
    inputSchema: {
      type: 'object',
      properties: { ...NOTEBOOK_URI, timeoutSec: { type: 'number', description: 'Max seconds to wait (default 45, cap 300).' } },
    },
  },
  {
    name: 'jupyter_get_status',
    description:
      'Instant kernel/notebook status snapshot: kernelStatus (idle/busy/starting/...), kernel language, list of currently running cells, dirty state. Cheap check before deciding to wait or interrupt.',
    inputSchema: { type: 'object', properties: { ...NOTEBOOK_URI } },
  },
  {
    name: 'jupyter_interrupt_kernel',
    description:
      'Interrupt current execution WITHOUT clearing kernel state — variables/imports survive. Use for stuck/long-running cells.',
    inputSchema: { type: 'object', properties: { ...NOTEBOOK_URI } },
  },
  {
    name: 'jupyter_edit_cell',
    description:
      "Replace a cell's source by stable ID or 0-based index. Editing assigns/keeps an ID persisted in cell metadata (#NB-*) that survives edits, insert/delete of other cells, save/reopen — reuse the same ID afterwards.",
    inputSchema: {
      type: 'object',
      properties: { ...CELL_REF, source: { type: 'string', description: 'New source content.' }, ...NOTEBOOK_URI },
      required: ['source'],
    },
  },
  {
    name: 'jupyter_insert_cell',
    description:
      'Insert a new code/markdown cell at a 0-based index. The new cell gets a persistent metadata ID (#NB-*) that cannot be recycled by later deletes.',
    inputSchema: {
      type: 'object',
      properties: {
        ...NOTEBOOK_URI,
        index: { type: 'number', description: 'Insert position (0-based).' },
        kind: { type: 'string', enum: ['code', 'markdown'] },
        source: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['index', 'kind', 'source'],
    },
  },
  {
    name: 'jupyter_delete_cell',
    description: 'Delete a cell by stable ID or 0-based index.',
    inputSchema: { type: 'object', properties: { ...CELL_REF, ...NOTEBOOK_URI } },
  },
  {
    name: 'jupyter_save_notebook',
    description: 'Save the notebook (.ipynb) to disk so edits/runs are persisted.',
    inputSchema: { type: 'object', properties: { ...NOTEBOOK_URI } },
  },
  {
    name: 'jupyter_create_notebook',
    description:
      'Create a new empty .ipynb on disk and open it in VS Code so it becomes visible to all other jupyter_* tools. Accepts an absolute path (or file:// URI); relative paths resolve against the first workspace folder.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target .ipynb path (absolute preferred).' },
        kernelName: { type: 'string', description: 'Kernelspec name for metadata (default python3).' },
        kernelDisplayName: { type: 'string', description: 'Friendly kernel display name.' },
        language: { type: 'string', description: 'Kernel language (default python).' },
        openInEditor: { type: 'boolean', description: 'Reveal the notebook in the editor (default true).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'jupyter_get_outputs',
    description:
      'Retrieve outputs of a cell. Short text is inlined; large/binary outputs saved as artifact files under .jupyter-mcp/artifacts/. Best called after jupyter_wait_until_idle.',
    inputSchema: { type: 'object', properties: { ...CELL_REF, ...NOTEBOOK_URI } },
  },
  {
    name: 'jupyter_get_variables',
    description:
      'Rich kernel variable report (Copilot-style): type-aware summaries — DataFrame/Series/ndarray as shape/dtype/columns/head, containers with length, scalars as short repr. Tries jupyter.listVariables first, falls back to a silent executeCode probe; names are filtered against cell document symbols when available. Never affects execution count.',
    inputSchema: { type: 'object', properties: { ...NOTEBOOK_URI } },
  },
  {
    name: 'jupyter_get_pip_packages',
    description:
      'List Python packages installed in the active kernel environment (name + version). Uses the Jupyter extension command when available, else an importlib.metadata probe on the kernel.',
    inputSchema: { type: 'object', properties: { ...NOTEBOOK_URI } },
  },
  {
    name: 'jupyter_install_packages',
    description:
      'Install Python packages into the ACTIVE KERNEL environment (pip runs inside the kernel interpreter, so remote runtimes like Colab are supported). Accepts version specs ("pandas", "requests==2.32.0"). Verifies resolution afterwards; budget 180s — prefer one call with all packages.',
    inputSchema: {
      type: 'object',
      properties: {
        ...NOTEBOOK_URI,
        packages: { type: 'array', items: { type: 'string' }, description: 'Package specs, max 30' },
        upgrade: { type: 'boolean', description: 'Pass --upgrade to pip (default false)' },
      },
      required: ['packages'],
    },
  },
  {
    name: 'jupyter_select_kernel',
    description:
      'Open the VS Code kernel picker for this notebook so the user can pick a kernel, then report the resulting kernel status/language. Use when get_status reports no active kernel.',
    inputSchema: { type: 'object', properties: { ...NOTEBOOK_URI } },
  },
  {
    name: 'jupyter_restart_kernel',
    description: 'Restart the kernel — clears all variables and imports.',
    inputSchema: { type: 'object', properties: { ...NOTEBOOK_URI } },
  },
];

const MCP_PATHS = new Set(['/', '/mcp', '/sse']);

export class McpServerManager {
  private httpServer?: http.Server;
  private transports = new Map<string, StreamableHTTPServerTransport>();

  constructor(
    private jupyterApi: JupyterApi,
    private port: number,
    private version = '0.0.0'
  ) {}

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  get running(): boolean {
    return !!this.httpServer;
  }

  private createServer(): Server {
    const server = new Server(
      {
        name: 'jupyter-mcp-vscode',
        version: this.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> };
      return this.handleToolCall(name, args);
    });

    return server;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;

    this.httpServer = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, mcp-protocol-version');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;

      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'jupyter-mcp-vscode', version: this.version, endpoints: ['/mcp', '/sse'] }));
        return;
      }

      if (!MCP_PATHS.has(pathname)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown path ${pathname}. Use /mcp (or legacy /sse). Health probe: GET /health.` }));
        return;
      }

      try {
        const sessionIdHeader = req.headers['mcp-session-id'];
        const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

        let transport: StreamableHTTPServerTransport;

        if (sessionId) {
          const existing = this.transports.get(sessionId);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
            return;
          }
          transport = existing;
        } else {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (id: string) => {
              this.transports.set(id, transport);
            },
          });

          const server = this.createServer();
          await server.connect(transport);

          transport.onclose = () => {
            const id = transport.sessionId;
            if (id) this.transports.delete(id);
          };
        }

        await transport.handleRequest(req, res);

        const generatedSessionId = transport.sessionId;
        if (generatedSessionId && !this.transports.has(generatedSessionId)) {
          this.transports.set(generatedSessionId, transport);
        }
      } catch (error) {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, '127.0.0.1', () => resolve());
      this.httpServer!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.close();
    }
    this.transports.clear();

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = undefined;
    }
  }

  private async handleToolCall(name: string, rawArgs: Record<string, unknown> | undefined): Promise<CallToolResult> {
    try {
      const args = rawArgs ?? {};
      const str = (key: string): string | undefined => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
      const num = (key: string): number | undefined => (typeof args[key] === 'number' ? (args[key] as number) : undefined);
      const uri = str('uri');
      const index = num('index');
      const id = str('id');
      let result: unknown;

      switch (name) {
        case 'jupyter_list_open_notebooks':
          result = this.jupyterApi.listOpenNotebooks();
          break;
        case 'jupyter_get_summary':
          result = await this.jupyterApi.getNotebookSummary(uri);
          break;
        case 'jupyter_get_cell_source':
          result = await this.jupyterApi.getCellSource(uri, index, id, num('offset'), num('limit'));
          break;
        case 'jupyter_run_cells': {
          const ids = Array.isArray(args['ids'])
            ? (args['ids'] as unknown[]).filter((v): v is string => typeof v === 'string')
            : undefined;
          const range =
            ids && ids.length > 0
              ? { ids }
              : { start: num('start') ?? 0, end: num('end') ?? (index !== undefined ? index + 1 : 1) };
          result = await this.jupyterApi.executeCells(uri, range);
          break;
        }
        case 'jupyter_wait_until_idle':
          result = await this.jupyterApi.waitUntilIdle(uri, num('timeoutSec'));
          break;
        case 'jupyter_get_status':
          result = await this.jupyterApi.getNotebookStatus(uri);
          break;
        case 'jupyter_interrupt_kernel':
          result = await this.jupyterApi.interruptKernel(uri);
          break;
        case 'jupyter_edit_cell': {
          const source = str('source');
          if (!source) throw new Error('Missing source');
          result = await this.jupyterApi.editCell(uri, index, id, source);
          break;
        }
        case 'jupyter_insert_cell': {
          const kind = str('kind');
          const source = str('source');
          if (index === undefined || (kind !== 'code' && kind !== 'markdown') || !source) {
            throw new Error('Missing index, kind, or source');
          }
          result = await this.jupyterApi.insertCell(uri, index, kind, source, str('language'));
          break;
        }
        case 'jupyter_delete_cell':
          result = await this.jupyterApi.deleteCell(uri, index, id);
          break;
        case 'jupyter_save_notebook':
          result = await this.jupyterApi.saveNotebook(uri);
          break;
        case 'jupyter_create_notebook': {
          const path = str('path');
          if (!path) throw new Error('Missing path');
          result = await this.jupyterApi.createNotebook(path, {
            kernelName: str('kernelName'),
            kernelDisplayName: str('kernelDisplayName'),
            language: str('language'),
            openInEditor: args['openInEditor'] !== false,
          });
          break;
        }
        case 'jupyter_get_outputs':
          result = await this.jupyterApi.getOutputs(uri, index, id);
          break;
        case 'jupyter_get_variables':
          result = await this.jupyterApi.getVariables(uri);
          break;
        case 'jupyter_get_pip_packages':
          result = await this.jupyterApi.getPipPackages(uri);
          break;
        case 'jupyter_select_kernel':
          result = await this.jupyterApi.selectKernel(uri);
          break;
        case 'jupyter_install_packages':
          result = await this.jupyterApi.installPackages(uri, args['packages'], args['upgrade'] === true);
          break;
        case 'jupyter_restart_kernel':
          result = await this.jupyterApi.restartKernel(uri);
          break;
        default:
          throw new Error(`Unknown tool: ${name}. Available tools: ${TOOLS.map((t) => t.name).join(', ')}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }],
        isError: true,
      };
    }
  }
}
