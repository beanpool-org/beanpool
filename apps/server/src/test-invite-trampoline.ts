/**
 * Integration & unit tests for invite trampoline landing page and invite check route.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, type Lang } from '@beanpool/core';
import { renderInviteTrampoline, BADGE_HEIGHT_PX, BADGE_CLEAR_SPACE_PX, BADGE_WORDS, INVITE_PAGE_WORDS, WARN } from './routes/invite-trampoline.js';
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

/** A text node, or an element of the small page {@link fakeDom} builds. */
type FakeNode = { text: string } | FakeEl;

/** An element: just what the page's script touches (ids, classes, `hidden`, inline display, words, order, handlers). */
class FakeEl {
    attrs: Record<string, string>;
    children: FakeNode[] = [];
    parentNode: FakeEl | null = null;
    style: Record<string, string> = {};
    handlers: Record<string, Array<(e: any) => void>> = {};
    href: string;
    value = '';
    constructor(public tag: string, attrs: Record<string, string>, private onSelect: (el: FakeEl) => void = () => {}) {
        this.attrs = attrs;
        this.href = attrs.href ?? '';
        for (const decl of (attrs.style ?? '').split(';')) {
            const [k, v] = decl.split(':').map((s) => s.trim());
            if (k && v) this.style[k === 'margin-top' ? 'marginTop' : k] = v;
        }
    }
    get id() { return this.attrs.id ?? ''; }
    get className() { return this.attrs.class ?? ''; }
    set className(v: string) { this.attrs.class = v; }
    get classList() {
        const names = () => this.className.split(/\s+/).filter(Boolean);
        return {
            add: (c: string) => { if (!names().includes(c)) this.className = [...names(), c].join(' '); },
            remove: (c: string) => { this.className = names().filter((n) => n !== c).join(' '); },
            contains: (c: string) => names().includes(c),
        };
    }
    get hidden() { return 'hidden' in this.attrs; }
    set hidden(v: boolean) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; }
    get textContent(): string { return this.children.map((c) => ('text' in c ? c.text : c.textContent)).join(''); }
    set textContent(v: string) { this.children = [{ text: String(v) }]; }
    setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
    removeAttribute(k: string) { delete this.attrs[k]; }
    getAttribute(k: string) { return this.attrs[k] ?? null; }
    private detach(n: FakeNode) { if (n instanceof FakeEl && n.parentNode) n.parentNode.removeChild(n); }
    appendChild(n: FakeNode) { this.detach(n); if (n instanceof FakeEl) n.parentNode = this; this.children.push(n); return n; }
    insertBefore(n: FakeNode, ref: FakeNode | null) {
        this.detach(n);
        const at = ref ? this.children.indexOf(ref) : -1;
        if (n instanceof FakeEl) n.parentNode = this;
        this.children.splice(at < 0 ? this.children.length : at, 0, n);
        return n;
    }
    removeChild(n: FakeNode) {
        const at = this.children.indexOf(n);
        if (at < 0) throw new Error('not a child');
        this.children.splice(at, 1);
        if (n instanceof FakeEl) n.parentNode = null;
        return n;
    }
    get firstChild() { return this.children[0] ?? null; }
    get nextSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) + 1] ?? null : null; }
    addEventListener(ev: string, fn: (e: any) => void) { (this.handlers[ev] ||= []).push(fn); }
    select() { this.onSelect(this); }
    setSelectionRange() {}
}

const VOID_TAGS = new Set(['img', 'br', 'meta', 'input', 'link', 'hr']);
const decodeEntities = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The page's `<body>` as a tree of FakeEl, its script left out (the test runs it). */
function fakeDom(html: string, onSelect: (el: FakeEl) => void): FakeEl {
    const body = new FakeEl('body', {}, onSelect);
    const source = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script>[\s\S]*?<\/script>/g, '');
    const stack: FakeEl[] = [body];
    for (const m of source.matchAll(/<(\/)?([a-zA-Z0-9]+)((?:[^>"]|"[^"]*")*)>|([^<]+)/g)) {
        if (m[4] !== undefined) { if (m[4].trim()) stack[stack.length - 1].children.push({ text: decodeEntities(m[4].replace(/\s+/g, ' ')) }); continue; }
        const tag = m[2].toLowerCase();
        if (m[1]) { if (stack.length > 1 && stack[stack.length - 1].tag === tag) stack.pop(); continue; }
        const attrs: Record<string, string> = {};
        for (const a of m[3].matchAll(/([^\s=/]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decodeEntities(a[2] ?? '');
        const el = new FakeEl(tag, attrs, onSelect);
        stack[stack.length - 1].appendChild(el);
        if (!VOID_TAGS.has(tag)) stack.push(el);
    }
    return body;
}

/** Whether an element shows: not `hidden`, no inline display:none, and not one the style sheet hides until a class says. */
function shows(el: FakeEl): boolean {
    if (el.hidden || el.style.display === 'none') return false;
    const c = el.classList;
    if ((c.contains('desktop-note') || c.contains('banner')) && !c.contains('show')) return false;
    if (c.contains('modal') && !c.contains('open')) return false;
    return true;
}
/** The words a person sees on the page: the text of every element that shows, inside elements that show. */
function visibleText(el: FakeEl): string {
    if (!shows(el)) return '';
    return el.children.map((c) => ('text' in c ? c.text : visibleText(c))).join(' ').replace(/\s+/g, ' ').trim();
}
function findById(el: FakeEl, id: string): FakeEl | null {
    if (el.id === id) return el;
    for (const c of el.children) if (c instanceof FakeEl) { const f = findById(c, id); if (f) return f; }
    return null;
}

interface TrampolineOpts {
    lang?: Lang | null;
    /** What document.execCommand('copy') does: fire the copy event and say yes, say no, throw, or not exist at all. */
    exec?: 'yes' | 'yes-no-data' | 'no' | 'throws' | 'missing';
    /** navigator.clipboard: absent (plain http://), writeText only, writeText refusing, or write() with ClipboardItem. */
    clipboard?: 'none' | 'text' | 'rejects' | 'item' | 'item-rejects' | 'item-no-uri-list';
    /** The tab's sessionStorage, shared between runs to stand for a reload in the same tab. */
    storage?: Map<string, string>;
}

/**
 * Run the page's own script against the page's own HTML (a small DOM, {@link fakeDom}), as a browser at `search` on
 * `origin` with the user agent `ua`: what it links to (the store, the app, the web hatch), what its buttons copy and how,
 * and the words it shows. Nothing is fetched: the preflight is a no-op.
 */
function runTrampoline(search: string, ua: string, origin = 'https://mullum.beanpool.org', opts: TrampolineOpts = {}) {
    const html = renderInviteTrampoline({ webJoin: true, lang: opts.lang ?? null });
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    let selected = '';
    const body = fakeDom(html, (el) => { selected = el.value; });
    const el = (id: string) => {
        const found = findById(body, id);
        if (!found) throw new Error(`no element #${id}`);
        return found as FakeEl & Record<string, any>;
    };
    const copied: string[] = [];
    /** Every write, in order: by the copy event (its types), by write() (its types), or by writeText. */
    const writes: Array<{ via: 'event' | 'selection' | 'write' | 'writeText'; types: Record<string, string> }> = [];
    const docHandlers: Record<string, Array<(e: any) => void>> = {};
    const winHandlers: Record<string, Array<(e: any) => void>> = {};
    const storage = opts.storage ?? new Map<string, string>();
    const exec = opts.exec ?? 'missing';
    const clip = opts.clipboard ?? 'text';
    const url = new URL(origin);
    const loc = { search, origin, href: '', protocol: url.protocol, host: url.host };
    const document: any = {
        getElementById: (id: string) => findById(body, id),
        createElement: (tag: string) => new FakeEl(tag, {}, (e) => { selected = e.value; }),
        createRange: () => ({ selectNode() {} }),
        body,
        ontouchend: null,
        visibilityState: 'visible',
        addEventListener(ev: string, fn: (e: any) => void) { (docHandlers[ev] ||= []).push(fn); },
        removeEventListener(ev: string, fn: (e: any) => void) { docHandlers[ev] = (docHandlers[ev] ?? []).filter((f) => f !== fn); },
    };
    if (exec !== 'missing') {
        document.execCommand = (command: string) => {
            if (command !== 'copy') return false;
            if (exec === 'throws') throw new Error('SecurityError');
            if (exec === 'no') return false;
            if (exec === 'yes-no-data') { // the event has no data to fill: the browser copies what is selected
                for (const fn of docHandlers.copy ?? []) fn({ preventDefault() {} });
                writes.push({ via: 'selection', types: { 'text/plain': selected } });
                copied.push(selected);
                return true;
            }
            const types: Record<string, string> = {};
            let prevented = false;
            for (const fn of docHandlers.copy ?? []) fn({ clipboardData: { setData: (t: string, v: string) => { types[t] = v; } }, preventDefault: () => { prevented = true; } });
            const written = prevented ? types : { 'text/plain': selected };
            writes.push({ via: prevented ? 'event' : 'selection', types: written });
            copied.push(written['text/plain']);
            return true;
        };
    }
    class FakeClipboardItem {
        constructor(public items: Record<string, { text: string }>) {}
        static supports(type: string) { return clip !== 'item-no-uri-list' || type !== 'text/uri-list'; }
    }
    class FakeBlob { constructor(public parts: string[], public options: { type: string }) {} get text() { return this.parts.join(''); } }
    const clipboard: any = clip === 'none' ? undefined : {
        writeText: (t: string) => {
            writes.push({ via: 'writeText', types: { 'text/plain': t } });
            if (clip === 'rejects') return Promise.reject(new Error('NotAllowedError'));
            copied.push(t);
            return Promise.resolve();
        },
    };
    if (clipboard && clip.startsWith('item')) {
        clipboard.write = (items: FakeClipboardItem[]) => {
            const types = Object.fromEntries(Object.entries(items[0].items).map(([k, b]) => [k, b.text]));
            writes.push({ via: 'write', types });
            if (clip === 'item-rejects') return Promise.reject(new Error('NotAllowedError'));
            copied.push(types['text/plain']);
            return Promise.resolve();
        };
    }
    const sandbox: any = {
        URLSearchParams, encodeURIComponent, decodeURIComponent, JSON, setTimeout: () => 0,
        location: loc,
        navigator: { userAgent: ua, clipboard },
        document,
        Blob: FakeBlob,
        window: {
            getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
            sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, String(v)); } },
            addEventListener(ev: string, fn: (e: any) => void) { (winHandlers[ev] ||= []).push(fn); },
            ...(clip.startsWith('item') ? { ClipboardItem: FakeClipboardItem } : {}),
        },
        fetch: () => Promise.resolve({ ok: false }),
    };
    vm.runInNewContext(script, sandbox);
    const click = (id: string) => { for (const fn of el(id).handlers.click ?? []) fn({ preventDefault() {} }); };
    /** The person leaves the page (the App Store opens over it) and comes back to it. */
    const leaveAndComeBack = () => {
        for (const state of ['hidden', 'visible']) { document.visibilityState = state; for (const fn of docHandlers.visibilitychange ?? []) fn({}); }
    };
    const pageshow = () => { for (const fn of winHandlers.pageshow ?? []) fn({ persisted: true }); };
    /** The ids of the install area's elements that show, in page order. */
    const installOrder = () => el('installArea').children.filter((c): c is FakeEl => c instanceof FakeEl && shows(c)).map((c) => c.id);
    return { el, click, copied, writes, loc, storage, leaveAndComeBack, pageshow, installOrder, text: () => visibleText(body), html };
}
/** Lets the page's promises (an async copy's answer) settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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
        // The iPhone's words (the script's `var W`, section 1e) are in the visitor's language too since W1, 21 Nov.
        const withoutWords = (page: string) => page.replace(/ alt="[^"]*"( lang="fr")?/g, '').replace(/var W = [^\n]*;/, '');
        assert(withoutWords(fr) === withoutWords(html), 'badges: a language changes the alt text and the iPhone\'s words, and nothing else in the page');
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

    // 1e. The iPhone's page says only what happened (DESIGN-ios-invite-paste-fable.md §2, §4.2, §4.3; Marty 21 Nov: all of
    // Fable's picks). It printed "We've copied your code to the clipboard" when it loaded, before any tap, and dropped every
    // failure. Now the App Store badge copies inside its tap in a way the page can check (the copy event and
    // execCommand first, navigator.clipboard second, the same tap), writes the link as text and as a link, claims nothing
    // before the tap, says so when the copy failed, and puts "Open your invite in BeanPool" on top when the person comes back.
    {
        const RIVER = 'https://riverside.example';
        const LINK = `${RIVER}/?invite=INV-AB12-CD34`;
        const W = INVITE_PAGE_WORDS;
        const english = wordsIn(null);
        const LEAD = english.t(W.lead), COPIES = english.t(W.copies), NOT_COPIED = english.t(W.notCopied);
        const OPEN_FIRST = english.t(W.openFirst), OPEN_BACK = english.t(W.openBack);
        const claims = /copied|clipboard|paste/i;
        assert(LEAD === 'New here? Get BeanPool, then tap “I have an invite”.' && COPIES === 'Tapping the badge copies your invite.'
            && NOT_COPIED === 'Your invite wasn’t copied. After installing, come back here and tap Open your invite in BeanPool.'
            && OPEN_FIRST === 'Have BeanPool already? Open your invite in it' && OPEN_BACK === 'Open your invite in BeanPool',
            'iPhone: the page\'s words are the design\'s (§4.2)');
        assert(NOT_COPIED.includes(OPEN_BACK), 'iPhone: the failed copy\'s line names the button by the words it shows');

        // The page as served: no claim, no banner, nothing of ours.
        const html = renderInviteTrampoline({ webJoin: true });
        const noScript = html.replace(/<script>[\s\S]*?<\/script>/g, '');
        assert(!/copied|clipboard/i.test(noScript), 'iPhone: the page as served says nothing about a copy (no "copied", no "clipboard")');
        assert(!html.includes('We\\u2019ve copied') && !/we.ve copied/i.test(html) && !/paste your code/i.test(html), 'iPhone: the old early claim and its "paste your code" step are gone');
        assert(!/apple-itunes-app/i.test(html), 'iPhone: no Safari smart banner (with no app it goes to the store past the copy)');
        assert(!/beanpool\.(?:org|app|com|net)\b/i.test(html), 'the page names no domain of ours (it is each community\'s own page)');
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
        const guard: any = await import(path.join(root, 'scripts/check-no-node-names.mjs'));
        const pageSites = (lang: Lang | null) => guard.sitesIn('apps/server/src/routes/invite-trampoline.ts', renderInviteTrampoline({ webJoin: true, lang }));
        assert(pageSites(null).length === 0 && pageSites('fr').length === 0, 'the page names none of our communities or servers (the node-names guard\'s own list)');
        assert(/var W = \{[^\n]*\};/.test(html) && !/var W = [^\n]*<\//.test(html), 'iPhone: the words reach the script as JSON with no way out of the script block');
        // Even a catalog sentence written to break out stays a string inside the script (words are files anyone can edit).
        useCatalogsForTests('tr', { server: { Copy: '</script><img src=x onerror=alert(1)>\u2028&' } });
        const hostile = renderInviteTrampoline({ webJoin: true, lang: 'tr' });
        useCatalogsForTests('tr', null);
        assert(hostile.split('</script>').length === 2 && !hostile.includes('<img src=x') && hostile.includes('\\u003c/script\\u003e\\u003cimg src=x onerror=alert(1)\\u003e\\u2028\\u0026'),
            'iPhone: a catalog sentence holding </script>, a tag, U+2028 or & is escaped inside the script block');

        // Before any tap: the two lines and the button, the code card under them with its address, and nothing written.
        const before = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'yes' });
        const shown0 = before.text();
        assert(shown0.includes(LEAD) && shown0.includes(COPIES) && shown0.includes(OPEN_FIRST), 'iPhone, before a tap: the line over the badge, the line under it and "Have BeanPool already? Open your invite in it"');
        assert(!claims.test(shown0), `iPhone, before a tap: no word on the page says copied, clipboard or paste (${shown0.match(claims)?.[0] ?? ''})`);
        assert(before.writes.length === 0, 'iPhone, before a tap: nothing is written');
        assert(before.el('steps').style.display === 'none' && !shown0.includes('Install BeanPool from the App Store'), 'iPhone: the three steps are gone (two lines instead)');
        assert(JSON.stringify(before.installOrder()) === JSON.stringify(['iosLead', 'badges', 'copyNote', 'openAppBtn']), `iPhone: the line, the badge, the line under it, then the second button (${before.installOrder().join(', ')})`);
        assert(before.el('installArea').nextSibling === before.el('codecard'), 'iPhone: the code card comes after the buttons');
        assert(before.el('codeAt').textContent === 'at riverside.example' && !before.el('codeAt').hidden, 'iPhone: the code card names the address the code belongs to');
        assert(before.el('copyBtn').textContent === 'Copy' && before.el('codeLabel').textContent === 'Your invite code', 'iPhone: the code card says "Your invite code" and "Copy"');
        assert(before.el('openAppBtn').href === `beanpool://welcome?invite=INV-AB12-CD34&server=${encodeURIComponent(RIVER)}` && before.el('openAppBtn').className === 'cta secondary', 'iPhone: the second button is the app\'s own domain-free link with the invite, a real button');
        before.leaveAndComeBack();
        assert(before.installOrder()[0] === 'iosLead', 'iPhone: leaving and coming back with no store tap moves nothing');

        // The tap, when the copy event works: both forms, inside the tap, before anything else; the words don't change.
        const ok = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'yes', clipboard: 'text' });
        ok.click('iosStore');
        assert(ok.writes.length === 1 && ok.writes[0].via === 'event', 'iPhone tap: the copy event wrote it, inside the tap (before the click handler returned)');
        assert(ok.writes[0].types['text/plain'] === LINK && ok.writes[0].types['text/uri-list'] === LINK, 'iPhone tap: the link is written as text and as a link (text/uri-list)');
        await settle();
        assert(ok.writes.length === 1, 'iPhone tap: a copy that worked is not written twice (navigator.clipboard untouched)');
        assert(ok.el('copyNote').textContent === COPIES && ok.el('copyNote').className === 'copynote' && !ok.text().includes(NOT_COPIED), 'iPhone tap that copied: the line under the badge stays as it was, no failure shown');
        // Coming back from the store: the button that carries the invite itself goes on top, solid.
        ok.leaveAndComeBack();
        assert(ok.installOrder()[0] === 'openAppBtn' && ok.el('openAppBtn').className === 'cta' && ok.el('openAppBtn').textContent === OPEN_BACK, 'iPhone, back from the store: "Open your invite in BeanPool" is on top, solid');
        assert(ok.el('openAppBtn').href.startsWith('beanpool://welcome?invite=INV-AB12-CD34&server='), 'iPhone, back from the store: the top button still carries the invite');
        assert(JSON.parse(ok.storage.get('beanpool-invite-store-tap') ?? 'null')?.copy === 'copied', 'iPhone tap: the tab remembers the store tap and that the copy worked');

        // A browser that fires the event with nothing to fill copies what is selected: the link, as text.
        const sel = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'yes-no-data' });
        sel.click('iosStore');
        await settle();
        assert(sel.writes.length === 1 && sel.writes[0].via === 'selection' && sel.writes[0].types['text/plain'] === LINK && !sel.text().includes(NOT_COPIED), 'iPhone tap: with no data to fill, the selected link is what is copied, and that counts');

        // The copy event says no: navigator.clipboard, in the same tap, with both forms where it takes them.
        const item = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'no', clipboard: 'item' });
        item.click('iosStore');
        assert(item.writes.length === 1 && item.writes[0].via === 'write' && item.writes[0].types['text/plain'] === LINK && item.writes[0].types['text/uri-list'] === LINK, 'iPhone tap: when the copy event says no, navigator.clipboard writes both forms, in the same tap');
        await settle();
        assert(!item.text().includes(NOT_COPIED), 'iPhone tap: a navigator.clipboard copy that worked shows no failure');
        const noUri = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'throws', clipboard: 'item-no-uri-list' });
        noUri.click('iosStore');
        assert(noUri.writes.length === 1 && noUri.writes[0].via === 'writeText' && noUri.writes[0].types['text/plain'] === LINK, 'iPhone tap: a browser that takes no text/uri-list gets the link as text, in the tap');
        const itemNo = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'no', clipboard: 'item-rejects' });
        itemNo.click('iosStore');
        await settle();
        assert(itemNo.writes.map((w) => w.via).join(',') === 'write,writeText' && !itemNo.text().includes(NOT_COPIED), 'iPhone tap: when write() refuses both forms, the link as text is tried, and its yes counts');

        // Every way failed: say so, with the way that needs no clipboard; back from the store, that button is on top.
        const fail = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'no', clipboard: 'rejects' });
        fail.click('iosStore');
        assert(!fail.text().includes(NOT_COPIED), 'iPhone tap: nothing is claimed while the answer is still coming');
        await settle();
        assert(fail.el('copyNote').textContent === NOT_COPIED && fail.el('copyNote').className === 'copynote warn' && !fail.text().includes(COPIES), 'iPhone tap that failed: "Your invite wasn\'t copied…" in place of the line under the badge');
        assert(fail.el('copyNote').getAttribute('role') === 'status', 'iPhone: the line under the badge is announced when it changes (role="status")');
        fail.leaveAndComeBack();
        assert(fail.installOrder()[0] === 'openAppBtn' && fail.el('openAppBtn').textContent === OPEN_BACK && fail.text().includes(NOT_COPIED), 'iPhone, back after a failed copy: the failed line stays and the button it names is on top');

        // Plain http:// (a hall laptop, a bare address): no navigator.clipboard at all. The copy event still works there.
        const HALL = 'http://10.1.2.3:8080';
        const http = runTrampoline('?invite=INV-AB12-CD34', IPHONE, HALL, { exec: 'yes', clipboard: 'none' });
        http.click('iosStore');
        await settle();
        assert(http.writes.length === 1 && http.writes[0].types['text/plain'] === `${HALL}/?invite=INV-AB12-CD34` && !http.text().includes(NOT_COPIED), 'iPhone on http://: the copy event copies the link with no navigator.clipboard');
        assert(http.el('codeAt').textContent === `at ${HALL}`, 'iPhone on http://: the code card gives the whole address, http:// and all, as the app needs it typed');
        const httpNo = runTrampoline('?invite=INV-AB12-CD34', IPHONE, HALL, { exec: 'no', clipboard: 'none' });
        httpNo.click('iosStore');
        await settle();
        assert(httpNo.writes.length === 0 && httpNo.el('copyNote').textContent === NOT_COPIED, 'iPhone on http:// where the copy event says no: nothing to fall back on, and the page says it wasn\'t copied');
        const missing = runTrampoline('?invite=INV-AB12-CD34', IPHONE, HALL, { exec: 'missing', clipboard: 'none' });
        missing.click('iosStore');
        await settle();
        assert(missing.el('copyNote').textContent === NOT_COPIED, 'iPhone with no way to copy at all: the page says it wasn\'t copied');

        // Back by Safari's back button (the page restored from its cache) and back after iOS reloaded the page.
        const cached = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'yes' });
        cached.click('iosStore');
        cached.pageshow();
        assert(cached.installOrder()[0] === 'openAppBtn', 'iPhone: the page restored from Safari\'s cache comes back with the invite\'s button on top');
        const tab = new Map<string, string>();
        const first = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'no', clipboard: 'rejects', storage: tab });
        first.click('iosStore');
        await settle();
        const reloaded = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'no', storage: tab });
        assert(reloaded.installOrder()[0] === 'openAppBtn' && reloaded.el('openAppBtn').textContent === OPEN_BACK && reloaded.el('copyNote').textContent === NOT_COPIED, 'iPhone: a page iOS reloads after the store tap still shows the way back on top, and the failed copy');
        assert(reloaded.writes.length === 0, 'iPhone: a reload writes nothing (no copy without a tap)');
        const other = runTrampoline('?invite=INV-ZZ99-YY88', IPHONE, RIVER, { exec: 'no', storage: tab });
        assert(other.installOrder()[0] === 'iosLead' && other.el('copyNote').textContent === COPIES, 'iPhone: another invite opened in the same tab starts fresh');

        // The code card's Copy: "Copied" only when it was.
        const card = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'no', clipboard: 'rejects' });
        card.click('copyBtn');
        await settle();
        assert(card.el('copyBtn').textContent === 'Copy', 'iPhone: Copy that failed never says "Copied"');
        const cardOk = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'yes' });
        cardOk.click('copyBtn');
        await settle();
        assert(cardOk.el('copyBtn').textContent === 'Copied ✓' && cardOk.writes[0].types['text/uri-list'] === LINK, 'iPhone: Copy that worked says "Copied ✓", both forms written');

        // In the visitor's language: the catalog's words, marked with the language; right to left where it reads so.
        const fr = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'no', clipboard: 'rejects', lang: 'fr' });
        const frW = wordsIn('fr');
        assert(fr.el('iosLead').textContent === frW.t(W.lead) && frW.t(W.lead) !== LEAD && fr.el('iosLead').getAttribute('lang') === 'fr', 'iPhone in French: the line over the badge is the catalog\'s, marked as French');
        assert(fr.el('codeAt').textContent === frW.t(W.codeAt).replace('{address}', 'riverside.example') && fr.el('copyBtn').textContent === frW.t(W.copy), 'iPhone in French: the code card\'s words are the catalog\'s, the address filled in');
        fr.click('iosStore');
        await settle();
        fr.leaveAndComeBack();
        assert(fr.el('copyNote').textContent === frW.t(W.notCopied) && fr.el('openAppBtn').textContent === frW.t(W.openBack) && fr.el('openAppBtn').getAttribute('lang') === 'fr', 'iPhone in French: the failed line and the button on top are the catalog\'s');
        const ar = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'yes', lang: 'ar' });
        assert(ar.el('iosLead').getAttribute('dir') === 'rtl' && ar.el('iosLead').getAttribute('lang') === 'ar', 'iPhone in Arabic: the lines read right to left');
        useCatalogsForTests('tr', { server: {} });
        const trBare = runTrampoline('?invite=INV-AB12-CD34', IPHONE, RIVER, { exec: 'yes', lang: 'tr' });
        useCatalogsForTests('tr', null);
        assert(trBare.el('iosLead').textContent === LEAD && trBare.el('iosLead').getAttribute('lang') === null, 'iPhone in a language whose catalog lacks the words: the English, unmarked');
        let everyLanguage = true;
        for (const lang of LANGS.filter((l) => l !== 'en')) {
            const w = wordsIn(lang);
            for (const [name, key] of Object.entries(W)) {
                const text = w.t(key);
                const enText = english.t(key);
                const sameEnglish = text === enText;
                const placeholders = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).join();
                if (sameEnglish || placeholders(text) !== placeholders(enText) || (enText.includes('BeanPool') && !text.includes('BeanPool'))) {
                    everyLanguage = false;
                    console.error(`  ${lang} ${name}: ${text}`);
                }
            }
            // The failed line names the button by the very words the button shows, in each language.
            if (!w.t(W.notCopied).includes(w.t(W.openBack))) { everyLanguage = false; console.error(`  ${lang}: the failed line does not name "${w.t(W.openBack)}"`); }
        }
        assert(everyLanguage, `iPhone: all ${LANGS.length - 1} languages have the page's words (machine drafts), with their placeholders and BeanPool, and the failed line names the button as it reads`);
        assert(/^#[0-9a-f]{6}$/i.test(WARN.tint) && /^#[0-9a-f]{6}$/i.test(WARN.ink) && html.includes(`background:${WARN.tint}; color:${WARN.ink};`), 'iPhone: the failed line\'s colours are the warning chip\'s, from core\'s colour library');

        // Android's part is as it was: no iPhone lines, the code card where it was, its own words and steps.
        const and = runTrampoline('?invite=INV-AB12-CD34', ANDROID, RIVER, { exec: 'yes' });
        assert(and.el('iosLead').hidden && and.el('copyNote').hidden && and.el('codeAt').hidden, 'Android: none of the iPhone\'s lines');
        assert(and.el('codecard').nextSibling === and.el('installArea') && and.el('copyBtn').textContent === 'Copy code', 'Android: the code card is where it was, with "Copy code"');
        assert(and.text().includes('Tap Open your invite in BeanPool') && and.text().includes('Choose a callsign and you’re in'), 'Android: its three steps are as they were');
        and.click('installBtn');
        assert(and.copied[0] === LINK, 'Android: the main button still copies the invite link');
        const desk = runTrampoline('?invite=INV-AB12-CD34', 'Mozilla/5.0 (X11; Linux x86_64)', RIVER, { exec: 'yes' });
        assert(desk.el('iosLead').hidden && desk.el('copyNote').hidden && desk.text().includes('Open this invite link on your phone'), 'desktop: none of the iPhone\'s lines, the nudge to a phone as before');
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
