// node --test tools/quality/quality-kit.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRepository, findWorkflowBypasses, isFakeTestCommand } from './check-hygiene.mjs';
import { isAllowed, scanRepository, scanText } from './scan-secrets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Built at run time so this file holds no value the scanner itself would flag
const AWS_SHAPE = ['AKIA', 'QWERTYUIOPASDFGH'].join('');
const JWT_SHAPE = ['eyJhbGciOiJI', 'eyJzdWIiOiIx', 'c2lnbmF0dXJl'].join('.');
const ASSIGNED = ['Zx9', 'Kq2', 'Lm7', 'Pw4', 'Rt8', 'Vb3'].join('');

const temp = [];
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'quality-kit-'));
  temp.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}
after(() => { for (const t of temp) rmSync(t, { recursive: true, force: true }); });

describe('scanText', () => {
  it('finds well-known formats and reports only rule, line and length', () => {
    const [f, ...rest] = scanText(`first line\nconst k = '${AWS_SHAPE}'\n`);
    assert.equal(rest.length, 0);
    assert.deepEqual(f, { rule: 'aws-access-key-id', line: 2, length: AWS_SHAPE.length });
    assert.equal(JSON.stringify(f).includes(AWS_SHAPE), false);
  });
  it('finds a JWT', () => assert.equal(scanText(JWT_SHAPE)[0].rule, 'jwt'));
  it('finds a literal assigned to a credential-named setting', () => {
    assert.equal(scanText(`SUPABASE_SERVICE_ROLE_KEY = "${ASSIGNED}"`)[0].rule, 'credential-assignment');
  });
  it('finds a bare assignment only in configuration-style files', () => {
    assert.equal(scanText(`API_TOKEN=${ASSIGNED}\n`, 'deploy/.env.production')[0].rule, 'credential-assignment');
    assert.equal(scanText(`API_TOKEN=${ASSIGNED}\n`, 'src/a.ts').length, 0);
  });
  it('finds a password inside a URL', () => {
    assert.equal(scanText('postgres://admin:Tr0ub4dor3x@db.internal/app')[0].rule, 'url-password');
  });
  it('ignores references, placeholders and non-credential settings', () => {
    assert.equal(scanText('API_TOKEN = "${API_TOKEN_FROM_VAULT_VALUE}"').length, 0);
    assert.equal(scanText('apiToken: "your-token-goes-here-1234"').length, 0);
    assert.equal(scanText('maxTokens = "12345678901234567890"').length, 0);
    assert.equal(scanText('https://user:password@example.test').length, 0);
  });
});

describe('allow list', () => {
  it('matches exact paths and folder globs by rule', () => {
    const allow = [{ path: 'tests/**', rule: 'jwt', reason: 'synthetic' }];
    assert.equal(isAllowed({ path: 'tests/a/b.ts', rule: 'jwt' }, allow), true);
    assert.equal(isAllowed({ path: 'src/a.ts', rule: 'jwt' }, allow), false);
    assert.equal(isAllowed({ path: 'tests/a/b.ts', rule: 'aws-access-key-id' }, allow), false);
  });
  it('rejects an entry without a reason', () => {
    const root = repo({ '.secret-scan-allow.json': JSON.stringify([{ path: 'a', rule: 'jwt' }]) });
    assert.throws(() => scanRepository(root), /needs a path, a rule and a reason/);
  });
});

describe('scanRepository', () => {
  it('scans staged content, not the working tree', () => {
    const root = repo({ 'a.txt': `key ${AWS_SHAPE}\n` });
    assert.equal(scanRepository(root, { staged: true }).length, 1);
    writeFileSync(join(root, 'a.txt'), 'clean\n');
    assert.equal(scanRepository(root, { staged: true }).length, 1, 'the staged copy is what would be committed');
    assert.equal(scanRepository(root).length, 0);
  });
  it('fails the command line with exit 1 and prints no value', () => {
    const root = repo({ 'a.txt': `key ${AWS_SHAPE}\n` });
    const r = spawnSync(process.execPath, [join(here, 'scan-secrets.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a\.txt:1\s+aws-access-key-id/);
    assert.equal((r.stdout + r.stderr).includes(AWS_SHAPE), false);
  });
  it('passes the command line with exit 0 on a clean repository', () => {
    const r = spawnSync(process.execPath, [join(here, 'scan-secrets.mjs')], { cwd: repo({ 'a.txt': 'clean\n' }), encoding: 'utf8' });
    assert.equal(r.status, 0);
  });
});

describe('isFakeTestCommand', () => {
  for (const c of ['echo "No tests specified" && exit 0', "echo 'Tests coming soon'", 'exit 0', '', 'jest --passWithNoTests']) {
    it(`flags: ${c || '(empty)'}`, () => assert.equal(isFakeTestCommand(c), true));
  }
  for (const c of ['jest', 'vitest run', 'node --test tests/a.test.js']) {
    it(`accepts: ${c}`, () => assert.equal(isFakeTestCommand(c), false));
  }
});

describe('findWorkflowBypasses', () => {
  it('flags each way a workflow can falsely succeed', () => {
    const rules = findWorkflowBypasses('on:\n  pull_request_target:\njobs:\n  a:\n    continue-on-error: true\n    steps:\n      - run: npm test || true\n').map((b) => b.rule);
    assert.deepEqual(rules, ['workflow-pull-request-target', 'workflow-continue-on-error', 'workflow-swallowed-failure']);
  });
  it('ignores comments and ordinary steps', () => {
    assert.deepEqual(findWorkflowBypasses('# continue-on-error: true\n      - run: npm test\n'), []);
  });
});

describe('checkRepository', () => {
  it('reports tracked sensitive paths, focused tests and fake test scripts', () => {
    const root = repo({
      '.env': 'A=1\n',
      '.env.example': 'A=\n',
      'certs/server.pem': 'x\n',
      'edge_reports/run/out.json': '{}\n',
      'tests/a.test.ts': "it.only('x', () => {})\n",
      'package.json': JSON.stringify({ scripts: { test: 'echo "No tests specified" && exit 0' } }),
    });
    const rules = checkRepository(root).map((f) => `${f.path}|${f.rule}`).sort();
    assert.deepEqual(rules, [
      '.env|env-file',
      'certs/server.pem|key-material',
      'edge_reports/run/out.json|customer-output',
      'package.json|fake-test-command',
      'tests/a.test.ts|focused-test',
    ]);
  });
  it('honours an allow-list entry with a reason', () => {
    const root = repo({ 'fixtures/test.pem': 'x\n', '.quality-allow.json': JSON.stringify([{ path: 'fixtures/test.pem', rule: 'key-material', reason: 'throwaway test certificate' }]) });
    assert.deepEqual(checkRepository(root), []);
  });
});
