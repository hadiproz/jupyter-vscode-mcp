import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { loadExtension, tempHome } from './load-extension.mjs';

const { activate, deactivate, JupyterApi, McpServerManager, vscode } = await loadExtension('smoke');
const { testing, commands } = vscode;
const legacyVersion = '2025-11-25';
const modernVersion = '2026-07-28';
const clientInfo = { name: 'smoke', version: '2.0.0' };
const acceptBoth = 'application/json, text/event-stream';
const notebookExecute = 'notebook.cell.execute';
const output = (text) => [{ items: [{ mime: 'application/vnd.code.notebook.stdout', data: Buffer.from(text) }] }];
const finished = (executionOrder) => ({ success: true, executionOrder, timing: { startTime: 100, endTime: 112 } });
const expectedTools = [
  'jupyter_list_open_notebooks', 'jupyter_get_summary', 'jupyter_get_cell_source', 'jupyter_run_cells',
  'jupyter_get_status', 'jupyter_interrupt_kernel', 'jupyter_edit_cell', 'jupyter_insert_cell',
  'jupyter_delete_cell', 'jupyter_save_notebook', 'jupyter_create_notebook', 'jupyter_get_outputs',
  'jupyter_get_variables', 'jupyter_get_pip_packages', 'jupyter_install_packages', 'jupyter_select_kernel', 'jupyter_restart_kernel',
];

let requestId = 0;
function post(endpoint, method, params, headers = {}, options = {}) {
  return fetch(endpoint, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: acceptBoth, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: method.startsWith('notifications/') ? undefined : ++requestId, method, params }),
  });
}

function initialize(endpoint) {
  return post(endpoint, 'initialize', { protocolVersion: legacyVersion, capabilities: {}, clientInfo });
}

async function legacyHeaders(endpoint) {
  const response = await initialize(endpoint);
  assert.equal(response.status, 200);
  const session = response.headers.get('mcp-session-id');
  assert.ok(session);
  const body = await response.json();
  assert.equal(body.result?.protocolVersion, legacyVersion);
  assert.equal(body.result.serverInfo.name, 'jupyter-vscode-mcp');
  const headers = { 'Mcp-Session-Id': session, 'Mcp-Protocol-Version': legacyVersion };
  const initialized = await post(endpoint, 'notifications/initialized', undefined, headers);
  assert.equal(initialized.status, 202);
  return headers;
}

function modernPost(endpoint, method, params, progressToken, options) {
  return post(endpoint, method, {
    ...params,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': modernVersion,
      'io.modelcontextprotocol/clientInfo': clientInfo,
      'io.modelcontextprotocol/clientCapabilities': {},
      ...(progressToken === undefined ? {} : { progressToken }),
    },
  }, { 'Mcp-Protocol-Version': modernVersion, 'Mcp-Method': method, ...(params?.name ? { 'Mcp-Name': params.name } : {}) }, options);
}

function toolData(body) {
  assert.ok(body.result && !body.result.isError, JSON.stringify(body));
  return JSON.parse(body.result.content[0].text);
}

function assertTools(tools) {
  assert.deepEqual(tools.map(({ name }) => name).sort(), [...expectedTools].sort());
  assert.equal(tools.some(({ name }) => name === 'jupyter_wait_until_idle'), false);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) assert.equal(typeof tool.annotations[hint], 'boolean');
  }
  const run = tools.find(({ name }) => name === 'jupyter_run_cells');
  const { waitTimeoutSec, includeOutputs } = run.inputSchema.properties;
  assert.deepEqual([waitTimeoutSec.minimum, waitTimeoutSec.maximum, waitTimeoutSec.default, includeOutputs.default], [0, 300, 30, true]);
}

async function liveServer(t) {
  testing.reset();
  const { home, dispose } = await tempHome();
  const context = testing.createContext(home);
  const api = new JupyterApi(context);
  testing.setWorkspaceFolders(home);
  const notebook = testing.openNotebook(path.join(home, 'demo.ipynb'), ['print(42)\nprint(7)']);
  const kernel = testing.createKernel();
  testing.setKernel(notebook, kernel);
  const manager = new McpServerManager(api, 0, '2.0.0', { workspaceFolders: () => [home] });
  t.after(async () => {
    await manager.stop();
    api.clearAllState();
    for (const item of context.subscriptions) item.dispose();
    await dispose();
  });
  await manager.start();
  return { home, manager, endpoint: manager.endpoint, notebook, kernel };
}

function requestStatus(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function* sseMessages(response) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const json = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (json) yield JSON.parse(json);
    }
  }
}

test('2025-11-25 initializes a session, lists and calls all 17 tools, and rejects unknown tools', { timeout: 10_000 }, async (t) => {
  const { endpoint, home, notebook, kernel } = await liveServer(t);
  const uri = notebook.uri.toString();
  const invoked = [];
  for (const name of ['jupyter.interruptkernel', 'jupyter.restartkernel', 'notebook.selectKernel']) {
    commands.registerCommand(name, () => { invoked.push(name); });
  }
  commands.registerCommand(notebookExecute, ({ document, ranges, autoReveal }) => {
    assert.equal(document, notebook.uri);
    assert.deepEqual(ranges, [{ start: 0, end: 1 }]);
    assert.equal(autoReveal, false);
    testing.changeCell(notebook.cellAt(0), finished(1), output('edited\n'));
  });
  commands.registerCommand('jupyter.listPipPackages', () => [{ name: 'pandas', version: '2.3.0' }]);
  kernel.executeCode = async function* (code) {
    if (code.includes('JMCP_RT:')) yield output('JMCP_RT:3.12.4|linux|x86_64')[0];
    if (code.includes('JMCP_VARS:')) yield output('JMCP_VARS:[{"name":"x","type":"int","preview":"42"}]')[0];
    if (code.includes('JMCP_INSTALL:')) yield output('JMCP_INSTALL:{"exit_code":0,"resolved":{"pandas":"2.3.0"},"tail":"ok"}')[0];
  };

  const headers = await legacyHeaders(endpoint);
  const list = await post(endpoint, 'tools/list', undefined, headers);
  assert.equal(list.status, 200);
  assertTools((await list.json()).result.tools);
  for (const alias of ['/', '/sse']) {
    const response = await post(new URL(alias, endpoint), 'tools/list', undefined, headers);
    assert.equal((await response.json()).result.tools.length, 17);
  }

  const call = async (name, args = {}) => toolData(await (await post(endpoint, 'tools/call', { name, arguments: args }, headers)).json());
  assert.equal((await call('jupyter_list_open_notebooks'))[0].name, 'demo.ipynb');
  const summary = await call('jupyter_get_summary', { uri });
  const { id, i } = summary.cells[0];
  assert.equal(i, 0);
  assert.match(id, /^#NB-[0-9a-f]{8}$/);
  assert.equal((await call('jupyter_get_cell_source', { uri, id, offset: 1, limit: 1 })).source, 'print(7)');
  assert.equal((await call('jupyter_edit_cell', { uri, id, source: 'print("edited")' })).id, id);
  const inserted = await call('jupyter_insert_cell', { uri, index: 1, kind: 'markdown', source: '# Title' });
  assert.equal(inserted.kind, 'markdown');
  assert.equal((await call('jupyter_delete_cell', { uri, id: inserted.id })).deletedIndex, 1);
  assert.equal((await call('jupyter_save_notebook', { uri })).dirty, false);
  const run = await call('jupyter_run_cells', { uri, ids: [id] });
  assert.equal(run.status, 'completed');
  assert.equal(run.cells[0].outputs[0].text, 'edited\n');
  assert.deepEqual((await call('jupyter_get_outputs', { uri, id })).artifacts, run.cells[0].outputs);
  const status = await call('jupyter_get_status', { uri });
  assert.equal(status.pythonVersion, '3.12.4');
  assert.equal(status.recentCompletions[0].elapsedMs, 12);
  assert.equal((await call('jupyter_get_variables', { uri })).variables[0].name, 'x');
  assert.equal((await call('jupyter_get_pip_packages', { uri })).packages[0].name, 'pandas');
  assert.equal((await call('jupyter_install_packages', { uri, packages: ['pandas'] })).installed, true);
  assert.equal((await call('jupyter_select_kernel', { uri })).kernelLanguage, 'python');
  assert.equal((await call('jupyter_interrupt_kernel', { uri })).interrupted, true);
  assert.equal((await call('jupyter_restart_kernel', { uri })).restarted, true);
  assert.deepEqual(invoked, ['notebook.selectKernel', 'jupyter.interruptkernel', 'jupyter.restartkernel']);
  const created = await call('jupyter_create_notebook', { path: 'new.ipynb', kernelName: 'python3' });
  assert.equal(created.success, true);
  const saved = JSON.parse(await readFile(path.join(home, 'new.ipynb'), 'utf8'));
  assert.equal(saved.metadata.kernelspec.name, 'python3');

  const invalid = await post(endpoint, 'tools/call', { name: 'jupyter_create_notebook', arguments: {} }, headers);
  assert.equal((await invalid.json()).result?.isError, true);
  const unknown = await post(endpoint, 'tools/call', { name: 'jupyter_nonexistent_tool' }, headers);
  assert.equal((await unknown.json()).error?.code, -32602);
});

test('HTTP guards enforce content type, body size, Host, Origin and handover authentication', { timeout: 5000 }, async (t) => {
  const { endpoint, home } = await liveServer(t);
  const health = await fetch(new URL('/health', endpoint));
  const data = await health.json();
  assert.equal(health.status, 200);
  assert.deepEqual(data, {
    status: 'ok', server: 'jupyter-vscode-mcp', version: '2.0.0', protocolEras: [modernVersion, legacyVersion],
    instanceId: data.instanceId, workspaceFolders: [home], endpoints: ['/mcp'],
  });
  assert.ok(data.instanceId);
  const missing = await fetch(new URL('/unknown', endpoint));
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /Use \/mcp/);

  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const httpPost = (headers, payload = body) => requestStatus(endpoint, { method: 'POST', headers }, payload);
  assert.equal(await httpPost({}), 415);
  assert.equal(await httpPost({ 'Content-Type': 'text/plain' }), 415);
  assert.equal(await httpPost({ 'Content-Type': 'application/json' }, '{x'), 400);
  assert.equal(await httpPost({ 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, Buffer.alloc(4 * 1024 * 1024 + 1, 32)), 413);
  assert.equal(await httpPost({ Host: 'invalid.example', 'Content-Type': 'application/json' }), 403);
  assert.equal(await httpPost({ Origin: 'https://invalid.example', 'Content-Type': 'application/json' }), 403);
  const denied = await fetch(new URL('/_internal/handover', endpoint), { method: 'POST', headers: { 'X-Jmcp-Control-Token': '00'.repeat(32) } });
  assert.equal(denied.status, 403);
  await denied.json();
  assert.equal((await (await fetch(new URL('/health', endpoint))).json()).instanceId, data.instanceId);
});

test('legacy sessions are capped at 32, support GET and DELETE, and return 404 when stale', { timeout: 5000 }, async (t) => {
  const { endpoint } = await liveServer(t);
  const sessions = await Promise.all(Array.from({ length: 32 }, () => legacyHeaders(endpoint)));
  const capped = await initialize(endpoint);
  assert.equal(capped.status, 503);
  await capped.json();

  const session = sessions[0];
  const listen = await fetch(endpoint, { headers: { ...session, Accept: 'text/event-stream' }, signal: AbortSignal.timeout(3000) });
  assert.equal(listen.status, 200);
  assert.match(listen.headers.get('content-type'), /^text\/event-stream/);
  const ended = await fetch(endpoint, { method: 'DELETE', headers: { ...session, Accept: acceptBoth } });
  assert.equal(ended.status, 200);
  await listen.body.cancel();
  const stale = await post(endpoint, 'tools/list', undefined, session);
  assert.equal(stale.status, 404);
  assert.equal((await stale.json()).error.code, -32001);
  assert.ok((await legacyHeaders(endpoint))['Mcp-Session-Id']);
});

test('2026-07-28 serves stateless discovery and JSON calls, then streams progress and a keepalive for a slow cell', { timeout: 15_000 }, async (t) => {
  const { endpoint, notebook, kernel } = await liveServer(t);
  const discover = await modernPost(endpoint, 'server/discover');
  assert.equal(discover.status, 200);
  assert.match(discover.headers.get('content-type'), /^application\/json/);
  assert.equal(discover.headers.get('mcp-session-id'), null);
  assert.ok((await discover.json()).result.supportedVersions.includes(modernVersion));
  const list = await modernPost(endpoint, 'tools/list');
  assertTools((await list.json()).result.tools);
  const fast = await modernPost(endpoint, 'tools/call', { name: 'jupyter_list_open_notebooks' });
  assert.match(fast.headers.get('content-type'), /^application\/json/);
  assert.equal(toolData(await fast.json())[0].name, 'demo.ipynb');

  let dispatched = false;
  commands.registerCommand(notebookExecute, () => { dispatched = true; kernel.setStatus('busy'); });
  const response = await modernPost(endpoint, 'tools/call', {
    name: 'jupyter_run_cells', arguments: { start: 0, end: 1, waitTimeoutSec: 12 },
  }, 0, { signal: AbortSignal.timeout(14_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const progress = [];
  let result;
  for await (const message of sseMessages(response)) {
    if (message.method === 'notifications/progress') {
      assert.equal(message.params.progressToken, 0);
      assert.equal(message.params.total, 1);
      progress.push(message.params);
      if (message.params.message.includes('still running')) {
        assert.equal(dispatched, true);
        testing.changeCell(notebook.cellAt(0), finished(1), output('slow cell done\n'));
        kernel.setStatus('idle');
      }
    } else {
      result = toolData(message);
    }
  }
  assert.deepEqual(progress.map(({ progress: done }) => done), [0, 0.01, 1]);
  assert.match(progress[0].message, /^Starting cell/);
  assert.match(progress[1].message, /still running/);
  assert.equal(result.status, 'completed');
  assert.equal(result.cells[0].outputs[0].text, 'slow cell done\n');
});

test('live handover releases keep-alive and SSE sockets, clears old state and lets a yielded window reclaim the same port', { timeout: 10_000 }, async (t) => {
  testing.reset();
  const { home, dispose } = await tempHome();
  const context = testing.createContext(home);
  const agent = new http.Agent({ keepAlive: true });
  let replacement;
  t.after(async () => {
    await replacement?.stop();
    await deactivate();
    for (const item of context.subscriptions) item.dispose();
    agent.destroy();
    await dispose();
  });
  testing.setSetting('jupyter-vscode-mcp.mcpPort', 0);
  const folderA = path.join(home, 'window-a');
  const folderB = path.join(home, 'window-b');
  testing.setWorkspaceFolders(folderA);
  const notebook = testing.openNotebook(path.join(folderA, 'demo.ipynb'), ['print(1)', 'print(2)']);
  await activate(context);
  const statusItem = testing.statusItems[0];
  assert.equal(statusItem.visible, true);
  const port = Number(statusItem.text.match(/:(\d+)$/)?.[1]);
  assert.ok(port > 0);
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const healthURL = new URL('/health', endpoint);
  const first = await (await fetch(healthURL)).json();
  assert.deepEqual(first.workspaceFolders, [folderA]);
  assert.equal(await requestStatus(healthURL, { agent }), 200);
  const session = await legacyHeaders(endpoint);
  const legacyStream = await fetch(endpoint, { headers: { ...session, Accept: 'text/event-stream' }, signal: AbortSignal.timeout(8000) });
  assert.equal(legacyStream.status, 200);
  testing.changeCell(notebook.cellAt(0), finished(1));
  testing.changeCell(notebook.cellAt(1), { executionOrder: 2 });
  const toolStatus = async () => toolData(await (await modernPost(endpoint, 'tools/call', { name: 'jupyter_get_status' })).json());
  const tracked = await toolStatus();
  assert.equal(tracked.recentCompletions.length, 1);
  assert.equal(tracked.runningCells.length, 1);

  const contender = new McpServerManager(new JupyterApi(context), port, '2.0.0', { workspaceFolders: () => [folderB] });
  replacement = contender;
  await assert.rejects(contender.start('fail'), /Ownership mode "fail"/);
  assert.equal((await (await fetch(healthURL)).json()).instanceId, first.instanceId);
  await contender.start();
  assert.equal(statusItem.text, '$(circle-slash) Jupyter MCP (yielded)');
  assert.equal(statusItem.command, 'jupyter-vscode-mcp.reclaimPort');
  assert.equal((await legacyStream.body.getReader().read()).done, true);
  const newOwner = await (await fetch(healthURL)).json();
  assert.notEqual(newOwner.instanceId, first.instanceId);
  assert.deepEqual(newOwner.workspaceFolders, [folderB]);
  assert.equal((await (await modernPost(endpoint, 'tools/list')).json()).result.tools.length, 17);
  await (await post(endpoint, 'tools/list', undefined, session)).json().then(({ error }) => assert.equal(error.code, -32001));

  testing.setSetting('jupyter-vscode-mcp.mcpPort', port);
  await commands.executeCommand('jupyter-vscode-mcp.reclaimPort');
  assert.equal(contender.running, false);
  assert.equal(contender.yielded, true);
  assert.equal(statusItem.text, `$(radio-tower) Jupyter MCP :${port}`);
  assert.deepEqual((await (await fetch(healthURL)).json()).workspaceFolders, [folderA]);
  const reclaimed = await toolStatus();
  assert.deepEqual(reclaimed.runningCells, []);
  assert.deepEqual(reclaimed.recentCompletions, []);

  testing.changeCell(notebook.cellAt(0), finished(3));
  testing.changeCell(notebook.cellAt(1), { executionOrder: 4 });
  testing.setWorkspaceFolders(folderB);
  assert.deepEqual((await (await fetch(healthURL)).json()).workspaceFolders, [folderB]);
  const afterFolderChange = await toolStatus();
  assert.deepEqual(afterFolderChange.runningCells, []);
  assert.deepEqual(afterFolderChange.recentCompletions, []);
});

test('an unrelated process keeps the port and the extension offers Open Settings', { timeout: 5000 }, async (t) => {
  testing.reset();
  const { home, dispose } = await tempHome();
  const context = testing.createContext(home);
  const owner = http.createServer((_req, res) => res.end('unrelated process'));
  owner.listen(0, '127.0.0.1');
  await once(owner, 'listening');
  t.after(async () => {
    await deactivate();
    for (const item of context.subscriptions) item.dispose();
    await new Promise((resolve) => owner.close(resolve));
    await dispose();
  });
  const { port } = owner.address();
  let opened;
  commands.registerCommand('workbench.action.openSettings', (setting) => { opened = setting; });
  testing.setSetting('jupyter-vscode-mcp.mcpPort', port);
  await activate(context);
  assert.deepEqual(testing.errorMessages[0].actions, ['Open Settings']);
  assert.match(testing.errorMessages[0].message, new RegExp(`MCP port ${port} is already in use`));
  assert.equal(opened, 'jupyter-vscode-mcp.mcpPort');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/health`)).text(), 'unrelated process');
});
