import crypto from 'node:crypto';

/**
 * Clean, zero-dependency TOTP (RFC 6238) implementation using Node.js built-in `crypto`.
 * Supports standard HMAC-SHA1 6-digit codes with 30s step.
 */

// Base32 RFC 4648 alphabet
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Generate a cryptographically random Base32 TOTP secret key (160 bits / 20 bytes = 32 base32 chars).
 */
export function generateTotpSecret(): string {
    const bytes = crypto.randomBytes(20);
    let result = '';
    let buffer = 0;
    let bitsLeft = 0;

    for (let i = 0; i < bytes.length; i++) {
        buffer = (buffer << 8) | bytes[i];
        bitsLeft += 8;
        while (bitsLeft >= 5) {
            result += ALPHABET[(buffer >> (bitsLeft - 5)) & 31];
            bitsLeft -= 5;
        }
    }
    if (bitsLeft > 0) {
        result += ALPHABET[(buffer << (5 - bitsLeft)) & 31];
    }
    return result;
}

/**
 * Decode Base32 string to Buffer.
 */
function base32Decode(base32: string): Buffer {
    const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
    const bytes: number[] = [];
    let buffer = 0;
    let bitsLeft = 0;

    for (let i = 0; i < clean.length; i++) {
        const val = ALPHABET.indexOf(clean[i]);
        if (val === -1) continue;
        buffer = (buffer << 5) | val;
        bitsLeft += 5;
        if (bitsLeft >= 8) {
            bytes.push((buffer >> (bitsLeft - 8)) & 255);
            bitsLeft -= 8;
        }
    }
    return Buffer.from(bytes);
}

/**
 * Generate a 6-digit TOTP token for a given Base32 secret and time counter.
 */
export function generateTotpCode(secretBase32: string, timeStepWindow = 0, stepSeconds = 30): string {
    const key = base32Decode(secretBase32);
    const counter = Math.floor(Date.now() / 1000 / stepSeconds) + timeStepWindow;

    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(BigInt(counter), 0);

    const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const codeInt = ((hmac[offset] & 0x7f) << 24) |
                    ((hmac[offset + 1] & 0xff) << 16) |
                    ((hmac[offset + 2] & 0xff) << 8) |
                    (hmac[offset + 3] & 0xff);

    const code = (codeInt % 1000000).toString().padStart(6, '0');
    return code;
}

/**
 * Verify a 6-digit TOTP token against a Base32 secret, checking a ±1 window (30s drift tolerance).
 * Handles copy-pasted tokens with spaces or hyphens (e.g. "123 456" or "123-456").
 */
export function verifyTotpCode(token: string, secretBase32: string, window = 1): boolean {
    if (!token || typeof token !== 'string') return false;
    const cleanToken = token.replace(/[\s-]/g, '').trim();
    if (!/^\d{6}$/.exec(cleanToken)) return false;

    const tokenBuf = Buffer.alloc(6);
    tokenBuf.write(cleanToken, 'utf8');

    for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
        const expected = generateTotpCode(secretBase32, errorWindow);
        const expectedBuf = Buffer.alloc(6);
        expectedBuf.write(expected, 'utf8');
        if (crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
            return true;
        }
    }
    return false;
}

/**
 * Generate 8 cryptographically secure 8-character hex backup codes.
 */
export function generateBackupCodes(count = 8): string[] {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
        codes.push(crypto.randomBytes(4).toString('hex').toLowerCase());
    }
    return codes;
}

/**
 * Hash a backup code with SHA-256 for secure storage at rest.
 */
export function hashBackupCode(code: string): string {
    return crypto.createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

/**
 * Verify a candidate backup code against an array of stored SHA-256 hashes using timingSafeEqual.
 * Returns the matching index or -1 if not found.
 */
export function verifyAndFindBackupCodeHash(candidateCode: string, storedHashes: string[]): number {
    if (!candidateCode || !Array.isArray(storedHashes)) return -1;
    const candidateHashBuf = Buffer.from(hashBackupCode(candidateCode));

    for (let i = 0; i < storedHashes.length; i++) {
        const storedBuf = Buffer.from(storedHashes[i]);
        if (candidateHashBuf.length === storedBuf.length && crypto.timingSafeEqual(candidateHashBuf, storedBuf)) {
            return i;
        }
    }
    return -1;
}

/**
 * Generate otpauth:// URI for QR code rendering.
 * Encodes issuer and accountName separately so the colon path separator is preserved unencoded.
 */
export function generateOtpauthUri(secretBase32: string, accountName = 'admin', issuer = 'BeanPool'): string {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
    const encIssuer = encodeURIComponent(issuer);
    return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}
