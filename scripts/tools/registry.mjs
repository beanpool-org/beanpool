// registry.mjs — the tool template's three registries, read and written as code (scratch/tools/DESIGN-tool-template-fable.md
// §2.3 step 1, docs/tools-template.md). Shared by check-tool-budgets.mjs (which refuses a folder registered in fewer than
// all three) and new-tool.mjs (which writes the three lines). Each index.ts is parsed with TypeScript, never grepped, so
// a name in a comment never counts as a registration.

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCAFFOLD_DIR = 'scripts/tools/_scaffold';

/** A tool's three halves: where its folder lives, and the registry that names it. */
export const PARTS = [
    { part: 'core', dir: 'packages/beanpool-core/src/tools', index: 'packages/beanpool-core/src/tools/index.ts', registry: 'TOOLS', half: 'core half' },
    { part: 'native', dir: 'apps/native/tools', index: 'apps/native/tools/index.ts', registry: 'TOOL_APPS', half: 'phone half' },
    { part: 'pwa', dir: 'apps/pwa/src/tools', index: 'apps/pwa/src/tools/index.ts', registry: 'TOOL_APPS', half: 'web half' },
];

/** Folders under a tools root that are not tools. */
const NOT_TOOLS = new Set(['__tests__', '__mocks__']);

let limits = null;
/** TOOL_ID_PATTERN and TOOL_LIMITS from core's tools/manifest.ts SOURCE (compiled in memory: no dist needed). */
export async function loadToolLimits() {
    limits ??= (async () => {
        const src = fs.readFileSync(path.join(ROOT, 'packages/beanpool-core/src/tools/manifest.ts'), 'utf8');
        const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
        return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
    })();
    return limits;
}

/** An id's names in code: `seed-library` → seedLibrary, SeedLibrary, SEED_LIBRARY. */
export function toolNames(id) {
    const words = id.split('-');
    const pascal = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    return { id, camel: pascal[0].toLowerCase() + pascal.slice(1), pascal, constant: words.map((w) => w.toUpperCase()).join('_') };
}

/** The tool folders under each root, by part. */
export function toolFolders(root = ROOT) {
    const out = {};
    for (const { part, dir } of PARTS) {
        const full = path.join(root, dir);
        out[part] = fs.existsSync(full)
            ? fs.readdirSync(full, { withFileTypes: true }).filter((d) => d.isDirectory() && !NOT_TOOLS.has(d.name)).map((d) => d.name).sort()
            : [];
    }
    return out;
}

const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** The initializer of `export const <name> … = <init>`, through any `as`/`satisfies`. */
function registryInit(sf, name) {
    for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
            if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
            let init = d.initializer;
            while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
            return init;
        }
    }
    return null;
}

/** Local name → the module it was imported from, and whether as the default. */
function importsOf(sf) {
    const out = new Map();
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause || st.importClause.isTypeOnly) continue;
        const from = st.moduleSpecifier.text;
        if (st.importClause.name) out.set(st.importClause.name.text, { from, isDefault: true });
        const named = st.importClause.namedBindings;
        if (named && ts.isNamedImports(named)) for (const el of named.elements) if (!el.isTypeOnly) out.set(el.name.text, { from, isDefault: false });
    }
    return out;
}

const propKey = (p) => (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null);

/**
 * What one index.ts registers: [{ id, folder }] (`folder` the one its line loads; it must be `id`), and the problems
 * that stop it being read. `id` is null where only the folder is known (core's TOOLS names an import, not an id).
 */
export function readRegistry(p, text) {
    const sf = parse(p.index, text);
    const init = registryInit(sf, p.registry);
    const problems = [];
    const entries = [];
    if (!init) return { entries, problems: [`${p.index} has no \`export const ${p.registry} = …\`: the template's registry is missing.`] };
    const imports = importsOf(sf);
    const at = (node) => `${p.index}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    if (p.part === 'core') {
        if (!ts.isArrayLiteralExpression(init)) return { entries, problems: [`${p.index}: ${p.registry} is a list of manifests.`] };
        for (const el of init.elements) {
            const imp = ts.isIdentifier(el) ? imports.get(el.text) : null;
            const m = imp && !imp.isDefault ? /^\.\/([^/]+)\/index\.js$/.exec(imp.from) : null;
            if (m) entries.push({ id: null, folder: m[1] });
            else problems.push(`${at(el)}: each entry of ${p.registry} is a manifest imported from './<id>/index.js'.`);
        }
        return { entries, problems };
    }
    if (!ts.isObjectLiteralExpression(init)) return { entries, problems: [`${p.index}: ${p.registry} is an object of tools by id.`] };
    for (const prop of init.properties) {
        const id = ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop) ? propKey(prop) : null;
        let folder = null;
        if (p.part === 'native') {
            const value = ts.isShorthandPropertyAssignment(prop) ? prop.name : ts.isPropertyAssignment(prop) ? prop.initializer : null;
            const imp = value && ts.isIdentifier(value) ? imports.get(value.text) : null;
            const m = imp?.isDefault ? /^\.\/([^/]+?)(?:\/index)?$/.exec(imp.from) : null;
            folder = m?.[1] ?? null;
        } else if (ts.isPropertyAssignment(prop) && ts.isArrowFunction(prop.initializer)) {
            const body = prop.initializer.body;
            const isImport = ts.isCallExpression(body) && body.expression.kind === ts.SyntaxKind.ImportKeyword && body.arguments.length === 1 && ts.isStringLiteral(body.arguments[0]);
            const m = isImport ? /^\.\/([^/]+?)(?:\/index)?$/.exec(body.arguments[0].text) : null;
            folder = m?.[1] ?? null;
        }
        if (id === null || folder === null) {
            problems.push(p.part === 'native'
                ? `${at(prop)}: each entry of ${p.registry} is \`<id>: <the default import of './<id>'>\`.`
                : `${at(prop)}: each entry of ${p.registry} is \`<id>: () => import('./<id>')\`.`);
            continue;
        }
        entries.push({ id, folder });
    }
    return { entries, problems };
}

/** Insert `line` as the last element of the array or object literal `node` in `text`, keeping what is there. */
function appendElement(text, sf, node, items, line) {
    const close = node.getEnd() - 1; // the `]` or `}`
    let out = text;
    let insertAt = close;
    const last = items[items.length - 1];
    if (last && !items.hasTrailingComma) {
        out = `${out.slice(0, last.getEnd())},${out.slice(last.getEnd())}`;
        insertAt += 1;
    }
    const lineStart = out.lastIndexOf('\n', insertAt - 1) + 1;
    if (out.slice(lineStart, insertAt).trim() === '') return `${out.slice(0, lineStart)}    ${line},\n${out.slice(lineStart)}`;
    return `${out.slice(0, insertAt)} ${line} ${out.slice(insertAt)}`;
}

/** After the last top-level statement matching `is` (or before the first statement), a new line. */
function insertAfterLast(text, sf, is, line) {
    const matches = sf.statements.filter(is);
    const after = matches.length ? matches[matches.length - 1].getEnd() : sf.statements[0]?.getFullStart() ?? 0;
    return `${text.slice(0, after)}\n${line}${text.slice(after)}`;
}

/** One part's index.ts with the tool `id` registered: its import(s) and its entry. Throws a sentence if the file isn't the template's. */
export function registerIn(p, text, id) {
    const n = toolNames(id);
    const { entries, problems } = readRegistry(p, text);
    if (problems.length) throw new Error(problems[0]);
    if (entries.some((e) => e.folder === id || e.id === id)) throw new Error(`${p.index} already registers ${id}.`);
    const key = /^[a-z]+$/.test(id) ? id : `'${id}'`;
    if (p.part === 'core') {
        let out = insertAfterLast(text, parse(p.index, text), ts.isImportDeclaration, `import { ${n.constant} } from './${id}/index.js';`);
        out = insertAfterLast(out, parse(p.index, out), (s) => ts.isExportDeclaration(s) && !!s.moduleSpecifier, `export * from './${id}/index.js';`);
        const sf = parse(p.index, out);
        const init = registryInit(sf, p.registry);
        return appendElement(out, sf, init, init.elements, n.constant);
    }
    const local = p.part === 'native' ? n.camel : null;
    let out = local ? insertAfterLast(text, parse(p.index, text), ts.isImportDeclaration, `import ${local} from './${id}';`) : text;
    const sf = parse(p.index, out);
    const init = registryInit(sf, p.registry);
    const entry = p.part === 'native' ? (key === local ? local : `${key}: ${local}`) : `${key}: () => import('./${id}')`;
    return appendElement(out, sf, init, init.properties, entry);
}

/** The scaffold's files for a tool `id`: [{ part, rel, text }], `rel` under that part's tools root. */
export function scaffoldFiles(id, root = ROOT) {
    const n = toolNames(id);
    const out = [];
    for (const { part } of PARTS) {
        const base = path.join(root, SCAFFOLD_DIR, part);
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir).sort()) {
                const full = path.join(dir, name);
                if (fs.statSync(full).isDirectory()) { walk(full); continue; }
                const rel = path.join(id, path.relative(base, full)).replace(/(^|\/)scaffold(\.test\.ts)$/, `$1${id}$2`);
                const text = fs.readFileSync(full, 'utf8')
                    .replace(/SCAFFOLD/g, n.constant).replace(/Scaffold/g, n.pascal).replace(/'scaffold'/g, `'${id}'`);
                out.push({ part, rel, text });
            }
        };
        walk(base);
    }
    return out;
}
