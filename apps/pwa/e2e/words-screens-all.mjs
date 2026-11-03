/**
 * Every web screen in the pseudo-locale, in one run (translation tooling design §2.5, slice T4: "the web e2e nightly on
 * all its screens"). The web app's words checks each open a different set of screens at 320 px with 1.3× text and fail on
 * a page that scrolls sideways, words past an edge or words clipped by their own box:
 *
 *   screens  words-screens-check.mjs     the first screens (welcome, the guest lobby, restore) in xx, ru, fr and zh-Hans
 *   w1       words-w1-check.mjs          the Market, deals, Pulse, events, Messages and Channels, in en and xx
 *   w2       words-w2-check.mjs          the enterprise page, the Ledger, the Commons, People and groups, in en and xx
 *   w3       words-w3-screens-check.mjs  Settings, profiles, the guide, the shell's header and tabs, and more, in xx
 *   w4       words-w4-screens-check.mjs  joining, getting an account back, recovery, the Invites page, in xx
 *
 * Run by scripts/merge-queue/tripwire.sh once a day after the full test-all run (docs/merge-gate.md); by hand:
 *   pnpm --filter @beanpool/pwa words-screens-all [out-dir]
 *   WORDS_ALL_ONLY=w1,w4     only these checks (names above)
 * Every check runs even when an earlier one failed, so one red never hides another; the last line names the ones that
 * failed, and the exit code is 1 when any did. Each check keeps its own switches (WORDS_SCREENS_LANGS, WORDS_W1_LANGS …).
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 * Nothing here talks to a node.
 */
/* global console, process */
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const PWA_DIR = path.resolve(E2E_DIR, '..');

/** The checks, in the order they run. A new `words-*check.mjs` in this folder must be added here (scripts/words/words.test.mjs). */
export const CHECKS = Object.freeze([
    { name: 'screens', file: 'words-screens-check.mjs' },
    { name: 'w1', file: 'words-w1-check.mjs' },
    { name: 'w2', file: 'words-w2-check.mjs' },
    { name: 'w3', file: 'words-w3-screens-check.mjs' },
    { name: 'w4', file: 'words-w4-screens-check.mjs' },
]);

/** The checks to run: all of them, or those `only` (a comma-separated list of names) names; an unknown name is an error. */
export function checksToRun(only) {
    if (!only) return [...CHECKS];
    const wanted = only.split(',').map((x) => x.trim()).filter(Boolean);
    const unknown = wanted.filter((n) => !CHECKS.some((c) => c.name === n));
    if (unknown.length) throw new Error(`WORDS_ALL_ONLY names ${unknown.join(', ')}, which is no check here. The checks: ${CHECKS.map((c) => c.name).join(', ')}`);
    return CHECKS.filter((c) => wanted.includes(c.name));
}

/** The last line of a run: which checks passed and which failed. */
export function summaryLine(results) {
    const failed = results.filter((r) => r.status !== 0).map((r) => r.name);
    const passed = results.filter((r) => r.status === 0).map((r) => r.name);
    return failed.length
        ? `words-screens-all: FAILED ${failed.join(', ')}${passed.length ? ` (passed ${passed.join(', ')})` : ''}`
        : `words-screens-all: ok — ${passed.join(', ')}`;
}

function main() {
    const outDir = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-words-screens-all');
    fs.mkdirSync(outDir, { recursive: true });
    const results = [];
    for (const { name, file } of checksToRun(process.env.WORDS_ALL_ONLY)) {
        console.log(`\n=== words-screens-all: ${name} (${file})`);
        // A check that cannot start (a signal, a missing node) is a failure, not a pass: status is null then.
        const r = spawnSync(process.execPath, [path.join(E2E_DIR, file), path.join(outDir, name)], { cwd: PWA_DIR, stdio: 'inherit', env: process.env });
        results.push({ name, status: r.status === null ? 1 : r.status });
    }
    console.log(`\n${summaryLine(results)}`);
    console.log(`screenshots: ${outDir}`);
    process.exit(results.some((r) => r.status !== 0) ? 1 : 0);
}

/**
 * Whether node was started on this file. import.meta.url is the file's real path but process.argv[1] is as typed, so a path
 * through a symlink (on a Mac /tmp is /private/tmp, and $TMPDIR is under /private/var) is resolved first: without that, a run
 * by `node /tmp/…/words-screens-all.mjs` skips main() and exits 0 with no output, which reads as a pass. A path that cannot be
 * resolved is not this file.
 */
export function startedOnThisFile(argv1 = process.argv[1], here = import.meta.url) {
    if (!argv1) return false;
    try {
        return here === pathToFileURL(fs.realpathSync(argv1)).href;
    } catch {
        return false;
    }
}

if (startedOnThisFile()) main();
