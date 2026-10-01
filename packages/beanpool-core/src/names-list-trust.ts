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
 * ## What the pin remembers (PR #1411's second deciding review)
 *
 * - **The newest generation this phone accepted** (`newest`). A server offering an older one as current (rolled back to
 *   an earlier copy, which a removed admin may hold the key of) is refused ({@link NamesTrustTrace.rolledBack}).
 * - **Whom a trusted admin dropped, and at which generation** (`dropped`). The walk never trusts such a key again from a
 *   wrap older than its drop, so a server that hides the drop can't bring them back; a trusted admin's wrap made at or
 *   after the drop can (they were made an admin again, and an admin shared with them).
 * - **Keys replaced under an admin's name** (`replaced`; {@link namesKeyChanges}): when the server shows an admin's
 *   callsign on a new key and the key this phone trusted under it is gone (a re-key after a lost phone, or whoever runs
 *   the server moving the account to a key of its own), the old key is dropped for good and the new one is trusted only
 *   after an in-person check on this phone, or a trusted admin's signed share. What the old key signed up to the
 *   generation current when this phone noticed (`at`) still counts (the key this phone holds may have come from them);
 *   nothing it signs for a later one does, and no wrap makes it a holder again.
 * - **The callsign each trusted key had** (`names`), to notice that.
 *
 * ## Checking a key in person (the director's decision on PR #1411, under Marty's delegation, 2026-10-02)
 *
 * A key the server names an admin by callsign is never shared with on that word alone. An admin's phone shows its own
 * key as a QR code ({@link namesKeyQr}) and a 20-digit code ({@link namesKeyCode}); the sharing admin scans it, or
 * compares the code, and only a match ({@link namesKeyCheckMatches}) puts that key in this phone's pin
 * ({@link pinCheckedKey}). Share is offered only for a key in the pin ({@link namesShareCheck}).
 *
 * ## What this doesn't protect against (said in the guide and in the app)
 *
 * - The first use: a phone with no pin trusts whoever signed the first wrap it opens. A server that hands a new admin's
 *   phone a key of its own making first gets what that admin then types; the other admins' phones refuse it. The app
 *   shows the new admin the code of whom it trusted, to compare in person.
 * - An in-person check is only as good as the person checking: comparing the code with someone who isn't that admin.
 * - A compromised admin phone: it holds the key and can sign.
 * - An admin who was removed, working with whoever runs the server, before any phone saw the signed drop: a phone that
 *   never learnt of it can't tell that admin is out.
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

/** What a phone keeps for one community (see the header). */
export interface NamesTrustPin {
    v: 2;
    communityId: string;
    /** The admin keys this phone trusts for the list (itself included). */
    trusted: string[];
    /** The callsign each trusted key had when this phone last saw it, to notice a key changed under an admin's name. */
    names: Record<string, string>;
    /** The newest generation a trusted admin made, as this phone saw it: it never goes back to an older one. */
    newest: number;
    /** Keys a trusted admin dropped, with the generation they were dropped at. */
    dropped: Record<string, number>;
    /**
     * Keys replaced under an admin's name, with that name and the generation current when this phone noticed: trusted
     * again only by an in-person check on this phone; their signatures count up to `at` only.
     */
    replaced: Record<string, { callsign: string; at: number }>;
}

/** A pin that trusts no one yet but this phone. */
export function emptyNamesTrustPin(communityId: string, me: string): NamesTrustPin {
    return { v: 2, communityId, trusted: [me.toLowerCase()], names: {}, newest: 0, dropped: {}, replaced: {} };
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
    /** The server's current generation is older than the newest this phone accepted: a copy rolled back. */
    rolledBack: boolean;
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
        keys: new Map(), trusted: new Set([me]), currentTraced: false, refused: [], firstTrust: null, pin: null, otherCommunity, rolledBack: false,
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

    // What the pin remembers: keys dropped (and at which generation) and keys replaced, which no old wrap brings back.
    const droppedAt = new Map<string, number>(Object.entries(input.pin?.dropped ?? {}).filter(([k, g]) => HEX_KEY.test(k) && Number.isSafeInteger(g) && g > 0));
    const replaced = new Map<string, number>(Object.entries(input.pin?.replaced ?? {}).filter(([k]) => HEX_KEY.test(k) && k !== me).map(([k, r]) => [k, r.at]));
    /** Whether `k` signs for generation `g`: trusted now, or a replaced key, for what it signed up to when it was replaced. */
    const signs = (k: string, g: number) => trusted.has(k)
        || (replaced.has(k) && g <= replaced.get(k)! && !(droppedAt.has(k) && droppedAt.get(k)! <= g));
    const trusted = new Set<string>(input.pin ? input.pin.trusted.map((k) => k.toLowerCase()).filter((k) => HEX_KEY.test(k) && !replaced.has(k) && !droppedAt.has(k)) : []);
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
            if (!signs(r.wrappedBy, g)) continue;
            // A maker naming itself as dropped means nothing: it signs the key it holds.
            for (const d of r.drops) {
                if (d === me || d === r.wrappedBy) continue;
                trusted.delete(d);
                droppedAt.set(d, Math.max(droppedAt.get(d) ?? 0, g));
            }
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const r of here) {
                const id = `${r.holder}|${r.generation}`;
                if (accepted.has(id) || !signs(r.wrappedBy, g)) continue;
                // A dropped key comes back only by a trusted admin's wrap made at or after its drop; a replaced key, never here.
                if (r.holder !== me && (replaced.has(r.holder) || (droppedAt.get(r.holder) ?? 0) > g)) continue;
                accepted.add(id);
                droppedAt.delete(r.holder);
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
    const newestAccepted = Math.max(0, ...[...accepted].map((id) => Number(id.split('|')[1])));
    const pinnedNewest = input.pin?.newest ?? 0;
    // Nothing accepted and nothing pinned yet: nothing is learnt, so nothing is kept (the next open is a first use again).
    const learnt = !!input.pin || keys.size > 0;
    if (!learnt) firstTrust = null;
    const names: Record<string, string> = {};
    for (const [k, n] of Object.entries(input.pin?.names ?? {})) if (trusted.has(k)) names[k] = n;
    return {
        keys,
        trusted,
        currentTraced,
        refused,
        firstTrust: keys.size > 0 ? firstTrust : null,
        pin: learnt ? {
            v: 2, communityId: input.communityId, trusted: [...trusted].sort(), names,
            newest: Math.max(pinnedNewest, newestAccepted),
            dropped: Object.fromEntries([...droppedAt.entries()].filter(([k]) => !trusted.has(k)).sort()),
            replaced: { ...(input.pin?.replaced ?? {}) },
        } : null,
        otherCommunity: false,
        rolledBack: !!input.pin && input.generation < pinnedNewest,
    };
}

/** A pin read back from storage (this version's, or the first version's, which knew only whom it trusted), or null. */
export function readNamesTrustPin(raw: unknown): NamesTrustPin | null {
    const p = raw as Partial<Omit<NamesTrustPin, 'v'>> & { v?: unknown } | null;
    if (!p || typeof p !== 'object' || (p.v !== 1 && p.v !== 2) || !isNamesCommunityId(p.communityId) || !Array.isArray(p.trusted)) return null;
    const trusted = p.trusted.filter((k): k is string => typeof k === 'string' && HEX_KEY.test(k));
    const record = <T>(raw: unknown, ok: (v: unknown) => v is T): Record<string, T> => {
        const out: Record<string, T> = {};
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) if (HEX_KEY.test(k) && ok(v)) out[k] = v;
        return out;
    };
    const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
    const isGeneration = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
    const isReplaced = (v: unknown): v is { callsign: string; at: number } => !!v && typeof v === 'object'
        && isName((v as { callsign?: unknown }).callsign) && Number.isSafeInteger((v as { at?: unknown }).at) && (v as { at: number }).at >= 0;
    return {
        v: 2, communityId: p.communityId, trusted,
        names: record(p.names, isName),
        newest: Number.isSafeInteger(p.newest) && (p.newest as number) > 0 ? p.newest as number : 0,
        dropped: record(p.dropped, isGeneration),
        replaced: record(p.replaced, isReplaced),
    };
}

// ── Keys changed under an admin's name ───────────────────────────────────────────────────────

/** A callsign as compared here: the same letters in any case or width. A look-alike in another script is not the same. */
const sameName = (a: string, b: string) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();

/** An admin as the server lists them: a key and the callsign it shows on it. */
export interface NamesAdminName {
    pubkey: string;
    callsign: string;
}

/**
 * Keys changed under an admin's name: an admin the server lists under a callsign this phone trusted on another key, which
 * the server no longer lists as an admin. That is a re-key (a lost phone replaced), or whoever runs the server moving the
 * account to a key of its own: this phone can't tell which, so it trusts neither until it is checked in person.
 */
export function namesKeyChanges(pin: NamesTrustPin | null, admins: NamesAdminName[]): { callsign: string; was: string; now: string }[] {
    if (!pin) return [];
    const listed = new Set(admins.map((a) => a.pubkey.toLowerCase()));
    const out: { callsign: string; was: string; now: string }[] = [];
    for (const a of admins) {
        const now = a.pubkey.toLowerCase();
        if (pin.trusted.includes(now)) continue;
        for (const was of pin.trusted) {
            const name = pin.names[was];
            if (was !== now && !listed.has(was) && name && sameName(name, a.callsign)) out.push({ callsign: a.callsign, was, now });
        }
    }
    return out;
}

/**
 * The pin with each changed key's old key moved from trusted to replaced (see {@link namesKeyChanges}), noticed while
 * the server's current generation is `generation`.
 */
export function pinKeyChanges(pin: NamesTrustPin, changes: { callsign: string; was: string }[], generation: number): NamesTrustPin {
    if (changes.length === 0) return pin;
    const gone = new Set(changes.map((c) => c.was));
    const names = { ...pin.names };
    const replaced = { ...pin.replaced };
    for (const c of changes) { replaced[c.was] = { callsign: c.callsign, at: Math.max(0, generation) }; delete names[c.was]; }
    return { ...pin, trusted: pin.trusted.filter((k) => !gone.has(k)), names, replaced };
}

/** The pin with the callsign each trusted key shows now (as the server lists it), for noticing a key change next time. */
export function pinCallsigns(pin: NamesTrustPin, admins: NamesAdminName[]): NamesTrustPin {
    const names = { ...pin.names };
    for (const a of admins) if (pin.trusted.includes(a.pubkey.toLowerCase())) names[a.pubkey.toLowerCase()] = a.callsign;
    return { ...pin, names };
}

// ── Checking a key in person ─────────────────────────────────────────────────────────────────

/** What an admin's phone shows as a QR code: its own identity key, nothing else. */
export const NAMES_KEY_QR_PREFIX = 'beanpool-admin-key:v1:';

export function namesKeyQr(pubkey: string): string {
    return `${NAMES_KEY_QR_PREFIX}${pubkey.toLowerCase()}`;
}

/**
 * A key's code, to compare by eye or read aloud when scanning isn't possible: 20 digits in five groups (about 66 bits,
 * from SHA-256 of the key), so nobody can make a key of their own with the same code.
 */
export function namesKeyCode(pubkey: string): string {
    const h = sha256(utf8ToBytes(`beanpool-key-code-v1\n${pubkey.toLowerCase()}`));
    const groups: string[] = [];
    for (let i = 0; i < 5; i++) {
        const n = ((h[4 * i] << 24) >>> 0) + (h[4 * i + 1] << 16) + (h[4 * i + 2] << 8) + h[4 * i + 3];
        groups.push(String(n % 10000).padStart(4, '0'));
    }
    return groups.join(' ');
}

/** What was scanned or typed: a key from an admin's QR code, or a 20-digit code; null for anything else. */
export function readNamesKeyCheck(text: unknown): { kind: 'key'; pubkey: string } | { kind: 'code'; digits: string } | null {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (t.startsWith(NAMES_KEY_QR_PREFIX)) {
        const pubkey = t.slice(NAMES_KEY_QR_PREFIX.length).toLowerCase();
        return HEX_KEY.test(pubkey) ? { kind: 'key', pubkey } : null;
    }
    if (!/^[\d\s-]+$/.test(t)) return null;
    const digits = t.replace(/\D/g, '');
    return digits.length === 20 ? { kind: 'code', digits } : null;
}

/** Whether what was scanned or typed is `pubkey`'s: its QR code, or its code. */
export function namesKeyCheckMatches(text: unknown, pubkey: string): boolean {
    const read = readNamesKeyCheck(text);
    if (!read || !HEX_KEY.test(pubkey.toLowerCase())) return false;
    if (read.kind === 'key') return read.pubkey === pubkey.toLowerCase();
    return read.digits === namesKeyCode(pubkey).replace(/\D/g, '');
}

/** The pin once this phone's admin checked `pubkey` in person: trusted, under `callsign`, and no longer dropped or replaced. */
export function pinCheckedKey(pin: NamesTrustPin, pubkey: string, callsign: string): NamesTrustPin {
    const k = pubkey.toLowerCase();
    const dropped = { ...pin.dropped };
    const replaced = { ...pin.replaced };
    delete dropped[k];
    delete replaced[k];
    return { ...pin, trusted: [...new Set([...pin.trusted, k])].sort(), names: { ...pin.names, [k]: callsign }, dropped, replaced };
}

/**
 * Whether this phone may share the list with an admin the server lists: only a key it trusts (`trusted`). `changed`: the
 * key isn't trusted, and the callsign is one this phone trusted on a key that was replaced. `check`: a key this phone
 * hasn't checked. Either way, never on the callsign alone.
 */
export function namesShareCheck(pin: NamesTrustPin | null, admin: NamesAdminName): 'trusted' | 'changed' | 'check' {
    const k = admin.pubkey.toLowerCase();
    if (pin?.trusted.includes(k)) return 'trusted';
    if (pin && Object.values(pin.replaced).some((r) => sameName(r.callsign, admin.callsign))) return 'changed';
    return 'check';
}
