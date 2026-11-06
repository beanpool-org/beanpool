/**
 * Integration test for Federation Origin utilities (`federation-origin.ts`).
 *
 * Verifies:
 *   1. `peerHomeUrl`:
 *      - Returns null for unknown / unconfigured peer IDs.
 *      - Returns null when connector record has no publicUrl or whitespace-only URL.
 *      - Returns trimmed publicUrl when connector record has valid publicUrl.
 *   2. `isLocalMemberKey`:
 *      - Returns false for non-existent public keys.
 *      - Returns true for local members (is_visitor = 0 and home_node_url IS NULL).
 *      - Returns false for visitors without home_node_url (is_visitor = 1 and home_node_url IS NULL).
 *      - Returns false for members with remote home_node_url (home_node_url IS NOT NULL).
 *      - Returns false for visitors with remote home_node_url.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-federation-origin.ts
 */

import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { addConnector } from './connector-manager.js';
import { peerHomeUrl, isLocalMemberKey } from './federation-origin.js';

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
    console.log('Running federation-origin test suite...\n');

    initStateEngine();

    // 1. peerHomeUrl checks
    const unknownPeerId = '12D3KooWUnknownPeerId111111111111111111111111111111';
    assert(peerHomeUrl(unknownPeerId) === null, 'peerHomeUrl returns null for unknown peer id');

    const peerIdNoUrl = '12D3KooWNoUrlPeerId222222222222222222222222222222222';
    addConnector(`/p2p/${peerIdNoUrl}`, 'peer', 'NoUrlPeer', undefined, true);
    assert(peerHomeUrl(peerIdNoUrl) === null, 'peerHomeUrl returns null when connector has undefined publicUrl');

    const peerIdWhitespaceUrl = '12D3KooWWhitespaceUrl333333333333333333333333333333';
    addConnector(`/p2p/${peerIdWhitespaceUrl}`, 'peer', 'WhitespacePeer', '   ', true);
    assert(peerHomeUrl(peerIdWhitespaceUrl) === null, 'peerHomeUrl returns null when connector publicUrl is whitespace-only');

    const peerIdValidUrl = '12D3KooWValidUrlPeer44444444444444444444444444444444';
    addConnector(`/p2p/${peerIdValidUrl}`, 'peer', 'ValidUrlPeer', '  https://remote.peer.org/node  ', true);
    assert(peerHomeUrl(peerIdValidUrl) === 'https://remote.peer.org/node', 'peerHomeUrl returns trimmed URL when valid');

    // 2. isLocalMemberKey checks
    const missingKey = 'key-not-in-db-0000000000000000000000000000000000000000000';
    assert(isLocalMemberKey(missingKey) === false, 'isLocalMemberKey returns false for non-existent public key');

    const localMemberKey = 'local-member-key-1111111111111111111111111111111111111';
    db.prepare('INSERT INTO members (public_key, callsign, is_visitor, home_node_url) VALUES (?, ?, 0, NULL)').run(localMemberKey, 'alice');
    assert(isLocalMemberKey(localMemberKey) === true, 'isLocalMemberKey returns true for local member (is_visitor=0, home=NULL)');

    const localVisitorKey = 'local-visitor-key-22222222222222222222222222222222222';
    db.prepare('INSERT INTO members (public_key, callsign, is_visitor, home_node_url) VALUES (?, ?, 1, NULL)').run(localVisitorKey, 'bob');
    assert(isLocalMemberKey(localVisitorKey) === false, 'isLocalMemberKey returns false for visitor with no home node (is_visitor=1, home=NULL)');

    const remoteMemberKey = 'remote-member-key-3333333333333333333333333333333333';
    db.prepare('INSERT INTO members (public_key, callsign, is_visitor, home_node_url) VALUES (?, ?, 0, ?)').run(remoteMemberKey, 'carol', 'https://other.node.org');
    assert(isLocalMemberKey(remoteMemberKey) === false, 'isLocalMemberKey returns false for member with remote home_node_url (is_visitor=0, home set)');

    const remoteVisitorKey = 'remote-visitor-key-444444444444444444444444444444444';
    db.prepare('INSERT INTO members (public_key, callsign, is_visitor, home_node_url) VALUES (?, ?, 1, ?)').run(remoteVisitorKey, 'dave', 'https://another.node.org');
    assert(isLocalMemberKey(remoteVisitorKey) === false, 'isLocalMemberKey returns false for visitor with remote home_node_url');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
}

main().then(() => process.exit(0)).catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
