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

function fail(file, line, message) {
    throw new Error(`${file}${line ? `:${line}` : ''}: ${message}`);
}

function checkInline(file, line, text) {
    if ((text.match(/\*\*/g) || []).length % 2 !== 0) fail(file, line, 'unbalanced ** (bold)');
    if (/\[[^\]]*\]\([^)]*\)/.test(text)) fail(file, line, 'links are not supported; the app shows plain text');
    if (/<[a-zA-Z/!]/.test(text)) fail(file, line, 'HTML is not supported');
    if (/(^|[^*])\*([^*]|$)/.test(text) || /(^|\W)_[^_]+_(\W|$)/.test(text)) fail(file, line, 'only **bold** is supported');
    if (/`/.test(text)) fail(file, line, 'code spans are not supported');
}

/** Parse one guide file. `file` is only used in error messages. */
export function parseGuideMarkdown(source, file = 'guide.md') {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '---') fail(file, 1, 'must start with front matter (---)');
    const meta = {};
    let i = 1;
    for (; i < lines.length && lines[i] !== '---'; i++) {
        const m = /^([a-z]+):\s*(.+)$/.exec(lines[i]);
        if (!m) fail(file, i + 1, 'front matter lines are "key: value"');
        meta[m[1]] = m[2].trim();
    }
    if (i >= lines.length) fail(file, null, 'front matter is not closed with ---');
    for (const key of ['slug', 'title', 'summary', 'related']) {
        if (!meta[key]) fail(file, null, `front matter needs "${key}"`);
    }
    for (const key of Object.keys(meta)) {
        if (!['slug', 'title', 'summary', 'related', 'video'].includes(key)) fail(file, null, `unknown front matter "${key}"`);
    }
    if (!SLUG_RE.test(meta.slug)) fail(file, null, `slug "${meta.slug}" must be lowercase letters, digits and dashes`);
    checkInline(file, null, meta.title);
    checkInline(file, null, meta.summary);
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
        if (line.startsWith('- ')) {
            if (para) flush();
            const item = line.slice(2).trim();
            checkInline(file, n, item);
            (list ??= []).push(item);
            continue;
        }
        if (/^(\d+[.)]\s|[*+]\s|>|\||```)/.test(line)) fail(file, n, 'only "- " bullets, ## headings and paragraphs are supported');
        if (list) fail(file, n, 'a bullet is one line; leave a blank line after a list');
        checkInline(file, n, line);
        (para ??= []).push(line.trim());
    }
    flush();
    if (blocks.length === 0) fail(file, null, 'has no content');
    const page = { slug: meta.slug, title: meta.title, summary: meta.summary, related };
    if (meta.video) page.video = meta.video;
    page.blocks = blocks;
    return page;
}

/** Hash of the guide text only (not the version), so a content change without a version bump is caught. */
export function contentHash(content) {
    return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * Read content/manifest.json and every page it lists. Each section is a folder, content/<section id>/, holding
 * exactly the pages the manifest lists for it, one file per page named <slug>.md. The operator manual
 * (operators/) is read the same way with `aboutSection: null`: it has no section of concept guides.
 */
export function loadGuide(contentDir, { aboutSection = ABOUT_SECTION } = {}) {
    const manifest = JSON.parse(fs.readFileSync(path.join(contentDir, 'manifest.json'), 'utf8'));
    if (!Number.isInteger(manifest.version) || manifest.version < 1) throw new Error('manifest.json: "version" must be a whole number, 1 or more');
    if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) throw new Error('manifest.json: "sections" lists the sections');
    const folders = fs.readdirSync(contentDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
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
            const g = parseGuideMarkdown(fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8'), file);
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
    }
    return { schema: GUIDE_SCHEMA, version: manifest.version, hash: contentHash({ sections, guides }), sections, guides };
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

function blockHtml(b) {
    if (b.type === 'h2') return `<h2>${inline(b.text)}</h2>`;
    if (b.type === 'h3') return `<h3>${inline(b.text)}</h3>`;
    if (b.type === 'p') return `<p>${inline(b.text)}</p>`;
    return `<ul>\n${b.items.map(it => `            <li>${inline(it)}</li>`).join('\n')}\n        </ul>`;
}

function page({ title, description, body, root = '../', nav = `<a href="index.html">Members' guide</a>` }) {
    return `<!DOCTYPE html>
<!-- Generated from packages/beanpool-guide/${root === '../' ? 'content' : 'operators'} by packages/beanpool-guide/scripts/build.mjs. Do not edit by hand. -->
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <link rel="icon" type="image/png" href="${root}favicon.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Outfit:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
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

// ─── The operator manual ───────────────────────────────────────────────────────
// For the owners and admins who run a community's server. The same block model and the same checks as the members'
// guide, in a separate collection (operators/) with its own version: the node's Settings bundles operators.json. The
// website copy under /guide/operators/ is rendered here but not written: scripts/build.mjs has it switched off
// (PUBLISH_OPERATORS_WEBSITE, Marty's decision 2026-09-19). It is not in the members' guide.json, so the member apps
// neither carry it nor find it in their search.

/** Every file of the website's copy (apps/website/guide/operators/, when published), keyed by file name. */
export function renderOperatorsWebsite(manual) {
    const root = '../../';
    const nav = `<a href="index.html">Operator manual</a>
                <a href="../index.html">Members' guide</a>`;
    const foot = `        <p class="guide-foot">The same manual is on your community's server, matching the version it runs: sign in to Settings (your server's address followed by /settings) and press Manual, or the ? beside a screen's title. Manual version ${manual.version}.</p>`;
    const bySlug = new Map(manual.guides.map(g => [g.slug, g]));
    const files = {};
    files['index.html'] = page({
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
    for (const g of manual.guides) {
        const section = manual.sections.find(s => s.id === g.section);
        files[`${g.slug}.html`] = page({
            root, nav,
            title: `${g.title} — BeanPool operator manual`,
            description: g.summary,
            body: [
                `        <p class="kicker"><a href="index.html">Operator manual</a> · <a href="index.html#${section.id}">${inline(section.title)}</a></p>`,
                `        <h1>${inline(g.title)}</h1>`,
                `        <p class="lede">${inline(g.summary)}</p>`,
                ...g.blocks.map(b => `        ${blockHtml(b)}`),
                `        <h2 class="guide-related">Related</h2>`,
                `        <ul class="guide-list">`,
                ...g.related.map(slug => linkItem(bySlug.get(slug))),
                `        </ul>`,
                foot,
            ].join('\n'),
        });
    }
    files['operators.json'] = serializeGuide(manual);
    return files;
}
