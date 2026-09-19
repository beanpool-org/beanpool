/**
 * The take-over envelope and the recovery code — main-server routes (sealed-keys.md §2.6, §4, §7; slice 2a).
 * services/takeover-envelope.ts does the work; this file is who may ask.
 *
 *   POST /api/local/admin/takeover/status               admin        who the keys are locked to, or why they are not;
 *                                                                    which standby holds which (main), what it holds (standby)
 *   POST /api/local/admin/takeover/recovery-code        owner        make / replace the code; returned ONCE
 *   POST /api/local/admin/takeover/recovery-code/check  owner        does this typed code match? under the password brake
 *   GET  /api/local/admin/takeover-envelope             token/admin  the sealed bytes, ETag = envelopeId
 *   GET  /api/node/takeover-envelope/header             owner, signed the public header, for an owner's app (§7)
 *
 * Take-over on a standby, by recovery code (§5.3, §5.4; slice 5; services/takeover.ts does the work):
 *   POST /api/local/admin/takeover/open                 owner        type the code: opens the held keys in memory,
 *                                                                    answers what will happen and what will be missing
 *   POST /api/local/admin/takeover/confirm              owner        the second step: runs the journaled promotion,
 *                                                                    restarts; returns a progress token ONCE
 *   POST /api/local/admin/takeover/cancel               owner        forget an open session
 *   POST /api/local/admin/takeover/progress             admin, or the progress token (X-Takeover-Progress)
 *
 * The split-brain guard (§5.4; slice 8; services/identity-epoch.ts):
 *   GET  /api/node/identity-epoch                       public       this identity's take-over count, signed with the
 *                                                                    node key; an old main server asks its own address
 *
 * No route here returns a plaintext field of the bundle. The envelope route returns the sealed bytes as they
 * are on disk; the header route returns the header, which is public by design (recipients, code number, sig).
 */

import Router from '@koa/router';
import { RecoveryCodeError } from '@beanpool/core';
import { getLocalConfig, verifyReplicationToken } from '../config/local-config.js';
import { requireAdminRole } from '../admin-auth.js';
import { acquirePasswordAttempt, refuseBraked, settlePasswordAttempt } from '../password-brake.js';
import { clientIp, clientLimiterKey } from '../client-ip.js';
import { recordReplicationAccess } from '../state-engine.js';
import { isNodeOwner } from '../engine/node-roles.js';
import {
    getTakeoverStatus, getSealedTakeoverEnvelope, makeRecoveryCode, checkCurrentRecoveryCode, parseRecoveryCode,
    RecoveryCodeExistsError, RecoveryCodeOnStandbyError, noteEnvelopeFetch, getEnvelopeHolders,
} from '../services/takeover-envelope.js';
import { getHeldEnvelopesStatus } from '../services/standby-envelopes.js';
import { getNodeRole } from '../state-engine.js';
import {
    TakeoverError, takeoverPreconditions, parseTypedCode, pickEnvelope, codeMatches, openTakeoverSession,
    confirmTakeover, discardTakeoverSession, getTakeoverProgress, progressTokenMatches,
} from '../services/takeover.js';
import { currentSignedEpoch, IDENTITY_EPOCH_PATH } from '../services/identity-epoch.js';
import type { RouteDeps } from './types.js';

const TAKEOVER_OWNER_ONLY = 'Only an owner of this standby can take over as the main server.';

function answerTakeoverError(ctx: any, e: unknown): void {
    if (e instanceof TakeoverError) {
        ctx.status = e.status;
        ctx.body = { error: e.message, ...e.extra };
        return;
    }
    ctx.status = 500;
    ctx.body = { error: 'The take-over could not start: ' + ((e as any)?.message || 'unknown error') };
}

const OWNER_ONLY = 'Only an owner can make or check the recovery code.';

/** `If-None-Match` names this envelope (quoted or not, or in a list). */
function matchesEtag(header: unknown, envelopeId: string): boolean {
    if (typeof header !== 'string' || !header) return false;
    return header.split(',').map((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, '')).includes(envelopeId);
}

export function createTakeoverEnvelopeRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    router.post('/api/local/admin/takeover/status', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        ctx.set('Cache-Control', 'no-store');
        const standby = getNodeRole() === 'backup';
        ctx.body = {
            ...(await getTakeoverStatus()),
            // Main server: which standby last fetched which envelope. Standby: the main server's envelopes it holds.
            standbys: standby ? [] : getEnvelopeHolders(),
            held: standby ? getHeldEnvelopesStatus() : null,
            // After a take-over by code: "Your recovery code was used. Make a new one" until a new one is made.
            codeUsed: getTakeoverProgress().codeUsed,
        };
    });

    // Make or replace the printed recovery code. The code is in this one response and nowhere else: not on disk,
    // not in local-config.json (only its public record), not in any log. `replace: true` is required when a code
    // exists, so a double tap cannot silently invalidate the paper already in the drawer.
    router.post('/api/local/admin/takeover/recovery-code', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        if (!requireAdminRole(ctx, ['owner'], OWNER_ONLY)) return;
        const replace = (ctx as any).requestBody?.replace === true;
        try {
            const made = await makeRecoveryCode({ replace });
            ctx.set('Cache-Control', 'no-store');
            ctx.body = {
                success: true,
                // Returned ONCE. Only the public record is kept, so it can never be shown again.
                code: made.code,
                codeId: made.codeId,
                createdAt: made.createdAt,
                replacedCodeId: made.replacedCodeId,
                status: made.status,
            };
        } catch (e: any) {
            if (e instanceof RecoveryCodeOnStandbyError) {
                ctx.status = 409;
                ctx.body = { error: e.message, standby: true };
                return;
            }
            if (e instanceof RecoveryCodeExistsError) {
                ctx.status = 409;
                ctx.body = { error: e.message, codeId: e.codeId, needsReplace: true };
                return;
            }
            ctx.status = 500;
            ctx.body = { error: 'The recovery code could not be made.' };
        }
    });

    // "I still have it — check" (§7). A typo is answered at once from the check characters, costing nothing; a
    // well-formed code is a guess at a secret, so it goes through the password brake like a password does: a wrong
    // code counts against the source, a right one clears nothing. Under the admin password the password itself
    // clears the source on every request (password-brake.ts, as for every admin route), so the brake bites on key
    // sessions; a caller holding the owner password could replace the code outright anyway.
    router.post('/api/local/admin/takeover/recovery-code/check', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        if (!requireAdminRole(ctx, ['owner'], OWNER_ONLY)) return;
        const code = (ctx as any).requestBody?.code;
        if (typeof code !== 'string' || !code.trim()) {
            ctx.status = 400;
            ctx.body = { error: 'Type the recovery code to check it.' };
            return;
        }
        try {
            parseRecoveryCode(code);
        } catch (e) {
            if (e instanceof RecoveryCodeError) {
                ctx.status = 400;
                ctx.body = { error: e.message, typo: true };
                return;
            }
            // Every typo is a RecoveryCodeError now, code number 0 included; anything else is still a typo to the person.
            ctx.status = 400;
            ctx.body = { error: 'That is not a recovery code: check what you typed.', typo: true };
            return;
        }
        if (!(getLocalConfig() as any).recoveryCode) {
            ctx.status = 404;
            ctx.body = { error: 'This server has no recovery code yet.', matches: false };
            return;
        }
        const key = clientLimiterKey(ctx);
        const admission = await acquirePasswordAttempt(key);
        if (!admission.admitted) {
            refuseBraked(ctx, admission);
            return;
        }
        let matches = false;
        let result: Awaited<ReturnType<typeof checkCurrentRecoveryCode>> = null;
        try {
            result = await checkCurrentRecoveryCode(code);
            matches = !!result?.matches;
        } catch {
            matches = false;
        } finally {
            // A right code clears nothing on its own under 2FA, for the same reason a right password doesn't.
            settlePasswordAttempt(key, matches, false);
        }
        if (!result) {
            ctx.status = 404;
            ctx.body = { error: 'This server has no recovery code yet.', matches: false };
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { matches, codeId: result.codeId };
    });

    // The sealed envelope, for a standby (replication token) or an admin. The token reaches this and nothing
    // else that holds a key: what it gets is ciphertext only the owners and the code can open.
    router.get('/api/local/admin/takeover-envelope', async (ctx) => {
        const ip = clientIp(ctx);
        const token = ctx.request.header['x-replication-token'];
        let viaToken = false;
        if (token) {
            if (!(await verifyReplicationToken(String(token)))) {
                recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'takeover envelope: invalid replication token' });
                ctx.status = 401;
                ctx.body = { error: 'Invalid replication token' };
                return;
            }
            viaToken = true;
        } else if (!(await checkAdminAuth(ctx as any))) {
            return;
        }

        const got = await getSealedTakeoverEnvelope();
        ctx.set('Cache-Control', 'no-store');
        if (got.envelopeId === null) {
            if (viaToken) recordReplicationAccess({ at: Date.now(), ip, auth: 'token', reason: `takeover envelope: none (${got.status.state})` });
            ctx.status = 404;
            ctx.body = { error: got.status.message, state: got.status.state };
            return;
        }
        ctx.set('ETag', `"${got.envelopeId}"`);
        ctx.set('X-Envelope-Id', got.envelopeId);
        if (matchesEtag(ctx.request.header['if-none-match'], got.envelopeId)) {
            if (viaToken) {
                recordReplicationAccess({ at: Date.now(), ip, auth: 'token', reason: `takeover envelope ${got.envelopeId.slice(0, 8)}: not modified (304)` });
                noteEnvelopeFetch(ip, got.envelopeId, got.header.createdAt, 'confirmed');
            }
            ctx.status = 304;
            return;
        }
        if (viaToken) {
            recordReplicationAccess({ at: Date.now(), ip, auth: 'token', reason: `takeover envelope ${got.envelopeId.slice(0, 8)}` });
            noteEnvelopeFetch(ip, got.envelopeId, got.header.createdAt, 'sent');
        }
        ctx.set('Content-Type', 'application/octet-stream');
        ctx.set('Content-Disposition', 'attachment; filename="takeover-envelope.bpseal"');
        ctx.body = got.bytes;
    });

    // An owner's app reads the current header to see whether the lock changed and to find its own stanza (§7).
    // A signed member request (the signature middleware sets ctx.state.authSig); the signer must be an owner now.
    router.get('/api/node/takeover-envelope/header', async (ctx) => {
        const signer: string | undefined = (ctx.state as any)?.authSig?.signer;
        if (!signer) {
            ctx.status = 401;
            ctx.body = { error: 'Sign this request with your member key.' };
            return;
        }
        if (!isNodeOwner(signer)) {
            ctx.status = 403;
            ctx.body = { error: "Only this community's owners can read its take-over lock." };
            return;
        }
        const got = await getSealedTakeoverEnvelope();
        ctx.set('Cache-Control', 'no-store');
        if (got.envelopeId === null) {
            ctx.status = 404;
            ctx.body = { error: got.status.message, state: got.status.state };
            return;
        }
        ctx.set('ETag', `"${got.envelopeId}"`);
        if (matchesEtag(ctx.request.header['if-none-match'], got.envelopeId)) {
            ctx.status = 304;
            return;
        }
        const mine = got.header.recipients.some((r) => r.type === 'owner' && r.pubkey === signer.toLowerCase());
        ctx.body = { envelopeId: got.envelopeId, header: got.header, youAreARecipient: mine };
    });

    // ── Take-over on a standby (§5.3) ──────────────────────────────────────────────────────

    // Step one: the printed recovery code. A typo is answered from the check characters, free. A well-formed code
    // is a guess at a secret, so it goes through the password brake under its own name ("takeover:" + the source):
    // the admin password clears the source's plain record on every request (password-brake.ts), which would
    // otherwise wipe the count of wrong codes between guesses. A right code clears nothing either.
    router.post('/api/local/admin/takeover/open', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        if (!requireAdminRole(ctx, ['owner'], TAKEOVER_OWNER_ONLY)) return;
        ctx.set('Cache-Control', 'no-store');
        const code = (ctx as any).requestBody?.code;
        try {
            takeoverPreconditions();
            const { codeId } = parseTypedCode(code);
            const candidate = pickEnvelope(codeId);
            const key = 'takeover:' + clientLimiterKey(ctx);
            const admission = await acquirePasswordAttempt(key);
            if (!admission.admitted) {
                refuseBraked(ctx, admission);
                ctx.body = { ...(ctx.body as Record<string, unknown>), error: `Too many wrong recovery codes from your network. Try again in ${admission.retryAfter}s.` };
                return;
            }
            let matches = false;
            try {
                matches = await codeMatches(String(code), candidate.stanza);
            } finally {
                settlePasswordAttempt(key, matches, false);
            }
            if (!matches) {
                ctx.status = 403;
                ctx.body = { error: `That is not recovery code #${candidate.stanza.codeId}. Check the paper and try again.`, wrongCode: true };
                return;
            }
            ctx.body = { success: true, preview: await openTakeoverSession(String(code), candidate) };
        } catch (e) {
            answerTakeoverError(ctx, e);
        }
    });

    // Step two: the confirm. The standby's own admin password stops working part-way (the community's is installed),
    // so the answer carries a progress token the screen uses to follow the steps across the restart.
    router.post('/api/local/admin/takeover/confirm', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        if (!requireAdminRole(ctx, ['owner'], TAKEOVER_OWNER_ONLY)) return;
        ctx.set('Cache-Control', 'no-store');
        const body = (ctx as any).requestBody || {};
        if (body.confirm !== true) {
            ctx.status = 400;
            ctx.body = { error: 'Confirm the take-over to go on.' };
            return;
        }
        try {
            const { progressToken, journalId } = confirmTakeover(body.sessionId);
            ctx.body = { success: true, progressToken, journalId, progress: getTakeoverProgress() };
        } catch (e) {
            answerTakeoverError(ctx, e);
        }
    });

    router.post('/api/local/admin/takeover/cancel', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        if (!requireAdminRole(ctx, ['owner'], TAKEOVER_OWNER_ONLY)) return;
        discardTakeoverSession();
        ctx.body = { success: true };
    });

    // The steps, for the progress and result screen. The progress token (from confirm) is enough on its own; the
    // rest of the time it is an admin read.
    router.post('/api/local/admin/takeover/progress', async (ctx) => {
        const token = ctx.request.header['x-takeover-progress'];
        if (!(token && progressTokenMatches(String(token)))) {
            if (!(await checkAdminAuth(ctx as any))) return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = getTakeoverProgress();
    });

    // Public: it proves nothing secret, and an old main server must read it with no credential for this server.
    router.get(IDENTITY_EPOCH_PATH, async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const signed = currentSignedEpoch();
        if (!signed) {
            ctx.status = 404;
            ctx.body = { error: 'This server has no node key yet.' };
            return;
        }
        ctx.body = signed;
    });

    return router;
}
