/**
 * Test suite for engine/nonce-pressure.ts
 * Covers: emptyNoncePressure, noteRoomRefusal, keysAtShareSince, and requestNoncePressure.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-nonce-pressure.ts
 */

import {
    emptyNoncePressure,
    noteRoomRefusal,
    keysAtShareSince,
    requestNoncePressure,
    type NoncePressure,
} from './engine/nonce-pressure.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

function main(): void {
    console.log('\n=== Testing engine/nonce-pressure.ts ===\n');

    // 1. emptyNoncePressure
    const p: NoncePressure = emptyNoncePressure();
    assert(p.member.regionAt === null && p.member.regionRefusals === 0, 'emptyNoncePressure initializes member region empty');
    assert(p.newcomer.ownerAt === null && p.newcomer.ownerRefusals === 0, 'emptyNoncePressure initializes newcomer owner empty');
    assert(p.stranger.live === 0 && p.stranger.share === 0, 'emptyNoncePressure initializes stranger metrics empty');
    assert(p.keysAtShare.size === 0, 'emptyNoncePressure initializes keysAtShare map empty');

    // 2. noteRoomRefusal - region / line refusal
    const held1 = { live: 10, owners: 5, ceiling: 100, share: 10 };
    noteRoomRefusal(p, 'member', 'region', 'pubkey-member-1', 1000, held1);

    assert(p.member.regionAt === 1000, 'regionAt updated for member');
    assert(p.member.regionRefusals === 1, 'regionRefusals incremented to 1');
    assert(p.member.ownerAt === null && p.member.ownerRefusals === 0, 'ownerAt/ownerRefusals untouched on region refusal');
    assert(p.member.live === 10 && p.member.ceiling === 100, 'held stats assigned to member region');
    assert(p.keysAtShare.size === 0, 'keysAtShare not updated on region refusal for member');

    // 3. noteRoomRefusal - owner refusal for member
    const held2 = { live: 15, owners: 6, ceiling: 100, share: 10 };
    noteRoomRefusal(p, 'member', 'owner', 'pubkey-member-1', 2000, held2);

    assert(p.member.ownerAt === 2000, 'ownerAt updated for member');
    assert(p.member.ownerRefusals === 1, 'ownerRefusals incremented');
    assert(p.keysAtShare.size === 1, 'keysAtShare added member key on owner refusal');
    assert(p.keysAtShare.get('pubkey-member-1')?.at === 2000, 'key timestamp set correctly in keysAtShare');
    assert(p.keysAtShare.get('pubkey-member-1')?.cls === 'member', 'key class recorded in keysAtShare');

    // 4. noteRoomRefusal - owner refusal for newcomer
    noteRoomRefusal(p, 'newcomer', 'owner', 'pubkey-newcomer-1', 2500, held2);
    assert(p.newcomer.ownerRefusals === 1, 'newcomer ownerRefusals incremented');
    assert(p.keysAtShare.size === 2, 'keysAtShare size is 2');
    assert(p.keysAtShare.get('pubkey-newcomer-1')?.cls === 'newcomer', 'newcomer class recorded in keysAtShare');

    // 5. noteRoomRefusal - owner refusal for stranger
    noteRoomRefusal(p, 'stranger', 'owner', 'pubkey-stranger-1', 3000, held2);
    assert(p.stranger.ownerRefusals === 1, 'stranger ownerRefusals incremented');
    assert(p.keysAtShare.size === 2, 'keysAtShare does not record stranger owner refusals');

    // 6. Updating existing key in keysAtShare moves it to latest
    noteRoomRefusal(p, 'member', 'owner', 'pubkey-member-1', 3500, held2);
    assert(p.keysAtShare.size === 2, 'keysAtShare size remains 2 after updating existing key');
    assert(p.keysAtShare.get('pubkey-member-1')?.at === 3500, 'key timestamp updated in keysAtShare');

    // 7. keysAtShareSince
    assert(keysAtShareSince(p, 1000, 'member') === 1, 'keysAtShareSince counts 1 member key since 1000');
    assert(keysAtShareSince(p, 3000, 'member') === 1, 'keysAtShareSince counts 1 member key since 3000');
    assert(keysAtShareSince(p, 4000, 'member') === 0, 'keysAtShareSince counts 0 member keys since 4000');
    assert(keysAtShareSince(p, 2000, 'newcomer') === 1, 'keysAtShareSince counts 1 newcomer key since 2000');
    assert(keysAtShareSince(p, 3000, 'newcomer') === 0, 'keysAtShareSince counts 0 newcomer keys since 3000');

    // 8. keysAtShare eviction by max age (KEYS_AT_SHARE_KEPT_MS = 15 mins = 900,000 ms)
    const p2 = emptyNoncePressure();
    noteRoomRefusal(p2, 'member', 'owner', 'old-key', 1000, held1);
    noteRoomRefusal(p2, 'member', 'owner', 'new-key', 1000 + 15 * 60_000 + 1, held1);
    assert(!p2.keysAtShare.has('old-key'), 'old-key evicted after exceeding 15 minutes window');
    assert(p2.keysAtShare.has('new-key'), 'new-key retained in keysAtShare');

    // 9. requestNoncePressure export
    assert(typeof requestNoncePressure === 'object', 'requestNoncePressure exported instance exists');
    assert(requestNoncePressure.member !== undefined, 'requestNoncePressure has member region');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    process.exit(0);
}

main();
