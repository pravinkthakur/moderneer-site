#!/usr/bin/env node
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
 * IP protection gate: stops first-party software being offered under an open licence, and stops a commercial package carrying
 * what it must not. Copied unchanged into each repository; ip-policy.json holds what differs. No dependencies, so it runs before
 * npm ci and in repositories with no build.
 *
 *   node tools/ip/ip-gate.mjs source [--staged]     licence declarations, notices, package metadata, LICENSE file, secrets
 *   node tools/ip/ip-gate.mjs deps                  third-party licences of the distributed dependency closure (needs lockfiles)
 *   node tools/ip/ip-gate.mjs notices [--write]     THIRD-PARTY-NOTICES.md is current, or regenerate it (--write needs node_modules)
 *   node tools/ip/ip-gate.mjs artefact <name> <path>  a directory, .zip, .asar or .tar/.tgz against its distribution manifest
 *   node tools/ip/ip-gate.mjs release [--artefact <name> <path>]... [--attest key=value]...   every check, then the legal state
 *   node tools/ip/ip-gate.mjs fix                   add the notice to tracked first-party files; drop exact "License: MIT" header lines
 *
 * --report <dir> writes ip-report.json and ip-report.md. Findings name file, line and rule; never a matched secret.
 * Exit 0 passed, 1 failed, 2 technically clean but BLOCKED — LEGAL APPROVAL REQUIRED (release only).
 * Passing this gate is not legal advice and does not undo any licence already granted: see docs/enterprise-deployment/ip-protection.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';

export const NOTICE_LINES = [
  'All rights reserved.',
  '',
  'Proprietary software.',
  'No licence or permission to use, copy,',
  'modify, redistribute or sublicense this',
  'software is granted except under an',
  'express written agreement with Moderneer Ltd.',
];
const COPYRIGHT_LINE = /^Copyright \(c\) 20\d\d(-20\d\d)? Moderneer Ltd\.$/;
const NOTICE_SEARCH_LINES = 25;

/** Comment syntax by extension. `after` keeps lines that must stay first (shebang, doctype, @charset). */
const COMMENT_STYLES = [
  { ext: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, open: '/*', line: ' * ', blank: ' *', close: ' */', after: /^#!/ },
  { ext: /\.(css|scss)$/i, open: '/*', line: ' * ', blank: ' *', close: ' */', after: /^@charset/i },
  { ext: /\.(ps1|psm1|sh|py|rb)$/i, line: '# ', blank: '#', after: /^#!/ },
  { ext: /\.sql$/i, line: '-- ', blank: '--' },
  { ext: /\.html?$/i, open: '<!--', line: '  ', blank: '', close: '-->', after: /^<!doctype/i },
];

export function renderNotice(path, startYear = 2026, endYear = 2026) {
  const style = COMMENT_STYLES.find((s) => s.ext.test(path));
  if (!style) return null;
  const years = startYear === endYear ? String(endYear) : `${startYear}-${endYear}`;
  const text = [`Copyright (c) ${years} Moderneer Ltd.`, ...NOTICE_LINES];
  return [...(style.open ? [style.open] : []), ...text.map((l) => (l ? style.line + l : style.blank)), ...(style.close ? [style.close] : [])];
}

/** The notice is present when its sentences appear in order near the top, whatever the comment markers */
export function hasNotice(content) {
  const stripped = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content)
    .split(/\r?\n/)
    .slice(0, NOTICE_SEARCH_LINES)
    .map((l) => l.replace(/^\s*(?:\/\*+|\*\/|\*|\/\/|#!?|--|<!--|-->)?\s?/, '').trim());
  const start = stripped.findIndex((l) => COPYRIGHT_LINE.test(l));
  if (start < 0) return false;
  const expected = NOTICE_LINES.filter(Boolean);
  const after = stripped.slice(start + 1).filter(Boolean);
  return expected.every((l, i) => after[i] === l);
}

/** Insert the notice without disturbing line endings, a byte order mark or a line that must stay first */
export function addNotice(path, content, startYear, endYear) {
  const lines = renderNotice(path, startYear, endYear);
  if (!lines) return content;
  const bom = content.startsWith('﻿') ? '﻿' : '';
  const body = bom ? content.slice(1) : content;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const style = COMMENT_STYLES.find((s) => s.ext.test(path));
  const firstLineEnd = body.indexOf('\n');
  const first = firstLineEnd < 0 ? body : body.slice(0, firstLineEnd);
  const block = lines.join(eol) + eol;
  if (style.after && style.after.test(first)) {
    if (firstLineEnd < 0) return bom + first + eol + block;
    return bom + body.slice(0, firstLineEnd + 1) + block + body.slice(firstLineEnd + 1);
  }
  return bom + block + body;
}

/** Remove an exact open-licence header line and an orphaned blank comment line above it; touches nothing else */
const LICENSE_HEADER_LINE = /^[ \t]*(?:\*|\/\/|#)[ \t]*Licen[sc]e:[ \t]*MIT[ \t]*\r?$/;
const OLD_COPYRIGHT_LINE = /^[ \t]*(?:\*|\/\/|#)[ \t]*Copyright \(c\) 20\d\d Moderneer\. All rights reserved\.[ \t]*\r?$/;
const BLANK_COMMENT_LINE = /^[ \t]*(?:\*|\/\/|#)[ \t]*\r?$/;
export function dropOpenLicenceHeader(content) {
  const lines = content.split('\n');
  const out = [];
  let changed = false;
  for (const line of lines) {
    if (LICENSE_HEADER_LINE.test(line) || OLD_COPYRIGHT_LINE.test(line)) {
      changed = true;
      if (out.length && BLANK_COMMENT_LINE.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(line);
  }
  return changed ? out.join('\n') : content;
}

// Declarations that would offer first-party code on open terms. Rule names are what an allow-list entry refers to.
const LICENSE_NAMES = 'MIT|Apache|GPL|LGPL|AGPL|BSD|ISC|MPL|Mozilla|CC[- ]|CC0|Creative Commons|Unlicense|WTFPL|Zlib|Public Domain|EPL|EUPL';
export const DECLARATION_RULES = [
  { rule: 'open-licence-header', pattern: new RegExp(`^[\\s*/#<!-]*Licen[sc]e[d]?\\s*:\\s*(?:${LICENSE_NAMES})\\b`, 'im') },
  { rule: 'spdx-header', pattern: /SPDX-License-Identifier:\s*(?!LicenseRef-Moderneer\b|UNLICENSED\b)\S+/i },
  { rule: 'open-licence-grant', pattern: /Permission is hereby granted, free of charge|Licensed under the (?:MIT|Apache|GNU|BSD|Mozilla)|GNU (?:AFFERO |LESSER )?GENERAL PUBLIC LICENSE|Creative Commons (?:Attribution|Zero|Legal)|released (?:in)?to the public domain/i },
  { rule: 'open-licence-badge', pattern: /img\.shields\.io\/badge\/licen[sc]e[-_]/i },
  { rule: 'open-source-claim', pattern: /\b(?:moderneer|telos|edge|this (?:project|software|repository|repo|product|package))\b[^.\n]{0,60}\b(?:is|are)\s+(?:free and )?open[- ]source\b|\bopen[- ]sourced? under\b|^\W*open[- ]source by default\b/im },
];

const ALWAYS_ALLOWED = [
  { path: 'tools/ip/**', reason: 'The gate must name what it looks for' },
  { path: 'ip-policy.json', reason: 'Records approved third-party licences' },
  { path: 'THIRD-PARTY-NOTICES.md', reason: 'Third-party licence text, reproduced as those licences require' },
  { path: 'package-lock.json', reason: 'Third-party licence identifiers' },
  { path: '**/package-lock.json', reason: 'Third-party licence identifiers' },
  { path: 'docs/enterprise-deployment/ip-protection/**', reason: 'The audit record quotes historical licence evidence' },
];

const TEXT_SCAN = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css|scss|html?|md|mdx|txt|json|ya?ml|ps1|psm1|sh|py|sql|toml|rst)$|(^|\/)(LICEN[SC]E|COPYING|NOTICE|COPYRIGHT|README)[^/]*$/i;

const globCache = new Map();
export function globMatch(glob, path) {
  let re = globCache.get(glob);
  if (!re) {
    const source = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/?/g, 'GLOBSTAR')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/GLOBSTAR/g, '(?:.*/)?');
    re = new RegExp(`^${source.replace(/\(\?:\.\*\/\)\?$/, '.*')}$`);
    globCache.set(glob, re);
  }
  return re.test(path);
}
const anyGlob = (globs, path) => globs.some((g) => globMatch(g, path));

export function loadPolicy(root) {
  const file = join(root, 'ip-policy.json');
  if (!existsSync(file)) throw new Error(`ip-policy.json is missing from ${root}: the gate refuses to pass without a policy`);
  const policy = JSON.parse(readFileSync(file, 'utf8'));
  for (const group of ['noticeExempt', 'declarationAllow', 'thirdPartyPaths']) {
    for (const entry of policy[group] ?? []) {
      if (!entry.path || !String(entry.reason ?? '').trim()) throw new Error(`ip-policy.json ${group}: every entry needs a path and a reason (${JSON.stringify(entry)})`);
    }
  }
  return policy;
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const trackedFiles = (root) => git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
const stagedFiles = (root) => git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);

function readFileFor(root, path, staged) {
  if (!staged) return readFileSync(join(root, path), 'utf8');
  return execFileSync('git', ['show', `:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

const finding = (check, rule, path, line, detail) => ({ check, rule, path, line, detail });

/** Open-licence declarations in first-party files. Approved third-party paths and product code that detects licences are recorded in the policy. */
export function scanDeclarations(path, content) {
  const found = [];
  for (const { rule, pattern } of DECLARATION_RULES) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    for (const match of content.matchAll(new RegExp(pattern.source, flags))) {
      found.push({ rule, line: content.slice(0, match.index).split('\n').length });
    }
  }
  return found;
}

function declarationFindings(root, policy, files, staged) {
  const findings = [];
  const usedAllow = new Set();
  const allow = [...ALWAYS_ALLOWED, ...(policy.thirdPartyPaths ?? [])];
  const ruleAllow = policy.declarationAllow ?? [];
  for (const path of files) {
    if (!TEXT_SCAN.test(path) || anyGlob(allow.map((a) => a.path), path)) continue;
    let content;
    try {
      content = readFileFor(root, path, staged);
    } catch {
      continue;
    }
    for (const hit of scanDeclarations(path, content)) {
      const entry = ruleAllow.find((a) => globMatch(a.path, path) && (a.rule === '*' || a.rule === hit.rule));
      if (entry) {
        usedAllow.add(entry);
        continue;
      }
      findings.push(finding('declarations', hit.rule, path, hit.line, 'Open-licence wording in a first-party file. Correct it, or record why it is not a licence offer in ip-policy.json declarationAllow.'));
    }
  }
  if (!staged) {
    for (const entry of ruleAllow) {
      if (!usedAllow.has(entry)) findings.push(finding('declarations', 'stale-allow-entry', entry.path, 0, `declarationAllow entry for rule ${entry.rule} matches nothing: remove it.`));
    }
  }
  return findings;
}

function noticeFindings(root, policy, files, staged) {
  const findings = [];
  const required = policy.noticeRequired ?? [];
  const exempt = [...(policy.noticeExempt ?? []), ...(policy.thirdPartyPaths ?? [])].map((e) => e.path);
  for (const path of files) {
    if (!COMMENT_STYLES.some((s) => s.ext.test(path))) continue;
    if (!anyGlob(required, path) || anyGlob(exempt, path)) continue;
    let content;
    try {
      content = readFileFor(root, path, staged);
    } catch {
      continue;
    }
    if (!hasNotice(content)) findings.push(finding('notices', 'missing-notice', path, 1, 'No valid proprietary notice near the top. Run: node tools/ip/ip-gate.mjs fix'));
  }
  return findings;
}

export function validatePackageMetadata(path, pkg, spec = {}) {
  const out = [];
  const licence = pkg.license;
  if (licence === undefined) out.push({ rule: 'package-licence-missing', detail: 'No license field. First-party packages declare UNLICENSED or SEE LICENSE IN <file>.' });
  else if (typeof licence !== 'string' || !(licence === 'UNLICENSED' || /^SEE LICENSE IN \S+$/.test(licence))) {
    out.push({ rule: 'package-licence-open', detail: `license is ${JSON.stringify(licence)}. First-party packages declare UNLICENSED or SEE LICENSE IN <file>.` });
  }
  if (pkg.licenses) out.push({ rule: 'package-licence-open', detail: 'Deprecated licenses array present.' });
  if (spec.publishable !== true && pkg.private !== true) out.push({ rule: 'package-not-private', detail: 'private: true is missing, so npm publish would succeed. Set it, or mark the package publishable in ip-policy.json with a reason.' });
  return out;
}

function packageFindings(root, policy, files, staged) {
  const findings = [];
  const specs = policy.packages ?? {};
  for (const path of files) {
    if (basename(path) !== 'package.json' || anyGlob((policy.thirdPartyPaths ?? []).map((e) => e.path), path)) continue;
    if ((policy.packageExempt ?? []).some((e) => globMatch(e.path, path))) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileFor(root, path, staged));
    } catch (error) {
      findings.push(finding('packages', 'package-unreadable', path, 0, String(error.message)));
      continue;
    }
    for (const issue of validatePackageMetadata(path, pkg, specs[path])) findings.push(finding('packages', issue.rule, path, 0, issue.detail));
    const lockPath = join(dirname(path), 'package-lock.json').split(sep).join('/').replace(/^\.\//, '');
    if (files.includes(lockPath)) {
      try {
        const lockRoot = JSON.parse(readFileFor(root, lockPath, staged)).packages?.[''];
        if (lockRoot && lockRoot.license !== pkg.license) findings.push(finding('packages', 'lockfile-licence-mismatch', lockPath, 0, `Lockfile root says ${lockRoot.license}; package.json says ${pkg.license}.`));
      } catch {
        findings.push(finding('packages', 'package-unreadable', lockPath, 0, 'Lockfile is not readable JSON.'));
      }
    }
  }
  return findings;
}

const OPEN_GRANT_IN_LICENCE = /Permission is hereby granted, free of charge|Licensed under the|GNU (?:AFFERO |LESSER )?GENERAL PUBLIC|Creative Commons|public domain/i;
function licenceFileFindings(root, policy) {
  const file = join(root, policy.licenceFile ?? 'LICENSE');
  if (!existsSync(file)) return [finding('licence-file', 'licence-file-missing', policy.licenceFile ?? 'LICENSE', 0, 'The root proprietary licence file is missing.')];
  const text = readFileSync(file, 'utf8');
  const out = [];
  if (!/Copyright \(c\) 20\d\d(-20\d\d)? Moderneer Ltd\./.test(text) || !/express written agreement with Moderneer Ltd/.test(text) || !/All rights reserved/.test(text)) {
    out.push(finding('licence-file', 'licence-file-wording', policy.licenceFile ?? 'LICENSE', 0, 'The licence file does not carry the proprietary statement.'));
  }
  if (OPEN_GRANT_IN_LICENCE.test(text)) out.push(finding('licence-file', 'licence-file-open-grant', policy.licenceFile ?? 'LICENSE', 0, 'The licence file contains open-licence wording.'));
  return out;
}

function thirdPartyFindings(root, policy, files) {
  const out = [];
  for (const entry of policy.thirdPartyPaths ?? []) {
    if (!files.some((f) => globMatch(entry.path, f))) out.push(finding('third-party', 'stale-third-party-entry', entry.path, 0, 'thirdPartyPaths entry matches nothing tracked.'));
    if (!entry.licence) out.push(finding('third-party', 'third-party-licence-unrecorded', entry.path, 0, 'Each third-party path records its licence.'));
  }
  return out;
}

async function secretFindings(root, staged) {
  const kit = join(root, 'tools/quality/scan-secrets.mjs');
  if (!existsSync(kit)) return [finding('secrets', 'secret-scanner-missing', 'tools/quality/scan-secrets.mjs', 0, 'The repository secret scanner is missing, so this check could not run.')];
  const { scanRepository } = await import(pathToFileURL(kit).href);
  const result = scanRepository(root, { staged });
  const list = Array.isArray(result) ? result : result.findings ?? [];
  return list.map((f) => finding('secrets', f.rule, f.path ?? f.file, f.line ?? 0, 'Credential-shaped value (never printed).'));
}

export async function checkSource(root, { staged = false } = {}) {
  const policy = loadPolicy(root);
  const files = staged ? stagedFiles(root) : trackedFiles(root);
  const findings = [
    ...declarationFindings(root, policy, files, staged),
    ...noticeFindings(root, policy, files, staged),
    ...packageFindings(root, policy, files, staged),
    ...(staged ? [] : licenceFileFindings(root, policy)),
    ...(staged ? [] : thirdPartyFindings(root, policy, files)),
    ...(await secretFindings(root, staged)),
  ];
  return { check: 'source', scanned: files.length, findings };
}

export async function applyFix(root) {
  const policy = loadPolicy(root);
  const startYear = policy.copyrightStartYear ?? 2026;
  const endYear = policy.copyrightEndYear ?? 2026;
  const exempt = [...(policy.noticeExempt ?? []), ...(policy.thirdPartyPaths ?? [])].map((e) => e.path);
  const changed = { headersCorrected: [], noticesAdded: [] };
  for (const path of trackedFiles(root)) {
    if (!COMMENT_STYLES.some((s) => s.ext.test(path)) || !anyGlob(policy.noticeRequired ?? [], path) || anyGlob(exempt, path)) continue;
    const full = join(root, path);
    const before = readFileSync(full, 'utf8');
    let after = dropOpenLicenceHeader(before);
    if (after !== before) changed.headersCorrected.push(path);
    if (!hasNotice(after)) {
      after = addNotice(path, after, startYear, endYear);
      changed.noticesAdded.push(path);
    }
    if (after !== before) writeFileSync(full, after);
  }
  return changed;
}

// ---- Third-party dependencies --------------------------------------------------------------------------------------------------

const PERMISSIVE = /^(MIT|MIT-0|ISC|0BSD|BSD(-\d-Clause.*)?|Apache-2\.0|Zlib|Unlicense|CC0-1\.0|WTFPL|Python-2\.0|BlueOak-1\.0\.0|CC-BY-(3|4)\.0|Artistic-2\.0|Unicode-.*|PSF-2\.0|X11|BSL-1\.0|MIT-CMU|ICU)$/i;
const WEAK_COPYLEFT = /^(LGPL.*|MPL.*|EPL.*|CDDL.*|CC-BY-SA.*|EUPL.*)$/i;
const NETWORK_COPYLEFT = /^(AGPL.*|SSPL.*|OSL.*|RPL.*)$/i;
const STRONG_COPYLEFT = /^(GPL.*)$/i;
const COMMERCIAL = /^(BUSL.*|Elastic.*|PolyForm.*|Commercial.*|CC-BY-NC.*|SEE LICEN[CS]E.*|UNLICENSED|Proprietary.*|LicenseRef-.*)$/i;
const RANK = { permissive: 0, 'weak-copyleft': 1, 'strong-copyleft': 2, 'network-copyleft': 3, commercial: 4, unknown: 5 };

const classifyOne = (id) => {
  if (PERMISSIVE.test(id)) return 'permissive';
  if (WEAK_COPYLEFT.test(id)) return 'weak-copyleft';
  if (NETWORK_COPYLEFT.test(id)) return 'network-copyleft';
  if (STRONG_COPYLEFT.test(id)) return 'strong-copyleft';
  if (COMMERCIAL.test(id)) return 'commercial';
  return 'unknown';
};

/** OR offers a choice, so the most permissive alternative counts; AND binds all, so the strictest does. A dual licence is flagged as chosen. */
export function classifyLicence(expression) {
  if (!expression || typeof expression !== 'string') return 'unknown';
  const clean = expression.trim().replace(/^\((.*)\)$/, '$1');
  const orParts = splitTop(clean, ' OR ');
  if (orParts.length > 1) return orParts.map(classifyLicence).sort((a, b) => RANK[a] - RANK[b])[0];
  const andParts = splitTop(clean, ' AND ');
  if (andParts.length > 1) return andParts.map(classifyLicence).sort((a, b) => RANK[b] - RANK[a])[0];
  return classifyOne(clean.replace(/\+$/, ''));
}
function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') depth -= 1;
    if (depth === 0 && text.toUpperCase().startsWith(separator, i)) {
      parts.push(current);
      current = '';
      i += separator.length - 1;
    } else current += text[i];
  }
  parts.push(current);
  return parts.filter((p) => p.trim());
}

function licenceOf(meta) {
  if (!meta) return undefined;
  const value = meta.license ?? meta.licenses;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : v.type)).join(' OR ');
  if (value && typeof value === 'object') return value.type;
  return undefined;
}

/** Walk the lockfile from the root's runtime dependencies, resolving each name as Node would (nearest node_modules upward) */
export function distributedClosure(lock, { includeRoots = [] } = {}) {
  const packages = lock.packages ?? {};
  const rootEntry = packages[''] ?? {};
  const resolvePath = (name, from) => {
    let base = from;
    for (;;) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return null;
      const index = base.lastIndexOf('node_modules/');
      if (index < 0) return null;
      base = base.slice(0, index).replace(/\/$/, '');
    }
  };
  const seen = new Map();
  const visit = (name, from) => {
    const key = resolvePath(name, from);
    if (!key || seen.has(key)) return;
    const entry = packages[key];
    seen.set(key, entry);
    for (const dep of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies })) visit(dep, key);
  };
  for (const name of [...Object.keys({ ...rootEntry.dependencies, ...rootEntry.optionalDependencies }), ...includeRoots]) visit(name, '');
  return seen;
}

function installedMeta(dir, key) {
  const file = join(dir, key, 'package.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function collectDependencies(root, policy) {
  const groups = [];
  for (const spec of policy.lockfiles ?? []) {
    const dir = join(root, spec.path);
    const lockFile = join(dir, 'package-lock.json');
    if (!existsSync(lockFile)) {
      groups.push({ spec, missing: true, packages: [] });
      continue;
    }
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    const closure = distributedClosure(lock, { includeRoots: spec.bundledDevDependencies ?? [] });
    const distributed = [...closure.entries()].map(([key, entry]) => {
      const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const meta = installedMeta(dir, key);
      const licence = entry.license ?? licenceOf(meta);
      return { key, name, version: entry.version ?? meta?.version, licence: licence ?? null, resolved: entry.resolved ?? null, installed: Boolean(meta), repository: typeof meta?.repository === 'string' ? meta.repository : meta?.repository?.url ?? null };
    });
    const closureKeys = new Set(closure.keys());
    const development = Object.entries(lock.packages ?? {})
      .filter(([key]) => key && !closureKeys.has(key) && key.includes('node_modules/'))
      .map(([key, entry]) => ({ name: entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length), version: entry.version, licence: entry.license ?? licenceOf(installedMeta(dir, key)) ?? null }));
    groups.push({ spec, dir, packages: distributed, development });
  }
  return groups;
}

const isFirstParty = (policy, name) => (policy.firstPartyPackages ?? []).some((g) => globMatch(g, name));
const decisionFor = (policy, pkg) => (policy.dependencyDecisions ?? []).find((d) => globMatch(d.package, pkg.name) && (!d.version || d.version === pkg.version));

export function checkDependencies(root) {
  const policy = loadPolicy(root);
  const groups = collectDependencies(root, policy);
  const findings = [];
  const summary = {};
  const blockers = [];
  for (const group of groups) {
    const label = group.spec.path;
    if (group.missing) {
      findings.push(finding('dependencies', 'lockfile-missing', `${label}/package-lock.json`, 0, 'The distributed dependency set cannot be established without a lockfile.'));
      continue;
    }
    const counts = {};
    for (const pkg of group.packages) {
      if (isFirstParty(policy, pkg.name)) {
        counts['first-party'] = (counts['first-party'] ?? 0) + 1;
        continue;
      }
      const decision = decisionFor(policy, pkg);
      const classification = pkg.licence ? classifyLicence(pkg.licence) : 'unknown';
      counts[classification] = (counts[classification] ?? 0) + 1;
      if (classification === 'permissive') continue;
      if (!decision) {
        findings.push(finding('dependencies', `unassessed-${classification}`, `${label}: ${pkg.name}@${pkg.version}`, 0, `Licence ${pkg.licence ?? 'not declared'} needs a recorded assessment in ip-policy.json dependencyDecisions.`));
      } else if (decision.blocker) {
        blockers.push(`${pkg.name}@${pkg.version}: ${decision.reason}`);
        findings.push(finding('dependencies', 'commercial-release-blocker', `${label}: ${pkg.name}@${pkg.version}`, 0, decision.reason));
      }
    }
    const devCounts = {};
    for (const pkg of group.development) {
      const classification = pkg.licence ? classifyLicence(pkg.licence) : 'unknown';
      devCounts[classification] = (devCounts[classification] ?? 0) + 1;
    }
    summary[label] = { distributed: group.packages.length, counts, development: group.development.length, developmentCounts: devCounts };
  }
  return { check: 'dependencies', summary, blockers, findings };
}

const NOTICE_FILE = /^(LICEN[SC]E|LICEN[SC]E-[^/]+|COPYING|NOTICE|COPYRIGHT|UNLICENSE)(\.[a-z]+)?$/i;
const noticeRows = (groups, policy) => {
  const rows = new Map();
  for (const group of groups) {
    for (const pkg of group.packages ?? []) {
      if (isFirstParty(policy, pkg.name)) continue;
      rows.set(`${pkg.name}@${pkg.version}`, pkg.licence ?? 'NOT DECLARED');
    }
  }
  return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));
};
const NOTICE_TABLE_START = '<!-- table:start -->';
const NOTICE_TABLE_END = '<!-- table:end -->';
const noticeTable = (rows) => [NOTICE_TABLE_START, '| Package | Licence |', '|---|---|', ...rows.map(([id, licence]) => `| ${id} | ${licence.replace(/\|/g, '\\|')} |`), NOTICE_TABLE_END].join('\n');

/** The table comes from lockfiles alone, so it is identical on every OS; licence text needs the installed packages */
export function buildNotices(root) {
  const policy = loadPolicy(root);
  const groups = collectDependencies(root, policy);
  const rows = noticeRows(groups, policy);
  const texts = new Map();
  const noText = [];
  for (const group of groups) {
    for (const pkg of group.packages ?? []) {
      if (isFirstParty(policy, pkg.name)) continue;
      const id = `${pkg.name}@${pkg.version}`;
      if (texts.has(id)) continue;
      const dir = join(group.dir, pkg.key);
      const found = existsSync(dir) ? readdirSync(dir).filter((f) => NOTICE_FILE.test(f)).sort() : [];
      if (found.length) {
        texts.set(id, found.map((f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()).join('\n\n'));
      } else if (!noText.includes(id)) noText.push(id);
    }
  }
  const sections = [...texts.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, text]) => [`### ${id}`, '', '````text', text, '````', '']);
  return [
    '# Third-party notices',
    '',
    'Third-party software distributed with this Moderneer product, listed under its own licence. These licences apply to these components only; they do not extend to Moderneer first-party software, which is proprietary (see LICENSE).',
    '',
    'Generated by `node tools/ip/ip-gate.mjs notices --write`. Do not edit by hand.',
    '',
    noticeTable(rows),
    '',
    '## Components with no licence file in the installed package',
    '',
    ...(noText.length ? noText.sort().map((id) => `- ${id}`) : ['None.']),
    '',
    '## Licence texts',
    '',
    ...sections,
  ].join('\n');
}

export function checkNotices(root) {
  const policy = loadPolicy(root);
  const file = join(root, 'THIRD-PARTY-NOTICES.md');
  if (!(policy.lockfiles ?? []).length) return { check: 'notices', findings: [] };
  if (!existsSync(file)) return { check: 'notices', findings: [finding('notices-file', 'third-party-notices-missing', 'THIRD-PARTY-NOTICES.md', 0, 'Run: node tools/ip/ip-gate.mjs notices --write')] };
  const groups = collectDependencies(root, policy);
  const expected = noticeTable(noticeRows(groups, policy));
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const actual = text.slice(text.indexOf(NOTICE_TABLE_START), text.indexOf(NOTICE_TABLE_END) + NOTICE_TABLE_END.length);
  return { check: 'notices', findings: actual === expected ? [] : [finding('notices-file', 'third-party-notices-stale', 'THIRD-PARTY-NOTICES.md', 0, 'The dependency set has changed. Run: node tools/ip/ip-gate.mjs notices --write')] };
}

// ---- Release artefacts ----------------------------------------------------------------------------------------------------------

export function readAsarEntries(buffer) {
  const headerPickleSize = buffer.readUInt32LE(4);
  const stringLength = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + stringLength).toString('utf8'));
  const base = 8 + headerPickleSize;
  const entries = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, path);
      else if (child.unpacked || child.link) entries.push({ path, read: null });
      else {
        const offset = base + Number(child.offset);
        entries.push({ path, read: () => buffer.subarray(offset, offset + child.size) });
      }
    }
  };
  walk(header, '');
  return entries;
}

export function readZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a readable zip');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('zip64 archives are not supported: refusing to pass what cannot be read');
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const path = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/');
    if (!path.endsWith('/')) {
      entries.push({
        path,
        read: () => {
          const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
          const raw = buffer.subarray(start, start + size);
          return method === 0 ? raw : inflateRawSync(raw);
        },
      });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readTarEntries(input) {
  const buffer = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const cString = (start, length) => {
      const raw = block.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end < 0 ? length : end).toString('utf8');
    };
    const size = parseInt(cString(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(block[156] || 48);
    const prefix = cString(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${cString(0, 100)}` : cString(0, 100));
    const dataStart = offset + 512;
    if (type === 'L') longName = buffer.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0+$/, '');
    else {
      longName = null;
      if (type === '0' || type === '7') {
        const start = dataStart;
        entries.push({ path: name.replace(/^\.\//, ''), read: () => buffer.subarray(start, start + size) });
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readDirectoryEntries(dir) {
  const entries = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else entries.push({ path: relative(dir, full).split(sep).join('/'), read: () => readFileSync(full) });
    }
  };
  walk(dir);
  return entries;
}

const NESTED = [
  { test: /\.asar$/i, open: readAsarEntries },
  { test: /\.zip$/i, open: readZipEntries },
  { test: /\.(tar|tgz|tar\.gz)$/i, open: readTarEntries },
];

/** Every file in the artefact, opening archives inside it, so a package cannot hide what it carries */
export function listArtefact(path) {
  const stat = statSync(path);
  const initial = stat.isDirectory()
    ? readDirectoryEntries(path)
    : (NESTED.find((n) => n.test.test(path)) ?? { open: () => { throw new Error(`Unsupported artefact type: ${basename(path)}. Use a directory, .zip, .asar or .tar`); } }).open(readFileSync(path));
  const out = [];
  const add = (entry, prefix) => {
    const full = prefix ? `${prefix}!/${entry.path}` : entry.path;
    const nested = NESTED.find((n) => n.test.test(entry.path));
    if (nested && entry.read) {
      out.push({ path: full, read: null, inner: entry.path });
      for (const child of nested.open(entry.read())) add(child, full);
      return;
    }
    out.push({ path: full, read: entry.read });
  };
  for (const entry of initial) add(entry, '');
  return out;
}

const THIRD_PARTY_TREE = /(^|\/|!\/)node_modules\//;
const LEGAL_FILE = /(^|\/)(LICEN[SC]E[^/]*|NOTICE[^/]*|THIRD-PARTY-NOTICES[^/]*|COPYRIGHT[^/]*)$/i;

/** What a commercial package must never contain. `everywhere` also applies inside node_modules. */
export const PROHIBITED = [
  { rule: 'git-metadata', everywhere: true, test: (p) => /(^|\/|!\/)\.git(\/|$)/.test(p) || /(^|\/)\.gitignore$/.test(p) },
  { rule: 'environment-file', everywhere: true, test: (p) => /(^|\/)\.env(\.[^/]*)?$/.test(p) },
  { rule: 'key-material', everywhere: true, test: (p) => /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i.test(p) },
  { rule: 'customer-output', everywhere: true, test: (p) => /(^|\/)edge_reports(_old)?\//.test(p) || /(^|\/)Project-[^/]+\/manifest\.json$/.test(p) || /(^|\/)chat\d*\.json$/.test(p) },
  { rule: 'source-map', test: (p) => /\.map$/i.test(p) },
  { rule: 'first-party-source', test: (p) => /(^|\/|!\/)src\//.test(p) || (/\.(ts|tsx|mts|cts)$/i.test(p) && !/\.d\.[mc]?ts$/i.test(p)) },
  { rule: 'type-declarations', test: (p) => /\.d\.[mc]?ts$/i.test(p) },
  { rule: 'tests-and-fixtures', test: (p) => /(^|\/|!\/)(tests?|__tests__|e2e|fixtures|coverage|test-results)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) },
  { rule: 'internal-documentation', test: (p) => !LEGAL_FILE.test(p) && (/(^|\/|!\/)(docs|documentation)\//.test(p) || /\.mdx?$/i.test(p)) },
  { rule: 'development-tool', test: (p) => /(^|\/|!\/)(\.github|\.claude|\.agents|\.vscode|\.husky|\.githooks|tools)\//.test(p) || /(^|\/)(lefthook\.ya?ml|tsconfig[^/]*\.json|vitest[^/]*|playwright[^/]*|eslint[^/]*|\.npmrc|\.quality-allow\.json|\.secret-scan-allow\.json|ip-policy\.json|electron-builder[^/]*|vite\.config[^/]*|tsup\.config[^/]*)$/i.test(p) },
];

const ARTEFACT_CREDENTIALS = [
  { rule: 'private-key-content', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'github-token-content', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { rule: 'aws-key-content', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'google-key-content', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'model-key-content', pattern: /\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}\b/ },
  { rule: 'database-secret-content', pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}\b/ },
];
const INLINE_SOURCE_MAP = /sourceMappingURL=data:application\/json/;
const SOURCE_MAP_REFERENCE = /\/[/*][#@]\s*sourceMappingURL=(?!data:)\S+\.map/;
const CONTENT_SCAN = /\.(js|mjs|cjs|css|html?|json|txt|ya?ml|ps1|sh|bat|cmd|env|ini|cfg|conf|toml|xml|asar\.unpacked)$/i;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;

export function checkArtefact(root, name, path, { policy = loadPolicy(root) } = {}) {
  const spec = (policy.artefacts ?? {})[name];
  const findings = [];
  if (!spec) return { check: `artefact:${name}`, findings: [finding('artefact', 'artefact-not-classified', name, 0, 'No distribution manifest for this artefact in ip-policy.json: it cannot ship.')] };
  if (!existsSync(path)) return { check: `artefact:${name}`, findings: [finding('artefact', 'artefact-missing', path, 0, 'The artefact does not exist, so it was not inspected.')] };
  if (spec.distribution === 'never') findings.push(finding('artefact', 'distribution-classification', name, 0, 'Classified as never distributed.'));
  let entries;
  try {
    entries = listArtefact(path);
  } catch (error) {
    return { check: `artefact:${name}`, findings: [finding('artefact', 'artefact-unreadable', path, 0, String(error.message))] };
  }
  const allow = spec.allow ?? [];
  const mapAllow = spec.allowSourceMaps ?? [];
  const contentAllow = spec.allowContent ?? [];
  // A first-party package installed under node_modules is still first-party: its source maps and sources get no third-party allowance
  const firstParty = (p) => {
    const match = p.match(/(?:^|\/|!\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
    return Boolean(match) && isFirstParty(policy, match[1]);
  };
  const ignored = spec.ignore ?? [];
  const files = entries.filter((e) => (e.read !== null || !e.inner) && !anyGlob(ignored, e.path));
  const paths = entries.map((e) => e.path);
  for (const entry of files) {
    const p = entry.path;
    if (!anyGlob(allow, p)) findings.push(finding('artefact', 'not-in-distribution-manifest', p, 0, `Not explicitly approved for ${name}.`));
    const thirdParty = THIRD_PARTY_TREE.test(p) && !firstParty(p);
    for (const rule of PROHIBITED) {
      if (!rule.test(p)) continue;
      if (thirdParty && !rule.everywhere) continue;
      if (rule.rule === 'source-map' && !firstParty(p) && anyGlob(mapAllow, p)) continue;
      findings.push(finding('artefact', rule.rule, p, 0, 'Prohibited in a commercial package.'));
    }
    if (!entry.read || !CONTENT_SCAN.test(p)) continue;
    const bytes = entry.read();
    if (bytes.length > MAX_CONTENT_BYTES) {
      findings.push(finding('artefact', 'content-too-large-to-scan', p, 0, 'Not scanned, so it cannot be approved.'));
      continue;
    }
    const text = bytes.toString('utf8');
    for (const { rule, pattern } of ARTEFACT_CREDENTIALS) {
      if (pattern.test(text) && !contentAllow.some((a) => a.rule === rule && globMatch(a.path, p))) findings.push(finding('artefact', rule, p, 0, 'Credential-shaped content (never printed).'));
    }
    if (!thirdParty && !anyGlob(mapAllow, p)) {
      if (INLINE_SOURCE_MAP.test(text)) findings.push(finding('artefact', 'inline-source-map', p, 0, 'First-party file embeds its source map.'));
      if (SOURCE_MAP_REFERENCE.test(text)) findings.push(finding('artefact', 'source-map-reference', p, 0, 'First-party file points at a source map.'));
    }
    if (!thirdParty && basename(p) === 'package.json' && !p.includes('!/node_modules')) {
      try {
        const pkg = JSON.parse(text);
        for (const issue of validatePackageMetadata(p, pkg, { publishable: spec.packagePublishable === true })) findings.push(finding('artefact', issue.rule, p, 0, issue.detail));
      } catch {
        findings.push(finding('artefact', 'package-unreadable', p, 0, 'Not readable JSON.'));
      }
    }
  }
  for (const required of spec.required ?? []) {
    if (!paths.some((p) => globMatch(required, p))) findings.push(finding('artefact', 'required-file-missing', required, 0, 'Must be present in this package.'));
  }
  return { check: `artefact:${name}`, entries: files.length, findings };
}

// ---- Release gate ---------------------------------------------------------------------------------------------------------------

export const STATUS = { READY: 'READY', BLOCKED: 'BLOCKED — LEGAL APPROVAL REQUIRED', FAILED: 'FAILED' };

/** An approval counts only when it names who gave it, when and where it is recorded. A package.json saying UNLICENSED is not one. */
export function outstandingLegalItems(policy) {
  const items = policy.legalApprovals ?? [];
  if (!items.length) return ['No legal approvals are recorded in ip-policy.json legalApprovals'];
  return items.filter((i) => !(i.status === 'approved' && i.approver && i.date && i.reference)).map((i) => i.item);
}

export function decideRelease({ results, policy, attestations }) {
  const failures = results.flatMap((r) => r.findings);
  const missingAttestations = (policy.requiredAttestations ?? []).filter((k) => !attestations[k]);
  const outstanding = outstandingLegalItems(policy);
  const technical = failures.length === 0 && missingAttestations.length === 0;
  return { status: !technical ? STATUS.FAILED : outstanding.length ? STATUS.BLOCKED : STATUS.READY, technical, failures: failures.length, missingAttestations, outstandingLegal: outstanding };
}

function writeReport(dir, name, report) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [`# IP gate: ${report.command}`, '', `Status: **${report.status}**`, '', `Commit: ${report.commit ?? 'unknown'}`, ''];
  for (const result of report.results) {
    lines.push(`## ${result.check}: ${result.findings.length ? `${result.findings.length} finding(s)` : 'pass'}`, '');
    if (result.scanned !== undefined) lines.push(`Files scanned: ${result.scanned}`, '');
    if (result.entries !== undefined) lines.push(`Entries inspected: ${result.entries}`, '');
    if (result.summary) lines.push('```json', JSON.stringify(result.summary, null, 2), '```', '');
    if (result.findings.length) {
      lines.push('| Rule | Where | Detail |', '|---|---|---|');
      for (const f of result.findings) lines.push(`| ${f.rule} | ${f.path}${f.line ? `:${f.line}` : ''} | ${String(f.detail).replace(/\|/g, '\\|')} |`);
      lines.push('');
    }
  }
  if (report.decision) {
    lines.push('## Decision', '', `Technical checks clean: ${report.decision.technical}`, '');
    if (report.decision.missingAttestations.length) lines.push(`Missing attestations: ${report.decision.missingAttestations.join(', ')}`, '');
    if (report.decision.outstandingLegal.length) lines.push('Outstanding legal items:', '', ...report.decision.outstandingLegal.map((i) => `- ${i}`), '');
  }
  writeFileSync(join(dir, `${name}.md`), `${lines.join('\n')}\n`);
}

function parseArgs(argv) {
  const options = { staged: false, write: false, artefacts: [], attest: {}, report: null, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--staged') options.staged = true;
    else if (arg === '--write') options.write = true;
    else if (arg === '--report') options.report = argv[(i += 1)];
    else if (arg === '--artefact') options.artefacts.push([argv[(i += 1)], argv[(i += 1)]]);
    else if (arg === '--attest') {
      const [key, ...value] = argv[(i += 1)].split('=');
      options.attest[key] = value.join('=');
    } else options.positional.push(arg);
  }
  return options;
}

function printResults(results) {
  for (const result of results) {
    console.log(`${result.check}: ${result.findings.length ? `${result.findings.length} finding(s)` : 'pass'}`);
    for (const f of result.findings) console.log(`  ${f.rule}: ${f.path}${f.line ? `:${f.line}` : ''}  ${f.detail}`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  const root = resolve(process.env.IP_GATE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  let commit = null;
  try {
    commit = git(root, ['rev-parse', 'HEAD']).trim();
  } catch {
    commit = null;
  }
  const finish = (results, decision) => {
    printResults(results);
    const failed = results.some((r) => r.findings.length);
    const status = decision ? decision.status : failed ? STATUS.FAILED : 'PASS';
    if (options.report) writeReport(options.report, 'ip-report', { command, status, commit, results, decision: decision ?? null });
    console.log(`\nIP gate ${command}: ${status}`);
    if (decision?.outstandingLegal.length) for (const item of decision.outstandingLegal) console.log(`  outstanding: ${item}`);
    if (decision?.missingAttestations.length) console.log(`  missing attestations: ${decision.missingAttestations.join(', ')}`);
    if (decision) process.exit(decision.status === STATUS.READY ? 0 : decision.status === STATUS.BLOCKED ? 2 : 1);
    process.exit(failed ? 1 : 0);
  };
  switch (command) {
    case 'source':
      return finish([await checkSource(root, { staged: options.staged })]);
    case 'deps':
      return finish([checkDependencies(root)]);
    case 'notices': {
      if (options.write) {
        writeFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), buildNotices(root));
        console.log('THIRD-PARTY-NOTICES.md written');
        return process.exit(0);
      }
      return finish([checkNotices(root)]);
    }
    case 'artefact': {
      const [name, path] = options.positional;
      if (!name || !path) throw new Error('Usage: ip-gate.mjs artefact <name> <path>');
      return finish([checkArtefact(root, name, resolve(path))]);
    }
    case 'release': {
      const policy = loadPolicy(root);
      const results = [await checkSource(root), checkDependencies(root), checkNotices(root), ...options.artefacts.map(([name, path]) => checkArtefact(root, name, resolve(path), { policy }))];
      for (const name of Object.keys(policy.artefacts ?? {})) {
        if (policy.artefacts[name].distribution === 'commercial' && !options.artefacts.some(([n]) => n === name)) {
          results.push({ check: `artefact:${name}`, findings: [finding('artefact', 'artefact-not-inspected', name, 0, 'A commercial artefact must be inspected by the release gate.')] });
        }
      }
      return finish(results, decideRelease({ results, policy, attestations: options.attest }));
    }
    case 'fix': {
      const changed = await applyFix(root);
      console.log(`Headers corrected: ${changed.headersCorrected.length}. Notices added: ${changed.noticesAdded.length}.`);
      if (options.report) {
        mkdirSync(options.report, { recursive: true });
        writeFileSync(join(options.report, 'ip-fix.json'), `${JSON.stringify(changed, null, 2)}\n`);
      }
      return process.exit(0);
    }
    default:
      console.error('Usage: ip-gate.mjs source|deps|notices|artefact|release|fix  (see the header of this file)');
      return process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`IP gate could not run: ${error.message}`);
    process.exit(1);
  });
}
