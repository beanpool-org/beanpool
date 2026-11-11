/**
 * Integration & unit tests for invite trampoline landing page and invite check route.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { LANGS } from '@beanpool/core';
import { renderInviteTrampoline, BADGE_HEIGHT_PX, BADGE_CLEAR_SPACE_PX, BADGE_WORDS } from './routes/invite-trampoline.js';
import { APP_STORE_BADGE_SVG, GOOGLE_PLAY_BADGE_SVG, STORE_BADGE_SHA256 } from './routes/store-badge-art.js';
import { wordsIn, useCatalogsForTests } from './member-words.js';

/** SHA-256 of the owners' files as downloaded on 2026-11-10 (store-badge-art.ts says where from). Written out here as well, so changing the art AND its recorded hash together still fails. */
const OFFICIAL_APPLE_BADGE_SHA256 = 'a26fc5b38380272c92e9019a2eb8b45542a66814b3e2b203772db8904b9fb99f';
const OFFICIAL_GOOGLE_BADGE_SHA256 = '4ffa4c7edd2f10b297ca4de2131eddaa00d03b2278d1e178fe512920d824ca34';
const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/**
 * Run the page's own script against a tiny fake page, as a browser at `search` on `origin` with the user agent `ua`: what it
 * links to (the store, the app, the web hatch) and what its buttons copy. Nothing is fetched: the preflight is a no-op.
 */
function runTrampoline(search: string, ua: string, origin = 'https://mullum.beanpool.org') {
    const html = renderInviteTrampoline({ webJoin: true });
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const els = new Map<string, any>();
    const el = (id: string) => {
        if (!els.has(id)) els.set(id, { id, style: {}, handlers: {} as Record<string, Array<(e: any) => void>>, classList: { add() {}, remove() {} }, href: '', textContent: '', className: '',
            addEventListener(ev: string, fn: (e: any) => void) { (this.handlers[ev] ||= []).push(fn); }, appendChild() {} });
        return els.get(id);
    };
    const copied: string[] = [];
    const loc = { search, origin, href: '' };
    const sandbox: any = {
        URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout: () => 0,
        location: loc,
        navigator: { userAgent: ua, clipboard: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } } },
        document: { getElementById: el, createElement: () => ({ style: {}, appendChild() {}, className: '', textContent: '' }), body: { removeChild() {} }, ontouchend: null },
        window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
        fetch: () => Promise.resolve({ ok: false }),
    };
    sandbox.document.createRange = () => ({ selectNode() {} });
    vm.runInNewContext(script, sandbox);
    const click = (id: string) => { for (const fn of el(id).handlers.click ?? []) fn({ preventDefault() {} }); };
    return { el, click, copied, loc };
}

async function main() {
    console.log('Running invite-trampoline tests...');

    // 1. Pure unit tests for renderInviteTrampoline
    const htmlWebJoinTrue = renderInviteTrampoline({ webJoin: true });
    assert(htmlWebJoinTrue.includes('WEB_JOIN = true;'), 'renderInviteTrampoline with webJoin: true sets WEB_JOIN to true');
    assert(htmlWebJoinTrue.includes('org.beanpool.pillar'), 'renderInviteTrampoline includes app bundle id');
    assert(htmlWebJoinTrue.includes('Continue in your browser'), 'renderInviteTrampoline with webJoin: true includes web join link');

    const htmlWebJoinFalse = renderInviteTrampoline({ webJoin: false });
    assert(htmlWebJoinFalse.includes('WEB_JOIN = false;'), 'renderInviteTrampoline with webJoin: false sets WEB_JOIN to false');

    // 1b. Invite and share: `&post=<id>` rides every way the invite goes on, and only as an id. It is never looked up or shown
    // here, and a link without one is exactly the link it always was.
    const ANDROID = 'Mozilla/5.0 (Linux; Android 14) Chrome/120';
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1';
    const POST = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34';
    const referrerOf = (href: string) => decodeURIComponent(new URL(href).searchParams.get('referrer') || '');
    // Android's main button is an `intent://` link: the app with the invite when installed, else its Play fallback.
    const fallbackOf = (href: string) => decodeURIComponent(/;S\.browser_fallback_url=([^;]*);/.exec(href)?.[1] ?? '');
    const MULLUM = encodeURIComponent('https://mullum.beanpool.org');
    {
        const withPost = runTrampoline(`?invite=INV-AB12-CD34&post=${POST}`, ANDROID);
        assert(referrerOf(fallbackOf(withPost.el('installBtn').href)) === `invite=INV-AB12-CD34&server=https://mullum.beanpool.org&post=${POST}`, 'trampoline: the Play referrer carries the listing after the server');
        assert(referrerOf(withPost.el('androidStore').href) === `invite=INV-AB12-CD34&server=https://mullum.beanpool.org&post=${POST}`, 'trampoline: the plain Google Play link (its badge) carries the listing');
        assert(withPost.el('installBtn').href.startsWith(`intent://welcome?invite=INV-AB12-CD34&server=${MULLUM}&post=${POST}#Intent;`), 'trampoline: the app\'s link carries the listing');
        withPost.click('copyBtn');
        assert(withPost.copied[0] === `https://mullum.beanpool.org/?invite=INV-AB12-CD34&post=${POST}`, 'trampoline: Copy code copies the invite link with the listing');
        withPost.click('proceedWeb');
        assert(withPost.loc.href === `/app?invite=INV-AB12-CD34&webjoin=1&post=${POST}`, 'trampoline: Continue in browser carries the listing');

        const ios = runTrampoline(`?invite=INV-AB12-CD34&post=${POST}`, IPHONE);
        assert(ios.el('openAppBtn').href === `beanpool://welcome?invite=INV-AB12-CD34&server=${MULLUM}&post=${POST}`, 'trampoline: Open BeanPool carries the listing');
        ios.click('iosStore'); // the App Store badge: on iOS it is the one way to the store, and it copies the link
        assert(ios.copied[0] === `https://mullum.beanpool.org/?invite=INV-AB12-CD34&post=${POST}`, 'trampoline: on iOS the copied link carries the listing');

        const desktop = runTrampoline(`?invite=INV-AB12-CD34&post=${POST}`, 'Mozilla/5.0 (X11; Linux x86_64)');
        assert(referrerOf(desktop.el('androidStore').href).endsWith(`&post=${POST}`), 'trampoline: the desktop page\'s Google Play link carries the listing');

        const plain = runTrampoline('?invite=INV-AB12-CD34', ANDROID);
        assert(referrerOf(fallbackOf(plain.el('installBtn').href)) === 'invite=INV-AB12-CD34&server=https://mullum.beanpool.org', 'trampoline: with no listing the Play referrer is as it always was');
        assert(runTrampoline('?invite=INV-AB12-CD34', IPHONE).el('openAppBtn').href === `beanpool://welcome?invite=INV-AB12-CD34&server=${MULLUM}`, 'trampoline: with no listing Open BeanPool is as it always was');
        plain.click('copyBtn');
        assert(plain.copied[0] === 'https://mullum.beanpool.org/?invite=INV-AB12-CD34', 'trampoline: with no listing the copied link is as it always was');
        plain.click('proceedWeb');
        assert(plain.loc.href === '/app?invite=INV-AB12-CD34&webjoin=1', 'trampoline: with no listing the browser link is as it always was');

        for (const bad of ['..%2F..%2Fetc', 'a%20b', '%3Cscript%3E', 'x%26invite=EVIL', 'https%3A%2F%2Fevil.example', 'a'.repeat(101), '']) {
            const r = runTrampoline(`?invite=INV-AB12-CD34&post=${bad}`, ANDROID);
            r.click('copyBtn');
            r.click('proceedWeb');
            const rIos = runTrampoline(`?invite=INV-AB12-CD34&post=${bad}`, IPHONE);
            assert(!r.el('installBtn').href.includes('post') && !referrerOf(r.el('androidStore').href).includes('post=') && !rIos.el('openAppBtn').href.includes('post=') && !r.copied[0].includes('post=') && !r.loc.href.includes('post='),
                `trampoline: a post that is not an id (${bad.slice(0, 20)}) is left out everywhere`);
        }
    }

    // 1c. An installed app on Android (Damo, 9 Nov): a camera scan that the phone hands to the browser instead of the app
    // reaches this page, and its Play page offers only "Open", which starts the app with no link and no referrer: the invite
    // was lost, and the member had to scan it again. The main button now opens the app itself with the invite, and falls
    // back to the Play link (its referrer intact) only where the app isn't installed. Every way off the page copies the link.
    {
        const and = runTrampoline('?invite=INV-AB12-CD34', ANDROID);
        const href = and.el('installBtn').href as string;
        assert(href.startsWith(`intent://welcome?invite=INV-AB12-CD34&server=${MULLUM}#Intent;`), 'trampoline (Android): the main button opens the app\'s own invite link');
        assert(/;scheme=beanpool;/.test(href) && /;package=org\.beanpool\.pillar;/.test(href) && href.endsWith(';end'), 'trampoline (Android): the link names the app\'s scheme and package, so only BeanPool opens it');
        assert(fallbackOf(href).startsWith('https://play.google.com/store/apps/details?id=org.beanpool.pillar&referrer='), 'trampoline (Android): without the app, the link falls back to Google Play');
        assert(and.el('installBtn').textContent === 'Open your invite in BeanPool', 'trampoline (Android): the main button says it opens the invite in BeanPool');
        and.click('installBtn');
        assert(and.copied[0] === 'https://mullum.beanpool.org/?invite=INV-AB12-CD34', 'trampoline (Android): the main button copies the invite link too');
        assert(and.el('androidStore').style.display !== 'none' && and.el('androidStore').href.startsWith('https://play.google.com/store/apps/details?id=org.beanpool.pillar&referrer='), 'trampoline (Android): the plain Google Play link is still there (now the Google Play badge)');
        and.click('androidStore');
        assert(and.copied[1] === 'https://mullum.beanpool.org/?invite=INV-AB12-CD34', 'trampoline (Android): the Google Play link copies the invite link, for the app\'s Paste after "Open"');
        assert(and.el('openAppBtn').style.display !== 'block', 'trampoline (Android): no second Open button, the main one opens the app');
        const desk = runTrampoline('?invite=INV-AB12-CD34', 'Mozilla/5.0 (X11; Linux x86_64)');
        assert(!desk.el('installBtn').href.startsWith('intent:') && desk.el('installBtn').style.display !== 'block', 'trampoline (desktop): no app link and no extra store button');
    }

    // 1d. The store badges (Marty, 10 Nov): Apple's and Google's own artwork, unmodified, as links in the page itself, so they
    // work with no script, need nothing outside this node, and are the size, spacing and order the owners ask for. A phone's
    // script then shows only that phone's store and points both at this invite.
    {
        const html = renderInviteTrampoline({ webJoin: true });
        const noScript = html.replace(/<script>[\s\S]*?<\/script>/g, ''); // a browser with no JavaScript
        const badgeIn = (page: string, id: string) => {
            const m = new RegExp(`<a class="badge" id="${id}" href="([^"]*)" rel="noopener"><img src="([^"]*)" alt="([^"]*)"([^>]*)></a>`).exec(page);
            return m ? { href: m[1], src: m[2], alt: m[3], rest: m[4] } : null;
        };
        const apple = badgeIn(noScript, 'iosStore');
        const google = badgeIn(noScript, 'androidStore');
        const decode = (src: string | undefined) => src?.startsWith('data:image/svg+xml;base64,') ? Buffer.from(src.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8') : null;

        // The links are real, and there with no script.
        assert(apple?.href === 'https://apps.apple.com/app/id6761870086', 'badges: with no script, the App Store badge links to the App Store page');
        assert(google?.href === 'https://play.google.com/store/apps/details?id=org.beanpool.pillar', 'badges: with no script, the Google Play badge links to the Google Play page');
        assert(noScript.indexOf('id="iosStore"') > 0 && noScript.indexOf('id="iosStore"') < noScript.indexOf('id="androidStore"'), 'badges: Apple asks for its badge first when badges stand together, so the App Store badge comes first');
        assert(!/id="(?:iosStore|androidStore|badges)"[^>]*(?:style=|hidden)/.test(noScript), 'badges: nothing hides a badge or their row until the script runs (they show with no script)');
        assert(/<a class="cta" id="installBtn" href="#" rel="noopener" style="display:none;">/.test(noScript), 'badges: the dead "Get the app" link that goes nowhere without the script is hidden until the script gives it somewhere to go');
        assert(/<\/style>[\s\S]*<div class="badges" id="badges">/.test(noScript) && !/\.badges\s*\{[^}]*display:\s*none/.test(noScript), 'badges: their row is shown by the style sheet');

        // The artwork is the owners' files, byte for byte.
        assert(sha256(APP_STORE_BADGE_SVG) === OFFICIAL_APPLE_BADGE_SHA256 && STORE_BADGE_SHA256.appStore === OFFICIAL_APPLE_BADGE_SHA256, 'badges: the App Store badge is Apple\'s file, unmodified (SHA-256 of the download)');
        assert(sha256(GOOGLE_PLAY_BADGE_SVG) === OFFICIAL_GOOGLE_BADGE_SHA256 && STORE_BADGE_SHA256.googlePlay === OFFICIAL_GOOGLE_BADGE_SHA256, 'badges: the Google Play badge is Google\'s file, unmodified (SHA-256 of the download)');
        assert(decode(apple?.src) === APP_STORE_BADGE_SVG, 'badges: the page draws exactly that App Store artwork');
        assert(decode(google?.src) === GOOGLE_PLAY_BADGE_SVG, 'badges: the page draws exactly that Google Play artwork');
        for (const [name, art] of [['App Store', APP_STORE_BADGE_SVG], ['Google Play', GOOGLE_PLAY_BADGE_SVG]] as const) {
            assert(/^(?:<\?xml[^>]*\?>\s*)?<svg\b/.test(art) && !/<(?:text|script|image|foreignObject)\b/i.test(art) && !/\bhref=|\burl\(\s*['"]?https?:/i.test(art) && !/\son[a-z]+=/i.test(art),
                `badges: the ${name} artwork is paths alone (no text, script, image, link or event handler)`);
        }

        // Nothing is fetched from anyone: every image is inline, and the page loads no script, style, frame or image from elsewhere.
        const imgs = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((m) => m[1]);
        assert(imgs.length === 2 && imgs.every((s) => s.startsWith('data:image/svg+xml;base64,')), 'badges: both images are inline data (a node needs nothing of ours, Apple\'s or Google\'s to show them)');
        assert(!/<(?:script|link|iframe|img|source|embed|object)\b[^>]*\b(?:src|href|data)="(?:https?:)?\/\//i.test(html), 'badges: the page loads nothing from outside this node');

        // The owners' rules for size and room: both at least their minimum, the same height (Google's no smaller than Apple's), a quarter of the height as clear space.
        assert(BADGE_HEIGHT_PX >= 40 && BADGE_HEIGHT_PX >= 28, 'badges: at least Apple\'s 40 px and Google\'s 28 px tall');
        assert(BADGE_CLEAR_SPACE_PX === BADGE_HEIGHT_PX / 4, 'badges: the clear space round a badge is a quarter of its height');
        assert(html.includes(`.badge { display:block; padding:${BADGE_CLEAR_SPACE_PX}px;`) && html.includes(`.badge img { display:block; height:${BADGE_HEIGHT_PX}px; width:auto; }`), 'badges: the style sheet gives each badge that height, and that clear space as the link\'s padding');
        assert(apple!.rest.includes(`height="${BADGE_HEIGHT_PX}"`) && google!.rest.includes(`height="${BADGE_HEIGHT_PX}"`), 'badges: both images state the same height');
        const widthOf = (b: { rest: string }) => Number(/width="(\d+)"/.exec(b.rest)?.[1]);
        assert(widthOf(apple!) === 144 && widthOf(google!) === 162 && widthOf(google!) >= widthOf(apple!), 'badges: each keeps its artwork\'s shape (Apple\'s 144 wide, Google\'s 162) and Google\'s is no smaller than Apple\'s');
        // Two badges and their room must fit a 320 dp phone with its page padding (20 px a side), stacked or side by side; 130% text zoom does not touch an image's size.
        assert(widthOf(google!) + 2 * BADGE_CLEAR_SPACE_PX <= 320 - 2 * 20, 'badges: the widest badge with its clear space fits a 320 dp phone');

        // Alt text, in English by default and in the visitor's language through the words layer.
        assert(apple?.alt === 'Download on the App Store' && google?.alt === 'Get it on Google Play', 'badges: the alt text is English with no language');
        assert(!/<img\b[^>]*\blang=/.test(html), 'badges: no language, no language mark on the images');
        assert(renderInviteTrampoline({ webJoin: true, lang: 'en' }) === html && renderInviteTrampoline({ webJoin: true, lang: null }) === html, 'badges: English asked for or no language is the page as it was');
        const fr = renderInviteTrampoline({ webJoin: true, lang: 'fr' });
        assert(badgeIn(fr, 'iosStore')?.alt === 'Télécharger dans l’App Store' && badgeIn(fr, 'androidStore')?.alt === 'Disponible sur Google Play', 'badges: the alt text in French is the catalog\'s');
        assert(/<img [^>]*alt="Télécharger dans l’App Store" lang="fr" width=/.test(fr), 'badges: the French alt text is marked as French');
        assert(fr.replace(/ alt="[^"]*"( lang="fr")?/g, '') === html.replace(/ alt="[^"]*"/g, ''), 'badges: a language changes the alt text and nothing else in the page');
        let allTranslated = true;
        for (const lang of LANGS.filter((l) => l !== 'en')) {
            const page = renderInviteTrampoline({ webJoin: true, lang });
            const a = badgeIn(page, 'iosStore'), g = badgeIn(page, 'androidStore');
            const w = wordsIn(lang);
            const rtl = ['ar', 'fa', 'ur'].includes(lang) ? ' dir="rtl"' : '';
            const ok = !!a && !!g && a.alt !== '' && g.alt !== '' && a.alt !== 'Download on the App Store' && g.alt !== 'Get it on Google Play'
                && a.rest.includes(`lang="${lang}"${rtl}`) && g.rest.includes(`lang="${lang}"${rtl}`)
                && page.includes(`alt="${w.t(BADGE_WORDS.appStore).replace(/'/g, '&#39;')}"`) && page.includes(`alt="${w.t(BADGE_WORDS.googlePlay).replace(/'/g, '&#39;')}"`);
            if (!ok) { allTranslated = false; console.error(`  ${lang}: alt text not translated or not marked (${a?.alt} | ${g?.alt})`); }
        }
        assert(allTranslated, `badges: the alt text is translated, and marked with its language, in all ${LANGS.length - 1} languages`);
        // A language whose catalog has not got these sentences yet shows the English, and is not marked as that language.
        useCatalogsForTests('tr', { server: {} });
        const noTr = renderInviteTrampoline({ webJoin: true, lang: 'tr' });
        useCatalogsForTests('tr', null);
        assert(noTr === html, 'badges: a language whose catalog lacks the sentences shows the English, unmarked (onboarding-no-hard-gates)');
        assert(renderInviteTrampoline({ webJoin: true, lang: 'tr' }).includes('alt="App Store&#39;dan indir"'), 'badges: and the catalog\'s words are back once the files are read again');

        // The script: a phone is shown its own store only; the desktop both; each store link points at this invite.
        const MULL = 'https://mullum.beanpool.org';
        const iph = runTrampoline('?invite=INV-AB12-CD34', IPHONE);
        assert(iph.el('iosStore').href === 'https://apps.apple.com/app/id6761870086' && iph.el('iosStore').style.display !== 'none', 'badges (iPhone): the App Store badge shows and links to the App Store');
        assert(iph.el('androidStore').style.display === 'none', 'badges (iPhone): no Google Play badge');
        assert(iph.el('installBtn').style.display !== 'block', 'badges (iPhone): the App Store badge is the way to the store, not a second button');
        iph.click('iosStore');
        assert(iph.copied[0] === `${MULL}/?invite=INV-AB12-CD34`, 'badges (iPhone): the App Store badge copies the invite link, for the app\'s Paste');
        const andr = runTrampoline('?invite=INV-AB12-CD34', ANDROID);
        assert(andr.el('iosStore').style.display === 'none', 'badges (Android): no App Store badge');
        assert(andr.el('androidStore').style.display !== 'none' && referrerOf(andr.el('androidStore').href) === `invite=INV-AB12-CD34&server=${MULL}`, 'badges (Android): the Google Play badge shows and its link carries the invite across the install');
        assert(andr.el('installBtn').style.display === 'block', 'badges (Android): the button that opens the invite in the app is still the main one');
        const dsk = runTrampoline('?invite=INV-AB12-CD34', 'Mozilla/5.0 (X11; Linux x86_64)');
        assert(dsk.el('iosStore').style.display !== 'none' && dsk.el('androidStore').style.display !== 'none', 'badges (desktop): both badges show');
        assert(dsk.el('iosStore').href === 'https://apps.apple.com/app/id6761870086' && referrerOf(dsk.el('androidStore').href) === `invite=INV-AB12-CD34&server=${MULL}`, 'badges (desktop): the App Store link is the store page and the Google Play link carries the invite');
    }

    // 2. Integration HTTP tests with running HTTPS server
    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    // GET /?invite=BP-TEST-INVITE-123
    const resInvite = await fetch(`${BASE}/?invite=BP-TEST-INVITE-123`, { redirect: 'manual' });
    assert(resInvite.status === 200, 'GET /?invite=... returns 200 OK');
    const contentType = resInvite.headers.get('content-type') || '';
    assert(contentType.includes('text/html'), 'GET /?invite=... returns HTML content-type');
    const cacheControl = resInvite.headers.get('cache-control') || '';
    assert(cacheControl.includes('no-cache'), 'GET /?invite=... sets no-cache header');
    const textInvite = await resInvite.text();
    assert(textInvite.includes('BeanPool'), 'GET /?invite=... contains BeanPool in HTML body');

    // The store badges over HTTP: both in the page a browser with no script gets, drawn under a policy that lets an inline image
    // show, in the visitor's language (?lang= before Accept-Language, as the community card) and never from a request value.
    assert(textInvite.includes('id="iosStore" href="https://apps.apple.com/app/id6761870086"') && textInvite.includes('id="androidStore" href="https://play.google.com/store/apps/details?id=org.beanpool.pillar"'), 'GET /?invite=... carries both store badges as links');
    assert(textInvite.includes('alt="Download on the App Store"') && textInvite.includes('alt="Get it on Google Play"'), 'GET /?invite=... with no language has the English alt text');
    const csp = resInvite.headers.get('content-security-policy') || '';
    assert(/img-src [^;]*\bdata:/.test(csp), 'GET /?invite=... allows inline (data:) images, which the badges are');
    assert((resInvite.headers.get('vary') || '').toLowerCase().includes('accept-language'), 'GET /?invite=... varies on Accept-Language');
    const frPage = await (await fetch(`${BASE}/?invite=BP-TEST-INVITE-123`, { headers: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5' } })).text();
    assert(frPage.includes('alt="Télécharger dans l’App Store"') && frPage.includes('alt="Disponible sur Google Play"'), 'GET /?invite=... in French (Accept-Language) has the French alt text');
    const dePage = await (await fetch(`${BASE}/?invite=BP-TEST-INVITE-123&lang=de`, { headers: { 'Accept-Language': 'fr' } })).text();
    assert(dePage.includes('alt="Laden im App Store"') && dePage.includes('alt="Jetzt bei Google Play"'), 'GET /?invite=...&lang=de asks for German before Accept-Language');
    const evilPage = await (await fetch(`${BASE}/?invite=BP-TEST-INVITE-123&lang=${encodeURIComponent('"><script>alert(1)</script>')}`)).text();
    assert(evilPage.includes('alt="Download on the App Store"') && !evilPage.includes('alert(1)'), 'GET /?invite=... with a language that is not one shows the English and echoes nothing');

    // GET / (without invite): a stranger at a local community's bare address gets the community's card (front doors S15,
    // test-community-card.ts); a browser that keeps an account here (the web app's hint cookie) goes to /app as before.
    const resNoInvite = await fetch(`${BASE}/`, { redirect: 'manual' });
    assert(resNoInvite.status === 200 && (await resNoInvite.text()).includes('data-testid="community-card"'), 'GET / without invite, for a stranger, is the community card');
    const resMember = await fetch(`${BASE}/`, { redirect: 'manual', headers: { Cookie: 'bp_account_here=1' } });
    assert(resMember.status === 302, 'GET / without invite, for a browser with an account here, returns 302 redirect');
    const location = resMember.headers.get('location') || '';
    assert(location === '/app', 'GET / without invite, for a browser with an account here, redirects to /app');

    // GET /api/invite/check?code=BP-INVALID-CODE
    const resCheck = await fetch(`${BASE}/api/invite/check?code=BP-INVALID-CODE`);
    assert(resCheck.status === 200, 'GET /api/invite/check returns 200');
    const dataCheck = await resCheck.json() as any;
    assert(dataCheck.valid === false, 'GET /api/invite/check for invalid code returns valid: false');
    assert(typeof dataCheck.reason === 'string', 'GET /api/invite/check returns failure reason');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ invite-trampoline checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
