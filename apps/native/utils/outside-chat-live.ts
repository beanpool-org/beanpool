/**
 * Chats with people in other communities, as the screens and the syncs reach them (slice X3): the context for the community
 * the phone is set to (utils/outside-mail.ts), one round at a time, and the event screens listen to. Where the community
 * does not take messages from other communities (its node says nothing, or the owner's switch is off), nothing is asked.
 *
 * Slice S4 (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3, §6): an across chat lives in the file of the
 * community that carries it (its mailbox is that community's server), and now shows and is fetched whatever community the
 * phone is set to. A context, and a round, may name another community this phone holds as a member: its own address, its own
 * mailbox, and its own file, reached through its copy open in place (db.ts outsideStoreOf), held open for the round only
 * (enterChatInPlace ... leaveChatInPlace). No data moves between files. A counts answer that says mail waits there starts
 * that community's round ({@link roundWhereMailWaits}); a ring from it while the app is open does too ({@link roundOnRing});
 * Chat as it opens and the background task fetch every held community, whatever its last answer said (#3310 review F1).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { t } from '@beanpool/core';
import { loadIdentity } from './identity';
import { blocksOwedAt, blockUser, isUserBlocked, syncBlocksAt } from './blocklist';
import { fetchNodeProfile, getCachedNodeProfile, outsideMessagesOn } from './node-profile';
import { failUnsent, setOutsideQuiet, syncOutsideMail, OutsideMailError, type OutsideMailContext, type SyncOutcome } from './outside-mail';
import { getDatabaseFilenameForNode, getSavedNodes, isGuestCopy } from './nodes';
import { isPlainNodeAddress } from './node-url';

/** Emitted after a round that changed anything here: a line in, a state moved, a chat made. */
export const OUTSIDE_CHATS_UPDATED = 'outside_chats_updated';

/**
 * The context for the community the phone is set to, or null with no community or no account. `community` (slice S4):
 * another community this phone holds, whose across chats it reaches by name ({@link contextFor}).
 */
export async function outsideContext(community?: string | null): Promise<OutsideMailContext | null> {
    return (await contextFor(community))?.ctx ?? null;
}

/**
 * Let in once for one round (slice S3b) at `community`, the mailbox it reads: utils/let-in.ts letInFor, loaded at its first
 * ask as db.ts is here; that community's own block list is read first in a run (slice S7b). A read that fails lets nobody
 * in: their line waits at the door as before.
 */
function letInOf(me: string, community: string): (key: string) => Promise<boolean> {
    let ask: Promise<(key: string) => Promise<boolean>> | null = null;
    return async (key) => {
        try {
            ask ??= import('./let-in').then((m) => m.letInFor(me, community));
            return await (await ask)(key);
        } catch {
            return false;
        }
    };
}

/**
 * The context for `community`'s across chats (slice S4), and the address it holds in place when that is not the community
 * in use. No community, or the one in use however spelled: the community in use, as before (its store throws once the
 * phone has switched). Another community this phone saved, as a member (not a guest's look), at a plain address: that one,
 * at the address the phone saved for it, never a link's own spelling. Anything else, no account, or no community set: null.
 */
async function contextFor(community?: string | null): Promise<{ ctx: OutsideMailContext; inPlace: string | null } | null> {
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
    if (!anchor) return null;
    const identity = await loadIdentity().catch(() => null);
    if (!identity?.privateKey) return null;
    const db = await import('./db');
    const file = community ? getDatabaseFilenameForNode(community) : null;
    if (!file || file === getDatabaseFilenameForNode(anchor)) {
        return { ctx: { nodeUrl: anchor.replace(/\/+$/, ''), identity, store: db.outsideStore(anchor), isBlocked: isUserBlocked, letIn: letInOf(identity.publicKey, anchor) }, inPlace: null };
    }
    const saved = (await getSavedNodes().catch(() => [])).find((n) => getDatabaseFilenameForNode(n.url) === file);
    if (!saved || !isPlainNodeAddress(saved.url) || await isGuestCopy(saved.url).catch(() => true)) return null;
    return { ctx: { nodeUrl: saved.url.replace(/\/+$/, ''), identity, store: db.outsideStoreOf(saved.url), isBlocked: isUserBlocked, letIn: letInOf(identity.publicKey, saved.url) }, inPlace: saved.url };
}

/**
 * Block, from an across chat (#3310 review F1): `key` blocked for the account on this phone, and the community in use hears it,
 * as it hears every block (blocklist.ts blockUser). When another community this phone holds carries the chat (`community`, the
 * screen's in place), that community hears it too, at the address the phone saved for it and signed for its name (blockUser's
 * `community`, syncBlocksAt): its mailbox holds that key's lines and rings for them (server engine/relay-mail.ts). And the key
 * is made quiet there at once (setOutsideQuiet), so it rings nothing even before that community holds the block. A quiet that
 * doesn't go (offline, an old server, the 500 limit) leaves the block as it is. Never throws.
 */
export async function blockFromAcross(community: string | null | undefined, key: string): Promise<void> {
    const found = await contextFor(community).catch(() => null);
    await blockUser(key, undefined, undefined, undefined, found?.inPlace ?? undefined);
    if (found) await setOutsideQuiet(found.ctx, key, true).catch(() => {});
}

/**
 * The other communities this phone holds as a member, whose files may carry across chats (slice S4): saved, at a plain
 * address, not a guest's look, not the one in use, one per file however spelled.
 */
export async function heldMailCommunities(): Promise<string[]> {
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
    const files = new Set<string>([getDatabaseFilenameForNode(anchor)]);
    const out: string[] = [];
    for (const node of await getSavedNodes().catch(() => [])) {
        const file = getDatabaseFilenameForNode(node.url);
        if (files.has(file) || !isPlainNodeAddress(node.url) || await isGuestCopy(node.url).catch(() => true)) continue;
        files.add(file);
        out.push(node.url);
    }
    return out;
}

/**
 * Whether a counts answer (other-communities-unread.ts, `heard`) says across mail waits there for this member (`mail`, server
 * GET /api/me/unread). Nothing is kept of one that says none (#3310 review F1): a line can land there, and ring, a minute
 * later, and no later answer would come to lift a kept 0 in the background, where no counts round runs.
 */
export function mailWaits(body: unknown): boolean {
    const mail = body && typeof body === 'object' ? (body as { mail?: unknown }).mail : undefined;
    return typeof mail === 'number' && Number.isSafeInteger(mail) && mail > 0;
}

/**
 * A held community's counts answer, as the round while the app is open hears it (services/push-notifications.ts
 * askOtherCommunitiesNow): its mailbox fetched now, into its own file, when mail waits there; else nothing (a node too old
 * to say `mail` included: Chat's round and the background task fetch it). Never throws.
 */
export function roundWhereMailWaits(community: string, body: unknown): Promise<SyncOutcome | null> | null {
    return mailWaits(body) ? syncOutsideMailNow(undefined, community) : null;
}

/**
 * A notice another community this phone holds signed for this account landed while the app is open (services/
 * push-notifications.ts handleNotification; design §3 "Live typing and instant arrival": across chats refresh on a push). A
 * `chat.message` (the ring of a line held there, engine/relay-mail.ts ringHeldMail, or a direct line there) fetches that
 * community's across mail now, into its own file, at the address the phone saved for it: the line shows in Chat and its
 * sender's Delivered goes, whatever that community's last counts answer said (#3310 review F1). The community in use, or one
 * the phone doesn't hold as a member: nothing (its own rounds fetch it). Null when no round was started. Never throws.
 */
export async function roundOnRing(notice: { community: string; kind: string | null; active: boolean }): Promise<SyncOutcome | null> {
    if (notice.active || notice.kind !== 'chat.message') return null;
    const file = getDatabaseFilenameForNode(notice.community);
    const held = (await heldMailCommunities().catch(() => [])).find((c) => getDatabaseFilenameForNode(c) === file);
    return held ? syncOutsideMailNow(undefined, held) : null;
}

/**
 * A round for each held community (slice S4): Chat as it opens, and the background task after the community in use's ({@link
 * mailAfterBackgroundSync}). Side by side, each with its own deadline at the end of the one budget (#3310 r3 review F2: one
 * after another, a community that never answers used the whole budget, and no other was fetched), each community fetched
 * whatever its last counts answer said (#3310 review F1: a `mail: 0` heard earlier never hides a line that came, and rang,
 * since). Returns how many rounds ran.
 */
export async function syncHeldMailNow(budgetMs: number = OUTSIDE_ROUND_MS): Promise<number> {
    const end = Date.now() + budgetMs;
    const held = await heldMailCommunities().catch(() => []);
    const left = end - Date.now();
    if (held.length === 0 || left < BACKGROUND_MIN_MS) return 0;
    await Promise.all(held.map((community) => syncOutsideMailNow(left, community).catch(() => null)));
    return held.length;
}

/**
 * The background task's mail step (services/background-task.ts), `wokeAt` when the task woke: the community in use's round
 * under its own budget, then every held community's in what is left of iOS's window, none skipped for a `mail: 0` heard while
 * the app was open (#3310 review F1: nothing in the background asks for counts, and a ring shown by the phone runs no app
 * code). Too little left: skipped, and the mail waits for the next wake or the app.
 */
export async function mailAfterBackgroundSync(wokeAt: number): Promise<void> {
    const budget = backgroundMailBudget(Date.now() - wokeAt);
    if (budget > 0) await syncOutsideMailNow(budget);
    const left = backgroundMailBudget(Date.now() - wokeAt);
    if (left > 0) await syncHeldMailNow(left);
}

/**
 * Whether the community the phone is set to takes messages from other communities, by the profile this phone keeps, read from
 * the community when it keeps none yet (a new phone's first minute, a restore from 12 words).
 */
export async function outsideMessagesHere(nodeUrl: string): Promise<boolean> {
    return outsideMessagesOn((await profileHere(nodeUrl))?.features);
}

/** The community's profile as this phone keeps it, read from the community when it keeps none; null when neither can be had. */
async function profileHere(nodeUrl: string) {
    return (await getCachedNodeProfile(nodeUrl).catch(() => null)) ?? (await fetchNodeProfile(nodeUrl).catch(() => null));
}

/**
 * How long one round may take in the app before it is given up: every request in it is aborted (React Native's fetch never
 * gives up by itself), and the next caller starts a new round. Well over a healthy round: a page, its confirm, and a receipt
 * to each sender, each forwarded by my server to theirs (up to 10 s each).
 */
export const OUTSIDE_ROUND_MS = 45_000;
/** How long a send from the chat waits for my server before the line is left `sending`, to go at the next round. */
export const OUTSIDE_SEND_MS = 20_000;
/** The background task's own budget for this step (services/background-task.ts), as the notices step has its 8 s. */
export const OUTSIDE_BACKGROUND_MS = 8_000;
/** What iOS gives the background task (~30 s), less a margin for the task's own end. */
const BACKGROUND_WINDOW_MS = 28_000;
/** Less than this left: the step is skipped, and its mail waits for the next wake or the app. */
const BACKGROUND_MIN_MS = 2_000;

/**
 * The background step's budget, `elapsedMs` into the task (after the sync's 20 s fail-fast and the notices' 8 s at worst):
 * its own budget, or what is left of iOS's window when that is less, or 0 (skip) when too little is left.
 */
export function backgroundMailBudget(elapsedMs: number): number {
    const left = BACKGROUND_WINDOW_MS - elapsedMs;
    return left < BACKGROUND_MIN_MS ? 0 : Math.min(OUTSIDE_BACKGROUND_MS, left);
}

/** The rounds running: the community in use's (''), and each held community's by its file. */
const running = new Map<string, Promise<SyncOutcome | null>>();

/**
 * One round, never two at once for one community; null when nothing was asked (no community, no account, the switch off,
 * unreachable) or the round ran out of time. A round has a deadline, `budgetMs`: at it, every request still out is aborted,
 * the round answers null and is let go, so one stalled request never stops the rounds after it (the chat's poll, the Chat
 * tab, the background task). A caller that finds a round running shares it, but waits no longer than its own budget.
 * `community` (slice S4): another community this phone holds, whose mailbox and file the round reaches by name; left out,
 * the one in use, as before.
 */
export function syncOutsideMailNow(budgetMs: number = OUTSIDE_ROUND_MS, community?: string | null): Promise<SyncOutcome | null> {
    const key = community ? getDatabaseFilenameForNode(community) : '';
    const under = running.get(key);
    if (under) return atMost(under, budgetMs);
    const round = roundWithDeadline(budgetMs, community);
    running.set(key, round);
    void round.finally(() => { if (running.get(key) === round) running.delete(key); });
    return round;
}

function roundWithDeadline(deadlineMs: number, community?: string | null): Promise<SyncOutcome | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            console.warn('[OutsideMail] This round ran out of time; the next one starts afresh.');
            resolve(null);
        }, deadlineMs);
    });
    const work = (async (): Promise<SyncOutcome | null> => {
        // Another community's copy is held open in place for this round only (slice S4), from before its first statement.
        let held: string | null = null;
        try {
            const found = await contextFor(community);
            if (!found) return null;
            const { ctx } = found;
            if (found.inPlace) {
                held = found.inPlace;
                (await import('./db')).enterChatInPlace(held);
                // A block from one of its chats whose answer never came (offline, the minute's limit: #3310 r3 review F1): sent
                // there again, outside this round's deadline, without waiting for the next round of every held community.
                const owedAt = held;
                void (async () => { if (await blocksOwedAt(owedAt)) await syncBlocksAt(owedAt); })().catch(() => {});
            }
            const profile = await profileHere(ctx.nodeUrl);
            if (!outsideMessagesOn(profile?.features)) {
                // Read, and off: my server would refuse my waiting lines (403), and no round will run to send them. They fail
                // now, saying why, rather than say "Sending…" for good. Not read at all: nothing is known, nothing changes.
                if (profile && await failUnsent(ctx, t("This community doesn't take messages from other communities.")) > 0) {
                    DeviceEventEmitter.emit(OUTSIDE_CHATS_UPDATED);
                }
                return null;
            }
            const out = await syncOutsideMail({ ...ctx, signal: controller.signal });
            if (out.written || out.requests || out.ticks) DeviceEventEmitter.emit(OUTSIDE_CHATS_UPDATED);
            return out;
        } catch (e) {
            if (!controller.signal.aborted) console.warn('[OutsideMail] This round did not finish:', (e as Error)?.message ?? e);
            return null;
        } finally {
            if (held) await (await import('./db')).leaveChatInPlace(held).catch(() => {});
        }
    })();
    return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
}

/** `p`, or null once `ms` pass first. */
function atMost<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * What to tell the member when a send or an answer didn't go: the server's own words, else ours. `kept` false: no line was
 * kept (outside-mail.ts sendFromBox), so nothing will be tried again, and the words wait in the box.
 */
export function outsideErrorWords(e: unknown, kept = true): string {
    if (e instanceof OutsideMailError && e.message && !/^HTTP \d+$/.test(e.message)) return e.message;
    return kept
        ? t("That didn't go through. It will be tried again when you're back online.")
        : t("That didn't go through. Your message is still there to send again.");
}
