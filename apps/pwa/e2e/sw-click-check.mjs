/**
 * A click on a web push notice, with the real service worker (public/sw.js) in headless Chromium (web push W1, round 2 of
 * #3005; DESIGN-web-notifications-fable.md §2.3).
 *
 * The waiting page is /app?door=ask, outside the worker's scope /app/, so the worker never controls it. This checks, in a
 * real browser, what the unit test's sandbox can only describe:
 *   1. the waiting page is not controlled; clients.matchAll() without includeUncontrolled leaves it out; and navigate() on
 *      it fails (so the worker can never take that tab anywhere);
 *   2. a push delivered to the worker (DevTools' deliverPushMessage, a real push event) asks for BeanPool's notice, and a
 *      click on it, with the waiting page open, opens /app?door=ask with the signed notice in the fragment, and focuses
 *      nothing before it;
 *   3. with no tab open, the same click opens it too;
 *   4. a tab the worker DOES control (under /app/) is taken there with a real navigate(), and brought forward, with no
 *      second tab.
 *
 * What no automation can make is the click itself: Chromium lets a worker focus() a tab or openWindow() only inside a real
 * click on its notification, ONE such call per click (each spends it; "Not allowed to open a window." after a focus), and
 * DevTools has no way to click a notification. So the click event is dispatched in the real worker with that one rule
 * kept: focus() and openWindow() are wrapped to allow exactly one call between them. The allowed openWindow() is carried
 * out by opening its address in a new page; the allowed focus() is recorded. And Playwright's headless Chromium has no
 * notification centre (its permission always reads denied), so showNotification() is recorded, and the click carries
 * back the data the worker gave it, as the browser's Notification would. Everything else is the browser's own: the scope,
 * control, matchAll, navigate (on a controlled tab and on the waiting page's), and the push event.
 *
 * Nothing here talks to a node: a local server serves the worker and a page that shows its own address.
 *
 * Run: pnpm --filter @beanpool/pwa sw-click-check            (the worker as it ships)
 *      node e2e/sw-click-check.mjs <path to another sw.js>     (e.g. an older one, to see it fail)
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global URL, console, process, setTimeout, self, navigator, WindowClient, ExtendableEvent, DOMException -- Node, and the page's and worker's side of evaluate() */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_FILE = path.resolve(process.argv[2] ?? path.join(PWA_DIR, 'public/sw.js'));

// A page that says where it is and whether a worker controls it.
const PAGE = `<!doctype html><meta charset="utf-8"><title>BeanPool</title><pre id="where"></pre><script>
document.getElementById('where').textContent = location.pathname + location.search + location.hash;
</script>`;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        res.end(fs.readFileSync(WORKER_FILE));
    } else if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
    } else {
        res.writeHead(404);
        res.end();
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// A notice as the community signs it (only its shape matters here: the worker checks no signature; the page does).
const NOTICE = { bp: 1, c: 'ab'.repeat(8), k: 'join.answered', i: 'cd'.repeat(16), t: Math.floor(Date.now() / 1000), s: 'ef'.repeat(64) };
const PAYLOAD = { title: 'Not this title', body: 'A community answered your request to join.', data: NOTICE };

/** The same fields with the same values, in any order. */
const same = (a, b) => {
    const canon = (o) => JSON.stringify(Object.keys(o ?? {}).sort().map(k => [k, o[k]]));
    return !!a && !!b && canon(a) === canon(b);
};
/** Where a page says it is: /app?door=ask with the notice its fragment carries, or null. */
const landedAt = (where) => {
    const m = /^(\/app\?door=ask)#notice=([^&]*)$/.exec(where ?? '');
    if (!m) return null;
    try { return { path: m[1], notice: JSON.parse(decodeURIComponent(m[2])) }; } catch { return null; }
};
const landsWithNotice = (where) => same(landedAt(where)?.notice, NOTICE);

const failures = [];
const check = (ok, what, detail) => {
    console.log(`${ok ? '✓' : '✗'} ${what}${ok || detail === undefined ? '' : `\n    ${JSON.stringify(detail)}`}`);
    if (!ok) failures.push(what);
};

const browser = await chromium.launch();
try {
    const context = await browser.newContext();

    // The waiting page, which registers the worker at /app/ (as the Tell me tap does).
    const waiting = await context.newPage();
    await waiting.goto(`${ORIGIN}/app?door=ask`);
    const workerSeen = context.waitForEvent('serviceworker').catch(() => null);
    const scope = await waiting.evaluate(async () => {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/app/' });
        const w = reg.installing ?? reg.waiting ?? reg.active;
        if (w.state !== 'activated') await new Promise(resolve => w.addEventListener('statechange', () => { if (w.state === 'activated') resolve(); }));
        return reg.scope;
    });
    const worker = context.serviceWorkers().find(w => w.url().endsWith('/sw.js')) ?? await workerSeen;
    check(scope === `${ORIGIN}/app/`, 'the worker is registered at /app/', scope);

    // 1. The browser's own rules for the waiting page's tab.
    const controlled = await waiting.evaluate(() => !!navigator.serviceWorker.controller);
    check(!controlled, 'the waiting page (/app?door=ask) is not controlled by the /app/ worker');
    const seen = await worker.evaluate(async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const mine = await self.clients.matchAll({ type: 'window' });
        let navigate = 'resolved';
        const tab = all.find(c => new URL(c.url).search === '?door=ask');
        try { await tab.navigate(tab.url + '#x'); } catch (e) { navigate = `${e.name}: ${e.message}`; }
        return { all: all.map(c => new URL(c.url).pathname + new URL(c.url).search), mine: mine.map(c => c.url), navigate };
    });
    check(seen.all.includes('/app?door=ask') && seen.mine.length === 0, 'matchAll sees the waiting page only when asked for uncontrolled tabs', seen);
    check(seen.navigate.startsWith('TypeError'), "navigate() on the waiting page's tab fails", seen.navigate);

    // The click's one window call, kept: focus() and openWindow() share it. Installed once, re-armed per click.
    await worker.evaluate(() => {
        self.__click = { allowance: 0, calls: [], refused: [] };
        const spend = (what, url) => {
            if (self.__click.allowance < 1) { self.__click.refused.push(`${what} ${url}`); return false; }
            self.__click.allowance--;
            self.__click.calls.push(`${what} ${url}`);
            return true;
        };
        WindowClient.prototype.focus = function () {
            if (!spend('focus', this.url)) return Promise.reject(new DOMException('Not allowed to focus a window.', 'InvalidAccessError'));
            return Promise.resolve(this);
        };
        self.clients.openWindow = (url) => {
            if (!spend('openWindow', new URL(url, self.location.origin).href)) return Promise.reject(new DOMException('Not allowed to open a window.', 'InvalidAccessError'));
            return Promise.resolve(null);
        };
        // An event dispatched here is not the browser's own, so waitUntil would refuse it: keep its promise instead.
        ExtendableEvent.prototype.waitUntil = function (p) { self.__click.waited = p; };
        // No notification centre here: what the worker asks to show is kept, as the browser would keep it.
        self.__shown = [];
        self.registration.showNotification = (title, options) => { self.__shown.push({ title, ...options }); return Promise.resolve(); };
    });

    // 2. A real push shows the notice; the click lands with it.
    const cdp = await context.newCDPSession(waiting);
    let regId = null;
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
        const r = registrations.find(x => x.scopeURL === `${ORIGIN}/app/` && !x.isDeleted);
        if (r) regId = r.registrationId;
    });
    await cdp.send('ServiceWorker.enable');
    for (let i = 0; i < 50 && !regId; i++) await new Promise(r => setTimeout(r, 100));
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: ORIGIN, registrationId: regId, data: JSON.stringify(PAYLOAD) });
    let shown = [];
    for (let i = 0; i < 50 && shown.length === 0; i++) {
        shown = await worker.evaluate(() => self.__shown);
        if (shown.length === 0) await new Promise(r => setTimeout(r, 100));
    }
    check(shown.length === 1 && shown[0].title === 'BeanPool' && shown[0].tag === 'join.answered' && shown[0].body === PAYLOAD.body,
        'a real push asks for BeanPool\'s notice: its own title, the sentence, the kind as tag', shown);
    check(same(shown[0]?.data?.notice, NOTICE), 'the notice rides with it, as signed', shown[0]?.data);

    /** Clicks the notice the push asked for (its data handed back, as a Notification's), with one window call allowed. */
    const click = () => worker.evaluate(async () => {
        const data = self.__shown[self.__shown.length - 1].data;
        self.__click.allowance = 1;
        self.__click.calls = [];
        self.__click.refused = [];
        self.__click.closed = 0;
        const event = new ExtendableEvent('notificationclick');
        Object.defineProperty(event, 'notification', { value: { data, close: () => { self.__click.closed++; } } });
        self.dispatchEvent(event);
        await Promise.resolve(self.__click.waited).catch(e => { self.__click.refused.push(`threw ${e && e.name}`); });
        self.__click.allowance = 0;
        return { calls: self.__click.calls, refused: self.__click.refused, closed: self.__click.closed };
    });
    /** Carries out an allowed openWindow(): the page it opened, and where that page says it is. */
    const opened = async (calls) => {
        const open = calls.find(c => c.startsWith('openWindow '));
        if (!open) return null;
        const page = await context.newPage();
        await page.goto(open.slice('openWindow '.length));
        const where = await page.locator('#where').textContent();
        return { page, where };
    };

    const withWaitingOpen = await click();
    check(withWaitingOpen.closed === 1, 'the click closes the notice', withWaitingOpen);
    check(withWaitingOpen.calls.length === 1 && withWaitingOpen.calls[0].startsWith('openWindow ') && withWaitingOpen.refused.length === 0,
        'with the waiting page open, the click opens a tab first and focuses nothing before it', withWaitingOpen);
    const landed = await opened(withWaitingOpen.calls);
    check(landsWithNotice(landed?.where), 'that tab is /app?door=ask with the signed notice in the fragment', landed?.where);
    await landed?.page.close();

    // 3. No tab open at all.
    await waiting.close();
    const noTab = await click();
    const landedFresh = await opened(noTab.calls);
    check(noTab.calls.length === 1 && landsWithNotice(landedFresh?.where), 'with no tab open, the click opens /app?door=ask with the notice', { noTab, where: landedFresh?.where });

    // 4. A tab under /app/, loaded after the worker took over: controlled, so it is taken there and brought forward.
    for (const p of context.pages()) await p.close();
    const inScope = await context.newPage();
    await inScope.goto(`${ORIGIN}/app/`);
    const inScopeControlled = await inScope.evaluate(() => !!navigator.serviceWorker.controller);
    check(inScopeControlled, 'a tab under /app/ opened after the worker took over is controlled');
    const pagesBefore = context.pages().length;
    const taken = await click();
    await inScope.waitForURL(u => u.pathname === '/app' && u.search === '?door=ask', { timeout: 5000 }).catch(() => {});
    const takenWhere = await inScope.locator('#where').textContent().catch(() => null);
    check(taken.calls.length === 1 && taken.calls[0].startsWith('focus ') && taken.refused.length === 0,
        'that tab is taken there with a real navigate() and brought forward (its one window call), no tab opened', taken);
    check(landsWithNotice(takenWhere) && context.pages().length === pagesBefore, 'it shows /app?door=ask with the notice, and no second tab opens', { takenWhere, pages: context.pages().length });
} finally {
    await browser.close();
    server.close();
}

if (failures.length) {
    console.error(`\n${failures.length} check(s) failed (worker: ${path.relative(process.cwd(), WORKER_FILE)})`);
    process.exit(1);
}
console.log('\nAll checks passed.');
