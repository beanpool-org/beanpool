/**
 * Following a community to where it lives now (scratch/global-node/DESIGN-https-anywhere-fable.md §3, D4; slice S3).
 *
 * A phone keeps one address for its community (`beanpool_anchor_url`), and every request it signs is bound to that
 * address's host. When the community says it lives somewhere else now (`primaryAddress` in GET /api/community/info, one
 * of its own `addresses`: a name taken after a start at the server's number, or a new name), the phone offers to move:
 * one card on Home (components/AddressFollowCard.tsx), "This community is also at beans.example.org. Use that address
 * from now on?". Never silently: nothing here writes the phone's community but acceptAddressFollow, which runs only when
 * the member taps. "Not now" asks again in 7 days.
 *
 * Only to the same community. Every node serves a statement of who it is, signed with its node key (GET
 * /api/node/identity-epoch, apps/server services/identity-epoch.ts: its PeerId, its community id and how many take-overs
 * it has had). The phone checks each statement's signature against the key its PeerId names, and offers the move only
 * when the new address names the same PeerId and community as the phone's own community does, and is not an older server
 * of it (a lower take-over count: a replaced main server started again). An address that leads to another server, one
 * that doesn't answer, or an answer that isn't signed so, offers nothing. The statement is public, so this tells a wrong
 * or stale address from the community's own; it is not a proof that whoever answers holds the key.
 *
 * What the phone first verified at its own address is kept (COMMUNITY_IDENTITY_KEY, per address; asked once a run while
 * nothing is kept, a small public read), and is what a new address is checked against: so a community whose number has
 * stopped answering can still be followed to a name the phone had heard of, and a number that now answers as some other
 * community (a server's number given to someone else) offers nothing at all. A number the phone never heard another
 * address for can't be followed: the member types the new address or scans a new QR.
 *
 * Never from an http address (whoever is in the middle of a home network could name both the address and the identity),
 * never from the worldwide community (the app knows it by its one address, utils/global-node-url.ts), never from a name
 * to a number (a name survives a change of server and a number doesn't, D3), and only to an address communityOrigin
 * takes (https, a host name or a public IPv4 address). The move is the existing switch (utils/reconnect.ts switchPhoneTo:
 * the community's own database, the address, then communitySwitched), so the host signatures are bound to changes only
 * there.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { audienceOf, ed25519KeyOfPeerId } from '@beanpool/core';
import { communityOrigin } from './community-origin';
import { GLOBAL_NODE_URL } from './global-node-url';
import { isPlainNodeAddress, plainOriginOf } from './node-url';
import type { NodeProfile } from './node-profile';
import type { SavedNode } from './nodes';

/** Where a node serves its signed statement (apps/server services/identity-epoch.ts IDENTITY_EPOCH_PATH). */
export const IDENTITY_STATEMENT_PATH = '/api/node/identity-epoch';
/** What the node key signs in front of the statement (apps/server services/identity-epoch.ts DOMAIN). */
const STATEMENT_DOMAIN = 'beanpool-identity-epoch-v1\n';
/** "Not now" asks again after this long. */
export const FOLLOW_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
/** `{ [the address followed from]: { to, until } }`: the offers declined, until when. */
export const FOLLOW_SNOOZE_KEY = 'beanpool_address_follow_snooze';
/** `{ [an address, as an origin]: CommunityIdentity }`: who this phone first verified each of its communities' addresses to be. */
export const COMMUNITY_IDENTITY_KEY = 'beanpool_community_identity';
const STATEMENT_TIMEOUT_MS = 8_000;
/** How long an offer's check is reused before Home asks the two servers again. */
const VERDICT_TTL_MS = 60 * 60 * 1000;
const MAX_KEPT = 50;

/** Who a node says it is, from a statement signed with its node key. */
export interface CommunityIdentity {
    peerId: string;
    communityId: string;
    /** Take-overs so far: a promoted standby is one higher than the server it replaced. */
    epoch: number;
}

export interface AddressFollowOffer {
    /** The phone's community's address now, as an origin. */
    from: string;
    /** Where the community says it lives now, as an origin. */
    to: string;
    /** `to`'s host (and port), for the card's sentence. */
    host: string;
}

const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** The phone's community address as an origin a move may start from: plain, https, not the worldwide community's. */
function followableOrigin(anchor: string | null | undefined): string | null {
    const from = anchor && isPlainNodeAddress(anchor.trim()) ? plainOriginOf(anchor.trim()) : null;
    if (!from || !from.startsWith('https://')) return null;
    const here = audienceOf(from);
    return here && here !== audienceOf(GLOBAL_NODE_URL) ? from : null;
}

/**
 * The move to offer, from the phone's community address and what that community last said of its own addresses, or null.
 * Pure: no network, no storage. Null unless `primaryAddress` is one of `addresses`, the phone's address is https and not
 * the worldwide community's, the new one is an address communityOrigin takes on another host, and it isn't a number
 * replacing a name.
 */
export function followCandidate(
    anchor: string | null | undefined, profile: Pick<NodeProfile, 'addresses' | 'primaryAddress'> | null | undefined,
): AddressFollowOffer | null {
    const primary = profile?.primaryAddress;
    if (!primary || !profile?.addresses?.includes(primary)) return null;
    const from = followableOrigin(anchor);
    const here = from ? audienceOf(from) : null;
    if (!from || !here) return null;
    const to = communityOrigin(`https://${primary}`);
    const there = to && isPlainNodeAddress(to) ? audienceOf(to) : null;
    if (!to || !there || there === here) return null;
    if (IPV4_HOST.test(there) && !IPV4_HOST.test(here)) return null;
    return { from, to, host: to.slice('https://'.length) };
}

function base64Bytes(b64: string): Uint8Array {
    const bin = globalThis.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * The identity in a node's statement (`{ statement: { v, peerId, communityId, epoch, since }, sig }`), only when `sig` is
 * the node key's Ed25519 signature (strict RFC 8032, as every verifier here) over the statement's bytes, the key being
 * the one its PeerId names. A node with no community id yet names no community. Null for anything else.
 */
export function readIdentityStatement(body: unknown): CommunityIdentity | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as { statement?: unknown; sig?: unknown };
    const s = b.statement as Record<string, unknown> | null | undefined;
    // An Ed25519 signature is 64 bytes: 86 base64 characters and its padding, as the server writes it.
    if (typeof b.sig !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(b.sig) || !s || typeof s !== 'object') return null;
    if (s.v !== 1 || typeof s.peerId !== 'string' || typeof s.communityId !== 'string' || !s.communityId
        || !Number.isSafeInteger(s.epoch) || (s.epoch as number) < 0 || !(s.since === null || typeof s.since === 'string')) return null;
    const key = ed25519KeyOfPeerId(s.peerId);
    if (!key) return null;
    // The server's canonical bytes (services/identity-epoch.ts `canonical`): its domain, then these five in this order.
    const bytes = new TextEncoder().encode(STATEMENT_DOMAIN + JSON.stringify({
        v: s.v, peerId: s.peerId, communityId: s.communityId, epoch: s.epoch, since: s.since,
    }));
    let valid = false;
    try {
        valid = ed25519.verify(base64Bytes(b.sig), bytes, key, { zip215: false });
    } catch {
        valid = false;
    }
    return valid ? { peerId: s.peerId, communityId: s.communityId, epoch: s.epoch as number } : null;
}

/** One community: the same node key and the same community id. */
function sameIdentity(a: CommunityIdentity, b: CommunityIdentity): boolean {
    return a.peerId === b.peerId && a.communityId === b.communityId;
}

/** Whether `there` is the community `here` is, and not an older server of it (fewer take-overs). */
export function sameCommunity(here: CommunityIdentity, there: CommunityIdentity): boolean {
    return sameIdentity(here, there) && there.epoch >= here.epoch;
}

export interface AddressFollowDeps {
    /** The phone's community address, as stored. */
    anchor(): Promise<string | null>;
    /** What the phone knows of `url`'s community: its copy when fresh, else asked. */
    profile(url: string): Promise<NodeProfile | null>;
    /** The signed statement at `origin`, verified, or null (no answer, or not one). */
    statement(origin: string): Promise<CommunityIdentity | null>;
    now(): number;
    /** Make `url` the phone's community (utils/reconnect.ts switchPhoneTo). */
    switchTo(url: string): Promise<void>;
    savedNodes(): Promise<SavedNode[]>;
    addSavedNode(url: string, alias?: string, currencyType?: 'text' | 'image', currencyValue?: string): Promise<void>;
    removeSavedNode(url: string): Promise<void>;
    isGuestNode(url: string): Promise<boolean>;
    markGuestNode(url: string): Promise<void>;
}

/** GET `origin`'s statement, verified. Null for no answer in 8 s, an error answer, or anything that isn't a signed statement. */
export async function fetchIdentityStatement(origin: string, fetchImpl: typeof fetch = fetch): Promise<CommunityIdentity | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STATEMENT_TIMEOUT_MS);
    try {
        const res = await fetchImpl(`${origin}${IDENTITY_STATEMENT_PATH}`, {
            method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal,
        });
        if (!res.ok) return null;
        return readIdentityStatement(await res.json().catch(() => null));
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function defaultDeps(): Promise<AddressFollowDeps> {
    const [profiles, nodes, { switchPhoneTo }, { anchorUrl }] = await Promise.all([
        import('./node-profile'), import('./nodes'), import('./reconnect'), import('./node-post'),
    ]);
    return {
        anchor: anchorUrl,
        profile: async (url) => {
            const held = await profiles.getCachedNodeProfile(url);
            if (profiles.nodeProfileIsFresh(held)) return held;
            return (await profiles.fetchNodeProfile(url)) ?? held;
        },
        statement: (origin) => fetchIdentityStatement(origin),
        now: () => Date.now(),
        switchTo: switchPhoneTo,
        savedNodes: nodes.getSavedNodes,
        addSavedNode: nodes.addSavedNode,
        removeSavedNode: nodes.removeSavedNode,
        isGuestNode: nodes.isGuestNode,
        markGuestNode: nodes.markGuestNode,
    };
}

async function depsWith(injected?: Partial<AddressFollowDeps>): Promise<AddressFollowDeps> {
    const keys: (keyof AddressFollowDeps)[] = [
        'anchor', 'profile', 'statement', 'now', 'switchTo', 'savedNodes', 'addSavedNode', 'removeSavedNode', 'isGuestNode', 'markGuestNode',
    ];
    return keys.every(k => injected?.[k]) ? injected as AddressFollowDeps : { ...(await defaultDeps()), ...injected };
}

async function readMap<T>(key: string): Promise<Record<string, T>> {
    try {
        const raw = await AsyncStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** Writes `map` with `id` set (or removed, for undefined), keeping the newest MAX_KEPT. Never throws. */
async function writeEntry<T>(key: string, id: string, value: T | undefined): Promise<void> {
    try {
        const map = await readMap<T>(key);
        delete map[id];
        if (value !== undefined) map[id] = value;
        const ids = Object.keys(map);
        for (const old of ids.slice(0, Math.max(0, ids.length - MAX_KEPT))) delete map[old];
        await AsyncStorage.setItem(key, JSON.stringify(map));
    } catch {
        // Not kept: the offer is checked afresh next time.
    }
}

function readKeptIdentity(v: unknown): CommunityIdentity | null {
    const k = v as Partial<CommunityIdentity> | null | undefined;
    return k && typeof k.peerId === 'string' && typeof k.communityId === 'string' && Number.isSafeInteger(k.epoch)
        ? { peerId: k.peerId, communityId: k.communityId, epoch: k.epoch as number } : null;
}

export type FollowCheck = 'same' | 'not-same' | 'unreachable';

/**
 * Whether `offer.to` is the community the phone has at `offer.from`. The phone's community is what it first verified at
 * that address, kept; its statement now must still match that (else the address answers as another community now, and
 * nothing is offered), and raises the kept take-over count. With nothing kept, its statement now is kept. 'unreachable'
 * when the community's identity isn't known or the new address gave no signed statement.
 */
async function checkFollow(offer: AddressFollowOffer, deps: AddressFollowDeps): Promise<FollowCheck> {
    const [now, there] = await Promise.all([deps.statement(offer.from), deps.statement(offer.to)]);
    const kept = readKeptIdentity((await readMap<CommunityIdentity>(COMMUNITY_IDENTITY_KEY))[offer.from]);
    if (now && kept && !sameIdentity(kept, now)) return 'not-same';
    const here = now ? { ...now, epoch: Math.max(now.epoch, kept?.epoch ?? 0) } : kept;
    if (!here) return 'unreachable';
    if (now && (!kept || here.epoch !== kept.epoch)) await writeEntry(COMMUNITY_IDENTITY_KEY, offer.from, here);
    if (!there) return 'unreachable';
    return sameCommunity(here, there) ? 'same' : 'not-same';
}

/** Offers checked this run: `from to` → the answer and when. 'unreachable' is never kept. */
const checked = new Map<string, { verdict: FollowCheck; at: number }>();
/** The addresses whose identity this run has asked for already, with nothing to follow. */
const asked = new Set<string>();

/** Forget this run's checks (tests). */
export function forgetFollowChecks(): void {
    checked.clear();
    asked.clear();
}

/**
 * With nothing to follow yet: keep who the phone's community is, once per run while nothing is kept for its address, so
 * the first move it is ever offered is checked against who the community was before, not against what its address
 * says on that day (a server's number can be given to someone else).
 */
async function keepIdentityOnce(from: string, deps: AddressFollowDeps): Promise<void> {
    if (asked.has(from)) return;
    asked.add(from);
    if (readKeptIdentity((await readMap<CommunityIdentity>(COMMUNITY_IDENTITY_KEY))[from])) return;
    const now = await deps.statement(from).catch(() => null);
    if (now) await writeEntry(COMMUNITY_IDENTITY_KEY, from, now);
    else asked.delete(from);
}

/** The offer declined until a time still ahead, for this same new address. */
async function snoozed(offer: AddressFollowOffer, now: number): Promise<boolean> {
    const s = (await readMap<{ to?: unknown; until?: unknown }>(FOLLOW_SNOOZE_KEY))[offer.from];
    return !!s && s.to === offer.to && typeof s.until === 'number' && s.until > now;
}

/**
 * The card's question, or null: the phone's community lives somewhere else now, the member hasn't said "Not now" to it in
 * the last 7 days, and it is checked to be the same community. Writes nothing but what the phone verified of its own
 * community (above): never the community's address.
 */
export async function addressFollowOffer(injected?: Partial<AddressFollowDeps>): Promise<AddressFollowOffer | null> {
    const deps = await depsWith(injected);
    const anchor = await deps.anchor().catch(() => null);
    const from = followableOrigin(anchor);
    if (!anchor || !from) return null;
    const offer = followCandidate(anchor, await deps.profile(anchor).catch(() => null));
    if (!offer) {
        await keepIdentityOnce(from, deps);
        return null;
    }
    if (await snoozed(offer, deps.now())) return null;
    const id = `${offer.from} ${offer.to}`;
    const memo = checked.get(id);
    let verdict = memo && deps.now() - memo.at < VERDICT_TTL_MS ? memo.verdict : null;
    if (!verdict) {
        verdict = await checkFollow(offer, deps);
        if (verdict === 'unreachable') checked.delete(id);
        else checked.set(id, { verdict, at: deps.now() });
    }
    return verdict === 'same' ? offer : null;
}

/** "Not now": the same offer is not made again for 7 days. A different new address is a new offer. */
export async function snoozeAddressFollow(offer: AddressFollowOffer, injected?: Partial<AddressFollowDeps>): Promise<void> {
    const deps = await depsWith(injected);
    await writeEntry(FOLLOW_SNOOZE_KEY, offer.from, { to: offer.to, until: deps.now() + FOLLOW_SNOOZE_MS });
}

/** What the member's "Use the new address" did. Only 'moved' moved anything. */
export type FollowResult =
    /** The phone's community is `offer.to` now. */
    | 'moved'
    /** The new address isn't the same community (checked again just now): nothing moved. */
    | 'not-same'
    /** The check couldn't be made: nothing moved, and the card stays. */
    | 'unreachable'
    /** The phone isn't on `offer.from` any more (switched meanwhile): nothing moved. */
    | 'gone';

/**
 * The member chose the new address. Checked again first (the card may have waited), then: a guest visit's mark goes with
 * it (else the app takes the guest for a mistyped address, utils/nodes.ts), the phone switches through switchPhoneTo
 * (which announces the switch), the saved list's row moves to the new address with its name, and "Not now" is forgotten.
 */
export async function acceptAddressFollow(offer: AddressFollowOffer, injected?: Partial<AddressFollowDeps>): Promise<FollowResult> {
    const deps = await depsWith(injected);
    const anchor = await deps.anchor().catch(() => null);
    if (followableOrigin(anchor) !== offer.from || !anchor) return 'gone';
    // The offer by the same rules as when it was made, never a move the card was handed some other way.
    const again = followCandidate(anchor, { addresses: [offer.host], primaryAddress: offer.host });
    if (!again || again.to !== offer.to) return 'not-same';
    const verdict = await checkFollow(offer, deps);
    checked.delete(`${offer.from} ${offer.to}`);
    if (verdict !== 'same') return verdict;
    const saved = (await deps.savedNodes().catch(() => [] as SavedNode[])).find(n => isPlainNodeAddress(n.url) && plainOriginOf(n.url) === offer.from);
    if (await deps.isGuestNode(anchor).catch(() => false)) await deps.markGuestNode(offer.to);
    await deps.switchTo(offer.to);
    await deps.addSavedNode(offer.to, saved?.alias, saved?.currencyType, saved?.currencyValue).catch(() => {});
    if (saved) await deps.removeSavedNode(saved.url).catch(() => {});
    await writeEntry(FOLLOW_SNOOZE_KEY, offer.from, undefined);
    return 'moved';
}

/**
 * The owner's nudge (design §3, D3): the server's public number when that is how members reach this community, else null.
 * `origin` is the community's address on this phone (or the one just claimed at); `addresses` its own, as its info names
 * them (absent: not known). A number only when none of the community's own addresses is a name.
 */
export function numberOnlyAddress(origin: string | null | undefined, addresses?: readonly string[] | null): string | null {
    if (!origin) return null;
    const o = communityOrigin(origin);
    const host = o ? audienceOf(o) : null;
    if (!host || !IPV4_HOST.test(host)) return null;
    const hasName = (addresses ?? []).some(a => {
        const h = audienceOf(`https://${a}`);
        return !!h && !IPV4_HOST.test(h) && !h.startsWith('[');
    });
    return hasName ? null : host;
}
