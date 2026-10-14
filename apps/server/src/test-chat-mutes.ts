/**
 * Unit/integration tests for chat mutes engine module (apps/server/src/engine/chat-mutes.ts).
 *
 * Asserts setting, clearing, retrieving, expiration handling, and recipient filtering for chat mutes.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-chat-mutes.ts
 */

import { initStateEngine } from './state-engine.js';
import {
    isChatMuteDuration,
    setChatMute,
    clearChatMute,
    getChatMute,
    getChatMutesFor,
    unmutedRecipients,
    type ChatMuteDuration,
} from './engine/chat-mutes.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

function main() {
    console.log('Running chat-mutes tests...\n');

    initStateEngine();

    const conv1 = 'conv_1111111111111111111111111111111111111111111111111111111111111111';
    const conv2 = 'conv_2222222222222222222222222222222222222222222222222222222222222222';
    const member1 = 'pubkey_11111111111111111111111111111111111111111111111111111111111111';
    const member2 = 'pubkey_22222222222222222222222222222222222222222222222222222222222222';
    const member3 = 'pubkey_33333333333333333333333333333333333333333333333333333333333333';

    const baseTime = 1700000000000; // Arbitrary fixed timestamp

    // 1. Test isChatMuteDuration predicate
    assert(isChatMuteDuration('8h'), '8h is valid chat mute duration');
    assert(isChatMuteDuration('1w'), '1w is valid chat mute duration');
    assert(isChatMuteDuration('always'), 'always is valid chat mute duration');
    assert(!isChatMuteDuration('1d'), '1d is not a valid chat mute duration');
    assert(!isChatMuteDuration(''), 'empty string is not a valid chat mute duration');
    assert(!isChatMuteDuration(null), 'null is not a valid chat mute duration');
    assert(!isChatMuteDuration(123), 'number is not a valid chat mute duration');

    // 2. Test getChatMute when no mute exists
    assert(getChatMute(conv1, member1, baseTime) === null, 'getChatMute returns null when no mute set');

    // 3. Test setChatMute throwing on invalid duration
    let threw = false;
    try {
        setChatMute(conv1, member1, 'invalid' as ChatMuteDuration, baseTime);
    } catch {
        threw = true;
    }
    assert(threw, 'setChatMute throws Error on invalid duration');

    // 4. Test setting 'always' mute
    const alwaysMute = setChatMute(conv1, member1, 'always', baseTime);
    assert(alwaysMute.conversationId === conv1, 'setChatMute returns matching conversationId');
    assert(alwaysMute.mutedUntil === null, 'always mute has null mutedUntil');
    assert(alwaysMute.always === true, 'always mute has always=true');

    const retrievedAlways = getChatMute(conv1, member1, baseTime);
    assert(retrievedAlways !== null && retrievedAlways.always === true && retrievedAlways.mutedUntil === null, 'getChatMute retrieves always mute');

    // 5. Test setting timed mutes ('8h', '1w')
    const mute8h = setChatMute(conv1, member2, '8h', baseTime);
    assert(mute8h.always === false, '8h mute has always=false');
    assert(mute8h.mutedUntil === new Date(baseTime + 8 * 60 * 60 * 1000).toISOString(), '8h mute sets expected mutedUntil ISO date');

    const mute1w = setChatMute(conv2, member1, '1w', baseTime);
    assert(mute1w.mutedUntil === new Date(baseTime + 7 * 24 * 60 * 60 * 1000).toISOString(), '1w mute sets expected mutedUntil ISO date');

    // 6. Test timed mute expiration
    const active8h = getChatMute(conv1, member2, baseTime + 1000);
    assert(active8h !== null, 'getChatMute returns timed mute before expiration');

    const expired8h = getChatMute(conv1, member2, baseTime + 8 * 60 * 60 * 1000 + 1);
    assert(expired8h === null, 'getChatMute returns null after timed mute expiration');

    // 7. Test ON CONFLICT update in setChatMute
    setChatMute(conv1, member2, 'always', baseTime);
    const updatedMute = getChatMute(conv1, member2, baseTime);
    assert(updatedMute !== null && updatedMute.always === true, 'setChatMute updates existing mute on conflict');

    // 8. Test getChatMutesFor
    const mutesForMember1 = getChatMutesFor(member1, baseTime);
    assert(mutesForMember1.size === 2, 'getChatMutesFor returns all active mutes for member');
    assert(mutesForMember1.has(conv1) && mutesForMember1.get(conv1)?.always === true, 'mutesForMember1 contains conv1');
    assert(mutesForMember1.has(conv2) && mutesForMember1.get(conv2)?.always === false, 'mutesForMember1 contains conv2');

    // getChatMutesFor with expired mute
    const mutesForMember1Later = getChatMutesFor(member1, baseTime + 8 * 24 * 60 * 60 * 1000);
    assert(mutesForMember1Later.size === 1 && mutesForMember1Later.has(conv1), 'getChatMutesFor filters out expired 1w mute');

    // 9. Test clearChatMute
    assert(clearChatMute(conv1, member1) === true, 'clearChatMute returns true when row is deleted');
    assert(getChatMute(conv1, member1, baseTime) === null, 'getChatMute returns null after clearing mute');
    assert(clearChatMute(conv1, member1) === false, 'clearChatMute returns false when no row exists');

    // 10. Test unmutedRecipients
    assert(unmutedRecipients(conv1, []).length === 0, 'unmutedRecipients returns empty array for empty recipients');

    // Set conv1 mutes: member2 is muted always, member3 has timed mute 8h
    setChatMute(conv1, member2, 'always', baseTime);
    setChatMute(conv1, member3, '8h', baseTime);

    const recipients = [member1, member2, member3];
    const unmutedAtBase = unmutedRecipients(conv1, recipients, [], baseTime);
    assert(unmutedAtBase.length === 1 && unmutedAtBase[0] === member1, 'unmutedRecipients excludes active muted members');

    // Mention override
    const unmutedWithMention = unmutedRecipients(conv1, recipients, [member2], baseTime);
    assert(unmutedWithMention.includes(member1) && unmutedWithMention.includes(member2) && !unmutedWithMention.includes(member3), 'unmutedRecipients includes muted member if mentioned');

    // After 8h expiration
    const unmutedAfter8h = unmutedRecipients(conv1, recipients, [], baseTime + 8 * 60 * 60 * 1000 + 100);
    assert(unmutedAfter8h.includes(member1) && unmutedAfter8h.includes(member3) && !unmutedAfter8h.includes(member2), 'unmutedRecipients includes member whose mute expired');

    console.log(`\n${passed}/${run} chat-mutes tests passed.`);
    process.exit(process.exitCode ?? 0);
}

main();
