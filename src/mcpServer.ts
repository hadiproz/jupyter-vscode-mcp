import * as http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { CallToolResultSchema } from '@modelcontextprotocol/core';
import {
  localhostHostValidation, localhostOriginValidation, NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest,
} from '@modelcontextprotocol/node';
import {
  createMcpHandler, isInitializeRequest, isJsonContentType, isLegacyRequest, McpServer,
  type McpHttpHandler, type ServerContext, type StandardSchemaWithJSON, type ToolAnnotations,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  CONTROL_HEADER, HANDOVER_PATH, LOOPBACK, SERVER_NAME, isAddressInUse, matchesControlToken,
  PortOwnershipError, removeControlFile, takeOverPort, writeControlFile,
  type ControlRecord, type OwnershipMode,
} from './clusterControl';
import type { JupyterApi } from './jupyterApi';

const NOTEBOOK_URI = { uri: z.string().optional().describe('Notebook URI/path. Defaults to the active notebook.') };
const CELL_REF = {
  id: z.string().optional().describe('Stable cell ID (e.g., #NB-xxxxxxxx).'),
  index: z.number().int().optional().describe('Zero-based cell index (fallback).'),
};
const READ_ONLY = { readOnlyHint: true };
const DESTRUCTIVE = { destructiveHint: true };
type CallToolResult = z.infer<typeof CallToolResultSchema>;

function buildServer(api: JupyterApi, version: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { capabilities: { tools: {}, logging: {} } });
  function register<Args>(
    name: string,
    description: string,
    inputSchema: StandardSchemaWithJSON<unknown, Args>,
    run: (args: Args, ctx: ServerContext) => unknown,
    hints: ToolAnnotations = {},
  ) {
    server.registerTool(name, {
      description, inputSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, ...hints },
    }, async (args, ctx): Promise<CallToolResult> => {
      try {
        const result = await run(args, ctx);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
      }
    });
  }

  register('jupyter_list_open_notebooks', 'List all currently open Jupyter notebooks in VS Code.',
    z.object({}), () => api.listOpenNotebooks(), READ_ONLY);
  register('jupyter_get_summary',
    'Compact notebook overview: path, cell count, runtime, kernel status, dirty state and cells with stable #NB-* IDs, types, execution status, output MIME types and first-line preview. Call this first to explore structure; it assigns persistent IDs to cells missing one.',
    z.object(NOTEBOOK_URI), ({ uri }) => api.getNotebookSummary(uri), READ_ONLY);
  register('jupyter_get_cell_source',
    'Read one cell\'s source by stable ID (preferred) or zero-based index. Supports line pagination for large cells.',
    z.object({
      ...NOTEBOOK_URI, ...CELL_REF,
      offset: z.number().int().optional().describe('Start line (zero-based).'),
      limit: z.number().int().optional().describe('Number of lines.'),
    }), ({ uri, index, id, offset, limit }) => api.getCellSource(uri, index, id, offset, limit), READ_ONLY);
  register('jupyter_run_cells',
    'Run code cells in order, stopping on the first failure. Wait for completion with inline outputs and artifact paths, or return while a cell is still running. Use jupyter_get_status to track later completions.',
    z.object({
      ...NOTEBOOK_URI,
      start: z.number().int().optional().describe('Range start index (zero-based, inclusive).'),
      end: z.number().int().optional().describe('Exclusive range end. Defaults to start + 1.'),
      ids: z.array(z.string()).optional().describe('Stable cell IDs to execute in order, instead of a range.'),
      waitTimeoutSec: z.number().min(0).max(300).default(30).describe('Wait budget for the batch, in seconds. Set to 0 to start a background batch.'),
      includeOutputs: z.boolean().default(true).describe('Include output previews, inline text and artifact paths for completed cells.'),
    }), ({ uri, start = 0, end = start + 1, ids, waitTimeoutSec, includeOutputs }, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let completed = -1;
      let ticks = 0;
      return api.executeCells(uri, ids?.length ? { ids } : { start, end }, {
        waitTimeoutSec,
        includeOutputs,
        signal: ctx.mcpReq.signal,
        onProgress: progressToken === undefined ? undefined : (done, total, message) => {
          // MCP requires strictly increasing progress. Reserve fractional
          // steps for starts and keepalives (at most 60 ticks in 300 seconds).
          ticks = done === completed ? ticks + 1 : 0;
          completed = done;
          const progress = done + ticks / 100;
          void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress, total, message } })
            .catch(() => undefined);
        },
      });
    });
  register('jupyter_get_status',
    'Snapshot of notebook and kernel status, cached Python runtime info, running cells and recent completions with elapsed times.',
    z.object(NOTEBOOK_URI), ({ uri }) => api.getNotebookStatus(uri), READ_ONLY);
  register('jupyter_interrupt_kernel', 'Interrupt current execution while keeping kernel variables and imports.',
    z.object(NOTEBOOK_URI), ({ uri }) => api.interruptKernel(uri), DESTRUCTIVE);
  register('jupyter_edit_cell',
    'Replace a cell\'s source by stable ID or zero-based index. The cell keeps its ID across edits, insertions, deletions of other cells, and save/reopen.',
    z.object({ ...NOTEBOOK_URI, ...CELL_REF, source: z.string().min(1).describe('New source content.') }),
    ({ uri, index, id, source }) => api.editCell(uri, index, id, source));
  register('jupyter_insert_cell', 'Insert a code or markdown cell at a zero-based index with a new persistent #NB-* ID.',
    z.object({
      ...NOTEBOOK_URI, index: z.number().int().describe('Zero-based insert position.'),
      kind: z.enum(['code', 'markdown']), source: z.string().min(1), language: z.string().optional(),
    }), ({ uri, index, kind, source, language }) => api.insertCell(uri, index, kind, source, language));
  register('jupyter_delete_cell', 'Delete a cell by stable ID or zero-based index.',
    z.object({ ...NOTEBOOK_URI, ...CELL_REF }), ({ uri, index, id }) => api.deleteCell(uri, index, id), DESTRUCTIVE);
  register('jupyter_save_notebook', 'Save the notebook (.ipynb) to disk so edits and outputs persist.',
    z.object(NOTEBOOK_URI), ({ uri }) => api.saveNotebook(uri));
  register('jupyter_create_notebook',
    'Create a new empty .ipynb on disk and open it in VS Code. Relative paths resolve against the first workspace folder.',
    z.object({
      path: z.string().min(1).describe('Target .ipynb path or file:// URI.'),
      kernelName: z.string().optional().describe('Kernelspec name (default python3).'),
      kernelDisplayName: z.string().optional().describe('Friendly kernel display name.'),
      language: z.string().optional().describe('Kernel language (default python).'),
      openInEditor: z.boolean().default(true).describe('Reveal the notebook in the editor.'),
    }), ({ path, ...options }) => api.createNotebook(path, options));
  register('jupyter_get_outputs', 'Retrieve current cell outputs: short text inline and artifact paths for large or binary data.',
    z.object({ ...NOTEBOOK_URI, ...CELL_REF }), ({ uri, index, id }) => api.getOutputs(uri, index, id), READ_ONLY);
  register('jupyter_get_variables',
    'Type-aware kernel variable summaries: DataFrame/Series/ndarray shapes and previews, container lengths and scalar reprs. Uses a silent probe or the Jupyter variable view without changing the execution count.',
    z.object(NOTEBOOK_URI), ({ uri }) => api.getVariables(uri), READ_ONLY);
  register('jupyter_get_pip_packages', 'List Python packages installed in the active kernel environment (name and version).',
    z.object(NOTEBOOK_URI), ({ uri }) => api.getPipPackages(uri), READ_ONLY);
  register('jupyter_install_packages',
    'Install Python packages in the active kernel interpreter, including remote runtimes, and verify the resolved versions. Budget up to 180 seconds.',
    z.object({
      ...NOTEBOOK_URI,
      packages: z.array(z.string()).min(1).max(30).describe('Package specs such as pandas or requests==2.32.0.'),
      upgrade: z.boolean().default(false).describe('Pass --upgrade to pip.'),
    }), ({ uri, packages, upgrade }) => api.installPackages(uri, packages, upgrade), { openWorldHint: true });
  register('jupyter_select_kernel', 'Open the VS Code kernel picker for the user and report the resulting kernel status and language.',
    z.object(NOTEBOOK_URI), ({ uri }) => api.selectKernel(uri));
  register('jupyter_restart_kernel', 'Restart the kernel, clearing all variables and imports.',
    z.object(NOTEBOOK_URI), ({ uri }) => api.restartKernel(uri), DESTRUCTIVE);

  return server;
}

const MCP_PATHS = new Set(['/', '/mcp', '/sse']);
const MAX_SESSIONS = 32;
const SESSION_IDLE_MS = 30 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 1500;
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

interface LegacySession {
  transport: NodeStreamableHTTPServerTransport;
  openResponses: number;
  lastActive: number;
}

interface Listener {
  http: http.Server;
  modern: McpHttpHandler;
  modernNode: ReturnType<typeof toNodeHandler>;
  sessions: Map<string, LegacySession>;
  control?: ControlRecord;
  reaper?: NodeJS.Timeout;
  accepting: boolean;
}

interface ManagerOptions {
  ownershipMode?: OwnershipMode;
  workspaceFolders?: () => readonly string[];
  onYield?: () => void;
}

function writeJson(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string) {
  writeJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

export class McpServerManager {
  private listener?: Listener;
  private queue = Promise.resolve();
  private ownershipMode: OwnershipMode;
  private hasYielded = false;

  constructor(
    private readonly jupyterApi: JupyterApi,
    private port: number,
    private readonly version = '0.0.0',
    private readonly options: ManagerOptions = {},
  ) {
    this.ownershipMode = options.ownershipMode ?? 'handover';
  }

  get listeningPort(): number {
    return this.listener?.control?.port ?? this.port;
  }

  get endpoint(): string {
    return `http://${LOOPBACK}:${this.listeningPort}/mcp`;
  }

  get running(): boolean {
    return this.listener?.accepting === true;
  }

  get yielded(): boolean {
    return this.hasYielded;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  start(mode?: OwnershipMode): Promise<void> {
    return this.enqueue(() => this.startListening(mode ?? this.ownershipMode));
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.listener) await this.closeListener(this.listener);
      this.hasYielded = false;
    });
  }

  configure(port: number, mode: OwnershipMode): Promise<void> {
    return this.enqueue(async () => {
      this.ownershipMode = mode;
      if (port === this.port) return;
      this.port = port;
      if (this.listener) {
        await this.closeListener(this.listener);
        await this.startListening(mode);
      }
    });
  }

  private async startListening(mode: OwnershipMode): Promise<void> {
    if (this.listener) return;
    if (mode === 'hub') throw new Error('MCP ownership mode "hub" is unavailable in this release. Select "handover" or "fail" in Settings.');

    const modern = createMcpHandler(() => buildServer(this.jupyterApi, this.version), { legacy: 'reject', responseMode: 'auto' });
    const listener: Listener = {
      http: http.createServer({ requestTimeout: 0, headersTimeout: 10_000 }),
      modern, modernNode: toNodeHandler(modern), sessions: new Map(), accepting: false,
    };
    listener.http.on('request', (req, res) => {
      void this.route(listener, req, res).catch((error) => {
        if (res.destroyed) return;
        if (res.headersSent) res.destroy();
        else rpcError(res, 500, -32603, 'Internal server error');
        console.error('Jupyter MCP request failed:', error);
      });
    });

    const bind = () => new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => {
        listener.http.off('listening', onListening);
        listener.http.off('error', onError);
        reject(error);
      };
      const onListening = () => {
        listener.http.off('error', onError);
        resolve();
      };
      listener.http.once('error', onError);
      listener.http.once('listening', onListening);
      try {
        listener.http.listen(this.port, LOOPBACK);
      } catch (error) {
        onError(error);
      }
    });

    try {
      await bind().catch(async (error: unknown) => {
        if (!isAddressInUse(error)) throw error;
        if (mode === 'fail') throw new PortOwnershipError(this.port, 'Ownership mode "fail" leaves the current owner in place.');
        await takeOverPort(this.port, bind);
      });

      const address = listener.http.address();
      if (address === null || typeof address === 'string') throw new Error('Missing MCP TCP listener address.');
      const control: ControlRecord = {
        pid: process.pid, instanceId: randomUUID(), port: address.port, token: randomBytes(32).toString('hex'),
        workspaceFolders: this.options.workspaceFolders?.() ?? [], startedAt: Date.now(),
      };
      await writeControlFile(control);
      listener.control = control;
      listener.reaper = setInterval(() => {
        const cutoff = Date.now() - SESSION_IDLE_MS;
        for (const session of listener.sessions.values()) {
          if (session.openResponses === 0 && session.lastActive < cutoff) {
            void session.transport.close().catch(console.error);
          }
        }
      }, 60_000).unref();
      listener.accepting = true;
      this.listener = listener;
      this.hasYielded = false;
    } catch (error) {
      await this.closeListener(listener);
      throw error;
    }
  }

  private async closeListener(listener: Listener): Promise<void> {
    listener.accepting = false;
    clearInterval(listener.reaper);
    const transports = [listener.modern, ...Array.from(listener.sessions.values(), ({ transport }) => transport)];
    listener.sessions.clear();

    if (listener.control) {
      await removeControlFile(listener.control.port).catch((error) => console.error('Jupyter MCP control file cleanup failed:', error));
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); });
    try {
      await Promise.race([Promise.allSettled(transports.map((transport) => transport.close())), deadline]);
      const closed = new Promise<void>((resolve) => {
        listener.http.close(() => resolve());
        listener.http.closeIdleConnections?.();
        listener.http.closeAllConnections?.();
      });
      await Promise.race([closed, deadline]);
    } finally {
      clearTimeout(timer);
      if (this.listener === listener) this.listener = undefined;
    }
  }

  private handover(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse, control: ControlRecord) {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (!matchesControlToken(req.headers[CONTROL_HEADER], control.token)) {
      writeJson(res, 403, { error: 'Invalid MCP control token' });
      return;
    }
    const acknowledged = new Promise<void>((resolve) => {
      res.once('finish', resolve);
      res.once('close', resolve);
      res.writeHead(202, { Connection: 'close' }).end();
    });
    void this.enqueue(async () => {
      if (this.listener !== listener) return;
      await acknowledged;
      this.jupyterApi.clearAllState();
      await this.closeListener(listener);
      this.hasYielded = true;
      this.options.onYield?.();
    }).catch((error) => console.error('Jupyter MCP handover failed:', error));
  }

  private async route(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse) {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const control = listener.control;
    if (!listener.accepting || !control) {
      writeJson(res, 503, { error: 'Jupyter MCP is starting or shutting down.' });
      return;
    }
    const pathname = new URL(req.url ?? '/', `http://${LOOPBACK}`).pathname;
    if (pathname === HANDOVER_PATH) {
      this.handover(listener, req, res, control);
      return;
    }

    if (req.headers.origin) {
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-Id');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(200).end();
      return;
    }
    if (pathname === '/health') {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      writeJson(res, 200, {
        status: 'ok', server: SERVER_NAME, version: this.version, protocolEras: ['2026-07-28', '2025-11-25'],
        instanceId: control.instanceId, workspaceFolders: this.options.workspaceFolders?.() ?? control.workspaceFolders,
        endpoints: ['/mcp'],
      });
      return;
    }
    if (!MCP_PATHS.has(pathname)) {
      writeJson(res, 404, { error: `Unknown path ${pathname}. Use /mcp. Health probe: GET /health.` });
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      await this.handleLegacy(listener, req, res);
    } else if (req.method === 'POST') {
      if (!isJsonContentType(req.headers['content-type'] ?? null)) {
        rpcError(res, 415, -32000, 'Content-Type must be application/json');
        return;
      }

      let request: Request;
      let body: unknown;
      try {
        // Keep the socket writable for the 413 response if the SDK stops
        // reading a chunked upload at its 4 MiB limit.
        request = await toWebRequest({
          method: req.method, url: req.url, headers: req.headers,
          [Symbol.asyncIterator]: () => req.iterator({ destroyOnReturn: false }),
        });
        body = await request.json();
      } catch (error) {
        if (error instanceof Error && error.name === 'RequestBodyTooLargeError') {
          res.setHeader('Connection', 'close');
          rpcError(res, 413, -32000, error.message);
        } else if (!res.destroyed) {
          rpcError(res, 400, -32700, 'Parse error: expected a JSON request body');
        }
        return;
      }

      const legacy = await isLegacyRequest(request, body);
      if (!listener.accepting || res.destroyed) return;
      if (legacy) await this.handleLegacy(listener, req, res, body);
      else await listener.modernNode(req, res, body);
    } else {
      res.writeHead(405, { Allow: 'GET, POST, OPTIONS, DELETE' }).end();
    }
  }

  private async handleLegacy(listener: Listener, req: http.IncomingMessage, res: http.ServerResponse, body?: unknown) {
    const sid = req.headers['mcp-session-id'];
    if (sid !== undefined) {
      const session = typeof sid === 'string' ? listener.sessions.get(sid) : undefined;
      if (!session?.transport.sessionId) {
        rpcError(res, 404, -32001, 'Session not found');
        return;
      }
      await this.serveLegacy(session, req, res, body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      return;
    }
    if (listener.sessions.size >= MAX_SESSIONS) {
      rpcError(res, 503, -32000, 'Too many open MCP sessions');
      return;
    }

    const id = randomUUID();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => id, enableJsonResponse: true });
    const session = { transport, openResponses: 0, lastActive: Date.now() };
    // Reserve capacity before the first await so simultaneous initializations
    // cannot exceed the cap. The SDK chains this hook when it connects.
    listener.sessions.set(id, session);
    transport.onclose = () => { listener.sessions.delete(id); };
    try {
      await buildServer(this.jupyterApi, this.version).connect(transport);
      if (listener.accepting && !res.destroyed) await this.serveLegacy(session, req, res, body);
    } finally {
      if (!transport.sessionId) await transport.close();
    }
  }

  private async serveLegacy(session: LegacySession, req: http.IncomingMessage, res: http.ServerResponse, body: unknown) {
    session.openResponses++;
    res.once('close', () => {
      session.openResponses--;
      session.lastActive = Date.now();
    });
    await session.transport.handleRequest(req, res, body);
  }
}
