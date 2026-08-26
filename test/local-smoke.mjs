import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

execSync(
  'npx esbuild src/mcpServer.ts --bundle --outfile=out-test/mcpServer.cjs --platform=node --format=cjs "--alias:vscode=./test/vscode-stub.cjs"',
  { cwd: root, stdio: 'inherit' }
);

const { McpServerManager } = require(path.join(root, 'out-test', 'mcpServer.cjs'));

const fakeNotebooks = [
  { uri: 'file:///w/demo.ipynb', fsPath: '/w/demo.ipynb', name: 'demo.ipynb', cellCount: 3, dirty: false },
];

const fakeApi = {
  listOpenNotebooks: () => fakeNotebooks,
  getNotebookSummary: async () => ({
    path: '/w/demo.ipynb',
    cellCount: 2,
    runtime: 'Python 3',
    dirty: false,
    kernelStatus: 'idle',
    cells: [
      { i: 0, id: '#NB-aaaa1111', kind: 'code', lang: 'python', lines: 1, exec: 'succeeded #1 5ms', outs: ['stdout'], first: 'print(1)' },
      { i: 1, id: '#NB-bbbb2222', kind: 'markdown', lang: 'markdown', lines: 1, exec: 'not-run', outs: [], first: '# Title' },
    ],
    metadata: {},
  }),
  waitUntilIdle: async (_uri, timeoutSec) => ({ idle: true, waitedMs: 10, kernelStatus: 'idle', completed: [], timeoutSec }),
  getVariables: async () => ({ kernelStatus: 'idle', count: 1, variables: [{ name: 'x', type: 'int', preview: '42' }], source: 'kernel-executeCode-probe' }),
  createNotebook: async (p, opts) => ({ success: true, path: p, cellCount: 0, kernelName: opts?.kernelName ?? 'python3' }),
};

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name} ${extra}`);
  }
}

const port = 19000 + Math.floor(Math.random() * 2000);
const manager = new McpServerManager(fakeApi, port);

await manager.start();
try {
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/health`);
  const healthBody = await health.json();
  check('GET /health 200', health.status === 200 && healthBody.status === 'ok');

  const notFound = await fetch(`${base}/nope`, { method: 'POST' });
  check('unknown path -> 404 JSON hint', notFound.status === 404 && (await notFound.json()).error.includes('/mcp'));

  const initRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } },
    }),
  });
  const session = initRes.headers.get('mcp-session-id');
  check('initialize ok + session id', initRes.status === 200 && !!session);
  const initBodyText = await initRes.text();
  const initBody = JSON.parse(initBodyText.includes('event:') ? initBodyText.split('\n').find((l) => l.startsWith('data:')).slice(6) : initBodyText);
  check('initialize protocol version echoed', initBody.result?.protocolVersion === '2025-11-25');

  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': session };

  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  const toolsRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  const toolsBody = await toolsRes.json();
  const names = toolsBody.result.tools.map((t) => t.name);
  const expected = [
    'jupyter_list_open_notebooks',
    'jupyter_get_summary',
    'jupyter_get_cell_source',
    'jupyter_run_cells',
    'jupyter_wait_until_idle',
    'jupyter_get_status',
    'jupyter_interrupt_kernel',
    'jupyter_edit_cell',
    'jupyter_insert_cell',
    'jupyter_delete_cell',
    'jupyter_save_notebook',
    'jupyter_create_notebook',
    'jupyter_get_outputs',
    'jupyter_get_variables',
    'jupyter_get_pip_packages',
    'jupyter_install_packages',
    'jupyter_select_kernel',
    'jupyter_restart_kernel',
  ];
  check(`tools/list has all ${expected.length} tools`, expected.every((n) => names.includes(n)) && names.length === expected.length, JSON.stringify(names));

  async function callTool(id, name, args) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args ?? {} } }),
    });
    return res.json();
  }

  const listRes = await callTool(3, 'jupyter_list_open_notebooks');
  const listData = JSON.parse(listRes.result.content[0].text);
  check('tools/call list_open_notebooks', Array.isArray(listData) && listData[0].name === 'demo.ipynb');

  const sumRes = await callTool(4, 'jupyter_get_summary', { uri: '/w/demo.ipynb' });
  const sumData = JSON.parse(sumRes.result.content[0].text);
  check('get_summary fake data roundtrip (stable ids, 0-based i)', sumData.cells[0].i === 0 && sumData.cells[0].id === '#NB-aaaa1111');

  const waitRes = await callTool(5, 'jupyter_wait_until_idle', { uri: '/w/demo.ipynb', timeoutSec: 1 });
  const waitData = JSON.parse(waitRes.result.content[0].text);
  check('wait_until_idle returns idle=true payload', waitData.idle === true);

  const varsRes = await callTool(6, 'jupyter_get_variables');
  const varsData = JSON.parse(varsRes.result.content[0].text);
  check('get_variables probe payload', varsData.variables?.[0]?.name === 'x');

  const createRes = await callTool(9, 'jupyter_create_notebook', { path: '/w/new.ipynb', kernelName: 'python3' });
  const createData = JSON.parse(createRes.result.content[0].text);
  check('create_notebook dispatch', createData.success === true && createData.path === '/w/new.ipynb');

  const noPathRes = await callTool(10, 'jupyter_create_notebook', {});
  check('create_notebook without path -> isError', noPathRes.result.isError === true);

  const badRes = await callTool(7, 'jupyter_nonexistent_tool');
  check('unknown tool -> isError with tool list', badRes.result.isError === true && badRes.result.content[0].text.includes('Available tools:'));

  const errRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': 'bogus-session' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }),
  });
  check('stale/bogus session -> 404', errRes.status === 404);
} finally {
  await manager.stop();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke checks passed');
