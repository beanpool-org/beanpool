/**
 * Recovery PIN helpers for client-side PIN management and verification.
 *
 * As specified in docs/recovery-model.md:
 * - The PIN is optional and off by default.
 * - It reveals the keeper list (so the recovering device knows which friends to call).
 * - It does NOT gate release of fragment A, and is NOT on the SSO tier.
 * - Forgetting the PIN is NOT a lockout; members can still recover if they remember their friends.
 */

import { signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';

export interface PinStatusResult {
    pinSet: boolean;
    error?: string;
}

export interface SetPinResult {
    ok: boolean;
    pinSet: boolean;
    error?: string;
}

export interface KeeperSummary {
    type: string;
    count: number;
}

export interface VerifyPinResult {
    verified: boolean;
    keepers: KeeperSummary[] | null;
    error?: string;
}

/** Check if the current identity has a recovery PIN set on their node. */
export async function getPinStatus(nodeUrl: string, identity: BeanPoolIdentity): Promise<PinStatusResult> {
    try {
        const res = await signedPost(nodeUrl, '/api/recovery/pin/status', {}, identity);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            return { pinSet: false, error: body.error || `HTTP ${res.status}` };
        }
        const data = await res.json();
        return { pinSet: !!data.pinSet };
    } catch (e: any) {
        return { pinSet: false, error: e.message || 'Failed to check PIN status' };
    }
}

/** Set, change, or clear (pin = null or '') the 6-digit recovery PIN. */
export async function setRecoveryPin(
    nodeUrl: string,
    identity: BeanPoolIdentity,
    pin: string | null,
): Promise<SetPinResult> {
    if (pin !== null && pin !== '' && !/^\d{6}$/.test(pin)) {
        return { ok: false, pinSet: false, error: 'PIN must be exactly 6 digits.' };
    }

    try {
        const res = await signedPost(nodeUrl, '/api/recovery/pin/set', { pin }, identity);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return { ok: false, pinSet: false, error: data.error || `HTTP ${res.status}` };
        }
        return { ok: true, pinSet: !!data.pinSet };
    } catch (e: any) {
        return { ok: false, pinSet: false, error: e.message || 'Failed to update PIN' };
    }
}

/** Verify a 6-digit PIN against a callsign to reveal the keeper list count. */
export async function verifyRecoveryPin(
    nodeUrl: string,
    callsign: string,
    pin: string,
): Promise<VerifyPinResult> {
    if (!/^\d{6}$/.test(pin)) {
        return { verified: false, keepers: null, error: 'PIN must be 6 digits.' };
    }

    try {
        const cleanUrl = nodeUrl.replace(/\/+$/, '');
        const res = await fetch(`${cleanUrl}/api/recovery/pin/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callsign: callsign.trim(), pin: pin.trim() }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            return { verified: false, keepers: null, error: data.error || `HTTP ${res.status}` };
        }
        return {
            verified: !!data.verified,
            keepers: Array.isArray(data.keepers) ? data.keepers : null,
        };
    } catch (e: any) {
        return { verified: false, keepers: null, error: e.message || 'Failed to verify PIN' };
    }
}
