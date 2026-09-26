/**
 * Spike: migrate jupyter-vscode-mcp McpServerManager (v1 pattern) → MCP SDK v2
 * Validates: createMcpHandler + toNodeHandler on plain node:http, low-level
 * setRequestHandler('tools/list') with raw JSON Schema tools, dual-era serving,
 * localhost guards, and behavior deltas vs the v1 smoke test.
 */
import http from 'node:http';
import { createMcpHandler, Server, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';


const parseBody = async (res) => {
  const t = await res.text();
  if (t.includes('event:')) return JSON.parse(t.split('\n').find((l) => l.startsWith('data:')).slice(6));
  return JSON.parse(t);
};

// --- repo's TOOLS (subset) -------------------------------------------------
const TOOLS = [
  { name: 'jupyter_list_open_notebooks', description: 'List open notebooks.', inputSchema: { type: 'object', properties: {} } },
  { name: 'jupyter_create_notebook', description: 'Create a notebook.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'jupyter_nonexistent_arg_test', description: 'Echo args.', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } },
];

const fakeApi = {
  listOpenNotebooks: () => [{ uri: 'file:///w/demo.ipynb', name: 'demo.ipynb' }],
  createNotebook: async (p) => ({ success: true, path: p }),
};

// --- factory (per-request server) ------------------------------------------
function factory() {
  const server = new Server({ name: 'jupyter-mcp-vscode', version: '1.0.0-spikes' }, { capabilities: { tools: {} } });

  server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      let result;
      switch (name) {
        case 'jupyter_list_open_notebooks': result = fakeApi.listOpenNotebooks(); break;
        case 'jupyter_create_notebook': {
          const p = args.path;
          if (!p) throw new Error('Missing path');
          result = await fakeApi.createNotebook(p);
          break;
        }
        case 'jupyter_nonexistent_arg_test': result = { n: args.n ?? null }; break;
        default:
          throw new Error(`Unknown tool: ${name}. Available tools: ${TOOLS.map((t) => t.name).join(', ')}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  });

  return server;
}

// --- handler + node wiring --------------------------------------------------
const handler = createMcpHandler(factory, { legacy: 'stateless' });
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const port = 21000 + Math.floor(Math.random() * 1000);
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' :: ' + extra}`);
  if (!cond) failures++;
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, mcp-protocol-version');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'jupyter-mcp-vscode', version: 'spike' }));
    return;
  }
  if (pathname === '/mcp' || pathname === '/sse' || pathname === '/') {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void nodeHandler(req, res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: `Unknown path ${pathname}. Use /mcp (or legacy /sse). Health probe: GET /health.` }));
});

await new Promise((r) => server.listen(port, '127.0.0.1', r));
console.log(`spike listening on 127.0.0.1:${port}  (LATEST=${LATEST_PROTOCOL_VERSION}, supported=${JSON.stringify(SUPPORTED_PROTOCOL_VERSIONS)})`);

const base = `http://127.0.0.1:${port}`;
const J = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

try {
  // 1. health
  const h = await fetch(`${base}/health`);
  check('GET /health 200', h.status === 200 && (await h.json()).status === 'ok');

  // 2. unknown path
  const nf = await fetch(`${base}/nope`, { method: 'POST' });
  check('unknown path -> 404 JSON hint', nf.status === 404 && (await nf.json()).error.includes('/mcp'));

  // 3. initialize with 2025-11-25 (repo's current era)
  const initRes = await fetch(`${base}/mcp`, {
    method: 'POST', headers: J,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'spike', version: '0.0.1' } } }),
  });
  const sess = initRes.headers.get('mcp-session-id');
  const ct = initRes.headers.get('content-type');
  const text = await initRes.text();
  const body = text.includes('event:') ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(6)) : JSON.parse(text);
  console.log(`   [init] status=${initRes.status} session=${sess ?? '(none)'} content-type=${ct} proto=${body.result?.protocolVersion}`);
  check('initialize 2025-11-25 ok', initRes.status === 200 && body.result?.protocolVersion === '2025-11-25', text.slice(0, 200));
  console.log(`   [init] session header: ${sess ? 'PRESENT (sessionful)' : 'ABSENT (stateless)'}`);

  // 4. initialized notification
  const nRes = await fetch(`${base}/mcp`, { method: 'POST', headers: J, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  check('notifications/initialized accepted', nRes.status === 200 || nRes.status === 202, `status=${nRes.status}`);

  // 5. tools/list (with & without bogus session header)
  const t1 = await fetch(`${base}/mcp`, { method: 'POST', headers: J, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  const t1b = await parseBody(t1);
  check('tools/list (no session header)', t1.status === 200 && t1b.result?.tools?.length === 3, JSON.stringify(t1b).slice(0, 300));
  const t2 = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...J, 'mcp-session-id': 'bogus-session' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) });
  const t2b = await parseBody(t2);
  console.log(`   [bogus-session] status=${t2.status} (v1 returned 404)`);
  check('bogus session id tolerated (stateless)', t2.status === 200 && t2b.result?.tools?.length === 3, `status=${t2.status}`);

  // 6. tools/call happy path
  const c1 = await fetch(`${base}/mcp`, { method: 'POST', headers: J, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'jupyter_list_open_notebooks', arguments: {} } }) });
  const c1b = await parseBody(c1);
  check('tools/call roundtrip', c1.status === 200 && JSON.parse(c1b.result.content[0].text)[0].name === 'demo.ipynb', JSON.stringify(c1b).slice(0, 300));

  // 7. tools/call missing required arg -> isError (repo behavior)
  const c2 = await fetch(`${base}/mcp`, { method: 'POST', headers: J, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'jupyter_create_notebook', arguments: {} } }) });
  const c2b = await parseBody(c2);
  check('missing arg -> isError content (no SDK validation)', c2b.result?.isError === true && c2b.result.content[0].text.includes('Missing path'), JSON.stringify(c2b).slice(0, 300));

  // 8. unknown tool -> isError with list
  const c3 = await fetch(`${base}/mcp`, { method: 'POST', headers: J, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } }) });
  const c3b = await parseBody(c3);
  check('unknown tool -> isError + Available tools', c3b.result?.isError === true && c3b.result.content[0].text.includes('Available tools:'), JSON.stringify(c3b).slice(0, 300));

  // 9. GET /mcp (v1 allowed SSE stream; stateless legacy = 405)
  const g = await fetch(`${base}/mcp`, { headers: J });
  console.log(`   [GET /mcp] status=${g.status}`);

  // 10. Host header guard (DNS rebinding) — raw http, fetch forbids Host override
  const evilStatus = await new Promise((resolve) => {
    const q = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: { Host: 'evil.example.com', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } },
      (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    q.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }));
  });
  console.log(`   [evil Host raw] status=${evilStatus} (guard active if 403)`);
  check('evil Host rejected by guard', evilStatus === 403, String(evilStatus));

  // 10b. Accept negotiation (spec): a POST client must accept both media types;
  // JSON-only Accept is rejected with 406 + an actionable JSON-RPC error.
  const jInit = await fetch(`${base}/mcp`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'curlish', version: '0' } } }) });
  const jStatus = jInit.status;
  const jText = await jInit.text();
  console.log(`   [Accept: application/json only] status=${jStatus}`);
  check('JSON-only Accept -> 406 actionable error (spec requires both)', jStatus === 406 && jText.includes('must accept both'), `${jStatus} :: ${jText.slice(0, 120)}`);

  // 10c. official v2 Client — auto negotiation should land on modern (2026-07-28)
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const auto = new Client({ name: 'spike-auto', version: '0.0.1' }, { versionNegotiation: { mode: 'auto' } });
  await auto.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const autoEra = auto.getProtocolEra();
  const autoTools = await auto.listTools();
  console.log(`   [client auto] era=${autoEra} tools=${autoTools.tools.length}`);
  check('v2 Client mode:auto lands on modern era', autoEra === 'modern', String(autoEra));
  check('modern-era tools/list works', autoTools.tools.length === 3, JSON.stringify(autoTools).slice(0, 200));
  await auto.close();

  // 10d. default v2 Client → legacy handshake must still work
  const leg = new Client({ name: 'spike-legacy', version: '0.0.1' });
  await leg.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const legEra = leg.getProtocolEra();
  const legTools = await leg.listTools();
  console.log(`   [client default] era=${legEra} tools=${legTools.tools.length}`);
  check('v2 Client default lands on legacy era', legEra === 'legacy', String(legEra));
  check('legacy-era tools/list works', legTools.tools.length === 3);
  await leg.close();

  // 11. legacy initialize offering 2026-07-28 must downgrade to 2025-11-25 (correct legacy negotiation)
  const m = await fetch(`${base}/mcp`, {
    method: 'POST', headers: J,
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'spike', version: '0.0.1' } } }),
  });
  const mtext = await m.text();
  let mbody; try { mbody = mtext.includes('event:') ? JSON.parse(mtext.split('\n').find((l) => l.startsWith('data:')).slice(6)) : JSON.parse(mtext); } catch { mbody = null; }
  console.log(`   [init offering 2026] echoed=${mbody?.result?.protocolVersion}`);
  check('initialize offering 2026 downgrades to 2025-11-25', m.status === 200 && mbody?.result?.protocolVersion === '2025-11-25', mtext.slice(0, 200));
} finally {
  await handler.close();
  server.close();
}
console.log(failures ? `\n${failures} FAILURES` : '\nALL SPIKE CHECKS PASSED');
process.exit(failures ? 1 : 0);
