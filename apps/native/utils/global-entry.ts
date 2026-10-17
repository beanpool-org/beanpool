/**
 * The phone's one rule for the global community (DESIGN-global-entry-fable.md §B.2): what to offer the account on this
 * phone there, decided from what the global community ITSELF last answered about this key (the membership probe,
 * utils/membership-probe.ts), never from the phone's saved list.
 *
 * Why not the list: a community lands in the list whenever the phone is anchored to it (nodes.ts' auto-migration), and
 * the not-recognised screen's Reconnect used to anchor before it asked. One wrong tap made "global is in the list and not
 * marked a guest", which the old rule (`globalStandingOnPhone`) read as "member", and every door went away (Damo, 17 Oct
 * 2026, §1). The list now says only whether the phone has a row for it (`saved`, for the row's shape in the BeanPool
 * sheet), never whether it belongs.
 *
 * Settings → Advanced, People's guest banner, the BeanPool sheet and the not-recognised screen all read this one
 * function (use-global-entry.ts is their hook). No-domain-lock-in: every state but `member` and `join` is "the global
 * community isn't available from here right now, and everything else is as before"; nothing else on the phone waits on
 * it or asks it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { GLOBAL_NODE_URL } from './global-node-url';
import { membershipAnswerOf } from './membership-answer';
import type { GlobalDoorCheck } from './node-profile';

/** What the global community last answered about THIS key: `unknown` until asked, or when the answer is over a day old. */
export type GlobalStanding = 'member' | 'stranger' | 'unknown';

/** The door check (node-profile.ts checkGlobalDoor), as the entry reads it. `unknown`: not asked yet this app start. */
export type GlobalDoorState = 'open' | 'closed' | 'preview' | 'unreachable' | 'unknown';

/**
 * What the phone offers the account for the global community:
 * - `member`: it is a member there (its row is the community's row: switch to it); no door.
 * - `join`: the door is open and the key is not a member, or the probe couldn't say and the door's own check will (the
 *   door answers `already_member` for a member, who simply lands in the global community).
 * - `checking`: the key's standing is being asked, or the door hasn't been asked yet: a moment, drawn as "Checking…".
 * - `unreachable`, `closed`, `preview`: the door can't be used right now (no answer; not taking new members; a private
 *   preview). Unavailable, and everything else as before.
 * - `closedAccount`: the global community closed this key's account (it answered `account_closed`): nothing to offer.
 * - `noAccount`: the phone holds no key: the first screen's door for a new phone, not this one.
 */
export type GlobalEntryState =
    | 'member' | 'join' | 'checking' | 'unreachable' | 'closed' | 'preview' | 'closedAccount' | 'noAccount';

export interface GlobalEntryInput {
    /** The phone holds a key. */
    account: boolean;
    /** What the global community last answered about this key (readGlobalStanding / askGlobalStanding). */
    standing: GlobalStanding;
    /** The door check. */
    door: GlobalDoorState;
    /** The global community answered `account_closed` for this key (global-join-existing.ts rememberAccountClosed). */
    closedHere: boolean;
    /** The global community is in the phone's saved list: for the row's shape only, NEVER for the state. */
    saved: boolean;
    /** A probe for this key's standing is out now. */
    asking?: boolean;
}

/** The one rule. Pure: the same input, the same answer, on every screen. `saved` never changes it. */
export function globalEntryState(input: GlobalEntryInput): GlobalEntryState {
    if (!input.account) return 'noAccount';
    if (input.closedHere) return 'closedAccount';
    if (input.standing === 'member') return 'member';
    // Not known to be a member: a stranger, or the probe hasn't said. While it is asking, wait a moment rather than offer
    // a member the door (it would only flash up); once it has failed, the door's own check decides.
    if (input.standing === 'unknown' && input.asking) return 'checking';
    switch (input.door) {
        case 'open': return 'join';
        case 'closed': return 'closed';
        case 'preview': return 'preview';
        case 'unreachable': return 'unreachable';
        default: return 'checking';
    }
}

/** The door check's answer as the entry reads it. Null (not asked) is `unknown`. A node that isn't the global one is shut. */
export function doorStateFromCheck(check: GlobalDoorCheck | null | undefined): GlobalDoorState {
    if (!check) return 'unknown';
    if (check.ok) return 'open';
    switch (check.reason) {
        case 'unreachable': return 'unreachable';
        case 'private_preview': return 'preview';
        // `not_global`: whatever answers at the address isn't the global community. Never a door the phone opens.
        default: return 'closed';
    }
}

// ── The probe's answer, kept per key ─────────────────────────────────────────────────────────────────────────────

export const GLOBAL_STANDING_STORE_KEY = 'beanpool_global_standing';
/** An answer older than this is `unknown` again: membership can change (a removal, a join on another device). */
export const GLOBAL_STANDING_TTL_MS = 24 * 60 * 60 * 1000;

interface KeptStanding { standing: 'member' | 'stranger'; at: number }

async function readKept(): Promise<Record<string, KeptStanding>> {
    try {
        const parsed = JSON.parse((await AsyncStorage.getItem(GLOBAL_STANDING_STORE_KEY)) ?? '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** A kept answer, if it is one and under a day old. Pure. */
export function freshStanding(kept: unknown, nowMs: number): GlobalStanding {
    if (!kept || typeof kept !== 'object') return 'unknown';
    const k = kept as Partial<KeptStanding>;
    if (k.standing !== 'member' && k.standing !== 'stranger') return 'unknown';
    if (typeof k.at !== 'number' || !Number.isFinite(k.at)) return 'unknown';
    const age = nowMs - k.at;
    return age >= 0 && age < GLOBAL_STANDING_TTL_MS ? k.standing : 'unknown';
}

/** What the global community last answered about `publicKey` on this phone, under a day ago. No network. Never throws. */
export async function readGlobalStanding(publicKey: string | null | undefined, nowMs: number = Date.now()): Promise<GlobalStanding> {
    if (!publicKey) return 'unknown';
    return freshStanding((await readKept())[publicKey], nowMs);
}

async function keepStanding(publicKey: string, standing: 'member' | 'stranger', nowMs: number): Promise<void> {
    try {
        const all = await readKept();
        all[publicKey] = { standing, at: nowMs };
        await AsyncStorage.setItem(GLOBAL_STANDING_STORE_KEY, JSON.stringify(all));
    } catch {
        // Not kept: asked again next time. Nothing depends on it but the offer.
    }
}

/** What the global community said, this time. */
export interface AskedStanding {
    standing: GlobalStanding;
    /** It answered `account_closed` for this key (kept: global-join-existing.ts rememberAccountClosed). */
    closed: boolean;
    /** It gave a definite answer this time (false: no answer, and `standing` is the kept one). */
    answered: boolean;
}

export interface AskDeps {
    probe(community: string, key: { publicKey: string; privateKey: string }, signal?: AbortSignal): Promise<Response>;
    rememberClosed(publicKey: string): Promise<void>;
    now(): number;
}

async function defaultAskDeps(): Promise<AskDeps> {
    // Loaded when used: the probe signs (crypto), and the closed list lives with the door (global-join-existing.ts).
    const { fetchMembership } = await import('./membership-probe');
    const { rememberAccountClosed } = await import('./global-join-existing');
    return { probe: fetchMembership, rememberClosed: rememberAccountClosed, now: Date.now };
}

const ASK_TIMEOUT_MS = 6_000;

/**
 * Ask the global community about this key (signed by it: the probe answers only its own key), and keep the answer. A
 * member or stranger answer is kept for a day; `account_closed` is remembered for good (it can't change from the phone);
 * any other failure leaves the kept answer as it was. Never throws.
 */
export async function askGlobalStanding(
    identity: { publicKey: string; privateKey: string },
    injected?: Partial<AskDeps>,
    community: string = GLOBAL_NODE_URL,
): Promise<AskedStanding> {
    const base = injected?.probe && injected?.rememberClosed ? null : await defaultAskDeps();
    const probe = injected?.probe ?? base!.probe;
    const rememberClosed = injected?.rememberClosed ?? base!.rememberClosed;
    const now = injected?.now ?? Date.now;
    const kept = async (): Promise<AskedStanding> => ({ standing: await readGlobalStanding(identity.publicKey, now()), closed: false, answered: false });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    try {
        const res = await probe(community, identity, controller.signal);
        const answer = await membershipAnswerOf(res);
        if (!answer) return await kept();
        if (answer.kind === 'closed') {
            await rememberClosed(identity.publicKey).catch(() => {});
            return { standing: 'unknown', closed: true, answered: true };
        }
        const standing = answer.kind === 'member' ? 'member' : 'stranger';
        await keepStanding(identity.publicKey, standing, now());
        return { standing, closed: false, answered: true };
    } catch {
        return await kept();
    } finally {
        clearTimeout(timer);
    }
}
