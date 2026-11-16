/**
 * Who a community is, by its signed statement (GET /api/node/identity-epoch), and what the phone first verified at each of
 * its addresses (COMMUNITY_IDENTITY_KEY). The follow card that lived here (DESIGN-https-anywhere-fable.md §3, D4) went in
 * addresses S4 (scratch/fable-design/DESIGN-several-addresses-fable.md §9): the phone now follows by itself, by the
 * community's signed list and a fresh proof from each address (utils/address-verify.ts), and nothing is copied.
 *
 * Every node serves a statement of who it is, signed with its node key: its PeerId, its community id and how many
 * take-overs it has had (apps/server services/identity-epoch.ts). The statement is public, so it tells a wrong or stale
 * address from the community's own; it is not a proof that whoever answers holds the key. What the phone first read at its
 * own address is kept (keepCommunityIdentity, from the tab strip's read at each app start and switch), and is what the hall
 * door checks the hall laptop against (utils/hall.ts, with a fresh nonce on top) and what address-verify.ts takes as the
 * community's key before any list is kept.
 *
 * Never from an http address (whoever is in the middle of a home network could name both the address and the identity),
 * and never from the worldwide community (the app knows it by its one address, utils/global-node-url.ts).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { audienceOf, ed25519KeyOfPeerId, t } from '@beanpool/core';
import { communityOrigin } from './community-origin';
import { GLOBAL_NODE_URL } from './global-node-url';
import { isPlainNodeAddress, plainOriginOf } from './node-url';

/** Where a node serves its signed statement (apps/server services/identity-epoch.ts IDENTITY_EPOCH_PATH). */
export const IDENTITY_STATEMENT_PATH = '/api/node/identity-epoch';
/** What the node key signs in front of the statement (apps/server services/identity-epoch.ts DOMAIN). */
const STATEMENT_DOMAIN = 'beanpool-identity-epoch-v1\n';
/** `{ [an address, as an origin]: CommunityIdentity }`: who this phone first verified each of its communities' addresses to be. */
export const COMMUNITY_IDENTITY_KEY = 'beanpool_community_identity';
const STATEMENT_TIMEOUT_MS = 8_000;
/** A statement that got no answer is asked again after this long (a name whose DNS is still on its way, a server down a moment). */
const UNREACHABLE_TTL_MS = 5 * 60 * 1000;
const MAX_KEPT = 50;

/** Who a node says it is, from a statement signed with its node key. */
export interface CommunityIdentity {
    peerId: string;
    communityId: string;
    /** Take-overs so far: a promoted standby is one higher than the server it replaced. */
    epoch: number;
}

/** A server's number as a host (communityOrigin takes only a public one). */
export const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The phone's community address as an origin that may be verified and followed (utils/address-verify.ts): plain, https,
 * not the worldwide community's.
 */
export function followableOrigin(anchor: string | null | undefined): string | null {
    const from = anchor && isPlainNodeAddress(anchor.trim()) ? plainOriginOf(anchor.trim()) : null;
    if (!from || !from.startsWith('https://')) return null;
    const here = audienceOf(from);
    return here && here !== audienceOf(GLOBAL_NODE_URL) ? from : null;
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
    let valid: boolean;
    try {
        valid = ed25519.verify(base64Bytes(b.sig), bytes, key, { zip215: false });
    } catch {
        valid = false;
    }
    return valid ? { peerId: s.peerId, communityId: s.communityId, epoch: s.epoch as number } : null;
}

/** One community: the same node key and the same community id. */
export function sameIdentity(a: CommunityIdentity, b: CommunityIdentity): boolean {
    return a.peerId === b.peerId && a.communityId === b.communityId;
}

/** Whether `there` is the community `here` is, and not an older server of it (fewer take-overs). */
export function sameCommunity(here: CommunityIdentity, there: CommunityIdentity): boolean {
    return sameIdentity(here, there) && there.epoch >= here.epoch;
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

export async function readMap<T>(key: string): Promise<Record<string, T>> {
    try {
        const raw = await AsyncStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** Writes `map` with `id` set (or removed, for undefined), keeping the newest MAX_KEPT. Never throws. */
export async function writeEntry<T>(key: string, id: string, value: T | undefined): Promise<void> {
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

/** Who the phone first verified its community at `origin` to be (kept by keepCommunityIdentity or a check), or null. */
export async function keptIdentityAt(origin: string): Promise<CommunityIdentity | null> {
    return readKeptIdentity((await readMap<CommunityIdentity>(COMMUNITY_IDENTITY_KEY))[origin]);
}

/**
 * What the phone first verified its community to be at `origin` (an origin, as kept), or null when nothing is kept there.
 * The hall door (utils/hall.ts) checks the hall laptop against it. Never throws: the same read as keptIdentityAt.
 */
export async function keptCommunityIdentity(origin: string): Promise<CommunityIdentity | null> {
    try {
        return await keptIdentityAt(origin);
    } catch {
        return null;
    }
}

/** Addresses whose statement gave no answer this run when there was nothing kept for them, and when (UNREACHABLE_TTL_MS). */
const unanswered = new Map<string, number>();

/** Forget this run's asks (tests). */
export function forgetFollowChecks(): void {
    unanswered.clear();
}

/**
 * Keep who the phone's community is at `url` (its signed statement there, verified), the first time the phone reads its
 * community at that address: the tab strip's read, at each app start and switch (app/(tabs)/_layout.tsx). So the hall door
 * and the first verify of the address (address-verify.ts) check against the community from before, not against whoever
 * answers at that address on the day one first is (review of #2138). One read, once per address: none once something is
 * kept, and after no answer none for five minutes. Only for an address that may be followed (followableOrigin). Never
 * throws.
 */
export async function keepCommunityIdentity(
    url: string | null | undefined,
    injected?: { statement?: (origin: string) => Promise<CommunityIdentity | null>; now?: () => number },
): Promise<void> {
    try {
        const from = followableOrigin(url);
        if (!from) return;
        const kept = async () => readKeptIdentity((await readMap<CommunityIdentity>(COMMUNITY_IDENTITY_KEY))[from]);
        if (await kept()) return;
        const now = injected?.now ?? (() => Date.now());
        const at = unanswered.get(from);
        if (at !== undefined && now() - at >= 0 && now() - at < UNREACHABLE_TTL_MS) return;
        const identity = await (injected?.statement ?? ((origin: string) => fetchIdentityStatement(origin)))(from);
        if (!identity) { unanswered.set(from, now()); return; }
        unanswered.delete(from);
        // One kept meanwhile (another read) stays.
        if (!(await kept())) await writeEntry(COMMUNITY_IDENTITY_KEY, from, identity);
    } catch {
        // Not kept: asked again at the next read.
    }
}

/**
 * The owner's nudge, the same sentence wherever it shows (the claim screen's last step, Settings → Manage; design §3, D3):
 * never a gate, never a deadline. "Settings → Public Address" is the community's own Settings, which Manage opens.
 */
export function numberNudge(ip: string): string {
    return t("Members reach this community by its server's number, {ip}. If the server or its number changes, each member will have to type the new one. A name follows the community: Settings → Public Address.", { ip });
}

/**
 * The server's public number when that is how members reach this community, else null (numberNudge says it).
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

/**
 * The community's .beanpool.org name if one is known, else null.
 * `origin` is the community's address on this phone (or the one just claimed at); `addresses` its own, as its info names them.
 */
export function registrarNameOf(origin: string | null | undefined, addresses?: readonly string[] | null): string | null {
    if (origin) {
        const o = communityOrigin(origin);
        const host = o ? audienceOf(o) : null;
        if (host && (host === 'beanpool.org' || host.endsWith('.beanpool.org'))) return host;
    }
    for (const a of addresses ?? []) {
        const h = audienceOf(`https://${a}`);
        if (h && (h === 'beanpool.org' || h.endsWith('.beanpool.org'))) return h;
    }
    return null;
}
