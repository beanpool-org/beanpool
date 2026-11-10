/**
 * "Never miss a DM" (Marty, 1 Nov), push or no push: the rounds that ask the phone's communities how many messages wait
 * there (scratch/fable-design/DESIGN-cross-community-chat-fable.md §1.2, R4, R5, R7). Its other communities always, and,
 * while the app is closed, the one it is set to as well: no socket watches that one then, and `performSync` reads no
 * messages, so the phone's own copy says only what it held when the app closed. Damo's phone runs GrapheneOS: push can't be
 * relied on there, and without this nothing on a phone ever asks "is there anything for me?"
 *
 * **When.** As the app opens or comes back and with the 5-minute sync ({@link roundWhileOpen}, app/_layout.tsx), and with
 * the background sync, 15 minutes at best ({@link noticesAfterSync}, services/push-notifications.ts), never closer together
 * than {@link UNREAD_ROUND_GAP_MS}.
 *
 * **What a round costs an old phone on prepaid data.** Each community is sent one signed `GET /api/me/unread` and no second
 * try: all at once, at most {@link UNREAD_ROUND_SIZE} of them with the community in use among them, under one deadline, which
 * in the background is the sync notices' own (sync-notices.ts `postAllNoticesFromSync`), so the task's ceiling doesn't move.
 * The next round goes on from where this one stopped, so with more communities than that each still gets its turn. A
 * community that doesn't answer costs that deadline, keeps the number it had, tells nobody anything, and is asked again next
 * round.
 *
 * **What is asked, and of whom.** Only communities the phone keeps and may send alerts from (push-registrations.ts
 * `communitiesForAlerts`: not one with alerts off, not an address that isn't plain, and not a guest's look except that a
 * closed round asks the community in use, as sync does), one of each however it is spelled (push-pins.ts `sameCommunity`). Being kept isn't belonging, and no mark says which it is, so the first
 * question is the test, as the membership probe is: it carries no push token, and a community that says the account isn't
 * theirs is left alone for {@link NOT_THEIRS_WAIT_MS}. Each request is signed by the member's key for that community's own
 * host, carries nothing of any other community, and no community is told of another.
 *
 * A community whose server is older than this app talks to is not asked: the phone sends it nothing but its health read
 * (utils/node-version-gate.ts), so its round is refused before it leaves the phone and counts as no answer.
 *
 * **What the phone does with an answer.** Its `unread` is that community's number on the BeanPool sheet (notice-counts.ts).
 * `requests` is not looked at: a message request makes no badge and no alert until it is accepted (Marty, 1 Nov).
 *
 * **Its own notice, where no push can have said it** (R5). A rise in `alerts` posts one notice, written down before it is
 * posted so it is never posted twice: "You have new messages in {community}", in the phone's own words, with the name the
 * phone saved for the community and nothing of any message. `alerts` is the lines the node would have pushed about, so a
 * muted chat, Direct Messages off and an event's chat stay as silent here as they are for a push: their lines move the number
 * and the badge, and tell nobody. **A node too old to send `alerts` is taken at its `unread`**: for that community alone a
 * muted chat can still post a notice until its server is updated. A fall posts nothing. Where that community holds this
 * phone's token, its own push told the member, so there is no second line on the lock screen: the number moves and that is
 * all. A tap moves the phone there, through the one switch, and opens its Chat (push-notice-check.ts `checkTap`,
 * push-notice-switch.ts).
 *
 * **Never a prompt** (permissions only when asked: Marty, 26 Oct). `post` is null unless the phone already lets the app
 * notify. Without it the numbers and the badge still move, and nothing shows.
 *
 * **The app-icon badge is the sum** (R7). A community's push sets the icon to that community's number alone, so with two
 * communities it would flip between them: after every round the phone sets it to all of them added up. While the app is
 * closed that takes the community in use's own answer. If it gives none, the badge stays as it was: no copy nobody refreshed
 * takes a number down. While the app is open that community isn't in the sum, as ever. A phone with one community is left to
 * its push's badge, and asks nothing, unless no push of its community can reach it: then, with the app closed, a round is all
 * that tells it.
 */
import { PUSH_NOTICE_TITLE, t, type UnreadAnswer } from '@beanpool/core';
import { communityName } from './community-name';
import type { BeanPoolIdentity } from './identity';
import { dropCounts, noteServerUnread, noticeCountsSum } from './notice-counts';
import { LOCAL_NOTICE_DATA, UNREAD_NOTICE_TYPE } from './push-notice-check';
import { readKeptCommunities, sameCommunity } from './push-pins';
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
    /**
     * The app is closed (the background sync's round): the community in use is asked as well, and its answer goes in the
     * badge. Absent while it's open: its socket says what happens there, and it isn't in the badge then.
     */
    closed?: boolean;
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
    /**
     * What the community in use last said in a closed round, for a rise to be measured from. Kept here, not in
     * notice-counts.ts, whose number for it goes as the root layout mounts, which iOS does in the background too: a line
     * would be told again each time. Forgotten each time the app is open: the member may read those lines there, no round
     * would see that fall, and the next line wouldn't read as a rise.
     */
    inUse: { community: string; alerts: number } | null;
}

function readState(raw: string | null, publicKey: string, now: number): RoundState {
    const state: RoundState = { publicKey, at: 0, after: null, notTheirs: {}, inUse: null };
    try {
        const stored = JSON.parse(raw ?? 'null') as Partial<RoundState> | null;
        if (!stored || stored.publicKey !== publicKey) return state;
        if (Number.isSafeInteger(stored.at)) state.at = stored.at as number;
        if (typeof stored.after === 'string') state.after = stored.after;
        if (typeof stored.inUse?.community === 'string' && Number.isSafeInteger(stored.inUse.alerts)) state.inUse = stored.inUse;
        for (const [community, until] of Object.entries(stored.notTheirs ?? {})) {
            if (typeof until === 'number' && until > now && until - now <= NOT_THEIRS_WAIT_MS) state.notTheirs[community] = until;
        }
    } catch {
        // Rounds that can't be read start again: the worst of it is one question early.
    }
    return state;
}

/**
 * The next `size` of `communities`, going round in address order from after `after`, so each gets its turn whoever joins or
 * leaves the list.
 */
function nextTurns(communities: readonly string[], after: string | null, size: number): string[] {
    const sorted = [...communities].sort();
    const start = after === null ? 0 : Math.max(sorted.findIndex((c) => c > after), 0);
    return [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, size);
}

/** `communities`, one of each however it is spelled: the first spelling stands. */
function oneOfEach(communities: readonly string[]): string[] {
    return communities.filter((c, i) => !communities.slice(0, i).some((d) => sameCommunity(c, d)));
}

/** The phone's saved list as far as a round reads it, by address. */
function savedRows(raw: string | null): { url?: unknown; alias?: unknown }[] {
    try {
        const saved = JSON.parse(raw ?? '[]');
        return Array.isArray(saved) ? saved.filter((n) => n && typeof n === 'object') : [];
    } catch {
        return [];
    }
}

/** The name the phone saved for `community`, on one line and cut short, or its host. A notice carries no other. */
function savedName(saved: ReturnType<typeof savedRows>, community: string): string {
    const row = saved.find((n) => sameCommunity(n.url, community));
    const name = communityName({ url: community, alias: typeof row?.alias === 'string' ? row.alias : null }).replace(/\s+/g, ' ');
    return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
}

/** A count as a community's answer gave it, or null for anything that isn't a count. */
function countIn(body: unknown, field: 'unread' | 'alerts'): number | null {
    const count = body && typeof body === 'object' ? (body as Partial<UnreadAnswer>)[field] : undefined;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function saysNotTheirs(answer: { status: number; body: unknown }): boolean {
    const code = answer.body && typeof answer.body === 'object' ? (answer.body as { code?: unknown }).code : undefined;
    return answer.status === 403 && typeof code === 'string' && NOT_THEIRS_CODES.has(code);
}

/**
 * What `community` says waits, with `alerts` standing at `unread` where a node too old to send it says nothing of them;
 * `'not-theirs'` where it says the account isn't theirs; null for no answer, or anything that isn't a count. Never throws.
 */
async function countAt(community: string, account: Account, deps: RoundDeps, signal: AbortSignal): Promise<{ unread: number; alerts: number } | 'not-theirs' | null> {
    const answer = await signedAnswer(`${community}${UNREAD_PATH}`, account, deps.timeoutMs ?? SYNC_NOTICES_TIMEOUT_MS, signal);
    if (!answer) return null;
    if (saysNotTheirs(answer)) return 'not-theirs';
    const unread = answer.ok ? countIn(answer.body, 'unread') : null;
    return unread === null ? null : { unread, alerts: countIn(answer.body, 'alerts') ?? unread };
}

/** The phone's own notice for a rise, unless it may not notify or that community's own push said so. True if one went out. */
async function tell(community: string, name: string, account: Account, deps: RoundDeps): Promise<boolean> {
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

/**
 * Whether `community` still has alerts on, read afresh: the answer to a round can come after the member turned them off
 * (the sheet's switch), and an answer from a community that is off is not counted, told, or written down. A list that can't
 * be read says no (a number shown for a community the member silenced is worse than none missed).
 */
async function stillForAlerts(storage: RoundDeps['storage'], community: string): Promise<boolean> {
    try {
        return (await communitiesForAlerts(storage)).some((c) => sameCommunity(c, community));
    } catch {
        return false;
    }
}

/** One community's turn: its count written down, and a notice if it rose where no push can have said so. True if one went out. */
async function askOne(community: string, account: Account, deps: RoundDeps, signal: AbortSignal, name: string, onNotTheirs: () => void): Promise<boolean> {
    const count = await countAt(community, account, deps, signal);
    if (count === 'not-theirs') {
        onNotTheirs();
        await dropCounts(deps.storage, [community]);
        return false;
    }
    if (!count || !await stillForAlerts(deps.storage, community)) return false;
    if (!await noteServerUnread(deps.storage, community, count.unread, count.alerts)) return false;
    // Again before the notice: the switch can go off between the number and the telling.
    return await stillForAlerts(deps.storage, community) && tell(community, name, account, deps);
}

/**
 * The community in use's turn, while the app is closed: as {@link askOne}, with what it said written down in `state`, and
 * its number handed to `onNumber` for the badge, which has none from it if it gives no answer. True if a notice went out.
 */
async function askInUse(
    community: string, account: Account, deps: RoundDeps, signal: AbortSignal, name: string, state: RoundState,
    onNotTheirs: () => void, onNumber: (unread: number) => void,
): Promise<boolean> {
    const count = await countAt(community, account, deps, signal);
    if (count === 'not-theirs') {
        onNotTheirs();
        onNumber(0);
        return false;
    }
    if (!count) return false;
    // Not if the member turned its alerts off while it answered, nor if the account left the phone: nothing is written back.
    if (!await stillForAlerts(deps.storage, community)) { onNumber(0); return false; }
    // Not if the account left the phone while it answered: nothing of it is written back after the wipe.
    if (!(await readKeptCommunities(deps.storage)).kept.includes(community)) return false;
    onNumber(count.unread);
    const rose = count.alerts > (state.inUse?.community === community ? state.inUse.alerts : 0);
    state.inUse = { community, alerts: count.alerts };
    try {
        await deps.storage.setItem(UNREAD_ROUNDS_STORE_KEY, JSON.stringify(state));
    } catch (e) {
        // A rise that can't be written down tells nobody: it would be told again every round.
        console.warn('[Notices] What the community in use said could not be kept', e);
        return false;
    }
    return rose && tell(community, name, account, deps);
}

/**
 * The badge set to `here` and the other communities' sum. Left as it was with no number for `here`, or if that can't be
 * done: the last number is better than a wrong one.
 */
async function setBadgeToSum(storage: Pick<Storage, 'getItem'>, setBadge: RoundDeps['setBadge'], here: number | null): Promise<void> {
    if (here === null) return;
    try {
        await setBadge(here + await noticeCountsSum(storage));
    } catch (e) {
        console.warn('[Notices] The badge was left as it was', e);
    }
}

async function round(deps: RoundDeps): Promise<number> {
    const { storage, account } = deps;
    const now = deps.now ?? Date.now();
    if (!account?.publicKey || !account.privateKey) return 0;
    const { anchor, kept } = await readKeptCommunities(storage);
    const state = readState(await storage.getItem(UNREAD_ROUNDS_STORE_KEY), account.publicKey, now);
    // The app is open: see `inUse` above. Before any floor or early way out, so it holds for every phone, every time.
    if (!deps.closed && state.inUse) {
        state.inUse = null;
        await storage.setItem(UNREAD_ROUNDS_STORE_KEY, JSON.stringify(state));
    }
    const others = kept.filter((c) => !sameCommunity(c, anchor));
    if (others.length === 0 && !deps.closed) return 0;
    // A clock set back since says nothing about when the last one went.
    if (now >= state.at && now - state.at < UNREAD_ROUND_GAP_MS) return 0;

    const saved = savedRows(await storage.getItem(SAVED_NODES_STORE_KEY));
    const forAlerts = await communitiesForAlerts(storage);
    const inUse = deps.closed ? anchor : null;
    // Whether the community in use has a part in the badge at all: alerts off there, or an account it says isn't theirs, is
    // none.
    const inBadge = inUse !== null && forAlerts.includes(inUse) && !(inUse in state.notTheirs);
    const asksInUse = inBadge && (others.length > 0 || !await pushLandedAt(storage, inUse, account.publicKey));
    if (others.length === 0 && !asksInUse) return 0;

    await dropCounts(storage, others.filter((c) => !forAlerts.includes(c)));
    const turns = nextTurns(
        oneOfEach(forAlerts.filter((c) => !sameCommunity(c, anchor) && !(c in state.notTheirs))),
        state.after,
        asksInUse ? UNREAD_ROUND_SIZE - 1 : UNREAD_ROUND_SIZE,
    );

    // Written down before anything goes out: a round that dies part-way has still had its turn.
    state.at = now;
    if (turns.length > 0) state.after = turns[turns.length - 1];
    await storage.setItem(UNREAD_ROUNDS_STORE_KEY, JSON.stringify(state));

    const refused: string[] = [];
    let here: number | null = inBadge ? null : 0;
    const { signal, done } = bounded(deps.timeoutMs ?? SYNC_NOTICES_TIMEOUT_MS, deps.signal);
    const asks = turns.map((c) => askOne(c, account, deps, signal, savedName(saved, c), () => { refused.push(c); }));
    if (asksInUse) {
        asks.push(askInUse(inUse, account, deps, signal, savedName(saved, inUse), state, () => { refused.push(inUse); }, (unread) => { here = unread; }));
    }
    const told = await Promise.all(asks).finally(done);

    if (refused.length > 0) {
        // Not if the account left the phone while they answered: nothing of it is written back after the wipe.
        const stillHere = (await readKeptCommunities(storage)).kept;
        for (const c of refused) if (stillHere.includes(c)) state.notTheirs[c] = now + NOT_THEIRS_WAIT_MS;
        if (stillHere.length > 0) await storage.setItem(UNREAD_ROUNDS_STORE_KEY, JSON.stringify(state));
    }
    await setBadgeToSum(storage, deps.setBadge, here);
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
        return kept.some((c) => !sameCommunity(c, anchor));
    } catch {
        return false;
    }
}

/**
 * The badge set to what the phone already knows, while the app is open, asking nobody: after a push is counted, at a
 * switch, and as the app comes back. A phone with one community is left alone: its badge is its push's. Never throws.
 */
export async function showUnreadSum(storage: Pick<Storage, 'getItem'>, setBadge: (count: number) => Promise<unknown>): Promise<void> {
    if (await keepsOtherCommunities(storage)) await setBadgeToSum(storage, setBadge, 0);
}

/** What the phone itself does for a round (services/push-notifications.ts): none of it asks the member for anything. */
export interface PhoneNotices {
    /** Whether the phone already lets the app notify. Reads that; never shows a prompt. */
    mayNotify(): Promise<boolean>;
    post(notice: LocalNotice): Promise<unknown>;
    setBadge(count: number): Promise<unknown>;
}

/**
 * A round while the app is open. A closed round still going finishes first: what it writes of the community in use must not
 * land after this forgets it. Throws only what `phone.mayNotify` throws.
 */
export async function roundWhileOpen(storage: Storage, account: Account | null, phone: PhoneNotices): Promise<number> {
    const post = (await phone.mayNotify()) ? phone.post : null;
    await running;
    return askOtherCommunities({ storage, account, post, setBadge: phone.setBadge });
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
    timeoutMs?: number;
}): Promise<number> {
    const { storage, account, phone, timeoutMs } = deps;
    const may = await phone.mayNotify();
    const ask = (signal?: AbortSignal) => askOtherCommunities({
        storage, account, post: may ? phone.post : null, setBadge: phone.setBadge, closed: true, timeoutMs, signal,
    });
    return may ? postAllNoticesFromSync({ storage, account, post: phone.post, timeoutMs }, ask) : ask();
}
