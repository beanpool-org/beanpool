/**
 * The pending keeper discovery route — proving what a keeper can discover about active recovery sessions.
 *
 * Requirements:
 * - Authenticated: rejects unauthenticated or non-member calls with 401.
 * - Isolated: keeper sees pending collections where they are an enrolled keeper; non-keepers see nothing.
 * - Minimal data: returns only collectionId, ownerPubkey, callsign, createdAt, expiresAt (no fragments, no key material).
 * - Honest liveness: cancelled, completed, expired, or stale-generation collections stop being reported.
 *
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-keeper-pending-route.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { createRecoveryCollectRoutes } from './routes/recovery-collect.js';
import { putShareGeneration, type KeeperShareInput } from './engine/recovery-shares.js';
import { openCollection, cancelCollection, releaseMemberFragment } from './engine/recovery-release.js';

initStateEngine();

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const router = createRecoveryCollectRoutes({
    checkAdminAuth: async () => false,
    rateLimit: () => true,
    clampLimit: (_v: unknown, d = 20) => d,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
});

function handlerFor(path: string) {
    const layer = (router as any).stack.find((l: any) => l.path === path && l.methods.includes('POST'));
    if (!layer) throw new Error(`POST ${path} is not mounted`);
    return layer.stack[layer.stack.length - 1];
}

async function call(path: string, actor: string | undefined, body: Record<string, unknown> = {}) {
    const ctx: any = { state: actor ? { actor } : {}, requestBody: body, status: 200, body: undefined };
    await handlerFor(path)(ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

let seq = 0;
function member(): { pubkey: string; callsign: string } {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const callsign = `kp${++seq}-${pubkey.slice(0, 6)}`;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pubkey, callsign);
    return { pubkey, callsign };
}

const ephemeral = (): string => crypto.randomBytes(32).toString('hex');

const frag = (i: number) => ({
    shareIndex: i,
    encryptedShare: Buffer.from(`ct-${i}`).toString('base64'),
    shareIv: Buffer.from(`iv-${i}`).toString('base64'),
    shareTag: Buffer.from(`tag-${i}`).toString('base64'),
});

const rewrap = (label: string) => ({
    payload: Buffer.from(`rw-${label}`).toString('base64'),
    payloadIv: Buffer.from(`rwiv-${label}`).toString('base64'),
    payloadTag: Buffer.from(`rwtag-${label}`).toString('base64'),
    ephemeralPubkey: Buffer.from(`rweph-${label}`).toString('base64'),
});

function split(owner: string, buddy: string, buddy2?: string): number {
    const shares: KeeperShareInput[] = [
        { holderType: 'hub', holderRef: 'node', ...frag(1) },
        { holderType: 'member', holderRef: buddy, ephemeralPubkey: 'ZXBo', ...frag(2) },
        { holderType: 'member', holderRef: buddy2 ?? 'buddy-2', ephemeralPubkey: 'ZXBoMg', ...frag(3) },
    ];
    return putShareGeneration(owner, shares);
}

async function main(): Promise<void> {
    console.log('\nPending Keeper Recovery Discovery Route Tests\n');

    // ── 1. Authentication requirement ──────────────────────────────────────────
    console.log('── 1. Authentication ─────────────────────────────────────');
    const unauth = await call('/api/recovery/approve-keeper/pending', undefined);
    assert(unauth.status === 401, 'unauthenticated call is rejected with 401');

    const unknownActor = await call('/api/recovery/approve-keeper/pending', ephemeral());
    assert(unknownActor.status === 401, 'non-member actor is rejected with 401');

    // ── 2. Keeper sees pending collection ──────────────────────────────────────
    console.log('\n── 2. Keeper Discovery & Isolation ──────────────────────');
    const owner = member();
    const buddy = member();
    const outsider = member();
    split(owner.pubkey, buddy.pubkey);

    const beforeOpen = await call('/api/recovery/approve-keeper/pending', buddy.pubkey);
    assert(beforeOpen.status === 200 && beforeOpen.body.pending.length === 0,
        'with no open recovery, keeper sees 0 pending collections');

    const device = ephemeral();
    const col = openCollection(owner.pubkey, device);

    const keeperRes = await call('/api/recovery/approve-keeper/pending', buddy.pubkey);
    assert(keeperRes.status === 200, 'keeper call succeeds with 200');
    assert(keeperRes.body.pending.length === 1, 'keeper sees exactly 1 pending collection');
    assert(keeperRes.body.pending[0].collectionId === col.id, 'collectionId matches session');
    assert(keeperRes.body.pending[0].ownerPubkey === owner.pubkey, 'ownerPubkey matches recovering account');
    assert(keeperRes.body.pending[0].callsign === owner.callsign, 'callsign matches recovering member');
    assert(keeperRes.body.pending[0].expiresAt === col.expiresAt, 'expiresAt matches session deadline');
    assert(keeperRes.body.pending[0].createdAt === col.createdAt, 'createdAt matches session start');

    // Minimum data invariant: no fragments, no key material
    assert(!('payload' in keeperRes.body.pending[0]), 'no fragment payload returned');
    assert(!('encryptedShare' in keeperRes.body.pending[0]), 'no encryptedShare returned');
    assert(!('ephemeralPubkey' in keeperRes.body.pending[0]), 'no ephemeralPubkey returned');
    assert(!('shareIv' in keeperRes.body.pending[0]), 'no shareIv returned');
    assert(!('shareTag' in keeperRes.body.pending[0]), 'no shareTag returned');

    // ── 3. Non-keeper sees nothing ─────────────────────────────────────────────
    console.log('\n── 3. Non-keeper Isolation ──────────────────────────────');
    const outsiderRes = await call('/api/recovery/approve-keeper/pending', outsider.pubkey);
    assert(outsiderRes.status === 200 && outsiderRes.body.pending.length === 0,
        'non-keeper sees nothing (0 pending)');

    const ownerRes = await call('/api/recovery/approve-keeper/pending', owner.pubkey);
    assert(ownerRes.status === 200 && ownerRes.body.pending.length === 0,
        'recovering owner does not see own recovery as keeper obligation');

    // ── 4. Cancelled collection stops being reported ───────────────────────────
    console.log('\n── 4. Cancellation Semantics ────────────────────────────');
    cancelCollection(col.id, owner.pubkey);
    const afterCancel = await call('/api/recovery/approve-keeper/pending', buddy.pubkey);
    assert(afterCancel.status === 200 && afterCancel.body.pending.length === 0,
        'cancelled collection stops being reported to keeper');

    // ── 5. Completed / Released collection stops being reported ────────────────
    console.log('\n── 5. Release / Completion Semantics ────────────────────');
    const col2 = openCollection(owner.pubkey, ephemeral());
    const seeCol2 = await call('/api/recovery/approve-keeper/pending', buddy.pubkey);
    assert(seeCol2.status === 200 && seeCol2.body.pending.length === 1,
        'keeper sees fresh active collection');

    // Keeper discharges obligation by releasing re-wrapped fragment
    releaseMemberFragment(col2.id, buddy.pubkey, rewrap('buddy'));
    const afterRelease = await call('/api/recovery/approve-keeper/pending', buddy.pubkey);
    assert(afterRelease.status === 200 && afterRelease.body.pending.length === 0,
        'released keeper obligation immediately stops being reported');

    // ── 6. Expired collection stops being reported ─────────────────────────────
    console.log('\n── 6. Expiry Semantics ──────────────────────────────────');
    const col3 = openCollection(owner.pubkey, ephemeral());
    db.prepare('UPDATE recovery_collections SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), col3.id);
    const afterExpire = await call('/api/recovery/approve-keeper/pending', buddy.pubkey);
    assert(afterExpire.status === 200 && afterExpire.body.pending.length === 0,
        'expired collection stops being reported');

    // ── 7. Stale generation (owner re-split) stops being reported ───────────────
    console.log('\n── 7. Stale Generation Semantics ────────────────────────');
    const col4 = openCollection(owner.pubkey, ephemeral());
    const seeCol4 = await call('/api/recovery/approve-keeper/pending', buddy.pubkey);
    assert(seeCol4.status === 200 && seeCol4.body.pending.length === 1,
        'keeper sees collection before re-split');

    // Owner re-splits, moving to a new generation with a new keeper
    const newBuddy = member();
    split(owner.pubkey, newBuddy.pubkey);
    const afterResplit = await call('/api/recovery/approve-keeper/pending', buddy.pubkey);
    assert(afterResplit.status === 200 && afterResplit.body.pending.length === 0,
        'stale generation (owner re-split) stops being reported to old keeper');

    // ── 8. Status = complete stops being reported ──────────────────────────────
    console.log('\n── 8. Status Complete Semantics ─────────────────────────');
    const col5 = openCollection(owner.pubkey, ephemeral());
    db.prepare("UPDATE recovery_collections SET status = 'complete' WHERE id = ?").run(col5.id);
    const afterCompleteStatus = await call('/api/recovery/approve-keeper/pending', newBuddy.pubkey);
    assert(afterCompleteStatus.status === 200 && afterCompleteStatus.body.pending.length === 0,
        'collection with status=complete stops being reported');

    // ── 9. Single Canonical Route Registration ────────────────────────────────
    console.log('\n── 9. Canonical Route Registration ──────────────────────');
    const aliasMounted = (router as any).stack.some((l: any) => l.path === '/api/recovery/collect/pending-keeper');
    assert(!aliasMounted, 'redundant alias route /api/recovery/collect/pending-keeper is not mounted (single canonical path)');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Pending keeper route tests PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
