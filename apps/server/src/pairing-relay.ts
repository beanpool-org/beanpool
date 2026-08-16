/**
 * Pairing Relay — In-Memory Ephemeral QR Device Pairing Relay (#89).
 *
 * Facilitates zero-knowledge transfer of encrypted identity payloads between
 * a scanning mobile app and an unauthenticated desktop PWA.
 *
 * Security Guarantees:
 * - In-memory only: zero disk writes, zero SQLite rows.
 * - Strict 120-second TTL auto-expiration.
 * - Single-use: session is purged from memory immediately upon successful poll.
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
const MAX_SESSIONS = 500;

const sessions = new Map<string, PairingSession>();

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
        return { ok: false, error: 'Pairing relay at capacity. Please try again shortly.' };
    }

    // Clean up existing session if re-initialized
    const existing = sessions.get(sessionId);
    if (existing) {
        clearTimeout(existing.timer);
        sessions.delete(sessionId);
    }

    const now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS;

    const timer = setTimeout(() => {
        sessions.delete(sessionId);
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
    if (!ciphertextHex || typeof ciphertextHex !== 'string' || ciphertextHex.length === 0) {
        return { ok: false, error: 'Invalid ciphertextHex' };
    }

    session.status = 'transferred';
    session.payload = {
        mobilePubHex,
        nonceHex,
        ciphertextHex,
    };

    return { ok: true };
}

/**
 * Polled by the waiting desktop PWA.
 * If transferred, delivers the payload and immediately destroys the session (single-use).
 */
export function pollPairingSession(sessionId: string): {
    status: 'waiting' | 'transferred' | 'expired';
    desktopPubHex?: string;
    payload?: PairingPayload;
} {
    const session = sessions.get(sessionId);
    if (!session) {
        return { status: 'expired' };
    }

    if (session.status === 'transferred' && session.payload) {
        const payload = session.payload;
        // Purge immediately on single-use consumption
        clearTimeout(session.timer);
        sessions.delete(sessionId);
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
        sessions.delete(sessionId);
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
}
