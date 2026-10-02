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
    checkDoorWorkChallenge,
    checkDoorWorkSolution,
    checkVaultTicket,
    isVaultChallenge,
    makeDoorWorkChallenge,
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

/**
 * A community as every live one is today: it keeps each member's sign-in copy, hands out its own nonce, and gives the
 * copy back to a restore that names the callsign and proves the sign-in. Put in place of {@link FakeCommunity}'s
 * `handle` (release-gate.test.ts, vault-phone-gates.test.ts).
 */
export class CommunityKeepingCopies {
    /** provider → the copy (the phone's single-blob share), for the one member here. */
    readonly copies = new Map<string, SealedShare>();
    readonly nonces = new Set<string>();
    private seq = 0;
    /** The sign-in the restore under way proved, whose copy it collects. */
    private collecting: string | null = null;
    constructor(readonly callsign: string) {}

    handle(req: SentRequest): { status: number; body: unknown } {
        const b = req.body ?? {};
        const ok = (body: unknown) => ({ status: 200, body });
        if (req.method === 'POST' && req.path === '/api/recovery/sso-nonce') {
            const nonce = `community-nonce-${++this.seq}`;
            this.nonces.add(nonce);
            return ok({ nonce, expiresInSeconds: 600, providers: ['apple', 'google', 'facebook'] });
        }
        if (req.method === 'POST' && req.path === '/api/recovery/shares/sso') {
            if (!this.nonces.delete(b.nonce)) return { status: 401, body: { error: 'nonce' } };
            this.copies.set(b.provider, b.shares[0]);
            return ok({ generation: 1, enrolledSso: [...this.copies.keys()], threshold: 1 });
        }
        if (req.method === 'POST' && req.path === '/api/recovery/shares/status') {
            return ok({ enrolledSso: [...this.copies.keys()], keepers: [{ holderType: 'sso', count: this.copies.size }], total: this.copies.size, threshold: 1 });
        }
        const del = /^\/api\/recovery\/shares\/sso\/([a-z]+)$/.exec(req.path);
        if (req.method === 'DELETE' && del) {
            if (!this.copies.delete(del[1])) return { status: 404, body: { error: 'not connected' } };
            return ok({ removed: del[1], enrolledSso: [...this.copies.keys()] });
        }
        if (req.method === 'POST' && req.path === '/api/recovery/collect') {
            return b.callsign === this.callsign ? ok({ collectionId: 'c-1' }) : { status: 404, body: { error: 'No such account.' } };
        }
        if (req.method === 'POST' && req.path === '/api/recovery/collect/sso-nonce') {
            const nonce = `collect-nonce-${++this.seq}`;
            this.nonces.add(nonce);
            return ok({ nonce });
        }
        if (req.method === 'POST' && req.path === '/api/recovery/collect/sso') {
            if (!this.nonces.delete(b.nonce)) return { status: 401, body: { error: 'nonce' } };
            this.collecting = b.provider;
            return ok({ released: true });
        }
        if (req.method === 'POST' && req.path === '/api/recovery/collect/fragments') {
            const copy = this.copies.get(this.collecting ?? 'google');
            if (!copy) return ok({ fragments: [] });
            return ok({
                fragments: [{
                    holderType: 'sso', payload: copy.encryptedShare, payloadIv: copy.shareIv, payloadTag: copy.shareTag, kdfParams: copy.kdfParams,
                }],
            });
        }
        return { status: 404, body: { error: 'Not Found' } };
    }
}

/** The door's 401 code for each way a vault ticket fails its check (V5 design §1.2). */
const DOOR_TICKET_CODES: Record<string, string> = {
    malformed: 'ticket_malformed',
    signature: 'ticket_signature',
    expired: 'ticket_expired',
    wrong_key: 'ticket_key',
    wrong_purpose: 'ticket_purpose',
};

/**
 * The global community's door (apps/server routes/open-join.ts), as far as the phone meets it, with V5's ticket check
 * (scratch/global-node/DESIGN-v5-global-door-vault-fable.md §1.2, §1.3): its nonce answer says which vault ticket keys
 * it takes, and a join is let in only on its own nonce or on a ticket it takes, with that ticket's hash as the nonce.
 */
export class FakeGlobal {
    /** The door's own nonce, for a sign-in that has no vault ticket. */
    readonly nonce = 'door-nonce-1';
    /**
     * The vault ticket keys the door takes, and says it takes in its nonce answer (`vault`): the test vault's, as
     * global with `BEANPOOL_VAULT_TICKET_KEYS` set. Null: a door with none set (`vault: null`), which takes no ticket.
     */
    ticketKeys: string[] | null = [TICKET_KEY];
    /** A door from before V5, as main's is: no `vault` in its nonce answer, and only its own nonce lets a join in. */
    beforeV5 = false;
    /** Refuse every join that carries a ticket, 401 with this code (a ticket that ran out between the sheet and the join). */
    refuseTickets: string | null = null;

    // ── The 12-words door and adding a sign-in later (apps/server routes/open-join.ts, S2/S3) ─────────────────────
    /** The door's work key: the challenges it hands out are real ones, checked as the node checks them. */
    readonly workKey = new Uint8Array(32).fill(0x55);
    /** The level the work route hands out at each door; null: none needed (the sign-in door at ordinary rates). */
    workLevel: { words: number; 'sign-in': number | null } = { words: 0, 'sign-in': null };
    /** Work this door has taken, by challenge: spent once. */
    readonly spentWork = new Set<string>();
    /** The next N work checks refuse with this code, whatever was sent (a restart, a challenge that ran out). */
    refuseWork: { code: string; times: number } | null = null;
    /** A 12-words door that is shut (a sign-in required here). */
    wordsShut = false;
    /** Members by key: the door they came in by, as `open_joins` records it ('words', or the provider once linked). */
    readonly joined = new Map<string, string>();
    /** The link's own nonce (bound to `open-join-link:<key>` on the node). */
    readonly linkNonce = 'link-nonce-1';
    /** Sign-in accounts already someone's here, and removed members' (`provider:sub`). */
    readonly takenSignIns = new Set<string>();
    readonly removedSignIns = new Set<string>();
    /** The node's own clock, for the work's ten minutes. */
    now = () => Date.now();

    private checkWork(work: any, key: string, door: 'words' | 'sign-in'): Reply | null {
        if (this.refuseWork && this.refuseWork.times > 0) {
            this.refuseWork.times--;
            return reply(400, { error: 'Setting up your account didn\'t work out. Please try again.', code: this.refuseWork.code });
        }
        if (!work) return reply(400, { error: 'work required', code: 'work_required' });
        const issued = checkDoorWorkChallenge(work.challenge, { workKey: this.workKey, key, door, now: this.now() });
        if (!issued.ok) return reply(400, { error: 'x', code: issued.reason === 'expired' ? 'work_expired' : 'work_invalid' });
        if (this.spentWork.has(work.challenge)) return reply(400, { error: 'x', code: 'work_spent' });
        if (!checkDoorWorkSolution(work.challenge, work.counters).ok) return reply(400, { error: 'x', code: 'work_invalid' });
        this.spentWork.add(work.challenge);
        return null;
    }

    private handleWordsAndLink(req: SentRequest): Reply | null {
        const key = req.headers['X-Public-Key'];
        const b = req.body ?? {};
        if (req.method === 'POST' && req.path === '/api/join/work') {
            if (b.door === 'words' && this.wordsShut) return reply(403, { error: 'sign-in required', code: 'sign_in_required' });
            const level = this.workLevel[b.door as 'words' | 'sign-in'];
            if (level === null) return reply(200, { work: null, turnstile: null });
            const challenge = makeDoorWorkChallenge({ workKey: this.workKey, level, key, door: b.door, now: this.now() });
            return reply(200, { work: { challenge, level, parts: 8, bits: 7 + level, size: 65_536, expiresInSeconds: 600 }, turnstile: null });
        }
        if (req.method === 'POST' && req.path === '/api/join' && b.door === 'words') {
            if (this.wordsShut) return reply(403, { error: 'sign-in required', code: 'sign_in_required' });
            if (this.joined.has(key)) return reply(409, { error: 'This key is already a member of this community.', code: 'already_member' });
            const refused = this.checkWork(b.work, key, 'words');
            if (refused) return refused;
            this.joined.set(key, 'words');
            return reply(200, { success: true, member: { publicKey: key, callsign: b.callsign }, door: 'words' });
        }
        if (req.method === 'POST' && (req.path === '/api/join/link/sso-nonce' || req.path === '/api/join/link')) {
            const row = this.joined.get(key);
            if (!row) return reply(403, { error: 'Only an active member of this community can add a sign-in here.', code: 'not_a_member' });
            if (row !== 'words') return reply(409, { error: 'This account already has a sign-in.', code: 'already_linked' });
            if (req.path === '/api/join/link/sso-nonce') {
                return reply(200, { nonce: this.linkNonce, expiresInSeconds: 600, providers: ['apple', 'google', 'facebook'], vault: this.ticketKeys ? { ticketKeys: this.ticketKeys } : null });
            }
            const claims = claimsOf(b.idToken);
            if (typeof b.vaultTicket === 'string') {
                if (this.refuseTickets) return reply(401, { error: 'Your sign-in could not be used.', code: this.refuseTickets });
                const check = checkVaultTicket(b.vaultTicket, { ticketKeys: this.ticketKeys ?? [], now: Date.now(), key, purpose: 'deposit' });
                if (!check.ok) return reply(401, { error: 'x', code: DOOR_TICKET_CODES[check.reason] });
                if (claims?.nonce !== vaultTicketNonce(b.vaultTicket)) return reply(401, { error: 'x', code: 'sign_in' });
            } else if (claims?.nonce !== this.linkNonce || b.nonce !== this.linkNonce) {
                return reply(401, { error: 'Your sign-in could not be used.', code: 'sign_in' });
            }
            const account = `${b.provider}:${claims?.sub}`;
            if (this.removedSignIns.has(account)) return reply(403, { error: 'removed', code: 'removed' });
            if (this.takenSignIns.has(account)) return reply(409, { error: 'already', code: 'already_joined' });
            this.takenSignIns.add(account);
            this.joined.set(key, b.provider);
            const recovery = b.recovery ? { enrolled: true, generation: 1, enrolledSso: [b.provider], threshold: 1 } : undefined;
            return reply(200, { success: true, provider: b.provider, ...(recovery ? { recovery } : {}) });
        }
        return null;
    }

    handle(req: SentRequest): Reply {
        const wordsOrLink = this.handleWordsAndLink(req);
        if (wordsOrLink) return wordsOrLink;
        if (req.method === 'POST' && req.path === '/api/join/sso-nonce') {
            const answer = { nonce: this.nonce, expiresInSeconds: 600, providers: ['apple', 'google', 'facebook'] };
            if (this.beforeV5) return reply(200, answer);
            return reply(200, { ...answer, vault: this.ticketKeys ? { ticketKeys: this.ticketKeys } : null });
        }
        if (req.method === 'POST' && req.path === '/api/join') {
            const b = req.body ?? {};
            const signedIn = claimsOf(b.idToken)?.nonce;
            const refused = (code: string) => reply(401, { error: 'Your sign-in could not be used.', code });
            // From the 30th sign-in join an hour from one network, the door asks for work, checked before the sign-in.
            if (this.workLevel['sign-in'] !== null) {
                const noWork = this.checkWork(b.work, req.headers['X-Public-Key'], 'sign-in');
                if (noWork) return noWork;
            }
            if (typeof b.vaultTicket === 'string' && !this.beforeV5) {
                if (this.refuseTickets) return refused(this.refuseTickets);
                if (!this.ticketKeys) return refused('ticket_unsupported');
                const check = checkVaultTicket(b.vaultTicket, {
                    ticketKeys: this.ticketKeys, now: Date.now(), key: req.headers['X-Public-Key'], purpose: 'deposit',
                });
                if (!check.ok) return refused(DOOR_TICKET_CODES[check.reason]);
                if (b.nonce !== vaultTicketNonce(b.vaultTicket)) return reply(400, { error: 'The nonce is not this ticket\'s.', code: 'bad_request' });
                if (signedIn !== b.nonce) return refused('sign_in');
            } else if (signedIn !== this.nonce || b.nonce !== this.nonce) {
                // Before V5 a ticket rides along unread, and its hash is not a nonce this door gave out.
                return refused('sign_in');
            }
            return reply(200, { success: true, member: { publicKey: req.headers['X-Public-Key'], callsign: b.callsign } });
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
