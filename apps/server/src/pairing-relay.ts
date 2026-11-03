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
 * - Number matching (fable-security-signin finding 1, as the Settings QR sign-in does it): the phone's payload is held
 *   with four digits the phone shows, and released only to the browser that opened the session (its binding secret, an
 *   httpOnly cookie set at init) once that browser types them. Someone who only sent a member the QR never sees the
 *   phone. Three wrong tries burn the session and its payload: 3 guesses in 10,000, 0.03% (with two digits it was 3%,
 *   SEC-INV-02 of the invite/join audit).
 *
 * The other way, browser to phone (front doors S9, a `to-phone` session): a member signed in on the web brings the account
 * to the phone app without typing the 12 words. The browser opens the session as before (its binding cookie) and shows
 * `beanpool://pair-in?…`; the phone OFFERS a fresh X25519 key and gets four digits and a binding secret of its own back;
 * the PHONE shows the digits and the browser types them, so the account goes only to the phone in the member's hand.
 * The browser never shows the digits: anyone who can see the browser's screen (over a shoulder, a screen share, a photo)
 * sees the QR, and would see digits beside it too. Only after the right digits does the browser learn the phone's key,
 * seal the account to it and send it (sendToPhonePayload); only the phone that offered, with its secret, collects it.
 * Same 120 s, three tries, one phone per session, 15 s grace, in memory. A session of one way refuses every step of the
 * other: no phone's payload is ever taken into a `to-phone` session, and no offer into a `from-phone` one.
 */

import crypto from 'node:crypto';

export interface PairingPayload {
    mobilePubHex: string;
    nonceHex: string;
    ciphertextHex: string;
}

/** `from-phone`: a phone sends its account to the browser that opened the session (#89). `to-phone`: that browser sends its account to a phone (S9). */
export type PairingDirection = 'from-phone' | 'to-phone';

interface PairingSession {
    sessionId: string;
    direction: PairingDirection;
    desktopPubHex: string;
    createdAt: number;
    /** 120 s after it opened: the latest the session ends. Nothing moves it, a poll included. */
    expiresAt: number;
    /** When it ends now: `expiresAt`, or sooner once its payload is collected (the grace, never past `expiresAt`). */
    endsAt: number;
    /** to-phone also has 'released' (right digits: the browser may seal to the phone) and 'sent' (the sealed account waits for the phone). */
    status: 'waiting' | 'confirming' | 'transferred' | 'burned' | 'released' | 'sent';
    payload?: PairingPayload;
    /** to-phone: the key the phone offered, the secret only that phone holds (sha256), and whether it has collected. */
    phonePubHex?: string;
    phoneSecretHash?: Buffer;
    phoneCollected?: boolean;
    /** sha256 of the binding secret only the opening browser holds. */
    secretHash: Buffer;
    /** The four digits the phone shows, until the browser types them. */
    confirmCode?: string;
    confirmTries: number;
    timer?: NodeJS.Timeout;
}

const PAIRING_TTL_MS = 120_000; // 2 minutes
/** Once the computer has its payload, a retry of a lost answer gets it again for this long, never past `expiresAt`. */
const COLLECT_GRACE_MS = 15_000;
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
// - A payload's slot is free the moment the computer collects it. The collected payload is kept for the grace, for a
//   retry, and those kept are capped at MAX_HELD_PAYLOADS too: past it a collect ends the session at once, its answer
//   carrying the payload. Without that cap, a sender collecting its own payloads could keep 10,000 of them.
// - No session outlives its 120 s, so polling a collected one every few seconds can't keep it: the grace is re-armed
//   only inside that. The computer polls every 1.5 s and stops at 120 s (apps/pwa WelcomePage), so no honest collect
//   needs longer.
// A payload past MAX_HELD_PAYLOADS is refused with the busy answer, which the phone shows, and its session stays waiting
// so the phone can try again; nobody else's held payload is ever dropped to make room.
const MAX_SESSIONS = 10_000;
const MAX_HELD_PAYLOADS = 1_000;
const MAX_CIPHERTEXT_HEX_LEN = 4_096;
const RELAY_BUSY = 'Pairing relay at capacity. Please try again shortly.';
/** A phone's account sent to a browser's code for bringing its account to a phone. */
const TO_PHONE_ONLY = 'This code brings an account from a browser to a phone. Nothing was sent.';
/** Wrong digits before the session and its payload are burned. */
const CONFIRM_TRIES = 3;
/** How many digits the phone shows and the browser types. A phone says it shows four (`confirm: 'four-digits'`). */
const CONFIRM_DIGITS = 4;
/** The only answer that can be right: exactly CONFIRM_DIGITS digits. Anything else is a wrong try. */
const CONFIRM_CODE = new RegExp(`^\\d{${CONFIRM_DIGITS}}$`);

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest();

export const PAIRING_RELAY_LIMITS = {
    sessions: MAX_SESSIONS,
    heldPayloads: MAX_HELD_PAYLOADS,
    ciphertextHex: MAX_CIPHERTEXT_HEX_LEN,
    ttlMs: PAIRING_TTL_MS,
    graceMs: COLLECT_GRACE_MS,
    confirmTries: CONFIRM_TRIES,
    confirmDigits: CONFIRM_DIGITS,
} as const;

const sessions = new Map<string, PairingSession>();
/** Payloads not yet collected: at most MAX_HELD_PAYLOADS. */
const held = new Set<string>();
/** Payloads collected and kept for the grace: at most MAX_HELD_PAYLOADS. */
const collected = new Set<string>();

let clockOffsetMs = 0;
const now = () => Date.now() + clockOffsetMs;

/** Tests move the relay's clock (a session's 120 s without waiting them); every read checks `endsAt` against it. */
export function _setPairingClockForTests(offsetMs: number): void {
    clockOffsetMs = offsetMs;
}

export function _pairingRelayCountsForTests(): { sessions: number; held: number; collected: number } {
    return { sessions: sessions.size, held: held.size, collected: collected.size };
}

/** Every way a session ends goes through here, so `held` and `collected` never count one that is gone. */
function dropSession(sessionId: string): void {
    clearTimeout(sessions.get(sessionId)?.timer);
    sessions.delete(sessionId);
    held.delete(sessionId);
    collected.delete(sessionId);
}

/** The session ends at `endsAt`: a timer frees the memory, and every read checks the time itself (`liveSession`). */
function endAt(session: PairingSession, endsAt: number): void {
    clearTimeout(session.timer);
    session.endsAt = endsAt;
    const timer = setTimeout(() => {
        if (sessions.get(session.sessionId) === session) dropSession(session.sessionId);
    }, Math.max(0, endsAt - now()));
    if (timer.unref) timer.unref();
    session.timer = timer;
}

/** The session, or undefined once its time is up (dropped then). */
function liveSession(sessionId: string): PairingSession | undefined {
    const session = sessions.get(sessionId);
    if (session && now() >= session.endsAt) {
        dropSession(sessionId);
        return undefined;
    }
    return session;
}

/**
 * Initializes a new pairing session requested by the desktop PWA.
 */
export function initPairingSession(
    sessionId: string,
    desktopPubHex: string,
    direction: PairingDirection = 'from-phone',
): { ok: boolean; error?: string; expiresAt?: number; secret?: string } {
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
    if (sessions.has(sessionId)) dropSession(sessionId);

    const createdAt = now();
    const expiresAt = createdAt + PAIRING_TTL_MS;
    const secret = crypto.randomBytes(32).toString('hex');
    const session: PairingSession = {
        sessionId, direction, desktopPubHex, createdAt, expiresAt, endsAt: expiresAt, status: 'waiting',
        secretHash: sha256(secret), confirmTries: 0,
    };
    sessions.set(sessionId, session);
    endAt(session, expiresAt);

    return { ok: true, expiresAt, secret };
}

/**
 * Submits the encrypted identity payload from the authenticated mobile device.
 */
export function transferPairingPayload(
    sessionId: string,
    mobilePubHex: string,
    nonceHex: string,
    ciphertextHex: string
): { ok: boolean; error?: string; confirmCode?: string } {
    const session = liveSession(sessionId);
    if (!session) {
        return { ok: false, error: 'Pairing session expired or not found' };
    }

    // A browser's code for bringing its account to a phone never takes a phone's account (S9).
    if (session.direction !== 'from-phone') {
        return { ok: false, error: TO_PHONE_ONLY };
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

    // Its end stays `expiresAt`: 120 s from opening, so at most 120 s from now. Held until the browser types the digits.
    session.status = 'confirming';
    session.payload = {
        mobilePubHex,
        nonceHex,
        ciphertextHex,
    };
    session.confirmCode = String(crypto.randomInt(10 ** CONFIRM_DIGITS)).padStart(CONFIRM_DIGITS, '0');
    session.confirmTries = 0;
    held.add(sessionId);

    return { ok: true, confirmCode: session.confirmCode };
}

/** Only the browser holding the session's binding secret. */
function bound(session: PairingSession, secret: string | undefined): boolean {
    return !!secret && crypto.timingSafeEqual(sha256(String(secret)), session.secretHash);
}

export type ConfirmResult =
    | { result: 'released' }
    | { result: 'wrong'; triesLeft: number }
    | { result: 'burned' | 'wrong-browser' | 'expired' | 'not-confirming' };

/**
 * The browser types the four digits the phone shows. Right digits release the payload to its next poll; three wrong
 * burn the session and drop the payload. An answer that isn't four digits (two, an old page's) is a wrong try. A
 * browser without the binding secret changes nothing.
 */
export function confirmPairingTransfer(sessionId: string, secret: string | undefined, digits: unknown): ConfirmResult {
    const session = typeof sessionId === 'string' ? liveSession(sessionId) : undefined;
    if (!session) return { result: 'expired' };
    if (!bound(session, secret)) return { result: 'wrong-browser' };
    if (session.status === 'burned') return { result: 'burned' };
    if (session.status !== 'confirming' || !session.confirmCode) return { result: 'not-confirming' };
    const typed = typeof digits === 'string' ? digits.trim() : '';
    const right = CONFIRM_CODE.test(typed) && crypto.timingSafeEqual(Buffer.from(typed), Buffer.from(session.confirmCode));
    if (!right) {
        session.confirmTries++;
        if (session.confirmTries >= CONFIRM_TRIES) {
            session.status = 'burned';
            session.payload = undefined;
            session.confirmCode = undefined;
            session.phonePubHex = undefined;
            held.delete(sessionId);
            return { result: 'burned' };
        }
        return { result: 'wrong', triesLeft: CONFIRM_TRIES - session.confirmTries };
    }
    // From a phone: its payload goes to this browser's next poll. To a phone: this browser may now seal to the phone's key.
    session.status = session.direction === 'to-phone' ? 'released' : 'transferred';
    session.confirmCode = undefined;
    return { result: 'released' };
}

/**
 * Polled by the waiting desktop PWA.
 * Answers only the browser holding the session's binding secret ('wrong-browser' to any other), and 'confirming'
 * while the phone's digits wait to be typed. Once they are, delivers the payload: its slot is free at once, and it is kept for a 15-second grace (a retry of a
 * lost answer gets it again), re-armed by each poll but never past the session's 120 s.
 */
export function pollPairingSession(sessionId: string, secret: string | undefined): {
    status: 'waiting' | 'confirming' | 'transferred' | 'burned' | 'expired' | 'wrong-browser' | 'released' | 'sent' | 'collected';
    desktopPubHex?: string;
    payload?: PairingPayload;
    phonePubHex?: string;
} {
    if (!sessionId || typeof sessionId !== 'string' || !/^[0-9a-fA-F]{16,64}$/.test(sessionId)) {
        return { status: 'expired' };
    }

    const session = liveSession(sessionId);
    if (!session) {
        return { status: 'expired' };
    }
    // Only the browser that opened it learns anything about it, the payload above all.
    if (!bound(session, secret)) return { status: 'wrong-browser' };
    // To a phone: the browser's own view, never a payload. The phone's key only once the browser has typed its digits.
    if (session.direction === 'to-phone') {
        if (session.status === 'released') return { status: 'released', phonePubHex: session.phonePubHex };
        if (session.status === 'sent') return { status: session.phoneCollected ? 'collected' : 'sent' };
        if (session.status === 'confirming' || session.status === 'burned') return { status: session.status };
        return { status: 'waiting' };
    }
    if (session.status === 'confirming' || session.status === 'burned') return { status: session.status };

    if (session.status === 'transferred' && session.payload) {
        const payload = session.payload;
        if (held.delete(sessionId)) {
            // Collected: the slot is free now. Kept for the grace if the kept ones have room; else it ends now.
            if (collected.size >= MAX_HELD_PAYLOADS) {
                dropSession(sessionId);
                return { status: 'transferred', payload };
            }
            collected.add(sessionId);
        }
        endAt(session, Math.min(now() + COLLECT_GRACE_MS, session.expiresAt));

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

/** Only the phone holding the secret its offer got. */
function phoneBound(session: PairingSession, secret: unknown): boolean {
    return !!session.phoneSecretHash && typeof secret === 'string' && !!secret
        && crypto.timingSafeEqual(sha256(secret), session.phoneSecretHash);
}

export type OfferResult =
    | { ok: true; confirmCode: string; phoneSecret: string; expiresAt: number }
    | { ok: false; error: 'expired' | 'not-to-phone' | 'taken' | 'bad-key' };

/**
 * To a phone (S9): the phone that scanned the browser's code offers its own X25519 key. One phone per session: a second
 * offer is refused ('taken') and changes nothing, so the phone that scanned first is the only one the digits can match.
 * The four digits go back to this phone only, with a secret only it holds; the browser is told that a phone scanned,
 * and the member types there the digits the phone shows.
 */
export function offerToPhoneSession(sessionId: string, phonePubHex: unknown): OfferResult {
    const session = typeof sessionId === 'string' ? liveSession(sessionId) : undefined;
    if (!session) return { ok: false, error: 'expired' };
    if (session.direction !== 'to-phone') return { ok: false, error: 'not-to-phone' };
    if (session.status !== 'waiting') return { ok: false, error: 'taken' };
    if (typeof phonePubHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(phonePubHex)) return { ok: false, error: 'bad-key' };
    const phoneSecret = crypto.randomBytes(32).toString('hex');
    session.status = 'confirming';
    session.phonePubHex = phonePubHex.toLowerCase();
    session.phoneSecretHash = sha256(phoneSecret);
    session.confirmCode = String(crypto.randomInt(10 ** CONFIRM_DIGITS)).padStart(CONFIRM_DIGITS, '0');
    session.confirmTries = 0;
    return { ok: true, confirmCode: session.confirmCode, phoneSecret, expiresAt: session.expiresAt };
}

export type SendResult =
    | { ok: true }
    | { ok: false; error: 'expired' | 'wrong-browser' | 'not-released' | 'bad-payload' | 'busy' };

/**
 * To a phone (S9): the browser that opened the session, with its binding secret, sends its account sealed to the phone's
 * key. Only after the digits matched ('released'), and only once: the session then holds it for that phone alone.
 */
export function sendToPhonePayload(sessionId: string, secret: string | undefined, nonceHex: unknown, ciphertextHex: unknown): SendResult {
    const session = typeof sessionId === 'string' ? liveSession(sessionId) : undefined;
    if (!session) return { ok: false, error: 'expired' };
    if (!bound(session, secret)) return { ok: false, error: 'wrong-browser' };
    if (session.direction !== 'to-phone' || session.status !== 'released') return { ok: false, error: 'not-released' };
    if (typeof nonceHex !== 'string' || !/^[0-9a-fA-F]{48}$/.test(nonceHex)) return { ok: false, error: 'bad-payload' };
    if (typeof ciphertextHex !== 'string' || ciphertextHex.length === 0 || ciphertextHex.length > MAX_CIPHERTEXT_HEX_LEN
        || !/^[0-9a-fA-F]+$/.test(ciphertextHex)) return { ok: false, error: 'bad-payload' };
    if (held.size >= MAX_HELD_PAYLOADS) return { ok: false, error: 'busy' };
    session.status = 'sent';
    // The sender's key is the session's own (the QR's `pub`): the phone opens it with that, never with a key the relay names.
    session.payload = { mobilePubHex: session.desktopPubHex, nonceHex, ciphertextHex };
    held.add(sessionId);
    return { ok: true };
}

/**
 * To a phone (S9): polled by the phone that offered, with its secret. 'confirming' while the member types the digits in
 * the browser, 'released' while the browser seals, then the sealed account (its nonce and ciphertext only), kept for
 * the same 15 s grace as the other way, never past the session's 120 s. Any other caller learns nothing ('wrong-phone').
 */
export function collectToPhonePayload(sessionId: string, phoneSecret: unknown): {
    status: 'confirming' | 'released' | 'sent' | 'burned' | 'expired' | 'wrong-phone';
    nonceHex?: string;
    ciphertextHex?: string;
} {
    const session = typeof sessionId === 'string' ? liveSession(sessionId) : undefined;
    if (!session || session.direction !== 'to-phone') return { status: 'expired' };
    if (!phoneBound(session, phoneSecret)) return { status: 'wrong-phone' };
    if (session.status === 'confirming' || session.status === 'released' || session.status === 'burned') return { status: session.status };
    if (session.status !== 'sent' || !session.payload) return { status: 'expired' };
    const { nonceHex, ciphertextHex } = session.payload;
    session.phoneCollected = true;
    if (held.delete(sessionId)) {
        // Collected: the slot is free now. Kept for the grace if the kept ones have room; else it ends now.
        if (collected.size >= MAX_HELD_PAYLOADS) {
            dropSession(sessionId);
            return { status: 'sent', nonceHex, ciphertextHex };
        }
        collected.add(sessionId);
    }
    endAt(session, Math.min(now() + COLLECT_GRACE_MS, session.expiresAt));
    return { status: 'sent', nonceHex, ciphertextHex };
}

/**
 * Cancels and deletes an active pairing session.
 */
export function cancelPairingSession(sessionId: string): void {
    if (sessions.has(sessionId)) dropSession(sessionId);
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
    collected.clear();
}
