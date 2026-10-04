/**
 * An owner's break-glass code, from the app (POST /api/node-admin/break-glass, signed with the member key).
 *
 * The code enrols a new admin key when the owner's phone is lost, so it belongs somewhere other than this phone: the app
 * shows it once, to be written down and kept offline, and keeps no copy. Asking for one makes a NEW code on the node (the
 * old one stops working), so the phone's own unlock comes first, as it does for Manage, and only one ask runs at a time
 * (issueBreakGlassCodeOnce): a double tap used to make two codes, the first shown already dead.
 *
 * Until #1531 the app offered "Also keep it on this phone", a copy in the secure store that nothing ever read back. It
 * was dropped rather than given a "Show" row: a copy on the phone is gone in the one case the code is for (the phone is
 * lost); while the phone is in hand the owner can make a new code behind the same unlock; and "Sign out everywhere" (the
 * app's row, utils/sign-out-everywhere.ts, or Settings' Owners & admins) retires the code on the node, so a kept copy
 * could show a dead code. Any copy an older app kept is deleted at start
 * (sweepKeptBreakGlassCode) and whenever a new code is made (forgetBreakGlassCode).
 */
import * as SecureStore from 'expo-secure-store';
import { buildSignedHeaders } from './crypto';
import type { BeanPoolIdentity } from './identity';
import { requireDeviceUnlock } from './node-admin';

export type BreakGlassResult =
    | { ok: true; code: string }
    | { ok: false; reason: 'no-device-lock' | 'failed' | 'refused' | 'busy'; message: string };

const CODE_SHAPE = /^bg-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;

/**
 * The secure-store key an older app kept one owner's code under, for one node (keys allow only letters, digits, '.', '-'
 * and '_'). Only ever deleted now.
 */
export function breakGlassStoreKey(nodeUrl: string, publicKey: string): string {
    const host = nodeUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
    return `bp_breakglass.${host}.${publicKey.slice(0, 16)}`;
}

/** The phone's unlock, then a new code for this owner's own key. Nothing is stored here. */
export async function makeBreakGlassCode(nodeUrl: string, identity: BeanPoolIdentity, communityName: string): Promise<BreakGlassResult> {
    const unlock = await requireDeviceUnlock(communityName);
    if (unlock === 'no-device-lock') {
        return { ok: false, reason: 'no-device-lock', message: 'Set a screen lock on this phone first: a break-glass code is only shown behind it.' };
    }
    if (unlock !== 'ok') return { ok: false, reason: 'failed', message: 'The phone was not unlocked, so no code was made.' };
    try {
        const url = `${nodeUrl.replace(/\/+$/, '')}/api/node-admin/break-glass`;
        const body = '{}';
        const headers = await buildSignedHeaders('POST', url, body, identity.privateKey, identity.publicKey);
        const res = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' }, body });
        const data = await res.json().catch(() => ({})) as { breakGlassCode?: unknown; error?: unknown };
        if (res.ok && typeof data.breakGlassCode === 'string' && CODE_SHAPE.test(data.breakGlassCode)) {
            return { ok: true, code: data.breakGlassCode };
        }
        return { ok: false, reason: 'refused', message: typeof data.error === 'string' ? data.error : `The community said no (${res.status}).` };
    } catch {
        return { ok: false, reason: 'failed', message: 'Could not reach the community. No code was made.' };
    }
}

let inFlight: Promise<BreakGlassResult> | null = null;

/**
 * makeBreakGlassCode, one at a time: a second press while one is running (the unlock prompt, then the node) asks neither
 * the phone nor the node and answers 'busy', so a double tap never makes a second code that retires the first.
 */
export async function issueBreakGlassCodeOnce(nodeUrl: string, identity: BeanPoolIdentity, communityName: string): Promise<BreakGlassResult> {
    if (inFlight) return { ok: false, reason: 'busy', message: 'A break-glass code is already being made.' };
    const run = makeBreakGlassCode(nodeUrl, identity, communityName);
    inFlight = run;
    try {
        return await run;
    } finally {
        inFlight = null;
    }
}

/** Deletes the copy an older app may have kept for this owner on this node. */
export async function forgetBreakGlassCode(nodeUrl: string, publicKey: string): Promise<void> {
    await SecureStore.deleteItemAsync(breakGlassStoreKey(nodeUrl, publicKey));
}

/**
 * At start: deletes the copy an older app may have kept for this owner on the community the phone is in now. The secure
 * store cannot list its keys, so that is the one it can name. Never throws.
 */
export async function sweepKeptBreakGlassCode(nodeUrl: string | null | undefined, publicKey: string | null | undefined): Promise<void> {
    if (!nodeUrl || !publicKey) return;
    try {
        await forgetBreakGlassCode(nodeUrl, publicKey);
    } catch {
        // Nothing kept, or the store is unavailable: either way there is nothing to show and nothing to do.
    }
}
