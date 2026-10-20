#!/usr/bin/env node
// check-tool-budgets.mjs — the tool template's size check (scratch/tools/DESIGN-tool-template-fable.md §2.3, slice T0.1),
// run by scripts/test-all.sh as `tool_budgets`. One sentence per problem; exit 1 on any.
//
//   1. Registration: every folder under the three tools roots is one tool, registered in all three index.ts files
//      (registry.mjs reads them as code), and every registered tool has its three folders.
//   2. Code: esbuild bundles each half's index.ts minified, everything outside the tool's own folder left out (core,
//      React, the host, data files): the phone's number is the phone half plus the core half, the web's likewise. A
//      proxy for Hermes bytecode, and a stable one: it compares tools with tools. Under a second a tool.
//   3. Data: bytes of *.json and *.table.ts in the tool's folders (tests aside).
//   4. Words: the sentences of its own, keys its folders use that no source outside a tool uses (words.mjs extracts them).
//
// Budgets are scripts/tools/budgets.json: a default, and a raised number per tool with the reason it was raised.
//
//   node scripts/tools/check-tool-budgets.mjs [--root <dir>]

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGES, extractRepo, loadCoreChecks } from '../words/words.mjs';
import { PARTS, ROOT, loadToolLimits, readRegistry, toolFolders } from './registry.mjs';

export const BUDGETS = 'scripts/tools/budgets.json';
const BUDGET_KEYS = ['phoneJsBytes', 'webJsBytes', 'dataBytes', 'sentences'];
const DATA_FILE = /\.json$|\.table\.ts$/;
const DATA_IMPORT = /\.json$|\.table(\.[jt]s)?$/;
const TEST_DIR = /(^|\/)(__tests__|__mocks__)(\/|$)/;
const part = (name) => PARTS.find((p) => p.part === name);
const n = (x) => x.toLocaleString('en');

/** Registration problems, and the ids registered with all three halves. */
export async function registrationProblems(root = ROOT) {
    const { TOOL_ID_PATTERN, TOOL_LIMITS } = await loadToolLimits();
    const problems = [];
    const folders = toolFolders(root);
    const registered = {};
    for (const p of PARTS) {
        const file = path.join(root, p.index);
        if (!fs.existsSync(file)) {
            problems.push(`${p.index} is missing: it is where every tool's ${p.half} is registered.`);
            registered[p.part] = [];
            continue;
        }
        const { entries, problems: read } = readRegistry(p, fs.readFileSync(file, 'utf8'));
        problems.push(...read);
        for (const e of entries) {
            if (e.id !== null && e.id !== e.folder) problems.push(`${p.index} registers ${e.id} from ./${e.folder}: a tool is registered under its own folder's name.`);
        }
        registered[p.part] = entries.map((e) => e.folder);
    }
    const ids = [...new Set(PARTS.flatMap((p) => [...folders[p.part], ...registered[p.part]]))].sort();
    const complete = [];
    for (const id of ids) {
        let ok = true;
        if (!TOOL_ID_PATTERN.test(id) || id.length > TOOL_LIMITS.idChars) {
            problems.push(`Tool ${id}: an id is 2 to ${TOOL_LIMITS.idChars} lowercase letters and hyphens, a letter at each end and never two hyphens together.`);
            ok = false;
        }
        for (const p of PARTS) {
            const hasFolder = folders[p.part].includes(id);
            const hasLine = registered[p.part].includes(id);
            if (hasFolder && !hasLine) problems.push(`${p.dir}/${id} is not registered: add it to ${p.registry} in ${p.index} (node scripts/tools/new-tool.mjs writes all three lines).`);
            else if (!hasFolder && hasLine) problems.push(`${p.index} registers ${id}, but ${p.dir}/${id} does not exist.`);
            else if (!hasFolder) problems.push(`Tool ${id} has no ${p.half} (${p.dir}/${id}): every tool has a core, a phone and a web half.`);
            if (!hasFolder || !hasLine) ok = false;
        }
        if (ok) complete.push(id);
    }
    return { problems, ids: complete };
}

/** Minified bytes of one half: its index.ts bundled with everything outside its own folder (and its data) left out. */
async function codeBytes(root, p, id) {
    const folder = path.join(root, p.dir, id);
    const entry = ['index.ts', 'index.tsx'].map((f) => path.join(folder, f)).find((f) => fs.existsSync(f));
    if (!entry) return { error: `Tool ${id} has no ${p.dir}/${id}/index.ts: each half starts there.` };
    // esbuild resolves from real paths: compare with the folder's own, or a root under a symlink (macOS's /var) is all "outside".
    const real = fs.realpathSync(folder);
    const outside = {
        name: 'outside-the-tool',
        setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
                if (args.kind === 'entry-point') return undefined;
                if (!args.path.startsWith('.') && !path.isAbsolute(args.path)) return { path: args.path, external: true };
                const target = path.resolve(args.resolveDir, args.path);
                if (DATA_IMPORT.test(args.path) || path.relative(real, target).startsWith('..')) return { path: args.path, external: true };
                return undefined;
            });
        },
    };
    try {
        const out = await esbuild.build({
            entryPoints: [entry], bundle: true, minify: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
            jsx: 'automatic', logLevel: 'silent', plugins: [outside],
        });
        return { bytes: out.outputFiles.reduce((s, f) => s + f.contents.length, 0) };
    } catch (e) {
        const first = e.errors?.[0];
        const where = first?.location ? `${path.relative(root, path.resolve(first.location.file))}:${first.location.line}: ` : '';
        return { error: `Tool ${id}'s ${p.half} does not bundle: ${where}${first?.text ?? e.message}.` };
    }
}

function filesUnder(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...filesUnder(full));
        else out.push(full);
    }
    return out;
}

/** Bytes of a tool's bundled data: *.json and *.table.ts in its three folders, tests aside. */
function dataBytes(root, id) {
    let bytes = 0;
    for (const p of PARTS) {
        for (const f of filesUnder(path.join(root, p.dir, id))) {
            if (DATA_FILE.test(f) && !TEST_DIR.test(path.relative(root, f))) bytes += fs.statSync(f).size;
        }
    }
    return bytes;
}

/** Each tool's sentences of its own: keys its folders use that no source outside the tools roots uses. */
async function sentencesByTool(root, ids) {
    const { callKey } = await loadCoreChecks(ROOT);
    // A file in a tool's folder is the tool's; the template's own files beside the folders (the host, its primitives) are
    // shared, like any other screen, so a tool reusing one of their sentences pays nothing for it.
    const toolOf = (file) => {
        for (const p of PARTS) {
            const rest = file.startsWith(`${p.dir}/`) ? file.slice(p.dir.length + 1).split('/') : [];
            if (rest.length > 1) return rest[0];
        }
        return null;
    };
    const elsewhere = new Set();
    const own = new Map(ids.map((id) => [id, new Set()]));
    for (const pkg of extractRepo(root, PACKAGES)) {
        for (const call of pkg.calls) {
            const key = callKey(call);
            if (!key) continue;
            const tool = toolOf(call.at.replace(/:\d+$/, ''));
            if (tool === null) elsewhere.add(key);
            else own.get(tool)?.add(key);
        }
    }
    return new Map([...own].map(([id, keys]) => [id, [...keys].filter((k) => !elsewhere.has(k)).length]));
}

/** The budget file, and its problems: a raise needs a reason, and names a tool that exists. */
function readBudgets(root, ids) {
    const file = path.join(root, BUDGETS);
    if (!fs.existsSync(file)) return { problems: [`${BUDGETS} is missing: it holds every tool's budget.`] };
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return { problems: [`${BUDGETS} is not JSON (${e.message}).`] };
    }
    const problems = [];
    for (const k of BUDGET_KEYS) if (!Number.isInteger(doc.default?.[k]) || doc.default[k] <= 0) problems.push(`${BUDGETS}: default.${k} is a whole number above 0.`);
    for (const [id, raise] of Object.entries(doc.tools ?? {})) {
        if (!ids.includes(id)) problems.push(`${BUDGETS} raises the budget of ${id}, which is not a registered tool: take its entry out.`);
        if (typeof raise?.reason !== 'string' || raise.reason.trim() === '') problems.push(`${BUDGETS} raises the budget of ${id} without a reason: say why in "reason".`);
        for (const k of Object.keys(raise ?? {})) {
            if (k !== 'reason' && (!BUDGET_KEYS.includes(k) || !Number.isInteger(raise[k]) || raise[k] <= 0)) problems.push(`${BUDGETS}: tools.${id}.${k} is not one of ${BUDGET_KEYS.join(', ')} as a whole number above 0.`);
        }
    }
    const budgetOf = (id) => ({ ...doc.default, ...Object.fromEntries(Object.entries(doc.tools?.[id] ?? {}).filter(([k]) => BUDGET_KEYS.includes(k))) });
    return { problems, budgetOf };
}

/** Everything the check says: problems (sentences) and, per registered tool, what it measured. */
export async function checkTools({ root = ROOT } = {}) {
    const { problems, ids } = await registrationProblems(root);
    const budgets = readBudgets(root, ids);
    problems.push(...budgets.problems);
    if (!budgets.budgetOf) return { problems, tools: [] };
    const words = await sentencesByTool(root, ids);
    const tools = [];
    for (const id of ids) {
        const halves = {};
        for (const name of ['core', 'native', 'pwa']) {
            const r = await codeBytes(root, part(name), id);
            if (r.error) problems.push(r.error);
            halves[name] = r.bytes ?? 0;
        }
        const t = { id, phoneJsBytes: halves.core + halves.native, webJsBytes: halves.core + halves.pwa, dataBytes: dataBytes(root, id), sentences: words.get(id) ?? 0 };
        tools.push(t);
        const budget = budgets.budgetOf(id);
        const over = (key, what, unit) => {
            if (t[key] > budget[key]) problems.push(`Tool ${id} has ${n(t[key])} ${unit} ${what}, over its ${n(budget[key])} (${BUDGETS}): make it smaller, or raise its budget there with a reason.`);
        };
        over('phoneJsBytes', 'on the phone', 'bytes of minified JS');
        over('webJsBytes', 'on the web', 'bytes of minified JS');
        over('dataBytes', 'in its folders', 'bytes of bundled data');
        over('sentences', 'that no other screen uses', 'sentences');
    }
    return { problems, tools };
}

async function main(argv) {
    const i = argv.indexOf('--root');
    const root = i >= 0 ? path.resolve(argv[i + 1] ?? '.') : ROOT;
    const { problems, tools } = await checkTools({ root });
    for (const t of tools) {
        console.log(`  ${t.id}: phone ${n(t.phoneJsBytes)} B, web ${n(t.webJsBytes)} B of minified JS; data ${n(t.dataBytes)} B; ${t.sentences} sentences of its own`);
    }
    if (problems.length) {
        console.error(`tool_budgets — ${problems.length} problem(s):`);
        for (const p of problems) console.error(`  ${p}`);
        return 1;
    }
    console.log(`tool_budgets — ok: ${tools.length} tool(s), each registered in all three packages and within its budget`);
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main(process.argv.slice(2));
}
