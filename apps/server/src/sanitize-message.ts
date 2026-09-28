/**
 * Redaction of secrets from anything about to be written to a log.
 *
 * WHY THIS IS ITS OWN FILE. It used to live in logger.ts, which opens the SQLite database at import.
 * The process-level error net (process-handlers.ts) must not depend on the database — the database may
 * be the very thing that just failed, and a net that fails to install is no net at all. The function is
 * unchanged and logger.ts still re-exports it, so every existing caller and its test are untouched.
 */

import net from 'node:net';

/**
 * Internet addresses. A candidate is kept only when node:net reads it as an address, so a time (10:22:33), a MAC
 * address, `std::` or a version number (v1.2.3.4) is left alone. A trailing full stop ends an address ("from
 * 203.0.113.7."); a dot followed by a digit does not.
 */
const IPV6_CANDIDATE = /(?<![0-9A-Za-z:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f]{0,4})(?:%[0-9A-Za-z_-]+)?(?![0-9A-Za-z:]|\.\d)/g;
const IPV4_CANDIDATE = /(?<![0-9A-Za-z.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g;

/** `text` with every internet address in it replaced, IPv6 first (its dotted IPv4 tail too), then IPv4. */
export function redactAddresses(text: string): string {
    return text
        .replace(IPV6_CANDIDATE, (m) => (/[0-9a-f]/i.test(m) && net.isIPv6(m.split('%')[0]) ? '[REDACTED_ADDRESS]' : m))
        .replace(IPV4_CANDIDATE, (m) => (net.isIPv4(m) ? '[REDACTED_ADDRESS]' : m));
}

/**
 * Sanitizes input message by redacting sensitive items (private keys, passwords, mnemonics, internet addresses).
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

    // 5. Internet addresses. A community server's logs never record one: a line that has to tell sources apart names
    // them by a daily keyed hash (log-address.ts). This is the net for any text that reaches a log with an address in
    // it anyway, an error message included.
    sanitized = redactAddresses(sanitized);

    return sanitized;
}
