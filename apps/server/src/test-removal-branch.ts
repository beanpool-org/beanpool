/**
 * Pause branch (removal by vote S5: scratch/fable-design/DESIGN-removal-by-vote-fable.md §3.5, §2 row 7; Marty 23 Oct
 * "Accept all"). An owner pauses a member and their whole invite branch at once, and ONE vote opens on removing every
 * account paused, "Remove these N accounts?" (decisions-engine.ts pauseBranch):
 *  1. Selection, as the burst cleanup selects (engine/burst-cleanup.ts): an established account in the branch is left off
 *     unless the owner names it, and named separately on the card; a role holder and an account already paused are left
 *     off; the root is the owner's choice. Refusals, each before the fresh proof: an admin, a short reason, a root holding a
 *     role, a branch of one, an owner from a computer (asked the phone).
 *  2. The pause: every listed account 'disabled' at once, nobody removed; one vote whose subject is null and whose params
 *     list them with the Beans each owes and their total; each listed account told, and every voter.
 *  3. The gate: the list and the vote by its id serve it only to an app that says it draws it (`draws=branch`), and Home's
 *     Decide card only to one that says it opens it (`lands=branch-vote`), so an app from before never gets a card it can't draw.
 *  4. Balances: a voter reads every account's and the total; a listed account its own only; anyone else none.
 *  5. The vote: nobody on the list votes on it or counts in its electorate; each keeps their vote on another Decision.
 *  6. Replies (Amendment A point 2, as S3b allows): each listed account replies on its own entry; someone not on it can't;
 *     an admin takes one down by naming the member, and they can't write another.
 *  7. Endings: No lifts every pause; a missed quorum lifts every pause; Yes opens one grace window, every account frozen,
 *     and its end removes each; a halt in the window gives them all back; lifting one by hand takes them off the list and
 *     the vote runs on for the others, its title and description saying the count left.
 *  8. The chain rules hold: after a branch's vote said No, an admin can't pause one of its accounts again, and an owner
 *     can't pause the branch again with the same reason. An account that LEFT the list keeps that pause on its record, as
 *     one member's removal does: brought back by the community's vote in the window, the owner who paused waits out the
 *     cool-down and a re-pause is an owner's with a new reason; lifted by hand, a third pause in 90 days is refused, on a
 *     new key too. And that vote holds them no more: paused alone again, they are in no window of it and vote elsewhere.
 *  9. Votes off: no branch pause (404 feature_off), and the owner's prune branch works as before.
 * 10. A re-key of an account on the list (engine/key-move.ts) moves it on the vote, mid-vote and mid-grace: No lifts its new
 *     key's pause, Yes removes its new key, a halt gives it back, and Offboard settling the others leaves the window open.
 * 11. The community's own vote to bring one account back (unsuspend_member), passed in the window, takes it off the list:
 *     the window's end removes the others, never them, and the record names them. Passed while the vote is open, the same.
 *
 * Boots the real server; the routes go over HTTPS through the real admin sessions and the real signature middleware.
 * Expo is answered here: nothing leaves this machine.
 *
 * Run (as test-all does, through scripts/run-server-suites.mjs):
 *   SERVER_SUITES_ONLY=test-removal-branch node scripts/run-server-suites.mjs
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
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

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
    throw new Error(`test-removal-branch: refused a request off this machine: ${url.hostname}`);
}) as typeof fetch;

let run = 0, passed = 0;
/** The story's figures are Beans; the node's are whole hundredths (exact for every figure here). */
const hc = (beans: number) => Math.round(beans * 100);
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string; token: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { pubKeyHex, privateKey, callsign, token: `ExponentPushToken[rb-${crypto.randomBytes(6).toString('hex')}]` };
}

function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = { method, path: p.split('?')[0], timestamp: ts, nonce, body };
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': signRequest(id.privateKey, canonical),
        [SIGNED_FOR_HEADER]: signedForHost(),
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

async function signed(method: 'GET' | 'POST', p: string, id: Id, payload?: unknown): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return answerOf(await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...signedHeaders(method, p, body, id) },
        ...(body ? { body } : {}),
    }));
}

async function admin(method: 'GET' | 'POST', p: string, session: Record<string, string>, payload?: unknown): Promise<Answer> {
    return answerOf(await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...session },
        ...(method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
    }));
}

const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const REASON = 'One member invited a crowd of fake accounts this week';

async function main() {
    console.log('Pause branch: one vote on a whole invite branch...\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const de = await import('./decisions-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { resetAdminAuthTarpit, FRESH_PROOF_PHONE_REQUIRED_CODE } = await import('./admin-auth.js');
    const { db } = await import('./db/db.js');
    const { setSwitchOverride } = await import('./config/node-profile.js');
    const { ownerSessionHeaders, ownerPhoneSessionHeaders } = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { setSimulatedDiskUsageForTesting } = await import('./engine/storage-health.js');
    const { completeRekey, issueRekeyCode, executeOffboard } = await import('./engine/member-wizards.js');

    await initTls();
    se.initStateEngine();
    setSimulatedDiskUsageForTesting(10);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const fresh = () => { resetAdminAuthTarpit(); resetAdminRateLimit(); resetGatewayRateLimit(); };

    // ── The people ──────────────────────────────────────────────────────────────────────────────────────────────────
    const gen = keypair('GenesisGwen');
    se.seedGenesisMember(gen.pubKeyHex, gen.callsign);
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(90 * DAY), gen.pubKeyHex);
    const seed = (callsign: string, invitedBy: Id, joinedDaysAgo: number, active = true): Id => {
        const id = keypair(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(id.pubKeyHex, callsign, ago(joinedDaysAgo * DAY), invitedBy.pubKeyHex, `INV-${callsign.toUpperCase()}`);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pubKeyHex);
        if (active) db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(new Date().toISOString(), id.pubKeyHex);
        se.registerPushToken(id.pubKeyHex, id.token, 'android');
        return id;
    };
    const otto = seed('OwnerOtto', gen, 60, false);
    grantNodeRole(otto.pubKeyHex, 'owner', gen.pubKeyHex);
    const ada = seed('AdminAda', gen, 60, false);
    grantNodeRole(ada.pubKeyHex, 'admin', gen.pubKeyHex);
    // Seven voters, invited by Gwen, outside every branch below.
    const voters = Array.from({ length: 7 }, (_, i) => seed(`Voter${i}`, gen, 30));
    const statusOf = (id: Id) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(id.pubKeyHex) as { status: string }).status;
    const frozenOf = (id: Id) => (db.prepare('SELECT COALESCE(credit_frozen, 0) AS f FROM members WHERE public_key = ?').get(id.pubKeyHex) as { f: number }).f;
    const row = (decisionId: string): any => db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
    const sessionOf = (id: Id, role: 'admin' | 'owner') => {
        const { handshakeToken } = mintHandshakeToken(id.pubKeyHex, role);
        const s = consumeHandshakeToken(handshakeToken);
        if (!s.ok || !s.sessionId) throw new Error(`could not open ${id.callsign}'s key session: ${s.error}`);
        return { 'X-Admin-Session': s.sessionId };
    };
    const adaSession = sessionOf(ada, 'admin');
    const ottoComputer = ownerSessionHeaders(otto.pubKeyHex);
    const ottoPhone = () => ownerPhoneSessionHeaders(otto.pubKeyHex);
    /** A branch of fakes under `root`: root invites a and b, a invites c (all new, so not established). */
    const branchOf = (tag: string) => {
        const root = seed(`${tag}Root`, gen, 2);
        const a = seed(`${tag}A`, root, 1);
        const b = seed(`${tag}B`, root, 1);
        const c = seed(`${tag}C`, a, 1);
        return { root, a, b, c, all: [root, a, b, c] };
    };
    const pauseRoute = async (root: Id, session: Record<string, string>, body: Record<string, unknown>) => {
        fresh();
        return admin('POST', `/api/local/admin/branches/${root.pubKeyHex}/pause`, session, body);
    };
    const closeNow = (id: string) => {
        db.prepare('UPDATE decisions SET closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
        de.tickDecisions();
    };
    const vote = (id: string, yes: Id[], no: Id[]) => {
        for (const v of yes) { const r = de.castDecisionVote(id, v.pubKeyHex, true); if (!r.success) throw new Error(`setup: ${v.callsign} Yes: ${r.error}`); }
        for (const v of no) { const r = de.castDecisionVote(id, v.pubKeyHex, false); if (!r.success) throw new Error(`setup: ${v.callsign} No: ${r.error}`); }
    };
    /** The owner's branch pause, from the phone with the fresh proof: its vote's id. */
    const pauseBranchNow = async (root: Id, reason = REASON, include: Id[] = []): Promise<string> => {
        const r = await pauseRoute(root, ottoPhone(), { reason, include: include.map(i => i.pubKeyHex) });
        if (r.status !== 200 || !r.body?.decision?.id) throw new Error(`setup: could not pause ${root.callsign}'s branch: ${r.status} ${r.text}`);
        return r.body.decision.id;
    };

    /** The member's key replaced, as Settings → Re-Key does (completeRekey): the same person on a new key. */
    const rekey = (from: Id): Id => {
        const to = keypair(from.callsign);
        completeRekey(from.pubKeyHex, to.pubKeyHex, issueRekeyCode(from.pubKeyHex, 'owner:password').code, 'owner:password');
        return to;
    };
    const listedKeys = (decisionId: string) => (JSON.parse(row(decisionId).params).branch as any[]).map((e) => e.pubkey);

    // ── 1. Selection and refusals ───────────────────────────────────────────────────────────────────────────────────
    console.log('1. Selection and refusals');
    const s1 = branchOf('Sel');
    const settled = seed('SelSettled', s1.b, 60);           // joined 60 days ago: established (8 weeks of standing)
    const modInBranch = seed('SelMod', s1.root, 1);
    grantNodeRole(modInBranch.pubKeyHex, 'admin', gen.pubKeyHex);
    fresh();
    const preview = await admin('GET', `/api/local/admin/branches/${s1.root.pubKeyHex}/pause`, ottoComputer);
    const listedNames = (preview.body?.accounts ?? []).filter((a: any) => a.listed).map((a: any) => a.name).sort();
    const leftOff = Object.fromEntries((preview.body?.accounts ?? []).filter((a: any) => !a.listed).map((a: any) => [a.name, a.leftOff]));
    assert(preview.status === 200 && JSON.stringify(listedNames) === JSON.stringify(['SelA', 'SelB', 'SelC', 'SelRoot']),
        `the preview lists the root and the new accounts under it (${preview.status} ${JSON.stringify(listedNames)})`);
    assert(leftOff.SelSettled === 'established' && leftOff.SelMod === 'role',
        `an established account and an admin are left off, each saying why (${JSON.stringify(leftOff)})`);
    fresh();
    const named = await admin('GET', `/api/local/admin/branches/${s1.root.pubKeyHex}/pause?include=${settled.pubKeyHex}`, ottoComputer);
    assert((named.body?.accounts ?? []).some((a: any) => a.name === 'SelSettled' && a.listed),
        'named by the owner, the established account is listed too');
    fresh();
    const previewByAdmin = await admin('GET', `/api/local/admin/branches/${s1.root.pubKeyHex}/pause`, adaSession);
    assert(previewByAdmin.status === 403, `an admin who is no owner is refused even the preview (${previewByAdmin.status})`);

    const byAdmin = await pauseRoute(s1.root, adaSession, { reason: REASON });
    assert(byAdmin.status === 403 && s1.all.every(i => statusOf(i) === 'active'), `an admin is refused, nobody paused (${byAdmin.status})`);
    const shortReason = await pauseRoute(s1.root, ottoComputer, { reason: 'too short' });
    assert(shortReason.status === 400 && /at least 10 characters/.test(shortReason.body?.error ?? ''),
        `a short reason is refused before any proof is asked (${shortReason.status} ${shortReason.body?.error})`);
    const fromComputer = await pauseRoute(s1.root, ottoComputer, { reason: REASON });
    assert(fromComputer.status === 403 && fromComputer.body?.code === FRESH_PROOF_PHONE_REQUIRED_CODE && s1.all.every(i => statusOf(i) === 'active'),
        `an owner from a computer is asked to do it from the phone, nobody paused (${fromComputer.status} ${fromComputer.body?.code})`);
    const roleRoot = await pauseRoute(modInBranch, ottoPhone(), { reason: REASON });
    assert(roleRoot.status === 400 && roleRoot.body?.error === de.BRANCH_ROOT_HOLDS_ROLE,
        `a root who holds a role is refused: no vote removes one (${roleRoot.status})`);
    const loner = seed('SelLoner', gen, 1);
    const ofOne = await pauseRoute(loner, ottoPhone(), { reason: REASON });
    assert(ofOne.status === 409 && ofOne.body?.error === de.BRANCH_OF_ONE && statusOf(loner) === 'active',
        `a branch of one is refused: that is one member's pause (${ofOne.status})`);

    // ── 2. The pause ────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n2. The pause: every listed account paused, one vote, nobody removed');
    // 40 and 25 Beans owed, in whole hundredths.
    db.prepare('UPDATE accounts SET balance_c = ? WHERE public_key = ?').run(hc(-40), s1.a.pubKeyHex);
    db.prepare('UPDATE accounts SET balance_c = ? WHERE public_key = ?').run(hc(-25), s1.c.pubKeyHex);
    pushes.length = 0;
    const id1 = await pauseBranchNow(s1.root);
    const d1 = row(id1);
    const p1 = JSON.parse(d1.params);
    assert(s1.all.every(i => statusOf(i) === 'disabled') && statusOf(settled) === 'active' && statusOf(modInBranch) === 'active',
        `every listed account is paused; the established one and the admin are not (${s1.all.map(statusOf).join(',')} / ${statusOf(settled)} / ${statusOf(modInBranch)})`);
    assert(s1.all.every(i => statusOf(i) !== 'pruned'), 'nobody is removed by the pause');
    assert(d1.subject === null && d1.effect === 'remove_member' && d1.author_pubkey === 'SYSTEM' && d1.title === 'Remove these 4 accounts?'
        && p1.rule === de.PAUSE_VOTE_RULE && p1.branch.length === 4 && p1.branchDebt === hc(65),
        `one vote, its subject null, "${d1.title}", its list of ${p1.branch?.length} owing ${p1.branchDebt} hundredths together`);
    assert(p1.established?.length === 1 && p1.established[0].name === 'SelSettled' && p1.root?.name === 'SelRoot',
        `the established account left off is named separately (${JSON.stringify(p1.established?.map((e: any) => e.name))})`);
    await new Promise(r => setTimeout(r, 300));
    const toldMembers = pushes.filter(p => p.k === 'account.removal-vote').flatMap(p => p.to);
    const toldVoters = pushes.filter(p => p.k === 'decision.removal').flatMap(p => p.to);
    assert(s1.all.every(i => toldMembers.includes(i.token)), `every listed account is told (${toldMembers.length} pushes)`);
    assert(voters.every(v => toldVoters.includes(v.token)) && !s1.all.some(i => toldVoters.includes(i.token)),
        'every voter is told, and nobody on the list is asked to vote');

    // ── 3. The gate ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n3. Only an app that draws a branch\'s vote is given one');
    fresh();
    const oldList = await signed('GET', '/api/commons/decisions', voters[0]);
    fresh();
    const newList = await signed('GET', '/api/commons/decisions?draws=branch', voters[0]);
    assert(oldList.status === 200 && !(oldList.body?.decisions ?? []).some((d: any) => d.id === id1),
        'an app that does not say it draws it is not given it in the list');
    assert((newList.body?.decisions ?? []).some((d: any) => d.id === id1), 'an app that says draws=branch is');
    fresh();
    const oldOne = await signed('GET', `/api/commons/decisions/${id1}`, voters[0]);
    fresh();
    const newOne = await signed('GET', `/api/commons/decisions/${id1}?draws=branch`, voters[0]);
    assert(oldOne.status === 404 && newOne.status === 200, `nor by its id (${oldOne.status}), unless it says so (${newOne.status})`);
    // Home's Decide card opens that list: an older app gets no row for it there, nor counts it (lands=branch-vote).
    const decideOf = (a: Answer) => a.body?.cards?.decide;
    fresh();
    const homeOld = await signed('GET', '/api/home?cards=decide', voters[0]);
    fresh();
    const homeNew = await signed('GET', '/api/home?cards=decide&lands=branch-vote', voters[0]);
    assert(homeOld.status === 200 && !(decideOf(homeOld)?.items ?? []).some((i: any) => i.id === id1)
        && (decideOf(homeOld)?.open ?? 0) === (decideOf(homeNew)?.open ?? 0) - 1,
        `Home's Decide card gives an older app no row for it, nor counts it (${JSON.stringify(decideOf(homeOld) ?? null)})`);
    assert((decideOf(homeNew)?.items ?? []).some((i: any) => i.id === id1 && i.title === 'Remove these 4 accounts?'),
        'an app that says lands=branch-vote is given its row');

    // ── 4. Balances ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n4. Who reads the Beans each account owes');
    const asVoter = newOne.body?.decision?.params;
    // Each entry's figures are whole hundredths (balance_c, debt_c); the total keeps its name, branchDebt, in hundredths.
    assert(asVoter?.branchDebt === hc(65) && asVoter.branch.find((e: any) => e.name === 'SelA')?.debt_c === hc(40),
        `a voter reads each account's debt and the total (${asVoter?.branchDebt})`);
    fresh();
    const asListed = (await signed('GET', `/api/commons/decisions/${id1}?draws=branch`, s1.a)).body?.decision?.params;
    assert(asListed && asListed.branchDebt === undefined && asListed.branch.find((e: any) => e.name === 'SelA')?.debt_c === hc(40)
        && asListed.branch.find((e: any) => e.name === 'SelC')?.debt_c === undefined && asListed.branch.find((e: any) => e.name === 'SelC')?.balance_c === undefined,
        'an account on the list reads its own, and not the others\' nor the total');
    const latecomer = seed('Latecomer', gen, 0);
    fresh();
    const asLate = (await signed('GET', `/api/commons/decisions/${id1}?draws=branch`, latecomer)).body?.decision?.params;
    assert(asLate && asLate.branchDebt === undefined && asLate.branch.every((e: any) => e.debt_c === undefined && e.balance_c === undefined),
        'someone who may not vote on it reads no balance at all');
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(latecomer.pubKeyHex);

    // ── 5. The vote ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n5. Nobody on the list votes on it; each keeps their vote elsewhere');
    const own = de.castDecisionVote(id1, s1.c.pubKeyHex, true);
    assert(!own.success && own.error === de.OWN_REMOVAL_VOTE_ERROR, `an account on the list can't vote on it (${own.error})`);
    const tally1 = de.tallyDecision(id1);
    // Active now and able to vote: the 7 voters, the established account, the admin in the branch and the loner (10), and
    // the 4 on the list, who are paused by nothing but this vote and so count anywhere else (14).
    const counted = de.getActiveMembersCount30d(Date.now(), row(id1).opens_at, []);
    assert(counted === 14 && tally1.electorate === 10,
        `its electorate leaves out the 4 on the list (${tally1.electorate} of the ${counted} who could vote elsewhere)`);
    const other = seed('OtherSubject', gen, 30);
    const single = de.adminEmergencySuspend(other.pubKeyHex, ada.pubKeyHex, 'A separate case about someone else', { freshProof: true });
    const elsewhere = single.decision ? de.castDecisionVote(single.decision.id, s1.c.pubKeyHex, false) : { success: false, error: 'no vote' };
    assert(single.success && elsewhere.success, `a paused account on the list still votes on another Decision (${elsewhere.error ?? 'cast'})`);
    if (single.decision) de.adminLiftSuspension(other.pubKeyHex, ada.pubKeyHex);

    // ── 6. Replies ──────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n6. Each account on the list replies to the case for itself');
    fresh();
    const reply = await signed('POST', `/api/commons/decisions/${id1}/reply`, s1.c, { reply: 'I am a real person; I joined to trade apples.' });
    assert(reply.status === 200 && JSON.parse(row(id1).params).branch.find((e: any) => e.pubkey === s1.c.pubKeyHex)?.reply === 'I am a real person; I joined to trade apples.',
        `a paused account on the list replies, on its own entry (${reply.status})`);
    fresh();
    const notListed = await signed('POST', `/api/commons/decisions/${id1}/reply`, settled, { reply: 'Not about me' });
    assert(notListed.status === 403, `someone not on the list can't (${notListed.status})`);
    fresh();
    const unnamed = await admin('POST', `/api/local/admin/decisions/${id1}/hide-reply`, adaSession, { reason: 'It names a neighbour by address' });
    fresh();
    const hidden = await admin('POST', `/api/local/admin/decisions/${id1}/hide-reply`, adaSession, { reason: 'It names a neighbour by address', member: s1.c.pubKeyHex });
    const cEntry = JSON.parse(row(id1).params).branch.find((e: any) => e.pubkey === s1.c.pubKeyHex);
    assert(unnamed.status === 400 && hidden.status === 200 && cEntry.reply === undefined && cEntry.replyHiddenReason === 'It names a neighbour by address',
        `an admin takes one reply down by naming its member (${unnamed.status}, then ${hidden.status})`);
    fresh();
    const membersView = (await signed('GET', `/api/commons/decisions/${id1}?draws=branch`, voters[1])).body?.decision?.params?.branch ?? [];
    assert(!JSON.stringify(membersView).includes(ada.pubKeyHex), 'members never read which admin took it down');
    fresh();
    const again = await signed('POST', `/api/commons/decisions/${id1}/reply`, s1.c, { reply: 'Again' });
    assert(again.status === 409, `the member can't write another on that vote (${again.status})`);

    // ── 7. Endings ──────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n7. Endings');
    vote(id1, voters.slice(0, 2), voters.slice(2, 5));
    closeNow(id1);
    assert(row(id1).status === 'failed' && s1.all.every(i => statusOf(i) === 'active'),
        `No: the vote fails and every pause lifts (${row(id1).status}; ${s1.all.map(statusOf).join(',')})`);

    const s2 = branchOf('Quiet');
    const id2 = await pauseBranchNow(s2.root);
    vote(id2, voters.slice(0, 1), []);
    closeNow(id2);
    assert(row(id2).status === 'unresolved' && s2.all.every(i => statusOf(i) === 'active'),
        `a missed quorum: every pause lifts (${row(id2).status})`);

    const s3 = branchOf('Yes');
    const id3 = await pauseBranchNow(s3.root);
    vote(id3, voters.slice(0, 5), voters.slice(5, 6));
    closeNow(id3);
    assert(row(id3).status === 'execution_pending_grace' && s3.all.every(i => statusOf(i) === 'disabled' && frozenOf(i) === 1),
        `Yes: one grace window, every account still paused and frozen (${row(id3).status})`);
    const inGrace = se.removalInGraceOf(s3.c.pubKeyHex);
    assert(inGrace?.id === id3, 'each account on the list is in that removal\'s grace window (Settings, Offboard)');
    const liftInGrace = de.adminLiftSuspension(s3.b.pubKeyHex, ada.pubKeyHex);
    assert(!liftInGrace.success && liftInGrace.status === 409, `an admin can't lift one in the window: halt it instead (${liftInGrace.error})`);
    // The offboarding wizard settles one account early: that one is removed, and the window runs on for the others.
    const settledEarly = executeOffboard(s3.a.pubKeyHex, { resolution: 'prune_zero_balance' }, ada.pubKeyHex);
    assert(settledEarly.success && statusOf(s3.a) === 'pruned' && row(id3).status === 'execution_pending_grace'
        && [s3.root, s3.b, s3.c].every(i => statusOf(i) === 'disabled'),
        `Offboard settles one account early; the vote stays in its window for the other 3, still paused (${row(id3).status})`);
    db.prepare('UPDATE decisions SET grace_period_ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id3);
    de.tickDecisions();
    assert(row(id3).status === 'executed' && s3.all.every(i => statusOf(i) === 'pruned'),
        `the window's end removes each account (${row(id3).status}; ${s3.all.map(statusOf).join(',')})`);

    const s4 = branchOf('Halt');
    const id4 = await pauseBranchNow(s4.root);
    vote(id4, voters, []);
    closeNow(id4);
    const halted = de.adminHaltDecision(id4, ada.pubKeyHex, 'The invites were real after all, we checked');
    assert(halted.success && row(id4).status === 'admin_halted' && s4.all.every(i => statusOf(i) === 'active' && frozenOf(i) === 0),
        `a halt in the window gives every account back, unfrozen (${row(id4).status})`);

    const s5 = branchOf('Lift');
    const id5 = await pauseBranchNow(s5.root);
    const liftOne = de.adminLiftSuspension(s5.b.pubKeyHex, ada.pubKeyHex);
    const p5 = JSON.parse(row(id5).params);
    assert(liftOne.success && statusOf(s5.b) === 'active' && row(id5).status === 'open' && p5.branch.length === 3
        && !p5.branch.some((e: any) => e.pubkey === s5.b.pubKeyHex) && p5.lifted?.[0]?.name === 'LiftB',
        `lifting one by hand takes them off the list; the vote runs on for the other ${p5.branch.length}`);
    assert([s5.root, s5.a, s5.c].every(i => statusOf(i) === 'disabled'), 'the others stay paused');
    assert(row(id5).title === 'Remove these 3 accounts?' && /the 3 accounts still paused in it/.test(row(id5).description)
        && !/\b4\b/.test(row(id5).description),
        `its title and description say the count left ("${row(id5).title}" / "${row(id5).description}")`);
    fresh();
    const liftedHome = await signed('GET', '/api/home?cards=decide&lands=branch-vote', voters[0]);
    assert((decideOf(liftedHome)?.items ?? []).some((i: any) => i.id === id5 && i.title === 'Remove these 3 accounts?'),
        'Home reads the count left too');
    vote(id5, voters, []);
    closeNow(id5);
    db.prepare('UPDATE decisions SET grace_period_ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id5);
    de.tickDecisions();
    assert(statusOf(s5.b) === 'active' && [s5.root, s5.a, s5.c].every(i => statusOf(i) === 'pruned'),
        'the one lifted is not removed when the vote carries; the others are');

    // ── 8. The chain rules ──────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n8. The chain rules hold for an account a branch\'s vote did not remove');
    const repause = de.adminEmergencySuspend(s1.a.pubKeyHex, ada.pubKeyHex, 'Another case about the same account', { freshProof: true });
    assert(!repause.success && repause.code === de.REPAUSE_NEEDS_OWNER_CODE,
        `an admin can't pause one of its accounts again within 30 days (${repause.code})`);
    const coolDown = await pauseRoute(s1.root, ottoPhone(), { reason: 'A new reason, given by the same owner as before' });
    assert(coolDown.status === 403 && coolDown.body?.code === de.REMOVAL_COOL_DOWN_CODE && s1.all.every(i => statusOf(i) === 'active'),
        `the owner who brought that vote waits out the cool-down, nobody paused (${coolDown.status} ${coolDown.body?.code})`);
    const sameReason = await pauseRoute(s1.root, ownerPhoneSessionHeaders(gen.pubKeyHex), { reason: REASON });
    assert(sameReason.status === 400 && sameReason.body?.code === de.REPAUSE_SAME_REASON_CODE && s1.all.every(i => statusOf(i) === 'active'),
        `another owner can't pause the branch again with the same reason, nobody paused (${sameReason.status} ${sameReason.body?.code})`);

    // An account that LEFT the list keeps that pause on its record: brought back by the community's vote, or lifted by hand.
    // The accounts the sections above brought back count in every electorate now: they leave, so the 7 voters reach quorum.
    for (const id of [...s1.all, ...s2.all, ...s4.all, s5.b, settled, modInBranch, loner, other]) {
        db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(id.pubKeyHex);
    }
    const bringBackVote = (who: Id) => {
        const d = de.createDecision({ authorPubkey: ada.pubKeyHex, title: `Bring ${who.callsign} back`, description: `${who.callsign} is a real neighbour; we know them`,
            touches: 'member', effect: 'unsuspend_member', subject: who.pubKeyHex });
        vote(d.id, voters.slice(0, 5), []);
        closeNow(d.id);
        return d.id;
    };
    const NEW_CASE = 'A new case about this one account, a week later';
    // (a) Yes, then the community brings one account back in the window: as for one member's removal, the owner who paused
    // waits out the cool-down, and pausing them again within 30 days is an owner's, with a new reason.
    const g = branchOf('Again');
    const idG = await pauseBranchNow(g.root);
    vote(idG, voters.slice(0, 5), []);
    closeNow(idG);
    const ottoActor = JSON.parse(row(idG).params).pausedBy as string;
    const backG = bringBackVote(g.b);
    assert(row(backG).status === 'executed' && statusOf(g.b) === 'active' && row(idG).status === 'execution_pending_grace' && !listedKeys(idG).includes(g.b.pubKeyHex),
        `setup: the community brings ${g.b.callsign} back in the window; they leave the list (${row(idG).status})`);
    const againG = de.adminEmergencySuspend(g.b.pubKeyHex, ottoActor, REASON, { freshProof: true });
    const needsOwnerG = de.repauseNeedsOwner(g.b.pubKeyHex);
    const solo = seed('SoloX', gen, 1);
    const soloPause = de.adminEmergencySuspend(solo.pubKeyHex, ottoActor, REASON, { freshProof: true });
    if (!soloPause.success || !soloPause.decision) throw new Error(`setup: could not pause SoloX alone: ${soloPause.error}`);
    vote(soloPause.decision.id, voters.slice(0, 5), []);
    closeNow(soloPause.decision.id);
    bringBackVote(solo);
    const againSolo = de.adminEmergencySuspend(solo.pubKeyHex, ottoActor, REASON, { freshProof: true });
    assert(row(soloPause.decision.id).status === 'failed' && !againSolo.success && againSolo.code === de.REMOVAL_COOL_DOWN_CODE && de.repauseNeedsOwner(solo.pubKeyHex),
        `control, one member's removal: brought back in the window, the owner's same-reason re-pause is refused (${againSolo.code}) and a re-pause is an owner's`);
    assert(!againG.success && againG.code === againSolo.code && statusOf(g.b) === 'active',
        `the same for one account a branch's vote listed: the owner who paused the branch is refused (${againG.code ?? 'PAUSED'}), still active`);
    assert(needsOwnerG, `and pausing them again within 30 days is an owner's (repauseNeedsOwner ${needsOwnerG})`);
    const sameReasonG = de.pauseChainRefusal(g.b.pubKeyHex, 'owner:password', REASON);
    assert(sameReasonG?.code === de.REPAUSE_SAME_REASON_CODE, `another owner can't pause them again with the branch's reason (${sameReasonG?.code ?? 'allowed'})`);
    // (b) An admin lifts one account by hand while the vote is open: that pause stays on its record. Paused alone again (an
    // owner, a new reason), a third pause in 90 days is refused.
    const h = branchOf('Thrice');
    const idH = await pauseBranchNow(h.root);
    const liftH = de.adminLiftSuspension(h.b.pubKeyHex, ada.pubKeyHex);
    assert(liftH.success && statusOf(h.b) === 'active' && row(idH).status === 'open' && !listedKeys(idH).includes(h.b.pubKeyHex),
        `setup: lifted by hand, ${h.b.callsign} leaves the open vote's list`);
    const byAdminH = de.adminEmergencySuspend(h.b.pubKeyHex, ada.pubKeyHex, NEW_CASE, { freshProof: true });
    assert(!byAdminH.success && byAdminH.code === de.REPAUSE_NEEDS_OWNER_CODE,
        `an admin can't pause them again within 30 days of that lift, as after one member's pause lifted by hand (${byAdminH.code ?? 'PAUSED'})`);
    const secondH = de.adminEmergencySuspend(h.b.pubKeyHex, 'owner:password', NEW_CASE, { freshProof: true });
    assert(secondH.success && statusOf(h.b) === 'disabled', `an owner pauses them alone again, with a new reason (${secondH.error ?? 'paused'})`);
    de.adminLiftSuspension(h.b.pubKeyHex, ada.pubKeyHex);
    const thirdH = de.adminEmergencySuspend(h.b.pubKeyHex, ada.pubKeyHex, 'A third case about the same account again', { freshProof: true });
    assert(!thirdH.success && thirdH.code === de.THIRD_PAUSE_CODE && statusOf(h.b) === 'active',
        `a third pause within 90 days is refused, the branch's pause counted (${thirdH.code ?? 'PAUSED'})`);
    // A re-key moves the lifted entry with the account (engine/key-move.ts): on its new key, the third pause is still refused.
    const hb2 = rekey(h.b);
    const thirdOnNewKey = de.pauseChainRefusal(hb2.pubKeyHex, ada.pubKeyHex, 'A third case about the same account again');
    assert(thirdOnNewKey?.code === de.THIRD_PAUSE_CODE && JSON.parse(row(idH).params).lifted?.some((l: any) => l.pubkey === hb2.pubKeyHex),
        `re-keyed, the account's lifted entry moves to its new key, and a third pause is still refused (${thirdOnNewKey?.code ?? 'allowed'})`);
    // The control: an account off a branch's list is not held by that vote. Paused alone again, it is paused by nothing
    // but its own open vote, outside the branch's window, so it still votes on another Decision.
    const soloG = de.adminEmergencySuspend(g.b.pubKeyHex, 'owner:password', NEW_CASE, { freshProof: true });
    const castByG = de.castDecisionVote(idH, g.b.pubKeyHex, false);
    assert(soloG.success && statusOf(g.b) === 'disabled' && se.removalInGraceOf(g.b.pubKeyHex) === null && castByG.success,
        `control: off the list, paused alone again, they are in no window of the branch's and still vote elsewhere (${castByG.error ?? 'cast'})`);

    // ── 9. Votes off ────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n9. Votes off: no branch vote, and the prune branch as before');
    setSwitchOverride('decisions', false);
    const s6 = branchOf('Off');
    const offPause = await pauseRoute(s6.root, ottoPhone(), { reason: REASON });
    assert(offPause.status === 404 && s6.all.every(i => statusOf(i) === 'active'), `no branch pause where votes are off (${offPause.status})`);
    fresh();
    const offPrune = await admin('POST', `/api/local/admin/branches/${s6.root.pubKeyHex}/prune`, ottoPhone(), {});
    assert(offPrune.status === 200 && s6.all.every(i => statusOf(i) === 'pruned'), `the owner's prune branch works as before (${offPrune.status} ${offPrune.body?.error ?? ''})`);
    setSwitchOverride('decisions', true);

    // ── 10. A re-key moves an account on the list ───────────────────────────────────────────────────────────────────
    console.log('\n10. A re-key moves an account on the list: mid-vote and mid-grace, then No, Yes and a halt');
    // The accounts §8 brought back, or left paused only by an open vote, count in every electorate: they leave too.
    for (const id of [...g.all, ...h.all, hb2, solo]) {
        db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(id.pubKeyHex);
    }
    const gone = (id: Id) => (db.prepare('SELECT COUNT(*) AS c FROM members WHERE public_key = ?').get(id.pubKeyHex) as { c: number }).c === 0;

    const k1 = branchOf('KeyNo');
    const idK1 = await pauseBranchNow(k1.root);
    const k1b = rekey(k1.b);
    assert(gone(k1.b) && statusOf(k1b) === 'disabled' && listedKeys(idK1).includes(k1b.pubKeyHex) && !listedKeys(idK1).includes(k1.b.pubKeyHex),
        'a re-key mid-vote moves the account on the list to its new key, still paused');
    vote(idK1, voters.slice(0, 2), voters.slice(2, 5));
    closeNow(idK1);
    assert(row(idK1).status === 'failed' && [k1.root, k1.a, k1b, k1.c].every(i => statusOf(i) === 'active'),
        `No: every pause lifts, the new key's included (${[k1.root, k1.a, k1b, k1.c].map(statusOf).join(',')})`);

    const k2 = branchOf('KeyYes');
    const idK2 = await pauseBranchNow(k2.root);
    const k2c = rekey(k2.c);
    vote(idK2, voters.slice(0, 5), voters.slice(5, 6));
    closeNow(idK2);
    assert(row(idK2).status === 'execution_pending_grace' && statusOf(k2c) === 'disabled' && frozenOf(k2c) === 1,
        `Yes: the account re-keyed mid-vote waits out the window on its new key, frozen (${statusOf(k2c)}, ${frozenOf(k2c)})`);
    const k2a = rekey(k2.a);
    assert(listedKeys(idK2).includes(k2a.pubKeyHex) && se.removalInGraceOf(k2a.pubKeyHex)?.id === idK2 && statusOf(k2a) === 'disabled',
        'a re-key mid-grace keeps the new key on the list, in the window, paused');
    // Offboard settles the two not re-keyed: the window runs on for the two re-keyed, as their new keys are still here.
    executeOffboard(k2.root.pubKeyHex, { resolution: 'prune_zero_balance' }, ada.pubKeyHex);
    executeOffboard(k2.b.pubKeyHex, { resolution: 'prune_zero_balance' }, ada.pubKeyHex);
    assert(statusOf(k2.root) === 'pruned' && statusOf(k2.b) === 'pruned' && row(idK2).status === 'execution_pending_grace',
        `Offboard settling the others leaves the vote in its window for the re-keyed two (${row(idK2).status})`);
    db.prepare('UPDATE decisions SET grace_period_ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), idK2);
    de.tickDecisions();
    assert(row(idK2).status === 'executed' && statusOf(k2a) === 'pruned' && statusOf(k2c) === 'pruned' && !/not removed/i.test(row(idK2).execution_reason ?? ''),
        `the window's end removes both re-keyed accounts on their new keys (${statusOf(k2a)}, ${statusOf(k2c)}; "${row(idK2).execution_reason}")`);

    const k3 = branchOf('KeyHalt');
    const idK3 = await pauseBranchNow(k3.root);
    vote(idK3, voters, []);
    closeNow(idK3);
    const k3b = rekey(k3.b);
    const haltK3 = de.adminHaltDecision(idK3, ada.pubKeyHex, 'We checked: these invites were real people after all');
    assert(haltK3.success && [k3.root, k3.a, k3b, k3.c].every(i => statusOf(i) === 'active' && frozenOf(i) === 0),
        `a halt in the window gives back the account re-keyed mid-grace too, unfrozen (${statusOf(k3b)}, ${frozenOf(k3b)})`);

    // ── 11. The community's own vote brings one back ────────────────────────────────────────────────────────────────
    console.log('\n11. A vote to bring one account back, passed in the window, takes it off the list');
    const b1 = branchOf('Back');
    const idB1 = await pauseBranchNow(b1.root);
    vote(idB1, voters.slice(0, 5), []);
    closeNow(idB1);
    const bringBack = de.createDecision({ authorPubkey: ada.pubKeyHex, title: 'Bring BackB back', description: 'BackB is a real neighbour; we know them',
        touches: 'member', effect: 'unsuspend_member', subject: b1.b.pubKeyHex });
    vote(bringBack.id, voters.slice(0, 5), []);
    closeNow(bringBack.id);
    const pB1 = JSON.parse(row(idB1).params);
    assert(row(bringBack.id).status === 'executed' && statusOf(b1.b) === 'active' && frozenOf(b1.b) === 0,
        `the vote to bring them back is carried out (${row(bringBack.id).status}, ${statusOf(b1.b)})`);
    assert(row(idB1).status === 'execution_pending_grace' && !listedKeys(idB1).includes(b1.b.pubKeyHex)
        && pB1.lifted?.some((l: any) => l.pubkey === b1.b.pubKeyHex && l.byVote === bringBack.id) && row(idB1).title === 'Remove these 3 accounts?',
        `they leave the branch's list, its record naming that vote; it runs on for the other 3 (${row(idB1).status}, "${row(idB1).title}")`);
    db.prepare('UPDATE decisions SET grace_period_ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), idB1);
    de.tickDecisions();
    assert(statusOf(b1.b) === 'active' && [b1.root, b1.a, b1.c].every(i => statusOf(i) === 'pruned')
        && /Brought back by a community vote, so not removed: BackB/.test(row(idB1).execution_reason ?? ''),
        `the window's end removes the others, never them, and the record says so ("${row(idB1).execution_reason}")`);
    // Passed while the branch's vote is still open: they leave its list as well, and it runs on for the others.
    const b2 = branchOf('Early');
    const idB2 = await pauseBranchNow(b2.root);
    const bringBackEarly = de.createDecision({ authorPubkey: ada.pubKeyHex, title: 'Bring EarlyA back', description: 'EarlyA is a real neighbour; we know them',
        touches: 'member', effect: 'unsuspend_member', subject: b2.a.pubKeyHex });
    vote(bringBackEarly.id, voters, []);
    closeNow(bringBackEarly.id);
    assert(row(bringBackEarly.id).status === 'executed' && statusOf(b2.a) === 'active' && row(idB2).status === 'open'
        && !listedKeys(idB2).includes(b2.a.pubKeyHex) && row(idB2).title === 'Remove these 3 accounts?'
        && JSON.parse(row(idB2).params).lifted?.some((l: any) => l.pubkey === b2.a.pubKeyHex && l.byVote === bringBackEarly.id),
        `passed while the branch's vote is open, they leave its list and it runs on for the other 3 (${row(idB2).status}, "${row(idB2).title}")`);

    assert(offMachine.length === 0, `nothing was asked of a server off this machine (${offMachine.join(', ') || 'none'})`);
    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
