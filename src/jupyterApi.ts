import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { compactCell, stableCellId, hasPersistentCellId, freshPersistentCellId, normalizeCellId, extensionForMime, isTextLikeMime, runtimeLabel } from './format';
import { toPosixPath, isRecord } from './util';

interface ActiveExec {
  cellUri: string;
  state: 'executing';
}

interface CellCompletion {
  id: string;
  i: number;
  success: boolean;
  at: number;
}

interface KernelOutputItemLike {
  mime: string;
  data: Uint8Array;
}

export interface JupyterKernelLike {
  language?: string;
  status?: string;
  executeCode?(code: string, token: vscode.CancellationToken): AsyncIterable<{ items: KernelOutputItemLike[] }>;
}

type JupyterExtensionApi = {
  kernels?: {
    getKernel?(uri: vscode.Uri): Promise<JupyterKernelLike | undefined>;
  };
};

const KERNEL_BUSY_STATES = new Set(['busy', 'starting', 'restarting', 'autorestarting']);

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

  constructor(private context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeNotebookDocument((e) => this.onNotebookChange(e))
    );
  }

  private onNotebookChange(e: vscode.NotebookDocumentChangeEvent) {
    if (e.cellChanges.length === 0) return;
    const nbKey = e.notebook.uri.fsPath;
    let m = this.activeExecs.get(nbKey);
    if (!m) {
      m = new Map();
      this.activeExecs.set(nbKey, m);
    }
    for (const change of e.cellChanges) {
      const summary = change.executionSummary;
      if (!summary) continue;
      const cellKey = change.cell.document.uri.toString();
      if (typeof summary.success === 'boolean') {
        m.delete(cellKey);
        const arr = this.completions.get(nbKey) ?? [];
        arr.push({
          id: stableCellId(change.cell),
          i: change.cell.index,
          success: summary.success,
          at: Date.now(),
        });
        if (arr.length > 50) arr.splice(0, arr.length - 50);
        this.completions.set(nbKey, arr);
      } else {
        m.set(cellKey, { cellUri: cellKey, state: 'executing' });
      }
    }
  }

  private running(notebook: vscode.NotebookDocument): Array<{ id: string; index: number; state: string }> {
    const m = this.activeExecs.get(notebook.uri.fsPath);
    if (!m || m.size === 0) return [];
    const byUri = new Map(notebook.getCells().map((c) => [c.document.uri.toString(), c] as const));
    const result: Array<{ id: string; index: number; state: string }> = [];
    for (const [cellUri, info] of m) {
      const cell = byUri.get(cellUri);
      if (!cell) {
        m.delete(cellUri);
        continue;
      }
      if (typeof cell.executionSummary?.success === 'boolean') {
        m.delete(cellUri);
        continue;
      }
      result.push({ id: stableCellId(cell), index: cell.index, state: info.state });
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

  async executeCells(uri: string | undefined, range: { start: number; end: number } | { ids: string[] }) {
    const notebook = this.resolveNotebook(uri);
    const targets: vscode.NotebookCell[] = [];

    if ('start' in range) {
      const start = Math.max(0, range.start);
      const end = Math.min(range.end, notebook.cellCount);
      for (let i = start; i < end; i++) targets.push(notebook.cellAt(i));
    } else {
      for (const id of range.ids) targets.push(this.resolveCell(notebook, undefined, id));
    }

    const skipped = targets.filter((c) => c.kind !== vscode.NotebookCellKind.Code).map(compactCell);
    const codeCells = targets.filter((c) => c.kind === vscode.NotebookCellKind.Code);

    if (codeCells.length === 0) {
      return { started: [], skipped, note: 'No code cells selected — nothing to execute.' };
    }

    const kernel = await this.getKernelInfo(notebook.uri);
    if (kernel?.status === 'dead' || kernel?.status === 'terminating') {
      throw new Error(
        `Kernel status is "${kernel.status}". Use jupyter_restart_kernel first, then retry jupyter_run_cells.`
      );
    }
    if (!kernel) {
      const hasSpec = hasKernelspecMetadata(notebook);
      if (!hasSpec) {
        return {
          started: [],
          skipped,
          ran: false,
          hint: 'No active kernel and no kernelspec metadata. Select a kernel in the VS Code notebook toolbar first, then retry.',
        };
      }
    }

    await this.ensureCommand(
      'notebook.cell.execute',
      'Ensure the Jupyter extension (ms-toolsai.jupyter) is installed and a kernel is selected for the notebook.'
    );

    for (const cell of codeCells) {
      await vscode.commands.executeCommand('notebook.cell.execute', { start: cell.index, end: cell.index + 1 }, notebook.uri);
    }

    return {
      started: codeCells.map(compactCell),
      skipped,
      note: 'Execution started asynchronously (non-blocking). Call jupyter_wait_until_idle to wait for completion, then jupyter_get_outputs for results.',
    };
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

    const artifactsRoot = this.getArtifactsRoot(notebook);
    if (!fs.existsSync(artifactsRoot)) {
      fs.mkdirSync(artifactsRoot, { recursive: true });
    }

    const artifacts = await Promise.all(
      cell.outputs.flatMap((output, outputIdx) =>
        output.items.map(async (item, itemIdx) => {
          const filename = `${path.basename(notebook.uri.fsPath, path.extname(notebook.uri.fsPath))}-c${cell.index}-o${outputIdx}-i${itemIdx}${extensionForMime(item.mime)}`;
          const filePath = path.join(artifactsRoot, filename);

          await fs.promises.writeFile(filePath, Buffer.from(item.data));

          const isText = isTextLikeMime(item.mime);
          const textValue = isText ? Buffer.from(item.data).toString('utf8') : undefined;

          return {
            output: outputIdx,
            item: itemIdx,
            mime: item.mime,
            bytes: item.data.byteLength,
            artifactPath: toPosixPath(filePath),
            preview: textValue ? textValue.substring(0, 1000) : undefined,
            text: textValue && item.data.byteLength <= 8192 ? textValue : undefined,
          };
        })
      )
    );

    return {
      cell: compactCell(cell),
      artifactsRoot: toPosixPath(artifactsRoot),
      artifacts,
    };
  }

  private getArtifactsRoot(notebook: vscode.NotebookDocument): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(notebook.uri) || vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) throw new Error('Artifacts require an open workspace folder');
    return path.join(workspaceFolder.uri.fsPath, '.jupyter-mcp', 'artifacts');
  }

  async getNotebookStatus(uri?: string) {
    const notebook = this.resolveNotebook(uri);
    const running = this.running(notebook);
    const kernel = await this.getKernelInfo(notebook.uri);
    const kernelStatus = running.length > 0 ? 'busy' : kernel?.status ?? 'unknown';

    const kernelBusy = running.length > 0;

    const metaLabel = runtimeLabel(notebook);
    let runtime = metaLabel;
    let runtimeSource = 'none';
    let pythonVersion: string | undefined;
    let pythonPlatform: string | undefined;

    if (!kernelBusy && kernel?.executeCode && kernel.language === 'python') {
      const probed = await this.probeRuntime(kernel);
      if (probed) {
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

    return {
      path: toPosixPath(notebook.uri.fsPath),
      dirty: notebook.isDirty,
      cellCount: notebook.cellCount,
      runtime,
      runtimeSource,
      ...(pythonVersion ? { pythonVersion, pythonPlatform } : {}),
      kernelStatus,
      kernelLanguage: kernel?.language,
      runningCells: running,
      ...(running.length > 0
        ? { hint: 'Kernel is busy. Use jupyter_wait_until_idle before reading outputs.' }
        : {}),
    };
  }

  async waitUntilIdle(uri: string | undefined, timeoutSec = 45) {
    const notebook = this.resolveNotebook(uri);
    const nbKey = notebook.uri.fsPath;
    const timeoutMs = Math.max(1, Math.min(timeoutSec, 300)) * 1000;
    const deadline = Date.now() + timeoutMs;
    const startAt = Date.now() - 1;
    let lastKernelCheck = 0;
    let kernelBusy = false;
    let lastKnownStatus = 'unknown';
    let staleChecks = 0;
    let polling = true;
    while (polling) {
      polling = false;
      const running = this.running(notebook);
      if (Date.now() - lastKernelCheck >= 1000) {
        lastKernelCheck = Date.now();
        const kernel = await this.getKernelInfo(notebook.uri);
        lastKnownStatus = kernel?.status ?? 'unknown';
        kernelBusy = !!lastKnownStatus && KERNEL_BUSY_STATES.has(lastKnownStatus);
      }
      if (running.length === 0 && !kernelBusy) {
        await sleep(150);
        const completed = (this.completions.get(nbKey) ?? []).filter((c) => c.at >= startAt);
        return {
          idle: true,
          waitedMs: Date.now() - startAt,
          kernelStatus: lastKnownStatus,
          completed,
          note: 'Kernel idle. Use jupyter_get_outputs on the cells you care about.',
        };
      }
      if (!kernelBusy && running.length > 0) {
        staleChecks++;
        if (staleChecks >= 5) {
          this.activeExecs.get(nbKey)?.clear();
          return {
            idle: true,
            waitedMs: Date.now() - startAt,
            kernelStatus: lastKnownStatus,
            completed: [],
            clearedStaleTrackers: running,
            note: 'Kernel is not busy but execution trackers were stuck (likely a dropped kernel connection). Stale entries cleared; verify the affected cells manually and re-run if needed.',
          };
        }
      } else {
        staleChecks = 0;
      }
      if (Date.now() >= deadline) {
        return {
          idle: false,
          waitedMs: Date.now() - startAt,
          kernelStatus: lastKnownStatus,
          runningCells: running,
          retryAfterSec: 5,
          hint: 'Execution still running. Poll jupyter_wait_until_idle again (short waits beat one long wait — avoids MCP client timeouts), check jupyter_get_status, or use jupyter_interrupt_kernel to abort while preserving variables.',
        };
      }
      await sleep(200);
      polling = true;
    }
  }

  private async probeRuntime(kernel: JupyterKernelLike): Promise<{ version: string; platform: string; machine: string } | undefined> {
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
        hint: 'Kernel is busy — variable probing is deferred until idle. Call jupyter_wait_until_idle first.',
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
    return Promise.race([
      Promise.resolve(promise).catch(() => undefined as T | undefined),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
    ]);
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
        await vscode.commands.executeCommand(cmd, ...args);
        this.activeExecs.get(notebook.uri.fsPath)?.clear();
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
        await vscode.commands.executeCommand(cmd, ...args);
        this.activeExecs.get(notebook.uri.fsPath)?.clear();
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
