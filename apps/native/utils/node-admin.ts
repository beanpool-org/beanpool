/**
 * "🛡️ Manage <community>" — an owner or admin opens their node's /settings from the app, already signed in
 * with their member key, without the node password.
 *
 *   1. Role: asked of the node every time (GET /api/node-admin/me, signed). Nothing cached, nothing the
 *      member could edit on the phone: the button only decides whether to offer, and the node re-checks
 *      the live role when it issues the link and again when the browser uses it.
 *   2. The phone's own unlock (fingerprint, face or device PIN) before any link is requested. A phone with
 *      no lock set gets an explanation, not a link — this path FAILS CLOSED, unlike the app-lock helper in
 *      LocalAuth.ts, which opens on a lockless phone on purpose so nobody is locked out of their own account.
 *   3. The node's challenge is signed with the member key; the node answers with a 60-second, single-use
 *      token (and still asks for its own 2FA code if the owner turned 2FA on).
 *   4. The token travels in the URL FRAGMENT (`/settings#handoff=…`): fragments are never sent to a server,
 *      so it cannot land in a proxy or access log or a Referer header. The page posts it to the node once
 *      and wipes it from the address bar.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import { buildSignedHeaders, signData, encodeUtf8, hexToBytes, encodeBase64 } from './crypto';
import type { BeanPoolIdentity } from './identity';

export type ManageRole = 'owner' | 'admin';

/** /settings sections the node's admin queue links to — mirrors ADMIN_SETTINGS_SECTIONS on the server. */
export const SETTINGS_SECTIONS = ['home', 'moderation', 'disputes', 'decisions'] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];

export function canManageNode(role: unknown): role is ManageRole {
    return role === 'owner' || role === 'admin';
}

function base(nodeUrl: string): string {
    return nodeUrl.replace(/\/+$/, '');
}

export interface MyNodeRole {
    role: ManageRole | null;
    communityName: string | null;
}

/**
 * The signed-in member's role on this node, straight from the node. Any failure — offline, an older node
 * without the endpoint, a refusal — answers "no role", so the button is simply not offered.
 */
export async function fetchMyNodeRole(nodeUrl: string, identity: BeanPoolIdentity): Promise<MyNodeRole> {
    const none: MyNodeRole = { role: null, communityName: null };
    try {
        const path = '/api/node-admin/me';
        const headers = await buildSignedHeaders('GET', path, '', identity.privateKey, identity.publicKey);
        delete headers['Content-Type'];
        const res = await fetch(`${base(nodeUrl)}${path}`, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
        if (!res.ok) return none;
        const body = await res.json() as { role?: unknown; communityName?: unknown };
        return {
            role: canManageNode(body.role) ? body.role : null,
            communityName: typeof body.communityName === 'string' && body.communityName.trim() ? body.communityName.trim() : null,
        };
    } catch {
        return none;
    }
}

export interface AdminQueueItem {
    kind: string;
    count: number;
    label: string;
    section: SettingsSection;
    settingsPath: string;
}

/** Pending admin work on this node (for the header badge). Null when unavailable or not an admin. */
export async function fetchAdminQueue(nodeUrl: string, identity: BeanPoolIdentity): Promise<{ total: number; items: AdminQueueItem[] } | null> {
    try {
        const path = '/api/node-admin/queue';
        const headers = await buildSignedHeaders('GET', path, '', identity.privateKey, identity.publicKey);
        delete headers['Content-Type'];
        const res = await fetch(`${base(nodeUrl)}${path}`, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
        if (!res.ok) return null;
        const body = await res.json() as { total?: unknown; items?: unknown };
        if (typeof body.total !== 'number' || !Array.isArray(body.items)) return null;
        const items = (body.items as AdminQueueItem[]).filter(i => (SETTINGS_SECTIONS as readonly string[]).includes(i?.section));
        return { total: body.total, items };
    } catch {
        return null;
    }
}

export type UnlockResult = 'ok' | 'no-device-lock' | 'failed';

/** The phone's own unlock. Fails closed: no lock set, or anything unexpected, means no link. */
export async function requireDeviceUnlock(communityName: string): Promise<UnlockResult> {
    let level: LocalAuthentication.SecurityLevel;
    try {
        level = await LocalAuthentication.getEnrolledLevelAsync();
    } catch {
        return 'failed';
    }
    if (level === LocalAuthentication.SecurityLevel.NONE) return 'no-device-lock';
    try {
        const res = await LocalAuthentication.authenticateAsync({
            promptMessage: `Confirm it's you to manage ${communityName}`,
            cancelLabel: 'Cancel',
            disableDeviceFallback: false,
        });
        return res.success ? 'ok' : 'failed';
    } catch {
        return 'failed';
    }
}

export const NO_DEVICE_LOCK_MESSAGE =
    "Managing a community opens its admin settings signed in as you, so BeanPool asks for your phone's own " +
    'unlock first — fingerprint, face or PIN. This phone has no screen lock set, so anyone holding it could ' +
    'do the same. Set a screen lock in your phone’s settings, then try again.';

export type LinkResult =
    | { kind: 'ok'; token: string }
    | { kind: 'totp-required'; wrongCode: boolean }
    | { kind: 'refused'; message: string }
    | { kind: 'error'; message: string };

/** Sign the node's challenge with the member key and get the 60-second, single-use sign-in token. */
export async function requestSettingsLink(nodeUrl: string, identity: BeanPoolIdentity, totpCode?: string): Promise<LinkResult> {
    try {
        const chalRes = await fetch(`${base(nodeUrl)}/api/local/admin/auth/challenge`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const chal = await chalRes.json().catch(() => ({})) as { challengeId?: string; challenge?: string; error?: string };
        if (!chalRes.ok || !chal.challengeId || !chal.challenge) {
            return chalRes.status === 403
                ? { kind: 'refused', message: chal.error || 'The node refused the request.' }
                : { kind: 'error', message: chal.error || `The node did not answer (${chalRes.status}).` };
        }
        const sig = await signData(encodeUtf8(chal.challenge), hexToBytes(identity.privateKey));
        const res = await fetch(`${base(nodeUrl)}/api/local/admin/auth/verify-challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                challengeId: chal.challengeId,
                memberPubkey: identity.publicKey,
                signature: encodeBase64(sig),
                ...(totpCode ? { totpCode: totpCode.trim() } : {}),
            }),
        });
        const body = await res.json().catch(() => ({})) as { handshakeToken?: string; totpRequired?: boolean; error?: string };
        if (res.ok && typeof body.handshakeToken === 'string' && body.handshakeToken) {
            return { kind: 'ok', token: body.handshakeToken };
        }
        if (body.totpRequired) return { kind: 'totp-required', wrongCode: !!totpCode };
        if (res.status === 403) return { kind: 'refused', message: body.error || 'You do not hold an owner or admin role on this node.' };
        return { kind: 'error', message: body.error || `The node did not answer (${res.status}).` };
    } catch (e: any) {
        return { kind: 'error', message: e?.message || 'Could not reach the node.' };
    }
}

/** `<node>/settings#handoff=<token>[&section=<id>]`. The token is in the fragment, never the query. */
export function buildSettingsHandoffUrl(nodeUrl: string, token: string, section?: string): string {
    const parts = [`handoff=${encodeURIComponent(token)}`];
    if (section && (SETTINGS_SECTIONS as readonly string[]).includes(section)) parts.push(`section=${section}`);
    return `${base(nodeUrl)}/settings#${parts.join('&')}`;
}

export type ManageOutcome =
    | { kind: 'opened' }
    | { kind: 'no-device-lock' }
    | { kind: 'unlock-failed' }
    | { kind: 'totp-required'; wrongCode: boolean; continueWith: (code: string) => Promise<ManageOutcome> }
    | { kind: 'refused'; message: string }
    | { kind: 'error'; message: string };

/**
 * The whole button press. `openUrl` is expo-web-browser's openBrowserAsync in the app (Custom Tabs /
 * SFSafariViewController) — /settings is not an app link, so the browser keeps it.
 *
 * When the node wants its 2FA code, the outcome carries `continueWith`: only reachable after the phone
 * unlock succeeded, so the code prompt can retry without asking for the fingerprint again, and the gate
 * cannot be skipped by calling the link request some other way from here.
 */
export async function manageNode(opts: {
    nodeUrl: string;
    identity: BeanPoolIdentity;
    communityName: string;
    section?: SettingsSection;
    openUrl: (url: string) => Promise<unknown>;
}): Promise<ManageOutcome> {
    const unlock = await requireDeviceUnlock(opts.communityName);
    if (unlock === 'no-device-lock') return { kind: 'no-device-lock' };
    if (unlock !== 'ok') return { kind: 'unlock-failed' };

    const attempt = async (totpCode?: string): Promise<ManageOutcome> => {
        const link = await requestSettingsLink(opts.nodeUrl, opts.identity, totpCode);
        if (link.kind === 'ok') {
            await opts.openUrl(buildSettingsHandoffUrl(opts.nodeUrl, link.token, opts.section));
            return { kind: 'opened' };
        }
        if (link.kind === 'totp-required') return { kind: 'totp-required', wrongCode: link.wrongCode, continueWith: attempt };
        return link;
    };
    return attempt();
}
