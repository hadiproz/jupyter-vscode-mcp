import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as util from './util';

export function shortMime(mime: string): string {
  if (mime === 'application/vnd.code.notebook.stdout') return 'stdout';
  if (mime === 'application/vnd.code.notebook.stderr') return 'stderr';
  if (mime === 'application/vnd.code.notebook.error') return 'error';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpeg';
  if (mime === 'text/plain') return 'text';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'application/json') return 'json';
  return mime.split('/').pop() ?? mime;
}

export function extensionForMime(mime: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/svg+xml') return '.svg';
  if (mime === 'text/html') return '.html';
  if (mime === 'text/plain') return '.txt';
  if (mime === 'application/json') return '.json';
  if (mime === 'application/vnd.code.notebook.error') return '.json';
  if (mime === 'application/vnd.code.notebook.stdout') return '.txt';
  if (mime === 'application/vnd.code.notebook.stderr') return '.txt';
  return '.bin';
}

export function isTextLikeMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/vnd.code.notebook.stdout' ||
    mime === 'application/vnd.code.notebook.stderr' ||
    mime === 'application/vnd.code.notebook.error'
  );
}

// Deterministic fallback for cells that do not carry a persisted nbformat id
// yet (e.g. hand-created in the UI and not summarized since). Ephemeral by
// design: the next jupyter_get_summary backfills a real persisted id.
function ephemeralCellId(cell: vscode.NotebookCell): string {
  return (
    '#NB-' +
    crypto
      .createHash('sha1')
      .update(cell.document.uri.toString(), 'utf8')
      .digest('hex')
      .slice(0, 8)
  );
}

const NBFORMAT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function persistentIdSuffix(cell: vscode.NotebookCell): string | undefined {
  const raw = cell.metadata['id'];
  if (typeof raw !== 'string') return undefined;
  const bare = raw.replace(/^#(NB-)?/i, '');
  return NBFORMAT_ID_RE.test(bare) ? bare : undefined;
}

export function freshPersistentCellId(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function stableCellId(cell: vscode.NotebookCell): string {
  const suffix = persistentIdSuffix(cell);
  return suffix ? '#NB-' + suffix : ephemeralCellId(cell);
}

export function hasPersistentCellId(cell: vscode.NotebookCell): boolean {
  return persistentIdSuffix(cell) !== undefined;
}

const CELL_ID_RE = /^#NB-([a-f0-9]{8})$/i;

export function normalizeCellId(cellId: string): string {
  const v = cellId.trim();
  const m = CELL_ID_RE.exec(v);
  if (m?.[1]) return `#NB-${m[1].toLowerCase()}`;
  if (/^[a-f0-9]{8}$/i.test(v)) return '#NB-' + v.toLowerCase();
  return v;
}

export function executionText(cell: vscode.NotebookCell): string {
  const summary = cell.executionSummary;
  if (!summary?.executionOrder && !summary?.timing) {
    return 'not-run';
  }
  const status = summary.success === false ? 'failed' : 'succeeded';
  const order = summary.executionOrder ?? '?';
  const duration = summary.timing ? ` ${Math.max(0, summary.timing.endTime - summary.timing.startTime)}ms` : '';
  return `${status} #${order}${duration}`;
}

export function runtimeLabel(notebook: vscode.NotebookDocument): string {
  const meta = util.isRecord(notebook['metadata']) ? notebook['metadata'] : {};
  const nested = util.isRecord(meta['metadata']) ? meta['metadata'] : {};
  const spec =
    (util.isRecord(meta['kernelspec']) ? meta['kernelspec'] : undefined) ??
    (util.isRecord(nested['kernelspec']) ? nested['kernelspec'] : undefined);
  const kernelName = util.stringProp(spec ?? {}, 'display_name') ?? util.stringProp(spec ?? {}, 'name');
  return kernelName ?? 'unknown';
}

export function compactCell(cell: vscode.NotebookCell) {
  return {
    i: cell.index,
    id: stableCellId(cell),
    kind: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown',
    lang: cell.document.languageId,
    lines: cell.document.lineCount,
    exec: executionText(cell),
    outs: [...new Set(cell.outputs.flatMap((o) => o.items.map((it) => shortMime(it.mime))))],
    first: util.previewText((cell.document.getText().split('\n')[0] ?? '').trim(), 50),
  };
}
