/*
 * BeanPool's service worker (scratch/fable-design/DESIGN-web-notifications-fable.md §2.2-§2.3, slice W1): push and
 * notificationclick, nothing else. Written by hand, served by the node as it is (apps/pwa/public → apps/server/public).
 *
 * Registered by the web app only at a tap ("Tell me when they answer" on the waiting page; a member's "Turn on", slice W2;
 * src/lib/web-push.ts), never on load, at scope /app/. No fetch handler and no cache: the app works exactly as without it.
 * It holds no key, signs nothing and reads no storage of the member's (src/lib/sw-rules.test.ts holds it to that).
 *
 * What it shows is fixed: the title is always "BeanPool", never the payload's; the text is the payload's one sentence (its
 * kind's fixed words, which the community's own server encrypted to this browser; anything that is not a short plain
 * sentence shows as no text); the icon is BeanPool's; no image, action, link or sound from the payload. The tag is the
 * kind, so a second notice of one kind takes the first one's place; in an asked community's registration (below) it is the
 * kind and that community's host, `join.answered:<host>`, as every registration of a site shares its notifications' tags,
 * so two communities' yeses each keep their own.
 *
 * A click opens /app?door=ask for `join.answered` (/app for anything else), with the signed notice in the address's
 * fragment, which no server is sent: the waiting page checks the notice's signature with the community key it pinned
 * (src/lib/web-push.ts noticeInLocation) and opens nothing for a forgery. Only a tab this worker controls (under /app/) is
 * taken there instead; the waiting page's own tab never is (see landOn). A member's notice (any other kind) goes to the
 * member's open app tab instead, when there is one: brought forward and handed the notice as a message, which the app
 * checks exactly as one in its address (src/lib/web-push.ts checkClickedNotice, the phone's checkTap).
 *
 * Told from another origin (DESIGN-global-yes-join-fable.md §2.4, slice Y2): a member who asked another community from
 * Home's Find card subscribes there with that community's key, through a registration of its own at /app/knock/<host>/
 * (a registration holds one subscription, bound to one community's key, so the member's own at /app/ stays as it is). That
 * registration controls no page. It shows what comes exactly as above; a click opens /app?knock=<host> with the notice in the
 * fragment, Home's Find card on that community's row, where the app checks the notice with the key it pinned for that
 * community (src/lib/knock-landing.ts) and opens nothing for a forgery.
 *
 * Registered anywhere else (a browser that kept the old self-removing worker's registration at /), it removes itself.
 */
/* eslint-env serviceworker */
const TITLE = 'BeanPool';
const ICON = '/icon-192x192.png';
const KIND = /^(?=.{1,64}$)[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const MAX_SENTENCE = 200;

const KNOCK_SCOPE = /^\/app\/knock\/([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?)\/$/;

const scopePath = () => new URL(self.registration.scope).pathname;
/** The community this registration was made for (its scope /app/knock/<host>/), or null for the member's own at /app/. */
const knockHost = () => {
    const m = KNOCK_SCOPE.exec(scopePath());
    return m ? m[1] : null;
};
const inScope = () => scopePath() === '/app/' || knockHost() !== null;

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    if (!inScope()) event.waitUntil(self.registration.unregister());
});

function payloadOf(event) {
    try {
        const p = event.data ? event.data.json() : null;
        return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch {
        return {};
    }
}

/** The payload's sentence when it is a short line of plain text; otherwise none. */
function sentenceOf(value) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value) || value.length > MAX_SENTENCE) return '';
    return value.trim();
}

/** The notice to hand to the app on a click: the signed fields only, as they came. */
function noticeOf(data) {
    if (!data || typeof data !== 'object') return null;
    const { bp, k, i, t, c, s } = data;
    return { bp, k, i, t, c, s };
}

self.addEventListener('push', (event) => {
    if (!inScope()) return;
    const p = payloadOf(event);
    const notice = noticeOf(p.data);
    const kind = notice && typeof notice.k === 'string' && KIND.test(notice.k) ? notice.k : 'beanpool';
    const host = knockHost();
    const tag = host ? `${kind}:${host}` : kind;
    event.waitUntil(self.registration.showNotification(TITLE, { body: sentenceOf(p.body), tag, icon: ICON, data: { notice } }));
});

/**
 * Where a click on a notice lands: for a community asked from here, Home's row for it; the waiting page for a yes; the app
 * otherwise. The notice in the fragment.
 */
function landingOf(notice) {
    const host = knockHost();
    const path = host ? `/app?knock=${encodeURIComponent(host)}` : notice && notice.k === 'join.answered' ? '/app?door=ask' : '/app';
    return notice ? `${path}#notice=${encodeURIComponent(JSON.stringify(notice))}` : path;
}

/**
 * Takes a click to `target`. A tab this worker controls (one under /app/) is taken there, then brought forward: navigate()
 * spends nothing, focus() spends the click's one window call. Any other tab can't be taken anywhere: the waiting page
 * itself, /app?door=ask, is outside the scope /app/, so this worker never controls it and its navigate() always fails. So
 * a new tab opens there at once, with nothing focused first: a click allows one window call, and in Chromium focus() spends
 * it exactly as openWindow() does (e2e/sw-click-check.mjs). The old tab reads the status itself within 5 minutes.
 */
async function landOn(target, notice) {
    // A community asked from here: this registration controls no tab, and the member's open app checks a notice by its own
    // community's key, so a new tab opens on Home's row (the click's one window call).
    if (knockHost()) {
        await self.clients.openWindow(target);
        return;
    }
    if (notice && notice.k !== 'join.answered' && (await toOpenApp(notice))) return;
    const tabs = await self.clients.matchAll({ type: 'window' });
    const tab = tabs.find((c) => {
        const u = new URL(c.url);
        return u.origin === self.location.origin && u.pathname.startsWith('/app/');
    });
    if (tab) {
        let moved = null;
        try {
            moved = await tab.navigate(new URL(target, self.location.origin).href);
        } catch {
            moved = null;
        }
        if (moved) {
            await moved.focus().catch(() => {});
            return;
        }
    }
    await self.clients.openWindow(target);
}

/**
 * A member's notice, to the member's app already open in a tab of this site (/app, not the waiting page; this worker
 * controls none of them, so it looks at every tab of its origin): brought forward with the click's one window call, then
 * handed the notice as a message (`beanpool-notice`). False when no such tab took it: the caller opens a new one.
 */
async function toOpenApp(notice) {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = tabs.find((c) => {
        const u = new URL(c.url);
        return u.origin === self.location.origin && (u.pathname === '/app' || u.pathname.startsWith('/app/')) && !/[?&]door=/.test(u.search);
    });
    if (!app) return false;
    try {
        const shown = (await app.focus()) || app;
        shown.postMessage({ type: 'beanpool-notice', notice });
        return true;
    } catch {
        return false;
    }
}

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const notice = event.notification.data && event.notification.data.notice;
    event.waitUntil(landOn(landingOf(notice), notice));
});
