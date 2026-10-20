// draft.test.mjs — tests for words:draft (slice S8).
// node --test scripts/words/draft.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
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

        // Verify commit instructions present
        assert.match(firstRunText, /git commit -m "Words: <lang> <catalog> \(machine draft\)"/);
        assert.match(firstRunText, /git commit -m "Guide page: <lang> <slug> \(machine draft\)"/);

        // Verify deterministic output: second run matches byte-for-byte
        await writeBriefs({ root: tmp, dir: briefsDir, langs: ['es'], maxKeys: 2, extracted: [] });
        const secondRunText = fs.readFileSync(briefPath, 'utf8');
        assert.equal(firstRunText, secondRunText);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('assert draft script NEVER spawns child processes or uses network', async () => {
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
    assert.equal(es.appWords.byCatalog.server.missing, 14);
    assert.equal(es.appWords.byCatalog.server.missingKeys.length, 14);

    // Verify brief includes server catalog and its missing keys
    const tmp = makeTempDir();
    try {
        const briefsDir = path.join(tmp, 'briefs');
        await writeBriefs({ dir: briefsDir, langs: ['es'] });
        const briefContent = fs.readFileSync(path.join(briefsDir, 'brief-es.md'), 'utf8');
        assert.match(briefContent, /server \(14\)/);
        assert.match(briefContent, /#### Catalog: apps\/server\/words\/es\.json \(14 missing\)/);
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
