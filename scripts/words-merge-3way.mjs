#!/usr/bin/env node
/**
 * Three-way merge of word catalogs (apps/<app>/words/*.json, packages/<pkg>/words/*.json), per key, mid-merge.
 *
 *   node scripts/words-merge-3way.mjs --base <rev> --main <rev> --pr <rev> [--resolve <file>...] [--verify <file>...]
 *
 * WHY. Every PR that adds words appends keys to the same catalogs and appends a note to _meta.draftedBy, so every merge to
 * main leaves the other waiting PRs conflicting on lines that do not really clash (31 Oct: every merge broke the others).
 * scripts/test-all-train.sh resolves such a conflict with this, and drops a PR whose conflict is anything else.
 *
 * ROLES, not HEAD and MERGE_HEAD: "main" is the side the PR lands on (main, or main plus the train's earlier PRs), "pr" is
 * the PR. The train merges a PR into main to test it and later merges main into the PR's branch to land it; naming the
 * sides makes both give the same file.
 *
 * PER KEY. Only one side changed it: that side. Both made the same change: that. Both changed it differently: refused (a
 * hand merge). A key one side removed and the other left alone: removed; removed by one and changed by the other: refused.
 * _meta per field the same way, except draftedBy (main's, then the PR's appended note) and updated (the later date).
 * Order: main's keys in main's order, each key the PR added after its nearest earlier key that is there.
 *
 * VERIFY. Every file in --resolve and --verify is then read back from the working tree and checked: it parses; every key
 * either side added is in it; every key either side removed is not; every other value is main's or the PR's. Any problem
 * exits 1 and names it. --verify alone checks files git merged by itself.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CATALOG = /^(apps|packages)\/[^/]+\/words\/[^/]+\.json$/;

const J = (v) => JSON.stringify(v);
const short = (k) => (k.length > 60 ? `${k.slice(0, 60)}…` : k);

function show(rev, file) {
    try {
        return execFileSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8', maxBuffer: 1e8, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return null;
    }
}

/** One side's catalog: null when the file is not in that revision. */
export function readAt(rev, file) {
    const text = show(rev, file);
    return text === null ? null : JSON.parse(text);
}

function mergeMeta(file, b = {}, m = {}, p = {}) {
    const out = {};
    const fields = [...Object.keys(m), ...Object.keys(p).filter((f) => !(f in m))];
    for (const f of fields) {
        const inB = f in b, inM = f in m, inP = f in p;
        if (inM && inP && J(m[f]) === J(p[f])) { out[f] = m[f]; continue; }
        if (f === 'draftedBy' && inM && inP) {
            const base = inB ? String(b[f]) : '';
            if (String(p[f]).startsWith(base)) {
                const note = String(p[f]).slice(base.length);
                out[f] = String(m[f]).endsWith(note) ? m[f] : m[f] + note;
                continue;
            }
            throw new Error(`${file}: _meta.draftedBy changed on the PR beyond an appended note`);
        }
        if (f === 'updated' && inM && inP) { out[f] = String(p[f]) > String(m[f]) ? p[f] : m[f]; continue; }
        const mChanged = J(m[f]) !== J(b[f]), pChanged = J(p[f]) !== J(b[f]);
        if (mChanged && pChanged) throw new Error(`${file}: both sides changed _meta.${f}`);
        const v = pChanged ? p : m;
        if (f in v) out[f] = v[f];
    }
    return out;
}

/** The merged catalog, or a thrown Error naming why it cannot be merged without a person. */
export function mergeCatalog(file, b, m, p) {
    if (m === null || p === null) {
        if (b !== null) throw new Error(`${file}: one side deleted the catalog`);
        if (m === null) return p;
        if (p === null) return m;
    }
    b = b || {};
    const keys = Object.keys(m);
    const prKeys = Object.keys(p);
    // A key main removed is kept in the list too, so the loop below can refuse it when the PR changed it.
    for (let i = 0; i < prKeys.length; i++) {
        const k = prKeys[i];
        if (k in m) continue;
        let j = i - 1;
        while (j >= 0 && !keys.includes(prKeys[j])) j--;
        keys.splice(j >= 0 ? keys.indexOf(prKeys[j]) + 1 : keys.length, 0, k);
    }
    const out = {};
    for (const k of keys) {
        if (k === '_meta') { out[k] = mergeMeta(file, b[k], m[k], p[k]); continue; }
        const inB = k in b, inM = k in m, inP = k in p;
        if (inM && inP) {
            if (J(m[k]) === J(p[k]) || J(p[k]) === J(b[k])) out[k] = m[k];
            else if (J(m[k]) === J(b[k])) out[k] = p[k];
            else throw new Error(`${file}: both sides changed "${short(k)}"`);
        } else if (inM) {
            if (!inB) out[k] = m[k];
            else if (J(m[k]) !== J(b[k])) throw new Error(`${file}: the PR removed "${short(k)}", which main changed`);
        } else if (inP) {
            if (!inB) out[k] = p[k];
            else if (J(p[k]) !== J(b[k])) throw new Error(`${file}: main removed "${short(k)}", which the PR changed`);
        }
    }
    return out;
}

/** Problems with the merged file as it stands in the working tree; [] when it is right. */
export function verifyCatalog(file, b, m, p, text) {
    let out;
    try { out = JSON.parse(text); } catch (e) { return [`${file}: not JSON after the merge (${e.message})`]; }
    b = b || {}; m = m || {}; p = p || {};
    const problems = [];
    for (const [side, s] of [['main', m], ['the PR', p]]) {
        for (const k of Object.keys(s)) if (!(k in b) && !(k in out)) problems.push(`${file}: lost "${short(k)}", added by ${side}`);
        for (const k of Object.keys(b)) if (!(k in s) && k in out) problems.push(`${file}: kept "${short(k)}", removed by ${side}`);
    }
    for (const k of Object.keys(out)) {
        if (k === '_meta') continue;
        if (J(out[k]) !== J(m[k]) && J(out[k]) !== J(p[k])) problems.push(`${file}: "${short(k)}" is neither main's nor the PR's`);
    }
    return problems;
}

function main(argv) {
    const opt = { resolve: [], verify: [] };
    let list = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--base' || a === '--main' || a === '--pr') { opt[a.slice(2)] = argv[++i]; list = null; }
        else if (a === '--resolve' || a === '--verify') list = opt[a.slice(2)];
        else if (list) list.push(a);
        else { console.error(`words-merge-3way: unexpected argument ${a}`); return 2; }
    }
    if (!opt.base || !opt.main || !opt.pr) { console.error('usage: words-merge-3way.mjs --base <rev> --main <rev> --pr <rev> [--resolve <file>...] [--verify <file>...]'); return 2; }
    const files = [...new Set([...opt.resolve, ...opt.verify])];
    const bad = files.filter((f) => !CATALOG.test(f));
    if (bad.length) { console.error(`words-merge-3way: not a word catalog: ${bad.join(' ')}`); return 1; }
    const sides = new Map(files.map((f) => [f, [readAt(opt.base, f), readAt(opt.main, f), readAt(opt.pr, f)]]));
    let added = 0;
    for (const f of opt.resolve) {
        const [b, m, p] = sides.get(f);
        let merged;
        try { merged = mergeCatalog(f, b, m, p); } catch (e) { console.error(`words-merge-3way: ${e.message}`); return 1; }
        added += Object.keys(merged).filter((k) => !(k in (m || {}))).length;
        writeFileSync(f, JSON.stringify(merged, null, 2) + '\n');
    }
    const problems = files.flatMap((f) => verifyCatalog(f, ...sides.get(f), readFileSync(f, 'utf8')));
    if (problems.length) {
        console.error(`words-merge-3way: ${problems.length} problem(s) after the merge:`);
        for (const pr of problems.slice(0, 20)) console.error(`   ${pr}`);
        return 1;
    }
    console.log(`words-merge-3way: ${opt.resolve.length} catalog(s) merged per key (${added} key(s) from the PR), ${files.length} verified, 0 problems`);
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
