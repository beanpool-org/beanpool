#!/usr/bin/env node
// scripts/lanes/pr-state.mjs <PR> [-R owner/name] [--lines N] — a pull request's true state, in one read, for the director.
//
// WHY (Marty, 15 Nov 2026). The director read one red of two on #3169 and called it a flake; the other red was real. A PR's
// state is spread over five places (the PR, its deciding review comment, its check runs, each job's log, its diff), and a
// hurried read of one of them is how a real red gets waved through. This prints all of it plainly:
//   - head, mergeable, base, and whether the PR is in the merge queue;
//   - the LAST deciding review (an issue comment or review whose first line is CLEAN or NOT CLEAN, from a member): its first
//     line, the head it names, and MISMATCH when that is not the current head;
//   - EVERY check that is not success, with the first failing lines of its log (test-all's ❌ lines, ✗ / not ok /
//     AssertionError and the file:line under them). The required summary job ("Shards: failure") is marked as the summary,
//     never read as the cause; pending checks are listed as pending;
//   - each file a failure names, and whether the PR's diff touches it ("untouched" is not proof of a flake);
//   - one last line: CLEAN+GREEN / CLEAN+RED (n reds) / NOT CLEAN / PENDING.
//
// READ-ONLY. It never comments, re-runs, requeues or boards: every gh call goes through readGh(), which refuses anything but
// `gh api` reads and GraphQL queries, and scripts/lanes/test/pr-state.test.mjs records every call a run makes.
//
// Exit: 0 CLEAN+GREEN, 3 CLEAN+RED, 4 NOT CLEAN, 5 PENDING, 2 the PR could not be read or bad arguments.
// PR_STATE_GH names the gh binary (the tests' stand-in); LANE_CI_CHECK the required check (lib.sh's default).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const REQUIRED_CHECK = process.env.LANE_CI_CHECK || 'Run BeanPool Test-All Pipeline';
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']); // a stranger's "CLEAN" comment on a public PR is not a verdict
const RED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'error']);
const WIDTH = 240;

// ── gh, read-only ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Refuses any gh call that could change something: only `gh api` GETs and GraphQL queries pass. */
export function assertRead(args) {
  if (args[0] !== 'api') throw new Error(`refused: gh ${args[0]} is not a read`);
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (/^(-X|--method)(=|$)/.test(a) || a === '--input') throw new Error(`refused: gh api ${a} is not a read`);
    if (/^(-f|-F|--field|--raw-field)$/.test(a)) {
      const v = args[i + 1] ?? '';
      if (args[1] !== 'graphql') throw new Error('refused: a field on a REST call makes it a POST');
      if (v.startsWith('query=') && !/^query=\s*query\b/.test(v)) throw new Error('refused: only a GraphQL query, never a mutation');
      i++;
    }
  }
}

function readGh(args) {
  assertRead(args);
  try {
    return execFileSync(process.env.PR_STATE_GH || 'gh', args, {
      encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const why = String(e.stderr || e.message || e).trim().split('\n').pop();
    throw new Error(why || 'gh failed');
  }
}

/** Every page of a REST list, flattened (`--paginate --slurp` wraps each page in an outer array). */
const pages = (path) => JSON.parse(readGh(['api', '--paginate', '--slurp', path]));
const flat = (slurped) => slurped.flatMap((p) => (Array.isArray(p) ? p : [p]));
/** Runs a read, keeping its error instead of stopping: one unreadable source must not hide the rest. */
function attempt(fn) { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: e.message }; } }

// ── the deciding review ───────────────────────────────────────────────────────────────────────────────────────────────────

/** CLEAN / NOT CLEAN from a comment's first non-empty line, past any markdown; null when it is not a verdict. */
export function verdictOf(body) {
  const first = String(body || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const m = /^[#>*_\s]*(NOT CLEAN|CLEAN)\b/.exec(first);
  return m ? { verdict: m[1], firstLine: first } : null;
}

/**
 * The head a verdict names: the first commit hash in it (first line, then the rest) that is one of the PR's commits; failing
 * that, a hash written after "head", "at" or "of". Null when it names none.
 */
export function namedHead(body, prCommits) {
  const text = String(body || '');
  const nl = text.indexOf('\n');
  const ordered = nl < 0 ? [text] : [text.slice(0, nl), text.slice(nl + 1)];
  const hashes = ordered.flatMap((t) => t.match(/\b[0-9a-f]{7,40}\b/g) || []);
  const ofPr = hashes.find((h) => prCommits.some((c) => c.startsWith(h)));
  if (ofPr) return { sha: ofPr, ofPr: true };
  const said = /\b(?:head|at|of|commit)\s+`?([0-9a-f]{7,40})\b/.exec(text);
  return said ? { sha: said[1], ofPr: false } : null;
}

/** The last trusted verdict among issue comments and reviews, with the head it names checked against `head`. */
export function lastVerdict(comments, reviews, prCommits, head) {
  const all = [
    ...comments.map((c) => ({ kind: 'comment', at: c.created_at, body: c.body, who: c.author_association, url: c.html_url })),
    ...reviews.map((r) => ({ kind: 'review', at: r.submitted_at, body: r.body, who: r.author_association, url: r.html_url })),
  ].map((c) => ({ ...c, ...verdictOf(c.body) })).filter((c) => c.verdict);
  const trusted = all.filter((c) => TRUSTED.has(c.who)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = trusted.at(-1);
  const ignored = all.length - trusted.length;
  if (!last) return { none: true, ignored };
  const named = namedHead(last.body, prCommits);
  const headMatch = Boolean(named && head && head.startsWith(named.sha));
  return { ...last, named, headMatch, ignored, count: trusted.length };
}

// ── checks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Check runs and commit statuses as one list: {name, state: success|red|pending|skipped|neutral, conclusion, url, ids}. */
export function normaliseChecks(checkRuns, status) {
  const out = checkRuns.map((c) => {
    const url = c.html_url || c.details_url || '';
    let state;
    if (c.status !== 'completed') state = 'pending';
    else if (c.conclusion === 'success') state = 'success';
    else if (c.conclusion === 'skipped' || c.conclusion === 'neutral') state = c.conclusion;
    else state = 'red';
    return {
      name: c.name, state, conclusion: c.status === 'completed' ? c.conclusion || 'unknown' : c.status, url,
      jobId: (/\/job\/(\d+)/.exec(url) || [])[1], runId: (/\/runs\/(\d+)/.exec(url) || [])[1],
      title: c.output?.title || '', aggregate: c.name === REQUIRED_CHECK,
    };
  });
  // A commit with no statuses answers state "pending" with total_count 0: that is no status at all, not a pending one.
  for (const s of status && status.total_count > 0 ? status.statuses || [] : []) {
    const state = s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'red';
    out.push({ name: s.context, state, conclusion: s.state, url: s.target_url || '', title: s.description || '', aggregate: false });
  }
  return out;
}

// ── failure lines in a job log ────────────────────────────────────────────────────────────────────────────────────────────

const clean = (l) => l.replace(/^﻿/, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r$/, '');
const clip = (s) => (s.length > WIDTH ? `${s.slice(0, WIDTH)} …` : s);
const FAIL_LINE = [
  /^\s*[✗✘]/, /^\s*FAIL\s/, /^\s*not ok \d+/, /AssertionError/, /^\s*❯ \S+:\d+/, /^\s*❌/, /^\s*Error:/,
  /^\s*##\[error\](?!Process completed with exit code)/,
];
const FRAME = /(?:\/home\/runner\/work\/[^/\s]+\/[^/\s]+\/|file:\/\/\/)(?!.*node_modules)\S+:\d+/;
const LOCATION = /^\s*[\w@.[\]()+-]+(?:\/[\w@.[\]()+-]+)+\.[a-z]{1,5}:\d+/; // esbuild / tsc: "apps/x/y.tsx:14:32: ERROR …"

/**
 * The lines that say what failed, in log order, each with the turbo package and server suite it sits under. Reads
 * test-all's "Failure Details" (its ❌ report lines from anywhere); a log without it (a setup failure, the summary job) gives
 * its last lines before the first ##[error] instead.
 */
export function failureLines(raw, limit = 24) {
  const lines = String(raw).split('\n').map(clean);
  const out = [];
  const seen = new Set();
  let pkg = '', suite = '';
  const keep = (text) => {
    const t = clip(text.trim());
    if (!t || seen.has(t) || out.length >= limit) return;
    seen.add(t);
    out.push({ text: t, pkg, suite });
  };
  for (const l of lines) if (/^║.*❌/.test(l)) keep(l.replace(/^║\s*/, 'check '));
  const start = lines.findIndex((l) => l.startsWith('──── Failure Details'));
  if (start >= 0) {
    let end = lines.findIndex((l, i) => i > start && /^##\[error\]Process completed|^Full logs of every check copied/.test(l));
    if (end < 0) end = lines.length;
    let frames = 0, entries = 0, under = -1, items = 0;
    for (let i = start + 1; i < end; i++) {
      const l = lines[i];
      // node --test's YAML: `actual:` / `expected:` and the values under them, which can name the file that broke the test.
      const indent = l.length - l.trimStart().length;
      if (under >= 0 && items > 0 && indent > under && l.trim()) { keep(l); items--; continue; }
      under = -1;
      const yaml = /^(\s*)(actual|expected):\s*(.*)$/.exec(l);
      if (yaml) { keep(l); if (!yaml[3]) { under = yaml[1].length; items = 3; } continue; }
      const h = /^━━━ (.+?) ━━━$/.exec(l);
      if (h) { suite = h[1]; pkg = ''; keep(l); continue; }
      const task = /^── (@?[\w./-]+)#\w+/.exec(l);
      if (task) { pkg = task[1]; continue; }
      const block = /^── Failing tests \((\d+)\) ──$/.exec(l);
      if (block) { entries = Number(block[1]); keep(l); continue; }
      // test-all's own "Failing tests" list: an entry at two spaces, its error at six. Counted, because the task output that
      // follows it is indented too.
      if (entries > 0 && /^ {2}\S/.test(l)) { keep(l); if (!/^ {6}\S/.test(lines[i + 1] || '')) entries--; continue; }
      if (entries > 0 && /^ {6}\S/.test(l)) { keep(l); entries--; continue; }
      if (entries > 0 && /^\s*… and \d+ more/.test(l)) { keep(l); entries = 0; continue; }
      entries = 0;
      if (FAIL_LINE.some((re) => re.test(l))) { keep(l); frames = 2; continue; }
      if (frames > 0 && (FRAME.test(l) || LOCATION.test(l))) { keep(l); frames--; continue; }
      if (LOCATION.test(l)) keep(l);
    }
  }
  if (out.length === 0) {
    let end = lines.findIndex((l) => l.startsWith('##[error]'));
    if (end < 0) end = lines.length;
    const tail = lines.slice(0, end).filter((l) => l.trim() && !/^##\[(end)?group\]/.test(l)).slice(-8);
    for (const l of [...tail, lines[end] || '']) keep(l);
  }
  return out;
}

/** True when a log is the required summary job's: it only reports how the shards ended. */
export const isSummaryLog = (raw) => /^Shards: \w+/m.test(String(raw).split('\n').map(clean).join('\n'));

// ── files a failure names ─────────────────────────────────────────────────────────────────────────────────────────────────

const TOP = new Set(existsSync(ROOT) ? readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
/** Workspace package name → its folder, from apps/ and packages/ package.json files. */
function packageDirs() {
  const map = {};
  for (const top of ['apps', 'packages', 'workers']) {
    const dir = join(ROOT, top);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) {
      const pj = join(dir, d, 'package.json');
      if (existsSync(pj)) { try { map[JSON.parse(readFileSync(pj, 'utf8')).name] = `${top}/${d}`; } catch { /* unreadable: skip */ } }
    }
  }
  return map;
}
const PKG = packageDirs();
const PATH_RE = /(?:file:\/\/)?((?:\/[^\s:()'"`]+\/)?[\w@.[\]+-]+(?:\/[\w@.[\]()+-]+)*\.(?:[cm]?[jt]sx?|sh|json|ya?ml|py|css|html|sql))(?::(\d+))?/g;
export const isTestFile = (p) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test-[^/]+\.[cm]?[jt]sx?$/.test(p) || /(^|\/)(__tests__|e2e)\//.test(p);

/**
 * The repository files the failure lines name, each {path, line, resolved, test}. A runner's absolute path is cut to the
 * repository's; a vitest path is relative to its package, which the turbo task header above it names; a server suite named
 * only by its header (killed by a timeout, so no stack) maps to apps/server/src/<suite>.ts when that file exists.
 */
export function namedFiles(entries, pkgDirs = PKG, top = TOP) {
  const files = new Map();
  const add = (path, line, resolved) => {
    if (!path || path.includes('node_modules/') || path.startsWith('/')) return;
    const had = files.get(path);
    if (had) { had.line ??= line ? Number(line) : undefined; return; } // a later "file:line" fills in an earlier bare mention
    files.set(path, { path, line: line ? Number(line) : undefined, resolved, test: isTestFile(path) });
  };
  for (const e of entries) {
    for (const m of e.text.matchAll(PATH_RE)) {
      let p = m[1].replace(/^.*?\/home\/runner\/work\/[^/]+\/[^/]+\//, '');
      if (p.startsWith(`${ROOT}/`)) p = p.slice(ROOT.length + 1);
      if (p.startsWith('/')) continue;
      const first = p.split('/')[0];
      if (top.has(first)) add(p, m[2], true);
      else if (e.pkg && pkgDirs[e.pkg]) add(`${pkgDirs[e.pkg]}/${p}`, m[2], true);
      else if (p.includes('/')) add(p, m[2], false);
    }
    const ids = [
      ...(/^━━━ (test-[\w-]+)/.exec(e.text) || []).slice(1),
      ...(/^(test-[\w-]+)(?:\s*\([^)]*\))?: /.exec(e.text) || []).slice(1),
      ...((/suites failed:\s*(.*)$/.exec(e.text) || [])[1] || '').split(/\s+/).map((s) => s.replace(/\(.*\)$/, '')),
    ];
    for (const id of ids) if (/^test-[\w-]+$/.test(id) && existsSync(join(ROOT, `apps/server/src/${id}.ts`))) add(`apps/server/src/${id}.ts`, undefined, true);
  }
  return [...files.values()];
}

/** Whether the PR's diff touches a named file (exactly, or by its tail when the package was not known). */
export function touches(file, diff) {
  return diff.some((d) => (file.resolved ? d === file.path : d === file.path || d.endsWith(`/${file.path}`)));
}

// ── summary ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The one-line answer, and its exit code. */
export function summarize({ review, checks, checksError }) {
  const reds = checks.filter((c) => c.state === 'red' && !c.aggregate);
  const aggRed = checks.filter((c) => c.state === 'red' && c.aggregate);
  const pending = checks.filter((c) => c.state === 'pending');
  const required = checks.some((c) => c.name === REQUIRED_CHECK);
  const n = reds.length || aggRed.length;
  const redWord = `${n} red${n === 1 ? '' : 's'}`;
  const ci = checksError ? 'checks unreadable'
    : n ? redWord : pending.length ? `${pending.length} pending` : !required ? 'the required check has not reported' : 'green';
  if (review.none) return { line: `NOT CLEAN (no deciding review on this PR; CI: ${ci})`, code: 4 };
  if (review.verdict !== 'CLEAN') return { line: `NOT CLEAN (the last deciding review says NOT CLEAN; CI: ${ci})`, code: 4 };
  if (!review.named) return { line: `NOT CLEAN (the CLEAN verdict names no head, so it cannot be tied to this one; CI: ${ci})`, code: 4 };
  if (!review.headMatch) return { line: `NOT CLEAN (MISMATCH: the CLEAN verdict is about ${review.named.sha.slice(0, 8)}, not this head; CI: ${ci})`, code: 4 };
  if (checksError) return { line: `PENDING (the checks could not be read: ${checksError})`, code: 5 };
  if (n) {
    const names = (reds.length ? reds : aggRed).map((c) => c.name).join(', ');
    const tail = reds.length && aggRed.length ? '; the summary check is red with them'
      : reds.length ? '' : '; only the summary check is red: read its log, no shard says why';
    const more = pending.length ? `; ${pending.length} still pending` : '';
    return { line: `CLEAN+RED (${redWord}: ${names}${tail}${more})`, code: 3 };
  }
  if (pending.length) return { line: `PENDING (${pending.length} pending: ${pending.map((c) => c.name).join(', ')})`, code: 5 };
  if (!required) return { line: `PENDING (the required check "${REQUIRED_CHECK}" has not reported on this head)`, code: 5 };
  return { line: 'CLEAN+GREEN', code: 0 };
}

// ── collect and print ─────────────────────────────────────────────────────────────────────────────────────────────────────

function repoOf(arg) {
  if (arg) return arg;
  if (process.env.LANE_GH_REPO) return process.env.LANE_GH_REPO;
  const url = execFileSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`cannot tell the GitHub repository from origin (${url}); pass -R owner/name`);
  return m[1];
}

export function collect(pr, repo, limit) {
  const [owner, name] = repo.split('/');
  const q = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){'
    + 'number title state isDraft headRefOid headRefName baseRefName mergeable mergeStateStatus isInMergeQueue mergeQueueEntry{state position}}}}';
  const p = JSON.parse(readGh(['api', 'graphql', '-f', `query=${q}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr}`]))
    ?.data?.repository?.pullRequest;
  if (!p) throw new Error(`PR #${pr} not found in ${repo}`);
  const base = `repos/${repo}`;
  const head = p.headRefOid;
  const comments = attempt(() => flat(pages(`${base}/issues/${pr}/comments?per_page=100`)));
  const reviews = attempt(() => flat(pages(`${base}/pulls/${pr}/reviews?per_page=100`)));
  const commits = attempt(() => flat(pages(`${base}/pulls/${pr}/commits?per_page=100`)).map((c) => c.sha));
  const files = attempt(() => flat(pages(`${base}/pulls/${pr}/files?per_page=100`)).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)));
  const runs = attempt(() => pages(`${base}/commits/${head}/check-runs?filter=latest&per_page=100`).flatMap((pg) => pg.check_runs || []));
  const status = attempt(() => JSON.parse(readGh(['api', `${base}/commits/${head}/status`])));
  const review = lastVerdict(comments.ok ? comments.value : [], reviews.ok ? reviews.value : [], commits.ok ? commits.value : [], head);
  const checks = runs.ok ? normaliseChecks(runs.value, status.ok ? status.value : null) : [];
  for (const c of checks) {
    if (c.state !== 'red' || !c.jobId) continue;
    const log = attempt(() => readGh(['api', `${base}/actions/jobs/${c.jobId}/logs`]));
    if (!log.ok) { c.logError = log.error; continue; }
    const summary = isSummaryLog(log.value);
    if (summary) c.aggregate = true;
    c.lines = failureLines(log.value, limit).filter((l) => !summary || /^Shards: /.test(l.text));
    c.files = namedFiles(c.lines).map((f) => ({ ...f, touched: files.ok ? touches(f, files.value) : undefined }));
  }
  return {
    repo, pr: p, review, checks, files, errors: { comments, reviews, commits, runs, status },
    checksError: runs.ok ? null : runs.error,
  };
}

export function render(s) {
  const { pr: p, review: r, checks, repo } = s;
  const out = [];
  const row = (k, v) => out.push(`${k.padEnd(12)}${v}`);
  out.push(`PR #${p.number}  ${p.headRefName} → ${p.baseRefName}  ${p.state}${p.isDraft ? ' (draft)' : ''}  ${p.title || ''}`.trimEnd());
  row('head', p.headRefOid);
  row('base', p.baseRefName);
  row('mergeable', `${p.mergeable} (merge state ${p.mergeStateStatus})`);
  row('merge queue', p.isInMergeQueue ? `IN THE QUEUE (${p.mergeQueueEntry?.state || '?'}, position ${p.mergeQueueEntry?.position ?? '?'})` : 'not in the queue');
  for (const k of ['comments', 'reviews', 'commits']) if (!s.errors[k].ok) row('warning', `${k} unreadable (${s.errors[k].error}): the verdict below may be wrong`);
  if (r.none) row('review', 'no deciding review (no member comment starting CLEAN or NOT CLEAN)');
  else {
    row('review', `${r.firstLine}`);
    row('', `[${r.kind} ${r.at}, the last of ${r.count}] ${r.url || ''}`.trimEnd());
    if (!r.named) row('', 'names NO head: it cannot be tied to the current head');
    else if (r.headMatch) row('', `names ${r.named.sha} = the current head`);
    else row('', `MISMATCH: names ${r.named.sha}${r.named.ofPr ? ' (an older commit of this PR)' : ' (not a commit of this PR)'}, the head is ${p.headRefOid.slice(0, 8)}`);
  }
  if (r.ignored) row('', `(${r.ignored} CLEAN/NOT CLEAN comment(s) from non-members ignored)`);
  if (s.checksError) row('checks', `UNREADABLE: ${s.checksError}`);
  else {
    const by = (st) => checks.filter((c) => c.state === st);
    row('checks', `${checks.length} on this head: ${by('success').length} success, ${by('red').length} red, ${by('pending').length} pending`
      + `${by('skipped').length ? `, ${by('skipped').length} skipped` : ''}${by('neutral').length ? `, ${by('neutral').length} neutral` : ''}`);
    if (!s.errors.status.ok) row('warning', `commit statuses unreadable (${s.errors.status.error})`);
    if (!checks.some((c) => c.name === REQUIRED_CHECK)) row('', `the required check "${REQUIRED_CHECK}" has NOT reported on this head`);
  }
  const order = [...checks.filter((c) => c.state === 'red' && !c.aggregate), ...checks.filter((c) => c.state === 'red' && c.aggregate),
    ...checks.filter((c) => c.state === 'pending'), ...checks.filter((c) => c.state === 'skipped' || c.state === 'neutral')];
  let untouchedTest = false;
  for (const c of order) {
    const tag = c.state === 'red' ? 'RED' : c.state.toUpperCase();
    const aside = c.aggregate && c.state === 'red' ? '  [the SUMMARY check: red because a shard is; the shard lines are the cause]' : '';
    out.push(`  ${tag.padEnd(8)}${c.name} — ${c.conclusion}${aside}`);
    if (c.state !== 'red') continue;
    if (c.jobId) {
      const shard = (/^Test-All shard (.+)$/.exec(c.name) || [])[1];
      out.push(`          log: gh run view --job ${c.jobId} -R ${repo} --log-failed${shard && c.runId ? `   all logs: gh run download ${c.runId} -n test-all-logs-${shard} -R ${repo}` : ''}`);
    } else if (c.url) out.push(`          ${c.url}${c.title ? `  ${c.title}` : ''}`);
    if (c.logError) out.push(`          (log unreadable: ${c.logError})`);
    for (const l of c.lines || []) out.push(`          │ ${l.text}`);
    if (c.lines && !c.lines.length) out.push('          (no failing line recognised: read the log)');
    for (const f of c.files || []) {
      if (f.test && f.touched === false) untouchedTest = true;
      const where = f.touched === undefined ? 'diff unreadable' : f.touched ? 'TOUCHED by this PR' : 'untouched by this PR';
      out.push(`          ${f.test ? 'test file ' : 'named     '}${f.path}${f.line ? `:${f.line}` : ''}  ${where}`);
    }
  }
  if (untouchedTest) {
    out.push('note        "untouched" is NOT proof of a flake: a test the PR never edits still fails when the PR changes what it reads');
    out.push('            (#3169: scripts/no-google-fonts.test.mjs was untouched; the PR\'s new apps/pwa/e2e/forum-320.mjs made it red).');
  }
  const sum = summarize(s);
  const flags = [p.state !== 'OPEN' ? `the PR is ${p.state}` : '', p.isDraft ? 'draft' : '', p.mergeable === 'CONFLICTING' ? 'CONFLICTING with its base' : '']
    .filter(Boolean).join(', ');
  out.push(`SUMMARY: ${sum.line}${flags ? `  [${flags}]` : ''}`);
  return { text: out.join('\n'), code: sum.code };
}

function main(argv) {
  let pr, repo, limit = 24;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-R' || a === '--repo') repo = argv[++i];
    else if (a === '--lines') limit = Number(argv[++i]) || limit;
    else if (a === '-h' || a === '--help') { console.log('usage: scripts/lanes/pr-state.mjs <PR number or URL> [-R owner/name] [--lines N]'); return 0; }
    else if (!pr) {
      const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(a);
      if (m) { repo ??= m[1]; pr = m[2]; } else pr = a.replace(/^#/, '');
    }
  }
  if (!/^\d+$/.test(pr || '')) { console.error('usage: scripts/lanes/pr-state.mjs <PR number or URL> [-R owner/name] [--lines N]'); return 2; }
  try {
    const { text, code } = render(collect(pr, repoOf(repo), limit));
    console.log(text);
    return code;
  } catch (e) {
    console.error(`pr-state: ${e.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = main(process.argv.slice(2));
