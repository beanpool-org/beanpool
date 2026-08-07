/**
 * The recovery collection routes — who may drive a session, and what falls out of it.
 *
 * engine/recovery-release.ts already proves D6, D7 and the K1 refusal. What is new here is that a
 * device with NO identity can drive the flow at all, and the property that replaced the bearer
 * token the engine was drafted around:
 *
 *   THE SESSION IS OWNED BY A KEY, NOT BY ITS ID. Every request is checked against
 *   `ctx.state.actor` — the cryptographically verified signer — so a leaked collection id is an
 *   identifier rather than a credential. It can appear in a log or a screenshot without being a
 *   way in.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-collect.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { createRecoveryCollectRoutes } from './routes/recovery-collect.js';
import { putShareGeneration, type KeeperShareInput } from './engine/recovery-shares.js';
import { listReleases, HUB_DELAY_MS } from './engine/recovery-release.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';

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
    const callsign = `col${++seq}-${pubkey.slice(0, 6)}`;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pubkey, callsign);
    return { pubkey, callsign };
}

/** A device with no identity at all — just a freshly minted keypair, which anybody can make. */
const ephemeral = (): string => crypto.randomBytes(32).toString('hex');

const frag = (i: number) => ({
    shareIndex: i,
    encryptedShare: Buffer.from(`ct-${i}`).toString('base64'),
    shareIv: Buffer.from(`iv-${i}`).toString('base64'),
    shareTag: Buffer.from(`tag-${i}`).toString('base64'),
});
const deviceFrag = (i: number) => ({ shareIndex: i, encryptedShare: '', shareIv: '', shareTag: '' });

const rewrap = (label: string) => ({
    payload: Buffer.from(`rw-${label}`).toString('base64'),
    payloadIv: Buffer.from(`rwiv-${label}`).toString('base64'),
    payloadTag: Buffer.from(`rwtag-${label}`).toString('base64'),
    ephemeralPubkey: Buffer.from(`rweph-${label}`).toString('base64'),
});

const SSO_HASH_SALT = 'c2FsdA';
function split(owner: string, buddy: string, ssoHash?: string): number {
    const shares: KeeperShareInput[] = [
        { holderType: 'device', holderRef: 'self', ...deviceFrag(1) },
        { holderType: 'hub', holderRef: 'node', ...frag(2) },
        { holderType: 'member', holderRef: buddy, ephemeralPubkey: 'ZXBo', ...frag(3) },
    ];
    if (ssoHash) {
        shares.push({ holderType: 'sso', holderRef: 'google', ssoLookupHash: ssoHash,
                      ssoLookupSalt: SSO_HASH_SALT, ...frag(4) });
    }
    return putShareGeneration(owner, shares);
}

async function main(): Promise<void> {
    console.log('\nRecovery collection routes\n');
    _resetJwksCacheForTests(); _clearNoncesForTests();

    const owner = member();
    const buddy = member();
    split(owner.pubkey, buddy.pubkey);

    // ── opening ───────────────────────────────────────────────────────────────────────────────
    console.log('── opening a session ────────────────────────────────────');

    const device = ephemeral();
    const opened = await call('/api/recovery/collect', device, { callsign: owner.callsign });
    assert(opened.status === 200 && typeof opened.body.collectionId === 'string',
        'a device with NO identity can open a collection — it only has to sign');
    assert(opened.body.generation === 1 && opened.body.threshold === 3,
        '...pinned to the generation it is collecting');
    const cid = opened.body.collectionId as string;

    assert((await call('/api/recovery/collect', undefined, { callsign: owner.callsign })).status === 401,
        'but an UNSIGNED open is refused — there would be nobody to bind the session to');
    assert((await call('/api/recovery/collect', device, {})).status === 400,
        'and one without a callsign is refused');
    assert((await call('/api/recovery/collect', device, { callsign: 'nobody-here' })).status === 400,
        'an unknown callsign gets the same answer as a member with no split — no sharper an oracle');

    // ── THE PROPERTY: the id is not a credential ──────────────────────────────────────────────
    console.log('\n── the session belongs to a key ─────────────────────────');

    const thief = ephemeral();
    for (const path of ['/api/recovery/collect/status', '/api/recovery/collect/fragments',
                        '/api/recovery/collect/hub', '/api/recovery/collect/sso-nonce']) {
        const stolen = await call(path, thief, { collectionId: cid });
        assert(stolen.status === 404, `knowing the id is not enough for ${path.split('/').pop()}`);
    }
    assert((await call('/api/recovery/collect/status', undefined, { collectionId: cid })).status === 404,
        '...and neither is knowing it with no signature at all');
    assert((await call('/api/recovery/collect/status', device, { collectionId: 'made-up' })).status === 404,
        'a made-up id and somebody else\'s id are indistinguishable — no existence oracle');

    const mine = await call('/api/recovery/collect/status', device, { collectionId: cid });
    assert(mine.status === 200 && mine.body.collected === 0,
        '...while the device that opened it can read its own progress');

    // ── D6 through the route ──────────────────────────────────────────────────────────────────
    console.log('\n── a keeper approves ────────────────────────────────────');

    const outsider = member();
    assert((await call('/api/recovery/approve-keeper', outsider.pubkey,
        { collectionId: cid, ...rewrap('outsider') })).status === 400,
        'somebody who is not a keeper on this account cannot approve');
    assert((await call('/api/recovery/approve-keeper', undefined,
        { collectionId: cid, ...rewrap('x') })).status === 401,
        'and an unsigned approval is refused');
    assert((await call('/api/recovery/approve-keeper', owner.pubkey,
        { collectionId: cid, ...rewrap('self') })).status === 400,
        'and the account being recovered cannot approve its own recovery');
    assert(listReleases(cid).length === 0, 'none of which released anything');

    // What the keeper needs in order to approve at all.
    const context = await call('/api/recovery/approve-keeper/context', buddy.pubkey, { collectionId: cid });
    assert(context.status === 200 && context.body.callsign === owner.callsign,
        'a keeper can see WHOSE account is being recovered...');
    assert(context.body.fragment.encryptedShare === frag(3).encryptedShare,
        '...and gets their own wrapped fragment to unwrap');
    assert(context.body.recipientEphemeralPubkey === device,
        '...and the key to re-wrap it to, which is the device that opened the session');
    assert((await call('/api/recovery/approve-keeper/context', outsider.pubkey,
        { collectionId: cid })).status === 404,
        '...while a non-keeper is told nothing about the session at all');

    const approved = await call('/api/recovery/approve-keeper', buddy.pubkey,
        { collectionId: cid, ...rewrap('buddy') });
    assert(approved.status === 200 && approved.body.progress.collected === 1,
        'the keeper approves and their fragment releases instantly (D6)');

    // ── fragments come from releases, never from polling ──────────────────────────────────────
    console.log('\n── fragments ────────────────────────────────────────────');

    const status = await call('/api/recovery/collect/status', device, { collectionId: cid });
    assert(!JSON.stringify(status.body).includes(rewrap('buddy').payload),
        'polling status never returns the fragments themselves');

    const frags = await call('/api/recovery/collect/fragments', device, { collectionId: cid });
    assert(frags.status === 200 && frags.body.fragments.length === 1,
        'asking for the fragments returns what was actually released');
    assert(frags.body.fragments[0].payload === rewrap('buddy').payload,
        '...as the keeper re-wrapped it, not as the node stored it');
    assert(frags.body.enough === false, '...and one of three is not enough');

    // ── D7 through the route ──────────────────────────────────────────────────────────────────
    console.log('\n── the hub (D7) ─────────────────────────────────────────');

    const hubNow = await call('/api/recovery/collect/hub', device, { collectionId: cid });
    assert(hubNow.status === 200 && hubNow.body.collected === 2,
        'with a human already approved, the hub releases immediately');

    // A cold session: no human, so the hub waits.
    const coldDevice = ephemeral();
    const cold = await call('/api/recovery/collect', coldDevice, { callsign: owner.callsign });
    const coldId = cold.body.collectionId as string;
    const coldHub = await call('/api/recovery/collect/hub', coldDevice, { collectionId: coldId });
    assert(coldHub.status === 400 && /24h|human keeper/i.test(String(coldHub.body.error)),
        'with no human approval the hub refuses, and says how to unblock it');
    assert(listReleases(coldId).length === 0, '...having released nothing');
    assert(cold.body.progress.hubReason === 'delay', '...and the session reports it is on the delay path');

    db.prepare('UPDATE recovery_collections SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - HUB_DELAY_MS - 60_000).toISOString(), coldId);
    assert((await call('/api/recovery/collect/hub', coldDevice, { collectionId: coldId })).status === 200,
        '...and releases once the 24 hours are up, with no human involved');

    // ── K4 through the route ──────────────────────────────────────────────────────────────────
    console.log('\n── the sign-in keeper ───────────────────────────────────');

    const ssoOwner = member();
    const ssoBuddy = member();
    const { ssoLookupHash } = await import('./sso.js');
    const REAL_SUB = '110169484474386276334';
    split(ssoOwner.pubkey, ssoBuddy.pubkey, await ssoLookupHash('google', REAL_SUB, SSO_HASH_SALT));

    const ssoDevice = ephemeral();
    const ssoSession = await call('/api/recovery/collect', ssoDevice, { callsign: ssoOwner.callsign });
    const ssoId = ssoSession.body.collectionId as string;

    const nonceRes = await call('/api/recovery/collect/sso-nonce', ssoDevice, { collectionId: ssoId });
    assert(nonceRes.status === 200 && typeof nonceRes.body.nonce === 'string',
        'the recovering device gets a sign-in nonce bound to its OWN ephemeral key');
    assert((await call('/api/recovery/collect/sso-nonce', thief, { collectionId: ssoId })).status === 404,
        '...and nobody else can get one for that session');

    const badProvider = await call('/api/recovery/collect/sso', ssoDevice,
        { collectionId: ssoId, provider: 'facebook', idToken: 'x', nonce: nonceRes.body.nonce });
    assert(badProvider.status === 400, 'a paused provider is refused (D11)');
    const garbage = await call('/api/recovery/collect/sso', ssoDevice,
        { collectionId: ssoId, provider: 'google', idToken: 'not-a-token', nonce: nonceRes.body.nonce });
    assert(garbage.status === 400, 'and a token that does not verify releases nothing');
    assert(listReleases(ssoId).length === 0, '...with nothing released by either');

    // ── the owner can see and stop it ─────────────────────────────────────────────────────────
    console.log('\n── the owner\'s stop button ─────────────────────────────');

    const listed = await call('/api/recovery/collect/mine', owner.pubkey);
    assert(listed.status === 200 && listed.body.collections.some((c: any) => c.collectionId === cid),
        'the owner can see live recoveries against their account...');
    assert(!listed.body.collections.some((c: any) => c.collectionId === ssoId),
        "...and never anybody else's");
    assert((await call('/api/recovery/collect/mine', undefined)).status === 401,
        '...and an unsigned caller sees nothing');

    assert((await call('/api/recovery/collect/cancel', buddy.pubkey, { collectionId: cid })).status === 400,
        'a keeper cannot cancel somebody else\'s recovery');
    const cancelled = await call('/api/recovery/collect/cancel', owner.pubkey, { collectionId: cid });
    assert(cancelled.status === 200 && cancelled.body.cancelled === true,
        'but the account owner can — the one person who does not have the session id');

    assert((await call('/api/recovery/collect/hub', device, { collectionId: cid })).status === 400,
        '...and the cancelled session can release nothing more');
    const deadStatus = await call('/api/recovery/collect/status', device, { collectionId: cid });
    assert(deadStatus.body.live === false && deadStatus.body.reason === 'cancelled',
        '...and reports itself cancelled rather than silently stalling');
    assert(deadStatus.body.hubEligibleAt === null,
        '...with no hub countdown to wait on');

    // The fragments it already collected stay readable — the device may still be mid-rebuild, and
    // taking them back would not un-release them anyway.
    const afterCancel = await call('/api/recovery/collect/fragments', device, { collectionId: cid });
    assert(afterCancel.status === 200 && afterCancel.body.fragments.length === 2,
        'what was already released stays readable — cancelling stops the future, not the past');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Recovery collection route checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
