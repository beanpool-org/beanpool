/**
 * Redaction of secrets from anything about to be written to a log.
 *
 * WHY THIS IS ITS OWN FILE. It used to live in logger.ts, which opens the SQLite database at import.
 * The process-level error net (process-handlers.ts) must not depend on the database — the database may
 * be the very thing that just failed, and a net that fails to install is no net at all. The function is
 * unchanged and logger.ts still re-exports it, so every existing caller and its test are untouched.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import { expoAccessTokenValue } from './config/expo-access-token.js';

/**
 * Internet addresses. A candidate is kept only when node:net reads it as an address, so a time (10:22:33), a MAC
 * address, `std::` or a version number (v1.2.3.4) is left alone. A trailing full stop ends an address ("from
 * 203.0.113.7."); a dot followed by a digit does not. An IPv6 one starts where a word does, or just after a label's
 * colon: main's limiters logged their key, `ip:2001:db8::1`.
 */
const IPV6_CANDIDATE = /(?:(?<![0-9A-Za-z:.])|(?<=[A-Za-z]:))(?:[0-9A-Fa-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f]{0,4})(?:%[0-9A-Za-z_-]+)?(?![0-9A-Za-z:]|\.\d)/g;
const IPV4_CANDIDATE = /(?<![0-9A-Za-z.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g;

/**
 * Loopback and unspecified addresses name no one, and an operator needs them in config warnings ("the bare ::1 is
 * left out"), so they stay. Every spelling counts: 0:0:0:0:0:0:0:1, ::ffff:127.0.0.1 and ::ffff:7f00:1 too.
 */
const NAMES_NO_ONE = new net.BlockList();
NAMES_NO_ONE.addSubnet('127.0.0.0', 8, 'ipv4');
NAMES_NO_ONE.addAddress('0.0.0.0', 'ipv4');
NAMES_NO_ONE.addAddress('::1', 'ipv6');
NAMES_NO_ONE.addAddress('::', 'ipv6');
NAMES_NO_ONE.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

/** `text` with every internet address in it replaced, IPv6 first (its dotted IPv4 tail too), then IPv4. */
export function redactAddresses(text: string): string {
    return text
        .replace(IPV6_CANDIDATE, (m) => {
            const address = m.split('%')[0];
            return /[0-9a-f]/i.test(m) && net.isIPv6(address) && !NAMES_NO_ONE.check(address, 'ipv6') ? '[REDACTED_ADDRESS]' : m;
        })
        .replace(IPV4_CANDIDATE, (m) => (net.isIPv4(m) && !NAMES_NO_ONE.check(m, 'ipv4') ? '[REDACTED_ADDRESS]' : m));
}

/**
 * The keys whose value is a secret. Matched anywhere in a key name and in any case, so `newPassword`, `handshakeToken`,
 * `inviteCode`, `shortCode`, `keyShare` and `wsTicket` are covered by `password`, `token`, `code`, `share` and `ticket`.
 * `code` and the short keys after it (FABLE-sec-errors M1, M2, NOTE-3): a re-key code binds any new key to a member for a
 * day, an invite lets anyone join, a pairing or one-time code signs someone in, and words or a share rebuild a key.
 */
const CREDENTIAL_KEYS = 'password|authToken|token|salt|adminHash|secret|privateKey|private_key|seed|keyBytes|apiKey|api_key|authorization'
    + '|code|otp|invite|words|mnemonic|share|ticket|cookie';

/**
 * `key: value`, `key=value` or `"key": "value"`. A quoted value is taken whole, spaces and all (a password with a space in
 * it, a handful of words); an unquoted one is a run of token characters. The minimum is 4 characters, not 12: a TOTP is
 * 6 digits and a pairing code 6 letters. Below 4 are an HTTP status after `statusCode:` or `exit code=1`, which name no
 * one. `authorization: Bearer x` keeps the scheme and loses the token.
 */
const CREDENTIAL_VALUE = new RegExp(
    `(["']?(?:${CREDENTIAL_KEYS})["']?\\s*[:=]\\s*(?:(?:Bearer|Basic)\\s+)?)`
    + `(?:"((?:[^"\\\\\\r\\n]|\\\\.)+)"|'((?:[^'\\\\\\r\\n]|\\\\.)+)'|[A-Za-z0-9_\\-.+=/]{4,})`,
    'gi',
);

/** A cookie header's value runs to the end of the line: every `name=value;` pair in it. */
const COOKIE_HEADER = /(["']?(?:set-)?cookie["']?\s*[:=]\s*)(?!["'\[])[^\r\n"']+/gi;

function redactCredentialValues(text: string): string {
    return text
        .replace(COOKIE_HEADER, '$1[REDACTED_CREDENTIAL]')
        .replace(CREDENTIAL_VALUE, (_m, key: string, dq?: string, sq?: string) => {
            if (dq !== undefined) return `${key}"[REDACTED_CREDENTIAL]"`;
            if (sq !== undefined) return `${key}'[REDACTED_CREDENTIAL]'`;
            return `${key}[REDACTED_CREDENTIAL]`;
        });
}

/**
 * Re-key codes (engine/member-wizards.ts generateRekeyCode: `RK-` and two groups of 4 hex digits) and invite codes
 * (@beanpool/engine generateShortCode: `INV-` and two groups of 4 from its 32-character alphabet, no 0, 1, I or O). Only
 * that whole shape, standing alone as a word: `XRK-1A2B-3C4D`, `INV-ABCD-EFGHI` and `INV-2024-0001` are left alone.
 * Case is ignored, for a code someone typed.
 */
export const REKEY_CODE_PATTERN = /(?<![A-Za-z0-9_])RK-[0-9A-F]{4}-[0-9A-F]{4}(?![A-Za-z0-9_])/gi;
export const INVITE_CODE_PATTERN = /(?<![A-Za-z0-9_])INV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}(?![A-Za-z0-9_])/gi;

/**
 * The short tag a log line carries for an invite code in its place: `inv#` and the first 4 hex characters of the code's
 * SHA-256. The same code always gives the same tag, so an operator can still follow one invite from line to line, and
 * 16 bits of a 40-bit code give nothing back: some 16 million codes share each tag. A re-key code gets no tag: it has only
 * 32 bits, and 16 of them would leave a log reader 65,536 codes to try in its 24 hours.
 */
export function inviteLogTag(code: string): string {
    return 'inv#' + crypto.createHash('sha256').update(String(code).toUpperCase()).digest('hex').slice(0, 4);
}

/**
 * `text` with every re-key code replaced by `[REDACTED_REKEY_CODE]` and every invite code by its tag (`inviteLogTag`).
 * Nothing else in it changes. Used on every line logged (`sanitizeMessage`) and on lines written before this version
 * (services/address-retention.ts, the boot scrub of system_logs and of stored copies of the database).
 */
export function redactCodes(text: string): string {
    return text
        .replace(REKEY_CODE_PATTERN, '[REDACTED_REKEY_CODE]')
        .replace(INVITE_CODE_PATTERN, (code) => inviteLogTag(code));
}

/**
 * Secrets the node holds only in its environment, taken out of a line by their VALUE: a key name (`token:`,
 * `Authorization: Bearer`) is caught above, but an error can quote one bare. Shorter than 8 characters is left alone,
 * so a stray value can't blank out ordinary words.
 */
function redactEnvironmentSecrets(text: string): string {
    const token = expoAccessTokenValue();
    return token && token.length >= 8 ? text.split(token).join('[REDACTED_CREDENTIAL]') : text;
}

/**
 * Sanitizes input message by redacting sensitive items (private keys, passwords, mnemonics, internet addresses).
 */
export function sanitizeMessage(msg: string): string {
    if (!msg) return '';
    // 0. The Expo access token's value, wherever it sits (`redactEnvironmentSecrets`), before any step below can cut
    // it into a shape the value no longer matches.
    let sanitized = redactEnvironmentSecrets(msg);

    // 1. BIP39 Mnemonic Seed Phrase (12 to 24 words)
    // Matches 12 to 24 lowercase space-separated words of 3-12 chars.
    sanitized = sanitized.replace(/\b(?:[a-z]{3,12}\s+){11,23}[a-z]{3,12}\b/gi, '[REDACTED_MNEMONIC]');

    // 2. PEM Private Keys
    sanitized = sanitized.replace(/-----BEGIN\s*(?:RSA\s*|EC\s*|ED25519\s*)?PRIVATE\s*KEY-----[\s\S]+?-----END\s*(?:RSA\s*|EC\s*|ED25519\s*)?PRIVATE\s*KEY-----/gi, '[REDACTED_PRIVATE_KEY]');

    // 3. Secrets, passwords, tokens, salt, hashes, api keys, codes in JSON / form / query / header formats
    sanitized = redactCredentialValues(sanitized);

    // 4. Standalone Hex seed strings / keys (64 or 128 hex chars)
    sanitized = sanitized.replace(/\b[0-9a-fA-F]{64}\b/gi, '[REDACTED_HEX_KEY_64]');
    sanitized = sanitized.replace(/\b[0-9a-fA-F]{128}\b/gi, '[REDACTED_HEX_KEY_128]');

    // 5. Internet addresses. A community server's logs never record one: a line that has to tell sources apart names
    // them by a daily keyed hash (log-address.ts). This is the net for any text that reaches a log with an address in
    // it anyway, an error message included.
    sanitized = redactAddresses(sanitized);

    // 6. Re-key and invite codes, wherever they sit in the text (`redactCodes`).
    sanitized = redactCodes(sanitized);

    return sanitized;
}
