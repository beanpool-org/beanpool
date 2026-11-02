/**
 * "Never miss a DM" (Marty, 1 Nov) at a community the phone isn't set to, push or no push: the rounds that ask the phone's
 * other communities how many messages wait there (scratch/fable-design/DESIGN-cross-community-chat-fable.md §1.2, R4, R5,
 * R7). The socket stays with the community in use. Damo's phone runs GrapheneOS: push can't be relied on there, and without
 * this nothing on a phone ever asks "is there anything for me at my other communities?"
 *
 * **When.** As the app opens or comes back and with the 5-minute sync ({@link roundWhileOpen}, app/_layout.tsx), and with
 * the background sync, 15 minutes at best ({@link noticesAfterSync}, services/push-notifications.ts), never closer together
 * than {@link UNREAD_ROUND_GAP_MS}.
 *
 * **What a round costs an old phone on prepaid data.** Each community is sent one signed `GET /api/me/unread` and no second
 * try: all at once, at most {@link UNREAD_ROUND_SIZE} of them, under one deadline, which in the background is the sync
 * notices' own (sync-notices.ts `postAllNoticesFromSync`), so the task's ceiling doesn't move. The next round goes on from
 * where this one stopped, so with more communities than that each still gets its turn. A community that doesn't answer costs
 * that deadline, keeps the number it had, tells nobody anything, and is asked again next round.
 *
 * **What is asked, and of whom.** Only communities the phone keeps and may send alerts from (push-registrations.ts
 * `communitiesForAlerts`: not one with alerts off, not a guest's look, not an address that isn't plain). Being kept isn't
 * belonging, and no mark says which it is, so the first question is the test, as the membership probe is: it carries no push
 * token, and a community that says the account isn't theirs is left alone for {@link NOT_THEIRS_WAIT_MS}. Each request is
 * signed by the member's key for that community's own host, carries nothing of any other community, and no community is
 * told of another. A community from before bound signatures is never asked: it has no such route, and a signature in the
 * old format names no host, so a hostile node could replay it elsewhere (request-signing-version.ts).
 *
 * **What the phone does with an answer.** Its `unread` is that community's number on the BeanPool sheet (notice-counts.ts).
 * `requests` is not looked at: a message request makes no badge and no alert until it is accepted (Marty, 1 Nov).
 *
 * **Its own notice, where no push can have said it** (R5). A rise posts one notice, written down before it is posted so it
 * is never posted twice: "You have new messages in {community}", in the phone's own words, with the name the phone saved for
 * the community and nothing of any message. A fall posts nothing. Where that community holds this phone's token, its own
 * push told the member, so there is no second line on the lock screen: the number moves and that is all. A tap moves the
 * phone there, through the one switch, and opens its Chat (push-notice-check.ts `checkTap`, push-notice-switch.ts).
 *
 * **Never a prompt** (permissions only when asked: Marty, 26 Oct). `post` is null unless the phone already lets the app
 * notify. Without it the numbers and the badge still move, and nothing shows.
 *
 * **The app-icon badge is the sum** (R7). A community's push sets the icon to that community's number alone, so with two
 * communities it would flip between them: after every round the phone sets it to all of them added up, the community in use
 * as the phone's own copy counts it while the app is closed, and not at all while it's open, as ever. A phone with one
 * community never gets here: its badge stays its push's.
 */
import { PUSH_NOTICE_TITLE, REQUEST_SIGNING_VERSION, t, type UnreadAnswer } from '@beanpool/core';
import { communityName } from './community-name';
import type { BeanPoolIdentity } from './identity';
import { dropCounts, noteServerUnread, noticeCountsSum } from './notice-counts';
import { LOCAL_NOTICE_DATA, UNREAD_NOTICE_TYPE } from './push-notice-check';
import { communityAddress, readKeptCommunities } from './push-pins';
import { communitiesForAlerts } from './push-registrations';
import { SAVED_NODES_STORE_KEY, UNREAD_ROUNDS_STORE_KEY } from './storage-keys';
import { bounded, postAllNoticesFromSync, pushLandedAt, signedAnswer, SYNC_NOTICES_TIMEOUT_MS, type LocalNotice } from './sync-notices';

const UNREAD_PATH = '/api/me/unread';

/** How many communities one round asks. */
export const UNREAD_ROUND_SIZE = 6;
/**
 * How soon after a round the next may go: as the design promises, a community is asked at most every 5 minutes, whatever
 * brings the member back to the app. Five seconds short of that, so the 5-minute tick doesn't lose every other turn to a
 * timer running a moment early.
 */
export const UNREAD_ROUND_GAP_MS = 5 * 60 * 1000 - 5000;
/** How long a community that says the account isn't theirs is left alone: a join is noticed within the hour. */
export const NOT_THEIRS_WAIT_MS = 60 * 60 * 1000;
/** A community's refusals that say the account isn't theirs (test-unread-count.ts); any other answer says nothing. */
const NOT_THEIRS_CODES: ReadonlySet<string> = new Set(['not_a_member', 'account_closed', 'key_invalidated']);
/** The longest community name a notice carries. */
const NAME_MAX = 60;

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

type Account = Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>;

export interface RoundDeps {
    storage: Storage;
    account: Account | null;
    /** Posts a notice on the phone; null when the phone doesn't let the app notify, and nothing shows. */
    post: ((notice: LocalNotice) => Promise<unknown>) | null;
    setBadge: (count: number) => Promise<unknown>;
    /** What waits at the community in use, while the app is closed. Absent while it's open: it isn't in the badge then. */
    activeUnread?: (publicKey: string) => Promise<number>;
    now?: number;
    timeoutMs?: number;
    /** A deadline shared with others (sync-notices.ts `postAllNoticesFromSync`). */
    signal?: AbortSignal;
}

interface RoundState {
    /** Whose rounds these are. */
    publicKey: string;
    /** When the last round went out (ms). */
    at: number;
    /** The last community it asked: the next round goes on after it. */
    after: string | null;
    /** The communities that said this account isn't theirs: address → left alone until (ms). */
    notTheirs: Record<string, number>;
}

function readState(raw: string | null, publicKey: string, now: number): RoundState {
    const state: RoundState = { publicKey, at: 0, after: null, notTheirs: {} };
    try {
        const stored = JSON.parse(raw ?? 'null') as Partial<RoundState> | null;
        if (!stored || stored.publicKey !== publicKey) return state;
        if (Number.isSafeInteger(stored.at)) state.at = stored.at as number;
        if (typeof stored.after === 'string') state.after = stored.after;
        for (const [community, until] of Object.entries(stored.notTheirs ?? {})) {
            if (typeof until === 'number' && until > now && until - now <= NOT_THEIRS_WAIT_MS) state.notTheirs[community] = until;
        }
    } catch {
        // Rounds that can't be read start again: the worst of it is one question early.
    }
    return state;
}

/**
 * The next {@link UNREAD_ROUND_SIZE} of `communities`, going round in address order from after `after`, so each gets its
 * turn whoever joins or leaves the list.
 */
function nextTurns(communities: readonly string[], after: string | null): string[] {
    const sorted = [...communities].sort();
    const start = after === null ? 0 : Math.max(sorted.findIndex((c) => c > after), 0);
    return [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, UNREAD_ROUND_SIZE);
}

/** The phone's saved list as far as a round reads it, by address. */
function savedRows(raw: string | null): { url?: unknown; alias?: unknown; requestSigning?: unknown }[] {
    try {
        const saved = JSON.parse(raw ?? '[]');
        return Array.isArray(saved) ? saved.filter((n) => n && typeof n === 'object') : [];
    } catch {
        return [];
    }
}

/** The name the phone saved for `community`, on one line and cut short, or its host. A notice carries no other. */
function savedName(saved: ReturnType<typeof savedRows>, community: string): string {
    const row = saved.find((n) => communityAddress(n.url) === community);
    const name = communityName({ url: community, alias: typeof row?.alias === 'string' ? row.alias : null }).replace(/\s+/g, ' ');
    return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
}

/** A community's `unread` as it answered it, or null for anything that isn't a count: as good as no answer. */
function unreadOf(body: unknown): number | null {
    const unread = body && typeof body === 'object' ? (body as Partial<UnreadAnswer>).unread : undefined;
    return typeof unread === 'number' && Number.isSafeInteger(unread) && unread >= 0 ? unread : null;
}

function saysNotTheirs(answer: { status: number; body: unknown }): boolean {
    const code = answer.body && typeof answer.body === 'object' ? (answer.body as { code?: unknown }).code : undefined;
    return answer.status === 403 && typeof code === 'string' && NOT_THEIRS_CODES.has(code);
}

/** One community's turn: its count written down, and a notice if it rose where no push can have said so. True if one went out. */
async function askOne(community: string, account: Account, deps: RoundDeps, signal: AbortSignal, name: string, onNotTheirs: () => void): Promise<boolean> {
    const answer = await signedAnswer(`${community}${UNREAD_PATH}`, account, deps.timeoutMs ?? SYNC_NOTICES_TIMEOUT_MS, signal);
    if (!answer) return false;
    if (saysNotTheirs(answer)) {
        onNotTheirs();
        await dropCounts(deps.storage, [community]);
        return false;
    }
    const unread = answer.ok ? unreadOf(answer.body) : null;
    if (unread === null) return false;
    if (!await noteServerUnread(deps.storage, community, unread)) return false;
    if (!deps.post || await pushLandedAt(deps.storage, community, account.publicKey)) return false;
    try {
        await deps.post({
            title: PUSH_NOTICE_TITLE,
            body: t('You have new messages in {community}', { community: name }),
            data: { ...LOCAL_NOTICE_DATA, type: UNREAD_NOTICE_TYPE, url: community },
        });
        return true;
    } catch (e) {
        console.warn('[Notices] Could not post a notice from a round', e);
        return false;
    }
}

/** The badge set to the sum. One that can't be worked out is left as it was: the last number is better than a wrong one. */
async function setBadgeToSum(storage: Pick<Storage, 'getItem'>, setBadge: RoundDeps['setBadge'], here: () => Promise<number>): Promise<void> {
    try {
        await setBadge(await here() + await noticeCountsSum(storage));
    } catch (e) {
        console.warn('[Notices] The badge was left as it was', e);
    }
}

async function round(deps: RoundDeps): Promise<number> {
    const { storage, account } = deps;
    const now = deps.now ?? Date.now();
    if (!account?.publicKey || !account.privateKey) return 0;
    const { anchor, kept } = await readKeptCommunities(storage);
    const others = kept.filter((c) => c !== anchor);
    if (others.length === 0) return 0;
    const state = readState(await storage.getItem(UNREAD_ROUNDS_STORE_KEY), account.publicKey, now);
    // A clock set back since says nothing about when the last one went.
    if (now >= state.at && now - state.at < UNREAD_ROUND_GAP_MS) return 0;

    const saved = savedRows(await storage.getItem(SAVED_NODES_STORE_KEY));
    const oldSigning = (c: string) => {
        const said = saved.find((n) => communityAddress(n.url) === c)?.requestSigning;
        return typeof said === 'number' && said < REQUEST_SIGNING_VERSION;
    };
    const forAlerts = await communitiesForAlerts(storage);
    await dropCounts(storage, others.filter((c) => !forAlerts.includes(c)));
    const turns = nextTurns(forAlerts.filter((c) => c !== anchor && !oldSigning(c) && !(c in state.notTheirs)), state.after);

    // Written down before anything goes out: a round that dies part-way has still had its turn.
    state.at = now;
    if (turns.length > 0) state.after = turns[turns.length - 1];
    await storage.setItem(UNREAD_ROUNDS_STORE_KEY, JSON.stringify(state));

    const refused: string[] = [];
    const { signal, done } = bounded(deps.timeoutMs ?? SYNC_NOTICES_TIMEOUT_MS, deps.signal);
    const told = await Promise.all(turns.map((c) => askOne(c, account, deps, signal, savedName(saved, c), () => { refused.push(c); })))
        .finally(done);

    if (refused.length > 0) {
        // Not if the account left the phone while they answered: nothing of it is written back after the wipe.
        const stillHere = (await readKeptCommunities(storage)).kept;
        for (const c of refused) if (stillHere.includes(c)) state.notTheirs[c] = now + NOT_THEIRS_WAIT_MS;
        if (stillHere.length > 0) await storage.setItem(UNREAD_ROUNDS_STORE_KEY, JSON.stringify(state));
    }
    await setBadgeToSum(storage, deps.setBadge, async () => (await deps.activeUnread?.(account.publicKey)) ?? 0);
    return told.filter(Boolean).length;
}

let running: Promise<number> | null = null;

/**
 * One round: see the header. A call while one runs waits for it, and asks nothing more. Returns how many notices it posted.
 * Never throws.
 */
export function askOtherCommunities(deps: RoundDeps): Promise<number> {
    if (running) return running;
    running = round(deps).catch((e) => {
        console.warn('[Notices] A round of the other communities failed', e);
        return 0;
    }).finally(() => { running = null; });
    return running;
}

/** Whether the phone keeps any community but the one it is set to. Never throws. */
export async function keepsOtherCommunities(storage: Pick<Storage, 'getItem'>): Promise<boolean> {
    try {
        const { anchor, kept } = await readKeptCommunities(storage);
        return kept.some((c) => c !== anchor);
    } catch {
        return false;
    }
}

/**
 * The badge set to what the phone already knows, while the app is open, asking nobody: after a push is counted, at a
 * switch, and as the app comes back. A phone with one community is left alone: its badge is its push's. Never throws.
 */
export async function showUnreadSum(storage: Pick<Storage, 'getItem'>, setBadge: (count: number) => Promise<unknown>): Promise<void> {
    if (await keepsOtherCommunities(storage)) await setBadgeToSum(storage, setBadge, async () => 0);
}

/** What the phone itself does for a round (services/push-notifications.ts): none of it asks the member for anything. */
export interface PhoneNotices {
    /** Whether the phone already lets the app notify. Reads that; never shows a prompt. */
    mayNotify(): Promise<boolean>;
    post(notice: LocalNotice): Promise<unknown>;
    setBadge(count: number): Promise<unknown>;
}

/** A round while the app is open. Throws only what `phone.mayNotify` throws. */
export async function roundWhileOpen(storage: Storage, account: Account | null, phone: PhoneNotices): Promise<number> {
    return askOtherCommunities({ storage, account, post: (await phone.mayNotify()) ? phone.post : null, setBadge: phone.setBadge });
}

/**
 * All the background sync posts: the sync's notices and the round, under one deadline. Where the phone doesn't let the app
 * notify, the round alone: its numbers and the badge are still worth having, and it posts nothing. Returns how many were
 * posted. Throws only what `phone.mayNotify` throws.
 */
export async function noticesAfterSync(deps: {
    storage: Storage;
    account: Account | null;
    phone: PhoneNotices;
    activeUnread: (publicKey: string) => Promise<number>;
    timeoutMs?: number;
}): Promise<number> {
    const { storage, account, phone, activeUnread, timeoutMs } = deps;
    const may = await phone.mayNotify();
    const ask = (signal?: AbortSignal) => askOtherCommunities({
        storage, account, post: may ? phone.post : null, setBadge: phone.setBadge, activeUnread, timeoutMs, signal,
    });
    return may ? postAllNoticesFromSync({ storage, account, post: phone.post, timeoutMs }, ask) : ask();
}
