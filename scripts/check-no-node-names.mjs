#!/usr/bin/env node
/**
 * Fails when one of BeanPool's own communities is named in the product's code (Marty, 14 Nov 2026: "I don't want special
 * code for a specific situation ... I want the code clean for people using it out in the world ... no stuff in our
 * codebase about mullum and byron ... not just these two").
 *
 * WHAT IT COUNTS. In every tracked file under apps/, packages/ and workers/: our communities' names (mullum, byron,
 * castlemaine, bindarrabi, eastgippy, gippsland, apollobay, melb, bris and the towns' long names), and the addresses of
 * our test, review and global servers. Comments and tests count too: an example in a comment is copied into code, and a
 * test's community is the next example. `bris` and `melb` count as words only (brisk, debris and Melba are not ours), and
 * a time zone (`Australia/Brisbane`) is the operating system's name for a clock, not our community.
 *
 * WHAT IS ALLOWED. The global community's address in packages/beanpool-core/src/beanpool-defaults.ts, the one named
 * default (DEFAULT_GLOBAL_COMMUNITY_URL) every app reads. Recorded schema fixtures (__fixtures__/schema-*.sql) and the
 * registrar's migrations, which ran on the live registrar as written and are never edited (check-migrations-unchanged.sh).
 * The pages outside the code, reported, not checked: the website (apps/website, apps/website-src), the members' guide
 * and the operator manual (packages/beanpool-guide content, operators and generated), lock files, and the configs that
 * deploy our own servers (apps/registrar/wrangler.toml, apps/busy-worker).
 *
 * THE BASELINE (scripts/no-node-names-baseline.json) is what is left today, per file, while later slices clear the tests
 * and comments. A file over its count, or a file not listed, fails: name a made-up place (riverside, Riverside Exchange,
 * riverside.example.org) instead. A file under its count also fails, so the room is not reused: lower it with
 * `node scripts/check-no-node-names.mjs --update`, which only ever lowers counts and drops files that reach 0.
 *
 * Usage: node scripts/check-no-node-names.mjs [--list | --update]    (--list prints every counted site)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_FILE = 'scripts/no-node-names-baseline.json';
export const ROOTS = ['apps', 'packages', 'workers'];

/** The one file that may name the global community's address. */
export const DEFAULTS_FILE = 'packages/beanpool-core/src/beanpool-defaults.ts';

/** Paths never read: recorded fixtures and migrations, and the pages and deploy configs that are out of this check. */
export const SKIP = [
    /(^|\/)__fixtures__\/schema-[^/]*\.sql$/,
    /^apps\/registrar\/migrations\//,
    /^apps\/website\//,
    /^apps\/website-src\//,
    /^packages\/beanpool-guide\/(content|operators|generated)\//,
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml)$/,
    /^apps\/registrar\/wrangler\.toml$/,
    /^apps\/busy-worker\//,
];

const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|html|css|md|sql|sh|toml|ya?ml|txt|csv|xml|plist|gradle|properties|kt|java|swift|m|h|env|example)$/i;

/** Our communities' names, and our servers' addresses. Case-insensitive. */
export const NAMES = [
    /mullum/gi,
    /byron/gi,
    /castlemaine/gi,
    /bindarrabi/gi,
    /eastgippy/gi,
    /gippsland/gi,
    /apollo[ -]?bay/gi,
    /(?<![a-z])melb(?![a-z])/gi,
    /(?<![a-z])bris(?![a-z])/gi,
    /(?<!australia\/)melbourne/gi,
    /(?<!australia\/)brisbane/gi,
    /(?<![a-z0-9-])(test|review)\.beanpool\.org/gi,
];
/** The global community's address: allowed in DEFAULTS_FILE only. */
export const GLOBAL_HOST = /(?<![a-z0-9-])global\.beanpool\.org/gi;

/** Every counted site in one file's text: `[line, the matched text]`. */
export function sitesIn(rel, text) {
    const out = [];
    const res = rel === DEFAULTS_FILE ? NAMES : [...NAMES, GLOBAL_HOST];
    for (const re of res) {
        for (const m of text.matchAll(re)) out.push([text.slice(0, m.index).split('\n').length, m[0]]);
    }
    return out.sort((a, b) => a[0] - b[0]);
}

/** Counts per file, for the files given (paths relative to `root`). */
export function scan(root, files) {
    const counts = {};
    const sites = [];
    for (const rel of files) {
        if (!TEXT.test(rel) || SKIP.some((re) => re.test(rel))) continue;
        const p = join(root, rel);
        if (!existsSync(p)) continue;
        const found = sitesIn(rel, readFileSync(p, 'utf8'));
        if (!found.length) continue;
        counts[rel] = found.length;
        for (const [line, what] of found) sites.push(`${rel}:${line}: ${what}`);
    }
    return { counts, sites };
}

/** What fails against the baseline: `over` (new names) and `lowered` (fewer than recorded: lower the baseline). */
export function judge(counts, baseline) {
    const over = [];
    for (const [rel, n] of Object.entries(counts)) {
        const allowed = baseline[rel] ?? 0;
        if (n > allowed) over.push(`${rel}: ${n} node name(s), ${allowed} allowed`);
    }
    const lowered = Object.entries(baseline).filter(([rel, n]) => (counts[rel] ?? 0) < n).map(([rel, n]) => `${rel}: ${counts[rel] ?? 0} now, baseline ${n}`);
    return { over, lowered };
}

/** The baseline lowered to what is found: never raised, never a new file. */
export function lowerBaseline(counts, baseline) {
    const next = {};
    for (const rel of Object.keys(baseline).sort()) {
        const n = Math.min(baseline[rel], counts[rel] ?? 0);
        if (n > 0) next[rel] = n;
    }
    return next;
}

function trackedFiles() {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter(Boolean);
}

function main() {
    const { counts, sites } = scan(ROOT, trackedFiles());
    const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_FILE), 'utf8'));
    if (process.argv.includes('--list')) {
        for (const s of sites) console.log(s);
        return 0;
    }
    const { over, lowered } = judge(counts, baseline);
    if (process.argv.includes('--update')) {
        const next = lowerBaseline(counts, baseline);
        writeFileSync(join(ROOT, BASELINE_FILE), JSON.stringify(next, null, 1) + '\n');
        console.log(`lowered ${BASELINE_FILE}: ${Object.keys(baseline).length} → ${Object.keys(next).length} files`);
        if (!over.length) return 0;
    }
    if (over.length) {
        console.log('❌ One of our communities is named in the code (or the address of one of our servers):');
        for (const p of over) console.log(`     ${p}`);
        console.log('   Name a made-up place instead (riverside, Riverside Exchange, riverside.example.org), and read what a');
        console.log("   community says about itself (its info, addresses, primaryAddress) instead of matching one of ours. The");
        console.log(`   global community's address is ${DEFAULTS_FILE}'s DEFAULT_GLOBAL_COMMUNITY_URL. \`--list\` shows every site.`);
        return 1;
    }
    if (lowered.length) {
        console.log('❌ Fewer node names than the baseline allows: lower it so the room is not reused (`node scripts/check-no-node-names.mjs --update`).');
        for (const l of lowered) console.log(`     ${l}`);
        return 1;
    }
    console.log(`✓ no new node names in the code (${sites.length} left to clear, in ${Object.keys(counts).length} files)`);
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
