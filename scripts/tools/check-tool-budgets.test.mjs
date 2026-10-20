// The tool template's checks (DESIGN-tool-template-fable.md §2.3, §6 T0.1) against throwaway trees: the three registries
// copied from this repository and tools written into them by new-tool.mjs, so nothing here touches the repository.
//
//   node --test scripts/tools/check-tool-budgets.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUDGETS, checkTools } from './check-tool-budgets.mjs';
import { newTool } from './new-tool.mjs';
import { PARTS, ROOT, readRegistry, registerIn, toolNames } from './registry.mjs';

/** A tree with this repository's three (empty) registries and budgets, and nothing else. */
function tree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-tools-'));
    for (const rel of [...PARTS.map((p) => p.index), BUDGETS]) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel));
    }
    return root;
}
const write = (root, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
};
/** Exactly one problem, one sentence, matching `words`. */
function one(problems, words) {
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /^[^\n]+\.$/);
    assert.match(problems[0], words);
}

test("this repository's registries are the template's, every tool registered and within budget", async () => {
    const { problems } = await checkTools();
    assert.deepEqual(problems, []);
});

test('an empty tree passes with no tools; a new tool from the scaffold passes registered and within budget', async () => {
    const root = tree();
    assert.deepEqual((await checkTools({ root })).problems, []);
    const written = await newTool('seed-library', { root });
    assert.ok(written.includes('apps/native/tools/seed-library/screens.tsx'));
    const { problems, tools } = await checkTools({ root });
    assert.deepEqual(problems, []);
    assert.equal(tools.length, 1);
    const [t] = tools;
    assert.equal(t.id, 'seed-library');
    assert.ok(t.phoneJsBytes > 500 && t.phoneJsBytes < 10_000, `phone ${t.phoneJsBytes}`);
    assert.ok(t.webJsBytes > 500 && t.webJsBytes < 10_000, `web ${t.webJsBytes}`);
    assert.equal(t.dataBytes, 0);
    assert.equal(t.sentences, 8);
});

test('new-tool writes one line in each registry, keeps what is there, and refuses what is not a new tool', async () => {
    const root = tree();
    await newTool('things', { root });
    await newTool('seed-library', { root });
    for (const p of PARTS) {
        const { entries, problems } = readRegistry(p, fs.readFileSync(path.join(root, p.index), 'utf8'));
        assert.deepEqual(problems, []);
        assert.deepEqual(entries.map((e) => e.folder), ['things', 'seed-library'], p.index);
    }
    const core = fs.readFileSync(path.join(root, PARTS[0].index), 'utf8');
    assert.match(core, /export \* from '\.\/seed-library\/index\.js';/);
    assert.match(core, /\[\n {4}THINGS,\n {4}SEED_LIBRARY,\n\]/);
    assert.match(fs.readFileSync(path.join(root, PARTS[1].index), 'utf8'), /\{\n {4}things,\n {4}'seed-library': seedLibrary,\n\}/);
    assert.match(fs.readFileSync(path.join(root, PARTS[2].index), 'utf8'), /'seed-library': \(\) => import\('\.\/seed-library'\),/);
    const generated = fs.readFileSync(path.join(root, 'packages/beanpool-core/src/tools/seed-library/manifest.ts'), 'utf8');
    assert.match(generated, /export const SEED_LIBRARY: ToolManifest<SeedLibraryDoc> = \{\n {4}id: 'seed-library',/);
    assert.doesNotMatch(generated.replace('scripts/tools/_scaffold', ''), /scaffold/i);
    for (const bad of ['Things', 'a', 'x-', 'seed_library', 'a-very-long-tool-id', '-x']) {
        await assert.rejects(newTool(bad, { root }), /lowercase letters and hyphens/, bad);
    }
    await assert.rejects(newTool('things', { root }), /already exists/);
    assert.deepEqual(toolNames('seed-library'), { id: 'seed-library', camel: 'seedLibrary', pascal: 'SeedLibrary', constant: 'SEED_LIBRARY' });
    // An entry already on the same line as the brackets keeps its place.
    assert.match(registerIn(PARTS[0], "import { A } from './a/index.js';\nexport const TOOLS = [A];\n", 'b'), /\[A, B \]/);
});

test('an unregistered folder is refused, and so is a line with no folder or a tool missing a half', async () => {
    const root = tree();
    await newTool('things', { root });
    write(root, 'apps/native/tools/stray/index.ts', 'export default {};\n');
    const { problems } = await checkTools({ root });
    assert.ok(problems.includes('apps/native/tools/stray is not registered: add it to TOOL_APPS in apps/native/tools/index.ts (node scripts/tools/new-tool.mjs writes all three lines).'), problems.join('\n'));
    assert.ok(problems.includes('Tool stray has no core half (packages/beanpool-core/src/tools/stray): every tool has a core, a phone and a web half.'));
    assert.ok(problems.includes('Tool stray has no web half (apps/pwa/src/tools/stray): every tool has a core, a phone and a web half.'));
    assert.equal(problems.length, 3);

    const lineOnly = tree();
    await newTool('things', { root: lineOnly });
    fs.rmSync(path.join(lineOnly, 'apps/pwa/src/tools/things'), { recursive: true });
    one((await checkTools({ root: lineOnly })).problems, /^apps\/pwa\/src\/tools\/index\.ts registers things, but apps\/pwa\/src\/tools\/things does not exist\.$/);

    const misfiled = tree();
    await newTool('things', { root: misfiled });
    const pwa = path.join(misfiled, PARTS[2].index);
    fs.writeFileSync(pwa, fs.readFileSync(pwa, 'utf8').replace("things: () => import('./things')", "things: () => import('./other')"));
    const p = (await checkTools({ root: misfiled })).problems;
    assert.ok(p.includes("apps/pwa/src/tools/index.ts registers things from ./other: a tool is registered under its own folder's name."), p.join('\n'));
});

test('a name in a comment is not a registration', async () => {
    const root = tree();
    await newTool('things', { root });
    const native = path.join(root, PARTS[1].index);
    fs.writeFileSync(native, fs.readFileSync(native, 'utf8').replace('    things,\n', '    // things,\n'));
    one((await checkTools({ root })).problems, /^apps\/native\/tools\/things is not registered/);
});

test('a tool over each budget is refused in one sentence that names the tool, the number and the budget', async () => {
    const big = (bytes) => `export const BIG = ${JSON.stringify(Array.from({ length: bytes }, (_, i) => String.fromCharCode(97 + ((i * 7919) % 26))).join(''))};\n`;
    const cases = [
        ['phone', (root) => fs.appendFileSync(path.join(root, 'apps/native/tools/things/index.ts'), big(130_000)), /^Tool things has 1\d\d,\d{3} bytes of minified JS on the phone, over its 122,880 \(scripts\/tools\/budgets\.json\): make it smaller, or raise its budget there with a reason\.$/],
        ['web', (root) => fs.appendFileSync(path.join(root, 'apps/pwa/src/tools/things/index.ts'), big(130_000)), /^Tool things has 1\d\d,\d{3} bytes of minified JS on the web, over its 122,880/],
        ['data', (root) => write(root, 'packages/beanpool-core/src/tools/things/crops.json', JSON.stringify({ rows: 'x'.repeat(110_000) })), /^Tool things has 110,\d{3} bytes of bundled data in its folders, over its 102,400/],
        ['words', (root) => write(root, 'packages/beanpool-core/src/tools/things/more.ts',
            `import { word } from '../../words.js';\nexport const MORE = [\n${Array.from({ length: 150 }, (_, i) => `    word('Line ${i + 1} of the test, for the count.'),`).join('\n')}\n];\n`),
        /^Tool things has 158 sentences that no other screen uses, over its 150/],
    ];
    for (const [name, grow, words] of cases) {
        const root = tree();
        await newTool('things', { root });
        assert.deepEqual((await checkTools({ root })).problems, [], name);
        grow(root);
        one((await checkTools({ root })).problems, words);
    }
});

test('data is counted once: a table imported by the code is data, not code; tests are neither', async () => {
    const root = tree();
    await newTool('things', { root });
    const table = `export const ROWS = ${JSON.stringify('y'.repeat(50_000))};\n`;
    write(root, 'packages/beanpool-core/src/tools/things/crops.table.ts', table);
    fs.appendFileSync(path.join(root, 'packages/beanpool-core/src/tools/things/index.ts'), "export { ROWS } from './crops.table.js';\n");
    write(root, 'packages/beanpool-core/src/tools/things/__tests__/big.json', JSON.stringify('z'.repeat(200_000)));
    const { problems, tools } = await checkTools({ root });
    assert.deepEqual(problems, []);
    assert.equal(tools[0].dataBytes, Buffer.byteLength(table));
    assert.ok(tools[0].phoneJsBytes < 10_000, `the table is not in the code: ${tools[0].phoneJsBytes}`);
});

test("a sentence the rest of the app already says costs a tool nothing; the template's own files beside the folders are shared", async () => {
    const root = tree();
    await newTool('things', { root });
    write(root, 'apps/native/app/settings.tsx', "import { t } from '@beanpool/core';\nexport const a = () => t('New tool');\n");
    write(root, 'apps/native/tools/ui.tsx', "import { t } from '@beanpool/core';\nexport const b = () => t('Kept here: {count}', { count: 1 });\n");
    assert.equal((await checkTools({ root })).tools[0].sentences, 6);
});

test('a raised budget needs a reason and a tool to raise', async () => {
    const root = tree();
    await newTool('things', { root });
    write(root, 'packages/beanpool-core/src/tools/things/crops.json', JSON.stringify({ rows: 'x'.repeat(110_000) }));
    const budgets = JSON.parse(fs.readFileSync(path.join(root, BUDGETS), 'utf8'));
    const save = (tools) => fs.writeFileSync(path.join(root, BUDGETS), JSON.stringify({ ...budgets, tools }));
    save({ things: { dataBytes: 120_000, reason: 'The crop table, read by a gardener (T2.2).' } });
    assert.deepEqual((await checkTools({ root })).problems, []);
    save({ things: { dataBytes: 120_000 } });
    one((await checkTools({ root })).problems, /^scripts\/tools\/budgets\.json raises the budget of things without a reason: say why in "reason"\.$/);
    save({ things: { dataBytes: 120_000, reason: 'x' }, gone: { sentences: 200, reason: 'x' } });
    one((await checkTools({ root })).problems, /raises the budget of gone, which is not a registered tool/);
    save({ things: { pages: 3, reason: 'x' } });
    const p = (await checkTools({ root })).problems;
    assert.ok(p.some((s) => /tools\.things\.pages is not one of/.test(s)), p.join('\n'));
});
