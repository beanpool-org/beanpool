// beanpool.org/global (apps/website/global.html): the website's link to the global community, slice Web1 of the
// global-entry design (scratch/global-node/DESIGN-global-entry-fable.md, decision 3, Marty 17 Oct 2026). This fails when:
//   - a link, stylesheet or picture on the page is not https and ours (beanpool.org, global.beanpool.org, the app's own
//     Google Play and App Store listings) or one of the site's own files, or the page loads a script from anywhere;
//   - the Google Play link's referrer does not read global=1 once decoded (what the app gets from Google's Install
//     Referrer on its first start), or carries an invite or a server;
//   - the line "or open the global community in your browser" is missing, hidden, or goes anywhere but global.beanpool.org;
//   - the page's script, run for each kind of visitor, does not do what the design says: Android, the app by its link
//     https://beanpool.org/global with Google Play (and the referrer) when the app can't take it; an iPhone, the App
//     Store; a computer, global.beanpool.org; and nothing without a tap on a copy of the site anywhere else, or on the
//     way back to the page;
//   - beanpool.org's apple-app-site-association stops claiming /global for the app, or loses a path it claimed before.
//
//   node --test scripts/website-global-link.test.mjs
//
// WEBSITE_ROOT points it at another copy of apps/website (an archive of origin/main, for a fail-first run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(process.env.WEBSITE_ROOT ?? path.join(ROOT, 'apps/website'));
const HTML = fs.readFileSync(path.join(SITE, 'global.html'), 'utf8');

const PLAY_ID = 'org.beanpool.pillar';
const APP_STORE_ID = 'id6761870086';
const GLOBAL = 'https://global.beanpool.org';
const BROWSER_LINE = 'or open the global community in your browser';

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
/** The page without its comments, so a URL named in a comment is not taken for a link. */
const MARKUP = HTML.replace(/<!--[\s\S]*?-->/g, '');

/** Every element that carries an id: its href, whether it is hidden, its classes and its words. */
function elementsById() {
    const els = new Map();
    for (const m of MARKUP.matchAll(/<(\w+)\b([^>]*)>/g)) {
        const attrs = m[2];
        const id = attrs.match(/\bid="([^"]+)"/)?.[1];
        if (!id) continue;
        const bare = attrs.replace(/"[^"]*"/g, '""');
        const end = MARKUP.indexOf(`</${m[1]}>`, m.index);
        const classes = new Set((attrs.match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean));
        els.set(id, {
            href: attrs.match(/\bhref="([^"]*)"/) ? decode(attrs.match(/\bhref="([^"]*)"/)[1]) : undefined,
            hidden: /(?:^|\s)hidden(?=\s|$|\/)/.test(bare),
            classes,
            classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
            text: decode(MARKUP.slice(m.index + m[0].length, end).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
        });
    }
    return els;
}

/** A store listing of this app, or one of our own addresses, over https. */
function oursAndHttps(raw) {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    if (u.hostname === 'beanpool.org' || u.hostname === 'global.beanpool.org') return true;
    if (u.hostname === 'play.google.com') return u.pathname === '/store/apps/details' && u.searchParams.get('id') === PLAY_ID;
    if (u.hostname === 'apps.apple.com') return new RegExp(`^/(?:[a-z]{2}/)?app/(?:[^/]+/)?${APP_STORE_ID}$`).test(u.pathname);
    return false;
}

/** The page's own script run as a browser would for one visitor; returns the page afterwards and where it went. */
function visit({ ua, host = 'beanpool.org', arrival = 'navigate', touch = false }) {
    const els = elementsById();
    const went = [];
    const document = { getElementById: (id) => els.get(id) ?? null };
    if (touch) document.ontouchend = null;
    const location = {
        hostname: host,
        set href(v) { went.push(['href', v]); },
        replace(v) { went.push(['replace', v]); },
    };
    const performance = { getEntriesByType: (t) => (t === 'navigation' ? [{ type: arrival }] : []) };
    vm.runInNewContext(SCRIPT, { document, location, performance, navigator: { userAgent: ua } });
    return { els, went };
}

const SCRIPTS = [...MARKUP.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const SCRIPT = SCRIPTS[0]?.[2] ?? '';

const UA = {
    android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    androidWebView: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const PLAY = elementsById().get('play')?.href;
const APP_STORE = elementsById().get('app-store')?.href;

/** Chrome's intent link → its parts: the address it asks the app to open, the package, and the fallback. */
function intentParts(link) {
    const m = link.match(/^intent:\/\/([^#]+)#Intent;(.*);end$/);
    assert.ok(m, `${link} is an intent link`);
    const fields = Object.fromEntries(m[2].split(';').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
    return { url: `${fields.scheme}://${m[1]}`, pkg: fields.package, fallback: decodeURIComponent(fields['S.browser_fallback_url'] ?? '') };
}

test('every link, stylesheet and picture on the page is https and ours, or one of the site\'s own files', () => {
    const refs = [...MARKUP.matchAll(/\b(href|src|action|srcset|poster)="([^"]*)"/g)].map((m) => decode(m[2]));
    assert.ok(refs.length >= 8, `${refs.length} references`);
    const wrong = [];
    for (const ref of refs) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) {
            if (!oursAndHttps(ref.startsWith('//') ? `https:${ref}` : ref)) wrong.push(ref);
        } else {
            const file = ref.split(/[?#]/)[0];
            if (!file || file.startsWith('/') || !fs.existsSync(path.join(SITE, file))) wrong.push(ref);
        }
    }
    assert.deepEqual(wrong, []);
    assert.doesNotMatch(MARKUP, /url\(/, 'the page\'s own style draws nothing from an address');
});

test('the page runs one script, its own, written in the page; no script comes from anywhere', () => {
    assert.equal(SCRIPTS.length, 1);
    assert.doesNotMatch(SCRIPTS[0][1], /\bsrc=/);
    assert.doesNotMatch(SCRIPT, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|document\.cookie|localStorage|sessionStorage|new Image\b/,
        'the script asks nothing of any server and keeps nothing about the visitor');
});

test('the Google Play link carries referrer=global%3D1, which reads global=1 and nothing else', () => {
    assert.ok(PLAY, 'the Google Play link');
    assert.match(PLAY, /&referrer=global%3D1(?:&|$)/);
    const u = new URL(PLAY);
    assert.equal(u.searchParams.get('id'), PLAY_ID);
    const referrer = u.searchParams.get('referrer');
    assert.equal(referrer, 'global=1');
    // What the app reads on its first start (apps/native/app/welcome.tsx): no invite, no server, so it can start no join.
    assert.doesNotMatch(referrer, /(?:^|&)(?:invite|server)=/);
    assert.equal(new URLSearchParams(referrer).get('global'), '1');
    assert.equal(elementsById().get('open-app').href, PLAY, 'the app door\'s own link, shown only by the script, is the same store link');
});

test('with no script: both stores and the browser line, all plain links; the app door stays hidden', () => {
    const els = elementsById();
    assert.equal(els.get('door-app').hidden, true);
    assert.equal(els.get('door-play').hidden, false);
    assert.equal(els.get('door-ios').hidden, false);
    assert.equal(els.get('app-store').href, `https://apps.apple.com/app/${APP_STORE_ID}`);
    const browser = els.get('browser');
    assert.equal(browser.text, BROWSER_LINE);
    assert.equal(browser.href, GLOBAL);
    assert.equal(browser.hidden, false);
    // The line is outside every door, so hiding a door never hides it.
    const at = MARKUP.indexOf('id="browser"');
    assert.ok(at > MARKUP.lastIndexOf('class="hero-doors"') && at > MARKUP.indexOf('id="door-ios"'));
    assert.doesNotMatch(MARKUP.slice(MARKUP.lastIndexOf('<p', at), at), /hidden/);
});

test('Android: the app by its link, beanpool.org/global, else Google Play with the referrer; once, on arrival at beanpool.org', () => {
    const { els, went } = visit({ ua: UA.android });
    const link = els.get('open-app').href;
    const parts = intentParts(link);
    assert.equal(parts.url, 'https://beanpool.org/global');
    assert.ok(oursAndHttps(parts.url));
    assert.equal(parts.pkg, PLAY_ID);
    assert.equal(parts.fallback, PLAY);
    assert.equal(new URL(parts.fallback).searchParams.get('referrer'), 'global=1');
    assert.deepEqual(went, [['href', link]]);
    assert.equal(els.get('door-app').hidden, false);
    assert.equal(els.get('door-ios').hidden, true);
    assert.equal(els.get('door-play').hidden, false, 'Google Play stays, for a browser that does not know intent links');
    assert.ok(els.get('play').classList.contains('btn-ghost') && !els.get('play').classList.contains('btn-primary'), 'the app door is first');
    assert.equal(els.get('browser').hidden, false);

    for (const arrival of ['back_forward', 'reload']) {
        const back = visit({ ua: UA.android, arrival });
        assert.deepEqual(back.went, [], `${arrival}: the doors, not the store again`);
        assert.equal(back.els.get('open-app').href, link);
    }
    assert.deepEqual(visit({ ua: UA.android, host: '127.0.0.1' }).went, [], 'a copy of the site elsewhere waits for a tap');
});

test('Android inside an app\'s web view: Google Play, never an intent link it may not know', () => {
    const { els, went } = visit({ ua: UA.androidWebView });
    assert.deepEqual(went, [['href', PLAY]]);
    assert.equal(els.get('door-app').hidden, true);
    assert.equal(els.get('door-ios').hidden, true);
    assert.ok(els.get('play').classList.contains('btn-primary'));
});

test('iPhone and iPad: the App Store, once, on arrival at beanpool.org', () => {
    for (const who of [{ ua: UA.iphone }, { ua: UA.mac, touch: true }]) {
        const { els, went } = visit(who);
        assert.deepEqual(went, [['href', APP_STORE]], who.ua);
        assert.equal(els.get('door-play').hidden, true);
        assert.equal(els.get('door-ios').hidden, false);
        assert.ok(els.get('app-store').classList.contains('btn-primary'));
        assert.equal(els.get('browser').hidden, false);
        assert.deepEqual(visit({ ...who, arrival: 'back_forward' }).went, []);
    }
});

test('a computer goes straight to global.beanpool.org, with this page out of the history', () => {
    for (const ua of [UA.mac, UA.windows]) {
        const { els, went } = visit({ ua });
        assert.deepEqual(went, [['replace', GLOBAL]], ua);
        assert.equal(els.get('door-play').hidden, false);
        assert.equal(els.get('door-ios').hidden, false);
        assert.deepEqual(visit({ ua, host: '127.0.0.1' }).went, [], 'the site\'s checks on this machine judge the page itself');
    }
});

test('every address the script can send anyone to is https and ours', () => {
    for (const ua of Object.values(UA)) {
        for (const [, to] of visit({ ua }).went) assert.ok(to.startsWith('intent://') ? oursAndHttps(intentParts(to).url) && oursAndHttps(intentParts(to).fallback) : oursAndHttps(to), to);
    }
});

test('beanpool.org claims /global for the app on iPhones, and keeps the paths it claimed before', () => {
    const aasa = JSON.parse(fs.readFileSync(path.join(SITE, '.well-known/apple-app-site-association'), 'utf8'));
    const ours = aasa.applinks.details.find((d) => d.appIDs.includes('485XM2R33S.org.beanpool.pillar'));
    assert.ok(ours, 'the app\'s entry');
    const paths = ours.components.map((c) => c['/']);
    assert.ok(paths.includes('/global'), `/global in ${JSON.stringify(paths)}`);
    assert.ok(ours.components.some((c) => c['/'] === '/' && c['?']?.invite === '*'), 'invite links');
    assert.ok(paths.includes('/app*'), 'the old app paths');
    assert.ok(!paths.some((p) => p === '*' || p === '/*'), 'no path takes every page of the website into the app');
});
