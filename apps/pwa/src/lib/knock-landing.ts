/**
 * A click on a notice from a community a member asked from Home's Find card (DESIGN-global-yes-join-fable.md §2.4, slice
 * Y2): public/sw.js, in the registration this browser keeps for that community (lib/web-push.ts knockScope), opens
 * `/app?knock=<host>#notice=<the signed notice>`. The fragment is never sent to a server.
 *
 * The app takes both out of the address as it opens ({@link takeKnockLanding}), and once the member's key is known checks the
 * notice as the phone's checkTap does ({@link knockLandingFor}), with the community key pinned when Tell me was tapped on
 * that row (the subscription's answer): signed by that community, for this key, a `join.answered`: Home, with the Find card
 * on that community's row, where its yes is **Join {name}** (components/YesJoin.tsx). A notice only late, or read on a slow
 * clock, lands the same way without a word: the row reads the community's answer itself. Anything else is a forgery: it
 * opens nothing, and the phone's warning shows once. No notice at all (the address typed or kept) lands on the row too:
 * the row is this browser's own memory of its request, and nothing in it is opened or sent by landing there.
 */
import { communityOrigin } from './knock';
import { checkClickedNotice, noticeInHash, readWebPushPin } from './web-push';

export interface KnockLanding {
    /** The community the notice came from, as Home's rows know it (lib/knock.ts communityOrigin). */
    origin: string;
    /** The notice the click brought, as it came: undefined with none, null when unreadable. */
    notice: unknown;
}

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;

/** `?knock=<host>` and its notice, taken out of the address (once, as the app opens); null with none or no community's host. */
export function takeKnockLanding(win: Pick<Window, 'location' | 'history'> = window): KnockLanding | null {
    const params = new URLSearchParams(win.location.search || '');
    if (!params.has('knock')) return null;
    const raw = params.get('knock') ?? '';
    const origin = HOST.test(raw) ? communityOrigin(`https://${raw}`) : null;
    const notice = noticeInHash(win.location.hash || '');
    try {
        params.delete('knock');
        const qs = params.toString();
        win.history.replaceState(win.history.state, '', `${win.location.pathname}${qs ? `?${qs}` : ''}`);
    } catch { /* the address keeps them; the landing is still read once */ }
    return origin ? { origin, notice } : null;
}

/** Where a landing goes for this key: Home's row for the community, or nowhere, with the warning (a forgery). */
export function knockLandingFor(landing: KnockLanding, publicKey: string, now?: number): 'row' | 'forged' {
    if (landing.notice === undefined) return 'row';
    const pushKey = readWebPushPin(landing.origin, publicKey)?.pushKey ?? null;
    const check = checkClickedNotice(landing.notice, publicKey, pushKey, now);
    if (check.kind === 'ok') return check.notice.kind === 'join.answered' ? 'row' : 'forged';
    return check.kind === 'none' ? 'row' : 'forged';
}
