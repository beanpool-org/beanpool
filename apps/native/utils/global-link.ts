/**
 * The global community's smart link (DESIGN-global-entry-fable.md §A row 5, slice P4): `https://beanpool.org/global`, which
 * the website hands out (apps/website/global.html: on Android its intent link names this app, else Google Play with
 * `referrer=global%3D1`), and `beanpool://global`. app/+native-intent.ts routes it with globalLinkRoute: to the first
 * screen's door when the phone has no account; for an account, as the phone's one rule for the global community has it
 * (utils/global-entry.ts): the global community's door (app/join-global.tsx), the BeanPool sheet for a member, nothing for
 * an account it closed.
 *
 * A link only OPENS a screen. It never joins, signs or sends anything: the door it opens asks the global community, unsigned,
 * whether it is open (as the first screen already does at every start), and holds its signed work until the member's first
 * tap there (`from=link`, read by both doors). A join wizard left half done resumes and the link starts nothing new; an
 * invite always wins, here and on the first screen (doorFromLink).
 *
 * No lock-in: nothing reads this but the router and the two doors. A build that doesn't claim beanpool.org (app.json) never
 * receives the https link, and `beanpool://global` opens the same door the first screen's **Explore BeanPool worldwide**
 * does. Invites, restores and every other community work the same without it.
 *
 * Kept free of the screens' imports and of the phone's storage, so the router can tell the link without loading either.
 */
import { linkCarriesInvite } from './welcome-invite';
import type { GlobalStanding } from './global-entry';

/** The website's host for the link: beanpool.org itself, as app.json's intent filter and the site's association file claim it. */
const SITE_HOST = 'beanpool.org';

/**
 * `beanpool://global` in the spellings a system hands over: the link itself, `beanpool:///global` (some normalisers add a
 * slash), and the bare `global` / `/global` path forms. `global` must be the whole first segment, with at most one trailing
 * slash; a query or fragment after it is allowed and carries nothing.
 */
const APP_PATH = /^(?:beanpool:\/\/\/?|\/)?global\/?(?=[?#]|$)/i;

/**
 * Every path app.json's Android intent filter claims on beanpool.org (`pathPrefix: "/global"`): `/global`, `/global/`,
 * `/global.html` and anything else that starts so. The filter hands all of them to the app, so all of them open the door:
 * a claimed link that the router left alone would land on Expo Router's Unmatched Route. Android matches the path's case
 * exactly, and so does this.
 */
const SITE_PATH = /^\/global/;

/** The https link's URL, or null: only https, only beanpool.org itself (not www., not a community's own host). */
function siteUrl(path: string): URL | null {
    if (!/^https:\/\//i.test(path)) return null;
    try {
        const url = new URL(path);
        if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== SITE_HOST || url.port || url.username || url.password) return null;
        return url;
    } catch {
        return null;
    }
}

/** The global community's link in any of its spellings, whatever it carries. */
export function isGlobalPath(path: unknown): boolean {
    if (typeof path !== 'string') return false;
    const s = path.trim();
    if (APP_PATH.test(s)) return true;
    const url = siteUrl(s);
    return !!url && SITE_PATH.test(url.pathname);
}

/**
 * The global community's link, to open its door. One that carries an invite is not: an invite always wins, and the
 * invite readers take it as from any other link (app/_layout.tsx, app/welcome.tsx).
 */
export function isGlobalLink(path: unknown): boolean {
    return typeof path === 'string' && isGlobalPath(path) && !linkCarriesInvite(path.trim());
}

/** What the router needs to know about the phone when the link arrives (app/+native-intent.ts reads it). */
export interface PhoneAtLink {
    /** A key is kept on the phone: an account, or a join wizard's. */
    account: boolean;
    /** A join wizard was left half done (utils/onboarding-state.ts): it resumes, and the link starts nothing new. */
    wizardPending: boolean;
    /** What the global community last answered about the key, kept under a day (global-entry.ts readGlobalStanding). Unread: `unknown`. */
    standing?: GlobalStanding;
    /** The global community closed the key's account (global-join-existing.ts accountClosedAtGlobal). Unread: no. */
    closedHere?: boolean;
}

/**
 * The first screen's param that opens its door: `/welcome?door=global&at=…` (app/welcome.tsx). `at`, not the invite's `t`:
 * the screen's invite and install-referrer reader runs again whenever `t` changes, and a door link must not restart it.
 */
export const DOOR_PARAM_GLOBAL = 'global';
/** join-global's param for a door a link opened: its signed work waits for the member's first tap. */
export const FROM_LINK = 'link';

/**
 * Where the global community's link goes (DESIGN-global-entry-fable.md §A row 5), or null to stay where the member is.
 *
 * - A join wizard left half done: nothing new. On a cold start the app opens as from its icon, and the root layout takes
 *   the member back into the wizard; a warm link leaves them where they are.
 * - No account: the first screen, which opens its door (app/welcome.tsx, `doorFromLink` decides). `at` is new each time,
 *   so a second tap of the same link is a second arrival.
 * - An account, as the one rule (global-entry.ts globalEntryState) reads what the phone kept, as every other way to the door
 *   does (the BeanPool sheet's row, Settings → Advanced, People's guest banner, the not-recognised screen):
 *   - its account there closed (`closedAccount`): nothing to offer. The app opens as from its icon (cold) or stays (warm).
 *   - a member (`member`): no door. The BeanPool sheet, where the global community's row is the member's row and its tap
 *     switches to it. The link itself switches nothing: a link only opens a screen, and never interrupts what the member is
 *     doing.
 *   - otherwise (a stranger, or no answer under a day old): the global community's door for it, with its work held until
 *     the member taps. The door asks whether it is open, and its own check decides (a member it didn't know of lands in it).
 */
export function globalLinkRoute(phone: PhoneAtLink, initial: boolean, nowMs: number): string | null {
    if (phone.wizardPending) return initial ? '/' : null;
    if (!phone.account) return `/welcome?door=${DOOR_PARAM_GLOBAL}&at=${nowMs}`;
    if (phone.closedHere) return initial ? '/' : null;
    if (phone.standing === 'member') return '/beanpool';
    return `/join-global?from=${FROM_LINK}`;
}

/** The first screen's modes (app/welcome.tsx). */
export type WelcomeMode =
    | 'home' | 'member' | 'create' | 'globalJoin' | 'recover' | 'ssoRecover' | 'profileSetup' | 'seedBackup' | 'onboardingGuide' | 'ownerCard'
    | 'confirmReplace';

/**
 * Whether the first screen opens its door for the link's arrival (or for the install referrer's `global=1`), from what
 * the screen is doing as it arrives.
 *
 * - A join wizard left half done, or an invite in hand (one that arrived, or a code in the invite field): stay. An invite
 *   always wins, whichever came first.
 * - The first screen, the restore choices, or the invite form with nothing in it: open the door. The member asked for it.
 * - Already at the door, or in the middle of anything else (a restore, the steps after a join): stay. A link never
 *   interrupts what the member is doing.
 */
export function doorFromLink(at: { mode: WelcomeMode; inviteInHand: boolean; wizardPending: boolean }): 'open' | 'stay' {
    if (at.wizardPending || at.inviteInHand) return 'stay';
    return at.mode === 'home' || at.mode === 'member' || at.mode === 'create' ? 'open' : 'stay';
}

/** The key one arrival of the door param is known by, so it opens the door once (null: no door asked for). */
export function doorLinkKey(door: unknown, at: unknown): string | null {
    if (door !== DOOR_PARAM_GLOBAL) return null;
    return `door:${typeof at === 'string' ? at : ''}`;
}
