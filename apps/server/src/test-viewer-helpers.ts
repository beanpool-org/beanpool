import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { viewerTier, seesGuestView, membersOnlyHere, memberReadsOnlyHere } from './routes/viewer.js';
import type { Context } from 'koa';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}

function mockCtx(actor?: string): Context {
    return {
        state: { actor },
        status: 200,
        body: undefined,
    } as unknown as Context;
}

async function main() {
    console.log('Running viewer helpers test suite...\n');

    initStateEngine();

    // Create test accounts:
    // 1. Member
    const memberPk = '11'.repeat(32);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(memberPk, 'MemberAlice');

    // 2. Visitor
    const visitorPk = '22'.repeat(32);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, is_visitor) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).run(visitorPk, 'VisitorBob');

    // 3. Suspended member
    const suspendedPk = '33'.repeat(32);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'suspended')`).run(suspendedPk, 'SuspendedCharlie');

    // 4. Non-member key
    const strangerPk = '44'.repeat(32);

    // ── 1. viewerTier ─────────────────────────────────────────────────────────────
    assert(viewerTier(mockCtx(memberPk)) === 'member', 'memberPk gives viewerTier member');
    assert(viewerTier(mockCtx(visitorPk)) === 'guest', 'visitorPk gives viewerTier guest');
    assert(viewerTier(mockCtx(suspendedPk)) === 'guest', 'suspendedPk gives viewerTier guest');
    assert(viewerTier(mockCtx(strangerPk)) === 'guest', 'strangerPk gives viewerTier guest');
    assert(viewerTier(mockCtx(undefined)) === 'guest', 'undefined actor gives viewerTier guest');

    // ── 2. seesGuestView (default node profile vs guestListingsOnly profile) ─────
    process.env.NODE_PROFILE = 'local';
    assert(seesGuestView(mockCtx(memberPk)) === false, 'seesGuestView is false for member when NODE_PROFILE=local');
    assert(seesGuestView(mockCtx(visitorPk)) === false, 'seesGuestView is false for visitor when NODE_PROFILE=local');
    assert(seesGuestView(mockCtx(strangerPk)) === false, 'seesGuestView is false for stranger when NODE_PROFILE=local');

    process.env.NODE_PROFILE = 'global';
    assert(seesGuestView(mockCtx(memberPk)) === false, 'seesGuestView is false for member when NODE_PROFILE=global');
    assert(seesGuestView(mockCtx(visitorPk)) === true, 'seesGuestView is true for visitor when NODE_PROFILE=global');
    assert(seesGuestView(mockCtx(suspendedPk)) === true, 'seesGuestView is true for suspended member when NODE_PROFILE=global');
    assert(seesGuestView(mockCtx(strangerPk)) === true, 'seesGuestView is true for stranger when NODE_PROFILE=global');
    assert(seesGuestView(mockCtx(undefined)) === true, 'seesGuestView is true for undefined when NODE_PROFILE=global');

    // ── 3. membersOnlyHere ────────────────────────────────────────────────────────
    process.env.NODE_PROFILE = 'local';
    const ctx1 = mockCtx(strangerPk);
    assert(membersOnlyHere(ctx1) === true, 'membersOnlyHere returns true when NODE_PROFILE=local even for stranger');

    process.env.NODE_PROFILE = 'global';

    // Member allowed
    const ctxMember = mockCtx(memberPk);
    assert(membersOnlyHere(ctxMember) === true, 'membersOnlyHere returns true for member');

    // Stranger refused 403
    const ctxStranger = mockCtx(strangerPk);
    const resStranger = membersOnlyHere(ctxStranger);
    assert(resStranger === false, 'membersOnlyHere returns false for stranger');
    assert(ctxStranger.status === 403, 'membersOnlyHere sets status 403');
    assert((ctxStranger.body as any)?.code === 'members_only', 'membersOnlyHere sets code members_only');

    // Visitor refused 403
    const ctxVisitor = mockCtx(visitorPk);
    const resVisitor = membersOnlyHere(ctxVisitor);
    assert(resVisitor === false, 'membersOnlyHere returns false for visitor');
    assert(ctxVisitor.status === 403, 'membersOnlyHere sets status 403 for visitor');

    // Suspended member allowed (as acts go through suspension checks separately)
    const ctxSuspended = mockCtx(suspendedPk);
    assert(membersOnlyHere(ctxSuspended) === true, 'membersOnlyHere returns true for suspended member');

    // ── 4. memberReadsOnlyHere ────────────────────────────────────────────────────
    process.env.NODE_PROFILE = 'local';
    const ctxRead1 = mockCtx(strangerPk);
    assert(memberReadsOnlyHere(ctxRead1) === true, 'memberReadsOnlyHere returns true when NODE_PROFILE=local');

    process.env.NODE_PROFILE = 'global';

    // Member allowed
    const ctxReadMember = mockCtx(memberPk);
    assert(memberReadsOnlyHere(ctxReadMember) === true, 'memberReadsOnlyHere returns true for member');

    // Stranger refused
    const ctxReadStranger = mockCtx(strangerPk);
    assert(memberReadsOnlyHere(ctxReadStranger) === false, 'memberReadsOnlyHere returns false for stranger');
    assert(ctxReadStranger.status === 403, 'memberReadsOnlyHere sets status 403');
    assert((ctxReadStranger.body as any)?.code === 'members_only', 'memberReadsOnlyHere sets code members_only');

    // Visitor refused
    const ctxReadVisitor = mockCtx(visitorPk);
    assert(memberReadsOnlyHere(ctxReadVisitor) === false, 'memberReadsOnlyHere returns false for visitor');

    // Suspended member refused for member reads
    const ctxReadSuspended = mockCtx(suspendedPk);
    assert(memberReadsOnlyHere(ctxReadSuspended) === false, 'memberReadsOnlyHere returns false for suspended member');

    // Reset profile switch
    delete process.env.NODE_PROFILE;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Viewer helpers checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
