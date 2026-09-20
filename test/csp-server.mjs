/**
 * Serves the app locally WITH the production CSP from vercel.json.
 *
 * This exists because a plain static server sends no CSP, and the app's most
 * important failure mode only appears when one is present: the previewed
 * document inherits the host policy, so a `script-src` without 'unsafe-inline'
 * silently stops every pasted script from running. Testing without the real
 * headers hides that entirely.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Read the CSP from vercel.json so the test cannot drift from the deployment.
const config = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));
const headers = Object.fromEntries(
  config.headers[0].headers.map((h) => [h.key, h.value])
);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
};

const port = Number(process.env.PORT || 8898);

createServer(async (req, res) => {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': (TYPES[extname(file)] || 'application/octet-stream') + '; charset=utf-8',
      ...headers,
    });
    res.end(body);
  } catch {
    res.writeHead(404, headers);
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${port} with the production CSP`);
});
