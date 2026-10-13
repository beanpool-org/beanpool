// No page of ours asks Google for a font. Every web page in apps/ (the web app, node Settings, the old Settings page,
// the website and its guide, the registrar's admin) draws its fonts from files served with it, so no visitor's address
// goes to Google, the web app works on a node with no internet, and a self-hosted node needs no outside service for its
// text. A Google Fonts address anywhere under apps/ or packages/ fails here, and so does a font file that is named but
// missing, a font set without its licence, or a document policy that lets a font host back in.
//
//   node --test scripts/no-google-fonts.test.mjs
//
// NO_GOOGLE_FONTS_ROOT points it at another tree (an archive of origin/main, for the fail-first run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.NO_GOOGLE_FONTS_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

const GOOGLE_FONTS = /fonts\.(googleapis|gstatic)\.com/;

/** Build output, installed packages and native projects: nothing in them is ours to serve. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.expo', '.turbo', '.gradle', 'Pods', '.wrangler']);
const SKIP_PATHS = new Set(['apps/server/public', 'apps/native/android', 'apps/native/ios']);
const TEXT = /\.(html?|css|m?js|cjs|tsx?|jsx|json|md|toml|ya?ml|txt|svg|webmanifest)$/;

/**
 * The one mention that is not ours: YouTube's own player, inside the app's embed, loads Roboto from Google, and the
 * test pins that the embed lets it. No page of ours names the host.
 */
const ALLOWED = new Map([['apps/native/utils/__tests__/youtube-embed.test.ts', 1]]);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name) && !SKIP_PATHS.has(rel)) walk(abs, out);
        } else if (entry.isFile() && TEXT.test(entry.name)) {
            out.push(rel);
        }
    }
    return out;
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('no Google Fonts address anywhere in apps/ or packages/', () => {
    const files = [...walk(path.join(ROOT, 'apps')), ...walk(path.join(ROOT, 'packages'))];
    assert.ok(files.length > 500, `walked only ${files.length} files: is NO_GOOGLE_FONTS_ROOT right?`);
    const found = [];
    for (const rel of files) {
        const lines = read(rel).split('\n');
        const hits = lines.map((l, i) => (GOOGLE_FONTS.test(l) ? i + 1 : 0)).filter(Boolean);
        if (hits.length && hits.length !== ALLOWED.get(rel)) found.push(`${rel}:${hits.join(',')}`);
    }
    assert.deepEqual(found, [], `Google Fonts is named in:\n  ${found.join('\n  ')}\nServe the font from the app itself (apps/pwa/public/fonts, apps/website/fonts).`);
});

/** Each url(...) a stylesheet names, resolved against where the browser would look for it. */
function fontFiles(cssRel, servedFrom) {
    const faces = [...read(cssRel).matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(faces.length > 0, `${cssRel} names no font`);
    const urls = faces.map((f) => {
        const src = [...f.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/["']/g, ''));
        assert.equal(src.length, 1, `${cssRel}: one file per @font-face`);
        assert.match(f, /font-display: swap;/, `${cssRel}: every face swaps in, never holds the text`);
        return src[0];
    });
    return urls.map((u) => (u.startsWith('/') ? path.join(servedFrom, u) : path.join(path.dirname(cssRel), u)));
}

test("the web app's Inter is the node's own files, with the licence", () => {
    // src/index.css is bundled; its /fonts/ addresses are public/fonts, which the build copies to the node's public/.
    const files = [...fontFiles('apps/pwa/src/index.css', 'apps/pwa/public'), ...fontFiles('apps/pwa/public/fonts/inter.css', 'apps/pwa/public')];
    for (const f of files) {
        assert.match(f, /\.woff2$/);
        assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is named but missing`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'apps/pwa/public/fonts/OFL.txt')), "Inter's licence (OFL.txt) ships with it");
    assert.match(read('apps/server/static/settings.html'), /href="\/fonts\/inter\.css"/, 'the old Settings page uses the same files');
});

test("the website's Inter and Outfit are its own files, with their licences", () => {
    for (const f of fontFiles('apps/website/fonts/fonts.css', 'apps/website')) {
        assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is named but missing`);
    }
    for (const l of ['Inter-OFL.txt', 'Outfit-OFL.txt']) assert.ok(fs.existsSync(path.join(ROOT, 'apps/website/fonts', l)), `${l} ships with the fonts`);
    const pages = fs.readdirSync(path.join(ROOT, 'apps/website')).filter((f) => f.endsWith('.html'));
    for (const p of pages) assert.match(read(`apps/website/${p}`), /href="fonts\/fonts\.css"/, `${p} links the website's own fonts`);
    assert.match(read('packages/beanpool-guide/src/guide.mjs'), /href="\$\{root\}fonts\/fonts\.css"/, 'the guide pages link them too');
});

test("the node's document policies let fonts come from the node only", () => {
    const src = read('apps/server/src/app-document-csp.ts');
    const fontSrc = [...src.matchAll(/font-src ('[^;"]*)/g)].map((m) => m[1].trim());
    assert.equal(fontSrc.length, 2, 'APP_DOCUMENT_CSP and DOCUMENT_CSP each have a font-src');
    for (const f of fontSrc) assert.equal(f, "'self'");
});
