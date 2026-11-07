// Serves the browser agent's test page (fixtures/agent-fixture.html) on 127.0.0.1 only, at
// /__anus_agent_fixture__/, and counts feedback-form submissions so tests can check that a
// declined approval sent nothing.
//   node chromium/tests/fixture-server.mjs [port]     # prints the page's URL
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const PREFIX = '/__anus_agent_fixture__/';

export function startFixtureServer(port = 0) {
  let submissions = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === PREFIX || url.pathname === `${PREFIX}index.html`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(here, 'fixtures/agent-fixture.html')));
    }
    if (url.pathname === `${PREFIX}submit` && req.method === 'POST') {
      submissions++;
      req.resume();
      res.writeHead(303, { location: `${PREFIX}?sent=1` });
      return res.end();
    }
    if (url.pathname === `${PREFIX}submissions`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ submissions }));
    }
    res.writeHead(404).end('Not found');
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({ server, url: `http://127.0.0.1:${actual}${PREFIX}`, submissions: () => submissions });
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startFixtureServer(Number(process.argv[2] ?? 4711));
  console.log(url);
}
