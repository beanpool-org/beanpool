// scripts/check-no-node-names.mjs can fail (memory: a check must be able to fail). Each case writes a small tree in a temp
// directory and runs the scanner and the baseline judge on it, as the script does on the repository; the last case runs the
// script itself on the repository, which passes only while nothing new names one of our communities.
//
//   node --test scripts/check-no-node-names.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS_FILE, judge, lowerBaseline, scan } from './check-no-node-names.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function tree(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-node-names-'));
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
    }
    return { dir, files: Object.keys(files) };
}

function check(files, baseline = {}) {
    const t = tree(files);
    try {
        const { counts } = scan(t.dir, t.files);
        return { counts, ...judge(counts, baseline) };
    } finally {
        fs.rmSync(t.dir, { recursive: true, force: true });
    }
}

test('a community of ours named in code fails, whatever its case, in a comment or a test', () => {
    const r = check({
        'apps/server/src/seed.ts': "const NODES = [{ id: 'mullum', url: 'https://byron.beanpool.org' }];\n",
        'apps/native/app/chat.tsx': "t('Connected via Mullum Node')\n",
        'packages/beanpool-core/src/x.ts': '// as Castlemaine does\n',
        'apps/pwa/src/x.test.ts': "expect(name).toBe('East Gippsland');\n",
    });
    assert.deepEqual(r.counts, {
        'apps/server/src/seed.ts': 2,
        'apps/native/app/chat.tsx': 1,
        'packages/beanpool-core/src/x.ts': 1,
        'apps/pwa/src/x.test.ts': 1,
    });
    assert.equal(r.over.length, 4);
});

test('every name and server address in the brief is caught', () => {
    for (const name of ['mullum', 'Mullumbimby', 'byron', 'Byron Bay', 'castlemaine', 'bindarrabi', 'eastgippy', 'gippsland', 'apollobay',
        'Apollo Bay', 'melb', 'Melbourne', 'bris', 'Brisbane', 'test.beanpool.org', 'review.beanpool.org', 'global.beanpool.org']) {
        const r = check({ 'apps/server/src/a.ts': `const x = '${name}';\n` });
        assert.equal(r.over.length, 1, `${name} is caught`);
    }
});

test('words that only contain a short name, and time zones, are not ours', () => {
    const r = check({
        'apps/server/src/a.ts': "const w = ['brisk', 'debris', 'Melba toast', 'BRISKET']; const tz = 'Australia/Brisbane' + 'Australia/Melbourne';\n",
        'apps/server/src/b.ts': "const contest = 'https://contest.beanpool.org'; const r = 'https://preview.beanpool.org';\n",
    });
    assert.deepEqual(r.counts, {});
    assert.deepEqual(r.over, []);
});

test("the global community's address is allowed in the defaults file only", () => {
    const r = check({
        [DEFAULTS_FILE]: "export const DEFAULT_GLOBAL_COMMUNITY_URL = 'https://global.beanpool.org';\n",
        'apps/pwa/src/lib/global.ts': "export const URL = 'https://global.beanpool.org';\n",
    });
    assert.deepEqual(r.counts, { 'apps/pwa/src/lib/global.ts': 1 });
    const own = check({ [DEFAULTS_FILE]: "// e.g. mullum\nexport const X = 'https://global.beanpool.org';\n" });
    assert.deepEqual(own.counts, { [DEFAULTS_FILE]: 1 }, 'the defaults file names no community of ours either');
});

test('recorded fixtures, migrations and out-of-scope pages are not read', () => {
    const r = check({
        'apps/server/src/__fixtures__/schema-v1.2.18.sql': "INSERT INTO x VALUES ('mullum');\n",
        'apps/registrar/migrations/0014_reserve_byron.sql': "INSERT INTO name_policy VALUES ('byron');\n",
        'apps/website/index.html': '<p>Mullumbimby</p>\n',
        'packages/beanpool-guide/content/talk/messages.md': 'Byron\n',
        'apps/registrar/wrangler.toml': 'mullum\n',
    });
    assert.deepEqual(r.counts, {});
});

test('the baseline: a file over its count fails, a file under it is reported, and --update only lowers', () => {
    const base = { 'apps/server/src/a.ts': 2, 'apps/server/src/gone.ts': 1 };
    const over = check({ 'apps/server/src/a.ts': 'mullum mullum mullum\n' }, base);
    assert.deepEqual(over.over, ['apps/server/src/a.ts: 3 node name(s), 2 allowed']);
    const under = check({ 'apps/server/src/a.ts': 'mullum\n' }, base);
    assert.deepEqual(under.over, []);
    assert.deepEqual(under.lowered, ['apps/server/src/a.ts: 1 now, baseline 2', 'apps/server/src/gone.ts: 0 now, baseline 1']);
    assert.deepEqual(lowerBaseline({ 'apps/server/src/a.ts': 1, 'apps/server/src/new.ts': 4 }, base), { 'apps/server/src/a.ts': 1 },
        'lowered, the gone file dropped, and a new file never added');
    assert.deepEqual(lowerBaseline({ 'apps/server/src/a.ts': 5 }, base), { 'apps/server/src/a.ts': 2 }, 'never raised');
});

test('the repository passes: nothing names one of our communities beyond the baseline', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/check-no-node-names.mjs')], { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /no new node names in the code/);
});
