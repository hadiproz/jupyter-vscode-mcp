import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createHash, randomUUID } from 'node:crypto';
import { compactCell, executionText, outputMimes, stableCellId, hasPersistentCellId, freshPersistentCellId, normalizeCellId, extensionForMime, isTextLikeMime, runtimeLabel } from './format';
import { toPosixPath, isRecord } from './util';

interface ActiveExec {
  startedAt: number;
  priorFingerprint?: string;
}

interface CellCompletion {
  id: string;
  i: number;
  success: boolean;
  exec: string;
  outs: string[];
  at: number;
  elapsedMs: number;
}

interface RuntimeInfo {
  version: string;
  platform: string;
  machine: string;
}

interface RuntimeEntry {
  kernel: JupyterKernelLike;
  probe?: Promise<RuntimeInfo | undefined>;
  subscription?: vscode.Disposable;
}

interface RunOptions {
  waitTimeoutSec?: number;
  includeOutputs?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, message: string) => void;
}

interface CellArtifact {
  output: number;
  item: number;
  mime: string;
  bytes: number;
  artifactPath: string;
  preview?: string;
  text?: string;
}

type RunCell = ReturnType<typeof compactCell> & {
  elapsedMs?: number;
  outputs?: CellArtifact[];
  artifactsRoot?: string;
  outputError?: string;
};

interface RunTarget {
  cell: vscode.NotebookCell;
  skipReason?: string;
}

function runTarget(cell: vscode.NotebookCell): RunTarget {
  if (cell.kind !== vscode.NotebookCellKind.Code) return { cell, skipReason: 'not code' };
  // Jupyter ends raw/empty cells without a successful or failed summary.
  if (cell.document.languageId === 'raw') return { cell, skipReason: 'raw cell' };
  if (cell.document.getText().trim() === '') return { cell, skipReason: 'empty cell' };
  return { cell };
}

function cellRef(cell: vscode.NotebookCell) {
  return { i: cell.index, id: stableCellId(cell) };
}

function executionElapsed(summary: vscode.NotebookCellExecutionSummary, startedAt: number, endedAt: number): number {
  return Math.max(0, summary.timing ? summary.timing.endTime - summary.timing.startTime : endedAt - startedAt);
}

function kernelError(status: string): Error {
  return new Error(`Kernel status is "${status}". Wait for a restart to finish or use jupyter_restart_kernel, then retry jupyter_run_cells.`);
}

interface KernelOutputItemLike {
  mime: string;
  data: Uint8Array;
}

export interface JupyterKernelLike {
  language?: string;
  status?: string;
  onDidChangeStatus?: vscode.Event<string>;
  executeCode?(code: string, token: vscode.CancellationToken): AsyncIterable<{ items: KernelOutputItemLike[] }>;
}

type JupyterExtensionApi = {
  kernels?: {
    getKernel?(uri: vscode.Uri): Promise<JupyterKernelLike | undefined>;
  };
};

const KERNEL_BUSY_STATES = new Set(['busy', 'starting', 'restarting', 'autorestarting']);
const KERNEL_UNAVAILABLE_STATES = new Set(['dead', 'terminating', 'restarting', 'autorestarting']);
const WAIT_EXPIRED = Symbol('cell execution wait expired');
const PROGRESS_INTERVAL_MS = 5000;

function hasKernelspecMetadata(notebook: vscode.NotebookDocument): boolean {
  const meta = notebook['metadata'] as Record<string, unknown>;
  const nested = isRecord(meta?.['metadata']) ? (meta['metadata'] as Record<string, unknown>) : {};
  return ['kernelspec', 'language_info'].some((key) => key in (meta ?? {}) || key in nested);
}

// Rich variable probe modeled on VS Code Copilot Chat's notebook variable
// summarization (microsoft/vscode-copilot-chat) and vscode-jupyter's
// KernelVariables: type-aware summaries instead of raw repr(), explicit
// truncation flags, hard char budgets so agent context never floods.
const VARIABLES_PROBE = [
  "import json as _jmcp_json, types as _jmcp_types",
  "def _jmcp_clip(_s, _n=120):",
  "    _s = _s.replace('\\n', ' ')",
  "    if len(_s) <= _n:",
  "        return _s",
  "    return _s[: _n - 3] + '...'",
  "def _jmcp_pack(_k, _v):",
  "    _d = {'name': _k, 'type': type(_v).__name__}",
  "    try:",
  "        if hasattr(_v, 'columns') and hasattr(_v, 'shape'):",
  "            _cols = [_jmcp_clip(str(c), 30) for c in list(_v.columns)[:8]]",
  "            _d['kind'] = 'dataframe'",
  "            _d['shape'] = list(_v.shape)",
  "            _d['n_columns'] = len(_v.columns)",
  "            _d['columns'] = _cols",
  "            try:",
  "                _rows = _v.head(2).values.tolist()",
  "                _d['head'] = [[_jmcp_clip(repr(c), 30) for c in row] for row in _rows]",
  "            except Exception:",
  "                pass",
  "        elif hasattr(_v, 'dtype') and hasattr(_v, 'shape'):",
  "            _d['kind'] = 'array'",
  "            _d['shape'] = list(_v.shape)",
  "            _d['dtype'] = str(_v.dtype)",
  "        elif isinstance(_v, (list, tuple, set, frozenset, dict)):",
  "            _d['length'] = len(_v)",
  "            _d['preview'] = _jmcp_clip(repr(_v))",
  "        else:",
  "            _d['preview'] = _jmcp_clip(repr(_v))",
  "    except Exception as _e:",
  "        _d['error'] = _jmcp_clip(str(_e), 60)",
  "    return _d",
  "_jmcp_out = []",
  "for _k in sorted(list(globals().keys())):",
  "    if _k.startswith('_') or _k in {'In', 'Out', 'exit', 'quit', 'get_ipython'}:",
  "        continue",
  "    try:",
  "        _v = globals()[_k]",
  "    except Exception:",
  "        continue",
  "    if isinstance(_v, _jmcp_types.ModuleType) or callable(_v):",
  "        continue",
  "    _jmcp_out.append(_jmcp_pack(_k, _v))",
  "_jmcp_text = _jmcp_json.dumps(_jmcp_out[:100], default=str)",
  "if len(_jmcp_text) > 8000:",
  "    _jmcp_text = _jmcp_text[:8000]",
  "print('JMCP_VARS:' + _jmcp_text)",
].join('\n');

const PIP_PROBE = [
  "import json as _jmcp_json",
  "try:",
  "    from importlib.metadata import distributions as _jmcp_dists",
  "    _pkgs = {}",
  "    for _dist in _jmcp_dists():",
  "        try:",
  "            _pkgs[_dist.metadata['Name']] = _dist.version",
  "        except Exception:",
  "            continue",
  "    _names = sorted(_pkgs)",
  "    print('JMCP_PIP:' + _jmcp_json.dumps({'count': len(_names), 'packages': [{'name': n, 'version': _pkgs[n]} for n in _names[:200]]}))",
  "except Exception as _e:",
  "    print('JMCP_PIP:' + _jmcp_json.dumps({'count': 0, 'packages': [], 'error': str(_e)[:120]}))",
].join('\n');

const RUNTIME_PROBE = [
  "import sys as _jmcp_sys, platform as _jmcp_platform",
  "print('JMCP_RT:%s|%s|%s' % (_jmcp_platform.python_version(), _jmcp_sys.platform, _jmcp_platform.machine()))",
].join('\n');

function buildInstallProbe(packages: string[], upgrade: boolean): string {
  const pkgJson = JSON.stringify(packages);
  return [
    "import json as _jmcp_json, sys as _jmcp_sys, subprocess as _jmcp_sp",
    "import importlib.metadata as _jmcp_im",
    `_pkgs = ${pkgJson}`,
    "_args = [_jmcp_sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check']",
    ...(upgrade ? ["_args.append('--upgrade')"] : []),
    "_args += _pkgs",
    "try:",
    "    _r = _jmcp_sp.run(_args, capture_output=True, text=True, timeout=170)",
    "    _tail = (_r.stdout[-1200:] + '\\n' + _r.stderr[-400:])[-1600:]",
    "    _code = _r.returncode",
    "except Exception as _e:",
    "    _tail, _code = str(_e)[:300], -1",
    "_resolved = {}",
    "for _spec in _pkgs:",
    "    _base = _spec",
    "    for _ch in '=<>!~':",
    "        _base = _base.split(_ch)[0]",
    "    _base = _base.strip()",
    "    try:",
    "        _resolved[_spec] = _jmcp_im.version(_base)",
    "    except Exception:",
    "        _resolved[_spec] = None",
    "print('JMCP_INSTALL:' + _jmcp_json.dumps({'exit_code': _code, 'resolved': _resolved, 'tail': _tail}))",
  ].join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class JupyterApi {
  private activeExecs = new Map<string, Map<string, ActiveExec>>();
  private completions = new Map<string, CellCompletion[]>();
  private runtimes = new Map<string, RuntimeEntry>();
  private batches = new Map<string, AbortController>();

  constructor(private context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeNotebookDocument((e) => this.onNotebookChange(e)),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        this.clearNotebookState(notebook.uri.toString(), 'Notebook was closed during cell execution.');
      }),
    );
  }

  clearAllState() {
    for (const batch of this.batches.values()) batch.abort(new Error('The Jupyter MCP window no longer owns this execution.'));
    this.batches.clear();
    this.activeExecs.clear();
    this.completions.clear();
    for (const runtime of this.runtimes.values()) runtime.subscription?.dispose();
    this.runtimes.clear();
  }

  clearStaleWorkspaceState() {
    const retained = new Set(vscode.workspace.notebookDocuments
      .filter((notebook) => vscode.workspace.getWorkspaceFolder(notebook.uri))
      .map((notebook) => notebook.uri.toString()));
    const tracked = new Set([...this.activeExecs.keys(), ...this.completions.keys(), ...this.runtimes.keys(), ...this.batches.keys()]);
    for (const key of tracked) {
      if (!retained.has(key)) this.clearNotebookState(key, 'Notebook is no longer in the workspace.');
    }
  }

  private clearNotebookState(key: string, reason: string) {
    this.batches.get(key)?.abort(new Error(reason));
    this.batches.delete(key);
    this.activeExecs.delete(key);
    this.completions.delete(key);
    this.runtimes.get(key)?.subscription?.dispose();
    this.runtimes.delete(key);
  }

  private trackExec(key: string, cellUri: string, active: ActiveExec) {
    const running = this.activeExecs.get(key) ?? new Map<string, ActiveExec>();
    running.set(cellUri, active);
    this.activeExecs.set(key, running);
  }

  private onNotebookChange(e: vscode.NotebookDocumentChangeEvent) {
    if (e.notebook.isClosed) return;
    const key = e.notebook.uri.toString();
    for (const change of e.cellChanges) {
      const summary = change.executionSummary;
      if (!summary) continue;
      const cellKey = change.cell.document.uri.toString();
      const active = this.activeExecs.get(key)?.get(cellKey);
      if (active?.priorFingerprint === JSON.stringify(summary)) continue;
      if (typeof summary.success === 'boolean') {
        this.activeExecs.get(key)?.delete(cellKey);
        const recent = this.completions.get(key) ?? [];
        const at = Date.now();
        recent.push({
          ...cellRef(change.cell),
          success: summary.success,
          exec: executionText(change.cell, summary),
          outs: outputMimes(change.cell),
          at,
          elapsedMs: executionElapsed(summary, active?.startedAt ?? at, at),
        });
        if (recent.length > 50) recent.shift();
        this.completions.set(key, recent);
      } else if (!active) {
        this.trackExec(key, cellKey, { startedAt: summary.timing?.startTime ?? Date.now() });
      }
    }
  }

  private running(notebook: vscode.NotebookDocument) {
    const tracked = this.activeExecs.get(notebook.uri.toString());
    if (!tracked?.size) return [];
    const byUri = new Map(notebook.getCells().map((c) => [c.document.uri.toString(), c] as const));
    const now = Date.now();
    const result = [];
    for (const [cellUri, info] of tracked) {
      const cell = byUri.get(cellUri);
      if (cell) result.push({ id: stableCellId(cell), index: cell.index, state: 'executing', elapsedMs: now - info.startedAt });
      else tracked.delete(cellUri);
    }
    return result.sort((a, b) => a.index - b.index);
  }

  async getKernelInfo(uri: vscode.Uri): Promise<JupyterKernelLike | undefined> {
    try {
      const ext = vscode.extensions.getExtension('ms-toolsai.jupyter');
      if (!ext) return undefined;
      if (!ext.isActive) await ext.activate();
      const api = ext.exports as JupyterExtensionApi;
      return (await api.kernels?.getKernel?.(uri)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async ensureCommand(cmd: string, guidance: string): Promise<void> {
    const available = await vscode.commands.getCommands(true);
    if (!available.includes(cmd)) {
      throw new Error(`VS Code command "${cmd}" is unavailable. ${guidance}`);
    }
  }

  getActiveNotebook(): vscode.NotebookDocument | undefined {
    return vscode.window.activeNotebookEditor?.notebook || vscode.workspace.notebookDocuments[0];
  }

  listOpenNotebooks() {
    return vscode.workspace.notebookDocuments.map((doc) => ({
      uri: doc.uri.toString(),
      fsPath: toPosixPath(doc.uri.fsPath),
      name: path.basename(doc.uri.fsPath) || 'untitled',
      cellCount: doc.cellCount,
      dirty: doc.isDirty,
    }));
  }

  getNotebookByUri(uri: string): vscode.NotebookDocument | undefined {
    const normalized = toPosixPath(uri);
    return vscode.workspace.notebookDocuments.find(
      (doc) => toPosixPath(doc.uri.fsPath) === normalized || toPosixPath(doc.uri.toString()) === normalized
    );
  }

  resolveNotebook(uri?: string): vscode.NotebookDocument {
    const notebook = uri ? this.getNotebookByUri(uri) : this.getActiveNotebook();
    if (!notebook) {
      const open = this.listOpenNotebooks().map((n) => n.fsPath).join(', ') || 'none';
      throw new Error(`No notebook found${uri ? ` matching "${uri}"` : ''}. Open notebooks: ${open}. Open a notebook in VS Code first.`);
    }
    return notebook;
  }

  resolveCell(notebook: vscode.NotebookDocument, index?: number, id?: string): vscode.NotebookCell {
    if (id) {
      const normalizedId = normalizeCellId(id);
      const cells = notebook.getCells();
      const match = cells.find((c) => stableCellId(c) === normalizedId);
      if (match) return match;
      throw new Error(
        `Cell with ID ${id} not found. IDs start with #NB-, persist in cell metadata, and survive edits/inserts/deletes; if the notebook was closed/reopened or changed on disk, refresh with jupyter_get_summary.`
      );
    }
    if (index !== undefined) {
      if (index < 0 || index >= notebook.cellCount) throw new Error(`Cell index ${index} out of bounds (0..${notebook.cellCount - 1})`);
      return notebook.cellAt(index);
    }
    throw new Error('Either index or id must be provided');
  }

  private async ensurePersistentIds(notebook: vscode.NotebookDocument): Promise<number> {
    const missing = notebook.getCells().filter((c) => !hasPersistentCellId(c));
    if (missing.length === 0) return 0;
    const edits = missing.map((c) =>
      vscode.NotebookEdit.updateCellMetadata(c.index, { id: freshPersistentCellId() })
    );
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, edits);
    await vscode.workspace.applyEdit(edit);
    return missing.length;
  }

  async getNotebookSummary(uri?: string) {
    const notebook = this.resolveNotebook(uri);
    const assigned = await this.ensurePersistentIds(notebook);
    const kernel = await this.getKernelInfo(notebook.uri);
    const metaLabel = runtimeLabel(notebook);
    const runtime = metaLabel !== 'unknown' ? metaLabel : kernel?.language ? `${kernel.language} (active kernel)` : 'unknown';
    return {
      path: toPosixPath(notebook.uri.fsPath),
      cellCount: notebook.cellCount,
      runtime,
      dirty: notebook.isDirty,
      kernelStatus: kernel?.status ?? 'unknown',
      ...(assigned > 0 ? { persistentIdsAssigned: assigned } : {}),
      cells: notebook.getCells().map(compactCell),
      metadata: notebook.metadata,
    };
  }

  async getCellSource(uri: string | undefined, index: number | undefined, id: string | undefined, offset?: number, limit?: number) {
    const notebook = this.resolveNotebook(uri);
    const cell = this.resolveCell(notebook, index, id);
    const fullText = cell.document.getText();

    if (offset !== undefined || limit !== undefined) {
      const lines = fullText.split('\n');
      const start = Math.max(0, offset ?? 0);
      const end = limit !== undefined ? start + limit : lines.length;
      return {
        ...compactCell(cell),
        source: lines.slice(start, end).join('\n'),
        totalLines: lines.length,
        offset: start,
        limit: limit ?? lines.length - start,
      };
    }

    return {
      ...compactCell(cell),
      source: fullText,
    };
  }

  async executeCells(
    uri: string | undefined,
    range: { start: number; end: number } | { ids: string[] },
    { waitTimeoutSec = 30, includeOutputs = true, onProgress, signal }: RunOptions = {},
  ) {
    signal?.throwIfAborted();
    const notebook = this.resolveNotebook(uri);
    const key = notebook.uri.toString();
    const cells = 'ids' in range
      ? range.ids.map((id) => this.resolveCell(notebook, undefined, id))
      : notebook.getCells().slice(Math.max(0, range.start), Math.max(0, range.end));
    const targets = cells.map(runTarget);
    const total = targets.filter(({ skipReason }) => skipReason === undefined).length;
    const startedAt = Date.now();

    if (this.batches.has(key)) {
      throw new Error('This notebook already has an MCP batch running. Use jupyter_get_status to check its progress.');
    }
    const batch = new AbortController();
    this.batches.set(key, batch);
    const release = () => {
      if (this.batches.get(key) === batch) this.batches.delete(key);
    };
    const request = signal ? AbortSignal.any([batch.signal, signal]) : batch.signal;
    let background = false;
    try {
      const kernel = await this.getKernelInfo(notebook.uri);
      request.throwIfAborted();
      const kernelStatus = kernel?.status ?? 'unknown';
      if (total === 0) {
        return {
          status: 'completed', durationMs: Date.now() - startedAt, kernelStatus,
          cells: targets.map(({ cell, skipReason }) => ({ ...compactCell(cell), exec: `skipped (${skipReason})` })),
        };
      }
      if (KERNEL_UNAVAILABLE_STATES.has(kernelStatus)) throw kernelError(kernelStatus);
      if (!kernel && !hasKernelspecMetadata(notebook)) {
        throw new Error('No active kernel or kernelspec metadata. Select a kernel in the VS Code notebook toolbar, then retry.');
      }
      await this.ensureCommand(
        'notebook.cell.execute',
        'Ensure the Jupyter extension (ms-toolsai.jupyter) is installed and a kernel is selected for the notebook.',
      );
      request.throwIfAborted();
      if (waitTimeoutSec === 0) {
        // The MCP exchange ends after dispatch, but the explicitly requested
        // background batch still observes cell outcomes and the notebook lifetime.
        if (!this.hasNotebookEditor(notebook)) await this.showExecutionEditor(notebook, request);
        const firstIndex = targets.findIndex(({ skipReason }) => skipReason === undefined);
        const first = targets[firstIndex]!.cell;
        this.assertDispatchable(first);
        const planned = targets.map(({ cell, skipReason }, index) => ({
          ...compactCell(cell),
          exec: skipReason ? `skipped (${skipReason})` : index === firstIndex ? 'started' : 'pending',
        }));
        onProgress?.(0, total, `Starting cell ${stableCellId(first)}`);
        request.throwIfAborted();
        const task = this.runBatch(notebook, targets, kernel, total, 0, false, batch.signal);
        background = true;
        void task.catch((error) => {
          if (!batch.signal.aborted) console.error('Jupyter MCP background execution failed:', error);
        }).finally(release);
        return { status: 'started', kernelStatus: kernel?.status ?? 'unknown', cells: planned };
      }

      return await this.runBatch(notebook, targets, kernel, total, waitTimeoutSec * 1000, includeOutputs, request, onProgress);
    } finally {
      if (!background) release();
    }
  }

  private async runBatch(
    notebook: vscode.NotebookDocument,
    targets: RunTarget[],
    kernel: JupyterKernelLike | undefined,
    total: number,
    timeoutMs: number,
    includeOutputs: boolean,
    request: AbortSignal,
    onProgress?: RunOptions['onProgress'],
  ) {
    const startedAt = Date.now();
    const deadline = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => deadline.abort(WAIT_EXPIRED), timeoutMs) : undefined;
    const signal = timer ? AbortSignal.any([request, deadline.signal]) : request;
    const results: Array<RunCell | Promise<RunCell>> = [];
    const runtime = { kernel };
    let next = 0;
    let current: (ReturnType<typeof cellRef> & { startedAt: number }) | undefined;
    let failed = false;
    let done = 0;
    try {
      for (const { cell, skipReason } of targets) {
        signal.throwIfAborted();
        if (failed || skipReason) {
          next++;
          results.push({ ...compactCell(cell), exec: `skipped (${failed ? 'previous cell failed' : skipReason})` });
          continue;
        }

        if (!this.hasNotebookEditor(notebook)) await this.showExecutionEditor(notebook, signal);
        signal.throwIfAborted();
        next++;
        current = { ...cellRef(cell), startedAt: Date.now() };
        const summary = await this.waitForCell(cell, runtime, signal, current.startedAt, onProgress && ((message) => {
          onProgress(done, total, message);
        }));
        const elapsedMs = executionElapsed(summary, current.startedAt, Date.now());
        const result: RunCell = { ...compactCell(cell), exec: executionText(cell, summary), elapsedMs };
        failed = summary.success === false;
        current = undefined;
        done++;
        results.push(includeOutputs ? this.collectCellArtifacts(notebook, cell).then(
          ({ artifactsRoot, artifacts }) => ({ ...result, artifactsRoot, outputs: artifacts }),
          (error: unknown) => ({ ...result, outputError: error instanceof Error ? error.message : String(error) }),
        ) : result);
        onProgress?.(done, total, `Cell ${result.id} ${failed ? 'failed' : 'succeeded'} (${elapsedMs} ms)`);
      }
    } catch (error) {
      if (error !== WAIT_EXPIRED) throw error;
      const now = Date.now();
      return {
        status: 'running', waitedMs: now - startedAt, kernelStatus: runtime.kernel?.status ?? 'unknown',
        completedCells: await Promise.all(results),
        runningCells: current ? [{ i: current.i, id: current.id, elapsedMs: now - current.startedAt }] : [],
        pendingCells: targets.slice(next).filter(({ skipReason }) => skipReason === undefined).map(({ cell }) => cellRef(cell)),
        hint: 'The dispatched cell can continue in the kernel. Use jupyter_get_status to check progress, jupyter_get_outputs to read outputs, or jupyter_interrupt_kernel to interrupt. Pending cells were not dispatched.',
      };
    } finally {
      clearTimeout(timer);
    }

    return {
      status: 'completed', durationMs: Date.now() - startedAt, kernelStatus: runtime.kernel?.status ?? 'unknown',
      cells: await Promise.all(results),
    };
  }

  private hasNotebookEditor(notebook: vscode.NotebookDocument): boolean {
    return vscode.window.visibleNotebookEditors.some((editor) => editor.notebook === notebook);
  }

  private async showExecutionEditor(notebook: vscode.NotebookDocument, signal: AbortSignal): Promise<void> {
    // VS Code falls back to the active editor if the URI has no editor widget.
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      await Promise.race([
        cancelled,
        Promise.resolve().then(() => vscode.window.showNotebookDocument(notebook, { preserveFocus: true })),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private assertDispatchable(cell: vscode.NotebookCell) {
    if (cell.notebook.isClosed || cell.index < 0) throw new Error('The target notebook or cell was closed or removed.');
    if (this.activeExecs.get(cell.notebook.uri.toString())?.has(cell.document.uri.toString())) {
      throw new Error(`Cell ${stableCellId(cell)} is already running.`);
    }
  }

  private async waitForCell(
    cell: vscode.NotebookCell,
    runtime: { kernel: JupyterKernelLike | undefined },
    signal: AbortSignal,
    startedAt: number,
    progress?: (message: string) => void,
  ): Promise<vscode.NotebookCellExecutionSummary> {
    this.assertDispatchable(cell);
    const notebook = cell.notebook;
    const key = notebook.uri.toString();
    const cellUri = cell.document.uri.toString();

    const priorFingerprint = JSON.stringify(cell.executionSummary) ?? 'undefined';
    const active = { startedAt, priorFingerprint };
    const id = stableCellId(cell);
    let complete!: (summary: vscode.NotebookCellExecutionSummary) => void;
    let fail!: (error: unknown) => void;
    const completion = new Promise<vscode.NotebookCellExecutionSummary>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    let kernelSubscription: vscode.Disposable | undefined;
    let checkingKernel = false;
    let disposed = false;
    const watchKernel = (kernel: JupyterKernelLike) => {
      const onStatus = (status: string) => {
        if (KERNEL_UNAVAILABLE_STATES.has(status)) {
          this.activeExecs.delete(key);
          fail(kernelError(status));
        }
      };
      kernelSubscription = kernel.onDidChangeStatus?.(onStatus);
      if (kernel.status) onStatus(kernel.status);
    };
    const changes = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook !== notebook) return;
      if (cell.index < 0) {
        this.activeExecs.get(key)?.delete(cellUri);
        fail(new Error(`Cell ${id} was removed during execution.`));
        return;
      }
      for (const change of event.cellChanges) {
        if (change.cell.document.uri.toString() !== cellUri) continue;
        const summary = change.executionSummary;
        if (summary && typeof summary.success === 'boolean' && JSON.stringify(summary) !== priorFingerprint) {
          complete(summary);
          return;
        }
        // A notebook can cold-start via its kernelspec. The Jupyter API only
        // exposes the kernel once it has started; check on the cell's first events.
        if (!runtime.kernel && !checkingKernel) {
          checkingKernel = true;
          void this.getKernelInfo(notebook.uri).then((kernel) => {
            checkingKernel = false;
            if (disposed || !kernel) return;
            runtime.kernel = kernel;
            watchKernel(kernel);
          });
        }
      }
    });
    const abort = () => fail(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const keepalive = progress && setInterval(() => {
      progress(`Cell ${id} is still running (${Math.floor((Date.now() - startedAt) / 1000)} s)`);
    }, PROGRESS_INTERVAL_MS);

    try {
      if (runtime.kernel) watchKernel(runtime.kernel);
      const command = (async () => {
        signal.throwIfAborted();
        if (runtime.kernel?.status && KERNEL_UNAVAILABLE_STATES.has(runtime.kernel.status)) throw kernelError(runtime.kernel.status);
        progress?.(`Starting cell ${id}`);
        this.trackExec(key, cellUri, active);
        try {
          await vscode.commands.executeCommand('notebook.cell.execute', {
            document: notebook.uri,
            ranges: [{ start: cell.index, end: cell.index + 1 }],
            autoReveal: false,
          });
        } catch (error) {
          if (this.activeExecs.get(key)?.get(cellUri) === active) this.activeExecs.get(key)?.delete(cellUri);
          throw error;
        }
        return completion;
      })();
      // A fast cell can publish its result before the command settles. Either
      // path must also release the waiter on timeout, cancellation or closure.
      return await Promise.race([completion, command]);
    } finally {
      disposed = true;
      changes.dispose();
      kernelSubscription?.dispose();
      signal.removeEventListener('abort', abort);
      clearInterval(keepalive);
    }
  }

  async editCell(uri: string | undefined, index: number | undefined, id: string | undefined, source: string) {
    const notebook = this.resolveNotebook(uri);
    const cell = this.resolveCell(notebook, index, id);
    const cellUriKey = cell.document.uri.toString();

    const notebookEdits: vscode.NotebookEdit[] = [];
    if (!hasPersistentCellId(cell)) {
      notebookEdits.push(vscode.NotebookEdit.updateCellMetadata(cell.index, { id: freshPersistentCellId() }));
    }

    const textEdit = new vscode.WorkspaceEdit();
    const doc = cell.document;
    textEdit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), source);
    if (notebookEdits.length > 0) {
      textEdit.set(notebook.uri, notebookEdits);
    }
    await vscode.workspace.applyEdit(textEdit);

    const updated = notebook.getCells().find((c) => c.document.uri.toString() === cellUriKey);
    if (!updated) throw new Error('Edited cell disappeared unexpectedly');
    return compactCell(updated);
  }

  async insertCell(uri: string | undefined, index: number, kind: 'code' | 'markdown', source: string, language?: string) {
    const notebook = this.resolveNotebook(uri);
    const clamped = Math.max(0, Math.min(index, notebook.cellCount));
    const cellKind = kind === 'code' ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup;
    const newCell = new vscode.NotebookCellData(
      cellKind,
      source,
      language || (kind === 'code' ? 'python' : 'markdown')
    );
    newCell.metadata = { id: freshPersistentCellId() };

    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(clamped, [newCell])]);
    await vscode.workspace.applyEdit(edit);

    return compactCell(notebook.cellAt(clamped));
  }

  async deleteCell(uri: string | undefined, index: number | undefined, id: string | undefined) {
    const notebook = this.resolveNotebook(uri);
    const cell = this.resolveCell(notebook, index, id);
    const deletedIndex = cell.index;

    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(deletedIndex, deletedIndex + 1), [])]);
    await vscode.workspace.applyEdit(edit);

    return { success: true, deletedIndex };
  }

  async saveNotebook(uri?: string) {
    const notebook = this.resolveNotebook(uri);
    await notebook.save();
    return { success: true, path: toPosixPath(notebook.uri.fsPath), dirty: notebook.isDirty };
  }

  async createNotebook(
    targetPath: string,
    options?: { kernelName?: string; kernelDisplayName?: string; language?: string; openInEditor?: boolean }
  ) {
    if (!targetPath) throw new Error('path is required');
    const normalized = toPosixPath(targetPath);
    if (!/\.ipynb$/i.test(normalized)) throw new Error(`Path must end with .ipynb, got: ${normalized}`);

    let uri: vscode.Uri;
    if (/^file:\/\//.test(targetPath)) {
      uri = vscode.Uri.parse(targetPath);
    } else {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!normalized.startsWith('/') && !workspaceFolder) {
        throw new Error('Relative paths require an open workspace folder; pass an absolute path instead.');
      }
      uri = vscode.Uri.file(
        path.resolve(workspaceFolder && !normalized.startsWith('/') ? workspaceFolder.uri.fsPath : '', normalized)
      );
    }

    let exists = false;
    try {
      await vscode.workspace.fs.stat(uri);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      throw new Error(`Notebook already exists at ${toPosixPath(uri.fsPath)}. Use jupyter_get_summary on it, or choose another path.`);
    }

    const metadata: Record<string, unknown> = {};
    const kernelName = options?.kernelName ?? 'python3';
    metadata['kernelspec'] = { name: kernelName, display_name: options?.kernelDisplayName ?? kernelName, language: options?.language ?? 'python' };
    metadata['language_info'] = { name: options?.language ?? 'python' };

    const content = {
      cells: [],
      metadata,
      nbformat: 4,
      nbformat_minor: 5,
    };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(content, null, 2), 'utf8'));

    const notebook = await vscode.workspace.openNotebookDocument(uri);

    if (options?.openInEditor !== false) {
      await vscode.window.showNotebookDocument(notebook);
    }

    return {
      success: true,
      path: toPosixPath(notebook.uri.fsPath),
      uri: notebook.uri.toString(),
      cellCount: notebook.cellCount,
      note: 'Notebook created and opened. Select a kernel in the VS Code toolbar if not auto-detected, then use jupyter_run_cells as usual.',
    };
  }

  async getOutputs(uri: string | undefined, index: number | undefined, id: string | undefined) {
    const notebook = this.resolveNotebook(uri);
    const cell = this.resolveCell(notebook, index, id);
    return { cell: compactCell(cell), ...await this.collectCellArtifacts(notebook, cell) };
  }

  private async collectCellArtifacts(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell) {
    const artifactsRoot = this.getArtifactsRoot(notebook);
    const outputs = cell.outputs.map(({ items }) => [...items]);
    const cellIndex = cell.index;
    if (outputs.length > 0) await fs.promises.mkdir(artifactsRoot, { recursive: true });
    const artifacts = await Promise.all(
      outputs.flatMap((items, outputIdx) =>
        items.map(async (item, itemIdx) => {
          const bytes = Buffer.from(item.data);
          // Keep earlier results readable when the same cell runs again.
          const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
          const name = path.basename(notebook.uri.fsPath, path.extname(notebook.uri.fsPath));
          const filename = `${name}-c${cellIndex}-o${outputIdx}-i${itemIdx}-${digest}${extensionForMime(item.mime)}`;
          const filePath = path.join(artifactsRoot, filename);
          const temp = path.join(artifactsRoot, `${randomUUID()}.tmp`);
          try {
            await fs.promises.writeFile(temp, bytes, { flag: 'wx' });
            await fs.promises.rename(temp, filePath);
          } catch (error) {
            await fs.promises.rm(temp, { force: true }).catch(() => undefined);
            throw error;
          }

          const textValue = isTextLikeMime(item.mime) ? bytes.toString('utf8') : undefined;

          return {
            output: outputIdx,
            item: itemIdx,
            mime: item.mime,
            bytes: item.data.byteLength,
            artifactPath: toPosixPath(filePath),
            preview: textValue?.substring(0, 1000),
            text: item.data.byteLength <= 8192 ? textValue : undefined,
          };
        })
      )
    );

    return { artifactsRoot: toPosixPath(artifactsRoot), artifacts };
  }

  private getArtifactsRoot(notebook: vscode.NotebookDocument): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(notebook.uri) || vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder
      ? path.join(workspaceFolder.uri.fsPath, '.jupyter-mcp', 'artifacts')
      : path.join(this.context.globalStorageUri.fsPath, 'artifacts');
  }

  async getNotebookStatus(uri?: string) {
    const notebook = this.resolveNotebook(uri);
    const key = notebook.uri.toString();
    const kernel = await this.getKernelInfo(notebook.uri);
    const entry = this.runtimeEntry(notebook, kernel);
    const status = kernel?.status ?? 'unknown';
    if (KERNEL_UNAVAILABLE_STATES.has(status)) {
      this.activeExecs.delete(key);
      if (entry) entry.probe = undefined;
    }

    const metaLabel = runtimeLabel(notebook);
    let runtime = metaLabel;
    let runtimeSource = 'none';
    let pythonVersion: string | undefined;
    let pythonPlatform: string | undefined;

    if (entry && kernel?.executeCode && kernel.language === 'python'
      && !KERNEL_BUSY_STATES.has(status) && !KERNEL_UNAVAILABLE_STATES.has(status)
      && !this.batches.has(key) && this.running(notebook).length === 0) {
      const probe = entry.probe ??= Promise.resolve().then(() => this.probeRuntime(kernel));
      const probed = await probe;
      if (probed && this.runtimes.get(key) === entry && entry.probe === probe) {
        pythonVersion = probed.version;
        pythonPlatform = `${probed.platform}/${probed.machine}`;
        runtime = `Python ${probed.version} (${probed.platform}/${probed.machine})`;
        runtimeSource = 'live-kernel-probe';
      }
    }
    if (runtimeSource === 'none' && kernel?.language) {
      runtime = metaLabel !== 'unknown' ? `${metaLabel} · ${kernel.language}` : `${kernel.language} (active kernel)`;
      runtimeSource = 'kernel-api';
    }
    if (runtimeSource === 'none' && metaLabel !== 'unknown') {
      runtimeSource = 'notebook-metadata';
    }

    const running = this.running(notebook);
    return {
      path: toPosixPath(notebook.uri.fsPath),
      dirty: notebook.isDirty,
      cellCount: notebook.cellCount,
      runtime,
      runtimeSource,
      ...(pythonVersion ? { pythonVersion, pythonPlatform } : {}),
      kernelStatus: running.length > 0 ? 'busy' : kernel?.status ?? 'unknown',
      kernelLanguage: kernel?.language,
      runningCells: running,
      recentCompletions: [...(this.completions.get(key) ?? [])],
      ...(running.length > 0
        ? { hint: 'Cells are running. Use jupyter_get_outputs to read current outputs.' }
        : {}),
    };
  }

  private runtimeEntry(notebook: vscode.NotebookDocument, kernel: JupyterKernelLike | undefined): RuntimeEntry | undefined {
    if (notebook.isClosed) return undefined;
    const key = notebook.uri.toString();
    const existing = this.runtimes.get(key);
    if (existing && existing.kernel === kernel) return existing;
    existing?.subscription?.dispose();
    if (!kernel) {
      this.runtimes.delete(key);
      return undefined;
    }
    const entry: RuntimeEntry = { kernel };
    entry.subscription = kernel.onDidChangeStatus?.((status) => {
      if (KERNEL_UNAVAILABLE_STATES.has(status)) {
        entry.probe = undefined;
        this.activeExecs.delete(key);
      }
    });
    this.runtimes.set(key, entry);
    return entry;
  }

  private async probeRuntime(kernel: JupyterKernelLike): Promise<RuntimeInfo | undefined> {
    const line = await this.runKernelProbe(kernel, RUNTIME_PROBE, 'JMCP_RT:', 10000);
    if (!line) return undefined;
    const [version, platform, machine] = line.split('|');
    if (!version || !platform) return undefined;
    return { version, platform, machine: machine ?? '' };
  }

  async getVariables(uri?: string) {
    const notebook = this.resolveNotebook(uri);
    const running = this.running(notebook);
    const kernel = await this.getKernelInfo(notebook.uri);
    const busy = running.length > 0 || (!!kernel?.status && KERNEL_BUSY_STATES.has(kernel.status));

    if (busy) {
      return {
        kernelStatus: kernel?.status ?? 'busy',
        count: 0,
        variables: [],
        hint: 'Kernel is busy — variable probing is deferred until idle. Check jupyter_get_status before retrying.',
      };
    }

    let variables = kernel?.executeCode ? await this.probeVariables(kernel) : undefined;
    let source = 'kernel-executeCode-probe';
    if (!variables) {
      variables = await this.listViaJupyterCommand(notebook.uri);
      source = 'jupyter-listvariables';
    }

    const symbols = await this.collectCellSymbols(notebook);
    let symbolFiltered = false;
    if (symbols.size > 0) {
      const filtered = variables.filter((v) => {
        const name = isRecord(v) ? v['name'] : undefined;
        return typeof name === 'string' && symbols.has(name);
      });
      if (filtered.length > 0) {
        variables = filtered;
        symbolFiltered = true;
      }
    }

    return {
      kernelStatus: kernel?.status ?? 'unknown',
      count: variables.length,
      variables,
      source,
      symbolFiltered,
      ...(symbolFiltered
        ? {}
        : { note: 'Symbol whitelist unavailable or empty — reporting unfiltered namespace.' }),
      ...(kernel?.executeCode
        ? {}
        : { hint: 'No active kernel available for probing. Run at least one cell first so ms-toolsai.jupyter starts the kernel.' }),
    };
  }

  // Mirrors microsoft/vscode-copilot-chat notebookServiceImpl.getVariables():
  // prefer the ms-toolsai.jupyter command, fall back silently when absent.
  private async listViaJupyterCommand(uri: vscode.Uri): Promise<Array<Record<string, unknown>>> {
    try {
      const result = await this.withTimeout(
        vscode.commands.executeCommand('jupyter.listVariables', uri),
        12000
      );
      if (!Array.isArray(result)) return [];
      return result.map((item) => {
        const rec = isRecord(item) ? item : {};
        const variable = isRecord(rec['variable']) ? rec['variable'] : rec;
        const out: Record<string, unknown> = {};
        for (const key of ['name', 'type', 'value', 'shape', 'count', 'size']) {
          if (variable[key] !== undefined) out[key] = variable[key];
        }
        if (typeof out['value'] === 'string') {
          const clipped = out['value'].length > 200;
          out['preview'] = clipped ? out['value'].slice(0, 197) + '...' : out['value'];
          delete out['value'];
          if (clipped) out['truncated'] = true;
        } else if ('value' in out) {
          out['preview'] = String(out['value']);
          delete out['value'];
        }
        return out;
      });
    } catch {
      return [];
    }
  }

  // Copilot's experimental variable filtering: keep only names that appear as
  // document symbols in executed cells. Applied only when the language server
  // yields symbols at all; otherwise we never hide data.
  private async collectCellSymbols(notebook: vscode.NotebookDocument): Promise<Set<string>> {
    const names = new Set<string>();
    const codeCells = notebook
      .getCells()
      .filter((c) => c.kind === vscode.NotebookCellKind.Code)
      .slice(-50);
    await Promise.all(
      codeCells.map(async (cell) => {
        try {
          const symbols = await vscode.commands.executeCommand<unknown[]>(
            'vscode.executeDocumentSymbolProvider',
            cell.document.uri
          );
          const walk = (list: unknown[]) => {
            for (const item of list) {
              if (!isRecord(item)) continue;
              if (typeof item['name'] === 'string') names.add(item['name']);
              if (Array.isArray(item['children'])) walk(item['children']);
            }
          };
          walk(Array.isArray(symbols) ? symbols : []);
        } catch {
          // language server absent for this cell — skip
        }
      })
    );
    return names;
  }

  private async withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve(promise).catch(() => undefined),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async getPipPackages(uri?: string) {
    const notebook = this.resolveNotebook(uri);
    try {
      const result = await this.withTimeout(
        vscode.commands.executeCommand('jupyter.listPipPackages', notebook.uri),
        20000
      );
      if (Array.isArray(result) && result.length > 0) {
        return {
          count: result.length,
          packages: result,
          source: 'jupyter-listPipPackages',
        };
      }
    } catch {
      // fall through to probe
    }

    const kernel = await this.getKernelInfo(notebook.uri);
    if (!kernel?.executeCode) {
      return { count: 0, packages: [], source: 'none', hint: 'No active kernel. Run a cell first.' };
    }
    const line = await this.runKernelProbe(kernel, PIP_PROBE, 'JMCP_PIP:');
    if (!line) {
      return { count: 0, packages: [], source: 'none', hint: 'Package probe failed on this kernel.' };
    }
    let parsed: { count?: number; packages?: Array<Record<string, unknown>>; error?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      return { count: 0, packages: [], source: 'none', hint: 'Package probe returned malformed data.' };
    }
    if (parsed.error) {
      return { count: 0, packages: [], source: 'kernel-probe', error: parsed.error };
    }
    const packages = parsed.packages ?? [];
    return {
      kernelStatus: kernel.status ?? 'idle',
      count: parsed.count ?? packages.length,
      reportedCount: packages.length,
      ...((parsed.count ?? 0) > packages.length ? { truncated: true } : {}),
      packages,
      source: 'kernel-executeCode-probe',
    };
  }

  // pip runs inside the kernel's own interpreter (sys.executable), so installs
  // land in the remote runtime the notebook is actually using (Colab included)
  // — never on the local code-server host.
  async installPackages(uri?: string, packages?: unknown, upgrade?: boolean) {
    const notebook = this.resolveNotebook(uri);
    const list = Array.isArray(packages) ? packages.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim()) : [];
    if (list.length === 0) throw new Error("Missing 'packages' (array of strings like [\"pandas\", \"requests==2.32.0\"])");
    if (list.length > 30) throw new Error('Too many packages (max 30 per call)');
    if (list.some((p) => p.length > 200)) throw new Error('Package spec too long');

    const kernel = await this.getKernelInfo(notebook.uri);
    if (!kernel?.executeCode) {
      return {
        installed: false,
        hint: 'No active kernel. Start a kernel first (run a cell or use jupyter_select_kernel) so packages install into it.',
      };
    }

    const line = await this.runKernelProbe(kernel, buildInstallProbe(list, upgrade === true), 'JMCP_INSTALL:', 180000);
    if (!line) {
      return { installed: false, hint: 'Install probe did not return within budget. The install may still be running in the kernel — check with jupyter_get_pip_packages.' };
    }
    let parsed: { exit_code: number; resolved: Record<string, string | null>; tail: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      return { installed: false, hint: 'Malformed install result.', raw: line.slice(0, 400) };
    }
    const missing = Object.entries(parsed.resolved ?? {}).filter(([, v]) => v === null).map(([k]) => k);
    return {
      installed: parsed.exit_code === 0,
      exitCode: parsed.exit_code,
      resolvedVersions: parsed.resolved ?? {},
      ...(missing.length > 0 ? { notResolvedAfterInstall: missing } : {}),
      outputTail: parsed.tail ?? '',
      note: 'pip ran inside the kernel interpreter; remote runtimes (e.g. Colab) reset installed packages on reconnect.',
    };
  }

  // Kernel picker is UI-only in VS Code; we surface it honestly and report
  // the resulting kernel state afterwards.
  async selectKernel(uri?: string) {
    const notebook = this.resolveNotebook(uri);
    const before = await this.getKernelInfo(notebook.uri);
    await vscode.commands.executeCommand('notebook.selectKernel', { notebookUri: notebook.uri });
    await sleep(2000);
    const after = await this.getKernelInfo(notebook.uri);
    const changed = (!before && !!after) || (!!before && !!after && before.language !== after.language);
    const canAutoBoot = !after && hasKernelspecMetadata(notebook);
    return {
      kernelStatus: after?.status ?? 'unknown',
      kernelLanguage: after?.language,
      changed,
      note:
        'The VS Code kernel picker was opened for this notebook. If nothing changed, no new kernel was chosen.',
      ...(canAutoBoot
        ? { hint: 'No kernel is active yet, but this notebook has kernelspec metadata — running any cell will auto-boot it.' }
        : {}),
    };
  }

  private async runKernelProbe(
    kernel: JupyterKernelLike,
    code: string,
    marker: string,
    timeoutMs = 15000
  ): Promise<string | undefined> {
    const tokenSource = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => tokenSource.cancel(), timeoutMs);
    try {
      const chunks: string[] = [];
      for await (const output of kernel.executeCode!(code, tokenSource.token)) {
        for (const item of output.items ?? []) {
          if (isTextLikeMime(item.mime)) {
            chunks.push(Buffer.from(item.data).toString('utf8'));
          }
        }
      }
      const text = chunks.join('');
      const markerIndex = text.indexOf(marker);
      if (markerIndex === -1) return undefined;
      const line = text.slice(markerIndex + marker.length).split('\n')[0];
      return line?.trim();
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      tokenSource.dispose();
    }
  }

  private async probeVariables(kernel: JupyterKernelLike): Promise<Array<Record<string, unknown>> | undefined> {
    const line = await this.runKernelProbe(kernel, VARIABLES_PROBE, 'JMCP_VARS:');
    if (!line || !line.startsWith('[')) return undefined;
    try {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async interruptKernel(uri?: string) {
    const notebook = this.resolveNotebook(uri);
    const candidates: Array<[string, unknown[]]> = [
      ['jupyter.interruptkernel', [notebook.uri]],
      ['notebook.interruptKernel', [notebook.uri]],
    ];
    const available = new Set(await vscode.commands.getCommands(true));
    for (const [cmd, args] of candidates) {
      if (available.has(cmd)) {
        const key = notebook.uri.toString();
        this.batches.get(key)?.abort(new Error('Kernel execution was interrupted.'));
        await vscode.commands.executeCommand(cmd, ...args);
        this.activeExecs.delete(key);
        return {
          interrupted: true,
          command: cmd,
          note: 'Interrupt requested — current execution aborts but kernel state (variables/imports) is preserved.',
        };
      }
    }
    throw new Error('No interrupt command available. Ensure the Jupyter extension (ms-toolsai.jupyter) is installed.');
  }

  async restartKernel(uri?: string) {
    const notebook = this.resolveNotebook(uri);
    const candidates: Array<[string, unknown[]]> = [
      ['jupyter.restartkernel', [notebook.uri]],
      ['notebook.kernel.restart', [notebook.uri]],
    ];
    const available = new Set(await vscode.commands.getCommands(true));
    for (const [cmd, args] of candidates) {
      if (available.has(cmd)) {
        this.clearNotebookState(notebook.uri.toString(), 'Kernel was restarted.');
        await vscode.commands.executeCommand(cmd, ...args);
        return {
          restarted: true,
          command: cmd,
          note: 'Kernel restarted — all variables are cleared. Execution trackers were reset as well.',
        };
      }
    }
    throw new Error('No restart command available. Ensure the Jupyter extension (ms-toolsai.jupyter) is installed.');
  }
}
