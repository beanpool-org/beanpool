/**
 * The member's list of communities, riding inside a sealed recovery copy (vault rethink VR5; scratch/fable-design/
 * DESIGN-vault-rethink-fable.md §3 item 5, Marty's picks of 27 Oct). The 12 words bring back the key and nothing else:
 * a new phone restored from them does not know where the member belongs. When the member chooses, a copy carries the
 * list too, so a restore knows where to go.
 *
 * What the list is, deliberately and only: each community's name and address, at most {@link MAX_COPY_COMMUNITIES} of
 * them, in at most {@link MAX_COPY_COMMUNITIES_BYTES} bytes, and, when the phone knew them and they fit, the community's
 * server key and up to {@link MAX_COPY_COMMUNITY_ADDRESSES} of its addresses (several addresses S8, design
 * scratch/fable-design/DESIGN-several-addresses-fable.md §9 S8): a restore proves each address with the key and finds the
 * community at whichever still answers. All of it public about the community; nothing else about the member (no name, no
 * role, no balance, no dates).
 *
 * The packed form is a JSON array of `[url, name]`, each followed, when it carries them, by `{ "k": key, "a": [addresses] }`
 * describing the entry before it. A reader from before S8 skips anything that is not a two-item array, so it still reads
 * every community of a copy made now; a copy made before S8 has no such item. It is packed here and sealed by keeper-crypto.ts in its own box inside the copy's `kdfParams`,
 * under a key derived from the copy's own key: whoever can open the copy can read it, and nobody else. The vault and
 * the node store `kdfParams` without reading it.
 *
 * Why a byte bound as well as a count: every place a copy is kept refuses a `kdfParams` longer than 4,096 characters
 * (the node's deposit, the community copy route, and the key vault's `isVaultClientCopy`, live today). The bound keeps
 * a copy with its words and a full list under that, whatever the names are written in (see the size test).
 *
 * Pure: no crypto, no I/O. The phone and the browser both use it, so they keep and drop the same communities.
 */

import { isListableAddress } from './address-list.js';
import { ed25519KeyOfPeerId } from './owner-unlock.js';

/** One community in the list: what it is called, and its address (`https://host` or `http://host:port`). */
export interface CopyCommunity {
    name: string;
    url: string;
    /** The community's server key (an Ed25519 libp2p PeerId), when the phone knew it: a restore proves an address with it. */
    peerId?: string;
    /** Up to {@link MAX_COPY_COMMUNITY_ADDRESSES} of its addresses (core's one spelling), the one in use first. */
    addresses?: string[];
}

/** At most this many of a community's addresses ride with it. */
export const MAX_COPY_COMMUNITY_ADDRESSES = 3;

/** At most this many communities ride in a copy. More are left out, and the member is told how many. */
export const MAX_COPY_COMMUNITIES = 20;
/** A name longer than this is shortened (by characters, never splitting one). */
export const MAX_COPY_COMMUNITY_NAME_CHARS = 60;
/** An address longer than this is left out: an address can't be shortened and still lead anywhere. */
export const MAX_COPY_COMMUNITY_URL_CHARS = 120;
/** The packed list's largest size in bytes (UTF-8 JSON). A community that would take it over is left out. */
export const MAX_COPY_COMMUNITIES_BYTES = 2400;

/** A packed list: the bytes a copy seals, the communities in them, and how many valid ones did not fit. */
export interface PackedCopyCommunities {
    bytes: Uint8Array;
    kept: CopyCommunity[];
    /** Communities that were valid but did not fit: past the 20th, or past the byte bound. */
    leftOut: number;
}

const PLAIN_ADDRESS = /^(https?):\/\/([^\s/?#@\\]+?)\/?$/i;

/**
 * The address as a copy carries it, or null when it isn't a plain community address: `http(s)://host[:port]`, nothing
 * after the host but one optional slash (dropped), no user part, at most {@link MAX_COPY_COMMUNITY_URL_CHARS} long. The
 * scheme is lower-cased; the host is kept as written (the apps compare addresses case-folded).
 */
export function copyCommunityUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || s.length > MAX_COPY_COMMUNITY_URL_CHARS) return null;
    const m = PLAIN_ADDRESS.exec(s);
    if (!m) return null;
    return `${m[1].toLowerCase()}://${m[2]}`;
}

/** The name as a copy carries it: control characters gone, spaces collapsed, at most 60 characters. */
export function copyCommunityName(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
    const chars = Array.from(clean);
    return chars.length > MAX_COPY_COMMUNITY_NAME_CHARS ? chars.slice(0, MAX_COPY_COMMUNITY_NAME_CHARS).join('').trim() : clean;
}

function sameAddress(url: string): string {
    return url.toLowerCase();
}

function encode(entries: readonly CopyCommunity[]): Uint8Array {
    const items: unknown[] = [];
    for (const c of entries) {
        items.push([c.url, c.name]);
        if (c.peerId && c.addresses?.length) items.push({ k: c.peerId, a: c.addresses });
    }
    return new TextEncoder().encode(JSON.stringify(items));
}

/** The key and addresses an entry may carry (`peerId`, `addresses`), each checked, or none when either is not one. */
function extrasOf(peerId: unknown, addresses: unknown): Pick<CopyCommunity, 'peerId' | 'addresses'> {
    if (typeof peerId !== 'string' || !ed25519KeyOfPeerId(peerId) || !Array.isArray(addresses)) return {};
    const kept: string[] = [];
    for (const a of addresses) {
        if (isListableAddress(a) && !kept.includes(a)) kept.push(a);
        if (kept.length === MAX_COPY_COMMUNITY_ADDRESSES) break;
    }
    return kept.length ? { peerId, addresses: kept } : {};
}

/**
 * Pack the member's communities, in the order given (the first is the most important: the community the phone is on).
 * Each address once; an entry that isn't a community address is skipped and not counted. At most
 * {@link MAX_COPY_COMMUNITIES} are kept; one that would take the bytes past {@link MAX_COPY_COMMUNITIES_BYTES} is left
 * out and the next still tried. `leftOut` counts the valid communities that did not fit, for the member's words.
 */
export function packCopyCommunities(list: readonly unknown[] | null | undefined): PackedCopyCommunities {
    const kept: CopyCommunity[] = [];
    const extras: Pick<CopyCommunity, 'peerId' | 'addresses'>[] = [];
    let leftOut = 0;
    const seen = new Set<string>();
    for (const raw of list ?? []) {
        const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const url = copyCommunityUrl(entry.url);
        if (!url || seen.has(sameAddress(url))) continue;
        seen.add(sameAddress(url));
        const candidate = { name: copyCommunityName(entry.name), url };
        if (kept.length >= MAX_COPY_COMMUNITIES || encode([...kept, candidate]).length > MAX_COPY_COMMUNITIES_BYTES) {
            leftOut++;
            continue;
        }
        kept.push(candidate);
        extras.push(extrasOf(entry.peerId, entry.addresses));
    }
    // Then each kept community's key and addresses, in order, while they fit in what is left: they never cost a community
    // its place (the communities kept and left out are exactly those of name and address alone).
    for (let i = 0; i < kept.length; i++) {
        if (!extras[i].peerId) continue;
        const withThem = kept.map((c, j) => (j === i ? { ...c, ...extras[i] } : c));
        if (encode(withThem).length <= MAX_COPY_COMMUNITIES_BYTES) kept[i] = withThem[i];
    }
    return { bytes: kept.length ? encode(kept) : new Uint8Array(0), kept, leftOut };
}

/**
 * Read a packed list back. Throws on bytes that aren't one (the caller treats that as an unreadable list, never as a
 * failed restore). Entries that aren't a community address are dropped, and never more than {@link MAX_COPY_COMMUNITIES}
 * come back, whatever the bytes say.
 */
export function unpackCopyCommunities(bytes: Uint8Array): CopyCommunity[] {
    if (bytes.length > MAX_COPY_COMMUNITIES_BYTES) throw new Error('A copy\'s list of communities is larger than any app makes.');
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(parsed)) throw new Error('A copy\'s list of communities is not a list.');
    const out: CopyCommunity[] = [];
    const seen = new Set<string>();
    // The entry an `{ k, a }` item right after it describes; none after anything else.
    let last: CopyCommunity | null = null;
    for (const item of parsed) {
        const before = last;
        last = null;
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            if (before) Object.assign(before, extrasOf((item as { k?: unknown }).k, (item as { a?: unknown }).a));
            continue;
        }
        if (!Array.isArray(item) || item.length !== 2 || out.length >= MAX_COPY_COMMUNITIES) continue;
        const url = copyCommunityUrl(item[0]);
        if (!url || seen.has(sameAddress(url))) continue;
        seen.add(sameAddress(url));
        last = { url, name: copyCommunityName(item[1]) };
        out.push(last);
    }
    return out;
}
