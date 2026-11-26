const { EventEmitter: NodeEventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

class EventEmitter {
  #emitter = new NodeEventEmitter();

  event = (listener) => {
    this.#emitter.on('event', listener);
    return { dispose: () => this.#emitter.off('event', listener) };
  };

  fire(value) { this.#emitter.emit('event', value); }
  dispose() { this.#emitter.removeAllListeners(); }
  get listenerCount() { return this.#emitter.listenerCount('event'); }
}

const Uri = {
  file(value) { return Uri.parse(pathToFileURL(value).href); },
  parse(value) {
    const url = new URL(value);
    return {
      fsPath: url.protocol === 'file:' ? fileURLToPath(url) : url.pathname,
      toString: () => url.href,
    };
  },
};

const NotebookCellKind = { Markup: 1, Code: 2 };
class NotebookCellData {
  constructor(kind, value, languageId) { Object.assign(this, { kind, value, languageId, metadata: {}, outputs: [] }); }
}

class NotebookRange {
  constructor(start, end) { Object.assign(this, { start, end }); }
}

const NotebookEdit = {
  updateCellMetadata: (index, metadata) => ({ index, metadata }),
  insertCells: (index, cells) => ({ range: new NotebookRange(index, index), cells }),
  replaceCells: (range, cells) => ({ range, cells }),
};

class WorkspaceEdit {
  notebooks = [];
  text = [];
  set(uri, edits) { this.notebooks.push({ uri, edits }); }
  replace(uri, _range, source) { this.text.push({ uri, source }); }
}

class CancellationTokenSource {
  #changed = new EventEmitter();
  token = { isCancellationRequested: false, onCancellationRequested: this.#changed.event };
  cancel() {
    this.token.isCancellationRequested = true;
    this.#changed.fire();
  }
  dispose() { this.#changed.dispose(); }
}

const changes = new EventEmitter();
const closes = new EventEmitter();
const folderChanges = new EventEmitter();
const configChanges = new EventEmitter();
const commandHandlers = new Map();
const kernels = new Map();
const settings = new Map();
const statusItems = [];
const errorMessages = [];

const notebookAt = (uri) => workspace.notebookDocuments.find((notebook) => notebook.uri.toString() === uri.toString());

function makeCell(notebook, data) {
  const uri = Uri.parse(`${notebook.uri}#cell-${notebook.nextCell++}`);
  const document = {
    uri, source: data.value, languageId: data.languageId,
    get lineCount() { return this.source.split('\n').length; },
    getText() { return this.source; },
    positionAt: (offset) => offset,
  };
  return {
    notebook, document, kind: data.kind, metadata: { ...data.metadata }, outputs: data.outputs ?? [],
    executionSummary: data.executionSummary,
    get index() { return notebook.cells.indexOf(this); },
  };
}

function openNotebook(filename, sources = []) {
  const uri = typeof filename === 'string' ? Uri.file(filename) : filename;
  const notebook = {
    uri, isDirty: false, isClosed: false, nextCell: 0,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
    get cellCount() { return this.cells.length; },
    getCells() { return [...this.cells]; },
    cellAt(index) { return this.cells[index]; },
    async save() { this.isDirty = false; return true; },
  };
  notebook.cells = sources.map((source) => makeCell(notebook,
    typeof source === 'string' ? new NotebookCellData(NotebookCellKind.Code, source, 'python') : source));
  workspace.notebookDocuments.push(notebook);
  window.activeNotebookEditor = { notebook };
  window.visibleNotebookEditors = [window.activeNotebookEditor];
  return notebook;
}

function changeCell(cell, executionSummary, outputs) {
  cell.executionSummary = executionSummary;
  if (outputs !== undefined) cell.outputs = outputs;
  changes.fire({ notebook: cell.notebook, cellChanges: [{ cell, executionSummary, outputs }], contentChanges: [] });
}

function createKernel() {
  const statuses = new EventEmitter();
  return {
    status: 'idle', language: 'python',
    onDidChangeStatus: statuses.event,
    get listenerCount() { return statuses.listenerCount; },
    setStatus(status) { this.status = status; statuses.fire(status); },
  };
}

const workspace = {
  notebookDocuments: [], workspaceFolders: [],
  onDidChangeNotebookDocument: changes.event,
  onDidCloseNotebookDocument: closes.event,
  onDidChangeWorkspaceFolders: folderChanges.event,
  onDidChangeConfiguration: configChanges.event,
  getWorkspaceFolder(uri) {
    return this.workspaceFolders.find((folder) => {
      const rel = path.relative(folder.uri.fsPath, uri.fsPath);
      return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    });
  },
  getConfiguration: (section) => ({ get: (key, fallback) => settings.get(`${section}.${key}`) ?? fallback }),
  fs: { stat: (uri) => fs.stat(uri.fsPath), writeFile: (uri, bytes) => fs.writeFile(uri.fsPath, bytes) },
  async openNotebookDocument(uri) { return notebookAt(uri) ?? openNotebook(uri); },
  async applyEdit(edit) {
    for (const { uri, source } of edit.text) {
      for (const notebook of this.notebookDocuments) {
        const cell = notebook.cells.find((candidate) => candidate.document.uri.toString() === uri.toString());
        if (cell) { cell.document.source = source; notebook.isDirty = true; }
      }
    }
    for (const { uri, edits } of edit.notebooks) {
      const notebook = notebookAt(uri);
      for (const item of edits) {
        if (item.metadata) notebook.cellAt(item.index).metadata = { ...notebook.cellAt(item.index).metadata, ...item.metadata };
        else {
          const { start, end } = item.range;
          notebook.cells.splice(start, end - start, ...item.cells.map((data) => makeCell(notebook, data)));
          changes.fire({ notebook, cellChanges: [], contentChanges: [item] });
        }
      }
      notebook.isDirty = true;
    }
    return true;
  },
};

const window = {
  activeNotebookEditor: undefined,
  visibleNotebookEditors: [],
  async showNotebookDocument(notebook, options) {
    const editor = { notebook };
    if (options?.preserveFocus && this.activeNotebookEditor) this.visibleNotebookEditors.push(editor);
    else {
      this.activeNotebookEditor = editor;
      this.visibleNotebookEditors = [editor];
    }
    return editor;
  },
  async showInformationMessage() {},
  async showErrorMessage(message, ...actions) { errorMessages.push({ message, actions }); return actions[0]; },
  createStatusBarItem() {
    const item = { show() { this.visible = true; }, dispose() { this.visible = false; } };
    statusItems.push(item);
    return item;
  },
};

const commands = {
  async executeCommand(name, ...args) { return commandHandlers.get(name)?.(...args); },
  async getCommands() { return [...commandHandlers.keys()]; },
  registerCommand(name, handler) {
    commandHandlers.set(name, handler);
    return { dispose: () => commandHandlers.delete(name) };
  },
};

const testing = {
  openNotebook, changeCell, createKernel, statusItems, errorMessages,
  get notebookChangeListeners() { return changes.listenerCount; },
  async flush() { await new Promise((resolve) => setImmediate(resolve)); },
  closeNotebook(notebook) {
    notebook.isClosed = true;
    workspace.notebookDocuments = workspace.notebookDocuments.filter((doc) => doc !== notebook);
    if (window.activeNotebookEditor?.notebook === notebook) window.activeNotebookEditor = undefined;
    window.visibleNotebookEditors = window.visibleNotebookEditors.filter((editor) => editor.notebook !== notebook);
    closes.fire(notebook);
  },
  setWorkspaceFolders(...folders) {
    const oldFolders = workspace.workspaceFolders;
    const newFolders = folders.map((folder) => ({ uri: Uri.file(folder), name: path.basename(folder) }));
    workspace.workspaceFolders = newFolders;
    folderChanges.fire({ added: newFolders, removed: oldFolders });
  },
  setKernel(notebook, kernel) { kernels.set(notebook.uri.toString(), kernel); },
  setSetting(key, value) { settings.set(key, value); configChanges.fire({ affectsConfiguration: (candidate) => candidate === key }); },
  createContext(storage) { return { subscriptions: [], globalStorageUri: Uri.file(storage), extension: { packageJSON: { version: '2.0.0' } } }; },
  reset() {
    for (const event of [changes, closes, folderChanges, configChanges]) event.dispose();
    workspace.notebookDocuments = [];
    workspace.workspaceFolders = [];
    window.activeNotebookEditor = undefined;
    window.visibleNotebookEditors = [];
    commandHandlers.clear();
    kernels.clear();
    settings.clear();
    statusItems.length = 0;
    errorMessages.length = 0;
  },
};

module.exports = {
  EventEmitter, Uri, NotebookCellKind, NotebookCellData, NotebookRange, NotebookEdit, WorkspaceEdit, CancellationTokenSource,
  Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  StatusBarAlignment: { Right: 2 }, workspace, window, commands,
  extensions: {
    getExtension(id) {
      return id === 'ms-toolsai.jupyter' ? {
        isActive: true, exports: { kernels: { getKernel: async (uri) => kernels.get(uri.toString()) } },
      } : undefined;
    },
  },
  testing,
};
