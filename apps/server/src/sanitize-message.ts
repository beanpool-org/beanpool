/**
 * Redaction of secrets from anything about to be written to a log.
 *
 * WHY THIS IS ITS OWN FILE. It used to live in logger.ts, which opens the SQLite database at import.
 * The process-level error net (process-handlers.ts) must not depend on the database — the database may
 * be the very thing that just failed, and a net that fails to install is no net at all. The function is
 * unchanged and logger.ts still re-exports it, so every existing caller and its test are untouched.
 */

/**
 * Sanitizes input message by redacting sensitive items (private keys, passwords, mnemonics).
 */
export function sanitizeMessage(msg: string): string {
    if (!msg) return '';
    let sanitized = msg;

    // 1. BIP39 Mnemonic Seed Phrase (12 to 24 words)
    // Matches 12 to 24 lowercase space-separated words of 3-12 chars.
    sanitized = sanitized.replace(/\b(?:[a-z]{3,12}\s+){11,23}[a-z]{3,12}\b/gi, '[REDACTED_MNEMONIC]');

    // 2. PEM Private Keys
    sanitized = sanitized.replace(/-----BEGIN\s*(?:RSA\s*|EC\s*|ED25519\s*)?PRIVATE\s*KEY-----[\s\S]+?-----END\s*(?:RSA\s*|EC\s*|ED25519\s*)?PRIVATE\s*KEY-----/gi, '[REDACTED_PRIVATE_KEY]');

    // 3. Secrets, passwords, tokens, salt, hashes, api keys in JSON / form / query formats
    sanitized = sanitized.replace(/(["']?(?:password|authToken|token|salt|adminHash|newPassword|currentPassword|secret|privateKey|private_key|seed|keyBytes|apiKey|api_key|authorization)["']?\s*[:=]\s*["']?)[a-zA-Z0-9_\-\.\+=\/]{12,}(["']?)/gi, '$1[REDACTED_CREDENTIAL]$2');

    // 4. Standalone Hex seed strings / keys (64 or 128 hex chars)
    sanitized = sanitized.replace(/\b[0-9a-fA-F]{64}\b/gi, '[REDACTED_HEX_KEY_64]');
    sanitized = sanitized.replace(/\b[0-9a-fA-F]{128}\b/gi, '[REDACTED_HEX_KEY_128]');

    return sanitized;
}
