// The members' guide: ONE source (content/*.md) read by both the app's bundled copy and the website's
// member pages. This module turns the Markdown into a small block model and renders the website's HTML
// from that same model, so the two can only differ if someone edits a generated file by hand — and the
// check in scripts/build.mjs (run by `pnpm test`) fails when they do.
//
// The Markdown is a deliberately tiny subset, because the app renders it with plain <Text> (no web view)
// and a copy fetched from the website must never be able to smuggle in anything richer:
//   ---            front matter: slug, title, summary, related (one line each; related is a comma-separated list
//                  of other pages' slugs), and optionally video (a YouTube id from the Learn lane)
//   ## Heading     section heading          ### Heading   sub-heading
//   - item         bullet (one line each)   blank line    ends a paragraph or list
//   **bold**       the only inline style
// Anything else that looks like Markdown (links, numbered lists, tables, quotes, HTML) is an error, not
// silently printed as text.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Bump when the JSON shape changes in a way an older app could not read. The app refuses other schemas. */
export const GUIDE_SCHEMA = 2;

const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const VIDEO_RE = /^[A-Za-z0-9_-]{6,20}$/;
/** The section that holds the four concept guides; every other section is the how-to manual. */
export const ABOUT_SECTION = 'about';

/**
 * The languages the guide is written in besides English, as core's LANGS spells them (packages/beanpool-core/src/words.ts;
 * apps/native/utils/__tests__/guide.test.ts keeps the two lists the same). Each has a folder, content/<lang>/, holding
 * manifest.json: its section and page titles and summaries (src/titles.mjs). Those folders are not sections.
 */
export const GUIDE_LANGS = Object.freeze(['es', 'pt', 'hi', 'bn', 'fr', 'ar', 'id', 'ru', 'zh-Hans', 'zh-Hant', 'it', 'de', 'tr', 'sw', 'ml', 'ta', 'uk', 'ur', 'fa', 'vi', 'el', 'fil', 'ja', 'ko']);

/** A page's title and summary at most, as the apps' validateGuide takes them. */
const MAX_TITLE = 120;
const MAX_SUMMARY = 300;
/** A page's `help:` line at most: the "?" sheet's body (packages/beanpool-core help-map.ts). */
const MAX_HELP = 160;

function fail(file, line, message) {
    throw new Error(`${file}${line ? `:${line}` : ''}: ${message}`);
}

export function checkInline(file, line, text) {
    if ((text.match(/\*\*/g) || []).length % 2 !== 0) fail(file, line, 'unbalanced ** (bold)');
    if (/\[[^\]]*\]\([^)]*\)/.test(text)) fail(file, line, 'links are not supported; the app shows plain text');
    if (/<[a-zA-Z/!]/.test(text)) fail(file, line, 'HTML is not supported');
    if (/(^|[^*])\*([^*]|$)/.test(text) || /(^|\W)_[^_]+_(\W|$)/.test(text)) fail(file, line, 'only **bold** is supported');
    if (/`/.test(text)) fail(file, line, 'code spans are not supported');
}

/** Parse one guide file. `file` is only used in error messages. */
export function parseGuideMarkdown(source, file = 'guide.md', { allowImages = false, isTranslated = false } = {}) {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '---') fail(file, 1, 'must start with front matter (---)');
    const meta = {};
    let i = 1;
    for (; i < lines.length && lines[i] !== '---'; i++) {
        const m = /^([a-z-]+):\s*(.+)$/.exec(lines[i]);
        if (!m) fail(file, i + 1, 'front matter lines are "key: value"');
        meta[m[1]] = m[2].trim();
    }
    if (i >= lines.length) fail(file, null, 'front matter is not closed with ---');
    for (const key of ['slug', 'title', 'summary', 'related']) {
        if (!meta[key]) fail(file, null, `front matter needs "${key}"`);
    }
    const translated = isTranslated || meta['source-hash'] !== undefined;
    const allowedKeys = translated
        ? ['slug', 'title', 'summary', 'related', 'video', 'help', 'source-hash']
        : ['slug', 'title', 'summary', 'related', 'video', 'help'];
    for (const key of Object.keys(meta)) {
        if (!allowedKeys.includes(key)) fail(file, null, `unknown front matter "${key}"`);
    }
    if (isTranslated && !meta['source-hash']) fail(file, null, 'front matter needs "source-hash"');
    if (meta['source-hash'] !== undefined && !/^[0-9a-f]{16}$/.test(meta['source-hash'])) {
        fail(file, null, '"source-hash" must be 16 hex digits');
    }
    if (!SLUG_RE.test(meta.slug)) fail(file, null, `slug "${meta.slug}" must be lowercase letters, digits and dashes`);
    checkInline(file, null, meta.title);
    checkInline(file, null, meta.summary);
    if (meta.help !== undefined) checkInline(file, null, meta.help);
    // The limits the apps check every page against (packages/beanpool-core member-guide.ts): one page over them makes
    // the whole guide or manual invalid there, so the build refuses the page instead.
    for (const [key, max] of [['title', MAX_TITLE], ['summary', MAX_SUMMARY], ['help', MAX_HELP]]) {
        if (meta[key] !== undefined && meta[key].length > max) fail(file, null, `${key} is ${meta[key].length} characters; the apps take ${max} at most`);
    }
    const related = meta.related.split(',').map(r => r.trim()).filter(Boolean);
    if (related.length === 0 || related.length > 8) fail(file, null, 'related lists 1 to 8 other pages');
    for (const r of related) {
        if (!SLUG_RE.test(r)) fail(file, null, `related "${r}" is not a page slug`);
        if (r === meta.slug) fail(file, null, 'a page cannot be related to itself');
    }
    if (new Set(related).size !== related.length) fail(file, null, 'related lists a page twice');
    if (meta.video !== undefined && !VIDEO_RE.test(meta.video)) fail(file, null, `video "${meta.video}" must be a YouTube video id`);

    const blocks = [];
    let para = null;
    let list = null;
    const flush = () => {
        if (para) blocks.push({ type: 'p', text: para.join(' ') });
        if (list) blocks.push({ type: 'ul', items: list });
        para = null;
        list = null;
    };

    for (i = i + 1; i < lines.length; i++) {
        const n = i + 1;
        const line = lines[i].trimEnd();
        if (line.trim() === '') { flush(); continue; }
        if (/^\s/.test(line)) fail(file, n, 'no indented lines (nested lists and code blocks are not supported)');
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            if (level !== 2 && level !== 3) fail(file, n, 'use ## or ### headings (the title comes from front matter)');
            flush();
            checkInline(file, n, heading[2]);
            blocks.push({ type: level === 2 ? 'h2' : 'h3', text: heading[2].trim() });
            continue;
        }
        const linkedImg = /^\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)$/.exec(line.trim());
        if (linkedImg) {
            if (!allowImages) fail(file, n, "images are only allowed in the operator manual, not in the members' guide (the apps cannot show them)");
            flush();
            const alt = linkedImg[1].trim();
            const src = linkedImg[2].trim();
            const href = linkedImg[3].trim();
            if (!alt) fail(file, n, 'images need alt text');
            if (!src) fail(file, n, 'images need a source path');
            if (!href) fail(file, n, 'linked images need a target slug');
            blocks.push({ type: 'img', src, alt, href });
            continue;
        }
        const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line.trim());
        if (img) {
            if (!allowImages) fail(file, n, "images are only allowed in the operator manual, not in the members' guide (the apps cannot show them)");
            flush();
            const alt = img[1].trim();
            const src = img[2].trim();
            if (!alt) fail(file, n, 'images need alt text');
            if (!src) fail(file, n, 'images need a source path');
            blocks.push({ type: 'img', src, alt });
            continue;
        }
        if (line.startsWith('- ')) {
            if (para) flush();
            const item = line.slice(2).trim();
            checkInline(file, n, item);
            (list ??= []).push(item);
            continue;
        }
        if (/^(\d+[.)]\s|[*+]\s|>|\||```)/.test(line)) fail(file, n, 'only "- " bullets, ## headings, images and paragraphs are supported');
        if (list) fail(file, n, 'a bullet is one line; leave a blank line after a list');
        checkInline(file, n, line);
        (para ??= []).push(line.trim());
    }
    flush();
    if (blocks.length === 0) fail(file, null, 'has no content');
    const page = { slug: meta.slug, title: meta.title, summary: meta.summary, related };
    if (meta.video) page.video = meta.video;
    if (meta.help) page.help = meta.help;
    if (meta['source-hash']) {
        page.sourceHash = meta['source-hash'];
        page['source-hash'] = meta['source-hash'];
    }
    page.blocks = blocks;
    return page;
}

/** Hash of the guide text only (not the version), so publishing can tell whether the text changed. */
export function contentHash(content) {
    return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** Hash of an English string (sha256, first 16 hex digits). */
export function guideSourceHash(english) {
    return crypto.createHash('sha256').update(english, 'utf8').digest('hex').slice(0, 16);
}

/** Hash of an English page body (the canonical JSON of its blocks): first 16 hex digits of sha256. */
export function guideBodyHash(pageOrBlocks) {
    const blocks = Array.isArray(pageOrBlocks) ? pageOrBlocks : pageOrBlocks.blocks;
    const canonical = blocks.map(b => b.type === 'ul' ? { type: 'ul', items: b.items } : { type: b.type, text: b.text });
    return guideSourceHash(JSON.stringify(canonical));
}

/**
 * Read content/manifest.json and every page it lists. Each section is a folder, content/<section id>/, holding
 * exactly the pages the manifest lists for it, one file per page named <slug>.md. The operator manual
 * (operators/) is read the same way with `aboutSection: null`: it has no section of concept guides.
 *
 * The pages carry no version: a collection gets one when the director publishes it after merge (scripts/build.mjs),
 * so `version` is null unless the caller passes the one it is publishing under.
 */
export function loadGuide(contentDir, { aboutSection = ABOUT_SECTION, allowImages = false, version = null } = {}) {
    const manifest = JSON.parse(fs.readFileSync(path.join(contentDir, 'manifest.json'), 'utf8'));
    if ('version' in manifest) {
        throw new Error('manifest.json: remove "version". A version is set when the director publishes the text after merge, never by hand (packages/beanpool-guide/README.md)');
    }
    if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) throw new Error('manifest.json: "sections" lists the sections');
    for (const sec of manifest.sections) {
        if (GUIDE_LANGS.includes(sec?.id)) throw new Error(`manifest.json: section id "${sec.id}" is a language's folder (content/${sec.id}/ holds that language's titles); pick another id`);
    }
    // A language's folder (content/<lang>/: its titles, src/titles.mjs) is not a section.
    const folders = fs.readdirSync(contentDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== 'images' && !GUIDE_LANGS.includes(d.name)).map(d => d.name).sort();
    const listedFolders = manifest.sections.map(s => s.id).sort();
    if (JSON.stringify(folders) !== JSON.stringify(listedFolders)) {
        throw new Error(`manifest.json "sections" (${listedFolders.join(', ')}) must match the folders in content/ (${folders.join(', ')})`);
    }
    if (aboutSection && !manifest.sections.some(s => s.id === aboutSection)) throw new Error(`manifest.json needs the "${aboutSection}" section`);
    const sections = [];
    const guides = [];
    for (const sec of manifest.sections) {
        if (!SLUG_RE.test(sec.id)) throw new Error(`manifest.json: section id "${sec.id}" must be lowercase letters, digits and dashes`);
        if (typeof sec.title !== 'string' || !sec.title || typeof sec.summary !== 'string' || !sec.summary) {
            throw new Error(`manifest.json: section "${sec.id}" needs a title and a summary`);
        }
        checkInline('manifest.json', null, sec.title);
        checkInline('manifest.json', null, sec.summary);
        if (!Array.isArray(sec.pages) || sec.pages.length === 0) throw new Error(`manifest.json: section "${sec.id}" lists its pages`);
        const dir = path.join(contentDir, sec.id);
        const onDisk = fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
        const listed = [...sec.pages].sort();
        if (JSON.stringify(onDisk) !== JSON.stringify(listed)) {
            throw new Error(`manifest.json section "${sec.id}" (${listed.join(', ')}) must list exactly the .md files in content/${sec.id}/ (${onDisk.join(', ')})`);
        }
        for (const slug of sec.pages) {
            const file = `${sec.id}/${slug}.md`;
            const g = parseGuideMarkdown(fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8'), file, { allowImages });
            if (g.slug !== slug) throw new Error(`${file}: slug "${g.slug}" must match the file name`);
            if (guides.some(x => x.slug === slug)) throw new Error(`${file}: another page already uses the slug "${slug}"`);
            // Keep the key order stable: it is part of the bytes both apps and the website carry.
            const { blocks, video, related, ...head } = g;
            guides.push({ ...head, section: sec.id, related, ...(video ? { video } : {}), blocks });
        }
        sections.push({ id: sec.id, title: sec.title, summary: sec.summary, slugs: [...sec.pages] });
    }
    const slugs = new Set(guides.map(g => g.slug));
    for (const g of guides) {
        for (const r of g.related) {
            if (!slugs.has(r)) throw new Error(`${g.section}/${g.slug}.md: related page "${r}" does not exist`);
        }
        for (const b of g.blocks) {
            if (b.type === 'img') {
                const imgPath = path.join(contentDir, b.src);
                if (!fs.existsSync(imgPath)) {
                    throw new Error(`${g.section}/${g.slug}.md: image "${b.src}" does not exist`);
                }
                if (b.href && !slugs.has(b.href)) {
                    throw new Error(`${g.section}/${g.slug}.md: linked image target "${b.href}" does not exist`);
                }
            }
        }
    }
    return { schema: GUIDE_SCHEMA, version, hash: contentHash({ sections, guides }), sections, guides };
}

/** The exact bytes of guide.json — the same file in the app bundle and on the website. */
export function serializeGuide(guide) {
    return JSON.stringify(guide, null, 2) + '\n';
}

// ─── Website pages ─────────────────────────────────────────────────────────────

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Escape, then turn **bold** into <strong>. */
function inline(text) {
    return esc(text).split('**').map((part, idx) => (idx % 2 === 1 ? `<strong>${part}</strong>` : part)).join('');
}

/** One block as HTML; an image links its page only when `linkable(slug)` (that page is on the website too). */
function blockHtml(b, linkable = () => true) {
    if (b.type === 'h2') return `<h2>${inline(b.text)}</h2>`;
    if (b.type === 'h3') return `<h3>${inline(b.text)}</h3>`;
    if (b.type === 'p') return `<p>${inline(b.text)}</p>`;
    if (b.type === 'img') {
        const img = `<img src="${esc(b.src)}" alt="${esc(b.alt)}" loading="lazy">`;
        return `<figure>${b.href && linkable(b.href) ? `<a href="${esc(b.href)}.html">${img}</a>` : img}<figcaption>${inline(b.alt)}</figcaption></figure>`;
    }
    return `<ul>\n${b.items.map(it => `            <li>${inline(it)}</li>`).join('\n')}\n        </ul>`;
}

function page({ title, description, body, root = '../', nav = `<a href="index.html">Members' guide</a>`, lang = 'en', source = root === '../' ? 'content' : 'operators' }) {
    return `<!DOCTYPE html>
<!-- Generated from packages/beanpool-guide/${source} by packages/beanpool-guide/scripts/build.mjs. Do not edit by hand. -->
<html lang="${esc(lang)}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <link rel="icon" type="image/png" href="${root}favicon.png">
    <link rel="stylesheet" href="${root}fonts/fonts.css">
    <link rel="stylesheet" href="${root}style.css?v=2.5">
    <style>
        /* Width only: .legal-content's top margin is what clears the fixed navbar. */
        .guide { max-width: 760px; }
        .guide .kicker { color: var(--text-muted); font-size: 0.85rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.4rem; }
        .guide .lede { font-size: 1.1rem; color: var(--text-secondary); margin-bottom: 1.5rem; }
        .guide h3 { font-family: var(--font-header); color: var(--text-primary); font-size: 1.1rem; margin: 1.4rem 0 0.5rem; }
        .guide strong { color: var(--text-primary); }
        .guide .guide-list { list-style: none; padding: 0; margin: 1.5rem 0 0; }
        .guide .guide-list li { margin: 0 0 0.75rem; }
        .guide .guide-list a { display: block; padding: 1rem 1.15rem; border: 1px solid var(--border); border-radius: 12px; text-decoration: none; }
        .guide .guide-list a span { display: block; color: var(--text-secondary); font-size: 0.95rem; margin-top: 0.2rem; }
        .guide .guide-toc { border: 1px solid var(--border); border-radius: 12px; padding: 0.9rem 1.15rem; margin: 1rem 0 0.5rem; }
        .guide .guide-toc h2 { margin: 0 0 0.4rem; font-size: 1rem; }
        .guide .guide-toc ul { margin: 0; padding-left: 1.1rem; }
        .guide .guide-toc a { display: inline-block; padding: 0.7rem 0; min-height: 48px; box-sizing: border-box; }
        .guide h2[id], .guide h3[id] { scroll-margin-top: 110px; }
        .guide .guide-manual, .guide .guide-related { margin-top: 2.5rem; }
        .guide .guide-foot { margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.95rem; }
        .guide-nav .nav-links { gap: 1.25rem; }
        /* The site hides nav links on phones (the home page has a menu instead); these stay, as 48px targets. */
        @media (max-width: 768px) { .guide-nav .nav-links a { display: inline-flex !important; align-items: center; min-height: 48px; } }
        @media (max-width: 480px) {
            .guide { margin-left: 16px; margin-right: 16px; padding: 1.5rem 1.1rem; }
            .guide-nav .logo span { display: none; }
            /* Three links don't fit beside the logo at 320px with large text; the bean logo already goes home. */
            .guide-nav .nav-inner { padding-left: 16px; padding-right: 16px; }
            .guide-nav .nav-links a.guide-nav-home { display: none !important; }
        }
    </style>
</head>
<body>
    <nav id="navbar" class="guide-nav">
        <div class="nav-inner">
            <a href="${root}index.html" class="logo"><img src="${root}bean.png" alt="BeanPool" style="width: 44px; height: 44px; object-fit: contain; vertical-align: middle; margin-right: 0.2rem;" /> <span>BeanPool</span></a>
            <div class="nav-links">
                ${nav}
                <a href="${root}help.html">Help</a>
                <a href="${root}index.html" class="guide-nav-home">Home</a>
            </div>
        </div>
    </nav>

    <main class="legal-content glass-panel guide">
${body}
    </main>
</body>
</html>
`;
}

const linkItem = g => `            <li><a href="${g.slug}.html"><strong>${inline(g.title)}</strong><span>${inline(g.summary)}</span></a></li>`;

/** Every file under apps/website/guide/, keyed by file name. */
export function renderWebsite(guide, { operatorManualOnWeb = false } = {}) {
    const operators = operatorManualOnWeb
        ? `Read the <a href="operators/index.html">operator manual</a>.`
        : `Its manual is in your server's Settings: sign in and press Manual in the side bar.`;
    const foot = `        <p class="guide-foot">The same guide is in the BeanPool app, and works there without a connection: open Settings, then "Help &amp; how it works" under BeanPool. Every other rule, guide and manual is in the <a href="../help.html">Help Centre</a>. Guide version ${guide.version}.</p>`;
    const bySlug = new Map(guide.guides.map(g => [g.slug, g]));
    const about = guide.sections.find(s => s.id === ABOUT_SECTION);
    const manual = guide.sections.filter(s => s.id !== ABOUT_SECTION);
    const files = {};
    files['index.html'] = page({
        title: "Members' guide — BeanPool",
        description: 'How BeanPool works, the rules, common questions, and a how-to for every part of the app. For members of a BeanPool community.',
        body: [
            `        <p class="kicker">For members</p>`,
            `        <h1>Members' guide</h1>`,
            `        <p class="lede">For people who already belong to a BeanPool community. New here? Start on the <a href="../index.html">home page</a>. Running a community's server? ${operators}</p>`,
            `        <nav class="guide-toc" aria-label="Contents">`,
            `            <h2>Contents</h2>`,
            `            <ul>`,
            ...guide.sections.map(s => `                <li><a href="#${s.id}">${inline(s.title)}</a></li>`),
            `            </ul>`,
            `        </nav>`,
            `        <h2 id="${about.id}">${inline(about.title)}</h2>`,
            `        <p>${inline(about.summary)}</p>`,
            `        <ul class="guide-list">`,
            ...about.slugs.map(slug => linkItem(bySlug.get(slug))),
            `        </ul>`,
            `        <h2 class="guide-manual">How to use the app</h2>`,
            ...manual.flatMap(s => [
                `        <h3 id="${s.id}">${inline(s.title)}</h3>`,
                `        <p>${inline(s.summary)}</p>`,
                `        <ul class="guide-list">`,
                ...s.slugs.map(slug => linkItem(bySlug.get(slug))),
                `        </ul>`,
            ]),
            foot,
        ].join('\n'),
    });
    for (const g of guide.guides) {
        const section = guide.sections.find(s => s.id === g.section);
        const related = g.related.map(slug => bySlug.get(slug));
        files[`${g.slug}.html`] = page({
            title: `${g.title} — BeanPool members' guide`,
            description: g.summary,
            body: [
                `        <p class="kicker"><a href="index.html">Members' guide</a> · <a href="index.html#${section.id}">${inline(section.title)}</a></p>`,
                `        <h1>${inline(g.title)}</h1>`,
                `        <p class="lede">${inline(g.summary)}</p>`,
                ...g.blocks.map(b => `        ${blockHtml(b)}`),
                `        <h2 class="guide-related">Related</h2>`,
                `        <ul class="guide-list">`,
                ...related.map(linkItem),
                `        </ul>`,
                foot,
            ].join('\n'),
        });
    }
    files['guide.json'] = serializeGuide(guide);
    return files;
}

// ─── Language guides (slice S5b) ──────────────────────────────────────────────
// Translated pages live in content/<lang>/<section>/<slug>.md.

/**
 * Load all translated pages for a language, or null if the language has no translated pages yet.
 * Returns { schema, version, language, hash, sections, guides }.
 */
export function loadLanguagePages(contentDir, lang, englishGuide, { version = null } = {}) {
    const langDir = path.join(contentDir, lang);
    if (!fs.existsSync(langDir)) return null;
    const guides = [];
    const sections = [];
    let titles = null;
    const titlesFile = path.join(langDir, 'manifest.json');
    if (fs.existsSync(titlesFile)) {
        try { titles = JSON.parse(fs.readFileSync(titlesFile, 'utf8')); } catch { /* ignore */ }
    }
    for (const enSec of englishGuide.sections) {
        const secDir = path.join(langDir, enSec.id);
        if (!fs.existsSync(secDir)) continue;
        const slugs = [];
        for (const slug of enSec.slugs) {
            const mdFile = path.join(secDir, `${slug}.md`);
            if (!fs.existsSync(mdFile)) continue;
            const file = `${lang}/${enSec.id}/${slug}.md`;
            const g = parseGuideMarkdown(fs.readFileSync(mdFile, 'utf8'), file, { isTranslated: true });
            if (g.slug !== slug) throw new Error(`${file}: slug "${g.slug}" must match the file name`);
            const { blocks, video, related, ...head } = g;
            guides.push({ ...head, section: enSec.id, related, ...(video ? { video } : {}), blocks });
            slugs.push(slug);
        }
        if (slugs.length > 0) {
            const secTitles = titles?.sections?.[enSec.id];
            const title = (secTitles?.title?.text && secTitles.title.sourceHash === guideSourceHash(enSec.title))
                ? secTitles.title.text
                : enSec.title;
            const summary = (secTitles?.summary?.text && secTitles.summary.sourceHash === guideSourceHash(enSec.summary))
                ? secTitles.summary.text
                : enSec.summary;
            sections.push({ id: enSec.id, title, summary, slugs });
        }
    }
    if (guides.length === 0) return null;
    return {
        schema: GUIDE_SCHEMA,
        version,
        language: lang,
        hash: contentHash({ sections, guides }),
        sections,
        guides,
    };
}

/**
 * Check translated pages for one language. Returns an array of problem sentences.
 */
export function checkLanguagePages(contentDir, lang, englishGuide) {
    const problems = [];
    const langDir = path.join(contentDir, lang);
    if (!fs.existsSync(langDir)) return problems;
    const englishSections = new Map(englishGuide.sections.map(s => [s.id, s]));
    const englishPages = new Map(englishGuide.guides.map(p => [p.slug, p]));
    const entries = fs.readdirSync(langDir, { withFileTypes: true })
        .filter(d => !d.name.startsWith('.'));
    for (const entry of entries) {
        if (entry.isFile()) {
            if (entry.name !== 'manifest.json') {
                problems.push(`content/${lang}/${entry.name}: a language's folder holds only manifest.json and section folders for translated pages`);
            }
            continue;
        }
        if (!entry.isDirectory()) continue;
        const secId = entry.name;
        if (!englishSections.has(secId)) {
            problems.push(`content/${lang}/${secId}: "${secId}" is not a section in the guide`);
            continue;
        }
        const secDir = path.join(langDir, secId);
        const enSec = englishSections.get(secId);
        const files = fs.readdirSync(secDir, { withFileTypes: true }).filter(f => !f.name.startsWith('.'));
        for (const f of files) {
            if (!f.isFile() || !f.name.endsWith('.md')) {
                problems.push(`content/${lang}/${secId}/${f.name}: only .md files are allowed in section folders`);
                continue;
            }
            const slug = f.name.slice(0, -3);
            if (!enSec.slugs.includes(slug)) {
                problems.push(`content/${lang}/${secId}/${f.name}: "${slug}" is not a page in section "${secId}"`);
                continue;
            }
            const file = `content/${lang}/${secId}/${f.name}`;
            let parsed = null;
            try {
                parsed = parseGuideMarkdown(fs.readFileSync(path.join(secDir, f.name), 'utf8'), file, { isTranslated: true });
            } catch (e) {
                problems.push(e.message);
                continue;
            }
            if (parsed.slug !== slug) {
                problems.push(`${file}: slug "${parsed.slug}" must match the file name "${slug}"`);
            }
            if (!parsed.sourceHash) {
                problems.push(`${file}: front matter needs "source-hash"`);
            } else if (!/^[0-9a-f]{16}$/.test(parsed.sourceHash)) {
                problems.push(`${file}: "source-hash" must be 16 hex digits`);
            }
            for (const r of parsed.related) {
                if (!englishPages.has(r)) {
                    problems.push(`${file}: related page "${r}" does not exist in the guide`);
                }
            }
        }
    }
    return problems;
}

/**
 * Render the website pages for a language collection: guide.json and <slug>.html for each translated page.
 */
export function renderLanguageWebsite(langGuide, englishGuide) {
    const files = {};
    const root = '../../';
    const lang = langGuide.language ?? 'en';
    const nav = `<a href="../index.html">Members' guide</a>`;
    const foot = `        <p class="guide-foot">The same guide is in the BeanPool app, and works there without a connection: open Settings, then "Help &amp; how it works" under BeanPool. Every other rule, guide and manual is in the <a href="../../help.html">Help Centre</a>. Guide version ${langGuide.version}.</p>`;
    const englishBySlug = new Map(englishGuide.guides.map(g => [g.slug, g]));
    const langBySlug = new Map(langGuide.guides.map(g => [g.slug, g]));

    for (const g of langGuide.guides) {
        const enPage = englishBySlug.get(g.slug);
        const enHash = enPage ? guideBodyHash(enPage) : null;
        const isBehind = g.sourceHash && enHash && g.sourceHash !== enHash;
        const section = langGuide.sections.find(s => s.id === g.section) ?? englishGuide.sections.find(s => s.id === g.section);
        const relatedItems = g.related.map(slug => {
            const relLang = langBySlug.get(slug);
            if (relLang) return `            <li><a href="${relLang.slug}.html"><strong>${inline(relLang.title)}</strong><span>${inline(relLang.summary)}</span></a></li>`;
            const relEn = englishBySlug.get(slug);
            if (relEn) return `            <li><a href="../${relEn.slug}.html"><strong>${inline(relEn.title)}</strong><span>${inline(relEn.summary)}</span></a></li>`;
            return '';
        }).filter(Boolean);

        const staleNote = isBehind
            ? `        <p class="guide-stale-note">This page is newer in English.</p>`
            : '';

        files[`${g.slug}.html`] = page({
            root, nav, lang, source: `content/${lang}`,
            title: `${g.title} — BeanPool members' guide`,
            description: g.summary,
            body: [
                `        <p class="kicker"><a href="../index.html">Members' guide</a> · <a href="../index.html#${section?.id ?? ''}">${inline(section?.title ?? '')}</a></p>`,
                `        <h1>${inline(g.title)}</h1>`,
                `        <p class="lede">${inline(g.summary)}</p>`,
                ...(staleNote ? [staleNote] : []),
                ...g.blocks.map(b => `        ${blockHtml(b)}`),
                ...(relatedItems.length ? [
                    `        <h2 class="guide-related">Related</h2>`,
                    `        <ul class="guide-list">`,
                    ...relatedItems,
                    `        </ul>`,
                ] : []),
                foot,
            ].join('\n'),
        });
    }
    files['guide.json'] = serializeGuide(langGuide);
    return files;
}

// ─── The operator manual ───────────────────────────────────────────────────────
// For the owners and admins who run a community's server. The same block model and the same checks as the members'
// guide, in a separate collection (operators/) with its own version: the node's Settings bundles operators.json. The
// website copy under /guide/operators/ holds only the pages scripts/build.mjs lists (OPERATOR_PAGES_ON_WEBSITE); the
// rest waits until the security weak spots it describes are fixed (Marty, 2026-09-19; first-time setup published
// 2026-10-13). It is not in the members' guide.json, so the member apps neither carry it nor find it in their search.

/**
 * Every file of the website's copy (apps/website/guide/operators/), keyed by file name: the whole manual, or with
 * `only` (page slugs) just those pages. Then there is no index and no operators.json, and a page names an unpublished
 * page without linking it. The pictures are not here: scripts/build.mjs copies the ones these pages show.
 */
export function renderOperatorsWebsite(manual, { only = null } = {}) {
    const root = '../../';
    const published = slug => !only || only.includes(slug);
    const nav = only
        ? `<a href="../index.html">Members' guide</a>`
        : `<a href="index.html">Operator manual</a>
                <a href="../index.html">Members' guide</a>`;
    const where = `on your community's server, matching the version it runs: sign in to Settings (your server's address followed by /settings) and press Manual, or the ? beside a screen's title`;
    const foot = only
        ? `        <p class="guide-foot">The whole manual is ${where}. Only this part of it is on the website. Manual version ${manual.version}.</p>`
        : `        <p class="guide-foot">The same manual is ${where}. Manual version ${manual.version}.</p>`;
    const bySlug = new Map(manual.guides.map(g => [g.slug, g]));
    for (const slug of only ?? []) if (!bySlug.has(slug)) throw new Error(`the operator manual has no page "${slug}" to publish`);
    const unlinkedItem = g => `            <li><strong>${inline(g.title)}</strong> (in Settings, under Manual)</li>`;
    const relatedItem = g => (published(g.slug) ? linkItem(g) : unlinkedItem(g));
    const files = {};
    if (!only) files['index.html'] = page({
        root, nav,
        title: 'Operator manual — BeanPool',
        description: "How to run a BeanPool community's server: setting up, signing in, roles, members, moderation, disputes, backups, updates and troubleshooting. For owners and admins.",
        body: [
            `        <p class="kicker">For owners and admins</p>`,
            `        <h1>Operator manual</h1>`,
            `        <p class="lede">For the people who run a BeanPool community's server. Members want the <a href="../index.html">members' guide</a> instead.</p>`,
            `        <nav class="guide-toc" aria-label="Contents">`,
            `            <h2>Contents</h2>`,
            `            <ul>`,
            ...manual.sections.map(s => `                <li><a href="#${s.id}">${inline(s.title)}</a></li>`),
            `            </ul>`,
            `        </nav>`,
            ...manual.sections.flatMap(s => [
                `        <h2 id="${s.id}">${inline(s.title)}</h2>`,
                `        <p>${inline(s.summary)}</p>`,
                `        <ul class="guide-list">`,
                ...s.slugs.map(slug => linkItem(bySlug.get(slug))),
                `        </ul>`,
            ]),
            foot,
        ].join('\n'),
    });
    for (const g of manual.guides.filter(p => published(p.slug))) {
        const section = manual.sections.find(s => s.id === g.section);
        const kicker = only
            ? `Operator manual · ${inline(section.title)}`
            : `<a href="index.html">Operator manual</a> · <a href="index.html#${section.id}">${inline(section.title)}</a>`;
        files[`${g.slug}.html`] = page({
            root, nav,
            title: `${g.title} — BeanPool operator manual`,
            description: g.summary,
            body: [
                `        <p class="kicker">${kicker}</p>`,
                `        <h1>${inline(g.title)}</h1>`,
                `        <p class="lede">${inline(g.summary)}</p>`,
                ...g.blocks.map(b => `        ${blockHtml(b, published)}`),
                `        <h2 class="guide-related">Related</h2>`,
                `        <ul class="guide-list">`,
                ...g.related.map(slug => relatedItem(bySlug.get(slug))),
                `        </ul>`,
                foot,
            ].join('\n'),
        });
    }
    if (!only) files['operators.json'] = serializeGuide(manual);
    return files;
}
