#!/usr/bin/env node
/**
 * Repository hygiene gate: stops what a passing build would not catch.
 *   - tracked credentials files, browser sessions, customer outputs and oversized generated files
 *   - focused tests (.only) that silently narrow a suite
 *   - package.json test commands that succeed without testing anything
 *   - workflows that can report success without having passed (continue-on-error, `|| true`, pull_request_target)
 *
 * Per-repository exceptions live in .quality-allow.json as [{ "path": "...", "rule": "...", "reason": "..." }]; a path ending in
 * /** covers a folder. An exception without a reason is an error. Exit 0 when clean, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_TRACKED_BYTES = 5 * 1024 * 1024;

const FORBIDDEN_PATHS = [
  { rule: 'env-file', test: (p) => /(^|\/)\.env(\.[^/]*)?$/.test(p) && !/\.(example|sample|template)$/.test(p) },
  { rule: 'key-material', test: (p) => /\.(pem|key|p12|pfx|jks|keystore)$/i.test(p) },
  { rule: 'browser-session', test: (p) => /(^|\/)\.auth\//.test(p) || /(^|\/)storage-?state[^/]*\.json$/i.test(p) },
  { rule: 'customer-output', test: (p) => /(^|\/)edge_reports(_old)?\//.test(p) || /(^|\/)Project-[^/]+\/manifest\.json$/.test(p) },
  { rule: 'chat-export', test: (p) => /(^|\/)chat\d*\.json$/.test(p) },
  { rule: 'dependency-folder', test: (p) => /(^|\/)node_modules\//.test(p) },
];

const FOCUSED_TEST = /\b(?:describe|it|test|context)\.only\s*\(/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** A test command that exits successfully without running anything */
export function isFakeTestCommand(command) {
  const c = String(command).trim();
  if (!c) return true;
  if (/^(echo|exit 0|true|:)\b/.test(c)) return true;
  if (/no tests? (specified|yet|coming)|tests? coming soon/i.test(c)) return true;
  if (/--passWithNoTests/.test(c)) return true;
  return false;
}

/** Lines in a workflow that can turn a failure into a success */
export function findWorkflowBypasses(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const l = line.replace(/\s+#.*$/, '');
    if (/^\s*#/.test(l)) return;
    if (/continue-on-error:\s*true/.test(l)) out.push({ line: i + 1, rule: 'workflow-continue-on-error' });
    if (/\|\|\s*(true|exit 0|:)\s*$/.test(l)) out.push({ line: i + 1, rule: 'workflow-swallowed-failure' });
    if (/^\s*pull_request_target\s*:?/.test(l)) out.push({ line: i + 1, rule: 'workflow-pull-request-target' });
  });
  return out;
}

export function loadAllowList(root) {
  const file = join(root, '.quality-allow.json');
  if (!existsSync(file)) return [];
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  for (const e of entries) {
    if (!e.path || !e.rule || !e.reason?.trim()) throw new Error('.quality-allow.json: every entry needs a path, a rule and a reason');
  }
  return entries;
}

const isAllowed = (f, allow) => allow.some((e) => (e.rule === '*' || e.rule === f.rule)
  && (e.path === f.path || (e.path.endsWith('/**') && f.path.startsWith(e.path.slice(0, -2)))));

export function checkRepository(root) {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 }).split('\u0000').filter(Boolean);
  const findings = [];
  for (const path of paths) {
    for (const { rule, test } of FORBIDDEN_PATHS) if (test(path)) findings.push({ path, rule, detail: 'must not be tracked' });
    const full = join(root, path);
    if (!existsSync(full)) continue; // deleted in the working tree
    let size;
    try { size = statSync(full).size; } catch { continue; }
    if (statSync(full).isDirectory()) continue; // gitlink
    if (size > MAX_TRACKED_BYTES) findings.push({ path, rule: 'oversized-file', detail: `${size} bytes` });
    if (TEST_FILE.test(path)) {
      const text = readFileSync(full, 'utf8');
      text.split(/\r?\n/).forEach((l, i) => { if (FOCUSED_TEST.test(l)) findings.push({ path, line: i + 1, rule: 'focused-test', detail: '.only narrows the suite' }); });
    }
    if (basename(path) === 'package.json') {
      let pkg;
      try { pkg = JSON.parse(readFileSync(full, 'utf8')); } catch { findings.push({ path, rule: 'invalid-package-json', detail: 'not valid JSON' }); continue; }
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        if (/^test(:|$)/.test(name) && isFakeTestCommand(command)) findings.push({ path, rule: 'fake-test-command', detail: `script "${name}" tests nothing` });
      }
    }
    if (/^\.github\/workflows\/.*\.ya?ml$/.test(path)) {
      for (const b of findWorkflowBypasses(readFileSync(full, 'utf8'))) findings.push({ path, line: b.line, rule: b.rule, detail: 'can report success without passing' });
    }
  }
  const allow = loadAllowList(root);
  return findings.filter((f) => !isAllowed(f, allow));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkRepository(process.cwd());
  for (const f of findings) console.error(`${f.path}${f.line ? `:${f.line}` : ''}  ${f.rule}  ${f.detail}`);
  console.log(findings.length ? `${findings.length} hygiene finding(s).` : 'Repository hygiene checks passed.');
  process.exitCode = findings.length ? 1 : 0;
}
