/**
 * How a log line names an internet address: never the address, only a short keyed hash of it.
 *
 * A community server's logs (system_logs, and stdout, which is Docker's log) never record anyone's address. Where a
 * line has to tell attempts apart (the same address guessing the admin password again, or one proxy forwarding for
 * everyone), it writes `ip#` and the first 10 characters of an HMAC-SHA-256 of the address. The key is 32 random bytes
 * made for the current UTC day and held in this process's memory only: never in the database, in a file or in a
 * log. So the same address has the same tag all day, and nothing links one day's tags to another's; a restart also
 * starts a new key. Without the key, a tag cannot be matched to an address by trying every IPv4 address, as a hash
 * under a key kept in the database could (engine/open-join.ts, `ip_hash`, which is why that one lives a day).
 *
 * Same shape as the open door's and the knocks' address hashes (engine/open-join.ts `keyedHash`): a domain tag, then
 * the address, under a key; its own domain, and its own key, so a log tag never equals either of those.
 *
 * Callers pass the limiter's key for the address (client-ip.ts `limiterKeyForIp`: an IPv6 client by its /64), so a
 * tag names the same source the limiter counted. No imports but node:crypto: client-ip.ts uses it.
 */

import crypto from 'node:crypto';

const DOMAIN = 'beanpool-log-ip/v1';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 10 base64url characters: 60 bits, enough that two sources in one day's logs never share a tag. */
const TAG_CHARS = 10;

let current: { day: number; key: Buffer } | null = null;

function keyFor(day: number): Buffer {
    // Only one day's key at a time: the old one is dropped the moment a new day's is made.
    if (!current || current.day !== day) current = { day, key: crypto.randomBytes(32) };
    return current.key;
}

/** `ip#` and a keyed hash of `limiterKey` under today's key (UTC). `now` is for tests. */
export function logAddressTag(limiterKey: string, now = Date.now()): string {
    const day = Math.floor(now / DAY_MS);
    const mac = crypto.createHmac('sha256', keyFor(day)).update(`${DOMAIN}|${limiterKey}`, 'utf-8').digest('base64url');
    return `ip#${mac.slice(0, TAG_CHARS)}`;
}
