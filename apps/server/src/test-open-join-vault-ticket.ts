/**
 * The open door takes key vault tickets (key vault V5; scratch/global-node/DESIGN-v5-global-door-vault-fable.md §1, §6):
 * a join whose sign-in is bound to a vault deposit ticket (`vaultTicket` in the body, the token's nonce the ticket's
 * hash) instead of the door's own nonce. Over REAL HTTPS through the real signature middleware. No provider and no
 * vault is contacted: the vault's ticket keys are made here, tickets are signed with @beanpool/core, and the Google and
 * Apple keys are test keys served by a stub that counts every request to a provider and refuses every other host.
 *
 *   T11a env unset: the nonce answer says `vault: null`, and a ticket join → 401 ticket_unsupported
 *   T1  a good join: member open:google, no invite code, join_hash = openJoinHash(google, sub), no sub, email, ticket or
 *       ticket `n` anywhere in the database, the funnel's attempt counted, and no copy kept here
 *   T2  one identity per sign-in account, whichever path: a ticket join for an account that joined by ticket, and one
 *       for an account that joined with the door's nonce → 409 already_joined
 *   T3  single use: the joined key again → 409 already_member; a ticket a refused join used, sent again → 401
 *       ticket_used; a self-deleted key is refused before the door (403 account_closed); with the used set forgotten (a
 *       restart) → not a 500, and at most one live record per join hash throughout; two sign-ins with one ticket at
 *       once → exactly one verifies
 *   T4  forged (another seed) → 401 ticket_signature, a random string or a non-string → 401 ticket_malformed: no
 *       provider asked, nothing written
 *   T5  a ticket for another key → 401 ticket_key, and its key then joins with it
 *   T6  a restore ticket → 401 ticket_purpose
 *   T7  expired a minute ago → 401 ticket_expired; dated 20 minutes ahead → 401 ticket_malformed
 *   T8  the door's own nonce in the token with a ticket in the body → 401 sign_in and the door's nonce not spent; a body
 *       nonce that is not the ticket's → 400, the ticket not spent
 *   T9  Apple's hashed nonce: sha256hex(the ticket's nonce) → 200
 *   T10 the door's own path is untouched: a ticket's nonce without the ticket → 401 sign_in, and the ticket still works
 *   T11 the advertised keys follow the env per request: two keys listed in order, a ticket by the second joins; cut to
 *       one, the other's tickets are refused, no restart; malformed or more than two → none; the boot line says each
 *   T12 refused before the sign-in, the ticket unspent: door_key_missing (503) and the address limit (429), no provider
 *       asked; the local profile → 404
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-open-join-vault-ticket.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;
delete process.env.FACEBOOK_CLIENT_IDS;
delete process.env.APPLE_SERVICES_ID;
delete process.env.BEANPOOL_VAULT_TICKET_KEYS;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { newVaultTicket, signVaultTicket, vaultTicketNonce, parseVaultTicket, type VaultTicketPurpose } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import * as sso from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { getFunnel } from './engine/funnel.js';
import { OPEN_JOIN_LIMITS, openJoinHash } from './engine/open-join.js';

let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── providers: test keys, served by a stub that counts ──────────────────────────────────────────
const GOOGLE_KID = 'test-door-vault-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const APPLE_KID = 'test-door-vault-apple';
const APPLE_AUD = 'org.beanpool.pillar';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const apple = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (k: crypto.KeyObject, kid: string) => ({ ...k.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }) as any;
const PROVIDER_KEYS: Record<string, unknown> = {
    'https://www.googleapis.com/oauth2/v3/certs': { keys: [jwk(google.publicKey, GOOGLE_KID)] },
    'https://appleid.apple.com/auth/keys': { keys: [jwk(apple.publicKey, APPLE_KID)] },
};

/** Every request this process makes to a host that is not this machine: a provider's keys, or a refusal. */
let providerFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return realFetch(input, init);
    providerFetches++;
    const keys = PROVIDER_KEYS[url.href];
    if (keys) return new Response(JSON.stringify(keys), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new TypeError(`this suite reaches no host but this machine and the stubbed provider keys (${url.host})`);
}) as typeof fetch;

/** No provider keys cached: a sign-in that is checked must now ask the stub, so a count that stays put means none was. */
function forgetProviderKeys(): void {
    sso._resetJwksCacheForTests();
}

type Provider = 'google' | 'apple';
function mint(provider: Provider, o: { sub: string; nonce: string; email?: string }): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: provider === 'google' ? GOOGLE_KID : APPLE_KID, typ: 'JWT' });
    const payload = b64({
        iss: provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com',
        aud: provider === 'google' ? GOOGLE_AUD : APPLE_AUD,
        sub: o.sub, email: o.email, email_verified: true, iat: now, exp: now + 3600, nonce: o.nonce,
    });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), provider === 'google' ? google.privateKey : apple.privateKey).toString('base64url');
    return `${header}.${payload}.${sig}`;
}

// ── the vault's ticket keys (made here; only their public halves go in the env) ─────────────────
const vaultSeedA = new Uint8Array(crypto.randomBytes(32));
const vaultSeedB = new Uint8Array(crypto.randomBytes(32));
const strangerSeed = new Uint8Array(crypto.randomBytes(32));
const pub = (seed: Uint8Array) => Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
const VAULT_KEY_A = pub(vaultSeedA);
const VAULT_KEY_B = pub(vaultSeedB);

function ticketFor(key: string, o: { purpose?: VaultTicketPurpose; seed?: Uint8Array; exp?: number } = {}): string {
    const t = newVaultTicket(key, o.purpose ?? 'deposit', Date.now());
    if (o.exp !== undefined) t.exp = o.exp;
    return signVaultTicket(t, o.seed ?? vaultSeedA);
}

// ── joiners ─────────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

/** Set while a block tests the per-address join limit itself; otherwise every join first moves earlier joins a day back. */
let holdJoinLimit = false;

async function call(id: Id, route: string, body: unknown): Promise<{ status: number; body: any }> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    if (!holdJoinLimit) {
        // Every join here comes from one address; this suite tests the ticket, not the 5-an-hour limit (T12 does that).
        const dayAgo = new Date(Date.now() - 25 * 3600_000).toISOString();
        db.prepare('UPDATE open_joins SET joined_at = ? WHERE joined_at > ?').run(dayAgo, dayAgo);
    }
    const raw = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${route}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${route}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: raw,
    });
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    return { status: res.status, body: parsed };
}

const nonceAnswer = (id: Id) => call(id, '/api/join/sso-nonce', {});

async function doorNonce(id: Id): Promise<string> {
    const r = await nonceAnswer(id);
    if (r.status !== 200 || typeof r.body?.nonce !== 'string') throw new Error(`no join nonce: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.nonce;
}

/** A join bound to `ticket`: the token's nonce is the ticket's hash (or `tokenNonce`), the body carries both. */
function ticketJoin(id: Id, ticket: string, o: { sub: string; provider?: Provider; email?: string; tokenNonce?: string; bodyNonce?: string; callsign?: string }) {
    const provider = o.provider ?? 'google';
    const nonce = vaultTicketNonce(ticket);
    return call(id, '/api/join', {
        callsign: o.callsign ?? 'Joiner',
        provider,
        idToken: mint(provider, { sub: o.sub, nonce: o.tokenNonce ?? nonce, email: o.email }),
        nonce: o.bodyNonce ?? nonce,
        vaultTicket: ticket,
    });
}

/** A join with the door's own nonce, as every phone did before V5. */
async function doorJoin(id: Id, sub: string, callsign = 'Joiner') {
    const n = await doorNonce(id);
    return call(id, '/api/join', { callsign, provider: 'google', idToken: mint('google', { sub, nonce: n }), nonce: n });
}

const memberRow = (pk: string) => db.prepare('SELECT * FROM members WHERE public_key = ?').get(pk) as any;
const joinRow = (pk: string) => db.prepare('SELECT * FROM open_joins WHERE member_pubkey = ?').get(pk) as any;
const countJoins = () => (db.prepare('SELECT COUNT(*) AS n FROM open_joins').get() as any).n as number;
const countMembers = () => (db.prepare('SELECT COUNT(*) AS n FROM members').get() as any).n as number;
const liveRowsFor = (hash: string) => (db.prepare('SELECT COUNT(*) AS n FROM open_joins WHERE join_hash = ?').get(hash) as any).n as number;
function funnelCount(event: string, variant: string): number {
    return getFunnel(1).filter(r => r.event === event && r.variant === variant).reduce((n, r) => n + r.count, 0);
}
const said = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)}`;
const refused = (r: { status: number; body: any }, code: string) => r.status === 401 && r.body?.code === code;

async function main(): Promise<void> {
    console.log('\n=== The open door takes key vault tickets (V5) ===\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    forgetProviderKeys();
    sso._clearNoncesForTests();
    process.env.NODE_PROFILE = 'global';

    // ── T11a. no keys: the door says so, and takes no ticket ─────────────────────────────────────
    console.log('── T11a. no keys set: vault null, tickets unsupported ──');
    const zed = newId();
    const zedAnswer = await nonceAnswer(zed);
    assert(zedAnswer.status === 200 && 'vault' in (zedAnswer.body ?? {}) && zedAnswer.body.vault === null,
        `env unset: the nonce answer says vault: null (got ${said(zedAnswer)})`);
    const zedJoin = await ticketJoin(zed, ticketFor(zed.pk), { sub: 'zed-google-sub' });
    assert(refused(zedJoin, 'ticket_unsupported'), `env unset: a ticket join → 401 ticket_unsupported (got ${said(zedJoin)})`);
    assert(!memberRow(zed.pk), '...and nobody joined');
    assert(funnelCount('open_join_failed', 'ticket_unsupported') === 1, 'the funnel counts it as open_join_failed:ticket_unsupported');

    process.env.BEANPOOL_VAULT_TICKET_KEYS = VAULT_KEY_A;
    const oneKey = await nonceAnswer(newId());
    assert(oneKey.status === 200 && JSON.stringify(oneKey.body?.vault) === JSON.stringify({ ticketKeys: [VAULT_KEY_A] }) && typeof oneKey.body?.nonce === 'string',
        `env set: the nonce answer lists the key, beside the door's own nonce (got ${JSON.stringify(oneKey.body?.vault)})`);

    // ── T1. a good join ──────────────────────────────────────────────────────────────────────────
    console.log('\n── T1. a good ticket join ──');
    const ada = newId();
    const ADA_SUB = '110169484474386276001';
    const ADA_EMAIL = 'door-vault-ada@example.com';
    const adaTicket = ticketFor(ada.pk);
    const adaN = parseVaultTicket(adaTicket)!.payload.n;
    const attemptsBefore = funnelCount('open_join_attempt', 'google');
    const membersBefore = countMembers();
    const good = await ticketJoin(ada, adaTicket, { sub: ADA_SUB, email: ADA_EMAIL, callsign: 'Ada' });
    assert(good.status === 200 && good.body?.success === true && good.body?.member?.publicKey === ada.pk && good.body?.provider === 'google',
        `a deposit ticket for Ada's key and a Google token carrying its hash → 200 (got ${said(good)})`);
    assert(good.body?.recovery === undefined, 'the answer has no recovery part: no copy rode in, none is kept here');
    const adaRow = memberRow(ada.pk);
    assert(adaRow?.invited_by === 'open:google' && adaRow?.invite_code === null && countMembers() === membersBefore + 1,
        `the member is open:google with no invite code (got ${adaRow?.invited_by}, ${adaRow?.invite_code})`);
    const ADA_HASH = openJoinHash('google', ADA_SUB);
    assert(joinRow(ada.pk)?.join_hash === ADA_HASH && joinRow(ada.pk)?.provider === 'google',
        'the open_joins row holds openJoinHash(google, sub), exactly as a door-nonce join makes it');
    const image = db.serialize();
    assert(!image.includes(Buffer.from(ADA_SUB)) && !image.includes(Buffer.from(ADA_EMAIL)), 'neither the raw sub nor the email is anywhere in the database');
    assert(!image.includes(Buffer.from(adaTicket)) && !image.includes(Buffer.from(adaN)) && !image.includes(Buffer.from(vaultTicketNonce(adaTicket))),
        'nor the ticket, its n, or its nonce');
    assert(!image.includes(Buffer.from(VAULT_KEY_A)), 'nor the vault\'s ticket key: it is env config only');
    assert((db.prepare('SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ?').get(ada.pk) as any).n === 0, 'and no recovery copy for Ada here');
    assert(funnelCount('open_join_attempt', 'google') === attemptsBefore + 1, 'the funnel counts the attempt (open_join_attempt:google)');

    // ── T2. one identity per sign-in account, whichever path verified it ─────────────────────────
    console.log('\n── T2. one sign-in account, one identity, either path ──');
    const ben = newId();
    const benFirstTicket = ticketFor(ben.pk);
    const benWithAdasAccount = await ticketJoin(ben, benFirstTicket, { sub: ADA_SUB });
    assert(benWithAdasAccount.status === 409 && benWithAdasAccount.body?.code === 'already_joined',
        `Ben's key, Ben's own ticket, Ada's Google account → 409 already_joined (got ${said(benWithAdasAccount)})`);
    assert(!memberRow(ben.pk) && !joinRow(ben.pk), '...and Ben did not join');
    const cal = newId();
    const CAL_SUB = '110169484474386276003';
    const calDoor = await doorJoin(cal, CAL_SUB, 'Cal');
    assert(calDoor.status === 200, `Cal joins with the door's own nonce (got ${said(calDoor)})`);
    const dee = newId();
    const deeWithCalsAccount = await ticketJoin(dee, ticketFor(dee.pk), { sub: CAL_SUB });
    assert(deeWithCalsAccount.status === 409 && deeWithCalsAccount.body?.code === 'already_joined',
        `an account that joined with the door's nonce, then a ticket join for it from another key → 409 already_joined (got ${said(deeWithCalsAccount)})`);
    assert(!memberRow(dee.pk), '...and that key did not join');

    // ── T3. single use ───────────────────────────────────────────────────────────────────────────
    console.log('\n── T3. a ticket is used once ──');
    assert(liveRowsFor(ADA_HASH) === 1, 'one live record for Ada\'s account');
    const adaAgain = await ticketJoin(ada, adaTicket, { sub: ADA_SUB, callsign: 'Ada' });
    assert(adaAgain.status === 409 && adaAgain.body?.code === 'already_member', `Ada's ticket and token again → 409 already_member (got ${said(adaAgain)})`);
    assert(liveRowsFor(ADA_HASH) === 1, 'still one live record');
    // Ben's first ticket was used by the join refused in T2 (its sign-in checked out, the account was Ada's). Sent again,
    // now with his own account, it is a clean refusal of the ticket, not a 409 that blames a sign-in account.
    const BEN_SUB = '110169484474386276002';
    const BEN_HASH = openJoinHash('google', BEN_SUB);
    const usedFunnel = funnelCount('open_join_failed', 'ticket_used');
    const benResend = await ticketJoin(ben, benFirstTicket, { sub: BEN_SUB, callsign: 'Ben' });
    assert(refused(benResend, 'ticket_used'), `a ticket a refused join used, sent again → 401 ticket_used (got ${said(benResend)})`);
    assert(funnelCount('open_join_failed', 'ticket_used') === usedFunnel + 1, 'counted as open_join_failed:ticket_used');
    assert(!memberRow(ben.pk) && liveRowsFor(BEN_HASH) === 0, 'and nothing was written');
    // A self-deleted key's account is closed: the signature middleware refuses it before the door reads anything, so
    // Ada can't send her ticket again at all (the design expected ticket_used here; measured, it never gets that far).
    const purge = await call(ada, '/api/member/purge', {});
    assert(purge.status === 200, `Ada deletes her own account (got ${said(purge)})`);
    assert(liveRowsFor(ADA_HASH) === 0, 'which frees her sign-in account (no live record)');
    const adaReplay = await ticketJoin(ada, adaTicket, { sub: ADA_SUB, callsign: 'Ada' });
    assert(adaReplay.status === 403 && adaReplay.body?.code === 'account_closed',
        `the same ticket and token after she deleted herself → refused before the door, 403 account_closed (got ${said(adaReplay)})`);
    assert(liveRowsFor(ADA_HASH) === 0, 'and no record was made');
    // The used set forgotten, as a restart forgets it: the key holder lands where a fresh sign-in would.
    sso._clearUsedTicketsForTests?.();
    const adaAfterRestart = await ticketJoin(ada, adaTicket, { sub: ADA_SUB, callsign: 'Ada' });
    assert(adaAfterRestart.status < 500 && liveRowsFor(ADA_HASH) <= 1,
        `with the used set forgotten (a restart), Ada's again is an answer, not a 500, and at most one live record (got ${said(adaAfterRestart)}, ${liveRowsFor(ADA_HASH)})`);
    const benAfterRestart = await ticketJoin(ben, benFirstTicket, { sub: BEN_SUB, callsign: 'Ben' });
    assert(benAfterRestart.status === 200 && liveRowsFor(BEN_HASH) === 1 && liveRowsFor(ADA_HASH) <= 1,
        `and Ben's used ticket joins him with his own account, one live record for it (got ${said(benAfterRestart)}, ${liveRowsFor(BEN_HASH)})`);
    // Two sign-ins with one ticket at once, at the verifier itself: exactly one uses it.
    const twinId = newId();
    const twinTicket = ticketFor(twinId.pk);
    const twin = { nonce: vaultTicketNonce(twinTicket), n: parseVaultTicket(twinTicket)!.payload.n, exp: parseVaultTicket(twinTicket)!.payload.exp };
    const twinToken = { idToken: mint('google', { sub: 'twin-google-sub', nonce: twin.nonce }) };
    // (Read through the module so this suite still runs, and fails, on a server without the verifier.)
    const twins = typeof sso.verifySignInWithVaultTicket === 'function'
        ? await Promise.allSettled([0, 1].map(() => sso.verifySignInWithVaultTicket('google', twinToken, [GOOGLE_AUD], twin, `open-join:${twinId.pk}`)))
        : [];
    assert(twins.filter(t => t.status === 'fulfilled').length === 1 && twins.filter(t => t.status === 'rejected').length === 1
        && sso.vaultTicketUsed?.(twin.n) === true,
        `two sign-ins with one ticket at once: exactly one verifies, and the ticket is used (${twins.map(t => t.status).join(', ') || 'no verifier'})`);

    // ── T4. forged ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── T4. a ticket the vault did not sign ──');
    const eve = newId();
    forgetProviderKeys();
    const fetchesBefore = providerFetches;
    const joinsBefore = countJoins();
    const forged = await ticketJoin(eve, ticketFor(eve.pk, { seed: strangerSeed }), { sub: 'eve-google-sub' });
    assert(refused(forged, 'ticket_signature'), `signed by another seed → 401 ticket_signature (got ${said(forged)})`);
    const junk = await ticketJoin(eve, crypto.randomBytes(48).toString('base64url'), { sub: 'eve-google-sub' });
    assert(refused(junk, 'ticket_malformed'), `a random string → 401 ticket_malformed (got ${said(junk)})`);
    const notAString = await call(eve, '/api/join', { callsign: 'Eve', provider: 'google', idToken: mint('google', { sub: 'eve-google-sub', nonce: 'x' }), nonce: 'x', vaultTicket: 12345 });
    assert(refused(notAString, 'ticket_malformed'), `a vaultTicket that is not a string → 401 ticket_malformed, not the door's own path (got ${said(notAString)})`);
    assert(providerFetches === fetchesBefore, `no provider was asked for its keys (${providerFetches - fetchesBefore} requests)`);
    assert(!memberRow(eve.pk) && countJoins() === joinsBefore, 'nothing was written');
    assert(funnelCount('open_join_failed', 'ticket_signature') === 1 && funnelCount('open_join_failed', 'ticket_malformed') === 2,
        'the funnel counts each with its code');

    // ── T5. a ticket for another key ─────────────────────────────────────────────────────────────
    console.log('\n── T5. a ticket names one key ──');
    const fay = newId();
    const quinn = newId();
    const quinnTicket = ticketFor(quinn.pk);
    const lifted = await ticketJoin(fay, quinnTicket, { sub: 'fay-google-sub' });
    assert(refused(lifted, 'ticket_key'), `Quinn's ticket on a join signed by Fay → 401 ticket_key (got ${said(lifted)})`);
    assert(!memberRow(fay.pk), '...and Fay did not join');
    assert(providerFetches === fetchesBefore, 'still no provider asked');
    const quinnJoin = await ticketJoin(quinn, quinnTicket, { sub: 'quinn-google-sub', callsign: 'Quinn' });
    assert(quinnJoin.status === 200 && memberRow(quinn.pk)?.invited_by === 'open:google', `Quinn then joins with it (got ${said(quinnJoin)})`);
    assert(providerFetches === fetchesBefore + 1, `and that sign-in was checked against the provider's keys (the stub counts: ${providerFetches - fetchesBefore})`);

    // ── T6. purpose ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── T6. a restore ticket is not a door ticket ──');
    const gus = newId();
    const restore = await ticketJoin(gus, ticketFor(gus.pk, { purpose: 'restore' }), { sub: 'gus-google-sub' });
    assert(refused(restore, 'ticket_purpose'), `a restore ticket → 401 ticket_purpose (got ${said(restore)})`);
    assert(!memberRow(gus.pk), '...and nobody joined');

    // ── T7. time ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n── T7. a ticket\'s time ──');
    const expired = await ticketJoin(gus, ticketFor(gus.pk, { exp: Date.now() - 60_000 }), { sub: 'gus-google-sub' });
    assert(refused(expired, 'ticket_expired'), `expired a minute ago → 401 ticket_expired (got ${said(expired)})`);
    const future = await ticketJoin(gus, ticketFor(gus.pk, { exp: Date.now() + 20 * 60_000 }), { sub: 'gus-google-sub' });
    assert(refused(future, 'ticket_malformed'), `expiring 20 minutes ahead (beyond 10 min + 2 min skew) → 401 ticket_malformed (got ${said(future)})`);
    assert(!memberRow(gus.pk), '...and nobody joined');

    // ── T8. the nonce is the ticket's ────────────────────────────────────────────────────────────
    console.log('\n── T8. a request does not mix the two paths ──');
    const hal = newId();
    const halDoorNonce = await doorNonce(hal);
    const halTicket = ticketFor(hal.pk);
    const mixed = await ticketJoin(hal, halTicket, { sub: 'hal-google-sub', tokenNonce: halDoorNonce });
    assert(refused(mixed, 'sign_in'), `a token carrying the door's own nonce, with a valid ticket in the body → 401 sign_in (got ${said(mixed)})`);
    assert(!memberRow(hal.pk), '...and Hal did not join');
    const halDoor = await call(hal, '/api/join', { callsign: 'Hal', provider: 'google', idToken: mint('google', { sub: 'hal-google-sub', nonce: halDoorNonce }), nonce: halDoorNonce });
    assert(halDoor.status === 200, `the door's nonce was not spent: Hal joins with it afterwards (got ${said(halDoor)})`);
    const ivy = newId();
    const ivyTicket = ticketFor(ivy.pk);
    const wrongBodyNonce = await ticketJoin(ivy, ivyTicket, { sub: 'ivy-google-sub', bodyNonce: await doorNonce(ivy) });
    assert(wrongBodyNonce.status === 400 && wrongBodyNonce.body?.code === 'bad_request',
        `a body nonce that is not the ticket's hash → 400 bad_request (got ${said(wrongBodyNonce)})`);
    const ivyJoin = await ticketJoin(ivy, ivyTicket, { sub: 'ivy-google-sub', callsign: 'Ivy' });
    assert(ivyJoin.status === 200, `...which spent nothing: the same ticket and token then join (got ${said(ivyJoin)})`);

    // ── T9. Apple ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── T9. Apple\'s hashed nonce ──');
    const jay = newId();
    const jayTicket = ticketFor(jay.pk);
    const hashed = crypto.createHash('sha256').update(vaultTicketNonce(jayTicket), 'utf-8').digest('hex');
    const jayJoin = await ticketJoin(jay, jayTicket, { provider: 'apple', sub: '001234.jayjayjayjayjayjayjayjayjayjay.0009', tokenNonce: hashed, callsign: 'Jay' });
    assert(jayJoin.status === 200 && memberRow(jay.pk)?.invited_by === 'open:apple',
        `an Apple token carrying sha256hex(the ticket's nonce) → 200 open:apple (got ${said(jayJoin)})`);

    // ── T10. the door's own path ─────────────────────────────────────────────────────────────────
    console.log('\n── T10. the door\'s own nonce path is unchanged ──');
    const kim = newId();
    const kimTicket = ticketFor(kim.pk);
    const kimNonce = vaultTicketNonce(kimTicket);
    const noTicket = await call(kim, '/api/join', { callsign: 'Kim', provider: 'google', idToken: mint('google', { sub: 'kim-google-sub', nonce: kimNonce }), nonce: kimNonce });
    assert(refused(noTicket, 'sign_in'), `a token with a ticket's nonce and no vaultTicket → 401 sign_in: the door's nonces are its own (got ${said(noTicket)})`);
    const kimJoin = await ticketJoin(kim, kimTicket, { sub: 'kim-google-sub', callsign: 'Kim' });
    assert(kimJoin.status === 200, `...and the ticket was not spent by it (got ${said(kimJoin)})`);

    // ── T11. the advertised keys, per request ────────────────────────────────────────────────────
    console.log('\n── T11. the keys the door takes follow the env, per request ──');
    process.env.BEANPOOL_VAULT_TICKET_KEYS = ` ${VAULT_KEY_B} , ${VAULT_KEY_A} `;
    const lea = newId();
    const twoKeys = await nonceAnswer(lea);
    assert(JSON.stringify(twoKeys.body?.vault) === JSON.stringify({ ticketKeys: [VAULT_KEY_B, VAULT_KEY_A] }),
        `two keys (spaces forgiven): the answer lists both, newest first (got ${JSON.stringify(twoKeys.body?.vault)})`);
    const leaJoin = await ticketJoin(lea, ticketFor(lea.pk, { seed: vaultSeedA }), { sub: 'lea-google-sub', callsign: 'Lea' });
    assert(leaJoin.status === 200, `a ticket signed by the second (older) key joins (got ${said(leaJoin)})`);
    process.env.BEANPOOL_VAULT_TICKET_KEYS = VAULT_KEY_B;
    const max = newId();
    const cut = await ticketJoin(max, ticketFor(max.pk, { seed: vaultSeedA }), { sub: 'max-google-sub' });
    assert(refused(cut, 'ticket_signature'), `env cut to the newer key, no restart: the older key's tickets → 401 ticket_signature (got ${said(cut)})`);
    const maxJoin = await ticketJoin(max, ticketFor(max.pk, { seed: vaultSeedB }), { sub: 'max-google-sub', callsign: 'Max' });
    assert(maxJoin.status === 200, `and the newer key's tickets join (got ${said(maxJoin)})`);
    const keysModule = await import('./services/vault-ticket-keys.js').catch(() => null);
    const line = (env: string | undefined, open = true) => keysModule
        ? keysModule.vaultTicketKeysLine(open, env === undefined ? {} : { BEANPOOL_VAULT_TICKET_KEYS: env })
        : 'no module';
    for (const [label, value] of [
        ['upper-case hex', VAULT_KEY_A.toUpperCase()],
        ['not a key', 'not-a-key'],
        ['three keys', `${VAULT_KEY_A},${VAULT_KEY_B},${pub(strangerSeed)}`],
    ] as const) {
        process.env.BEANPOOL_VAULT_TICKET_KEYS = value;
        const answer = await nonceAnswer(newId());
        const nobody = newId();
        const join = await ticketJoin(nobody, ticketFor(nobody.pk), { sub: `${label}-sub` });
        assert(answer.status === 200 && answer.body?.vault === null && refused(join, 'ticket_unsupported'),
            `env ${label}: no keys, so vault: null and a ticket → 401 ticket_unsupported (got ${JSON.stringify(answer.body?.vault)}, ${said(join)})`);
        assert(/^⚠️ Open door: BEANPOOL_VAULT_TICKET_KEYS .+, so the door takes no key vault tickets/.test(String(line(value))), `and the boot line warns (${line(value)})`);
    }
    assert(/takes no vault tickets/.test(String(line(undefined))) && line(undefined, false) === null,
        `boot line, unset: says the open door takes no tickets, and nothing on a shut door (${line(undefined)})`);
    assert(String(line(`${VAULT_KEY_B},${VAULT_KEY_A}`)).includes(VAULT_KEY_B.slice(0, 8)) && /2 keys, newest first/.test(String(line(`${VAULT_KEY_B},${VAULT_KEY_A}`))),
        `boot line, two keys: names them, newest first (${line(`${VAULT_KEY_B},${VAULT_KEY_A}`)})`);
    process.env.BEANPOOL_VAULT_TICKET_KEYS = VAULT_KEY_A;

    // ── T12. refused before the sign-in, the ticket unspent ──────────────────────────────────────
    console.log('\n── T12. what the door refuses before it reads a ticket ──');
    const ned = newId();
    const nedTicket = ticketFor(ned.pk);
    const keyFile = path.join(process.env.BEANPOOL_DATA_DIR!, 'open-join.key');
    const keyAside = `${keyFile}.aside`;
    fs.renameSync(keyFile, keyAside);
    forgetProviderKeys();
    const fetchesAtKey = providerFetches;
    let keyMissing: { status: number; body: any };
    try {
        keyMissing = await ticketJoin(ned, nedTicket, { sub: 'ned-google-sub', callsign: 'Ned' });
    } finally {
        fs.renameSync(keyAside, keyFile);
    }
    assert(keyMissing.status === 503 && keyMissing.body?.code === 'door_key_missing',
        `the door's key file moved away → 503 door_key_missing, with a ticket too (got ${said(keyMissing)})`);
    assert(providerFetches === fetchesAtKey, 'no provider was asked');
    const nedJoin = await ticketJoin(ned, nedTicket, { sub: 'ned-google-sub', callsign: 'Ned' });
    assert(nedJoin.status === 200, `the key back: the same ticket and token join (the 503 spent nothing) (got ${said(nedJoin)})`);

    holdJoinLimit = true;
    const ipHash = joinRow(ned.pk)?.ip_hash as string;
    const recentFromHere = () => (db.prepare('SELECT COUNT(*) AS n FROM open_joins WHERE ip_hash = ? AND joined_at > ?')
        .get(ipHash, new Date(Date.now() - 3600_000).toISOString()) as any).n as number;
    const fakes: string[] = [];
    const insertFake = db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, ip_hash) VALUES (?, ?, ?, ?, ?)');
    for (let i = recentFromHere(); i < OPEN_JOIN_LIMITS.perHour; i++) {
        const pk = crypto.randomBytes(32).toString('hex');
        fakes.push(pk);
        insertFake.run(pk, 'google', crypto.randomBytes(32).toString('base64url'), new Date().toISOString(), ipHash);
    }
    const oli = newId();
    const oliTicket = ticketFor(oli.pk);
    forgetProviderKeys();
    const fetchesAtLimit = providerFetches;
    const limited = await ticketJoin(oli, oliTicket, { sub: 'oli-google-sub', callsign: 'Oli' });
    assert(limited.status === 429 && limited.body?.code === 'rate_limited',
        `the ${OPEN_JOIN_LIMITS.perHour + 1}th join from one address in an hour, with a ticket → 429 (got ${said(limited)})`);
    assert(providerFetches === fetchesAtLimit, 'before the sign-in is checked: no provider asked');
    for (const pk of fakes) db.prepare('DELETE FROM open_joins WHERE member_pubkey = ?').run(pk);
    holdJoinLimit = false;
    const oliJoin = await ticketJoin(oli, oliTicket, { sub: 'oli-google-sub', callsign: 'Oli' });
    assert(oliJoin.status === 200, `under the limit again: the same ticket joins (got ${said(oliJoin)})`);

    delete process.env.NODE_PROFILE;
    const pia = newId();
    const local = await ticketJoin(pia, ticketFor(pia.pk), { sub: 'pia-google-sub' });
    assert(local.status === 404 && local.body?.code === 'invite_only', `the local profile: a ticket join → 404 invite_only (got ${said(local)})`);
    assert((await nonceAnswer(pia)).status === 404, 'and the nonce answer → 404');
    delete process.env.BEANPOOL_VAULT_TICKET_KEYS;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The open door takes key vault tickets: offline, bound to the joining key, once, and only the keys its operator pinned.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
