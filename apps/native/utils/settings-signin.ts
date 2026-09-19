/**
 * Settings → "Sign in on a computer": an owner or admin scans the QR on their node's /settings page in a browser,
 * and — after the phone's own unlock — signs that browser in with their member key. Like WhatsApp Web.
 *
 *   1. The scan is read with @beanpool/core's parseSettingsSigninQr and must name THIS app's node: a code from any
 *      other node is refused with both names shown, never approved.
 *   2. The node is asked about the pairing (GET …/pairing/<id>): its short code must match the one in the QR, and
 *      it says which browser asked ("Firefox on Windows") so the owner can notice a computer that isn't theirs.
 *   3. The owner confirms, then the phone's unlock — the same gate as Manage (requireDeviceUnlock, fails closed).
 *   4. The approval: the member key signs `beanpool-settings-signin:v1:approve:<id>:<code>` (the same Ed25519
 *      scheme as the Manage link's challenge). The node checks the live role and its 2FA code, and signs in only
 *      the browser that showed the code — it holds a secret this phone never sees. Nothing comes back to the
 *      phone but "done".
 *
 * Server: apps/server/src/settings-signin-pairing.ts. Page: apps/manager/src/components/auth/PhoneSignIn.tsx.
 */

import { parseSettingsSigninQr, isSameNode, nodeOrigin, type SettingsSigninQr } from '@beanpool/core';
import { signData, encodeUtf8, hexToBytes, encodeBase64 } from './crypto';
import type { BeanPoolIdentity } from './identity';
import { requireDeviceUnlock } from './node-admin';

export type ScanResult =
    | { kind: 'ok'; qr: SettingsSigninQr }
    | { kind: 'wrong-node'; scannedHost: string; appHost: string }
    | { kind: 'not-signin' }
    | { kind: 'malformed' }
    | { kind: 'no-node' };

function host(url: string): string {
    const o = nodeOrigin(url);
    return o ? o.replace(/^https?:\/\//, '') : url;
}

/** Is this a sign-in code for the node this app is on? */
export function readSigninScan(text: unknown, appNodeUrl: string | null): ScanResult {
    const parsed = parseSettingsSigninQr(text);
    if (!parsed.ok) return { kind: parsed.reason };
    if (!appNodeUrl) return { kind: 'no-node' };
    if (!isSameNode(parsed.nodeUrl, appNodeUrl)) {
        return { kind: 'wrong-node', scannedHost: host(parsed.nodeUrl), appHost: host(appNodeUrl) };
    }
    return { kind: 'ok', qr: { nodeUrl: parsed.nodeUrl, pairingId: parsed.pairingId, shortCode: parsed.shortCode } };
}

export function scanProblemMessage(r: Exclude<ScanResult, { kind: 'ok' }>): { title: string; message: string } {
    switch (r.kind) {
        case 'wrong-node':
            return {
                title: 'A different community',
                message: `That code is for ${r.scannedHost}, but this app is signed in to ${r.appHost}. ` +
                    'You can only sign in to the Settings of the community this app belongs to.',
            };
        case 'no-node':
            return { title: 'Not connected', message: 'Connect to your community first.' };
        case 'malformed':
            return { title: "Can't read that code", message: 'It looks like a sign-in code but part of it is missing. Get a new code on the computer and scan again.' };
        case 'not-signin':
        default:
            return { title: 'Not a sign-in code', message: "That isn't a BeanPool Settings sign-in code. On the computer, open your community's Settings and choose “Sign in with your phone”." };
    }
}

/** "K7F 3QX", as the computer shows it. */
export function formatShortCode(code: string): string {
    return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

const pairingPath = (id: string) => `/api/local/admin/auth/pairing/${id}`;

export type PairingLookup =
    | { kind: 'ok'; browser: string; expiresAt: number }
    | { kind: 'gone'; message: string }
    | { kind: 'error'; message: string };

/** The node's view of the pairing. Refuses a QR whose short code the node does not recognise. */
export async function lookupPairing(qr: SettingsSigninQr): Promise<PairingLookup> {
    try {
        const res = await fetch(`${qr.nodeUrl}${pairingPath(qr.pairingId)}`, { headers: { Accept: 'application/json' } });
        const body = await res.json().catch(() => ({})) as { shortCode?: unknown; browser?: unknown; expiresAt?: unknown; error?: unknown };
        if (res.ok) {
            if (body.shortCode !== qr.shortCode) {
                return { kind: 'gone', message: "The code on the computer doesn't match this QR. Get a new code on the computer and scan again." };
            }
            return {
                kind: 'ok',
                browser: typeof body.browser === 'string' && body.browser ? body.browser : 'A browser',
                expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : 0,
            };
        }
        const message = typeof body.error === 'string' ? body.error : `The node did not answer (${res.status}).`;
        return res.status === 404 || res.status === 410 ? { kind: 'gone', message } : { kind: 'error', message };
    } catch (e: any) {
        return { kind: 'error', message: e?.message || 'Could not reach the node.' };
    }
}

/** The exact text the member key signs. Must match pairingMessage() in the server's settings-signin-pairing.ts. */
export function signinMessage(action: 'approve' | 'decline', qr: SettingsSigninQr): string {
    return `beanpool-settings-signin:v1:${action}:${qr.pairingId}:${qr.shortCode}`;
}

/** The approval (or decline) request: POST …/pairing/<id>/<action>, JSON { memberPubkey, signature[, totpCode] }. */
export async function buildSigninRequest(
    action: 'approve' | 'decline', qr: SettingsSigninQr, identity: BeanPoolIdentity, totpCode?: string,
): Promise<{ url: string; init: RequestInit }> {
    const sig = await signData(encodeUtf8(signinMessage(action, qr)), hexToBytes(identity.privateKey));
    return {
        url: `${qr.nodeUrl}${pairingPath(qr.pairingId)}/${action}`,
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                memberPubkey: identity.publicKey,
                signature: encodeBase64(sig),
                ...(action === 'approve' && totpCode ? { totpCode: totpCode.trim() } : {}),
            }),
        },
    };
}

export type ApproveOutcome =
    | { kind: 'approved' }
    | { kind: 'no-device-lock' }
    | { kind: 'unlock-failed' }
    | { kind: 'totp-required'; wrongCode: boolean; continueWith: (code: string) => Promise<ApproveOutcome> }
    | { kind: 'refused'; message: string }
    | { kind: 'error'; message: string };

/**
 * The "Sign in" press: the phone's unlock first — nothing is signed or sent without it — then the approval.
 * When the node wants its 2FA code, `continueWith` retries without asking for the unlock again (and is only
 * reachable after it succeeded), as in manageNode.
 */
export async function approveComputerSignin(opts: {
    qr: SettingsSigninQr;
    identity: BeanPoolIdentity;
    communityName: string;
}): Promise<ApproveOutcome> {
    const unlock = await requireDeviceUnlock(opts.communityName);
    if (unlock === 'no-device-lock') return { kind: 'no-device-lock' };
    if (unlock !== 'ok') return { kind: 'unlock-failed' };

    const attempt = async (totpCode?: string): Promise<ApproveOutcome> => {
        try {
            const { url, init } = await buildSigninRequest('approve', opts.qr, opts.identity, totpCode);
            const res = await fetch(url, init);
            const body = await res.json().catch(() => ({})) as { success?: boolean; totpRequired?: boolean; error?: string; reason?: string };
            if (res.ok && body.success) return { kind: 'approved' };
            if (body.totpRequired) return { kind: 'totp-required', wrongCode: !!totpCode, continueWith: attempt };
            if (body.reason === 'not-admin') return { kind: 'refused', message: `You are not an owner or admin of ${opts.communityName}, so you can't open its Settings.` };
            if (res.status === 403 || res.status === 404 || res.status === 409 || res.status === 410) {
                return { kind: 'refused', message: body.error || 'The node refused the sign-in.' };
            }
            if (res.status === 429) return { kind: 'error', message: body.error || 'Too many attempts. Wait a minute and try again.' };
            return { kind: 'error', message: body.error || `The node did not answer (${res.status}).` };
        } catch (e: any) {
            return { kind: 'error', message: e?.message || 'Could not reach the node.' };
        }
    };
    return attempt();
}

/** "No, that's not me": ends the pairing so the computer stops waiting. Best effort. */
export async function declineComputerSignin(qr: SettingsSigninQr, identity: BeanPoolIdentity): Promise<void> {
    try {
        const { url, init } = await buildSigninRequest('decline', qr, identity);
        await fetch(url, init);
    } catch { /* the code expires in two minutes anyway */ }
}
