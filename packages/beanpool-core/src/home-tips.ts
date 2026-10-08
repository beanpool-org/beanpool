/**
 * Home's Tips card (scratch/home/TIPS-DESIGN-fable.md): the tips, their order, the switch each one depends on, and the
 * rules for which tip shows. One file for both apps (the native app and the web app draw it the same way), bundled so
 * it works with no connection and no data, and its wording is tested once (__tests__/home-tips.test.ts).
 *
 * - **The list** is the node's own: a tip whose switch is off is not in it at all, so the count ("3 of 15") and the
 *   sequence are what this community has and nothing says "not here". The switches are the ones the Home cards read
 *   (`features` from GET /api/home; unknown counts as on, as the apps' `cardOnNode` reads a node).
 * - **The record** is kept per account on the device, never on the account: which tips are seen (by id, so reordering or
 *   rewording a tip never resets anyone), the one on the card and the local day it was first shown, and the dismissal.
 * - **Rotation**: the card shows the first tip not seen. Next marks it seen and draws the next one. On landing, a tip
 *   first shown on an earlier local day is marked seen and the next one drawn, once. Nothing moves while Home is in front.
 * - **Stopping**: when every tip in the list is seen, or at once on "Don't show tips again". Showing the card again in
 *   Edit home starts over from the first tip.
 */

/** What a tip's rule reads: the Home answer's profile and features, and the reader's role on the node. */
export interface TipsNode {
    profile: string;
    features: { beans?: boolean; escrow?: boolean; invites?: boolean; decisions?: boolean; door?: unknown; [k: string]: unknown };
}
export type TipsRole = 'owner' | 'admin' | 'moderator' | null | undefined;

export interface HomeTip {
    id: string;
    text: string;
    /** The bundled guide page Read more opens; absent: no Read more. */
    guide?: string;
    when: (node: TipsNode, role: TipsRole) => boolean;
}

const beansOn = (n: TipsNode) => n.features.beans !== false;
/** The apps' `invitesForReader`, with the Grow your community card's "never on the global node". */
const invitesHere = (n: TipsNode, role: TipsRole) =>
    n.profile !== 'global' && n.features.invites === true && (n.features.door !== 'admins' || role === 'owner' || role === 'admin');
/** The apps' `decideOnNode`: Decisions need Beans as well. */
const decideHere = (n: TipsNode) => n.features.decisions !== false && beansOn(n);
const always = () => true;

/** Every tip, in the order a member meets them (design §3; wording approved by the founder 8 Oct 2026, word for word). */
export const HOME_TIPS: readonly HomeTip[] = [
    { id: 'what-this-is', when: always, guide: 'how-it-works',
        text: 'BeanPool is neighbours helping neighbours. You offer what you can do or spare, and ask for what you need.' },
    { id: 'offer', when: beansOn, guide: 'posting',
        text: 'Tap + ADD POST to put up an Offer: bread, a lift, an hour of your time. Post an Offer before a Need, so everyone brings something.' },
    { id: 'offer-global', when: n => !beansOn(n), guide: 'posting',
        text: "Tap + ADD POST to put up something free or for swap. A Need is something you're looking for." },
    { id: 'beans', when: beansOn, guide: 'how-it-works',
        text: "Beans count help given and received. Everyone starts at zero, and zero is a fine place to be: it means you've given as much as you've got." },
    { id: 'no-beans', when: n => !beansOn(n), guide: 'posting',
        text: "There are no Beans on the worldwide community. Say in your post what you'd like in return: free, a swap, or ask." },
    { id: 'price', when: beansOn, guide: 'posting',
        text: 'A rough guide: 40 Beans is about an hour of someone\'s time. You and the other person agree the real price.' },
    { id: 'words', when: always, guide: 'your-12-words',
        text: 'Your 12 words are the key to your account, and there is no password. Write them on paper and keep it safe: nobody can reset them for you.' },
    { id: 'map', when: always, guide: 'map-pins',
        text: "The Map shows what's near you: green pins are Offers, orange are Needs, purple are events. Your own pin can sit near your home rather than on it." },
    { id: 'messages', when: always, guide: 'messages',
        text: "A chat with one person is locked end to end, so your community's server can't read it. Group, event and enterprise chats are not locked." },
    { id: 'deal', when: n => beansOn(n) && n.features.escrow !== false, guide: 'a-deal-step-by-step',
        text: "When a deal is agreed, the buyer's Beans are held until the job is done and confirmed. If a deal gets stuck, an admin can step in." },
    { id: 'credit', when: beansOn, guide: 'credit-line',
        text: 'You can go below zero: your credit line opens with your first finished trade and grows as you trade with more people. Being below zero costs nothing.' },
    { id: 'levels', when: beansOn, guide: 'trust-badges',
        text: 'Levels are badges for the trust you build by trading: Newcomer, Resident, Steward, Elder. A level is recognition, not permission: every member can post, trade and vote.' },
    { id: 'find-community', when: n => n.profile === 'global', guide: 'finding-a-community',
        text: 'Neighbours trade in a local community, with its own Beans. Find one near you on Home and ask to join: any member there can let you in.' },
    { id: 'invites', when: invitesHere, guide: 'joining',
        text: "Know someone who'd fit in? Invite them from Talk, People, Invites: an invite works once and lasts 30 days." },
    { id: 'groups', when: always, guide: 'groups',
        text: 'Groups are for a street, a choir, a garden crew, a guild. Find them in Talk under Groups, or start one.' },
    { id: 'votes', when: decideHere, guide: 'decisions',
        text: 'Commons is where your community decides things together. A Decision is a secret ballot, and when it passes it is carried out.' },
    { id: 'polls', when: n => !decideHere(n), guide: 'polls',
        text: 'Polls ask what people think and change nothing by themselves. Find them in the Market under Polls.' },
    { id: 'private', when: beansOn, guide: 'privacy',
        text: 'Only you can see your balance and your trades. Other members see your name, photo, level and reviews.' },
    { id: 'visitors', when: n => !beansOn(n), guide: 'privacy',
        text: "People who haven't joined can see what's on offer and roughly where, never your name, your face or the exact spot." },
    { id: 'guide', when: always, guide: 'the-bean',
        text: "That's the last tip. The whole guide is in Settings under Help & how it works, and it works with no connection; Edit home, at the bottom, arranges your cards." },
];

/** The tips this node shows this reader, in order. */
export function tipsFor(node: TipsNode, role: TipsRole): HomeTip[] {
    return HOME_TIPS.filter(t => t.when(node, role));
}

// ── The record on the device ───────────────────────────────────────────────────────────────────────────────────────

export interface TipsRecord {
    v: 1;
    /** Tip ids seen, each once. An id the list no longer has is kept (a member may move to a node that has it) and ignored. */
    seen: string[];
    /** The tip on the card; null: none drawn yet. */
    current: string | null;
    /** The local day (YYYY-MM-DD) `current` was first shown. */
    currentShownOn: string | null;
    /** When "Don't show tips again" was tapped; null: not dismissed. */
    dismissedAt: string | null;
}

export const emptyTipsRecord = (): TipsRecord => ({ v: 1, seen: [], current: null, currentShownOn: null, dismissedAt: null });

/** At most this many seen ids are kept (a stored record is read tolerantly: it comes off the device's storage). */
const MAX_SEEN = 64;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 40;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A stored record, read tolerantly; anything unreadable is a fresh record. */
export function readTipsRecord(raw: unknown): TipsRecord {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyTipsRecord();
    const r = raw as Record<string, unknown>;
    const seen = Array.isArray(r.seen) ? [...new Set(r.seen.filter(isId))].slice(0, MAX_SEEN) : [];
    const current = isId(r.current) ? r.current : null;
    return {
        v: 1,
        seen,
        current,
        currentShownOn: current && isDay(r.currentShownOn) ? r.currentShownOn : null,
        dismissedAt: typeof r.dismissedAt === 'string' && r.dismissedAt.length <= 40 ? r.dismissedAt : null,
    };
}

/** The device's local calendar day, YYYY-MM-DD. */
export function localDay(at: Date = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/** What the card draws: the tip, its place in the list ("3 of 15"), and whether it is the last one not yet seen (Done). */
export interface TipsView { tip: HomeTip; position: number; total: number; last: boolean }

/** The card's state: what to draw (null: no card), and the record to keep (the same object when nothing changed). */
export interface TipsStep { record: TipsRecord; view: TipsView | null }

const seenIn = (record: TipsRecord) => new Set(record.seen);

/** Every tip in this list is seen (the card went by itself: Edit home says "All tips seen"). */
export function allTipsSeen(record: TipsRecord, list: readonly HomeTip[]): boolean {
    const seen = seenIn(record);
    return list.every(t => seen.has(t.id));
}

function viewOf(tip: HomeTip, list: readonly HomeTip[], seen: ReadonlySet<string>): TipsView {
    return {
        tip,
        position: list.findIndex(t => t.id === tip.id) + 1,
        total: list.length,
        last: !list.some(t => t.id !== tip.id && !seen.has(t.id)),
    };
}

/** The tip to draw now, with no change but drawing one when none is on the card (or the one there is not in this list). */
function draw(record: TipsRecord, list: readonly HomeTip[], today: string): TipsStep {
    if (record.dismissedAt) return { record, view: null };
    const seen = seenIn(record);
    const held = record.current ? list.find(t => t.id === record.current && !seen.has(t.id)) : undefined;
    if (held) return { record, view: viewOf(held, list, seen) };
    const next = list.find(t => !seen.has(t.id));
    if (!next) {
        const cleared = record.current === null && record.currentShownOn === null ? record : { ...record, current: null, currentShownOn: null };
        return { record: cleared, view: null };
    }
    return { record: { ...record, current: next.id, currentShownOn: today }, view: viewOf(next, list, seen) };
}

const markSeen = (record: TipsRecord, id: string): TipsRecord =>
    record.seen.includes(id) ? { ...record, current: null, currentShownOn: null } : { ...record, seen: [...record.seen, id].slice(-MAX_SEEN), current: null, currentShownOn: null };

/**
 * On landing on Home: the tip on the card, advanced once when it was first shown on an earlier local day. Calling it
 * again on the same day changes nothing.
 */
export function tipOnLanding(record: TipsRecord, list: readonly HomeTip[], today: string): TipsStep {
    if (record.dismissedAt) return { record, view: null };
    const stale = record.current && record.currentShownOn && record.currentShownOn < today && list.some(t => t.id === record.current);
    return draw(stale ? markSeen(record, record.current!) : record, list, today);
}

/** The tip on the card now, without advancing (a redraw while Home is in front). */
export function tipNow(record: TipsRecord, list: readonly HomeTip[], today: string): TipsStep {
    return draw(record, list, today);
}

/** Next (or Done): the tip on the card is seen, and the next one not seen is drawn (none: the card goes). */
export function nextTip(record: TipsRecord, list: readonly HomeTip[], today: string): TipsStep {
    const on = draw(record, list, today);
    if (!on.view) return on;
    return draw(markSeen(on.record, on.view.tip.id), list, today);
}

/** "Don't show tips again": the card goes now and never comes back on its own. */
export function dismissTips(record: TipsRecord, at: string): TipsRecord {
    return { ...record, dismissedAt: at };
}

/** Edit home switched Tips on: the tips start over from the first one. */
export function restartTips(): TipsRecord {
    return emptyTipsRecord();
}

/** The caption: "Tips · 3 of 15" (drawn in capitals as every caption; a screen reader says "Tips, 3 of 15"). */
export function tipsCaption(view: Pick<TipsView, 'position' | 'total'>): string {
    return `Tips · ${view.position} of ${view.total}`;
}

/** The screen reader's words for Next, and for Done on the last tip. */
export function tipsNextLabel(view: Pick<TipsView, 'last'>): string {
    return view.last ? 'Done with tips. The card goes.' : 'Next tip';
}

export const TIPS_DONT_SHOW = "Don't show tips again";
export const TIPS_DONT_SHOW_LABEL = "Don't show tips again. Edit home brings them back.";
export const TIPS_ALL_SEEN = 'All tips seen';
