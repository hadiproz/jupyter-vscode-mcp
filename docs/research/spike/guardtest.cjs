const http = require('node:http');
const { localhostHostValidation, localhostOriginValidation } = require('@modelcontextprotocol/node');
const vh = localhostHostValidation(); const vo = localhostOriginValidation();
const s = http.createServer((req, res) => {
  if (!vh(req, res) || !vo(req, res)) return;
  res.writeHead(200); res.end('ok');
});
s.listen(21999, '127.0.0.1', () => {
  const tryReq = (label, headers) => new Promise((r) => {
    const q = http.request({ host: '127.0.0.1', port: 21999, path: '/', method: 'GET', headers }, (res) => {
      console.log(label, '->', res.statusCode); res.resume(); res.on('end', r);
    });
    q.end();
  });
  (async () => {
    await tryReq('normal Host (127.0.0.1)', { Host: '127.0.0.1:21999' });
    await tryReq('forged Host (evil.example.com)', { Host: 'evil.example.com' });
    await tryReq('Host: localhost', { Host: 'localhost:21999' });
    await tryReq('evil Origin', { Host: '127.0.0.1:21999', Origin: 'https://evil.example.com' });
    await tryReq('localhost Origin', { Host: '127.0.0.1:21999', Origin: 'http://localhost:3000' });
    await tryReq('no Origin (curl/agent)', { Host: '127.0.0.1:21999' });
    s.close(); process.exit(0);
  })();
});
