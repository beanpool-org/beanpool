/**
 * Where the member came to Settings from, so Settings can send them back there — and never into a web app
 * they never set up (Marty and Damo, 2026-09-19).
 *
 *   `#…&from=app`  the BeanPool phone app's "Manage" (apps/native/utils/node-admin.ts), with the key hand-off
 *   `#from=pwa`    the web app's "Manage this community" (apps/pwa/src/components/NodeAdminLink.tsx)
 *   neither        typed in, bookmarked, or an older app build
 *
 * It rides in the URL FRAGMENT like the hand-off token, so no server sees it. It is read once on load, kept
 * in sessionStorage for the rest of the visit (a reload has lost the fragment by then), and taken out of the
 * address bar together with the token (lib/key-session.ts strips `from` with `handoff` and `section`).
 */

export type CameFrom = 'app' | 'pwa' | 'unknown';

const STORAGE_KEY = 'bp-settings-from';

function parse(value: string | null | undefined): CameFrom | null {
    return value === 'app' || value === 'pwa' ? value : null;
}

/** Run once, before startKeySession strips the fragment. `win` is injectable for tests. */
export function readCameFrom(win: Pick<Window, 'location' | 'sessionStorage'> = window): CameFrom {
    const fromFragment = parse(new URLSearchParams((win.location.hash || '').replace(/^#/, '')).get('from'));
    try {
        if (fromFragment) {
            win.sessionStorage.setItem(STORAGE_KEY, fromFragment);
            return fromFragment;
        }
        return parse(win.sessionStorage.getItem(STORAGE_KEY)) ?? 'unknown';
    } catch {
        // Storage refused (private mode, blocked site data). The fragment we just read is still right for
        // this page load; a reload without it cannot know, so it says "unknown" rather than guess.
        return fromFragment ?? 'unknown';
    }
}

/** The app's own no-op route: it comes forward and the member stays on the screen they pressed Manage from. */
export const APP_RETURN_URL = 'beanpool://foreground';
/** The web app on this same node (GET / redirects here; apps/server/src/routes/settings.ts). */
export const WEB_APP_PATH = '/app';

/** `label` is the accessible name everywhere; `short` is what the phone top bar has room to show beside `glyph`. */
export type BackLink = { label: string; href: string; glyph: string; short: string };

export function backLink(from: CameFrom): BackLink {
    switch (from) {
        case 'app': return { label: 'Back to the BeanPool app', href: APP_RETURN_URL, glyph: '←', short: 'App' };
        case 'pwa': return { label: 'Back to BeanPool', href: WEB_APP_PATH, glyph: '←', short: 'BeanPool' };
        default: return { label: 'Open the BeanPool web app', href: WEB_APP_PATH, glyph: '🌱', short: 'Web app' };
    }
}

/**
 * "View my profile", in the same place the back link goes. Only for a key sign-in: under the password there
 * is no member, so there is no profile to show (null hides it).
 */
export function profileLink(from: CameFrom, memberPubkey: string | null | undefined): BackLink | null {
    if (!memberPubkey || !/^[0-9a-f]{64}$/i.test(memberPubkey)) return null;
    const key = memberPubkey.toLowerCase();
    return {
        label: 'View my profile',
        glyph: '👤',
        short: 'Profile',
        href: from === 'app'
            ? `beanpool://public-profile?publicKey=${key}`
            : `${WEB_APP_PATH}#profile=${key}`,
    };
}
