// beanpool.org/start (apps/website/start.html and its 24 language copies): "Start a community" on its own page (Marty,
// 29 Oct 2026, evening: "lets get start a community on its own page - straight up", after seeing the install block and a
// 35-line live-restore step on the home page). This fails when:
//   - a language has no /start, or its sections are not what running a community involves, then the address, then the one
//     install block, then the one pointer to the operator manual (in that order), or a translation is behind the English;
//   - the home page still carries install code (a block, the facts, the cards), or its teaser has no button to /start, or
//     it has lost the element id="run-a-node" that released apps (1.2.83) and socialism.org link as beanpool.org/#run-a-node;
//   - a page still links to the old anchor (the nav, the footer, the map's "Start a community", Help, Getting Started), or a
//     sentence still says the steps are on the home page;
//   - the address the apps open for Start a community (core's default, the phone's) is not a page in the tree;
//   - drawn in headless Chromium at 320 px with text at 130 %, light and dark, in every language: /start is wider than the
//     screen, its copy button is under 44 px, its last button is under 48 px, the install block runs past the screen, or the
//     home teaser's button is under 48 px or outside the screen, or the old link (#run-a-node) does not land on the teaser.
// Every colour is also held to the site's tokens by scripts/website-colours.test.mjs, and the English pages' words to 4.5:1
// in both themes by scripts/website-contrast.mjs. No network.
//
//   node --test scripts/website-start.test.mjs   (needs: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium)
//
// WEBSITE_ROOT points it at another copy of apps/website (an archive of origin/main, for a fail-first run);
// START_SHOTS=<dir> keeps 320 px screenshots (in 880 px strips) of /start and of the home teaser in English, German and
// Arabic, light and dark.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { GUIDE_LANGS, LANGS, RTL_LANGS, pageContentHash, extractSourceHash } from './website-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(process.env.WEBSITE_ROOT ?? path.join(ROOT, 'apps/website'));
const CONTENT = path.join(ROOT, 'apps/website-src/content');
const require = createRequire(path.join(ROOT, 'apps/pwa/package.json'));
const SHOTS = process.env.START_SHOTS;

const pagePath = (lang, page) => path.join(SITE, lang === 'en' ? '' : lang, page);
const read = (lang, page) => fs.readFileSync(pagePath(lang, page), 'utf8');
/** The page without its comments, so nothing named in a comment counts. */
const markup = (lang, page) => read(lang, page).replace(/<!--[\s\S]*?-->/g, '');

test('every language has /start, with the sections in order: what it involves, your address, install, the pointer', () => {
    assert.equal(LANGS.length, 25);
    for (const lang of LANGS) {
        assert.ok(fs.existsSync(pagePath(lang, 'start.html')), `${lang}/start.html exists`);
        const html = markup(lang, 'start.html');
        assert.match(html, new RegExp(`<html lang="${lang}"`), `${lang}: its own language`);
        assert.equal((html.match(/<h1>/g) || []).length, 1, `${lang}: one h1`);
        const ids = [...html.matchAll(/<h2 id="([a-z-]+)">/g)].map((m) => m[1]);
        assert.deepEqual(ids, ['involves', 'address', 'install', 'keep-running'], `${lang}: the sections, in order`);
        const at = (needle) => html.indexOf(needle);
        assert.ok(at('class="run-node-facts"') > at('<h2 id="involves">') && at('class="run-node-facts"') < at('<h2 id="address">'), `${lang}: the facts are under "what it involves"`);
        assert.ok(at('class="features-grid"') > at('class="run-node-facts"') && at('class="features-grid"') < at('<h2 id="address">'), `${lang}: so are the four cards`);
        assert.ok(at('class="cta-block"') > at('<h2 id="install">') && at('class="cta-block"') < at('<h2 id="keep-running">'), `${lang}: the one install block is under Install`);
        assert.ok(at('<p class="run-node-note">') > at('class="cta-block"') && at('<p class="run-node-note">') < at('<h2 id="keep-running">'), `${lang}: what to do if the claim code does not appear follows it`);
        // no domain lock-in: the page says the community needs nothing of ours, and the .beanpool.org name is optional
        assert.match(html, /beanpool\.org/, `${lang}: names beanpool.org`);
        assert.equal((html.match(/data-apk=/g) || []).length, 0, `${lang}: no download values here`);
    }
});

test('/start in English says what running a community involves, in the order Marty asked', () => {
    const html = markup('en', 'start.html');
    assert.match(html, /<h1>Start a community<\/h1>/);
    const involves = html.slice(html.indexOf('<h2 id="involves">'), html.indexOf('<h2 id="address">'));
    for (const words of ['a spare computer that stays on at home', 'about US$6', 'Who hosts it.', 'It never needs <a href="https://beanpool.org">beanpool.org</a>', 'What you never see.', 'Docker first.']) {
        assert.ok(involves.includes(words), `"${words}" is under what it involves`);
    }
    const address = html.slice(html.indexOf('<h2 id="address">'), html.indexOf('<h2 id="install">'));
    assert.match(address, /<h2 id="address">Your address<\/h2>/);
    for (const words of ['--ip', '--address https://your.domain', '--no-name', 'yourtown.beanpool.org']) {
        assert.ok(address.includes(words), `"${words}" is under your address`);
    }
    assert.match(html, /<h2 id="keep-running">Recommended: keep your community running when Docker updates<\/h2>/);
});

test('the translations of /start are of today\'s English', () => {
    const english = read('en', 'start.html');
    for (const lang of GUIDE_LANGS) {
        const src = fs.readFileSync(path.join(CONTENT, lang, 'start.html'), 'utf8');
        assert.equal(extractSourceHash(src), pageContentHash(english), `${lang}: the translation is of today's English`);
        assert.ok(!read(lang, 'start.html').includes('website-stale-banner'), `${lang}: no "newer in English" banner`);
    }
});

test('the home page keeps id="run-a-node" as a teaser with a button to /start, and no install code, in every language', () => {
    for (const lang of LANGS) {
        const html = markup(lang, 'index.html');
        assert.equal((html.match(/\bid="run-a-node"/g) || []).length, 1, `${lang}: one id="run-a-node", for the released apps' and socialism.org's link`);
        const section = html.match(/<section id="run-a-node">([\s\S]*?)<\/section>/)?.[1];
        assert.ok(section, `${lang}: the section`);
        const button = section.match(/<p class="run-node-start"[^>]*><a href="start\.html" class="btn btn-primary">([^<]+)<\/a><\/p>/);
        assert.ok(button, `${lang}: a clear button to /start`);
        assert.match(button[1], /\S/, `${lang}: the button says something`);
        for (const gone of ['cta-block', 'terminal-window', 'run-node-facts', 'run-node-steps', 'features-grid', 'feature-card', 'cta-card', 'copy-btn', 'docker']) {
            assert.ok(!section.toLowerCase().includes(gone), `${lang}: the teaser has no ${gone}`);
        }
        assert.ok(!/docker compose|docker network|git clone/i.test(html), `${lang}: no install code anywhere on the home page`);
        // a short teaser: the heading, one paragraph of at most three sentences, the button
        assert.equal((section.match(/<p>/g) || []).length, 1, `${lang}: one paragraph`);
        const sentences = section.match(/<p>([\s\S]*?)<\/p>/)[1].split(/[.。।۔]\s*/).filter((s) => s.trim());
        // (Korean says the same three things in four sentences.)
        assert.ok(sentences.length <= (lang === 'ko' ? 4 : 3), `${lang}: at most three sentences (${sentences.length})`);
    }
    // a visitor who follows the old link lands on the section's heading, which sits above the button
    const en = markup('en', 'index.html');
    assert.match(en, /<section id="run-a-node">[\s\S]*?<h2>Run BeanPool for Your Community<\/h2>[\s\S]*?<a href="start\.html" class="btn btn-primary">Start a community&nbsp;→<\/a>/);
});

test('no page links the old anchor: the nav, the footer, the map, Help and Getting Started lead to /start; no sentence says the steps are on the home page', () => {
    for (const lang of LANGS) {
        for (const page of ['index.html', 'start.html', 'help.html', 'getting-started.html', '404.html', 'global.html', 'android.html', 'rules.html', 'safety.html', 'post-extraction.html', 'status.html']) {
            const html = markup(lang, page);
            assert.ok(!/href="[^"]*#run-a-node"/.test(html), `${lang}/${page}: no link to #run-a-node`);
        }
        const home = markup(lang, 'index.html');
        const runLinks = [...home.matchAll(/<a href="start\.html"( aria-current="page")?>([^<]*)<\/a>/g)];
        assert.ok(runLinks.length >= 3, `${lang}/index.html: the two nav links and the footer link lead to /start (${runLinks.length})`);
        assert.match(home, /<a id="map-empty-start" href="start\.html">/, `${lang}/index.html: the map's "Start a community" leads to /start`);
        const help = markup(lang, 'help.html');
        assert.match(help, /<a class="help-card glass-panel" href="start\.html">/, `${lang}/help.html: the "Running a community" card leads to /start`);
        const gs = markup(lang, 'getting-started.html');
        assert.match(gs, /<a href="start\.html">[^<]+<\/a>/, `${lang}/getting-started.html: it links /start`);
    }
    assert.match(markup('en', 'getting-started.html'), /the steps are on our <a href="start\.html">Start a community<\/a> page\./);
    assert.doesNotMatch(markup('en', 'getting-started.html'), /steps are on our home page/);
});

test('the address the apps open for Start a community is the /start page in this tree', () => {
    const features = fs.readFileSync(path.join(ROOT, 'packages/beanpool-core/src/features.ts'), 'utf8');
    assert.match(features, /export const START_COMMUNITY_URL_DEFAULT = 'https:\/\/beanpool\.org\/start';/);
    const phone = fs.readFileSync(path.join(ROOT, 'apps/native/utils/start-community.ts'), 'utf8');
    assert.match(phone, /export const RUN_A_NODE_URL = `\$\{BEANPOOL_WEBSITE_URL\}\/start`;/);
    assert.ok(fs.existsSync(path.join(SITE, 'start.html')), 'beanpool.org/start is a page in the site');
    for (const [file, text] of [['core features.ts', features], ['the phone\'s start-community.ts', phone]]) {
        assert.ok(!/#run-a-node/.test(text.replace(/^\s*\*.*$|^\s*\/\/.*$/gm, '')), `${file}: no code opens the old anchor (a comment may name it)`);
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

/** Opens one page at 320 px in a theme, offline but for this site, text at 130 %. */
async function open(e, url, colorScheme) {
    const context = await e.browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme });
    const page = await context.newPage();
    await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.fulfill({ status: 204, body: '' })));
    await page.goto(`${e.base}/${url}`, { waitUntil: 'load' });
    await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
    return { page, context };
}

/** Screenshots of the page in strips 880 px tall, so each can be looked at whole. */
async function strips(page, name) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let i = 0, y = 0; y < height; i += 1, y += 880) {
        await page.screenshot({ path: path.join(SHOTS, `${name}-${i + 1}.png`), fullPage: true, clip: { x: 0, y, width: 320, height: Math.min(880, height - y) } });
    }
}

for (const colorScheme of ['light', 'dark']) {
    test(`/start at 320 px, text at 130 %, ${colorScheme}: every language's page fits, the block is whole, the copy button is 44 px and the last button 48 px`, { timeout: 240_000 }, async () => {
        const e = await env();
        const failures = [];
        for (const lang of LANGS) {
            const url = lang === 'en' ? 'start.html' : `${lang}/start.html`;
            const { page, context } = await open(e, url, colorScheme);
            const m = await page.evaluate(() => {
                const root = document.documentElement;
                const wide = [...document.body.querySelectorAll('*')]
                    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > root.clientWidth + 0.5 || r.left < -0.5); })
                    .filter((el) => !el.closest('.lang-dropdown, .nav-menu-panel, details:not([open])'))
                    .slice(0, 3).map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')}`);
                const copy = document.querySelector('.copy-btn').getBoundingClientRect();
                const block = document.querySelector('code.cta-block').getBoundingClientRect();
                const last = [...document.querySelectorAll('main a.btn-primary')].pop();
                const l = last.getBoundingClientRect();
                const probe = document.createElement('span');
                probe.style.color = 'var(--on-accent)';
                document.body.appendChild(probe);
                const onAccent = getComputedStyle(probe).color;
                probe.remove();
                const blockStyle = getComputedStyle(document.querySelector('code.cta-block'));
                return {
                    scrollW: root.scrollWidth, clientW: root.clientWidth, wide, copyW: copy.width, copyH: copy.height,
                    blockLeft: block.left, blockRight: block.right, blockWrap: blockStyle.whiteSpace,
                    lastH: l.height, lastColor: getComputedStyle(last).color, onAccent, dir: getComputedStyle(document.body).direction,
                    h1: document.querySelector('main h1').textContent.trim(),
                };
            });
            if (m.scrollW > m.clientW) failures.push(`${url}: ${m.scrollW} px wide on a ${m.clientW} px screen (${m.wide.join(', ')})`);
            if (m.copyW < 44 || m.copyH < 44) failures.push(`${url}: the copy button is ${Math.round(m.copyW)}×${Math.round(m.copyH)} px`);
            if (m.blockLeft < -0.5 || m.blockRight > m.clientW + 0.5) failures.push(`${url}: the install block runs ${Math.round(m.blockLeft)}–${Math.round(m.blockRight)} px on a ${m.clientW} px screen`);
            if (!/pre-wrap/.test(m.blockWrap)) failures.push(`${url}: the install block does not wrap (${m.blockWrap})`);
            if (m.lastH < 48) failures.push(`${url}: the last button is ${m.lastH} px tall`);
            if (m.lastColor !== m.onAccent) failures.push(`${url}: the button's words are ${m.lastColor}, not the button's own ${m.onAccent}`);
            if (RTL_LANGS.includes(lang) && m.dir !== 'rtl') failures.push(`${url}: the page reads ${m.dir}`);
            if (!m.h1) failures.push(`${url}: no heading`);
            if (SHOTS && ['en', 'de', 'ar'].includes(lang)) await strips(page, `start-${lang}-${colorScheme}`);
            await context.close();
        }
        assert.deepEqual(failures, []);
    });

    test(`the home teaser at 320 px, text at 130 %, ${colorScheme}: a 48 px button inside the screen, and the old link (#run-a-node) points at it, in every language`, { timeout: 240_000 }, async () => {
        const e = await env();
        const failures = [];
        for (const lang of LANGS) {
            const url = lang === 'en' ? 'index.html' : `${lang}/index.html`;
            const { page, context } = await open(e, `${url}#run-a-node`, colorScheme);
            // The old link (the released apps', socialism.org's) names this element: the browser's :target is the teaser.
            // (Where the browser then scrolls is the browser's, and this long page grows as its map and cards load.)
            const m = await page.evaluate(() => {
                const root = document.documentElement;
                const section = document.getElementById('run-a-node');
                const target = document.querySelector(':target');
                document.documentElement.style.scrollBehavior = 'auto';
                section.scrollIntoView({ behavior: 'instant', block: 'start' });
                const a = section.querySelector('.run-node-start a');
                const r = a.getBoundingClientRect();
                return { target: target?.id, h: r.height, left: r.left, right: r.right, clientW: root.clientWidth };
            });
            if (m.target !== 'run-a-node') failures.push(`${url}#run-a-node: the browser's target is ${m.target ?? 'nothing'}, not the teaser`);
            if (m.h < 48) failures.push(`${url}: the button is ${m.h} px tall`);
            if (m.left < -0.5 || m.right > m.clientW + 0.5) failures.push(`${url}: the button runs ${Math.round(m.left)}–${Math.round(m.right)} px on a ${m.clientW} px screen`);
            // (The page as a whole is not judged here: the hero is wider than 320 px at 130 % in German, Malayalam and Tamil,
            // and the German audience tag is one 304 px word, as on origin/main. This test holds the teaser's own button.)
            if (SHOTS && ['en', 'de', 'ar'].includes(lang)) {
                fs.mkdirSync(SHOTS, { recursive: true });
                // the home page grows as its map and cards load: scroll to the section until it stops moving, then take what is on screen
                await page.setViewportSize({ width: 320, height: 900 });
                let last = null;
                for (let i = 0; i < 20; i += 1) {
                    const top = await page.evaluate(() => { const s = document.getElementById('run-a-node'); s.scrollIntoView({ behavior: 'instant', block: 'start' }); return Math.round(s.getBoundingClientRect().top + window.scrollY); });
                    if (top === last) break;
                    last = top;
                    await page.waitForTimeout(150);
                }
                await page.screenshot({ path: path.join(SHOTS, `home-teaser-${lang}-${colorScheme}.png`) });
            }
            await context.close();
        }
        assert.deepEqual(failures, []);
    });
}
