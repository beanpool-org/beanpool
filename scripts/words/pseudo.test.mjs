// pseudo.test.mjs — the pseudo-locale's nightly run on the web app (translation tooling design §2.5, slice T4):
// apps/pwa/e2e/words-screens-all.mjs runs every web words check, and scripts/merge-queue/tripwire.sh runs it once a day.
// Imported by words.test.mjs, so test-all.sh's "words" check runs it. Nothing here opens a browser or reads a catalog, so it
// holds for JSON catalogs today and for PO ones after slice T1: no file format is read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './words.mjs';

const E2E = path.join(ROOT, 'apps/pwa/e2e');
const { CHECKS, checksToRun, summaryLine } = await import(pathToFileURL(path.join(E2E, 'words-screens-all.mjs')).href);

test('the nightly runner runs every web words check in apps/pwa/e2e: a new one cannot be left out', () => {
    // The screen checks are words-*check.mjs. words-chunks-check measures the build's chunks, not a screen; the runner is not a check.
    const onDisk = fs.readdirSync(E2E).filter((f) => /^words-.*check\.mjs$/.test(f) && f !== 'words-chunks-check.mjs').sort();
    assert.deepEqual(CHECKS.map((c) => c.file).sort(), onDisk);
    for (const c of CHECKS) {
        const text = fs.readFileSync(path.join(E2E, c.file), 'utf8');
        assert.match(text, /argv\[2\]/, `${c.file} takes an out-dir as its first argument, as the runner passes it`);
        assert.match(text, /'xx'|"xx"/, `${c.file} opens its screens in the pseudo-locale`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/pwa/package.json'), 'utf8'));
    assert.equal(pkg.scripts['words-screens-all'], 'node e2e/words-screens-all.mjs');
});

test('the runner picks all checks, or the named ones in their own order, and refuses a name it does not know', () => {
    assert.deepEqual(checksToRun(undefined).map((c) => c.name), ['screens', 'w1', 'w2', 'w3', 'w4']);
    assert.deepEqual(checksToRun('w4, w1').map((c) => c.name), ['w1', 'w4']);
    assert.throws(() => checksToRun('w1,w9'), /w9, which is no check here/);
});

test('the last line names every check that failed, so one red never hides another', () => {
    assert.equal(summaryLine([{ name: 'screens', status: 0 }, { name: 'w1', status: 0 }]), 'words-screens-all: ok — screens, w1');
    assert.equal(
        summaryLine([{ name: 'screens', status: 1 }, { name: 'w1', status: 0 }, { name: 'w2', status: 1 }]),
        'words-screens-all: FAILED screens, w2 (passed w1)',
    );
    assert.equal(summaryLine([{ name: 'w3', status: 1 }]), 'words-screens-all: FAILED w3');
});

test('the tripwire runs the runner after the full run, from the package script the runner is named by', () => {
    const tripwire = fs.readFileSync(path.join(ROOT, 'scripts/merge-queue/tripwire.sh'), 'utf8');
    assert.match(tripwire, /words_screens_run\(\) \{[^}]*pnpm --filter @beanpool\/pwa words-screens-all[^}]*\}/);
    assert.match(tripwire, /\$\{TRIPWIRE_WORDS_RUN:-words_screens_run\}/);
    assert.ok(tripwire.indexOf('${TRIPWIRE_RUN:-') < tripwire.indexOf('${TRIPWIRE_WORDS_RUN:-'), 'the full run comes first');
});
