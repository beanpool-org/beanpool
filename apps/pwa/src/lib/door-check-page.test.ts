/**
 * The door's check page (apps/door-check), run for real in a small stand-in for a browser. It is a static page with no
 * tests of its own, and two of its promises matter: a token goes only to a node on its list (Turnstile trusts this page's
 * hostname, so a page that sent a token anywhere would let any website make tokens), and every way it can fail ends in
 * an answer to the app, because the app is what says so in words.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const DIR = path.resolve(__dirname, '../../../door-check');
const SCRIPT = fs.readFileSync(path.join(DIR, 'check.js'), 'utf-8');
const CDATA = 'ab'.repeat(16);
const NODE = 'https://global.beanpool.org';

interface Widget { options: any }

function open(hash: string, o: { embedded?: boolean; width?: number; widgetThrows?: boolean } = {}) {
    const replaced: string[] = [];
    const posted: any[] = [];
    const widgets: Widget[] = [];
    const scripts: any[] = [];
    const timers: Array<() => void> = [];
    const back: any = { hidden: true };
    const documentElement: any = { className: '' };
    const win: any = {
        location: { hash, replace: (u: string) => replaced.push(u) },
        innerWidth: o.width ?? 360,
        setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
        clearTimeout: () => { timers.length = 0; },
        document: {
            documentElement,
            getElementById: () => back,
            createElement: () => { const s: any = {}; scripts.push(s); return s; },
            head: { appendChild: () => undefined },
        },
    };
    if (o.embedded) win.ReactNativeWebView = { postMessage: (s: string) => posted.push(JSON.parse(s)) };
    win.window = win;
    win.turnstile = { render: (_at: string, options: any) => { if (o.widgetThrows) throw new Error('no'); widgets.push({ options }); } };
    vm.runInNewContext(SCRIPT, win);
    return { win, replaced, posted, widgets, scripts, timers, back, documentElement };
}

const asked = (extra = '') => `#sitekey=0x4AAA&cdata=${CDATA}&theme=dark${extra}`;
const onWeb = asked(`&return=${encodeURIComponent(NODE)}`);

describe('the check page', () => {
    it('runs the widget for this key: action join, its cdata, the theme asked for, and retries left to the member', () => {
        const p = open(onWeb);
        expect(p.scripts[0].src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onDoorCheckReady');
        p.win.onDoorCheckReady();
        expect(p.widgets[0].options).toMatchObject({ sitekey: '0x4AAA', action: 'join', cData: CDATA, theme: 'dark', size: 'flexible', retry: 'never' });
        expect(p.documentElement.className).toBe('dark');
    });

    it('fits 320 px; narrower than the widget\'s least width, its compact size', () => {
        const wide = open(onWeb, { width: 320 });
        wide.win.onDoorCheckReady();
        expect(wide.widgets[0].options.size).toBe('flexible');
        const narrow = open(onWeb, { width: 300 });
        narrow.win.onDoorCheckReady();
        expect(narrow.widgets[0].options.size).toBe('compact');
    });

    it('sends the token back in the fragment, to the node\'s own return page', () => {
        const p = open(onWeb);
        p.win.onDoorCheckReady();
        p.widgets[0].options.callback('0.a+token');
        expect(p.replaced).toEqual([`${NODE}/app/auth/check#token=0.a%2Btoken`]);
    });

    it('hands a token to nobody else: a return that is not on the list gets no widget at all', () => {
        for (const evil of ['https://evil.example', 'https://global.beanpool.org.evil.example', 'http://global.beanpool.org', 'javascript:alert(1)', '']) {
            const p = open(asked(`&return=${encodeURIComponent(evil)}`));
            expect(p.scripts).toHaveLength(0);
            expect(p.replaced).toHaveLength(0);
        }
    });

    it('does nothing for a page opened with no key, or a cdata that is not one', () => {
        expect(open(`#sitekey=x&return=${encodeURIComponent(NODE)}`).scripts).toHaveLength(0);
        expect(open(`#sitekey=x&cdata=<script>&return=${encodeURIComponent(NODE)}`).scripts).toHaveLength(0);
        expect(open(`#cdata=${CDATA}&return=${encodeURIComponent(NODE)}`).scripts).toHaveLength(0);
    });

    it('in the phone\'s embedded browser, tells the app and goes nowhere', () => {
        const p = open(asked(), { embedded: true });
        p.win.onDoorCheckReady();
        expect(p.posted).toEqual([{ ready: true }]);
        p.widgets[0].options.callback('0.tok');
        expect(p.posted[1]).toEqual({ token: '0.tok' });
        expect(p.replaced).toHaveLength(0);
        expect(p.back.hidden).toBe(true);
    });

    it('every failure ends in an answer, once: a widget error, a timeout, an expiry, an old browser, no script, too slow', () => {
        for (const [what, end] of [
            ['error-callback', 'failed'], ['timeout-callback', 'failed'], ['expired-callback', 'failed'], ['unsupported-callback', 'wont_load'],
        ] as const) {
            const p = open(onWeb);
            p.win.onDoorCheckReady();
            p.widgets[0].options[what]();
            p.widgets[0].options.callback('late');
            expect(p.replaced).toEqual([`${NODE}/app/auth/check#error=${end}`]);
        }
        const noScript = open(onWeb);
        noScript.scripts[0].onerror();
        expect(noScript.replaced).toEqual([`${NODE}/app/auth/check#error=wont_load`]);
        const slow = open(onWeb);
        slow.timers[0]();
        expect(slow.replaced).toEqual([`${NODE}/app/auth/check#error=wont_load`]);
        const broken = open(onWeb, { widgetThrows: true });
        broken.win.onDoorCheckReady();
        expect(broken.replaced).toEqual([`${NODE}/app/auth/check#error=wont_load`]);
    });

    it('the way back on the web says it was closed, so the app asks nothing of the member', () => {
        const p = open(onWeb);
        expect(p.back.hidden).toBe(false);
        p.back.onclick();
        expect(p.replaced).toEqual([`${NODE}/app/auth/check#error=closed`]);
    });

    it('runs on an old WebView: no arrow, no let or const, no template, no URLSearchParams', () => {
        expect(SCRIPT.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/=>|\b(let|const|class)\s|`|URLSearchParams/);
    });

    it('its headers let no other script in and keep it out of frames', () => {
        const headers = fs.readFileSync(path.join(DIR, '_headers'), 'utf-8');
        expect(headers).toMatch(/script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
        expect(headers).toMatch(/frame-ancestors 'none'/);
        // The origin and nothing more: the page's own host, which Cloudflare already knows, and never a path or a fragment.
        expect(headers).toMatch(/Referrer-Policy: strict-origin$/m);
        expect(vi.isMockFunction(fs.readFileSync)).toBe(false);
    });
});
