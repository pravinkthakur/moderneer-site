// node --test "tools/quality/*.test.mjs"
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkSite, cssReferences, localTarget, parseHtml } from './check-site.mjs';
import { smokeSite } from './smoke-site.mjs';

const temp = [];
after(() => { for (const t of temp) rmSync(t, { recursive: true, force: true }); });

function site(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-site-'));
  temp.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

const page = ({ head = '', body = '<h1>Heading</h1>', lang = ' lang="en"', title = 'A page' } = {}) => `<!doctype html>
<html${lang}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><meta name="description" content="About this page">${head}</head><body>${body}</body></html>`;

const rules = (files, config = {}) => checkSite(site(files), config).findings.map((f) => f.rule);

describe('checkSite accepts a clean page', () => {
  it('reports nothing', () => assert.deepEqual(rules({ 'index.html': page() }), []));
  it('accepts a labelled form and named controls', () => {
    const body = '<h1>H</h1><form><label>Name<input name="n"></label><label for="e">Email</label><input id="e"><button>Send</button><button aria-label="Close"></button></form><a href="#x" id="x"><img src="a.png" alt="A"></a>';
    assert.deepEqual(rules({ 'index.html': page({ body }), 'a.png': 'x' }), []);
  });
});

describe('checkSite fails each defect it claims to catch', () => {
  const cases = [
    ['doctype', page().replace('<!doctype html>', '')],
    ['lang', page({ lang: '' })],
    ['charset', page().replace('<meta charset="utf-8">', '')],
    ['viewport', page().replace(/<meta name="viewport"[^>]*>/, '')],
    ['title', page({ title: ' ' })],
    ['description', page().replace(/<meta name="description"[^>]*>/, '')],
    ['one-h1', page({ body: '<p>none</p>' })],
    ['one-h1', page({ body: '<h1>a</h1><h1>b</h1>' })],
    ['img-alt', page({ body: '<h1>h</h1><img src="data:image/gif;base64,AA">' })],
    ['label', page({ body: '<h1>h</h1><input name="a">' })],
    ['label-for', page({ body: '<h1>h</h1><label for="nope">L</label>' })],
    ['button-name', page({ body: '<h1>h</h1><button></button>' })],
    ['link-name', page({ body: '<h1>h</h1><a href="#"></a>' })],
    ['duplicate-id', page({ body: '<h1 id="a">h</h1><p id="a">x</p>' })],
    ['broken-reference', page({ body: '<h1>h</h1><img src="missing.png" alt="">' })],
    ['broken-reference', page({ head: '<link rel="stylesheet" href="missing.css">' })],
    ['broken-reference', page({ body: '<h1>h</h1><a href="other.html">x</a>' })],
    ['broken-fragment', page({ body: '<h1>h</h1><a href="#nowhere">x</a>' })],
    ['javascript-url', page({ body: '<h1>h</h1><a href="javascript:void(0)">x</a>' })],
    ['html-structure', page({ body: '<h1>h</h1><div><span>x</div>' })],
    ['html-structure', page({ body: '<h1>h</h1></section>' })],
    ['tabindex', page({ body: '<h1 tabindex="2">h</h1>' })],
    ['aria-labelledby', page({ body: '<h1>h</h1><div aria-labelledby="ghost"></div>' })],
  ];
  for (const [rule, html] of cases) it(rule, () => assert.ok(rules({ 'index.html': html }).includes(rule), `${rule} not reported`));

  it('treats a reference differing only by case as broken, as Pages would', () => {
    assert.ok(rules({ 'index.html': page({ body: '<h1>h</h1><img src="Logo.PNG" alt="">' }), 'logo.png': 'x' }).includes('broken-reference'));
  });
  it('finds a broken url() in a stylesheet', () => {
    assert.ok(rules({ 'index.html': page(), 'a.css': 'body{background:url("gone.png")}' }).includes('broken-reference'));
  });
  it('fails when a branch deployment would publish tooling', () => {
    const config = { published: { allowedTopLevel: ['index.html', '_config.yml'], excludedTooling: ['tools/'], jekyllConfig: '_config.yml' } };
    assert.ok(rules({ 'index.html': page(), '_config.yml': 'title: x\n' }, config).includes('tooling-published'));
    assert.deepEqual(rules({ 'index.html': page(), '_config.yml': 'exclude: [tools]\n' }, config), []);
  });
  it('tolerates only the exact recorded defect and fails once it is fixed', () => {
    const broken = page({ body: '<h1>h</h1><a href="#gone">x</a><a href="#other">y</a>' });
    const knownDefects = [{ path: 'index.html', rule: 'broken-fragment', detail: '#gone', reason: 'recorded' }];
    assert.deepEqual(rules({ 'index.html': broken }, { knownDefects }), ['broken-fragment']);
    assert.deepEqual(rules({ 'index.html': page({ body: '<h1>h</h1><a href="#gone" id="gone">x</a>' }) }, { knownDefects }), ['known-defect-stale']);
  });
  it('requires root-relative references on the not-found page', () => {
    const files = (href) => ({ 'index.html': page(), '404.html': page({ title: 'Missing', head: `<link rel="stylesheet" href="${href}">` }), 'a.css': 'body{}' });
    assert.ok(rules(files('a.css'), { notFoundPage: '404.html' }).includes('not-found-relative-reference'));
    assert.deepEqual(rules(files('/a.css'), { notFoundPage: '404.html' }), []);
  });
  it('rejects two pages with one title', () => {
    assert.ok(rules({ 'index.html': page(), 'b.html': page() }).includes('title-unique'));
  });
  it('requires listed files and the right CNAME', () => {
    const r = rules({ 'index.html': page(), CNAME: 'wrong.example\n' }, { requiredFiles: ['robots.txt'], cname: 'right.example' });
    assert.ok(r.includes('required-file-missing'));
    assert.ok(r.includes('cname'));
  });
  it('checks the sitemap both ways', () => {
    const r = rules({
      'index.html': page(), 'b.html': page({ title: 'B' }),
      'sitemap.xml': '<urlset><url><loc>https://a.test/</loc></url><url><loc>https://a.test/gone.html</loc></url></urlset>',
    }, { origin: 'https://a.test' });
    assert.ok(r.includes('sitemap-missing-page'));
    assert.ok(r.includes('sitemap-omits-page'));
  });
  it('fails on anything new that the deployment would publish', () => {
    const config = { published: { allowedTopLevel: ['index.html'], excludedTooling: ['tools/'] } };
    assert.deepEqual(rules({ 'index.html': page(), 'tools/x.mjs': '' }, config), []);
    assert.ok(rules({ 'index.html': page(), 'internal/secret-plan.md': '' }, config).includes('unexpected-publication'));
  });
  it('fails when the deploy workflow stops removing tooling', () => {
    const config = { published: { allowedTopLevel: ['index.html', 'wf.yml'], excludedTooling: ['tools/'], workflow: 'wf.yml' } };
    assert.ok(rules({ 'index.html': page(), 'wf.yml': 'path: tools/x' }, config).includes('tooling-published'));
    assert.deepEqual(rules({ 'index.html': page(), 'wf.yml': 'run: rm -rf tools' }, config), []);
  });
});

describe('parseHtml and references', () => {
  it('reads attributes that contain > and does not parse script contents', () => {
    const { root, errors } = parseHtml('<div title="a>b"><script>if (a<b) { document.write("<p>"); }</script></div>');
    assert.deepEqual(errors, []);
    assert.equal(root.children[0].attrs.title, 'a>b');
  });
  it('does not require optional end tags', () => assert.deepEqual(parseHtml('<ul><li>a<li>b</ul><p>x').errors, []));
  it('resolves relative, root-relative, same-origin and directory references', () => {
    assert.deepEqual(localTarget('../a.png?v=1#f', 'x/y.html'), { file: 'a.png', fragment: 'f' });
    assert.deepEqual(localTarget('/', 'x/y.html'), { file: 'index.html', fragment: '' });
    assert.deepEqual(localTarget('https://a.test/p/', 'i.html', 'https://a.test'), { file: 'p/index.html', fragment: '' });
    assert.equal(localTarget('https://b.test/p', 'i.html', 'https://a.test'), null);
    assert.equal(localTarget('mailto:a@b.test', 'i.html'), null);
  });
  it('finds css references and ignores comments', () => {
    assert.deepEqual(cssReferences('/* url(no.png) */ a{b:url(yes.png)} @import "c.css";'), ['yes.png', 'c.css']);
  });
});

describe('smokeSite', () => {
  const config = { smoke: { pages: [{ path: '/', title: 'A page' }], notFound: 'Not here' } };
  const notFound = page({ title: 'Missing', body: '<h1>Not here</h1>' });
  it('passes when pages and assets are served', async () => {
    const root = site({ 'index.html': page({ head: '<script src="a.js"></script>' }), 'a.js': 'var ok = 1;', '404.html': notFound });
    const { failures, requests } = await smokeSite(root, config);
    assert.deepEqual(failures, []);
    assert.ok(requests >= 3);
  });
  it('fails on a script that does not parse, a missing asset and a wrong title', async () => {
    const root = site({ 'index.html': page({ title: 'Other', head: '<script src="a.js"></script><script src="gone.js"></script><script>if (</script>' }), 'a.js': 'var = ;', '404.html': notFound });
    const { failures } = await smokeSite(root, config);
    assert.ok(failures.some((f) => f.includes('title')));
    assert.ok(failures.some((f) => f.startsWith('/a.js')));
    assert.ok(failures.some((f) => f.includes('gone.js')));
    assert.ok(failures.some((f) => f.includes('inline script')));
  });
  it('fails when an unknown path does not produce the 404 page', async () => {
    const root = site({ 'index.html': page() });
    const { failures } = await smokeSite(root, config);
    assert.ok(failures.some((f) => f.includes('404')));
  });
});
