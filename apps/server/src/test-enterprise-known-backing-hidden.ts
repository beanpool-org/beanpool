/**
 * An enterprise's backing never names which keepers the admins confirmed (Marty, 2026-10-21: "Hide the names"). A known
 * pledge (engine known-floor.ts KNOWN_PLEDGE_PREFIX) is drawn from a confirmed keeper's known grant, so a pledge list that
 * names it names a confirmation. Over HTTPS, through the real middleware:
 *
 *   1. an ordinary member's read of an enterprise one confirmed keeper backs from their known grant (the enterprises list,
 *      the enterprise's page, its pledges): one folded entry (id `known`, kind `known`) with the known pledges' sum, no
 *      keeper, name, key, photo, date or `known:` id anywhere in the answer; each keeper's own (earned) pledge still named;
 *      the allowance unchanged
 *   2. the keepers list beside it: each keeper's `backing` is their named pledges standing now, never the known part they
 *      joined with, so subtracting the named pledges from it shows nothing; the keeper reads their own row as before
 *   3. two confirmed keepers: one folded entry, the sum of both, and neither named
 *   4. an owner or admin (signed, or the manager's admin sign-in): every pledge and every keeper's backing as before
 *   5. a guest (no key) is refused these reads, as before; another keeper of the same enterprise reads it as the ordinary
 *      member does; the keeper reads their own row as before
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-enterprise-known-backing-hidden.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'KnownBacking123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, transfer, seedGenesisMember, pledgeEnterpriseBacking, requestToJoinEnterprise, approveKeeperRequest } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto, getEnterpriseFloor, clearEnterpriseFloorCache } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 240);

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, beans = 0): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, beans, `seed ${name}`, 'direct', true);
    return id;
}

/** An enterprise with keepers bound as a join binds them: `backing` is what each pledged as they joined. */
function makeEnterprise(name: string, keepers: { id: Id; backing: number }[]): string {
    const pk = keypair(name).pk;
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active', 1)`).run(pk, name, ago(DAY));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    setMemberPhoto(db, pk, AVATAR);
    for (const k of keepers) {
        db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, backing) VALUES (?, ?, ?)').run(pk, k.id.pk, k.backing);
        db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(k.id.pk);
    }
    clearEnterpriseFloorCache(db);
    return pk;
}

/** A keeper's own pledge of earned credit, as insertPledgeRows writes its earned part (a plain id). */
function earnedPledge(enterprise: string, keeper: Id, amount: number): void {
    db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), keeper.pk, enterprise, amount, ago(DAY));
    clearEnterpriseFloorCache(db);
}

function confirm(member: Id, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
}

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

type Pledge = { id: string; kind?: string; keeper: string; callsign: string; avatarUrl: string | null; amount: number; pledgedAt: string | null };
type Keeper = { publicKey: string; callsign: string; backing: number };
/** One enterprise as a reader reads it on each of its three routes. */
type Reads = { list: any; detail: any; pledges: any };

async function readAs(who: Id | null, enterprise: string, extra: Record<string, string> = {}): Promise<Reads> {
    const list = await call('GET', who, '/api/enterprises', undefined, extra);
    const detail = await call('GET', who, `/api/enterprise/${enterprise}`, undefined, extra);
    const pledges = await call('GET', who, `/api/treasury/${enterprise}/pledges`, undefined, extra);
    if (list.status !== 200 || detail.status !== 200 || pledges.status !== 200) {
        throw new Error(`a read was refused: ${list.status} ${detail.status} ${pledges.status}`);
    }
    return { list: (list.body?.treasuries ?? []).find((e: any) => e.publicKey === enterprise), detail: detail.body, pledges: pledges.body };
}

const folded = (pledges: Pledge[]) => pledges.filter(p => p.id === 'known');
const knownRows = (pledges: Pledge[]) => pledges.filter(p => p.id.startsWith('known:'));
const keeperOf = (keepers: Keeper[], who: Id) => keepers.find(k => k.publicKey === who.pk);

/** An answer that names no known pledge: one folded entry of `sum`, naming no one, and no `known:` id anywhere in it. */
function assertFolded(label: string, answer: { pledges: Pledge[] }, sum: number, confirmed: Id[]): void {
    const fold = folded(answer.pledges);
    assert(fold.length === 1 && fold[0].amount === sum && fold[0].kind === 'known',
        `${label}: one folded entry, kind known, of ${sum} (${show(fold)})`);
    assert(fold.length === 1 && fold[0].keeper === '' && fold[0].callsign === '' && fold[0].avatarUrl === null && fold[0].pledgedAt === null,
        `${label}: the folded entry names no keeper, name, photo or date (${show(fold[0])})`);
    assert(folded(answer.pledges).every(p => answer.pledges.indexOf(p) === answer.pledges.length - 1),
        `${label}: the folded entry comes last`);
    assert(knownRows(answer.pledges).length === 0 && !JSON.stringify(answer).includes('known:'),
        `${label}: no known: id anywhere in the answer`);
    for (const c of confirmed) {
        const named = answer.pledges.filter(p => p.keeper === c.pk);
        assert(named.every(p => !p.id.startsWith('known:')) && !JSON.stringify(fold).includes(c.pk) && !JSON.stringify(fold).includes(c.name),
            `${label}: ${c.name}'s known pledge is not named (${c.name}'s named pledges: ${show(named)})`);
    }
}

async function main(): Promise<void> {
    console.log('An enterprise\'s backing never names which keepers the admins confirmed\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = ownerSessionHeaders();
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const una = makeMember('Una');   // an ordinary member: keeps nothing, no role
    const kai = makeMember('Kai');
    const lee = makeMember('Lee');   // not confirmed
    const lia = makeMember('Lia');
    const mo = makeMember('Mo');
    for (const m of [kai, lia, mo]) confirm(m, ada);

    const dial = await call('POST', null, '/api/local/admin/known-floor', { confirmation: true }, owner);
    assert(dial.status === 200 && dial.body?.confirmation === true, `the owner turns the confirmation dial on (${dial.status})`);

    // Kai Co: Lee keeps it and backs it with 300 of his own. Kai, confirmed, asks to join with 500, which he can back only
    // from his known grant, and Ada (an admin outside it) approves: bound at once, with a known pledge of 500.
    const kaiCo = makeEnterprise('Kai Co', [{ id: lee, backing: 300 }]);
    earnedPledge(kaiCo, lee, 300);
    const request = requestToJoinEnterprise(kaiCo, kai.pk, 500);
    const approved = approveKeeperRequest(request.id, ada.pk);
    assert(approved.applied && approved.backing === 500, `Ada approves Kai with 500 of backing, bound at once (${show(approved)})`);
    const kaiKnown = db.prepare("SELECT SUM(amount) AS s FROM enterprise_pledges WHERE enterprise = ? AND keeper = ? AND id LIKE 'known:%' AND released_at IS NULL").get(kaiCo, kai.pk) as { s: number };
    assert(kaiKnown.s === 500, `Kai's 500 is a known pledge (${kaiKnown.s})`);
    // And a pledge Kai chose to put in of his own earned credit, which stays his and named.
    earnedPledge(kaiCo, kai, 50);
    const kaiCoAllowance = getEnterpriseFloor(db, kaiCo).allowance;
    assert(kaiCoAllowance === 850, `Kai Co's allowance counts all three: 300 + 50 earned, 500 known (${kaiCoAllowance})`);

    // Two Co: Lia and Mo, both confirmed, each back it from their known grants.
    const twoCo = makeEnterprise('Two Co', [{ id: lia, backing: 0 }, { id: mo, backing: 0 }]);
    pledgeEnterpriseBacking(twoCo, lia.pk, 200);
    pledgeEnterpriseBacking(twoCo, mo.pk, 300);
    const twoKnown = db.prepare("SELECT COUNT(*) AS n FROM enterprise_pledges WHERE enterprise = ? AND id LIKE 'known:%' AND released_at IS NULL").get(twoCo) as { n: number };
    assert(twoKnown.n === 2, `Lia's 200 and Mo's 300 are known pledges (${twoKnown.n} rows)`);
    const twoCoAllowance = getEnterpriseFloor(db, twoCo).allowance;

    // ── 1, 2. an ordinary member ─────────────────────────────────────────────────────────────────────
    console.log('── 1, 2. an ordinary member reads Kai Co ──');
    const unaReads = await readAs(una, kaiCo);
    for (const [route, answer] of Object.entries(unaReads) as [keyof Reads, any][]) {
        assertFolded(`Una, ${route}`, answer, 500, [kai]);
        const named = (answer.pledges as Pledge[]).filter(p => p.id !== 'known');
        assert(named.some(p => p.keeper === lee.pk && p.callsign === 'Lee' && p.amount === 300)
            && named.some(p => p.keeper === kai.pk && p.callsign === 'Kai' && p.amount === 50) && named.length === 2,
            `Una, ${route}: Lee's 300 and Kai's own 50 are named as before (${show(named)})`);
        assert(answer.allowance === kaiCoAllowance, `Una, ${route}: the allowance is unchanged, ${kaiCoAllowance} (${answer.allowance})`);
    }
    for (const [route, answer] of [['list', unaReads.list], ['detail', unaReads.detail]] as const) {
        const keepers = answer.keepers as Keeper[];
        assert(keeperOf(keepers, kai)?.backing === 50 && keeperOf(keepers, lee)?.backing === 300,
            `Una, ${route}: each keeper's backing is their named pledges, Kai 50 and Lee 300, never Kai's 500 (${show(keepers.map(k => [k.callsign, k.backing]))})`);
        // Subtracting each keeper's named pledges from their backing leaves nothing to point at.
        const gap = (who: Id) => (keeperOf(keepers, who)?.backing ?? NaN)
            - (answer.pledges as Pledge[]).filter(p => p.keeper === who.pk).reduce((s, p) => s + p.amount, 0);
        assert(gap(kai) === 0 && gap(lee) === 0, `Una, ${route}: backing less named pledges is 0 for both keepers (Kai ${gap(kai)}, Lee ${gap(lee)})`);
    }

    // ── 3. two confirmed keepers ─────────────────────────────────────────────────────────────────────
    console.log('── 3. two confirmed keepers ──');
    const unaTwo = await readAs(una, twoCo);
    for (const [route, answer] of Object.entries(unaTwo) as [keyof Reads, any][]) {
        assertFolded(`Una, Two Co ${route}`, answer, 500, [lia, mo]);
        assert((answer.pledges as Pledge[]).length === 1, `Una, Two Co ${route}: the folded entry is the only pledge (${show(answer.pledges)})`);
        assert(answer.allowance === twoCoAllowance && twoCoAllowance === 500, `Una, Two Co ${route}: the allowance is unchanged, 500 (${answer.allowance})`);
    }
    for (const [route, answer] of [['list', unaTwo.list], ['detail', unaTwo.detail]] as const) {
        const keepers = answer.keepers as Keeper[];
        assert(keeperOf(keepers, lia)?.backing === 0 && keeperOf(keepers, mo)?.backing === 0,
            `Una, Two Co ${route}: neither keeper shows a backing of their own (${show(keepers.map(k => [k.callsign, k.backing]))})`);
    }

    // ── 4. an owner or admin ─────────────────────────────────────────────────────────────────────────
    console.log('── 4. an owner or admin ──');
    const adaReads = await readAs(ada, kaiCo);
    for (const [route, answer] of Object.entries(adaReads) as [keyof Reads, any][]) {
        const known = knownRows(answer.pledges);
        assert(known.length === 1 && known[0].keeper === kai.pk && known[0].callsign === 'Kai' && known[0].amount === 500 && folded(answer.pledges).length === 0,
            `Ada (admin), ${route}: Kai's known pledge, by name, as before (${show(known)})`);
        assert((answer.pledges as Pledge[]).length === 3 && answer.allowance === kaiCoAllowance,
            `Ada (admin), ${route}: all three pledges, the allowance ${kaiCoAllowance} (${answer.allowance})`);
    }
    for (const [route, answer] of [['list', adaReads.list], ['detail', adaReads.detail]] as const) {
        assert(keeperOf(answer.keepers, kai)?.backing === 500 && keeperOf(answer.keepers, lee)?.backing === 300,
            `Ada (admin), ${route}: the keepers' backing as before, Kai 500 and Lee 300`);
    }
    const adaTwo = await readAs(ada, twoCo);
    const adaTwoKnown = knownRows(adaTwo.pledges.pledges);
    assert(adaTwoKnown.length === 2 && adaTwoKnown.some(p => p.keeper === lia.pk && p.amount === 200) && adaTwoKnown.some(p => p.keeper === mo.pk && p.amount === 300),
        `Ada (admin): Two Co's known pledges, each by its keeper (${show(adaTwoKnown)})`);
    // The manager reads the list with the admin sign-in, which has no member key.
    const managerList = await call('GET', null, '/api/local/admin/treasury', undefined, owner);
    const managerKaiCo = (managerList.body?.treasuries ?? []).find((e: any) => e.publicKey === kaiCo);
    assert(managerList.status === 200 && knownRows(managerKaiCo?.pledges ?? []).some(p => p.keeper === kai.pk && p.amount === 500)
        && keeperOf(managerKaiCo?.keepers ?? [], kai)?.backing === 500,
        `the manager's admin sign-in: Kai's known pledge and backing as before (${managerList.status} ${show(managerKaiCo?.pledges)})`);
    const founderReads = await readAs(founder, kaiCo);
    assert(knownRows(founderReads.detail.pledges).some(p => p.keeper === kai.pk),
        `the founder (the node's owner) reads Kai's known pledge by name`);

    // ── 5. a guest, another keeper, and the keeper themself ──────────────────────────────────────────
    console.log('── 5. a guest, another keeper, the keeper themself ──');
    // A guest is refused every one of these reads (members only, https-server.ts MEMBERS_ONLY_READS_PATTERNS), as before.
    for (const path of ['/api/enterprises', `/api/enterprise/${kaiCo}`, `/api/treasury/${kaiCo}/pledges`]) {
        const r = await call('GET', null, path);
        assert(r.status === 401 && !JSON.stringify(r.body ?? {}).includes(kai.pk) && !JSON.stringify(r.body ?? {}).includes('known'),
            `a guest is refused ${path}, and the refusal names no one (${r.status} ${show(r.body)})`);
    }
    const leeReads = await readAs(lee, kaiCo);
    for (const [route, answer] of Object.entries(leeReads) as [keyof Reads, any][]) assertFolded(`Lee (Kai Co's other keeper), ${route}`, answer, 500, [kai]);
    assert(keeperOf(leeReads.detail.keepers, kai)?.backing === 50 && keeperOf(leeReads.detail.keepers, lee)?.backing === 300,
        `Lee: Kai's backing is his named 50, Lee's own row is his 300`);
    const kaiReads = await readAs(kai, kaiCo);
    assertFolded('Kai himself, detail', kaiReads.detail, 500, []);
    assert(keeperOf(kaiReads.detail.keepers, kai)?.backing === 500 && keeperOf(kaiReads.detail.keepers, lee)?.backing === 300,
        `Kai reads his own row as before, 500, and Lee's as Lee's named 300 (${show(kaiReads.detail.keepers.map((k: Keeper) => [k.callsign, k.backing]))})`);
    const plain = makeEnterprise('Plain Co', [{ id: lee, backing: 100 }]);
    earnedPledge(plain, lee, 100);
    const plainReads = await readAs(una, plain);
    assert(folded(plainReads.detail.pledges).length === 0 && plainReads.detail.pledges.length === 1 && plainReads.detail.pledges[0].keeper === lee.pk,
        `an enterprise with no known pledge reads as before: Lee's 100, no folded entry (${show(plainReads.detail.pledges)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
