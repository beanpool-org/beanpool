#!/usr/bin/env node
// new-tool.mjs — a new tool from the template (docs/tools-template.md step 1): copies scripts/tools/_scaffold into the
// three tools roots as <id>/ (a compiling empty tool with its fixtures and a test) and writes its line in each of the
// three registries. Nothing else is touched; the rest of a tool is its own folders.
//
//   node scripts/tools/new-tool.mjs <id> [--root <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARTS, ROOT, loadToolLimits, registerIn, scaffoldFiles, toolFolders, toolNameClashes } from './registry.mjs';

/** Writes the tool `id` under `root`; returns the paths written. Throws one sentence when it can't, having written nothing. */
export async function newTool(id, { root = ROOT } = {}) {
    const { TOOL_ID_PATTERN, TOOL_LIMITS } = await loadToolLimits();
    if (typeof id !== 'string' || !TOOL_ID_PATTERN.test(id) || id.length > TOOL_LIMITS.idChars) {
        throw new Error(`A tool's id is 2 to ${TOOL_LIMITS.idChars} lowercase letters and hyphens, a letter at each end and never two hyphens together (as things or seed-library).`);
    }
    const folders = toolFolders(root);
    for (const p of PARTS) {
        if (folders[p.part].includes(id)) throw new Error(`${p.dir}/${id} already exists.`);
    }
    const clashes = toolNameClashes(id, root);
    if (clashes.length) {
        throw new Error(`The tool ${id} would export ${clashes.join(', ')} from core, which core already has: pick another id.`);
    }
    // Every registry first, so a file that isn't the template's stops it before anything is written.
    const indexes = PARTS.map((p) => {
        const file = path.join(root, p.index);
        if (!fs.existsSync(file)) throw new Error(`${p.index} is missing: it is where every tool's ${p.half} is registered.`);
        return { file, text: registerIn(p, fs.readFileSync(file, 'utf8'), id) };
    });
    const written = [];
    for (const f of scaffoldFiles(id)) {
        const dest = path.join(root, PARTS.find((p) => p.part === f.part).dir, f.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.text);
        written.push(path.relative(root, dest));
    }
    for (const { file, text } of indexes) {
        fs.writeFileSync(file, text);
        written.push(path.relative(root, file));
    }
    return written;
}

async function main(argv) {
    const i = argv.indexOf('--root');
    const root = i >= 0 ? path.resolve(argv[i + 1] ?? '.') : ROOT;
    const id = argv.find((a, j) => !a.startsWith('--') && argv[j - 1] !== '--root');
    if (!id) {
        console.error('usage: node scripts/tools/new-tool.mjs <id> [--root <dir>]');
        return 2;
    }
    try {
        const written = await newTool(id, { root });
        for (const w of written) console.log(`  ${w}`);
        console.log(`new-tool — ${id} written. Next: its manifest's words, permissions and document (docs/tools-template.md steps 2 to 6).`);
        return 0;
    } catch (e) {
        console.error(`new-tool — ${e.message}`);
        return 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main(process.argv.slice(2));
}
