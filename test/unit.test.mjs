import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadExtension, tempHome } from './load-extension.mjs';

const { JupyterApi, takeOverPort, writeControlFile, vscode } = await loadExtension('unit');
const { testing, commands } = vscode;
const execute = 'notebook.cell.execute';
const stdout = (text) => [{ items: [{ mime: 'application/vnd.code.notebook.stdout', data: Buffer.from(text) }] }];
const finished = (executionOrder, success = true) => ({ success, executionOrder, timing: { startTime: 100, endTime: 115 } });
const parked = () => new Promise(() => {});

async function notebookFixture(t, sources = ['print(42)', 'print(7)', 'print(0)']) {
  testing.reset();
  const folder = await mkdtemp(path.join(tmpdir(), 'jmcp-notebook-'));
  const context = testing.createContext(folder);
  const api = new JupyterApi(context);
  const filename = path.join(folder, 'demo.ipynb');
  testing.setWorkspaceFolders(folder);
  const notebook = testing.openNotebook(filename, sources);
  const kernel = testing.createKernel();
  testing.setKernel(notebook, kernel);
  let interrupts = 0;
  commands.registerCommand('jupyter.interruptkernel', () => { interrupts++; });
  t.after(async () => {
    api.clearAllState();
    for (const item of context.subscriptions) item.dispose();
    await rm(folder, { recursive: true, force: true });
  });
  return { api, notebook, kernel, filename, get interrupts() { return interrupts; } };
}

test('executeCells catches synchronous completion even if the command never resolves and shares output artifacts', { timeout: 2000 }, async (t) => {
  const { api, notebook, kernel } = await notebookFixture(t);
  commands.registerCommand(execute, (args) => {
    assert.deepEqual(args, { document: notebook.uri, ranges: [{ start: 0, end: 1 }], autoReveal: false });
    assert.equal(testing.notebookChangeListeners, 2);
    assert.equal(kernel.listenerCount, 1);
    testing.changeCell(notebook.cellAt(0), finished(1), stdout('42\n'));
    return parked();
  });
  const progress = [];
  const result = await api.executeCells(undefined, { start: 0, end: 1 }, { onProgress: (...event) => progress.push(event) });
  assert.equal(result.status, 'completed');
  assert.equal(result.cells[0].exec, 'succeeded #1 15ms');
  assert.equal(result.cells[0].elapsedMs, 15);
  const [output] = result.cells[0].outputs;
  assert.equal(output.text, '42\n');
  assert.equal(await readFile(output.artifactPath, 'utf8'), '42\n');
  assert.deepEqual((await api.getOutputs(undefined, 0)).artifacts, [output]);
  assert.deepEqual(progress.map(([done, total]) => [done, total]), [[0, 1], [1, 1]]);
  assert.equal(testing.notebookChangeListeners, 1);
  assert.equal(kernel.listenerCount, 0);
});

test('executeCells ignores a prior execution summary during a rerun', { timeout: 2000 }, async (t) => {
  const { api, notebook } = await notebookFixture(t);
  const cell = notebook.cellAt(0);
  cell.executionSummary = finished(1);
  commands.registerCommand(execute, () => testing.changeCell(cell, finished(1)));
  let resolved = false;
  const run = api.executeCells(undefined, { start: 0, end: 1 }, { includeOutputs: false })
    .then((value) => { resolved = true; return value; });
  await testing.flush();
  assert.equal(resolved, false);
  const status = await api.getNotebookStatus();
  assert.equal(status.recentCompletions.length, 0);
  assert.equal(status.runningCells.length, 1);
  testing.changeCell(cell, { executionOrder: 2 });
  testing.changeCell(cell, finished(2));
  const result = await run;
  assert.equal(result.cells[0].exec, 'succeeded #2 15ms');
  assert.equal('outputs' in result.cells[0], false);
});

test('executeCells runs stable IDs in order and skips all remaining cells on the first error', async (t) => {
  const { api, notebook } = await notebookFixture(t);
  const { cells } = await api.getNotebookSummary();
  const dispatched = [];
  commands.registerCommand(execute, ({ ranges: [{ start }] }) => {
    dispatched.push(start);
    const ok = start !== 0;
    testing.changeCell(notebook.cellAt(start), finished(dispatched.length, ok), ok ? [] : [{ items: [{
      mime: 'application/vnd.code.notebook.error', data: Buffer.from('{"stack":"ValueError: failure"}'),
    }] }]);
  });
  const result = await api.executeCells(undefined, { ids: [cells[2].id, cells[0].id, cells[1].id] });
  assert.equal(result.status, 'completed');
  assert.deepEqual(dispatched, [2, 0]);
  assert.deepEqual(result.cells.map((cell) => cell.exec), ['succeeded #1 15ms', 'failed #2 15ms', 'skipped (previous cell failed)']);
  assert.match(result.cells[1].outputs[0].text, /ValueError/);
  assert.equal('outputs' in result.cells[2], false);
});

test('a hidden notebook is targeted without changing focus, and empty, raw and markdown cells are skipped', async (t) => {
  const markdown = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, '# Title', 'markdown');
  const raw = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'raw text', 'raw');
  const { api, notebook, filename } = await notebookFixture(t, ['  ', markdown, raw, 'print(1)']);
  const other = testing.openNotebook(path.join(path.dirname(filename), 'other.ipynb'), ['print(2)']);
  commands.registerCommand(execute, ({ document, ranges }) => {
    assert.equal(vscode.window.activeNotebookEditor.notebook, other);
    assert.ok(vscode.window.visibleNotebookEditors.some((editor) => editor.notebook === notebook));
    assert.equal(document, notebook.uri);
    assert.deepEqual(ranges, [{ start: 3, end: 4 }]);
    testing.changeCell(notebook.cellAt(3), finished(1));
  });
  const result = await api.executeCells(filename, { start: 0, end: 4 });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.cells.map((cell) => cell.exec), [
    'skipped (empty cell)', 'skipped (not code)', 'skipped (raw cell)', 'succeeded #1 15ms',
  ]);
});

test('output paths for multiple executions of the same cell retain the respective bytes', async (t) => {
  const { api, notebook } = await notebookFixture(t);
  const { id } = (await api.getNotebookSummary()).cells[0];
  let order = 0;
  commands.registerCommand(execute, () => {
    order++;
    testing.changeCell(notebook.cellAt(0), finished(order), stdout(`run ${order}`));
  });
  const { cells } = await api.executeCells(undefined, { ids: [id, id] });
  const [first, second] = cells.map((cell) => cell.outputs[0].artifactPath);
  assert.notEqual(first, second);
  assert.equal(await readFile(first, 'utf8'), 'run 1');
  assert.equal(await readFile(second, 'utf8'), 'run 2');
  assert.equal((await api.getOutputs(undefined, 0)).artifacts[0].artifactPath, second);
});

test('wait timeout covers a stuck VS Code command and reports completed, running, and undispatched cells', { timeout: 2000 }, async (t) => {
  const fixture = await notebookFixture(t);
  const { api, notebook, kernel } = fixture;
  const dispatched = [];
  commands.registerCommand(execute, ({ ranges: [{ start }] }) => {
    dispatched.push(start);
    if (start === 0) {
      testing.changeCell(notebook.cellAt(0), finished(1), stdout('first'));
      return;
    }
    kernel.setStatus('busy');
    return parked();
  });
  const result = await api.executeCells(undefined, { start: 0, end: 3 }, { waitTimeoutSec: 0.03 });
  assert.equal(result.status, 'running');
  assert.equal(result.kernelStatus, 'busy');
  assert.deepEqual(result.completedCells.map((cell) => cell.i), [0]);
  assert.equal(result.completedCells[0].outputs[0].text, 'first');
  assert.deepEqual(result.runningCells.map((cell) => cell.i), [1]);
  assert.ok(result.runningCells[0].elapsedMs > 0);
  assert.deepEqual(result.pendingCells.map((cell) => cell.i), [2]);
  assert.equal((await api.getNotebookStatus()).runningCells[0].index, 1);
  testing.changeCell(notebook.cellAt(1), finished(2));
  kernel.setStatus('idle');
  const status = await api.getNotebookStatus();
  assert.deepEqual(status.runningCells, []);
  assert.deepEqual(status.recentCompletions.map(({ i, elapsedMs }) => [i, elapsedMs]), [[0, 15], [1, 15]]);
  assert.deepEqual(dispatched, [0, 1]);
  assert.equal(fixture.interrupts, 0);
});

test('dead kernel fails fast and disposes execution listeners', { timeout: 2000 }, async (t) => {
  const fixture = await notebookFixture(t);
  const { api, kernel } = fixture;
  commands.registerCommand(execute, () => {
    kernel.setStatus('dead');
    return parked();
  });
  await assert.rejects(api.executeCells(undefined, { start: 0, end: 1 }), /Kernel status is "dead"/);
  assert.equal(testing.notebookChangeListeners, 1);
  assert.equal(kernel.listenerCount, 0);
  assert.deepEqual((await api.getNotebookStatus()).runningCells, []);
  assert.equal(fixture.interrupts, 0);
});

test('abort detaches the request without interrupting or dispatching the rest of the batch', { timeout: 2000 }, async (t) => {
  const fixture = await notebookFixture(t);
  const { api, notebook, kernel } = fixture;
  const abort = new AbortController();
  const dispatched = [];
  commands.registerCommand(execute, ({ ranges: [{ start }] }) => {
    dispatched.push(start);
    abort.abort(new Error('Client cancelled'));
    return parked();
  });
  await assert.rejects(api.executeCells(undefined, { start: 0, end: 3 }, { signal: abort.signal }), /Client cancelled/);
  assert.equal(testing.notebookChangeListeners, 1);
  assert.equal(kernel.listenerCount, 0);
  testing.changeCell(notebook.cellAt(0), finished(1));
  assert.deepEqual(dispatched, [0]);
  assert.equal(fixture.interrupts, 0);
  assert.equal((await api.getNotebookStatus()).recentCompletions[0].success, true);
});

test('waitTimeoutSec 0 dispatches before replying and runs queued cells in order through the first failure', async (t) => {
  const { api, notebook } = await notebookFixture(t);
  const dispatched = [];
  commands.registerCommand(execute, ({ ranges: [{ start }] }) => { dispatched.push(start); });
  const result = await api.executeCells(undefined, { start: 0, end: 3 }, { waitTimeoutSec: 0 });
  assert.equal(result.status, 'started');
  assert.deepEqual(result.cells.map((cell) => cell.exec), ['started', 'pending', 'pending']);
  assert.deepEqual(dispatched, [0]);
  testing.changeCell(notebook.cellAt(0), finished(1));
  await testing.flush();
  assert.deepEqual(dispatched, [0, 1]);
  testing.changeCell(notebook.cellAt(1), finished(2, false));
  await testing.flush();
  assert.deepEqual(dispatched, [0, 1]);
});

test('runtime probes are shared per notebook and kernel and invalidated by restart or replacement', async (t) => {
  const { api, kernel, notebook, filename } = await notebookFixture(t);
  let probes = 0;
  kernel.executeCode = async function* (code) {
    assert.match(code, /JMCP_RT:/);
    probes++;
    yield stdout('JMCP_RT:3.12.4|linux|x86_64')[0];
  };
  kernel.setStatus('busy');
  assert.equal((await api.getNotebookStatus()).pythonVersion, undefined);
  assert.equal(probes, 0);
  kernel.setStatus('idle');
  const snapshots = await Promise.all([api.getNotebookStatus(), api.getNotebookStatus()]);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.pythonVersion), ['3.12.4', '3.12.4']);
  assert.equal((await api.getNotebookStatus()).pythonPlatform, 'linux/x86_64');
  assert.equal(probes, 1);
  kernel.setStatus('restarting');
  kernel.setStatus('idle');
  assert.equal((await api.getNotebookStatus()).pythonVersion, '3.12.4');
  assert.equal(probes, 2);

  const other = testing.openNotebook(path.join(path.dirname(filename), 'other.ipynb'));
  testing.setKernel(other, kernel);
  await api.getNotebookStatus(other.uri.toString());
  assert.equal(probes, 3);
  const replacement = testing.createKernel();
  replacement.executeCode = kernel.executeCode;
  testing.setKernel(notebook, replacement);
  await api.getNotebookStatus(notebook.uri.toString());
  assert.equal(probes, 4);
  assert.equal(kernel.listenerCount, 1);
  assert.equal(replacement.listenerCount, 1);
});

test('closing a notebook purges running cells, completions and runtime metadata for the reopened URI', { timeout: 2000 }, async (t) => {
  const { api, notebook, kernel, filename } = await notebookFixture(t);
  let probes = 0;
  kernel.executeCode = async function* () {
    probes++;
    yield stdout('JMCP_RT:3.12.4|linux|x86_64')[0];
  };
  testing.changeCell(notebook.cellAt(0), finished(1));
  assert.equal((await api.getNotebookStatus()).recentCompletions.length, 1);
  commands.registerCommand(execute, () => parked());
  const run = api.executeCells(undefined, { start: 1, end: 2 });
  const rejected = assert.rejects(run, /Notebook was closed/);
  await testing.flush();
  assert.equal((await api.getNotebookStatus()).runningCells.length, 1);
  testing.closeNotebook(notebook);
  await rejected;
  assert.equal(kernel.listenerCount, 0);
  const reopened = testing.openNotebook(filename, ['print(1)', 'print(2)']);
  testing.setKernel(reopened, kernel);
  const status = await api.getNotebookStatus();
  assert.deepEqual(status.runningCells, []);
  assert.deepEqual(status.recentCompletions, []);
  assert.equal(probes, 2);
});

test('control files are atomically replaced with mode 0600 and no temporary residue', async (t) => {
  const { home, dispose } = await tempHome();
  t.after(dispose);
  const port = 9123;
  const record = { pid: process.pid, instanceId: 'old', port, token: 'ab'.repeat(32), workspaceFolders: ['/old'], startedAt: Date.now() };
  const dir = path.join(home, '.jupyter-vscode-mcp');
  const file = path.join(dir, `control-${port}.json`);
  await writeControlFile(record);
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(await read(), record);
  const next = { ...record, instanceId: 'new', token: 'cd'.repeat(32), workspaceFolders: ['/new'] };
  const update = writeControlFile(next);
  const snapshots = await Promise.all([read(), read(), read()]);
  await update;
  for (const snapshot of snapshots) assert.deepEqual(snapshot, snapshot.instanceId === 'old' ? record : next);
  assert.deepEqual(await read(), next);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), [`control-${port}.json`]);
});

test('handover matches the live peer to its record and retries binding until the old listener releases', { timeout: 3000 }, async (t) => {
  const { dispose } = await tempHome();
  t.after(dispose);
  const token = '9a'.repeat(32);
  const instanceId = 'live-owner';
  const requests = [];
  let probes = 0;
  const owner = createServer((req, res) => {
    if (req.url === '/health') {
      probes++;
      res.end(JSON.stringify({ server: 'jupyter-vscode-mcp', instanceId }));
    } else {
      requests.push(req.headers['x-jmcp-control-token']);
      res.writeHead(202, { Connection: 'close' }).end();
      if (requests.length === 1) setTimeout(() => owner.close(), 70);
    }
  });
  owner.listen(0, '127.0.0.1');
  await once(owner, 'listening');
  t.after(() => owner.close());
  const { port } = owner.address();
  const record = { pid: process.pid, instanceId, port, token, workspaceFolders: [], startedAt: Date.now() };
  await writeControlFile({ ...record, instanceId: 'stale-owner', token: '00'.repeat(32) });
  const contender = createServer();
  t.after(() => contender.close());
  let tries = 0;
  const bind = async () => {
    tries++;
    // Publish the correct record only after the first retry found the stale one.
    if (tries === 1) await writeControlFile(record);
    contender.listen(port, '127.0.0.1');
    await once(contender, 'listening');
  };
  await takeOverPort(port, bind);
  assert.ok(probes > 1 && tries > 1);
  assert.ok(requests.length > 0);
  assert.ok(requests.every((header) => header === token));
  assert.equal(contender.address().port, port);
});
