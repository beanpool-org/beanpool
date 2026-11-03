// website-auth-bounce: the sign-in return pages (apps/website/auth/*.html and apps/pwa/public/auth/facebook.html) say what they
// are doing in the member's language (words-wire-2; scripts/website-build.mjs, "Sign-in return pages").
//
//   - the five pages are generated, in sync, and their English is word for word what it was;
//   - the English and ids the build reads from auth-bounce-words.ts are the words the words layer extracts;
//   - per language: the table has exactly the languages and sentences that have a translation; a missing sentence is left out;
//   - the page picks the member's own choice, else the browser's, as core's normaliseLang does, and ALWAYS still bounces to the app;
//   - a catalog that gained a translation fails --check until the pages are rebuilt.
//
// Run: node --test scripts/website-auth-bounce.test.mjs
// In memory: the pages' script runs in node:vm against a few fake browser objects; nothing is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { AUTH_PAGES, GUIDE_LANGS, LANGS, authTables, checkAuthPages, checkWebsite, readAuthWords, readCoreCatalogs, renderAuthPage } from './website-build.mjs';
import { extractFromSource, loadCoreChecks } from './words/words.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const WORDS = readAuthWords();

// ── The five pages as they stand ────────────────────────────────────────────────────────────────────────────────

test('the five pages are exactly what the build writes, and --check says so', () => {
    assert.deepEqual(checkAuthPages(), []);
    assert.deepEqual(checkWebsite().filter((e) => /auth/.test(e)), []);
    assert.equal(AUTH_PAGES.length, 5);
    for (const page of AUTH_PAGES) assert.ok(fs.existsSync(path.join(REPO_ROOT, page.out)), page.out);
});

test('the English of every page is word for word what it was before the pages were generated', () => {
    const was = {
        google: "Connecting your Google sign-in. If you aren't redirected automatically, tap the button below:",
        facebook: "Connecting your Facebook authentication. If you aren't redirected automatically, tap the button below:",
        instagram: "Connecting your Instagram authentication. If you aren't redirected automatically, tap the button below:",
        tiktok: "Connecting your TikTok authentication. If you aren't redirected automatically, tap the button below:",
    };
    for (const page of AUTH_PAGES) {
        const html = read(page.out);
        assert.match(html, /<html lang="en">/);
        assert.match(html, /<title data-w="title">Connecting to BeanPool\.\.\.<\/title>/, page.out);
        assert.match(html, /<h2 data-w="heading">Returning to BeanPool\.\.\.<\/h2>/, page.out);
        assert.ok(html.includes(`<p data-w="${page.message}">${was[page.id]}</p>`), `${page.out}: the sentence`);
        assert.match(html, /<a id="open-app" class="btn" href="#" data-w="open">Open BeanPool<\/a>/, page.out);
        // The bounce itself is unchanged: the app's address, with the provider's answer carried along.
        assert.ok(html.includes(`const appUrl = 'beanpool://auth/${page.id}' + search + hash;`), `${page.out}: the redirect`);
        assert.ok(html.includes('window.location.replace(appUrl);'), page.out);
    }
    // The web app's own page and beanpool.org's Facebook page are one page.
    assert.equal(read('apps/pwa/public/auth/facebook.html'), read('apps/website/auth/facebook.html'));
});

test("the build reads the same English and ids that the words layer extracts from auth-bounce-words.ts", () => {
    const source = read('packages/beanpool-core/src/auth-bounce-words.ts');
    const calls = extractFromSource('packages/beanpool-core/src/auth-bounce-words.ts', source).calls;
    assert.deepEqual(calls.map((c) => c.fn), ['word', 'word', 'word', 'word', 'word']);
    assert.deepEqual(calls.map((c) => c.text).sort(), Object.values(WORDS).sort());
    assert.deepEqual(Object.keys(WORDS).sort(), ['authentication', 'heading', 'open', 'signIn', 'title']);
    assert.ok(Object.values(WORDS).every((s) => !/\{(?!provider\})/.test(s)), 'only {provider} is a placeholder');
});

// ── Per language ────────────────────────────────────────────────────────────────────────────────────────────────

/** A catalog set that translates every sentence for each of `langs`, as `<lang>: <English>` so a test can tell them apart. */
const catalogsFor = (langs, only = Object.keys(WORDS)) => Object.fromEntries(langs.map((lang) => [lang,
    Object.fromEntries(only.map((id) => [WORDS[id], WORDS[id].replace(/BeanPool|Connecting|Returning|Open/g, (m) => `${lang}:${m}`)]))]));

test('the table holds exactly the languages and sentences that have a translation; a missing one is left out', () => {
    assert.deepEqual(authTables(WORDS, {}), {});
    assert.deepEqual(authTables(WORDS, { es: { 'Some other sentence': 'x' } }), {});
    const tables = authTables(WORDS, {
        es: { [WORDS.open]: 'Abrir BeanPool', [WORDS.heading]: 'Volviendo a BeanPool...' },
        ar: { [WORDS.open]: '   ' },
        fr: { [WORDS.open]: 3 },
        ja: { [WORDS.signIn]: '{provider} のサインインを接続しています。' },
    });
    assert.deepEqual(tables, {
        es: { heading: 'Volviendo a BeanPool...', open: 'Abrir BeanPool' },
        ja: { signIn: '{provider} のサインインを接続しています。' },
    });
});

test('the real catalogs, today: no language has these sentences yet, so every page carries an empty table and shows English', () => {
    const catalogs = readCoreCatalogs();
    assert.deepEqual(Object.keys(catalogs).sort(), [...GUIDE_LANGS].sort());
    const tables = authTables(WORDS, catalogs);
    for (const page of AUTH_PAGES) {
        const html = read(page.out);
        const m = /var WORDS = (\{.*\});/.exec(html);
        assert.ok(m, page.out);
        assert.deepEqual(JSON.parse(m[1]), tables, `${page.out} carries the catalogs' translations of its sentences`);
    }
});

test('each page is built with a table per translated language; a translation containing </script> cannot end the script early', () => {
    const nasty = { ...catalogsFor(['es', 'ar', 'zh-Hant']), de: { [WORDS.open]: '</script><img src=x onerror=alert(1)>' } };
    for (const page of AUTH_PAGES) {
        const html = renderAuthPage(page, { catalogs: nasty });
        assert.equal(html.split('</script>').length - 1, 1, `${page.out}: one closing script tag`);
        const m = /var WORDS = (\{.*\});/.exec(html);
        const table = JSON.parse(m[1]);
        assert.deepEqual(Object.keys(table).sort(), ['ar', 'de', 'es', 'zh-Hant']);
        assert.deepEqual(Object.keys(table.es).sort(), ['authentication', 'heading', 'open', 'signIn', 'title']);
        assert.equal(table.de.open, '</script><img src=x onerror=alert(1)>');
        assert.ok(!html.includes('<img src=x'), 'the markup in a translation is never in the page as markup');
        // The English the page starts with does not depend on the catalogs.
        assert.equal(html.replace(/var WORDS = \{.*\};/, ''), renderAuthPage(page, { catalogs: {} }).replace(/var WORDS = \{.*\};/, ''));
    }
});

test('a translation that looks like a placeholder is put in the page as written, once', () => {
    const odd = { es: { [WORDS.open]: 'Abrir {{PROVIDER_ID}} {{TITLE}} $& $1' } };
    const html = renderAuthPage(google, { catalogs: odd });
    const table = JSON.parse(/var WORDS = (\{.*\});/.exec(html)[1]);
    assert.equal(table.es.open, 'Abrir {{PROVIDER_ID}} {{TITLE}} $& $1');
    // And no placeholder of the template is left unfilled anywhere else.
    assert.equal(html.replace(/var WORDS = \{.*\};/, '').includes('{{'), false);
});

test('a catalog that gained a translation fails --check until the pages are rebuilt', () => {
    const errors = checkAuthPages({ catalogs: catalogsFor(['es']) });
    assert.equal(errors.length, 5);
    for (const e of errors) assert.match(e, /is out of sync .*run 'node scripts\/website-build\.mjs'/);
});

// ── The page, run ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Opens a built page's script against fake browser objects: the elements the script writes to, the member's stored choice,
 * the browser's languages. Returns what the member would see and where the page sent them.
 */
function open(html, { languages = [], language, stored = {}, cookie = '', storageThrows = false, search = '?code=abc&state=xyz', hash = '#id_token=t', noNavigator = false } = {}) {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    const nodes = [...html.matchAll(/<(title|h2|p|a)\b[^>]*data-w="([^"]+)"[^>]*>([^<]*)</g)].map((m) => ({
        tag: m[1], id: m[2], textContent: m[3].replace(/&amp;/g, '&'), getAttribute: (n) => (n === 'data-w' ? m[2] : null),
    }));
    const link = { href: '#' };
    const root = { lang: 'en', dir: '' };
    const replaced = [];
    const sandbox = {
        window: {
            location: { search, hash, replace: (url) => replaced.push(url) },
            localStorage: { getItem: (k) => { if (storageThrows) throw new Error('blocked'); return stored[k] ?? null; } },
        },
        document: {
            documentElement: root, cookie,
            querySelectorAll: (sel) => (sel === '[data-w]' ? nodes : []),
            getElementById: (id) => (id === 'open-app' ? link : null),
        },
        navigator: noNavigator ? undefined : { languages, language },
    };
    vm.runInNewContext(script, sandbox);
    const text = (id) => nodes.find((n) => n.id === id).textContent;
    return { text, root, link, replaced, nodes };
}

const google = AUTH_PAGES.find((p) => p.id === 'google');
const tiktok = AUTH_PAGES.find((p) => p.id === 'tiktok');
const withTables = (page, catalogs) => renderAuthPage(page, { catalogs });

test("the page speaks the browser's language when it has the words, with the provider's name filled in, and says so in <html lang>", () => {
    const html = withTables(google, catalogsFor(['es', 'zh-Hant']));
    const seen = open(html, { languages: ['es-MX', 'en-US'], language: 'es-MX' });
    assert.equal(seen.text('title'), 'es:Connecting to es:BeanPool...');
    assert.equal(seen.text('heading'), 'es:Returning to es:BeanPool...');
    assert.equal(seen.text('signIn'), "es:Connecting your Google sign-in. If you aren't redirected automatically, tap the button below:");
    assert.equal(seen.text('open'), 'es:Open es:BeanPool');
    assert.equal(seen.root.lang, 'es');
    assert.equal(seen.root.dir, '');
});

test("the member's own choice wins over the browser's: the web app's beanpool-language, beanpool.org's beanpool_lang and its cookie", () => {
    const html = withTables(tiktok, catalogsFor(['es', 'fr', 'ru']));
    assert.equal(open(html, { languages: ['es'], stored: { 'beanpool-language': 'fr' } }).root.lang, 'fr');
    assert.equal(open(html, { languages: ['es'], stored: { beanpool_lang: 'ru' } }).root.lang, 'ru');
    assert.equal(open(html, { languages: ['es'], cookie: 'a=b; beanpool_lang=ru; c=d' }).root.lang, 'ru');
    // An explicit English stays English, whatever the browser says.
    const english = open(html, { languages: ['es'], stored: { 'beanpool-language': 'en' } });
    assert.equal(english.root.lang, 'en');
    assert.equal(english.text('open'), 'Open BeanPool');
    // A stored language with no words yet is English (as the web app would show it in German with no German words here).
    assert.equal(open(html, { languages: ['es'], stored: { 'beanpool-language': 'de' } }).text('open'), 'Open BeanPool');
    // Storage that throws (private mode) falls back to the browser.
    assert.equal(open(html, { languages: ['es'], storageThrows: true }).root.lang, 'es');
});

test('a sentence a language has not translated stays English beside the ones it has; a language with no words stays English', () => {
    const html = withTables(google, catalogsFor(['ar'], ['heading']));
    const seen = open(html, { languages: ['ar-EG'] });
    assert.equal(seen.text('heading'), 'ar:Returning to ar:BeanPool...');
    assert.equal(seen.text('open'), 'Open BeanPool');
    assert.equal(seen.text('signIn'), "Connecting your Google sign-in. If you aren't redirected automatically, tap the button below:");
    assert.equal(seen.root.dir, 'rtl');
    const german = open(withTables(google, catalogsFor(['es'])), { languages: ['de-DE'] });
    assert.equal(german.text('heading'), 'Returning to BeanPool...');
    assert.equal(german.root.lang, 'en');
    assert.equal(german.root.dir, '');
});

test('the page picks the language as core\'s normaliseLang does, for every tag a device sends', async () => {
    const { normaliseLang } = await loadCoreChecks();
    const html = withTables(google, catalogsFor(GUIDE_LANGS));
    const tags = ['es', 'es-MX', 'pt_BR', 'PT-br', 'zh', 'zh-CN', 'zh-SG', 'zh-Hans-HK', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh_CN_#Hans', 'in-ID', 'iw-IL',
        'tl', 'fil-PH', 'ru-RU', 'EN-us', 'de-CH', 'ja-JP', 'ko-KR', 'xx', 'x', '', 'tlh', 'ar-SA', 'fa-IR', 'ur-PK', 'sw-KE', 'ml-IN', 'ta-IN', 'uk-UA', 'vi-VN', 'el-GR', 'hi-IN', 'bn-BD', 'it-IT', 'tr-TR', 'id-ID', 'fr-CA'];
    for (const tag of tags) {
        const want = normaliseLang(tag);
        const seen = open(html, { languages: [tag], language: tag });
        assert.equal(seen.root.lang, want && want !== 'en' ? want : 'en', `browser language "${tag}"`);
    }
    // The first language BeanPool writes in the browser's order, not just the first tag.
    assert.equal(open(html, { languages: ['xx', 'tlh', 'it-IT', 'es'] }).root.lang, 'it');
    assert.equal(LANGS.length, 25);
});

test('the page ALWAYS bounces to the app with the provider\'s answer: with words, with none, and when the picker itself fails', () => {
    for (const page of AUTH_PAGES) {
        for (const catalogs of [{}, catalogsFor(['es', 'ar'])]) {
            const html = renderAuthPage(page, { catalogs });
            for (const options of [{ languages: ['es'] }, { languages: [] }, { noNavigator: true }, { languages: ['ar'], storageThrows: true }]) {
                const seen = open(html, { ...options, search: '?code=1&state=2', hash: '#access_token=3' });
                const want = `beanpool://auth/${page.id}?code=1&state=2#access_token=3`;
                assert.deepEqual(seen.replaced, [want], `${page.out}: bounced once`);
                assert.equal(seen.link.href, want, `${page.out}: the button points at the app`);
            }
        }
    }
    // No navigator at all: the English stays and nothing throws out of the page.
    const seen = open(renderAuthPage(google, { catalogs: catalogsFor(['es']) }), { noNavigator: true });
    assert.equal(seen.text('open'), 'Open BeanPool');
});
