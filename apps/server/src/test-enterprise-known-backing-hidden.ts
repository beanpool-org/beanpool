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
 *   6. a confirmed keeper pledges more, and releases it: the socket event every member hears names the enterprise only, so
 *      the folded total a member re-reads moves with no one to tie it to (state-engine.ts broadcastPledgesChanged)
 *   7. a confirmed member joins by request into an enterprise with two keepers (keeperPledgeForReader): the other keeper
 *      reads the change in its objection window with her named part only; the lead who decides it reads the open request
 *      and the change whole; once it lands, the lead's own requests list gives her named part only; an admin and she
 *      herself read the whole
 *   8. a confirmed member's join the other keeper objects to: the objection's answer and the declined request the lead
 *      reads carry her named part (none), never the whole; an admin reads it whole
 *   9. a confirmed keeper who also has earned credit releases part of his pledge (releaseEnterpriseBacking): inside his
 *      known part, the named pledges a member re-reads stay byte-identical (id, amount, date) while the fold moves, and
 *      his earned rows are not written; past it, the known part goes first. After every release the pledge sums, the
 *      allowance and every floor are what main's release (#2313) leaves for the same release on the same rows
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
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, transfer, seedGenesisMember, pledgeEnterpriseBacking, requestToJoinEnterprise, approveKeeperRequest, getMemberTrustProfile, getEnterpriseUnderlyingFloor, usableFloor, enterpriseKnownShareOf } from './state-engine.js';
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

/** Completed trades enough to earn about `target` of earned credit (test-enterprise-keeper-answers.ts giveEarnedCredit). */
function giveEarnedCredit(member: Id, target: number): number {
    let valueNeeded = Math.ceil((5000 * target) / (1920 - target));
    for (let i = 0; valueNeeded > 0; i++) {
        const amount = Math.min(valueNeeded, 400);
        const peer = `peer-${member.pk.slice(0, 8)}-${i}`;
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, status) VALUES (?, ?, ?, 'active')`).run(peer, `Peer ${i}`, ago(30 * DAY));
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 1000, 0)`).run(peer);
        const post = `post-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'misc', 'goods', 'goods', ?, ?, 'completed')`).run(post, amount, peer);
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, ?, 'completed')`).run(`mtx-${crypto.randomUUID()}`, post, member.pk, peer, amount);
        valueNeeded -= amount;
    }
    return getMemberTrustProfile(member.pk).earnedCredit;
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

type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* not JSON */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The events `sock` hears while `act` runs, once an enterprise_pledge_updated for `enterprise` has arrived (or 3 s pass). */
async function heardDuring(sock: Sock, enterprise: string, act: () => Promise<Res>): Promise<{ res: Res; heard: any[] }> {
    const from = sock.events.length;
    const res = await act();
    for (let i = 0; i < 60 && !sock.events.slice(from).some(e => e?.type === 'enterprise_pledge_updated' && e.enterprise === enterprise); i++) await sleep(50);
    await sleep(100);
    return { res, heard: sock.events.slice(from) };
}

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

/**
 * One keeper's pledges to one enterprise, earned and known, and every figure a pledge moves: the enterprise's allowance,
 * known share, spend floor and usable floor, the keeper's own floor (their known line less what they pledged of it) and
 * usable floor.
 */
type Figures = { earned: number; known: number; allowance: number; knownShare: number; spendFloor: number; usable: number; keeperFloor: number; keeperUsable: number };
function figuresOf(enterprise: string, keeper: Id): Figures {
    const sum = (known: boolean) => Number((db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM enterprise_pledges
        WHERE enterprise = ? AND keeper = ? AND released_at IS NULL AND id ${known ? '' : 'NOT '}LIKE 'known:%'`).get(enterprise, keeper.pk) as { s: number }).s);
    clearEnterpriseFloorCache(db);
    return {
        earned: sum(false), known: sum(true),
        allowance: getEnterpriseFloor(db, enterprise).allowance,
        knownShare: enterpriseKnownShareOf(enterprise),
        spendFloor: getEnterpriseUnderlyingFloor(enterprise).floor,
        usable: usableFloor(enterprise),
        keeperFloor: getMemberTrustProfile(keeper.pk).floor,
        keeperUsable: usableFloor(keeper.pk),
    };
}

/**
 * What main's release (#2313's releaseEnterpriseBacking) leaves for the same release on the same rows: it released every
 * row of the keeper's and pledged the remainder again, the known part first. Written and read in a transaction rolled back.
 */
function asMainReleases(enterprise: string, keeper: Id, amount: number): Figures {
    let figures: Figures | undefined;
    try {
        db.transaction(() => {
            const all = Number((db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM enterprise_pledges WHERE enterprise = ? AND keeper = ? AND released_at IS NULL').get(enterprise, keeper.pk) as { s: number }).s);
            const known = figuresOf(enterprise, keeper).known;
            const toRelease = Math.min(amount, all);
            const knownRemaining = Math.max(0, known - toRelease);
            const at = new Date().toISOString();
            db.prepare('UPDATE enterprise_pledges SET released_at = ? WHERE keeper = ? AND enterprise = ? AND released_at IS NULL').run(at, keeper.pk, enterprise);
            const insert = db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)');
            if (all - toRelease - knownRemaining > 0) insert.run(crypto.randomUUID(), keeper.pk, enterprise, all - toRelease - knownRemaining, at);
            if (knownRemaining > 0) insert.run(`known:${crypto.randomUUID()}`, keeper.pk, enterprise, knownRemaining, at);
            figures = figuresOf(enterprise, keeper);
            throw new Error('rolled back');
        })();
    } catch (e) {
        if (!figures) throw e;
    }
    clearEnterpriseFloorCache(db);
    return figures!;
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

    const dial = await call('POST', null, '/api/local/admin/community-shape', { changes: { knownFloor: { on: true } } }, owner);
    assert(dial.status === 200 && dial.body?.shape?.settings?.knownFloor?.value?.on === true, `the owner turns the confirmation dial on (${dial.status})`);

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

    // ── 6. the socket event every member hears ───────────────────────────────────────────────────────
    console.log('── 6. a pledge and its release, as a member\'s socket hears them ──');
    const unaSock = await socket(una);
    await sleep(100);
    const foldOf = async () => (await readAs(una, twoCo)).detail;
    const before = await foldOf();
    const pledged = await heardDuring(unaSock, twoCo, () => call('POST', lia, `/api/enterprise/${twoCo}/backing`, { amount: 100 }));
    const afterPledge = await foldOf();
    const pledgeEvents = pledged.heard.filter(e => e?.type === 'enterprise_pledge_updated' && e.enterprise === twoCo);
    assert(pledged.res.status === 200 && folded(afterPledge.pledges)[0]?.amount === folded(before.pledges)[0]?.amount + 100,
        `Lia, confirmed, pledges 100 more to Two Co: the folded total Una re-reads moves ${folded(before.pledges)[0]?.amount} → ${folded(afterPledge.pledges)[0]?.amount} (${pledged.res.status})`);
    assert(pledgeEvents.length >= 1 && pledgeEvents.every(e => Object.keys(e).sort().join(',') === 'enterprise,type'),
        `Una's socket hears the pledge as { type, enterprise } only, no keeper (${show(pledgeEvents)})`);
    assert(!JSON.stringify(pledged.heard).includes(lia.pk) && !JSON.stringify(pledged.heard).includes('Lia'),
        `nothing Una's socket heard around the pledge names Lia, so the move ties to no one (${show(pledged.heard)})`);
    const released = await heardDuring(unaSock, twoCo, () => call('POST', lia, `/api/enterprise/${twoCo}/backing/release`, { amount: 100 }));
    const afterRelease = await foldOf();
    const releaseEvents = released.heard.filter(e => e?.type === 'enterprise_pledge_updated' && e.enterprise === twoCo);
    assert(released.res.status === 200 && folded(afterRelease.pledges)[0]?.amount === folded(before.pledges)[0]?.amount,
        `Lia releases it: the folded total moves back to ${folded(afterRelease.pledges)[0]?.amount} (${released.res.status} ${show(released.res.body)})`);
    assert(releaseEvents.length >= 1 && releaseEvents.every(e => Object.keys(e).sort().join(',') === 'enterprise,type')
        && !JSON.stringify(released.heard).includes(lia.pk) && !JSON.stringify(released.heard).includes('Lia'),
        `the release's event names no keeper either, and nothing heard around it names Lia (${show(released.heard)})`);
    unaSock.ws.close();

    // ── 7. a join by request, in the other keepers' objection window and after it ────────────────────────
    console.log('── 7. a confirmed member\'s join, as the keepers, the admin and she read it ──');
    // Shed: Lee leads it and Mo keeps it. Zoe, confirmed, with about 100 of earned credit, asks to join with 400: that much
    // of it named, the rest from her known grant. Lee approves, which opens Mo's 3-day window to object.
    const shed = makeEnterprise('Shed', [{ id: lee, backing: 0 }, { id: mo, backing: 0 }]);
    db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(shed, lee.pk);
    const zoe = makeMember('Zoe');
    const zoeEarned = giveEarnedCredit(zoe, 100);
    const zoeKnown = 400 - zoeEarned;
    confirm(zoe, ada);
    assert(zoeEarned > 0 && zoeEarned < 400, `Zoe has earned ${zoeEarned} of credit by trading, less than the 400 she will pledge`);
    const zoeAsks = await call('POST', zoe, `/api/enterprise/${shed}/keepers/request`, { pledgedBacking: 400 });
    const zoeApproved = await call('POST', lee, `/api/enterprise/${shed}/keepers/requests/${zoeAsks.body?.request?.id}/approve`, {});
    assert(zoeAsks.status === 200 && zoeApproved.status === 200 && zoeApproved.body?.applied === false && zoeApproved.body?.change?.pledgedBacking === 400,
        `Lee, Shed's lead, approves Zoe's 400: the window opens, and the answer gives Lee, who decides it, the whole 400 (${zoeAsks.status} ${show(zoeApproved.body)})`);
    const changeFor = (who: Id, answer: any) => (answer?.keeperChanges ?? []).find((c: any) => c.memberPubkey === who.pk);
    const pageAs = async (who: Id, enterprise: string) => (await call('GET', who, `/api/enterprise/${enterprise}`)).body;
    const moWindow = await pageAs(mo, shed);
    assert(changeFor(zoe, moWindow)?.pledgedBacking === zoeEarned && changeFor(zoe, moWindow)?.namedBackingOnly === true
        && !JSON.stringify(changeFor(zoe, moWindow)).includes(':400') && (moWindow.keeperRequests ?? []).length === 0,
        `Mo, Shed's other keeper, reads Zoe's change with her named ${zoeEarned} only, never 400 (pledgedBacking ${changeFor(zoe, moWindow)?.pledgedBacking})`);
    const leeWindow = await pageAs(lee, shed);
    const leeOpen = (leeWindow.keeperRequests ?? []).find((r: any) => r.memberPubkey === zoe.pk);
    assert(leeOpen?.pledgedBacking === 400 && leeOpen?.pendingChange?.pledgedBacking === 400 && changeFor(zoe, leeWindow)?.pledgedBacking === 400
        && changeFor(zoe, leeWindow)?.namedBackingOnly !== true,
        `Lee, who decides it, reads the open request and its change whole, 400 on each (${show([leeOpen?.pledgedBacking, changeFor(zoe, leeWindow)])})`);
    const adaWindow = await pageAs(ada, shed);
    assert(changeFor(zoe, adaWindow)?.pledgedBacking === 400, `Ada (admin) reads Zoe's change whole, 400 (${show(changeFor(zoe, adaWindow))})`);
    const zoeWindow = await pageAs(zoe, shed);
    assert(zoeWindow.myPendingRequest?.pledgedBacking === 400 && zoeWindow.myPendingRequest?.pendingChange?.pledgedBacking === 400,
        `Zoe reads her own request and its change whole, 400 (${show(zoeWindow.myPendingRequest?.pendingChange)})`);

    // The window ends; Mo's next read applies it, and the one after reads it applied.
    db.prepare('UPDATE enterprise_keeper_changes SET applies_at = ? WHERE enterprise_pubkey = ? AND member_pubkey = ?').run(ago(60_000), shed, zoe.pk);
    await pageAs(mo, shed);
    const moAfter = await pageAs(mo, shed);
    const zoeSplit = db.prepare("SELECT id LIKE 'known:%' AS known, SUM(amount) AS s FROM enterprise_pledges WHERE enterprise = ? AND keeper = ? AND released_at IS NULL GROUP BY 1 ORDER BY 1")
        .all(shed, zoe.pk) as { known: number; s: number }[];
    assert(!!keeperOf(moAfter.keepers, zoe) && show(zoeSplit) === show([{ known: 0, s: zoeEarned }, { known: 1, s: zoeKnown }]),
        `the window ends: Zoe keeps Shed, with ${zoeEarned} named and ${zoeKnown} known (${show(zoeSplit)})`);
    for (const query of ['?status=approved', '']) {
        const listed = await call('GET', lee, `/api/enterprise/${shed}/keepers/requests${query}`);
        const row = (listed.body?.requests ?? []).find((r: any) => r.memberPubkey === zoe.pk);
        const named = (moAfter.pledges as Pledge[]).filter(p => p.keeper === zoe.pk).reduce((s, p) => s + p.amount, 0);
        assert(listed.status === 200 && row?.status === 'approved' && row.pledgedBacking === zoeEarned && row.namedBackingOnly === true && row.pledgedBacking - named === 0,
            `Lee's requests (${query || 'all'}): Zoe's approved request reads her named ${zoeEarned}, never 400; less her named pledges, 0 (pledgedBacking ${row?.pledgedBacking}, named ${named})`);
    }
    const adaListed = await call('GET', ada, `/api/enterprise/${shed}/keepers/requests?status=approved`);
    const adaRow = (adaListed.body?.requests ?? []).find((r: any) => r.memberPubkey === zoe.pk);
    assert(adaListed.status === 200 && adaRow?.pledgedBacking === 400 && adaRow?.namedBackingOnly !== true,
        `Ada (admin) reads Zoe's approved request whole, 400 (${show(adaRow)})`);
    const zoeAfter = await pageAs(zoe, shed);
    assert(keeperOf(zoeAfter.keepers, zoe)?.backing === 400 && keeperOf(moAfter.keepers, zoe)?.backing === zoeEarned,
        `Zoe reads her own keeper row whole, 400; Mo reads it as her named ${zoeEarned} (${keeperOf(zoeAfter.keepers, zoe)?.backing}, ${keeperOf(moAfter.keepers, zoe)?.backing})`);
    assertFolded('Mo, Shed after Zoe joins', moAfter, zoeKnown, [zoe]);

    // ── 8. a join the other keeper objects to ────────────────────────────────────────────────────────
    console.log('── 8. a confirmed member\'s join that a keeper objects to ──');
    // Ivy, confirmed, with no earned credit, asks to join with 200, all of it from her known grant. Lee approves; Mo objects.
    const ivy = makeMember('Ivy');
    confirm(ivy, ada);
    const ivyAsks = await call('POST', ivy, `/api/enterprise/${shed}/keepers/request`, { pledgedBacking: 200 });
    const ivyApproved = await call('POST', lee, `/api/enterprise/${shed}/keepers/requests/${ivyAsks.body?.request?.id}/approve`, {});
    const moIvy = changeFor(ivy, await pageAs(mo, shed));
    assert(ivyApproved.body?.applied === false && moIvy?.pledgedBacking === 0 && moIvy?.namedBackingOnly === true,
        `Lee approves Ivy's 200; Mo reads her change with no named backing, never 200 (${show(moIvy)})`);
    const objected = await call('POST', mo, `/api/enterprise/${shed}/keepers/changes/${moIvy?.id}/object`, {});
    assert(objected.status === 200 && objected.body?.change?.status === 'objected' && objected.body?.change?.pledgedBacking === 0
        && objected.body?.change?.namedBackingOnly === true,
        `Mo objects: the answer gives him the closed change with no named backing, never 200 (${objected.status} ${show(objected.body?.change)})`);
    const leeDeclined = (await call('GET', lee, `/api/enterprise/${shed}/keepers/requests?status=declined`)).body?.requests?.find((r: any) => r.memberPubkey === ivy.pk);
    assert(leeDeclined?.status === 'declined' && leeDeclined.pledgedBacking === 0 && leeDeclined.namedBackingOnly === true,
        `Lee reads Ivy's declined request with nothing named, never 200 (${show(leeDeclined)})`);
    const adaDeclined = (await call('GET', ada, `/api/enterprise/${shed}/keepers/requests?status=declined`)).body?.requests?.find((r: any) => r.memberPubkey === ivy.pk);
    assert(adaDeclined?.pledgedBacking === 200, `Ada (admin) reads Ivy's declined request whole, 200 (${show(adaDeclined)})`);

    // ── 9. a confirmed keeper who also has earned credit releases part of his pledge ─────────────────────
    console.log('── 9. a confirmed keeper with earned credit releases inside his known part, then past it ──');
    // Barn: Lee backs it with 100 of his own. Zed, confirmed, with about 100 of earned credit, pledges 40 of it, then 260
    // more: the rest of his earned credit named, the remainder from his known grant.
    const zed = makeMember('Zed');
    const zedEarned = giveEarnedCredit(zed, 100);
    confirm(zed, ada);
    const barn = makeEnterprise('Barn', [{ id: lee, backing: 100 }, { id: zed, backing: 0 }]);
    earnedPledge(barn, lee, 100);
    // Five live offers each, so Barn's and Zed's usable floors read their whole lines, not the offer bands' first steps.
    for (const author of [barn, zed.pk]) {
        for (let i = 0; i < 5; i++) {
            db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active) VALUES (?, 'offer', 'misc', 'goods', 'goods', 10, ?, 'active', 1)`)
                .run(`post-${crypto.randomUUID()}`, author);
        }
    }
    const zedFirst = await call('POST', zed, `/api/enterprise/${barn}/backing`, { amount: 40 });
    const zedTopUp = await call('POST', zed, `/api/enterprise/${barn}/backing`, { amount: 260 });
    const zedStart = figuresOf(barn, zed);
    assert(zedFirst.status === 200 && zedTopUp.status === 200 && zedEarned > 40 && zedStart.earned === zedEarned && zedStart.known === 300 - zedEarned,
        `Zed pledges 40, then 260: ${zedEarned} of it named, ${300 - zedEarned} known (${zedFirst.status} ${zedTopUp.status} ${show(zedStart)})`);
    // The top-up wrote a named row and a known row in one write: the residual Rule 3 records ("What folding cannot hide").
    console.log(`  (residual, Rule 3) the 260 wrote a named row beside its known part, at one moment: ${show(db.prepare(
        "SELECT id LIKE 'known:%' AS known, amount, pledged_at FROM enterprise_pledges WHERE enterprise = ? AND keeper = ? ORDER BY rowid").all(barn, zed.pk))}`);

    /** Zed's named pledges to Barn as Una reads them on the page and the pledges route, his earned rows as stored, the fold. */
    const zedAsUnaReads = async () => {
        const reads = await readAs(una, barn);
        return {
            detail: (reads.detail.pledges as Pledge[]).filter(p => p.keeper === zed.pk),
            pledges: (reads.pledges.pledges as Pledge[]).filter(p => p.keeper === zed.pk),
            stored: db.prepare("SELECT id, amount, pledged_at, released_at FROM enterprise_pledges WHERE enterprise = ? AND keeper = ? AND id NOT LIKE 'known:%' ORDER BY rowid").all(barn, zed.pk),
            fold: folded(reads.detail.pledges)[0]?.amount ?? 0,
        };
    };
    /** One release by Zed over HTTPS, and what main's release of the same amount on the same rows leaves (asMainReleases). */
    const zedReleases = async (amount: number) => {
        const before = await zedAsUnaReads();
        const onMain = asMainReleases(barn, zed, amount);
        const res = await call('POST', zed, `/api/enterprise/${barn}/backing/release`, { amount });
        return { res, before, after: await zedAsUnaReads(), onMain, figures: figuresOf(barn, zed) };
    };
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const brief = (rows: any[]) => show(rows.map(p => [p.id.slice(0, 8), p.amount, p.pledgedAt ?? p.pledged_at, p.released_at].filter(v => v !== undefined)));
    const assertNamedUntouched = (label: string, r: Awaited<ReturnType<typeof zedReleases>>) => {
        assert(r.after.detail.length > 0 && same(r.after.detail, r.before.detail) && same(r.after.pledges, r.before.pledges),
            `${label}: the named pledges Una re-reads are byte-identical, same ids, amounts and dates (before ${brief(r.before.detail)}, after ${brief(r.after.detail)})`);
        assert(same(r.after.stored, r.before.stored),
            `${label}: Zed's earned rows as stored are untouched, none released or written (before ${brief(r.before.stored)}, after ${brief(r.after.stored)})`);
    };
    const assertAsMain = (label: string, r: Awaited<ReturnType<typeof zedReleases>>, earned: number, known: number) => {
        assert(r.figures.earned === earned && r.figures.known === known && r.figures.allowance === 100 + earned + known,
            `${label}: ${earned} named and ${known} known stay pledged, Barn's allowance ${100 + earned + known} (${show(r.figures)})`);
        assert(same(r.figures, r.onMain),
            `${label}: the sums, the allowance and every floor are main's for the same release (${show(r.onMain)})`);
    };

    // 9a. 50 of his known part: only the known rows are written again.
    const inside = await zedReleases(50);
    assert(inside.res.status === 200 && inside.before.fold === 300 - zedEarned && inside.after.fold === 250 - zedEarned,
        `9a. Zed releases 50, inside his known part: the fold Una re-reads moves ${inside.before.fold} → ${inside.after.fold} (${inside.res.status} ${show(inside.res.body)})`);
    assertNamedUntouched('9a', inside);
    assertAsMain('9a', inside, zedEarned, 250 - zedEarned);

    // 9b. exactly the rest of his known part: the fold goes, his named pledges stay as they were.
    const exact = await zedReleases(250 - zedEarned);
    assert(exact.res.status === 200 && exact.after.fold === 0 && exact.figures.known === 0,
        `9b. Zed releases the rest of his known part, ${250 - zedEarned}: the fold Una re-reads moves ${exact.before.fold} → none (${exact.res.status})`);
    assertNamedUntouched('9b', exact);
    assertAsMain('9b', exact, zedEarned, 0);

    // 9c. past his known part: the known part goes first, then the earned rows as before (pledged again under a new id).
    const zedAgain = await call('POST', zed, `/api/enterprise/${barn}/backing`, { amount: 100 });
    const again = figuresOf(barn, zed);
    assert(zedAgain.status === 200 && again.earned === zedEarned && again.known === 100,
        `9c. Zed pledges 100 again, all of it known (his earned credit is all pledged) (${zedAgain.status} ${show(again)})`);
    const past = await zedReleases(130);
    assert(past.res.status === 200 && past.after.fold === 0 && past.res.body?.releasedAmount === 130,
        `9c. Zed releases 130, past his known 100: the fold moves ${past.before.fold} → none (${past.res.status} ${show(past.res.body)})`);
    assertAsMain('9c (the known 100 first, then 30 of the earned)', past, zedEarned - 30, 0);
    const adaBarn = await readAs(ada, barn);
    assert(knownRows(adaBarn.detail.pledges).filter(p => p.keeper === zed.pk).length === 0
        && (adaBarn.detail.pledges as Pledge[]).filter(p => p.keeper === zed.pk).reduce((s, p) => s + p.amount, 0) === zedEarned - 30,
        `9c. Ada (admin) reads none of Zed's known pledges left, and ${zedEarned - 30} of his earned (${show(adaBarn.detail.pledges)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
