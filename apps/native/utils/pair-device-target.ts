/**
 * Where "Use your account on another device" may send the account (fable-security-signin finding 1; the deciding
 * review of #1983, BLOCKING 1).
 *
 * The QR names the server that relays the account. The relay's number matching (pairing-relay.ts) only holds on an
 * honest server: a hand-made QR naming the sender's own server could skip it. So the phone sends the key and the
 * 12 words only to a server it already uses (the community it is on, or one in its saved list), the way the Settings
 * QR sign-in only signs in to the phone's own community. Moving to a brand-new community's server by QR is therefore
 * not possible; the 12 words still are.
 *
 * Two rules make "a server it already uses" mean one host on every parser (node-url.ts explains why: iOS's NSURL reads
 * `https://mullum.example\@evil.test` as evil.test, while the WHATWG URL that compared it reads mullum.example):
 *  1. The QR is read by a strict grammar, never by a URL parser: `beanpool://pair?` and exactly the parameters
 *     session, pub and node, each once; `node` a plain https origin in its one canonical spelling (lower case ASCII
 *     host or bracketed IPv6, a port only when it isn't 443, at most one trailing slash). No login, `\`, percent
 *     escape, whitespace, control character, path, query or fragment. Anything else is refused outright.
 *  2. The account goes to the matched SAVED address, rebuilt from its canonical origin (plainOriginOf): never the
 *     scanned text. The QR only chooses among the phone's own servers; it never spells the address that is used.
 *
 * https only. The QR's `node` must be https and only https saved addresses are targets, so a phone on an http server
 * (the emulator's `http://10.0.2.2:3000`, a LAN dev node) can't use this flow: a dev page's QR is refused as
 * unreadable, and one naming no server says "Connect to your community first.". Every live node is https; the 12
 * words still work anywhere. The screen relies on this: it keeps no cleartext check of its own.
 *
 * Several addresses (addresses S5, scratch/fable-design/DESIGN-several-addresses-fable.md §3.6). A code that names any
 * address of one of the phone's communities is accepted: an address string for string as a saved one (as before), or one
 * the community's own signed list names, as the phone keeps it in the community's record (utils/community-index.ts). Rule 2
 * stands: the account goes to the phone's own spelling of that address (the saved origin, or the list's entry), never the
 * scanned text. And the address is proved again at the scan (provedAtScan): when the community's key is known, the address
 * must sign the phone's fresh question with it, at a take-over count no lower than the phone has seen, before anything is
 * sent. One that answers as something else, or an older server, gets nothing ('replaced'); one that doesn't answer gets
 * nothing yet ('not-answering'). A community whose server can't say who it is (no key: an older server) keeps today's rule.
 */
import { addressOf, parseSettingsSigninQr, t } from '@beanpool/core';
import { plainOriginOf } from './node-url';
import { GLOBAL_NODE_URL } from './global-node-url';
import { communityRecordNaming, communityRecordOf, recordHolds, type CommunityRecord } from './community-index';
import type { AddressAnswer } from './address-decide';

export interface PairingQr {
    sessionId: string;
    desktopPubHex: string;
    /** The QR's server, as it spelled it ('' when it names none: the phone's own community). Only ever compared. */
    nodeUrl: string;
}

const PAIR_PREFIX = 'beanpool://pair?';
/** A plain https origin in its canonical spelling, with at most one trailing slash. Lower case only. */
export const CANONICAL_HTTPS_ORIGIN = /^https:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[(?=(?:[0-9a-f.]*:){2})[0-9a-f:.]+\])(?::[1-9]\d{0,4})?\/?$/;

/** The pairing QR, read strictly (rule 1), or null: refused, nothing sent. */
export function parsePairingQr(raw: unknown): PairingQr | null {
    if (typeof raw !== 'string' || raw.length > 600 || !raw.startsWith(PAIR_PREFIX)) return null;
    const query = raw.slice(PAIR_PREFIX.length);
    // Only the characters these three values are made of, plus the separators and node's own escapes (%3A, %2F).
    if (!/^[A-Za-z0-9=&%._-]+$/.test(query)) return null;
    const params = new Map<string, string>();
    for (const part of query.split('&')) {
        const eq = part.indexOf('=');
        if (eq <= 0) return null;
        const key = part.slice(0, eq);
        if ((key !== 'session' && key !== 'pub' && key !== 'node') || params.has(key)) return null;
        let value: string;
        try {
            value = decodeURIComponent(part.slice(eq + 1));
        } catch {
            return null;
        }
        params.set(key, value);
    }
    const sessionId = params.get('session') ?? '';
    const desktopPubHex = params.get('pub') ?? '';
    const nodeUrl = params.get('node') ?? '';
    if (!/^[0-9a-f]{16,64}$/.test(sessionId) || !/^[0-9a-f]{64}$/.test(desktopPubHex)) return null;
    if (nodeUrl && !CANONICAL_HTTPS_ORIGIN.test(nodeUrl)) return null;
    return { sessionId, desktopPubHex, nodeUrl };
}

/**
 * A code meant for this screen (`beanpool://pair`, in any case, around any spaces) that the grammar refuses: the
 * screen says so, so a bad code doesn't look like a camera that hasn't focused. Any other QR is not one: ignored.
 */
export function isUnreadablePairingQr(raw: unknown): boolean {
    return typeof raw === 'string' && raw.trim().toLowerCase().startsWith('beanpool://pair') && parsePairingQr(raw) === null;
}

/**
 * Whether a scanned code is the web app's "Link with Mobile App" code (`beanpool://pair?…`), readable or not: the
 * Settings sign-in scanner sends it to Link a device (utils/settings-signin.ts readSigninScan).
 */
export function isDeviceLinkCode(raw: unknown): boolean {
    return parsePairingQr(raw) !== null || isUnreadablePairingQr(raw);
}

/**
 * What one code means to the pairing screen, read the same way however it arrived: the camera on the screen, or a
 * `beanpool://pair` link the phone's camera app (or any other) opened (utils/pair-link.ts, app/+native-intent.ts).
 *  - 'pairing': the strict grammar read it; the screen still asks transferTarget where it may go, and sends nothing
 *    before the member's tap, the phone's unlock and the four digits.
 *  - 'unreadable': refused, said so, nothing sent. Any link is, when the grammar refuses it: a link was opened on
 *    purpose, so it is never silently dropped.
 *  - 'settings-signin': a node's Settings sign-in code (`beanpool-settings-signin:v1?…`, readable or not) in the camera's
 *    view: Settings → Manage this community from a computer's (app/settings-signin.tsx), never this screen's. Nothing read.
 *  - 'ignore': some other QR in the camera's view.
 */
export type PairingRead = { kind: 'pairing'; qr: PairingQr } | { kind: 'unreadable' } | { kind: 'settings-signin' } | { kind: 'ignore' };

export function readPairingCode(raw: unknown, source: 'camera' | 'link'): PairingRead {
    const qr = parsePairingQr(raw);
    if (qr) return { kind: 'pairing', qr };
    if (source === 'link' || isUnreadablePairingQr(raw)) return { kind: 'unreadable' };
    const signin = parseSettingsSigninQr(raw);
    return signin.ok || signin.reason === 'malformed' ? { kind: 'settings-signin' } : { kind: 'ignore' };
}

/** The key an address must prove with at the scan, and the highest take-over count the phone has seen for it. */
export interface ProveAtScan { peerId: string; epoch: number }

export type TransferTarget =
    /**
     * `nodeUrl`: the phone's own address for that server (a saved origin, or its community's listed address), in its
     * canonical origin. Where the account goes. `prove`: the community's key is known, so the address proves at the scan.
     */
    | { kind: 'ok'; nodeUrl: string; prove?: ProveAtScan }
    /** The QR names a server this phone does not use. `appHost`: the one it is on, to name in the refusal. */
    | { kind: 'foreign'; scannedHost: string; appHost: string | null }
    /** No server in the QR and none on the phone. */
    | { kind: 'no-node' }
    /** The address answered the scan's question as something else (another key, an older server, not on its list). */
    | { kind: 'replaced'; scannedHost: string }
    /** The address gave the scan's question no answer: nothing sent yet. */
    | { kind: 'not-answering'; scannedHost: string };

/** The phone's server as it is sent to: an https address the phone saved, in its canonical origin. */
function knownOrigin(url: string | null | undefined): string | null {
    const origin = plainOriginOf(url);
    return origin && origin.startsWith('https://') ? origin : null;
}

/** What a record says must be proved at the scan: its key and count, once known (a keyless record proves nothing). */
function proveOf(record: CommunityRecord | null): { prove?: ProveAtScan } {
    return record?.peerId ? { prove: { peerId: record.peerId, epoch: record.epoch ?? 0 } } : {};
}

/** The addresses `record`'s own signed list names, in canonical https origins: none unless the list is the record's key's. */
function listedOrigins(record: CommunityRecord | null): string[] {
    const list = record?.list?.list;
    if (!record?.peerId || !list || list.peerId !== record.peerId || !Array.isArray(list.addresses)) return [];
    return list.addresses.map((a) => knownOrigin(`https://${a}`)).filter((o): o is string => o !== null);
}

/**
 * The phone's own spelling of `scanned` (a canonical https origin) when it is an address of one of `communities` (the
 * community in use and the saved ones): the saved origin itself, string for string, else an address that community's own
 * list names. Null for an address the phone doesn't hold.
 */
export function heldAddress(
    scanned: string, communities: readonly (string | null | undefined)[], recordOf: (address: string) => CommunityRecord | null = communityRecordOf,
): { origin: string; prove?: ProveAtScan } | null {
    const own = communities.map(knownOrigin).filter((o): o is string => o !== null);
    const exact = own.find((o) => o === scanned);
    if (exact) return { origin: exact, ...proveOf(recordOf(exact)) };
    for (const o of own) {
        const record = recordOf(o);
        const listed = listedOrigins(record).find((l) => l === scanned);
        if (listed) return { origin: listed, ...proveOf(record) };
    }
    return null;
}

/**
 * @param scannedNodeUrl the QR's `node=` from parsePairingQr; empty means "this phone's community"
 * @param appNodeUrl the community this phone is on (`beanpool_anchor_url`)
 * @param savedNodeUrls the phone's saved communities (utils/nodes getSavedNodes)
 */
export function transferTarget(
    scannedNodeUrl: string, appNodeUrl: string | null, savedNodeUrls: readonly string[],
    recordOf: (address: string) => CommunityRecord | null = communityRecordOf,
): TransferTarget {
    const own = knownOrigin(appNodeUrl);
    if (!scannedNodeUrl) return own ? { kind: 'ok', nodeUrl: own, ...proveOf(recordOf(own)) } : { kind: 'no-node' };
    const scanned = CANONICAL_HTTPS_ORIGIN.test(scannedNodeUrl) ? scannedNodeUrl.replace(/\/$/, '') : null;
    // Equal strings: the QR's canonical spelling is exactly the saved server's canonical origin, or an address its
    // community's own list names. No other spelling of it (a port of 443, upper case, another IP form) is the same server.
    const held = scanned ? heldAddress(scanned, [own, ...savedNodeUrls], recordOf) : null;
    if (held) return { kind: 'ok', nodeUrl: held.origin, ...(held.prove ? { prove: held.prove } : {}) };
    return { kind: 'foreign', scannedHost: scanned ? scanned.slice('https://'.length) : '', appHost: own ? own.slice('https://'.length) : null };
}

/**
 * The scan's own proof (§3.6: "the address is proved again at the scan"). An 'ok' target whose community's key is known
 * stays 'ok' only when its address signs a fresh question with that key at a take-over count no lower than the phone's;
 * `prove` asks it (utils/address-verify.ts proofAt, the round's own ask). Any other target is returned as it is.
 */
export async function provedAtScan(
    target: TransferTarget, prove: (address: string, peerId: string) => Promise<AddressAnswer>,
): Promise<TransferTarget> {
    if (target.kind !== 'ok' || !target.prove) return target;
    const scannedHost = target.nodeUrl.slice('https://'.length);
    const address = addressOf(target.nodeUrl);
    const answer: AddressAnswer = address ? await prove(address, target.prove.peerId).catch(() => ({ kind: 'silent' as const })) : { kind: 'other-key', why: 'no address' };
    if (answer.kind === 'silent') return { kind: 'not-answering', scannedHost };
    if (answer.kind === 'proved' && answer.epoch >= target.prove.epoch) return target;
    return { kind: 'replaced', scannedHost };
}

/** What a code whose address didn't pass the scan's proof says, the same on both scanners (Link a device, Settings sign-in). */
export function scanProofRefusal(target: { kind: 'replaced' | 'not-answering'; scannedHost: string }): string {
    return target.kind === 'replaced'
        ? t('{host} no longer answers as your community, so nothing was sent. Make a new code at your community\'s main address and scan that one.', { host: target.scannedHost })
        : t('{host} isn\'t answering right now, so nothing was sent. Try again in a moment.', { host: target.scannedHost });
}

/**
 * Is `target` the community this phone is on (`beanpool_anchor_url`)? The member rows on the phone are that one's, so only
 * then does its member record give the account's name there (pair-device-payload.ts). Any address of it counts.
 */
export function isAppCommunity(target: TransferTarget | undefined, appNodeUrl: string | null): boolean {
    if (target?.kind !== 'ok') return false;
    const own = knownOrigin(appNodeUrl);
    if (target.nodeUrl === own) return true;
    // A listed address the phone hasn't proved yet is its community's too (the list names it; the scan proved it).
    const record = own ? communityRecordNaming(target.nodeUrl) : null;
    return !!record && recordHolds(record, own!);
}

/** Every address the screen sends to for one pairing: built from the matched saved origin and the session id only. */
export function pairingRequestUrls(target: Extract<TransferTarget, { kind: 'ok' }>, sessionId: string): { probe: string; transfer: string; cancel: string } {
    return {
        probe: `${target.nodeUrl}/api/pair/poll?session=${encodeURIComponent(sessionId)}`,
        transfer: `${target.nodeUrl}/api/pair/transfer`,
        cancel: `${target.nodeUrl}/api/pair/cancel`,
    };
}

/**
 * The other way through a refusal (Marty, 16 Oct: "why can't he add global as a second node to his phone?"): join the
 * global community on this phone first, through its own door (app/join-global.tsx, with its sign-in and checks), then
 * scan again. That door joins GLOBAL_NODE_URL, never the QR's text, and its relay is ours, so the digits still guard it.
 *
 * Only global: no button for any other server (the deciding review of #2025, B1). A join there would make the sender's
 * server one this phone uses, and the next scan of the same code would send the key and the 12 words to it, sealed to
 * the sender's own key: the digits protect nothing on a dishonest relay. The refusal, at the moment the app said no,
 * must not hand the member that server's address and a loop back to the scan. The rule above is unchanged: the QR
 * never adds a server, and the refused QR is not reused.
 */
export type RefusalJoin = { kind: 'global'; href: { pathname: '/join-global'; params: { then: typeof PAIR_AGAIN } } };

/** Where a join started from the pairing screen's refusal comes back to: a fixed name, never a route read from a link. */
export const PAIR_AGAIN = 'pair-device';

export function refusalJoin(target: TransferTarget | undefined): RefusalJoin | null {
    if (!target || target.kind !== 'foreign' || !target.scannedHost) return null;
    if (`https://${target.scannedHost}` !== GLOBAL_NODE_URL) return null;
    return { kind: 'global', href: { pathname: '/join-global', params: { then: PAIR_AGAIN } } };
}

/** The screen after a join: back to the pairing screen when the join started from its refusal, else `otherwise`. */
export function afterJoinRedirect(then: unknown, otherwise: string): string {
    return then === PAIR_AGAIN ? '/pair-device' : otherwise;
}
