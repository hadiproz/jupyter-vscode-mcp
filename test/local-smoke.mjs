import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
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

// MCP responses may arrive as SSE (event: message / data: …) or plain JSON,
// depending on the Accept header — parse both shapes.
async function parseBody(res) {
  const text = await res.text();
  if (text.includes('event:')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(dataLine.slice(6));
  }
  return JSON.parse(text);
}

// Raw HTTP request — needed because fetch() forbids overriding Host/Origin.
function rawRequest(port, { method = 'POST', path: reqPath = '/mcp', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

const EXPECTED_TOOLS = [
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

const port = 19000 + Math.floor(Math.random() * 2000);
const manager = new McpServerManager(fakeApi, port);

await manager.start();
try {
  const base = `http://127.0.0.1:${port}`;
  const J = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

  const health = await fetch(`${base}/health`);
  const healthBody = await health.json();
  check('GET /health 200', health.status === 200 && healthBody.status === 'ok');

  const notFound = await fetch(`${base}/nope`, { method: 'POST' });
  check('unknown path -> 404 JSON hint', notFound.status === 404 && (await notFound.json()).error.includes('/mcp'));

  // Legacy (2025-11-25) initialize handshake — stateless: no session id.
  const initRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } },
    }),
  });
  const session = initRes.headers.get('mcp-session-id');
  check('initialize ok (stateless: no session id)', initRes.status === 200 && !session, `session=${session}`);
  const initBody = await parseBody(initRes);
  check('initialize protocol version echoed', initBody.result?.protocolVersion === '2025-11-25');

  const initNotif = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  check('notifications/initialized accepted', initNotif.status === 200 || initNotif.status === 202, `status=${initNotif.status}`);

  const toolsRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  const toolsBody = await parseBody(toolsRes);
  const names = toolsBody.result.tools.map((t) => t.name);
  check(
    `tools/list has all ${EXPECTED_TOOLS.length} tools`,
    EXPECTED_TOOLS.every((n) => names.includes(n)) && names.length === EXPECTED_TOOLS.length,
    JSON.stringify(names)
  );

  async function callTool(id, name, args) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args ?? {} } }),
    });
    return parseBody(res);
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

  // Stateless tolerance: a stale/bogus session id is ignored (v1 returned 404).
  const bogusRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...J, 'mcp-session-id': 'bogus-session' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }),
  });
  const bogusBody = await parseBody(bogusRes);
  check('bogus session id tolerated (stateless)', bogusRes.status === 200 && bogusBody.result?.tools?.length === EXPECTED_TOOLS.length, `status=${bogusRes.status}`);

  // Stateless serving: session-oriented GET is 405.
  const getSse = await fetch(`${base}/mcp`, { headers: J });
  check('GET /mcp -> 405 (stateless)', getSse.status === 405, `status=${getSse.status}`);

  // Streamable HTTP Accept negotiation (spec): a POST client must accept both
  // application/json and text/event-stream; the legacy leg answers with a
  // single-message SSE frame (event: message / data: …).
  check(
    'initialize responds single-message SSE',
    (initRes.headers.get('content-type') ?? '').includes('text/event-stream'),
    initRes.headers.get('content-type') ?? '(none)'
  );
  const jsonInit = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 20,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'curlish', version: '0' } },
    }),
  });
  const jsonInitText = await jsonInit.text();
  check(
    'JSON-only Accept -> 406 with actionable JSON-RPC error',
    jsonInit.status === 406 && jsonInitText.includes('must accept both'),
    `status=${jsonInit.status} :: ${jsonInitText.slice(0, 120)}`
  );

  // Security guards (raw HTTP — fetch forbids Host/Origin overrides).
  const evilHost = await rawRequest(port, {
    headers: { Host: 'evil.example.com', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/list' }),
  });
  check('forged Host -> 403 (DNS-rebinding guard)', evilHost.status === 403, `status=${evilHost.status}`);

  const evilOrigin = await rawRequest(port, {
    headers: {
      Host: `127.0.0.1:${port}`,
      Origin: 'https://evil.example.com',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/list' }),
  });
  check('evil Origin -> 403 (origin guard)', evilOrigin.status === 403, `status=${evilOrigin.status}`);

  // Dual-era serving with the official v2 client.
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');

  const modern = new Client({ name: 'smoke-auto', version: '0.0.1' }, { versionNegotiation: { mode: 'auto' } });
  await modern.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const modernEra = modern.getProtocolEra();
  const modernTools = await modern.listTools();
  check('v2 client auto -> modern era (2026-07-28)', modernEra === 'modern', `era=${modernEra}`);
  check('modern-era tools/list complete', modernTools.tools.length === EXPECTED_TOOLS.length, `count=${modernTools.tools.length}`);
  await modern.close();

  const legacy = new Client({ name: 'smoke-legacy', version: '0.0.1' });
  await legacy.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const legacyEra = legacy.getProtocolEra();
  const legacyTools = await legacy.listTools();
  check('v2 client default -> legacy era (2025-11-25)', legacyEra === 'legacy', `era=${legacyEra}`);
  check('legacy-era tools/list complete', legacyTools.tools.length === EXPECTED_TOOLS.length, `count=${legacyTools.tools.length}`);
  await legacy.close();
} finally {
  await manager.stop();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke checks passed');
