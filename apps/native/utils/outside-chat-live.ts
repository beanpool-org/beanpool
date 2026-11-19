/**
 * Chats with people in other communities, as the screens and the syncs reach them (slice X3): the context for the community
 * the phone is set to (utils/outside-mail.ts), one round at a time, and the event screens listen to. Where the community
 * does not take messages from other communities (its node says nothing, or the owner's switch is off), nothing is asked.
 *
 * Slice S4 (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3, §6): an across chat lives in the file of the
 * community that carries it (its mailbox is that community's server), and now shows and is fetched whatever community the
 * phone is set to. A context, and a round, may name another community this phone holds as a member: its own address, its own
 * mailbox, and its own file, reached through its copy open in place (db.ts outsideStoreOf), held open for the round only
 * (enterChatInPlace ... leaveChatInPlace). No data moves between files. A held community's round is skipped while the last
 * counts answer it gave says `mail: 0` ({@link noteMailHeard}); a node too old to say `mail` is fetched as before.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { t } from '@beanpool/core';
import { loadIdentity } from './identity';
import { isUserBlocked } from './blocklist';
import { fetchNodeProfile, getCachedNodeProfile, outsideMessagesOn } from './node-profile';
import { failUnsent, syncOutsideMail, OutsideMailError, type OutsideMailContext, type SyncOutcome } from './outside-mail';
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
        return { ctx: { nodeUrl: anchor.replace(/\/+$/, ''), identity, store: db.outsideStore(anchor), isBlocked: isUserBlocked }, inPlace: null };
    }
    const saved = (await getSavedNodes().catch(() => [])).find((n) => getDatabaseFilenameForNode(n.url) === file);
    if (!saved || !isPlainNodeAddress(saved.url) || await isGuestCopy(saved.url).catch(() => true)) return null;
    return { ctx: { nodeUrl: saved.url.replace(/\/+$/, ''), identity, store: db.outsideStoreOf(saved.url), isBlocked: isUserBlocked }, inPlace: saved.url };
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
 * What each held community's counts answer last said waits there for this member (`mail`, server GET /api/me/unread), by
 * file. 0: its round is skipped until an answer says more. Absent (never heard, or a node too old to send it): fetched.
 * Kept while the app runs: a fresh start asks each once.
 */
const mailHeard = new Map<string, number>();

/**
 * A community's counts answer (other-communities-unread.ts, `heard`): its `mail`, kept. True when something waits there,
 * so the caller starts that community's round.
 */
export function noteMailHeard(community: string, body: unknown): boolean {
    const file = getDatabaseFilenameForNode(community);
    const mail = body && typeof body === 'object' ? (body as { mail?: unknown }).mail : undefined;
    if (typeof mail !== 'number' || !Number.isSafeInteger(mail) || mail < 0) {
        mailHeard.delete(file);
        return false;
    }
    mailHeard.set(file, mail);
    return mail > 0;
}

/** For tests: forget what was heard, as an app start does. */
export function _forgetMailHeardForTests(): void {
    mailHeard.clear();
}

/**
 * A round for each held community where mail may wait (slice S4): Chat as it opens, and the background task after the
 * community in use's. One after another under one budget; a community whose last answer said `mail: 0` is skipped. Returns
 * how many rounds ran.
 */
export async function syncHeldMailNow(budgetMs: number = OUTSIDE_ROUND_MS): Promise<number> {
    const end = Date.now() + budgetMs;
    let ran = 0;
    for (const community of await heldMailCommunities().catch(() => [])) {
        if (mailHeard.get(getDatabaseFilenameForNode(community)) === 0) continue;
        const left = end - Date.now();
        if (left < BACKGROUND_MIN_MS) break;
        await syncOutsideMailNow(left, community);
        ran++;
    }
    return ran;
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
