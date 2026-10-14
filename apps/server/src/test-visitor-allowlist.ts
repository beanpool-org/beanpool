import {
    initStateEngine,
    registerVisitor,
    seedGenesisMember,
    createConversation,
    sendMessage,
    createPost,
} from './state-engine.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import {
    visitorWriteRefused,
    visitorsOwnRead,
    routedPath,
    setVisitorGateForTests,
} from './visitor-allowlist.js';
import { lockedDm } from './dm-test-payload.js';

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

async function main() {
    console.log('Running visitor allowlist tests...\n');

    initStateEngine();

    const visitorKey = '1111111111111111111111111111111111111111111111111111111111111111';
    const memberKey1 = '2222222222222222222222222222222222222222222222222222222222222222';
    const memberKey2 = '3333333333333333333333333333333333333333333333333333333333333333';

    registerVisitor(visitorKey);
    seedGenesisMember(memberKey1, 'Member One');
    seedGenesisMember(memberKey2, 'Member Two');

    setMemberPhoto(db, visitorKey, 'https://example.com/v.jpg');
    setMemberPhoto(db, memberKey1, 'https://example.com/m1.jpg');
    setMemberPhoto(db, memberKey2, 'https://example.com/m2.jpg');

    // --- 1. routedPath ---
    assert(routedPath('/api/messages/') === '/api/messages', 'routedPath strips trailing slash');
    assert(routedPath('/api/messages') === '/api/messages', 'routedPath leaves un-slashed path intact');
    assert(routedPath('/') === '/', 'routedPath leaves root slash intact');

    // --- 2. Non-visitor & Gate bypass ---
    assert(!visitorWriteRefused('POST', '/api/marketplace/posts', {}, memberKey1), 'Member write is not refused');

    setVisitorGateForTests(false);
    assert(!visitorWriteRefused('POST', '/api/marketplace/posts', {}, visitorKey), 'Visitor write is not refused when gate disabled');
    setVisitorGateForTests(true);

    // --- 3. Visitor Writes ---
    // Unlisted route
    assert(visitorWriteRefused('POST', '/api/marketplace/posts', {}, visitorKey), 'Unlisted POST route refused for visitor');
    assert(visitorWriteRefused('POST', '/api/members/holiday', {}, visitorKey), 'Holiday mode refused for visitor');

    // Push tokens & purge & transfer
    assert(!visitorWriteRefused('POST', '/api/push-tokens', {}, visitorKey), 'POST /api/push-tokens allowed for visitor');
    assert(!visitorWriteRefused('DELETE', '/api/push-tokens', {}, visitorKey), 'DELETE /api/push-tokens allowed for visitor');
    assert(!visitorWriteRefused('POST', '/api/member/purge', {}, visitorKey), 'POST /api/member/purge allowed for visitor');
    assert(!visitorWriteRefused('POST', '/api/ledger/transfer', {}, visitorKey), 'POST /api/ledger/transfer allowed for visitor');

    // Preferences
    assert(!visitorWriteRefused('POST', '/api/members/preferences', { preferences: { notify_chat: 'true' } }, visitorKey), 'Push preferences allowed for visitor');
    assert(visitorWriteRefused('POST', '/api/members/preferences', { preferences: { holiday_mode: 'true' } }, visitorKey), 'Preferences naming non-push settings refused for visitor');

    // DM Conversation opening / sending / editing / deleting / reactions
    const conv = createConversation('dm', [visitorKey, memberKey1], memberKey1);
    assert(conv !== null, 'DM conversation created');
    const convId = conv!.id;

    assert(!visitorWriteRefused('POST', '/api/messages/conversation', { participants: [visitorKey, memberKey1] }, visitorKey), 'Open conversation with visitor allowed');
    assert(visitorWriteRefused('POST', '/api/messages/conversation', { participants: [memberKey1, memberKey2] }, visitorKey), 'Open conversation without visitor refused');

    assert(!visitorWriteRefused('POST', '/api/messages/send', { conversationId: convId }, visitorKey), 'Send message in DM visitor is in allowed');
    assert(visitorWriteRefused('POST', '/api/messages/send', { conversationId: 'invalid-conv-id' }, visitorKey), 'Send message in conversation visitor not in refused');

    const dmPayload = lockedDm();
    const msg = sendMessage(convId, visitorKey, dmPayload.ciphertext, dmPayload.nonce);
    assert(msg !== null, 'Message sent by visitor in DM');
    const msgId = msg!.id;

    assert(!visitorWriteRefused('POST', '/api/messages/edit', { messageId: msgId }, visitorKey), 'Edit own line allowed');
    assert(visitorWriteRefused('POST', '/api/messages/edit', { messageId: 'nonexistent-msg' }, visitorKey), 'Edit other line refused');

    assert(!visitorWriteRefused('POST', '/api/messages/delete', { messageId: msgId }, visitorKey), 'Delete own line allowed');
    assert(!visitorWriteRefused('POST', '/api/messages/react', { messageId: msgId }, visitorKey), 'React to own line allowed');

    assert(!visitorWriteRefused('POST', '/api/messages/mark-read', { conversationId: convId }, visitorKey), 'Mark read DM visitor is in allowed');
    assert(!visitorWriteRefused('POST', '/api/messages/mute', { conversationId: convId }, visitorKey), 'Mute DM visitor is in allowed');

    // Marketplace post removal
    const memberPost = createPost('offer', 'goods', 'Member Item', 'Test', 0, 'fixed', memberKey1);
    const memberPostId = memberPost?.id;

    const visitorPostId = 'visitor-post-1';
    db.prepare("INSERT INTO posts (id, author_pubkey, title, description, type, category, status, active) VALUES (?, ?, 'Visitor Item', 'Desc', 'offer', 'goods', 'active', 1)").run(visitorPostId, visitorKey);

    assert(visitorWriteRefused('POST', '/api/marketplace/posts/remove', { id: memberPostId }, visitorKey), 'Remove other listing refused');
    assert(!visitorWriteRefused('POST', '/api/marketplace/posts/remove', { id: visitorPostId }, visitorKey), 'Remove own listing allowed');

    // --- 4. Visitors Own Read ---
    assert(visitorsOwnRead(`/api/messages/conversations/${visitorKey}`, {}, visitorKey), 'Read own conversation list allowed');
    assert(!visitorsOwnRead(`/api/messages/conversations/${memberKey1}`, {}, visitorKey), 'Read someone else conversation list refused');

    assert(visitorsOwnRead(`/api/messages/${convId}`, {}, visitorKey), 'Read DM visitor is in allowed');
    assert(!visitorsOwnRead('/api/messages/unknown-conv-id', {}, visitorKey), 'Read unknown DM refused');

    assert(visitorsOwnRead(`/api/ledger/balance/${visitorKey}`, {}, visitorKey), 'Read own balance allowed');
    assert(!visitorsOwnRead(`/api/ledger/balance/${memberKey1}`, {}, visitorKey), 'Read someone else balance refused');

    assert(visitorsOwnRead('/api/ledger/transactions', { publicKey: visitorKey }, visitorKey), 'Read own transactions allowed');
    assert(!visitorsOwnRead('/api/ledger/transactions', { publicKey: memberKey1 }, visitorKey), 'Read someone else transactions refused');

    assert(visitorsOwnRead('/api/marketplace/posts', { author: visitorKey }, visitorKey), 'Read own marketplace posts allowed');
    assert(!visitorsOwnRead('/api/marketplace/posts', { author: memberKey1 }, visitorKey), 'Read someone else marketplace posts refused');

    assert(!visitorsOwnRead('/api/members', {}, visitorKey), 'Unlisted gated read refused for visitor');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ Visitor allowlist tests PASSED.');
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error('❌ Test failed:', e);
        process.exit(1);
    });
