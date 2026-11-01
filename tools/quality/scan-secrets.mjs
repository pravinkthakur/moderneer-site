#!/usr/bin/env node
/**
 * Repository secret scan. Prints where a credential is (file, line) and which rule matched; never the value.
 *
 *   node tools/quality/scan-secrets.mjs            tracked files (CI gate)
 *   node tools/quality/scan-secrets.mjs --staged   what the next commit would contain (pre-commit hook)
 *
 * Same rules as moderneer-edge src/security/audit/secret-scan.ts, which stays the source for Edge itself. This copy has no
 * dependencies so repositories without a build can run it. Deliberate synthetic values go in .secret-scan-allow.json with a reason.
 * Exit 0 when clean, 1 when anything is found.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CREDENTIAL_FORMATS = [
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack-token', pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'model-provider-key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

const SECRET_SUFFIXES = ['token', 'apikey', 'apikeys', 'apitoken', 'password', 'secret', 'clientsecret', 'credentials', 'privatekey', 'authkey', 'secretkey'];
const SECRET_STEMS = ['servicerolekey', 'encryptionkey', 'privatekey', 'secretaccesskey', 'password'];
const NOT_SECRET = new Set(['maxtokens', 'tokencount', 'totaltokens', 'tokensused', 'authheader', 'nexttoken', 'pagetoken', 'continuationtoken']);

const isSecretKey = (key) => {
  const k = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!k || NOT_SECRET.has(k)) return false;
  return SECRET_SUFFIXES.some((s) => k.endsWith(s)) || SECRET_STEMS.some((s) => k.includes(s));
};

const credentialShaped = (value, minLength = 8) =>
  value.length >= minLength && (/\d/.test(value) || /[=._~+/-]/.test(value) || /[A-Z]/.test(value.slice(1)));

/** Words that mark a value as synthetic test data or a placeholder, not a credential */
const PLACEHOLDER = /canary|synthetic|example|placeholder|dummy|fake|sample|changeme|secret|your[-_]|redacted|xxxx|\*\*\*|<[^>]*>/i;
/** References to a value held elsewhere */
const REFERENCE = /\$\{|\$env:|process\.env|import\.meta\.env|\$\(|%[A-Z_]+%|^\$[A-Za-z_]/;
const QUOTED_ASSIGNMENT = /(?<![\w.-])\$?(?:env:)?["']?([A-Za-z_][\w.-]{0,63})["']?\s*(?::|=|:=)\s*(["'`])([^"'`\r\n]{16,512})\2/g;
const BARE_ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]{0,63})[ \t]*=[ \t]*([^\s"'`#]{16,512})[ \t]*$/gm;
const CONFIGURATION_FILE = /(^|\/)\.env[^/]*$|\.(env|properties|ini|cfg|conf|toml)$/i;
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/:@'"`]{1,64}:([^\s/@'"`]{6,128})@/gi;

function isCredentialValue(value) {
  if (value.length < 16 || /\s/.test(value) || PLACEHOLDER.test(value) || REFERENCE.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  const mixed = (/\d/.test(value) && /[A-Za-z]/.test(value)) || (value.length >= 32 && /[a-z]/.test(value) && /[A-Z]/.test(value));
  return mixed && credentialShaped(value, 16);
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Every credential-shaped match in a text as { rule, line, length }. The value itself never leaves this function. */
export function scanText(text, path = '') {
  const found = [];
  const add = (rule, index, value) => found.push({ rule, line: lineOf(text, index), value });
  for (const { name, pattern } of CREDENTIAL_FORMATS) {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) if (!PLACEHOLDER.test(m[0])) add(name, m.index, m[0]);
  }
  for (const m of text.matchAll(URL_PASSWORD)) {
    const password = m[1];
    if (password.length >= 8 && !/^\W*(pass(word)?|pwd|token)\W*$/i.test(password) && !PLACEHOLDER.test(password) && !REFERENCE.test(password)) add('url-password', m.index, password);
  }
  for (const m of text.matchAll(QUOTED_ASSIGNMENT)) if (isSecretKey(m[1]) && isCredentialValue(m[3])) add('credential-assignment', m.index, m[3]);
  if (CONFIGURATION_FILE.test(path)) {
    for (const m of text.matchAll(BARE_ASSIGNMENT)) if (isSecretKey(m[1]) && isCredentialValue(m[2])) add('credential-assignment', m.index, m[2]);
  }
  const seen = new Set();
  return found
    .filter((f) => { const k = `${f.line}:${f.value}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.line - b.line)
    .map(({ rule, line, value }) => ({ rule, line, length: value.length }));
}

export function loadAllowList(root) {
  const file = join(root, '.secret-scan-allow.json');
  if (!existsSync(file)) return [];
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  for (const e of entries) {
    if (!e.path || !e.rule || !e.reason?.trim()) throw new Error('.secret-scan-allow.json: every entry needs a path, a rule and a reason');
  }
  return entries;
}

export const isAllowed = (finding, allow) => allow.some((e) => (e.rule === '*' || e.rule === finding.rule)
  && (e.path === finding.path || (e.path.endsWith('/**') && finding.path.startsWith(e.path.slice(0, -2)))));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });

export function scanRepository(root, { staged = false } = {}) {
  const allow = loadAllowList(root);
  const paths = (staged ? git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']) : git(root, ['ls-files', '-z'])).split('\u0000').filter(Boolean);
  const findings = [];
  for (const path of paths) {
    let text;
    try {
      text = staged ? git(root, ['show', `:${path}`]) : readFileSync(join(root, path), 'utf8');
    } catch {
      continue; // deleted in the working tree, or a submodule entry
    }
    if (text.includes('\u0000')) continue;
    for (const f of scanText(text, path)) {
      const finding = { path, ...f };
      if (!isAllowed(finding, allow)) findings.push(finding);
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const staged = process.argv.includes('--staged');
  const findings = scanRepository(process.cwd(), { staged });
  for (const f of findings) console.error(`${f.path}:${f.line}  ${f.rule}  (${f.length} characters)`);
  console.log(findings.length
    ? `${findings.length} credential(s) found in ${staged ? 'staged changes' : 'tracked files'}. Move them to an ignored local file or a secret store; a deliberate synthetic value goes in .secret-scan-allow.json with a reason.`
    : `No credentials found in ${staged ? 'staged changes' : 'tracked files'}.`);
  process.exitCode = findings.length ? 1 : 0;
}
