/**
 * Global node G1: Beans off on the global profile, never on a live ledger (config/node-profile.ts).
 *
 * Over REAL HTTPS, through the signature middleware and the feature gate, with signed members:
 *
 *   1. A fresh local node with `nodeProfile.beans=false`: Beans really are off (the override works where nothing
 *      has ever moved), and escrow goes with them.
 *   2. The global profile on a fresh node. The boot log lists every switch still pinned by NOT_BUILT_YET.
 *      /api/community/info reports beans, escrow and enterprises off. A send is 403 profile_no_beans before any
 *      other check; a post with a Beans price is 403 and one without is stored at 0, as is an edit; every escrow,
 *      treasury/enterprise, crowdfund/Commons-project and federation purchase route is 404 feature_off, reads
 *      included; a pool-money Decision is refused (a member Decision is not); the settlement gate refuses; the
 *      offboarding wizard still works (a zero balance); members' own history and balance still answer. Underneath,
 *      every ledger primitive refuses on its own. The ledger audit is clean and nothing was written.
 *   3. That database, now recorded as global, refuses to boot as local; a standby of it doesn't refuse; started
 *      once with NODE_PROFILE_ALLOW_CHANGE_FROM=global it converts.
 *   4. The local profile: unchanged. Beans switched off and back on at runtime first, before anything moves. A send
 *      fails for the old reason, a price is kept, the routes answer, and a real escrow opens.
 *   5. Now the ledger has moved: `nodeProfile.beans=false` is refused at runtime, with no reboot (the "never moved"
 *      seen in 4 did not outlive Beans coming back on), and at boot (the log says why), and Beans stay on;
 *      NODE_PROFILE=global on this database keeps all five money switches on, and the open escrow completes.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-global-no-beans.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Whatever the shell running the suite has set, the suite starts from a node with no profile configured.
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
process.env.ADMIN_PASSWORD = 'Global-No-Beans-Admin-83!';

import crypto from 'node:crypto';

const PORT = 8741;
const BASE = `https://localhost:${PORT}`;
const ADMIN_PW = process.env.ADMIN_PASSWORD;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** Runs fn and returns what it wrote to console.log / console.warn, still printing it. */
async function capture(fn: () => unknown): Promise<{ logs: string[]; warns: string[]; error: unknown }> {
    const logs: string[] = [], warns: string[] = [];
    const log = console.log, warn = console.warn;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); log(...a); };
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); warn(...a); };
    let error: unknown = null;
    try { await fn(); } catch (e) { error = e; } finally { console.log = log; console.warn = warn; }
    return { logs, warns, error };
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string };

async function call(method: 'GET' | 'POST', path: string, body: unknown, id: Id | null, extra: Record<string, string> = {}) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const signPath = path.split('?')[0];
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${signPath}\n${ts}\n${nonce}\n${bodyString}`), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

async function main() {
    const { db, initSchema } = await import('./db/db.js');
    const profile = await import('./config/node-profile.js');
    const { mirrorNodeProfileAtBoot, getProfileSwitches, getNodeFeatures, NODE_PROFILE_KEY } = profile;

    const setOverride = (name: string, value: string) =>
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`${NODE_PROFILE_KEY}.${name}`, value);
    const clearOverrides = () => db.prepare('DELETE FROM node_config WHERE substr(key, 1, 12) = ?').run(`${NODE_PROFILE_KEY}.`);
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    const nonZeroBalances = () => (db.prepare('SELECT COUNT(*) AS c FROM accounts WHERE balance != 0').get() as { c: number }).c;

    // ── 1. A fresh local node, Beans switched off by an override ──
    console.log('── 1. a fresh local node with nodeProfile.beans=false ──');
    initSchema();
    setOverride('beans', 'false');
    const { initAdminPassword } = await import('./config/local-config.js');
    initAdminPassword();
    const se = await import('./state-engine.js');
    const boot1 = await capture(() => se.initStateEngine());
    assert(!boot1.error, `the node boots (${String(boot1.error ?? 'ok')})`);
    assert(boot1.logs.some(l => l.includes('Beans are off')), 'the boot log says Beans are off');

    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    await initTls();
    await startHttpsServer(PORT);

    const member = (callsign: string): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, avatar_url, status, joined_at, updated_at, invited_by, invite_code)
                    VALUES (?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed')`)
            .run(pubKeyHex, callsign, AVATAR);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pubKeyHex);
        return { pubKeyHex, privateKey, callsign };
    };
    const alice = member('Alice'), bob = member('Bob'), carol = member('Carol'), dave = member('Dave');
    const send = (from: Id, to: Id, amount = 5) => call('POST', '/api/ledger/transfer', { to: to.pubKeyHex, amount, memo: 'thanks' }, from);

    const s1 = await send(alice, bob);
    assert(s1.status === 403 && s1.body?.code === 'profile_no_beans', `a send is refused with profile_no_beans (${s1.status} ${JSON.stringify(s1.body)})`);
    const f1 = getNodeFeatures();
    assert(!f1.beans && !f1.escrow, `features: Beans off, and escrow with them (${JSON.stringify(f1)})`);
    clearOverrides();

    // ── 2. The global profile, fresh ──
    console.log('\n── 2. NODE_PROFILE=global on a node whose ledger has never moved ──');
    process.env.NODE_PROFILE = 'global';
    const boot2 = await capture(() => mirrorNodeProfileAtBoot());
    assert(!boot2.error, `the global node boots (${String(boot2.error ?? 'ok')})`);
    const pinnedLine = boot2.logs.find(l => l.includes('Not built yet, so these run as on any node today')) ?? '';
    assert(['openJoin=false (global wants true)', 'knocks=false', 'distanceSortDefault=false (global wants true)', 'directoryMirror=false (global wants true)',
        'publishToDirectory=true (global wants false)', 'probation=false (global wants true)', 'autoHideReports=false (global wants true)',
        'autoMute=false (global wants true)', 'ssoRequiredForJoin=true'].every(p => pinnedLine.includes(p)),
        `the boot log lists every switch still pinned, and what the profile wants (${pinnedLine})`);
    assert(!/\bbeans=|\bescrow=|enterprises=|treasuries=|crowdfund=/.test(pinnedLine), 'and the money switches are no longer among them');

    const info = await call('GET', '/api/community/info', null, alice);
    assert(info.status === 200 && info.body.profile === 'global', `info says global (${info.status} ${info.body?.profile})`);
    assert(info.body.features?.beans === false && info.body.features?.escrow === false && info.body.features?.enterprises === false,
        `info reports beans, escrow and enterprises off (${JSON.stringify(info.body.features)})`);

    // Sends
    const s2 = await send(alice, bob);
    assert(s2.status === 403 && s2.body?.code === 'profile_no_beans' && s2.body?.error === profile.BEANS_OFF_MESSAGE,
        `POST /api/ledger/transfer → 403 profile_no_beans with the plain message (${s2.status} ${JSON.stringify(s2.body)})`);
    const s3 = await call('POST', '/api/ledger/transfer', { to: 'COMMONS_POOL', amount: -1 }, alice);
    assert(s3.status === 403 && s3.body?.code === 'profile_no_beans', `…before any other check, even a malformed send (${s3.status})`);

    // Posts
    const priced = await call('POST', '/api/marketplace/posts', { type: 'offer', category: 'food', title: 'Lemons', description: 'A bag', credits: 10, authorPublicKey: alice.pubKeyHex }, alice);
    assert(priced.status === 403 && priced.body?.code === 'profile_no_beans' && priced.body?.error === profile.BEANS_OFF_PRICE_MESSAGE,
        `a post with a Beans price → 403 profile_no_beans, saying how to post it instead (${priced.status} ${JSON.stringify(priced.body)})`);
    assert(count('posts') === 0, 'and nothing was stored');
    const free = await call('POST', '/api/marketplace/posts', { type: 'offer', category: 'food', title: 'Lemons', description: 'A bag, free', authorPublicKey: alice.pubKeyHex }, alice);
    const freeId = free.body?.post?.id;
    const storedCredits = () => (db.prepare('SELECT credits FROM posts WHERE id = ?').get(freeId) as { credits: number } | undefined)?.credits;
    assert(free.status === 200 && freeId && storedCredits() === 0, `a post with no price is stored, at 0 Beans (${free.status} ${storedCredits()})`);
    const zero = await call('POST', '/api/marketplace/posts', { type: 'offer', category: 'tools', title: 'A ladder', description: 'Borrow it for a day', credits: '0', authorPublicKey: bob.pubKeyHex }, bob);
    assert(zero.status === 200 && zero.body?.post?.credits === 0, `credits "0" is stored as 0 (${zero.status} ${JSON.stringify(zero.body)})`);
    const repriced = await call('POST', '/api/marketplace/posts/update', { id: freeId, authorPublicKey: alice.pubKeyHex, credits: 15 }, alice);
    assert(repriced.status === 403 && repriced.body?.code === 'profile_no_beans' && storedCredits() === 0,
        `an edit that adds a Beans price → 403, the post keeps 0 (${repriced.status} ${storedCredits()})`);
    const retitled = await call('POST', '/api/marketplace/posts/update', { id: freeId, authorPublicKey: alice.pubKeyHex, title: 'Lemons and limes' }, alice);
    assert(retitled.status === 200, `an edit without a price still works (${retitled.status})`);

    // Escrow
    const escrowRoutes: Array<[string, Record<string, unknown>]> = [
        ['/api/marketplace/posts/accept', { postId: freeId, buyerPublicKey: bob.pubKeyHex }],
        ['/api/marketplace/posts/request', { postId: freeId, buyerPublicKey: bob.pubKeyHex }],
        ['/api/marketplace/transactions/approve', { transactionId: 'x', authorPublicKey: alice.pubKeyHex }],
        ['/api/marketplace/transactions/reject', { transactionId: 'x', authorPublicKey: alice.pubKeyHex }],
        ['/api/marketplace/transactions/cancel-request', { transactionId: 'x', buyerPublicKey: bob.pubKeyHex }],
        ['/api/marketplace/transactions/complete', { transactionId: 'x', confirmerPublicKey: bob.pubKeyHex }],
        ['/api/marketplace/transactions/cancel', { transactionId: 'x', cancellerPublicKey: bob.pubKeyHex }],
    ];
    for (const [path, body] of escrowRoutes) {
        const r = await call('POST', path, body, path.includes('approve') || path.includes('reject') ? alice : bob);
        assert(r.status === 404 && r.body?.code === 'feature_off' && r.body?.feature === 'escrow', `POST ${path} → 404 feature_off (escrow) (${r.status} ${JSON.stringify(r.body)})`);
    }
    for (const path of ['/api/local/admin/disputes', '/api/local/admin/stranded-escrows']) {
        const r = await call('GET', path, null, null, { 'x-admin-password': ADMIN_PW });
        assert(r.status === 404 && r.body?.code === 'feature_off', `GET ${path} (admin) → 404 feature_off (${r.status})`);
    }

    // Treasuries and enterprises. The node makes its own system treasuries at boot ("BeanPool", "Daily Pulse": credit
    // line 0, posting 0-Bean offers), so what is checked is that no route made one.
    const treasuries = () => (db.prepare('SELECT COUNT(*) AS c FROM members WHERE is_treasury = 1').get() as { c: number }).c;
    const treasuriesBefore = treasuries();
    const ent = await call('POST', '/api/enterprise', { name: 'Seed library' }, carol);
    assert(ent.status === 404 && ent.body?.code === 'feature_off', `POST /api/enterprise → 404 feature_off (${ent.status} ${JSON.stringify(ent.body)})`);
    const tre = await call('POST', '/api/treasury', { name: 'Seed library' }, carol);
    assert(tre.status === 404 && tre.body?.code === 'feature_off', `POST /api/treasury → 404 feature_off (${tre.status})`);
    for (const path of ['/api/treasuries', '/api/enterprises', '/api/enterprises/map', '/api/map/enterprises', '/api/treasuries/statuses', `/api/treasury/${carol.pubKeyHex}`]) {
        const r = await call('GET', path, null, carol);
        assert(r.status === 404 && r.body?.code === 'feature_off', `GET ${path} → 404 feature_off (${r.status})`);
    }
    const adminTreasury = await call('POST', '/api/local/admin/treasury', { name: 'Commons', avatar: AVATAR }, null, { 'x-admin-password': ADMIN_PW });
    assert(adminTreasury.status === 404 && adminTreasury.body?.code === 'feature_off', `POST /api/local/admin/treasury (admin) → 404 feature_off (${adminTreasury.status})`);
    assert(treasuries() === treasuriesBefore, `no route made a treasury (${treasuriesBefore} system ones before, ${treasuries()} after)`);

    // Crowdfunds and Commons projects
    for (const [method, path, body] of [
        ['GET', '/api/crowdfund/projects', null],
        ['POST', '/api/crowdfund/projects', { title: 'A well', description: 'Water', goalAmount: 100 }],
        ['POST', '/api/crowdfund/projects/p1/pledge', { amount: 5 }],
        ['GET', '/api/commons/projects', null],
        ['POST', '/api/commons/projects', { title: 'A well', description: 'Water', requestedAmount: 100 }],
    ] as const) {
        const r = await call(method, path, body, carol);
        assert(r.status === 404 && r.body?.code === 'feature_off' && r.body?.feature === 'crowdfund', `${method} ${path} → 404 feature_off (crowdfund) (${r.status})`);
    }

    // Federation
    const purchase = await call('POST', '/api/federation/purchase', { postId: 'x', amount: 5 }, alice);
    assert(purchase.status === 404 && purchase.body?.code === 'feature_off' && purchase.body?.feature === 'beans', `POST /api/federation/purchase → 404 feature_off (${purchase.status})`);
    const capacity = await call('GET', '/api/federation/commission/capacity', null, alice);
    assert(capacity.status === 404 && capacity.body?.code === 'feature_off', `GET /api/federation/commission/capacity → 404 feature_off (${capacity.status})`);
    const { settlementGateRefusal, SETTLE_PURCHASE, SETTLE_RECEIPT } = await import('./federation-protocol.js');
    assert(settlementGateRefusal('peer', '12D3KooWpeer', SETTLE_PURCHASE, 'primary', true)?.code === 'profile_no_beans'
        && settlementGateRefusal('peer', '12D3KooWpeer', SETTLE_RECEIPT, 'primary', true)?.code === 'profile_no_beans',
        'the inbound settlement gate refuses a purchase and a receipt from a trading peer, even with settlement enabled');

    // Decisions
    const noStanding = await call('POST', '/api/commons/decisions', {
        title: 'Help Dave', description: 'A hardship grant for Dave', touches: 'pool', effect: 'grant_hardship', subject: dave.pubKeyHex, params: { amount: 5 },
    }, alice);
    assert(noStanding.status === 403 && noStanding.body?.code === 'profile_no_beans',
        `a pool-money Decision gets the plain answer first, even from a member with no standing to propose (${noStanding.status} ${JSON.stringify(noStanding.body)})`);
    db.prepare('UPDATE members SET earned_credit = 1 WHERE public_key = ?').run(carol.pubKeyHex); // standing to propose
    const grant = await call('POST', '/api/commons/decisions', {
        title: 'Help Dave', description: 'A hardship grant for Dave', touches: 'pool', effect: 'grant_hardship', subject: dave.pubKeyHex, params: { amount: 5 },
    }, carol);
    assert(grant.status === 403 && grant.body?.code === 'profile_no_beans', `a pool-money Decision is refused, profile_no_beans (${grant.status} ${JSON.stringify(grant.body)})`);
    const memberDecision = await call('POST', '/api/commons/decisions', {
        title: 'Freeze Dave', description: 'Freeze Dave for a while', touches: 'member', effect: 'freeze_credit', subject: dave.pubKeyHex,
    }, carol);
    assert(memberDecision.status === 200 && memberDecision.body?.success, `a member Decision is still proposed (${memberDecision.status} ${JSON.stringify(memberDecision.body).slice(0, 120)})`);
    const { preflightAssert } = await import('./decisions-engine.js');
    const pre = preflightAssert({ effect: 'grant_hardship', touches: 'pool', subject: dave.pubKeyHex, params: { amount: 5 } } as any);
    assert(pre.status === 'blocked', `a pool Decision that reached execution would be blocked (${JSON.stringify(pre)})`);

    // Offboarding, and what still answers
    const offboard = await call('POST', `/api/local/admin/members/${dave.pubKeyHex}/offboard`, { resolution: 'prune_zero_balance' }, null, { 'x-admin-password': ADMIN_PW });
    assert(offboard.status === 200 && offboard.body?.success, `the offboarding wizard works: a zero balance to settle (${offboard.status} ${JSON.stringify(offboard.body).slice(0, 120)})`);
    const history = await call('GET', `/api/marketplace/transactions?publicKey=${bob.pubKeyHex}`, null, bob);
    assert(history.status === 200 && Array.isArray(history.body) && history.body.length === 0, `a member's own trade list still answers, empty (${history.status})`);
    const bal = await call('GET', `/api/ledger/balance/${bob.pubKeyHex}`, null, bob);
    assert(bal.status === 200 && bal.body?.balance === 0, `a member's balance still answers: 0 (${bal.status} ${bal.body?.balance})`);

    // Underneath the routes: every primitive refuses by itself
    const refuses = (fn: () => unknown, code: string) => { try { fn(); return false; } catch (e: any) { return e?.code === code; } };
    assert(refuses(() => se.transfer('COMMONS_POOL', alice.pubKeyHex, 1, 'direct'), 'profile_no_beans'), 'transfer() refuses (profile_no_beans)');
    assert(refuses(() => se.transfer(alice.pubKeyHex, bob.pubKeyHex, 1, 'gift', 'direct', true, { signer: 'owner:password', offboardOverride: true }), 'profile_no_beans'),
        "transfer() refuses an offboarding wizard's gift too");
    assert(refuses(() => se.payFromCommons(alice.pubKeyHex, 1, 'grant', { allowDeficit: true }), 'profile_no_beans'), 'payFromCommons() refuses, even allowed a deficit');
    assert(refuses(() => se.moveToCommons('escrow_nothing', 1, 'sweep'), 'profile_no_beans'), 'moveToCommons() refuses');
    const { pledgeToProject } = await import('./db/db.js');
    assert(refuses(() => pledgeToProject('tx1', 'no-such-project', alice.pubKeyHex, 1, 'pledge'), 'profile_no_beans'), 'a crowdfund pledge refuses before it looks for the project');
    assert(refuses(() => se.acceptPost(freeId, bob.pubKeyHex), 'feature_off') && refuses(() => se.requestPost(freeId, bob.pubKeyHex), 'feature_off')
        && refuses(() => se.approvePostRequest('x', alice.pubKeyHex), 'feature_off'), 'the escrow engine refuses to open an escrow (request, approve, accept)');
    assert(refuses(() => se.createPost('offer', 'food', 'Eggs', '', 3, 'fixed', alice.pubKeyHex), 'profile_no_beans'), 'createPost() refuses a price whoever calls it');

    const audit = se.runLedgerAudit();
    assert(audit.ok && Math.abs(audit.drift) < 1e-9 && audit.strandedEscrows === 0, `the ledger audit is clean (${JSON.stringify(audit)})`);
    assert(count('transactions') === 0 && count('marketplace_transactions') === 0 && nonZeroBalances() === 0,
        'no transaction, no escrow, every balance 0: nothing moved');
    assert(profile.ledgerHistory() === null, 'so this ledger has never moved');

    // ── 3. The record now says global ──
    console.log('\n── 3. this database is a global node now ──');
    delete process.env.NODE_PROFILE;
    const refusedBoot = await capture(() => se.initStateEngine());
    assert(refusedBoot.error instanceof profile.NodeProfileMismatchError, `booted with NODE_PROFILE unset, it refuses to start (${String(refusedBoot.error)})`);
    assert(getProfileSwitches('global').beans === false, 'and nothing was switched on meanwhile');
    const standbyBoot = await capture(() => mirrorNodeProfileAtBoot('backup'));
    assert(!standbyBoot.error && standbyBoot.warns.some(w => w.includes('runs as global') && w.includes('take-over from here is refused')),
        'a standby of it starts, and says a take-over from it would be refused');
    assert((db.prepare('SELECT value FROM node_config WHERE key = ?').get(NODE_PROFILE_KEY) as { value: string }).value === 'global',
        "and keeps the main server's record");
    process.env.NODE_PROFILE_ALLOW_CHANGE_FROM = 'global';
    const converted = await capture(() => mirrorNodeProfileAtBoot());
    delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
    assert(!converted.error && converted.warns.some(w => w.includes('on purpose')), 'with NODE_PROFILE_ALLOW_CHANGE_FROM=global it converts, and says so');

    // ── 4. The local profile: unchanged ──
    console.log('\n── 4. local: everything as before ──');
    // Beans switched off and back on at runtime while nothing has moved yet: what was seen while they were off must
    // not outlive them, or 5 below would find the ledger "never moved" after it has.
    setOverride('beans', 'false');
    assert(getProfileSwitches().beans === false, 'switched off at runtime on a ledger that has never moved, Beans are off');
    clearOverrides();
    assert(getProfileSwitches().beans === true, 'and switched back on, they are on');
    const info4 = await call('GET', '/api/community/info', null, alice);
    assert(info4.body.profile === 'local' && info4.body.features?.beans === true && info4.body.features?.escrow === true && info4.body.features?.enterprises === true,
        `info: local, Beans, escrow and enterprises on (${JSON.stringify(info4.body.features)})`);
    const s4 = await send(alice, bob);
    assert(s4.status === 400 && s4.body?.code === undefined && /first completed trade/.test(s4.body?.error ?? ''),
        `a send by a member with no trade yet fails for the old reason, not the profile (${s4.status} ${s4.body?.error})`);
    const lemons = await call('POST', '/api/marketplace/posts', { type: 'offer', category: 'food', title: 'Lemons', description: 'A bag', credits: 10, authorPublicKey: alice.pubKeyHex }, alice);
    assert(lemons.status === 200 && lemons.body?.post?.credits === 10, `a post keeps its Beans price (${lemons.status} ${lemons.body?.post?.credits})`);
    for (const path of ['/api/treasuries', '/api/crowdfund/projects', '/api/commons/projects']) {
        const r = await call('GET', path, null, carol);
        assert(r.status === 200, `GET ${path} → 200 (${r.status})`);
    }
    // A real escrow: Bob is given Beans the way a prune write-off pays out, lists an offer (the contribution rule),
    // and accepts Alice's lemons.
    se.payFromCommons(bob.pubKeyHex, 20, 'Test: Beans for Bob', { allowDeficit: true });
    await call('POST', '/api/marketplace/posts', { type: 'offer', category: 'tools', title: 'Ladder loan', description: 'Any day', credits: 1, authorPublicKey: bob.pubKeyHex }, bob);
    const accepted = await call('POST', '/api/marketplace/posts/accept', { postId: lemons.body.post.id, buyerPublicKey: bob.pubKeyHex }, bob);
    const escrowTx = accepted.body?.transaction?.id;
    assert(accepted.status === 200 && escrowTx, `Bob accepts: an escrow opens (${accepted.status} ${JSON.stringify(accepted.body).slice(0, 160)})`);
    assert(count('marketplace_transactions') === 1 && count('transactions') >= 2, 'the ledger has moved: a grant and an escrow hold');

    // ── 5. Money is never frozen ──
    console.log('\n── 5. a ledger that has moved ──');
    // At runtime first, with no reboot to look at the ledger again.
    setOverride('beans', 'false');
    const live5 = getProfileSwitches();
    assert(live5.beans && live5.escrow, `nodeProfile.beans=false set at runtime on this node: Beans and escrow stay on (${JSON.stringify({ beans: live5.beans, escrow: live5.escrow })})`);
    const liveSend5 = await send(alice, bob);
    assert(liveSend5.status !== 403 && liveSend5.body?.code !== 'profile_no_beans',
        `and a send is not refused for the profile (${liveSend5.status} ${liveSend5.body?.error})`);
    setOverride('escrow', 'false');
    const lockBoot = await capture(() => mirrorNodeProfileAtBoot());
    const lockLine = lockBoot.warns.find(w => w.includes('stay ON') && w.includes('ledger has moved')) ?? '';
    assert(!lockBoot.error && /beans/.test(lockLine) && /escrow/.test(lockLine) && /freeze/.test(lockLine),
        `nodeProfile.beans=false and escrow=false on this node: refused at boot, and the log says why (${lockLine})`);
    const sw5 = getProfileSwitches();
    assert(sw5.beans && sw5.escrow, 'Beans and escrow stay on');
    const s5 = await send(alice, bob);
    assert(s5.status !== 403 && s5.body?.code !== 'profile_no_beans', `a send is not refused for the profile (${s5.status} ${s5.body?.error})`);
    const priced5 = await call('POST', '/api/marketplace/posts', { type: 'offer', category: 'food', title: 'Eggs', description: 'A dozen', credits: 4, authorPublicKey: alice.pubKeyHex }, alice);
    assert(priced5.status === 200 && priced5.body?.post?.credits === 4, `a Beans price is still kept (${priced5.status})`);
    clearOverrides();

    process.env.NODE_PROFILE = 'global';
    const globalBoot = await capture(() => mirrorNodeProfileAtBoot());
    const globalLock = globalBoot.warns.find(w => w.includes('stay ON')) ?? '';
    assert(!globalBoot.error && ['beans', 'escrow', 'enterprises', 'treasuries', 'crowdfund'].every(k => globalLock.includes(k)),
        `NODE_PROFILE=global on this database keeps all five money switches on, and says why (${globalLock})`);
    const f5 = getNodeFeatures();
    assert(f5.beans && f5.escrow && f5.enterprises, `features report them on (${JSON.stringify(f5)})`);
    const t5 = await call('GET', '/api/treasuries', null, carol);
    assert(t5.status === 200, `the treasury routes still answer (${t5.status})`);
    const completed = await call('POST', '/api/marketplace/transactions/complete', { transactionId: escrowTx, confirmerPublicKey: bob.pubKeyHex }, bob);
    assert(completed.status === 200 && completed.body?.success, `the open escrow completes: nothing is frozen (${completed.status} ${JSON.stringify(completed.body).slice(0, 160)})`);
    const audit5 = se.runLedgerAudit();
    assert(audit5.ok && audit5.strandedEscrows === 0, `the ledger audit is clean (${JSON.stringify(audit5)})`);
    delete process.env.NODE_PROFILE;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Beans are off on the global profile, and never on a ledger that has moved.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
