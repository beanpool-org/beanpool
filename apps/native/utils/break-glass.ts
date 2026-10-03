/**
 * An owner's break-glass code, from the app (POST /api/node-admin/break-glass, signed with the member key).
 *
 * The code enrols a new admin key when the owner's phone is lost, so it is worth having somewhere other than this phone;
 * the app shows it once and offers to keep a copy in the secure store as well, never in AsyncStorage. Asking for one
 * makes a NEW code on the node (the old one stops working), so the phone's own unlock comes first, as it does for Manage.
 */
import * as SecureStore from 'expo-secure-store';
import { buildSignedHeaders } from './crypto';
import type { BeanPoolIdentity } from './identity';
import { requireDeviceUnlock } from './node-admin';

export type BreakGlassResult =
    | { ok: true; code: string }
    | { ok: false; reason: 'no-device-lock' | 'failed' | 'refused'; message: string };

const CODE_SHAPE = /^bg-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;

/** The secure-store key for one owner's code on one node (keys allow only letters, digits, '.', '-' and '_'). */
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

/** Keeps the code in the secure store, readable only while this phone is unlocked and never copied to another device. */
export async function keepBreakGlassCode(nodeUrl: string, publicKey: string, code: string): Promise<void> {
    await SecureStore.setItemAsync(breakGlassStoreKey(nodeUrl, publicKey), code, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

/** A kept code that a newer one replaced is useless: forget it whenever a new code is shown and not kept. */
export async function forgetBreakGlassCode(nodeUrl: string, publicKey: string): Promise<void> {
    await SecureStore.deleteItemAsync(breakGlassStoreKey(nodeUrl, publicKey));
}
