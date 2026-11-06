// The busy page Worker (apps/busy-worker/src/index.js): what it answers, what it never touches, and the page itself.
//
//   node --test test/busy-worker.test.js        (from apps/busy-worker; the colour checks read @beanpool/core's dist:
//                                               build core first, pnpm --filter @beanpool/core build)
//
// No network: the origin is a fake passed to handle(), and the real fetch is replaced by one that fails the test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import worker, { handle, isPageRequest, hasOwnCookie, ORIGIN_TIMEOUT_MS, RETRY_AFTER_S } from '../src/index.js';
import { busyPage, pickLanguage, siteLinks, LANGUAGES, RTL_LANGUAGES, STYLE } from '../src/busy-page.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ROOT = path.resolve(APP, '../..');
const WORDS = JSON.parse(fs.readFileSync(path.join(APP, 'src/words.json'), 'utf8'));

const URL_ = 'https://global.beanpool.org/';
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const SHORT = 40; // the timeout the tests use, so a "hung" origin costs 40 ms, not 5 s

let realFetch;
before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = () => {
        throw new Error('the test reached the network: every origin must be a fake');
    };
});
after(() => {
    globalThis.fetch = realFetch;
});

/** A browser asking for a page. */
function pageRequest(headers = {}, init = {}) {
    return new Request(init.url ?? URL_, { method: 'GET', ...init, headers: { accept: BROWSER_ACCEPT, ...headers } });
}

/** A fake origin answering `status` (and recording what it was asked). */
function origin(status, body = `origin ${status}`, headers = { 'content-type': 'text/html' }) {
    const calls = [];
    const fn = async (request, init) => {
        calls.push({ request, init });
        return new Response(status === 204 || status === 304 ? null : body, { status, headers });
    };
    fn.calls = calls;
    return fn;
}

/** A fake origin that never answers until its request is aborted. */
function hungOrigin() {
    const calls = [];
    const fn = (request, init) => {
        calls.push({ request, init });
        return new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
    };
    fn.calls = calls;
    return fn;
}

function assertBusy(res) {
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), String(RETRY_AFTER_S));
    assert.equal(res.headers.get('retry-after'), '120');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-type'), /^text\/html; charset=utf-8$/);
    assert.equal(res.headers.get('x-beanpool-busy'), '1');
}

// ---------------------------------------------------------------------------------------------------------------------
// A page request: the busy page when the origin fails, the origin's answer otherwise.

test('the timeout is 5 s and the retry is 120 s', () => {
    assert.equal(ORIGIN_TIMEOUT_MS, 5000);
    assert.equal(RETRY_AFTER_S, 120);
});

for (const status of [500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]) {
    test(`a page request whose origin answers ${status} gets the busy page`, async () => {
        const res = await handle(pageRequest(), {}, { fetchImpl: origin(status), timeoutMs: SHORT });
        assertBusy(res);
        const html = await res.text();
        assert.match(html, /The global community is very busy right now/);
        assert.doesNotMatch(html, new RegExp(`origin ${status}`));
    });
}

test('a page request whose origin gives no headers in time gets the busy page, and the origin request is aborted', async () => {
    const fake = hungOrigin();
    const started = Date.now();
    const res = await handle(pageRequest(), {}, { fetchImpl: fake, timeoutMs: SHORT });
    assertBusy(res);
    assert.ok(Date.now() - started < 2000, 'answered at the timeout, not later');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].init.signal.aborted, true);
});

test('the real timeout: a hung origin is cut off at 5 s (fake timers)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = hungOrigin();
    const pending = handle(pageRequest(), {}, { fetchImpl: fake });
    await Promise.resolve();
    t.mock.timers.tick(4999);
    await Promise.resolve();
    assert.equal(fake.calls[0].init.signal.aborted, false, 'still waiting at 4.999 s');
    t.mock.timers.tick(1);
    assertBusy(await pending);
});

test('a page request whose origin cannot be reached at all (fetch throws) gets the busy page', async () => {
    const res = await handle(pageRequest(), {}, {
        fetchImpl: async () => {
            throw new TypeError('network connection lost');
        },
        timeoutMs: SHORT,
    });
    assertBusy(res);
});

for (const status of [200, 301, 302, 304, 404, 429]) {
    test(`a page request whose origin answers ${status} gets the origin's answer unchanged`, async () => {
        const fake = origin(status, `<!DOCTYPE html><p>the node's own page ${status}</p>`, { 'content-type': 'text/html', 'x-from-origin': 'yes', etag: '"abc"' });
        const res = await handle(pageRequest(), {}, { fetchImpl: fake, timeoutMs: SHORT });
        assert.equal(res.status, status);
        assert.equal(res.headers.get('x-from-origin'), 'yes');
        assert.equal(res.headers.get('etag'), '"abc"');
        assert.equal(res.headers.get('x-beanpool-busy'), null);
        if (status !== 304) assert.equal(await res.text(), `<!DOCTYPE html><p>the node's own page ${status}</p>`);
        assert.equal(fake.calls.length, 1);
        assert.equal(fake.calls[0].request.url, URL_);
    });
}

test('a slow body after the headers is never cut off: the timer stops when the headers arrive', async () => {
    let signal;
    const res = await handle(pageRequest(), {}, {
        fetchImpl: async (_req, init) => {
            signal = init.signal;
            const stream = new ReadableStream({
                async start(controller) {
                    await new Promise((r) => setTimeout(r, SHORT * 3));
                    controller.enqueue(new TextEncoder().encode('late body'));
                    controller.close();
                },
            });
            return new Response(stream, { status: 200 });
        },
        timeoutMs: SHORT,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'late body');
    assert.equal(signal.aborted, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Everything that is not a browser asking for a page passes straight through, even when the origin fails.

const PASS_THROUGH = [
    ['an API GET (JSON)', () => new Request(`${URL_}api/marketplace/posts`, { headers: { accept: 'application/json' } })],
    ['a GET with no Accept', () => new Request(`${URL_}api/version`)],
    ['a GET for anything (*/*), as fetch() sends', () => new Request(`${URL_}assets/index.js`, { headers: { accept: '*/*' } })],
    ['an image', () => new Request(`${URL_}avatars/a.png`, { headers: { accept: 'image/avif,image/webp,*/*' } })],
    ['a POST that accepts HTML', () => new Request(`${URL_}api/join`, { method: 'POST', body: '{"a":1}', headers: { accept: BROWSER_ACCEPT, 'content-type': 'application/json' } })],
    ['a PUT', () => new Request(`${URL_}api/profile`, { method: 'PUT', body: '{}', headers: { accept: BROWSER_ACCEPT } })],
    ['a HEAD that accepts HTML', () => new Request(URL_, { method: 'HEAD', headers: { accept: BROWSER_ACCEPT } })],
    ['a socket upgrade that accepts HTML', () => pageRequest({ upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' })],
    ['a socket handshake with no Upgrade header left', () => pageRequest({ 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' })],
    ['a signed page GET (x-signature)', () => pageRequest({ 'x-public-key': 'ab'.repeat(32), 'x-signature': 'cd'.repeat(64), 'x-timestamp': '1', 'x-nonce': 'n' })],
    ['a page GET with only x-signature', () => pageRequest({ 'x-signature': 'cd'.repeat(64) })],
    ['a page GET with only x-public-key', () => pageRequest({ 'x-public-key': 'ab'.repeat(32) })],
    ['a page GET signed for someone (x-signed-for)', () => pageRequest({ 'x-signed-for': 'ab'.repeat(32) })],
    ['a page GET signed the registrar way (x-bp-signature)', () => pageRequest({ 'x-bp-pubkey': 'ab', 'x-bp-signature': 'cd', 'x-bp-timestamp': '1' })],
    ['a page GET with Authorization', () => pageRequest({ authorization: 'Bearer something' })],
    ['a page GET with a session cookie', () => pageRequest({ cookie: 'session=abc123' })],
    ['a page GET with a session cookie among Cloudflare ones', () => pageRequest({ cookie: 'cf_clearance=x; sid=abc; __cf_bm=y' })],
];

for (const [name, make] of PASS_THROUGH) {
    for (const status of [502, 530, 200]) {
        test(`${name} passes straight through (origin ${status})`, async () => {
            const req = make();
            const fake = origin(status, 'from the origin', { 'content-type': 'application/json' });
            const res = await handle(req, {}, { fetchImpl: fake, timeoutMs: SHORT });
            assert.equal(fake.calls.length, 1);
            assert.equal(fake.calls[0].request, req, 'the very same Request object');
            assert.equal(fake.calls[0].init, undefined, 'nothing added: no signal, no timeout');
            assert.equal(res.status, status);
            assert.equal(res.headers.get('x-beanpool-busy'), null);
            if (req.method !== 'HEAD') assert.equal(await res.text(), 'from the origin');
        });
    }
    test(`${name} passes straight through even with BUSY_FORCE=1`, async () => {
        const req = make();
        const fake = origin(200, 'from the origin');
        const res = await handle(req, { BUSY_FORCE: '1' }, { fetchImpl: fake, timeoutMs: SHORT });
        assert.equal(fake.calls[0].request, req);
        assert.equal(res.status, 200);
    });
    test(`${name} is not a page request`, () => {
        assert.equal(isPageRequest(make()), false);
    });
}

test("a hung origin on a passed-through request is not timed out by the Worker: the origin's own wait stands", async () => {
    const fake = hungOrigin();
    const req = new Request(`${URL_}api/version`, { headers: { accept: 'application/json' } });
    const outcome = await Promise.race([
        handle(req, {}, { fetchImpl: fake, timeoutMs: SHORT }).then(() => 'answered'),
        new Promise((r) => setTimeout(() => r('still waiting'), SHORT * 4)),
    ]);
    assert.equal(outcome, 'still waiting');
    assert.equal(fake.calls[0].init, undefined);
});

test("Cloudflare's own cookies are no session: a visitor past a challenge still gets the busy page", async () => {
    assert.equal(hasOwnCookie('cf_clearance=abc; __cf_bm=def; _cfuvid=ghi; __cflb=jkl'), false);
    assert.equal(hasOwnCookie(''), false);
    assert.equal(hasOwnCookie(null), false);
    assert.equal(hasOwnCookie('cf_clearance=abc; theme=dark'), true);
    const res = await handle(pageRequest({ cookie: 'cf_clearance=abc; __cf_bm=def' }), {}, { fetchImpl: origin(522), timeoutMs: SHORT });
    assertBusy(res);
});

test('a page request is a GET accepting text/html with nothing of a member on it', () => {
    assert.equal(isPageRequest(pageRequest()), true);
    assert.equal(isPageRequest(pageRequest({ accept: 'TEXT/HTML' })), true);
    assert.equal(isPageRequest(pageRequest({ accept: 'application/json' })), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// The switches.

test('BUSY_FORCE=1 answers the busy page to a page request without asking the origin', async () => {
    const fake = origin(200);
    for (const on of ['1', 'true', ' 1 ']) {
        const res = await handle(pageRequest(), { BUSY_FORCE: on }, { fetchImpl: fake, timeoutMs: SHORT });
        assertBusy(res);
    }
    assert.equal(fake.calls.length, 0);
});

test('BUSY_OFF=1 hands every request to the origin untouched, the page request and its 5xx included', async () => {
    for (const status of [500, 522, 200]) {
        const req = pageRequest();
        const fake = origin(status, 'origin page');
        const res = await handle(req, { BUSY_OFF: '1' }, { fetchImpl: fake, timeoutMs: SHORT });
        assert.equal(fake.calls[0].request, req);
        assert.equal(fake.calls[0].init, undefined);
        assert.equal(res.status, status);
        assert.equal(await res.text(), 'origin page');
    }
});

test('BUSY_OFF wins over BUSY_FORCE', async () => {
    const fake = origin(200, 'origin page');
    const res = await handle(pageRequest(), { BUSY_OFF: '1', BUSY_FORCE: '1' }, { fetchImpl: fake, timeoutMs: SHORT });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'origin page');
});

test('a switch set to anything but 1 or true is off', async () => {
    for (const value of ['0', '', 'false', 'no', undefined]) {
        const fake = origin(200, 'origin page');
        const res = await handle(pageRequest(), { BUSY_FORCE: value, BUSY_OFF: value }, { fetchImpl: fake, timeoutMs: SHORT });
        assert.equal(res.status, 200, `BUSY_FORCE=${value}`);
    }
});

test("wrangler.toml ships both switches off and the route global.beanpool.org/*", () => {
    const toml = fs.readFileSync(path.join(APP, 'wrangler.toml'), 'utf8');
    assert.match(toml, /^BUSY_FORCE = "0"$/m);
    assert.match(toml, /^BUSY_OFF = "0"$/m);
    assert.match(toml, /^pattern = "global\.beanpool\.org\/\*"$/m);
    assert.match(toml, /^main = "src\/index\.js"$/m);
});

test("the Worker's fetch entry is handle()", async () => {
    const res = await worker.fetch(pageRequest(), { BUSY_FORCE: '1' });
    assertBusy(res);
});

// ---------------------------------------------------------------------------------------------------------------------
// The page: self-contained, small screens, BeanPool's colours, the visitor's language.

test('the page makes no request of its own: no script, no stylesheet, no font, no image, and a policy that forbids them', async () => {
    const res = await handle(pageRequest(), { BUSY_FORCE: '1' });
    const html = await res.text();
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<img|<iframe|<object|<embed|<video|<audio|<source|<form/i);
    assert.doesNotMatch(html, /\ssrc\s*=/i);
    assert.doesNotMatch(html, /url\(|@import|@font-face/i);
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    assert.deepEqual(links, ['<link rel="icon" href="data:,">'], 'the only <link> is the empty icon');
    // Every href is a link a visitor may follow to beanpool.org, or the empty icon: nothing loads by itself.
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
        assert.ok(href === 'data:,' || href.startsWith('https://beanpool.org/'), href);
    }
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /https?:|\*/);
    assert.ok(Buffer.byteLength(html) < 8 * 1024, `small: ${Buffer.byteLength(html)} bytes`);
});

test('the page fits 320 px at 130 % text: a viewport, no fixed widths, words that wrap', () => {
    const { html } = busyPage('en');
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    // No width of any kind in an absolute length: every width is a %, or a max-width in rem that only caps.
    for (const m of STYLE.matchAll(/(?:^|[;{\s])((?:min-|max-)?width)\s*:\s*([^;]+);/g)) {
        const [, prop, value] = m;
        if (prop === 'max-width') assert.match(value.trim(), /^\d+(?:\.\d+)?rem$/, `${prop}: ${value}`);
        else assert.match(value.trim(), /^100%$/, `${prop}: ${value}`);
    }
    assert.doesNotMatch(STYLE, /\b\d{3,}px\b/, 'no pixel size of 100 or more');
    assert.doesNotMatch(STYLE, /nowrap|overflow\s*:\s*hidden|position\s*:\s*(?:fixed|absolute)/);
    assert.match(STYLE, /overflow-wrap: anywhere/);
    // Text sizes in rem, so a phone's larger text setting scales them.
    for (const m of STYLE.matchAll(/font-size\s*:\s*([^;]+);/g)) assert.match(m[1].trim(), /^\d+(?:\.\d+)?rem$/);
});

/** The library's values, as website-colours.test.mjs reads them. */
async function library() {
    const core = path.join(ROOT, 'packages/beanpool-core/dist/brand-colours.js');
    if (!fs.existsSync(core)) throw new Error(`${core} is missing: build @beanpool/core first (pnpm --filter @beanpool/core build)`);
    return import(pathToFileURL(core).href);
}

function block(css, start) {
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
        if (css[i] === '{') depth++;
        if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
    }
    throw new Error('unbalanced braces');
}

function vars(css) {
    const out = {};
    for (const m of css.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6});\s*\/\*\s*([a-z.]+)\s*\*\//g)) out[m[1]] = { value: m[2].toLowerCase(), tag: m[3] };
    return out;
}

function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

test("the page's colours are the brand library's roles, in both themes, and its words read 4.5:1 or better", async () => {
    const { brandColours, WEB_INK_GROUNDS } = await library();
    const media = STYLE.indexOf('@media (prefers-color-scheme: light)');
    const themes = {
        dark: vars(block(STYLE, STYLE.indexOf(':root {'))),
        light: vars(block(block(STYLE, media), block(STYLE, media).indexOf(':root {'))),
    };
    const NAMES = ['--page', '--card', '--heading', '--text', '--cta', '--cta-hover', '--on-cta', '--second', '--note-tint', '--note-ink', '--muted'];
    for (const [theme, set] of Object.entries(themes)) {
        assert.deepEqual(Object.keys(set).sort(), [...NAMES].sort(), `${theme}: every colour is a tagged variable`);
        const lib = brandColours(theme);
        for (const [name, { value, tag }] of Object.entries(set)) {
            if (tag === 'ground') {
                assert.ok(WEB_INK_GROUNDS[theme].includes(value), `${theme} ${name} ${value} is not one of the web's ${theme} grounds`);
                continue;
            }
            const want = tag.split('.').reduce((node, key) => node?.[key], lib);
            assert.equal(typeof want, 'string', `${theme} ${name}: no role ${tag}`);
            assert.equal(value, want.toLowerCase(), `${theme} ${name} names ${tag} (${want}) but is ${value}`);
        }
        const c = (n) => set[n].value;
        for (const [ink, ground] of [
            ['--heading', '--card'],
            ['--text', '--card'],
            ['--on-cta', '--cta'],
            ['--on-cta', '--cta-hover'],
            ['--second', '--card'],
            ['--note-ink', '--note-tint'],
            ['--muted', '--card'],
        ]) {
            const ratio = contrast(c(ink), c(ground));
            assert.ok(ratio >= 4.5, `${theme}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1`);
        }
    }
    // No colour anywhere else in the style but the two variable sets.
    const rules = STYLE.replace(block(STYLE, STYLE.indexOf(':root {')), '').replace(block(STYLE, media), '');
    assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
});

/** The website's 25 languages, read from scripts/website-build.mjs. */
function websiteLanguages() {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/website-build.mjs'), 'utf8');
    const list = src.match(/GUIDE_LANGS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1];
    return ['en', ...[...list.matchAll(/'([^']+)'/g)].map((m) => m[1])];
}

test("words.json speaks the website's 25 languages, each with every sentence, the drafts labelled", () => {
    const site = websiteLanguages();
    assert.equal(site.length, 25);
    assert.deepEqual([...LANGUAGES].sort(), [...site].sort());
    const KEYS = ['heading', 'body', 'start', 'find', 'apps'];
    assert.deepEqual(Object.keys(WORDS.en).sort(), [...KEYS].sort(), 'English is the source and carries no draft label');
    for (const lang of LANGUAGES) {
        for (const key of KEYS) assert.ok(typeof WORDS[lang][key] === 'string' && WORDS[lang][key].trim() !== '', `${lang}.${key}`);
        if (lang !== 'en') {
            assert.ok(WORDS[lang].machine?.trim(), `${lang}: a machine draft carries its label`);
            assert.deepEqual(Object.keys(WORDS[lang]).sort(), [...KEYS, 'machine'].sort(), lang);
            // Each draft names BeanPool in the apps sentence, as the English does.
            assert.match(WORDS[lang].apps, /BeanPool/, lang);
        }
        const { html } = busyPage(lang);
        assert.match(html, new RegExp(`<html lang="${lang}" dir="${RTL_LANGUAGES.includes(lang) ? 'rtl' : 'ltr'}">`));
        assert.ok(html.includes(WORDS[lang].heading));
        if (lang !== 'en') assert.ok(html.includes(`<p class="draft">${WORDS[lang].machine.replace(/'/g, '&#39;')}</p>`), `${lang}: the label shows`);
        else assert.doesNotMatch(html, /class="draft"/);
    }
});

test('the links go to the start page and the communities map, in the visitor\'s language, and each page exists on the site', () => {
    assert.deepEqual(siteLinks('en'), { start: 'https://beanpool.org/start', find: 'https://beanpool.org/#find-or-start' });
    assert.deepEqual(siteLinks('fr'), { start: 'https://beanpool.org/fr/start', find: 'https://beanpool.org/fr/#find-or-start' });
    for (const lang of LANGUAGES) {
        const dir = path.join(ROOT, 'apps/website', lang === 'en' ? '' : lang);
        assert.ok(fs.existsSync(path.join(dir, 'start.html')), `${lang}: start.html`);
        assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /id="find-or-start"/, `${lang}: the map's anchor`);
        const { html } = busyPage(lang);
        const links = siteLinks(lang);
        assert.ok(html.includes(`href="${links.start}"`) && html.includes(`href="${links.find}"`), lang);
    }
});

test("Accept-Language picks the visitor's best language of ours, English when none fits", () => {
    const cases = [
        [undefined, 'en'],
        ['', 'en'],
        ['*', 'en'],
        ['en-AU,en;q=0.9', 'en'],
        ['fr-CA,fr;q=0.9,en;q=0.8', 'fr'],
        ['nl-NL, de;q=0.5', 'de'],
        ['en;q=0.1, ja', 'ja'],
        ['es;q=0, pt-BR;q=0.4', 'pt'],
        ['zh-CN', 'zh-Hans'],
        ['zh', 'zh-Hans'],
        ['zh-TW', 'zh-Hant'],
        ['zh-HK,zh;q=0.9', 'zh-Hant'],
        ['zh-Hant-TW', 'zh-Hant'],
        ['ZH-HANS', 'zh-Hans'],
        ['tl-PH', 'fil'],
        ['fil', 'fil'],
        ['ar-EG', 'ar'],
        ['xx-YY, qq', 'en'],
        ['de;q=abc, fr;q=0.2', 'fr'],
        [`${'x-'.repeat(2000)}, de`, 'en'],
    ];
    for (const [header, want] of cases) assert.equal(pickLanguage(header), want, String(header));
});

test('the busy response carries the language it chose', async () => {
    const res = await handle(pageRequest({ 'accept-language': 'ar,en;q=0.5' }), {}, { fetchImpl: origin(502), timeoutMs: SHORT });
    assertBusy(res);
    assert.equal(res.headers.get('content-language'), 'ar');
    const html = await res.text();
    assert.match(html, /<html lang="ar" dir="rtl">/);
    assert.ok(html.includes(WORDS.ar.heading));
    assert.ok(html.includes('https://beanpool.org/ar/start'));
});

test('the English page says what the brief asks, in plain words', () => {
    const { html } = busyPage(undefined);
    for (const words of ['The global community is very busy right now', 'try again in a few minutes', 'Start your own community', 'Find one near you', 'BeanPool app', 'keeps working']) {
        assert.ok(html.includes(words), words);
    }
});

test('never the two words the project bans (resilien…, surviv…), in any file here', () => {
    const files = ['src/words.json', 'src/busy-page.js', 'src/index.js', 'README.md', 'wrangler.toml', 'scripts/deploy.sh'];
    for (const file of files) {
        const text = fs.readFileSync(path.join(APP, file), 'utf8');
        assert.doesNotMatch(text, /resilien|surviv/i, file);
    }
});
