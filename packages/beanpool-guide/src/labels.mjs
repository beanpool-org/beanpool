// The translated guide pages held to what the apps show (words round, #3247 review round 1, 16 Nov 2026).
//
// A translated page (content/<lang>/<section>/<slug>.md) tells a member which button to tap, so:
//   - a **bold** label whose English, on the same line of the English page, is the English of a sentence in the apps'
//     catalogs must be that sentence's value in the page's language (a sentence with a count: the form its number
//     needs, "Invite 2 people" → that language's form for 2);
//   - a page named in "quotes" on the English line must be named by its title in that language.
// A label left in English, or worded differently from the app, sends the reader looking for a button they will never
// see. Capitals aside (a role named mid-sentence, "an **observer**", is the app's word in lower case), and without what
// the app draws around a label (an emoji before it, an arrow after it: `👥 Chat groups`, `Manage ›`): the guide may
// bold the words alone, as long as they are the app's words. Where one English word is several sentences in the
// catalogs (a context: "Open" a vote, "Open" to anyone), any of their values passes.
//
// The lines are paired by position: a translated page keeps the English page's lines, headings and list items one for
// one (the drafting round, titles.mjs --draft-page, starts from the English body). Only pages at today's English (their
// source-hash is the English body's hash) are held to it. A page behind its English shows "This page is newer in
// English" until its next drafting round brings it current, and with it under this check; until then its problems are
// listed (`--behind`), never a failure.
//
//   node packages/beanpool-guide/src/labels.mjs [--behind] [--shrink]
//
// labels-baseline.json holds the problems on older pages that were current when this check came (16 Nov 2026: 85
// lines on 7 pages, more than that PR could take on), waiting for a follow-up words round. It may only shrink: the
// check fails on a problem it does not hold and on one it holds that is gone (--shrink writes it without those).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE_LANGS, guideBodyHash, parseGuideMarkdown } from './guide.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repository root (the catalogs live in the apps, not in this package). */
export const REPO_ROOT = path.resolve(HERE, '../../..');
export const CONTENT_DIR = path.resolve(HERE, '..', 'content');
export const BASELINE_FILE = path.join(HERE, 'labels-baseline.json');
/** The catalogs a member's screen reads its words from: the phone, the web app, core (both apps) and the server's replies. */
export const CATALOG_DIRS = Object.freeze(['apps/native/words', 'apps/pwa/words', 'packages/beanpool-core/words', 'apps/server/words']);

/**
 * Deliberate exceptions: a problem's key (`<lang>/<section>/<slug>.md: **<English bold>**`, or `: "<English title>"`
 * for a page name), with why in a comment above it. Empty to start (16 Nov 2026): every label follows the app.
 */
export const LABEL_EXCEPTIONS = Object.freeze([]);

const CONTEXT_SEPARATOR = '\u0004';
const PLURAL_SEPARATOR = '|';
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/** A label without what the app draws around it: leading emoji, symbols and spaces; trailing arrows and spaces. */
export function bareLabel(text) {
    return String(text).replace(/^[^\p{L}\p{N}{]+/u, '').replace(/[\s›→»>‹←«<]+$/u, '').trim();
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One language's catalogs as a lookup from an English bold to what the app shows for it.
 * `catalogs`: [{ key, value }], key the catalog's (the English; `one|other` for a count; `…\u0004context`),
 * value a string or the language's plural forms ({ one, other, … }).
 */
export function labelIndex(lang, catalogs) {
    const exact = new Map(); // bare English → Set of bare translations
    const patterns = []; // sentences with a {placeholder}: matched against a bold that carries a number
    const plural = new Intl.PluralRules(lang);
    for (const { key, value } of catalogs) {
        const source = key.split(CONTEXT_SEPARATOR)[0];
        const forms = source.includes(PLURAL_SEPARATOR) ? source.split(PLURAL_SEPARATOR) : [source];
        for (const english of forms) {
            const bare = bareLabel(english);
            const names = [...bare.matchAll(PLACEHOLDER)].map(m => m[1]);
            if (names.length === 0) {
                const v = typeof value === 'string' ? bareLabel(value) : '';
                if (!bare || !v) continue;
                if (!exact.has(bare)) exact.set(bare, new Set());
                exact.get(bare).add(v);
                continue;
            }
            // The English bold carries the number ("Invite 2 people"), so a placeholder stands for digits only (a name or
            // a phrase in its place is the guide's own example, not the app's words), and only when the words around it
            // say something: a bare "{n}" would match every number.
            if (bare.replace(PLACEHOLDER, '').replace(/[^\p{L}]/gu, '').length < 3) continue;
            const re = new RegExp(`^${bare.split(PLACEHOLDER).map((part, i) => (i % 2 ? '(\\d+)' : escapeRe(part))).join('')}$`, 'u');
            patterns.push({ re, names, value });
        }
    }
    return {
        /** The bare words the app can show for this English bold, or null when no catalog sentence is it. */
        expected(englishBold) {
            const bold = bareLabel(englishBold);
            if (exact.has(bold)) return [...exact.get(bold)];
            const out = new Set();
            for (const { re, names, value } of patterns) {
                const m = re.exec(bold);
                if (!m) continue;
                const args = Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
                let form = value;
                if (value && typeof value === 'object') {
                    const count = Number(args.n ?? args.count ?? Object.values(args)[0]);
                    form = value[plural.select(count)] ?? value.other;
                }
                if (typeof form === 'string') out.add(bareLabel(form.replace(PLACEHOLDER, (all, name) => args[name] ?? all)));
            }
            return out.size ? [...out] : null;
        },
    };
}

/** The bold runs on one line. */
export const boldRuns = line => [...line.matchAll(/\*\*(.+?)\*\*/g)].map(m => m[1]);
/** The "quoted" names on one English line. */
const quoted = line => [...line.matchAll(/["“]([^"”]+)["”]/g)].map(m => m[1]);

/** A page's body lines that carry words: front matter and blank lines dropped. Each keeps its 1-based line number. */
export function bodyLines(source) {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const start = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0;
    const out = [];
    for (let i = start; i < lines.length; i++) if (lines[i].trim()) out.push({ n: i + 1, text: lines[i] });
    return out;
}

/**
 * One translated page against its English page. `titles`: English page title → the titles that page has in this
 * language (its translated page's front matter, its manifest line). Returns { findings, paired }; each finding is
 * { key, message, file, line, kind: 'label' | 'title', english, want, enText }.
 */
export function checkTranslatedPage({ file, english, translated, index, titles = new Map(), exceptions = LABEL_EXCEPTIONS }) {
    const en = bodyLines(english);
    const tr = bodyLines(translated);
    if (en.length !== tr.length) return { findings: [], paired: false };
    const allowed = new Set(exceptions);
    const lang = file.split('/')[0];
    const fold = s => s.toLocaleLowerCase(lang);
    const findings = [];
    for (let i = 0; i < en.length; i++) {
        const trBold = boldRuns(tr[i].text).map(bareLabel);
        const trFolded = trBold.map(fold);
        for (const bold of boldRuns(en[i].text)) {
            const want = index.expected(bold);
            const key = `${file}: **${bold}**`;
            if (!want || allowed.has(key) || want.some(w => trFolded.includes(fold(w)))) continue;
            const has = trBold.length ? trBold.map(b => `**${b}**`).join(', ') : 'nothing';
            findings.push({ key, file, line: tr[i].n, kind: 'label', english: bold, want, enText: en[i].text,
                message: `${file}:${tr[i].n}: **${bold}** is ${want.map(w => `**${w}**`).join(' or ')} in the app; the line bolds ${has}` });
        }
        for (const name of quoted(en[i].text)) {
            const want = titles.get(name);
            const key = `${file}: "${name}"`;
            if (!want || allowed.has(key) || want.some(w => tr[i].text.includes(w))) continue;
            findings.push({ key, file, line: tr[i].n, kind: 'title', english: name, want, enText: en[i].text,
                message: `${file}:${tr[i].n}: "${name}" is the page ${want.map(w => `"${w}"`).join(' or ')} in this language; the line does not name it` });
        }
    }
    return { findings, paired: true };
}

/** Every sentence of one language's catalogs, as { key, value }, from each of CATALOG_DIRS. */
export function readCatalogs(root, lang) {
    const out = [];
    for (const dir of CATALOG_DIRS) {
        const file = path.join(root, dir, `${lang}.json`);
        if (!fs.existsSync(file)) continue;
        for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
            if (key !== '_meta' && value != null && value !== '') out.push({ key, value });
        }
    }
    return out;
}

const frontMatter = source => {
    const meta = {};
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '---') return meta;
    for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
        const m = /^([a-z-]+):\s*(.+)$/.exec(lines[i]);
        if (m) meta[m[1]] = m[2].trim();
    }
    return meta;
};

/**
 * Every translated page in every language. Returns { findings, behindFindings, behind: [file], checked }: `findings`
 * on the pages at today's English, `behindFindings` on the pages behind it (listed for their drafting round).
 */
export function checkGuideLabels({ contentDir = CONTENT_DIR, root = REPO_ROOT, langs = GUIDE_LANGS, exceptions = LABEL_EXCEPTIONS } = {}) {
    const englishPages = new Map(); // "<section>/<slug>.md" → { source, title, slug, hash }
    for (const section of fs.readdirSync(contentDir).sort()) {
        const dir = path.join(contentDir, section);
        if (!fs.statSync(dir).isDirectory() || GUIDE_LANGS.includes(section)) continue;
        for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort()) {
            const source = fs.readFileSync(path.join(dir, name), 'utf8');
            const meta = frontMatter(source);
            englishPages.set(`${section}/${name}`, { source, title: meta.title, slug: meta.slug, hash: guideBodyHash(parseGuideMarkdown(source, `${section}/${name}`)) });
        }
    }
    const findings = [];
    const behindFindings = [];
    const behind = [];
    let checked = 0;
    for (const lang of langs) {
        const langDir = path.join(contentDir, lang);
        if (!fs.existsSync(langDir)) continue;
        const pages = [];
        for (const section of fs.readdirSync(langDir).sort()) {
            const dir = path.join(langDir, section);
            if (!fs.statSync(dir).isDirectory()) continue;
            for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort()) pages.push(`${section}/${name}`);
        }
        if (pages.length === 0) continue;
        const manifestFile = path.join(langDir, 'manifest.json');
        const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
        const titles = new Map();
        for (const [rel, page] of englishPages) {
            const names = new Set();
            const own = path.join(langDir, rel);
            if (fs.existsSync(own)) names.add(frontMatter(fs.readFileSync(own, 'utf8')).title);
            names.add(manifest.pages?.[page.slug]?.title?.text);
            names.delete(undefined);
            if (page.title && names.size) titles.set(page.title, [...names]);
        }
        const index = labelIndex(lang, readCatalogs(root, lang));
        for (const rel of pages) {
            const english = englishPages.get(rel);
            if (!english) continue; // a page the English no longer has: build.mjs --check reports it
            const file = `${lang}/${rel}`;
            const translated = fs.readFileSync(path.join(langDir, rel), 'utf8');
            const r = checkTranslatedPage({ file, english: english.source, translated, index, titles, exceptions });
            if (frontMatter(translated)['source-hash'] !== english.hash) {
                behind.push(file);
                behindFindings.push(...r.findings);
                continue;
            }
            checked += 1;
            if (!r.paired) findings.push({ key: `${file}: lines`, file, message: `${file}: is at today's English (its source-hash) but its lines do not pair one for one with the English page's` });
            findings.push(...r.findings);
        }
    }
    return { findings, behindFindings, behind, checked };
}

/** The baseline's keys (a key twice when a page has the problem twice). */
export function readBaseline(file = BASELINE_FILE) {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).problems : [];
}

/**
 * Findings against the baseline: `fresh`, the findings it does not hold (failures), and `gone`, the keys it holds that
 * are no longer found (fixed: take them out with --shrink).
 */
export function againstBaseline(findings, baseline) {
    const left = new Map();
    for (const k of baseline) left.set(k, (left.get(k) ?? 0) + 1);
    const fresh = [];
    for (const f of findings) {
        if (left.get(f.key) > 0) left.set(f.key, left.get(f.key) - 1);
        else fresh.push(f);
    }
    const gone = [];
    for (const [k, n] of left) for (let i = 0; i < n; i++) gone.push(k);
    return { fresh, gone };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { findings, behindFindings, behind, checked } = checkGuideLabels();
    const baseline = readBaseline();
    const { fresh, gone } = againstBaseline(findings, baseline);
    for (const f of fresh) console.log(f.message);
    for (const k of gone) console.log(`fixed, still in labels-baseline.json: ${k}`);
    if (process.argv.includes('--behind')) for (const f of behindFindings) console.log(`(behind) ${f.message}`);
    if (process.argv.includes('--shrink') && gone.length) {
        const doc = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
        const drop = new Map();
        for (const k of gone) drop.set(k, (drop.get(k) ?? 0) + 1);
        doc.problems = doc.problems.filter(k => !(drop.get(k) > 0 && drop.set(k, drop.get(k) - 1)));
        fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(doc, null, 2)}\n`);
        console.log(`labels-baseline.json: ${gone.length} fixed problem(s) taken out`);
    }
    console.log(`\n${checked} translated pages at today's English checked: ${findings.length} problem(s), ${findings.length - fresh.length} of them in labels-baseline.json, ${fresh.length} new; ${behind.length} pages behind their English (${behindFindings.length} problem(s) listed with --behind)`);
    process.exitCode = fresh.length || (gone.length && !process.argv.includes('--shrink')) ? 1 : 0;
}
