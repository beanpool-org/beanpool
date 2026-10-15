// The website's colours come from two sets in apps/website/style.css, and the light one from the brand library.
//
// beanpool.org follows the visitor's light or dark setting (Marty, 15 Oct 2026). Its stylesheet holds every colour the
// site draws as a variable, in two sets: dark (`:root`, the site as it always looked) and light (the
// `prefers-color-scheme: light` block). This fails when:
//   - a colour is written anywhere else: another rule of style.css, a page (the site's own or the generated guide), or
//     main.js — except the App Store and Google Play badges (their makers' artwork), Leaflet's circle option, and the
//     base body rule's doodle washes (a var() there would void its -webkit-image-set fallback on old Android WebViews);
//   - a light value does not name its role in packages/beanpool-core/src/brand-colours.ts (`/* ink.warning */`, or
//     `/* ground */` for one of the web's light grounds in INK_GROUNDS), or differs from that role's value;
//   - a dark value that names a role differs from it;
//   - the light set changes a variable the dark set does not have.
//
//   node --test scripts/website-colours.test.mjs      (reads @beanpool/core's dist: build core first)
//
// WEBSITE_ROOT points it at another copy of apps/website (an archive of origin/main, for a fail-first run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(process.env.WEBSITE_ROOT ?? path.join(ROOT, 'apps/website'));
const CORE = path.join(ROOT, 'packages/beanpool-core/dist/brand-colours.js');
if (!fs.existsSync(CORE)) throw new Error(`${CORE} is missing: build @beanpool/core first (pnpm --filter @beanpool/core build)`);
const { brandColours, INK_GROUNDS } = await import(pathToFileURL(CORE).href);

const CSS = fs.readFileSync(path.join(SITE, 'style.css'), 'utf8');
const COLOUR = /(?<![&\w-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\(\s*\d/g;

/** The text from `open` (an index of `{`'s line start) to its matching `}`. */
function block(css, at) {
    assert.ok(at >= 0, 'block not found');
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
        if (css[i] === '{') depth++;
        if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
    }
    throw new Error('unbalanced braces');
}
const DARK = block(CSS, CSS.indexOf(':root {'));
const LIGHT_MEDIA = block(CSS, CSS.indexOf('@media (prefers-color-scheme: light)'));
const LIGHT = block(LIGHT_MEDIA, LIGHT_MEDIA.indexOf(':root {'));

/** `--name: value; /* comment *\/` → { name, value, tag } (tag: `ground` or a dotted library path, else null). */
function declarations(css) {
    const out = [];
    for (const m of css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);[ \t]*(?:\/\*\s*([^*]*?)\s*\*\/)?/gm)) {
        const tag = m[3]?.match(/^(ground|[a-z]+(?:\.[a-z]+)+)\b/)?.[1] ?? null;
        out.push({ name: m[1], value: m[2].trim(), tag });
    }
    return out;
}
const isColour = (value) => /^#[0-9a-fA-F]{3,8}$|^rgba?\(|^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(value);

/** The `#rrggbb` a value paints (alpha dropped): `#ABC123`, `rgba(1, 2, 3, 0.5)` or a bare `1, 2, 3` triplet. */
function rgbHex(value) {
    if (value.startsWith('#')) return value.toLowerCase();
    const [r, g, b] = value.replace(/^rgba?\(|\)$/g, '').split(',').map((v) => Number(v.trim()));
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** A tag's value in the library for `theme`: `ink.warning`, or `accent.fill.dark` for the other theme's value. */
function libraryValue(tag, theme) {
    const parts = tag.split('.');
    if (parts.at(-1) === 'dark' || parts.at(-1) === 'light') theme = parts.pop();
    let node = brandColours(theme);
    for (const p of parts) node = node?.[p];
    return typeof node === 'string' ? node.toLowerCase() : undefined;
}

function checkTags(decls, theme) {
    const wrong = [];
    for (const d of decls.filter((x) => x.tag && isColour(x.value))) {
        const hex = rgbHex(d.value);
        if (d.tag === 'ground') {
            if (!INK_GROUNDS[theme].includes(hex)) wrong.push(`${d.name}: ${d.value} is tagged ground but is not one of INK_GROUNDS.${theme}`);
        } else {
            const want = libraryValue(d.tag, theme);
            if (want === undefined) wrong.push(`${d.name}: ${d.tag} is not a role in brand-colours.ts`);
            else if (want !== hex) wrong.push(`${d.name}: ${d.value} drifted from ${d.tag} (${want} in the library)`);
        }
    }
    return wrong;
}

test('the light set takes every value from the brand library, by role', () => {
    const decls = declarations(LIGHT).filter((d) => isColour(d.value));
    assert.ok(decls.length >= 30, `the light set has ${decls.length} colours`);
    const untagged = decls.filter((d) => !d.tag).map((d) => `${d.name}: ${d.value}`);
    assert.deepEqual(untagged, [], 'every light colour names its role in brand-colours.ts (or `ground`)');
    assert.deepEqual(checkTags(decls, 'light'), []);
});

test('a dark value that names a library role matches it', () => {
    const tagged = declarations(DARK).filter((d) => d.tag && isColour(d.value));
    assert.ok(tagged.length >= 3, 'the dark set names the roles it shares with the library');
    assert.deepEqual(checkTags(tagged, 'dark'), []);
});

test('the light set only changes variables the dark set defines', () => {
    const dark = new Set(declarations(DARK).map((d) => d.name));
    assert.deepEqual(declarations(LIGHT).map((d) => d.name).filter((n) => !dark.has(n)), []);
});

test('style.css writes no colour outside the two sets', () => {
    let rest = CSS.replace(DARK, '').replace(LIGHT_MEDIA, '');
    // The base body rule's doodle: its two background-image declarations keep their washes literal (see above).
    const bodyAt = rest.search(/\nbody \{/);
    const body = block(rest, bodyAt + 1);
    assert.match(body, /pattern-dark\.webp/);
    rest = rest.replace(body, body.replace(/background-image:[^;]+;/g, ''));
    const left = rest.split('\n').filter((line) => line.match(COLOUR)).map((line) => line.trim());
    assert.deepEqual(left, []);
});

test('no page and no script of the site names a colour of its own', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const abs = path.join(dir, e.name);
        return e.isDirectory() ? walk(abs) : /\.(html|js)$/.test(e.name) ? [abs] : [];
    });
    const files = [...fs.readdirSync(SITE).filter((f) => /\.(html|js)$/.test(f)).map((f) => path.join(SITE, f)), ...walk(path.join(SITE, 'guide'))];
    assert.ok(files.length > 50, `${files.length} files`);
    const found = [];
    for (const file of files) {
        const rel = path.relative(SITE, file);
        let text = fs.readFileSync(file, 'utf8').replace(/\b(href|xlink:href)="#[^"]*"/g, '');
        // The store badges are Apple's and Google's own artwork, drawn the same in both themes.
        if (rel === 'index.html') text = text.replace(/<a [^>]*class="(?:hero-)?store-badge"[\s\S]*?<\/a>/g, (badge) => badge.replace(/[^\n]/g, ''));
        // Leaflet draws a community's circle from these options (an SVG attribute: no var() there); gold.fill.
        if (rel === 'main.js') text = text.replace(/^\s*(color|fillColor): '#f59e0b',$/gm, '');
        text.split('\n').forEach((line, i) => { if (line.match(COLOUR)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`); });
    }
    assert.deepEqual(found, []);
});

test('the pages that keep their own look are the sign-in hand-offs, which do not load style.css', () => {
    const auth = fs.readdirSync(path.join(SITE, 'auth')).filter((f) => f.endsWith('.html'));
    for (const f of auth) assert.doesNotMatch(fs.readFileSync(path.join(SITE, 'auth', f), 'utf8'), /style\.css/, `auth/${f}`);
});

test('both doodles the stylesheet names are served', () => {
    for (const m of CSS.matchAll(/url\('([^']+\.webp)'\)/g)) assert.ok(fs.existsSync(path.join(SITE, m[1])), m[1]);
    assert.match(LIGHT_MEDIA, /pattern-light\.webp/);
});
