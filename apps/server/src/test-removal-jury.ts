/**
 * Removal by a drawn jury, slice J1: the draw and the roll (scratch/fable-design/DESIGN-removal-jury-fable.md §2–§6, §11;
 * Marty accepted all ten answers 29 Oct). In a community whose owners chose it, a pause made where the eligible pool is
 * at or over the line draws a jury of 12 (core juryDraw), passes over everyone with a conflict, records the draw on the
 * vote (params.decider, params.jury) and its pool and roll on the node, and only the jury's votes count.
 *
 * And slice J2a, who serves and the closed record (scratch/fable-design/DESIGN-removal-jury-j2-calls-fable.md, Marty 4 Nov
 * "All Fable's picks"): a frozen member is in the pool and a seated one votes (call 1); the admin who paused is in the pool
 * and stood aside at the walk (call 1); after close the record is two lists, `voted` and `didNotServe`, and the reader's
 * own seat is `seated`, `not_seated` or null (call 2); a completed loan stands its lender aside (call 3); the vote records
 * the key it was drawn for and the closed lists each entry's `drawnAs`, so a re-key still checks out (§5.1); a jury's
 * tally carries `turnout` (§5.5).
 *
 * Boots the real server. The setting goes through the owners' real route; the vote's card and the jury are read through
 * the real signature middleware. Expo is answered here; nothing leaves this machine.
 *
 *  1. Behind the setting: on a 150-member node with no choice made, a pause is decided by everyone, as before (J1 ships
 *     behind the setting until the apps can show a jury, slice J3).
 *  2. Who decides a removal: an owner sets Automatic; A jury is locked (pool_too_small) while fewer than 36 could serve.
 *  3. The draw on 150 members: the pool is exactly the members of 30 days (never the subject or a newcomer; the admin
 *     pausing them and a frozen account are in it, J2a), and its hash is the one worked out from the public People list;
 *     the jury's size and rule on the vote; every member with a conflict Sam can't make alone, at the head of the draw,
 *     stood aside (a reporter, the inviter, an invitee, one who blocked Sam, a deal completed in 90 days, a loan the member
 *     lent Sam, an open deal they opened, a chat they opened, kept for them alone because Sam blocks them or not), and the
 *     admin who paused; one whose trade or loan is older than 90 days seated; what Sam does alone stands nobody aside
 *     (Marty, 3 Nov: five Sam blocked, a chat and a deal request Sam sent that nobody answered); the roll is the head of
 *     the draw, and it checks out with core's checkJuryDraw.
 *  4. Only the jury votes: a member not drawn and one passed over are refused; a juror votes; a vote row written for anyone
 *     off the roll is not counted. While open members read the turnout, never the split, and `turnout` beside it; the push
 *     goes to the jury and the member, nobody else.
 *  5. GET /api/commons/decisions/:id/jury through the middleware: a member reads the pool and the facts and can recompute
 *     the draw; a juror reads `seated`; nobody else is named while open; a member Sam blocked reads exactly what a juror
 *     with no link to Sam reads, and one passed over, the admin who paused among them, reads exactly what a member not
 *     drawn reads; a non-member and an unsigned caller are refused; a vote no jury decides is a 404.
 *  6. The tally over the roll (§5): 6 Yes to 3 No removes (the grace window opens), 5 to 4 doesn't and the pause lifts,
 *     8 votes is too few and the pause lifts. Closed, two lists and no more (J2a): who voted, never which way, and who
 *     didn't serve, never why, in draw order and each entry alike; and the two together still check out.
 *  7. The line: 99 in the pool is decided by everyone, 100 by a jury; Everyone set is everyone at 150.
 *  8. Votes off: a pause opens no vote and draws nobody.
 *  9. A node from before: decision_electors' CHECK gains the jury's statuses at boot, its rows kept.
 * 10. A branch vote with a jury rule (director's call for J1, 3 Nov): the whole community decides an owner's branch pause
 *     (removal by vote S5) as S5 built it, with no draw, roll or stand-asides; one member's pause in the same community is
 *     still the jury's.
 * 11. J2a, who serves: a freeze moves no roster (freeze two members, pause, unfreeze one: the hash worked out before the
 *     freeze); a frozen juror's signed vote counts; the admin who paused is in the served pool and, closed, among those who
 *     didn't serve; an owner pausing the same member the same day draws from the same roster; a juror and the member
 *     re-keyed since still check out, by `drawnAs` and the key the vote recorded.
 *
 * Run (as test-all does, through scripts/run-server-suites.mjs):
 *   SERVER_SUITES_ONLY=test-removal-jury node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_ROLE;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_OFFBOX_') || k.startsWith('ALERTS_WEBHOOK_')) delete process.env[k];

import crypto from 'node:crypto';
import { checkJuryDraw, juryOrder, juryRosterHash, jurySnapshotAt, jurySnapshotDate } from '@beanpool/core';

// Expo is answered here; nothing else off this machine is reached.
const realFetch = globalThis.fetch;
const pushes: Array<{ to: string[]; k: string }> = [];
/** Every message sent to Expo, one per phone: what leaves this machine, word for word (section 12). */
const sent: Array<{ to: string; k: string; title: string; body: string; data: unknown }> = [];
const offMachine: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    if (url.hostname === 'exp.host') {
        const batch = JSON.parse(String(init?.body ?? '[]')) as any[];
        pushes.push({ to: batch.map((m) => m.to), k: batch[0]?.data?.k });
        for (const m of batch) sent.push({ to: m.to, k: m.data?.k, title: m.title, body: m.body, data: m.data });
        return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    offMachine.push(url.hostname);
    throw new Error(`test-removal-jury: refused a request off this machine: ${url.hostname}`);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pk: string; privateKey: crypto.KeyObject; callsign: string; token: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { pk, privateKey, callsign, token: `ExponentPushToken[rj-${crypto.randomBytes(6).toString('hex')}]` };
}

function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

type Answer = { status: number; text: string; body: any };
async function answerOf(res: Response): Promise<Answer> {
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body };
}

let BASE = '';
async function signed(method: 'GET' | 'POST', p: string, id: Id | null, payload?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return answerOf(await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(id ? signedHeaders(method, p, body, id) : {}), ...headers },
        ...(body ? { body } : {}),
    }));
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ADMIN_PW = 'Removal-Jury-Admin-Pw-71!';

async function main() {
    console.log('Removal by a drawn jury (J1): the draw, the roll, the tally over it, the route and the setting...\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const de = await import('./decisions-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { db } = await import('./db/db.js');
    const { setSwitchOverride } = await import('./config/node-profile.js');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { ownerSessionHeaders } = await import('./admin-auth-test-harness.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { setSimulatedDiskUsageForTesting } = await import('./engine/storage-health.js');
    const { readShape } = await import('./config/community-shape.js');
    const { readCommunitySettings } = await import('./config/community-settings.js');

    await initTls();
    se.initStateEngine();
    setSimulatedDiskUsageForTesting(10);
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, communityName: 'Jury Test Commons' });
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const fresh = () => { resetAdminAuthTarpit(); resetAdminRateLimit(); resetGatewayRateLimit(); };

    // ── The people: 150 members of 60 days, an owner and an admin among them ────────────────────────────────────────
    const gen = keypair('GenesisGwen');
    se.seedGenesisMember(gen.pk, gen.callsign);
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(60 * DAY), gen.pk);
    // A phone, as every member here has: Gwen is in every pool, and a draw that seats her must find a phone to push to.
    se.registerPushToken(gen.pk, gen.token, 'android');
    const seedMember = (callsign: string, joinedDaysAgo = 60): Id => {
        const id = keypair(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(id.pk, callsign, ago(joinedDaysAgo * DAY), gen.pk, `INV-${callsign.toUpperCase()}`);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        se.registerPushToken(id.pk, id.token, 'android');
        return id;
    };
    const ada = seedMember('AdminAda');
    grantNodeRole(ada.pk, 'admin', gen.pk);
    const members: Id[] = [gen, ada];
    for (let i = 0; i < 148; i++) members.push(seedMember(`Member${String(i).padStart(3, '0')}`));
    // Not in any pool: two who joined 10 days ago. And one whose credit an admin froze, who is in every pool: a freeze is
    // private and any admin's, so it shapes no jury (J2a, call 1).
    const newcomers = [seedMember('NewNed', 10), seedMember('NewNia', 10)];
    const frozen = seedMember('FrozenFay');
    db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(frozen.pk);
    const byKey = new Map([...members, ...newcomers, frozen].map(m => [m.pk, m]));
    const ownerSession = ownerSessionHeaders(gen.pk);

    const today = jurySnapshotDate(Date.now());
    /**
     * The pool, worked out here from who was seeded rather than by the code under test: the members of 60 days who are
     * active, or paused with nothing but their own open vote holding them, one member's or a branch's whose card lists
     * them (never one in a removal's grace window). A frozen member too (J2a).
     */
    const namesSql = (d: string) => `(${d}.subject = m.public_key OR (${d}.subject IS NULL AND EXISTS (
        SELECT 1 FROM json_each(${d}.params, '$.branch') b WHERE json_extract(b.value, '$.pubkey') = m.public_key)))`;
    const expectedPool = (exclude: Id[]) => {
        const out = new Set(exclude.map(e => e.pk));
        const live = new Set((db.prepare(`
            SELECT public_key FROM members m WHERE m.status = 'active' OR (m.status = 'disabled'
              AND EXISTS (SELECT 1 FROM decisions d WHERE ${namesSql('d')} AND d.status = 'open' AND d.effect = 'remove_member')
              AND NOT EXISTS (SELECT 1 FROM decisions g WHERE ${namesSql('g')} AND g.status = 'execution_pending_grace'))
        `).all() as Array<{ public_key: string }>).map(r => r.public_key));
        const old = new Set((db.prepare('SELECT public_key FROM members WHERE julianday(joined_at) <= julianday(?)').all(ago(31 * DAY)) as Array<{ public_key: string }>)
            .map(r => r.public_key));
        return [...members, frozen].filter(m => !out.has(m.pk) && live.has(m.pk) && old.has(m.pk)).map(m => m.pk);
    };
    const row = (decisionId: string): any => db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
    const paramsOf = (decisionId: string): any => JSON.parse(row(decisionId).params);
    const rollOf = (decisionId: string) => db.prepare('SELECT member_pubkey AS k, status, role_at_open AS role FROM decision_electors WHERE decision_id = ?')
        .all(decisionId) as Array<{ k: string; status: string; role: string }>;
    const poolRowOf = (decisionId: string) => (db.prepare('SELECT pool FROM decision_jury_pools WHERE decision_id = ?').get(decisionId) as { pool: string } | undefined)?.pool;
    const pauseOf = (who: Id, reason = `A case against ${who.callsign} for this check`): string => {
        const r = de.adminEmergencySuspend(who.pk, ada.pk, reason, { freshProof: true });
        if (!r.success || !r.decision) throw new Error(`setup: could not pause ${who.callsign}: ${r.error}`);
        return r.decision.id;
    };
    const statusOf = (id: Id) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(id.pk) as { status: string }).status;
    const closeNow = (id: string) => {
        db.prepare('UPDATE decisions SET closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
        de.tickDecisions();
    };
    const setDecider = async (to: unknown) => {
        fresh();
        return answerOf(await fetch(`${BASE}/api/local/admin/community-shape`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...ownerSession }, body: JSON.stringify({ changes: { removalDecider: to } }),
        }));
    };
    let subjects = 0;
    /** A member of the pool to be the subject of the next case. */
    const nextSubject = () => members[2 + subjects++];
    /**
     * The next subject, from those left, for whom `ok` holds of the draw a pause today would make (keys are fresh each
     * run, so the draw is too): swapped to the front of those left, so nextSubject goes on from there.
     */
    const subjectWhere = (ok: (candidate: Id) => boolean): Id => {
        for (let i = 2 + subjects; i < members.length; i++) {
            if (!ok(members[i])) continue;
            [members[2 + subjects], members[i]] = [members[i], members[2 + subjects]];
            return nextSubject();
        }
        throw new Error('setup: no member left that fits as the subject');
    };
    /** Every key in a JSON value's objects, at any depth. */
    const keysIn = (v: unknown, out = new Set<string>()): Set<string> => {
        if (Array.isArray(v)) for (const x of v) keysIn(x, out);
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); }
        return out;
    };

    // ── 1. Behind the setting ───────────────────────────────────────────────────────────────────────────────────────
    console.log('1. Behind the setting: no choice made, everyone decides, even at 150');
    const shape0 = readShape().settings.removalDecider;
    assert(shape0.configured === 'everyone' && shape0.value === 'everyone' && shape0.source === 'default' && shape0.lock === null && shape0.poolSize === 151,
        `How this community works reads Who decides a removal: everyone, the default for now, no lock, 151 could serve, FrozenFay among them (${JSON.stringify(shape0)})`);
    const plain = nextSubject();
    const plainVote = pauseOf(plain);
    assert(paramsOf(plainVote).decider === 'everyone' && !('jury' in paramsOf(plainVote)), `the pause's vote says everyone decides it (${JSON.stringify(paramsOf(plainVote).decider)})`);
    assert(rollOf(plainVote).length === 0 && poolRowOf(plainVote) === undefined, 'no roll and no pool are kept for it');
    assert(de.tallyDecision(plainVote).decider === undefined && de.tallyDecision(plainVote).quorumRequired >= 3, "its tally is today's: no jury in it");
    de.adminLiftSuspension(plain.pk, ada.pk);
    // An owner choosing Everyone while Everyone is still the default: kept as a row all the same (review of #2793), so J3's
    // change of default leaves this community on Everyone. Quietly: no rule changed, so no log line and no notice.
    const countOf = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    const logRowsBefore = countOf('SELECT COUNT(*) AS c FROM community_settings_log');
    const noticesBefore0 = countOf('SELECT COUNT(*) AS c FROM moderation_notices');
    const asDefault = await setDecider('everyone');
    const asRow = readShape().settings.removalDecider;
    assert(asDefault.status === 200 && asDefault.body?.told === 'nobody' && asRow.configured === 'everyone' && asRow.source === 'owner'
        && readCommunitySettings().nodeConfig.removal_decider === 'everyone',
        `an owner choosing Everyone on the default keeps it as a row: 200, source owner (${asDefault.status} ${JSON.stringify(asRow)})`);
    assert(countOf('SELECT COUNT(*) AS c FROM community_settings_log') === logRowsBefore && countOf('SELECT COUNT(*) AS c FROM moderation_notices') === noticesBefore0,
        'and quietly: no owner log line, nothing told to members');

    // ── 2. Who decides a removal ────────────────────────────────────────────────────────────────────────────────────
    console.log('\n2. Who decides a removal: the owners set it; A jury is locked while fewer than 36 could serve');
    const wrong = await setDecider('sometimes');
    assert(wrong.status === 400 && wrong.body?.setting === 'removalDecider', `a rule that isn't one is refused, 400 (${wrong.status} ${wrong.body?.error})`);
    // 29 of the 150 kept, and FrozenFay, whose freeze no longer keeps her out (J2a): 30 who could serve.
    const tooRecent = members.slice(29).map(m => m.pk);
    const joinedOf = new Map(tooRecent.map(k => [k, (db.prepare('SELECT joined_at FROM members WHERE public_key = ?').get(k) as { joined_at: string }).joined_at]));
    db.prepare(`UPDATE members SET joined_at = ? WHERE public_key IN (${tooRecent.map(() => '?').join(',')})`).run(ago(5 * DAY), ...tooRecent);
    const locked = readShape().settings.removalDecider;
    assert(locked.lock?.code === 'pool_too_small' && locked.poolSize === 30, `with 30 who could serve, a frozen member among them, A jury is locked: pool_too_small (${JSON.stringify(locked.lock)})`);
    const refusedJury = await setDecider('jury');
    assert(refusedJury.status === 409 && refusedJury.body?.code === 'pool_too_small', `an owner choosing A jury then is refused, 409 pool_too_small (${refusedJury.status} ${refusedJury.body?.code})`);
    for (const [k, at] of joinedOf) db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(at, k);
    const noticesBefore = (db.prepare('SELECT COUNT(*) AS c FROM moderation_notices').get() as { c: number }).c;
    const auto = await setDecider('automatic');
    assert(auto.status === 200 && auto.body?.shape?.settings?.removalDecider?.configured === 'automatic' && auto.body?.shape?.settings?.removalDecider?.lock === null,
        `an owner sets Automatic: 200 (${auto.status} ${auto.body?.error ?? ''})`);
    const told = db.prepare('SELECT body FROM moderation_notices ORDER BY rowid DESC LIMIT 1').get() as { body: string } | undefined;
    assert((db.prepare('SELECT COUNT(*) AS c FROM moderation_notices').get() as { c: number }).c > noticesBefore && told?.body?.includes('a jury of members drawn at random'),
        `members are told, in the fixed sentence (${JSON.stringify(told?.body)})`);
    assert(readCommunitySettings().nodeConfig.removal_decider === 'automatic', 'the record a standby keeps carries it');
    const logged = db.prepare("SELECT old_value, new_value FROM community_settings_log WHERE setting = 'removalDecider'").all() as Array<{ old_value: string; new_value: string }>;
    assert(logged.length === 1 && logged[0].old_value === 'everyone' && logged[0].new_value === 'automatic', `one owner log line: everyone → automatic (${JSON.stringify(logged)})`);

    // ── 3. The draw on 150 members ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n3. The draw: the pool, the stand-asides, the roll');
    // The admin who pauses is in the pool now, passed over at the walk (J2a, call 1): Sam is a member for whom the walk
    // reaches Ada, and FrozenFay falls beyond it (she is seated wherever the draw puts her; section 11 seats a frozen juror).
    const orderFor = (who: Id) => juryOrder(expectedPool([who]), who.pk, today).order;
    const sam = subjectWhere(c => {
        const o = orderFor(c);
        return o.indexOf(ada.pk) >= 0 && o.indexOf(ada.pk) < 20 && o.indexOf(frozen.pk) > 30;
    });
    const pool = expectedPool([sam]);
    const { order } = juryOrder(pool, sam.pk, today);
    // The draw without Ada, who stands aside wherever she falls in it.
    const heads = order.filter(k => k !== ada.pk);
    const at = (i: number) => byKey.get(heads[i])!;
    // The head of the draw, each with a conflict only this node knows of. at(9)'s deal with Sam is older than 90 days.
    const post = crypto.randomUUID();
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, created_at, updated_at, search_keywords)
                VALUES (?, 'offer', 'food', 'Plums', '', 5, ?, 'active', 1, ?, ?, 'plums')`).run(post, sam.pk, ago(DAY), ago(DAY));
    db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, status, created_at) VALUES (?, ?, ?, ?, 'A report of the plums', 'pending', ?)`)
        .run(crypto.randomUUID(), at(0).pk, gen.pk, post, ago(DAY));
    db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(at(1).pk, sam.pk);
    db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(sam.pk, at(2).pk);
    const block = db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)');
    block.run(at(4).pk, sam.pk);
    const deal = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at, updated_at)
                             VALUES (?, ?, ?, ?, 5, ?, ?, ?, ?)`);
    deal.run(crypto.randomUUID(), post, at(5).pk, sam.pk, 'completed', ago(20 * DAY), ago(20 * DAY), ago(20 * DAY));
    // at(6) asked for Sam's plums: an open deal they opened.
    deal.run(crypto.randomUUID(), post, at(6).pk, sam.pk, 'pending', ago(DAY), null, ago(DAY));
    deal.run(crypto.randomUUID(), post, at(9).pk, sam.pk, 'completed', ago(120 * DAY), ago(120 * DAY), ago(120 * DAY));
    const dm = (opener: Id, other: Id, createdAt = ago(DAY)) => {
        const id = crypto.randomUUID();
        db.prepare("INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'dm', ?, ?)").run(id, opener.pk, createdAt);
        db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?), (?, ?)').run(id, opener.pk, id, other.pk);
        return id;
    };
    dm(at(7), sam);
    // What Sam can do alone, to steer the draw (review of #2793, Marty's answer of 3 Nov): Sam blocks five of the members
    // the draw would seat first; opens a chat with at(13), who never answers; and asks for a deal on at(14)'s listing,
    // which nobody answers. None of it stands anyone aside.
    const samBlocks = [3, 8, 10, 11, 12].map(at);
    for (const b of samBlocks) block.run(sam.pk, b.pk);
    const unanswered = dm(sam, at(13));
    db.prepare("INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, timestamp) VALUES (?, ?, ?, 'c', 'n', ?)")
        .run(crypto.randomUUID(), unanswered, sam.pk, ago(DAY));
    const theirPost = crypto.randomUUID();
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, created_at, updated_at, search_keywords)
                VALUES (?, 'offer', 'food', 'Pears', '', 5, ?, 'active', 1, ?, ?, 'pears')`).run(theirPost, at(14).pk, ago(DAY), ago(DAY));
    deal.run(crypto.randomUUID(), theirPost, sam.pk, at(14).pk, 'requested', ago(DAY), null, ago(DAY));
    // And Sam accepts at(17)'s free Offer in one step and confirms it as the buyer, through the real escrow code: a completed
    // deal, and its trade chat, Sam made alone (reviews of #2793 rounds 2 and 3). It stands nobody aside. Sam may accept: the
    // Plums are a listed Offer of Sam's.
    const freeOffer = crypto.randomUUID();
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, created_at, updated_at, search_keywords)
                VALUES (?, 'offer', 'food', 'Free lemons', '', 0, ?, 'active', 1, ?, ?, 'lemons')`).run(freeOffer, at(17).pk, ago(DAY), ago(DAY));
    const lemons = se.acceptPost(freeOffer, sam.pk);
    const lemonsDone = se.completePostTransaction(lemons.id, sam.pk);
    const lemonsRow = db.prepare('SELECT buyer_pubkey, seller_pubkey, credits, status FROM marketplace_transactions WHERE id = ?')
        .get(lemons.id) as { buyer_pubkey: string; seller_pubkey: string; credits: number; status: string } | undefined;
    assert(lemonsDone?.status === 'completed' && lemonsRow?.status === 'completed' && lemonsRow.buyer_pubkey === sam.pk
        && lemonsRow.seller_pubkey === at(17).pk && lemonsRow.credits === 0,
        `Sam's one-step accept of at(17)'s free lemons is completed, Sam the buyer, 0 Beans (${JSON.stringify(lemonsRow)})`);
    // A loan (J2a, call 3): Sam asks to borrow at(19)'s drill, at(19) says yes, and Sam gives it back, through the real escrow
    // code. A loan is always asked for and its lender says yes first, so at(19) made this deal too and stands aside. at(20)
    // lent Sam a ladder 120 days ago, and is seated.
    const lendable = (lender: Id, title: string) => {
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, lendable, repeatable, created_at, updated_at, search_keywords)
                    VALUES (?, 'offer', 'tools', ?, '', 0, ?, 'active', 1, 1, 1, ?, ?, ?)`).run(id, title, lender.pk, ago(DAY), ago(DAY), title.toLowerCase());
        return id;
    };
    // Asking for a deal needs a profile photo: Sam picks one of the pictures the apps ship.
    db.prepare("UPDATE members SET avatar_ref = 'bundled://fox' WHERE public_key = ?").run(sam.pk);
    const drill = se.requestPost(lendable(at(19), 'Drill'), sam.pk);
    se.approvePostRequest(drill.id, at(19).pk);
    const drillDone = se.completePostTransaction(drill.id, sam.pk);
    const drillRow = db.prepare('SELECT buyer_pubkey, seller_pubkey, status FROM marketplace_transactions WHERE id = ?')
        .get(drill.id) as { buyer_pubkey: string; seller_pubkey: string; status: string } | undefined;
    assert(drillDone?.status === 'completed' && drillRow?.status === 'completed' && drillRow.buyer_pubkey === sam.pk && drillRow.seller_pubkey === at(19).pk,
        `Sam borrowed at(19)'s drill, at(19) said yes first, and Sam gave it back: completed (${JSON.stringify(drillRow)})`);
    deal.run(crypto.randomUUID(), lendable(at(20), 'Ladder'), sam.pk, at(20).pk, 'completed', ago(120 * DAY), ago(120 * DAY), ago(120 * DAY));
    // A chat a member opened with Sam while Sam blocks them is kept for them alone (engine/withheld-lines.ts); it stands them
    // aside as at(7)'s does, or who stood aside would say who Sam blocks. at(15)'s is still kept; at(16)'s became the real one
    // when Sam, the block lifted, opened a chat with them, under Sam's name: at(16)'s line kept from before is older than it.
    block.run(sam.pk, at(15).pk);
    db.prepare('INSERT INTO withheld_conversations (id, owner_pubkey, other_pubkey, created_at) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), at(15).pk, sam.pk, ago(2 * DAY));
    const promoted = dm(sam, at(16), ago(DAY));
    db.prepare("INSERT INTO withheld_lines (id, conversation_id, author_pubkey, ciphertext, nonce, timestamp) VALUES (?, ?, ?, 'c', 'n', ?)")
        .run(crypto.randomUUID(), promoted, at(16).pk, ago(3 * DAY));
    const asideAt = [0, 1, 2, 4, 5, 6, 7, 15, 16, 19];
    const seatedAt = [3, 8, 9, 10, 11, 12, 13, 14, 17, 18, 20, 21];
    pushes.length = 0;
    const samVote = pauseOf(sam);
    const params = paramsOf(samVote);
    assert(params.decider === 'jury' && params.jury?.snapshotDate === today && params.jury?.size === 12 && params.jury?.mustVote === 9
        && params.jury?.minYes === 6 && params.jury?.poolSize === 150 && params.jury?.subject === sam.pk,
        `the vote records a jury: today's snapshot, 12 seated, 9 must vote, at least 6 Yes, a pool of 150, drawn for Sam's key (${JSON.stringify(params.jury)})`);
    assert(params.jury?.rosterHash === juryRosterHash(pool), 'its roster hash is the hash of the pool worked out here');
    // §2's promise, from what any member reads (J2a, call 1): the People list's rows under the public rule (status active,
    // nobody else being paused yet; joined 30 days before the snapshot's midnight; minus Sam; the list shows no enterprise
    // and there is no visitor here) hash to the roster the vote recorded. No freeze is on any row of it.
    fresh();
    const people = await signed('GET', '/api/community/members', gen);
    const cutoffMs = jurySnapshotAt(today) - 30 * DAY;
    const publicPool = (Array.isArray(people.body) ? people.body : [])
        .filter((p: any) => p.status === 'active' && Date.parse(p.joinedAt) <= cutoffMs && p.publicKey !== sam.pk).map((p: any) => p.publicKey);
    assert(people.status === 200 && juryRosterHash(publicPool) === params.jury?.rosterHash && publicPool.includes(frozen.pk) && publicPool.includes(ada.pk),
        `the hash worked out from the public People list is the vote's, FrozenFay and the admin pausing Sam among its rows (${people.status}, ${publicPool.length} rows)`);
    assert(![...keysIn(people.body)].some(k => /frozen/i.test(k)), 'and nothing on that list says who is frozen');
    const stored = poolRowOf(samVote)?.split('\n') ?? [];
    assert(JSON.stringify(stored) === JSON.stringify([...pool].sort()), `the node keeps that pool, sorted as hashed (${stored.length} keys)`);
    assert(!stored.includes(sam.pk) && !newcomers.some(n => stored.includes(n.pk)) && stored.includes(ada.pk) && stored.includes(frozen.pk),
        'never the subject or a member of 10 days; the admin pausing them and a frozen account are in it (J2a)');
    const roll = rollOf(samVote);
    const aside = roll.filter(r => r.status === 'stood_aside').map(r => r.k);
    const seated = roll.filter(r => r.status === 'on').map(r => r.k);
    const keysAt = (is: number[]) => is.map(i => heads[i]).sort();
    assert(JSON.stringify([...aside].sort()) === JSON.stringify([...keysAt(asideAt), ada.pk].sort()),
        `the reporter, the inviter, an invitee, the one who blocked Sam, the 90-day partner, the lender, the deal and the chats they opened stood aside, and the admin who paused: 11 (${aside.length})`);
    assert(aside.includes(ada.pk) && order.indexOf(ada.pk) < order.indexOf(heads[21]),
        'the admin who paused Sam, reached by the walk, is passed over at it rather than left out of the pool (J2a, call 1)');
    assert(aside.includes(at(19).pk) && seated.includes(at(20).pk),
        'a loan the member lent Sam in the last 90 days stands them aside; one lent 120 days ago seats them (J2a, call 3)');
    assert(samBlocks.every(b => seated.includes(b.pk)),
        `Sam blocked five of the first the draw would seat, and the draw seats all five anyway (${samBlocks.filter(b => seated.includes(b.pk)).length} of 5)`);
    assert(seated.includes(at(13).pk) && seated.includes(at(14).pk),
        'a chat Sam opened that nobody answered, and a deal Sam asked for that nobody answered, stand nobody aside');
    assert(seated.includes(at(17).pk),
        "a deal Sam completed alone, accepting and confirming a member's free Offer as the buyer, stands nobody aside");
    assert(aside.includes(at(7).pk) && aside.includes(at(15).pk) && aside.includes(at(16).pk),
        'a chat the member opened with Sam stands them aside, kept for them alone because Sam blocks them or not');
    assert(JSON.stringify([...seated].sort()) === JSON.stringify(keysAt(seatedAt)) && seated.includes(at(9).pk),
        `the next 12 of the draw are seated, the one whose deal is 120 days old among them (${seated.length})`);
    assert(roll.every(r => r.role === 'juror'), 'every row of the roll is a juror\'s');
    assert(checkJuryDraw({ pool: stored, subject: sam.pk, snapshotDate: today, rosterHash: params.jury.rosterHash, roll: roll.map(r => r.k) }).ok,
        "core's checkJuryDraw: the node's pool and roll check out");

    // ── 4. Only the jury votes ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n4. Only the jury votes, and nobody reads the split while it is open');
    const notDrawn = byKey.get(order[40])!;
    const refusedOff = de.castDecisionVote(samVote, notDrawn.pk, true);
    const refusedAside = de.castDecisionVote(samVote, at(0).pk, true);
    assert(!refusedOff.success && refusedOff.error === de.JURY_ONLY_VOTE_ERROR, `a member not drawn is refused, in the jury's words (${refusedOff.error})`);
    assert(!refusedAside.success && refusedAside.error === de.JURY_ONLY_VOTE_ERROR, 'one who stood aside is refused the same way');
    const onHttp = await signed('POST', `/api/commons/decisions/${samVote}/vote`, notDrawn, { support: true });
    assert(onHttp.status === 400 && onHttp.body?.error === de.JURY_ONLY_VOTE_ERROR, `over the route too, 400 (${onHttp.status} ${onHttp.body?.error})`);
    const jurors = seated.map(k => byKey.get(k)!);
    // Home's Needs you asks only those who can cast it (review of #2793): never a member not drawn, nor one who stood aside,
    // whom the vote refuses all week; a juror who hasn't voted is asked.
    fresh();
    const voteLine = async (who: Id) => ((await signed('GET', '/api/home?cards=needs', who)).body?.cards?.needs?.items ?? [])
        .filter((i: any) => i.kind === 'vote');
    const homeOff = await voteLine(notDrawn);
    const homeAside = await voteLine(at(0));
    const homeJuror = await voteLine(jurors[0]);
    assert(homeOff.length === 0 && homeAside.length === 0,
        `Home asks no member not drawn, and no one who stood aside, to vote (${JSON.stringify([homeOff, homeAside])})`);
    assert(homeJuror.length === 1 && homeJuror[0].count === 1 && String(homeJuror[0].label).includes(sam.callsign) && homeJuror[0].target?.to === 'decide',
        `a juror who hasn't voted is asked, the line naming the member (${JSON.stringify(homeJuror)})`);
    const first = await signed('POST', `/api/commons/decisions/${samVote}/vote`, jurors[0], { support: true });
    assert(first.status === 200 && first.body?.success === true, `a juror votes over the route (${first.status} ${first.body?.error ?? ''})`);
    for (const j of jurors.slice(1, 6)) de.castDecisionVote(samVote, j.pk, true);
    for (const j of jurors.slice(6, 9)) de.castDecisionVote(samVote, j.pk, false);
    // Rows written straight into the table, as a restore or a bug might: someone not drawn and someone passed over, both No.
    const raw = db.prepare(`INSERT INTO decision_votes (decision_id, voter_pubkey, support, weight, credits_used, created_at, updated_at) VALUES (?, ?, 0, 1, 1, ?, ?)`);
    raw.run(samVote, notDrawn.pk, new Date().toISOString(), new Date().toISOString());
    raw.run(samVote, at(1).pk, new Date().toISOString(), new Date().toISOString());
    const t = de.tallyDecision(samVote);
    assert(t.decider === 'jury' && t.totalVoters === 9 && t.yesWeight === 6 && t.noWeight === 3 && t.electorate === 12 && t.quorumRequired === 9,
        `the tally counts the 9 jurors' votes only, never the two rows off the roll (${t.totalVoters} voted, ${t.yesWeight} Yes, ${t.noWeight} No)`);
    fresh();
    const card = await signed('GET', `/api/commons/decisions/${samVote}`, notDrawn);
    assert(card.status === 200 && card.body?.tally?.totalVoters === 9 && card.body?.tally?.electorate === 12
        && !('yesWeight' in card.body.tally) && !('noWeight' in card.body.tally) && !('supportRatio' in card.body.tally) && !('passed' in card.body.tally),
        `a member reads "12 jurors, 9 have voted", never the split (${JSON.stringify(card.body?.tally)})`);
    assert(JSON.stringify(card.body?.tally?.turnout) === JSON.stringify({ voted: 9, size: 12, mustVote: 9 }),
        `and beside it the jury's turnout in its own words, never a Yes or No of 0 (J2a §5.5: ${JSON.stringify(card.body?.tally?.turnout)})`);
    fresh();
    const list = await signed('GET', '/api/commons/decisions', jurors[0]);
    const listed = (list.body?.decisions ?? []).find((d: any) => d.id === samVote);
    assert(listed && !('yesWeight' in listed.tally) && listed.tally.totalVoters === 9, 'the list says the same, to a juror too');
    assert(listed && listed.params?.debt !== undefined && !('debt' in ((card.body?.decision?.params) ?? {})),
        "the member's balance goes to the jury, as it went to a vote's voters, and not to a member not drawn");
    await settle(500);
    // Since J2b the jurors' "a vote opened" is the jury's own push, decision.jury: they were drawn, and are asked to answer.
    const pushedTo = new Set(pushes.filter(p => p.k === 'decision.jury' || p.k === 'decision.removal' || p.k === 'account.removal-vote').flatMap(p => p.to));
    const expectedTokens = new Set([...jurors.map(j => j.token), sam.token]);
    assert(pushedTo.size === expectedTokens.size && [...expectedTokens].every(tk => pushedTo.has(tk)),
        `"a vote opened" goes to the 12 jurors and the member, nobody else (${pushedTo.size} phones)`);

    // ── 5. The jury, through the middleware ─────────────────────────────────────────────────────────────────────────
    console.log('\n5. GET /api/commons/decisions/:id/jury');
    fresh();
    const open = await signed('GET', `/api/commons/decisions/${samVote}/jury`, notDrawn);
    const served = (open.body?.jury?.pool ?? []).map((p: any) => p.publicKey);
    assert(open.status === 200 && open.body.jury.rosterHash === params.jury.rosterHash && served.length === 150 && open.body.jury.you === null
        && open.body.jury.subject === sam.pk,
        `a member reads the pool (150), its hash and the facts, the subject the key it was drawn for; they are on no roll (${open.status})`);
    assert(checkJuryDraw({ pool: served, subject: open.body.jury.subject, snapshotDate: open.body.jury.snapshotDate, rosterHash: open.body.jury.rosterHash }).ok,
        'and can recompute the hash from what was served');
    assert(open.body.jury.pool.every((p: any) => typeof p.callsign === 'string'), 'each with their name, to hold against the People list');
    assert(!('jury' in open.body.jury) && !('stoodAside' in open.body.jury) && !('voted' in open.body.jury), 'while open, nobody on the jury is named');
    fresh();
    const mine = await signed('GET', `/api/commons/decisions/${samVote}/jury`, jurors[2]);
    fresh();
    const mineAside = await signed('GET', `/api/commons/decisions/${samVote}/jury`, at(4));
    // In neutral words (J2a, call 2 point 4): `seated`; and one passed over reads exactly what a member not drawn reads.
    fresh();
    const adaReads = await signed('GET', `/api/commons/decisions/${samVote}/jury`, ada);
    assert(mine.body?.jury?.you === 'seated' && mineAside.body?.jury?.you === null && mineAside.text === open.text && adaReads.text === open.text,
        `a juror reads seated; one passed over, and the admin who paused, read byte for byte what a member not drawn reads (${mine.body?.jury?.you}, ${mineAside.body?.jury?.you}, ${adaReads.body?.jury?.you})`);
    // Nothing a member reads says Sam blocked them (Marty, 3 Nov: no reason shown may reveal a block). A member Sam blocked
    // reads, byte for byte, what a juror with no link to Sam reads; one passed over is told no reason, only where they stand,
    // and is refused a vote in the words a member not drawn is.
    fresh();
    const blockedBySam = await signed('GET', `/api/commons/decisions/${samVote}/jury`, at(3));
    fresh();
    const noLink = await signed('GET', `/api/commons/decisions/${samVote}/jury`, at(17));
    assert(blockedBySam.status === 200 && blockedBySam.text === noLink.text && blockedBySam.body?.jury?.you === 'seated',
        `a member Sam blocked reads exactly what a juror with no link to Sam reads (${blockedBySam.body?.jury?.you})`);
    const juryKeys = (b: any) => Object.keys(b?.jury ?? {}).sort().join(',');
    const refusedBlocker = de.castDecisionVote(samVote, at(4).pk, true);
    assert(juryKeys(mineAside.body) === juryKeys(open.body) && !/block|reason|why/i.test(mineAside.text)
        && refusedBlocker.error === de.JURY_ONLY_VOTE_ERROR && !/block/i.test(String(refusedBlocker.error)),
        `one passed over reads no reason, and is refused as a member not drawn is (${juryKeys(mineAside.body)}; ${refusedBlocker.error})`);
    fresh();
    const stranger = await signed('GET', `/api/commons/decisions/${samVote}/jury`, keypair('Stranger'));
    fresh();
    const unsigned = await signed('GET', `/api/commons/decisions/${samVote}/jury`, null);
    assert(stranger.status >= 400 && stranger.status < 500 && !stranger.text.includes(jurors[0].pk) && unsigned.status >= 400 && unsigned.status < 500 && !unsigned.text.includes(jurors[0].pk),
        `a non-member signer and an unsigned caller are refused, and read no key (${stranger.status}, ${unsigned.status})`);
    fresh();
    const noJury = await signed('GET', `/api/commons/decisions/${plainVote}/jury`, notDrawn);
    assert(noJury.status === 404, `a vote no jury decides has no jury: 404 (${noJury.status})`);

    // ── 6. The tally over the roll ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n6. The tally over the roll: 6 of 9 removes, 5 of 9 does not, 8 votes is too few');
    closeNow(samVote);
    assert(row(samVote).status === 'execution_pending_grace' && statusOf(sam) === 'disabled', `6 Yes to 3 No: the removal's grace window opens, Sam still paused (${row(samVote).status})`);
    fresh();
    const closed = await signed('GET', `/api/commons/decisions/${samVote}/jury`, notDrawn);
    // Two lists and no more (J2a, call 2 point 2): who voted, and who didn't serve, with no status, reason or time.
    const cj = closed.body?.jury ?? {};
    const votedKeys: string[] = (cj.voted ?? []).map((x: any) => x.publicKey);
    const notServed: string[] = (cj.didNotServe ?? []).map((x: any) => x.publicKey);
    const voters = jurors.slice(0, 9).map(j => j.pk);
    assert(closed.status === 200 && Object.keys(cj).filter(k => !(k in open.body.jury)).sort().join(',') === 'didNotServe,voted',
        `closed: two lists are added to what was read while open, voted and didNotServe, and nothing else (${Object.keys(cj).join(', ')})`);
    const forbidden = ['jury', 'stoodAside', 'didNotVote', 'status', 'reason', 'at'].filter(k => keysIn(cj).has(k));
    assert(forbidden.length === 0, `no list of who sat, stood aside or didn't vote, and no status, reason or time anywhere in it (${forbidden.join(', ') || 'none'})`);
    const inDrawOrder = (ks: string[]) => ks.every((k, i) => i === 0 || order.indexOf(ks[i - 1]) < order.indexOf(k));
    assert(JSON.stringify([...votedKeys].sort()) === JSON.stringify([...voters].sort()) && inDrawOrder(votedKeys),
        `voted: the 9 jurors whose votes are the tally, in draw order (${votedKeys.length})`);
    assert(JSON.stringify([...notServed].sort()) === JSON.stringify(roll.map(r => r.k).filter(k => !voters.includes(k)).sort())
        && notServed.length === 14 && inDrawOrder(notServed),
        `didNotServe: everyone else the walk reached, the 11 passed over and the 3 seated who didn't vote, in draw order (${notServed.length})`);
    const entries: any[] = [...(cj.voted ?? []), ...(cj.didNotServe ?? [])];
    assert(entries.every(x => Object.keys(x).sort().join(',') === 'callsign,drawnAs,publicKey' && x.drawnAs === x.publicKey && typeof x.callsign === 'string'),
        'every entry alike: the key, the name, and the key it was drawn as (the same, with no re-key)');
    const alike = [at(0), at(4), ada, jurors[9]];
    const textOf = (k: string) => JSON.stringify(Object.keys((cj.didNotServe ?? []).find((x: any) => x.publicKey === k) ?? {}));
    assert(alike.every(m => notServed.includes(m.pk)) && new Set(alike.map(m => textOf(m.pk))).size === 1,
        'the reporter, one who blocked Sam, the admin who paused and a juror who did not vote are all among those who did not serve, their entries alike');
    assert(!closed.text.includes('"support"') && !JSON.stringify(cj.voted).includes('true'), 'never which way anyone voted');
    // The five Sam blocked were all seated (section 3): each is listed as any juror is, among those who voted if they voted.
    assert(!/block|reason|why/i.test(closed.text) && samBlocks.every(b => votedKeys.includes(b.pk) === voters.includes(b.pk)),
        'who did not serve is named with no reason, and the five Sam blocked are listed as any juror is: with those who voted if they voted');
    const pooled = (cj.pool ?? []).map((p: any) => p.publicKey);
    const checkClosed = (lists: string[][]) => checkJuryDraw({ pool: pooled, subject: cj.subject, snapshotDate: cj.snapshotDate, rosterHash: cj.rosterHash, roll: lists.flat() });
    const asDrawn = (xs: any[] | undefined) => (xs ?? []).map((x: any) => x.drawnAs as string);
    assert(cj.subject === sam.pk && checkClosed([asDrawn(cj.voted), asDrawn(cj.didNotServe)]).ok,
        'and what was served checks out: the two lists together are the head of the draw');
    const movedOne = checkClosed([asDrawn(cj.voted).slice(1), [...asDrawn(cj.didNotServe), asDrawn(cj.voted)[0]]]);
    const droppedOne = checkClosed([asDrawn(cj.voted), asDrawn(cj.didNotServe)].map(l => l.filter(k => k !== order[0])));
    assert(movedOne.ok && !droppedOne.ok && droppedOne.problem === 'order',
        `the lists are a partition, not an order: one name moved between them still checks out; the first of the draw dropped does not (${JSON.stringify(droppedOne)})`);
    fresh();
    const closedCard = await signed('GET', `/api/commons/decisions/${samVote}`, notDrawn);
    assert(closedCard.body?.tally?.yesWeight === 6 && closedCard.body?.tally?.noWeight === 3, 'closed, the totals are read');

    const tia = nextSubject();
    const tiaVote = pauseOf(tia);
    const tiaJury = rollOf(tiaVote).filter(r => r.status === 'on').map(r => r.k);
    for (const k of tiaJury.slice(0, 5)) de.castDecisionVote(tiaVote, k, true);
    for (const k of tiaJury.slice(5, 9)) de.castDecisionVote(tiaVote, k, false);
    closeNow(tiaVote);
    assert(row(tiaVote).status === 'failed' && statusOf(tia) === 'active', `5 Yes to 4 No: not removed, and the pause lifts (${row(tiaVote).status}, ${statusOf(tia)}: ${row(tiaVote).execution_reason})`);

    const uma = nextSubject();
    const umaVote = pauseOf(uma);
    const umaJury = rollOf(umaVote).filter(r => r.status === 'on').map(r => r.k);
    for (const k of umaJury.slice(0, 8)) de.castDecisionVote(umaVote, k, true);
    closeNow(umaVote);
    assert(row(umaVote).status === 'unresolved' && statusOf(uma) === 'active' && /Quorum not met \(8\/9\)/.test(row(umaVote).execution_reason ?? ''),
        `8 votes, all Yes: too few to decide, the pause lifts (${row(umaVote).status}, ${statusOf(uma)}: ${row(umaVote).execution_reason})`);

    // ── 7. The line ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n7. The line: 99 is everyone, 100 a jury; Everyone set is everyone');
    const vic = nextSubject();
    const wil = nextSubject();
    const poolNow = expectedPool([vic]);
    // Members made new enough to leave the pool, until 99 (then 100) could serve.
    const spare = poolNow.filter(k => k !== wil.pk && k !== gen.pk);
    const outOf = (n: number) => spare.slice(0, poolNow.length - n);
    const hide = (keys: string[]) => keys.length && db.prepare(`UPDATE members SET joined_at = ? WHERE public_key IN (${keys.map(() => '?').join(',')})`).run(ago(5 * DAY), ...keys);
    const unhide = (keys: string[]) => keys.length && db.prepare(`UPDATE members SET joined_at = ? WHERE public_key IN (${keys.map(() => '?').join(',')})`).run(ago(60 * DAY), ...keys);
    const hid99 = outOf(99);
    hide(hid99);
    const vicVote = pauseOf(vic);
    assert(paramsOf(vicVote).decider === 'everyone' && rollOf(vicVote).length === 0, `99 could serve: everyone decides (${paramsOf(vicVote).decider})`);
    unhide(hid99);
    const hid100 = expectedPool([wil]).filter(k => k !== gen.pk).slice(0, expectedPool([wil]).length - 100);
    hide(hid100);
    const wilVote = pauseOf(wil);
    assert(paramsOf(wilVote).decider === 'jury' && paramsOf(wilVote).jury?.poolSize === 100 && rollOf(wilVote).filter(r => r.status === 'on').length === 12,
        `100 could serve: a jury of 12 (${paramsOf(wilVote).decider}, pool ${paramsOf(wilVote).jury?.poolSize})`);
    unhide(hid100);
    const toEveryone = await setDecider('everyone');
    assert(toEveryone.status === 200, `an owner sets Everyone (${toEveryone.status})`);
    const xia = nextSubject();
    const xiaVote = pauseOf(xia);
    assert(paramsOf(xiaVote).decider === 'everyone' && rollOf(xiaVote).length === 0, 'with Everyone set, everyone decides at 150');
    assert(paramsOf(wilVote).decider === 'jury' && de.tallyDecision(wilVote).decider === 'jury', 'and the vote opened with a jury keeps it');

    // ── 8. Votes off ────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n8. Votes off: no vote, no draw');
    await setDecider('automatic');
    setSwitchOverride('decisions', false);
    const yan = nextSubject();
    const yanVote = pauseOf(yan);
    assert(row(yanVote).effect === 'keep_suspension' && !('decider' in paramsOf(yanVote)) && rollOf(yanVote).length === 0 && poolRowOf(yanVote) === undefined,
        `a pause with votes off opens no vote and draws nobody (${row(yanVote).effect})`);
    setSwitchOverride('decisions', true);

    // ── 9. A node from before: its roll's CHECK is rebuilt at boot ──────────────────────────────────────────────────
    console.log("\n9. A node from before: decision_electors' CHECK gains the jury's statuses at boot, its rows kept");
    const { initSchema } = await import('./db/db.js');
    const tableSql = () => (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'decision_electors'").get() as { sql: string }).sql;
    const triggers = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'decision_electors' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
    const triggersBefore = triggers();
    const kept = db.prepare("SELECT decision_id, member_pubkey FROM decision_electors WHERE status IN ('on', 'left') ORDER BY decision_id, member_pubkey").all();
    db.exec(`
        CREATE TABLE decision_electors_old (
            decision_id   TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
            member_pubkey TEXT NOT NULL REFERENCES members(public_key) ON DELETE CASCADE,
            role_at_open  TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'on' CHECK (status IN ('on', 'left')),
            created_at    DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at    DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY (decision_id, member_pubkey)
        );
        INSERT INTO decision_electors_old SELECT decision_id, member_pubkey, role_at_open, status, created_at, updated_at
            FROM decision_electors WHERE status IN ('on', 'left');
        DROP TABLE decision_electors;
        ALTER TABLE decision_electors_old RENAME TO decision_electors;
    `);
    assert(!tableSql().includes("'stood_aside'"), "the table is as a node from before has it: 'on' and 'left' only");
    initSchema();
    assert(tableSql().includes("'stood_aside'") && tableSql().includes("'silent'"), "after boot its CHECK takes 'stood_aside' and 'silent'");
    assert(JSON.stringify(db.prepare("SELECT decision_id, member_pubkey FROM decision_electors ORDER BY decision_id, member_pubkey").all()) === JSON.stringify(kept),
        `every row it held is kept (${kept.length})`);
    assert(JSON.stringify(triggers()) === JSON.stringify(triggersBefore) && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_decision_electors_member'").get(),
        `its index and its triggers are back (${triggers().join(', ') || 'no triggers'})`);
    // Wil's roll, which section 7 drew; with none, this fails here rather than throwing, so the sections after it still run.
    db.prepare("UPDATE decision_electors SET status = 'stood_aside' WHERE decision_id = ? AND member_pubkey = ?").run(wilVote, rollOf(wilVote)[0]?.k ?? '');
    assert(rollOf(wilVote)[0]?.status === 'stood_aside', 'and a juror can be stood aside in it');

    // ── 10. A branch vote with a jury rule ──────────────────────────────────────────────────────────────────────────
    // The director's call for J1 (3 Nov, reversible): a branch's vote (removal by vote S5) is decided by the whole community
    // as S5 built it, whatever Who decides a removal says; one member's removal in the same community goes to the jury.
    console.log('\n10. A branch vote with a jury rule: the whole community decides it; one member\'s removal still the jury\'s');
    assert(readShape().settings.removalDecider.value === 'automatic', 'the rule is still Automatic, at 150');
    const root = nextSubject();
    const twigs = [nextSubject(), nextSubject()];
    for (const tw of twigs) db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(root.pk, tw.pk);
    const branchKeys = [root, ...twigs].map(m => m.pk);
    pushes.length = 0;
    const branched = de.pauseBranch(root.pk, gen.pk, `A crowd of fakes brought in by ${root.callsign}`, { freshProof: true, include: branchKeys });
    if (!branched.success) throw new Error(`setup: could not pause the branch of ${root.callsign}: ${branched.error}`);
    const branchVote = branched.decision.id;
    await settle(500);
    const branchPushed = new Set(pushes.filter(p => p.k === 'decision.removal').flatMap(p => p.to));
    const bp = paramsOf(branchVote);
    assert(JSON.stringify((bp.branch ?? []).map((e: any) => e.pubkey).sort()) === JSON.stringify([...branchKeys].sort()),
        `the branch vote lists the three accounts (${(bp.branch ?? []).length})`);
    assert(bp.decider === 'everyone' && !('jury' in bp) && de.juryOf(de.getDecision(branchVote)!) === null,
        `it records that everyone decides it, and no jury (${JSON.stringify(bp.decider)})`);
    assert(rollOf(branchVote).length === 0 && poolRowOf(branchVote) === undefined, 'no roll and no pool are kept for it');
    // One member's pause in the same community, a moment later: still the jury's.
    const zed = nextSubject();
    const zedVote = pauseOf(zed);
    const zedRoll = rollOf(zedVote).filter(r => r.status === 'on').map(r => r.k);
    assert(paramsOf(zedVote).decider === 'jury' && zedRoll.length === 12 && de.tallyDecision(zedVote).decider === 'jury',
        `one member's pause in the same community is the jury's: 12 seated (${paramsOf(zedVote).decider}, ${zedRoll.length})`);
    // Members on neither roll nor list: the jury refuses them, the branch vote takes their votes.
    const eligible = members.filter(m => m !== gen && m !== ada && statusOf(m) === 'active' && !zedRoll.includes(m.pk) && !branchKeys.includes(m.pk));
    const outsider = eligible[0];
    const refusedOnZed = de.castDecisionVote(zedVote, outsider.pk, true);
    assert(!refusedOnZed.success && refusedOnZed.error === de.JURY_ONLY_VOTE_ERROR,
        `a member not drawn for it is refused on the one member's vote, in the jury's words (${refusedOnZed.error})`);
    assert(branchPushed.has(outsider.token) && branchPushed.size > 15,
        `"a vote opened" on the branch went to every voter, that member among them, not to a jury (${branchPushed.size} phones)`);
    fresh();
    const needsCount = async (q: string) => ((await signed('GET', `/api/home?cards=needs${q}`, outsider)).body?.cards?.needs?.items ?? [])
        .filter((i: any) => i.kind === 'vote').reduce((n: number, i: any) => n + (i.count ?? 0), 0);
    const withBranch = await needsCount('&lands=branch-vote');
    fresh();
    const withoutBranch = await needsCount('');
    assert(withBranch === withoutBranch + 1,
        `Home asks that member to vote on the branch (an app that opens it: ${withBranch} votes, an older app: ${withoutBranch})`);
    const voters15 = eligible.slice(0, 15);
    const cast = voters15.map(m => de.castDecisionVote(branchVote, m.pk, true));
    assert(cast.every(c => c.success), `15 members on no jury vote on the branch (${cast.filter(c => c.success).length} of 15)`);
    const listedVoter = de.castDecisionVote(branchVote, twigs[0].pk, true);
    assert(!listedVoter.success && listedVoter.error !== de.JURY_ONLY_VOTE_ERROR, `an account on its list may not vote on it, by S5's rule (${listedVoter.error})`);
    raw.run(branchVote, twigs[1].pk, new Date().toISOString(), new Date().toISOString());
    const bt = de.tallyDecision(branchVote);
    assert(bt.decider === undefined && bt.totalVoters === 15 && bt.yesWeight === 15 && bt.noWeight === 0,
        `its tally is S5's: all 15 count, more than a jury seats, and the listed account's row does not (${bt.totalVoters} voted, ${bt.yesWeight} Yes, decider ${bt.decider})`);
    assert(bt.electorate > 12 && bt.minYes === 3 && bt.thresholdRequired !== 2 / 3 && bt.quorumRequired >= 3,
        `over the community, not a roll: electorate ${bt.electorate}, at least ${bt.minYes} Yes, threshold ${bt.thresholdRequired}`);
    fresh();
    const branchCard = await signed('GET', `/api/commons/decisions/${branchVote}?draws=branch`, eligible[20]);
    assert(branchCard.status === 200 && branchCard.body?.tally?.yesWeight === 15 && branchCard.body?.tally?.passed !== undefined,
        `a member reads its split while it is open, as any community vote's (${JSON.stringify(branchCard.body?.tally?.yesWeight)})`);
    fresh();
    const branchJury = await signed('GET', `/api/commons/decisions/${branchVote}/jury`, outsider);
    assert(branchJury.status === 404, `it has no jury: 404 (${branchJury.status})`);

    // ── 11. J2a: who serves ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n11. J2a: a freeze moves no roster and no seat; the admin who paused stands aside; a re-key still checks out');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    // A member with nothing to do with Sam's case. Their only link is Gwen, who invited them.
    const samsWalk = new Set([sam.pk, ...heads.slice(0, 22)]);
    const sue = subjectWhere(c => !samsWalk.has(c.pk) && statusOf(c) === 'active');
    const before = juryRosterHash(expectedPool([sue]));
    const sueOrder = orderFor(sue);
    // The admin who pauses Sue: the first member of the draw (not Gwen), made an admin, so the walk always reaches them.
    // Then, through the admins' own freeze, before the pause: the next member of the draw who would be seated, frozen all
    // week; and one far down the draw, unfrozen a moment after the pause. On J1 each of the three moved the roster.
    const activeAt = (k: string) => byKey.has(k) && statusOf(byKey.get(k)!) === 'active';
    const abe = byKey.get(sueOrder.find(k => k !== gen.pk && k !== ada.pk && activeAt(k))!)!;
    grantNodeRole(abe.pk, 'admin', gen.pk);
    const frozenJuror = byKey.get(sueOrder.find(k => k !== gen.pk && k !== ada.pk && k !== abe.pk && activeAt(k))!)!;
    const briefly = byKey.get(sueOrder.filter(k => k !== frozenJuror.pk && k !== abe.pk && activeAt(k))[100])!;
    se.adminSetCreditFrozen(frozenJuror.pk, true);
    se.adminSetCreditFrozen(briefly.pk, true);
    const abePause = de.adminEmergencySuspend(sue.pk, abe.pk, `A first case against ${sue.callsign} for this check`, { freshProof: true });
    if (!abePause.success || !abePause.decision) throw new Error(`setup: ${abe.callsign} could not pause ${sue.callsign}: ${abePause.error}`);
    const sueVote = abePause.decision.id;
    se.adminSetCreditFrozen(briefly.pk, false);
    const sueParams = paramsOf(sueVote);
    assert(sueParams.decider === 'jury' && sueParams.jury?.rosterHash === before,
        `two members frozen, a pause, one unfrozen: the vote's roster hash is the one worked out before either freeze (${sueParams.decider})`);
    assert(rollOf(sueVote).some(r => r.k === frozenJuror.pk && r.status === 'on'), `a frozen member at the head of the draw is seated (${frozenJuror.callsign})`);
    fresh();
    const frozenVotes = await signed('POST', `/api/commons/decisions/${sueVote}/vote`, frozenJuror, { support: false });
    const sueTally = de.tallyDecision(sueVote);
    assert(frozenVotes.status === 200 && frozenVotes.body?.success === true && sueTally.totalVoters === 1 && sueTally.noWeight === 1 && sueTally.turnout?.voted === 1,
        `their signed vote is taken over the route and counted, whatever their credit (${frozenVotes.status} ${frozenVotes.body?.error ?? ''}; ${sueTally.totalVoters} counted)`);
    fresh();
    const sueOpen = await signed('GET', `/api/commons/decisions/${sueVote}/jury`, gen);
    const suePooled = (sueOpen.body?.jury?.pool ?? []).map((p: any) => p.publicKey);
    assert(sueOpen.status === 200 && suePooled.includes(abe.pk) && suePooled.includes(frozenJuror.pk) && suePooled.includes(briefly.pk)
        && rollOf(sueVote).some(r => r.k === abe.pk && r.status === 'stood_aside'),
        'the admin who paused and both members frozen are in the pool the node serves, and the admin is passed over at the walk');
    // A juror the node later marks silent or gone (slice J2b writes those) reads `not_seated`, and nothing more.
    const idle = rollOf(sueVote).find(r => r.status === 'on' && r.k !== frozenJuror.pk)!.k;
    db.prepare("UPDATE decision_electors SET status = 'silent' WHERE decision_id = ? AND member_pubkey = ?").run(sueVote, idle);
    fresh();
    const idleReads = await signed('GET', `/api/commons/decisions/${sueVote}/jury`, byKey.get(idle)!);
    db.prepare("UPDATE decision_electors SET status = 'on' WHERE decision_id = ? AND member_pubkey = ?").run(sueVote, idle);
    assert(idleReads.body?.jury?.you === 'not_seated', `a juror no longer seated reads not_seated (${idleReads.body?.jury?.you})`);
    // An admin lifts the pause, which stops the vote; an owner pauses Sue again the same day with a new reason (after a vote
    // stopped, only an owner may): the same roster, though the one pausing is another.
    const lifted = de.adminLiftSuspension(sue.pk, abe.pk);
    fresh();
    const sueClosed = (await signed('GET', `/api/commons/decisions/${sueVote}/jury`, gen)).body?.jury ?? {};
    const sueNotServed = (sueClosed.didNotServe ?? []).map((x: any) => x.publicKey);
    const sueVoted = (sueClosed.voted ?? []).map((x: any) => x.publicKey);
    assert(lifted.success && row(sueVote).status !== 'open' && sueNotServed.includes(abe.pk) && JSON.stringify(sueVoted) === JSON.stringify([frozenJuror.pk]),
        `closed, the admin who paused is among those who didn't serve, and the frozen juror is who voted (${row(sueVote).status})`);
    const again = de.adminEmergencySuspend(sue.pk, gen.pk, `A second case against ${sue.callsign}, with new facts`, { freshProof: true });
    if (!again.success || !again.decision) throw new Error(`setup: Gwen could not pause ${sue.callsign} again: ${again.error}`);
    const sueAgain = again.decision.id;
    assert(paramsOf(sueAgain).decider === 'jury' && paramsOf(sueAgain).jury?.snapshotDate === today && paramsOf(sueAgain).jury?.rosterHash === before,
        `an owner pausing Sue the same day draws from the same roster as the admin's pause did (${paramsOf(sueAgain).jury?.rosterHash === sueParams.jury?.rosterHash})`);
    // §5.1: a juror and Sue re-keyed while it is open. The roll, the votes and the vote's subject move to the new keys; the
    // pool and the key the vote was drawn for don't, and the closed lists say what each entry was drawn as.
    const sueSeated = rollOf(sueAgain).filter(r => r.status === 'on').map(r => byKey.get(r.k)!).filter(j => j && statusOf(j) === 'active');
    const moving = sueSeated.find(j => j !== frozenJuror)!;
    const votedBefore = [de.castDecisionVote(sueAgain, frozenJuror.pk, true), de.castDecisionVote(sueAgain, moving.pk, true)];
    const rekey = (who: Id): Id => {
        const next = keypair(who.callsign);
        completeRekey(who.pk, next.pk, issueRekeyCode(who.pk, 'owner:password').code, 'owner:password');
        return next;
    };
    const moved = rekey(moving);
    const sueMoved = rekey(sue);
    assert(votedBefore.every(v => v.success) && row(sueAgain).subject === sueMoved.pk && paramsOf(sueAgain).jury?.subject === sue.pk
        && rollOf(sueAgain).some(r => r.k === moved.pk) && !rollOf(sueAgain).some(r => r.k === moving.pk),
        "re-keyed: the vote's subject and the juror's seat moved to the new keys; the key the vote was drawn for stayed");
    closeNow(sueAgain);
    fresh();
    const rk = (await signed('GET', `/api/commons/decisions/${sueAgain}/jury`, gen)).body?.jury ?? {};
    const rkEntries: any[] = [...(rk.voted ?? []), ...(rk.didNotServe ?? [])];
    const rkMoved = (rk.voted ?? []).find((x: any) => x.publicKey === moved.pk);
    assert(rk.subject === sue.pk && rkMoved?.drawnAs === moving.pk && rkMoved?.callsign === moving.callsign,
        `closed: the jury is served as drawn for Sue's old key, and the re-keyed juror, among those who voted under their new key, as drawn under their old one (${row(sueAgain).status})`);
    const rkPool = (rk.pool ?? []).map((p: any) => p.publicKey);
    const rkCheck = (subject: string, roll: string[]) => checkJuryDraw({ pool: rkPool, subject, snapshotDate: rk.snapshotDate, rosterHash: rk.rosterHash, roll });
    assert(rkCheck(rk.subject, rkEntries.map(x => x.drawnAs)).ok, 'and it checks out: the served subject, and each entry as drawn');
    const byNewKeys = rkCheck(rk.subject, rkEntries.map(x => x.publicKey));
    const byNewSubject = rkCheck(row(sueAgain).subject, rkEntries.map(x => x.drawnAs));
    assert(!byNewKeys.ok && !byNewSubject.ok, "by the new keys it wouldn't, which is why the record keeps what each was drawn as");

    // ── 12. J2b: seating, silence, alternates, pushes ───────────────────────────────────────────────────────────────
    console.log('\n12. J2b: Serve or Step aside, silent at 72 hours, a juror paused is gone, the next of the draw seated once, the pushes');
    const { useCatalogsForTests } = await import('./member-words.js');
    const HOUR = 60 * 60_000;
    // The open juries before this section close, so every jury push from here on is one of this section's cases.
    closeNow(wilVote);
    closeNow(zedVote);
    const memberStatus = (k: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(k) as { status: string } | undefined)?.status;
    const tokenOf = (k: string) => byKey.get(k)?.token ?? `no token for ${k.slice(0, 8)}`;
    /** A member's phones besides the one seedMember gave them (a juror's French phone, below). */
    const morePhones = new Map<string, string[]>();
    const phonesOf = (keys: string[]) => new Set(keys.flatMap(k => [tokenOf(k), ...(morePhones.get(k) ?? [])]));
    const sentTo = (kind: string, from = 0) => new Set(sent.slice(from).filter(m => m.k === kind).map(m => m.to));
    const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));
    const seatedOf = (id: string) => rollOf(id).filter(r => r.status === 'on').map(r => r.k);
    /**
     * A case whose first 30 of the draw are active members seeded here, with phones this suite knows (none re-keyed since,
     * none paused: `age` moves one case's times and not the rest of the world's, so a pause made a minute ago would read as
     * made after a seat it moved two days back).
     */
    const plainCase = () => subjectWhere(c => {
        if (memberStatus(c.pk) !== 'active') return false;
        const o = juryOrder(de.removalJuryPool(today, [c.pk]), c.pk, today).order;
        return o.slice(0, 30).every(k => byKey.has(k) && memberStatus(k) === 'active');
    });
    /** A case `who` is among the first 10 of the draw of, so they are seated (nothing links them to its member). Not aged. */
    const caseSeating = (who: Id) => subjectWhere(c => memberStatus(c.pk) === 'active'
        && juryOrder(de.removalJuryPool(today, [c.pk]), c.pk, today).order.slice(0, 10).includes(who.pk));
    /** Time travel: the whole case, its seats with it, as if it had all happened `ms` earlier. */
    const rollColumns = new Set((db.prepare("SELECT name FROM pragma_table_info('decision_electors')").all() as Array<{ name: string }>).map(c => c.name));
    const back = (iso: string | null, ms: number) => (iso ? new Date(Date.parse(iso) - ms).toISOString() : iso);
    const age = (id: string, ms: number) => {
        const d = row(id);
        db.prepare('UPDATE decisions SET opens_at = ?, closes_at = ?, created_at = ? WHERE id = ?').run(back(d.opens_at, ms), back(d.closes_at, ms), back(d.created_at, ms), id);
        const cols = ['created_at', 'answered_at', 'reminded_at'].filter(c => rollColumns.has(c));
        for (const e of db.prepare(`SELECT member_pubkey, ${cols.join(', ')} FROM decision_electors WHERE decision_id = ?`).all(id) as any[]) {
            db.prepare(`UPDATE decision_electors SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE decision_id = ? AND member_pubkey = ?`)
                .run(...cols.map(c => back(e[c], ms)), id, e.member_pubkey);
        }
    };
    const answerAs = async (id: string, who: Id, answer: unknown) => { fresh(); return signed('POST', `/api/commons/decisions/${id}/jury/answer`, who, { answer }); };
    const juryRead = async (id: string, who: Id) => { fresh(); return signed('GET', `/api/commons/decisions/${id}/jury`, who); };
    /** Nobody's name or key in anything sent to a phone since `from`: not the member, the admin, a juror, anyone. */
    const namesNobody = (from: number) => {
        const wire = JSON.stringify(sent.slice(from));
        return [...byKey.values()].every(m => !wire.includes(m.pk) && !new RegExp(`\\b${m.callsign}\\b`).test(wire));
    };

    // ── Cal's case: the seating push, Serve, Step aside, the reply, the reminder and silence ──
    const cal = plainCase();
    let mark = sent.length;
    pushes.length = 0;
    const calVote = pauseOf(cal);
    await settle(500);
    const calJury = seatedOf(calVote);
    const notOnCal = byKey.get(juryOrder(de.removalJuryPool(today, [cal.pk]), cal.pk, today).order.slice(60).find(k => byKey.has(k) && memberStatus(k) === 'active')!)!;
    assert(calJury.length === 12 && sameSet(sentTo('decision.jury', mark), phonesOf(calJury)) && sameSet(sentTo('account.removal-vote', mark), phonesOf([cal.pk])),
        `"a vote opened" to the jury is the jury's own push, to the 12 seated and nobody else, and the member is told as before (${sentTo('decision.jury', mark).size} phones)`);
    assert(sentTo('decision.removal', mark).size === 0, 'and nobody else in the community is pushed: the card has no vote button for them');
    const seatWords = sent.slice(mark).filter(m => m.k === 'decision.jury');
    assert(seatWords.length > 0 && seatWords.every(m => m.title === 'BeanPool'
        && m.body === 'You were drawn for a jury in your community. Open BeanPool within three days to serve or step aside.'),
        `each juror's lock screen: drawn, and asked to answer within three days (${JSON.stringify(seatWords[0]?.body)})`);
    assert(namesNobody(mark), 'no push names anyone: not the member, the admin who paused, nor any juror');
    const calJurors = calJury.map(k => byKey.get(k)!);
    const seatRead = await juryRead(calVote, calJurors[0]);
    const offRead = await juryRead(calVote, notOnCal);
    const seatDue = Date.parse(row(calVote).opens_at) + 72 * HOUR;
    assert(seatRead.body?.jury?.you === 'seated' && Date.parse(seatRead.body?.jury?.answerBy) === seatDue && !('answerBy' in (offRead.body?.jury ?? { answerBy: 1 })),
        `a juror reads seated, their answer due 72 hours after the seat; a member not drawn reads no such line (${seatRead.body?.jury?.answerBy})`);
    // Serve: then vote.
    const servesAnswer = await answerAs(calVote, calJurors[0], 'serve');
    const servedToo = await answerAs(calVote, calJurors[1], 'serve');
    assert(servesAnswer.status === 200 && servesAnswer.body?.jury?.you === 'seated' && servesAnswer.body?.jury?.answerBy === null && servedToo.status === 200,
        `a juror answers Serve over the route: still seated, nothing more due (${servesAnswer.status} ${servesAnswer.body?.error ?? ''})`);
    for (const j of calJurors.slice(2, 6)) de.castDecisionVote(calVote, j.pk, true);
    const lateAside = await answerAs(calVote, calJurors[5], 'step_aside');
    assert(lateAside.status === 409 && seatedOf(calVote).includes(calJurors[5].pk),
        `one who has voted can't step aside: they serve, and can still change their vote (${lateAside.status} ${lateAside.body?.error})`);
    // Step aside: no reason asked, and the next member of the draw is seated at once, and told.
    mark = sent.length;
    const stepper = calJurors[6];
    const stepped = await answerAs(calVote, stepper, 'step_aside');
    await settle(300);
    const afterStep = seatedOf(calVote);
    const firstAlternate = afterStep.filter(k => !calJury.includes(k));
    assert(stepped.status === 200 && stepped.body?.jury?.you === null && rollOf(calVote).find(r => r.k === stepper.pk)?.status === 'stood_aside'
        && afterStep.length === 12 && firstAlternate.length === 1,
        `a juror steps aside over the route: off the jury, reading what a member not drawn reads, and the next of the draw seated (${stepped.status} ${stepped.body?.error ?? ''}; ${afterStep.length} seated)`);
    assert(sameSet(sentTo('decision.jury', mark), phonesOf(firstAlternate)) && namesNobody(mark),
        `the member seated in their place is told, they alone (${sentTo('decision.jury', mark).size} phone)`);
    const steppedRead = await juryRead(calVote, stepper);
    const strangerRead = await juryRead(calVote, notOnCal);
    assert(steppedRead.text === strangerRead.text, 'the one who stepped aside reads, byte for byte, what a member not drawn reads');
    const steppedVote = de.castDecisionVote(calVote, stepper.pk, true);
    const offAnswer = await answerAs(calVote, notOnCal, 'serve');
    const badAnswer = await answerAs(calVote, calJurors[7], 'maybe');
    fresh();
    const unsignedAnswer = await signed('POST', `/api/commons/decisions/${calVote}/jury/answer`, null, { answer: 'serve' });
    assert(!steppedVote.success && steppedVote.error === de.JURY_ONLY_VOTE_ERROR && offAnswer.status === 403 && offAnswer.body?.error === de.JURY_ONLY_VOTE_ERROR
        && badAnswer.status === 400 && unsignedAnswer.status === 401,
        `their vote is refused, as a member not drawn is refused an answer (403, in the jury's words); a wrong answer 400; unsigned 401 (${offAnswer.status}, ${badAnswer.status}, ${unsignedAnswer.status})`);
    fresh();
    const noJuryAnswer = await signed('POST', `/api/commons/decisions/${plainVote}/jury/answer`, notOnCal, { answer: 'serve' });
    assert(noJuryAnswer.status === 404, `a vote no jury decides takes no answer: 404 (${noJuryAnswer.status})`);
    // The member answers the case: every seated juror is told, once, in their phone's language, naming nobody.
    const french = 'Le membre sur lequel votre jury décide a répondu. Ouvrez BeanPool pour lire sa réponse.';
    useCatalogsForTests('fr', { core: { 'The member your jury is deciding about has answered the case. Open BeanPool to read it.': french } });
    const frenchJuror = calJurors[8];
    const frenchPhone = `ExponentPushToken[rj-fr-${crypto.randomBytes(4).toString('hex')}]`;
    se.registerPushToken(frenchJuror.pk, frenchPhone, 'android', null, null, 'fr');
    morePhones.set(frenchJuror.pk, [frenchPhone]);
    mark = sent.length;
    fresh();
    const replied = await signed('POST', `/api/commons/decisions/${calVote}/reply`, cal, { reply: 'I did nothing of the kind, and here is what happened.' });
    await settle(300);
    const replyPhones = sentTo('decision.jury-reply', mark);
    assert(replied.status === 200 && sameSet(replyPhones, phonesOf(seatedOf(calVote))) && replyPhones.has(frenchPhone),
        `the member answers: every seated juror is pushed, nobody else (${replied.status}; ${replyPhones.size} phones)`);
    const frenchSent = sent.slice(mark).find(m => m.to === frenchPhone);
    const englishSent = sent.slice(mark).find(m => m.to === frenchJuror.token);
    assert(frenchSent?.body === french && englishSent?.body === 'The member your jury is deciding about has answered the case. Open BeanPool to read it.'
        && namesNobody(mark),
        `in each phone's language, through the push words (fr: ${JSON.stringify(frenchSent?.body)}), and naming nobody`);
    mark = sent.length;
    fresh();
    await signed('POST', `/api/commons/decisions/${calVote}/reply`, cal, { reply: 'And one thing more about what happened that day.' });
    await settle(300);
    assert(sentTo('decision.jury-reply', mark).size === 0, 'a rewrite of the answer pushes nobody again');
    useCatalogsForTests('fr', null);
    // 49 hours on: one reminder, to each juror with no answer, once.
    const noAnswer = seatedOf(calVote).filter(k => k !== calJurors[0].pk && k !== calJurors[1].pk && !calJurors.slice(2, 6).some(j => j.pk === k));
    age(calVote, 49 * HOUR);
    mark = sent.length;
    de.tickDecisions();
    await settle(300);
    const reminded = sentTo('decision.jury-reminder', mark);
    assert(noAnswer.length === 6 && noAnswer.includes(frenchJuror.pk) && sameSet(reminded, phonesOf(noAnswer)) && namesNobody(mark),
        `48 hours after their seat, each of the 6 jurors with no answer is reminded, nobody who answered Serve or voted (${reminded.size} phones)`);
    assert(sent.slice(mark).filter(m => m.k === 'decision.jury-reminder').every(m => m.body === 'A jury you were drawn for is waiting for your answer. Answer within a day, or your seat goes to the next member drawn.'),
        'the reminder says a day is left, and what happens then');
    mark = sent.length;
    de.tickDecisions();
    await settle(300);
    assert(sentTo('decision.jury-reminder', mark).size === 0, 'the next tick reminds nobody again');
    // 73 hours on: the six are silent, and six of the draw are seated in their places, each told; once, never twice.
    age(calVote, 24 * HOUR);
    mark = sent.length;
    const rollBefore = rollOf(calVote).length;
    de.tickDecisions();
    await settle(300);
    const afterSilence = seatedOf(calVote);
    const silentNow = rollOf(calVote).filter(r => r.status === 'silent').map(r => r.k);
    const replacements = afterSilence.filter(k => !calJury.includes(k) && !firstAlternate.includes(k));
    assert(JSON.stringify([...silentNow].sort()) === JSON.stringify([...noAnswer].sort()) && afterSilence.length === 12 && replacements.length === 6,
        `72 hours with no answer: the 6 are silent and 6 of the draw seated in their places (${silentNow.length} silent, ${afterSilence.length} seated)`);
    assert([calJurors[0], calJurors[1], ...calJurors.slice(2, 6)].every(j => afterSilence.includes(j.pk)),
        'the two who answered Serve and the four who voted keep their seats');
    assert(sameSet(sentTo('decision.jury', mark), phonesOf(replacements)) && sentTo('decision.jury-late', mark).size === 0 && namesNobody(mark),
        `each member seated is told, with four days left the ordinary words (${sentTo('decision.jury', mark).size} phones)`);
    const rollAfter = rollOf(calVote).length;
    mark = sent.length;
    de.tickDecisions();
    de.tickDecisions();
    await settle(300);
    assert(rollOf(calVote).length === rollAfter && seatedOf(calVote).length === 12 && JSON.stringify(seatedOf(calVote).sort()) === JSON.stringify([...afterSilence].sort())
        && sentTo('decision.jury', mark).size === 0 && rollAfter > rollBefore,
        `the next ticks seat nobody more: each silent juror replaced once, never twice (${rollAfter} on the roll)`);
    // (With none silent, as on a node before J2b, a member not drawn stands in, so the checks below fail rather than throw.)
    const silentOne = byKey.get(silentNow[0] ?? '') ?? notOnCal;
    const silentRead = await juryRead(calVote, silentOne);
    const silentVote = de.castDecisionVote(calVote, silentOne.pk, true);
    assert(silentRead.body?.jury?.you === 'not_seated' && !('answerBy' in (silentRead.body?.jury ?? {})) && !silentVote.success && silentVote.error === de.JURY_ONLY_VOTE_ERROR,
        `a silent juror reads not_seated, and their vote is refused (${silentRead.body?.jury?.you})`);
    closeNow(calVote);
    const calClosed = (await juryRead(calVote, notOnCal)).body?.jury ?? {};
    const calNot = (calClosed.didNotServe ?? []) as any[];
    const entryOf = (k: string) => calNot.find(x => x.publicKey === k);
    assert(!!entryOf(stepper.pk) && !!entryOf(silentOne.pk) && JSON.stringify(Object.keys(entryOf(stepper.pk)).sort()) === JSON.stringify(Object.keys(entryOf(silentOne.pk)).sort())
        && !(calClosed.voted ?? []).some((x: any) => x.publicKey === stepper.pk || x.publicKey === silentOne.pk),
        'closed: one who stepped aside and one gone silent are both among those who did not serve, their entries alike');
    const calAll = [...(calClosed.voted ?? []), ...calNot].map((x: any) => x.drawnAs);
    assert(calAll.length === rollOf(calVote).length && checkJuryDraw({ pool: (calClosed.pool ?? []).map((p: any) => p.publicKey), subject: calClosed.subject,
        snapshotDate: calClosed.snapshotDate, rosterHash: calClosed.rosterHash, roll: calAll }).ok,
        `and the draw still checks out with everyone seated since: the roll is the head of the draw (${calAll.length})`);

    // ── Dee's case: a juror paused is gone and their vote with them; under 48 hours the one seated is told; the last day ──
    const dee = plainCase();
    const deeVote = pauseOf(dee);
    const deeJury = seatedOf(deeVote);
    const deeJurors = deeJury.map(k => byKey.get(k)!);
    // One no case was ever brought against, so the cool-down after a vote that kept them doesn't refuse their pause.
    const wasSubject = new Set(members.slice(2, 2 + subjects).map(m => m.pk));
    const paused = deeJurors.find(j => memberStatus(j.pk) === 'active' && !wasSubject.has(j.pk))!;
    const others = deeJurors.filter(j => j !== paused);
    for (const j of others) await answerAs(deeVote, j, 'serve');
    const pausedVote = de.castDecisionVote(deeVote, paused.pk, true);
    assert(pausedVote.success && de.tallyDecision(deeVote).turnout?.voted === 1, `a juror votes, and it counts (${de.tallyDecision(deeVote).turnout?.voted})`);
    const pausedOwn = pauseOf(paused, `A case against ${paused.callsign}, a juror, for this check`);
    // Five and a half days in: a day and a half left.
    age(deeVote, 132 * HOUR);
    const deeCloses = row(deeVote).closes_at;
    mark = sent.length;
    de.tickDecisions();
    await settle(300);
    const deeAfter = seatedOf(deeVote);
    const deeAlternate = deeAfter.filter(k => !deeJury.includes(k));
    assert(rollOf(deeVote).find(r => r.k === paused.pk)?.status === 'left' && de.tallyDecision(deeVote).turnout?.voted === 0 && de.tallyDecision(deeVote).totalVoters === 0,
        `a juror paused since they were seated is gone from the jury, and their vote with them (${rollOf(deeVote).find(r => r.k === paused.pk)?.status}, ${de.tallyDecision(deeVote).turnout?.voted} counted)`);
    assert(deeAfter.length === 12 && deeAlternate.length === 1 && others.every(j => deeAfter.includes(j.pk)),
        `the next of the draw takes the seat, and the eleven who answered Serve keep theirs, five days on (${deeAfter.length} seated)`);
    assert(sameSet(sentTo('decision.jury-late', mark), phonesOf(deeAlternate)) && sentTo('decision.jury-reminder', mark).size === 0 && namesNobody(mark),
        `with less than 48 hours left, the member seated is told so, they alone (${sentTo('decision.jury-late', mark).size} phone)`);
    const lateWords = sent.slice(mark).find(m => m.k === 'decision.jury-late')?.body;
    assert(lateWords === 'You were drawn for a jury in your community, and its vote closes in less than two days. Open BeanPool to serve or step aside.',
        `in words that say the vote closes in less than two days (${JSON.stringify(lateWords)})`);
    const pausedRead = await juryRead(deeVote, paused);
    const pausedAgain = de.castDecisionVote(deeVote, paused.pk, false);
    assert(pausedRead.body?.jury?.you === 'not_seated' && !pausedAgain.success && pausedAgain.error === de.JURY_ONLY_VOTE_ERROR,
        `they read not_seated and can't vote again (${pausedRead.body?.jury?.you}; ${pausedAgain.error})`);
    mark = sent.length;
    de.tickDecisions();
    await settle(300);
    assert(seatedOf(deeVote).length === 12 && sentTo('decision.jury-late', mark).size === 0 && row(deeVote).closes_at === deeCloses,
        'the next tick changes nothing, and nothing moved the close: the seat filled once, the vote still ends on its seventh day');
    // The sixth day: every seated juror who hasn't voted is reminded, once.
    age(deeVote, 15 * HOUR);
    mark = sent.length;
    de.tickDecisions();
    await settle(300);
    const lastDay = sentTo('decision.jury-last-day', mark);
    assert(sameSet(lastDay, phonesOf(seatedOf(deeVote))) && namesNobody(mark)
        && sent.slice(mark).filter(m => m.k === 'decision.jury-last-day').every(m => m.body === "A jury you're on closes in about a day. Open BeanPool to vote."),
        `on the sixth day every seated juror who hasn't voted is reminded, the one seated late among them (${lastDay.size} phones)`);
    mark = sent.length;
    de.tickDecisions();
    await settle(300);
    assert(sentTo('decision.jury-last-day', mark).size === 0, 'and once');

    // ── Fay's case: one paused before they were seated keeps the seat (the pool keeps paused members), and votes ──
    const fay = caseSeating(paused);
    const fayVote = pauseOf(fay);
    const pausedSeated = seatedOf(fayVote).includes(paused.pk);
    de.tickDecisions();
    const fayCast = de.castDecisionVote(fayVote, paused.pk, true);
    assert(memberStatus(paused.pk) === 'disabled' && row(pausedOwn).status === 'open' && pausedSeated && seatedOf(fayVote).includes(paused.pk)
        && fayCast.success && de.tallyDecision(fayVote).turnout?.voted === 1,
        `a member paused before the draw seated them keeps the seat across the tick, and their vote counts (${pausedSeated}, ${fayCast.error ?? 'voted'})`);

    // ── Gus's case: a member of the draw who moved to a new phone since is seated under the key they sign with ──
    const gus = plainCase();
    const gusVote = pauseOf(gus);
    const gusOrder = juryOrder((poolRowOf(gusVote) ?? '').split('\n'), gus.pk, today).order;
    const onGus = new Set(rollOf(gusVote).map(r => r.k));
    const nextUp = byKey.get(gusOrder.find(k => !onGus.has(k) && k !== gen.pk && k !== ada.pk)!)!;
    const nextUpMoved = rekey(nextUp);
    const gusStep = await answerAs(gusVote, byKey.get(seatedOf(gusVote)[0])!, 'step_aside');
    const gusRoll = rollOf(gusVote);
    assert(gusStep.status === 200 && gusRoll.some(r => r.k === nextUpMoved.pk && r.status === 'on') && !gusRoll.some(r => r.k === nextUp.pk),
        `a member of the draw re-keyed since the draw is seated in the seat that came free, under their new key (${gusStep.status})`);
    closeNow(gusVote);
    const gusClosed = (await juryRead(gusVote, notOnCal)).body?.jury ?? {};
    const gusEntries: any[] = [...(gusClosed.voted ?? []), ...(gusClosed.didNotServe ?? [])];
    assert(gusEntries.find(x => x.publicKey === nextUpMoved.pk)?.drawnAs === nextUp.pk
        && checkJuryDraw({ pool: (gusClosed.pool ?? []).map((p: any) => p.publicKey), subject: gusClosed.subject, snapshotDate: gusClosed.snapshotDate,
            rosterHash: gusClosed.rosterHash, roll: gusEntries.map(x => x.drawnAs) }).ok,
        'closed, they are listed as drawn under their old key, and the draw checks out');

    assert(offMachine.length === 0, `nothing left this machine (${offMachine.join(', ') || 'none'})`);
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
