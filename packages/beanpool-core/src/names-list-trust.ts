/**
 * Whom an admin's phone takes the names list's keys from, and gives them to (scratch/global-node/
 * DESIGN-names-list-trust-fable.md, the redesign of PR #1411's trust layer after five review rounds). The server is not
 * trusted with this: whoever runs it can write any row and, through `node_roles` (the owner password), make any key an
 * admin or move any account to a new key. Everything the server says is used to remove trust, to find candidates, or to
 * deliver data that is signed or sealed. Its word never adds trust and never adds a key.
 *
 * ## Three parts and nothing else
 *
 * 1. **A signed, hash-chained history of the list's keys.** A generation is a statement (*maker, parent, drops*) signed
 *    by its maker ({@link makeNamesGeneration}); its id is the SHA-256 of the signed bytes, always recomputed here, never
 *    taken from the server. A phone appends to its own copy of the history (its pin's `chain`) only a statement whose
 *    parent is its head and whose maker it trusts ({@link syncNames}, rule 1). The pin is a cursor: nothing older is
 *    ever re-read to decide anything.
 * 2. **A key ring, not re-sealing.** Each entry stays sealed under the key it was written under. A share hands over every
 *    key the sharer holds, sealed to the recipient, in one box, under a header the sharer signs
 *    ({@link makeNamesShare}). A new key locks nothing and carries nothing over.
 * 3. **Trust comes from people; drops come from the history.** A phone trusts a key it checked in person
 *    ({@link checkNamesKeyInPerson}), or a key vouched by a key it trusts (the `trusts` of a signed share header). It
 *    drops a key only through a statement it accepted. A dropped key comes back only through a share header made by a
 *    trusted phone at or after the drop: a person checked it again.
 *
 * ## The five rules (design §3.2)
 *
 * 1. **Accept.** A statement is appended only if its signature verifies for its maker, its community is the pin's, its
 *    parent is this phone's head (or `-` with an empty chain), its number is the head's plus one, and its maker is
 *    trusted. Accepting applies its drops (never this phone's own key, never the maker's).
 * 2. **Trust.** `trusted` grows only by an in-person check here, or by a header signed by a trusted key, for each key in
 *    its `trusts`; a dropped key is re-admitted only by a header whose head is on this phone's chain at or after the drop.
 *    It shrinks only by rule 1.
 * 3. **Keys.** A key enters the ring only from a box opened here under a header a trusted key signed, and only for a
 *    statement this phone accepted; or from a statement this phone made itself.
 * 4. **Seal.** A phone writes only under its head's key, and only when the server's current is its head.
 * 5. **Give.** A phone shares its whole ring, and its `trusted` list, only to trusted keys the server lists as admins,
 *    without a tap. It makes a new generation, dropping them, for any trusted key the server no longer lists as an admin,
 *    and for any key its admin chose to remove.
 *
 * ## One extension: a history a trusted admin vouches for (this builder's, 2026-10-02)
 *
 * Rule 1 alone leaves a new admin's phone stuck for good once any earlier maker has left: the admin it checks no longer
 * trusts that maker, so nothing vouches for them, and the first statement can never be taken. So a statement whose
 * parent is this phone's head may also be accepted when a trusted admin's signed share header names a head whose
 * history (by parent links, through the statements the server shows) includes it, and its maker was never dropped on
 * this phone. That admin's phone accepted it under the same rules, so it adds nothing the proof (design §6) doesn't
 * already rest on: a key in `trusted` is an honest admin's phone. It never takes a statement off another parent, so a
 * phone that saw a drop still refuses whatever a dropped key makes after it.
 *
 * ## What this doesn't protect against (the app and the guide say the same)
 *
 * A check made with the wrong person; a phone someone else gets into; a lost phone until an admin removes its key (or
 * the server's role change does); and a server that hides things, which costs availability, never confidentiality.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEd25519Seed } from './ed25519-key.js';
import {
    isNamesKeyId, isNamesRingBox, namesBoxDigest, newNamesListKey, openNamesRing, sealNamesRing, NAMES_LIMITS,
    type NamesRingBox,
} from './names-list-crypto.js';

/** What a generation's signed bytes start with: the domain its signature is for, and nothing else. */
export const NAMES_GEN_STATEMENT = 'beanpool-names-gen-v2';
/** What a share header's signed bytes start with. */
export const NAMES_SHARE_STATEMENT = 'beanpool-names-share-v2';

/** How much a phone reads (design §4.1): anything beyond is ignored, and said. */
export const NAMES_TRUST_BOUNDS = {
    /** Keys in one statement's `drops` or one header's `trusts`. */
    keys: 50,
    generations: 5000,
    shares: 2500,
} as const;

const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/;
/** A community's id (genesis.json `communityId`): 16 lower-case hex characters, or anything short and plain in a test. */
const COMMUNITY_ID = /^[0-9A-Za-z_-]{1,64}$/;
const WHOLE = /^[1-9][0-9]{0,8}$/;

export function isNamesCommunityId(id: unknown): id is string {
    return typeof id === 'string' && COMMUNITY_ID.test(id);
}

const lower = (k: string) => k.toLowerCase();

/** A list of admin keys as a statement carries them: lower-case, each once, sorted. Throws on anything but keys. */
export function normaliseNamesKeys(raw: unknown, max: number = NAMES_TRUST_BOUNDS.keys): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > max) throw new Error(`A list of at most ${max} admin keys.`);
    const out = new Set<string>();
    for (const k of raw) {
        const hex = typeof k === 'string' ? lower(k) : '';
        if (!HEX_KEY.test(hex)) throw new Error('Each admin key is 64 hexadecimal characters.');
        out.add(hex);
    }
    return [...out].sort();
}

function idsLine(ids: string[], max: number, what: string): string {
    if (ids.length > max) throw new Error(`At most ${max} ${what}.`);
    for (const id of ids) if (!HEX_KEY.test(id)) throw new Error(`Each of the ${what} is 64 hexadecimal characters.`);
    const sorted = [...new Set(ids)].sort();
    if (sorted.length !== ids.length || sorted.some((v, i) => v !== ids[i])) throw new Error(`The ${what} are sorted, each once.`);
    return ids.join(',');
}

function readIdsLine(line: string, max: number): string[] | null {
    if (line === '') return [];
    const ids = line.split(',');
    if (ids.length > max || ids.some((id) => !HEX_KEY.test(id))) return null;
    for (let i = 1; i < ids.length; i++) if (ids[i - 1] >= ids[i]) return null;
    return ids;
}

function seedOf(privateKey: string | Uint8Array): Uint8Array {
    return toEd25519Seed(typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey);
}

/** An admin's keys as a phone holds them: the public key, and the identity key (raw seed or PKCS8, hex or bytes). */
export interface NamesSigner {
    publicKey: string;
    privateKey: string | Uint8Array;
}

function sign(text: string, signer: NamesSigner): string {
    const seed = seedOf(signer.privateKey);
    if (bytesToHex(ed25519.getPublicKey(seed)) !== lower(signer.publicKey)) throw new Error('A statement is signed by the key it names.');
    return bytesToHex(ed25519.sign(utf8ToBytes(text), seed));
}

function verify(text: string, signature: unknown, key: string): boolean {
    if (typeof signature !== 'string' || !HEX_SIG.test(signature)) return false;
    try {
        return ed25519.verify(hexToBytes(signature), utf8ToBytes(text), hexToBytes(key));
    } catch {
        return false;
    }
}

/** A statement's id: the SHA-256 of its signed bytes, in hex. */
export function namesStatementId(text: string): string {
    return bytesToHex(sha256(utf8ToBytes(text)));
}

// ── Generations ──────────────────────────────────────────────────────────────────────────────

/** What a generation says. */
export interface NamesGenerationClaim {
    communityId: string;
    /** 1 for the first, the parent's plus one after. */
    n: number;
    /** The previous statement's id; null only for the first. */
    parentId: string | null;
    maker: string;
    /** The keys this generation removes: lower-case, sorted, each once; may be empty. */
    drops: string[];
}

/** A generation as a phone holds it once checked: the claim, read from the signed bytes, and their id. */
export interface NamesGeneration extends NamesGenerationClaim {
    id: string;
    statement: string;
    signature: string;
}

/** The bytes a generation's maker signs, as text (every character ASCII). */
export function namesGenerationStatement(c: NamesGenerationClaim): string {
    if (!isNamesCommunityId(c.communityId)) throw new Error('A community id is needed to make a generation.');
    if (!Number.isSafeInteger(c.n) || c.n < 1 || c.n > 999_999_999) throw new Error('A generation is a whole number from 1.');
    if (c.n === 1 && c.parentId !== null) throw new Error('The first generation has no parent.');
    if (c.n > 1 && (c.parentId === null || !HEX_KEY.test(c.parentId))) throw new Error('A generation after the first names its parent’s id.');
    if (!HEX_KEY.test(c.maker)) throw new Error('A maker is a key of 64 hexadecimal characters.');
    const drops = idsLine(c.drops, NAMES_TRUST_BOUNDS.keys, 'dropped keys');
    return [NAMES_GEN_STATEMENT, c.communityId, String(c.n), c.parentId ?? '-', c.maker, drops].join('\n');
}

/** A new generation made and signed by `maker`. Its key is made apart ({@link newNamesListKey}). */
export function makeNamesGeneration(claim: Omit<NamesGenerationClaim, 'maker'>, maker: NamesSigner): NamesGeneration {
    const full: NamesGenerationClaim = { ...claim, maker: lower(maker.publicKey), drops: normaliseNamesKeys(claim.drops) };
    const statement = namesGenerationStatement(full);
    return { ...full, id: namesStatementId(statement), statement, signature: sign(statement, maker) };
}

/**
 * A generation from what the server sent (`{ statement, signature }`; anything else it says is ignored): parsed from
 * the bytes, which must be in the one form {@link namesGenerationStatement} makes, its id computed here, and its
 * signature checked for the maker it names. Null for anything else. `known` holds ids already accepted, whose
 * signatures were checked then.
 */
export function readNamesGeneration(raw: unknown, communityId?: string, known?: ReadonlySet<string>): NamesGeneration | null {
    if (!raw || typeof raw !== 'object') return null;
    const { statement, signature } = raw as { statement?: unknown; signature?: unknown };
    if (typeof statement !== 'string' || statement.length > 4000 || typeof signature !== 'string') return null;
    const lines = statement.split('\n');
    if (lines.length !== 6 || lines[0] !== NAMES_GEN_STATEMENT || !isNamesCommunityId(lines[1]) || !WHOLE.test(lines[2])) return null;
    if (communityId !== undefined && lines[1] !== communityId) return null;
    const n = Number(lines[2]);
    const parentId = lines[3] === '-' ? null : lines[3];
    if ((n === 1) !== (parentId === null)) return null;
    if (parentId !== null && !HEX_KEY.test(parentId)) return null;
    if (!HEX_KEY.test(lines[4])) return null;
    const drops = readIdsLine(lines[5], NAMES_TRUST_BOUNDS.keys);
    if (!drops) return null;
    const id = namesStatementId(statement);
    const sig = lower(signature);
    if (!known?.has(id) && !verify(statement, sig, lines[4])) return null;
    return { communityId: lines[1], n, parentId, maker: lines[4], drops, id, statement, signature: sig };
}

// ── Shares ───────────────────────────────────────────────────────────────────────────────────

/** What a share's header says. */
export interface NamesShareClaim {
    communityId: string;
    from: string;
    to: string;
    /** The sharer's head when it shared. */
    headId: string;
    /** The ids whose keys are in the box. */
    keyIds: string[];
    /** Every key the sharer trusts, itself included: its vouch. */
    trusts: string[];
    boxDigest: string;
}

/** A share as a phone holds it once checked: the header read from its signed bytes, and the box where it came with one. */
export interface NamesShare extends NamesShareClaim {
    header: string;
    signature: string;
    /** The box, only where it was sent and its digest is the header's; null otherwise. */
    box: NamesRingBox | null;
}

/** The bytes a sharer signs, as text. */
export function namesShareHeader(c: NamesShareClaim): string {
    if (!isNamesCommunityId(c.communityId)) throw new Error('A community id is needed to share.');
    for (const k of [c.from, c.to, c.headId, c.boxDigest]) if (!HEX_KEY.test(k)) throw new Error('A share names keys and ids of 64 hexadecimal characters.');
    return [
        NAMES_SHARE_STATEMENT, c.communityId, c.from, c.to, c.headId,
        idsLine(c.keyIds, NAMES_LIMITS.ringKeys, 'key ids'), idsLine(c.trusts, NAMES_TRUST_BOUNDS.keys, 'trusted keys'), c.boxDigest,
    ].join('\n');
}

/**
 * A share from `from` to `to`: every key in `ring` sealed to `to` in one box, under a header `from` signs naming its
 * head, the ids in the box, and every key it trusts.
 */
export function makeNamesShare(opts: {
    communityId: string; from: NamesSigner; to: string; headId: string; ring: Record<string, Uint8Array>; trusts: string[];
}): NamesShare {
    const from = lower(opts.from.publicKey);
    const to = lower(opts.to);
    const box = sealNamesRing(opts.ring, { communityId: opts.communityId, from, to, headId: opts.headId });
    const claim: NamesShareClaim = {
        communityId: opts.communityId, from, to, headId: opts.headId, keyIds: Object.keys(opts.ring).sort(),
        trusts: normaliseNamesKeys([...opts.trusts, from]), boxDigest: namesBoxDigest(box),
    };
    const header = namesShareHeader(claim);
    return { ...claim, header, signature: sign(header, opts.from), box };
}

/** A share from what the server sent (`{ header, signature, box? }`): parsed, checked, its box kept only where its digest matches. */
export function readNamesShare(raw: unknown, communityId?: string): NamesShare | null {
    if (!raw || typeof raw !== 'object') return null;
    const { header, signature, box } = raw as { header?: unknown; signature?: unknown; box?: unknown };
    if (typeof header !== 'string' || header.length > 80_000 || typeof signature !== 'string') return null;
    const lines = header.split('\n');
    if (lines.length !== 8 || lines[0] !== NAMES_SHARE_STATEMENT || !isNamesCommunityId(lines[1])) return null;
    if (communityId !== undefined && lines[1] !== communityId) return null;
    const [from, to, headId] = [lines[2], lines[3], lines[4]];
    if (![from, to, headId, lines[7]].every((k) => HEX_KEY.test(k))) return null;
    const keyIds = readIdsLine(lines[5], NAMES_LIMITS.ringKeys);
    const trusts = readIdsLine(lines[6], NAMES_TRUST_BOUNDS.keys);
    if (!keyIds || !trusts || keyIds.length === 0) return null;
    const sig = lower(signature);
    if (!verify(header, sig, from)) return null;
    const kept = isNamesRingBox(box) && namesBoxDigest(box) === lines[7] ? box : null;
    return { communityId: lines[1], from, to, headId, keyIds, trusts, boxDigest: lines[7], header, signature: sig, box: kept };
}

// ── The pin ──────────────────────────────────────────────────────────────────────────────────

/** A statement this phone accepted, as its pin keeps it. */
export interface NamesChainLink {
    statement: string;
    signature: string;
    id: string;
    n: number;
}

/** A statement this phone made and may not have landed, with its key: saved before the request (design §8). */
export interface NamesPending extends NamesChainLink {
    /** The generation's key, hex. */
    key: string;
}

/**
 * What an admin's phone keeps for one community (by its own key and the community's address, both the phone's own
 * values; sealed at rest under a key in the phone's secure store). Nothing else: no callsigns, no server numbers.
 */
export interface NamesPin {
    v: 3;
    communityId: string;
    me: string;
    /** Every key this phone trusts; `me` always. */
    trusted: string[];
    /** Keys dropped, by the number of the generation that dropped them on this phone. */
    dropped: Record<string, number>;
    /** The statements this phone accepted, in order; the head is the last. */
    chain: NamesChainLink[];
    /** Statements accepted, then left behind by "Take @X's history" (design §4.3.9); usually empty. */
    abandoned: string[];
    /** The keys this phone holds, by generation id (hex): only ids in `chain` or `abandoned`. */
    ring: Record<string, string>;
    pending: NamesPending | null;
    /** Keys this phone's admin chose to remove, until the generation that drops them lands. */
    manualDrops: string[];
    /** Entries last seen, for the rollback message. */
    lastCount: number;
}

/** A pin that trusts no one yet but this phone. */
export function emptyNamesPin(communityId: string, me: string): NamesPin {
    return { v: 3, communityId, me: lower(me), trusted: [lower(me)], dropped: {}, chain: [], abandoned: [], ring: {}, pending: null, manualDrops: [], lastCount: 0 };
}

function readLink(raw: unknown): NamesChainLink | null {
    const g = readNamesGeneration(raw, undefined, new Set([namesStatementId(String((raw as { statement?: unknown })?.statement ?? ''))]));
    return g ? { statement: g.statement, signature: g.signature, id: g.id, n: g.n } : null;
}

/**
 * The pin as this phone saved it, for `me`, or null when it isn't one (another phone's, another version, or damaged:
 * then the phone starts from an empty pin, which trusts nobody but itself). Its chain must link, parent to child,
 * number by number; only its first statement may have a parent this phone never accepted (a start again, §4.3.1).
 */
export function readNamesPin(raw: unknown, me: string): NamesPin | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    if (p.v !== 3 || !isNamesCommunityId(p.communityId) || p.me !== lower(me)) return null;
    try {
        const trusted = normaliseNamesKeys(p.trusted, 10_000);
        const dropped: Record<string, number> = {};
        for (const [k, n] of Object.entries((p.dropped && typeof p.dropped === 'object' ? p.dropped : {}) as Record<string, unknown>)) {
            if (!HEX_KEY.test(k) || !Number.isSafeInteger(n) || (n as number) < 1) return null;
            dropped[k] = n as number;
        }
        if (!Array.isArray(p.chain) || !Array.isArray(p.abandoned) || !Array.isArray(p.manualDrops)) return null;
        const chain: NamesChainLink[] = [];
        let prev: NamesGeneration | null = null;
        for (const raw of p.chain) {
            const link = readLink(raw);
            if (!link) return null;
            const g = readNamesGeneration(link, p.communityId as string, new Set([link.id]))!;
            if (prev && (g.parentId !== prev.id || g.n !== prev.n + 1)) return null;
            chain.push(link);
            prev = g;
        }
        const abandoned = p.abandoned.filter((id): id is string => isNamesKeyId(id));
        const ids = new Set([...chain.map((l) => l.id), ...abandoned]);
        const ring: Record<string, string> = {};
        for (const [id, k] of Object.entries((p.ring && typeof p.ring === 'object' ? p.ring : {}) as Record<string, unknown>)) {
            if (ids.has(id) && typeof k === 'string' && HEX_KEY.test(k)) ring[id] = k;
        }
        let pending: NamesPending | null = null;
        if (p.pending) {
            const link = readLink(p.pending);
            const key = (p.pending as { key?: unknown }).key;
            if (link && typeof key === 'string' && HEX_KEY.test(key)) pending = { ...link, key };
        }
        const lastCount = Number.isSafeInteger(p.lastCount) && (p.lastCount as number) >= 0 ? (p.lastCount as number) : 0;
        return {
            v: 3, communityId: p.communityId as string, me: lower(me), trusted: [...new Set([...trusted, lower(me)])].sort(), dropped, chain, abandoned, ring, pending,
            manualDrops: normaliseNamesKeys(p.manualDrops, 10_000), lastCount,
        };
    } catch {
        return null;
    }
}

const headOf = (pin: Pick<NamesPin, 'chain'>): NamesChainLink | null => pin.chain[pin.chain.length - 1] ?? null;

/** The pin once this phone's admin checked `key` in person (design §3.3): trusted, and no longer dropped or due to be removed. */
export function checkNamesKeyInPerson(pin: NamesPin, key: string): NamesPin {
    const k = lower(key);
    if (!HEX_KEY.test(k)) return pin;
    const dropped = { ...pin.dropped };
    delete dropped[k];
    return { ...pin, trusted: [...new Set([...pin.trusted, k])].sort(), dropped, manualDrops: pin.manualDrops.filter((m) => m !== k) };
}

/** "Remove @X's old key" (design §4.3.2): the key goes into the next generation this phone makes. Never this phone's own. */
export function removeNamesKey(pin: NamesPin, key: string): NamesPin {
    const k = lower(key);
    if (!HEX_KEY.test(k) || k === pin.me || !pin.trusted.includes(k)) return pin;
    return { ...pin, manualDrops: [...new Set([...pin.manualDrops, k])].sort() };
}

// ── What the server says ─────────────────────────────────────────────────────────────────────

/** An admin as the server lists them, with the key ids it says they hold (a liveness hint: made, or named in a share). */
export interface NamesServerAdmin {
    pubkey: string;
    callsign?: string;
    keyIds?: string[];
}

/** What {@link syncNames} reads from the server's `GET /api/names/state`. Everything is checked or used only as a hint. */
export interface NamesServerState {
    communityId: unknown;
    current: { id: string; n: number } | null;
    generations: unknown[];
    shares: unknown[];
    admins: NamesServerAdmin[];
    nobodyHoldsKey?: boolean;
    newKeyNeeded?: boolean;
}

/** Why a phone reads and writes nothing. Exactly these (design §10 D8). */
export const NAMES_REFUSAL_REASONS = ['other_community', 'untrusted_maker', 'missing_record', 'different_history', 'rolled_back'] as const;
export type NamesRefusalReason = (typeof NAMES_REFUSAL_REASONS)[number];

export type NamesPlan =
    /** This phone holds the head's key and the server's current is its head: the only plan that reads or writes. */
    | { kind: 'ready' }
    /** The list has no history yet: this phone makes the first generation, without asking. */
    | { kind: 'make_first' }
    /** This phone makes the next generation, dropping `drops`, without asking (it only removes trust). */
    | { kind: 'make_new'; drops: string[] }
    /**
     * This phone doesn't hold the head's key (or must wait for a holder to make a new one): `holders` are the trusted
     * admins the server says hold it. `canMakeNew`: nobody who is an admin holds it, so this phone may make a new key off
     * its head (asked first), and what was sealed under the old one stays locked.
     */
    | { kind: 'wait'; keyId: string; n: number; holders: string[]; newKeyNeeded: boolean; canMakeNew: boolean; drops: string[] }
    | {
        kind: 'refused';
        reason: NamesRefusalReason;
        /** untrusted_maker: who made the statement this phone stops at, its number, and whether the server lists them as an admin. */
        maker?: string;
        n?: number;
        canCheck?: boolean;
        /** untrusted_maker on an empty chain: nobody holds the current key, so this phone may start again (asked first). */
        canStartAgain?: boolean;
        /** rolled_back: what the server offers, and this phone's head. */
        offered?: { id: string; n: number } | null;
        newest?: { id: string; n: number };
    };

export type NamesNotice =
    /** A trusted admin made a generation that named this phone as dropped (ignored; design §10 C7). */
    | { kind: 'dropped_me'; maker: string; n: number }
    /** Two trusted admins sent different keys for one generation: the first is kept (A6). */
    | { kind: 'different_keys'; id: string; n: number; from: string }
    /** A trusted admin's phone is on a key history this phone didn't take (§4.3.10). */
    | { kind: 'other_history'; who: string }
    /** A generation this phone accepted dropped these keys (for the screen's "the list has a new key because…"). */
    | { kind: 'dropped'; maker: string; n: number; keys: string[] }
    /** The server sent more than the phone reads (§4.1 bounds). */
    | { kind: 'too_many'; what: 'generations' | 'shares' };

export interface NamesSyncResult {
    /** The pin after this open; the pin as it was on `other_community`. */
    pin: NamesPin;
    plan: NamesPlan;
    /** Trusted keys the server no longer lists as admins, and the ones this phone's admin chose to remove. */
    toDrop: string[];
    notices: NamesNotice[];
    /** The statements the server sent that check out, by id. */
    generations: Map<string, NamesGeneration>;
}

/** The ancestors of `id` (itself first) through the statements in `gens`, by parent links; stops at a gap. */
function pathBack(gens: Map<string, NamesGeneration>, id: string | null | undefined): { ids: string[]; complete: boolean } {
    const ids: string[] = [];
    let at = id ?? null;
    const seen = new Set<string>();
    while (at && ids.length <= NAMES_TRUST_BOUNDS.generations) {
        if (seen.has(at)) return { ids, complete: false };
        seen.add(at);
        const g = gens.get(at);
        if (!g) return { ids, complete: false };
        ids.push(at);
        if (g.parentId === null) return { ids, complete: true };
        const parent = gens.get(g.parentId);
        if (parent && parent.n !== g.n - 1) return { ids, complete: false };
        at = g.parentId;
    }
    return { ids, complete: false };
}

/**
 * Every open, before anything is read or written (design §4.1): pure, idempotent, and monotone in the direction the
 * server can't abuse. Extends this phone's chain by the server's statements under rule 1, takes vouches (rule 2) and
 * keys (rule 3) from the share headers trusted keys signed, and works out what to do ({@link planNames}).
 */
export function syncNames(input: { pin: NamesPin | null; state: NamesServerState; me: NamesSigner }): NamesSyncResult {
    const me = lower(input.me.publicKey);
    const { state } = input;
    const communityId = typeof state.communityId === 'string' ? state.communityId : '';
    const given = input.pin;
    const pin0 = given ?? emptyNamesPin(isNamesCommunityId(communityId) ? communityId : '-', me);
    const notices: NamesNotice[] = [];
    if (!isNamesCommunityId(communityId) || pin0.communityId !== communityId) {
        return { pin: pin0, plan: { kind: 'refused', reason: 'other_community' }, toDrop: [], notices, generations: new Map() };
    }

    // The records, checked here. A statement already on this chain was checked when it was accepted.
    const accepted = new Set([...pin0.chain.map((l) => l.id), ...pin0.abandoned]);
    const rawGens = Array.isArray(state.generations) ? state.generations : [];
    if (rawGens.length > NAMES_TRUST_BOUNDS.generations) notices.push({ kind: 'too_many', what: 'generations' });
    const gens = new Map<string, NamesGeneration>();
    for (const r of rawGens.slice(0, NAMES_TRUST_BOUNDS.generations)) {
        const g = readNamesGeneration(r, communityId, accepted);
        if (g) gens.set(g.id, g);
    }
    // This phone's own chain stands whatever the server shows: its statements are known here.
    for (const l of pin0.chain) {
        const g = gens.has(l.id) ? null : readNamesGeneration(l, communityId, accepted);
        if (g) gens.set(g.id, g);
    }
    const rawShares = Array.isArray(state.shares) ? state.shares : [];
    if (rawShares.length > NAMES_TRUST_BOUNDS.shares) notices.push({ kind: 'too_many', what: 'shares' });
    const shares = rawShares.slice(0, NAMES_TRUST_BOUNDS.shares).map((r) => readNamesShare(r, communityId)).filter((s): s is NamesShare => !!s)
        .sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));

    const byParent = new Map<string, NamesGeneration[]>();
    for (const g of gens.values()) {
        const key = g.parentId ?? '-';
        byParent.set(key, [...(byParent.get(key) ?? []), g]);
    }
    const curId = state.current && isNamesKeyId(state.current.id) ? state.current.id : null;
    const onServerPath = new Set(pathBack(gens, curId).ids);

    const T = new Set([...pin0.trusted, me]);
    const D: Record<string, number> = { ...pin0.dropped };
    const chain = [...pin0.chain];
    const position = new Map(chain.map((l) => [l.id, l.n] as const));
    const ring: Record<string, string> = { ...pin0.ring };
    const abandoned = [...pin0.abandoned];
    let pending = pin0.pending;
    let manualDrops = [...pin0.manualDrops];

    const accept = (g: NamesGeneration) => {
        chain.push({ statement: g.statement, signature: g.signature, id: g.id, n: g.n });
        position.set(g.id, g.n);
        if (pending && pending.id === g.id) {
            ring[g.id] = pending.key;
            pending = null;
        }
        const out: string[] = [];
        for (const d of g.drops) {
            if (d === me) { notices.push({ kind: 'dropped_me', maker: g.maker, n: g.n }); continue; }
            if (d === g.maker) continue;
            if (T.delete(d)) out.push(d);
            D[d] = g.n;
        }
        if (out.length && g.maker !== me) notices.push({ kind: 'dropped', maker: g.maker, n: g.n, keys: out });
        manualDrops = manualDrops.filter((k) => !g.drops.includes(k));
    };

    const histories = new Map<string, Set<string>>();
    const historyOf = (id: string) => {
        if (!histories.has(id)) histories.set(id, new Set(pathBack(gens, id).ids));
        return histories.get(id)!;
    };
    /** Whether a trusted admin's header names a head whose history includes `g` (the extension in the header). */
    const vouchedHistory = (g: NamesGeneration): boolean => {
        if (g.maker in D) return false;
        return shares.some((w) => w.from !== me && T.has(w.from) && historyOf(w.headId).has(g.id));
    };

    const opened = new Map<NamesShare, Record<string, Uint8Array> | null>();
    const openBox = (w: NamesShare) => {
        if (!opened.has(w)) {
            try {
                opened.set(w, openNamesRing(w.box!, input.me.privateKey, { communityId, from: w.from, to: me, headId: w.headId }));
            } catch {
                opened.set(w, null);
            }
        }
        return opened.get(w)!;
    };

    for (let round = 0; round < 10_000; round++) {
        let changed = false;
        // 0. This phone's own start-again statement (§4.3.1), the one first link whose parent it never accepted.
        if (chain.length === 0 && pending && gens.get(pending.id)?.maker === me) {
            accept(gens.get(pending.id)!);
            changed = true;
        }
        // 1. Extend the chain, in order.
        for (;;) {
            const head = chain[chain.length - 1];
            const want = head ? head.id : '-';
            const n = head ? head.n + 1 : 1;
            const cands = (byParent.get(want) ?? []).filter((g) => g.n === n && !position.has(g.id) && !abandoned.includes(g.id))
                .sort((a, b) => a.id.localeCompare(b.id));
            if (cands.length === 0) break;
            const pick = cands.find((g) => onServerPath.has(g.id)) ?? cands.find((g) => T.has(g.maker)) ?? cands[0];
            if (!T.has(pick.maker) && !vouchedHistory(pick)) break;
            accept(pick);
            changed = true;
        }
        // 2. Vouches, one header at a time; after one adds anyone, the chain is extended again first, so a drop it then
        // reaches applies before the next header is read.
        for (const w of shares) {
            if (w.from === me || !T.has(w.from)) continue;
            let added = false;
            for (const k of w.trusts) {
                if (k === me || T.has(k)) continue;
                if (!(k in D)) {
                    T.add(k);
                    added = true;
                } else if (position.has(w.headId) && position.get(w.headId)! >= D[k]) {
                    T.add(k);
                    delete D[k];
                    added = true;
                }
            }
            if (added) { changed = true; break; }
        }
        if (changed) continue;
        // 3. Keys, from boxes to this phone under headers trusted keys signed, for statements this phone accepted.
        for (const w of shares) {
            if (w.to !== me || !w.box || !T.has(w.from)) continue;
            const keys = openBox(w);
            if (!keys) continue;
            for (const [id, k] of Object.entries(keys)) {
                if (!w.keyIds.includes(id) || !(position.has(id) || abandoned.includes(id))) continue;
                const hex = bytesToHex(k);
                if (ring[id] === undefined) ring[id] = hex;
                else if (ring[id] !== hex && !notices.some((x) => x.kind === 'different_keys' && x.id === id)) {
                    notices.push({ kind: 'different_keys', id, n: position.get(id) ?? gens.get(id)?.n ?? 0, from: w.from });
                }
            }
        }
        break;
    }

    // A statement this phone made that never landed (§8): kept while its parent is still the server's current, so the
    // next open sends it again; dropped once the server moved on (the winner was taken above, by rule 1).
    if (pending && !position.has(pending.id) && !gens.has(pending.id) && pending.statement.split('\n')[3] !== (curId ?? '-')) pending = null;

    // §4.3.10: a trusted admin's newest header whose head is neither on this chain nor ahead of it on the server's path.
    const newestFrom = new Map<string, NamesShare>();
    for (const w of shares) {
        if (w.from === me || !T.has(w.from)) continue;
        const prev = newestFrom.get(w.from);
        const n = gens.get(w.headId)?.n ?? 0;
        if (!prev || n > (gens.get(prev.headId)?.n ?? 0)) newestFrom.set(w.from, w);
    }
    for (const [who, w] of chain.length > 0 ? newestFrom : new Map<string, NamesShare>()) {
        if (position.has(w.headId)) continue;
        const ahead = historyOf(w.headId).has(chain[chain.length - 1].id) && onServerPath.has(w.headId);
        if (!ahead) notices.push({ kind: 'other_history', who });
    }

    const admins = new Set((state.admins ?? []).map((a) => lower(String(a.pubkey ?? ''))));
    manualDrops = manualDrops.filter((k) => T.has(k) && k !== me);
    const toDrop = [...new Set([...[...T].filter((k) => k !== me && !admins.has(k)), ...manualDrops])].sort().slice(0, NAMES_TRUST_BOUNDS.keys);
    const pin: NamesPin = {
        v: 3, communityId, me, trusted: [...T].sort(), dropped: D, chain, abandoned, ring, pending, manualDrops, lastCount: pin0.lastCount,
    };
    return { pin, plan: planNames(pin, state, toDrop, gens), toDrop, notices, generations: gens };
}

/** The trusted admins the server says hold key `id`. */
export function namesTrustedHolders(pin: Pick<NamesPin, 'trusted' | 'me'>, state: Pick<NamesServerState, 'admins'>, id: string): string[] {
    return (state.admins ?? []).filter((a) => a.pubkey !== pin.me && pin.trusted.includes(lower(a.pubkey)) && (a.keyIds ?? []).includes(id)).map((a) => lower(a.pubkey));
}

/** What to do, from the synced pin and the server's state (design §4.2). */
export function planNames(pin: NamesPin, state: NamesServerState, toDrop: string[], gens: Map<string, NamesGeneration>): NamesPlan {
    const curId = state.current && isNamesKeyId(state.current.id) ? state.current.id : null;
    const cur = curId ? gens.get(curId) : undefined;
    const head = headOf(pin);
    const isAdmin = (k: string) => (state.admins ?? []).some((a) => lower(a.pubkey) === k);
    if (!head) {
        if (!curId) return { kind: 'make_first' };
        if (!cur) return { kind: 'refused', reason: 'missing_record' };
        const back = pathBack(gens, curId);
        if (!back.complete) return { kind: 'refused', reason: 'missing_record' };
        const root = gens.get(back.ids[back.ids.length - 1])!;
        return { kind: 'refused', reason: 'untrusted_maker', maker: root.maker, n: root.n, canCheck: isAdmin(root.maker), canStartAgain: !!state.nobodyHoldsKey };
    }
    const position = new Map(pin.chain.map((l) => [l.id, l.n] as const));
    if (!curId) return { kind: 'refused', reason: 'rolled_back', offered: null, newest: { id: head.id, n: head.n } };
    if (!cur) return { kind: 'refused', reason: 'missing_record' };
    if (cur.id === head.id) {
        const needNew = toDrop.length > 0 || !!state.newKeyNeeded;
        const holders = namesTrustedHolders(pin, state, head.id);
        if (needNew && pin.ring[head.id]) return { kind: 'make_new', drops: toDrop };
        if (!needNew && pin.ring[head.id]) return { kind: 'ready' };
        // Nobody who is an admin holds it, or only this phone does as far as the server knows, and this phone lost it (the
        // only admin, reinstalled with the same key): a new key off this head is the way on, asked first.
        const othersHold = (state.admins ?? []).some((a) => lower(a.pubkey) !== pin.me && (a.keyIds ?? []).includes(head.id));
        return { kind: 'wait', keyId: head.id, n: head.n, holders, newKeyNeeded: needNew, canMakeNew: !!state.nobodyHoldsKey || !othersHold, drops: toDrop };
    }
    if (position.has(cur.id)) return { kind: 'refused', reason: 'rolled_back', offered: { id: cur.id, n: cur.n }, newest: { id: head.id, n: head.n } };
    if (pin.abandoned.includes(cur.id)) return { kind: 'refused', reason: 'different_history' };
    // The server's current is not on this chain: walk back from it to where it meets this chain.
    const back = pathBack(gens, curId);
    const meet = back.ids.findIndex((id) => position.has(id));
    // No statement in common: a different history where the server's path is whole, else a gap in it.
    if (meet < 0) return { kind: 'refused', reason: back.complete ? 'different_history' : 'missing_record' };
    if (back.ids[meet] !== head.id) return { kind: 'refused', reason: 'different_history' };
    const next = gens.get(back.ids[meet - 1]);
    if (!next) return { kind: 'refused', reason: 'missing_record' };
    if (pin.trusted.includes(next.maker)) return { kind: 'refused', reason: 'different_history' };
    return { kind: 'refused', reason: 'untrusted_maker', maker: next.maker, n: next.n, canCheck: isAdmin(next.maker) };
}

// ── Actions ──────────────────────────────────────────────────────────────────────────────────

/**
 * A generation this phone makes now (design §4.3.1): the first, a new one off its head, or a start again chained onto
 * the server's current (only on an empty chain, when nobody holds the current key). The pin keeps it as `pending`, with
 * its key, before anything is sent: save that pin first.
 */
export function makeNamesGenerationFor(pin: NamesPin, state: Pick<NamesServerState, 'current'>, me: NamesSigner, drops: string[], opts: { startAgain?: boolean } = {}):
    { generation: NamesGeneration; key: Uint8Array; pin: NamesPin } {
    const head = headOf(pin);
    const cur = state.current && isNamesKeyId(state.current.id) ? state.current : null;
    let n: number;
    let parentId: string | null;
    if (head) {
        n = head.n + 1;
        parentId = head.id;
    } else if (opts.startAgain && cur) {
        n = cur.n + 1;
        parentId = cur.id;
    } else {
        n = 1;
        parentId = null;
    }
    const generation = makeNamesGeneration({ communityId: pin.communityId, n, parentId, drops: drops.filter((k) => lower(k) !== pin.me) }, me);
    const key = newNamesListKey();
    return { generation, key, pin: { ...pin, pending: { statement: generation.statement, signature: generation.signature, id: generation.id, n, key: bytesToHex(key) } } };
}

/** The keys this phone holds, as bytes, by generation id. */
export function namesRingKeys(pin: Pick<NamesPin, 'ring'>): Record<string, Uint8Array> {
    return Object.fromEntries(Object.entries(pin.ring).map(([id, hex]) => [id, hexToBytes(hex)]));
}

/**
 * The shares this phone sends on this open (design §4.3.3, rule 5): to every admin the server lists whose key it trusts,
 * but itself, where the key ids the server says they hold lack one in this ring, or this phone trusts someone its last
 * header to them didn't name. Each carries the whole ring and every key this phone trusts.
 */
export function namesSharesToSend(pin: NamesPin, state: NamesServerState, me: NamesSigner, only?: string): NamesShare[] {
    const head = headOf(pin);
    if (!head || Object.keys(pin.ring).length === 0) return [];
    const mine = (Array.isArray(state.shares) ? state.shares : []).map((r) => readNamesShare(r, pin.communityId)).filter((s): s is NamesShare => !!s && s.from === pin.me);
    // Only keys of statements the server keeps: it takes a share only for ids it stores.
    const stored = new Set((Array.isArray(state.generations) ? state.generations : []).map((g) => {
        const text = (g as { statement?: unknown })?.statement;
        return typeof text === 'string' ? namesStatementId(text) : '';
    }));
    const keys = Object.fromEntries(Object.entries(namesRingKeys(pin)).filter(([id]) => stored.has(id)));
    if (!stored.has(head.id) || Object.keys(keys).length === 0) return [];
    const out: NamesShare[] = [];
    for (const a of state.admins ?? []) {
        const to = lower(a.pubkey);
        if (to === pin.me || !pin.trusted.includes(to) || (only && to !== lower(only))) continue;
        const held = new Set(a.keyIds ?? []);
        const last = mine.find((s) => s.to === to);
        // They lack a key this phone holds, or this phone trusts someone its last header to them didn't name (or it sent none).
        const due = Object.keys(keys).some((id) => !held.has(id)) || !last || pin.trusted.some((k) => !last.trusts.includes(k));
        if (!only && !due) continue;
        out.push(makeNamesShare({ communityId: pin.communityId, from: me, to, headId: head.id, ring: keys, trusts: pin.trusted }));
    }
    return out;
}

/** The statements to put back on a server rolled back to an older copy (§4.3.6): this chain's, after the server's current. */
export function namesReplay(pin: NamesPin, state: Pick<NamesServerState, 'current'>): NamesChainLink[] {
    const cur = state.current && isNamesKeyId(state.current.id) ? state.current.id : null;
    if (!cur) return [...pin.chain];
    const at = pin.chain.findIndex((l) => l.id === cur);
    return at < 0 ? [] : pin.chain.slice(at + 1);
}

/**
 * "Take @X's history" (§4.3.9; only on a different history, after checking @X at this meeting, asked first): this
 * chain is cut back to the last statement it shares with the server's path, and the statements after it are kept as
 * `abandoned` (their keys too: readable, shared, never sealed under; their drops stay applied). The next sync walks the
 * server's path from there, under rule 1.
 */
export function takeNamesHistory(pin: NamesPin, state: NamesServerState): NamesPin {
    const gens = new Map<string, NamesGeneration>();
    for (const r of (Array.isArray(state.generations) ? state.generations : []).slice(0, NAMES_TRUST_BOUNDS.generations)) {
        const g = readNamesGeneration(r, pin.communityId);
        if (g) gens.set(g.id, g);
    }
    const curId = state.current && isNamesKeyId(state.current.id) ? state.current.id : null;
    const path = new Set(pathBack(gens, curId).ids);
    let keep = pin.chain.length;
    while (keep > 0 && !path.has(pin.chain[keep - 1].id)) keep--;
    const left = pin.chain.slice(keep).map((l) => l.id);
    return { ...pin, chain: pin.chain.slice(0, keep), abandoned: [...new Set([...pin.abandoned, ...left])] };
}

/** Who made key `id` and its number, where this phone accepted it (on its chain, or abandoned): for a locked entry's words. */
export function namesKeyLabel(pin: NamesPin, gens: Map<string, NamesGeneration>, id: string): { n: number; maker: string } | null {
    const link = pin.chain.find((l) => l.id === id);
    const g = link ? readNamesGeneration(link, pin.communityId, new Set([id])) : pin.abandoned.includes(id) ? gens.get(id) ?? null : null;
    return g ? { n: g.n, maker: g.maker } : null;
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
