/**
 * "Member here" (addresses S5 round 2, PR #3251's deciding review): this phone holds an ACCOUNT key that is a member of
 * that community. Never merely a record of it with a key: a guest visit's record gets its key from the first proved round
 * at its address (address-verify.ts), the same as a member's, and a guest told "You are already a member" lost Ask to join,
 * the waiting request and Join.
 *
 * So the community itself is asked (the membership probe, signed by the phone's key: membership-probe.ts), and only its
 * definite "a member" counts. A guest visit (nodes.ts markGuestNode, at any address the record holds) is not, and is not
 * asked; a phone with no key (a visitor looking around) is not; a closed or removed account, a stranger and no answer at
 * all are not. Each of those keeps the knock's own doors: Ask to join, the waiting request, Join (utils/knock.ts).
 * No answer is the safe side here: a knock from a member is answered "You are already a member" by the community itself.
 *
 * Read by Find a community's rows (app/find-community.tsx) and a community's card (app/community-card.tsx).
 */
import { membershipAnswerOf, type MembershipAnswer } from './membership-answer';
import type { directoryRowCommunity } from './community-index';

/** What the phone knows about itself at one community. */
export interface MemberHereFacts {
    /** The phone holds a key to sign the ask with. */
    hasKey: boolean;
    /** The phone marked this community a guest visit, at any address its record holds. */
    guest: boolean;
    /** The community's own answer, signed by the key; null for none (not asked, no answer, an answer that says nothing). */
    answer: MembershipAnswer | null;
}

/** Member here: a key, no guest visit, and the community's own "a member". Pure. */
export function memberHere(f: MemberHereFacts): boolean {
    return f.hasKey && !f.guest && f.answer?.kind === 'member';
}

export interface MemberHereDeps {
    isGuestNode(url: string): Promise<boolean>;
    probe(url: string, key: { publicKey: string; privateKey: string }, signal: AbortSignal): Promise<Response>;
}

const ASK_TIMEOUT_MS = 8_000;

async function defaultDeps(): Promise<MemberHereDeps> {
    const [{ isGuestNode }, { fetchMembership }] = await Promise.all([import('./nodes'), import('./membership-probe')]);
    return { isGuestNode, probe: fetchMembership };
}

/**
 * Whether this phone is a member of the community at `community.using` (its other addresses: `community.addresses`), asked
 * of the community itself with `key`. Never throws: anything that goes wrong is "not a member here".
 */
export async function askMemberHere(
    community: { using: string; addresses: readonly string[] },
    key: { publicKey: string; privateKey?: string } | null | undefined,
    injected?: MemberHereDeps,
): Promise<boolean> {
    if (!key?.publicKey || !key.privateKey) return false;
    const signer = { publicKey: key.publicKey, privateKey: key.privateKey };
    try {
        const deps = injected ?? await defaultDeps();
        for (const address of new Set([community.using, ...community.addresses])) {
            if (await deps.isGuestNode(address).catch(() => false)) return false;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
        let answer: MembershipAnswer | null;
        try {
            answer = await membershipAnswerOf(await deps.probe(community.using, signer, controller.signal));
        } catch {
            answer = null;
        } finally {
            clearTimeout(timer);
        }
        return memberHere({ hasKey: true, guest: false, answer });
    } catch {
        return false;
    }
}

/** What a directory row offers (§3.6): the community this phone is a member of opens (or, in front, says so); any other row knocks. */
export type DirectoryRowDoor =
    | { kind: 'open'; using: string; askList: boolean }
    | { kind: 'in-front' }
    | { kind: 'knock' };

/**
 * A directory row's door: one of this phone's communities (`mine`: community-index.ts directoryRowCommunity) where it is a
 * member (`member`: askMemberHere; undefined while it is asked) opens it, or in front says so; every other row, a guest's,
 * a visitor's, a removed account's, and one still being asked, keeps the knock (Ask to join, the waiting request, Join).
 */
export function directoryRowDoor(mine: ReturnType<typeof directoryRowCommunity>, member: boolean | undefined): DirectoryRowDoor {
    if (!mine || member !== true) return { kind: 'knock' };
    return mine.inFront ? { kind: 'in-front' } : { kind: 'open', using: mine.using, askList: mine.askList };
}
