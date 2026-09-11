/**
 * The keyholder fragment routes — what must be impossible to ask for over HTTP.
 *
 * Covers the surviving SSO and Hub fragment routes:
 *   - POST /api/recovery/sso-nonce
 *   - POST /api/recovery/shares/hub-fragment
 *   - POST /api/recovery/shares/sso
 *   - POST /api/recovery/shares/status
 *   - DELETE /api/recovery/shares/sso/:provider
 *   - DELETE /api/recovery/shares
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-keeper-routes.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { createKeeperRoutes } from './routes/keepers.js';
import { getCurrentShares, countCurrentShares, findShareBySsoLookup } from './engine/recovery-shares.js';
import { _resetJwksCacheForTests, _clearNoncesForTests, ssoLookupHash } from './sso.js';

initStateEngine();

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ─── the router under test ────────────────────────────────────────────────────────────────────

const router = createKeeperRoutes({
    checkAdminAuth: async () => false,
    rateLimit: () => true,
    clampLimit: (_v: unknown, def = 20) => def,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
});

function handlerFor(method: string, path: string) {
    const layer = (router as any).stack.find((l: any) =>
        l.path === path && l.methods.includes(method.toUpperCase()));
    if (!layer) throw new Error(`${method} ${path} is not mounted — this test is looking at the wrong path`);
    return layer.stack[layer.stack.length - 1];
}

/** Invoke a mounted handler the way Koa would. `actor` undefined = an unsigned request. */
async function call(
    method: string, path: string,
    opts: { actor?: string; body?: Record<string, unknown>; params?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
    const ctx: any = {
        state: opts.actor ? { actor: opts.actor } : {},
        requestBody: opts.body ?? {},
        params: opts.params ?? {},
        status: 200,
        body: undefined,
    };
    await handlerFor(method, path)(ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

// ─── fixtures ─────────────────────────────────────────────────────────────────────────────────

let callsignSeq = 0;
function member(status = 'active'): { pubkey: string; callsign: string } {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const callsign = `kr${++callsignSeq}-${pubkey.slice(0, 6)}`;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pubkey, callsign, status);
    return { pubkey, callsign };
}

const frag = (i: number) => ({
    shareIndex: i,
    encryptedShare: Buffer.from(`share-${i}`).toString('base64'),
    shareIv: Buffer.from(`iv-${i}`).toString('base64'),
    shareTag: Buffer.from(`tag-${i}`).toString('base64'),
});

// ─── a real Google token, for the sso route ───────────────────────────────────────────────────

const KID = 'kr-test-key';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const GOOGLE_SUB = '110169484474386276334';
const { publicKey: gPub, privateKey: gPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const gJwk = { ...gPub.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' } as any;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');

function googleToken(nonce: string, sub = GOOGLE_SUB): string {
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
    const p = b64({
        iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub,
        email: 'someone@gmail.com', email_verified: true, iat: now, exp: now + 3600, nonce,
    });
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), gPriv).toString('base64url')}`;
}

function primeGoogle(): void {
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [gJwk], expiresAt: Date.now() + 3600_000 });
    _clearNoncesForTests();
}

async function main(): Promise<void> {
    console.log('\nKeyholder fragment routes\n');

    // ── 1. sso-nonce ──────────────────────────────────────────────────────────────────────────
    console.log('── sso-nonce ───────────────────────────────────────────');

    primeGoogle();
    const alice = member();
    const bob = member();

    const nonceRes = await call('POST', '/api/recovery/sso-nonce', { actor: alice.pubkey });
    assert(nonceRes.status === 200 && typeof nonceRes.body.nonce === 'string' && nonceRes.body.nonce.length > 20,
        'the node issues a sign-in nonce to a signed member');
    assert(Array.isArray(nonceRes.body.providers) && nonceRes.body.providers.includes('apple'),
        'and tells the client which providers it can verify');
    assert((await call('POST', '/api/recovery/sso-nonce', {})).status === 401,
        'but not to an unsigned caller — a nonce nobody owns protects nobody');

    // ── 2. hub-fragment before deposit ────────────────────────────────────────────────────────
    console.log('\n── hub-fragment ─────────────────────────────────────────');

    const noHub = await call('POST', '/api/recovery/shares/hub-fragment', { actor: alice.pubkey });
    assert(noHub.status === 200 && noHub.body.hubFragment === null,
        'a member with no recovery shares has no hub fragment');
    assert((await call('POST', '/api/recovery/shares/hub-fragment', {})).status === 401,
        'an unsigned hub-fragment request is refused');

    // ── 3. verified sign-in deposit ───────────────────────────────────────────────────────────
    console.log('\n── verified sign-in deposit ─────────────────────────────');

    const ssoShares = [
        { holderType: 'hub', holderRef: 'node', ...frag(1) },
        { holderType: 'sso', holderRef: 'unset', ...frag(2) },
    ];

    // Nonce binding
    const bobNonce = (await call('POST', '/api/recovery/sso-nonce', { actor: bob.pubkey })).body.nonce;
    const stolenNonce = await call('POST', '/api/recovery/shares/sso', {
        actor: alice.pubkey,
        body: { provider: 'google', idToken: googleToken(bobNonce), nonce: bobNonce, shares: ssoShares },
    });
    assert(stolenNonce.status === 400, 'a nonce issued to another member cannot be used');

    // Paused provider
    const aliceNonce = (await call('POST', '/api/recovery/sso-nonce', { actor: alice.pubkey })).body.nonce;
    const badProvider = await call('POST', '/api/recovery/shares/sso', {
        actor: alice.pubkey,
        body: { provider: 'facebook', idToken: googleToken(aliceNonce), nonce: aliceNonce, shares: ssoShares },
    });
    assert(badProvider.status === 400, 'a paused provider is refused (D11)');

    // Client-supplied lookup hash refused
    const clientHash = await call('POST', '/api/recovery/shares/sso', {
        actor: alice.pubkey,
        body: {
            provider: 'google', idToken: googleToken(aliceNonce), nonce: aliceNonce,
            shares: ssoShares.map(s => s.holderType === 'sso' ? { ...s, ssoLookupHash: 'fake-hash' } : s),
        },
    });
    assert(clientHash.status === 400,
        'a client-supplied lookup hash is refused on the verified route');

    // Successful deposit
    const aliceDeposit = await call('POST', '/api/recovery/shares/sso', {
        actor: alice.pubkey,
        body: { provider: 'google', idToken: googleToken(aliceNonce), nonce: aliceNonce, shares: ssoShares },
    });
    assert(aliceDeposit.status === 200 && aliceDeposit.body.provider === 'google',
        'a verified Google deposit succeeds');
    assert(aliceDeposit.body.email === 's•••@gmail.com', 'and returns a masked email for the keeper list');
    assert(!JSON.stringify(aliceDeposit.body).includes(GOOGLE_SUB),
        'and the raw Google subject is not echoed back in the response');
    assert(aliceDeposit.body.threshold === 2, 'and threshold is 2 for SSO tier');

    // Replay protection
    const replay = await call('POST', '/api/recovery/shares/sso', {
        actor: alice.pubkey,
        body: { provider: 'google', idToken: googleToken(aliceNonce), nonce: aliceNonce, shares: ssoShares },
    });
    assert(replay.status === 400, 'REPLAY: the same token and nonce cannot be presented twice');

    // Verify stored lookup hash
    const aliceSso = getCurrentShares(alice.pubkey).find(s => s.holderType === 'sso')!;
    const expectedHash = await ssoLookupHash('google', GOOGLE_SUB, aliceSso.ssoLookupSalt!);
    assert(aliceSso.ssoLookupHash === expectedHash,
        'stored lookup hash is derived correctly node-side');
    assert(findShareBySsoLookup(expectedHash)?.ownerPubkey === alice.pubkey,
        'lookup hash resolves to member via findShareBySsoLookup');

    // hub-fragment now returns the stored hub fragment
    const withHub = await call('POST', '/api/recovery/shares/hub-fragment', { actor: alice.pubkey });
    assert(withHub.status === 200 && withHub.body.hubFragment === frag(1).encryptedShare,
        'the member can retrieve their own stored hub fragment');

    // Unsigned deposit refused
    assert((await call('POST', '/api/recovery/shares/sso', { body: { provider: 'google', shares: ssoShares } })).status === 401,
        'an unsigned sign-in deposit is refused');

    // ── 4. status ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── status ───────────────────────────────────────────────');

    const status = await call('POST', '/api/recovery/shares/status', { actor: alice.pubkey });
    assert(status.status === 200 && status.body.generation === 1 && status.body.total === 2,
        'the owner can read their own generation and count');
    assert(status.body.threshold === 2 && status.body.recoverable === true,
        'SSO recovery is recoverable at threshold 2');
    assert(status.body.unattendedPieces === 2 && status.body.dependsOnPeople === false,
        'SSO tier has 2 unattended pieces and does not depend on people');
    assert((await call('POST', '/api/recovery/shares/status', {})).status === 401,
        'an unsigned status read is refused');

    // ── 5. disconnecting SSO provider ─────────────────────────────────────────────────────────
    console.log('\n── disconnecting SSO provider ───────────────────────────');

    assert((await call('DELETE', '/api/recovery/shares/sso/:provider', { actor: alice.pubkey, params: { provider: 'invalid-provider' } })).status === 400,
        'an invalid provider is refused');
    assert((await call('DELETE', '/api/recovery/shares/sso/:provider', { actor: alice.pubkey, params: { provider: 'apple' } })).status === 404,
        'a provider that is not connected returns 404');
    assert((await call('DELETE', '/api/recovery/shares/sso/:provider', { params: { provider: 'google' } })).status === 401,
        'an unsigned disconnect is refused');

    // Disconnecting the only SSO provider drops all shares
    const disconnected = await call('DELETE', '/api/recovery/shares/sso/:provider', { actor: alice.pubkey, params: { provider: 'google' } });
    assert(disconnected.status === 200 && disconnected.body.removed === 'google',
        'disconnecting google succeeds');
    assert(disconnected.body.generation === 0 && disconnected.body.enrolledSso.length === 0,
        'disconnecting the only provider clears recovery set to generation 0');
    assert(countCurrentShares(alice.pubkey) === 0,
        'all shares are deleted from storage');

    // ── 6. bulk deletion of all shares ────────────────────────────────────────────────────────
    console.log('\n── deletion confirmation ────────────────────────────────');

    // Deposit again on bob
    primeGoogle();
    const bNonce = (await call('POST', '/api/recovery/sso-nonce', { actor: bob.pubkey })).body.nonce;
    await call('POST', '/api/recovery/shares/sso', {
        actor: bob.pubkey,
        body: { provider: 'google', idToken: googleToken(bNonce), nonce: bNonce, shares: ssoShares },
    });
    assert(countCurrentShares(bob.pubkey) === 2, 'bob now has recovery shares');

    const noConfirm = await call('DELETE', '/api/recovery/shares', { actor: bob.pubkey, body: {} });
    assert(noConfirm.status === 400 && noConfirm.body.currentShareCount === 2,
        'deleting every fragment needs an explicit confirmation, and says what is at stake');
    assert(countCurrentShares(bob.pubkey) === 2, 'and the unconfirmed attempt deleted nothing');

    const wrongConfirm = await call('DELETE', '/api/recovery/shares', {
        actor: bob.pubkey, body: { confirm: 'yes' },
    });
    assert(wrongConfirm.status === 400 && countCurrentShares(bob.pubkey) === 2,
        'a near-miss confirmation is still a refusal');

    assert((await call('DELETE', '/api/recovery/shares', {
        body: { confirm: 'delete-my-recovery-keepers' },
    })).status === 401, 'and an unsigned delete is refused');

    const gone = await call('DELETE', '/api/recovery/shares', {
        actor: bob.pubkey, body: { confirm: 'delete-my-recovery-keepers' },
    });
    assert(gone.status === 200 && gone.body.removed === 2, 'a confirmed delete drops every fragment');
    assert(countCurrentShares(bob.pubkey) === 0 && gone.body.generation === 0,
        'and the member is back to the 12 words alone');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Keyholder route checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
