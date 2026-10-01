/**
 * The open door (global profile, design §2.2): join with a one-time sign-in, or with 12 words alone, instead of an
 * invite (the two-doors design, scratch/global-node/DESIGN-global-two-doors-fable.md).
 *
 *   POST /api/join/work          { door: 'words' | 'sign-in' }  → { work: { challenge, level, parts, bits, size, expiresInSeconds } | null, turnstile: null }
 *   POST /api/join/sso-nonce     → { nonce, expiresInSeconds, providers, clientIds, vault }   (the recovery nonce's shape, and `vault`)
 *   POST /api/join               { callsign, provider, idToken, nonce, recovery?: { shares }, vaultTicket?, work? }
 *                                { door: 'words', callsign, work }
 *   POST /api/join/link/sso-nonce   (a 12-words member) → the nonce answer above, bound to adding a sign-in
 *   POST /api/join/link             (a 12-words member) { provider, idToken, nonce, recovery?: { shares }, vaultTicket? }
 *
 * All answer 404 "This community is invite-only." unless the profile switch `openJoin` is on (config/node-
 * profile.ts): off on every local node, on by default on the global one, and never on a node whose ledger has moved,
 * whatever the profile or an override says, so open sign-up never meets a live credit system. Read per request, so an
 * operator's override takes effect without a restart, and the first Bean that moves shuts the door.
 *
 * ## Two doors (design §2)
 *
 * Where `ssoRequiredForJoin` is off (the global profile's default; `features.wordsDoor` in /api/community/info), a join
 * may carry `door: 'words'`: a name and the door work, and no provider, token, nonce, recovery or ticket (400 if it
 * carries any: one request, one path). The signed request is the proof the phone holds the key, as it is for a sign-in;
 * nothing about the person is kept but the key, the name and, for a day, the keyed hash of their network. The member is
 * `invited_by = 'open:words'` with an `open_joins` row of provider `words` (engine/open-join.ts). Where the switch is on,
 * the 12-words door answers 403 `sign_in_required`, and the sign-in door is the only one, as before. The sign-in door is
 * open beside it whatever happens to the 12-words one: never a dead end.
 *
 * A 12-words join needs no door key (services/open-join-key.ts): there is no sign-in to compare. So a server that answers
 * a sign-in 503 `door_key_missing` still takes 12-words joins. Adding a sign-in later needs the key, as joining with one.
 *
 * ## Door work (design §3, services/door-work.ts)
 *
 * `POST /api/join/work` hands the joining key a challenge bound to it and to the door, at the level the door's signal
 * asks for now (engine/door-signal.ts): always some for the 12 words, none for a sign-in at ordinary rates
 * (`work: null`). The app solves it while the person types their name, and the join carries `work: { challenge,
 * counters }`. It is checked after the signature, the key's spelling, the limiter, the body and the ceilings, and before
 * the sign-in is verified or anything is written, so a work refusal never spends a nonce or a ticket. Its refusals are
 * 400 `work_required`, `work_invalid`, `work_expired` and `work_spent`, and an app answers each the same way: a new
 * challenge, solved again, by itself. An app from before the work sends none; at the sign-in door it needs none until 30
 * people an hour have joined from its network, and from there its 400 says to update the app.
 *
 * The level is set when the challenge is issued and not checked again at the join: a challenge is good for ten minutes,
 * and the ceilings below are checked at the join itself.
 *
 * ## Signed by the joiner's new key, all of them
 *
 * None of these routes is on the signature bypass list. The real `requireSignature` middleware proves the caller holds
 * the key they are joining with, and the new member is the signer (`ctx.state.actor`, in the spelling below), never
 * a body field: the opposite of `/api/invite/redeem`, which is bypassed and takes `publicKey` from the body. The
 * middleware's spoof guard also refuses a body `publicKey` that names anyone but the signer. A signed request does
 * not need a member, so a key nobody has seen before can ask; it is what makes the key the thing the sign-in (and the
 * work) is bound to.
 *
 * ## The nonce is bound to that key, for this door only
 *
 * `issueNonce` binds a nonce to a subject and `verifyIdToken` only consumes it for the same subject (sso.ts). Here
 * the subject is `open-join:<key>`: a token obtained for one key's join cannot join another key (so a token lifted
 * from a joiner cannot claim their sign-in account for somebody else's key), and a join nonce cannot be spent on
 * the recovery routes, whose nonces are bound to the bare key, nor the other way round. One nonce, one
 * verification, consumed once. Adding a sign-in has its own subject, `open-join-link:<key>`, so neither door's nonce
 * is spent on the other.
 *
 * A key a re-key replaced is refused on all of them (403 `key_invalidated`): it is no member any more, but every write it
 * signs is refused, so it would join as a member nobody can use (engine/open-join.ts).
 *
 * A server that holds sign-in records but not the key they were made with (restored from a plain backup, promoted by
 * hand without the take-over keys) refuses every sign-in too, before the sign-in is checked (503 `door_key_missing`,
 * services/open-join-key.ts): it cannot tell a returning account from a new one, so it lets neither in.
 *
 * ## One key, one spelling
 *
 * The middleware verifies `X-Public-Key` by decoding its hex, which forgives case, so one keypair signs as `ab12…`
 * and as `AB12…`. Taken as sent, those were two keys here: one keypair joined twice, with two sign-in accounts.
 * So every door route takes the signer's key in the one spelling the member table keeps, 64 lower-case hex
 * characters (`canonicalKey`), before any check or write: the nonce and the work are bound to it, the
 * member and the `open_joins` row are written under it, and an upper-case spelling of a member's key is that
 * member (409 `already_member`). A spelling with anything else in it, which the decoder would skip, is refused
 * (400 `bad_key`).
 *
 * ## One sign-in, two jobs (design §2.3)
 *
 * `recovery: { shares }` enrols the SAME sign-in account as the new member's recovery keeper, in this request,
 * from the identity just verified: the body `POST /api/recovery/shares/sso` takes, minus the token and nonce this
 * request already carries. The shares are checked before the token is verified, so a malformed split is refused
 * (400) without spending the nonce. The token is never verified twice and the lookup hash is still derived by the
 * node from the verified `sub` (engine/keeper-deposit.ts). If storing the split fails the join still stands (never
 * a hard gate, and the 12 words are the key): the answer says so, and the app enrols the ordinary way. Adding a sign-in
 * later (`/api/join/link`) does the same two jobs.
 *
 * ## Or a key vault ticket instead of the door's nonce (key vault V5)
 *
 * A phone built with BeanPool's key vault asks the vault for a deposit ticket naming the joining key and binds the
 * sign-in to it: the token's nonce is the ticket's hash (@beanpool/core `vaultTicketNonce`), so the one token joins here
 * and deposits the member's copy at the vault (scratch/global-node/DESIGN-v5-global-door-vault-fable.md). The join then
 * carries `vaultTicket`, and the ticket, not a nonce this door issued, decides the nonce. Everything the door checks
 * before a sign-in still comes first (the door open, signed, the key's spelling, the limiters, the body, already a
 * member, a replaced key, the door's key, the ceilings, the work). Then the ticket is checked offline, with no provider and
 * no vault asked: signed by one of the vault's public ticket keys the operator pinned in .env (services/vault-ticket-
 * keys.ts, never from the network), unexpired, for a deposit, naming the key that signed this request, and not used
 * here before. Each refusal is a 401 with its code (`ticket_unsupported` when no key is pinned, `ticket_malformed`,
 * `ticket_signature`, `ticket_expired`, `ticket_key`, `ticket_purpose`, `ticket_used`), so a phone falls back to the
 * door's own nonce. The body's `nonce` must be the ticket's (400 otherwise: one request, one path), and the sign-in is
 * checked by the same verifier, consuming the ticket instead of a nonce (sso.ts). From there the join is the same:
 * one `join_hash` per sign-in account from the verified `sub`, whichever path verified it. Nothing of the ticket is
 * kept. The nonce answer's `vault` lists the keys the door takes (`{ ticketKeys }`, or null), so a phone knows before
 * it opens a sign-in sheet; it says only which vault this door trusts, which is public.
 *
 * Global is BeanPool's own node, so its door may trust BeanPool's vault. Any other door leaves the keys unset and runs
 * exactly as before, needing nothing of ours.
 *
 * ## Adding a sign-in later (design §2.5)
 *
 * A 12-words member has one way back: the 12 words. `POST /api/join/link` adds a sign-in as a second, and lifts them to a
 * sign-in member's new-account limits at once (engine/probation.ts). Signed by the member (an active member whose
 * `open_joins` row is still `words`), the nonce bound to `open-join-link:<key>`, the same verifier, the same optional
 * vault ticket or `recovery: { shares }`. In one transaction it checks the sign-in account is not already someone's here
 * (409 `already_joined`), or a removed member's (403 `removed`: a removed person can't lift a new account with their old
 * sign-in), and rewrites the member's row to that provider (engine/open-join.ts linkOpenJoin). If storing the recovery
 * copy fails the link still stands, and the answer says so. Refused before any sign-in when the member came in another
 * way (409 `not_words_member`) or already has one (409 `already_linked`).
 *
 * ## Limits
 *
 * The door's own limiter (auth-rate-limit.ts `doorRateLimit`: 20 a minute per signing key, 600 a minute per address), in
 * place of the auth limiter's 15 a minute per address, which turned a hall away; the gateway limiter in front of
 * everything. Then the door's signal (engine/door-signal.ts): no refusal for a network but its ceilings, 500 12-words
 * joins an hour or 2,000 a day from one address, 1,000 sign-in joins an hour or 5,000 a day, each counting its own
 * door's joins and answered 429 `network_busy` with `Retry-After`. An address over a ceiling is told before the work and
 * the sign-in are checked, so neither is spent; a 12-words refusal says the sign-in door is open.
 */

import Router from '@koa/router';
import {
    checkVaultTicket,
    isDoorWorkDoor,
    parseVaultTicket,
    vaultTicketNonce,
    VAULT_TICKET_CLOCK_SKEW_MS,
    VAULT_TICKET_TTL_MS,
    type DoorWorkDoor,
    type VaultTicketRefusal,
} from '@beanpool/core';
import { getProfileSwitches } from '../config/node-profile.js';
import { alreadyJoined, broadcast, getActingMember } from '../state-engine.js';
import { clientLimiterKey } from '../client-ip.js';
import { doorRateLimit } from '../auth-rate-limit.js';
import {
    issueNonce,
    verifySignIn,
    verifySignInWithVaultTicket,
    vaultTicketUsed,
    signInCredentialFrom,
    getConfiguredAudiences,
    isSsoProvider,
    ssoProviderLabel,
    SsoVerificationError,
    SsoProviderUnavailableError,
    SSO_PROVIDERS,
    webClientIds,
    type SignInCredential,
    type SsoIdentity,
    type SsoProvider,
    type VaultTicketSignIn,
} from '../sso.js';
import { recordFunnelEvent } from '../engine/funnel.js';
import {
    forgetOldJoinAddresses,
    linkOpenJoin,
    openJoinAddressHash,
    openJoinHash,
    openJoinKeyInvalidated,
    openJoinProviderOf,
    registerOpenJoin,
    wordsJoinHash,
    type OpenJoinLinkRefusal,
    type OpenJoinOutcome,
    type OpenJoinRefusal,
} from '../engine/open-join.js';
import { doorCeilingReached, doorLevel, noteWordsJoin, WORDS_PROVIDER, type DoorCeiling } from '../engine/door-signal.js';
import { checkDoorWork, issueDoorWork, type DoorWorkRefusal } from '../services/door-work.js';
import { OpenJoinKeyMissing, openJoinKeyState } from '../services/open-join-key.js';
import { vaultTicketKeys, VAULT_TICKET_KEYS_ENV } from '../services/vault-ticket-keys.js';
import { checkSsoKeeperShares, storeVerifiedSsoKeeperGeneration, KeeperDepositError } from '../engine/keeper-deposit.js';
import { RecoveryShareError, type KeeperShareInput } from '../engine/recovery-shares.js';
import { BadRequest, parseShares, ssoDepositBody } from './keepers.js';
import type { RouteDeps } from './types.js';

/** The same cap `/api/invite/redeem` puts on a joining name; the wizard-on-join renames with the full rules. */
const MAX_JOIN_CALLSIGN = 20;

function joinNonceSubject(actor: string): string {
    return `open-join:${actor}`;
}

function linkNonceSubject(actor: string): string {
    return `open-join-link:${actor}`;
}

function doorOpen(): boolean {
    return getProfileSwitches().openJoin;
}

/** The 12-words door: the open door, where a sign-in is not required (design §2.1). */
function wordsDoorOpen(): boolean {
    const s = getProfileSwitches();
    return s.openJoin && !s.ssoRequiredForJoin;
}

function inviteOnly(ctx: any): void {
    ctx.status = 404;
    ctx.body = { error: 'This community is invite-only.', code: 'invite_only' };
}

function signInRequired(ctx: any): void {
    ctx.status = 403;
    ctx.body = { error: 'This community needs a sign-in to join: Google, Apple or Facebook.', code: 'sign_in_required' };
}

/** The signer's key as the member table keeps it (lower-case hex), or null when it has no such spelling. */
function canonicalKey(signer: string): string | null {
    const key = signer.toLowerCase();
    return /^[0-9a-f]{64}$/.test(key) ? key : null;
}

function badKey(ctx: any): void {
    ctx.status = 400;
    ctx.body = { error: 'The key that signed this request is not a member key: it must be 64 hexadecimal characters.', code: 'bad_key' };
}

function unsigned(ctx: any): void {
    // The middleware refuses an unsigned POST before this runs; kept so the handler never trusts that alone.
    ctx.status = 401;
    ctx.body = { error: 'This request must be signed by the key you are joining with.' };
}

function badRequest(ctx: any, error: string, code = 'bad_request'): void {
    ctx.status = 400;
    ctx.body = { error, code };
}

const KEY_INVALIDATED = 'This key was replaced by a new one, so it can\'t join. Use the device or the 12 words that hold the new key.';

/**
 * The door cannot check a sign-in against the accounts that already joined (services/open-join-key.ts): the key its
 * records were made with is not here (a server restored from a plain backup, or promoted by hand without the take-over
 * keys). It fails closed: every join with a sign-in is refused, a new account's too, since without the key it cannot
 * be told from one already here, and nothing is written. Before the sign-in is checked, so the nonce survives. The
 * 12-words door needs no key and stays open.
 */
function doorKeyMissing(ctx: any, provider?: SsoProvider): void {
    if (provider) recordFunnelEvent('open_join_failed', 'door_key_missing');
    ctx.status = 503;
    ctx.body = {
        error: 'This community can\'t check sign-ins right now, so it isn\'t taking new members this way. Nothing was saved. Please try again later.',
        code: 'door_key_missing',
    };
}

/** Whether the door can check a sign-in here now (see doorKeyMissing). Read per request: a key put back counts at once. */
function doorKeyHere(): boolean {
    return openJoinKeyState().on;
}

/** "in about 5 minutes", "in about 3 hours": the wait a ceiling asks for. */
function inAbout(seconds: number): string {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    if (minutes < 60) return minutes === 1 ? 'in about a minute' : `in about ${minutes} minutes`;
    const hours = Math.round(minutes / 60);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

/**
 * A ceiling for this network (engine/door-signal.ts): 429 with `Retry-After`. The 12-words door says the sign-in door is
 * open. The sign-in door's sentence names no time, because today's apps add "(Try again in N minutes.)" from the header.
 * `count` false leaves the join funnel alone: the work route is no join, and writes nothing.
 */
function networkBusy(ctx: any, ceiling: DoorCeiling, count = true): void {
    if (count) recordFunnelEvent('open_join_failed', ceiling.door === 'words' ? 'network_busy_words' : 'network_busy');
    ctx.status = 429;
    ctx.set('Retry-After', String(ceiling.retryAfterSeconds));
    const span = ceiling.window === 'day' ? 'today' : 'in the last hour';
    ctx.body = {
        error: ceiling.door === 'words'
            ? `A very large number of 12-words accounts were made from your network ${span}. Sign in to join now, or try again ${inAbout(ceiling.retryAfterSeconds)}.`
            : `Too many new accounts have joined from your network ${span}. Please try again later.`,
        code: 'network_busy',
        door: ceiling.door,
        window: ceiling.window,
        retryAfterSeconds: ceiling.retryAfterSeconds,
    };
}

const WORK_REFUSALS: Record<DoorWorkRefusal, string> = {
    // What an app from before the work shows (it never fetches any): the sign-in door at 30 joins an hour from its network.
    work_required: 'Lots of people have joined from your network lately, so joining here now takes a moment of setting up on your phone first, '
        + 'which this version of the app can\'t do. Please update the BeanPool app, or try again later.',
    work_invalid: 'Setting up your account didn\'t work out. Please try again.',
    work_expired: 'That took a while, so setting up your account has to start again. Please try again.',
    work_spent: 'Setting up your account didn\'t work out. Please try again.',
};

/** 400: the app fetches a new challenge and solves again (the header). Before the sign-in, so nothing is spent. */
function refuseWork(ctx: any, code: DoorWorkRefusal): void {
    recordFunnelEvent('open_join_failed', code);
    ctx.status = 400;
    ctx.body = { error: WORK_REFUSALS[code], code };
}

/** `count` false leaves the join funnel alone: adding a sign-in (`/api/join/link`) is no join. */
function refuse(ctx: any, reason: OpenJoinRefusal, provider: SsoProvider | null, ceiling?: DoorCeiling, count = true): void {
    if (reason === 'network_busy' && ceiling) return networkBusy(ctx, ceiling, count);
    if (count) recordFunnelEvent('open_join_failed', reason);
    const label = provider ? ssoProviderLabel(provider) : 'sign-in';
    switch (reason) {
        case 'already_member':
            ctx.status = 409;
            ctx.body = { error: 'This key is already a member of this community.', code: reason };
            return;
        case 'key_invalidated':
            ctx.status = 403;
            ctx.body = { error: KEY_INVALIDATED, code: reason };
            return;
        case 'already_joined':
            ctx.status = 409;
            ctx.body = {
                error: `This ${label} account already has a BeanPool identity here. Restore it with your 12 words or your sign-in instead.`,
                code: reason,
            };
            return;
        case 'removed':
            ctx.status = 403;
            ctx.body = {
                error: `The BeanPool identity this ${label} account joined with was removed from this community, so it can't join again.`,
                code: reason,
            };
            return;
        case 'network_busy':
            // Every network_busy carries its ceiling (registerOpenJoin); this is never reached without one.
            ctx.status = 429;
            ctx.body = { error: 'Too many new accounts have joined from your network. Please try again later.', code: reason };
            return;
    }
}

// ── key vault tickets (the header's "Or a key vault ticket") ──────────────────────────────────────

type TicketRefusal = 'ticket_unsupported' | 'ticket_malformed' | 'ticket_signature' | 'ticket_expired' | 'ticket_key' | 'ticket_purpose' | 'ticket_used';

const TICKET_REFUSALS: Record<TicketRefusal, string> = {
    ticket_unsupported: 'This community doesn\'t take key vault tickets. Please sign in again.',
    ticket_malformed: 'That is not a key vault ticket. Please sign in again.',
    ticket_signature: 'That ticket is not signed by a key vault this community trusts. Please sign in again.',
    ticket_expired: 'That ticket has expired. Please sign in again.',
    ticket_key: 'That ticket was issued to another key. Please sign in again.',
    ticket_purpose: 'That ticket was issued for something else. Please sign in again.',
    ticket_used: 'That ticket was already used. Please sign in again.',
};

const TICKET_CHECK_CODES: Record<VaultTicketRefusal, TicketRefusal> = {
    malformed: 'ticket_malformed',
    signature: 'ticket_signature',
    expired: 'ticket_expired',
    wrong_key: 'ticket_key',
    wrong_purpose: 'ticket_purpose',
};

/** 401, so every phone reads it as "sign in again"; a phone that knows the codes signs in with the door's own nonce. */
function refuseTicket(ctx: any, code: TicketRefusal, count = true): void {
    if (count) recordFunnelEvent('open_join_failed', code);
    ctx.status = 401;
    ctx.body = { error: TICKET_REFUSALS[code], code };
}

/**
 * One line for an operator when a refusal may be this server's doing: its clock (every fresh ticket then looks expired
 * or from the future; the line says by how much), or its pinned keys (the vault signs with a key .env doesn't list).
 * Nothing of the joiner. The door limiter bounds how often anyone can make it write one.
 */
function noteTicketRefusal(reason: VaultTicketRefusal, raw: unknown, now: number): void {
    if (reason === 'signature') {
        console.warn(`[OpenJoin] key vault ticket refused: signed by none of the keys in ${VAULT_TICKET_KEYS_ENV}. `
            + 'If every ticket is refused so, the vault signs with a key this server does not list.');
        return;
    }
    if (reason !== 'expired' && reason !== 'malformed') return;
    const exp = parseVaultTicket(raw)?.payload.exp;
    if (exp === undefined) return; // not a ticket at all: nothing about this server
    const seconds = (ms: number) => Math.round(ms / 1000);
    if (reason === 'expired') {
        console.warn(`[OpenJoin] key vault ticket refused: it expired ${seconds(now - exp)} s ago by this server's clock. `
            + 'If every ticket is refused so, check this server\'s clock.');
    } else {
        console.warn(`[OpenJoin] key vault ticket refused: it was issued ${seconds(exp - VAULT_TICKET_TTL_MS - now)} s ahead of this server's clock `
            + `(more than ${seconds(VAULT_TICKET_CLOCK_SKEW_MS)} s). If every ticket is refused so, check this server's clock.`);
    }
}

/**
 * The ticket a join carries, checked for the key that signed it (`actor`), or null once the refusal is written. Offline:
 * no provider and no vault is asked, and nothing is written but the funnel's count (`count`: a join's, not a link's).
 */
function acceptVaultTicket(ctx: any, raw: unknown, actor: string, count = true): VaultTicketSignIn | null {
    const ticketKeys = vaultTicketKeys();
    if (!ticketKeys.length) { refuseTicket(ctx, 'ticket_unsupported', count); return null; }
    const now = Date.now();
    const check = checkVaultTicket(raw, { ticketKeys, now, key: actor, purpose: 'deposit' });
    if (!check.ok) {
        noteTicketRefusal(check.reason, raw, now);
        refuseTicket(ctx, TICKET_CHECK_CODES[check.reason], count);
        return null;
    }
    if (vaultTicketUsed(check.ticket.n)) { refuseTicket(ctx, 'ticket_used', count); return null; }
    return { nonce: vaultTicketNonce(raw as string), n: check.ticket.n, exp: check.ticket.exp };
}

/** The keys the nonce answer advertises (the header), or null when the door takes no tickets. */
function vaultAnswer(): { ticketKeys: string[] } | null {
    const ticketKeys = vaultTicketKeys();
    return ticketKeys.length ? { ticketKeys } : null;
}

/** The nonce answer, for a join or for adding a sign-in: the same shape, each bound to its own subject. */
function nonceAnswer(subject: string): Record<string, unknown> {
    return {
        nonce: issueNonce(subject),
        expiresInSeconds: 600,
        providers: SSO_PROVIDERS,
        // The id a browser puts in its request to each provider it leaves the page for (sso.ts webClientId).
        clientIds: webClientIds(),
        // The key vault ticket keys this door takes, so a phone binds its sign-in to a ticket only where it is taken.
        vault: vaultAnswer(),
    };
}

/** The recovery body a sign-in may carry (the header's "One sign-in, two jobs"): null when there is none, false once refused. */
function readRecoveryShares(ctx: any, body: any, provider: SsoProvider, actor: string): KeeperShareInput[] | null | false {
    if (body.recovery === undefined || body.recovery === null) return null;
    try {
        const shares = parseShares(body.recovery?.shares);
        checkSsoKeeperShares(provider, actor, shares);
        return shares;
    } catch (e) {
        if (e instanceof BadRequest || e instanceof KeeperDepositError) {
            badRequest(ctx, `The recovery keeper could not be read: ${e.message}`, 'recovery_invalid');
            return false;
        }
        throw e;
    }
}

/** Store the recovery copy from the sign-in just verified. Never a gate: a failure is said in the answer. */
async function storeRecovery(identity: SsoIdentity, actor: string, shares: KeeperShareInput[]): Promise<Record<string, unknown>> {
    try {
        const result = await storeVerifiedSsoKeeperGeneration(identity, actor, shares);
        return { enrolled: true, ...ssoDepositBody(actor, result) };
    } catch (e) {
        const known = e instanceof KeeperDepositError || e instanceof RecoveryShareError || e instanceof SsoVerificationError;
        if (!known) console.warn('[OpenJoin] recovery keeper not stored:', (e as Error)?.message || e);
        return { enrolled: false, error: known ? (e as Error).message : 'The recovery keeper could not be stored.' };
    }
}

/**
 * Verify the sign-in a join or a link carries, for `subject`; null once the refusal is written. `count` says whether
 * the funnel counts its refusals (a join's, not a link's).
 */
async function verifyDoorSignIn(
    ctx: any, provider: SsoProvider, credential: SignInCredential, nonce: string, ticket: VaultTicketSignIn | null, subject: string, count: boolean,
): Promise<SsoIdentity | null> {
    try {
        return ticket
            ? await verifySignInWithVaultTicket(provider, credential, getConfiguredAudiences(provider), ticket, subject)
            : await verifySignIn(provider, credential, getConfiguredAudiences(provider), nonce, subject);
    } catch (e) {
        // An SsoProviderUnavailableError is also an SsoVerificationError, so it is ruled out explicitly.
        if (e instanceof SsoVerificationError && !(e instanceof SsoProviderUnavailableError)) {
            // The same ticket submitted twice at once: the other request used it while this one was checked.
            if (ticket && vaultTicketUsed(ticket.n)) { refuseTicket(ctx, 'ticket_used', count); return null; }
            if (count) recordFunnelEvent('open_join_failed', 'sign_in');
            ctx.status = 401;
            ctx.body = { error: e.message, code: 'sign_in' };
            return null;
        }
        // Not the member's sign-in: the provider could not be asked (its keys failed, came back unusable,
        // or timed out). The nonce was not spent, so the same sign-in can try again.
        console.warn('[OpenJoin] sign-in could not be checked:', (e as Error)?.message || e);
        if (count) recordFunnelEvent('open_join_failed', 'sign_in_unavailable');
        ctx.status = 503;
        ctx.body = { error: `${ssoProviderLabel(provider)} sign-in could not be checked right now. Please try again in a minute.`, code: 'sign_in_unavailable' };
        return null;
    }
}

const LINK_REFUSALS: Record<Exclude<OpenJoinLinkRefusal, 'already_joined' | 'removed'>, { status: number; error: string }> = {
    not_a_member: { status: 403, error: 'Only an active member of this community can add a sign-in here.' },
    not_words_member: { status: 409, error: 'This account wasn\'t made with 12 words here, so there is no sign-in to add to it.' },
    already_linked: { status: 409, error: 'This account already has a sign-in.' },
};

export function createOpenJoinRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    /**
     * The key asking at the door, in the member table's spelling (`canonicalKey`), or null once the refusal is written:
     * the door shut, unsigned, not a key's spelling, over the door's limiter, already a member, or a key a re-key
     * replaced.
     */
    function joiningKey(ctx: any): string | null {
        if (!doorOpen()) { inviteOnly(ctx); return null; }
        const signer = ctx.state?.actor as string | undefined;
        if (!signer) { unsigned(ctx); return null; }
        const actor = canonicalKey(signer);
        if (!actor) { badKey(ctx); return null; }
        if (!doorRateLimit(ctx, actor)) return null;
        // A visitor's row hasn't joined: it may join here, and the join makes that row a member's.
        if (alreadyJoined(actor)) {
            ctx.status = 409;
            ctx.body = { error: 'This key is already a member of this community.', code: 'already_member' };
            return null;
        }
        if (openJoinKeyInvalidated(actor)) {
            ctx.status = 403;
            ctx.body = { error: KEY_INVALIDATED, code: 'key_invalidated' };
            return null;
        }
        return actor;
    }

    /** This network's keyed hash, with the old ones cleared first (engine/open-join.ts). */
    function addressHash(ctx: any): string {
        forgetOldJoinAddresses();
        return openJoinAddressHash(clientLimiterKey(ctx));
    }

    router.post('/api/join/work', async (ctx) => {
        const actor = joiningKey(ctx);
        if (!actor) return;
        const door = ((ctx as any).requestBody || {}).door;
        if (!isDoorWorkDoor(door)) return badRequest(ctx, "'door' must be 'words' or 'sign-in'.");
        if (door === 'words' && !wordsDoorOpen()) return signInRequired(ctx);
        // No sweep here: the signal reads only the last hour and day, which a day-old hash is outside of, and the joins
        // clear them. This route is asked more often than any join, so it writes nothing, not even to the join funnel
        // at a ceiling: a work fetch is no join, and the join the app may try next is counted there.
        const ipHash = openJoinAddressHash(clientLimiterKey(ctx));
        // Told here, before the phone does any work it could not use.
        const ceiling = doorCeilingReached(door, ipHash);
        if (ceiling) return networkBusy(ctx, ceiling, false);
        const { level } = doorLevel(door, ipHash);
        ctx.status = 200;
        // Turnstile (design §5) is not built: no discount is offered, and none is needed.
        ctx.body = { work: level === null ? null : issueDoorWork(actor, door, level), turnstile: null };
    });

    router.post('/api/join/sso-nonce', async (ctx) => {
        const actor = joiningKey(ctx);
        if (!actor) return;
        if (!doorKeyHere()) return doorKeyMissing(ctx);
        ctx.status = 200;
        ctx.body = nonceAnswer(joinNonceSubject(actor));
    });

    /** `POST /api/join` with `door: 'words'` (the header's "Two doors"). */
    function wordsJoin(ctx: any, actor: string, body: any): void {
        if (!wordsDoorOpen()) return signInRequired(ctx);
        for (const field of ['provider', 'idToken', 'nonce', 'recovery', 'vaultTicket']) {
            if (body[field] !== undefined && body[field] !== null) {
                return badRequest(ctx, 'A 12-words join carries no sign-in: send the name and the work only.');
            }
        }
        const callsign = typeof body.callsign === 'string' ? body.callsign.trim().slice(0, MAX_JOIN_CALLSIGN).trim() : '';
        if (callsign.length < 2) return badRequest(ctx, 'Please choose a name of at least 2 characters.');

        recordFunnelEvent('open_join_attempt', WORDS_PROVIDER);
        // Refused before the work is checked, so these never spend it. registerOpenJoin checks them again with its writes.
        if (alreadyJoined(actor)) return refuse(ctx, 'already_member', null);
        if (openJoinKeyInvalidated(actor)) return refuse(ctx, 'key_invalidated', null);
        const ipHash = addressHash(ctx);
        const ceiling = doorCeilingReached('words', ipHash);
        if (ceiling) return networkBusy(ctx, ceiling);
        const work = checkDoorWork(body.work, actor, 'words');
        if (!work.ok) return refuseWork(ctx, work.code);

        let outcome: OpenJoinOutcome;
        try {
            outcome = registerOpenJoin(broadcast, { publicKey: actor, callsign, provider: WORDS_PROVIDER, joinHash: wordsJoinHash(), ipHash });
        } catch (e) {
            console.error('[OpenJoin] join could not be recorded:', (e as Error)?.message || e);
            recordFunnelEvent('open_join_failed', 'join_failed');
            ctx.status = 503;
            ctx.body = { error: 'Your join could not be completed, and nothing was saved. Please try again in a minute.', code: 'join_failed' };
            return;
        }
        if (!outcome.ok) return refuse(ctx, outcome.reason, null, outcome.ceiling);
        noteWordsJoin();
        ctx.status = 200;
        ctx.body = { success: true, member: outcome.member, door: 'words' };
    }

    router.post('/api/join', async (ctx) => {
        if (!doorOpen()) return inviteOnly(ctx);
        const signer = ctx.state?.actor as string | undefined;
        if (!signer) return unsigned(ctx);
        // Every check and write below is on the member table's spelling of the key, never the one that was sent.
        const actor = canonicalKey(signer);
        if (!actor) return badKey(ctx);
        if (!doorRateLimit(ctx, actor)) return;

        const body = (ctx as any).requestBody || {};
        const door: unknown = body.door ?? 'sign-in';
        if (!isDoorWorkDoor(door)) return badRequest(ctx, "'door' must be 'words' or 'sign-in'.");
        if ((door as DoorWorkDoor) === 'words') return wordsJoin(ctx, actor, body);

        const provider = body.provider;
        if (!isSsoProvider(provider)) {
            return badRequest(ctx, `'provider' must be one of: ${SSO_PROVIDERS.join(', ')}.`);
        }
        const credential = signInCredentialFrom(body);
        const nonce = typeof body.nonce === 'string' ? body.nonce : '';
        if (!credential.idToken) return badRequest(ctx, "'idToken' is required.");
        if (!nonce) return badRequest(ctx, "'nonce' is required.");
        const callsign = typeof body.callsign === 'string' ? body.callsign.trim().slice(0, MAX_JOIN_CALLSIGN).trim() : '';
        if (callsign.length < 2) return badRequest(ctx, 'Please choose a name of at least 2 characters.');

        const recoveryShares = readRecoveryShares(ctx, body, provider, actor);
        if (recoveryShares === false) return;

        recordFunnelEvent('open_join_attempt', provider);

        // Refused before the sign-in is checked, so these never spend the nonce. registerOpenJoin checks all of them
        // again with its writes, and those are the checks that decide.
        if (alreadyJoined(actor)) return refuse(ctx, 'already_member', provider);
        if (openJoinKeyInvalidated(actor)) return refuse(ctx, 'key_invalidated', provider);
        if (!doorKeyHere()) return doorKeyMissing(ctx, provider);
        const ipHash = addressHash(ctx);
        const ceiling = doorCeilingReached('sign-in', ipHash);
        if (ceiling) return networkBusy(ctx, ceiling);
        // No work at ordinary rates (today's apps send none); from 30 joins an hour from this network, some.
        if (doorLevel('sign-in', ipHash).level !== null) {
            const work = checkDoorWork(body.work, actor, 'sign-in');
            if (!work.ok) return refuseWork(ctx, work.code);
        }

        // A key vault ticket decides the nonce (the header). Absent (or null), the door's own nonce, exactly as before.
        let ticket: VaultTicketSignIn | null = null;
        if (body.vaultTicket !== undefined && body.vaultTicket !== null) {
            ticket = acceptVaultTicket(ctx, body.vaultTicket, actor);
            if (!ticket) return;
            if (nonce !== ticket.nonce) {
                // Counted like the refusals around it: the attempt above was.
                recordFunnelEvent('open_join_failed', 'ticket_nonce');
                return badRequest(ctx, 'The nonce is not this ticket\'s: a join with a key vault ticket carries the ticket\'s nonce.');
            }
        }

        const identity = await verifyDoorSignIn(ctx, provider, credential, nonce, ticket, joinNonceSubject(actor), true);
        if (!identity) return;

        let outcome: OpenJoinOutcome;
        try {
            outcome = registerOpenJoin(broadcast, {
                publicKey: actor,
                callsign,
                provider: identity.provider,
                joinHash: openJoinHash(identity.provider, identity.sub),
                ipHash,
            });
        } catch (e) {
            // The key went between the check above and the hash: refused as above, and nothing was written.
            if (e instanceof OpenJoinKeyMissing) return doorKeyMissing(ctx, provider);
            // Nothing was kept: the member row and the open_joins row roll back together (engine/open-join.ts). The
            // exception's text names tables and constraints, so it goes to the log and never into the answer.
            console.error('[OpenJoin] join could not be recorded:', (e as Error)?.message || e);
            recordFunnelEvent('open_join_failed', 'join_failed');
            ctx.status = 503;
            ctx.body = { error: 'Your join could not be completed, and nothing was saved. Please sign in and try again in a minute.', code: 'join_failed' };
            return;
        }
        if (!outcome.ok) return refuse(ctx, outcome.reason, identity.provider, outcome.ceiling);

        const recovery = recoveryShares ? await storeRecovery(identity, actor, recoveryShares) : undefined;

        ctx.status = 200;
        ctx.body = { success: true, member: outcome.member, provider: identity.provider, ...(recovery ? { recovery } : {}) };
    });

    // ── Adding a sign-in later (the header's "Adding a sign-in later") ──────────────────────────────

    /**
     * The 12-words member asking to add a sign-in, in the member table's spelling, or null once the refusal is written:
     * the door shut, unsigned, not a key's spelling, over the door's limiter, not an active member here, a member who
     * came in another way or already has a sign-in, or a server that can't check one.
     */
    function linkingMember(ctx: any): string | null {
        if (!doorOpen()) { inviteOnly(ctx); return null; }
        const signer = ctx.state?.actor as string | undefined;
        if (!signer) { unsigned(ctx); return null; }
        const actor = canonicalKey(signer);
        if (!actor) { badKey(ctx); return null; }
        if (!doorRateLimit(ctx, actor)) return null;
        const member = getActingMember(actor);
        if (!member || member.status !== 'active') {
            ctx.status = 403;
            ctx.body = { error: 'Only an active member of this community can add a sign-in here.', code: 'not_a_member' };
            return null;
        }
        const row = linkState(actor);
        if (row !== 'words') {
            const refusal = LINK_REFUSALS[row];
            ctx.status = refusal.status;
            ctx.body = { error: refusal.error, code: row };
            return null;
        }
        if (!doorKeyHere()) { doorKeyMissing(ctx); return null; }
        return actor;
    }

    router.post('/api/join/link/sso-nonce', async (ctx) => {
        const actor = linkingMember(ctx);
        if (!actor) return;
        ctx.status = 200;
        ctx.body = nonceAnswer(linkNonceSubject(actor));
    });

    router.post('/api/join/link', async (ctx) => {
        const actor = linkingMember(ctx);
        if (!actor) return;
        const body = (ctx as any).requestBody || {};
        const provider = body.provider;
        if (!isSsoProvider(provider)) {
            return badRequest(ctx, `'provider' must be one of: ${SSO_PROVIDERS.join(', ')}.`);
        }
        const credential = signInCredentialFrom(body);
        const nonce = typeof body.nonce === 'string' ? body.nonce : '';
        if (!credential.idToken) return badRequest(ctx, "'idToken' is required.");
        if (!nonce) return badRequest(ctx, "'nonce' is required.");
        const recoveryShares = readRecoveryShares(ctx, body, provider, actor);
        if (recoveryShares === false) return;

        let ticket: VaultTicketSignIn | null = null;
        if (body.vaultTicket !== undefined && body.vaultTicket !== null) {
            ticket = acceptVaultTicket(ctx, body.vaultTicket, actor, false);
            if (!ticket) return;
            if (nonce !== ticket.nonce) {
                return badRequest(ctx, 'The nonce is not this ticket\'s: a sign-in with a key vault ticket carries the ticket\'s nonce.');
            }
        }

        const identity = await verifyDoorSignIn(ctx, provider, credential, nonce, ticket, linkNonceSubject(actor), false);
        if (!identity) return;

        let outcome: ReturnType<typeof linkOpenJoin>;
        try {
            outcome = linkOpenJoin({ publicKey: actor, provider: identity.provider, joinHash: openJoinHash(identity.provider, identity.sub) });
        } catch (e) {
            if (e instanceof OpenJoinKeyMissing) return doorKeyMissing(ctx);
            console.error('[OpenJoin] sign-in could not be added:', (e as Error)?.message || e);
            ctx.status = 503;
            ctx.body = { error: 'Your sign-in could not be added, and nothing was changed. Please sign in and try again in a minute.', code: 'link_failed' };
            return;
        }
        if (!outcome.ok) {
            if (outcome.reason === 'already_joined' || outcome.reason === 'removed') {
                // The join's own answers, but no join was refused: the funnel is left alone, as the sign-in check above.
                refuse(ctx, outcome.reason, identity.provider, undefined, false);
                return;
            }
            const refusal = LINK_REFUSALS[outcome.reason];
            ctx.status = refusal.status;
            ctx.body = { error: refusal.error, code: outcome.reason };
            return;
        }

        const recovery = recoveryShares ? await storeRecovery(identity, actor, recoveryShares) : undefined;
        ctx.status = 200;
        ctx.body = { success: true, provider: identity.provider, ...(recovery ? { recovery } : {}) };
    });

    return router;
}

/** Where a member stands for adding a sign-in: a 12-words row, or why not (engine/open-join.ts linkOpenJoin decides again). */
function linkState(publicKey: string): 'words' | 'not_words_member' | 'already_linked' {
    const provider = openJoinProviderOf(publicKey);
    if (provider === null) return 'not_words_member';
    return provider === WORDS_PROVIDER ? 'words' : 'already_linked';
}
