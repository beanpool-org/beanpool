// The scaffold compiles and is clean (DESIGN-tool-template-fable.md §4 step 1): what `new-tool.mjs <id>` would write — the
// three halves and the three registry lines — type-checked with each package's own compiler options and linted through
// the repository's eslint config (the tool fence included), all in memory at the paths it would have. Nothing is written,
// so a build running beside this never sees a half-made tool. The generic tests on its core half are core's own
// (packages/beanpool-core/src/__tests__/tools-template.test.ts).
//
//   node --test scripts/tools/scaffold.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ESLint } from 'eslint';
import { PARTS, ROOT, registerIn, scaffoldFiles } from './registry.mjs';

const ID = 'new-tool-check';
const CORE_SRC = path.join(ROOT, 'packages/beanpool-core/src/index.ts');

/** Every file new-tool.mjs would write for ID, by absolute path: its halves and the three registries with its line. */
const overlay = new Map();
for (const f of scaffoldFiles(ID)) overlay.set(path.join(ROOT, PARTS.find((p) => p.part === f.part).dir, f.rel), f.text);
for (const p of PARTS) overlay.set(path.join(ROOT, p.index), registerIn(p, fs.readFileSync(path.join(ROOT, p.index), 'utf8'), ID));
const inPart = (part) => [...overlay.keys()].filter((f) => f.startsWith(path.join(ROOT, PARTS.find((p) => p.part === part).dir) + path.sep));

/** A compiler host that sees the overlay over the disk. */
function overlayHost(options) {
    const host = ts.createCompilerHost(options, true);
    const { fileExists, readFile, getSourceFile, directoryExists, realpath } = host;
    const isDirOfOverlay = (d) => [...overlay.keys()].some((f) => f.startsWith(path.resolve(d) + path.sep));
    host.fileExists = (f) => overlay.has(path.resolve(f)) || fileExists.call(host, f);
    host.readFile = (f) => overlay.get(path.resolve(f)) ?? readFile.call(host, f);
    host.directoryExists = (d) => isDirOfOverlay(d) || (directoryExists ? directoryExists.call(host, d) : ts.sys.directoryExists(d));
    host.realpath = (p) => (overlay.has(path.resolve(p)) || isDirOfOverlay(p) ? p : realpath ? realpath.call(host, p) : p);
    host.getSourceFile = (f, lang, onError, create) => {
        const text = overlay.get(path.resolve(f));
        return text !== undefined ? ts.createSourceFile(f, text, lang, true) : getSourceFile.call(host, f, lang, onError, create);
    };
    return host;
}

/** The type errors in the overlay's files of one part, checked with that package's tsconfig and core from its source. */
function typeErrors(part, tsconfig) {
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, tsconfig), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => assert.fail(ts.flattenDiagnosticMessageText(d.messageText, '\n')) });
    const options = { ...parsed.options, noEmit: true, declaration: false, rootDir: undefined, outDir: undefined, paths: { ...parsed.options.paths, '@beanpool/core': [CORE_SRC] } };
    const roots = inPart(part);
    const program = ts.createProgram({ rootNames: roots, options, host: overlayHost(options) });
    const mine = new Set([...overlay.keys()]);
    const diagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
    for (const sf of program.getSourceFiles()) {
        if (mine.has(path.resolve(sf.fileName))) diagnostics.push(...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf));
    }
    assert.ok(roots.length >= 3, `${part}: the scaffold has its files (${roots.length})`);
    return diagnostics.map((d) => {
        const where = d.file ? `${path.relative(ROOT, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ` : '';
        return `${where}${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
}

test('the scaffold names its own id everywhere (scaffold, Scaffold and SCAFFOLD all replaced)', () => {
    for (const [file, text] of overlay) {
        if (!file.includes(`${path.sep}${ID}${path.sep}`)) continue;
        assert.doesNotMatch(text.replace('scripts/tools/_scaffold', ''), /scaffold/i, path.relative(ROOT, file));
    }
});

test("its core half and core's registry with it compile with core's options", () => {
    assert.deepEqual(typeErrors('core', 'packages/beanpool-core/tsconfig.json'), []);
});

test("its phone half and the phone's registry compile with the phone's options", () => {
    assert.deepEqual(typeErrors('native', 'apps/native/tsconfig.json'), []);
});

test("its web half and the web's registry compile with the web's options", () => {
    assert.deepEqual(typeErrors('pwa', 'apps/pwa/tsconfig.json'), []);
});

test('every file of it, and each registry with its line, lints clean inside the tool fence', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const found = [];
    for (const [file, text] of overlay) {
        const [r] = await eslint.lintText(text, { filePath: file });
        for (const m of r.messages) found.push(`${path.relative(ROOT, file)}:${m.line}: ${m.ruleId}: ${m.message}`);
    }
    assert.deepEqual(found, []);
});

test('a type error in a half is seen (the check is not blind)', () => {
    const screens = inPart('native').find((f) => f.endsWith('screens.tsx'));
    const was = overlay.get(screens);
    overlay.set(screens, `${was}\nexport const wrong: number = 'words';\n`);
    try {
        assert.equal(typeErrors('native', 'apps/native/tsconfig.json').length, 1);
    } finally {
        overlay.set(screens, was);
    }
});
