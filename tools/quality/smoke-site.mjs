#!/usr/bin/env node
/**
 * HTTP smoke check. Serves the tracked files the way GitHub Pages does (index.html for directories, 404.html with status 404 for
 * anything unknown, no directory listings) and requests every page and everything it references. Scripts must parse. No browser, no
 * dependencies. Exit 0 when clean, 1 otherwise.
 *
 *   node tools/quality/smoke-site.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { cssReferences, loadConfig, localTarget, parseHtml } from './check-site.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };

export function startSite(root) {
  const files = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 }).split('\u0000').filter(Boolean).filter((p) => existsSync(join(root, p))));
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1);
    const file = !pathname || pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const found = files.has(file);
    const served = found ? file : '404.html';
    if (!files.has(served)) { res.writeHead(404); res.end(); return; }
    res.writeHead(found ? 200 : 404, { 'content-type': TYPES[extname(served)] ?? 'application/octet-stream' });
    res.end(readFileSync(join(root, served)));
  });
  return new Promise((ok) => { server.listen(0, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })); });
}

function nodesOf(node, out = []) {
  for (const c of node.children) { if (c.name !== '#text') out.push(c); nodesOf(c, out); }
  return out;
}

const scriptProblem = (code) => {
  try { new vm.Script(code); return null; } catch (e) { return e.message; }
};

export async function smokeSite(root, config) {
  const failures = [];
  let requests = 0;
  const { server, base } = await startSite(root);
  const get = async (path) => { requests += 1; return fetch(base + path, { redirect: 'manual' }); };
  try {
    const assets = new Set();
    for (const page of config.smoke.pages) {
      const res = await get(page.path);
      const body = await res.text();
      if (res.status !== 200) { failures.push(`${page.path} returned ${res.status}`); continue; }
      if (!/text\/html/.test(res.headers.get('content-type') ?? '')) failures.push(`${page.path} is not served as HTML`);
      const tree = parseHtml(body);
      const nodes = nodesOf(tree.root);
      const title = nodes.find((n) => n.name === 'title')?.text.trim() ?? '';
      if (!title.includes(page.title)) failures.push(`${page.path} title "${title}" does not contain "${page.title}"`);
      for (const needle of page.contains ?? []) if (!body.includes(needle)) failures.push(`${page.path} is missing expected text "${needle}"`);
      const file = localTarget(page.path, 'index.html', config.origin).file;
      for (const n of nodes) {
        if (n.name === 'script' && !n.attrs.src && !/json|importmap|module/.test(n.attrs.type ?? '')) {
          const problem = scriptProblem(n.text);
          if (problem) failures.push(`${page.path} inline script on line ${n.line}: ${problem}`);
        }
        for (const attr of ['src', 'href']) {
          if (!(attr in n.attrs) || (attr === 'href' && n.name === 'a')) continue;
          const target = localTarget(n.attrs[attr], file, config.origin);
          if (target) assets.add(target.file);
        }
      }
    }
    for (const asset of assets) {
      const res = await get(`/${asset}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (res.status !== 200) { failures.push(`/${asset} returned ${res.status}`); continue; }
      if (!bytes.length) failures.push(`/${asset} is empty`);
      if (asset.endsWith('.js')) { const problem = scriptProblem(bytes.toString('utf8')); if (problem) failures.push(`/${asset}: ${problem}`); }
      if (asset.endsWith('.css')) {
        for (const ref of cssReferences(bytes.toString('utf8'))) {
          const target = localTarget(ref, asset, config.origin);
          if (!target) continue;
          const nested = await get(`/${target.file}`);
          await nested.arrayBuffer();
          if (nested.status !== 200) failures.push(`/${target.file} (from ${asset}) returned ${nested.status}`);
        }
      }
    }
    const missing = await get('/quality-smoke-does-not-exist');
    const missingBody = await missing.text();
    if (config.smoke.notFound) {
      if (missing.status !== 404) failures.push(`an unknown path returned ${missing.status}, expected 404`);
      if (!missingBody.includes(config.smoke.notFound)) failures.push(`the 404 page does not contain "${config.smoke.notFound}"`);
    } else if (missing.status !== 404) failures.push(`an unknown path returned ${missing.status}, expected 404`);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
  return { failures, requests };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const { failures, requests } = await smokeSite(root, loadConfig(root));
  for (const f of failures) console.error(f);
  console.log(failures.length ? `${failures.length} smoke failure(s) from ${requests} request(s).` : `Smoke checks passed: ${requests} request(s).`);
  process.exitCode = failures.length ? 1 : 0;
}
