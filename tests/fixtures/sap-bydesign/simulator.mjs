import http from 'node:http';
import { once } from 'node:events';
import { syntheticCredentials, syntheticReadConfig, syntheticRows } from './synthetic.ts';

/** Test-only real HTTP server. It binds loopback, has no real credentials and
 * cannot proxy to SAP. Only the injected test transport rewrites HTTPS to here. */
export async function startByDesignSimulator(options = {}) {
  const requests = [];
  const expected = new URL(syntheticReadConfig.tenantUrl);
  const path = syntheticReadConfig.collectionPath;
  const rows = structuredClone(options.rows ?? syntheticRows);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, expected);
    requests.push({ method: req.method, path: url.pathname, skip: url.searchParams.get('$skip') });
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET' || url.pathname !== path) { res.writeHead(405); res.end('{}'); return; }
    if (req.headers.authorization !== `Basic ${Buffer.from(`${syntheticCredentials.username}:${syntheticCredentials.password}`).toString('base64')}`) { res.writeHead(401); res.end('{}'); return; }
    const call = requests.length;
    if (options.status && (!options.failOnCall || options.failOnCall === call)) {
      res.writeHead(options.status, { 'retry-after': '1', ...(options.status === 302 ? { location: 'https://untrusted.example/credentials' } : {}) });
      res.end(JSON.stringify({ error: 'SYNTHETIC_ERROR_BODY_MUST_NOT_LEAK' })); return;
    }
    if (options.malformed) { res.end('<html>Sign in</html>'); return; }
    const skip = Number(url.searchParams.get('$skip') ?? '0');
    const top = Number(url.searchParams.get('$top') ?? '100');
    const data = { results: rows.slice(skip, skip + top) };
    if (!options.offsetOnly && skip + top < rows.length) {
      url.searchParams.set('$skip', String(skip + top));
      data.__next = options.nextLink ?? url.href;
    }
    res.end(JSON.stringify({ d: data }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    requests,
    async fetch(url, init) {
      const parsed = new URL(url);
      if (parsed.origin !== expected.origin || parsed.pathname !== path) throw new Error('Fixture refuses external traffic');
      return fetch(`http://127.0.0.1:${address.port}${parsed.pathname}${parsed.search}`, init);
    },
    async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); },
  };
}
