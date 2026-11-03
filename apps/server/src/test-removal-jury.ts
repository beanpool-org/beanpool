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
 * And slice J2c, branch juries (call 4): under a jury rule an owner's branch pause is decided by one jury for the whole
 * branch, drawn for its root's key, in section 10.
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
 * 10. J2c, branch juries (DESIGN-removal-jury-j2-calls-fable.md call 4): under Automatic at 150 an owner's branch pause
 *     (removal by vote S5) of three draws one jury of 12 for the root's key, from the day's pool without the accounts its
 *     card names (the listed and the established left off); the root's inviter, the subtree's other accounts (an admin, an
 *     account already paused: in the pool, passed over) and the owner pausing stand aside; only jurors vote (an account on
 *     the list in S5's words), are pushed and asked on Home, and read the balances; /jury serves no subject, the root and
 *     the list, and checks out with the root's key, open and closed; paused again the same day naming the established
 *     account, the same pool, hash and order; the tally leaves out every account on the list; 6 of 9 removes the branch.
 *     Under Everyone, S5's vote as it was (every voter pushed, 15 votes count, no jury); under Automatic with 99 in the
 *     branch's pool, everyone too.
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
const offMachine: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    if (url.hostname === 'exp.host') {
        const batch = JSON.parse(String(init?.body ?? '[]')) as any[];
        pushes.push({ to: batch.map((m) => m.to), k: batch[0]?.data?.k });
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
    const pushedTo = new Set(pushes.filter(p => p.k === 'decision.removal' || p.k === 'account.removal-vote').flatMap(p => p.to));
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
        INSERT INTO decision_electors_old SELECT * FROM decision_electors WHERE status IN ('on', 'left');
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

    // ── 10. Branch juries (J2c) ─────────────────────────────────────────────────────────────────────────────────────
    // DESIGN-removal-jury-j2-calls-fable.md call 4 (Marty, 4 Nov "All Fable's picks"): under a jury rule an owner's branch
    // pause (removal by vote S5) is decided by one jury for the whole branch, drawn for the root's key from the day's pool
    // without every account its card names; whoever has a link to an account on its list, the rest of the root's invite
    // subtree and the owner pausing stand aside. Under Everyone, or below the line, the whole community decides it, as S5 built.
    console.log('\n10. Branch juries: under a jury rule one jury decides a whole branch; under Everyone or below the line, everyone');
    assert(readShape().settings.removalDecider.value === 'automatic', 'the rule is still Automatic, at 150');
    const { juryConflictsOf } = await import('./engine/removal-jury.js');
    const { revokeNodeRole } = await import('./engine/node-roles.js');
    const invitedBy = db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?');
    // Members with nothing to do with Sam's case, who invited nobody (Gwen invited everyone else here; at(1) and Sam one each).
    const samsCase = new Set([sam.pk, ...heads.slice(0, 22)]);
    const freshOk = (c: Id) => !samsCase.has(c.pk) && statusOf(c) === 'active';
    const twigA = subjectWhere(freshOk);
    const twigB = subjectWhere(freshOk);
    // Joined 60 days ago, as everyone here: established (engine/burst-cleanup.ts), so left off the list unless the owner names it.
    const settled = subjectWhere(freshOk);
    /** The draw for a branch under `r`, worked out here: the day's pool without every account its card names, for r's key. */
    const branchPoolOf = (r: Id) => expectedPool([r, twigA, twigB, settled]);
    const unused = () => new Set(members.slice(2 + subjects).map(m => m.pk));
    /** The first `n` of a draw free to be set up: not yet used here, active, not in Sam's case, not Gwen or Ada. */
    const headPicks = (order: string[], n: number) => order.filter(k => unused().has(k) && !samsCase.has(k) && byKey.has(k)
        && statusOf(byKey.get(k)!) === 'active' && k !== gen.pk && k !== ada.pk).slice(0, n);
    // The root: one for whom Gwen, the owner who pauses, and three members free to be set up all fall in the first 12 of the
    // draw, so the walk reaches all four whatever else it passes over.
    const root = subjectWhere(c => {
        if (!freshOk(c)) return false;
        const o = juryOrder(branchPoolOf(c), c.pk, today).order;
        const picks = headPicks(o, 3);
        return o.indexOf(gen.pk) >= 0 && o.indexOf(gen.pk) < 12 && picks.length === 3 && picks.every(k => o.indexOf(k) < 12);
    });
    const [inviterKey, roleKey, pausedKey] = headPicks(juryOrder(branchPoolOf(root), root.pk, today).order, 3);
    const inviter = subjectWhere(c => c.pk === inviterKey);
    const roleHolder = subjectWhere(c => c.pk === roleKey);
    const pausedOne = subjectWhere(c => c.pk === pausedKey);
    // The branch: the root, whom `inviter` invited; the root invited the two twigs, the established account and an admin; the
    // admin invited `pausedOne`, paused on their own already. Left off the list: the admin (a role) and pausedOne (paused);
    // both still in the pool (nothing on the card names them), so only the walk passes them over.
    invitedBy.run(inviter.pk, root.pk);
    for (const m of [twigA, twigB, settled, roleHolder]) invitedBy.run(root.pk, m.pk);
    invitedBy.run(roleHolder.pk, pausedOne.pk);
    grantNodeRole(roleHolder.pk, 'admin', gen.pk);
    pauseOf(pausedOne);
    const branchPool = branchPoolOf(root);
    const bOrder = juryOrder(branchPool, root.pk, today).order;
    const listedKeys = [root, twigA, twigB].map(m => m.pk);
    const linked = new Set(listedKeys.flatMap(k => [...juryConflictsOf(k)]));
    assert(linked.has(inviter.pk) && linked.has(roleHolder.pk) && !linked.has(pausedOne.pk) && !linked.has(gen.pk),
        "set up: the root's inviter and the admin the root invited have a link to an account on the list; pausedOne and Gwen have none");
    pushes.length = 0;
    const b1 = de.pauseBranch(root.pk, gen.pk, `A crowd of fakes brought in by ${root.callsign}`, { freshProof: true, include: [twigA.pk, twigB.pk] });
    if (!b1.success) throw new Error(`setup: could not pause the branch of ${root.callsign}: ${b1.error}`);
    const branchVote = b1.decision.id;
    await settle(500);
    const bp = paramsOf(branchVote);
    const leftOffAs = new Map(b1.leftOff.map(a => [a.pubkey, a.leftOff]));
    assert(JSON.stringify((bp.branch ?? []).map((e: any) => e.pubkey).sort()) === JSON.stringify([...listedKeys].sort())
        && JSON.stringify((bp.established ?? []).map((e: any) => e.pubkey)) === JSON.stringify([settled.pk])
        && leftOffAs.get(roleHolder.pk) === 'role' && leftOffAs.get(pausedOne.pk) === 'paused',
        `the branch vote lists the root and the two named; the established account left off is on the card; the admin and the paused account are left off (${JSON.stringify([...leftOffAs.values()])})`);
    assert(bp.decider === 'jury' && bp.jury?.snapshotDate === today && bp.jury?.size === 12 && bp.jury?.mustVote === 9 && bp.jury?.minYes === 6
        && bp.jury?.poolSize === branchPool.length && bp.jury?.subject === root.pk && de.juryOf(de.getDecision(branchVote)!) !== null,
        `under Automatic at 150 an owner's branch pause is a jury's: today's snapshot, 12 seated, 9 must vote, at least 6 Yes, drawn for the root's key (${JSON.stringify(bp.decider)}, ${JSON.stringify(bp.jury)})`);
    assert(bp.jury?.rosterHash === juryRosterHash(branchPool),
        "its roster hash is the hash of the day's pool without the accounts on the card, worked out here");
    const bStored = poolRowOf(branchVote)?.split('\n') ?? [];
    assert(bStored.length === branchPool.length && JSON.stringify(bStored) === JSON.stringify([...branchPool].sort())
        && ![...listedKeys, settled.pk].some(k => bStored.includes(k)),
        `the node keeps that pool: no account on the list and no established account left off is in it (${bStored.length} keys)`);
    assert([roleHolder, pausedOne, inviter, gen].every(m => bStored.includes(m.pk)),
        "the admin and the paused account in the subtree, the root's inviter and the owner pausing are in it, as the public facts put them");
    const bRoll = rollOf(branchVote);
    const bAside = bRoll.filter(r => r.status === 'stood_aside').map(r => r.k);
    const bSeated = bRoll.filter(r => r.status === 'on').map(r => r.k);
    const expectAside = [inviter, roleHolder, pausedOne, gen].map(m => m.pk);
    assert(JSON.stringify([...bAside].sort()) === JSON.stringify([...expectAside].sort()),
        `passed over at the walk: the root's inviter, the admin the root invited, pausedOne (in the subtree, linked to nobody on the list) and the owner pausing (${bAside.length})`);
    assert(bSeated.length === 12 && JSON.stringify([...bSeated].sort()) === JSON.stringify(bOrder.filter(k => !expectAside.includes(k)).slice(0, 12).sort()),
        `the next 12 of the draw for the root's key are seated (${bSeated.length})`);
    assert(checkJuryDraw({ pool: bStored, subject: root.pk, snapshotDate: today, rosterHash: bp.jury?.rosterHash, roll: bRoll.map(r => r.k) }).ok,
        "core's checkJuryDraw with the root's key: the node's pool and roll check out");
    const opened = new Set(pushes.filter(p => p.k === 'decision.removal').flatMap(p => p.to));
    const toldListed = new Set(pushes.filter(p => p.k === 'account.removal-vote').flatMap(p => p.to));
    assert(opened.size === 12 && bSeated.every(k => opened.has(byKey.get(k)!.token)),
        `"a vote opened" goes to the 12 jurors, nobody else (${opened.size} phones)`);
    assert(toldListed.size === 3 && [root, twigA, twigB].every(m => toldListed.has(m.token)), `and each account on the list is told (${toldListed.size})`);
    // Only the jury votes: a member not drawn and one passed over in the jury's words; an account on the list in S5's.
    const notSeated = byKey.get(bOrder.slice(bRoll.length + 5).find(k => k !== gen.pk && k !== ada.pk && statusOf(byKey.get(k)!) === 'active')!)!;
    const offRoll = de.castDecisionVote(branchVote, notSeated.pk, true);
    const asideVote = de.castDecisionVote(branchVote, inviter.pk, true);
    const listedVote = de.castDecisionVote(branchVote, twigA.pk, true);
    assert(!offRoll.success && offRoll.error === de.JURY_ONLY_VOTE_ERROR && !asideVote.success && asideVote.error === de.JURY_ONLY_VOTE_ERROR,
        `a member not seated is refused in the jury's words, and so is the root's inviter, passed over (${offRoll.error ?? 'taken'}; ${asideVote.error ?? 'taken'})`);
    assert(!listedVote.success && listedVote.error === de.OWN_REMOVAL_VOTE_ERROR, `an account on the list is refused in S5's words (${listedVote.error})`);
    fresh();
    const offRollHttp = await signed('POST', `/api/commons/decisions/${branchVote}/vote`, notSeated, { support: true });
    assert(offRollHttp.status === 400 && offRollHttp.body?.error === de.JURY_ONLY_VOTE_ERROR, `over the route too, 400 (${offRollHttp.status} ${offRollHttp.body?.error ?? ''})`);
    // Home's Needs you asks a juror and nobody else: what an app that opens a branch's vote is shown, less what an older app is.
    const needsCount = async (who: Id, q: string) => {
        fresh();
        return ((await signed('GET', `/api/home?cards=needs${q}`, who)).body?.cards?.needs?.items ?? [])
            .filter((i: any) => i.kind === 'vote').reduce((n: number, i: any) => n + (i.count ?? 0), 0);
    };
    const branchLine = async (who: Id) => (await needsCount(who, '&lands=branch-vote')) - (await needsCount(who, ''));
    const jurorsB = bSeated.map(k => byKey.get(k)!);
    const lines = [jurorsB[0] ? await branchLine(jurorsB[0]) : -1, await branchLine(notSeated), await branchLine(inviter)];
    assert(JSON.stringify(lines) === '[1,0,0]', `Home asks a juror to vote on the branch, never a member not seated nor one passed over (${JSON.stringify(lines)})`);
    // The accounts' balances and debts go to those who may vote on it: the jury, and nobody else (decisionForReader).
    const branchCardOf = async (who: Id) => { fresh(); return signed('GET', `/api/commons/decisions/${branchVote}?draws=branch`, who); };
    const jurorCard = jurorsB[0] ? await branchCardOf(jurorsB[0]) : null;
    const offCard = await branchCardOf(notSeated);
    const owing = (a: Answer | null) => (a?.body?.decision?.params?.branch ?? []).filter((e: any) => 'debt' in e && 'balance' in e).length;
    assert(jurorCard?.status === 200 && owing(jurorCard) === 3 && 'branchDebt' in (jurorCard.body.decision.params ?? {})
        && offCard.status === 200 && owing(offCard) === 0 && !('branchDebt' in (offCard.body?.decision?.params ?? {})),
        `each account's balance and debt, and their total, go to the jury, not to a member not seated (${owing(jurorCard)}, ${owing(offCard)})`);
    assert(offCard.body?.tally?.decider === 'jury' && !('yesWeight' in (offCard.body?.tally ?? {}))
        && JSON.stringify(offCard.body?.tally?.turnout) === JSON.stringify({ voted: 0, size: 12, mustVote: 9 }),
        `while open a member reads the jury's turnout, never the split (${JSON.stringify(offCard.body?.tally?.turnout)})`);
    // GET /jury: no one subject; the root's key it was drawn for; the accounts it is on. Check the draw with the root's key.
    fresh();
    const bJuryOpen = await signed('GET', `/api/commons/decisions/${branchVote}/jury`, notSeated);
    const bj = bJuryOpen.body?.jury ?? {};
    const bServed = (bj.pool ?? []).map((p: any) => p.publicKey);
    assert(bJuryOpen.status === 200 && bj.subject === null && bj.root === root.pk
        && JSON.stringify((bj.branch ?? []).map((e: any) => e.publicKey).sort()) === JSON.stringify([...listedKeys].sort())
        && (bj.branch ?? []).every((e: any) => Object.keys(e).sort().join(',') === 'callsign,publicKey' && e.callsign === byKey.get(e.publicKey)?.callsign),
        `GET /jury: subject null, root the root's key, branch the three accounts on the list by name (${bJuryOpen.status} ${JSON.stringify({ subject: bj.subject, root: bj.root === root.pk })})`);
    assert(JSON.stringify(bServed) === JSON.stringify(bStored)
        && checkJuryDraw({ pool: bServed, subject: bj.root, snapshotDate: bj.snapshotDate, rosterHash: bj.rosterHash }).ok,
        "the pool served is the one kept, and checkJuryDraw with the root's key passes on what was served");
    fresh();
    const inviterReads = await signed('GET', `/api/commons/decisions/${branchVote}/jury`, inviter);
    fresh();
    const jurorReads = jurorsB[0] ? await signed('GET', `/api/commons/decisions/${branchVote}/jury`, jurorsB[0]) : null;
    assert(bj.you === null && !('voted' in bj) && !('didNotServe' in bj) && inviterReads.text === bJuryOpen.text && jurorReads?.body?.jury?.you === 'seated',
        "while open nobody is named; the root's inviter, passed over, reads byte for byte what a member not drawn reads; a juror reads seated");
    // Two jurors vote, then an admin halts it: every pause lifts, and the record is closed.
    const early = jurorsB.slice(0, 2).map(j => de.castDecisionVote(branchVote, j.pk, true));
    const halted = de.adminHaltDecision(branchVote, ada.pk, 'Halted for this check: an owner pauses the branch again');
    assert(early.length === 2 && early.every(v => v.success) && halted.success && row(branchVote).status === 'admin_halted'
        && listedKeys.every(k => statusOf(byKey.get(k)!) === 'active'),
        `two jurors vote; an admin halts it, and every account on the list is back (${row(branchVote).status})`);
    fresh();
    const bClosed = (await signed('GET', `/api/commons/decisions/${branchVote}/jury`, notSeated)).body?.jury ?? {};
    const bVoted: string[] = (bClosed.voted ?? []).map((x: any) => x.publicKey);
    const bNotServed: string[] = (bClosed.didNotServe ?? []).map((x: any) => x.publicKey);
    assert(JSON.stringify([...bVoted].sort()) === JSON.stringify(jurorsB.slice(0, 2).map(j => j.pk).sort())
        && expectAside.every(k => bNotServed.includes(k)) && bNotServed.length === bRoll.length - 2,
        `closed: the two who voted; and among those who didn't serve, the root's inviter, the subtree's admin and paused account and the owner who paused (${bVoted.length}, ${bNotServed.length})`);
    const bDrawnAs = [...(bClosed.voted ?? []), ...(bClosed.didNotServe ?? [])].map((x: any) => x.drawnAs as string);
    assert(bClosed.subject === null && bClosed.root === root.pk && checkJuryDraw({
        pool: (bClosed.pool ?? []).map((p: any) => p.publicKey), subject: bClosed.root, snapshotDate: bClosed.snapshotDate, rosterHash: bClosed.rosterHash, roll: bDrawnAs,
    }).ok, "and the two lists together check out with the root's key");
    // The same root again the same day, by an owner with a new reason (after a vote was stopped, only an owner may: S4), with
    // the server's password this time, and naming the established account: `include` only moves it from the card's
    // established list to its branch list, so the roster, its hash and the order are the ones the first pause drew from.
    const b2 = de.pauseBranch(root.pk, 'owner:password', `A crowd of fakes brought in by ${root.callsign}, with new facts`,
        { freshProof: true, include: [twigA.pk, twigB.pk, settled.pk] });
    if (!b2.success) throw new Error(`setup: could not pause the branch of ${root.callsign} again: ${b2.error}`);
    const branchVote2 = b2.decision.id;
    const bp2 = paramsOf(branchVote2);
    const listed2 = [...listedKeys, settled.pk];
    const stored2 = poolRowOf(branchVote2)?.split('\n') ?? [];
    assert(JSON.stringify((bp2.branch ?? []).map((e: any) => e.pubkey).sort()) === JSON.stringify([...listed2].sort()) && (bp2.established ?? []).length === 0,
        'paused again, the owner naming it, the established account is on the list too');
    assert(bp2.decider === 'jury' && bp2.jury?.rosterHash === bp.jury?.rosterHash && bp2.jury?.snapshotDate === today && bp2.jury?.subject === root.pk
        && stored2.length > 0 && JSON.stringify(stored2) === JSON.stringify(bStored),
        `naming an established account moves neither the pool nor its roster hash (${bp2.decider}, ${bp2.jury?.rosterHash === bp.jury?.rosterHash})`);
    assert(stored2.length > 0 && JSON.stringify(juryOrder(stored2, root.pk, today).order) === JSON.stringify(bOrder), 'nor the order the jury is seated in');
    const roll2 = rollOf(branchVote2);
    const aside2 = roll2.filter(r => r.status === 'stood_aside').map(r => r.k);
    const seated2 = roll2.filter(r => r.status === 'on').map(r => r.k);
    const expectAside2 = [inviter, roleHolder, pausedOne].map(m => m.pk);
    assert(JSON.stringify([...aside2].sort()) === JSON.stringify([...expectAside2].sort()) && seated2.includes(gen.pk) && seated2.length === 12,
        `paused with the password, which has no key, nobody stands aside as the one pausing: Gwen is seated this time (${aside2.length} passed over)`);
    // The tally over the roll (§5) leaves out every account on the list, whatever a row says: here one seated by a row written
    // straight into the roll, with a No, and a member not drawn with a No too. 6 Yes to 3 No from the jury removes the branch.
    const jurors2 = seated2.map(k => byKey.get(k)!);
    for (const j of jurors2.slice(0, 6)) de.castDecisionVote(branchVote2, j.pk, true);
    for (const j of jurors2.slice(6, 9)) de.castDecisionVote(branchVote2, j.pk, false);
    db.prepare("INSERT INTO decision_electors (decision_id, member_pubkey, role_at_open, status) VALUES (?, ?, 'juror', 'on')").run(branchVote2, twigB.pk);
    raw.run(branchVote2, twigB.pk, new Date().toISOString(), new Date().toISOString());
    raw.run(branchVote2, notSeated.pk, new Date().toISOString(), new Date().toISOString());
    const bt2 = de.tallyDecision(branchVote2);
    assert(bt2.decider === 'jury' && bt2.totalVoters === 9 && bt2.yesWeight === 6 && bt2.noWeight === 3 && bt2.electorate === 12 && bt2.quorumRequired === 9,
        `the tally counts the 9 jurors' votes only: not an account on the list a row seats, nor a member not drawn (${bt2.totalVoters} voted, ${bt2.yesWeight} Yes, ${bt2.noWeight} No)`);
    db.prepare('DELETE FROM decision_electors WHERE decision_id = ? AND member_pubkey = ?').run(branchVote2, twigB.pk);
    closeNow(branchVote2);
    assert(row(branchVote2).status === 'execution_pending_grace' && listed2.every(k => statusOf(byKey.get(k)!) === 'disabled'),
        `6 Yes to 3 No: the jury removes the branch, one grace window for every account on it, each still paused (${row(branchVote2).status})`);
    fresh();
    const c2 = (await signed('GET', `/api/commons/decisions/${branchVote2}/jury`, notSeated)).body?.jury ?? {};
    const voted2: string[] = (c2.voted ?? []).map((x: any) => x.publicKey);
    const notServed2: string[] = (c2.didNotServe ?? []).map((x: any) => x.publicKey);
    assert(JSON.stringify([...voted2].sort()) === JSON.stringify(jurors2.slice(0, 9).map(j => j.pk).sort())
        && expectAside2.every(k => notServed2.includes(k)) && notServed2.length === roll2.length - 9 && !notServed2.includes(twigB.pk),
        `closed: the 9 who voted; and among those who didn't serve the root's inviter and the subtree's other accounts, with the 3 jurors who didn't vote (${voted2.length}, ${notServed2.length})`);
    const pool2 = (c2.pool ?? []).map((p: any) => p.publicKey);
    const roll2Served = [...(c2.voted ?? []), ...(c2.didNotServe ?? [])].map((x: any) => x.drawnAs as string);
    const check2 = (seedKey: string) => checkJuryDraw({ pool: pool2, subject: seedKey, snapshotDate: c2.snapshotDate, rosterHash: c2.rosterHash, roll: roll2Served });
    assert(c2.subject === null && c2.root === root.pk && check2(c2.root).ok && !check2(twigA.pk).ok,
        "and it checks out with the root's key, and with no other key on the list");
    revokeNodeRole(roleHolder.pk, 'admin', gen.pk);

    // Everyone set: the whole community decides a branch, as S5 built it.
    const toEveryone10 = await setDecider('everyone');
    assert(toEveryone10.status === 200, `an owner sets Everyone (${toEveryone10.status})`);
    const root3 = subjectWhere(freshOk);
    const twigs3 = [subjectWhere(freshOk), subjectWhere(freshOk)];
    for (const tw of twigs3) invitedBy.run(root3.pk, tw.pk);
    const branchKeys3 = [root3, ...twigs3].map(m => m.pk);
    pushes.length = 0;
    const b3 = de.pauseBranch(root3.pk, gen.pk, `A crowd of fakes brought in by ${root3.callsign}`, { freshProof: true, include: branchKeys3 });
    if (!b3.success) throw new Error(`setup: could not pause the branch of ${root3.callsign}: ${b3.error}`);
    const branchVote3 = b3.decision.id;
    await settle(500);
    const everyonePushed = new Set(pushes.filter(p => p.k === 'decision.removal').flatMap(p => p.to));
    const bp3 = paramsOf(branchVote3);
    assert(bp3.decider === 'everyone' && !('jury' in bp3) && de.juryOf(de.getDecision(branchVote3)!) === null
        && rollOf(branchVote3).length === 0 && poolRowOf(branchVote3) === undefined,
        `with Everyone set, the branch vote records that everyone decides it: no jury, roll or pool (${JSON.stringify(bp3.decider)})`);
    const eligible = members.filter(m => m !== gen && m !== ada && statusOf(m) === 'active' && !branchKeys3.includes(m.pk));
    const outsider = eligible[0];
    assert(everyonePushed.has(outsider.token) && everyonePushed.size > 15, `"a vote opened" goes to every voter, not to a jury (${everyonePushed.size} phones)`);
    const outsiderLine = await branchLine(outsider);
    assert(outsiderLine === 1, `Home asks a member on no jury to vote on it (${outsiderLine})`);
    const cast = eligible.slice(0, 15).map(m => de.castDecisionVote(branchVote3, m.pk, true));
    assert(cast.every(c => c.success), `15 members on no jury vote on it (${cast.filter(c => c.success).length} of 15)`);
    const listedVoter = de.castDecisionVote(branchVote3, twigs3[0].pk, true);
    assert(!listedVoter.success && listedVoter.error === de.OWN_REMOVAL_VOTE_ERROR, `an account on its list may not vote on it, by S5's rule (${listedVoter.error})`);
    raw.run(branchVote3, twigs3[1].pk, new Date().toISOString(), new Date().toISOString());
    const bt = de.tallyDecision(branchVote3);
    assert(bt.decider === undefined && bt.totalVoters === 15 && bt.yesWeight === 15 && bt.noWeight === 0,
        `its tally is S5's: all 15 count, more than a jury seats, and the listed account's row does not (${bt.totalVoters} voted, ${bt.yesWeight} Yes, decider ${bt.decider})`);
    assert(bt.electorate > 12 && bt.minYes === 3 && bt.thresholdRequired !== 2 / 3 && bt.quorumRequired >= 3,
        `over the community, not a roll: electorate ${bt.electorate}, at least ${bt.minYes} Yes, threshold ${bt.thresholdRequired}`);
    fresh();
    const branchCard = await signed('GET', `/api/commons/decisions/${branchVote3}?draws=branch`, eligible[20]);
    assert(branchCard.status === 200 && branchCard.body?.tally?.yesWeight === 15 && branchCard.body?.tally?.passed !== undefined,
        `a member reads its split while it is open, as any community vote's (${JSON.stringify(branchCard.body?.tally?.yesWeight)})`);
    fresh();
    const branchJury = await signed('GET', `/api/commons/decisions/${branchVote3}/jury`, outsider);
    assert(branchJury.status === 404, `it has no jury: 404 (${branchJury.status})`);

    // Automatic below the line: a branch whose pool, without the accounts its card names, is 99 is decided by everyone.
    const backToAuto = await setDecider('automatic');
    assert(backToAuto.status === 200, `an owner sets Automatic again (${backToAuto.status})`);
    const root4 = subjectWhere(freshOk);
    const twigs4 = [subjectWhere(freshOk), subjectWhere(freshOk)];
    for (const tw of twigs4) invitedBy.run(root4.pk, tw.pk);
    const pool4 = expectedPool([root4, ...twigs4]);
    const hid4 = pool4.filter(k => k !== gen.pk).slice(0, pool4.length - 99);
    hide(hid4);
    const b4 = de.pauseBranch(root4.pk, gen.pk, `A crowd of fakes brought in by ${root4.callsign}`, { freshProof: true, include: [root4, ...twigs4].map(m => m.pk) });
    unhide(hid4);
    if (!b4.success) throw new Error(`setup: could not pause the branch of ${root4.callsign}: ${b4.error}`);
    assert(paramsOf(b4.decision.id).decider === 'everyone' && rollOf(b4.decision.id).length === 0 && poolRowOf(b4.decision.id) === undefined,
        `under Automatic, 99 who could serve once the card's three accounts are out: everyone decides the branch (${paramsOf(b4.decision.id).decider})`);

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

    assert(offMachine.length === 0, `nothing left this machine (${offMachine.join(', ') || 'none'})`);
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
