/**
 * An in-process key vault, a stranger's community and the global community's door, for the phone's vault tests
 * (utils/vault.ts, key vault design V4). Nothing is contacted: `installNetwork` replaces `fetch`, records every request,
 * and throws for any address that isn't one of these.
 *
 * The vault answers as apps/vault/src/api/server.ts does, with the same wire formats, from @beanpool/core's
 * vault-wire.ts: it signs real tickets with its ticket key, opens real deposit boxes with its deposit secret, checks
 * that a sign-in's nonce is the hash of a ticket it signed for the request's signer, holds every restore (D2) and seals
 * each release to the key that asked. It checks each request's format-2 signature for its own host
 * (server-signature-check.ts), so a request signed for anywhere else is refused, as the vault refuses it.
 *
 * It signs its answers as the vault does (core vault-wire.ts "Signed answers"): to a request carrying a challenge,
 * every 2xx but a ticket and every 4xx whose request signature checked out, with its ticket key, about the signer.
 * The signing is done on the way out ({@link FakeVault.answer}), so a test that swaps `handle` still gets answers
 * signed as the vault would sign them. {@link FakeVault.answers} makes it a server at the vault's address that can't.
 *
 * The providers' sheets are not here: a test stubs `signInWithProvider` and makes a token with {@link fakeJwt}.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    checkVaultTicket,
    isVaultChallenge,
    newVaultChallenge,
    newVaultTicket,
    openVaultDepositBox,
    sealVaultRelease,
    signVaultAnswer,
    signVaultTicket,
    vaultB64,
    vaultCopyDigest,
    vaultTicketNonce,
    type SealedShare,
    type VaultAnswerKind,
    type VaultTicketPurpose,
} from '@beanpool/core';
import { boundSignatureValid } from './server-signature-check';

export const VAULT = 'https://vault.test';
/** "The current community": a stranger's, in the custody design's sense. Nothing that opens a key may reach it. */
export const COMMUNITY = 'https://a.test';
export const GLOBAL = 'https://global.beanpool.org';

export const TICKET_SEED = new Uint8Array(32).fill(0x11);
export const TICKET_KEY = bytesToHex(ed25519.getPublicKey(TICKET_SEED));
export const DEPOSIT_SECRET = new Uint8Array(32).fill(0x22);
export const DEPOSIT_KEY = vaultB64(x25519.getPublicKey(DEPOSIT_SECRET));
/** A key the phone doesn't pin: a ticket signed with it is not the vault's. */
export const FORGED_SEED = new Uint8Array(32).fill(0x33);
/** Someone else's key: a ticket naming it isn't this phone's. */
export const OTHER_KEY = bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(0x44)));

/** This build has the test vault (utils/vault.ts `vaultConfig` reads these, as Expo writes them into a build). */
export function useVault(): void {
    process.env.EXPO_PUBLIC_BEANPOOL_VAULT_URL = VAULT;
    process.env.EXPO_PUBLIC_BEANPOOL_VAULT_TICKET_KEYS = TICKET_KEY;
    process.env.EXPO_PUBLIC_BEANPOOL_VAULT_DEPOSIT_KEYS = DEPOSIT_KEY;
}

/** This build has no vault. */
export function noVault(): void {
    delete process.env.EXPO_PUBLIC_BEANPOOL_VAULT_URL;
    delete process.env.EXPO_PUBLIC_BEANPOOL_VAULT_TICKET_KEYS;
    delete process.env.EXPO_PUBLIC_BEANPOOL_VAULT_DEPOSIT_KEYS;
}

/** An unsigned JWT with these claims: enough for the phone, which only reads claims back (the vault verifies). */
export function fakeJwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2lnbmF0dXJl`;
}

function claimsOf(idToken: unknown): Record<string, unknown> | null {
    if (typeof idToken !== 'string') return null;
    try {
        return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

export interface SentRequest {
    url: string;
    origin: string;
    path: string;
    method: string;
    headers: Record<string, string>;
    raw: string;
    body: any;
}

interface Copy {
    provider: string;
    sub: string;
    pubkey: string;
    clientCopy: SealedShare;
    pushTokens: string[];
    lastReleasedAt: number | null;
}

interface Hold {
    holdId: string;
    copy: string;
    requester: string;
    provider: string;
    openedAt: number;
    releaseAt: number;
    cancelled: boolean;
    released: boolean;
}

export const HOLD_MS = 24 * 60 * 60 * 1000;

/** Hold ids unique across every vault a run starts, as the real vault's random ones are (the app remembers ids it showed). */
let holdSeq = 0;

/**
 * An answer. `says` is what a 2xx is signed as when its kind or fields aren't simply its path's and its body (a receipt,
 * a release); `unsigned` marks a refusal the vault never signs (a request whose own signature failed).
 */
type Reply = { status: number; body: unknown; says?: { kind: VaultAnswerKind; fields: Record<string, unknown> }; unsigned?: true };
const reply = (status: number, body: unknown): Reply => ({ status, body });

/** What each route's 2xx is signed as. A ticket answers for itself. */
const KIND_BY_PATH: Record<string, VaultAnswerKind> = {
    '/v1/copies': 'receipt',
    '/v1/copies/status': 'status',
    '/v1/copies/delete': 'deleted',
    '/v1/push-token': 'push-token',
    '/v1/push-token/remove': 'push-token',
    '/v1/restore': 'restore',
    '/v1/restore/collect': 'collect',
    '/v1/holds/cancel': 'hold',
    '/v1/holds/approve': 'hold',
};

/**
 * How a server at the vault's address signs its answers: as the vault does (`signed`); not at all (`unsigned`); with
 * a key the phone doesn't pin (`forged`); correctly but for another request (`replayed`: another challenge), about
 * another key (`other_key`), or as another kind (`other_kind`), as a server replaying the vault's real answers would.
 */
export type AnswerMode = 'signed' | 'unsigned' | 'forged' | 'replayed' | 'other_key' | 'other_kind';

export class FakeVault {
    /** Every call but health answers 503 `{locked: true}` (design §2.3). */
    locked = false;
    /** No answer at all. */
    unreachable = false;
    /** What its tickets are: its own, one signed by a key the phone doesn't pin, or one naming another key. */
    tickets: 'ok' | 'forged' | 'other_key' = 'ok';
    /** A release that names a key other than the one its copy's seed makes. */
    releaseNamesOtherKey = false;
    /** How it signs its answers ({@link AnswerMode}), on every route or only on `answersOn`'s. */
    answers: AnswerMode = 'signed';
    answersOn: string[] | null = null;
    /** False: a deposit is answered as kept, and not kept (a server at the vault's address that isn't the vault). */
    keepsDeposits = true;
    readonly copies = new Map<string, Copy>();
    readonly holds = new Map<string, Hold>();
    readonly spent = new Set<string>();

    /** A copy the vault keeps already: `clientCopy` sealed to `provider:sub`, for `pubkey`. */
    keep(provider: string, sub: string, pubkey: string, clientCopy: SealedShare): void {
        this.copies.set(`${provider}:${sub}`, { provider, sub, pubkey, clientCopy, pushTokens: [], lastReleasedAt: null });
    }

    copiesOf(pubkey: string): Copy[] {
        return [...this.copies.values()].filter(c => c.pubkey === pubkey);
    }

    private ticketFor(key: string, purpose: VaultTicketPurpose): string {
        const now = Date.now();
        if (this.tickets === 'forged') return signVaultTicket(newVaultTicket(key, purpose, now), FORGED_SEED);
        if (this.tickets === 'other_key') return signVaultTicket(newVaultTicket(OTHER_KEY, purpose, now), TICKET_SEED);
        return signVaultTicket(newVaultTicket(key, purpose, now), TICKET_SEED);
    }

    /** The vault's own check of a sign-in: its ticket, for this signer and purpose, unspent, with its hash in the token. */
    private signIn(body: any, signer: string, purpose: VaultTicketPurpose): { sub: string; provider: string } | Reply {
        const check = checkVaultTicket(body.ticket, { ticketKeys: [TICKET_KEY], now: Date.now(), key: signer, purpose });
        if (!check.ok) return reply(401, { error: 'That ticket is not this vault\'s.', code: `ticket_${check.reason}` });
        if (this.spent.has(check.ticket.n)) return reply(401, { error: 'That ticket was already used.', code: 'ticket_used' });
        const claims = claimsOf(body.idToken);
        if (!claims || claims.nonce !== vaultTicketNonce(body.ticket) || typeof claims.sub !== 'string') {
            return reply(401, { error: 'The sign-in could not be checked.', code: 'signin_refused' });
        }
        if (!['google', 'apple', 'facebook'].includes(body.provider)) return reply(400, { error: 'bad provider', code: 'bad_provider' });
        this.spent.add(check.ticket.n);
        return { sub: claims.sub, provider: body.provider };
    }

    /**
     * The answer as it leaves the vault: {@link handle}'s, signed as the vault signs it (core vault-wire.ts "Signed
     * answers"), or as {@link answers} says a server that isn't the vault would.
     */
    answer(req: SentRequest): Reply {
        const r = this.handle(req);
        const challenge = (req.body as { challenge?: unknown } | undefined)?.challenge;
        const signer = req.headers['X-Public-Key'];
        const kind: VaultAnswerKind | undefined = r.says?.kind ?? (r.status >= 400 ? 'refusal' : KIND_BY_PATH[req.path]);
        if (!isVaultChallenge(challenge) || !signer || r.status >= 500 || r.unsigned || !kind) return r;
        const says = r.says?.fields ?? (kind === 'refusal'
            ? { status: r.status, code: (r.body as { code?: unknown } | null)?.code }
            : { ...(r.body as Record<string, unknown>) });
        const mode = this.answersOn && !this.answersOn.includes(req.path) ? 'signed' : this.answers;
        if (mode === 'unsigned') return r;
        const head = {
            kind: mode === 'other_kind' ? (kind === 'status' ? 'deleted' : 'status') as VaultAnswerKind : kind,
            key: mode === 'other_key' ? OTHER_KEY : signer,
            challenge: mode === 'replayed' ? newVaultChallenge() : challenge,
            at: Date.now(),
        };
        const signed = signVaultAnswer(head, says, mode === 'forged' ? FORGED_SEED : TICKET_SEED);
        return { ...r, body: { ...(r.body as Record<string, unknown>), signed } };
    }

    handle(req: SentRequest): Reply {
        if (req.method !== 'POST') return reply(404, { error: 'No such route.', code: 'not_found' });
        if (this.locked) return reply(503, { error: 'The key vault is locked.', code: 'locked', locked: true });
        const signer = req.headers['X-Public-Key'];
        if (!signer || !boundSignatureValid({ url: req.url, method: req.method, headers: req.headers, body: req.raw }, signer)) {
            return { ...reply(401, { error: 'The signature does not check out.', code: 'bad_signature' }), unsigned: true };
        }
        const b = req.body ?? {};
        switch (req.path) {
            case '/v1/ticket': {
                if (b.purpose !== 'deposit' && b.purpose !== 'restore') return reply(400, { code: 'bad_purpose' });
                return reply(200, { ticket: this.ticketFor(signer, b.purpose), expiresAt: Date.now() + 600_000 });
            }
            case '/v1/copies': {
                const s = this.signIn(b, signer, 'deposit');
                if ('status' in s) return s;
                let contents;
                try {
                    contents = openVaultDepositBox(b.box, DEPOSIT_SECRET, signer, s.provider);
                } catch {
                    return reply(400, { error: 'The copy did not open as a deposit for this account and sign-in.', code: 'bad_box' });
                }
                const id = `${s.provider}:${s.sub}`;
                const existing = this.copies.get(id);
                const replaced = !!existing && existing.pubkey !== signer;
                if (this.keepsDeposits) {
                    this.copies.set(id, {
                        provider: s.provider, sub: s.sub, pubkey: signer, clientCopy: contents.clientCopy,
                        pushTokens: contents.pushToken ? [contents.pushToken] : [], lastReleasedAt: null,
                    });
                }
                return {
                    ...reply(200, { ok: true, provider: s.provider, replaced }),
                    says: {
                        kind: 'receipt',
                        fields: { provider: s.provider, copy: vaultCopyDigest(contents.clientCopy), signIn: vaultTicketNonce(b.ticket), replaced },
                    },
                };
            }
            case '/v1/copies/status': {
                const mine = this.copiesOf(signer);
                const holds = [...this.holds.values()]
                    .filter(h => !h.cancelled && !h.released && mine.some(c => `${c.provider}:${c.sub}` === h.copy))
                    .map(h => ({ holdId: h.holdId, provider: h.provider, openedAt: h.openedAt, releaseAt: h.releaseAt }));
                return reply(200, {
                    copies: mine.map(c => ({ provider: c.provider, lastReleasedAt: c.lastReleasedAt, updatedDay: '2026-10-01' })),
                    holds,
                });
            }
            case '/v1/copies/delete': {
                const doomed = this.copiesOf(signer).filter(c => b.all === true || c.provider === b.provider);
                for (const c of doomed) this.copies.delete(`${c.provider}:${c.sub}`);
                return reply(200, { deleted: doomed.length });
            }
            case '/v1/push-token': {
                const mine = this.copiesOf(signer);
                for (const c of mine) if (!c.pushTokens.includes(b.token)) c.pushTokens.push(b.token);
                return reply(200, { updated: mine.length });
            }
            case '/v1/push-token/remove': {
                let updated = 0;
                for (const c of this.copiesOf(signer)) {
                    if (!c.pushTokens.includes(b.token)) continue;
                    c.pushTokens = c.pushTokens.filter(t => t !== b.token);
                    updated++;
                }
                return reply(200, { updated });
            }
            case '/v1/restore': {
                const s = this.signIn(b, signer, 'restore');
                if ('status' in s) return s;
                const id = `${s.provider}:${s.sub}`;
                if (!this.copies.has(id)) {
                    return reply(404, { error: 'The key vault keeps no copy for this account. Your 12 words work any time.', code: 'no_copy' });
                }
                const open = [...this.holds.values()].find(h => h.copy === id && !h.cancelled && !h.released);
                if (open && open.requester === signer) return reply(200, { status: 'held', holdId: open.holdId, until: open.releaseAt });
                if (open && Date.now() < open.releaseAt) return reply(409, { error: 'already waiting', code: 'hold_open', until: open.releaseAt });
                const now = Date.now();
                const hold: Hold = {
                    holdId: `hold-${++holdSeq}`, copy: id, requester: signer, provider: s.provider, openedAt: now,
                    releaseAt: now + HOLD_MS, cancelled: false, released: false,
                };
                this.holds.set(hold.holdId, hold);
                return reply(200, { status: 'held', holdId: hold.holdId, until: hold.releaseAt });
            }
            case '/v1/restore/collect': {
                const hold = this.holds.get(b.holdId);
                if (!hold || hold.requester !== signer) return reply(404, { error: 'There is no restore waiting for this device.', code: 'no_hold' });
                if (hold.cancelled) return reply(200, { status: 'stopped' });
                if (Date.now() < hold.releaseAt) return reply(200, { status: 'held', until: hold.releaseAt });
                const copy = this.copies.get(hold.copy);
                if (!copy) return reply(404, { error: 'The copy this restore was for is no longer kept.', code: 'no_copy' });
                hold.released = true;
                copy.lastReleasedAt = Date.now();
                const pubkey = this.releaseNamesOtherKey ? OTHER_KEY : copy.pubkey;
                const release = sealVaultRelease({ provider: copy.provider, pubkey, clientCopy: copy.clientCopy }, signer);
                return { ...reply(200, { status: 'released', release }), says: { kind: 'release', fields: { provider: copy.provider, pubkey, box: release } } };
            }
            case '/v1/holds/cancel':
            case '/v1/holds/approve': {
                const hold = this.holds.get(b.holdId);
                const copy = hold ? this.copies.get(hold.copy) : undefined;
                if (!hold || !copy || copy.pubkey !== signer) return reply(404, { error: 'There is no restore of this account waiting.', code: 'no_hold' });
                if (req.path === '/v1/holds/cancel') {
                    hold.cancelled = true;
                    return reply(200, { status: 'stopped' });
                }
                hold.releaseAt = Math.min(hold.releaseAt, Date.now());
                return reply(200, { status: 'approved', releaseAt: hold.releaseAt });
            }
            default:
                return reply(404, { error: 'No such route.', code: 'not_found' });
        }
    }
}

/** A stranger's community: it keeps an old sign-in copy for the providers in `copies`, until the phone deletes it. */
export class FakeCommunity {
    copies = new Set<string>();

    handle(req: SentRequest): Reply {
        if (req.method === 'POST' && req.path === '/api/recovery/shares/status') {
            return reply(200, { enrolledSso: [...this.copies], keepers: [], total: this.copies.size, threshold: 1 });
        }
        const del = /^\/api\/recovery\/shares\/sso\/([a-z]+)$/.exec(req.path);
        if (req.method === 'DELETE' && del) {
            if (!this.copies.delete(del[1])) return reply(404, { error: 'not connected' });
            return reply(200, { removed: del[1], enrolledSso: [...this.copies] });
        }
        return reply(404, { error: 'Not Found' });
    }
}

/** The global community's door (apps/server routes/open-join.ts), as far as the phone meets it. */
export class FakeGlobal {
    /** The door's own nonce, for a sign-in that has no vault ticket. */
    readonly nonce = 'door-nonce-1';

    handle(req: SentRequest): Reply {
        if (req.method === 'POST' && req.path === '/api/join/sso-nonce') {
            return reply(200, { nonce: this.nonce, expiresInSeconds: 600, providers: ['apple', 'google', 'facebook'] });
        }
        if (req.method === 'POST' && req.path === '/api/join') {
            return reply(200, { success: true, member: { publicKey: req.headers['X-Public-Key'], callsign: req.body?.callsign } });
        }
        return reply(404, { error: 'Not Found' });
    }
}

export interface Network {
    vault: FakeVault;
    community: FakeCommunity;
    global: FakeGlobal;
    sent: SentRequest[];
}

/** Replace `fetch` with the vault, the community and the global door; anything else fails, as unreachable. */
export function installNetwork(): Network {
    const net: Network = { vault: new FakeVault(), community: new FakeCommunity(), global: new FakeGlobal(), sent: [] };
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        const u = new URL(url);
        const raw = typeof init?.body === 'string' ? init.body : '';
        let body: any;
        try {
            body = raw ? JSON.parse(raw) : undefined;
        } catch {
            body = raw;
        }
        const req: SentRequest = {
            url, origin: u.origin, path: u.pathname, method: String(init?.method ?? 'GET').toUpperCase(),
            headers: { ...(init?.headers ?? {}) }, raw, body,
        };
        net.sent.push(req);
        let r: Reply;
        if (u.origin === VAULT) {
            if (net.vault.unreachable) throw new TypeError('Network request failed');
            r = net.vault.answer(req);
        } else if (u.origin === COMMUNITY) {
            r = net.community.handle(req);
        } else if (u.origin === GLOBAL) {
            r = net.global.handle(req);
        } else {
            throw new TypeError(`Network request failed: the app contacted ${url}`);
        }
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    return net;
}

/** Every JSON key anywhere in `value`, nested included. */
export function keysIn(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
        for (const v of value) keysIn(v, out);
    } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            out.add(k);
            keysIn(v, out);
        }
    }
    return out;
}
