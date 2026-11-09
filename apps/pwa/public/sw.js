/*
 * BeanPool's service worker (scratch/fable-design/DESIGN-web-notifications-fable.md §2.2-§2.3, slice W1): push and
 * notificationclick, nothing else. Written by hand, served by the node as it is (apps/pwa/public → apps/server/public).
 *
 * Registered by the web app only at a tap ("Tell me when they answer" on the waiting page, src/lib/web-push.ts), never on
 * load, at scope /app/. No fetch handler and no cache: the app works exactly as without it. It holds no key, signs nothing
 * and reads no storage of the member's.
 *
 * What it shows is fixed: the title is always "BeanPool", never the payload's; the text is the payload's one sentence (its
 * kind's fixed words, which the community's own server encrypted to this browser; anything that is not a short plain
 * sentence shows as no text); the icon is BeanPool's; no image, action, link or sound from the payload. The tag is the
 * kind, so a second notice of one kind takes the first one's place.
 *
 * A click focuses an open BeanPool tab and takes it to /app?door=ask for `join.answered` (/app for anything else), or opens
 * one there, with the signed notice in the address's fragment, which no server is sent: the waiting page checks the
 * notice's signature with the community key it pinned (src/lib/web-push.ts noticeInLocation) and opens nothing for a
 * forgery.
 *
 * Registered anywhere but /app/ (a browser that kept the old self-removing worker's registration at /), it removes itself.
 */
/* eslint-env serviceworker */
const TITLE = 'BeanPool';
const ICON = '/icon-192x192.png';
const KIND = /^(?=.{1,64}$)[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const MAX_SENTENCE = 200;

const inScope = () => new URL(self.registration.scope).pathname === '/app/';

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
    event.waitUntil(self.registration.showNotification(TITLE, { body: sentenceOf(p.body), tag: kind, icon: ICON, data: { notice } }));
});

/** Where a click on a notice lands: the waiting page for a yes, the app otherwise; the notice in the fragment. */
function landingOf(notice) {
    const path = notice && notice.k === 'join.answered' ? '/app?door=ask' : '/app';
    return notice ? `${path}#notice=${encodeURIComponent(JSON.stringify(notice))}` : path;
}

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = landingOf(event.notification.data && event.notification.data.notice);
    event.waitUntil((async () => {
        const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const tab = tabs.find((c) => {
            const u = new URL(c.url);
            return u.origin === self.location.origin && (u.pathname === '/app' || u.pathname.startsWith('/app/'));
        });
        if (tab) {
            try {
                await tab.focus();
                await tab.navigate(new URL(target, self.location.origin).href);
                return;
            } catch {
                // A tab this worker doesn't control can't be taken elsewhere: a new one opens instead.
            }
        }
        await self.clients.openWindow(target);
    })());
});
