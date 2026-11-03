/**
 * Removal by a drawn jury, slice J1: the draw and the roll (scratch/fable-design/DESIGN-removal-jury-fable.md §2–§6, §11;
 * Marty accepted all ten answers 29 Oct). In a community whose owners chose it, a pause made where the eligible pool is
 * at or over the line draws a jury of 12 (core juryDraw), passes over everyone with a conflict, records the draw on the
 * vote (params.decider, params.jury) and its pool and roll on the node, and only the jury's votes count.
 *
 * Boots the real server. The setting goes through the owners' real route; the vote's card and the jury are read through
 * the real signature middleware. Expo is answered here; nothing leaves this machine.
 *
 *  1. Behind the setting: on a 150-member node with no choice made, a pause is decided by everyone, as before (J1 ships
 *     behind the setting until the apps can show a jury, slice J3).
 *  2. Who decides a removal: an owner sets Automatic; A jury is locked (pool_too_small) while fewer than 36 could serve.
 *  3. The draw on 150 members: the pool is exactly the members of 30 days (never the subject, the admin pausing them, a
 *     newcomer or a frozen account); its hash, the jury's size and rule on the vote; every member with a conflict Sam
 *     can't make alone, at the head of the draw, stood aside (a reporter, the inviter, an invitee, one who blocked Sam, a
 *     deal completed in 90 days, an open deal they opened, a chat they opened, kept for them alone because Sam blocks them
 *     or not), one whose trade is older than 90 days seated; what Sam does alone stands nobody aside (Marty, 3 Nov: five
 *     Sam blocked, a chat and a deal request Sam sent that nobody answered); the roll is the head of the draw, and it
 *     checks out with core's checkJuryDraw.
 *  4. Only the jury votes: a member not drawn and one passed over are refused; a juror votes; a vote row written for anyone
 *     off the roll is not counted. While open members read the turnout, never the split; the push goes to the jury and the
 *     member, nobody else.
 *  5. GET /api/commons/decisions/:id/jury through the middleware: a member reads the pool and the facts and can recompute
 *     the draw; a juror reads their own seat; nobody else is named while open; a member Sam blocked reads exactly what a
 *     juror with no link to Sam reads, and one passed over reads no reason; a non-member and an unsigned caller are
 *     refused; a vote no jury decides is a 404.
 *  6. The tally over the roll (§5): 6 Yes to 3 No removes (the grace window opens), 5 to 4 doesn't and the pause lifts,
 *     8 votes is too few and the pause lifts. Closed, the jury, who stood aside and who voted are named, never which way,
 *     and the roll still checks out.
 *  7. The line: 99 in the pool is decided by everyone, 100 by a jury; Everyone set is everyone at 150.
 *  8. Votes off: a pause opens no vote and draws nobody.
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
import { checkJuryDraw, juryOrder, juryRosterHash, jurySnapshotDate } from '@beanpool/core';

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
    // Not in any pool: two who joined 10 days ago, and one whose credit an admin froze.
    const newcomers = [seedMember('NewNed', 10), seedMember('NewNia', 10)];
    const frozen = seedMember('FrozenFay');
    db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(frozen.pk);
    const byKey = new Map([...members, ...newcomers, frozen].map(m => [m.pk, m]));
    const ownerSession = ownerSessionHeaders(gen.pk);

    const today = jurySnapshotDate(Date.now());
    /**
     * The pool, worked out here from who was seeded rather than by the code under test: the members of 60 days who are
     * active, or paused with nothing but their own open vote holding them (never one in a removal's grace window).
     */
    const expectedPool = (exclude: Id[]) => {
        const out = new Set(exclude.map(e => e.pk));
        const live = new Set((db.prepare(`
            SELECT public_key FROM members m WHERE m.status = 'active' OR (m.status = 'disabled'
              AND EXISTS (SELECT 1 FROM decisions d WHERE d.subject = m.public_key AND d.status = 'open' AND d.effect = 'remove_member')
              AND NOT EXISTS (SELECT 1 FROM decisions g WHERE g.subject = m.public_key AND g.status = 'execution_pending_grace'))
        `).all() as Array<{ public_key: string }>).map(r => r.public_key));
        const old = new Set((db.prepare('SELECT public_key FROM members WHERE julianday(joined_at) <= julianday(?)').all(ago(31 * DAY)) as Array<{ public_key: string }>)
            .map(r => r.public_key));
        return members.filter(m => !out.has(m.pk) && live.has(m.pk) && old.has(m.pk)).map(m => m.pk);
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

    // ── 1. Behind the setting ───────────────────────────────────────────────────────────────────────────────────────
    console.log('1. Behind the setting: no choice made, everyone decides, even at 150');
    const shape0 = readShape().settings.removalDecider;
    assert(shape0.configured === 'everyone' && shape0.value === 'everyone' && shape0.source === 'default' && shape0.lock === null && shape0.poolSize === 150,
        `How this community works reads Who decides a removal: everyone, the default for now, no lock, 150 could serve (${JSON.stringify(shape0)})`);
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
    const tooRecent = members.slice(30).map(m => m.pk);
    const joinedOf = new Map(tooRecent.map(k => [k, (db.prepare('SELECT joined_at FROM members WHERE public_key = ?').get(k) as { joined_at: string }).joined_at]));
    db.prepare(`UPDATE members SET joined_at = ? WHERE public_key IN (${tooRecent.map(() => '?').join(',')})`).run(ago(5 * DAY), ...tooRecent);
    const locked = readShape().settings.removalDecider;
    assert(locked.lock?.code === 'pool_too_small' && locked.poolSize === 30, `with 30 who could serve, A jury is locked: pool_too_small (${JSON.stringify(locked.lock)})`);
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
    const sam = nextSubject();
    const pool = expectedPool([sam, ada]);
    const { order } = juryOrder(pool, sam.pk, today);
    const at = (i: number) => byKey.get(order[i])!;
    // The head of the draw, each with a conflict only this node knows of. order[9]'s deal with Sam is older than 90 days.
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
    // A chat a member opened with Sam while Sam blocks them is kept for them alone (engine/withheld-lines.ts); it stands them
    // aside as at(7)'s does, or who stood aside would say who Sam blocks. at(15)'s is still kept; at(16)'s became the real one
    // when Sam, the block lifted, opened a chat with them, under Sam's name: at(16)'s line kept from before is older than it.
    block.run(sam.pk, at(15).pk);
    db.prepare('INSERT INTO withheld_conversations (id, owner_pubkey, other_pubkey, created_at) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), at(15).pk, sam.pk, ago(2 * DAY));
    const promoted = dm(sam, at(16), ago(DAY));
    db.prepare("INSERT INTO withheld_lines (id, conversation_id, author_pubkey, ciphertext, nonce, timestamp) VALUES (?, ?, ?, 'c', 'n', ?)")
        .run(crypto.randomUUID(), promoted, at(16).pk, ago(3 * DAY));
    const asideAt = [0, 1, 2, 4, 5, 6, 7, 15, 16];
    const seatedAt = [3, 8, 9, 10, 11, 12, 13, 14, 17, 18, 19, 20];
    pushes.length = 0;
    const samVote = pauseOf(sam);
    const params = paramsOf(samVote);
    assert(params.decider === 'jury' && params.jury?.snapshotDate === today && params.jury?.size === 12 && params.jury?.mustVote === 9
        && params.jury?.minYes === 6 && params.jury?.poolSize === 148,
        `the vote records a jury: today's snapshot, 12 seated, 9 must vote, at least 6 Yes, a pool of 148 (${JSON.stringify(params.jury)})`);
    assert(params.jury?.rosterHash === juryRosterHash(pool), 'its roster hash is the hash of the pool worked out here');
    const stored = poolRowOf(samVote)?.split('\n') ?? [];
    assert(JSON.stringify(stored) === JSON.stringify([...pool].sort()), `the node keeps that pool, sorted as hashed (${stored.length} keys)`);
    assert(!stored.includes(sam.pk) && !stored.includes(ada.pk) && !newcomers.some(n => stored.includes(n.pk)) && !stored.includes(frozen.pk),
        'never the subject, the admin pausing them, a member of 10 days or a frozen account');
    const roll = rollOf(samVote);
    const aside = roll.filter(r => r.status === 'stood_aside').map(r => r.k);
    const seated = roll.filter(r => r.status === 'on').map(r => r.k);
    const keysAt = (is: number[]) => is.map(i => order[i]).sort();
    assert(JSON.stringify([...aside].sort()) === JSON.stringify(keysAt(asideAt)),
        `the reporter, the inviter, an invitee, the one who blocked Sam, the 90-day partner, the deal and the chats they opened stood aside: 9 (${aside.length})`);
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
    assert(open.status === 200 && open.body.jury.rosterHash === params.jury.rosterHash && served.length === 148 && open.body.jury.you === null,
        `a member reads the pool (148), its hash and the facts; they are on no roll (${open.status})`);
    assert(checkJuryDraw({ pool: served, subject: open.body.jury.subject, snapshotDate: open.body.jury.snapshotDate, rosterHash: open.body.jury.rosterHash }).ok,
        'and can recompute the hash from what was served');
    assert(open.body.jury.pool.every((p: any) => typeof p.callsign === 'string'), 'each with their name, to hold against the People list');
    assert(!('jury' in open.body.jury) && !('stoodAside' in open.body.jury) && !('voted' in open.body.jury), 'while open, nobody on the jury is named');
    fresh();
    const mine = await signed('GET', `/api/commons/decisions/${samVote}/jury`, jurors[2]);
    fresh();
    const mineAside = await signed('GET', `/api/commons/decisions/${samVote}/jury`, at(4));
    assert(mine.body?.jury?.you === 'on' && mineAside.body?.jury?.you === 'stood_aside', `a juror reads their own seat; one passed over reads that (${mine.body?.jury?.you}, ${mineAside.body?.jury?.you})`);
    // Nothing a member reads says Sam blocked them (Marty, 3 Nov: no reason shown may reveal a block). A member Sam blocked
    // reads, byte for byte, what a juror with no link to Sam reads; one passed over is told no reason, only where they stand,
    // and is refused a vote in the words a member not drawn is.
    fresh();
    const blockedBySam = await signed('GET', `/api/commons/decisions/${samVote}/jury`, at(3));
    fresh();
    const noLink = await signed('GET', `/api/commons/decisions/${samVote}/jury`, at(17));
    assert(blockedBySam.status === 200 && blockedBySam.text === noLink.text && blockedBySam.body?.jury?.you === 'on',
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
    const names = (xs: any[] | undefined) => (xs ?? []).map((x: any) => x.publicKey).sort();
    assert(JSON.stringify(names(closed.body?.jury?.jury)) === JSON.stringify([...seated].sort())
        && JSON.stringify(names(closed.body?.jury?.stoodAside)) === JSON.stringify([...aside].sort())
        && names(closed.body?.jury?.voted).length === 9 && names(closed.body?.jury?.didNotVote).length === 3,
        'closed: the jury, who stood aside, the 9 who voted and the 3 who did not are named');
    assert(!closed.text.includes('"support"') && !JSON.stringify(closed.body?.jury?.voted).includes('true'), 'never which way anyone voted');
    assert((closed.body?.jury?.stoodAside ?? []).every((x: any) => Object.keys(x).sort().join(',') === 'callsign,publicKey')
        && !/block|reason|why/i.test(closed.text) && !samBlocks.some(b => names(closed.body?.jury?.stoodAside).includes(b.pk)),
        'who stood aside is named with no reason, and none of the five Sam blocked is among them');
    const closedRoll = [...names(closed.body?.jury?.jury), ...names(closed.body?.jury?.stoodAside)];
    assert(checkJuryDraw({ pool: (closed.body?.jury?.pool ?? []).map((p: any) => p.publicKey), subject: sam.pk, snapshotDate: today, rosterHash: params.jury.rosterHash, roll: closedRoll }).ok,
        'and what was served checks out: the roll is the head of the draw');
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
    const poolNow = expectedPool([vic, ada]);
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
    const hid100 = expectedPool([wil, ada]).filter(k => k !== gen.pk).slice(0, expectedPool([wil, ada]).length - 100);
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
    db.prepare("UPDATE decision_electors SET status = 'stood_aside' WHERE decision_id = ? AND member_pubkey = ?").run(wilVote, rollOf(wilVote)[0].k);
    assert(rollOf(wilVote)[0].status === 'stood_aside', 'and a juror can be stood aside in it');

    assert(offMachine.length === 0, `nothing left this machine (${offMachine.join(', ') || 'none'})`);
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
