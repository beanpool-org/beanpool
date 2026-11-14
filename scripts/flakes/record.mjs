#!/usr/bin/env node
// record.mjs: put a PR's failing CI tests on the flake ledger, and say SECOND-HIT when one of them failed on a
// different PR within 14 days, so a flake is acted on at its second hit rather than its third (Marty, 15 Nov). Only a
// named test (or a suite's named assertion) pairs: a failed check whose log names no test is recorded and said as
// "check red, no test named", and never counts toward a second hit (lib.mjs namesATest says why).
//
//   node scripts/flakes/record.mjs <PR> [run id]        record the PR's newest failed CI run (or that run)
//   node scripts/flakes/record.mjs --seen <repo file> [--log <run log>]
//                                                        stress.sh's cross-check: print SEEN-ON-CI for each ledger
//                                                        hit of the tests that log names in that file (or the file)
//
// It ONLY records and reports. Every gh call goes through readOnlyGh, which refuses anything but reads: it never
// re-runs a job, requeues, cancels, merges, comments or marks anything green.
//
// The ledger is one JSON line per failing test per job: { test, file, kind, check, pr, head, run, job, jobName, time,
// recordedAt, touched, via, judge }. Path: FLAKE_LEDGER, default outside the repo (lib.mjs DEFAULT_LEDGER). A test
// already recorded for the same run and job is not appended again, so a heartbeat can call this every tick.
//
// "touched" says whether the PR's diff reached the test (lib.mjs judgeTouch says how it is judged); "not-seen" is the
// honest word for the rest, because no static reading proves a PR did not cause its own red.
//
// Exit: 0 when it ran (with or without a SECOND-HIT), 1 when gh or the arguments failed.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DEFAULT_LEDGER, SECOND_HIT_DAYS, parseFailures, resolveFiles, workspace, judgeTouch,
    readLedger, appendLedger, recordKey, earlierHits, normTest, namesATest, NO_TEST,
} from './lib.mjs';
import fs from 'node:fs';

// FLAKE_ROOT: the tree whose imports judgeTouch reads (the tests point it at a made-up one).
const ROOT = process.env.FLAKE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = process.env.FLAKE_WORKFLOW || 'ci.yml';

/** The gh subcommands this script may run. Anything else, or an api call that writes, throws before gh starts. */
export function assertReadOnly(args) {
    const [a, b] = args;
    const reads = { pr: ['view', 'diff'], run: ['list', 'view'] };
    if (a === 'api') {
        // A short flag can carry its value glued on (-XPOST, -fk=v) or sit in a cluster (-iXPOST), so any single-dash
        // argument holding X, f or F is refused (a read flag with such a glued value is refused too: none is used here).
        const writes = args.find((x) => /^-[^-]/.test(x) && /[XfF]/.test(x) || /^--(method|field|raw-field|input)(=|$)/.test(x));
        if (writes) throw new Error(`record.mjs refuses a gh api call that can write (${writes})`);
        return;
    }
    if (!reads[a]?.includes(b)) throw new Error(`record.mjs only reads: refusing gh ${args.slice(0, 2).join(' ')}`);
}

function readOnlyGh(args) {
    assertReadOnly(args);
    return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const ghJson = (args) => JSON.parse(readOnlyGh(args));

/** The newest failed pull_request run of the workflow on the PR's branch, preferring one at its current head. */
function pickRun(pr) {
    const runs = ghJson(['run', 'list', '--workflow', WORKFLOW, '--branch', pr.headRefName, '--limit', '30',
        '--json', 'databaseId,headSha,conclusion,event,createdAt']);
    const failed = runs.filter((r) => r.conclusion === 'failure' && r.event === 'pull_request');
    return failed.find((r) => r.headSha === pr.headRefOid) ?? failed[0] ?? null;
}

/** Files the PR changed as of the head the run tested; the PR's current diff when GitHub cannot compare that head. */
function diffFiles(pr, headSha) {
    try {
        const files = readOnlyGh(['api', `repos/{owner}/{repo}/compare/${pr.baseRefName}...${headSha}`, '--jq', '.files[].filename'])
            .split('\n').filter(Boolean);
        return { files, at: headSha, note: files.length >= 300 ? 'GitHub lists at most 300 files: the diff may be cut' : '' };
    } catch {
        const files = readOnlyGh(['pr', 'diff', String(pr.number), '--name-only']).split('\n').filter(Boolean);
        return { files, at: pr.headRefOid, note: `diff read at the PR's head ${pr.headRefOid.slice(0, 7)}, not the run's` };
    }
}

export function record({ prNumber, runId, ledgerPath, now = new Date(), log = console.log, root = ROOT }) {
    const pr = ghJson(['pr', 'view', String(prNumber), '--json', 'number,headRefOid,headRefName,baseRefName']);
    let run;
    if (runId) {
        const r = ghJson(['run', 'view', String(runId), '--json', 'databaseId,headSha,event,conclusion']);
        run = { databaseId: r.databaseId, headSha: r.headSha };
    } else {
        run = pickRun(pr);
        if (!run) { log(`PR #${pr.number}: no failed ${WORKFLOW} run on ${pr.headRefName}; nothing to record`); return { recorded: [], secondHits: [] }; }
    }
    const jobs = ghJson(['run', 'view', String(run.databaseId), '--json', 'jobs']).jobs
        .filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');
    const diff = diffFiles(pr, run.headSha);
    const ws = workspace(root);
    const ledger = readLedger(ledgerPath);
    const have = new Set(ledger.map(recordKey));
    const fresh = [];
    const again = [];
    log(`PR #${pr.number} run ${run.databaseId} (head ${run.headSha.slice(0, 7)}): ${jobs.length} failed job(s); `
        + `diff ${diff.files.length} file(s)${diff.note ? ` (${diff.note})` : ''}`);
    for (const job of jobs) {
        const text = readOnlyGh(['run', 'view', '--job', String(job.databaseId), '--log-failed']);
        const found = resolveFiles(root, parseFailures(text), ws);
        if (!found.length) { log(`  ${job.name}: no failing test named in its log`); continue; }
        for (const f of found) {
            const t = judgeTouch(root, f.file, diff.files, { kind: f.kind, ws });
            const entry = {
                test: f.test, file: f.file, kind: f.kind, check: f.check,
                pr: pr.number, head: run.headSha, run: run.databaseId, job: job.databaseId, jobName: job.name,
                time: job.completedAt || job.startedAt || now.toISOString(), recordedAt: now.toISOString(),
                touched: t.touched, via: t.via, judge: t.judge,
            };
            if (have.has(recordKey(entry))) { again.push(entry); continue; }
            have.add(recordKey(entry));
            fresh.push(entry);
            const label = namesATest(entry) || entry.test.startsWith(NO_TEST) ? entry.test : `${NO_TEST}${entry.test}`;
            log(`  recorded  ${label}  [${entry.file ?? 'no file'}; touched=${entry.touched}${entry.via && entry.via !== entry.file ? ` via ${entry.via}` : ''}]`
                + (namesATest(entry) ? '' : '; never counted toward a second hit'));
        }
    }
    if (again.length) log(`  ${again.length} already on the ledger for this run`);
    appendLedger(ledgerPath, fresh);
    const secondHits = [];
    for (const e of fresh) {
        const { same, sameFile } = earlierHits(ledger, e);
        if (same.length) {
            const prs = [...new Set(same.map((s) => s.pr))];
            secondHits.push({ entry: e, earlier: same });
            log(`SECOND-HIT ${e.test} | ${e.file ?? 'no file'} | now PR #${e.pr} (touched=${e.touched}) | before `
                + same.map((s) => `PR #${s.pr} ${String(s.time).slice(0, 10)} run ${s.run} (touched=${s.touched})`).join(', ')
                + ` | ${prs.length + 1} PRs in ${SECOND_HIT_DAYS} days`);
        } else if (sameFile.length) {
            log(`  same file failed on another PR: ${e.file} on PR #${sameFile[0].pr} (${normTest(sameFile[0].test)})`);
        }
    }
    return { recorded: fresh, secondHits };
}

/** stress.sh's cross-check. Names from the log when it names any in that file, else the file itself. */
// The log holds only this file's runs, so every name in it is this file's. A vitest name starts with the file's path
// relative to where it ran, so a name with a ` > ` is also compared without that first part.
export function seen({ file, logText, ledgerPath, now = new Date(), log = console.log }) {
    const ledger = readLedger(ledgerPath).filter((e) => Math.abs(now - Date.parse(e.time)) <= SECOND_HIT_DAYS * 86400e3);
    const names = logText ? parseFailures(logText).map((e) => normTest(e.test)) : [];
    const short = (t) => t.replace(/^[^>]*? > /, '');
    const inFile = ledger.filter((e) => e.file === file);
    const hits = [];
    for (const e of inFile) {
        const name = normTest(e.test);
        const same = namesATest(e) && names.some((n) => n === name || (n.includes(' > ') && short(n) === short(name)));
        if (same) hits.push(e);
        log(`${same ? 'SEEN-ON-CI' : 'same file on CI'} PR #${e.pr} ${String(e.time).slice(0, 10)} run ${e.run}: ${name} (touched=${e.touched})`);
    }
    return { hits, inFile };
}

function main(argv) {
    const ledgerPath = process.env.FLAKE_LEDGER || DEFAULT_LEDGER;
    if (argv[0] === '--seen') {
        const file = argv[1];
        const li = argv.indexOf('--log');
        if (!file) throw new Error('usage: record.mjs --seen <repo file> [--log <run log>]');
        const logText = li > 0 ? fs.readFileSync(argv[li + 1], 'utf8') : '';
        seen({ file, logText, ledgerPath });
        return;
    }
    const [prArg, runArg] = argv;
    if (!/^\d+$/.test(prArg ?? '') || (runArg && !/^\d+$/.test(runArg))) {
        throw new Error('usage: record.mjs <PR number> [run id]   |   record.mjs --seen <repo file> [--log <file>]');
    }
    record({ prNumber: Number(prArg), runId: runArg ? Number(runArg) : null, ledgerPath });
}

// realpath on both sides: called through a symlinked path (macOS's /var is /private/var) it must still run.
const isMain = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) {
    try { main(process.argv.slice(2)); } catch (err) {
        console.error(`record.mjs: ${err.message.split('\n')[0]}`);
        process.exit(1);
    }
}
