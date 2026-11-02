/*
 * Copyright (c) 2026 Moderneer Ltd.
 * All rights reserved.
 *
 * Proprietary software.
 * No licence or permission to use, copy,
 * modify, redistribute or sublicense this
 * software is granted except under an
 * express written agreement with Moderneer Ltd.
 */
/**
 * Self-test of the IP gate. Most cases are negative: each one proves that forbidden content is rejected, using real git repositories
 * and real archives in a temporary folder. Run: node --test tools/ip/ip-gate.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gzipSync } from 'node:zlib';
import {
  addNotice,
  checkArtefact,
  checkDependencies,
  checkNotices,
  checkSource,
  classifyLicence,
  decideRelease,
  distributedClosure,
  dropOpenLicenceHeader,
  globMatch,
  hasNotice,
  listArtefact,
  outstandingLegalItems,
  renderNotice,
  scanDeclarations,
  STATUS,
  validatePackageMetadata,
} from './ip-gate.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'ip-gate.mjs');
const temp = mkdtempSync(join(tmpdir(), 'ip-gate-'));
after(() => rmSync(temp, { recursive: true, force: true }));
let counter = 0;

// Built by concatenation so the kit's own secret scan does not read this test file as holding a key
const PRIVATE_KEY_HEADER = `-----BEGIN ${'RSA PRIVATE'} KEY-----`;
const OPEN_HEADER = `License: ${'MIT'}`;
const MIT_GRANT = `Permission is hereby ${'granted, free of charge'}, to any person`;
const NOTICE_BODY = renderNotice('a.ts', 2025, 2026).join('\n');
const LICENSE_TEXT = 'Copyright (c) 2025-2026 Moderneer Ltd.\nAll rights reserved.\n\nProprietary software.\nexpress written agreement with Moderneer Ltd.\n';

function repo(files, policy = {}) {
  const root = join(temp, `r${(counter += 1)}`);
  mkdirSync(root, { recursive: true });
  const fullPolicy = { noticeRequired: ['src/**'], copyrightStartYear: 2025, copyrightEndYear: 2026, ...policy };
  const all = { 'ip-policy.json': JSON.stringify(fullPolicy), LICENSE: LICENSE_TEXT, 'tools/quality/scan-secrets.mjs': 'export const scanRepository = () => [];\n', ...files };
  for (const [path, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}
const rules = (result) => result.findings.map((f) => f.rule);

function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const compressed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(compressed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function makeTar(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header[156] = 48;
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function makeAsar(files) {
  const tree = { files: {} };
  const bodies = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const parts = name.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} };
      node = node.files[part];
    }
    node.files[parts[parts.length - 1]] = { size: data.length, offset: String(offset) };
    bodies.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(tree));
  const padded = 4 + 4 + json.length + ((4 - (json.length % 4)) % 4);
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(padded + 4, 4);
  header.writeUInt32LE(padded, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  return Buffer.concat([header, ...bodies]);
}

const ARTEFACT_POLICY = { artefacts: { pack: { distribution: 'commercial', allow: ['**'], required: ['LICENSE'] }, strict: { distribution: 'commercial', allow: ['app.js', 'LICENSE'], required: ['LICENSE'] }, internal: { distribution: 'never', allow: ['**'] } } };
function writeArtefact(root, name, buffer) {
  const path = join(root, name);
  writeFileSync(path, buffer);
  return path;
}

describe('notices', () => {
  it('renders the mandated wording in each comment syntax and recognises it', () => {
    for (const path of ['a.ts', 'a.tsx', 'a.css', 'a.ps1', 'a.sql', 'a.html', 'a.sh', 'a.mjs']) {
      const text = renderNotice(path, 2025, 2026).join('\n');
      assert.ok(hasNotice(`${text}\nbody\n`), path);
      assert.match(text, /Copyright \(c\) 2025-2026 Moderneer Ltd\./);
      assert.match(text, /express written agreement with Moderneer Ltd\./);
    }
  });
  it('keeps a shebang, doctype, @charset, byte order mark and CRLF endings intact', () => {
    assert.ok(addNotice('a.mjs', '#!/usr/bin/env node\nx();\n', 2025, 2026).startsWith('#!/usr/bin/env node\n/*'));
    assert.ok(addNotice('a.html', '<!doctype html>\n<html></html>\n', 2025, 2026).startsWith('<!doctype html>\n<!--'));
    assert.ok(addNotice('a.css', '@charset "utf-8";\nb{}\n', 2025, 2026).startsWith('@charset "utf-8";\n/*'));
    const bom = addNotice('a.ps1', '﻿param()\r\n', 2025, 2026);
    assert.ok(bom.startsWith('﻿# Copyright'));
    assert.ok(!bom.replace(/\r\n/g, '').includes('\n'));
  });
  it('rejects a partial, altered or wrong-owner notice', () => {
    assert.equal(hasNotice('// Copyright (c) 2026 Moderneer Ltd.\nconst a = 1;\n'), false);
    assert.equal(hasNotice(NOTICE_BODY.replace('Moderneer Ltd.', 'Someone Else Ltd.')), false);
    assert.equal(hasNotice(NOTICE_BODY.replace('No licence or permission', 'Permission')), false);
  });
  it('correcting a header removes only the exact declaration line', () => {
    const fixed = dropOpenLicenceHeader(`/**\n * Summary\n * \n * ${OPEN_HEADER}\n */\nconst license = 'License: MIT';\n`);
    assert.equal(fixed, `/**\n * Summary\n */\nconst license = 'License: MIT';\n`);
    assert.equal(dropOpenLicenceHeader('/* Note: see MIT notes */\n'), '/* Note: see MIT notes */\n');
  });
});

describe('source check rejects open licensing of first-party code', () => {
  for (const [label, content, rule] of [
    ['a MIT header', `/* ${OPEN_HEADER} */`, 'open-licence-header'],
    ['an SPDX header', `// SPDX-License-Identifier: ${'Apache-2.0'}`, 'spdx-header'],
    ['the MIT grant', MIT_GRANT, 'open-licence-grant'],
    ['a licence badge', '[![L](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)', 'open-licence-badge'],
    ['an open-source claim', 'Moderneer Edge is open source.', 'open-source-claim'],
    ['a statement of intent to open source', '- Open source by default', 'open-source-claim'],
    ['a GPL statement', `GNU GENERAL ${'PUBLIC LICENSE'}`, 'open-licence-grant'],
  ]) {
    it(label, () => assert.ok(scanDeclarations('x', content).some((h) => h.rule === rule)));
  }
  it('fails a repository holding a declaration, names file and rule', async () => {
    const root = repo({ 'src/a.ts': `${NOTICE_BODY}\n// ${OPEN_HEADER}\n` });
    const result = await checkSource(root);
    assert.ok(rules(result).includes('open-licence-header'));
    assert.equal(result.findings.find((f) => f.rule === 'open-licence-header').path, 'src/a.ts');
  });
  it('fails first-party code with no notice', async () => {
    assert.ok(rules(await checkSource(repo({ 'src/a.ts': 'export {}\n' }))).includes('missing-notice'));
  });
  it('fails package metadata that is open, absent or publishable', () => {
    assert.ok(validatePackageMetadata('p', { license: 'MIT', private: true }).some((i) => i.rule === 'package-licence-open'));
    assert.ok(validatePackageMetadata('p', { license: 'ISC', private: true }).some((i) => i.rule === 'package-licence-open'));
    assert.ok(validatePackageMetadata('p', { private: true }).some((i) => i.rule === 'package-licence-missing'));
    assert.ok(validatePackageMetadata('p', { license: 'UNLICENSED' }).some((i) => i.rule === 'package-not-private'));
    assert.deepEqual(validatePackageMetadata('p', { license: 'UNLICENSED', private: true }), []);
    assert.deepEqual(validatePackageMetadata('p', { license: 'SEE LICENSE IN LICENSE', private: true }), []);
  });
  it('fails a lockfile that disagrees with package.json', async () => {
    const root = repo({ 'package.json': '{"license":"UNLICENSED","private":true}', 'package-lock.json': '{"packages":{"":{"license":"MIT"}}}' });
    assert.ok(rules(await checkSource(root)).includes('lockfile-licence-mismatch'));
  });
  it('fails when LICENSE is missing, or swapped for an open licence', async () => {
    assert.ok(rules(await checkSource(repo({ LICENSE: null }))).includes('licence-file-missing'));
    assert.ok(rules(await checkSource(repo({ LICENSE: `${LICENSE_TEXT}\n${MIT_GRANT}` }))).includes('licence-file-open-grant'));
  });
  it('fails without a policy rather than passing', async () => {
    const root = join(temp, 'nopolicy');
    mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    await assert.rejects(checkSource(root), /ip-policy\.json is missing/);
  });
  it('fails a secret reported by the repository scanner, without its value', async () => {
    const root = repo({ 'tools/quality/scan-secrets.mjs': "export const scanRepository = () => [{ rule: 'aws-access-key-id', path: 'x.ts', line: 3 }];\n" });
    const finding = (await checkSource(root)).findings.find((f) => f.rule === 'aws-access-key-id');
    assert.equal(finding.path, 'x.ts');
    assert.equal(finding.detail, 'Credential-shaped value (never printed).');
  });
  it('fails when the secret scanner is absent', async () => {
    assert.ok(rules(await checkSource(repo({ 'tools/quality/scan-secrets.mjs': null }))).includes('secret-scanner-missing'));
  });
  it('staged mode checks what would be committed, not the working copy', async () => {
    const root = repo({ 'src/a.ts': `${NOTICE_BODY}\n// ${OPEN_HEADER}\n` });
    writeFileSync(join(root, 'src/a.ts'), `${NOTICE_BODY}\n`);
    assert.ok(rules(await checkSource(root, { staged: true })).includes('open-licence-header'));
  });
});

describe('approved exceptions stay narrow', () => {
  it('third-party paths keep their licence text and need no Moderneer notice', async () => {
    const root = repo({ 'src/vendor/x.js': `// ${OPEN_HEADER}\n${MIT_GRANT}\n` }, { thirdPartyPaths: [{ path: 'src/vendor/**', licence: 'MIT', reason: 'Vendored library' }] });
    assert.deepEqual(rules(await checkSource(root)), []);
  });
  it('an allow entry without a reason is refused', async () => {
    const root = repo({}, { declarationAllow: [{ path: 'src/a.ts', rule: '*' }] });
    await assert.rejects(checkSource(root), /needs a path and a reason/);
  });
  it('an allow entry covers one rule only', async () => {
    const root = repo({ 'src/a.ts': `${NOTICE_BODY}\n// ${OPEN_HEADER}\n// ${MIT_GRANT}\n` }, { declarationAllow: [{ path: 'src/a.ts', rule: 'open-licence-grant', reason: 'Detection rule text' }] });
    assert.deepEqual(rules(await checkSource(root)), ['open-licence-header']);
  });
  it('a stale allow entry or third-party entry fails', async () => {
    assert.ok(rules(await checkSource(repo({}, { declarationAllow: [{ path: 'gone.ts', rule: '*', reason: 'old' }] }))).includes('stale-allow-entry'));
    assert.ok(rules(await checkSource(repo({}, { thirdPartyPaths: [{ path: 'gone/**', licence: 'MIT', reason: 'old' }] }))).includes('stale-third-party-entry'));
  });
});

describe('dependency licences', () => {
  it('classifies by actual terms', () => {
    assert.equal(classifyLicence('MIT'), 'permissive');
    assert.equal(classifyLicence('Apache-2.0'), 'permissive');
    assert.equal(classifyLicence('LGPL-3.0-only'), 'weak-copyleft');
    assert.equal(classifyLicence('MPL-2.0'), 'weak-copyleft');
    assert.equal(classifyLicence('GPL-3.0'), 'strong-copyleft');
    assert.equal(classifyLicence('AGPL-3.0-or-later'), 'network-copyleft');
    assert.equal(classifyLicence('BUSL-1.1'), 'commercial');
    assert.equal(classifyLicence('SEE LICENSE IN LICENSE'), 'commercial');
    assert.equal(classifyLicence('Some-Custom-Terms'), 'unknown');
    assert.equal(classifyLicence(null), 'unknown');
  });
  it('an OR offers a choice; an AND binds the strictest', () => {
    assert.equal(classifyLicence('(MIT OR GPL-3.0)'), 'permissive');
    assert.equal(classifyLicence('(MIT AND GPL-3.0)'), 'strong-copyleft');
  });
  const lock = (deps) => JSON.stringify({ packages: { '': { dependencies: { top: '1' } }, 'node_modules/top': { version: '1.0.0', license: 'MIT', dependencies: { deep: '1' } }, 'node_modules/deep': { version: '2.0.0', ...deps }, 'node_modules/devonly': { version: '3.0.0', license: 'GPL-3.0', dev: true } } });
  for (const [label, licence, rule] of [
    ['AGPL', 'AGPL-3.0', 'unassessed-network-copyleft'],
    ['GPL', 'GPL-2.0', 'unassessed-strong-copyleft'],
    ['LGPL', 'LGPL-2.1', 'unassessed-weak-copyleft'],
    ['commercial', 'BUSL-1.1', 'unassessed-commercial'],
    ['undeclared', undefined, 'unassessed-unknown'],
  ]) {
    it(`fails an unassessed transitive ${label} dependency`, () => {
      const root = repo({ 'package-lock.json': lock({ license: licence }) }, { lockfiles: [{ path: '.' }] });
      assert.ok(rules(checkDependencies(root)).includes(rule));
    });
  }
  it('an assessment clears a finding; a recorded blocker stays one', () => {
    const decision = { package: 'deep', licence: 'LGPL-2.1', reason: 'Dynamically loaded, replaceable' };
    assert.deepEqual(rules(checkDependencies(repo({ 'package-lock.json': lock({ license: 'LGPL-2.1' }) }, { lockfiles: [{ path: '.' }], dependencyDecisions: [decision] }))), []);
    const blocked = checkDependencies(repo({ 'package-lock.json': lock({ license: 'GPL-2.0' }) }, { lockfiles: [{ path: '.' }], dependencyDecisions: [{ package: 'deep', licence: 'GPL-2.0', reason: 'Statically bundled', blocker: true }] }));
    assert.ok(rules(blocked).includes('commercial-release-blocker'));
  });
  it('a development-only tool is not treated as distributed', () => {
    const closure = distributedClosure(JSON.parse(lock({ license: 'MIT' })));
    assert.ok(closure.has('node_modules/deep'));
    assert.ok(!closure.has('node_modules/devonly'));
  });
  it('a development dependency bundled into the product counts as distributed', () => {
    const root = repo({ 'package-lock.json': lock({ license: 'MIT' }) }, { lockfiles: [{ path: '.', bundledDevDependencies: ['devonly'] }] });
    assert.ok(rules(checkDependencies(root)).includes('unassessed-strong-copyleft'));
  });
  it('a missing lockfile fails', () => {
    assert.ok(rules(checkDependencies(repo({}, { lockfiles: [{ path: '.' }] }))).includes('lockfile-missing'));
  });
  it('a stale or absent notices file fails', () => {
    const noFile = repo({ 'package-lock.json': lock({ license: 'MIT' }) }, { lockfiles: [{ path: '.' }] });
    assert.ok(rules(checkNotices(noFile)).includes('third-party-notices-missing'));
    const stale = repo({ 'package-lock.json': lock({ license: 'MIT' }), 'THIRD-PARTY-NOTICES.md': '<!-- table:start -->\nold\n<!-- table:end -->' }, { lockfiles: [{ path: '.' }] });
    assert.ok(rules(checkNotices(stale)).includes('third-party-notices-stale'));
  });
});

describe('artefact inspection rejects prohibited content', () => {
  const zipCases = [
    ['a git folder', '.git/config', 'x', 'git-metadata'],
    ['an environment file', '.env', 'A=1', 'environment-file'],
    ['a production environment file', 'app/.env.production', 'A=1', 'environment-file'],
    ['a signing key', 'build/sign.pfx', 'x', 'key-material'],
    ['a key file', 'certs/server.key', 'x', 'key-material'],
    ['a source map', 'dist/app.js.map', '{}', 'source-map'],
    ['first-party source', 'src/scoring.ts', 'x', 'first-party-source'],
    ['type declarations', 'dist/index.d.mts', 'x', 'type-declarations'],
    ['tests', 'tests/a.test.ts', 'x', 'tests-and-fixtures'],
    ['fixtures', 'fixtures/a.json', '{}', 'tests-and-fixtures'],
    ['internal documentation', 'docs/ARCHITECTURE.md', 'x', 'internal-documentation'],
    ['agent instructions', 'CLAUDE.md', 'x', 'internal-documentation'],
    ['the policy', 'ip-policy.json', '{}', 'development-tool'],
    ['the workflow folder', '.github/workflows/ci.yml', 'x', 'development-tool'],
    ['customer output', 'edge_reports/Project-a/manifest.json', '{}', 'customer-output'],
    ['a chat export', 'chat3.json', '{}', 'customer-output'],
  ];
  for (const [label, path, content, rule] of zipCases) {
    it(`${label} in a zip`, () => {
      const root = repo({}, ARTEFACT_POLICY);
      const zip = writeArtefact(root, 'p.zip', makeZip({ LICENSE: 'x', [path]: content }));
      assert.ok(rules(checkArtefact(root, 'pack', zip)).includes(rule), `${rule} not found`);
    });
  }
  it('a private key inside any text file, without printing it', () => {
    const root = repo({}, ARTEFACT_POLICY);
    const zip = writeArtefact(root, 'p.zip', makeZip({ LICENSE: 'x', 'app.js': `var k = "${PRIVATE_KEY_HEADER}"` }));
    const found = checkArtefact(root, 'pack', zip).findings.find((f) => f.rule === 'private-key-content');
    assert.ok(found);
    assert.ok(!JSON.stringify(found).includes('PRIVATE KEY-----'));
  });
  it('a key file hidden in a third-party folder', () => {
    const root = repo({}, ARTEFACT_POLICY);
    const zip = writeArtefact(root, 'p.zip', makeZip({ LICENSE: 'x', 'node_modules/a/server.pem': 'x' }));
    assert.ok(rules(checkArtefact(root, 'pack', zip)).includes('key-material'));
  });
  it('an inline or referenced source map in a first-party bundle', () => {
    const root = repo({}, ARTEFACT_POLICY);
    const zip = writeArtefact(root, 'p.zip', makeZip({ LICENSE: 'x', 'a.js': 'x\n//# sourceMappingURL=data:application/json;base64,AA', 'b.js': 'y\n//# sourceMappingURL=b.js.map' }));
    const found = rules(checkArtefact(root, 'pack', zip));
    assert.ok(found.includes('inline-source-map'));
    assert.ok(found.includes('source-map-reference'));
  });
  it('a package.json in the package that is open licensed', () => {
    const root = repo({}, ARTEFACT_POLICY);
    const zip = writeArtefact(root, 'p.zip', makeZip({ LICENSE: 'x', 'package.json': '{"license":"MIT","private":true}' }));
    assert.ok(rules(checkArtefact(root, 'pack', zip)).includes('package-licence-open'));
  });
  it('forbidden content inside an asar inside a directory', () => {
    const root = repo({}, ARTEFACT_POLICY);
    const dir = join(root, 'unpacked/resources');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.asar'), makeAsar({ 'dist/app.js': 'ok', 'src/secret-sauce.ts': 'x', 'LICENSE': 'x' }));
    writeFileSync(join(root, 'unpacked/LICENSE'), 'x');
    const result = checkArtefact(root, 'pack', join(root, 'unpacked'));
    const hit = result.findings.find((f) => f.rule === 'first-party-source');
    assert.equal(hit.path, 'resources/app.asar!/src/secret-sauce.ts');
  });
  it('forbidden content inside a tar inside a zip, and a container-style layer', () => {
    const root = repo({}, ARTEFACT_POLICY);
    const layer = makeTar({ 'app/.env': 'A=1', 'app/run.js': 'x' });
    const zip = writeArtefact(root, 'p.zip', makeZip({ LICENSE: 'x', 'layer.tar': layer }));
    assert.equal(checkArtefact(root, 'pack', zip).findings.find((f) => f.rule === 'environment-file').path, 'layer.tar!/app/.env');
    const image = writeArtefact(root, 'image.tar', makeTar({ LICENSE: 'x' }));
    assert.ok(listArtefact(image).some((e) => e.path === 'LICENSE'));
    const gz = writeArtefact(root, 'image.tgz', gzipSync(makeTar({ LICENSE: 'x', 'app/.env': 'A=1' })));
    assert.ok(rules(checkArtefact(root, 'pack', gz)).includes('environment-file'));
  });
  it('an ignored path is skipped only as the manifest says; everything else is still checked', () => {
    const root = repo({}, { artefacts: { site: { distribution: 'commercial', allow: ['**'], ignore: ['.git/**'] } } });
    const zip = writeArtefact(root, 'p.zip', makeZip({ '.git/config': 'x', '.env': 'A=1' }));
    assert.deepEqual(rules(checkArtefact(root, 'site', zip)), ['environment-file']);
  });
  it('anything outside the distribution manifest', () => {
    const root = repo({}, ARTEFACT_POLICY);
    const zip = writeArtefact(root, 'p.zip', makeZip({ LICENSE: 'x', 'app.js': 'ok', 'extra.bin': 'x' }));
    const result = checkArtefact(root, 'strict', zip);
    assert.deepEqual(result.findings.map((f) => [f.rule, f.path]), [['not-in-distribution-manifest', 'extra.bin']]);
  });
  it('a missing required licence file', () => {
    const root = repo({}, ARTEFACT_POLICY);
    const zip = writeArtefact(root, 'p.zip', makeZip({ 'app.js': 'ok' }));
    assert.ok(rules(checkArtefact(root, 'strict', zip)).includes('required-file-missing'));
  });
  it('an artefact with no classification, one classified never, one absent, one unreadable', () => {
    const root = repo({}, ARTEFACT_POLICY);
    const zip = writeArtefact(root, 'p.zip', makeZip({ LICENSE: 'x' }));
    assert.ok(rules(checkArtefact(root, 'unknown', zip)).includes('artefact-not-classified'));
    assert.ok(rules(checkArtefact(root, 'internal', zip)).includes('distribution-classification'));
    assert.ok(rules(checkArtefact(root, 'pack', join(root, 'none.zip'))).includes('artefact-missing'));
    assert.ok(rules(checkArtefact(root, 'pack', writeArtefact(root, 'bad.zip', Buffer.from('not a zip')))).includes('artefact-unreadable'));
  });
  it('a first-party package under node_modules gets no third-party allowance', () => {
    const root = repo({}, { firstPartyPackages: ['@moderneer/*'], artefacts: { pack: { distribution: 'commercial', allow: ['**'], allowSourceMaps: ['node_modules/**'] } } });
    const zip = writeArtefact(root, 'p.zip', makeZip({
      'node_modules/@moderneer/ds/dist/index.js.map': '{}',
      'node_modules/@moderneer/ds/src/tokens.css': 'x',
      'node_modules/thirdparty/dist/index.js.map': '{}',
    }));
    const found = checkArtefact(root, 'pack', zip).findings.map((f) => [f.rule, f.path]);
    assert.deepEqual(found, [
      ['source-map', 'node_modules/@moderneer/ds/dist/index.js.map'],
      ['first-party-source', 'node_modules/@moderneer/ds/src/tokens.css'],
    ]);
  });
  it('a clean package passes, with third-party documentation and notices in place', () => {
    const root = repo({}, ARTEFACT_POLICY);
    const zip = writeArtefact(root, 'p.zip', makeZip({ LICENSE: 'x', 'THIRD-PARTY-NOTICES.md': 'x', 'dist/app.js': 'ok', 'node_modules/a/README.md': 'x', 'node_modules/a/index.d.ts': 'x', 'package.json': '{"license":"UNLICENSED","private":true}' }));
    assert.deepEqual(checkArtefact(root, 'pack', zip).findings, []);
  });
});

describe('commercial release gate', () => {
  const clean = [{ check: 'x', findings: [] }];
  const approved = { item: 'Licence terms', status: 'approved', approver: 'Counsel', date: '2026-11-02', reference: 'REF-1' };
  it('technically clean with legal approval outstanding is BLOCKED, never ready', () => {
    const decision = decideRelease({ results: clean, policy: { legalApprovals: [{ item: 'Licence terms', status: 'outstanding' }] }, attestations: {} });
    assert.equal(decision.status, STATUS.BLOCKED);
    assert.equal(decision.status, 'BLOCKED — LEGAL APPROVAL REQUIRED');
  });
  it('no recorded approvals at all is BLOCKED', () => {
    assert.equal(decideRelease({ results: clean, policy: {}, attestations: {} }).status, STATUS.BLOCKED);
  });
  it('an approval with no approver, date or reference does not count', () => {
    for (const missing of ['approver', 'date', 'reference']) {
      const item = { ...approved };
      delete item[missing];
      assert.equal(outstandingLegalItems({ legalApprovals: [item] }).length, 1, missing);
    }
  });
  it('any finding fails the release, even with legal approval', () => {
    const decision = decideRelease({ results: [{ check: 'x', findings: [{ rule: 'r' }] }], policy: { legalApprovals: [approved] }, attestations: {} });
    assert.equal(decision.status, STATUS.FAILED);
  });
  it('a missing test attestation fails the release', () => {
    const decision = decideRelease({ results: clean, policy: { legalApprovals: [approved], requiredAttestations: ['tests'] }, attestations: {} });
    assert.equal(decision.status, STATUS.FAILED);
    assert.deepEqual(decision.missingAttestations, ['tests']);
  });
  it('ready only when every check and every approval is in place', () => {
    assert.equal(decideRelease({ results: clean, policy: { legalApprovals: [approved], requiredAttestations: ['tests'] }, attestations: { tests: 'run-1' } }).status, STATUS.READY);
  });
  it('package.json saying UNLICENSED is not enough: end to end, the CLI exits 2 and reports both formats', () => {
    const root = repo({ 'package.json': '{"license":"UNLICENSED","private":true}' }, { legalApprovals: [{ item: 'Ownership', status: 'outstanding' }] });
    const reportDir = join(root, 'out');
    const result = spawnSync(process.execPath, [GATE, 'release', '--report', reportDir], { env: { ...process.env, IP_GATE_ROOT: root }, encoding: 'utf8' });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /BLOCKED — LEGAL APPROVAL REQUIRED/);
    assert.ok(JSON.parse(execFileSync(process.execPath, ['-p', `require('fs').readFileSync(${JSON.stringify(join(reportDir, 'ip-report.json'))},'utf8')`], { encoding: 'utf8' })).status.startsWith('BLOCKED'));
  });
  it('a commercial artefact the release did not inspect fails', () => {
    const root = repo({}, { artefacts: { pack: { distribution: 'commercial', allow: ['**'] } } });
    const result = spawnSync(process.execPath, [GATE, 'release'], { env: { ...process.env, IP_GATE_ROOT: root }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /artefact-not-inspected/);
  });
  it('the CLI exits 1 on a source failure', () => {
    const root = repo({ 'src/a.ts': `// ${OPEN_HEADER}\n` });
    const result = spawnSync(process.execPath, [GATE, 'source'], { env: { ...process.env, IP_GATE_ROOT: root }, encoding: 'utf8' });
    assert.equal(result.status, 1);
  });
});

describe('globs', () => {
  it('matches folders and single segments as written', () => {
    assert.ok(globMatch('src/**', 'src/a/b.ts'));
    assert.ok(globMatch('**/package-lock.json', 'services/a/package-lock.json'));
    assert.ok(globMatch('**/package-lock.json', 'package-lock.json'));
    assert.ok(globMatch('dist/*.js', 'dist/a.js'));
    assert.ok(!globMatch('dist/*.js', 'dist/x/a.js'));
    assert.ok(!globMatch('src/**', 'srcx/a.ts'));
  });
});
