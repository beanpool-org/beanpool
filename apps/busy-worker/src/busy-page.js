// The busy page itself: one self-contained HTML document, in the visitor's language when it is one of the website's 25.
//
// Self-contained: the styles are inline, there is no script, no font file, no image and no icon file, and the response's
// Content-Security-Policy (src/index.js) forbids loading anything, so a visitor's browser makes no request for this page
// beyond the page itself (the empty data: icon stops the browser asking the struggling node for /favicon.ico).
//
// The look is BeanPool's: the colours are roles from the brand library (packages/beanpool-core/src/brand-colours.ts),
// each named in the comment after it; test/busy-worker.test.js fails when one drifts from the library or a pair of words
// on its ground reads under 4.5:1. Dark by default, as beanpool.org is; light when the visitor's device is set to light.
// No fixed widths: the card is the screen's width up to 32rem, and the words wrap, so it holds at 320 px with 130 % text.

import WORDS from './words.json' with { type: 'json' };

/** The website's 25 languages (scripts/website-build.mjs LANGS), in the order words.json lists them. */
export const LANGUAGES = Object.freeze(Object.keys(WORDS).filter((key) => !key.startsWith('_')));

/** Languages written right to left (scripts/website-build.mjs RTL_LANGS). */
export const RTL_LANGUAGES = Object.freeze(['ar', 'fa', 'ur']);

const SITE = 'https://beanpool.org';

/** The language this tag names, or null: `fr-CA` is fr, `zh-TW` and `zh-Hant-*` are zh-Hant, other zh is zh-Hans, `tl` is fil. */
function languageOf(tag) {
    const parts = tag.toLowerCase().split('-');
    const primary = parts[0];
    if (primary === 'zh') {
        return parts.includes('hant') || parts.includes('tw') || parts.includes('hk') || parts.includes('mo') ? 'zh-Hant' : 'zh-Hans';
    }
    if (primary === 'tl') return 'fil';
    return LANGUAGES.find((lang) => lang.toLowerCase() === primary) ?? null;
}

/** The visitor's best language of ours from an Accept-Language header (q-values honoured); English when none fits. */
export function pickLanguage(header) {
    if (!header) return 'en';
    const tags = String(header)
        .slice(0, 1024)
        .split(',')
        .map((part, index) => {
            const [tag, ...params] = part.trim().split(';');
            let q = 1;
            for (const param of params) {
                const [key, value] = param.trim().split('=');
                if (key?.trim().toLowerCase() === 'q') q = Number(value);
            }
            return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
        })
        .filter(({ tag, q }) => tag !== '' && tag !== '*' && q > 0)
        .sort((a, b) => b.q - a.q || a.index - b.index);
    for (const { tag } of tags) {
        const lang = languageOf(tag);
        if (lang) return lang;
    }
    return 'en';
}

/** The website's page for this language: English at the site's root, the others under /<lang>/ (every one exists). */
export function siteLinks(lang) {
    const base = lang === 'en' ? SITE : `${SITE}/${lang}`;
    return { start: `${base}/start`, find: `${base}/#find-or-start` };
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Dark first (beanpool.org's own default), light for a device set to light. Each colour names its brand-library role:
// `ground` is one of the web app's grounds (WEB_INK_GROUNDS), any other is a path in BRAND_COLOURS, read in that theme.
export const STYLE = `
:root {
    color-scheme: dark light;
    --page: #1d231d; /* ground */
    --card: #2a322a; /* ground */
    --heading: #ffffff; /* cta.on */
    --text: #c0ccc0; /* ink.accent */
    --cta: #b85236; /* cta.fill */
    --cta-hover: #a3472e; /* cta.hover */
    --on-cta: #ffffff; /* cta.on */
    --second: #c0ccc0; /* ink.accent */
    --note-tint: #022c22; /* chip.ok.tint */
    --note-ink: #6ee7b7; /* chip.ok.ink */
    --muted: #c0ccc0; /* ink.accent */
}
@media (prefers-color-scheme: light) {
    :root {
        --page: #f6f4f0; /* ground */
        --card: #ffffff; /* ground */
        --heading: #1d231d; /* gold.on */
        --text: #1d231d; /* gold.on */
        --cta: #b85236; /* cta.fill */
        --cta-hover: #a3472e; /* cta.hover */
        --on-cta: #ffffff; /* cta.on */
        --second: #5b6b5b; /* ink.accent */
        --note-tint: #d1fae5; /* chip.ok.tint */
        --note-ink: #065f46; /* chip.ok.ink */
        --muted: #5b6b5b; /* ink.accent */
    }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: var(--page);
    color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
    font-size: 1rem;
    line-height: 1.5;
}
main {
    width: 100%;
    max-width: 32rem;
    background: var(--card);
    border-radius: 1rem;
    padding: 1.5rem 1.25rem;
    overflow-wrap: anywhere;
}
.mark { margin: 0 0 0.75rem; font-weight: 700; color: var(--heading); }
h1 { margin: 0 0 0.75rem; font-size: 1.5rem; line-height: 1.3; color: var(--heading); }
p { margin: 0 0 1rem; }
.ways { display: flex; flex-direction: column; gap: 0.75rem; margin: 1.25rem 0; }
.ways a {
    display: block;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    font-weight: 600;
    text-align: center;
    text-decoration: none;
}
.ways .start { background: var(--cta); color: var(--on-cta); }
.ways .start:hover { background: var(--cta-hover); }
.ways .find { border: 2px solid var(--second); color: var(--second); }
.ways a:focus-visible { outline: 3px solid var(--heading); outline-offset: 2px; }
.apps { background: var(--note-tint); color: var(--note-ink); padding: 0.75rem 1rem; border-radius: 0.75rem; }
.draft { margin: 0; font-size: 0.875rem; color: var(--muted); }
`;

/** The busy page in the visitor's language: `{ html, lang }`. */
export function busyPage(acceptLanguage) {
    const lang = pickLanguage(acceptLanguage);
    const w = WORDS[lang];
    const links = siteLinks(lang);
    const dir = RTL_LANGUAGES.includes(lang) ? 'rtl' : 'ltr';
    const draft = w.machine ? `\n<p class="draft">${escapeHtml(w.machine)}</p>` : '';
    const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>${escapeHtml(w.heading)} · BeanPool</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="mark">BeanPool</p>
<h1>${escapeHtml(w.heading)}</h1>
<p>${escapeHtml(w.body)}</p>
<div class="ways">
<a class="start" href="${links.start}">${escapeHtml(w.start)}</a>
<a class="find" href="${links.find}">${escapeHtml(w.find)}</a>
</div>
<p class="apps">${escapeHtml(w.apps)}</p>${draft}
</main>
</body>
</html>
`;
    return { html, lang };
}
