// website-s6: beanpool.org in the member's language (translation slice S6; scratch/global-node/DESIGN-translation-fable.md §4, §7).
//
// Tests:
//   - scripts/website-build.mjs --check passes with zero errors;
//   - every generated page has <html lang>, 26 hreflang tags (25 languages + x-default), and the footer language row;
//   - RTL languages (ar, fa, ur) have dir="rtl" on <body>;
//   - no English-only link where a translated page exists;
//   - legal banner mechanism works with the extracted English date, and NO legal translations are shipped in this slice;
//   - outdated translation detection renders "This page is newer in English." banner with link to English;
//   - main.js WORDS object adapts strings by document.documentElement.lang;
//   - main.js on English pages shows one-line "Read this in <language>" when navigator.language matches and no choice cookie is set, without redirecting;
//   - layout at 320px in ar has no horizontal overflow (scrollWidth <= 320) in headless Chromium;
//   - apps/website/_headers keeps at most one rule per path.
//
// Run: node --test scripts/website-lang.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
    GUIDE_LANGS,
    LANGS,
    RTL_LANGS,
    LANGUAGE_NAMES,
    TRANSLATED_PAGES,
    LEGAL_PAGES,
    ALL_PAGES,
    checkWebsite,
    pageContentHash,
    renderTranslatedPage,
    formatEnglishPage,
    extractLegalDate,
    buildHreflangTags,
    buildFooterLanguagesRow
} from './website-build.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const WEBSITE_DIR = path.join(REPO_ROOT, 'apps', 'website');
const CONTENT_DIR = path.join(WEBSITE_DIR, 'content');

const require = createRequire(path.join(REPO_ROOT, 'apps/pwa/package.json'));
const { chromium } = require('playwright');
const { JSDOM } = require('jsdom');

test('website translation check passes across all pages and languages', () => {
    const errors = checkWebsite();
    assert.deepEqual(errors, [], `website check reported errors:\n  ${errors.join('\n  ')}`);
});

test('every language has its source folder in content/ and generated folder in apps/website/', () => {
    assert.equal(GUIDE_LANGS.length, 24, '24 languages in GUIDE_LANGS');
    for (const lang of GUIDE_LANGS) {
        const contentDir = path.join(CONTENT_DIR, lang);
        const targetDir = path.join(WEBSITE_DIR, lang);
        assert.ok(fs.existsSync(contentDir), `content/${lang} exists`);
        assert.ok(fs.existsSync(targetDir), `apps/website/${lang} exists`);

        for (const page of TRANSLATED_PAGES) {
            const src = path.join(contentDir, page);
            const gen = path.join(targetDir, page);
            assert.ok(fs.existsSync(src), `content/${lang}/${page} exists`);
            assert.ok(fs.existsSync(gen), `apps/website/${lang}/${page} exists`);
        }
    }
});

test('every generated page has lang attribute, 26 hreflang tags, and footer language row', () => {
    for (const lang of GUIDE_LANGS) {
        for (const page of TRANSLATED_PAGES) {
            const file = path.join(WEBSITE_DIR, lang, page);
            const html = fs.readFileSync(file, 'utf8');

            // 1. Lang attribute
            const langMatch = html.match(/<html[^>]*\blang="([^"]*)"/i);
            assert.ok(langMatch, `${lang}/${page} has <html lang>`);
            assert.equal(langMatch[1], lang, `${lang}/${page} lang attribute matches ${lang}`);

            // 2. 26 hreflang tags
            const hreflangs = [...html.matchAll(/<link\s+rel="alternate"\s+hreflang="([^"]*)"\s+href="([^"]*)"/gi)];
            assert.equal(hreflangs.length, 26, `${lang}/${page} has 26 hreflang links (25 languages + x-default)`);

            // Verify x-default is present
            const xDefault = hreflangs.find(m => m[1] === 'x-default');
            assert.ok(xDefault, `${lang}/${page} has x-default hreflang link`);

            // 3. Footer language row (if page has footer)
            if (html.includes('<footer>')) {
                assert.ok(html.includes('class="footer-languages"'), `${lang}/${page} has footer-languages row`);
                // Verify each language is present in its native name
                for (const l of LANGS) {
                    assert.ok(html.includes(LANGUAGE_NAMES[l]), `${lang}/${page} footer contains native name for ${l} (${LANGUAGE_NAMES[l]})`);
                }
            }
        }
    }
});

test('RTL languages (ar, fa, ur) have dir="rtl" on <body>', () => {
    for (const rtlLang of RTL_LANGS) {
        for (const page of TRANSLATED_PAGES) {
            const file = path.join(WEBSITE_DIR, rtlLang, page);
            const html = fs.readFileSync(file, 'utf8');
            assert.match(html, /<body[^>]*\bdir="rtl"/i, `${rtlLang}/${page} has dir="rtl" on body`);
        }
    }
});

test('no English-only link where a translated page exists', () => {
    for (const lang of GUIDE_LANGS) {
        for (const page of TRANSLATED_PAGES) {
            const file = path.join(WEBSITE_DIR, lang, page);
            const html = fs.readFileSync(file, 'utf8');

            for (const trPage of TRANSLATED_PAGES) {
                if (trPage === page) continue;
                // An English-only link would look like href="../rules.html" or href="/rules.html" inside <lang>/
                assert.doesNotMatch(
                    html,
                    new RegExp(`href=["'](?:\\.\\./|/)${trPage}["']`, 'i'),
                    `${lang}/${page} links to English ${trPage} instead of translated ${trPage}`
                );
            }
        }
    }
});

test('legal pages banner mechanism works, and no legal translations are shipped in slice S6', () => {
    // 1. Verify no legal translations exist in content/ or apps/website/<lang>/
    for (const lang of GUIDE_LANGS) {
        for (const legalPage of LEGAL_PAGES) {
            assert.ok(!fs.existsSync(path.join(CONTENT_DIR, lang, legalPage)), `content/${lang}/${legalPage} must NOT exist`);
            assert.ok(!fs.existsSync(path.join(WEBSITE_DIR, lang, legalPage)), `apps/website/${lang}/${legalPage} must NOT exist`);
        }
    }

    // 2. Test banner mechanism when a legal page is rendered
    const sampleEnglishPrivacy = fs.readFileSync(path.join(WEBSITE_DIR, 'privacy.html'), 'utf8');
    const legalDate = extractLegalDate(sampleEnglishPrivacy);
    assert.ok(legalDate, 'legal date extracted from privacy.html');

    const sampleDraftPrivacy = `<!-- source-hash: ${pageContentHash(sampleEnglishPrivacy)} -->\n${sampleEnglishPrivacy}`;
    const renderedEsPrivacy = renderTranslatedPage('es', 'privacy.html', sampleDraftPrivacy, sampleEnglishPrivacy);

    assert.ok(renderedEsPrivacy.includes('website-legal-banner'), 'rendered translated legal page includes legal banner');
    assert.ok(renderedEsPrivacy.includes(legalDate), 'legal banner mentions the English version date');
    assert.ok(renderedEsPrivacy.includes('href="../privacy.html"'), 'legal banner links to English version');

    // 3. Verify hreflang tags on legal pages only include en and x-default (no dead links)
    const privacyHreflang = buildHreflangTags('privacy.html');
    assert.ok(privacyHreflang.includes('hreflang="en"'), 'legal page includes en hreflang');
    assert.ok(privacyHreflang.includes('hreflang="x-default"'), 'legal page includes x-default hreflang');
    assert.ok(!privacyHreflang.includes('hreflang="es"'), 'legal page omits unbuilt translations');

    // 4. Verify footer languages row on legal pages points each language to its home page (/es/)
    const legalFooter = buildFooterLanguagesRow('privacy.html', 'en');
    assert.ok(legalFooter.includes('href="/es/"'), 'footer row links Spanish to /es/');
    assert.ok(legalFooter.includes('href="/ar/"'), 'footer row links Arabic to /ar/');
    assert.ok(!legalFooter.includes('href="privacy.html" hreflang="es"'), 'footer row does not link Spanish to English privacy.html');
});

test('outdated translation displays "This page is newer in English." banner linking to English', () => {
    const sampleEnglishRules = fs.readFileSync(path.join(WEBSITE_DIR, 'rules.html'), 'utf8');
    const staleHash = '0000000000000000'; // deliberately stale
    const sampleStaleContent = `<!-- source-hash: ${staleHash} -->\n${sampleEnglishRules}`;

    const rendered = renderTranslatedPage('es', 'rules.html', sampleStaleContent, sampleEnglishRules);
    assert.ok(rendered.includes('website-stale-banner'), 'stale translation includes website-stale-banner');
    assert.ok(rendered.includes('href="../rules.html"'), 'stale banner links to English rules.html');
});

test('main.js WORDS dictionary translates strings by document.documentElement.lang', () => {
    const mainJsText = fs.readFileSync(path.join(WEBSITE_DIR, 'main.js'), 'utf8');

    // Run in jsdom with Spanish lang
    const domEs = new JSDOM(`<!DOCTYPE html><html lang="es"><body><div id="nodes-map"></div></body></html>`, { runScripts: 'dangerously' });
    domEs.window.eval(mainJsText);

    // Verify word function exists and translates
    const wordFn = domEs.window.eval('word');
    assert.equal(wordFn('noneNear'), 'Aún no hay una comunidad cerca de ti.');
    assert.equal(wordFn('members', 5), '5 miembros');
    assert.equal(wordFn('radius', 10), 'Radio de 10km');

    // Run in jsdom with English lang
    const domEn = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="nodes-map"></div></body></html>`, { runScripts: 'dangerously' });
    domEn.window.eval(mainJsText);
    const wordFnEn = domEn.window.eval('word');
    assert.equal(wordFnEn('noneNear'), 'No community near you yet.');
    assert.equal(wordFnEn('members', 5), '5 members');
    assert.equal(wordFnEn('radius', 10), '10km radius');

    // Verify all 25 languages exist in WORDS and have every key
    const wordsTable = domEn.window.WORDS;
    const REQUIRED_KEYS = [
        'noneNear', 'notLoaded', 'members', 'radius', 'visit',
        'subscribing', 'alreadySubscribed', 'checkInbox', 'somethingWrong',
        'subscribe', 'readIn'
    ];
    for (const lang of LANGS) {
        assert.ok(wordsTable[lang], `WORDS must contain language ${lang}`);
        for (const key of REQUIRED_KEYS) {
            assert.ok(wordsTable[lang][key] !== undefined, `WORDS[${lang}] missing key ${key}`);
        }
        assert.equal(typeof wordsTable[lang].members, 'function', `WORDS[${lang}].members must be a function`);
        assert.equal(typeof wordsTable[lang].radius, 'function', `WORDS[${lang}].radius must be a function`);
        assert.equal(typeof wordsTable[lang].visit, 'function', `WORDS[${lang}].visit must be a function`);
        assert.equal(typeof wordsTable[lang].readIn, 'function', `WORDS[${lang}].readIn must be a function`);
    }
});

test('main.js on English page presents "Read this in <language>" banner when navigator.language matches without choice cookie', () => {
    const mainJsText = fs.readFileSync(path.join(WEBSITE_DIR, 'main.js'), 'utf8');

    // Test 1: Spanish visitor on English page, no cookie -> banner appears
    const dom1 = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/rules.html',
        runScripts: 'dangerously'
    });
    Object.defineProperty(dom1.window.navigator, 'language', { value: 'es-ES', configurable: true });
    Object.defineProperty(dom1.window.navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
    dom1.window.eval(mainJsText);

    const banner1 = dom1.window.document.getElementById('read-in-banner');
    assert.ok(banner1, 'banner appears for Spanish visitor on English page');
    assert.ok(banner1.textContent.includes('Español'), 'banner mentions Español');
    assert.ok(dom1.window.document.body.classList.contains('has-read-in-banner'), 'body has has-read-in-banner class when banner is active');
    assert.equal(dom1.window.document.documentElement.style.getPropertyValue('--banner-height'), '61px', 'sets --banner-height custom property');
    const link = banner1.querySelector('a');
    assert.equal(link.getAttribute('href'), '/es/rules', 'banner link points to extensionless /es/rules');
    assert.equal(link.getAttribute('lang'), 'es', 'banner link sets lang to target language');
    assert.equal(link.textContent, 'Leer esto en Español →', 'banner link uses target language readIn string');

    // Test 1b: Homepage links to extensionless /es/
    const domHome = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/',
        runScripts: 'dangerously'
    });
    Object.defineProperty(domHome.window.navigator, 'language', { value: 'es-ES', configurable: true });
    Object.defineProperty(domHome.window.navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
    domHome.window.eval(mainJsText);
    const homeBanner = domHome.window.document.getElementById('read-in-banner');
    assert.ok(homeBanner, 'banner appears on homepage');
    assert.equal(homeBanner.querySelector('a').getAttribute('href'), '/es/', 'homepage banner links to /es/');

    // Test 1c: Extensionless path /rules links to /es/rules
    const domRulesExtless = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/rules',
        runScripts: 'dangerously'
    });
    Object.defineProperty(domRulesExtless.window.navigator, 'language', { value: 'es-ES', configurable: true });
    Object.defineProperty(domRulesExtless.window.navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
    domRulesExtless.window.eval(mainJsText);
    assert.equal(domRulesExtless.window.document.getElementById('read-in-banner').querySelector('a').getAttribute('href'), '/es/rules');

    // Test 2: Cookie already set -> banner does NOT appear
    const dom2 = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/rules.html',
        runScripts: 'dangerously'
    });
    Object.defineProperty(dom2.window.navigator, 'language', { value: 'es-ES', configurable: true });
    dom2.window.document.cookie = 'beanpool_lang=es;path=/';
    dom2.window.eval(mainJsText);

    const banner2 = dom2.window.document.getElementById('read-in-banner');
    assert.equal(banner2, null, 'banner does not appear when choice cookie is set');

    // Test 3: Dismiss button sets cookie with Secure flag on HTTPS and clears body class
    const closeBtn = banner1.querySelector('.read-in-close');
    closeBtn.click();
    assert.ok(dom1.window.document.cookie.includes('beanpool_lang=en'), 'dismiss sets beanpool_lang=en cookie');
    assert.equal(dom1.window.document.getElementById('read-in-banner'), null, 'banner element is removed after dismiss');
    assert.ok(!dom1.window.document.body.classList.contains('has-read-in-banner'), 'has-read-in-banner class removed on dismiss');
    assert.equal(dom1.window.document.documentElement.style.getPropertyValue('--banner-height'), '', '--banner-height property removed on dismiss');

    // Test 4: Bilingual user with English primary ['en-US', 'es'] does NOT see banner
    const dom4 = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/rules.html',
        runScripts: 'dangerously'
    });
    Object.defineProperty(dom4.window.navigator, 'language', { value: 'en-US', configurable: true });
    Object.defineProperty(dom4.window.navigator, 'languages', { value: ['en-US', 'es'], configurable: true });
    dom4.window.eval(mainJsText);
    assert.equal(dom4.window.document.getElementById('read-in-banner'), null, 'banner does not appear for bilingual user with English primary');

    // Test 5: Untranslated legal pages suppress banner to avoid 404 links (with or without .html)
    for (const legalPage of ['privacy', 'privacy.html', 'terms', 'terms.html', 'data-deletion', 'data-deletion.html']) {
        const domLegal = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
            url: `https://beanpool.org/${legalPage}`,
            runScripts: 'dangerously'
        });
        Object.defineProperty(domLegal.window.navigator, 'language', { value: 'es-ES', configurable: true });
        Object.defineProperty(domLegal.window.navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
        domLegal.window.eval(mainJsText);
        assert.equal(domLegal.window.document.getElementById('read-in-banner'), null, `banner does not appear on legal page ${legalPage}`);
    }
});

test('320px viewport layout in Arabic (ar) has no horizontal overflow in headless Chromium', async () => {
    const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2' };

    const server = http.createServer((req, res) => {
        let p = path.join(WEBSITE_DIR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
        if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
        fs.createReadStream(p).pipe(res);
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const browser = await chromium.launch({ headless: true });

    try {
        const page = await browser.newPage({ viewport: { width: 320, height: 600 } });

        for (const testPage of ['ar/index.html', 'ar/rules.html', 'ar/getting-started.html', 'ar/help.html']) {
            await page.goto(`http://127.0.0.1:${port}/${testPage}`, { waitUntil: 'load' });
            const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
            const bodyDir = await page.evaluate(() => document.body.getAttribute('dir'));

            assert.equal(bodyDir, 'rtl', `${testPage} has dir="rtl" on body`);
            assert.ok(scrollWidth <= 320, `${testPage} scrollWidth (${scrollWidth}) <= 320 at 320px width`);
        }
    } finally {
        await browser.close();
        server.close();
    }
});

test('RTL navbar is mirrored at 1280px in headless Chromium with logo on the right', async () => {
    const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2' };

    const server = http.createServer((req, res) => {
        let p = path.join(WEBSITE_DIR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
        if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
        fs.createReadStream(p).pipe(res);
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const browser = await chromium.launch({ headless: true });

    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

        await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
        const enLogoBox = await page.locator('#navbar .logo').boundingBox();
        assert.ok(enLogoBox && enLogoBox.x < 100, `English logo on left (x=${enLogoBox?.x})`);

        await page.goto(`http://127.0.0.1:${port}/ar/index.html`, { waitUntil: 'load' });
        const arLogoBox = await page.locator('#navbar .logo').boundingBox();
        assert.ok(arLogoBox && arLogoBox.x > 800, `Arabic logo mirrored to right (x=${arLogoBox?.x})`);
    } finally {
        await browser.close();
        server.close();
    }
});

test('language banner on mobile (320px) does not overlap fixed navbar in headless Chromium', async () => {
    const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2' };

    const server = http.createServer((req, res) => {
        let p = path.join(WEBSITE_DIR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
        if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
        fs.createReadStream(p).pipe(res);
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const browser = await chromium.launch({ headless: true });

    try {
        const context = await browser.newContext({
            viewport: { width: 320, height: 600 },
            locale: 'es-ES'
        });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${port}/rules.html`, { waitUntil: 'load' });

        await page.waitForFunction(() => {
            const nav = document.getElementById('navbar');
            const prop = document.documentElement.style.getPropertyValue('--banner-height');
            return nav && prop && window.getComputedStyle(nav).top === prop;
        });

        const layout = await page.evaluate(() => {
            const banner = document.getElementById('read-in-banner');
            const nav = document.getElementById('navbar');
            if (!banner || !nav) return null;
            const bRect = banner.getBoundingClientRect();
            const nRect = nav.getBoundingClientRect();
            return {
                bannerHeight: bRect.height,
                bannerBottom: bRect.bottom,
                navTop: nRect.top,
                computedTop: window.getComputedStyle(nav).top,
                customProp: document.documentElement.style.getPropertyValue('--banner-height')
            };
        });

        assert.ok(layout, 'banner and navbar are present in Chromium');
        assert.ok(layout.bannerHeight >= 44, `banner height (${layout.bannerHeight}) meets touch target requirements`);
        assert.equal(layout.computedTop, layout.customProp, 'navbar computed top matches --banner-height');
        assert.ok(layout.navTop >= layout.bannerBottom - 0.1, `navbar top (${layout.navTop}) must be at or below banner bottom (${layout.bannerBottom}) with no overlap`);
        assert.equal(layout.customProp, `${Math.round(layout.bannerHeight)}px`, 'custom property matches banner height');

        // Test dismiss cleanup
        await page.click('.read-in-close');
        await page.waitForFunction(() => {
            const nav = document.getElementById('navbar');
            return nav && window.getComputedStyle(nav).top === '0px';
        });
        const afterDismiss = await page.evaluate(() => {
            const banner = document.getElementById('read-in-banner');
            const nav = document.getElementById('navbar');
            return {
                bannerPresent: !!banner,
                navTop: nav ? nav.getBoundingClientRect().top : -1,
                computedTop: nav ? window.getComputedStyle(nav).top : '',
                customProp: document.documentElement.style.getPropertyValue('--banner-height')
            };
        });

        assert.equal(afterDismiss.bannerPresent, false, 'banner removed on dismiss');
        assert.equal(afterDismiss.computedTop, '0px', 'navbar computed top returns to 0px after banner dismiss');
        assert.equal(afterDismiss.customProp, '', 'custom property cleared on dismiss');
    } finally {
        await browser.close();
        server.close();
    }
});

test('apps/website/_headers matches at most one rule per path', () => {
    const headersFile = path.join(WEBSITE_DIR, '_headers');
    const content = fs.readFileSync(headersFile, 'utf8');
    const rules = content.split('\n').filter(l => l.startsWith('/')).map(l => l.trim());

    function matches(rule, p) {
        const re = new RegExp(`^${rule.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        return re.test(p);
    }

    const testPaths = [
        '/guide/guide.json',
        ...GUIDE_LANGS.map(l => `/guide/${l}/guide.json`),
        '/rules.html',
        '/es/rules.html',
        '/content/es/rules.html',
        '/content/es/rules'
    ];

    for (const p of testPaths) {
        const hits = rules.filter(r => matches(r, p));
        assert.ok(hits.length <= 1, `${p} matched ${hits.length} rules: ${hits.join(', ')}`);
    }
});

test('apps/website/_redirects blocks public access to /content/* with 404', () => {
    const redirectsFile = path.join(WEBSITE_DIR, '_redirects');
    assert.ok(fs.existsSync(redirectsFile), 'apps/website/_redirects exists');
    const content = fs.readFileSync(redirectsFile, 'utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    const contentRule = lines.find(l => l.startsWith('/content/*'));
    assert.ok(contentRule, '_redirects contains rule for /content/*');
    assert.match(contentRule, /^\/content\/\*\s+\S+\s+404$/, '/content/* rule returns 404 status');
});
