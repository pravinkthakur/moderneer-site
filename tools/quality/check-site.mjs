#!/usr/bin/env node
/**
 * Static checks for a hand-written HTML site: markup and metadata, internal links and fragments, referenced and required assets,
 * basic accessibility (lang, title, one h1, alt text, labels, accessible names) and what the deployment would publish.
 * No dependencies. Settings live in tools/quality/site.config.json. Only files tracked by Git count, matched case-sensitively,
 * because that is what GitHub Pages serves. Exit 0 when clean, 1 otherwise.
 *
 *   node tools/quality/check-site.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea']);
// The end tag of these is optional in HTML, so a missing one is not a defect
const OPTIONAL_END = new Set(['p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'html', 'head', 'body']);
const LABELLABLE = new Set(['input', 'select', 'textarea']);
const UNLABELLED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset']);
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

const TAG_ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Parses markup into a tree of { name, attrs, line, children, parent, text }. Reports problems a browser would silently repair. */
export function parseHtml(text) {
  const root = { name: '#root', attrs: {}, children: [], parent: null, text: '', line: 1 };
  const errors = [];
  const stack = [root];
  let doctype = false;
  let i = 0;
  const top = () => stack[stack.length - 1];
  const addText = (value) => { if (value) top().children.push({ name: '#text', text: value, attrs: {}, children: [], parent: top(), line: 0 }); };

  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open === -1) { addText(text.slice(i)); break; }
    addText(text.slice(i, open));
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end === -1) { errors.push({ line: lineAt(text, open), message: 'unterminated comment' }); break; }
      i = end + 3;
      continue;
    }
    if (/^<!doctype/i.test(text.slice(open, open + 9))) {
      doctype = /^<!doctype\s+html\s*>/i.test(text.slice(open, open + 40));
      i = text.indexOf('>', open) + 1;
      continue;
    }
    const closing = text[open + 1] === '/';
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(text.slice(open + (closing ? 2 : 1), open + 64));
    if (!nameMatch) { addText('<'); i = open + 1; continue; }
    const name = nameMatch[0].toLowerCase();
    // Find the end of the tag, honouring quoted attribute values (which may contain '>')
    let j = open + nameMatch[0].length + (closing ? 2 : 1);
    let quote = '';
    for (; j < text.length; j++) {
      const c = text[j];
      if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
    }
    if (j >= text.length) { errors.push({ line: lineAt(text, open), message: `unterminated <${name}> tag` }); break; }
    const line = lineAt(text, open);
    i = j + 1;
    if (closing) {
      if (VOID.has(name)) { errors.push({ line, message: `end tag for void element </${name}>` }); continue; }
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at === -1) { errors.push({ line, message: `stray end tag </${name}>` }); continue; }
      for (const skipped of stack.slice(at + 1).reverse()) {
        if (!OPTIONAL_END.has(skipped.name)) errors.push({ line, message: `</${name}> closes unclosed <${skipped.name}> from line ${skipped.line}` });
      }
      stack.length = at;
      continue;
    }
    const inner = text.slice(open + nameMatch[0].length + 1, j);
    const attrs = {};
    for (const m of inner.matchAll(TAG_ATTRIBUTE)) {
      const key = m[1].toLowerCase();
      if (key in attrs) errors.push({ line, message: `duplicate attribute "${key}" on <${name}>` });
      attrs[key] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    const node = { name, attrs, line, children: [], parent: top(), text: '' };
    top().children.push(node);
    if (VOID.has(name)) continue;
    if (inner.trimEnd().endsWith('/') && !name.includes(':') && name !== 'svg' && !hasSvgAncestor(node)) {
      errors.push({ line, message: `self-closing syntax on non-void <${name}> leaves it open` });
    }
    if (inner.trimEnd().endsWith('/')) continue;
    if (RAW_TEXT.has(name)) {
      const closeAt = text.toLowerCase().indexOf(`</${name}`, i);
      if (closeAt === -1) { errors.push({ line, message: `<${name}> is never closed` }); break; }
      node.text = text.slice(i, closeAt);
      i = text.indexOf('>', closeAt) + 1;
      continue;
    }
    stack.push(node);
  }
  for (const unclosed of stack.slice(1)) {
    if (!OPTIONAL_END.has(unclosed.name)) errors.push({ line: unclosed.line, message: `<${unclosed.name}> is never closed` });
  }
  return { root, errors, doctype };
}

function hasSvgAncestor(node) {
  for (let n = node.parent; n; n = n.parent) if (n.name === 'svg') return true;
  return false;
}

const walk = (node, visit) => { for (const c of node.children) { if (c.name !== '#text') visit(c); walk(c, visit); } };

function collect(root) {
  const out = [];
  walk(root, (n) => out.push(n));
  return out;
}

const isHidden = (n) => n.attrs['aria-hidden'] === 'true';

/** Text an assistive technology would announce for an element's contents */
function innerName(node) {
  let out = '';
  for (const c of node.children) {
    if (c.name === '#text') out += c.text;
    else if (isHidden(c)) continue;
    else if (c.name === 'img') out += ` ${c.attrs.alt ?? ''} `;
    else if (c.name === 'svg') out += ` ${c.attrs['aria-label'] ?? ''} `;
    else out += ` ${innerName(c)} `;
  }
  return out.replace(/&nbsp;/g, ' ').trim();
}

const accessibleName = (n) => (n.attrs['aria-label'] ?? '').trim() || ('aria-labelledby' in n.attrs ? 'referenced' : '') || innerName(n) || (n.attrs.title ?? '').trim();

function isLabelled(control, nodes) {
  if ((control.attrs['aria-label'] ?? '').trim() || 'aria-labelledby' in control.attrs) return true;
  for (let p = control.parent; p; p = p.parent) if (p.name === 'label') return true;
  const id = control.attrs.id;
  return Boolean(id) && nodes.some((n) => n.name === 'label' && n.attrs.for === id);
}

const decode = (s) => s.replace(/&amp;/g, '&');

/** The site-relative file a reference points at, or null when it leaves the site. A same-origin absolute URL counts as local. */
export function localTarget(reference, fromPage, origin) {
  let ref = decode(reference.trim());
  if (origin && ref.toLowerCase().startsWith(origin.toLowerCase())) ref = ref.slice(origin.length) || '/';
  if (!ref || EXTERNAL.test(ref)) return null;
  const hashAt = ref.indexOf('#');
  const fragment = hashAt === -1 ? '' : ref.slice(hashAt + 1);
  const withoutFragment = hashAt === -1 ? ref : ref.slice(0, hashAt);
  const path = withoutFragment.split('?')[0];
  if (!path) return { file: fromPage, fragment };
  const joined = path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(fromPage), path);
  const normal = posix.normalize(joined);
  const file = !normal || normal === '.' ? 'index.html' : normal.endsWith('/') ? `${normal}index.html` : normal;
  return { file, fragment };
}

/** url(...) and @import targets inside a stylesheet */
export const cssReferences = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)|@import\s+["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);

export function checkSite(root, config) {
  const findings = [];
  const report = (path, line, rule, detail) => findings.push({ path, line, rule, detail });
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 })
    .split('\u0000').filter(Boolean).filter((p) => existsSync(join(root, p)));
  const files = new Set(tracked);
  const ignored = config.ignoreHtml ?? [];
  const pages = tracked.filter((p) => p.endsWith('.html') && !ignored.some((i) => p === i || p.startsWith(i)));
  if (!pages.length) report('(site)', 0, 'no-pages', 'no HTML pages found');
  for (const required of config.requiredPages ?? []) if (!files.has(required)) report(required, 0, 'required-page-missing', 'listed in site.config.json');

  const parsed = new Map();
  for (const page of pages) parsed.set(page, parseHtml(readFileSync(join(root, page), 'utf8')));
  const idsOf = (page) => new Set(collect(parsed.get(page).root).map((n) => n.attrs.id).filter(Boolean));

  const titles = new Map();
  for (const page of pages) {
    const { root: tree, errors, doctype } = parsed.get(page);
    const nodes = collect(tree);
    const first = (name) => nodes.find((n) => n.name === name);
    const meta = (attr, value) => nodes.find((n) => n.name === 'meta' && n.attrs[attr]?.toLowerCase() === value);
    for (const e of errors) report(page, e.line, 'html-structure', e.message);
    if (!doctype) report(page, 1, 'doctype', 'must start with <!doctype html>');
    if (!first('html')?.attrs.lang?.trim()) report(page, first('html')?.line ?? 1, 'lang', '<html> needs a lang attribute');
    if (!nodes.some((n) => n.name === 'meta' && n.attrs.charset)) report(page, 1, 'charset', 'missing <meta charset>');
    if (!(meta('name', 'viewport')?.attrs.content ?? '').includes('width=device-width')) report(page, 1, 'viewport', 'missing responsive viewport meta');
    const title = first('title')?.text.trim();
    if (!title) report(page, 1, 'title', 'missing or empty <title>');
    else if (titles.has(title)) report(page, first('title').line, 'title-unique', `same title as ${titles.get(title)}`);
    else titles.set(title, page);
    const notIndexed = (config.notIndexed ?? []).includes(page);
    if (!notIndexed && !(meta('name', 'description')?.attrs.content ?? '').trim()) report(page, 1, 'description', 'missing meta description');
    if (config.requireCanonical && !notIndexed && !nodes.some((n) => n.name === 'link' && n.attrs.rel === 'canonical' && n.attrs.href)) report(page, 1, 'canonical', 'missing canonical link');

    const h1s = nodes.filter((n) => n.name === 'h1');
    if (h1s.length !== 1) report(page, h1s[1]?.line ?? 1, 'one-h1', `expected exactly one <h1>, found ${h1s.length}`);

    const seenIds = new Map();
    for (const n of nodes) {
      const { id } = n.attrs;
      if (id && seenIds.has(id)) report(page, n.line, 'duplicate-id', `id "${id}" also on line ${seenIds.get(id)}`);
      else if (id) seenIds.set(id, n.line);
    }
    for (const n of nodes) {
      if (n.name === 'img' && !('alt' in n.attrs)) report(page, n.line, 'img-alt', '<img> needs an alt attribute');
      if (LABELLABLE.has(n.name) && !UNLABELLED_INPUT_TYPES.has((n.attrs.type ?? '').toLowerCase()) && !isLabelled(n, nodes)) report(page, n.line, 'label', `<${n.name}> has no label`);
      if (n.name === 'label' && n.attrs.for && !seenIds.has(n.attrs.for)) report(page, n.line, 'label-for', `label points at missing id "${n.attrs.for}"`);
      if (n.name === 'button' && !accessibleName(n)) report(page, n.line, 'button-name', '<button> has no accessible name');
      if (n.name === 'a' && 'href' in n.attrs && !accessibleName(n)) report(page, n.line, 'link-name', '<a> has no accessible name');
      if (n.name === 'iframe' && !n.attrs.title) report(page, n.line, 'iframe-title', '<iframe> needs a title');
      for (const ref of (n.attrs['aria-labelledby'] ?? '').split(/\s+/).filter(Boolean)) if (!seenIds.has(ref)) report(page, n.line, 'aria-labelledby', `references missing id "${ref}"`);
      if (Number(n.attrs.tabindex) > 0) report(page, n.line, 'tabindex', 'positive tabindex breaks keyboard order');

      for (const attr of ['href', 'src', 'poster']) {
        if (!(attr in n.attrs) || n.name === 'base') continue;
        const value = n.attrs[attr].trim();
        if (/^javascript:/i.test(value)) { report(page, n.line, 'javascript-url', 'use a button and a listener'); continue; }
        if (!value && n.name !== 'a') { report(page, n.line, 'empty-reference', `empty ${attr} on <${n.name}>`); continue; }
        const target = localTarget(value, page, config.origin);
        if (!target) continue;
        // Pages serves the not-found page at whatever deep URL was requested, where a relative reference resolves elsewhere
        if (page === config.notFoundPage && value && !value.startsWith('/') && !value.startsWith('#')) report(page, n.line, 'not-found-relative-reference', `${value} breaks when served from a nested URL; use a root-relative path`);
        if (!files.has(target.file)) { report(page, n.line, 'broken-reference', `${value} does not resolve to a tracked file`); continue; }
        if (target.fragment && target.fragment !== 'top' && parsed.has(target.file) && !idsOf(target.file).has(target.fragment)) {
          report(page, n.line, 'broken-fragment', `${value}: no element with that id`);
        }
      }
      if (n.name === 'meta' && /^(og:image|og:url|twitter:image)$/.test(n.attrs.property ?? n.attrs.name ?? '')) {
        const target = localTarget(n.attrs.content ?? '', page, config.origin);
        if (target && !files.has(target.file)) report(page, n.line, 'broken-reference', `${n.attrs.content} does not resolve to a tracked file`);
      }
    }
  }

  for (const css of tracked.filter((p) => p.endsWith('.css'))) {
    for (const ref of cssReferences(readFileSync(join(root, css), 'utf8'))) {
      const target = localTarget(ref, css, config.origin);
      if (target && !files.has(target.file)) report(css, 0, 'broken-reference', `${ref} does not resolve to a tracked file`);
    }
  }

  for (const required of config.requiredFiles ?? []) if (!files.has(required)) report(required, 0, 'required-file-missing', 'listed in site.config.json');
  if (config.cname) {
    const actual = files.has('CNAME') ? readFileSync(join(root, 'CNAME'), 'utf8').trim() : '';
    if (actual !== config.cname) report('CNAME', 1, 'cname', `expected ${config.cname}`);
  }
  if (files.has('robots.txt') && config.origin) {
    const robots = readFileSync(join(root, 'robots.txt'), 'utf8');
    if (!robots.includes(`Sitemap: ${config.origin}/sitemap.xml`)) report('robots.txt', 0, 'robots-sitemap', 'must point at the sitemap on this origin');
    if (/^\s*Disallow:\s*\/\s*$/m.test(robots)) report('robots.txt', 0, 'robots-blocks-site', 'Disallow: / hides the whole site');
  }
  if (files.has('sitemap.xml')) {
    const listed = [...readFileSync(join(root, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    if (!listed.length) report('sitemap.xml', 0, 'sitemap-empty', 'lists no URLs');
    const covered = new Set();
    for (const loc of listed) {
      const target = localTarget(loc, 'index.html', config.origin);
      if (!target) report('sitemap.xml', 0, 'sitemap-origin', `${loc} is not on ${config.origin}`);
      else if (!files.has(target.file)) report('sitemap.xml', 0, 'sitemap-missing-page', `${loc} has no page`);
      else covered.add(target.file);
    }
    for (const page of pages) if (!covered.has(page) && !(config.notIndexed ?? []).includes(page)) report(page, 0, 'sitemap-omits-page', 'indexable page is not in sitemap.xml');
  }

  if (config.published) {
    const { allowedTopLevel, excludedTooling, workflow, jekyllConfig } = config.published;
    const excluded = (p) => excludedTooling.some((e) => p === e || (e.endsWith('/') && p.startsWith(e)));
    const published = tracked.filter((p) => !p.startsWith('.git/') && !p.startsWith('.github/') && !excluded(p));
    for (const p of published) {
      const top = p.includes('/') ? `${p.split('/')[0]}/` : p;
      if (!allowedTopLevel.includes(top)) report(p, 0, 'unexpected-publication', `${top} would be published; add it to published.allowedTopLevel only if it is meant to be public`);
    }
    if (jekyllConfig) {
      const text = files.has(jekyllConfig) ? readFileSync(join(root, jekyllConfig), 'utf8') : '';
      for (const e of excludedTooling.filter((x) => !x.startsWith('.'))) if (!text.includes(e.split('/')[0])) report(jekyllConfig, 0, 'tooling-published', `branch deployment would publish ${e}; list it under exclude`);
    }
    if (workflow) {
      const removals = readFileSync(join(root, workflow), 'utf8').split(/\r?\n/).filter((l) => /\brm -rf\b/.test(l)).join(' ').split(/\s+/);
      for (const e of excludedTooling) if (!removals.includes(e.replace(/\/$/, ''))) report(workflow, 0, 'tooling-published', `the deploy job does not remove ${e} before uploading`);
    }
  }
  // A recorded defect stays visible on every run and must be removed from the config once fixed; anything else fails.
  const known = config.knownDefects ?? [];
  const isKnown = (f, k) => f.path === k.path && f.rule === k.rule && f.detail.includes(k.detail);
  const stale = known.filter((k) => !findings.some((f) => isKnown(f, k)));
  for (const k of stale) findings.push({ path: k.path, line: 0, rule: 'known-defect-stale', detail: `"${k.detail}" no longer occurs; remove it from knownDefects` });
  return { findings: findings.filter((f) => !known.some((k) => isKnown(f, k))), pages, known: known.filter((k) => !stale.includes(k)) };
}

export const loadConfig = (root) => JSON.parse(readFileSync(join(root, 'tools/quality/site.config.json'), 'utf8'));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const config = loadConfig(root);
  const { findings, pages, known } = checkSite(root, config);
  for (const f of findings) console.error(`${f.path}${f.line ? `:${f.line}` : ''}  ${f.rule}  ${f.detail}`);
  for (const k of known) console.log(`KNOWN DEFECT ${k.path}  ${k.rule}  ${k.detail}: ${k.reason}`);
  for (const risk of config.published?.knownRisks ?? []) console.log(`KNOWN RISK ${risk.id}: ${risk.detail}`);
  console.log(findings.length ? `${findings.length} site finding(s) across ${pages.length} page(s).` : `Site checks passed on ${pages.length} page(s): ${pages.join(', ')}.`);
  process.exitCode = findings.length ? 1 : 0;
}
