// beanpool.org/android (apps/website/android.html and its 24 language copies): the direct APK download, front doors S5
// (scratch/fable-design/DESIGN-entry-points-fable.md §4.4). The APK is the Google-signed universal APK of a release,
// which the director publishes as a GitHub Release asset, tag android-v<version> (Marty, 27 Oct 2026). This fails when:
//   - apps/website-src/android-apk.json is not one release (a version, its versionCode, the asset's size and digest), or
//     a page's download link, version, size, file name or digest is not that release's;
//   - a page prints a signing key other than the one the site already names as the app's (.well-known/assetlinks.json),
//     in either form (keytool's colon form, or apksigner's line);
//   - a release, which changes those values on every page at once, makes a translation stale; or masking them hides a
//     change of words;
//   - a page leaves out Google Play or the App Store as the other two ways, or the home page's web note or /global's
//     "No Google Play?" line does not lead to this page in the same language;
//   - drawn in headless Chromium at 320 px with text at 130 %, light and dark, in every language: the page is wider than
//     the screen, the download button is under 48 px or its words lose the button's own colour, the key and the command
//     do not read left to right, or /global's line is under 48 px.
// Every colour is also held to the site's tokens by scripts/website-colours.test.mjs, and the English page's words to
// 4.5:1 in both themes by scripts/website-contrast.mjs. No network.
//
//   node --test scripts/website-android.test.mjs   (needs: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium)
//
// WEBSITE_ROOT points it at another copy of apps/website (an archive of origin/main, for a fail-first run);
// ANDROID_SHOTS=<dir> keeps a 320 px screenshot of the English, Arabic and Tamil pages in each theme.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
    GUIDE_LANGS, LANGS, RTL_LANGS, readApkRelease, applyApkRelease, pageContentHash, renderTranslatedPage, extractSourceHash,
} from './website-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(process.env.WEBSITE_ROOT ?? path.join(ROOT, 'apps/website'));
const CONTENT = path.join(ROOT, 'apps/website-src/content');
const require = createRequire(path.join(ROOT, 'apps/pwa/package.json'));
const SHOTS = process.env.ANDROID_SHOTS;

const PLAY_ID = 'org.beanpool.pillar';
const APP_STORE_ID = 'id6761870086';
const pagePath = (lang, page) => path.join(SITE, lang === 'en' ? '' : lang, page);
const read = (lang, page) => fs.readFileSync(pagePath(lang, page), 'utf8');
/** The page without its comments, so nothing named in a comment counts. */
const markup = (lang, page) => read(lang, page).replace(/<!--[\s\S]*?-->/g, '');

/** The app's signing key as the site names it for Android App Links: the fingerprints for our package. */
function appLinksKeys() {
    const links = JSON.parse(fs.readFileSync(path.join(SITE, '.well-known/assetlinks.json'), 'utf8'));
    return links.filter((s) => s.target?.package_name === PLAY_ID).flatMap((s) => s.target.sha256_cert_fingerprints);
}

test('android-apk.json is one release: the GitHub asset of tag android-v<version>, its size and its digest', () => {
    const r = readApkRelease();
    assert.match(r.version, /^\d+\.\d+\.\d+$/);
    assert.equal(r.file, `BeanPool-${r.version}-${r.versionCode}.apk`);
    assert.equal(r.url, `https://github.com/beanpool-org/beanpool/releases/download/android-v${r.version}/${r.file}`);
    assert.equal(r.mb, String(Math.round(r.bytes / 1e6)));
    assert.match(r.sha256, /^[0-9a-f]{64}$/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-apk-'));
    try {
        const bad = (over) => {
            const file = path.join(dir, 'r.json');
            fs.writeFileSync(file, JSON.stringify({ version: '1.2.83', versionCode: 305, bytes: 165595593, sha256: 'a'.repeat(64), ...over }));
            return () => readApkRelease(file);
        };
        assert.doesNotThrow(bad({}));
        assert.throws(bad({ version: 'v1.2.83' }), /version/);
        assert.throws(bad({ version: '1.2' }), /version/);
        assert.throws(bad({ versionCode: '305' }), /versionCode/);
        assert.throws(bad({ bytes: 1.5 }), /bytes/);
        assert.throws(bad({ sha256: 'A'.repeat(64) }), /sha256/);
        assert.throws(bad({ sha256: 'sha256:' + 'a'.repeat(64) }), /sha256/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('every language has the page, with this release\'s link, version, size, file name and digest', () => {
    const r = readApkRelease();
    assert.equal(LANGS.length, 25);
    for (const lang of LANGS) {
        assert.ok(fs.existsSync(pagePath(lang, 'android.html')), `${lang}/android.html exists`);
        const html = markup(lang, 'android.html');
        const links = [...html.matchAll(/<a\b[^>]*\bdata-apk="url"[^>]*>/g)];
        assert.equal(links.length, 1, `${lang}: one download link`);
        assert.match(links[0][0], new RegExp(`href="${r.url.replace(/[.?]/g, '\\$&')}"`), `${lang}: the link is the release's asset`);
        assert.match(links[0][0], /class="btn btn-primary"/, `${lang}: the link is the page's button`);
        const values = (key) => [...html.matchAll(new RegExp(`<(?:span|code)\\b[^>]*\\bdata-apk="${key}"[^>]*>([^<]*)<`, 'g'))].map((m) => m[1]);
        assert.ok(values('version').length >= 2 && values('version').every((v) => v === r.version), `${lang}: the version is ${r.version}`);
        assert.deepEqual(values('mb'), [r.mb], `${lang}: the size`);
        assert.deepEqual(values('file'), [r.file], `${lang}: apksigner names the file`);
        assert.deepEqual(values('sha256'), [r.sha256], `${lang}: the file's digest`);
        assert.match(html, /<code class="apk-code" id="apk-command" dir="ltr">apksigner verify --print-certs <span data-apk="file">/, `${lang}: the apksigner line`);
    }
});

test('every page prints the key the site already names as the app\'s, in keytool\'s form and in apksigner\'s', () => {
    const keys = appLinksKeys();
    assert.ok(keys.length >= 1, 'assetlinks.json names a key for org.beanpool.pillar');
    for (const lang of LANGS) {
        const html = markup(lang, 'android.html');
        // It breaks between its pairs at 320 px (a <wbr> after each colon), and reads as one line anywhere wider.
        const key = html.match(/<code class="apk-code" id="apk-key" dir="ltr">((?:[^<]|<wbr>)*)<\/code>/)?.[1].replace(/<wbr>/g, '');
        assert.ok(key, `${lang}: the key is printed`);
        assert.match(key, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/, `${lang}: a SHA-256 fingerprint`);
        assert.ok(keys.includes(key), `${lang}: ${key} is a key assetlinks.json names`);
        const digest = html.match(/<code class="apk-code" id="apk-digest" dir="ltr">Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})<\/code>/)?.[1];
        assert.equal(digest, key.replace(/:/g, '').toLowerCase(), `${lang}: apksigner's line is the same key`);
    }
});

test('a release changes every page at once and leaves no translation stale; a change of words still does', () => {
    const r = readApkRelease();
    const next = { ...r, version: '9.8.7', versionCode: 999, file: 'BeanPool-9.8.7-999.apk', mb: '200', sha256: 'b'.repeat(64),
        url: 'https://github.com/beanpool-org/beanpool/releases/download/android-v9.8.7/BeanPool-9.8.7-999.apk' };
    const english = read('en', 'android.html');
    const bumped = applyApkRelease(english, next);
    assert.notEqual(bumped, english);
    assert.ok(!bumped.includes(r.url) && !bumped.includes(`>${r.version}<`) && !bumped.includes(r.sha256), 'nothing of the old release is left');
    assert.ok(bumped.includes(`href="${next.url}"`) && bumped.includes('>9.8.7<') && bumped.includes('>200<') && bumped.includes(next.sha256));
    assert.equal(pageContentHash(bumped), pageContentHash(english), 'a release is not a change of words');

    for (const lang of GUIDE_LANGS) {
        const src = fs.readFileSync(path.join(CONTENT, lang, 'android.html'), 'utf8');
        assert.equal(extractSourceHash(src), pageContentHash(english), `${lang}: the translation is of today's English`);
        assert.ok(!renderTranslatedPage(lang, 'android.html', src, bumped).includes('website-stale-banner'), `${lang}: not stale after a release`);
    }
    const reworded = english.replace('Most people should use', 'Nearly everyone should use');
    assert.notEqual(pageContentHash(reworded), pageContentHash(english), 'a change of words is still a change');
    const es = fs.readFileSync(path.join(CONTENT, 'es', 'android.html'), 'utf8');
    assert.ok(renderTranslatedPage('es', 'android.html', es, reworded).includes('website-stale-banner'), 'and makes the translation stale');
});

test('every page names Google Play and the App Store as the other two ways', () => {
    for (const lang of LANGS) {
        const html = markup(lang, 'android.html');
        const play = [...html.matchAll(/href="(https:\/\/play\.google\.com\/[^"]*)"/g)].map((m) => new URL(m[1].replace(/&amp;/g, '&')));
        assert.ok(play.length >= 1 && play.every((u) => u.pathname === '/store/apps/details' && u.searchParams.get('id') === PLAY_ID), `${lang}: Google Play's listing`);
        assert.ok(html.includes(`href="https://apps.apple.com/app/${APP_STORE_ID}"`), `${lang}: the App Store's listing`);
    }
});

test('when Android refuses the file, every page says what to do, with the app\'s own words for the buttons', () => {
    const r = readApkRelease();
    const html = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const lang of LANGS) {
        const page = markup(lang, 'android.html');
        const install = page.match(/<h2 id="install">[\s\S]*?(?=<h2 )/)?.[0] ?? '';
        const note = install.match(/<p id="not-installed">([\s\S]*?)<\/p>/)?.[1];
        assert.ok(note, `${lang}: "Install it" says what to do when Android refuses the file`);
        // A BeanPool newer than this file is kept; an older one under another key goes, after the 12 words are written down.
        assert.ok(note.includes(`<span data-apk="version">${r.version}</span>`), `${lang}: it names this release's version`);
        assert.match(note, /<a href="#words">/, `${lang}: it sends you to your 12 words first`);
        const words = lang === 'en' ? null : JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/native/words', `${lang}.json`), 'utf8'));
        for (const key of ['Already a Member? Restore Account', 'Recover with 12 Words']) {
            const shown = html(words ? words[key] : key);
            assert.ok(note.includes(`<strong>${shown}</strong>`), `${lang}: it names the app's button "${shown}"`);
        }
        const keep = page.match(/<h2 id="words">[\s\S]*?(?=<h2 )/)?.[0] ?? '';
        assert.match(keep, /<a href="#not-installed">/, `${lang}: "Keep your 12 words safe" names the one time to uninstall`);
    }
    // assetlinks.json names two keys for the app (Google Play's and the upload key), so the page speaks of this file's.
    assert.doesNotMatch(markup('en', 'android.html'), /signed with one key/);
});

test('the home page\'s web note and /global\'s "No Google Play?" line lead to this page, in the same language', () => {
    for (const lang of LANGS) {
        const home = markup(lang, 'index.html');
        const notes = [...home.matchAll(/<p class="hero-web-note">([\s\S]*?)<\/p>/g)].map((m) => m[1]);
        const note = notes.find((n) => n.includes('android'));
        assert.ok(note, `${lang}/index.html: the web note names the download`);
        assert.match(note, /<a href="android\.html">beanpool\.org\/android<\/a>/, `${lang}/index.html: it links this language's page`);
        if (lang === 'en') assert.doesNotMatch(note, /home screen/i, 'no "add them to your home screen": that makes a second icon');

        const global = markup(lang, 'global.html');
        const door = global.match(/<div class="hero-door" id="door-play">([\s\S]*?)<\/div>/)?.[1];
        assert.ok(door, `${lang}/global.html: the Google Play door`);
        assert.match(door, /<p class="global-apk"><a href="android\.html">[^<]+<\/a><\/p>/, `${lang}/global.html: the line is in the Google Play door, so an iPhone never sees it`);
    }
});

// ── In Chromium, at 320 px with text at 130 %, light and dark ─────────────────────────────────────────────────────────

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
let envPromise = null;
function env() {
    if (!envPromise) {
        envPromise = (async () => {
            const { chromium } = require('playwright');
            const server = http.createServer((req, res) => {
                let p = path.join(SITE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
                if (!p.startsWith(SITE)) { res.writeHead(403); res.end(); return; }
                if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
                if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
                res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
                fs.createReadStream(p).pipe(res);
            });
            await new Promise((r) => server.listen(0, '127.0.0.1', r));
            try {
                return { server, base: `http://127.0.0.1:${server.address().port}`, browser: await chromium.launch({ headless: true }) };
            } catch (err) {
                server.close();
                throw err;
            }
        })();
    }
    return envPromise;
}
after(async () => {
    if (!envPromise) return;
    const e = await envPromise.catch(() => null);
    if (!e) return;
    await e.browser.close();
    e.server.close();
});

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

/** Opens one page at 320 px in a theme (as an Android phone when `userAgent` is one), offline but for this site, text at 130 %. */
async function open(e, url, colorScheme, userAgent) {
    const context = await e.browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme, ...(userAgent ? { userAgent } : {}) });
    const page = await context.newPage();
    await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.fulfill({ status: 204, body: '' })));
    await page.goto(`${e.base}/${url}`, { waitUntil: 'load' });
    await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
    return { page, context };
}

for (const colorScheme of ['light', 'dark']) {
    test(`at 320 px, text at 130 %, ${colorScheme}: every language's page fits, its button is 48 px in its own colours, its key reads left to right`, { timeout: 180_000 }, async () => {
        const e = await env();
        const failures = [];
        for (const lang of LANGS) {
            const url = lang === 'en' ? 'android.html' : `${lang}/android.html`;
            const { page, context } = await open(e, url, colorScheme);
            const m = await page.evaluate(() => {
                const root = document.documentElement;
                const button = document.getElementById('apk-download');
                const b = button.getBoundingClientRect();
                const probe = document.createElement('span');
                probe.style.color = 'var(--on-accent)';
                document.body.appendChild(probe);
                const onAccent = getComputedStyle(probe).color;
                probe.remove();
                const wide = [...document.body.querySelectorAll('*')]
                    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > root.clientWidth + 0.5 || r.left < -0.5); })
                    .filter((el) => !el.closest('.lang-dropdown, .nav-menu-panel, details:not([open])'))
                    .slice(0, 3).map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')}`);
                const codes = [...document.querySelectorAll('.apk-code')].map((c) => getComputedStyle(c).direction);
                return { scrollW: root.scrollWidth, clientW: root.clientWidth, wide, buttonH: b.height, buttonColor: getComputedStyle(button).color, onAccent, codes, dir: getComputedStyle(document.body).direction };
            });
            if (m.scrollW > m.clientW) failures.push(`${url}: ${m.scrollW} px wide on a ${m.clientW} px screen (${m.wide.join(', ')})`);
            if (m.buttonH < 48) failures.push(`${url}: the download button is ${m.buttonH} px tall`);
            if (m.buttonColor !== m.onAccent) failures.push(`${url}: the button's words are ${m.buttonColor}, not the button's own ${m.onAccent}`);
            if (m.codes.length !== 4 || m.codes.some((d) => d !== 'ltr')) failures.push(`${url}: the key, the command and the digests read ${m.codes.join(', ')}`);
            if (RTL_LANGS.includes(lang) && m.dir !== 'rtl') failures.push(`${url}: the page reads ${m.dir}`);
            if (SHOTS && ['en', 'ar', 'ta'].includes(lang)) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await page.screenshot({ path: path.join(SHOTS, `android-${lang}-${colorScheme}.png`), fullPage: true });
            }
            await context.close();
        }
        assert.deepEqual(failures, []);
    });
}

test('/global at 320 px: on an Android phone the "No Google Play?" line is a 48 px row, in every language', { timeout: 120_000 }, async () => {
    const e = await env();
    const failures = [];
    for (const lang of LANGS) {
        const url = lang === 'en' ? 'global.html' : `${lang}/global.html`;
        const { page, context } = await open(e, url, 'dark', ANDROID_UA);
        const m = await page.evaluate(() => {
            const a = document.querySelector('.global-apk a');
            const r = a.getBoundingClientRect();
            return { h: r.height, shown: r.width > 0, href: a.getAttribute('href'), scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };
        });
        if (!m.shown || m.h < 48) failures.push(`${url}: the line is ${m.shown ? m.h + ' px tall' : 'not drawn'}`);
        if (m.href !== 'android.html') failures.push(`${url}: it links ${m.href}`);
        if (m.scrollW > m.clientW) failures.push(`${url}: ${m.scrollW} px wide on a ${m.clientW} px screen`);
        await context.close();
    }
    assert.deepEqual(failures, []);
});
