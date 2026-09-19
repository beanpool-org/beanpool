/**
 * Unlocking with an owner's phone, on this server (sealed-keys.md §5.2, §6.2 step 2; slice 6). The crypto and the
 * session rules are @beanpool/core's owner-unlock.ts; this file keeps the sessions and says what an unlock does.
 *
 *   take-over  a standby's Settings starts a session on the newest held envelope locked to an owner. An owner's app
 *              scans the QR, re-wraps that envelope's data key to the session, and signs. The standby opens the
 *              envelope with it and holds the SAME preview a recovery code gives (services/takeover.ts), which the
 *              Settings screen then confirms, exactly as for the code: the journal, the restart, the audit.
 *   restore    a server restoring a `.bpsealed` backup keeps the uploaded file and starts a session on its header.
 *              After the owner's unlock it opens the file with the data key and restores it through the same
 *              hostile-archive checks as a restore by code (routes/backup.ts hands in `finish`).
 *
 * Two people or one: the session is started with this server's own admin sign-in, and only an owner's key unlocks
 * it. The phone never sees the payload; this server never sees the owner's key.
 *
 * Sessions live in memory: a restart forgets them, and the phone is told "no such session". Single use, ten
 * minutes, closed after five bad requests (core's OwnerUnlockSessions).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    OwnerUnlockSessions, OwnerUnlockError, buildOwnerUnlockQr, buildOwnerUnlockLink, unlockServerOrigin,
    type OwnerUnlockPurpose, type OwnerUnlockSession, type SealedEnvelopeHeader,
} from '@beanpool/core';
import { logger } from '../logger.js';
import {
    TakeoverError, takeoverPreconditions, pickEnvelopeForOwners, openTakeoverSessionWithDataKey, mainServerStatus,
    WHAT_WILL_BE_MISSING, type TakeoverPreview,
} from './takeover.js';

export interface UnlockedBy { pubkey: string; callsign: string }

interface TakeoverData {
    kind: 'takeover';
    candidate: ReturnType<typeof pickEnvelopeForOwners>;
    unlockedBy: UnlockedBy | null;
    preview: TakeoverPreview | null;
    error: string | null;
}

export interface RestoreOutcome { ok: boolean; status: number; body: Record<string, unknown> }

interface RestoreData {
    kind: 'restore';
    /** The uploaded sealed file, kept until the unlock (or until the session is forgotten). */
    file: string;
    /** Restores the file with the data key: routes/backup.ts's restore, from the sealed file on. */
    finish: (dataKey: Uint8Array) => Promise<RestoreOutcome>;
    describe: Record<string, unknown>;
    databaseOnly: boolean;
    unlockedBy: UnlockedBy | null;
    outcome: RestoreOutcome | null;
    /**
     * sha256 of the follow token. A restore brings back the community's admin password, so this server's own stops
     * working part-way; the screen that started the restore follows it with the token (like a take-over's progress
     * token), which it was given once.
     */
    followTokenHash: string;
}

type Data = TakeoverData | RestoreData;

const sessions = new OwnerUnlockSessions<Data>();

function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

function ownCommunityId(): string | null {
    try {
        const g = JSON.parse(fs.readFileSync(path.join(dataDir(), 'genesis.json'), 'utf-8'));
        return typeof g?.communityId === 'string' ? g.communityId : null;
    } catch {
        return null;
    }
}

export interface StartedUnlock {
    sessionId: string;
    /** A restore only: lets the screen that started it follow it after the admin password changes. Given once. */
    followToken?: string;
    expiresAt: number;
    /** The QR text (not a web link: only the BeanPool app reads it). */
    qr: string;
    /** The same as a link, for an owner whose phone shows this page. */
    link: string;
    /** Who can unlock it: the owners the envelope is locked to. */
    owners: string[];
    envelope: { envelopeId: string; sealedAt: string };
}

function started(s: OwnerUnlockSession<Data>, serverUrl: string): StartedUnlock {
    const qr = sessions.qrFor(s, serverUrl);
    return {
        sessionId: s.keys.sessionId,
        expiresAt: s.expiresAt,
        qr: buildOwnerUnlockQr(qr),
        link: buildOwnerUnlockLink(qr),
        owners: s.header.recipients.filter((r) => r.type === 'owner').map((r) => '@' + (r as { callsign: string }).callsign),
        envelope: { envelopeId: s.header.envelopeId, sealedAt: s.header.createdAt },
    };
}

/** The origin the phone will reach this server on: what the Settings screen says, else the request's own. */
export function unlockServerUrl(fromClient: unknown, requestOrigin: string): string {
    const client = typeof fromClient === 'string' ? unlockServerOrigin(fromClient) : null;
    const own = unlockServerOrigin(requestOrigin);
    if (!client && !own) throw new TakeoverError(400, "This server can't tell the address a phone would reach it on. Open Settings at the server's own web address.");
    return (client || own)!;
}

function forgetOthers(kind: Data['kind'], keep: string): void {
    for (const s of listSessions()) {
        if (s.data.kind === kind && s.keys.sessionId !== keep) forgetUnlockSession(s.keys.sessionId);
    }
}

const live: string[] = [];
function listSessions(): OwnerUnlockSession<Data>[] {
    return live.map((id) => sessions.peek(id)).filter((s): s is OwnerUnlockSession<Data> => !!s);
}

function remember(s: OwnerUnlockSession<Data>): void {
    live.push(s.keys.sessionId);
    while (live.length > 8) live.shift();
}

// ── Take-over ──────────────────────────────────────────────────────────────────────────────

/** "Take over with an owner's phone" on a standby: a session on the newest held envelope an owner can open. */
export function startTakeoverUnlock(serverUrl: string): StartedUnlock {
    takeoverPreconditions();
    const candidate = pickEnvelopeForOwners();
    const s = sessions.create('takeover', candidate.header, { kind: 'takeover', candidate, unlockedBy: null, preview: null, error: null });
    remember(s);
    forgetOthers('takeover', s.keys.sessionId);
    logger.warn('SYS', `[Takeover] Waiting for an owner's phone (${candidate.owners.join(', ')}) to open the keys sealed ${candidate.header.createdAt}`);
    return started(s, serverUrl);
}

// ── Restore ────────────────────────────────────────────────────────────────────────────────

/** A restore of a sealed backup, waiting for an owner's phone. `file` is taken over by the session. */
export function startRestoreUnlock(opts: {
    serverUrl: string; file: string; header: SealedEnvelopeHeader; describe: Record<string, unknown>; databaseOnly: boolean;
    finish: RestoreData['finish'];
}): StartedUnlock {
    const followToken = crypto.randomBytes(32).toString('hex');
    const s = sessions.create('restore', opts.header, {
        kind: 'restore', file: opts.file, finish: opts.finish, describe: opts.describe, databaseOnly: opts.databaseOnly,
        unlockedBy: null, outcome: null, followTokenHash: sha256Hex(followToken),
    });
    remember(s);
    forgetOthers('restore', s.keys.sessionId);
    logger.warn('SYS', `[Restore] Waiting for an owner's phone to open the backup sealed ${opts.header.createdAt}`);
    return { ...started(s, opts.serverUrl), followToken };
}

function sha256Hex(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/** Does this token follow this restore session? */
export function restoreFollowTokenMatches(sessionId: unknown, token: unknown): boolean {
    const s = sessions.peek(sessionId);
    if (!s || s.data.kind !== 'restore' || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
    const a = Buffer.from(sha256Hex(token));
    const b = Buffer.from(s.data.followTokenHash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── The phone's two calls ──────────────────────────────────────────────────────────────────

export interface UnlockHttpAnswer { status: number; body: Record<string, unknown> }

function refusal(e: unknown): UnlockHttpAnswer {
    if (e instanceof OwnerUnlockError) {
        const status = e.reason === 'unknown-session' ? 404
            : e.reason === 'expired' || e.reason === 'used' || e.reason === 'closed' ? 410
                : e.reason === 'malformed' ? 400 : 403;
        return { status, body: { error: e.message, reason: e.reason } };
    }
    if (e instanceof TakeoverError) return { status: e.status, body: { error: e.message, ...e.extra } };
    return { status: 500, body: { error: (e as Error)?.message || 'The unlock failed.' } };
}

/**
 * What the phone reads before it asks the owner anything: the header (to hash against the QR and to find its own
 * stanza), what will happen, and for a take-over whether the main server still answers. Public by design: the
 * header is, and the session id is what the QR carries.
 */
export async function describeUnlock(sessionId: unknown): Promise<UnlockHttpAnswer> {
    const found = sessions.lookup(sessionId);
    if (!found.ok) return refusal(new OwnerUnlockError(found.reason, found.reason === 'unknown-session'
        ? 'There is no such unlock session on this server. Start again on its Settings page.'
        : found.reason === 'expired' ? 'This unlock session ran out. Start again on the server.' : 'This unlock session is over.'));
    const s = found.session;
    const base = { purpose: s.purpose as OwnerUnlockPurpose, header: s.header, expiresAt: s.expiresAt };
    if (s.data.kind === 'takeover') {
        const main = await mainServerStatus();
        return {
            status: 200,
            body: {
                ...base,
                takeover: {
                    sealedAt: s.header.createdAt,
                    mainServerAnswers: main.answers,
                    lastCopyAt: main.lastCopyAt,
                    missing: WHAT_WILL_BE_MISSING,
                },
            },
        };
    }
    return { status: 200, body: { ...base, restore: { backup: s.data.describe, databaseOnly: s.data.databaseOnly } } };
}

/**
 * The phone's signed request. Core checks it against the session (signer an owner of the header, signature, session,
 * envelope, community) and unwraps the data key; then the take-over opens the envelope and holds its preview for the
 * Settings screen, or the restore runs. The data key is zeroed before this returns.
 */
export async function redeemUnlock(sessionId: unknown, request: unknown): Promise<UnlockHttpAnswer> {
    const peeked = sessions.peek(sessionId);
    let opened: ReturnType<typeof sessions.redeem>;
    try {
        opened = sessions.redeem(sessionId, request, peeked?.data.kind === 'takeover' ? ownCommunityId() : null);
    } catch (e) {
        if (e instanceof OwnerUnlockError && peeked) {
            logger.security('SYS', `[Unlock] Refused a phone's unlock for a ${peeked.purpose}: ${e.reason}`);
        }
        return refusal(e);
    }
    const { session, dataKey, signer, callsign } = opened;
    const who: UnlockedBy = { pubkey: signer, callsign };
    try {
        if (session.data.kind === 'takeover') {
            session.data.unlockedBy = who;
            try {
                session.data.preview = await openTakeoverSessionWithDataKey(session.data.candidate, dataKey, who);
            } catch (e) {
                session.data.error = (e as Error)?.message || 'The keys did not open.';
                return refusal(e);
            }
            return {
                status: 200,
                body: { success: true, purpose: 'takeover', next: "Finish on the standby's screen: it shows what will happen, then Take over now." },
            };
        }
        session.data.unlockedBy = who;
        const outcome = await session.data.finish(dataKey);
        session.data.outcome = outcome;
        return outcome.ok
            ? { status: 200, body: { success: true, purpose: 'restore', next: 'The server restores the backup and restarts.' } }
            : { status: outcome.status, body: { error: typeof outcome.body.error === 'string' ? outcome.body.error : 'The restore failed.', ...outcome.body } };
    } finally {
        dataKey.fill(0);
    }
}

// ── The Settings screen following its session ──────────────────────────────────────────────

export type FollowState =
    | { state: 'waiting'; expiresAt: number }
    | { state: 'expired' | 'closed' | 'gone' }
    | { state: 'unlocked'; unlockedBy: string; preview: TakeoverPreview }
    | { state: 'failed'; unlockedBy: string | null; error: string }
    | { state: 'restored'; unlockedBy: string; result: Record<string, unknown> };

export function followUnlock(sessionId: unknown, kind: Data['kind']): FollowState {
    const s = sessions.peek(sessionId);
    if (!s || s.data.kind !== kind) return { state: 'gone' };
    if (s.state === 'waiting') return { state: 'waiting', expiresAt: s.expiresAt };
    if (s.state === 'expired' || s.state === 'closed') {
        if (s.data.kind === 'restore') forgetUnlockSession(s.keys.sessionId);
        return { state: s.state };
    }
    const by = s.data.unlockedBy ? `@${s.data.unlockedBy.callsign}` : null;
    if (s.data.kind === 'takeover') {
        if (s.data.preview) return { state: 'unlocked', unlockedBy: by!, preview: s.data.preview };
        return { state: 'failed', unlockedBy: by, error: s.data.error || 'The keys did not open.' };
    }
    const outcome = s.data.outcome;
    if (!outcome) return { state: 'waiting', expiresAt: s.expiresAt };
    if (outcome.ok) return { state: 'restored', unlockedBy: by!, result: outcome.body };
    return { state: 'failed', unlockedBy: by, error: typeof outcome.body.error === 'string' ? outcome.body.error : 'The restore failed.' };
}

/** Forget a session; a restore's kept file goes with it. */
export function forgetUnlockSession(sessionId: unknown): void {
    const s = sessions.peek(sessionId);
    if (!s) return;
    if (s.data.kind === 'restore') fs.rmSync(s.data.file, { force: true });
    sessions.forget(s.keys.sessionId);
}

/** Tests only. */
export function resetOwnerUnlockForTests(): void {
    for (const s of listSessions()) forgetUnlockSession(s.keys.sessionId);
    live.length = 0;
    sessions.clear();
}
