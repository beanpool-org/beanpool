/**
 * Fair removal votes (removal by vote, Amendment A points 2–5 and the push: scratch/fable-design/DESIGN-removal-by-vote-fable.md
 * "Amendment A", Marty 24 Oct). Only an admin's pause opens a vote on removing a member (point 1, slice S3); this suite
 * covers the rest.
 *
 * Boots the real server; every request goes over HTTPS through the real signature middleware and real admin sessions (an
 * admin's key session, and the password with a 2FA code). Expo is answered here: nothing leaves this machine.
 *
 *  1. The push. When a pause opens its vote, everyone who may vote on it gets one push (`decision.removal`), and the
 *     member it is about gets their own (`account.removal-vote`), which comes through with their chat alerts off. Not the
 *     admin who paused, a member whose credit is frozen, an enterprise's account, a voter with chat alerts off, or one who
 *     joined after the vote opened; a member paused by their own vote still is (they keep their vote elsewhere). The lock
 *     screen shows each kind's fixed words; nothing that leaves names the member, the admin or the case, and the details
 *     only open Commons, Decide. The member is told at once on the web too: a kept notice, read when the web app opens.
 *     A pause through a report pushes the same. With votes off a pause opens no vote and pushes nothing of the kind.
 *  2. The proposer is named on the card: the admin who paused, by name and never by key; an owner with the server's
 *     password, as such; a member's own proposal from before, by name. Another Decision names nobody.
 *  3. The right of reply: the member (paused) replies, signed, and everyone who reads the vote sees it beside the case;
 *     they can change it; nobody else can write it; empty, too long, or once the vote has closed is refused; the words go
 *     nowhere but the vote (no push, no notice, no log line). Votes off: 404 feature_off. A member who deletes their
 *     account takes their reply with them, while the vote is open or after it removed them: gone from the card, the row
 *     and a standby's copy.
 *  4. A case shown false is hidden: an admin hides it with a public reason, and members (the member included) read that
 *     reason in its place, no case, no reason in the params, a member's own title replaced, on Decide and on Home; who
 *     brought it and the reply stay; the admin's list keeps the case and who hid it. Once only; a reason of 10+
 *     characters; only a removal vote; only an admin. A closed vote's case too, from the admin list's past removals.
 *  5. The member reports the case as a false accusation: a report about whoever brought it, in Reports; the answer names
 *     nobody; once while it waits; only the member; a password's case names nobody to report. A member who already had a
 *     report waiting about that admin (the retaliation it is for) has the case added to it, and the owners are told.
 *  6. The cool-down: whoever brought a vote on removing someone that ended without removing them (No, too few voting, or
 *     stopped before it closed) can't pause them again for 90 days, by the route or through a report, and nothing is
 *     written; another admin can; a removal the community passed and an admin halted in its grace window doesn't count;
 *     after 90 days it lifts; with votes off it doesn't apply.
 *  7. The upgrade: a decisions table from before gains the eight columns, every row kept.
 *  8. A reply that harms someone is taken down (the deciding review of #2585): an owner or admin takes it down with a public
 *     reason; never a moderator, a member, a short reason, a vote with no reply, nor twice. Its words are gone from every
 *     read: Decide's list and the vote itself (to a voter, the member it names, and the member), a member's open app, Home,
 *     the admins' list, the vote's row, a standby's next copy and a whole copy; members read the reason in its place, never
 *     who. The member is told (a push of its own kind and a kept notice, neither saying why or who) and can't write another,
 *     open or closed. A closed vote's reply comes down too. On a standby, hiding a case and taking down a reply are refused
 *     with its JSON answer, and nothing is written.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-removal-fairness.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_ROLE;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;

import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { PUSH_NOTICE_KINDS, PUSH_NOTICE_TITLE, reportKind } from '@beanpool/core';

// Expo is answered here, so every push is measured without leaving this machine; nothing else off it is reached.
const realFetch = globalThis.fetch;
const expo: any[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://exp.host')) {
        const msgs = JSON.parse(String(init?.body ?? '[]'));
        expo.push(...msgs);
        return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (!url.startsWith('https://localhost')) throw new Error(`test-removal-fairness: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

let BASE = '';
let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string; token: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { pubKeyHex, privateKey, callsign, token: `ExponentPushToken[rf-${pubKeyHex.slice(0, 12)}]` };
}

function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
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

/** A member's signed request. */
async function signed(method: 'GET' | 'POST', p: string, id: Id, payload?: unknown): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return answerOf(await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...signedHeaders(method, p, body, id) },
        ...(body ? { body } : {}),
    }));
}

/** The same request, unsigned. */
async function unsigned(method: 'GET' | 'POST', p: string, payload?: unknown): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return answerOf(await fetch(`${BASE}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body } : {}) }));
}

/** An admin route under `session`'s headers (a key session, or the password with a 2FA code). */
async function admin(p: string, session: Record<string, string>, payload?: unknown): Promise<Answer> {
    return answerOf(await fetch(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...session },
        body: JSON.stringify(payload ?? {}),
    }));
}

/** A member's open app: their live socket, signed as the apps sign it, and every event it is sent, as sent. */
function memberSocket(id: Id): Promise<{ ws: WebSocket; raw: string[] }> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const raw: string[] = [];
        ws.on('message', (d) => raw.push(d.toString()));
        ws.on('open', () => resolve({ ws, raw }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}

/** Waits (up to 3 s) for the pushes a request set off: Expo is called after the answer. */
async function settle(done: () => boolean): Promise<void> {
    for (let i = 0; i < 60 && !done(); i++) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 100));
}

const ADMIN_PW = 'Removal-Fairness-Admin-Pw-47!';
const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAVE_CASE = 'Took deposits for repairs and never came back, three times';

async function main() {
    console.log('Fair removal votes: the member told and heard, the proposer named, a false case hidden, a cool-down...\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const de = await import('./decisions-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { db, addRemovalCaseColumns, REMOVAL_CASE_COLUMNS } = await import('./db/db.js');
    const { createTableText } = await import('./db/table-rules.js');
    const { setSwitchOverride } = await import('./config/node-profile.js');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { ownerSessionHeaders, turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { setNodeRole, STANDBY_CODE } = await import('./config/node-role.js');
    const alerts = await import('./services/alerts.js');
    const fixture: any = await import('./decisions-from-before-test-fixture.js');

    await initTls();
    se.initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    const twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // ── The people ──────────────────────────────────────────────────────────────────────────────────────────────────
    const gen = keypair('GenesisGwen');
    se.seedGenesisMember(gen.pubKeyHex, gen.callsign);
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(60 * DAY), gen.pubKeyHex);
    se.registerPushToken(gen.pubKeyHex, gen.token, 'android');
    const seed = (callsign: string, opts: { joinedAt?: string; token?: boolean } = {}): Id => {
        const id = keypair(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(id.pubKeyHex, callsign, opts.joinedAt ?? ago(30 * DAY), gen.pubKeyHex, `INV-${callsign.toUpperCase()}`);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pubKeyHex);
        se.transfer('genesis', id.pubKeyHex, 20, `seed ${callsign}`, 'direct', true);
        if (opts.token !== false) se.registerPushToken(id.pubKeyHex, id.token, 'android');
        return id;
    };
    const otto = seed('OwnerOtto');   // a second owner: pausing one asks an owner's fresh proof
    grantNodeRole(otto.pubKeyHex, 'owner', gen.pubKeyHex);
    const ada = seed('AdminAda');
    grantNodeRole(ada.pubKeyHex, 'admin', gen.pubKeyHex);
    const abe = seed('AdminAbe');
    grantNodeRole(abe.pubKeyHex, 'admin', gen.pubKeyHex);
    const voters = ['VoterVi', 'VoterWu', 'VoterXo', 'VoterYa', 'VoterZed'].map(n => seed(n));
    const [vi] = voters;
    const dave = seed('DaveDoe');     // the member a pause's vote is about
    const erin = seed('ErinEast');    // paused with the server's password
    const finn = seed('FinnFox');     // a removal a member proposed before proposing one closed
    const gus = seed('GusGrey');      // a removal the community passed, halted in its grace window
    const hal = seed('HalHill');      // votes off
    const pia = seed('PiaPark');      // paused already: she keeps her vote on others' removals
    const tia = seed('TraderTia');    // proposed Finn's removal before
    const fay = seed('FrozenFay');    // credit frozen: no vote
    db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(fay.pubKeyHex);
    const quinn = seed('QuietQuinn'); // chat alerts off
    se.setMemberPreferences(quinn.pubKeyHex, { notify_chat: false });
    // Dave has chat alerts off too: the alert about his own account comes through all the same.
    se.setMemberPreferences(dave.pubKeyHex, { notify_chat: false });
    const ent = seed('EggsEnterprise'); // an enterprise's account votes on nothing
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(ent.pubKeyHex);
    // Newt joins a minute after Dave's vote opens (his row is here, dated so): he may not vote on it, and is not told.
    const newt = seed('NewtNew', { joinedAt: new Date(Date.now() + 60_000).toISOString() });

    const sessionOf = (id: Id) => {
        const { handshakeToken } = mintHandshakeToken(id.pubKeyHex, 'admin');
        const s = consumeHandshakeToken(handshakeToken);
        if (!s.ok || !s.sessionId) throw new Error(`could not open ${id.callsign}'s key session: ${s.error}`);
        return { 'X-Admin-Session': s.sessionId };
    };
    const adaSession = sessionOf(ada);
    const abeSession = sessionOf(abe);
    const gwenSession = ownerSessionHeaders(gen.pubKeyHex);
    const password = () => twoFa.headers();
    const fresh = () => { resetAdminAuthTarpit(); resetAdminRateLimit(); resetGatewayRateLimit(); };
    const statusOf = (id: Id) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(id.pubKeyHex) as { status: string }).status;
    const row = (decisionId: string): any => db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
    const removalsOf = (id: Id) => (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE effect = 'remove_member' AND subject = ?").get(id.pubKeyHex) as { n: number }).n;
    const pause = async (session: Record<string, string>, who: Id, reason: string) => {
        fresh();
        return admin(`/api/local/admin/users/${who.pubKeyHex}/suspend`, session, { reason });
    };
    /** The community votes on Decision `id` (Yes, or No; none at all with `null`), it closes now, and the tick runs. */
    const voteAndClose = (id: string, yes: boolean | null) => {
        if (yes !== null) for (const v of voters) de.castDecisionVote(id, v.pubKeyHex, yes);
        db.prepare('UPDATE decisions SET closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
        de.tickDecisions();
    };
    const cardFor = async (reader: Id, decisionId: string) => {
        fresh();
        const r = await signed('GET', '/api/commons/decisions', reader);
        return { status: r.status, text: r.text, card: (r.body?.decisions ?? []).find((d: any) => d.id === decisionId) };
    };
    const pushesTo = (who: Id) => expo.filter(m => m.to === who.token);
    const kindOf = (m: any) => m?.data?.k;

    // Pia is paused first (by Abe): held by nothing but her own pause's vote, she keeps her vote on Dave's removal.
    const piaPause = await pause(abeSession, pia, 'Shouted at a stallholder at the market');
    assert(piaPause.status === 200 && statusOf(pia) === 'disabled', `setup: Pia is paused, her vote open (${piaPause.status})`);

    // ── 1. The push ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n1. The push, when a pause opens its vote');
    expo.length = 0;
    const davePaused = await pause(adaSession, dave, DAVE_CASE);
    const daveVote = davePaused.body?.decision?.id as string;
    assert(davePaused.status === 200 && !!daveVote && statusOf(dave) === 'disabled', `Ada pauses Dave; his vote opens (${davePaused.status})`);
    await settle(() => expo.length >= voters.length + 3);
    const toVoters = (who: Id) => pushesTo(who).filter(m => kindOf(m) === 'decision.removal');
    const told = [abe, ...voters, pia, gen];
    assert(told.every(v => toVoters(v).length === 1),
        `each member who may vote gets one push of kind decision.removal: Abe, the five voters, Pia (paused by her own vote) and Gwen (${told.map(v => `${v.callsign}:${toVoters(v).length}`).join(', ')})`);
    const notTold = [ada, dave, fay, quinn, ent, newt];
    assert(notTold.every(v => toVoters(v).length === 0),
        `no voters' push to Ada (who paused), Dave (it is about him), frozen Fay, Quinn (chat alerts off), the enterprise, or Newt (joined after it opened) (${notTold.map(v => `${v.callsign}:${toVoters(v).length}`).join(', ')})`);
    const toDave = pushesTo(dave);
    assert(toDave.length === 1 && kindOf(toDave[0]) === 'account.removal-vote',
        `Dave gets one push of his own, account.removal-vote, though his chat alerts are off (${toDave.map(kindOf).join(', ')})`);
    assert(expo.every(m => m.title === PUSH_NOTICE_TITLE && m.body === PUSH_NOTICE_KINDS[kindOf(m) as keyof typeof PUSH_NOTICE_KINDS]?.body),
        'every lock screen shows the fixed title and its kind\'s fixed words');
    const wire = JSON.stringify(expo);
    assert(![dave.callsign, DAVE_CASE, dave.pubKeyHex, ada.callsign, ada.pubKeyHex].some(s => wire.includes(s)),
        'nothing that left this machine names Dave, Ada or the case, by name or key');
    fresh();
    const viDetails = await signed('GET', `/api/notices/push/${toVoters(vi)[0]?.data?.i}`, vi);
    assert(viDetails.status === 200 && viDetails.body?.data?.screen === 'decide' && Object.keys(viDetails.body.data).length === 1
        && ![dave.callsign, DAVE_CASE, ada.callsign].some(s => viDetails.text.includes(s)),
        `the voter's details open Commons, Decide, and say nothing more (${viDetails.status} ${viDetails.text.slice(0, 160)})`);
    const daveDetails = await signed('GET', `/api/notices/push/${toDave[0]?.data?.i}`, dave);
    assert(daveDetails.status === 200 && daveDetails.body?.data?.screen === 'decide' && !daveDetails.text.includes(DAVE_CASE) && !daveDetails.text.includes(ada.callsign),
        `Dave's details open Decide too, without the case or who brought it (${daveDetails.status})`);
    const strangersRead = await signed('GET', `/api/notices/push/${toDave[0]?.data?.i}`, vi);
    assert(strangersRead.status === 404, `Vi can't read Dave's notice (${strangersRead.status})`);
    // On the web, which has no push: a kept notice the web app reads when it opens.
    fresh();
    const kept = await signed('GET', '/api/notices?unseen=1', dave);
    const keptNotice = (kept.body?.notices ?? []).find((n: any) => n.title === de.REMOVAL_VOTE_NOTICE_TITLE);
    assert(kept.status === 200 && !!keptNotice && keptNotice.body.includes(row(daveVote).closes_at.slice(0, 10))
        && !kept.text.includes(DAVE_CASE) && !kept.text.includes(ada.callsign),
        `Dave is told on the web too: a kept notice says a vote on his account runs until it closes, without the case (${kept.status} ${keptNotice?.body})`);
    const viKept = await signed('GET', '/api/notices?unseen=1', vi);
    assert(!(viKept.body?.notices ?? []).some((n: any) => n.title === de.REMOVAL_VOTE_NOTICE_TITLE), "no such notice is kept for a voter");

    // A pause through a report pushes the same.
    expo.length = 0;
    const gusReport = se.submitReport(vi.pubKeyHex, gus.pubKeyHex, 'Sold a bike that was not his to sell')!;
    fresh();
    const gusPaused = await admin(`/api/local/admin/reports/${gusReport.id}/action`, adaSession, { suspendUser: true });
    await settle(() => expo.length >= voters.length + 3);
    assert(gusPaused.status === 200 && statusOf(gus) === 'disabled' && pushesTo(gus).some(m => kindOf(m) === 'account.removal-vote')
        && voters.every(v => toVoters(v).length === 1),
        `a report's pause tells Gus and every voter the same way (${gusPaused.status}; Gus ${pushesTo(gus).map(kindOf).join(',')})`);
    const gusVote = (db.prepare("SELECT id FROM decisions WHERE subject = ? AND status = 'open' AND effect = 'remove_member'").get(gus.pubKeyHex) as { id: string }).id;

    // ── 2. The proposer is named ────────────────────────────────────────────────────────────────────────────────────
    console.log('\n2. The proposer is named on the card');
    const daveCard = await cardFor(vi, daveVote);
    assert(daveCard.card?.proposer?.kind === 'admin' && daveCard.card.proposer.name === ada.callsign,
        `Dave's card names who paused him: Ada (${JSON.stringify(daveCard.card?.proposer)})`);
    assert(!daveCard.text.includes(ada.pubKeyHex) && !('pausedBy' in (daveCard.card?.params ?? {})), "never by key: Ada's key is nowhere in the list");
    // By the name she had when she paused him: a name she takes later doesn't rewrite the record.
    db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run('AdaLater', ada.pubKeyHex);
    const renamed = await cardFor(vi, daveVote);
    db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run(ada.callsign, ada.pubKeyHex);
    assert(renamed.card?.proposer?.name === ada.callsign, `named as she was called when she paused him (${renamed.card?.proposer?.name})`);
    // A vote opened before the name was recorded names the admin as they are called now.
    const bare = de.getDecision(daveVote)!;
    const { pausedByName: _name, ...withoutName } = bare.params;
    assert(de.publicDecision({ ...bare, params: withoutName }).proposer?.name === ada.callsign, 'a pause vote with no recorded name names the admin by their name now');
    fresh();
    const erinPaused = await admin(`/api/local/admin/users/${erin.pubKeyHex}/suspend`, password(), { reason: 'Threatened a member in a direct message' });
    const erinVote = erinPaused.body?.decision?.id as string;
    const erinCard = await cardFor(vi, erinVote);
    assert(erinPaused.status === 200 && erinCard.card?.proposer?.kind === 'password' && erinCard.card.proposer.name === null,
        `a pause made with the server's password is named as an owner's, with no name (${erinPaused.status} ${JSON.stringify(erinCard.card?.proposer)})`);
    const finnVote = fixture.removalProposedFromBefore({
        authorPubkey: tia.pubKeyHex, title: 'Remove Finn the thief', description: 'Finn stole from the tool library, everyone knows it', subject: finn.pubKeyHex,
    }).id as string;
    const finnCard = await cardFor(vi, finnVote);
    assert(finnCard.card?.proposer?.kind === 'member' && finnCard.card.proposer.name === tia.callsign,
        `a removal a member proposed before names its author: Tia (${JSON.stringify(finnCard.card?.proposer)})`);
    const freeze = de.createDecision({
        authorPubkey: ada.pubKeyHex, title: 'Freeze Zed for a week', description: 'A plain Decision about a member, not a removal',
        touches: 'member', effect: 'freeze_credit', subject: voters[4].pubKeyHex,
    });
    const freezeCard = await cardFor(vi, freeze.id);
    assert(!!freezeCard.card && !('proposer' in freezeCard.card), 'a Decision that removes nobody carries no proposer');

    // ── 3. The right of reply ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n3. The right of reply');
    const REPLY = 'I fixed two of those bikes and refunded the third. Ask Wu, who was there.';
    const logged: string[] = [];
    const realLog = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const capture = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    console.log = capture; console.warn = capture; console.error = capture; console.info = capture;
    expo.length = 0;
    fresh();
    const replied = await signed('POST', `/api/commons/decisions/${daveVote}/reply`, dave, { reply: REPLY });
    await settle(() => false);
    Object.assign(console, realLog);
    assert(replied.status === 200 && replied.body?.decision?.subjectReply === REPLY, `Dave, paused, replies to the case, signed (${replied.status} ${replied.text.slice(0, 120)})`);
    const withReply = await cardFor(vi, daveVote);
    assert(withReply.card?.subjectReply === REPLY && !!withReply.card?.subjectRepliedAt, "a voter reads Dave's reply on the card, beside the case");
    assert(!logged.some(l => l.includes(REPLY)) && expo.length === 0
        && !(db.prepare('SELECT 1 FROM push_notices WHERE body LIKE ? OR title LIKE ?').get(`%fixed two%`, `%fixed two%`))
        && !(db.prepare('SELECT 1 FROM moderation_notices WHERE body LIKE ?').get('%fixed two%')),
        `the reply goes nowhere else: no log line, no push, no notice (${logged.filter(l => l.includes(REPLY)).length} lines, ${expo.length} pushes)`);
    const REPLY2 = 'Wu saw me refund the third bike on the 12th.';
    fresh();
    const changed = await signed('POST', `/api/commons/decisions/${daveVote}/reply`, dave, { reply: `  ${REPLY2}  ` });
    assert(changed.status === 200 && row(daveVote).subject_reply === REPLY2, `he changes it: the new reply replaces the old, trimmed (${changed.status})`);
    fresh();
    const byVoter = await signed('POST', `/api/commons/decisions/${daveVote}/reply`, vi, { reply: 'Not Dave writing this' });
    const byAdmin = await signed('POST', `/api/commons/decisions/${daveVote}/reply`, ada, { reply: 'Nor Ada' });
    const byNobody = await unsigned('POST', `/api/commons/decisions/${daveVote}/reply`, { reply: 'Nobody signed this' });
    assert(byVoter.status === 403 && byAdmin.status === 403 && byNobody.status === 401 && row(daveVote).subject_reply === REPLY2,
        `nobody else writes it: a voter 403, the admin who paused him 403, unsigned 401 (${byVoter.status} ${byAdmin.status} ${byNobody.status})`);
    fresh();
    const empty = await signed('POST', `/api/commons/decisions/${daveVote}/reply`, dave, { reply: '   ' });
    const long = await signed('POST', `/api/commons/decisions/${daveVote}/reply`, dave, { reply: 'x'.repeat(de.REMOVAL_REPLY_MAX_CHARS + 1) });
    const notText = await signed('POST', `/api/commons/decisions/${daveVote}/reply`, dave, { reply: ['a list'] });
    assert(empty.status === 400 && long.status === 400 && notText.status === 400 && row(daveVote).subject_reply === REPLY2,
        `empty, over ${de.REMOVAL_REPLY_MAX_CHARS} characters, or not text: 400, and the reply stays (${empty.status} ${long.status} ${notText.status})`);
    const noSuch = await signed('POST', `/api/commons/decisions/${crypto.randomUUID()}/reply`, dave, { reply: 'To nothing' });
    const notRemoval = await signed('POST', `/api/commons/decisions/${freeze.id}/reply`, voters[4], { reply: 'A freeze has no case to reply to here' });
    assert(noSuch.status === 404 && notRemoval.status === 404, `no such vote, or a Decision that removes nobody: 404 (${noSuch.status} ${notRemoval.status})`);
    // Deleting the account takes the reply with it, as it does every message the member wrote: Ivy deletes hers while her
    // vote is open; Jo, whom his vote removed, deletes his after it, through the one route a removed member's key still signs.
    const ivy = seed('IvyInk');
    const jo = seed('JoJones');
    const IVY_REPLY = 'My phone is 0400 123 456 and I live at 12 Example Street. This is false.';
    const JO_REPLY = 'Ring me on 0400 654 321 and I will tell you what happened at the market.';
    const ivyVote = (await pause(abeSession, ivy, 'Took a deposit for a market stall and kept it')).body?.decision?.id as string;
    const joVote = (await pause(abeSession, jo, 'Took a deposit for a bike repair and kept it')).body?.decision?.id as string;
    fresh();
    const ivyReplied = await signed('POST', `/api/commons/decisions/${ivyVote}/reply`, ivy, { reply: IVY_REPLY });
    const joReplied = await signed('POST', `/api/commons/decisions/${joVote}/reply`, jo, { reply: JO_REPLY });
    assert(ivyReplied.status === 200 && joReplied.status === 200 && row(ivyVote).subject_reply === IVY_REPLY && row(joVote).subject_reply === JO_REPLY,
        `Ivy and Jo, each paused, reply to their cases (${ivyReplied.status} ${joReplied.status})`);
    voteAndClose(joVote, true);
    db.prepare('UPDATE decisions SET grace_period_ends_at = ? WHERE id = ?').run(ago(1000), joVote);
    de.tickDecisions();
    assert(row(joVote).status === 'executed' && statusOf(jo) === 'pruned' && row(joVote).subject_reply === JO_REPLY,
        `the community removes Jo, and his reply stays on the closed vote (${row(joVote).status} ${statusOf(jo)})`);
    const beforeDeleting = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    fresh();
    const ivyDeletes = await signed('POST', '/api/member/purge', ivy);
    const joDeletes = await signed('POST', '/api/member/purge', jo);
    assert(ivyDeletes.status === 200 && ivyDeletes.body?.ok === true && joDeletes.status === 200 && joDeletes.body?.ok === true,
        `Ivy deletes her account, and Jo, removed, deletes his (${ivyDeletes.status} ${ivyDeletes.text.slice(0, 80)}; ${joDeletes.status} ${joDeletes.text.slice(0, 80)})`);
    for (const [who, vote, words] of [['Ivy', ivyVote, IVY_REPLY], ['Jo', joVote, JO_REPLY]]) {
        const c = await cardFor(vi, vote);
        assert(!!c.card && c.card.subjectReply === null && c.card.subjectRepliedAt === null && !c.text.includes(words),
            `${who}'s reply is gone from the card a voter reads, and from the whole list (${c.status} ${JSON.stringify(c.card?.subjectReply)})`);
        assert(row(vote).subject_reply === null && row(vote).subject_replied_at === null, `and from the vote's row: ${who}'s words and when they were written`);
    }
    const delta = await se.exportSyncState('removal-fairness', beforeDeleting) as { plainTables?: Record<string, any[]> };
    const carried = (delta.plainTables?.decisions ?? []).filter((d: any) => d.id === ivyVote || d.id === joVote);
    assert(carried.length === 2 && carried.every((d: any) => d.subject_reply === null && d.subject_replied_at === null),
        `a standby's next copy carries both votes without the replies, so it drops them too (${carried.length} rows)`);
    const wholeCopy = JSON.stringify(await se.exportSyncState('removal-fairness'));
    assert(![IVY_REPLY, JO_REPLY].some(w => wholeCopy.includes(w)), 'and a whole copy holds neither reply');

    // ── 4. A case shown false is hidden ─────────────────────────────────────────────────────────────────────────────
    console.log('\n4. A case shown false is hidden, with a public reason');
    const HIDE_WHY = 'Wu and the bike shop confirmed every repair was done or refunded';
    fresh();
    const tooShort = await admin(`/api/local/admin/decisions/${daveVote}/hide-case`, adaSession, { reason: 'false' });
    const hideFreeze = await admin(`/api/local/admin/decisions/${freeze.id}/hide-case`, adaSession, { reason: HIDE_WHY });
    const byMember = await signed('POST', `/api/local/admin/decisions/${daveVote}/hide-case`, vi, { reason: HIDE_WHY });
    assert(tooShort.status === 400 && hideFreeze.status === 404 && [401, 403].includes(byMember.status) && !row(daveVote).case_hidden_at,
        `a reason under 10 characters 400, a Decision that removes nobody 404, a member's signed request ${byMember.status}: nothing hidden (${tooShort.status} ${hideFreeze.status})`);
    fresh();
    const hidden = await admin(`/api/local/admin/decisions/${daveVote}/hide-case`, adaSession, { reason: HIDE_WHY });
    assert(hidden.status === 200 && row(daveVote).case_hidden_by === ada.pubKeyHex && row(daveVote).case_hidden_reason === HIDE_WHY && !!row(daveVote).case_hidden_at,
        `Ada hides Dave's case: kept as a halt is, when, who and why (${hidden.status} ${hidden.text.slice(0, 120)})`);
    for (const reader of [vi, dave]) {
        const c = await cardFor(reader, daveVote);
        assert(!c.text.includes(DAVE_CASE) && !('reason' in (c.card?.params ?? {})) && c.card?.caseHiddenReason === HIDE_WHY && !('caseHiddenBy' in (c.card ?? {}))
            && c.card?.description.includes(HIDE_WHY) && c.card?.proposer?.name === ada.callsign && c.card?.subjectReply === REPLY2 && c.card?.status === 'open',
            `${reader.callsign} reads the reason in the case's place; the case, and who hid it, are gone; who brought it, the reply and the vote stay`);
    }
    fresh();
    const adminList = await admin('/api/local/admin/decisions', adaSession);
    const adminRow = (adminList.body?.decisions ?? []).find((d: any) => d.id === daveVote);
    assert(adminRow?.description.includes(DAVE_CASE) && adminRow?.caseHiddenBy === ada.pubKeyHex, "the admins' list keeps the case and who hid it");
    const engineHide = de.adminHideCase(finnVote, vi.pubKeyHex, 'A member asking the engine itself');
    assert(!engineHide.success && engineHide.status === 403 && !row(finnVote).case_hidden_at, 'the engine refuses a member underneath, whatever route reaches it');
    fresh();
    const again = await admin(`/api/local/admin/decisions/${daveVote}/hide-case`, abeSession, { reason: 'Hiding it a second time' });
    assert(again.status === 409 && row(daveVote).case_hidden_by === ada.pubKeyHex, `once only: a second hide 409 (${again.status})`);
    // A member's own removal title, which may carry the accusation, goes too: on Decide and on Home.
    fresh();
    const finnHidden = await admin(`/api/local/admin/decisions/${finnVote}/hide-case`, abeSession, { reason: 'Finn borrowed the drill with the steward\'s say-so' });
    const finnAfter = await cardFor(vi, finnVote);
    // Home's Decide card lists the soonest closing first: Finn's closes first, so its row is there.
    db.prepare('UPDATE decisions SET closes_at = ? WHERE id = ?').run(new Date(Date.now() + 3600_000).toISOString(), finnVote);
    fresh();
    const home = await signed('GET', '/api/home?cards=needs,decide', vi);
    const homeRow = (home.body?.cards?.decide?.items ?? []).find((i: any) => i.id === finnVote);
    assert(finnHidden.status === 200 && finnAfter.card?.title === 'Remove FinnFox?' && !finnAfter.text.includes('thief') && !finnAfter.text.includes('stole')
        && home.status === 200 && homeRow?.title === 'Remove FinnFox?' && !home.text.includes('thief'),
        `a member's own title gives way to the node's, on Decide and on Home (${finnHidden.status} "${finnAfter.card?.title}"; home ${home.status} "${homeRow?.title}")`);

    // ── 5. Reporting the case as false ──────────────────────────────────────────────────────────────────────────────
    console.log('\n5. The member reports the case as a false accusation');
    fresh();
    const reported = await signed('POST', `/api/commons/decisions/${daveVote}/report`, dave, { words: 'Ada knew the bikes were done' });
    const reportRow = db.prepare('SELECT * FROM abuse_reports WHERE reporter_pubkey = ? AND target_pubkey = ?').get(dave.pubKeyHex, ada.pubKeyHex) as any;
    assert(reported.status === 200 && !!reportRow && reportRow.status === 'pending' && /false accusation/i.test(reportRow.reason)
        && reportRow.reason.includes(daveVote.slice(0, 8)) && reportRow.reason.includes('Ada knew the bikes were done'),
        `Dave's report is about Ada, who brought the case, and says which vote (${reported.status} ${reportRow?.reason})`);
    assert(!reported.text.includes(ada.pubKeyHex), "the answer names nobody: Ada's key is not in it");
    fresh();
    const twice = await signed('POST', `/api/commons/decisions/${daveVote}/report`, dave, {});
    assert(twice.status === 200 && twice.body?.duplicate === true
        && (db.prepare('SELECT COUNT(*) AS n FROM abuse_reports WHERE reporter_pubkey = ? AND target_pubkey = ?').get(dave.pubKeyHex, ada.pubKeyHex) as any).n === 1,
        `once while it waits: a repeat files nothing new (${twice.status})`);
    const byOther = await signed('POST', `/api/commons/decisions/${daveVote}/report`, vi, {});
    const pwCase = await signed('POST', `/api/commons/decisions/${erinVote}/report`, erin, {});
    const notCase = await signed('POST', `/api/commons/decisions/${freeze.id}/report`, voters[4], {});
    const unsignedReport = await unsigned('POST', `/api/commons/decisions/${daveVote}/report`, {});
    assert(byOther.status === 403 && pwCase.status === 409 && notCase.status === 404 && unsignedReport.status === 401,
        `only the member: a voter 403; a password's case names nobody 409; not a removal 404; unsigned 401 (${byOther.status} ${pwCase.status} ${notCase.status} ${unsignedReport.status})`);
    // The retaliation the report is for: Kit reported Abe first, about something else, and then Abe paused Kit. The queue
    // keeps one report a member has pending about one person, so the case goes on the one waiting, after its own words.
    const kit = seed('KitKane');
    const KIT_EARLIER = 'Offensive content: Abe shouted at me at the market stall';
    const earlier = se.submitReport(kit.pubKeyHex, abe.pubKeyHex, KIT_EARLIER)!;
    const kitVote = (await pause(abeSession, kit, 'Shouted back at an admin at the market stall')).body?.decision?.id as string;
    const kitReports = () => db.prepare('SELECT * FROM abuse_reports WHERE reporter_pubkey = ? AND target_pubkey = ?').all(kit.pubKeyHex, abe.pubKeyHex) as any[];
    const reportsTold = () => alerts.getAlertsStatus().history.filter((e: any) => e.key === 'reports.new');
    alerts.resetAlertsForTests();
    fresh();
    const kitReported = await signed('POST', `/api/commons/decisions/${kitVote}/report`, kit, { words: 'Abe paused me for reporting him' });
    await settle(() => reportsTold().length > 0);
    const [kitRow] = kitReports();
    assert(kitReported.status === 200 && kitReported.body?.duplicate !== true && kitReports().length === 1 && kitRow?.id === earlier.id && kitRow.status === 'pending'
        && kitRow.reason.startsWith(KIT_EARLIER) && /false accusation/i.test(kitRow.reason) && kitRow.reason.includes(kitVote.slice(0, 8))
        && kitRow.reason.includes('Abe paused me for reporting him'),
        `Kit's report already waiting about Abe gains the case, after its own words: something new is on file, not "on file already" (${kitReported.status} ${kitReported.text.slice(0, 80)}; ${JSON.stringify(kitRow?.reason)})`);
    assert(reportKind(kitRow?.reason) === 'offensive content', `the report keeps its kind (${reportKind(kitRow?.reason)})`);
    assert(reportsTold().length === 1 && reportsTold()[0].detail.includes('(other)'),
        `the owners and admins are told, as of a new report, by the case's kind (${reportsTold().map((e: any) => e.detail).join(' | ')})`);
    fresh();
    const kitAgain = await signed('POST', `/api/commons/decisions/${kitVote}/report`, kit, { words: 'And again' });
    await settle(() => false);
    assert(kitAgain.status === 200 && kitAgain.body?.duplicate === true && kitReports().length === 1 && kitReports()[0].reason === kitRow?.reason && reportsTold().length === 1,
        `reported again, the same case is a repeat: nothing new on file, nobody told (${kitAgain.status})`);

    // ── 6. The cool-down ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n6. The cool-down');
    voteAndClose(daveVote, false);
    assert(row(daveVote).status === 'failed' && statusOf(dave) === 'active', `the community says No: Dave's vote fails and he is back (${row(daveVote).status})`);
    fresh();
    const replyAfter = await signed('POST', `/api/commons/decisions/${daveVote}/reply`, dave, { reply: 'One more word' });
    assert(replyAfter.status === 409 && row(daveVote).subject_reply === REPLY2, `once the vote has closed, the reply stays as it was (${replyAfter.status})`);
    const before = removalsOf(dave);
    const adaAgain = await pause(adaSession, dave, 'Took deposits for repairs again this week');
    assert(adaAgain.status === 403 && adaAgain.body?.code === de.REMOVAL_COOL_DOWN_CODE && statusOf(dave) === 'active' && removalsOf(dave) === before
        && adaAgain.body.error.includes(row(daveVote).closes_at.slice(0, 10)),
        `Ada can't pause Dave again: 403 ${adaAgain.body?.code}, in words with the day it ended; nothing written (${adaAgain.text.slice(0, 200)})`);
    const daveReport = se.submitReport(voters[1].pubKeyHex, dave.pubKeyHex, 'Took a deposit for a bike repair again')!;
    fresh();
    const throughReport = await admin(`/api/local/admin/reports/${daveReport.id}/action`, adaSession, { suspendUser: true });
    const reportAfter = db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(daveReport.id) as { status: string };
    assert(throughReport.status === 403 && throughReport.body?.code === de.REMOVAL_COOL_DOWN_CODE && reportAfter.status === 'pending' && statusOf(dave) === 'active',
        `nor through a report: 403, the report left as it was (${throughReport.status} ${reportAfter.status})`);
    const engineRefusal = de.adminEmergencySuspend(dave.pubKeyHex, ada.pubKeyHex, 'Asked of the engine directly');
    assert(!engineRefusal.success && engineRefusal.code === de.REMOVAL_COOL_DOWN_CODE && statusOf(dave) === 'active', 'the engine refuses underneath, whatever route reaches it');
    let reportThrew: any = null;
    try { se.actionReport(daveReport.id, false, true, false, { actor: ada.pubKeyHex }); } catch (e) { reportThrew = e; }
    assert(reportThrew?.status === 403 && reportThrew?.code === de.REMOVAL_COOL_DOWN_CODE && statusOf(dave) === 'active'
        && (db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(daveReport.id) as { status: string }).status === 'pending',
        "and so does the report's, before any write");
    // Before any fresh proof: an owner pausing another owner gives one, but a pause the cool-down refuses never asks it.
    const ottoVote = de.adminEmergencySuspend(otto.pubKeyHex, gen.pubKeyHex, 'Locked the other owner out of the server').decision!.id;
    voteAndClose(ottoVote, false);
    assert(row(ottoVote).status === 'failed' && statusOf(otto) === 'active', `the community says No on Otto, whom Gwen paused (${row(ottoVote).status})`);
    fresh();
    const gwenAgain = await admin(`/api/local/admin/users/${otto.pubKeyHex}/suspend`, gwenSession, { reason: 'Locked the other owner out again' });
    assert(gwenAgain.status === 403 && gwenAgain.body?.code === de.REMOVAL_COOL_DOWN_CODE && statusOf(otto) === 'active',
        `Gwen can't pause Otto again, refused before any fresh proof is asked (${gwenAgain.status} ${gwenAgain.text.slice(0, 120)})`);
    const ottoReport = se.submitReport(voters[2].pubKeyHex, otto.pubKeyHex, 'Locked the server again this week')!;
    fresh();
    const gwenReport = await admin(`/api/local/admin/reports/${ottoReport.id}/action`, gwenSession, { suspendUser: true });
    assert(gwenReport.status === 403 && gwenReport.body?.code === de.REMOVAL_COOL_DOWN_CODE && statusOf(otto) === 'active',
        `nor through a report, refused before any fresh proof too (${gwenReport.status} ${gwenReport.text.slice(0, 120)})`);
    // Another admin can; Abe lifts it by hand before its vote closes, which ends it without removing Dave: Abe waits now.
    const abePause = await pause(abeSession, dave, 'Another complaint about the bike repairs');
    const abeVote = abePause.body?.decision?.id as string;
    assert(abePause.status === 200 && statusOf(dave) === 'disabled', `another admin can pause him: Abe (${abePause.status})`);
    fresh();
    const lifted = await admin(`/api/local/admin/users/${dave.pubKeyHex}/status`, abeSession, { status: 'active' });
    assert(lifted.status === 200 && row(abeVote).status === 'admin_halted' && statusOf(dave) === 'active', `Abe lifts it by hand (${lifted.status})`);
    const abeAgain = await pause(abeSession, dave, 'And another complaint about the bike repairs');
    assert(abeAgain.status === 403 && abeAgain.body?.code === de.REMOVAL_COOL_DOWN_CODE, `a vote stopped before it closed counts: Abe waits too (${abeAgain.status})`);
    // The password: a vote too few voted on (unresolved) holds the password back, and Ada is another proposer.
    voteAndClose(erinVote, null);
    assert(row(erinVote).status === 'unresolved' && statusOf(erin) === 'active', `too few vote on Erin's: unresolved, and she is back (${row(erinVote).status})`);
    fresh();
    const pwAgain = await admin(`/api/local/admin/users/${erin.pubKeyHex}/suspend`, password(), { reason: 'Threatened a member again this week' });
    assert(pwAgain.status === 403 && pwAgain.body?.code === de.REMOVAL_COOL_DOWN_CODE && statusOf(erin) === 'active',
        `the server's password waits on Erin (${pwAgain.status})`);
    const adaOnErin = await pause(adaSession, erin, 'Threatened a member again this week');
    assert(adaOnErin.status === 200, `Ada, another proposer, can (${adaOnErin.status})`);
    fresh();
    await admin(`/api/local/admin/users/${erin.pubKeyHex}/status`, adaSession, { status: 'active' });
    // A removal the community passed, halted in its grace window, doesn't count: the community agreed with its case.
    voteAndClose(gusVote, true);
    assert(row(gusVote).status === 'execution_pending_grace', `the community votes to remove Gus: his grace window starts (${row(gusVote).status})`);
    fresh();
    const halted = await admin(`/api/local/admin/decisions/${gusVote}/halt`, abeSession, { reason: 'The bike was his brother\'s, lent to him' });
    assert(halted.status === 200 && statusOf(gus) === 'active', `Abe halts it in the window; Gus is back (${halted.status})`);
    const adaOnGus = await pause(adaSession, gus, 'Sold another bike that was not his');
    assert(adaOnGus.status === 200, `Ada, whose case the community passed, may pause Gus again (${adaOnGus.status} ${adaOnGus.text.slice(0, 160)})`);
    // After 90 days it lifts.
    db.prepare('UPDATE decisions SET closes_at = ? WHERE id = ?').run(ago((de.REMOVAL_COOL_DOWN_DAYS + 1) * DAY), daveVote);
    const adaLater = await pause(adaSession, dave, 'Took deposits for repairs again, months later');
    assert(adaLater.status === 200 && statusOf(dave) === 'disabled', `${de.REMOVAL_COOL_DOWN_DAYS} days after his vote ended, Ada may pause Dave again (${adaLater.status} ${adaLater.text.slice(0, 160)})`);
    // Votes off: no vote, so no cool-down; the moderators decide.
    const halVote = (await pause(adaSession, hal, 'Spammed the market chat with adverts')).body?.decision?.id as string;
    voteAndClose(halVote, false);
    assert(row(halVote).status === 'failed', 'Hal\'s vote fails');
    // A closed vote's case can be hidden too: the admin list carries the closed removal votes, newest first.
    fresh();
    const listed = await admin('/api/local/admin/decisions', adaSession);
    const pastIds = (listed.body?.pastRemovals ?? []).map((d: any) => d.id);
    assert(pastIds[0] === halVote && pastIds.includes(daveVote) && !(listed.body?.decisions ?? []).some((d: any) => d.id === halVote),
        `the admin list carries the closed votes on removing a member, newest first (${pastIds.length}: ${pastIds.slice(0, 3).join(', ')})`);
    const hideClosed = await admin(`/api/local/admin/decisions/${halVote}/hide-case`, abeSession, { reason: 'The adverts were the market stall he runs' });
    const halCard = await cardFor(vi, halVote);
    assert(hideClosed.status === 200 && halCard.card?.status === 'failed' && halCard.card?.caseHiddenReason === 'The adverts were the market stall he runs'
        && !halCard.text.includes('Spammed the market chat'), `and its case hidden after the vote (${hideClosed.status})`);
    setSwitchOverride('decisions', false);
    try {
        expo.length = 0;
        const offPause = await pause(adaSession, hal, 'Spammed the market chat again');
        await settle(() => false);
        assert(offPause.status === 200 && offPause.body?.decision?.effect === 'keep_suspension' && offPause.body.decision.params?.noVote === true,
            `with votes off, Ada pauses Hal again: a 7-day hold, no vote, no cool-down (${offPause.status})`);
        assert(!expo.some(m => ['decision.removal', 'account.removal-vote'].includes(kindOf(m))), 'and no removal vote is pushed: there is none');
        fresh();
        const offReply = await signed('POST', `/api/commons/decisions/${adaLater.body?.decision?.id}/reply`, dave, { reply: 'Votes are off now' });
        assert(offReply.status === 404 && offReply.body?.code === 'feature_off', `a reply with votes off: 404 feature_off (${offReply.status} ${offReply.body?.code})`);
    } finally {
        setSwitchOverride('decisions', true);
    }
    fresh();
    await admin(`/api/local/admin/users/${hal.pubKeyHex}/status`, adaSession, { status: 'active' });

    // ── 7. The upgrade ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n7. The upgrade');
    const schemaSql = fs.readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
    const newColumns = new Set(REMOVAL_CASE_COLUMNS.map(([c]) => c));
    const olderTable = createTableText(schemaSql, 'decisions')!.split('\n')
        .filter(l => !newColumns.has(l.trim().split(/\s+/)[0]) && !l.trim().startsWith('--')).join('\n');
    const older = new Database(':memory:');
    older.pragma('foreign_keys = OFF'); // as db.ts runs it
    older.exec(olderTable);
    older.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, status, closes_at)
        VALUES ('old-1', 'SYSTEM', 'Remove Old?', 'An admin paused Old.', 'member', 'remove_member', 'pk-old', '{"rule":2}', '1m1v', 'open', '2026-11-01T00:00:00.000Z')`).run();
    const hadBefore = (older.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map(c => c.name);
    const added = addRemovalCaseColumns(older);
    const hasAfter = (older.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map(c => c.name);
    const oldRow = older.prepare('SELECT * FROM decisions WHERE id = ?').get('old-1') as any;
    assert(!hadBefore.some(c => newColumns.has(c)) && added === newColumns.size && [...newColumns].every(c => hasAfter.includes(c)),
        `a table from before gains the ${newColumns.size} columns (${added} added)`);
    assert(oldRow?.title === 'Remove Old?' && oldRow.status === 'open' && oldRow.subject_reply === null && oldRow.case_hidden_at === null && oldRow.reply_hidden_at === null,
        'its rows are kept, NULL in each');
    assert(addRemovalCaseColumns(older) === 0, 'a second boot adds nothing');
    older.close();

    // ── 8. A reply taken down ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n8. A reply that harms someone is taken down, with a public reason');
    const kai = seed('KaiKnox');
    const mo = seed('ModMo');
    grantNodeRole(mo.pubKeyHex, 'moderator', gen.pubKeyHex);
    const moSession = sessionOf(mo);
    const KAI_REPLY = 'Erin is lying. She lives at 12 Example Street and her number is 0400 000 000. Go and ask her yourselves.';
    const DOXX = ['12 Example Street', '0400 000 000'];
    const TAKE_DOWN_WHY = "It gave a member's home address and phone number";
    const holdsWords = (text: string) => DOXX.some(w => text.includes(w));
    const kaiVote = (await pause(adaSession, kai, 'Shouted at Erin at the market stall, twice')).body?.decision?.id as string;
    fresh();
    const kaiReplied = await signed('POST', `/api/commons/decisions/${kaiVote}/reply`, kai, { reply: KAI_REPLY });
    const kaiCaseHidden = await admin(`/api/local/admin/decisions/${kaiVote}/hide-case`, adaSession, { reason: 'Wu saw Erin start it, not Kai' });
    const erinReads = await cardFor(erin, kaiVote);
    assert(kaiReplied.status === 200 && kaiCaseHidden.status === 200 && erinReads.card?.subjectReply === KAI_REPLY,
        `Kai, paused, replies with Erin's address and number; hiding his case leaves it, and Erin reads it (${kaiReplied.status} ${kaiCaseHidden.status})`);
    fresh();
    const shortWhy = await admin(`/api/local/admin/decisions/${kaiVote}/hide-reply`, abeSession, { reason: 'address' });
    const notRemovalVote = await admin(`/api/local/admin/decisions/${freeze.id}/hide-reply`, abeSession, { reason: TAKE_DOWN_WHY });
    const nothingToTake = await admin(`/api/local/admin/decisions/${kitVote}/hide-reply`, abeSession, { reason: TAKE_DOWN_WHY });
    const byModerator = await admin(`/api/local/admin/decisions/${kaiVote}/hide-reply`, moSession, { reason: TAKE_DOWN_WHY });
    const byMemberSigned = await signed('POST', `/api/local/admin/decisions/${kaiVote}/hide-reply`, erin, { reason: TAKE_DOWN_WHY });
    const moderatorEngine = de.adminHideReply(kaiVote, mo.pubKeyHex, TAKE_DOWN_WHY, () => {});
    const memberEngine = de.adminHideReply(kaiVote, erin.pubKeyHex, TAKE_DOWN_WHY, () => {});
    assert(shortWhy.status === 400 && notRemovalVote.status === 404 && nothingToTake.status === 409,
        `a reason under 10 characters 400, a Decision that removes nobody 404, a vote with no reply 409 (${shortWhy.status} ${notRemovalVote.status} ${nothingToTake.status})`);
    assert(byModerator.status === 403 && byModerator.body?.moderator === true && [401, 403].includes(byMemberSigned.status)
        && !moderatorEngine.success && moderatorEngine.status === 403 && !memberEngine.success && memberEngine.status === 403,
        `never a moderator (${byModerator.status}) or a member (${byMemberSigned.status}): by the route, and by the engine underneath`);
    assert(row(kaiVote).subject_reply === KAI_REPLY && !row(kaiVote).reply_hidden_at, 'nothing was taken down');

    const viApp = await memberSocket(vi);
    await new Promise(r => setTimeout(r, 300)); // its greeting
    viApp.raw.length = 0;
    expo.length = 0;
    const beforeTakingDown = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    fresh();
    const takenDown = await admin(`/api/local/admin/decisions/${kaiVote}/hide-reply`, abeSession, { reason: `  ${TAKE_DOWN_WHY}  ` });
    await settle(() => expo.length >= 1 && viApp.raw.some(m => m.includes('"decision_updated"')));
    const kaiRow = row(kaiVote);
    assert(takenDown.status === 200 && kaiRow.subject_reply === null && kaiRow.subject_replied_at === null && !!kaiRow.reply_hidden_at
        && kaiRow.reply_hidden_by === abe.pubKeyHex && kaiRow.reply_hidden_reason === TAKE_DOWN_WHY,
        `Abe takes Kai's reply down: its words are gone from the vote's row; when, who and why are kept (${takenDown.status} ${takenDown.text.slice(0, 120)})`);
    for (const reader of [vi, erin, kai]) {
        const c = await cardFor(reader, kaiVote);
        fresh();
        const detail = await signed('GET', `/api/commons/decisions/${kaiVote}`, reader);
        const d = detail.body?.decision;
        assert(c.card?.subjectReply === null && c.card?.subjectRepliedAt === null && c.card?.replyHiddenReason === TAKE_DOWN_WHY && !!c.card?.replyHiddenAt
            && !('replyHiddenBy' in c.card) && !JSON.stringify(c.card).includes(abe.pubKeyHex)
            && detail.status === 200 && d?.subjectReply === null && d?.replyHiddenReason === TAKE_DOWN_WHY && !('replyHiddenBy' in d)
            && !holdsWords(c.text) && !holdsWords(detail.text),
            `${reader.callsign} reads the reason in the reply's place, on Decide's list and on the vote itself; the words, and who took it down, are gone`);
    }
    const sent = viApp.raw.map(m => { try { return JSON.parse(m); } catch { return null; } })
        .filter((e: any) => e?.type === 'decision_updated' && e.decision?.id === kaiVote);
    assert(sent.length >= 1 && sent.every((e: any) => e.decision.subjectReply === null && e.decision.replyHiddenReason === TAKE_DOWN_WHY && !('replyHiddenBy' in e.decision))
        && !holdsWords(viApp.raw.join('\n')),
        `a member's open app is sent the vote as it reads now, without the words (${sent.length} decision_updated)`);
    viApp.ws.close();
    // Home lists the vote (the soonest to close), and none of its words.
    db.prepare('UPDATE decisions SET closes_at = ? WHERE id = ?').run(new Date(Date.now() + 1800_000).toISOString(), kaiVote);
    fresh();
    const kaiHome = await signed('GET', '/api/home?cards=needs,decide', vi);
    assert(kaiHome.status === 200 && (kaiHome.body?.cards?.decide?.items ?? []).some((i: any) => i.id === kaiVote) && !holdsWords(kaiHome.text),
        `Home's cards list the vote and none of the words (${kaiHome.status})`);
    fresh();
    const adminList8 = await admin('/api/local/admin/decisions', adaSession);
    const adminRow8 = (adminList8.body?.decisions ?? []).find((d: any) => d.id === kaiVote);
    assert(adminRow8?.subjectReply === null && adminRow8?.replyHiddenBy === abe.pubKeyHex && adminRow8?.replyHiddenReason === TAKE_DOWN_WHY && !holdsWords(adminList8.text),
        "the admins' list keeps who took it down and why, and holds no copy of the words either");
    const delta8 = await se.exportSyncState('removal-fairness', beforeTakingDown) as { plainTables?: Record<string, any[]> };
    const carried8 = (delta8.plainTables?.decisions ?? []).find((d: any) => d.id === kaiVote);
    assert(!!carried8 && carried8.subject_reply === null && carried8.subject_replied_at === null && carried8.reply_hidden_reason === TAKE_DOWN_WHY
        && carried8.reply_hidden_by === abe.pubKeyHex && !holdsWords(JSON.stringify(delta8)),
        "a standby's next copy carries the vote without the words, and the takedown with it");
    assert(!holdsWords(JSON.stringify(await se.exportSyncState('removal-fairness'))), 'and a whole copy holds none of the words');
    // The member is told: a push of its own kind, which always comes through, and a notice the web app keeps; neither says
    // why or who, which the card does. Nobody else is pushed.
    const toKai = pushesTo(kai);
    assert(toKai.length === 1 && kindOf(toKai[0]) === 'account.reply-taken-down' && toKai[0].title === PUSH_NOTICE_TITLE
        && toKai[0].body === PUSH_NOTICE_KINDS['account.reply-taken-down'].body && expo.every(m => m.to === kai.token),
        `Kai gets one push, account.reply-taken-down, with its fixed words; nobody else is pushed (${expo.map(kindOf).join(', ')})`);
    fresh();
    const kaiPushDetails = await signed('GET', `/api/notices/push/${toKai[0]?.data?.i}`, kai);
    const kaiKept = await signed('GET', '/api/notices?unseen=1', kai);
    const keptTakeDown = (kaiKept.body?.notices ?? []).find((n: any) => n.title === de.REPLY_TAKEN_DOWN_NOTICE_TITLE);
    assert(kaiPushDetails.status === 200 && kaiPushDetails.body?.data?.screen === 'decide' && Object.keys(kaiPushDetails.body.data).length === 1 && !!keptTakeDown
        && ![TAKE_DOWN_WHY, abe.callsign, ...DOXX].some(w => kaiPushDetails.text.includes(w) || kaiKept.text.includes(w)),
        `its details open Decide, and the web app keeps him a notice; neither says why or who (${kaiPushDetails.status} ${keptTakeDown?.body})`);
    // Kai can't put it back: not by writing another, open or closed, nor can it be taken down twice.
    fresh();
    const kaiAgain = await signed('POST', `/api/commons/decisions/${kaiVote}/reply`, kai, { reply: 'Erin is still lying. 12 Example Street, go and see.' });
    const twiceDown = await admin(`/api/local/admin/decisions/${kaiVote}/hide-reply`, adaSession, { reason: 'Taking it down a second time' });
    assert(kaiAgain.status === 409 && kaiAgain.body?.error === de.REPLY_TAKEN_DOWN && twiceDown.status === 409 && twiceDown.body?.error === 'This reply is already taken down'
        && row(kaiVote).subject_reply === null && row(kaiVote).reply_hidden_by === abe.pubKeyHex && row(kaiVote).reply_hidden_reason === TAKE_DOWN_WHY,
        `Kai can't write another while the vote is open (${kaiAgain.status} ${kaiAgain.text.slice(0, 100)}), and a second takedown is refused (${twiceDown.status})`);
    voteAndClose(kaiVote, null);
    const kaiClosed = await cardFor(erin, kaiVote);
    fresh();
    const kaiAfterClose = await signed('POST', `/api/commons/decisions/${kaiVote}/reply`, kai, { reply: 'Now that the vote is over.' });
    assert(row(kaiVote).status === 'unresolved' && kaiClosed.card?.subjectReply === null && kaiClosed.card?.replyHiddenReason === TAKE_DOWN_WHY
        && !holdsWords(kaiClosed.text) && kaiAfterClose.status === 409 && row(kaiVote).subject_reply === null,
        `the vote closes (${row(kaiVote).status}): the closed card reads the reason, and the reply stays down (${kaiAfterClose.status})`);
    // A closed vote's reply comes down too, from the admins' list of closed votes: here by an owner with the server's password.
    const lia = seed('LiaLane');
    const LIA_REPLY = 'Ring Erin on 0400 111 222 and ask her what she did.';
    const liaVote = (await pause(adaSession, lia, 'Took a deposit for a market stall and kept it')).body?.decision?.id as string;
    fresh();
    const liaReplied = await signed('POST', `/api/commons/decisions/${liaVote}/reply`, lia, { reply: LIA_REPLY });
    voteAndClose(liaVote, false);
    fresh();
    const closedList = await admin('/api/local/admin/decisions', password());
    const liaListed = (closedList.body?.pastRemovals ?? []).find((d: any) => d.id === liaVote);
    fresh();
    const liaDown = await admin(`/api/local/admin/decisions/${liaVote}/hide-reply`, password(), { reason: "It gave another member's phone number" });
    const liaCard = await cardFor(vi, liaVote);
    assert(liaReplied.status === 200 && row(liaVote).status === 'failed' && liaListed?.subjectReply === LIA_REPLY && liaDown.status === 200
        && row(liaVote).reply_hidden_by === 'owner:password' && row(liaVote).subject_reply === null
        && liaCard.card?.subjectReply === null && !liaCard.text.includes('0400 111 222'),
        `a closed vote's reply, listed with the closed votes, comes down too: by an owner with the password (${liaDown.status} ${liaDown.text.slice(0, 120)})`);
    // On a standby, both are refused with its JSON answer, before anything is written.
    let onStandby: Answer[];
    setNodeRole('backup');
    try {
        fresh();
        onStandby = [
            await admin(`/api/local/admin/decisions/${gusVote}/hide-case`, abeSession, { reason: 'Hidden on a standby, which it must not be' }),
            await admin(`/api/local/admin/decisions/${daveVote}/hide-reply`, abeSession, { reason: 'Taken down on a standby, which it must not be' }),
        ];
    } finally {
        setNodeRole('primary');
    }
    assert(onStandby.length === 2 && onStandby.every(a => a.status === 409 && a.body?.code === STANDBY_CODE && typeof a.body?.error === 'string')
        && !row(gusVote).case_hidden_at && row(daveVote).subject_reply === REPLY2 && !row(daveVote).reply_hidden_at,
        `on a standby, hiding a case and taking down a reply answer the standby's JSON refusal, and nothing is written (${onStandby.map(a => `${a.status} ${a.text.slice(0, 70)}`).join('; ')})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
