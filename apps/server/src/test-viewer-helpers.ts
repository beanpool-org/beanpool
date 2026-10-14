/**
 * Unit/integration tests for viewer helper functions in routes/viewer.ts:
 * - viewerTier
 * - seesGuestView
 * - membersOnlyHere
 * - memberReadsOnlyHere
 *
 * Verifies tier evaluation and route access guards across:
 *   Actors: Active member, Suspended member, Disabled member, Visitor, Stranger/Unsigned
 *   Node Profiles: Local node (guestListingsOnly=false) & Global node (guestListingsOnly=true)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-viewer-helpers.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import type { Context } from 'koa';
import { initStateEngine } from './state-engine.js';
import { db, initSchema } from './db/db.js';
import {
    viewerTier,
    seesGuestView,
    membersOnlyHere,
    memberReadsOnlyHere,
    VIEW_HEADER,
} from './routes/viewer.js';

let run = 0, passed = 0;
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

function randomPubkey(): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}

function mockContext(actor?: string): Context {
    return {
        state: { actor },
        status: 200,
        body: undefined as any,
    } as unknown as Context;
}

function setGuestListingsOnly(enabled: boolean): void {
    db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(
        'nodeProfile.guestListingsOnly',
        enabled ? 'true' : 'false',
    );
}

function seedMember(pk: string, callsign: string, status = 'active', isVisitor = 0): void {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_visitor)
                VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis', ?)`).run(
        pk,
        callsign,
        status,
        isVisitor,
    );
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

function main(): void {
    console.log('Running test-viewer-helpers...\n');

    initSchema();
    initStateEngine();

    const activeMemberPk = randomPubkey();
    const suspendedMemberPk = randomPubkey();
    const disabledMemberPk = randomPubkey();
    const visitorPk = randomPubkey();
    const strangerPk = randomPubkey();

    seedMember(activeMemberPk, 'ActiveAlice', 'active', 0);
    seedMember(suspendedMemberPk, 'SuspendedSam', 'suspended', 0);
    seedMember(disabledMemberPk, 'DisabledDan', 'disabled', 0);
    seedMember(visitorPk, 'VisitorVal', 'active', 1);

    assert(VIEW_HEADER === 'X-BeanPool-View', 'VIEW_HEADER constant is X-BeanPool-View');

    // =========================================================================
    // 1. LOCAL NODE (guestListingsOnly = false)
    // =========================================================================
    console.log('\n--- Testing on Local Node (guestListingsOnly = false) ---');
    setGuestListingsOnly(false);

    // 1a. viewerTier
    const ctxActive = mockContext(activeMemberPk);
    assert(viewerTier(ctxActive) === 'member', 'Local: Active member has viewerTier === "member"');

    const ctxSuspended = mockContext(suspendedMemberPk);
    assert(viewerTier(ctxSuspended) === 'guest', 'Local: Suspended member has viewerTier === "guest"');

    const ctxDisabled = mockContext(disabledMemberPk);
    assert(viewerTier(ctxDisabled) === 'guest', 'Local: Disabled member has viewerTier === "guest"');

    const ctxVisitor = mockContext(visitorPk);
    assert(viewerTier(ctxVisitor) === 'guest', 'Local: Visitor has viewerTier === "guest"');

    const ctxStranger = mockContext(strangerPk);
    assert(viewerTier(ctxStranger) === 'guest', 'Local: Stranger has viewerTier === "guest"');

    const ctxUnsigned = mockContext(undefined);
    assert(viewerTier(ctxUnsigned) === 'guest', 'Local: Unsigned caller has viewerTier === "guest"');

    // 1b. seesGuestView
    assert(!seesGuestView(ctxActive), 'Local: Active member seesGuestView === false');
    assert(!seesGuestView(ctxSuspended), 'Local: Suspended member seesGuestView === false');
    assert(!seesGuestView(ctxVisitor), 'Local: Visitor seesGuestView === false');
    assert(!seesGuestView(ctxStranger), 'Local: Stranger seesGuestView === false');
    assert(!seesGuestView(ctxUnsigned), 'Local: Unsigned caller seesGuestView === false');

    // 1c. membersOnlyHere (when guestListingsOnly = false, always allows through)
    const ctxMoActive = mockContext(activeMemberPk);
    assert(membersOnlyHere(ctxMoActive) === true && ctxMoActive.status === 200, 'Local: membersOnlyHere returns true for active member');

    const ctxMoStranger = mockContext(strangerPk);
    assert(membersOnlyHere(ctxMoStranger) === true && ctxMoStranger.status === 200, 'Local: membersOnlyHere returns true on local node even for stranger');

    // 1d. memberReadsOnlyHere (refuses anyone who does not read as a member on local nodes too)
    const ctxMroActive = mockContext(activeMemberPk);
    assert(memberReadsOnlyHere(ctxMroActive) === true && ctxMroActive.status === 200, 'Local: memberReadsOnlyHere returns true for active member');

    const ctxMroSuspended = mockContext(suspendedMemberPk);
    assert(
        memberReadsOnlyHere(ctxMroSuspended) === false &&
        ctxMroSuspended.status === 403 &&
        (ctxMroSuspended.body as any)?.code === 'members_only',
        'Local: memberReadsOnlyHere returns 403 members_only for suspended member',
    );

    const ctxMroDisabled = mockContext(disabledMemberPk);
    assert(
        memberReadsOnlyHere(ctxMroDisabled) === false &&
        ctxMroDisabled.status === 403 &&
        (ctxMroDisabled.body as any)?.code === 'members_only',
        'Local: memberReadsOnlyHere returns 403 members_only for disabled member',
    );

    const ctxMroVisitor = mockContext(visitorPk);
    assert(
        memberReadsOnlyHere(ctxMroVisitor) === false &&
        ctxMroVisitor.status === 403 &&
        (ctxMroVisitor.body as any)?.code === 'members_only',
        'Local: memberReadsOnlyHere returns 403 members_only for visitor',
    );

    const ctxMroStranger = mockContext(strangerPk);
    assert(
        memberReadsOnlyHere(ctxMroStranger) === false &&
        ctxMroStranger.status === 403 &&
        (ctxMroStranger.body as any)?.code === 'members_only',
        'Local: memberReadsOnlyHere returns 403 members_only for stranger',
    );

    const ctxMroUnsigned = mockContext(undefined);
    assert(
        memberReadsOnlyHere(ctxMroUnsigned) === false &&
        ctxMroUnsigned.status === 403 &&
        (ctxMroUnsigned.body as any)?.code === 'members_only',
        'Local: memberReadsOnlyHere returns 403 members_only for unsigned caller',
    );

    // =========================================================================
    // 2. GLOBAL NODE (guestListingsOnly = true)
    // =========================================================================
    console.log('\n--- Testing on Global Node (guestListingsOnly = true) ---');
    setGuestListingsOnly(true);

    // 2a. viewerTier (unchanged by guestListingsOnly switch)
    assert(viewerTier(mockContext(activeMemberPk)) === 'member', 'Global: Active member is "member"');
    assert(viewerTier(mockContext(suspendedMemberPk)) === 'guest', 'Global: Suspended member is "guest"');
    assert(viewerTier(mockContext(visitorPk)) === 'guest', 'Global: Visitor is "guest"');
    assert(viewerTier(mockContext(strangerPk)) === 'guest', 'Global: Stranger is "guest"');

    // 2b. seesGuestView
    assert(!seesGuestView(mockContext(activeMemberPk)), 'Global: Active member seesGuestView === false');
    assert(seesGuestView(mockContext(suspendedMemberPk)), 'Global: Suspended member seesGuestView === true');
    assert(seesGuestView(mockContext(disabledMemberPk)), 'Global: Disabled member seesGuestView === true');
    assert(seesGuestView(mockContext(visitorPk)), 'Global: Visitor seesGuestView === true');
    assert(seesGuestView(mockContext(strangerPk)), 'Global: Stranger seesGuestView === true');
    assert(seesGuestView(mockContext(undefined)), 'Global: Unsigned caller seesGuestView === true');

    // 2c. membersOnlyHere (on global node, requires isNodeMember - visitor row is NOT a node member)
    const ctxGmoActive = mockContext(activeMemberPk);
    assert(membersOnlyHere(ctxGmoActive) === true, 'Global: membersOnlyHere returns true for active member');

    const ctxGmoSuspended = mockContext(suspendedMemberPk);
    assert(membersOnlyHere(ctxGmoSuspended) === true, 'Global: membersOnlyHere returns true for suspended member (isNodeMember is true)');

    const ctxGmoVisitor = mockContext(visitorPk);
    assert(
        membersOnlyHere(ctxGmoVisitor) === false &&
        ctxGmoVisitor.status === 403 &&
        (ctxGmoVisitor.body as any)?.code === 'members_only',
        'Global: membersOnlyHere returns 403 members_only for visitor (a visitor row is not a node member)',
    );

    const ctxGmoStranger = mockContext(strangerPk);
    assert(
        membersOnlyHere(ctxGmoStranger) === false &&
        ctxGmoStranger.status === 403 &&
        (ctxGmoStranger.body as any)?.code === 'members_only',
        'Global: membersOnlyHere returns 403 members_only for stranger',
    );

    const ctxGmoUnsigned = mockContext(undefined);
    assert(
        membersOnlyHere(ctxGmoUnsigned) === false &&
        ctxGmoUnsigned.status === 403 &&
        (ctxGmoUnsigned.body as any)?.code === 'members_only',
        'Global: membersOnlyHere returns 403 members_only for unsigned caller',
    );

    // 2d. memberReadsOnlyHere (same as local: only active/reading members pass)
    assert(memberReadsOnlyHere(mockContext(activeMemberPk)) === true, 'Global: memberReadsOnlyHere returns true for active member');

    const ctxGmroSuspended = mockContext(suspendedMemberPk);
    assert(
        memberReadsOnlyHere(ctxGmroSuspended) === false &&
        ctxGmroSuspended.status === 403 &&
        (ctxGmroSuspended.body as any)?.code === 'members_only',
        'Global: memberReadsOnlyHere returns 403 members_only for suspended member',
    );

    const ctxGmroStranger = mockContext(strangerPk);
    assert(
        memberReadsOnlyHere(ctxGmroStranger) === false &&
        ctxGmroStranger.status === 403 &&
        (ctxGmroStranger.body as any)?.code === 'members_only',
        'Global: memberReadsOnlyHere returns 403 members_only for stranger',
    );

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ test-viewer-helpers PASSED.');
    process.exit(0);
}

try {
    main();
} catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
}
