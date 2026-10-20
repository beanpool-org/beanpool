// The members' guide's titles and summaries in the member's language (slice S5a; scratch/global-node/DESIGN-translation-
// fable.md §4 and director amendment 1 item 4: while a page is untranslated, its title, summary and help line are in the
// member's language over the English body).
//
// English stays the source: each page's front matter and content/manifest.json. Each other language has ONE file,
// content/<lang>/manifest.json, holding its section titles and summaries and every page's title, summary and help line:
//
//   {
//     "_meta":    { … },                                                      optional: who drafted it, review status
//     "sections": { "<section id>": { "title": ENTRY, "summary": ENTRY } },
//     "pages":    { "<page slug>":  { "title": ENTRY, "summary": ENTRY, "help": ENTRY } }
//   }
//   ENTRY = { "text": "<the translation>", "sourceHash": "<guideSourceHash of the English it was drafted from>" }
//
// Any entry may be missing: the English shows. One file for all the short lines, not one per page as §4 first drew it, so
// that the drafting round handles one file per language, the length caps are checked in one place, and the apps bundle
// every language's titles offline for a few kilobytes. The page bodies (slice S5b) can then live beside it as
// content/<lang>/<section>/<slug>.md holding only the body, and a title is never written in two places.
//
// An entry whose sourceHash is not the hash of today's English is STALE: the apps show the English instead (never a
// translation of words the page no longer says) until the next drafting round redrafts it. Stale is not an error, so
// the pull request that changes an English title costs nothing; `pnpm --filter @beanpool/guide titles` lists the stale
// and missing entries per language, and `titles --draft <lang>` prints them in this file's shape, with the English to
// translate, for that round.
//
// The apps never read this module: they bundle the files themselves (apps/native/utils/guide-titles.ts, the web app's
// language chunks) and apply them with @beanpool/core's guideInLanguage, which hashes the English with the same sha256.
// This module is the drafting tooling and the check scripts/build.mjs --check runs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GUIDE_LANGS, checkInline, loadGuide, guideBodyHash } from './guide.mjs';

/** The file in content/<lang>/ that holds a language's titles. */
export const TITLES_FILE = 'manifest.json';

/** The hex digits of sha256 an entry keeps: plenty to notice that the English changed. core's guideSourceHash matches. */
export const SOURCE_HASH_LENGTH = 16;
const HASH_RE = new RegExp(`^[0-9a-f]{${SOURCE_HASH_LENGTH}}$`);

/** The hash of an English title, summary or help line, as an entry records it (sha256 of its UTF-8, first 16 hex digits). */
export function guideSourceHash(english) {
    return crypto.createHash('sha256').update(english, 'utf8').digest('hex').slice(0, SOURCE_HASH_LENGTH);
}

/** The fields an entry may translate, per kind, with the longest each may be (the apps' validateGuide and help-map limits). */
export const TITLE_FIELDS = Object.freeze({
    section: Object.freeze({ title: 80, summary: 300 }),
    page: Object.freeze({ title: 120, summary: 300, help: 160 }),
});

// East Asian wide characters (Han, kana, Hangul, full-width forms): about twice a Latin letter's width on screen.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
const ZERO_WIDTH = /[\p{M}\u200B-\u200D\uFE0F]/u;

/** How wide a line reads, in columns: a wide character counts two, a combining mark or a zero-width space none. */
export function displayColumns(text) {
    let n = 0;
    for (const c of text) n += ZERO_WIDTH.test(c) ? 0 : WIDE.test(c) ? 2 : 1;
    return n;
}

/**
 * The per-language length cap for a title, in display columns (so a Chinese, Japanese or Korean title holds about half
 * the characters of a Latin one): 35 % over its English, which is what the pseudo-locale `xx` pads every title by, and
 * the 320 dp and 320 px render tests at 1.3× text show every guide title that long whole in the guide list, a section
 * and a page (apps/native/utils/__tests__/guide-words-render.test.ts, apps/pwa/e2e/words-w3-screens-check.mjs). Never
 * under 14: that much fits one line of the narrowest row a title is drawn in (the sheet's, 188 dp at 16 × 1.3), so a
 * one-word English title ("Map") is not held to five letters.
 */
export const TITLE_GROWTH = 1.35;
export const TITLE_FLOOR_COLUMNS = 14;
export function titleCap(english) {
    return Math.max(TITLE_FLOOR_COLUMNS, Math.ceil(displayColumns(english) * TITLE_GROWTH));
}

/** Every line a language can translate, in the guide's order: { kind, id, field, key, english }. */
export function titleEntries(guide) {
    const out = [];
    for (const s of guide.sections) {
        for (const field of Object.keys(TITLE_FIELDS.section)) out.push({ kind: 'section', id: s.id, field, key: `sections.${s.id}.${field}`, english: s[field] });
    }
    for (const p of guide.guides) {
        for (const field of Object.keys(TITLE_FIELDS.page)) {
            if (p[field] !== undefined) out.push({ kind: 'page', id: p.slug, field, key: `pages.${p.slug}.${field}`, english: p[field] });
        }
    }
    return out;
}

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const rel = (lang, rest = TITLES_FILE) => `content/${lang}/${rest}`;

/**
 * Each language's titles file as written, or null where it is missing or not JSON; and what is wrong with the folders
 * themselves. Every language must have its file (an empty one is fine): the phone bundles each by name.
 */
export function readGuideTitles(contentDir) {
    const files = {};
    const problems = [];
    for (const lang of GUIDE_LANGS) {
        const dir = path.join(contentDir, lang);
        const file = path.join(dir, TITLES_FILE);
        files[lang] = null;
        if (!fs.existsSync(file)) {
            problems.push(`${rel(lang)} is missing: every language has one, even with nothing translated yet ({ "sections": {}, "pages": {} }), because the apps bundle each by name`);
            continue;
        }
        // A dotfile is the system's, not ours: a Mac's Finder leaves .DS_Store in a folder it has opened (gitignored).
        // Section folders holding translated page bodies (slice S5b) are checked by checkLanguagePages.
        for (const dirent of fs.readdirSync(dir, { withFileTypes: true }).filter(n => !n.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
            if (dirent.isDirectory()) continue;
            if (dirent.name !== TITLES_FILE) problems.push(`${rel(lang, dirent.name)}: a language's folder holds only ${TITLES_FILE} and section folders for translated pages`);
        }
        try {
            files[lang] = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            problems.push(`${rel(lang)} is not JSON (${e.message})`);
        }
    }
    return { files, problems };
}

/** What is wrong with one line of a language's titles, as sentences; `stale` lines are not held to their English's length. */
function textProblems(text, english, field, max, stale) {
    const out = [];
    if (typeof text !== 'string' || text.trim() === '') return ['"text" is the translation, a line of words'];
    if (text !== text.trim()) out.push('starts or ends with a space');
    if (/[\r\n\t]/.test(text)) out.push('is one line: no line breaks or tabs');
    if (/[{}]/.test(text)) out.push('has a {placeholder} or a brace: the guide fills nothing in, so none may appear');
    try { checkInline('', null, text); } catch (e) { out.push(e.message.replace(/^: /, '')); }
    if (text.length > max) out.push(`is ${text.length} characters; the apps take ${max} at most`);
    if (!stale) {
        const bold = s => (s.match(/\*\*/g) || []).length;
        if (bold(text) !== bold(english)) out.push(`marks ${bold(text) / 2} bold run(s) with **; the English marks ${bold(english) / 2}`);
        if (field === 'title' && displayColumns(text) > titleCap(english)) {
            out.push(`is ${displayColumns(text)} columns wide; this title takes ${titleCap(english)} at most (35 % over its English, ${displayColumns(english)}, and never under ${TITLE_FLOOR_COLUMNS}; a wide character counts two)`);
        }
    }
    return out;
}

/**
 * Check every language's titles against the guide's English (the pages as they stand). Returns:
 *   problems   sentences, each a reason the check fails: a key that is no section or page, a field the English does not
 *              have, an entry not shaped { text, sourceHash }, a placeholder, a title over its cap, a missing file
 *   stale      per language, the lines drafted from English that has changed since: { key, english } (not a failure:
 *              the apps show the English until the next drafting round)
 *   counts     per language: { translated, stale, missing, total } lines
 */
export function checkGuideTitles(guide, { files, problems: fileProblems = [] }) {
    const problems = [...fileProblems];
    const stale = {};
    const counts = {};
    const all = titleEntries(guide);
    const english = new Map(all.map(e => [e.key, e.english]));
    const sectionIds = new Set(guide.sections.map(s => s.id));
    const slugs = new Set(guide.guides.map(p => p.slug));
    for (const lang of GUIDE_LANGS) {
        const file = files[lang];
        stale[lang] = [];
        counts[lang] = { translated: 0, stale: 0, missing: all.length, total: all.length };
        if (file === null || file === undefined) continue;
        const where = rel(lang);
        if (!isObject(file)) { problems.push(`${where}: an object with "sections" and "pages"`); continue; }
        for (const key of Object.keys(file)) {
            if (!['_meta', 'sections', 'pages'].includes(key)) problems.push(`${where}: "${key}" is not part of a titles file ("sections", "pages", and an optional "_meta")`);
        }
        if (file._meta !== undefined && !isObject(file._meta)) problems.push(`${where}: "_meta" is an object`);
        let translated = 0;
        for (const [group, kind, known] of [['sections', 'section', sectionIds], ['pages', 'page', slugs]]) {
            const entries = file[group] ?? {};
            if (!isObject(entries)) { problems.push(`${where}: "${group}" is an object keyed by ${kind === 'section' ? 'section id' : 'page slug'}`); continue; }
            for (const [id, entry] of Object.entries(entries)) {
                if (!known.has(id)) { problems.push(`${where}: ${group}.${id}: the guide has no ${kind} "${id}"`); continue; }
                if (!isObject(entry)) { problems.push(`${where}: ${group}.${id}: an object of { text, sourceHash } per field`); continue; }
                for (const [field, value] of Object.entries(entry)) {
                    const key = `${group}.${id}.${field}`;
                    const max = TITLE_FIELDS[kind][field];
                    if (max === undefined) { problems.push(`${where}: ${key}: a ${kind} translates ${Object.keys(TITLE_FIELDS[kind]).join(', ')} only`); continue; }
                    const en = english.get(key);
                    if (en === undefined) { problems.push(`${where}: ${key}: the English ${kind} has no ${field} to translate`); continue; }
                    if (!isObject(value) || Object.keys(value).sort().join() !== 'sourceHash,text') {
                        problems.push(`${where}: ${key}: { "text": "<translation>", "sourceHash": "<hash of the English>" }, nothing else`);
                        continue;
                    }
                    if (typeof value.sourceHash !== 'string' || !HASH_RE.test(value.sourceHash)) {
                        problems.push(`${where}: ${key}: "sourceHash" is ${SOURCE_HASH_LENGTH} hex digits (guideSourceHash of the English)`);
                        continue;
                    }
                    const isStale = value.sourceHash !== guideSourceHash(en);
                    for (const p of textProblems(value.text, en, field, max, isStale)) problems.push(`${where}: ${key}: ${JSON.stringify(value.text)} ${p}`);
                    if (isStale) stale[lang].push({ key, english: en });
                    else translated++;
                }
            }
        }
        counts[lang] = { translated, stale: stale[lang].length, missing: all.length - translated - stale[lang].length, total: all.length };
    }
    return { problems, stale, counts };
}

/**
 * The drafting round's work for one language, in the titles file's own shape: every line it is missing or holds stale,
 * with the English as "text" and today's sourceHash. Translate each "text" and merge the entries into
 * content/<lang>/manifest.json. For a language with nothing translated, this is the whole file in English.
 */
export function draftGuideTitles(guide, file) {
    const out = { sections: {}, pages: {} };
    for (const e of titleEntries(guide)) {
        const group = e.kind === 'section' ? 'sections' : 'pages';
        const have = isObject(file) && isObject(file[group]) && isObject(file[group][e.id]) ? file[group][e.id][e.field] : undefined;
        const hash = guideSourceHash(e.english);
        if (isObject(have) && have.sourceHash === hash && typeof have.text === 'string' && have.text.trim()) continue;
        (out[group][e.id] ??= {})[e.field] = { text: e.english, sourceHash: hash };
    }
    return out;
}

/**
 * Draft a translated guide page in content/<lang>/<section>/<slug>.md shape:
 * front matter with slug, title, summary, related, optional video, help, and source-hash
 * (sha256 hex of the English body blocks canonical JSON), followed by the English body.
 */
export function draftGuidePage(contentDir, lang, slug) {
    if (!GUIDE_LANGS.includes(lang)) {
        throw new Error(`unknown language "${lang}"; must be one of ${GUIDE_LANGS.join(', ')}`);
    }
    const englishGuide = loadGuide(contentDir);
    const page = englishGuide.guides.find(g => g.slug === slug);
    if (!page) {
        throw new Error(`page "${slug}" does not exist in the guide`);
    }
    const section = englishGuide.sections.find(s => s.id === page.section);
    if (!section) {
        throw new Error(`section "${page.section}" for page "${slug}" not found`);
    }
    const englishFile = path.join(contentDir, section.id, `${slug}.md`);
    if (!fs.existsSync(englishFile)) {
        throw new Error(`file "${englishFile}" not found`);
    }
    const englishRaw = fs.readFileSync(englishFile, 'utf8').replace(/\r\n/g, '\n');
    const lines = englishRaw.split('\n');
    let bodyStart = -1;
    let sepCount = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '---') {
            sepCount++;
            if (sepCount === 2) {
                bodyStart = i + 1;
                break;
            }
        }
    }
    const rawBody = bodyStart >= 0 ? lines.slice(bodyStart).join('\n').trim() : '';
    const bodyHash = guideBodyHash(page);

    // Check if manifest.json has translated title, summary, or help
    let title = page.title;
    let summary = page.summary;
    let help = page.help;
    const manifestPath = path.join(contentDir, lang, TITLES_FILE);
    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const p = manifest.pages?.[slug];
            if (p?.title?.text && p.title.sourceHash === guideSourceHash(page.title)) title = p.title.text;
            if (p?.summary?.text && p.summary.sourceHash === guideSourceHash(page.summary)) summary = p.summary.text;
            if (page.help && p?.help?.text && p.help.sourceHash === guideSourceHash(page.help)) help = p.help.text;
        } catch { /* ignore */ }
    }

    const frontMatter = [
        '---',
        `slug: ${slug}`,
        `title: ${title}`,
        `summary: ${summary}`,
        ...(page.related?.length ? [`related: ${page.related.join(', ')}`] : []),
        ...(page.video ? [`video: ${page.video}`] : []),
        ...(help ? [`help: ${help}`] : []),
        `source-hash: ${bodyHash}`,
        '---',
    ].join('\n');

    return `${frontMatter}\n\n${rawBody}\n`;
}
