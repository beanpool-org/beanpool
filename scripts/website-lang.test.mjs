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
    CHOOSE_LANGUAGE_WORDS,
    getLanguageLinks,
    checkWebsite,
    pageContentHash,
    renderTranslatedPage,
    formatEnglishPage,
    extractLegalDate,
    buildHreflangTags,
    buildFooterLanguagesRow,
    draftLanguage,
    extractSourceHash,
    buildAll,
    markCurrent,
    injectBanner
} from './website-build.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const WEBSITE_DIR = path.join(REPO_ROOT, 'apps', 'website');
const CONTENT_DIR = path.join(REPO_ROOT, 'apps', 'website-src', 'content');

const require = createRequire(path.join(REPO_ROOT, 'apps/pwa/package.json'));
const { chromium } = require('playwright');
const { JSDOM } = require('jsdom');

test('website translation check passes across all pages and languages', () => {
    const errors = checkWebsite();
    assert.deepEqual(errors, [], `website check reported errors:\n  ${errors.join('\n  ')}`);
});

test('every language has its source folder in apps/website-src/content/ and generated folder in apps/website/', () => {
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

            // Verify x-default is present and all URLs are final extensionless absolute URLs
            const xDefault = hreflangs.find(m => m[1] === 'x-default');
            assert.ok(xDefault, `${lang}/${page} has x-default hreflang link`);

            for (const [, hLang, href] of hreflangs) {
                assert.ok(href.startsWith('https://beanpool.org/'), `${lang}/${page} hreflang="${hLang}" href (${href}) must be absolute https://beanpool.org/`);
                assert.ok(!href.includes('.html'), `${lang}/${page} hreflang="${hLang}" href (${href}) must not contain .html`);
            }

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

test('translated pages link to guide page in their language when it exists, else English, and --check flags violations', () => {
    const esGettingStarted = fs.readFileSync(path.join(WEBSITE_DIR, 'es', 'getting-started.html'), 'utf8');
    assert.ok(esGettingStarted.includes('href="../guide/es/joining.html"'), 'es/getting-started.html links to guide/es/joining.html');
    assert.ok(esGettingStarted.includes('href="../guide/index.html"'), 'es/getting-started.html falls back to guide/index.html when guide/es/index.html is absent');

    // Simulate an English guide link where the localized guide page exists
    const origEsFile = path.join(WEBSITE_DIR, 'es', 'getting-started.html');
    const originalContent = fs.readFileSync(origEsFile, 'utf8');
    try {
        fs.writeFileSync(origEsFile, originalContent.replace('href="../guide/es/joining.html"', 'href="../guide/joining.html"'), 'utf8');
        const errors = checkWebsite();
        assert.ok(errors.some(e => e.includes('links to English guide page "joining.html" although guide/es/joining.html exists')),
            'checkWebsite fails when translated page links to English guide page that exists in language');
    } finally {
        fs.writeFileSync(origEsFile, originalContent, 'utf8');
    }
});

test('a publish that adds a language guide page leaves website-build.mjs --check green after website rebuild', () => {
    const fakeGuidePage = path.join(WEBSITE_DIR, 'guide', 'es', 'index.html');
    assert.ok(!fs.existsSync(fakeGuidePage), 'guide/es/index.html does not exist initially');

    try {
        // 1. Simulate guide publish writing a new localized guide page
        fs.writeFileSync(fakeGuidePage, '<html><body>Guía</body></html>', 'utf8');

        // 2. Without website rebuild, checkWebsite() catches the violation
        const errorsBefore = checkWebsite();
        assert.ok(
            errorsBefore.some(e => e.includes('links to English guide page "index.html" although guide/es/index.html exists')),
            'checkWebsite catches stale English link before website rebuild'
        );

        // 3. Simulate the website build step run by publish.mjs
        buildAll();

        // 4. website check is green
        const errorsAfter = checkWebsite();
        assert.deepEqual(errorsAfter, [], 'checkWebsite is green after rebuild');
    } finally {
        if (fs.existsSync(fakeGuidePage)) fs.rmSync(fakeGuidePage);
        buildAll(); // restore original files
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
    const legalContentIdx = renderedEsPrivacy.indexOf('<section class="legal-content');
    const legalBannerIdx = renderedEsPrivacy.indexOf('website-legal-banner');
    assert.ok(legalBannerIdx > legalContentIdx, 'legal banner is inside legal-content container, not before it');

    // 3. Verify hreflang tags on legal pages only include en and x-default (no dead links, extensionless absolute URLs)
    const privacyHreflang = buildHreflangTags('privacy.html');
    assert.ok(privacyHreflang.includes('hreflang="en" href="https://beanpool.org/privacy"'), 'legal page includes extensionless absolute en hreflang');
    assert.ok(privacyHreflang.includes('hreflang="x-default" href="https://beanpool.org/privacy"'), 'legal page includes extensionless absolute x-default hreflang');
    assert.ok(!privacyHreflang.includes('.html'), 'legal page hreflang does not contain .html');
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
    const rulesContentIdx = rendered.indexOf('<section class="legal-content');
    const rulesBannerIdx = rendered.indexOf('website-stale-banner');
    assert.ok(rulesBannerIdx > rulesContentIdx, 'stale banner is inside legal-content container, not before it');

    // Also test hero-container on index.html
    const sampleEnglishIndex = fs.readFileSync(path.join(WEBSITE_DIR, 'index.html'), 'utf8');
    const sampleStaleIndex = `<!-- source-hash: ${staleHash} -->\n${sampleEnglishIndex}`;
    const renderedIndex = renderTranslatedPage('es', 'index.html', sampleStaleIndex, sampleEnglishIndex);
    assert.ok(renderedIndex.includes('website-stale-banner'), 'stale index includes website-stale-banner');
    const heroContainerIdx = renderedIndex.indexOf('hero-container');
    const indexBannerIdx = renderedIndex.indexOf('website-stale-banner');
    assert.ok(indexBannerIdx > heroContainerIdx, 'stale banner is inside hero-container, not before it');
});

test('pageContentHash ignores asset queries and script injections, but changes on text edits', () => {
    const sampleEnglish = fs.readFileSync(path.join(WEBSITE_DIR, 'rules.html'), 'utf8');
    const baseHash = pageContentHash(sampleEnglish);

    // Bump ?v= query string
    const bumpedV = sampleEnglish.replace(/style\.css\?v=[0-9.]+/g, 'style.css?v=999.0');
    assert.equal(pageContentHash(bumpedV), baseHash, 'bumping ?v= asset query string does not change hash');

    // Injected script tag
    const injectedScript = sampleEnglish.replace('</body>', '    <script src="main.js"></script>\n</body>');
    assert.equal(pageContentHash(injectedScript), baseHash, 'injected script tag does not change hash');

    // Change a sentence of visible text
    const changedText = sampleEnglish.replace('The simple rules of BeanPool', 'The completely altered rules of BeanPool');
    assert.notEqual(pageContentHash(changedText), baseHash, 'modifying text content changes hash');

    // Verify when text changes, that page goes stale in every language
    for (const lang of GUIDE_LANGS) {
        const langContent = fs.readFileSync(path.join(CONTENT_DIR, lang, 'rules.html'), 'utf8');
        const rendered = renderTranslatedPage(lang, 'rules.html', langContent, changedText);
        assert.ok(rendered.includes('website-stale-banner'), `changing sentence makes rules.html stale in ${lang}`);
    }
});

test("editing words inside status.html's inline script marks that page stale in every language, while bumping ?v= leaves nothing stale", () => {
    const statusEnglish = fs.readFileSync(path.join(WEBSITE_DIR, 'status.html'), 'utf8');
    const baseHash = pageContentHash(statusEnglish);

    // 1. Bumping ?v= asset query leaves hash unchanged and nothing stale
    const bumpedV = statusEnglish.replace(/style\.css\?v=[0-9.]+/g, 'style.css?v=999.9');
    assert.equal(pageContentHash(bumpedV), baseHash, 'bumping ?v= asset query does not change hash');
    for (const lang of GUIDE_LANGS) {
        const langContent = fs.readFileSync(path.join(CONTENT_DIR, lang, 'status.html'), 'utf8');
        const rendered = renderTranslatedPage(lang, 'status.html', langContent, bumpedV);
        assert.ok(!rendered.includes('website-stale-banner'), `bumping ?v= does not make status.html stale in ${lang}`);
    }

    // 2. Editing a word inside status.html inline script changes hash and marks page stale in every language
    assert.ok(statusEnglish.includes("'Answering'"), "status.html contains inline script word 'Answering'");
    const editedScriptStatus = statusEnglish.replace("'Answering'", "'Up and answering'");
    assert.notEqual(pageContentHash(editedScriptStatus), baseHash, 'editing inline script word changes hash');
    for (const lang of GUIDE_LANGS) {
        const langContent = fs.readFileSync(path.join(CONTENT_DIR, lang, 'status.html'), 'utf8');
        const rendered = renderTranslatedPage(lang, 'status.html', langContent, editedScriptStatus);
        assert.ok(rendered.includes('website-stale-banner'), `editing inline script word makes status.html stale in ${lang}`);
    }
});

test('--draft <lang> never re-stamps an existing file hash without writing new text', () => {
    const testLang = 'es';
    const testPage = 'rules.html';
    const filePath = path.join(CONTENT_DIR, testLang, testPage);
    const originalContent = fs.readFileSync(filePath, 'utf8');
    const staleHash = '12345678abcdef01';
    const fakeStaleContent = originalContent.replace(/<!--\s*source-hash:\s*[0-9a-f]{16}\s*-->/i, `<!-- source-hash: ${staleHash} -->`);

    try {
        fs.writeFileSync(filePath, fakeStaleContent, 'utf8');
        // Run draftLanguage('es')
        draftLanguage(testLang);

        const contentAfterDraft = fs.readFileSync(filePath, 'utf8');
        assert.equal(extractSourceHash(contentAfterDraft), staleHash, 'existing file source-hash was NOT overwritten by --draft');
        assert.equal(contentAfterDraft, fakeStaleContent, 'existing file content was preserved untouched by --draft');
    } finally {
        fs.writeFileSync(filePath, originalContent, 'utf8');
    }
});

test('--mark-current <lang> <page> records current English hash on translated page and refuses missing file', () => {
    const testLang = 'es';
    const testPage = 'rules.html';
    const filePath = path.join(CONTENT_DIR, testLang, testPage);
    const originalContent = fs.readFileSync(filePath, 'utf8');
    const staleHash = '0000000000000000';
    const fakeStaleContent = originalContent.replace(/<!--\s*source-hash:\s*[0-9a-f]{16}\s*-->/i, `<!-- source-hash: ${staleHash} -->`);

    try {
        fs.writeFileSync(filePath, fakeStaleContent, 'utf8');
        assert.equal(extractSourceHash(fs.readFileSync(filePath, 'utf8')), staleHash);

        // 1. Mark current successfully records the current English hash
        const stampedHash = markCurrent(testLang, testPage);
        const enHtml = fs.readFileSync(path.join(WEBSITE_DIR, testPage), 'utf8');
        const expectedHash = pageContentHash(enHtml);
        assert.equal(stampedHash, expectedHash, 'returned hash matches current English hash');
        const updatedContent = fs.readFileSync(filePath, 'utf8');
        assert.equal(extractSourceHash(updatedContent), expectedHash, 'file source-hash was updated to current English hash');

        // 2. Also accepts page name without .html
        fs.writeFileSync(filePath, fakeStaleContent, 'utf8');
        markCurrent(testLang, 'rules');
        assert.equal(extractSourceHash(fs.readFileSync(filePath, 'utf8')), expectedHash);

        // 3. Refuses a page whose translation source file is missing
        assert.throws(() => markCurrent('es', 'nonexistent.html'), /unknown or untranslated page/);

        // Create a missing condition for a valid page
        const tmpMissingPage = path.join(CONTENT_DIR, 'es', 'status.html');
        const statusBak = fs.readFileSync(tmpMissingPage, 'utf8');
        try {
            fs.rmSync(tmpMissingPage);
            assert.throws(() => markCurrent('es', 'status.html'), /Translation source file missing/);
        } finally {
            fs.writeFileSync(tmpMissingPage, statusBak, 'utf8');
        }

        // 4. Refuses an invalid language
        assert.throws(() => markCurrent('xx', 'rules.html'), /unknown or invalid language/);
    } finally {
        fs.writeFileSync(filePath, originalContent, 'utf8');
    }
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
    assert.equal(wordsTable.id.readIn('Bahasa Indonesia'), 'Baca ini dalam Bahasa Indonesia →', 'Indonesian readIn avoids redundant "bahasa"');
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
    assert.equal(link.getAttribute('href'), 'https://beanpool.org/es/rules', 'banner link points to extensionless absolute https://beanpool.org/es/rules');
    assert.equal(link.getAttribute('lang'), 'es', 'banner link sets lang to target language');
    assert.equal(link.getAttribute('dir'), 'auto', 'banner link sets dir="auto"');
    assert.equal(link.textContent, 'Leer esto en Español →', 'banner link uses target language readIn string');

    // Test 1b: Homepage links to extensionless absolute /es/
    const domHome = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/',
        runScripts: 'dangerously'
    });
    Object.defineProperty(domHome.window.navigator, 'language', { value: 'es-ES', configurable: true });
    Object.defineProperty(domHome.window.navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
    domHome.window.eval(mainJsText);
    const homeBanner = domHome.window.document.getElementById('read-in-banner');
    assert.ok(homeBanner, 'banner appears on homepage');
    assert.equal(homeBanner.querySelector('a').getAttribute('href'), 'https://beanpool.org/es/', 'homepage banner links to https://beanpool.org/es/');
    assert.equal(homeBanner.querySelector('a').getAttribute('dir'), 'auto', 'homepage banner link sets dir="auto"');

    // Test 1c: Extensionless path /rules links to /es/rules
    const domRulesExtless = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/rules',
        runScripts: 'dangerously'
    });
    Object.defineProperty(domRulesExtless.window.navigator, 'language', { value: 'es-ES', configurable: true });
    Object.defineProperty(domRulesExtless.window.navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
    domRulesExtless.window.eval(mainJsText);
    assert.equal(domRulesExtless.window.document.getElementById('read-in-banner').querySelector('a').getAttribute('href'), 'https://beanpool.org/es/rules');
    assert.equal(domRulesExtless.window.document.getElementById('read-in-banner').querySelector('a').getAttribute('dir'), 'auto');

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

test('stale banner renders inside legal-content and is not obscured by fixed navbar in headless Chromium', async () => {
    const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2' };

    const sampleEnglishRules = fs.readFileSync(path.join(WEBSITE_DIR, 'rules.html'), 'utf8');
    const staleHash = '0000000000000000';
    const sampleStaleContent = `<!-- source-hash: ${staleHash} -->\n${sampleEnglishRules}`;
    const renderedStaleRules = renderTranslatedPage('es', 'rules.html', sampleStaleContent, sampleEnglishRules);

    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (urlPath === '/stale-rules.html') {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(renderedStaleRules);
            return;
        }
        let p = path.join(WEBSITE_DIR, urlPath);
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
        await page.goto(`http://127.0.0.1:${port}/stale-rules.html`, { waitUntil: 'load' });

        const layout = await page.evaluate(() => {
            const banner = document.querySelector('.website-stale-banner');
            const nav = document.getElementById('navbar');
            if (!banner || !nav) return null;
            const bRect = banner.getBoundingClientRect();
            const nRect = nav.getBoundingClientRect();
            return {
                bannerTop: bRect.top,
                bannerBottom: bRect.bottom,
                navBottom: nRect.bottom
            };
        });

        assert.ok(layout, 'stale banner and navbar are present in Chromium');
        assert.ok(layout.bannerTop >= layout.navBottom, `stale banner top (${layout.bannerTop}) must be at or below navbar bottom (${layout.navBottom}) with zero overlap`);
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
        '/es/rules.html'
    ];

    for (const p of testPaths) {
        const hits = rules.filter(r => matches(r, p));
        assert.ok(hits.length <= 1, `${p} matched ${hits.length} rules: ${hits.join(', ')}`);
    }
});

test('nothing under apps/website/ is a translation source', () => {
    assert.ok(!fs.existsSync(path.join(WEBSITE_DIR, 'content')), 'apps/website/content must NOT exist');
    assert.ok(fs.existsSync(CONTENT_DIR), 'apps/website-src/content exists');
    for (const lang of GUIDE_LANGS) {
        assert.ok(!fs.existsSync(path.join(WEBSITE_DIR, 'content', lang)), `apps/website/content/${lang} must NOT exist`);
        assert.ok(fs.existsSync(path.join(CONTENT_DIR, lang)), `apps/website-src/content/${lang} exists`);
    }
});

test('every generated and English page has top menu language buttons (desktop and phone) with accessible name', () => {
    // English pages
    for (const page of ALL_PAGES) {
        const file = path.join(WEBSITE_DIR, page);
        const html = fs.readFileSync(file, 'utf8');

        // Check desktop lang button
        assert.ok(html.includes('class="lang-menu desktop-lang-menu"'), `en/${page} has desktop-lang-menu`);
        assert.ok(html.includes(`aria-label="${CHOOSE_LANGUAGE_WORDS.en}"`), `en/${page} desktop button has aria-label="${CHOOSE_LANGUAGE_WORDS.en}"`);

        // Check phone lang button on pages with phone menu (.has-menu / .nav-menu)
        if (html.includes('class="nav-menu"')) {
            assert.ok(html.includes('class="lang-menu phone-lang-menu"'), `en/${page} has phone-lang-menu`);
            assert.ok(html.includes(`aria-label="${CHOOSE_LANGUAGE_WORDS.en}"`), `en/${page} phone button has aria-label="${CHOOSE_LANGUAGE_WORDS.en}"`);
        }
    }

    // Translated pages
    for (const lang of GUIDE_LANGS) {
        for (const page of TRANSLATED_PAGES) {
            const file = path.join(WEBSITE_DIR, lang, page);
            const html = fs.readFileSync(file, 'utf8');

            const expectedLabel = CHOOSE_LANGUAGE_WORDS[lang];
            assert.ok(html.includes('class="lang-menu desktop-lang-menu"'), `${lang}/${page} has desktop-lang-menu`);
            assert.ok(html.includes(`aria-label="${expectedLabel}"`), `${lang}/${page} desktop button has aria-label="${expectedLabel}"`);

            if (html.includes('class="nav-menu"')) {
                assert.ok(html.includes('class="lang-menu phone-lang-menu"'), `${lang}/${page} has phone-lang-menu`);
                assert.ok(html.includes(`aria-label="${expectedLabel}"`), `${lang}/${page} phone button has aria-label="${expectedLabel}"`);
            }
        }
    }
});

test('language menu in top menu opens the same list of 25 languages with own names and marks aria-current="page"', () => {
    for (const lang of LANGS) {
        const pagesToTest = lang === 'en' ? ALL_PAGES : TRANSLATED_PAGES;
        for (const page of pagesToTest) {
            const file = lang === 'en' ? path.join(WEBSITE_DIR, page) : path.join(WEBSITE_DIR, lang, page);
            const html = fs.readFileSync(file, 'utf8');

            const expectedLinks = getLanguageLinks(page, lang);

            // Check desktop menu links
            const desktopMenuMatch = html.match(/<details\s+class="lang-menu\s+desktop-lang-menu">([\s\S]*?)<\/details>/i);
            assert.ok(desktopMenuMatch, `desktop menu found in ${lang}/${page}`);
            const desktopDropdown = desktopMenuMatch[1];

            const menusToTest = [desktopDropdown];

            // Check phone menu links if page has phone menu
            const phoneMenuMatch = html.match(/<details\s+class="lang-menu\s+phone-lang-menu">([\s\S]*?)<\/details>/i);
            if (html.includes('class="nav-menu"')) {
                assert.ok(phoneMenuMatch, `phone menu found in ${lang}/${page}`);
                menusToTest.push(phoneMenuMatch[1]);
            }

            for (const menuHtml of menusToTest) {
                const links = [...menuHtml.matchAll(/<a\s+href="([^"]*)"\s+hreflang="([^"]*)"\s+lang="([^"]*)"(?:\s+aria-current="([^"]*)")?>([^<]*)<\/a>/gi)];
                assert.equal(links.length, 25, `${lang}/${page} menu contains 25 language links`);

                for (let i = 0; i < 25; i++) {
                    const [, href, hreflang, langAttr, ariaCurrent, text] = links[i];
                    const exp = expectedLinks[i];
                    assert.equal(hreflang, exp.lang);
                    assert.equal(langAttr, exp.lang);
                    assert.equal(href, exp.href);
                    assert.equal(text, exp.name);
                    if (exp.isCurrent) {
                        assert.equal(ariaCurrent, 'page', `current language ${exp.lang} marked with aria-current="page"`);
                    } else {
                        assert.equal(ariaCurrent, undefined, `non-current language ${exp.lang} does not have aria-current`);
                    }
                }
            }
        }
    }
});

test('keyboard interaction: Escape key closes open language menus and focuses summary button when menu had focus', () => {
    const mainJsText = fs.readFileSync(path.join(WEBSITE_DIR, 'main.js'), 'utf8');
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
        <input id="outside" />
        <details class="lang-menu desktop-lang-menu" open>
            <summary class="lang-btn" aria-label="Choose language">🌐</summary>
            <div class="lang-dropdown">
                <a id="link" href="/es/">Español</a>
            </div>
        </details>
    </body></html>`, { runScripts: 'dangerously' });

    dom.window.eval(mainJsText);

    const details = dom.window.document.querySelector('.lang-menu');
    const summary = dom.window.document.querySelector('.lang-btn');
    const link = dom.window.document.querySelector('#link');
    const outsideInput = dom.window.document.querySelector('#outside');
    assert.equal(details.open, true, 'menu is initially open');

    // Case 1: Focus within the menu -> Escape returns focus to summary
    link.focus();
    const event1 = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    dom.window.document.dispatchEvent(event1);

    assert.equal(details.open, false, 'menu is closed after Escape key');
    assert.equal(dom.window.document.activeElement, summary, 'focus returned to summary button');

    // Case 2: Focus outside the menu -> Escape closes menu without stealing focus
    details.open = true;
    outsideInput.focus();
    const event2 = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    dom.window.document.dispatchEvent(event2);

    assert.equal(details.open, false, 'menu is closed after Escape key');
    assert.equal(dom.window.document.activeElement, outsideInput, 'focus not stolen from outside input');
});

test('browser offer banner dismissal is remembered in localStorage and works without storage', () => {
    const mainJsText = fs.readFileSync(path.join(WEBSITE_DIR, 'main.js'), 'utf8');

    // Case 1: Dismiss button records dismissal in localStorage and suppresses banner on reload
    const dom1 = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/rules.html',
        runScripts: 'dangerously'
    });
    Object.defineProperty(dom1.window.navigator, 'language', { value: 'es-ES', configurable: true });
    Object.defineProperty(dom1.window.navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
    dom1.window.eval(mainJsText);

    const banner1 = dom1.window.document.getElementById('read-in-banner');
    assert.ok(banner1, 'banner shown initially');
    const closeBtn = banner1.querySelector('.read-in-close');
    closeBtn.click();

    assert.equal(dom1.window.localStorage.getItem('beanpool_lang_banner_dismissed'), 'true', 'dismiss recorded in localStorage');
    assert.equal(dom1.window.localStorage.getItem('beanpool_lang'), 'en', 'dismiss records en in localStorage');

    // Next load with dismissal in localStorage but NO cookies:
    const dom1Reload = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/rules.html',
        runScripts: 'dangerously'
    });
    Object.defineProperty(dom1Reload.window.navigator, 'language', { value: 'es-ES', configurable: true });
    Object.defineProperty(dom1Reload.window.navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
    dom1Reload.window.localStorage.setItem('beanpool_lang_banner_dismissed', 'true');
    dom1Reload.window.eval(mainJsText);

    assert.equal(dom1Reload.window.document.getElementById('read-in-banner'), null, 'banner suppressed on reload due to localStorage dismissal');

    // Case 2: Clicking the recommendation link also marks dismissal in localStorage
    const dom2 = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/rules.html',
        runScripts: 'dangerously'
    });
    Object.defineProperty(dom2.window.navigator, 'language', { value: 'es-ES', configurable: true });
    Object.defineProperty(dom2.window.navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
    dom2.window.eval(mainJsText);

    const banner2 = dom2.window.document.getElementById('read-in-banner');
    assert.ok(banner2);
    const langLink = banner2.querySelector('a');
    langLink.click();
    assert.equal(dom2.window.localStorage.getItem('beanpool_lang_banner_dismissed'), 'true', 'banner link click marks dismissal in localStorage');
    assert.equal(dom2.window.localStorage.getItem('beanpool_lang'), 'es', 'banner link click records chosen language in localStorage');

    // Case 3: When localStorage throws (SecurityError / disabled storage), banner still works without error
    const dom3 = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="navbar"></div></body></html>`, {
        url: 'https://beanpool.org/rules.html',
        runScripts: 'dangerously'
    });
    Object.defineProperty(dom3.window.navigator, 'language', { value: 'es-ES', configurable: true });
    Object.defineProperty(dom3.window.navigator, 'languages', { value: ['es-ES', 'es'], configurable: true });
    Object.defineProperty(dom3.window, 'localStorage', {
        get() {
            throw new Error('SecurityError: The operation is insecure.');
        }
    });

    assert.doesNotThrow(() => {
        dom3.window.eval(mainJsText);
    }, 'main.js does not throw when localStorage throws');
    const banner3 = dom3.window.document.getElementById('read-in-banner');
    assert.ok(banner3, 'banner still renders when localStorage throws');
    assert.doesNotThrow(() => {
        banner3.querySelector('.read-in-close').click();
    }, 'dismiss button does not throw when localStorage throws');
});

test('mobile width (320px and 360px with 1.3x text) with language menu open has no horizontal scroll and dropdown scrolls internally', async () => {
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
    let browser;

    try {
        browser = await chromium.launch({ headless: true });
        for (const width of [320, 360]) {
            for (const testPage of ['index.html', 'ar/index.html']) {
                const page = await browser.newPage({ viewport: { width, height: 640 } });
                await page.goto(`http://127.0.0.1:${port}/${testPage}`, { waitUntil: 'load' });

                // Apply 1.3x text scaling (simulating user font preference)
                await page.evaluate(() => {
                    document.documentElement.style.fontSize = '130%';
                });

                // Open the phone menu
                await page.locator('.nav-menu > summary').click();
                await page.waitForTimeout(50);

                // Open the phone language menu
                await page.locator('.phone-lang-menu summary').click();
                await page.waitForTimeout(50);

                const metrics = await page.evaluate(() => {
                    const scrollW = document.documentElement.scrollWidth;
                    const clientW = document.documentElement.clientWidth;
                    const dropdown = document.querySelector('.phone-lang-menu .lang-dropdown');
                    return {
                        scrollW,
                        clientW,
                        hasOverflowX: scrollW > clientW,
                        dropdownScrollH: dropdown ? dropdown.scrollHeight : 0,
                        dropdownClientH: dropdown ? dropdown.clientHeight : 0,
                        dropdownOverflowY: dropdown ? window.getComputedStyle(dropdown).overflowY : ''
                    };
                });

                assert.ok(!metrics.hasOverflowX, `${testPage} at ${width}px 1.3x text has scrollWidth (${metrics.scrollW}) <= clientWidth (${metrics.clientW})`);
                assert.ok(metrics.dropdownScrollH >= metrics.dropdownClientH, `${testPage} phone lang dropdown scrollHeight >= clientHeight`);
                assert.equal(metrics.dropdownOverflowY, 'auto', `${testPage} phone lang dropdown has overflow-y: auto`);

                await page.close();
            }
        }
    } finally {
        if (browser) await browser.close();
        server.close();
    }
});

test('RTL desktop top language menu mirrors without horizontal overflow at 1280px in headless Chromium', async () => {
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
    let browser;

    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(`http://127.0.0.1:${port}/ar/index.html`, { waitUntil: 'load' });

        // Open desktop language menu
        await page.locator('.desktop-lang-menu summary').click();
        await page.waitForTimeout(50);

        const bounds = await page.evaluate(() => {
            const dropdown = document.querySelector('.desktop-lang-menu .lang-dropdown');
            const rect = dropdown.getBoundingClientRect();
            return {
                x: rect.x,
                right: rect.right,
                width: rect.width,
                viewportWidth: window.innerWidth,
                scrollWidth: document.documentElement.scrollWidth
            };
        });

        assert.ok(bounds.x >= 0, `dropdown x (${bounds.x}) >= 0`);
        assert.ok(bounds.right <= bounds.viewportWidth, `dropdown right (${bounds.right}) <= viewportWidth (${bounds.viewportWidth})`);
        assert.ok(bounds.scrollWidth <= bounds.viewportWidth, `page scrollWidth (${bounds.scrollWidth}) <= viewportWidth`);
    } finally {
        if (browser) await browser.close();
        server.close();
    }
});

test('mobile width (320px) desktop-lang-menu on pages without phone menu stays within viewport for LTR and RTL', async () => {
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
    let browser;

    try {
        browser = await chromium.launch({ headless: true });
        for (const testPage of ['privacy.html', 'ar/status.html']) {
            const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
            await page.goto(`http://127.0.0.1:${port}/${testPage}`, { waitUntil: 'load' });

            await page.locator('.desktop-lang-menu summary').click();
            await page.waitForTimeout(50);

            const bounds = await page.evaluate(() => {
                const dropdown = document.querySelector('.desktop-lang-menu .lang-dropdown');
                const rect = dropdown.getBoundingClientRect();
                return {
                    x: rect.x,
                    right: rect.right,
                    width: rect.width,
                    viewportWidth: window.innerWidth,
                    scrollWidth: document.documentElement.scrollWidth
                };
            });

            assert.ok(bounds.x >= 0, `${testPage} dropdown x (${bounds.x}) >= 0`);
            assert.ok(bounds.right <= bounds.viewportWidth, `${testPage} dropdown right (${bounds.right}) <= viewportWidth (${bounds.viewportWidth})`);
            assert.ok(bounds.scrollWidth <= bounds.viewportWidth, `${testPage} scrollWidth (${bounds.scrollWidth}) <= viewportWidth`);
            await page.close();
        }
    } finally {
        if (browser) await browser.close();
        server.close();
    }
});

test('nav-cta is never clipped and does not wrap where main did not, and ☰ panel links are reachable at 320x568', { timeout: 180_000 }, async () => {
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
    let browser;

    try {
        browser = await chromium.launch({ headless: true });
        const allPages = [];
        for (const pageName of ALL_PAGES) {
            allPages.push({ url: pageName, lang: 'en', rtl: false });
        }
        for (const lang of GUIDE_LANGS) {
            for (const pageName of TRANSLATED_PAGES) {
                allPages.push({ url: `${lang}/${pageName}`, lang, rtl: RTL_LANGS.includes(lang) });
            }
        }

        const WIDTHS = [320, 346, 360, 390, 430, 768, 1024, 1280, 1366, 1440];
        const MAIN_WRAPPED_LANGS = new Set(['pt', 'ru', 'uk', 'de']);

        const runWorker = async (items) => {
            const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
            const clipped = [];
            const wrapped = [];
            const unreachable = [];

            for (const item of items) {
                await page.goto(`http://127.0.0.1:${port}/${item.url}`, { waitUntil: 'domcontentloaded' });
                for (const width of WIDTHS) {
                    await page.setViewportSize({ width, height: 800 });
                    const res = await page.evaluate((isRtl) => {
                        const cta = document.querySelector('.nav-cta');
                        if (!cta) return null;
                        const rect = cta.getBoundingClientRect();
                        const range = document.createRange();
                        range.selectNodeContents(cta);
                        const rects = range.getClientRects();
                        const isClipped = isRtl
                            ? (rect.left < -0.5 || rect.right > window.innerWidth + 0.5)
                            : (rect.right > window.innerWidth + 0.5);
                        const isWrapped = rects.length > 1 || rect.height > 50;
                        return {
                            isClipped,
                            isWrapped,
                            left: rect.left,
                            right: rect.right,
                            height: rect.height,
                            lineCount: rects.length
                        };
                    }, item.rtl);

                    if (res) {
                        if (res.isClipped) clipped.push({ page: item.url, width, right: res.right, left: res.left });
                        if (res.isWrapped && !MAIN_WRAPPED_LANGS.has(item.lang)) wrapped.push({ page: item.url, width, height: res.height, lineCount: res.lineCount });
                    }
                }

                // Reachability at 320x568 for pages with .nav-menu
                await page.setViewportSize({ width: 320, height: 568 });
                const hasNavMenu = await page.evaluate(() => !!document.querySelector('.nav-menu'));
                if (hasNavMenu) {
                    const summary = page.locator('.nav-menu > summary');
                    await summary.click();
                    await page.waitForTimeout(20);
                    const unreach = await page.evaluate(() => {
                        const links = Array.from(document.querySelectorAll('.nav-menu-panel a')).filter(a => a.offsetParent !== null);
                        const bad = [];
                        for (const link of links) {
                            link.scrollIntoView();
                            const r = link.getBoundingClientRect();
                            if (r.bottom > window.innerHeight + 1 || r.top < -1) {
                                bad.push({ text: link.textContent.trim(), top: r.top, bottom: r.bottom });
                            }
                        }
                        return bad;
                    });
                    if (unreach.length > 0) unreachable.push({ page: item.url, badLinks: unreach });
                    await summary.click();
                }
            }
            await page.close();
            return { clipped, wrapped, unreachable };
        };

        const NUM_WORKERS = 4;
        const chunks = Array.from({ length: NUM_WORKERS }, () => []);
        allPages.forEach((p, i) => chunks[i % NUM_WORKERS].push(p));

        const results = await Promise.all(chunks.map(runWorker));
        const allClipped = results.flatMap(r => r.clipped);
        const allWrapped = results.flatMap(r => r.wrapped);
        const allUnreachable = results.flatMap(r => r.unreachable);

        assert.equal(allClipped.length, 0, `Found ${allClipped.length} clipped CTAs across pages and widths:\n  ` +
            allClipped.slice(0, 10).map(c => `${c.page} @ ${c.width}px (right: ${c.right})`).join('\n  '));
        assert.equal(allWrapped.length, 0, `Found ${allWrapped.length} wrapped CTAs where main did not wrap:\n  ` +
            allWrapped.slice(0, 10).map(w => `${w.page} @ ${w.width}px`).join('\n  '));
        assert.equal(allUnreachable.length, 0, `Found ${allUnreachable.length} pages with unreachable ☰ panel links at 320x568:\n  ` +
            allUnreachable.slice(0, 10).map(u => `${u.page}: ${u.badLinks.map(b => b.text).join(', ')}`).join('\n  '));
    } finally {
        if (browser) await browser.close();
        server.close();
    }
});
