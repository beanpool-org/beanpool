/**
 * A stranger at a local community's door (front doors S15): the web app's half of the community's public card. The node
 * serves the card at its bare address to a browser with no account here (apps/server routes/community-card.ts), and the
 * welcome page draws the same card above its invite form (components/CommunityCardPanel.tsx). The shape and the words
 * are core's (community-card.ts), so both say the same thing.
 */
import { COMMUNITY_CARD_WORDS, type CommunityCard, type WordKey } from '@beanpool/core';

/**
 * The hint that this browser keeps an account here, which the node reads at `/` to send the browser on to the web app
 * rather than show it the card (apps/server ACCOUNT_HINT_COOKIE). A hint, never a credential: it says nothing but "1".
 */
export const ACCOUNT_HINT_COOKIE = 'bp_account_here';
/** About 400 days, the most a browser keeps a cookie. */
const ACCOUNT_HINT_MAX_AGE_S = 400 * 86_400;

/** Say (or stop saying) that this browser keeps an account here. A browser that refuses cookies: nothing. */
export function setAccountHint(on: boolean, doc: Pick<Document, 'cookie'> = document, secure = location.protocol === 'https:'): void {
    try {
        doc.cookie = `${ACCOUNT_HINT_COOKIE}=${on ? '1' : ''}; Path=/; Max-Age=${on ? ACCOUNT_HINT_MAX_AGE_S : 0}; SameSite=Lax${secure ? '; Secure' : ''}`;
    } catch { /* the card shows at the bare address; Already a member is one tap */ }
}

/** Where the card's doors open the welcome page: `/app?door=invite` (the invite form) or `/app?door=signin`. */
export type WelcomeDoor = 'invite' | 'signin';

/** `?door=` in this page's address, taken out of it: the welcome page's starting screen, or null. */
export function takeWelcomeDoor(win: Pick<Window, 'location' | 'history'> = window): WelcomeDoor | null {
    const params = new URLSearchParams(win.location.search || '');
    const raw = params.get('door');
    if (raw === null) return null;
    try {
        params.delete('door');
        const qs = params.toString();
        win.history.replaceState(win.history.state, '', `${win.location.pathname}${qs ? `?${qs}` : ''}${win.location.hash || ''}`);
    } catch { /* the page still opens there */ }
    return raw === 'invite' || raw === 'signin' ? raw : null;
}

/** Whether this browser is an Android phone's, where the BeanPool app may be installed. */
export function onAndroid(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
    return /\bAndroid\b/i.test(ua);
}

/**
 * Where the card's Ask to join goes, as the node's own page has it: on Android the app's card screen, falling back to the
 * global community's lobby; elsewhere the lobby with this community first; with neither, no link and the words that say
 * to ask from the app. `note`: the line under it.
 */
export function askDoor(card: CommunityCard, android: boolean): { href: string | null; note: WordKey | null } {
    if (card.joining !== 'requests') return { href: null, note: null };
    if (android && card.host) {
        const node = encodeURIComponent(`https://${card.host}`);
        const fallback = card.askUrl ? `S.browser_fallback_url=${encodeURIComponent(card.askUrl)};` : '';
        return { href: `intent://community-card?node=${node}#Intent;scheme=beanpool;package=org.beanpool.pillar;${fallback}end`, note: null };
    }
    if (card.askUrl) return { href: card.askUrl, note: COMMUNITY_CARD_WORDS.askViaGlobal };
    return { href: null, note: COMMUNITY_CARD_WORDS.askInApp };
}
