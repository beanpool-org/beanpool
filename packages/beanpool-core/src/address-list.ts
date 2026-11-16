/**
 * One community, several addresses: the signed list and the proof (slice S0 of
 * scratch/fable-design/DESIGN-several-addresses-fable.md, §2.2, §2.3, §7; decided by Marty 16 Nov). One definition for the
 * server, the phone and the web. A community is its server key, never its address: this file is what lets a phone check
 * that an address is the key's.
 *
 * **An address** is how a phone dials a server: `host`, or `host:port` for a port other than 443, in ONE spelling
 * ({@link addressOf}). It is a server's home as node-request-signing.ts spells it (`nodeHomeOf`: no scheme, path or
 * userinfo, the host lower case with no trailing dot, the port written only when it is not 443), with one step more: an
 * IP address is written as the URL standard writes it (WHATWG, what browsers and Node dial): `0xcb.0.113.5`,
 * `203.000.113.005` and `3405803781` are all `203.0.113.5`; `[2001:DB8:0::1]` is `[2001:db8::1]`. So every address is a
 * home in its own spelling, and two spellings that reach the same place are one address. A host that the URL standard
 * reads as a number but that is no IPv4 address (`coop.example.123`) is no address.
 *
 * **The list**, `GET /api/node/addresses` at every address:
 *
 *   { "list": { "v": 1, "peerId", "communityId", "epoch", "seq", "main", "addresses": [...], "spares": [...] }, "sig": "<base64>" }
 *
 * signed by the server key (the key `peerId` names) over the bytes
 *
 *   0xFF ‖ utf8( "beanpool-address-list/1\n" JSON.stringify({ v, peerId, communityId, epoch, seq, main, addresses, spares }) )
 *
 * with the fields in that order, the way the identity-epoch statement is (a tag line, then fixed-order JSON). The 0xFF
 * byte, as on a server's key document and request signature, keeps any text the key ever signs from being read as a
 * list. Every field is in its one spelling, so the JSON has one form in every runtime: `peerId` an Ed25519 libp2p
 * PeerId, `communityId` 1 to 64 of `A-Z a-z 0-9 . _ -`, `epoch` and `seq` safe integers from 0, `addresses` 1 to
 * {@link ADDRESS_LIST_MAX} addresses in code-unit order with none twice, `main` one of them, `spares` up to
 * {@link ADDRESS_SPARES_MAX} more in that order, none also in `addresses`. No address may be loopback or unspecified
 * (`localhost`, `127.0.0.0/8`, `0.0.0.0/8`, `[::1]`, `[::]`, and those as IPv4-mapped IPv6): a phone is never sent there.
 * Exactly these fields, no others, at both levels: a reader that met an unknown field could not tell whether it was
 * signed.
 *
 * **The order** is `(epoch, seq)`: `epoch` is the take-over count, so a take-over's list beats every list from before it
 * whatever its counter; `seq` goes up whenever the list's content changes (a server may skip numbers, never go back). A
 * phone keeps the highest it has read and takes nothing lower ({@link chooseAddressList}).
 *
 * **The proof**, `GET /api/node/proof?for=<address>&nonce=<32 hex>` at every address:
 *
 *   { "peerId", "for", "nonce", "epoch", "seq", "ts", "sig": "<128 hex>" }
 *
 * signed by the server key over
 *
 *   0xFF ‖ utf8( "beanpool-address-proof/1\n" FOR "\n" NONCE "\n" EPOCH "\n" SEQ "\n" TS )
 *
 * where EPOCH and SEQ name the server's newest list and TS is its clock in seconds. A server signs only when FOR is on its
 * current list (else 421, {@link addressProofRefusal}); it never reads the Host header. The phone builds the bytes
 * itself from the address it dialled and the nonce it made, so an answer for another address or an older question does
 * not verify. The nonce is what makes it fresh; TS is signed and handed back, never judged against the phone's clock (an
 * old phone's clock is often wrong).
 *
 * Every signature check is strict RFC 8032 (`zip215: false`): one signature for one key and message. A list's signature
 * is canonical base64 of 64 bytes; a proof's is 128 lower-case hex characters, as the registrar's attestation is.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { nodeHomeOf, signatureBytesOf } from './node-request-signing.js';
import { ed25519KeyOfPeerId } from './owner-unlock.js';
import { signedRequestBytes, toBase64, type Signer } from './request-signing.js';

/** The tag line of a signed address list. */
export const ADDRESS_LIST_TAG = 'beanpool-address-list/1';
/** The tag line of an address proof. Its own tag, so a proof is never a registrar attestation or a member's request. */
export const ADDRESS_PROOF_TAG = 'beanpool-address-proof/1';
/** Where every server publishes its signed list, at every address. */
export const ADDRESS_LIST_PATH = '/api/node/addresses';
/** Where every server answers a proof, at every address. */
export const ADDRESS_PROOF_PATH = '/api/node/proof';
/** The version of the list this code writes and reads. */
export const ADDRESS_LIST_VERSION = 1;
/** The most addresses one list may name. */
export const ADDRESS_LIST_MAX = 16;
/** The most spares one list may name (a standby's address or two, design §6). */
export const ADDRESS_SPARES_MAX = 4;

const COMMUNITY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const NONCE_HEX = /^[0-9a-f]{32}$/;
const SIG_HEX = /^[0-9a-f]{128}$/;
const LIST_FIELDS = ['v', 'peerId', 'communityId', 'epoch', 'seq', 'main', 'addresses', 'spares'] as const;
const PROOF_FIELDS = ['peerId', 'for', 'nonce', 'epoch', 'seq', 'ts', 'sig'] as const;

// ─── The one spelling of an address ─────────────────────────────────────────────────────────

/**
 * One piece of a dotted IPv4 host as the URL standard reads it (its "IPv4 number parser"): `0x` then hex, `0` then octal,
 * else decimal; `0x` alone is 0. Null for anything else.
 */
function ipv4NumberOf(part: string): number | null {
    if (part === '') return null;
    let radix = 10;
    let digits = part;
    if (part.length >= 2 && part.startsWith('0x')) {
        radix = 16;
        digits = part.slice(2);
    } else if (part.length >= 2 && part.startsWith('0')) {
        radix = 8;
        digits = part.slice(1);
    }
    if (digits === '') return 0;
    const ok = radix === 16 ? /^[0-9a-f]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
    return ok.test(digits) ? parseInt(digits, radix) : null;
}

/** Whether the URL standard reads `host` as an IPv4 address ("ends in a number"): its last label is digits, or `0x` hex. */
function endsInNumber(host: string): boolean {
    const last = host.slice(host.lastIndexOf('.') + 1);
    return /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last);
}

/** An IPv4 host (1 to 4 dotted pieces, each in any of the URL standard's forms) as one 32-bit number, or null. */
function ipv4Of(host: string): number | null {
    const parts = host.split('.');
    if (parts.length > 4) return null;
    const numbers: number[] = [];
    for (const part of parts) {
        const n = ipv4NumberOf(part);
        if (n === null) return null;
        numbers.push(n);
    }
    const last = numbers.pop()!;
    if (numbers.some((n) => n > 255) || last >= 256 ** (4 - numbers.length)) return null;
    return numbers.reduce((sum, n, i) => sum + n * 256 ** (3 - i), last);
}

function ipv4Text(n: number): string {
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** The eight 16-bit pieces of an IPv6 address (the text between the brackets), as the URL standard parses it, or null. */
function ipv6Of(text: string): number[] | null {
    const pieces = [0, 0, 0, 0, 0, 0, 0, 0];
    let piece = 0;
    let compress: number | null = null;
    let p = 0;
    const at = (i: number) => text[i];
    const hex = (c: string | undefined) => c !== undefined && /^[0-9a-fA-F]$/.test(c);
    const digit = (c: string | undefined) => c !== undefined && /^[0-9]$/.test(c);
    if (at(p) === ':') {
        if (at(p + 1) !== ':') return null;
        p += 2;
        compress = ++piece;
    }
    while (at(p) !== undefined) {
        if (piece === 8) return null;
        if (at(p) === ':') {
            if (compress !== null) return null;
            p++;
            compress = ++piece;
            continue;
        }
        let value = 0;
        let length = 0;
        while (length < 4 && hex(at(p))) {
            value = value * 16 + parseInt(at(p)!, 16);
            p++;
            length++;
        }
        if (at(p) === '.') {
            // An IPv4 address in the last 32 bits: exactly four decimal pieces, no leading zero.
            if (length === 0) return null;
            p -= length;
            if (piece > 6) return null;
            let seen = 0;
            while (at(p) !== undefined) {
                if (seen > 0) {
                    if (at(p) === '.' && seen < 4) p++;
                    else return null;
                }
                if (!digit(at(p))) return null;
                let v4: number | null = null;
                while (digit(at(p))) {
                    const d = Number(at(p));
                    if (v4 === null) v4 = d;
                    else if (v4 === 0) return null;
                    else v4 = v4 * 10 + d;
                    if (v4 > 255) return null;
                    p++;
                }
                pieces[piece] = pieces[piece] * 256 + v4!;
                seen++;
                if (seen === 2 || seen === 4) piece++;
            }
            if (seen !== 4) return null;
            break;
        } else if (at(p) === ':') {
            p++;
            if (at(p) === undefined) return null;
        } else if (at(p) !== undefined) {
            return null;
        }
        pieces[piece] = value;
        piece++;
    }
    if (compress !== null) {
        let swaps = piece - compress;
        piece = 7;
        while (piece !== 0 && swaps > 0) {
            const other = compress + swaps - 1;
            [pieces[piece], pieces[other]] = [pieces[other], pieces[piece]];
            piece--;
            swaps--;
        }
    } else if (piece !== 8) {
        return null;
    }
    return pieces;
}

/** IPv6 pieces as the URL standard writes them: lower-case hex, no leading zero, the first longest run of 2+ zeros as `::`. */
function ipv6Text(pieces: number[]): string {
    let compress = -1;
    let best = 1;
    for (let i = 0; i < 8; ) {
        if (pieces[i] !== 0) { i++; continue; }
        let j = i;
        while (j < 8 && pieces[j] === 0) j++;
        if (j - i > best) { best = j - i; compress = i; }
        i = j;
    }
    let out = '';
    for (let i = 0; i < 8; i++) {
        if (i === compress) {
            out += i === 0 ? '::' : ':';
            i += best - 1;
            continue;
        }
        out += pieces[i].toString(16);
        if (i !== 7) out += ':';
    }
    return out;
}

/** A home (`nodeHomeOf`'s spelling) split into its host and the port written after it, if any. */
function splitHome(home: string): { host: string; port: string | null } {
    if (home.startsWith('[')) {
        const close = home.indexOf(']');
        return { host: home.slice(0, close + 1), port: home.length > close + 1 ? home.slice(close + 2) : null };
    }
    const colon = home.lastIndexOf(':');
    return colon === -1 ? { host: home, port: null } : { host: home.slice(0, colon), port: home.slice(colon + 1) };
}

/**
 * An address in its one spelling: a server's home (`nodeHomeOf`), with an IPv4 or IPv6 host written as the URL standard
 * writes it. Takes a URL (`https://Coop.Example.org.:8443/x`), a bare host or `host:port`, and anything between. Null
 * for anything that is no address: no host, a scheme other than http(s) or ws(s), a port outside 1 to 65535, a host in
 * another script, or a host the URL standard reads as a number that is no IPv4 address.
 */
export function addressOf(input: string): string | null {
    if (typeof input !== 'string') return null;
    const home = nodeHomeOf(input);
    if (!home) return null;
    const { host, port } = splitHome(home);
    let canonical: string;
    if (host.startsWith('[')) {
        const pieces = ipv6Of(host.slice(1, -1));
        if (!pieces) return null;
        canonical = `[${ipv6Text(pieces)}]`;
    } else if (endsInNumber(host)) {
        const n = ipv4Of(host);
        if (n === null) return null;
        canonical = ipv4Text(n);
    } else {
        canonical = host;
    }
    return port === null ? canonical : `${canonical}:${port}`;
}

/** Whether `x` is an address in its one spelling: exactly what {@link addressOf} makes of it. */
export function isAddress(x: unknown): x is string {
    return typeof x === 'string' && x.length > 0 && addressOf(x) === x;
}

const isLoopbackV4 = (n: number) => n >>> 24 === 127 || n >>> 24 === 0;

/**
 * Whether a list may name `address`: an address in its one spelling that is not loopback or unspecified (`localhost` and
 * names under it, `127.0.0.0/8`, `0.0.0.0/8`, `[::1]`, `[::]`, and IPv4-mapped IPv6 in those ranges). A home network's
 * number (`10.0.0.7`) may be listed.
 */
export function isListableAddress(address: unknown): address is string {
    if (!isAddress(address)) return false;
    const { host } = splitHome(address);
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    if (host.startsWith('[')) {
        const p = ipv6Of(host.slice(1, -1))!;
        const upperZero = p.slice(0, 5).every((x) => x === 0);
        if (upperZero && p[5] === 0 && p[6] === 0 && (p[7] === 0 || p[7] === 1)) return false;
        if (upperZero && p[5] === 0xffff && isLoopbackV4(p[6] * 65536 + p[7])) return false;
        return true;
    }
    if (endsInNumber(host)) return !isLoopbackV4(ipv4Of(host)!);
    return true;
}

// ─── The signed list ────────────────────────────────────────────────────────────────────────

/** What a server signs: who it is, the list's number, and where it answers. */
export interface AddressListFields {
    /** The server key, as a libp2p PeerId (Ed25519). */
    peerId: string;
    communityId: string;
    /** The take-over count. */
    epoch: number;
    /** Up by one whenever the content changes. */
    seq: number;
    /** One of `addresses`: where phones go. */
    main: string;
    addresses: string[];
    /** Where the community would go if this server were lost (design §6). Never in `addresses`. */
    spares: string[];
}

export interface AddressList extends AddressListFields {
    v: typeof ADDRESS_LIST_VERSION;
}

/** What `GET /api/node/addresses` answers. */
export interface SignedAddressList {
    list: AddressList;
    /** Ed25519 by the key `list.peerId` names, over {@link addressListBytes}, canonical base64. */
    sig: string;
}

/** The text a list is signed as (the signed bytes are 0xFF, then this in UTF-8). */
export function addressListText(f: AddressListFields): string {
    return `${ADDRESS_LIST_TAG}\n${JSON.stringify({
        v: ADDRESS_LIST_VERSION, peerId: f.peerId, communityId: f.communityId, epoch: f.epoch, seq: f.seq,
        main: f.main, addresses: f.addresses, spares: f.spares,
    })}`;
}

/** The bytes a list is signed as: 0xFF, then {@link addressListText} in UTF-8. */
export function addressListBytes(f: AddressListFields): Uint8Array {
    return signedRequestBytes(addressListText(f));
}

/** A count as signed: a safe integer from 0. */
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Each one listable, each after the one before in code-unit order (so none twice). */
function inOneOrder(xs: unknown, max: number, min: number): xs is string[] {
    if (!Array.isArray(xs) || xs.length < min || xs.length > max) return false;
    return xs.every((x, i) => isListableAddress(x) && (i === 0 || (xs[i - 1] as string) < x));
}

/** Why these fields are no list, or null. */
function listProblem(f: Partial<Record<keyof AddressListFields, unknown>>): string | null {
    if (typeof f.peerId !== 'string' || !ed25519KeyOfPeerId(f.peerId)) return 'peerId is not an Ed25519 PeerId';
    if (typeof f.communityId !== 'string' || !COMMUNITY_ID.test(f.communityId)) return 'communityId is not 1 to 64 of A-Z a-z 0-9 . _ -';
    if (!isCount(f.epoch) || !isCount(f.seq)) return 'epoch and seq are safe integers from 0';
    if (!inOneOrder(f.addresses, ADDRESS_LIST_MAX, 1)) {
        return `addresses are 1 to ${ADDRESS_LIST_MAX} different addresses, each in its one spelling, none loopback, in order`;
    }
    if (typeof f.main !== 'string' || !f.addresses.includes(f.main)) return 'main is not one of the addresses';
    if (!inOneOrder(f.spares, ADDRESS_SPARES_MAX, 0)) {
        return `spares are up to ${ADDRESS_SPARES_MAX} different addresses, each in its one spelling, none loopback, in order`;
    }
    if (f.spares.some((s) => (f.addresses as string[]).includes(s))) return 'a spare is also one of the addresses';
    return null;
}

/** Strict Ed25519 (RFC 8032) by the key a PeerId names: never throws. */
function verifiesForPeer(sig: Uint8Array, message: Uint8Array, peerId: string): boolean {
    const key = ed25519KeyOfPeerId(peerId);
    if (!key) return false;
    try {
        return ed25519.verify(sig, message, key, { zip215: false });
    } catch {
        return false;
    }
}

function copyList(f: AddressListFields): AddressList {
    return {
        v: ADDRESS_LIST_VERSION, peerId: f.peerId, communityId: f.communityId, epoch: f.epoch, seq: f.seq,
        main: f.main, addresses: [...f.addresses], spares: [...f.spares],
    };
}

/**
 * The list signed with the server key. The addresses and spares are put in their one order; anything else not in its one
 * spelling throws, having signed nothing (an address is spelled by {@link addressOf} before it is listed, never here).
 * Throws, too, when the signature does not verify for `peerId`: the key signing is not the one the list names.
 */
export async function signAddressList(f: AddressListFields, sign: Signer): Promise<SignedAddressList> {
    const fields = {
        ...f,
        addresses: Array.isArray(f.addresses) ? [...f.addresses].sort(byCodeUnit) : f.addresses,
        spares: Array.isArray(f.spares) ? [...f.spares].sort(byCodeUnit) : f.spares,
    };
    const problem = listProblem(fields);
    if (problem) throw new Error(`Cannot sign an address list: ${problem}`);
    const list = copyList(fields);
    const sig = await sign(addressListBytes(list));
    if (!verifiesForPeer(sig, addressListBytes(list), list.peerId)) {
        throw new Error('Cannot sign an address list: the signature is not by the key its peerId names');
    }
    return { list, sig: toBase64(sig) };
}

function hasExactly(o: object, fields: readonly string[]): boolean {
    const keys = Object.keys(o);
    return keys.length === fields.length && fields.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** What reading a list found: the list, or why it is none (`malformed`: not in its one form; `bad-signature`: not its key's). */
export type AddressListCheck =
    | { ok: true; signed: SignedAddressList }
    | { ok: false; why: 'malformed' | 'bad-signature' };

/**
 * A list read back: in its one form and signed by the key its `peerId` names, else why not. Says nothing about whether
 * that key is the community the reader holds, or whether the list is newer than one it keeps ({@link chooseAddressList}).
 */
export function checkAddressList(json: unknown): AddressListCheck {
    if (!isRecord(json) || !hasExactly(json, ['list', 'sig'])) return { ok: false, why: 'malformed' };
    const list = json.list;
    if (!isRecord(list) || !hasExactly(list, LIST_FIELDS) || list.v !== ADDRESS_LIST_VERSION || listProblem(list)) {
        return { ok: false, why: 'malformed' };
    }
    const sig = signatureBytesOf(json.sig);
    if (!sig) return { ok: false, why: 'malformed' };
    const fields = list as unknown as AddressListFields;
    if (!verifiesForPeer(sig, addressListBytes(fields), fields.peerId)) return { ok: false, why: 'bad-signature' };
    return { ok: true, signed: { list: copyList(fields), sig: json.sig as string } };
}

/** {@link checkAddressList}'s list, or null. */
export function readAddressList(json: unknown): SignedAddressList | null {
    const check = checkAddressList(json);
    return check.ok ? check.signed : null;
}

// ─── The order ──────────────────────────────────────────────────────────────────────────────

/** -1, 0 or 1 as `a`'s (epoch, seq) is lower than, the same as, or higher than `b`'s: the take-over count first. */
export function compareAddressNumbers(a: { epoch: number; seq: number }, b: { epoch: number; seq: number }): -1 | 0 | 1 {
    if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
    if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
    return 0;
}

const sameSet = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const x = [...a].sort(byCodeUnit), y = [...b].sort(byCodeUnit);
    return x.every((v, i) => v === y[i]);
};

/**
 * Whether two lists say the same thing: the same key, community, main, addresses and spares, in any order. Their numbers
 * are not content. A server bumps `seq` when this is false against the list it last signed.
 */
export function sameAddressListContent(a: AddressListFields, b: AddressListFields): boolean {
    return a.peerId === b.peerId && a.communityId === b.communityId && a.main === b.main
        && sameSet(a.addresses, b.addresses) && sameSet(a.spares, b.spares);
}

/**
 * What a phone does with a list it is offered, against the one it keeps for the community:
 * - `refuse`: no list of this community. `malformed` or `bad-signature` ({@link checkAddressList}); `other-key`: signed by
 *   another key than the community's; `other-community`: the community's key, another community id.
 * - `replace`: take it. `first`: nothing was kept; `newer`: a higher (epoch, seq).
 * - `keep`: keep what it has. `older`: a lower (epoch, seq); `same`: the same number and content; `conflict`: the same
 *   number with other content (two lists signed at one number; the first one kept stands, design §7 "takes nothing lower").
 */
export type AddressListChoice =
    | { action: 'replace'; why: 'first' | 'newer'; signed: SignedAddressList }
    | { action: 'keep'; why: 'older' | 'same' | 'conflict' }
    | { action: 'refuse'; why: 'malformed' | 'bad-signature' | 'other-key' | 'other-community' };

export interface AddressListHeld {
    /** The community's key as the phone holds it (from its first proved read). */
    peerId: string;
    /** The list kept for it, as {@link readAddressList} gave it; null before the first. */
    kept: SignedAddressList | null;
    /** The community id held when no list is kept yet; a kept list's own id is used when there is one. */
    communityId?: string | null;
}

/**
 * Keep, replace or refuse `offered` against what is held. Throws when what is held is itself wrong (a `peerId` that is no
 * Ed25519 PeerId, a kept list of another key): that is the caller's mistake, never a verdict on the offer.
 */
export function chooseAddressList(offered: unknown, held: AddressListHeld): AddressListChoice {
    if (typeof held.peerId !== 'string' || !ed25519KeyOfPeerId(held.peerId)) throw new Error('chooseAddressList: peerId is not an Ed25519 PeerId');
    if (held.kept && held.kept.list.peerId !== held.peerId) throw new Error('chooseAddressList: the kept list is another key\'s');
    const check = checkAddressList(offered);
    if (!check.ok) return { action: 'refuse', why: check.why };
    const { signed } = check;
    if (signed.list.peerId !== held.peerId) return { action: 'refuse', why: 'other-key' };
    const communityId = held.kept?.list.communityId ?? held.communityId ?? null;
    if (communityId !== null && signed.list.communityId !== communityId) return { action: 'refuse', why: 'other-community' };
    if (!held.kept) return { action: 'replace', why: 'first', signed };
    const order = compareAddressNumbers(signed.list, held.kept.list);
    if (order > 0) return { action: 'replace', why: 'newer', signed };
    if (order < 0) return { action: 'keep', why: 'older' };
    return { action: 'keep', why: sameAddressListContent(signed.list, held.kept.list) ? 'same' : 'conflict' };
}

// ─── The proof ──────────────────────────────────────────────────────────────────────────────

/** What a proof signs: the address asked for, the asker's nonce, the newest list's number, and the time in seconds. */
export interface AddressProofFields {
    for: string;
    nonce: string;
    epoch: number;
    seq: number;
    ts: number;
}

/** What `GET /api/node/proof` answers. */
export interface AddressProof extends AddressProofFields {
    peerId: string;
    /** Ed25519 by the key `peerId` names, over {@link addressProofBytes}, 128 lower-case hex characters. */
    sig: string;
}

/** The text a proof is signed as (the signed bytes are 0xFF, then this in UTF-8). */
export function addressProofText(f: AddressProofFields): string {
    return `${ADDRESS_PROOF_TAG}\n${f.for}\n${f.nonce}\n${f.epoch}\n${f.seq}\n${f.ts}`;
}

/** The bytes a proof is signed as: 0xFF, then {@link addressProofText} in UTF-8. */
export function addressProofBytes(f: AddressProofFields): Uint8Array {
    return signedRequestBytes(addressProofText(f));
}

/** A fresh question: 16 random bytes, as 32 lower-case hex characters. */
export function newAddressProofNonce(): string {
    return bytesToHex(randomBytes(16));
}

/**
 * Why a server holding `list` must not sign a proof for this question, or null when it may: 400 when the nonce is not 32
 * lower-case hex characters, 421 when `for` is not exactly one of the list's addresses (another spelling, a spare, a
 * former name, loopback, anything else: the code a signature for the wrong community gets today).
 */
export function addressProofRefusal(list: AddressList, question: { for?: unknown; nonce?: unknown }): 400 | 421 | null {
    if (typeof question.nonce !== 'string' || !NONCE_HEX.test(question.nonce)) return 400;
    // isAddress as well as the list: the signed text is one field per line, so a list built wrongly by hand (an address
    // with a line break) still never gets one signed.
    if (!isAddress(question.for) || !Array.isArray(list.addresses) || !list.addresses.includes(question.for)) return 421;
    return null;
}

/**
 * The proof a server signs for a question, naming its list's number. Throws, having signed nothing, when
 * {@link addressProofRefusal} refuses the question or `ts` is no count; throws, too, when the signature does not verify
 * for the list's `peerId`.
 */
export async function signAddressProof(
    input: { list: AddressList; for: string; nonce: string; ts?: number },
    sign: Signer,
): Promise<AddressProof> {
    const refusal = addressProofRefusal(input.list, { for: input.for, nonce: input.nonce });
    if (refusal === 400) throw new Error('Cannot sign an address proof: the nonce is not 32 lower-case hex characters');
    if (refusal === 421) throw new Error('Cannot sign an address proof: that address is not on the list');
    const ts = input.ts ?? Math.floor(Date.now() / 1000);
    if (!isCount(ts)) throw new Error('Cannot sign an address proof at that time');
    const fields: AddressProofFields = { for: input.for, nonce: input.nonce, epoch: input.list.epoch, seq: input.list.seq, ts };
    if (!isCount(fields.epoch) || !isCount(fields.seq)) throw new Error('Cannot sign an address proof: the list\'s epoch and seq are not counts');
    const sig = await sign(addressProofBytes(fields));
    if (!verifiesForPeer(sig, addressProofBytes(fields), input.list.peerId)) {
        throw new Error('Cannot sign an address proof: the signature is not by the key the list\'s peerId names');
    }
    return { peerId: input.list.peerId, ...fields, sig: bytesToHex(sig) };
}

/**
 * What a proof says: the address answered as the key for this very question, at this list number; else why not.
 * `malformed`: not a proof in its one form; `other-key`: it names another key; `other-address`, `other-nonce`: it answers
 * another question; `bad-signature`: not the key's signature over this question.
 */
export type AddressProofVerdict =
    | { ok: true; epoch: number; seq: number; ts: number }
    | { ok: false; why: 'malformed' | 'other-key' | 'other-address' | 'other-nonce' | 'bad-signature' };

/**
 * Whether `answer` proves that the address the phone dialled answers as the key it holds, for the nonce it made. The
 * bytes are built from the phone's own question, never from the answer's. Throws when the question itself is not one (a
 * `peerId` that is no Ed25519 PeerId, `for` not an address in its one spelling, a nonce not 32 lower-case hex): the
 * caller's mistake, never a verdict on the address.
 */
export function verifyAddressProof(answer: unknown, question: { peerId: string; for: string; nonce: string }): AddressProofVerdict {
    if (typeof question.peerId !== 'string' || !ed25519KeyOfPeerId(question.peerId)) throw new Error('verifyAddressProof: peerId is not an Ed25519 PeerId');
    if (!isAddress(question.for)) throw new Error('verifyAddressProof: for is not an address in its one spelling');
    if (typeof question.nonce !== 'string' || !NONCE_HEX.test(question.nonce)) throw new Error('verifyAddressProof: the nonce is not 32 lower-case hex characters');
    if (!isRecord(answer) || !hasExactly(answer, PROOF_FIELDS)) return { ok: false, why: 'malformed' };
    const { peerId, for: answeredFor, nonce, epoch, seq, ts, sig } = answer;
    if (typeof peerId !== 'string' || !ed25519KeyOfPeerId(peerId) || typeof answeredFor !== 'string' || typeof nonce !== 'string'
        || !isCount(epoch) || !isCount(seq) || !isCount(ts) || typeof sig !== 'string' || !SIG_HEX.test(sig)) {
        return { ok: false, why: 'malformed' };
    }
    if (peerId !== question.peerId) return { ok: false, why: 'other-key' };
    if (answeredFor !== question.for) return { ok: false, why: 'other-address' };
    if (nonce !== question.nonce) return { ok: false, why: 'other-nonce' };
    const bytes = addressProofBytes({ for: question.for, nonce: question.nonce, epoch, seq, ts });
    if (!verifiesForPeer(hexToBytes(sig), bytes, question.peerId)) return { ok: false, why: 'bad-signature' };
    return { ok: true, epoch, seq, ts };
}

// ─── Where ──────────────────────────────────────────────────────────────────────────────────

function mustBeAddress(address: string): void {
    if (!isAddress(address)) throw new Error(`${JSON.stringify(address)} is not an address in its one spelling (host, or host:port for a port other than 443)`);
}

/** Where `address` serves the signed list: `https://<address>/api/node/addresses`, on its own port. */
export function addressListUrl(address: string): string {
    mustBeAddress(address);
    return `https://${address}${ADDRESS_LIST_PATH}`;
}

/** The proof question to `address` for `nonce`: `https://<address>/api/node/proof?for=<address>&nonce=<nonce>`. */
export function addressProofUrl(address: string, nonce: string): string {
    mustBeAddress(address);
    if (typeof nonce !== 'string' || !NONCE_HEX.test(nonce)) throw new Error('An address proof nonce is 32 lower-case hex characters');
    return `https://${address}${ADDRESS_PROOF_PATH}?for=${encodeURIComponent(address)}&nonce=${nonce}`;
}
