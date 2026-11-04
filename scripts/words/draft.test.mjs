// draft.test.mjs — tests for words:draft (slice S8).
// node --test scripts/words/draft.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
    APP_CATALOG_DEFS,
    SAFETY_MONEY_PATTERNS,
    draftCli,
    draftStatus,
    isSafetyOrMoney,
    reportDraft,
    scanAppWords,
    scanGuidePages,
    scanGuideTitles,
    scanWebsitePages,
    writeBriefs,
} from './draft.mjs';
import { guideBodyHash, loadGuide } from '../../packages/beanpool-guide/src/guide.mjs';
import { guideSourceHash } from '../../packages/beanpool-guide/src/titles.mjs';
import { ROOT, baselineBase, catalogLangs, extractRepo, loadCoreChecks } from './words.mjs';

function makeTempDir(prefix = 'words-draft-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('isSafetyOrMoney matches reviewed safety and money patterns and ignores general text', () => {
    // Safety / Money patterns
    assert.equal(isSafetyOrMoney('Show my 12 words recovery phrase'), true);
    assert.equal(isSafetyOrMoney('check-your-12-words'), true);
    assert.equal(isSafetyOrMoney('Account recovery options'), true);
    assert.equal(isSafetyOrMoney('Please sign-in to continue'), true);
    assert.equal(isSafetyOrMoney('leaving-or-deleting'), true);
    assert.equal(isSafetyOrMoney('leaving or deleting'), true);
    assert.equal(isSafetyOrMoney('Delete your account permanently'), true);
    assert.equal(isSafetyOrMoney('Remove member from group'), true);
    assert.equal(isSafetyOrMoney('You sent 500 Beans'), true);
    assert.equal(isSafetyOrMoney('Check your Beans balance'), true);
    assert.equal(isSafetyOrMoney('circulation fee of beans'), true);
    assert.equal(isSafetyOrMoney('trading-partner-limit'), true);
    assert.equal(isSafetyOrMoney('Exceeded daily limits'), true);
    assert.equal(isSafetyOrMoney('who can see my posts'), true);
    assert.equal(isSafetyOrMoney('who-can-see'), true);
    assert.equal(isSafetyOrMoney('what-the-admins-can-see'), true);
    assert.equal(isSafetyOrMoney('Community privacy settings'), true);
    assert.equal(isSafetyOrMoney('Recover your account'), true);
    assert.equal(isSafetyOrMoney('Account deletion'), true);
    assert.equal(isSafetyOrMoney('Removing member'), true);
    assert.equal(isSafetyOrMoney('Balance: {amount} Beans'), true);
    assert.equal(isSafetyOrMoney('{n} Beans'), true);

    // Normal strings
    assert.equal(isSafetyOrMoney('Welcome home'), false);
    assert.equal(isSafetyOrMoney('Save changes'), false);
    assert.equal(isSafetyOrMoney('Choose light or dark theme'), false);
    assert.equal(isSafetyOrMoney('Type a town or suburb'), false);
    assert.equal(isSafetyOrMoney(''), false);
    assert.equal(isSafetyOrMoney(null), false);
});

test('scanAppWords accurately detects missing keys even if they collide with Object.prototype properties', async () => {
    const tmp = makeTempDir();
    try {
        const catalogDefs = [{ name: 'core', folder: 'packages/beanpool-core/words' }];
        fs.mkdirSync(path.join(tmp, 'packages/beanpool-core/words'), { recursive: true });
        fs.writeFileSync(
            path.join(tmp, 'packages/beanpool-core/words/es.json'),
            JSON.stringify({ _meta: { language: 'es' } }),
        );
        const extracted = [
            {
                name: 'core',
                words: 'packages/beanpool-core/words',
                calls: [{ fn: 't', text: 'toString', at: 'core/a.ts:1' }],
            },
        ];
        const result = await scanAppWords({ root: tmp, catalogDefs, langs: ['es'], extracted });
        assert.equal(result.es.missing, 1);
        assert.equal(result.es.byCatalog.core.missingKeys[0].key, 'toString');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanAppWords accurately counts missing, stale (0), and orphaned keys with fixtures', async () => {
    const tmp = makeTempDir();
    try {
        const catalogDefs = [
            { name: 'core', folder: 'packages/beanpool-core/words' },
            { name: 'native', folder: 'apps/native/words' },
        ];
        fs.mkdirSync(path.join(tmp, 'packages/beanpool-core/words'), { recursive: true });
        fs.mkdirSync(path.join(tmp, 'apps/native/words'), { recursive: true });

        // Catalog files
        // core: has "Save", missing "Confirm transfer"
        fs.writeFileSync(
            path.join(tmp, 'packages/beanpool-core/words/es.json'),
            JSON.stringify({ _meta: { language: 'es' }, Save: 'Guardar' }),
        );
        // native: has "Hello", but also "Old sentence" (orphaned)
        fs.writeFileSync(
            path.join(tmp, 'apps/native/words/es.json'),
            JSON.stringify({ _meta: { language: 'es' }, Hello: 'Hola', 'Old sentence': 'Viejo' }),
        );

        // Extracted mock
        const extracted = [
            {
                name: 'core',
                words: 'packages/beanpool-core/words',
                calls: [
                    { fn: 't', text: 'Save', at: 'core/a.ts:10' },
                    { fn: 't', text: 'Confirm transfer', at: 'core/b.ts:25' },
                ],
            },
            {
                name: 'native',
                words: 'apps/native/words',
                calls: [
                    { fn: 't', text: 'Hello', at: 'native/app.tsx:5' },
                ],
            },
        ];

        const result = await scanAppWords({
            root: tmp,
            catalogDefs,
            langs: ['es'],
            extracted,
        });

        const es = result.es;
        assert.equal(es.missing, 1); // "Confirm transfer" in core
        assert.equal(es.orphaned, 1); // "Old sentence" in native
        assert.equal(es.stale, 0);

        assert.equal(es.byCatalog.core.missing, 1);
        assert.equal(es.byCatalog.core.missingKeys[0].key, 'Confirm transfer');
        assert.equal(es.byCatalog.core.orphaned, 0);

        assert.equal(es.byCatalog.native.missing, 0);
        assert.equal(es.byCatalog.native.orphaned, 1);
        assert.equal(es.byCatalog.native.orphanedKeys[0].key, 'Old sentence');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('guide titles: a key whose English changed is stale; missing lines are missing', () => {
    const tmp = makeTempDir();
    try {
        const contentDir = path.join(tmp, 'packages/beanpool-guide/content');
        fs.mkdirSync(path.join(contentDir, 'about'), { recursive: true });
        fs.mkdirSync(path.join(contentDir, 'es'), { recursive: true });

        // English manifest with two pages so related works
        fs.writeFileSync(
            path.join(contentDir, 'manifest.json'),
            JSON.stringify({
                sections: [
                    { id: 'about', title: 'About BeanPool', summary: 'How it works', pages: ['the-bean', 'other-page'] },
                ],
            }),
        );
        fs.writeFileSync(
            path.join(contentDir, 'about/the-bean.md'),
            '---\nslug: the-bean\ntitle: The Bean Currency\nsummary: All about beans\nrelated: other-page\n---\n\n## Section\n\nBody paragraph.\n',
        );
        fs.writeFileSync(
            path.join(contentDir, 'about/other-page.md'),
            '---\nslug: other-page\ntitle: Other Page\nsummary: Another summary\nrelated: the-bean\n---\n\n## Section\n\nOther body.\n',
        );

        // Target language manifest for 'es':
        // - sections.about.title is current
        // - sections.about.summary was drafted from old English ("Old summary") -> STALE!
        // - pages.the-bean.* are omitted -> MISSING!
        const currentTitleHash = guideSourceHash('About BeanPool');
        const oldSummaryHash = guideSourceHash('Old summary');

        fs.writeFileSync(
            path.join(contentDir, 'es/manifest.json'),
            JSON.stringify({
                _meta: { language: 'es' },
                sections: {
                    about: {
                        title: { text: 'Sobre BeanPool', sourceHash: currentTitleHash },
                        summary: { text: 'Resumen viejo', sourceHash: oldSummaryHash },
                    },
                },
                pages: {
                    'other-page': {
                        title: { text: 'Otra página', sourceHash: guideSourceHash('Other Page') },
                        summary: { text: 'Otro resumen', sourceHash: guideSourceHash('Another summary') },
                    },
                },
            }),
        );

        const titles = scanGuideTitles({ root: tmp, langs: ['es'] });
        const es = titles.byLang.es;

        // sections.about.summary is stale
        assert.equal(es.stale, 1);
        assert.equal(es.staleItems[0].key, 'sections.about.summary');

        // pages.the-bean.title, summary are missing
        assert.equal(es.missing, 2);
        assert.ok(es.missingItems.some((it) => it.key === 'pages.the-bean.title'));
        assert.ok(es.missingItems.some((it) => it.key === 'pages.the-bean.summary'));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('guide pages: missing files are missing, source-hash behind is stale, equal hash is current', () => {
    const tmp = makeTempDir();
    try {
        const contentDir = path.join(tmp, 'packages/beanpool-guide/content');
        fs.mkdirSync(path.join(contentDir, 'about'), { recursive: true });
        fs.mkdirSync(path.join(contentDir, 'es/about'), { recursive: true });

        fs.writeFileSync(
            path.join(contentDir, 'manifest.json'),
            JSON.stringify({
                sections: [
                    { id: 'about', title: 'About', summary: 'Summary', pages: ['page-a', 'page-b', 'page-c'] },
                ],
            }),
        );

        const pageA = '---\nslug: page-a\ntitle: Page A\nsummary: Sum A\nrelated: page-b\n---\n\n## Head A\n\nBody A\n';
        const pageB = '---\nslug: page-b\ntitle: Page B\nsummary: Sum B\nrelated: page-c\n---\n\n## Head B\n\nBody B\n';
        const pageC = '---\nslug: page-c\ntitle: Page C\nsummary: Sum C\nrelated: page-a\n---\n\n## Head C\n\nBody C\n';

        fs.writeFileSync(path.join(contentDir, 'about/page-a.md'), pageA);
        fs.writeFileSync(path.join(contentDir, 'about/page-b.md'), pageB);
        fs.writeFileSync(path.join(contentDir, 'about/page-c.md'), pageC);

        // Now for 'es':
        // page-a: exists and current source-hash
        const hashA = guideBodyHash([{ type: 'h2', text: 'Head A' }, { type: 'p', text: 'Body A' }]);
        fs.writeFileSync(
            path.join(contentDir, 'es/about/page-a.md'),
            `---\nslug: page-a\ntitle: Página A\nsummary: Sum A\nrelated: page-b\nsource-hash: ${hashA}\n---\n\n## Head A\n\nCuerpo traducido A\n`,
        );

        // page-b: exists but source-hash is behind (stale)
        fs.writeFileSync(
            path.join(contentDir, 'es/about/page-b.md'),
            '---\nslug: page-b\ntitle: Página B\nsummary: Sum B\nrelated: page-c\nsource-hash: 0123456789abcdef\n---\n\n## Head B\n\nCuerpo B\n',
        );

        // page-c: no file -> missing!

        const result = scanGuidePages({ root: tmp, langs: ['es'] });
        const es = result.es;

        assert.equal(es.missing, 1);
        assert.equal(es.missingPages[0].slug, 'page-c');

        assert.equal(es.stale, 1);
        assert.equal(es.stalePages[0].slug, 'page-b');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanWebsitePages returns skipped when S6 is not implemented', async () => {
    const tmp = makeTempDir();
    try {
        const res = await scanWebsitePages(tmp, ['es']);
        assert.equal(res.implemented, false);
        assert.equal(res.message, 'website pages: skipped (S6 not yet implemented)');
        assert.equal(res.missing, 0);
        assert.equal(res.stale, 0);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanWebsitePages catches async errors from hook gracefully', async () => {
    const tmp = makeTempDir();
    try {
        const hookDir = path.join(tmp, 'apps/website/scripts');
        fs.mkdirSync(hookDir, { recursive: true });
        fs.writeFileSync(
            path.join(hookDir, 'pages.mjs'),
            'export async function checkWebsitePages() { throw new Error("async boom"); }\n',
        );
        const res = await scanWebsitePages(tmp, ['es']);
        assert.equal(res.implemented, false);
        assert.equal(res.missing, 0);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('writeBriefs creates deterministic, self-contained brief files with style rules, exact keys, and capped by --max-keys', async () => {
    const tmp = makeTempDir();
    try {
        const contentDir = path.join(tmp, 'packages/beanpool-guide/content');
        fs.mkdirSync(path.join(contentDir, 'about'), { recursive: true });
        fs.mkdirSync(path.join(contentDir, 'es'), { recursive: true });
        fs.mkdirSync(path.join(tmp, 'packages/beanpool-core/words'), { recursive: true });
        fs.mkdirSync(path.join(tmp, 'apps/native/words'), { recursive: true });
        fs.mkdirSync(path.join(tmp, 'apps/pwa/words'), { recursive: true });
        fs.mkdirSync(path.join(tmp, 'scripts/words'), { recursive: true });

        // STYLE.md
        fs.writeFileSync(path.join(tmp, 'scripts/words/STYLE.md'), '# Style Rules\n- Warm, plain and short\n- Beans translated\n');

        // English guide with 2 pages
        fs.writeFileSync(
            path.join(contentDir, 'manifest.json'),
            JSON.stringify({
                sections: [{ id: 'about', title: 'About', summary: 'Sum', pages: ['faq', 'intro'] }],
            }),
        );
        fs.writeFileSync(
            path.join(contentDir, 'about/faq.md'),
            '---\nslug: faq\ntitle: FAQ\nsummary: Questions\nrelated: intro\n---\n\n## Questions\n\nAnswers.\n',
        );
        fs.writeFileSync(
            path.join(contentDir, 'about/intro.md'),
            '---\nslug: intro\ntitle: Intro\nsummary: Overview\nrelated: faq\n---\n\n## Intro\n\nText.\n',
        );

        // es manifest and catalogs
        fs.writeFileSync(path.join(contentDir, 'es/manifest.json'), JSON.stringify({ sections: {}, pages: {} }));
        fs.writeFileSync(path.join(tmp, 'packages/beanpool-core/words/es.json'), JSON.stringify({ _meta: {} }));
        fs.writeFileSync(path.join(tmp, 'apps/native/words/es.json'), JSON.stringify({ _meta: {} }));
        fs.writeFileSync(path.join(tmp, 'apps/pwa/words/es.json'), JSON.stringify({ _meta: {} }));

        const briefsDir = path.join(tmp, 'draft-briefs');
        const rc = await writeBriefs({ root: tmp, dir: briefsDir, langs: ['es'], maxKeys: 2, extracted: [] });
        assert.equal(rc, 0);

        const briefPath = path.join(briefsDir, 'brief-es.md');
        assert.ok(fs.existsSync(briefPath));
        const firstRunText = fs.readFileSync(briefPath, 'utf8');

        // Verify style rules embedded
        assert.match(firstRunText, /# Style Rules/);
        assert.match(firstRunText, /Warm, plain and short/);

        // Verify commit instructions present with interpolated lang and mkdir -p in Section C
        assert.match(firstRunText, /git commit -m "Words: es <catalog> \(machine draft\)"/);
        assert.match(firstRunText, /git commit -m "Guide page: es <slug> \(machine draft\)"/);
        assert.match(firstRunText, /mkdir -p packages\/beanpool-guide\/content\/es\/<section>/);

        // Verify deterministic output: second run matches byte-for-byte
        await writeBriefs({ root: tmp, dir: briefsDir, langs: ['es'], maxKeys: 2, extracted: [] });
        const secondRunText = fs.readFileSync(briefPath, 'utf8');
        assert.equal(firstRunText, secondRunText);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('assert draft script NEVER spawns child processes', async () => {
    let processSpawns = 0;
    const originals = {
        exec: childProcess.exec,
        execSync: childProcess.execSync,
        execFile: childProcess.execFile,
        execFileSync: childProcess.execFileSync,
        spawn: childProcess.spawn,
        spawnSync: childProcess.spawnSync,
    };

    const intercept = () => {
        processSpawns++;
        throw new Error('drafting tooling must never spawn a child process!');
    };

    try {
        childProcess.exec = intercept;
        childProcess.execSync = intercept;
        childProcess.execFile = intercept;
        childProcess.execFileSync = intercept;
        childProcess.spawn = intercept;
        childProcess.spawnSync = intercept;
        module.syncBuiltinESMExports();

        // Run draftStatus
        const status = await draftStatus({ langs: ['es'] });
        assert.ok(status.summaryLine.startsWith('words:draft:'));

        // Run writeBriefs
        const tmp = makeTempDir();
        try {
            await writeBriefs({ dir: path.join(tmp, 'briefs'), langs: ['es'], maxKeys: 5 });
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }

        // Verify 0 child processes spawned
        assert.equal(processSpawns, 0);
    } finally {
        Object.assign(childProcess, originals);
        module.syncBuiltinESMExports();
    }
});

test('assert child process spawn guard catches words.mjs execFileSync', () => {
    let processSpawns = 0;
    const originals = {
        execFileSync: childProcess.execFileSync,
    };
    const intercept = () => {
        processSpawns++;
        throw new Error('drafting tooling must never spawn a child process!');
    };

    try {
        childProcess.execFileSync = intercept;
        module.syncBuiltinESMExports();

        // words.mjs's baselineBase executes git via named execFileSync import
        baselineBase();
        assert.equal(processSpawns, 1, 'Expected guard to catch execFileSync call from words.mjs');
    } finally {
        Object.assign(childProcess, originals);
        module.syncBuiltinESMExports();
    }
});

test('draftCli with empty --langs falls back to scanning all catalog languages instead of 0', async () => {
    // Calling draftCli with --report and --langs "" should not crash and should scan all languages
    const origLog = console.log;
    let output = '';
    console.log = (...args) => { output += args.join(' ') + '\n'; };
    try {
        const rc = await draftCli(['--report', '--langs', '']);
        assert.equal(rc, 0);
        assert.ok(!output.includes('across 0 languages'));
    } finally {
        console.log = origLog;
    }
});

test('writeBriefs rejects invalid language codes with path traversal', async () => {
    const tmp = makeTempDir();
    try {
        await assert.rejects(
            async () => {
                await writeBriefs({ root: tmp, dir: path.join(tmp, 'briefs'), langs: ['../../exploit'] });
            },
            /Invalid language code/,
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('reportDraft on scan error prints SCAN ERROR, never prints 0 missing, and exits 2', async () => {
    const tmp = makeTempDir();
    try {
        let errOut = '';
        let stdOut = '';
        const origErr = console.error;
        const origLog = console.log;
        console.error = (...args) => { errOut += args.join(' ') + '\n'; };
        console.log = (...args) => { stdOut += args.join(' ') + '\n'; };
        try {
            // Point root to an empty temp dir that lacks guide manifest
            const rc = await reportDraft({ root: tmp });
            assert.equal(rc, 2);
            assert.match(errOut, /^words:draft: SCAN ERROR — /);
            assert.ok(!errOut.includes('0 missing'));
            assert.ok(!stdOut.includes('0 missing'));
        } finally {
            console.error = origErr;
            console.log = origLog;
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('writeBriefs reflects custom catalogDefs in header summary', async () => {
    const tmp = makeTempDir();
    try {
        const contentDir = path.join(tmp, 'packages/beanpool-guide/content');
        fs.mkdirSync(path.join(contentDir, 'about'), { recursive: true });
        fs.mkdirSync(path.join(contentDir, 'es'), { recursive: true });
        fs.writeFileSync(
            path.join(contentDir, 'manifest.json'),
            JSON.stringify({
                sections: [{ id: 'about', title: 'About', summary: 'Sum', pages: ['faq', 'intro'] }],
            }),
        );
        fs.writeFileSync(
            path.join(contentDir, 'about/faq.md'),
            '---\nslug: faq\ntitle: FAQ\nsummary: Questions\nrelated: intro\n---\n\n## Questions\n\nAnswers.\n',
        );
        fs.writeFileSync(
            path.join(contentDir, 'about/intro.md'),
            '---\nslug: intro\ntitle: Intro\nsummary: Overview\nrelated: faq\n---\n\n## Intro\n\nText.\n',
        );
        fs.writeFileSync(path.join(contentDir, 'es/manifest.json'), JSON.stringify({ sections: {}, pages: {} }));
        fs.mkdirSync(path.join(tmp, 'custom-pkg/words'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'custom-pkg/words/es.json'), JSON.stringify({ _meta: {} }));

        const briefsDir = path.join(tmp, 'briefs');
        const customDefs = [{ name: 'custom-pkg', folder: 'custom-pkg/words' }];
        const extracted = [
            {
                name: 'custom-pkg',
                words: 'custom-pkg/words',
                calls: [{ fn: 't', text: 'Custom key', at: 'file.ts:1' }],
            },
        ];

        const rc = await writeBriefs({
            root: tmp,
            dir: briefsDir,
            langs: ['es'],
            catalogDefs: customDefs,
            extracted,
        });
        assert.equal(rc, 0);

        const briefText = fs.readFileSync(path.join(briefsDir, 'brief-es.md'), 'utf8');
        assert.match(briefText, /- App words missing: custom-pkg \(1\)/);
        assert.ok(!briefText.includes('core ('));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('README runner regex matches all 24 supported languages including 2- and 3-letter codes and zh subtags', async () => {
    const allLangs = [
        'es', 'pt', 'hi', 'bn', 'fr', 'ar', 'id', 'ru',
        'zh-Hans', 'zh-Hant', 'it', 'de', 'tr', 'sw', 'ml',
        'ta', 'uk', 'ur', 'fa', 'vi', 'el', 'fil', 'ja', 'ko',
    ];
    assert.equal(allLangs.length, 24);

    const regex = /^[a-z]{2,3}(-[A-Za-z]+)?:$/;
    for (const lang of allLangs) {
        assert.ok(regex.test(`${lang}:`), `Expected regex to match "${lang}:"`);
    }

    // Verify against report output lines
    let reportOutput = '';
    const origLog = console.log;
    console.log = (...args) => { reportOutput += args.join(' ') + '\n'; };
    try {
        const rc = await reportDraft();
        assert.equal(rc, 0);
        const matched = reportOutput
            .split('\n')
            .filter((line) => /^[a-z]{2,3}(-[A-Za-z]+)?:$/.test(line.trim()))
            .map((line) => line.trim().replace(':', ''));
        assert.equal(matched.length, 24);
        assert.ok(matched.includes('fil'));
        assert.ok(matched.includes('zh-Hans'));
        assert.ok(matched.includes('zh-Hant'));
    } finally {
        console.log = origLog;
    }
});

test('apps/server/words is scanned as fourth catalog, counting in --report and appearing in briefs', async () => {
    assert.equal(APP_CATALOG_DEFS.length, 4);
    assert.deepEqual(APP_CATALOG_DEFS[3], { name: 'server', folder: 'apps/server/words' });

    // Verify draftStatus includes server for es
    const status = await draftStatus({ langs: ['es'] });
    const es = status.perLang.es;
    assert.ok(es.appWords.byCatalog.server, 'es should include server catalog');
    // The count is live data (drafting rounds shrink it), so the report, the key list and the brief must agree on it.
    const n = es.appWords.byCatalog.server.missing;
    assert.equal(es.appWords.byCatalog.server.missingKeys.length, n);

    // Verify brief includes server catalog and its missing keys
    const tmp = makeTempDir();
    try {
        const briefsDir = path.join(tmp, 'briefs');
        await writeBriefs({ dir: briefsDir, langs: ['es'] });
        const briefContent = fs.readFileSync(path.join(briefsDir, 'brief-es.md'), 'utf8');
        if (n > 0) {
            assert.ok(briefContent.includes(`server (${n})`), 'the brief counts the server catalog');
            assert.ok(briefContent.includes(`#### Catalog: apps/server/words/es.json (${n} missing)`), 'the brief lists its keys');
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('writeBriefs removes old brief-*.md files and leaves no brief for a completed language', async () => {
    const tmp = makeTempDir();
    try {
        const contentDir = path.join(tmp, 'packages/beanpool-guide/content');
        fs.mkdirSync(path.join(contentDir, 'about'), { recursive: true });
        fs.mkdirSync(path.join(contentDir, 'es/about'), { recursive: true });
        fs.writeFileSync(
            path.join(contentDir, 'manifest.json'),
            JSON.stringify({
                sections: [{ id: 'about', title: 'About', summary: 'Sum', pages: ['faq', 'intro'] }],
            }),
        );
        fs.writeFileSync(
            path.join(contentDir, 'about/faq.md'),
            '---\nslug: faq\ntitle: FAQ\nsummary: Questions\nrelated: intro\n---\n\n## Questions\n\nAnswers.\n',
        );
        fs.writeFileSync(
            path.join(contentDir, 'about/intro.md'),
            '---\nslug: intro\ntitle: Intro\nsummary: Overview\nrelated: faq\n---\n\n## Intro\n\nText.\n',
        );
        // manifest has all titles translated
        fs.writeFileSync(path.join(contentDir, 'es/manifest.json'), JSON.stringify({
            sections: {
                about: {
                    title: { text: 'Acerca de', sourceHash: guideSourceHash('About') },
                    summary: { text: 'Resumen', sourceHash: guideSourceHash('Sum') },
                },
            },
            pages: {
                faq: {
                    title: { text: 'Preguntas', sourceHash: guideSourceHash('FAQ') },
                    summary: { text: 'Respuestas', sourceHash: guideSourceHash('Questions') },
                },
                intro: {
                    title: { text: 'Introducción', sourceHash: guideSourceHash('Intro') },
                    summary: { text: 'Resumen', sourceHash: guideSourceHash('Overview') },
                },
            },
        }));

        const guide = loadGuide(contentDir);
        const introG = guide.guides.find((g) => g.slug === 'intro');
        fs.writeFileSync(
            path.join(contentDir, 'es/about/intro.md'),
            `---\nslug: intro\ntitle: Intro\nsummary: Sum\nrelated: faq\nsource-hash: ${guideBodyHash(introG)}\n---\n\n## Introducción\n\nTexto.\n`,
        );

        fs.mkdirSync(path.join(tmp, 'packages/beanpool-core/words'), { recursive: true });
        const catDefs = [{ name: 'core', folder: 'packages/beanpool-core/words' }];
        const extracted = [
            {
                name: 'core',
                words: 'packages/beanpool-core/words',
                calls: [{ fn: 't', text: 'Save', at: 'file.ts:1' }],
            },
        ];

        // Round 1: es is missing "Save" and missing page "about/faq.md"
        fs.writeFileSync(path.join(tmp, 'packages/beanpool-core/words/es.json'), JSON.stringify({ _meta: {} }));
        const briefsDir = path.join(tmp, 'briefs');
        fs.mkdirSync(briefsDir, { recursive: true });
        fs.writeFileSync(path.join(briefsDir, 'notes.txt'), 'keep me');

        await writeBriefs({ root: tmp, dir: briefsDir, langs: ['es'], catalogDefs: catDefs, extracted });
        assert.equal(fs.existsSync(path.join(briefsDir, 'brief-es.md')), true);
        assert.equal(fs.existsSync(path.join(briefsDir, 'notes.txt')), true);

        // Round 2: Complete es by adding missing key and page
        fs.writeFileSync(
            path.join(tmp, 'packages/beanpool-core/words/es.json'),
            JSON.stringify({ _meta: {}, Save: 'Guardar' }),
        );
        const faqG = guide.guides.find((g) => g.slug === 'faq');
        fs.writeFileSync(
            path.join(contentDir, 'es/about/faq.md'),
            `---\nslug: faq\ntitle: FAQ\nsummary: Sum\nrelated: intro\nsource-hash: ${guideBodyHash(faqG)}\n---\n\n## Preguntas\n\nRespuestas.\n`,
        );

        // Run writeBriefs again on the same dir
        await writeBriefs({ root: tmp, dir: briefsDir, langs: ['es'], catalogDefs: catDefs, extracted });

        // Assert brief-es.md was removed and no brief was created
        assert.equal(fs.existsSync(path.join(briefsDir, 'brief-es.md')), false);
        const remainingBriefs = fs.readdirSync(briefsDir).filter((f) => /^brief-.*\.md$/.test(f));
        assert.equal(remainingBriefs.length, 0);
        assert.equal(fs.existsSync(path.join(briefsDir, 'notes.txt')), true);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('step 1 of Section C creates target directory and drafts pages successfully for missing pages', async () => {
    const tmp = makeTempDir();
    try {
        fs.mkdirSync(path.join(tmp, 'packages'), { recursive: true });
        fs.cpSync(path.join(ROOT, 'packages/beanpool-guide'), path.join(tmp, 'packages/beanpool-guide'), { recursive: true });

        // Day zero for es pages, whatever main holds by now: drop every es page (its titles file, manifest.json, stays), so
        // every English page is missing and the count never pins live data (round 2 took es from 44 missing to 1).
        const esDir = path.join(tmp, 'packages/beanpool-guide/content/es');
        for (const e of fs.readdirSync(esDir, { withFileTypes: true })) if (e.isDirectory()) fs.rmSync(path.join(esDir, e.name), { recursive: true });
        const english = loadGuide(path.join(tmp, 'packages/beanpool-guide/content')).guides;
        const pages = scanGuidePages({ root: tmp, langs: ['es'] });
        const missing = pages.es.missingPages;
        assert.ok(english.length > 0);
        assert.equal(missing.length, english.length);

        for (const page of missing) {
            const targetDir = path.join(tmp, 'packages/beanpool-guide/content/es', page.section);
            const targetFile = path.join(targetDir, `${page.slug}.md`);
            const script = path.join(tmp, 'packages/beanpool-guide/scripts/titles.mjs');
            const cmd = `mkdir -p "${targetDir}" && node "${script}" --draft-page es "${page.slug}" > "${targetFile}"`;
            childProcess.execSync(cmd);
            assert.ok(fs.existsSync(targetFile), `Expected ${targetFile} to exist`);
            const content = fs.readFileSync(targetFile, 'utf8');
            assert.match(content, new RegExp(`slug: ${page.slug}`));
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── What counts as missing follows the tests (4 Nov, #2841 / #2842) ────────────────────────────────────────────────
//
//   (a) a sentence core's own sources use is core's alone in the phone and the web app (your-deals-words.test.ts forbids
//       the bare "Your deals" in their catalogs), so the tool must not ask for it there;
//   (b) the welcome screens' sentences are ordinary keys: language-switch-render.test.ts reads each language's own catalog
//       (#2847), so a round for some languages may draft them. The tool once held them back for a round of every language,
//       for a rule no test holds (#2846 review, 4 Nov); (b) fails if that comes back.

/** Write files (relative path -> text) under `tmp`. */
function writeTree(tmp, files) {
    for (const [rel, text] of Object.entries(files)) {
        const file = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
}

/** A catalog file for every language in each folder, holding what `have[folder][lang]` gives. */
async function writeCatalogs(tmp, folders, have = {}) {
    for (const folder of folders) {
        for (const lang of await catalogLangs(ROOT)) {
            writeTree(tmp, { [`${folder}/${lang}.json`]: JSON.stringify({ _meta: { language: lang }, ...(have[folder]?.[lang] ?? {}) }) });
        }
    }
}

/** A two-page guide in `tmp`; the languages in `translated` have all of it, the others an empty titles file. */
async function writeGuide(tmp, translated = []) {
    const contentDir = path.join(tmp, 'packages/beanpool-guide/content');
    writeTree(tmp, {
        'packages/beanpool-guide/content/manifest.json': JSON.stringify({ sections: [{ id: 'about', title: 'About', summary: 'Sum', pages: ['faq', 'intro'] }] }),
        'packages/beanpool-guide/content/about/faq.md': '---\nslug: faq\ntitle: FAQ\nsummary: Questions\nrelated: intro\n---\n\n## Questions\n\nAnswers.\n',
        'packages/beanpool-guide/content/about/intro.md': '---\nslug: intro\ntitle: Intro\nsummary: Overview\nrelated: faq\n---\n\n## Intro\n\nText.\n',
    });
    const guide = loadGuide(contentDir);
    const related = { faq: 'intro', intro: 'faq' };
    for (const lang of await catalogLangs(ROOT)) {
        if (!translated.includes(lang)) {
            writeTree(tmp, { [`packages/beanpool-guide/content/${lang}/manifest.json`]: JSON.stringify({ sections: {}, pages: {} }) });
            continue;
        }
        writeTree(tmp, {
            [`packages/beanpool-guide/content/${lang}/manifest.json`]: JSON.stringify({
                sections: { about: { title: { text: 'Acerca de', sourceHash: guideSourceHash('About') }, summary: { text: 'Resumen', sourceHash: guideSourceHash('Sum') } } },
                pages: {
                    faq: { title: { text: 'Preguntas', sourceHash: guideSourceHash('FAQ') }, summary: { text: 'Respuestas', sourceHash: guideSourceHash('Questions') } },
                    intro: { title: { text: 'Introducción', sourceHash: guideSourceHash('Intro') }, summary: { text: 'Resumen', sourceHash: guideSourceHash('Overview') } },
                },
            }),
        });
        for (const g of guide.guides) {
            writeTree(tmp, {
                [`packages/beanpool-guide/content/${lang}/${g.section}/${g.slug}.md`]:
                    `---\nslug: ${g.slug}\ntitle: ${g.title}\nsummary: Sum\nrelated: ${related[g.slug]}\nsource-hash: ${guideBodyHash(g)}\n---\n\n## ${g.title}\n\nTexto.\n`,
            });
        }
    }
}

/** The text of `fn`'s console.log lines. */
async function captureLog(fn) {
    let out = '';
    const original = console.log;
    console.log = (...args) => { out += args.join(' ') + '\n'; };
    try {
        await fn();
    } finally {
        console.log = original;
    }
    return out;
}

/** The part of a brief under one app catalog's heading. */
function catalogSection(brief, folder, lang) {
    const start = brief.indexOf(`#### Catalog: ${folder}/${lang}.json`);
    assert.ok(start >= 0, `the brief has a section for ${folder}/${lang}.json`);
    const rest = brief.slice(start + 10);
    const next = rest.search(/\n#### Catalog: |\n### 2\./);
    return next < 0 ? rest : rest.slice(0, next);
}

const keyLine = (key) => `- **Key**: ${JSON.stringify(key)}`;

// The welcome screens' two files, as the phone has them. (The extractor knows `word` and `t` by their import, or from a
// words hook, as in the real files.)
const WELCOME_SOURCE = `
import { Alert } from 'react-native';
export function Welcome() {
    const { t } = useWords();
    const first = t('Welcome A');
    const second = t("Welcome B");
    Alert.alert(t('In an alert'), t('Also in an alert'));
    return [first, second];
}
`;
const DOORS_SOURCE = `
export function Doors() {
    const { t } = useWords();
    return t('Door A');
}
`;
const OTHER_SOURCE = `
export function Other() {
    const { t } = useWords();
    return [t('Plain other'), t('Shared')];
}
`;
const coreSource = (...keys) => `import { word } from './words.js';\nexport const shared = [${keys.map((k) => `word(${JSON.stringify(k)})`).join(', ')}];\n`;
// Every phone key of the fixture except core's "Shared".
const PHONE_KEYS = ['Also in an alert', 'Door A', 'In an alert', 'Plain other', 'Welcome A', 'Welcome B'];

/** A small tree with the welcome screens' two files at their real paths, one more phone file, core's sources and a catalog for every language. */
async function welcomeTree(tmp, { coreKeys = ['Shared'], have = {}, translatedGuide = [] } = {}) {
    writeTree(tmp, {
        'apps/native/app/welcome.tsx': WELCOME_SOURCE,
        'apps/native/components/WelcomeDoors.tsx': DOORS_SOURCE,
        'apps/native/components/Other.tsx': OTHER_SOURCE,
        'packages/beanpool-core/src/shared.ts': coreSource(...coreKeys),
    });
    await writeCatalogs(tmp, ['packages/beanpool-core/words', 'apps/native/words'], have);
    await writeGuide(tmp, translatedGuide);
}

const missingByKey = (scan, lang, catalog) => Object.fromEntries(scan[lang].byCatalog[catalog].missingKeys.map((item) => [item.key, item]));

test('(a) a sentence core\'s own sources use is core\'s alone in the phone and the web app: not missing there, not orphaned, still missing in the server', async () => {
    const tmp = makeTempDir();
    try {
        writeTree(tmp, {
            'packages/beanpool-core/src/deals.ts': coreSource('Your deals', 'Core only'),
            'apps/native/components/Deals.tsx': "export function D() { const { t } = useWords(); return [t('Your deals'), t('Native only')]; }\n",
            'apps/pwa/src/Deals.tsx': "export function D() { const { t } = useWords(); return [t('Your deals'), t('Web only')]; }\n",
            'apps/server/src/deals.ts': "import { t } from '@beanpool/core';\nexport function d() { return [t('Your deals'), t('Server only')]; }\n",
        });
        // An older round put core's sentence in the phone's Spanish catalog: it is still used there, so it is not orphaned.
        await writeCatalogs(tmp, APP_CATALOG_DEFS.map((d) => d.folder), { 'apps/native/words': { es: { 'Your deals': 'Tus tratos' } } });
        const scan = await scanAppWords({ root: tmp, langs: ['es', 'pt'] });
        for (const lang of ['es', 'pt']) {
            assert.deepEqual(Object.keys(missingByKey(scan, lang, 'native')), ['Native only'], `${lang} native`);
            assert.deepEqual(Object.keys(missingByKey(scan, lang, 'pwa')), ['Web only'], `${lang} web`);
            // The server's refusals are translated with its own catalog alone, so core's copy does not stand for it there.
            assert.deepEqual(Object.keys(missingByKey(scan, lang, 'server')).sort(), ['Server only', 'Your deals'], `${lang} server`);
            // Core translates it: that is where it is missing.
            assert.deepEqual(Object.keys(missingByKey(scan, lang, 'core')).sort(), ['Core only', 'Your deals'], `${lang} core`);
        }
        assert.equal(scan.es.byCatalog.native.orphaned, 0, 'the old copy in the phone catalog is still a used key');
        // The report's total agrees with the lists.
        assert.equal(scan.es.missing, 1 + 1 + 2 + 2);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('(a) on this tree no list asks the phone or the web app for "Your deals", or for any sentence core\'s own sources use', async () => {
    const extracted = extractRepo(ROOT);
    const { callKey } = await loadCoreChecks(ROOT);
    const coreKeys = new Set(extracted.filter((p) => p.name === 'core').flatMap((p) => p.calls.map(callKey).filter(Boolean)));
    assert.ok(coreKeys.has('Your deals'), 'premise: core draws the bare "Your deals" (Deals S7, your-deals-words.test.ts)');

    // Every language: the lists of what is missing.
    const scan = await scanAppWords({ root: ROOT, extracted });
    assert.equal(Object.keys(scan).length, 24);
    for (const [lang, result] of Object.entries(scan)) {
        for (const catalog of ['native', 'pwa']) {
            for (const item of result.byCatalog[catalog].missingKeys) {
                assert.ok(!coreKeys.has(item.key), `${lang} ${catalog} is asked for "${item.key}", which core translates`);
            }
        }
    }

    // The brief for es, as the 4 Nov rounds were given it.
    const tmp = makeTempDir();
    try {
        await writeBriefs({ root: ROOT, dir: path.join(tmp, 'briefs'), langs: ['es'], extracted });
        const brief = fs.readFileSync(path.join(tmp, 'briefs', 'brief-es.md'), 'utf8');
        for (const folder of ['apps/native/words', 'apps/pwa/words']) {
            assert.ok(!catalogSection(brief, folder, 'es').includes(keyLine('Your deals')), `${folder}/es.json is not asked for "Your deals"`);
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('(b) a round for some languages asks for the welcome sentences like any others: nothing is held back for a round of every language', async () => {
    const tmp = makeTempDir();
    try {
        // The welcome screens' sentences are in no catalog yet, as on the tree the #2846 review measured.
        await welcomeTree(tmp);
        const scan = await scanAppWords({ root: tmp, langs: ['es'] });
        const native = missingByKey(scan, 'es', 'native');
        // "Shared" is core's. Every other key is asked for, the alert's words and the screens' cards alike.
        assert.deepEqual(Object.keys(native).sort(), PHONE_KEYS);
        for (const [key, item] of Object.entries(native)) assert.equal(item.group, undefined, `${key} belongs to no group`);

        // The four-language groups the machine-drafting rounds run in (es/pt/fr/ru here).
        const dir = path.join(tmp, 'briefs4');
        const out = await captureLog(() => writeBriefs({ root: tmp, dir, langs: ['es', 'pt', 'fr', 'ru'] }));
        for (const lang of ['es', 'pt', 'fr', 'ru']) {
            const brief = fs.readFileSync(path.join(dir, `brief-${lang}.md`), 'utf8');
            const section = catalogSection(brief, 'apps/native/words', lang);
            for (const key of PHONE_KEYS) assert.ok(section.includes(`${keyLine(key)}\n`), `${lang}: "${key}" is asked for, as an ordinary key`);
            assert.match(section, /\(6 missing\)/);
            assert.ok(!/all languages at once|ALL-AT-ONCE|COMPLETE THE SET|Not in this brief|in every language's|would turn it red/i.test(brief), `${lang}: the brief gives no reason to leave a sentence out`);
        }
        assert.ok(!/left out|all-at-once/i.test(out), 'the run leaves nothing out');
        assert.match(out, /wrote 4 brief\(s\)/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('(b) a welcome sentence some language already has is asked for in the others as an ordinary key; --max-keys cuts it like any key', async () => {
    const tmp = makeTempDir();
    try {
        await welcomeTree(tmp, { have: { 'apps/native/words': { pt: { 'Welcome A': 'Bem-vindo A' } } } });
        const scan = await scanAppWords({ root: tmp, langs: ['es', 'pt'] });
        assert.deepEqual(Object.keys(missingByKey(scan, 'es', 'native')).sort(), PHONE_KEYS, 'es: all asked for');
        assert.deepEqual(Object.keys(missingByKey(scan, 'pt', 'native')).sort(), PHONE_KEYS.filter((k) => k !== 'Welcome A'), 'pt: all but its own');

        // The cap counts every key the same (core's "Shared" takes the first, then five of the phone's are cut).
        const dir = path.join(tmp, 'briefs-capped');
        await captureLog(() => writeBriefs({ root: tmp, dir, langs: ['es'], maxKeys: 2 }));
        const brief = fs.readFileSync(path.join(dir, 'brief-es.md'), 'utf8');
        const section = catalogSection(brief, 'apps/native/words', 'es');
        assert.equal(PHONE_KEYS.filter((key) => section.includes(keyLine(key))).length, 1, 'one phone key is listed');
        assert.match(section, /and 5 more keys \(capped by --max-keys\)/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('(b) the report counts the welcome sentences as plain missing words, with no "all-at-once" line', async () => {
    const tmp = makeTempDir();
    try {
        await welcomeTree(tmp);
        const out = await captureLog(() => reportDraft({ root: tmp, langs: ['es', 'pt'] }));
        assert.match(out, /^ {4}native: 6 missing, 0 stale, 0 orphaned$/m);
        assert.match(out, /^ {4}core: 1 missing, 0 stale, 0 orphaned$/m);
        assert.ok(!/all-at-once/i.test(out));
        // The heartbeat's summary line keeps its shape, and the README's language-list grep still finds only languages.
        assert.match(out, /^words:draft: \d+ missing, \d+ stale across 2 languages$/m);
        assert.deepEqual(out.split('\n').filter((line) => /^[a-z]{2,3}(-[A-Za-z]+)?:/.test(line)).map((line) => line.replace(/:.*/, '')), ['es', 'pt']);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
