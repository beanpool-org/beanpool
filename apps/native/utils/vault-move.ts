/**
 * The move card (key vault design §5.1): a sign-in copy that a community still keeps goes to BeanPool's key vault,
 * with one sign-in, and then comes off the community.
 *
 * - The card shows when the community the phone is on has a copy for a sign-in and the vault has none for it (asked of
 *   each, `/api/recovery/shares/status` and `/v1/copies/status`), or when a sign-in the member tried to link while the
 *   vault was paused is still unlinked (§2.3: "saved and retried at the next app open").
 * - Moving is an ordinary connect (utils/sso-sheet-connect.ts): the phone seals the copy afresh from its own seed and
 *   words, so nothing is read from the old one, and deposits it at the vault. Only once the vault has it does the phone
 *   send a signed DELETE for that sign-in to the community. A delete that doesn't land is remembered on the phone and
 *   tried again each time the card looks, until it does. Only copies this phone moved are ever deleted.
 * - "Not now" is always there; the card comes back a week later, and never blocks anything.
 * - "Remove it instead" (PR #1336 review finding 7): a member who wants no copy anywhere can have the community's copy
 *   deleted without first depositing one at the vault. The same signed DELETE, remembered and tried again the same way
 *   when it doesn't land ({@link removeInstead}).
 *
 * Nothing sent to the community here carries a token, a copy or a nonce request: its status, and the delete.
 *
 * ## Both directions, by the community's rule (vault rethink VR2, design §5.2, §5.3)
 *
 * The card goes where the community the phone is on keeps copies now (utils/copies-rule.ts, kept answer; never heard:
 * this build's place, as before the rule):
 * - `vault`: the move above, community → vault, and a paused link offered again.
 * - `server`: the reverse ("keep it with my community instead"): a copy the vault keeps for a sign-in the community
 *   keeps none for. An ordinary connect, which the rule sends to the community, then the vault's copy for that sign-in
 *   is removed. No move to the vault is offered, and no paused link: the vault isn't this community's place.
 * - `none`: nothing to move to. Only the deletes waiting are tried again; a member's copies stay theirs, listed and
 *   removable on "Where your account can be brought back from".
 *
 * A move removes the old copy only once the new one is kept where the move meant it to go (the deposit's `keptAt`):
 * a rule changed between the card and the connect sends the copy elsewhere, and the old one then stays.
 *
 * "Where your account can be brought back from" (vault rethink VR1, design §5.1; utils/ways-back.ts) removes a community's
 * copy with the same delete and keeps the same list of deletes that didn't land, so either one's are tried again by the
 * other: when the card looks, when that screen opens, and at app open ({@link retryCommunityRemovals}). A delete it
 * remembers also remembers the community's `generation` when it was asked, and the other sign-ins it kept copies for
 * then: tried again, it goes only while nothing changed there since but removals of those others, so a copy the member
 * made there afterwards, from any device, is never the one deleted ({@link unchangedSince}). This phone's own deletes
 * there change the generation too (the node writes a new one for each that leaves another copy), whether their answers
 * reached the phone or not: each is the removal of one of those others, so a community keeping two copies loses both.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { BeanPoolIdentity } from './identity';
import type { KeeperEnrolmentResult } from './keeper-enrolment';
import { signedDelete, signedPost } from './node-post';
import { offeredProviders, type SsoProvider } from './sso-providers';
import { vaultMoveLaterStoreKey, vaultMoveUnfinishedStoreKey } from './storage-keys';
import { connectWanted, disconnectFromVault, hasVault, signInCopiesAt, vaultStatus, VaultError } from './vault';
import { knownCopiesRule } from './copies-rule';
import { sameCommunity } from './ways-back-state';
import { unopenableOf, type CommunityCopyUnopenable } from './community-copy-state';

export { sameCommunity };

/** How long "Not now" puts the card away (design §5.1: weekly until the date). */
export const MOVE_AGAIN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type VaultMoveOffer =
    /** The community keeps a copy for `provider` and the vault none: move it. */
    | { kind: 'move'; provider: SsoProvider; communityUrl: string }
    /** The member tried to link `provider` while the vault was paused: offer it again. */
    | { kind: 'retry'; provider: SsoProvider }
    /** The community keeps copies itself (its rule `server`), the vault keeps one for `provider` and it none: move it here. */
    | { kind: 'keep-here'; provider: SsoProvider; communityUrl: string };

/** The sign-ins this phone can sign in with (Apple on the iPhone only). */
function canSignInHere(provider: SsoProvider): boolean {
    return provider !== 'apple' || Platform.OS === 'ios';
}

/**
 * How long the community gets to answer the card's two questions. React Native's fetch never gives up by itself, and a
 * community that never answers would otherwise hold the card (and a paused link's offer) back for good (seen on the
 * emulator with no connection).
 */
export const COMMUNITY_TIMEOUT_MS = 15_000;

/** `p`, or null once `ms` has passed. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })])
        .finally(() => { if (timer) clearTimeout(timer); });
}

/** What the community at `url` keeps for this key: its sign-in copies, and the `generation` of its copies (null when unsaid). */
export interface CommunityCopyStatus {
    providers: SsoProvider[];
    generation: number | null;
    /**
     * The copy its admins can bring the member back from ("Your community's admins", vault rethink VR3; utils/
     * community-copy.ts), with since when: absent or null when it keeps none, as a server from before it always answers.
     */
    adminsCopy?: { since: string | null; placement?: 'whole' | 'shared'; copy?: string | null } | null;
    /**
     * A copy it keeps for its admins but can't open now (its key gone, or another: utils/community-copy-state.ts), so no
     * way back: listed, and removable, but never counted. Absent from a server from before it said so.
     */
    adminsCopyUnopenable?: CommunityCopyUnopenable | null;
    /** The key its vouchers are signed with, so this phone can tell which of the vault's community copies is this one's. */
    nodeKey?: string | null;
}

/**
 * The community's own answer about this key's copies, or null when it gave none in time: no answer, a refusal (not a
 * member there, a server that can't open its copies), or one that isn't a status. Null is "couldn't ask", never "none".
 */
export async function communityCopyStatus(identity: BeanPoolIdentity, url: string): Promise<CommunityCopyStatus | null> {
    try {
        const controller = new AbortController();
        const res = await within(signedPost(url, '/api/recovery/shares/status', {}, identity, controller.signal), COMMUNITY_TIMEOUT_MS);
        if (!res) {
            controller.abort();
            return null;
        }
        if (!res.ok) return null;
        const body = await within(res.json().catch(() => null), COMMUNITY_TIMEOUT_MS) as {
            enrolledSso?: unknown; generation?: unknown; communityCopy?: unknown; communityCopyUnopenable?: unknown; nodeKey?: unknown;
        } | null;
        if (!body || !Array.isArray(body.enrolledSso)) return null;
        const generation = typeof body.generation === 'number' && Number.isSafeInteger(body.generation) ? body.generation : null;
        const providers = [...new Set(offeredProviders(body.enrolledSso))];
        const nodeKey = isVaultKeyHex(body.nodeKey) ? { nodeKey: body.nodeKey } : {};
        const copy = body.communityCopy && typeof body.communityCopy === 'object' ? body.communityCopy as { since?: unknown; placement?: unknown; copy?: unknown } : null;
        if (copy) {
            const since = typeof copy.since === 'string' ? copy.since : null;
            const shared = copy.placement === 'shared' ? { placement: 'shared' as const, copy: typeof copy.copy === 'string' ? copy.copy : null } : {};
            return { providers, generation, ...nodeKey, adminsCopy: { since, ...shared } };
        }
        const unopenable = unopenableOf(body.communityCopyUnopenable);
        return unopenable ? { providers, generation, ...nodeKey, adminsCopyUnopenable: unopenable } : { providers, generation, ...nodeKey };
    } catch {
        return null;
    }
}

/** The sign-ins the community at `url` keeps a copy for, for this key. Empty when it can't say in time. */
export async function communityCopies(identity: BeanPoolIdentity, url: string): Promise<SsoProvider[]> {
    return (await communityCopyStatus(identity, url))?.providers ?? [];
}

/**
 * What a community did with a delete. `gone`: it removed the copy, or had none, in its own answer. `generation`: the
 * generation its copies of this key are at now, as its 2xx answer gives it (routes/keepers.ts: 0 once it keeps none);
 * null when it doesn't say, as a 404 doesn't.
 */
export interface CommunityDelete {
    gone: boolean;
    generation: number | null;
}

/**
 * Remove the community's copy for `provider`: a signed DELETE, and nothing else. Gone only on the node's own answer
 * (routes/keepers.ts): a 2xx whose JSON names the copy removed (`removed: provider`), or a 404 with its JSON `error` (it
 * has no copy for that sign-in: already gone). Any other answer is not gone, a 2xx included: a captive portal or proxy
 * on a plain `http://` address answers 200 with its own page, and a saved address may now point at another server
 * (utils/node-post.ts `purgeAccountOnNode` refuses the same for Delete account, #1303). Not gone either when the
 * community refused it or didn't answer in time. A delete not gone is tried again ({@link deleteOrRemember}).
 */
export async function removeCommunityCopy(identity: BeanPoolIdentity, url: string, provider: SsoProvider): Promise<CommunityDelete> {
    const notGone: CommunityDelete = { gone: false, generation: null };
    let res: Response | null;
    try {
        res = await within(signedDelete(url, `/api/recovery/shares/sso/${encodeURIComponent(provider)}`, identity), COMMUNITY_TIMEOUT_MS);
    } catch {
        return notGone;
    }
    if (!res || !(res.ok || res.status === 404)) return notGone;
    const body = await within(res.json().catch(() => null), COMMUNITY_TIMEOUT_MS) as { removed?: unknown; generation?: unknown; error?: unknown } | null;
    if (!body || typeof body !== 'object') return notGone;
    if (!res.ok) return typeof body.error === 'string' ? { gone: true, generation: null } : notGone;
    if (body.removed !== provider) return notGone;
    const generation = body.generation;
    return { gone: true, generation: typeof generation === 'number' && Number.isSafeInteger(generation) ? generation : null };
}

/**
 * Remove the copy the community at `url` keeps for its admins to bring the member back from ("Your community's admins",
 * vault rethink VR3): the signed DELETE utils/community-copy.ts sends. Gone only on the community's own answer
 * (routes/keepers.ts): a 2xx whose JSON says it keeps none now (`kept: false`), never a proxy's page. Not remembered when
 * it doesn't land: the member is told so, and tries again. Never throws.
 */
export async function removeAdminsCopy(identity: BeanPoolIdentity, url: string): Promise<boolean> {
    let res: Response | null;
    try {
        res = await within(signedDelete(url, '/api/recovery/community-copy', identity), COMMUNITY_TIMEOUT_MS);
    } catch {
        return false;
    }
    if (!res?.ok) return false;
    const body = await within(res.json().catch(() => null), COMMUNITY_TIMEOUT_MS) as { kept?: unknown } | null;
    return !!body && typeof body === 'object' && body.kept === false;
}

/**
 * What the card offers now, or null. Never throws, and a vault that can't say shows no card: the card is never shown
 * on a guess. First, deletes this phone sent that didn't land are tried again: only copies this phone moved or was
 * asked to remove. A copy the vault already has is not deleted from the community on that ground alone.
 */
export async function vaultMoveOffer(
    identity: BeanPoolIdentity, communityUrl: string | null, now: number = Date.now(),
): Promise<VaultMoveOffer | null> {
    if (!hasVault()) return null;
    // Where this community keeps copies now (the header's "Both directions"): never heard reads as this build's place.
    const place = signInCopiesAt(communityUrl ? await knownCopiesRule(communityUrl) : null);
    if (place === 'none') {
        await retryCommunityRemovals(identity);
        return null;
    }
    let atVault: SsoProvider[];
    try {
        atVault = (await vaultStatus(identity, 15_000)).providers;
    } catch {
        return null;
    }
    await retryCommunityRemovals(identity);
    if (place === 'community') {
        // Only on the community's own answer: one that couldn't say what it keeps may keep that sign-in already.
        const there = communityUrl ? await communityCopyStatus(identity, communityUrl) : null;
        if (!there || !communityUrl || await movedLaterRecently(identity, now)) return null;
        const keep = atVault.find(p => !there.providers.includes(p) && canSignInHere(p));
        return keep ? { kind: 'keep-here', provider: keep, communityUrl } : null;
    }
    const atCommunity = communityUrl ? await communityCopies(identity, communityUrl) : [];
    if (await movedLaterRecently(identity, now)) return null;
    // A copy the member asked to remove, whose delete hasn't landed yet, is never offered as one to move.
    const removing = await unfinishedMoves(identity);
    const move = atCommunity.find(p => !atVault.includes(p) && canSignInHere(p)
        && !removing.some(m => m.provider === p && sameCommunity(m.url, communityUrl as string)));
    if (move && communityUrl) return { kind: 'move', provider: move, communityUrl };
    const retry = (await connectWanted(identity.publicKey)).find(p => !atVault.includes(p) && canSignInHere(p));
    return retry ? { kind: 'retry', provider: retry } : null;
}

/** Whether "Not now" put the card away less than a week ago. */
async function movedLaterRecently(identity: BeanPoolIdentity, now: number): Promise<boolean> {
    const later = Number(await AsyncStorage.getItem(vaultMoveLaterStoreKey(identity.publicKey)).catch(() => null));
    return !!later && now - later < MOVE_AGAIN_AFTER_MS;
}

/** "Not now": the card comes back a week later. */
export async function moveLater(identity: BeanPoolIdentity, now: number = Date.now()): Promise<void> {
    await AsyncStorage.setItem(vaultMoveLaterStoreKey(identity.publicKey), String(now)).catch(() => {});
}

interface UnfinishedMove {
    url: string;
    provider: SsoProvider;
    /**
     * The community's `generation` when the member asked (utils/ways-back.ts), and `others`, the other sign-ins it kept
     * copies for at that generation (absent: none). Tried again, the delete goes only while nothing changed there since
     * but removals of those others ({@link unchangedSince}). Absent on the card's own deletes, which are tried again as
     * they always were.
     */
    generation?: number;
    others?: SsoProvider[];
}

/** A delete that hasn't landed yet: which community, and which sign-in's copy there. */
export interface PendingRemoval {
    url: string;
    provider: SsoProvider;
}

const sameRemoval = (a: PendingRemoval, b: PendingRemoval) => a.provider === b.provider && sameCommunity(a.url, b.url);

async function unfinishedMoves(identity: BeanPoolIdentity): Promise<UnfinishedMove[]> {
    try {
        const raw = await AsyncStorage.getItem(vaultMoveUnfinishedStoreKey(identity.publicKey));
        const list = raw ? JSON.parse(raw) as unknown : [];
        return Array.isArray(list)
            ? list.filter((m): m is UnfinishedMove => !!m && typeof m.url === 'string' && offeredProviders([m.provider]).length === 1
                && (m.generation === undefined || Number.isSafeInteger(m.generation))
                && (m.others === undefined || (Array.isArray(m.others) && offeredProviders(m.others).length === m.others.length)))
            : [];
    } catch {
        return [];
    }
}

async function keepUnfinishedMoves(identity: BeanPoolIdentity, moves: UnfinishedMove[]): Promise<void> {
    const key = vaultMoveUnfinishedStoreKey(identity.publicKey);
    await (moves.length ? AsyncStorage.setItem(key, JSON.stringify(moves)) : AsyncStorage.removeItem(key)).catch(() => {});
}

/**
 * Every change to the list, one at a time. A retry takes seconds per community, and writes its answer only to the
 * entries it tried, so a delete remembered meanwhile (Remove everything while the app-open retry runs) is kept.
 */
let listTurn: Promise<unknown> = Promise.resolve();
function changeList<T>(change: () => Promise<T>): Promise<T> {
    const turn = listTurn.then(change, change);
    listTurn = turn.catch(() => {});
    return turn;
}

/** The deletes this phone was asked for that haven't landed yet, of `identity`'s copies. */
export async function pendingCommunityRemovals(identity: BeanPoolIdentity): Promise<PendingRemoval[]> {
    return (await unfinishedMoves(identity)).map(({ url, provider }) => ({ url, provider }));
}

/**
 * A waiting delete, as it would be asked for now: `seen` is the community's copies when the member asked (its status, or
 * that as this phone's own deletes since moved it). With no generation said, the delete goes unguarded.
 */
function waitingDelete(url: string, provider: SsoProvider, seen: CommunityCopyStatus | null): UnfinishedMove {
    if (!seen || seen.generation === null) return { url, provider };
    const others = seen.providers.filter(p => p !== provider);
    return others.length ? { url, provider, generation: seen.generation, others } : { url, provider, generation: seen.generation };
}

/**
 * This phone's own delete of `removed` at `url` landed, and the community's answer put its copies at `generation`: a
 * delete waiting there that counts at the generation just before counts at this one, without `removed` among its others.
 * A generation only goes up, one for each change (routes/keepers.ts; after a delete of every copy, it goes on from the
 * one deleted), so the copies were at that one when this delete reached them, and this delete was the only change.
 * Any other generation, or none said, moves nothing: the guard then counts what is gone ({@link unchangedSince}).
 */
function carried(m: UnfinishedMove, url: string, removed: SsoProvider, generation: number | null): UnfinishedMove {
    if (generation === null || generation < 1 || m.generation !== generation - 1 || !sameCommunity(m.url, url)) return m;
    return waitingDelete(m.url, m.provider, { providers: [m.provider, ...(m.others ?? []).filter(p => p !== removed)], generation });
}

/**
 * Whether a waiting delete may still go, by the community's copies now (`there`, which lists its sign-in): nothing
 * changed there since the member asked but removals of the others it kept copies for then. A generation only goes up,
 * one for each change (routes/keepers.ts), and a removal leaves every other copy as it was stored, so the generation is
 * then the member's plus one for each of those others no longer listed. Judged by what is gone, not by which answers
 * this phone read: a delete of its own that landed while its answer was lost (a timeout, a dropped connection) moves the
 * generation as one whose answer came. A copy linked there, or linked again, from any device, moves it with nothing
 * gone, so the delete is dropped: the copy may be a newer one, which the member's list then shows as kept.
 */
function unchangedSince(m: UnfinishedMove, there: CommunityCopyStatus): boolean {
    const gone = (m.others ?? []).filter(p => !there.providers.includes(p)).length;
    return m.generation !== undefined && there.generation === m.generation + gone;
}

/** A retry under way, per account: asked again meanwhile (app open and the screen at once), the ask joins it. */
const retrying = new Map<string, Promise<void>>();

/**
 * Deletes that didn't land: tried again, and kept until each lands. Only ones this phone moved or was asked to remove.
 * One remembered with the community's generation is asked about first: gone already, it is done; the community's copies
 * changed since in any way but the removal of others listed then ({@link unchangedSince}: a sign-in linked there, or
 * linked again, from any device), it is dropped and nothing is deleted, as the copy may be a newer one, which the
 * member's list then shows as kept; the community can't say, it waits. Each community is asked once, all of them at
 * once, so one that doesn't answer holds the rest up no longer than its own wait. One pass at a time per account, so no
 * delete is sent twice at once. Never throws.
 */
export function retryCommunityRemovals(identity: BeanPoolIdentity): Promise<void> {
    const running = retrying.get(identity.publicKey);
    if (running) return running;
    const pass = retryPass(identity).finally(() => retrying.delete(identity.publicKey));
    retrying.set(identity.publicKey, pass);
    return pass;
}

async function retryPass(identity: BeanPoolIdentity): Promise<void> {
    const moves = await unfinishedMoves(identity);
    if (!moves.length) return;
    const byCommunity: UnfinishedMove[][] = [];
    for (const m of moves) {
        const there = byCommunity.find(w => sameCommunity(w[0].url, m.url));
        if (there) there.push(m);
        else byCommunity.push([m]);
    }
    const changed = (await Promise.all(byCommunity.map(w => retryAt(identity, w)))).flat().filter(r => r.now !== r.was);
    if (!changed.length) return;
    await changeList(async () => {
        const list = await unfinishedMoves(identity);
        const left: UnfinishedMove[] = [];
        for (const m of list) {
            // Only the entries this pass tried, as it read them: one written meanwhile stays as it is.
            const r = changed.find(c => sameRemoval(c.was, m) && c.was.generation === m.generation);
            if (!r) left.push(m);
            else if (r.now) left.push(r.now);
        }
        await keepUnfinishedMoves(identity, left);
    });
}

/** What a retry did with one waiting delete: done (`now` null), or still waiting, as it counts now. */
interface Retried {
    was: UnfinishedMove;
    now: UnfinishedMove | null;
}

/**
 * One community's waiting deletes, in turn. Its copies are asked about once, when one of them is guarded; after that
 * this pass follows them by its own deletes' answers. Each delete that lands moves the others on ({@link carried}); one
 * whose answer doesn't say the generation leaves the guarded ones waiting for the next pass.
 */
async function retryAt(identity: BeanPoolIdentity, waiting: UnfinishedMove[]): Promise<Retried[]> {
    const url = waiting[0].url;
    const counted: (UnfinishedMove | null)[] = [...waiting];
    let there = waiting.some(m => m.generation !== undefined) ? await communityCopyStatus(identity, url) : null;
    for (let i = 0; i < counted.length; i++) {
        const m = counted[i]!;
        if (m.generation !== undefined) {
            if (!there) continue;
            if (!there.providers.includes(m.provider)) {
                counted[i] = null;
                continue;
            }
            if (!unchangedSince(m, there)) {
                console.log(`[VAULT] a remembered delete of a ${m.provider} copy was dropped: that community's copies changed since it was asked`);
                counted[i] = null;
                continue;
            }
        }
        const d = await removeCommunityCopy(identity, m.url, m.provider);
        if (!d.gone) continue;
        counted[i] = null;
        for (let j = 0; j < counted.length; j++) {
            const o = counted[j];
            if (o) counted[j] = carried(o, url, m.provider, d.generation);
        }
        there = there && d.generation !== null
            ? { providers: d.generation === 0 ? [] : there.providers.filter(p => p !== m.provider), generation: d.generation }
            : null;
    }
    return waiting.map((was, i) => ({ was, now: counted[i] }));
}

/** What finishing a move did with the old copy: removed, left (the new copy isn't where the move meant), or not yet. */
export type MoveFinish = 'removed' | 'kept' | 'not-yet';

/**
 * After the connect: the old copy goes, but only once the new one is kept where the move meant (`result.keptAt`; the
 * header's "Both directions"). A move to the vault removes the community's copy with a signed DELETE, remembered and
 * tried again when it doesn't land ({@link vaultMoveOffer}); a move here removes the vault's copy for that sign-in. A
 * deposit that went elsewhere, as a rule changed meanwhile sends it, leaves the old copy: two copies, never none.
 */
export async function finishMove(identity: BeanPoolIdentity, offer: VaultMoveOffer, result?: KeeperEnrolmentResult | null): Promise<MoveFinish> {
    if (offer.kind === 'move') {
        if (result && result.keptAt !== 'vault') return 'kept';
        return (await deleteOrRemember(identity, offer.communityUrl, offer.provider)).gone ? 'removed' : 'not-yet';
    }
    if (offer.kind === 'keep-here') {
        if (!result || result.keptAt !== 'community') return 'kept';
        return (await removeVaultCopy(identity, offer.provider)) ? 'removed' : 'not-yet';
    }
    return 'kept';
}

/** The vault's copies for `provider` go (its signed `deleted`); false when the vault couldn't do it now. Never throws. */
async function removeVaultCopy(identity: BeanPoolIdentity, provider: SsoProvider): Promise<boolean> {
    try {
        await disconnectFromVault(identity, provider);
        return true;
    } catch (e) {
        if (!(e instanceof VaultError)) console.log(`[VAULT] the vault's ${provider} copy was not removed: ${(e as Error).message}`);
        return false;
    }
}

/**
 * "Remove it instead": the old copy for `provider` goes and nothing is deposited anywhere. For a move to the vault, the
 * community's copy, with the signed DELETE, remembered and tried again when the card next looks; for a move here, the
 * vault's copy. The member's choice: afterwards that sign-in brings the account back from there no more until it is
 * linked again. True once it is gone.
 */
export async function removeInstead(identity: BeanPoolIdentity, offer: VaultMoveOffer): Promise<boolean> {
    if (offer.kind === 'keep-here') return removeVaultCopy(identity, offer.provider);
    if (offer.kind !== 'move') return false;
    return (await deleteOrRemember(identity, offer.communityUrl, offer.provider)).gone;
}

/**
 * The community's copy for `provider` goes now, or is remembered and tried again ({@link retryCommunityRemovals}). With
 * `seen` (the community's copies, as the member saw them: its generation and every sign-in listed), a retry deletes only
 * while nothing changed there since but removals of those others ({@link unchangedSince}). Gone, with the generation the
 * community's answer gives; or not gone, and remembered: not yet removed.
 */
export async function deleteOrRemember(
    identity: BeanPoolIdentity, url: string, provider: SsoProvider, seen: CommunityCopyStatus | null = null,
): Promise<CommunityDelete> {
    const d = await removeCommunityCopy(identity, url, provider);
    if (d.gone) {
        // Gone: a delete of it that was waiting is done too, and the others waiting there move on with it ({@link carried}).
        await changeList(async () => {
            const list = await unfinishedMoves(identity);
            const left = list.filter(m => !sameRemoval(m, { url, provider })).map(m => carried(m, url, provider, d.generation));
            if (left.length !== list.length || left.some(m => !list.includes(m))) await keepUnfinishedMoves(identity, left);
        });
        return d;
    }
    await changeList(async () => {
        const list = await unfinishedMoves(identity);
        const was = list.find(m => sameRemoval(m, { url, provider }));
        const entry = waitingDelete(url, provider, seen);
        // The card's own delete of the same copy, already waiting, stays as it was; otherwise this one, with its generation.
        if (was && (was.generation === undefined || entry.generation === undefined)) return;
        await keepUnfinishedMoves(identity, [...list.filter(m => !sameRemoval(m, entry)), entry]);
    });
    return d;
}
