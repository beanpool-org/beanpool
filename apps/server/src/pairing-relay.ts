/**
 * Pairing Relay — In-Memory Ephemeral QR Device Pairing Relay (#89).
 *
 * Facilitates zero-knowledge transfer of encrypted identity payloads between
 * a scanning mobile app and an unauthenticated desktop PWA.
 *
 * Security Guarantees:
 * - In-memory only: zero disk writes, zero SQLite rows.
 * - Strict 120-second TTL auto-expiration.
 * - Single-use guarantee with 15s resilience window for transient network drops.
 * - Zero-knowledge: the server only relays opaque ciphertext (XChaCha20-Poly1305).
 */

export interface PairingPayload {
    mobilePubHex: string;
    nonceHex: string;
    ciphertextHex: string;
}

interface PairingSession {
    sessionId: string;
    desktopPubHex: string;
    createdAt: number;
    expiresAt: number;
    status: 'waiting' | 'transferred';
    payload?: PairingPayload;
    timer: NodeJS.Timeout;
}

const PAIRING_TTL_MS = 120_000; // 2 minutes
// The relay's memory, measured (#1950: the real functions, --expose-gc, --max-old-space-size=512, the deciding review's
// probes/relay-full.mts). Anyone can open a session and fill it without signing in, so the caps bound what an unsigned
// sender can hold for the 2 minutes.
// - Waiting sessions: ~0.55 KB each, so MAX_SESSIONS of them is +5.3 MB. At 500, ~17 addresses filled the relay and
//   pairing answered "at capacity" to a hall; 10,000 takes ~670 (init + transfer both spend the pairing bucket, 15 a
//   minute per address).
// - A session holding a phone's payload until the computer fetches it was ~17 KB at the old 16,384-hex payload limit:
//   10,000 of them +164 MB, on a 1 GB node with a 512 MB heap. MAX_HELD_PAYLOADS alone brings that to +21 MB, and
//   the payload limit of 4,096 hex to +9.4 MB in all (10,000 waiting, 1,000 holding the largest payload allowed).
//   4,096 is 2.6x the largest the phone builds (1,548 hex: a 32-character name in the costliest characters, the longest
//   key and 24 of the longest words, through core's encryptPairingPayload; a 5-letter name and 12 words is 782).
// A payload past MAX_HELD_PAYLOADS is refused with the busy answer, which the phone shows, and its session stays waiting
// so the phone can try again; nobody else's held payload is ever dropped to make room.
const MAX_SESSIONS = 10_000;
const MAX_HELD_PAYLOADS = 1_000;
const MAX_CIPHERTEXT_HEX_LEN = 4_096;
const RELAY_BUSY = 'Pairing relay at capacity. Please try again shortly.';

export const PAIRING_RELAY_LIMITS = {
    sessions: MAX_SESSIONS,
    heldPayloads: MAX_HELD_PAYLOADS,
    ciphertextHex: MAX_CIPHERTEXT_HEX_LEN,
} as const;

const sessions = new Map<string, PairingSession>();
/** The sessions holding a payload (status 'transferred'), so MAX_HELD_PAYLOADS is counted without a walk. */
const held = new Set<string>();

/** Every way a session ends goes through here, so `held` never counts one that is gone. */
function dropSession(sessionId: string): void {
    sessions.delete(sessionId);
    held.delete(sessionId);
}

/**
 * Initializes a new pairing session requested by the desktop PWA.
 */
export function initPairingSession(sessionId: string, desktopPubHex: string): { ok: boolean; error?: string; expiresAt?: number } {
    if (!sessionId || typeof sessionId !== 'string' || !/^[0-9a-fA-F]{16,64}$/.test(sessionId)) {
        return { ok: false, error: 'Invalid sessionId format (must be 16-64 hex chars)' };
    }
    if (!desktopPubHex || typeof desktopPubHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(desktopPubHex)) {
        return { ok: false, error: 'Invalid desktopPubHex format (must be 64 hex chars)' };
    }

    // Capacity limit
    if (sessions.size >= MAX_SESSIONS) {
        return { ok: false, error: RELAY_BUSY };
    }

    // Clean up existing session if re-initialized
    const existing = sessions.get(sessionId);
    if (existing) {
        clearTimeout(existing.timer);
        dropSession(sessionId);
    }

    const now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS;

    const timer = setTimeout(() => {
        dropSession(sessionId);
    }, PAIRING_TTL_MS);

    if (timer.unref) timer.unref();

    sessions.set(sessionId, {
        sessionId,
        desktopPubHex,
        createdAt: now,
        expiresAt,
        status: 'waiting',
        timer,
    });

    return { ok: true, expiresAt };
}

/**
 * Submits the encrypted identity payload from the authenticated mobile device.
 */
export function transferPairingPayload(
    sessionId: string,
    mobilePubHex: string,
    nonceHex: string,
    ciphertextHex: string
): { ok: boolean; error?: string } {
    const session = sessions.get(sessionId);
    if (!session) {
        return { ok: false, error: 'Pairing session expired or not found' };
    }

    if (session.status !== 'waiting') {
        return { ok: false, error: 'Pairing session already completed or consumed' };
    }

    if (!mobilePubHex || !/^[0-9a-fA-F]{64}$/.test(mobilePubHex)) {
        return { ok: false, error: 'Invalid mobilePubHex format' };
    }
    if (!nonceHex || !/^[0-9a-fA-F]{48}$/.test(nonceHex)) {
        return { ok: false, error: 'Invalid nonceHex format (must be 48 hex chars / 24 bytes)' };
    }
    if (
        !ciphertextHex ||
        typeof ciphertextHex !== 'string' ||
        ciphertextHex.length === 0 ||
        ciphertextHex.length > MAX_CIPHERTEXT_HEX_LEN ||
        !/^[0-9a-fA-F]+$/.test(ciphertextHex)
    ) {
        return { ok: false, error: `Invalid ciphertextHex (must be hex up to ${MAX_CIPHERTEXT_HEX_LEN} chars)` };
    }

    // At most MAX_HELD_PAYLOADS wait for their computers (above). Past it, the busy answer; this session stays waiting.
    if (held.size >= MAX_HELD_PAYLOADS) {
        return { ok: false, error: RELAY_BUSY };
    }

    session.status = 'transferred';
    session.payload = {
        mobilePubHex,
        nonceHex,
        ciphertextHex,
    };
    held.add(sessionId);

    return { ok: true };
}

/**
 * Polled by the waiting desktop PWA.
 * If transferred, delivers the payload and schedules immediate cleanup with a 15-second
 * resilience grace period to tolerate transient browser retry loops.
 */
export function pollPairingSession(sessionId: string): {
    status: 'waiting' | 'transferred' | 'expired';
    desktopPubHex?: string;
    payload?: PairingPayload;
} {
    if (!sessionId || typeof sessionId !== 'string' || !/^[0-9a-fA-F]{16,64}$/.test(sessionId)) {
        return { status: 'expired' };
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return { status: 'expired' };
    }

    if (session.status === 'transferred' && session.payload) {
        const payload = session.payload;
        // Schedule deletion within 15 seconds to allow retry resilience
        clearTimeout(session.timer);
        session.timer = setTimeout(() => {
            dropSession(sessionId);
        }, 15_000);
        if (session.timer.unref) session.timer.unref();

        return {
            status: 'transferred',
            payload,
        };
    }

    return {
        status: 'waiting',
        desktopPubHex: session.desktopPubHex,
    };
}

/**
 * Cancels and deletes an active pairing session.
 */
export function cancelPairingSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) {
        clearTimeout(session.timer);
        dropSession(sessionId);
    }
}

/**
 * Clears all pairing sessions (for tests / shutdown).
 */
export function clearAllPairingSessions(): void {
    for (const session of sessions.values()) {
        clearTimeout(session.timer);
    }
    sessions.clear();
    held.clear();
}
