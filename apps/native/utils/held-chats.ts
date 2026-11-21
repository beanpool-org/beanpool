/**
 * Chat's rows from every other community this phone holds (slice S1, scratch/fable-design/DESIGN-no-switch-messaging-fable.md
 * §1 and §6): Damo, 19 Nov 2026, "if I switch to another node it's gone". Each community's chats are read from that
 * community's own copy through a held, read-only handle (utils/db.ts getHeldConversations, utils/held-copies.ts), by its
 * name, never through the copy in use. A tap still moves the phone there and opens the chat (app/(tabs)/chats.tsx):
 * reading and replying in place is slice S2.
 *
 * Which communities: the phone's saved list, one row set per community however its address is spelled, never the one in
 * use, never one visited as a guest (its copy holds no chat of the member's), never an address that isn't plain. A
 * community whose copy hasn't synced (or was cleared) since shows nothing (getHeldConversations).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KnownChat } from '@beanpool/core';
import { closeHeldCopies, getHeldConversations, getHeldLatest, getHeldLetIn, getHeldMembers, getHeldOutsideChats, getHeldPreviews, heldChatIsDm, refreshHeldDms, HELD_PREVIEWS_MAX, type HeldConversation, type LetInRead } from './db';
import { getDatabaseFilenameForNode, getSavedNodes, isGuestCopy, isGuestNode } from './nodes';
import { isPlainNodeAddress } from './node-url';
import { communityAddress, sameCommunity } from './push-pins';
import { communitiesWithAlertsOff } from './push-alerts-off';
import { communityName } from './community-name';
import { getBlockedUsers, isUserBlocked } from './blocklist';
import { talkShowsChat } from './dm-blocked';
import type { OutsideChat } from './outside-chat-store';
import { noticeCountFor, readNoticeCounts } from './notice-counts';
import { heldChatOpensInPlace } from './held-chat-in-place';

export interface HeldChatRow extends HeldConversation {
    /** The row's key in Chat's list: never that of a chat in the community in use, nor of the same id in another. */
    key: string;
    held: true;
    /** The community's address, as the saved list has it: where a tap moves the phone. */
    community: string;
    /** Its name as the phone saved it, in grey under the person's. */
    communityName: string;
    /** Its own unread count, as its community's copy has it (slice S2b, {@link heldChatsFilledIn}): absent until read. */
    unread?: number;
    /** Its newest line's preview (slice S2b): absent until read, null when the pins can't place it. */
    lastMessage?: string | null;
    /** The preview is BeanPool's own sentence, translated where shown (chat-line-words.ts chatPreviewWords). */
    lastMessageFromApp?: boolean;
}

export { heldChatInPlaceParams, heldChatOpensInPlace } from './held-chat-in-place';

/** One stretch of Chat in view (its focus effect), as {@link heldChatsInView} hands it out. */
export interface HeldChatsView {
    /** True until Chat is left. */
    inView(): boolean;
    /** Chat is left: every held handle closes, unless Chat is in view again by then. Once only. */
    leave(): Promise<void>;
}

/** How many stretches of Chat are in view now: one, but a quick move away and back can have the next begin first. */
let viewsInView = 0;

/** Close every held handle, unless Chat is in view again: the handles are Chat's, and only Chat reads them (slice S1). */
function closeUnlessInView(): Promise<void> {
    return viewsInView === 0 ? closeHeldCopies() : Promise.resolve();
}

/**
 * Chat in view, from its focus to its blur (app/(tabs)/chats.tsx): its held reads go through it, so no handle opened after
 * Chat is left stays open (#3302 review F3). As Chat is left (`leave`) every held handle closes; a list still on its way
 * then reads no community more ({@link heldChatRows}) and closes once more as it ends, for a handle it opened after that
 * close. Neither close runs while Chat is in view again.
 */
export function heldChatsInView(): HeldChatsView {
    viewsInView++;
    let shown = true;
    return {
        inView: () => shown,
        leave: () => {
            if (!shown) return Promise.resolve();
            shown = false;
            viewsInView--;
            return closeUnlessInView();
        },
    };
}

/**
 * The held rows Chat lists: {@link heldChatRows} less every DM with someone the member blocked, under any key that chat
 * names them by in its own community, its pin's former and offered keys included (db.ts getHeldConversations peerKeys), as
 * Talk's own list leaves them out (dm-blocked.ts talkShowsChat).
 */
export async function heldChatsShown(myPubkey: string, view?: HeldChatsView): Promise<HeldChatRow[]> {
    const [blocked, rows] = await Promise.all([getBlockedUsers(), heldChatRows(myPubkey, view)]);
    return rows.filter((c) => talkShowsChat(c, blocked));
}

/**
 * Chat's held rows. `view`: Chat in view ({@link heldChatsInView}); once it is left, no further community is read, and
 * what this list opened closes as it ends (unless Chat is in view again).
 */
export async function heldChatRows(myPubkey: string, view?: HeldChatsView): Promise<HeldChatRow[]> {
    try {
        return await heldChatRowsWhile(myPubkey, view ? view.inView : () => true);
    } finally {
        if (view && !view.inView()) await closeUnlessInView();
    }
}

/**
 * The other communities whose copies Chat reads (slice S1; S4's across chats too): the saved list, one per file however its
 * address is spelled, never the one in use, never a guest's look, never an address that isn't plain; each with its saved name.
 */
async function heldCommunities(): Promise<Array<{ url: string; file: string; name: string }>> {
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
    const out: Array<{ url: string; file: string; name: string }> = [];
    const files = new Set<string>();
    for (const node of await getSavedNodes()) {
        const url = node.url;
        if (!isPlainNodeAddress(url) || (anchor && sameCommunity(url, anchor))) continue;
        if (await isGuestNode(url).catch(() => true)) continue;
        const file = getDatabaseFilenameForNode(url);
        if (files.has(file)) continue;
        files.add(file);
        const savedName = (node as { name?: unknown }).name;
        out.push({ url, file, name: typeof savedName === 'string' && savedName.trim() ? savedName.trim() : communityName(node) });
    }
    return out;
}

/**
 * What each other community's copy says for let in once (slice S3b, let-in.ts): whom it lets in, and the keys its pins say
 * are not a person's key now, read through held, read-only handles (db.ts getHeldLetIn): the same communities Chat reads.
 * Null when any of their pins can't be read (nobody is let in quietly then: #3319 review F1). The handles are Chat's: what
 * this opened closes as it ends, unless Chat is in view.
 */
export async function heldLetIn(myPubkey: string): Promise<LetInRead | null> {
    try {
        const out: LetInRead = { letIn: [], notCurrent: [] };
        for (const { url } of await heldCommunities()) {
            const one = await getHeldLetIn(myPubkey, url);
            if (!one) return null;
            out.letIn.push(...one.letIn);
            out.notCurrent.push(...one.notCurrent);
        }
        return out;
    } finally {
        await closeUnlessInView();
    }
}

/** The other communities this phone holds as a member, by address and saved name, in the order Chat lists them (Message's path rule: S5 part 2). */
export async function heldCommunityList(): Promise<Array<{ url: string; name: string }>> {
    return (await heldCommunities()).map(({ url, name }) => ({ url, name }));
}

/**
 * The chats with any of `keys` that Chat lists in every other community this phone holds (Message's path rule, slice S5
 * part 2; #3354 review): direct ones ({@link heldChatsShown}) and across ones ({@link heldOutsideChatsShown}), so none a block
 * hid and none in a guest's file. A read that fails counts as no chat. The handles are Chat's: what this opened closes as it
 * ends, unless Chat is in view (#3302 review F3).
 */
export async function heldChatsWith(myPubkey: string, keys: readonly string[]): Promise<KnownChat[]> {
    const want = new Set(keys);
    const out: KnownChat[] = [];
    try {
        for (const c of await heldChatsShown(myPubkey).catch(() => [] as HeldChatRow[])) {
            if (c.type !== 'dm') continue;
            for (const key of new Set([...c.peerKeys, ...(c.peerPubkey ? [c.peerPubkey] : [])])) if (want.has(key)) out.push({ kind: 'direct', community: c.community, id: c.id, key });
        }
        for (const c of await heldOutsideChatsShown(myPubkey).catch(() => [] as HeldOutsideChat[])) {
            if (want.has(c.peerKey)) out.push({ kind: 'across', community: c.community, id: c.id, key: c.peerKey });
        }
    } finally {
        await closeUnlessInView();
    }
    return out;
}

/** A person in another community this phone holds, found by New message's search (slice S5 part 2). */
export interface HeldPerson {
    public_key: string;
    callsign: string | null;
    avatar_url: string | null;
    joined_at: string | null;
    community: string;
    communityName: string;
}

/**
 * New message's search of every other community this phone holds (slice S5 part 2, DESIGN-no-switch-messaging-fable.md §6
 * row S5: "New message searches your contacts from every community"): each copy's people whose name holds `typed`, read
 * through held, read-only handles (db.ts getHeldMembers), each with the community they were found in. The handles are
 * Chat's: what this opened closes as it ends, unless Chat is in view.
 */
export async function heldPeopleMatching(myPubkey: string, typed: string): Promise<HeldPerson[]> {
    const out: HeldPerson[] = [];
    try {
        for (const { url, name } of await heldCommunities()) {
            for (const m of (await getHeldMembers(myPubkey, url, typed)) ?? []) out.push({ ...m, community: url, communityName: name });
        }
    } finally {
        await closeUnlessInView();
    }
    return out;
}

async function heldChatRowsWhile(myPubkey: string, inView: () => boolean): Promise<HeldChatRow[]> {
    const rows: HeldChatRow[] = [];
    for (const { url, file, name } of await heldCommunities()) {
        // Chat left: no further community's copy is opened (one opened since the close as it was left closes as this ends).
        if (!inView()) break;
        const chats = await getHeldConversations(myPubkey, url);
        if (!chats) continue;
        for (const chat of chats) rows.push({ ...chat, key: `held:${file}:${chat.id}`, held: true, community: url, communityName: name });
    }
    return rows;
}

/**
 * A chat with someone in a community the member doesn't belong to, kept in the file of another community this phone holds
 * (slice S4, scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3: "Same file, same rule, visible always"). It opens
 * in that file (app/outside-chat/[id].tsx `community`): read, answered and fetched there with no switch.
 */
export interface HeldOutsideChat extends OutsideChat {
    /** The row's key in Chat's list and the requests list: never that of an across chat in use, nor of the same id elsewhere. */
    key: string;
    /** The community whose file carries it, as the saved list has its address: where its mail is fetched and its lines go. */
    community: string;
    communityName: string;
}

/**
 * Where an across chat opens (app/outside-chat/[id].tsx): in the file that carries it, named by its community when that is
 * another one this phone holds (slice S4), else the community in use's, as before.
 */
export function outsideChatHref(chat: { id: string; community?: string }): string {
    return chat.community ? `/outside-chat/${chat.id}?community=${encodeURIComponent(chat.community)}` : `/outside-chat/${chat.id}`;
}

/**
 * The across chats and requests kept in every other community's file this phone holds, read through held, read-only handles
 * (db.ts getHeldOutsideChats), none with someone the account blocked (as outside-mail.ts chatsShown leaves them out). `view`:
 * as {@link heldChatRows}, so no handle opened after Chat is left stays open.
 */
export async function heldOutsideChatsShown(myPubkey: string, view?: HeldChatsView): Promise<HeldOutsideChat[]> {
    const inView = view ? view.inView : () => true;
    try {
        const out: HeldOutsideChat[] = [];
        for (const { url, file, name } of await heldCommunities()) {
            if (!inView()) break;
            // Listed only where it opens: never a file a guest mark names under any spelling (outside-chat-live.ts contextFor).
            if (await isGuestCopy(url).catch(() => true)) continue;
            for (const chat of (await getHeldOutsideChats(myPubkey, url)) ?? []) {
                if (await isUserBlocked(chat.peerKey)) continue;
                out.push({ ...chat, key: `held-across:${file}:${chat.id}`, community: url, communityName: name });
            }
        }
        return out;
    } finally {
        if (view && !view.inView()) await closeUnlessInView();
    }
}

/**
 * What a link to a chat of another community opens (slice S2; #3305 review F1 and F2). The chat's route asks this before
 * it draws anything for a `community` param:
 * - `here`: the community in use, however spelled: the chat's ordinary route, which asks what kind of chat the id is;
 * - `in-place`: a direct chat that community's own copy already holds (db.ts heldChatIsDm, read only), at the address and
 *   under the name the phone saved for it, never a link's own;
 * - `move`: any other id of a community this phone holds as a member (a group's, an event's or an enterprise's chat, an
 *   id its copy doesn't hold): nothing of it opens in place, and a tap moves the phone there (S1);
 * - `nothing`: not a community this phone holds (not saved, a guest's look, not a plain address).
 */
export type ChatInPlaceRoute =
    | { open: 'here' }
    | { open: 'in-place' | 'move'; community: string; name: string }
    | { open: 'nothing' };

export async function chatInPlaceRoute(myPubkey: string | null | undefined, id: string, community: string): Promise<ChatInPlaceRoute> {
    const file = getDatabaseFilenameForNode(community);
    if (getDatabaseFilenameForNode(await AsyncStorage.getItem('beanpool_anchor_url')) === file) return { open: 'here' };
    const node = (await getSavedNodes().catch(() => [])).find((n) => getDatabaseFilenameForNode(n.url) === file);
    if (!node || !isPlainNodeAddress(node.url) || await isGuestCopy(node.url).catch(() => true)) return { open: 'nothing' };
    // Named as Chat's held rows name it: the name the phone saved, else the community's own.
    const savedName = (node as { name?: unknown }).name;
    const where = { community: node.url, name: typeof savedName === 'string' && savedName.trim() ? savedName.trim() : communityName(node) };
    if (!myPubkey || !id) return { open: 'move', ...where };
    try {
        return (await heldChatIsDm(myPubkey, node.url, id)) ? { open: 'in-place', ...where } : { open: 'move', ...where };
    } finally {
        // The check read through a held, read-only handle: it closes again unless Chat is in view (#3302 review F3). The
        // chat doesn't wait for that close: the copy it opens in place is a connection of its own.
        void closeUnlessInView().catch(() => {});
    }
}

/** What Chat adds to a held row once the rows show (slice S2b): its own unread count and its newest line's preview. */
export interface HeldRowFill {
    unread: number;
    /** Null: no preview (not among the newest {@link HELD_PREVIEWS_MAX}, not a direct chat, or the pins can't place it). */
    lastMessage: string | null;
    lastMessageFromApp: boolean;
}

/** Newest first: by each held row's newest line, else when the chat was made. */
function newestFirst(a: HeldChatRow, b: HeldChatRow): number {
    const at = (c: HeldChatRow) => c.rawTimestamp ?? c.createdAt ?? '';
    return at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0;
}

/**
 * Each held row's own unread count and, for the {@link HELD_PREVIEWS_MAX} newest held direct chats across every community,
 * its newest line's preview (slice S2b; DESIGN-no-switch-messaging-fable.md §3, "The list shows each row's own count").
 * Read AFTER the rows show (Chat's first paint pays nothing), each community from its own copy by its name (db.ts
 * getHeldLatest, getHeldPreviews), by key. `view`: as {@link heldChatRows}, once Chat is left no further community is read.
 */
export async function heldChatsFilledIn(myPubkey: string, rows: readonly HeldChatRow[], view?: HeldChatsView): Promise<Map<string, HeldRowFill>> {
    const inView = view ? view.inView : () => true;
    const out = new Map<string, HeldRowFill>();
    try {
        const previewed = new Set([...rows].filter((r) => heldChatOpensInPlace(r)).sort(newestFirst).slice(0, HELD_PREVIEWS_MAX).map((r) => r.key));
        const byCommunity = new Map<string, HeldChatRow[]>();
        for (const row of rows) byCommunity.set(row.community, [...(byCommunity.get(row.community) ?? []), row]);
        for (const [community, chats] of byCommunity) {
            if (!inView()) break;
            const latest = await getHeldLatest(myPubkey, community);
            const ids = chats.filter((c) => previewed.has(c.key)).map((c) => c.id);
            const previews = ids.length > 0 && inView() ? await getHeldPreviews(myPubkey, community, ids) : null;
            const unreadOf = new Map((latest ?? []).map((l) => [l.id, l.unread] as const));
            for (const c of chats) {
                const preview = previews?.[c.id] ?? null;
                out.set(c.key, { unread: unreadOf.get(c.id) ?? 0, lastMessage: preview?.lastMessage ?? null, lastMessageFromApp: preview?.lastMessageFromApp ?? true });
            }
        }
    } finally {
        if (view && !view.inView()) await closeUnlessInView();
    }
    return out;
}

/** How often, while Chat stays in view, a held community with its alerts off (it has no number to rise) is refreshed. */
export const HELD_QUIET_REFRESH_MS = 15_000;

/** A held community's number as a refresh had its list answer for it (`number`), and when that refresh began (`at`). */
interface Noted {
    number: number;
    at: number;
}

/**
 * What one stretch of Chat in view noted of each held community, by account and file (#3312 review F1). Kept with that
 * view, so it goes as Chat is left: the next focus asks again of every held community with a number above 0, and of every
 * one with its alerts off, whatever happened while Chat was away (a number that fell and rose again unseen, a list read
 * Chat left on its way). Never module-wide: a refresh that ends after its view was left notes nothing a later view reads.
 *
 * Forgetting, not the copy's own count (getHeldLatest): that count can't tell a stale copy from a fresh one (a line read on
 * another device stays unread in the copy while a newer one waits there: 1 against 3, nothing asked), and the number
 * counts lines this refresh never brings (a group's chat), so a comparison would miss lines or ask on every round.
 */
const notedByView = new WeakMap<HeldChatsView, Map<string, Noted>>();
/** One refresh pass at a time: a rise while one runs is looked at once it is done. */
let refreshing: Promise<unknown> = Promise.resolve();

/**
 * Freshness (slice S2b; DESIGN §3 "Live typing and instant arrival": away chats refresh on a push and every few seconds
 * while open, no second socket). For each community among Chat's held rows, bring its newest lines into its own copy (db.ts
 * refreshHeldDms: one list read, at most HELD_REFRESH_MAX chats, through S2's write path) when something may wait there:
 * - its own number (notice-counts.ts, the one the BeanPool sheet and the badge read: a round's count or a push's) is above
 *   what this stretch of Chat in view last had an answer for: on Chat's focus any number above 0, then each rise;
 * - its alerts are off (notice-counts.ts leaves it out: no number): on Chat's focus, then every
 *   {@link HELD_QUIET_REFRESH_MS} while Chat stays in view (app/(tabs)/chats.tsx calls this on that beat).
 * A number is noted only once the refresh had its list answer, so a list read that failed, ran out or was cut by Chat's
 * leaving is asked again at the next call. A number that falls is noted at once, so the next rise from there refreshes.
 * Each call is bounded (one list read and at most HELD_REFRESH_MAX pages a community) and starts nothing itself: no loop.
 * Resolves to the communities whose copy took something, for Chat to read their rows again. Never throws.
 */
export function refreshHeldWhereRose(myPubkey: string, rows: readonly HeldChatRow[], view: HeldChatsView): Promise<string[]> {
    const run = refreshing.then(() => refreshOnce(myPubkey, rows, view)).catch((e) => {
        console.warn('[Held] A refresh of the other communities failed', e);
        return [] as string[];
    });
    refreshing = run;
    return run;
}

async function refreshOnce(myPubkey: string, rows: readonly HeldChatRow[], view: HeldChatsView): Promise<string[]> {
    const brought: string[] = [];
    try {
        if (!view.inView()) return brought;
        const [counts, alertsOff] = await Promise.all([readNoticeCounts(AsyncStorage), communitiesWithAlertsOff(AsyncStorage)]);
        let noted = notedByView.get(view);
        if (!noted) notedByView.set(view, (noted = new Map()));
        const files = new Set<string>();
        for (const row of rows) {
            const file = getDatabaseFilenameForNode(row.community);
            if (files.has(file)) continue;
            files.add(file);
            if (!view.inView()) break;
            const key = `${myPubkey}\n${file}`;
            const was = noted.get(key);
            const at = Date.now();
            const quiet = alertsOff.includes(communityAddress(row.community) ?? '');
            const number = quiet ? 0 : noticeCountFor(counts, row.community);
            if (quiet) {
                // Half a beat of slack (#3312 review F3): Chat's beat starts at focus, but the focus refresh notes its time only
                // after the rows are read, so the first beat comes a little under 15 s after it and must still count as due.
                if (was && at - was.at < HELD_QUIET_REFRESH_MS / 2) continue;
            } else {
                if (was && number < was.number) noted.set(key, { ...was, number });
                if (number <= (was?.number ?? 0)) continue;
            }
            const done = await refreshHeldDms(myPubkey, row.community, view.inView);
            if (done.answered) noted.set(key, { number, at });
            if (done.brought > 0) brought.push(row.community);
        }
    } finally {
        // The refresh reads the copy's newest lines through a held handle: one opened after Chat was left closes as this
        // ends, on every path out of it (#3312 review F2, as heldChatRows and heldChatsFilledIn).
        if (!view.inView()) await closeUnlessInView();
    }
    return brought;
}

/** For tests: a new app run (no refresh pass under way). */
export function _resetHeldRefreshForTests(): void {
    refreshing = Promise.resolve();
}
