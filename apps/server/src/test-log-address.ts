/**
 * Test coverage for logAddressTag in log-address.ts.
 *
 * Checks:
 *   1. Tag format: prefix "ip#", length (13 characters), base64url characters.
 *   2. Consistency: identical input and timestamp produce identical output.
 *   3. Uniqueness: different IP addresses produce different tags on the same day.
 *   4. UTC Day Rotation: same IP address produces different tags on different UTC days.
 *   5. Privacy: output tag never contains raw IP strings in plain text.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-log-address.ts
 */

import { logAddressTag } from './log-address.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

async function main(): Promise<void> {
    console.log('Running log-address tests...\n');

    const ipV4 = '203.0.113.42';
    const ipV6 = '2001:db8::1';
    const now = 1700000000000; // Fixed timestamp
    const DAY_MS = 24 * 60 * 60 * 1000;

    // 1. Tag format
    const tag = logAddressTag(ipV4, now);
    assert(tag.startsWith('ip#'), 'tag starts with "ip#" prefix');
    assert(tag.length === 13, `tag length is 13 characters (got ${tag.length})`);
    assert(/^ip#[A-Za-z0-9_-]{10}$/.test(tag), `tag matches expected base64url pattern (${tag})`);

    // 2. Consistency on same day
    const tagAgain = logAddressTag(ipV4, now + 1000); // 1 sec later on same day
    assert(tag === tagAgain, 'same IP produces same tag on the same UTC day');

    // 3. Divergence for different IPs on same day
    const tagOther = logAddressTag('203.0.113.43', now);
    assert(tag !== tagOther, 'different IPs produce different tags on the same UTC day');

    const tagV6 = logAddressTag(ipV6, now);
    assert(tagV6.startsWith('ip#') && tagV6.length === 13, 'IPv6 produces valid tag format');
    assert(tagV6 !== tag, 'IPv6 produces different tag than IPv4');

    // 4. Key rotation across UTC day boundary
    const tagNextDay = logAddressTag(ipV4, now + DAY_MS);
    assert(tag !== tagNextDay, 'same IP produces different tag on the next UTC day');

    // 5. Privacy: IP address not leaked
    assert(!tag.includes(ipV4) && !tagV6.includes(ipV6), 'tags do not expose raw IP addresses');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ test-log-address PASSED.');
}

main().catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
