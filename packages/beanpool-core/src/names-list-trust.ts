/**
 * Who an admin's phone takes the names list's key from (PR #1411's deciding review: the phone opened any wrap of the
 * list key addressed to it, whoever made it, and re-sealed every older entry under it; one row written into the server's
 * database read the whole list).
 *
 * The server is not trusted with this. Whoever runs it can write any row, and through `node_roles` (the owner password
 * is owner-level) make any key an admin. So the phone decides from what admins' own keys signed, never from what the
 * server says about who is an admin or who made a wrap.
 *
 * ## The signed wrap
 *
 * Every wrap of the list key is SIGNED by the admin who made it, with their identity key (Ed25519), over
 * {@link namesWrapStatementBytes}: the community's id, the generation, the holder, the signer, a digest of the wrap's
 * fields, and the admins the signer dropped from the list when it made a new generation (`drops`). A wrap is how an
 * admin adds a holder (a share, or their own key when they make a generation) and a generation's first wrap, the
 * maker's own, is how they change the key and say who is out. The server checks the signature is the requester's
 * before it keeps a wrap, and keeps the signature beside it (and keeps it after the wrap itself is cleared), so every
 * phone can check the same.
 *
 * ## The pin, and the trace
 *
 * Each admin's phone keeps, per community, its own **pinned set of trusted admin keys** ({@link NamesTrustPin}): itself,
 * and every key it has accepted. {@link traceNamesTrust} walks the signed wraps the server lists, generation by
 * generation from the first:
 *
 *   1. a wrap whose signature doesn't check out is ignored;
 *   2. in each generation, first the drops: a key that a trusted admin dropped when they made that generation stops
 *      being trusted (this phone's own key never does);
 *   3. then the additions: a wrap signed by a trusted key adds its holder (repeated until nothing changes, so an admin
 *      added by an admin added by a trusted one is trusted too).
 *
 * The phone uses a wrap of its own only where that wrap was accepted in the walk. A key the server made an admin, with
 * no trusted admin's signature adding it, is never accepted, nor is any key it signs, nor any generation only it made.
 *
 * **Trust on first use.** A phone with no pin for the community (it never opened the list, or it was reinstalled)
 * trusts itself, and the signer of the wrap it is opening for the first time (the current generation's, else its
 * newest). A phone that makes the list's first key trusts only itself.
 *
 * ## What this doesn't protect against (said in the guide and in the app)
 *
 * - The first use: a phone with no pin trusts whoever signed the first wrap it opens. A server that hands a new admin's
 *   phone a key of its own making first gets what that admin then types; the other admins' phones refuse it.
 * - A compromised admin phone: it holds the key and can sign.
 * - An admin who was removed, working with whoever runs the server: the server can hide the removal from the phones,
 *   which then can't tell that admin is out.
 * - An admin tapping Share for a key the server made an admin, or tapping "Trust" for one: that is an admin's own choice.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Seed } from './ed25519-key.js';
import { unwrapNamesListKey, type WrappedNamesKey } from './names-list-crypto.js';

/** What a signed wrap's statement starts with. */
export const NAMES_WRAP_STATEMENT = 'beanpool-names-wrap-v1';

const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
/** A community's id (genesis.json `communityId`): 16 lower-case hex characters, or anything short and plain in a test. */
const COMMUNITY_ID = /^[0-9A-Za-z_-]{1,64}$/;

/** What a signed wrap says. */
export interface NamesWrapClaim {
    communityId: string;
    generation: number;
    holder: string;
    wrappedBy: string;
    wrapDigest: string;
    /** The admins the signer dropped from the list when it made this generation; empty for every other wrap. */
    drops: string[];
}

/** A wrap's header as the server lists it for every admin: its claim and signature, never the wrapped key itself. */
export interface NamesKeyRecord extends NamesWrapClaim {
    signature: string;
}

/** One of this admin's own wraps, as the server sends it: the wrap, its generation, who signed it and the signature. */
export interface NamesOwnWrap extends WrappedNamesKey {
    generation: number;
    wrappedBy: string;
    signature: string;
    drops: string[];
}

/** What a phone keeps for one community: the community's id, and the admin keys it trusts for the list. */
export interface NamesTrustPin {
    v: 1;
    communityId: string;
    trusted: string[];
}

export function isNamesCommunityId(id: unknown): id is string {
    return typeof id === 'string' && COMMUNITY_ID.test(id);
}

/** A list of admin keys as a statement carries them: lower-case, each once, sorted. Throws on anything but keys. */
export function normaliseNamesDrops(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > 50) throw new Error('drops must be a list of at most 50 admin keys.');
    const out = new Set<string>();
    for (const k of raw) {
        const hex = typeof k === 'string' ? k.toLowerCase() : '';
        if (!HEX_KEY.test(hex)) throw new Error('Each dropped admin is a key of 64 hexadecimal characters.');
        out.add(hex);
    }
    return [...out].sort();
}

/** The digest a statement names for a wrap: SHA-256 over its five fields, in order, each on its own line. */
export function namesWrapDigest(w: WrappedNamesKey): string {
    const text = [w.wrappedKey, w.wrapIv, w.wrapTag, w.ephemeralPubkey, w.kdfParams].join('\n');
    return bytesToHex(sha256(utf8ToBytes(text)));
}

/** The bytes an admin signs for a wrap. */
export function namesWrapStatementBytes(c: NamesWrapClaim): Uint8Array {
    if (!isNamesCommunityId(c.communityId)) throw new Error('A community id is needed to sign or check a wrap.');
    if (!Number.isSafeInteger(c.generation) || c.generation < 1) throw new Error('A generation is a whole number from 1.');
    if (!HEX_KEY.test(c.holder) || !HEX_KEY.test(c.wrappedBy)) throw new Error('A holder and a signer are keys of 64 hexadecimal characters.');
    if (!HEX_DIGEST.test(c.wrapDigest)) throw new Error('A wrap digest is 64 hexadecimal characters.');
    const drops = normaliseNamesDrops(c.drops);
    return utf8ToBytes([NAMES_WRAP_STATEMENT, c.communityId, String(c.generation), c.holder, c.wrappedBy, c.wrapDigest, drops.join(',')].join('\n'));
}

function seedOf(privateKey: string | Uint8Array): Uint8Array {
    const bytes = typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey;
    return toEd25519Seed(bytes);
}

/** Signs a wrap's claim with the signer's identity key (raw seed or PKCS8, hex or bytes): 128 hex characters. */
export function signNamesWrap(claim: NamesWrapClaim, privateKey: string | Uint8Array): string {
    const seed = seedOf(privateKey);
    if (bytesToHex(ed25519.getPublicKey(seed)) !== claim.wrappedBy) throw new Error('A wrap is signed by the key it names as its signer.');
    return bytesToHex(ed25519.sign(namesWrapStatementBytes(claim), seed));
}

/** Whether `signature` is `claim.wrappedBy`'s over `claim`. Never throws. */
export function verifyNamesWrap(claim: NamesWrapClaim, signature: unknown): boolean {
    if (typeof signature !== 'string' || !HEX_SIG.test(signature)) return false;
    try {
        return ed25519.verify(hexToBytes(signature), namesWrapStatementBytes(claim), hexToBytes(claim.wrappedBy));
    } catch {
        return false;
    }
}

/** A wrap of `generation` to `holder`, signed by `signer`: what a phone sends the server. */
export function signedNamesWrap(
    wrap: WrappedNamesKey, opts: { communityId: string; generation: number; holder: string; signer: { publicKey: string; privateKey: string | Uint8Array }; drops?: string[] },
): WrappedNamesKey & { holder: string; signature: string; drops: string[] } {
    const drops = normaliseNamesDrops(opts.drops ?? []);
    const claim: NamesWrapClaim = {
        communityId: opts.communityId, generation: opts.generation, holder: opts.holder.toLowerCase(),
        wrappedBy: opts.signer.publicKey.toLowerCase(), wrapDigest: namesWrapDigest(wrap), drops,
    };
    return { holder: claim.holder, ...wrap, signature: signNamesWrap(claim, opts.signer.privateKey), drops };
}

/** Why one of this admin's own wraps wasn't used. */
export type NamesWrapRefusal =
    /** Its signature doesn't check out: written by someone without the signer's key (the server, or anyone with its database). */
    | 'unsigned'
    /** Signed, but by a key this phone doesn't trust: no admin it trusts added that key. */
    | 'untrusted'
    /** The box didn't open with this phone's key. */
    | 'did_not_open';

export interface NamesTrustTrace {
    /** The list keys this phone may use, by generation: only wraps accepted in the walk. */
    keys: Map<number, Uint8Array>;
    /** The admin keys this phone trusts after the walk (itself included). */
    trusted: Set<string>;
    /** Whether `generation` (the server's current one) has a wrap signed by a trusted key: a key an admin made. */
    currentTraced: boolean;
    /** This phone's own wraps it didn't use, newest first, and why. */
    refused: { generation: number; wrappedBy: string; reason: NamesWrapRefusal }[];
    /** The key this phone trusted on first use this time (never itself), or null. */
    firstTrust: string | null;
    /** The pin to keep now, or null to keep what is kept (nothing was accepted, or the community's id doesn't match). */
    pin: NamesTrustPin | null;
    /** The server names another community than the pin: nothing is used. */
    otherCommunity: boolean;
}

export interface NamesTrustInput {
    communityId: string;
    me: { publicKey: string; privateKey: string | Uint8Array };
    pin: NamesTrustPin | null;
    /** Every wrap's header the server lists (cleared ones included). */
    records: NamesKeyRecord[];
    /** This admin's own live wraps. */
    myKeys: NamesOwnWrap[];
    /** The server's current generation. */
    generation: number;
}

const claimOf = (r: NamesKeyRecord): NamesWrapClaim => ({
    communityId: r.communityId, generation: r.generation, holder: r.holder, wrappedBy: r.wrappedBy, wrapDigest: r.wrapDigest, drops: r.drops,
});

function cleanRecord(raw: unknown, communityId: string): NamesKeyRecord | null {
    const r = raw as Partial<NamesKeyRecord> | null;
    if (!r || typeof r !== 'object') return null;
    const holder = typeof r.holder === 'string' ? r.holder.toLowerCase() : '';
    const wrappedBy = typeof r.wrappedBy === 'string' ? r.wrappedBy.toLowerCase() : '';
    if (!HEX_KEY.test(holder) || !HEX_KEY.test(wrappedBy) || !Number.isSafeInteger(r.generation) || (r.generation as number) < 1) return null;
    if (typeof r.wrapDigest !== 'string' || !HEX_DIGEST.test(r.wrapDigest)) return null;
    let drops: string[];
    try { drops = normaliseNamesDrops(r.drops); } catch { return null; }
    // The community is the one this phone checks against, never what a record says of itself.
    return { communityId, generation: r.generation as number, holder, wrappedBy, wrapDigest: r.wrapDigest, drops, signature: String(r.signature ?? '') };
}

/**
 * The walk (see the header). Pure: reads nothing, writes nothing. Opens this admin's own accepted wraps with its key.
 */
export function traceNamesTrust(input: NamesTrustInput): NamesTrustTrace {
    const me = input.me.publicKey.toLowerCase();
    const none = (otherCommunity: boolean): NamesTrustTrace => ({
        keys: new Map(), trusted: new Set([me]), currentTraced: false, refused: [], firstTrust: null, pin: null, otherCommunity,
    });
    if (!isNamesCommunityId(input.communityId)) return none(true);
    if (input.pin && input.pin.communityId !== input.communityId) return none(true);

    // Every header, with this phone's own wraps standing in for theirs: their digest is worked out here from the wrap
    // itself, so a header the server altered can't vouch for a different wrap.
    const byKey = new Map<string, NamesKeyRecord>();
    for (const raw of input.records ?? []) {
        const r = cleanRecord(raw, input.communityId);
        if (r) byKey.set(`${r.holder}|${r.generation}`, r);
    }
    const mine = new Map<number, NamesOwnWrap>();
    for (const w of input.myKeys ?? []) {
        if (!w || !Number.isSafeInteger(w.generation) || w.generation < 1) continue;
        let digest: string;
        try { digest = namesWrapDigest(w); } catch { continue; }
        const r = cleanRecord({ ...w, holder: me, wrapDigest: digest }, input.communityId);
        if (!r) continue;
        byKey.set(`${me}|${r.generation}`, r);
        mine.set(r.generation, w);
    }
    const valid = [...byKey.values()].filter((r) => verifyNamesWrap(claimOf(r), r.signature));
    const validKeys = new Set(valid.map((r) => `${r.holder}|${r.generation}`));

    const trusted = new Set<string>(input.pin ? input.pin.trusted.map((k) => k.toLowerCase()).filter((k) => HEX_KEY.test(k)) : []);
    trusted.add(me);
    let firstTrust: string | null = null;
    if (!input.pin) {
        // Trust on first use: the signer of this phone's own wrap of the current generation, else of its newest.
        const candidates = [...mine.keys()].filter((g) => validKeys.has(`${me}|${g}`)).sort((a, b) => b - a);
        const pick = candidates.includes(input.generation) ? input.generation : candidates[0];
        const signer = pick !== undefined ? byKey.get(`${me}|${pick}`)!.wrappedBy : null;
        if (signer && signer !== me) {
            trusted.add(signer);
            firstTrust = signer;
        }
    }

    const accepted = new Set<string>();
    const generations = [...new Set(valid.map((r) => r.generation))].sort((a, b) => a - b);
    for (const g of generations) {
        const here = valid.filter((r) => r.generation === g);
        for (const r of here) {
            if (!trusted.has(r.wrappedBy)) continue;
            for (const d of r.drops) if (d !== me) trusted.delete(d);
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const r of here) {
                const id = `${r.holder}|${r.generation}`;
                if (accepted.has(id) || !trusted.has(r.wrappedBy)) continue;
                accepted.add(id);
                if (!trusted.has(r.holder)) trusted.add(r.holder);
                changed = true;
            }
        }
    }

    const keys = new Map<number, Uint8Array>();
    const refused: NamesTrustTrace['refused'] = [];
    for (const [g, w] of [...mine.entries()].sort((a, b) => b[0] - a[0])) {
        const id = `${me}|${g}`;
        const wrappedBy = byKey.get(id)!.wrappedBy;
        if (!validKeys.has(id)) { refused.push({ generation: g, wrappedBy, reason: 'unsigned' }); continue; }
        if (!accepted.has(id)) { refused.push({ generation: g, wrappedBy, reason: 'untrusted' }); continue; }
        try {
            keys.set(g, unwrapNamesListKey(w, input.me.privateKey, me, g));
        } catch {
            refused.push({ generation: g, wrappedBy, reason: 'did_not_open' });
        }
    }
    const currentTraced = [...accepted].some((id) => id.endsWith(`|${input.generation}`));
    // Nothing accepted and nothing pinned yet: nothing is learnt, so nothing is kept (the next open is a first use again).
    const learnt = !!input.pin || keys.size > 0;
    if (!learnt) firstTrust = null;
    return {
        keys,
        trusted,
        currentTraced,
        refused,
        firstTrust: keys.size > 0 ? firstTrust : null,
        pin: learnt ? { v: 1, communityId: input.communityId, trusted: [...trusted].sort() } : null,
        otherCommunity: false,
    };
}

/** A pin read back from storage, or null for anything that isn't one. */
export function readNamesTrustPin(raw: unknown): NamesTrustPin | null {
    const p = raw as Partial<NamesTrustPin> | null;
    if (!p || typeof p !== 'object' || p.v !== 1 || !isNamesCommunityId(p.communityId) || !Array.isArray(p.trusted)) return null;
    const trusted = p.trusted.filter((k): k is string => typeof k === 'string' && HEX_KEY.test(k));
    return { v: 1, communityId: p.communityId, trusted };
}
