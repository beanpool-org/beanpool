/**
 * Small communities (removal by vote S6: scratch/fable-design/DESIGN-removal-by-vote-fable.md §5; Marty 23 Oct "Accept
 * all", Q7 and Q8). Three rules for a vote on removing a member:
 *  - at least 3 Yes votes remove anyone, whatever the share (decisions-engine.ts REMOVAL_MIN_YES): two neighbours can't
 *    remove a third;
 *  - its subject is never counted: not in its electorate, and their own vote not in its tally, whatever a row says;
 *  - too few to vote: when fewer than 3 others could vote, its quorum can't be met, and an owner (never an admin), with
 *    the fresh proof and a public reason members read, may decide it while it is open; the tick carries that out when the
 *    vote closes, if it is still too few then. Left alone, the pause lifts as today.
 *
 * Boots the real server; the owner's decision goes over HTTPS through the real admin sessions (an admin's key session, an
 * owner's from a computer and from the phone's Manage hand-off, an owner's automation token, the password with a 2FA
 * code). The members' card is read through the real signature middleware. Expo and the owners' alert channel (a stand-in
 * ntfy on loopback) are answered here: nothing leaves this machine.
 *
 *  1. The design's table: electorates of 3 (a family of 4), 4, 6 (castlemaine: 7 active, 6 without the subject), 7 and 25
 *     (mullum): each one's quorum, which tallies pass, and what the tick does with them. 2 Yes to 1 No passed before this
 *     slice (66.7%) and fails now, its record saying why.
 *  2. The subject never counted: their own vote, written straight into the table as one cast before the rule or carried
 *     by a restore would be, is left out of the tally; they can't cast one; they are out of their own electorate while
 *     paused.
 *  3. Too few to vote, decided by an owner: the card says so; an admin is refused; an owner from a computer is asked the
 *     phone, an owner's automation token is refused, an owner's stale hand-off is asked Manage again, a short reason is
 *     refused before any proof; from the phone just now it is recorded. Members read the reason, never the owner's key;
 *     the member is told; the owners are told, never whom. Once only. The vote closes: the grace window opens, its record
 *     "Decided by the owner: too few members to vote."; the grace window ends: the member is removed. The password decides
 *     another with its current code.
 *  4. When the owner's decision does not stand: enough members voted by the close (a dormant member's vote made it 3),
 *     the owner who decided lost the role, no decision at all, a vote on someone holding a server role, a vote with enough
 *     voters, votes off.
 *  5. Reinstatement keeps no Yes floor: 2 Yes to 1 No passes.
 *
 * Run (as test-all does, through scripts/run-server-suites.mjs):
 *   SERVER_SUITES_ONLY=test-removal-small node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_ROLE;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
delete process.env.ALERTS_REPORT_FOLD_MINUTES;
for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_OFFBOX_') || k.startsWith('ALERTS_WEBHOOK_')) delete process.env[k];

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Expo and the stand-in ntfy are answered here; nothing else off this machine is reached.
const realFetch = globalThis.fetch;
const pushes: Array<{ to: string[]; k: string; body: string }> = [];
const offMachine: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    if (url.hostname === 'exp.host') {
        const batch = JSON.parse(String(init?.body ?? '[]')) as any[];
        pushes.push({ to: batch.map((m) => m.to), k: batch[0]?.data?.k, body: JSON.stringify(batch) });
        return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    offMachine.push(url.hostname);
    throw new Error(`test-removal-small: refused a request off this machine: ${url.hostname}`);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** The stand-in ntfy: every POST kept, a 200 for each. */
async function startFakeNtfy() {
    const hits: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"id":"x"}');
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return { hits, url: (p: string) => `http://127.0.0.1:${port}${p}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string; token: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    // Nothing of the key in the token: a push's wire is read below for any member's key.
    return { pubKeyHex, privateKey, callsign, token: `ExponentPushToken[rs-${crypto.randomBytes(6).toString('hex')}]` };
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

let BASE = '';

/** A member's signed request. */
async function signed(method: 'GET' | 'POST', p: string, id: Id, payload?: unknown): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return answerOf(await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...signedHeaders(method, p, body, id) },
        ...(body ? { body } : {}),
    }));
}

/** An admin route under `session`'s headers (a key session, or the password with a 2FA code). */
async function admin(p: string, session: Record<string, string>, payload?: unknown): Promise<Answer> {
    return answerOf(await fetch(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...session },
        body: JSON.stringify(payload ?? {}),
    }));
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const ADMIN_PW = 'Removal-Small-Admin-Pw-63!';
const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function main() {
    console.log('Small communities: at least 3 Yes, the subject never counted, an owner decides when too few can vote...\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const de = await import('./decisions-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { resetAdminAuthTarpit, TOKEN_REFUSED_CODE, FRESH_PROOF_PHONE_REQUIRED_CODE } = await import('./admin-auth.js');
    const { db } = await import('./db/db.js');
    const { setSwitchOverride } = await import('./config/node-profile.js');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { ownerSessionHeaders, ownerPhoneSessionHeaders, turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken, backdateAdminSessionForTests, STEP_UP_REQUIRED_CODE } = await import('./admin-key-auth.js');
    const { issueAutomationToken } = await import('./automation-tokens.js');
    const { grantNodeRole, revokeNodeRole } = await import('./engine/node-roles.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { setSimulatedDiskUsageForTesting } = await import('./engine/storage-health.js');
    const alerts = await import('./services/alerts.js');

    const ntfy = await startFakeNtfy();
    const TOPIC = `bp-small-${crypto.randomBytes(9).toString('hex')}`;

    await initTls();
    se.initStateEngine();
    // This machine's own disk may be full enough to alert: the lines here are the votes'.
    setSimulatedDiskUsageForTesting(10);
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, communityName: 'Small Test Commons' });
    const twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // ── The people ──────────────────────────────────────────────────────────────────────────────────────────────────
    // The node's owners and its admin are quiet here (no signed activity in 30 days), so each electorate below is exactly
    // the members a step makes active: the turnout base counts members active in the last 30 days (answer K).
    const gen = keypair('GenesisGwen');
    se.seedGenesisMember(gen.pubKeyHex, gen.callsign);
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(60 * DAY), gen.pubKeyHex);
    se.registerPushToken(gen.pubKeyHex, gen.token, 'android');
    const people: Id[] = [gen];
    const seed = (callsign: string, active = true): Id => {
        const id = keypair(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(id.pubKeyHex, callsign, ago(30 * DAY), gen.pubKeyHex, `INV-${callsign.toUpperCase()}`);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pubKeyHex);
        if (active) db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(new Date().toISOString(), id.pubKeyHex);
        se.registerPushToken(id.pubKeyHex, id.token, 'android');
        people.push(id);
        return id;
    };
    const otto = seed('OwnerOtto', false);
    grantNodeRole(otto.pubKeyHex, 'owner', gen.pubKeyHex);
    const ada = seed('AdminAda', false);
    grantNodeRole(ada.pubKeyHex, 'admin', gen.pubKeyHex);
    const quiet = [gen, otto, ada];
    const hushStanding = () => db.prepare(`UPDATE members SET last_active_at = NULL WHERE public_key IN (${quiet.map(() => '?').join(',')})`)
        .run(...quiet.map(i => i.pubKeyHex));

    const sessionOf = (id: Id, role: 'admin' | 'owner') => {
        const { handshakeToken } = mintHandshakeToken(id.pubKeyHex, role);
        const s = consumeHandshakeToken(handshakeToken);
        if (!s.ok || !s.sessionId) throw new Error(`could not open ${id.callsign}'s key session: ${s.error}`);
        return { 'X-Admin-Session': s.sessionId };
    };
    const adaSession = sessionOf(ada, 'admin');
    const ottoSession = ownerSessionHeaders(otto.pubKeyHex);          // an owner from a computer: no fresh proof
    const ottoPhone = () => ownerPhoneSessionHeaders(otto.pubKeyHex);  // pressed Manage on the phone just now
    const gwenSession = ownerSessionHeaders(gen.pubKeyHex);
    const password = () => twoFa.headers();
    const ottoPhoneStale = () => {
        const headers = ottoPhone();
        backdateAdminSessionForTests(headers['X-Admin-Session'], 10 * 60_000);
        return headers;
    };
    const madeToken = issueAutomationToken({ name: 'Small test script', scope: 'admin', createdBy: gen.pubKeyHex });
    if (!madeToken.ok) throw new Error(`setup: could not make Gwen's automation token: ${madeToken.error}`);
    const gwenToken = { Authorization: `Bearer ${madeToken.token}` };
    const fresh = () => { resetAdminAuthTarpit(); resetAdminRateLimit(); resetGatewayRateLimit(); };
    const statusOf = (id: Id) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(id.pubKeyHex) as { status: string }).status;
    const frozenOf = (id: Id) => (db.prepare('SELECT COALESCE(credit_frozen, 0) AS f FROM members WHERE public_key = ?').get(id.pubKeyHex) as { f: number }).f;
    const row = (decisionId: string): any => db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
    /** A fixture's pause, straight in the engine (the routes' pause is S1–S4's to test): its vote's id. */
    const pauseOf = (who: Id, reason = `A case against ${who.callsign} for this check`): string => {
        hushStanding();
        const r = de.adminEmergencySuspend(who.pubKeyHex, ada.pubKeyHex, reason, { freshProof: true });
        if (!r.success || !r.decision) throw new Error(`setup: could not pause ${who.callsign}: ${r.error}`);
        return r.decision.id;
    };
    const vote = (id: string, yes: Id[], no: Id[]) => {
        for (const v of yes) { const r = de.castDecisionVote(id, v.pubKeyHex, true); if (!r.success) throw new Error(`setup: ${v.callsign} Yes: ${r.error}`); }
        for (const v of no) { const r = de.castDecisionVote(id, v.pubKeyHex, false); if (!r.success) throw new Error(`setup: ${v.callsign} No: ${r.error}`); }
    };
    /** The vote closes now, and the tick runs. */
    const closeNow = (id: string) => {
        hushStanding();
        db.prepare('UPDATE decisions SET closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
        de.tickDecisions();
    };
    /** Members done with leave (a fixture's tidy: out of every later electorate). */
    const gone = (ids: Id[]) => {
        if (ids.length) db.prepare(`UPDATE members SET status = 'pruned' WHERE public_key IN (${ids.map(() => '?').join(',')})`).run(...ids.map(i => i.pubKeyHex));
    };
    const cardFor = async (reader: Id, decisionId: string) => {
        fresh();
        const r = await signed('GET', '/api/commons/decisions', reader);
        return { card: (r.body?.decisions ?? []).find((d: any) => d.id === decisionId), text: r.text };
    };
    const decide = async (session: Record<string, string>, decisionId: string, reason: unknown, extra: Record<string, unknown> = {}) => {
        fresh();
        return admin(`/api/local/admin/decisions/${decisionId}/owner-decision`, session, { reason, ...extra });
    };

    // ── 1. The design's table ───────────────────────────────────────────────────────────────────────────────────────
    console.log('1. The design\'s table: quorum, the 3-Yes floor, and the tick');
    const TABLE: Array<{ label: string; others: number; quorum: number; cases: Array<{ yes: number; no: number; passes: boolean; why?: string; wasPass?: boolean }> }> = [
        { label: 'a family of 4 (3 others)', others: 3, quorum: 3, cases: [
            { yes: 2, no: 1, passes: false, why: 'Fewer than 3 Yes votes (2)', wasPass: true },
            { yes: 3, no: 0, passes: true },
        ] },
        { label: '4 others', others: 4, quorum: 3, cases: [
            { yes: 2, no: 1, passes: false, why: 'Fewer than 3 Yes votes (2)', wasPass: true },
            { yes: 3, no: 1, passes: true },
        ] },
        { label: 'castlemaine (7 active, 6 without the subject)', others: 6, quorum: 3, cases: [
            { yes: 2, no: 1, passes: false, why: 'Fewer than 3 Yes votes (2)', wasPass: true },
            { yes: 3, no: 0, passes: true },
            { yes: 4, no: 2, passes: true },
            { yes: 3, no: 2, passes: false, why: 'Threshold not met (60.0% < 66.0%)' },
        ] },
        { label: '7 others', others: 7, quorum: 3, cases: [
            { yes: 2, no: 1, passes: false, why: 'Fewer than 3 Yes votes (2)', wasPass: true },
            { yes: 3, no: 1, passes: true },
        ] },
        { label: 'mullum (25 active)', others: 25, quorum: 7, cases: [
            { yes: 5, no: 2, passes: true },
            { yes: 4, no: 2, passes: false, why: 'Quorum not met (6/7)' },
            { yes: 5, no: 3, passes: false, why: 'Threshold not met (62.5% < 66.0%)' },
        ] },
    ];
    let subjectNo = 0;
    for (const community of TABLE) {
        const others = Array.from({ length: community.others }, (_, i) => seed(`Voter${community.others}x${i}`));
        for (const c of community.cases) {
            const subject = seed(`Subject${++subjectNo}`);
            const id = pauseOf(subject);
            vote(id, others.slice(0, c.yes), others.slice(c.yes, c.yes + c.no));
            const tally = de.tallyDecision(id);
            const shape = `${c.yes} Yes, ${c.no} No`;
            assert(tally.electorate === community.others && tally.quorumRequired === community.quorum && tally.minYes === 3 && tally.tooFewToVote === false,
                `${community.label}: ${shape}: electorate ${tally.electorate}, quorum ${tally.quorumRequired}, at least ${tally.minYes} Yes`);
            assert(tally.passed === c.passes, `${community.label}: ${shape} ${c.passes ? 'removes' : 'does not remove'} (passed ${tally.passed})`);
            if (c.wasPass) {
                assert(tally.quorumMet && tally.supportRatio >= tally.thresholdRequired && tally.yesWeight > tally.noWeight,
                    `${community.label}: ${shape} meets the quorum and 66% (${(tally.supportRatio * 100).toFixed(1)}%), which removed them before; the floor stops it`);
            }
            closeNow(id);
            const after = row(id);
            if (c.passes) {
                assert(after.status === 'execution_pending_grace' && statusOf(subject) === 'disabled' && frozenOf(subject) === 1
                    && after.execution_reason === 'Member suspended. 7-day grace period active before destructive removal.',
                    `${community.label}: ${shape}: the tick opens the grace window, the member paused and frozen (${after.status})`);
            } else {
                assert(after.status === (c.why?.startsWith('Quorum') ? 'unresolved' : 'failed') && statusOf(subject) === 'active'
                    && String(after.execution_reason).startsWith(`${c.why}.`),
                    `${community.label}: ${shape}: the vote ends, the pause lifts, its record says "${c.why}" (${after.status}: ${after.execution_reason})`);
            }
            gone([subject]);
        }
        gone(others);
    }

    // ── 2. The subject never counted ────────────────────────────────────────────────────────────────────────────────
    console.log('\n2. The subject is never counted: not their vote, not them');
    {
        const three = ['Ann', 'Ben', 'Cal'].map(n => seed(`Neighbour${n}`));
        const dee = seed('DeeDrake');
        const id = pauseOf(dee);
        const own = de.castDecisionVote(id, dee.pubKeyHex, false);
        assert(!own.success && own.error === de.OWN_REMOVAL_VOTE_ERROR, `Dee can't vote on removing herself (${own.error})`);
        assert(de.tallyDecision(id).electorate === 3, `paused, Dee is out of her own vote's electorate: 3, her three neighbours (${de.tallyDecision(id).electorate})`);
        // A vote by the subject in the table itself, as one cast before the rule (or a restore) would leave: Yes, with two more.
        db.prepare(`INSERT INTO decision_votes (decision_id, voter_pubkey, support, weight, credits_used, created_at, updated_at) VALUES (?, ?, 1, 1, 0, ?, ?)`)
            .run(id, dee.pubKeyHex, new Date().toISOString(), new Date().toISOString());
        vote(id, three.slice(0, 2), []);
        const t = de.tallyDecision(id);
        assert(t.totalVoters === 2 && t.yesWeight === 2 && !t.quorumMet && !t.passed,
            `her own Yes in the table is not counted: 2 voters, 2 Yes, quorum 3 not met, not removed (${t.totalVoters} voters, ${t.yesWeight} Yes)`);
        closeNow(id);
        assert(row(id).status === 'unresolved' && statusOf(dee) === 'active', `it closes as too few voted, and Dee is back (${row(id).status})`);
        gone([...three, dee]);
    }

    // ── 3. Too few to vote, decided by an owner ─────────────────────────────────────────────────────────────────────
    console.log('\n3. Too few to vote: an owner decides, with the fresh proof and a public reason');
    const tia = seed('TiaTrue');
    const uma = seed('UmaUpton');
    const sam = seed('SamStone');
    const ownerPushes = () => pushes.filter((p) => p.k === 'owner.alert');
    const decidedLines = () => alerts.getAlertsStatus().history.filter((e) => e.key === 'sec.members' && /too few members could vote on/.test(e.detail));
    alerts.resetAlertsForTests();
    fresh();
    const set = await admin('/api/local/admin/alerts/settings', gwenSession, { url: ntfy.url(`/${TOPIC}`) });
    assert(set.status === 200, `setup: the owner sets the alert channel (${set.status} ${set.text.slice(0, 120)})`);
    alerts.resetAlertsForTests();
    hushStanding();
    fresh();
    const SAM_CASE = 'Kept taking things from the shared shed and selling them';
    const paused = await admin(`/api/local/admin/users/${sam.pubKeyHex}/suspend`, adaSession, { reason: SAM_CASE });
    const samVote = paused.body?.decision?.id as string;
    assert(paused.status === 200 && !!samVote && statusOf(sam) === 'disabled', `Ada pauses Sam; his vote opens (${paused.status})`);
    let seen = await cardFor(tia, samVote);
    assert(seen.card?.tally?.tooFewToVote === true && seen.card.tally.electorate === 2 && seen.card.tally.quorumRequired === 3 && !seen.card.ownerDecidedAt,
        `the card says too few can vote: 2 could, 3 are needed (${JSON.stringify(seen.card?.tally ?? null).slice(0, 200)})`);
    const REASON = 'Only Tia and Uma could vote; both saw the shed emptied, and Sam has not answered in five days';
    const untouched = () => !row(samVote).owner_decided_at && !row(samVote).owner_decided_by && !row(samVote).owner_decided_reason;
    let r = await decide(adaSession, samVote, REASON);
    assert(r.status === 403 && r.body?.error === de.OWNER_DECISION_ONLY_OWNER && untouched(), `an admin, Ada, is refused: an owner's only (${r.status} ${r.body?.error})`);
    r = await decide(ottoSession, samVote, REASON);
    assert(r.status === 403 && r.body?.code === FRESH_PROOF_PHONE_REQUIRED_CODE && untouched(),
        `an owner from a computer is asked the fresh proof: do it from the phone (${r.status} ${r.body?.code})`);
    r = await decide(gwenToken, samVote, REASON);
    assert(r.status === 403 && r.body?.code === TOKEN_REFUSED_CODE && untouched(), `an owner's automation token is refused (${r.status} ${r.body?.code})`);
    r = await decide(ottoPhoneStale(), samVote, REASON);
    assert(r.status === 403 && r.body?.code === STEP_UP_REQUIRED_CODE && untouched(), `an owner's hand-off 10 minutes old is asked Manage again (${r.status} ${r.body?.code})`);
    r = await decide(ottoPhone(), samVote, 'Too short');
    assert(r.status === 400 && /at least 10 characters/.test(r.body?.error ?? '') && untouched(), `a reason under 10 characters is refused (${r.status} ${r.body?.error})`);
    r = await decide(ottoPhone(), samVote, '');
    assert(r.status === 400 && untouched(), `so is none (${r.status})`);
    const samPushesBefore = pushes.filter(p => p.to.includes(sam.token)).length;
    r = await decide(ottoPhone(), samVote, `  ${REASON}  `);
    await settle();
    const decided = row(samVote);
    assert(r.status === 200 && !!decided.owner_decided_at && decided.owner_decided_by === otto.pubKeyHex && decided.owner_decided_reason === REASON
        && decided.status === 'open' && statusOf(sam) === 'disabled',
        `from the phone just now, Otto decides: recorded with his reason, trimmed; the vote stays open (${r.status} ${r.text.slice(0, 120)})`);
    seen = await cardFor(tia, samVote);
    assert(seen.card?.ownerDecidedReason === REASON && !!seen.card.ownerDecidedAt && !('ownerDecidedBy' in seen.card) && !seen.text.includes(otto.pubKeyHex),
        "members read the owner's reason on the card, never the owner's key");
    const samSees = await cardFor(sam, samVote);
    assert(samSees.card?.ownerDecidedReason === REASON, 'Sam reads it too, beside the case he can answer');
    const samPushes = pushes.filter(p => p.to.includes(sam.token)).slice(samPushesBefore);
    assert(samPushes.length === 1 && samPushes[0].k === 'account.removal-vote' && !samPushes[0].body.includes(REASON),
        `Sam is told, as when the vote opened, and the push carries no reason (${samPushes.map(p => p.k).join(', ')})`);
    const lines = decidedLines();
    assert(lines.length === 1 && lines[0].detail === 'A vote on removing a member, which too few members could vote on, was decided in the last day, by an owner.',
        `the owners are told: "${lines[0]?.detail}"`);
    const wire = [...ntfy.hits.map(h => `${JSON.stringify(h.headers)}${h.body}`), ...ownerPushes().map(p => p.body), JSON.stringify(alerts.getAlertsStatus())];
    assert(!wire.some(w => w.includes(sam.callsign) || w.includes(sam.pubKeyHex.slice(0, 12)) || w.includes('shared shed')),
        'nothing on the channel, in a push or in the book names Sam or quotes the case or the reason');
    r = await decide(ottoPhone(), samVote, 'A second decision on the same vote, refused');
    assert(r.status === 409 && r.body?.error === de.OWNER_DECISION_ALREADY && row(samVote).owner_decided_reason === REASON,
        `once only: a second decision is refused, the first kept (${r.status} ${r.body?.error})`);
    vote(samVote, [], [tia, uma]);
    assert(de.tallyDecision(samVote).tooFewToVote === true, 'Tia and Uma vote No: still too few to decide (2 of 3)');
    closeNow(samVote);
    const closed = row(samVote);
    assert(closed.status === 'execution_pending_grace' && !!closed.owner_decision_carried_at
        && closed.execution_reason === 'Decided by the owner: too few members to vote. Member suspended. 7-day grace period active before destructive removal.'
        && statusOf(sam) === 'disabled' && frozenOf(sam) === 1,
        `the vote closes: the owner's decision is carried out, the grace window opens, its record "Decided by the owner: too few members to vote." (${closed.status}: ${closed.execution_reason})`);
    seen = await cardFor(tia, samVote);
    assert(!!seen.card?.ownerDecisionCarriedAt && seen.card.ownerDecidedReason === REASON && seen.card.tally?.passed === false,
        'the closed card says the owner decided it, with the reason; the vote itself did not pass');
    db.prepare('UPDATE decisions SET grace_period_ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), samVote);
    de.tickDecisions();
    assert(row(samVote).status === 'executed' && statusOf(sam) === 'pruned', `the grace window ends: Sam is removed (${row(samVote).status}, ${statusOf(sam)})`);

    // The password decides another, with its current code as the fresh proof.
    const val = seed('ValVane');
    const valVote = pauseOf(val);
    r = await decide(password(), valVote, 'Only two members could vote, and Val told both of them he is leaving');
    assert(r.status === 200 && row(valVote).owner_decided_by === 'owner:password', `the password, with its current code, decides another (${r.status} ${r.text.slice(0, 120)})`);
    await settle();
    assert(decidedLines().some(e => e.detail === 'A vote on removing a member, which too few members could vote on, was decided in the last day, by the admin password.'),
        "the owners are told it was the password's");
    closeNow(valVote);
    assert(row(valVote).status === 'execution_pending_grace' && !!row(valVote).owner_decision_carried_at, `and it is carried out at the close (${row(valVote).status})`);
    gone([val]);

    // ── 4. When an owner's decision does not stand, or can't be made ─────────────────────────────────────────────────
    console.log("\n4. When it doesn't stand, or can't be made");
    // Enough members could vote by the close: a quiet member's vote made it three. The community decides, not the owner.
    const wes = seed('WesWard', false);
    const xia = seed('XiaXu');
    const xiaVote = pauseOf(xia);
    r = await decide(ottoPhone(), xiaVote, 'Only two could vote and Xia threatened one of them');
    assert(r.status === 200, `Otto decides Xia's vote while too few could vote (${r.status})`);
    vote(xiaVote, [wes], []);
    let t = de.tallyDecision(xiaVote);
    assert(t.electorate === 3 && t.tooFewToVote === false, `Wes, quiet until now, votes Yes: 3 could vote now, not too few (${t.electorate})`);
    closeNow(xiaVote);
    assert(row(xiaVote).status === 'unresolved' && !row(xiaVote).owner_decision_carried_at && statusOf(xia) === 'active',
        `at the close the community decides: too few voted (1 of 3), the owner's decision is not carried out, Xia is back (${row(xiaVote).status})`);
    gone([wes, xia]);

    // The owner who decided is no owner by the close: nothing is carried out.
    const yan = seed('YanYork');
    const yanVote = pauseOf(yan);
    r = await decide(ottoPhone(), yanVote, 'Only two could vote and Yan left a threat on the board');
    assert(r.status === 200, `Otto decides Yan's vote (${r.status})`);
    revokeNodeRole(otto.pubKeyHex, 'owner', gen.pubKeyHex);
    closeNow(yanVote);
    assert(row(yanVote).status === 'unresolved' && !row(yanVote).owner_decision_carried_at && statusOf(yan) === 'active',
        `Otto's owner role is taken away before the close: his decision is not carried out, the pause lifts (${row(yanVote).status})`);
    grantNodeRole(otto.pubKeyHex, 'owner', gen.pubKeyHex);
    gone([yan]);

    // Decided, but the member deleted their own account before the close: nothing to carry out, and nothing says it was.
    const ivo = seed('IvoIrwin');
    const ivoVote = pauseOf(ivo);
    r = await decide(ottoPhone(), ivoVote, 'Only two could vote and Ivo stopped answering anyone');
    assert(r.status === 200, `Otto decides Ivo's vote (${r.status})`);
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(ivo.pubKeyHex);
    closeNow(ivoVote);
    assert(row(ivoVote).status === 'execution_void' && !row(ivoVote).owner_decision_carried_at,
        `Ivo deleted his account first: the vote is void at the close, and it is never marked carried out (${row(ivoVote).status})`);

    // No decision: too few to vote, and the pause lifts as it always has.
    const zoe = seed('ZoeZane');
    const zoeVote = pauseOf(zoe);
    closeNow(zoeVote);
    assert(row(zoeVote).status === 'unresolved' && statusOf(zoe) === 'active' && /^Quorum not met \(0\/3\)/.test(row(zoeVote).execution_reason),
        `nobody decides: the vote ends as too few voted, and Zoe is back (${row(zoeVote).status}: ${row(zoeVote).execution_reason})`);
    gone([zoe]);

    // A vote on someone who holds a server role: no vote removes them, so no owner's decision does.
    const abe = seed('AdminAbe');
    grantNodeRole(abe.pubKeyHex, 'admin', gen.pubKeyHex);
    hushStanding();
    const abePaused = de.adminEmergencySuspend(abe.pubKeyHex, gen.pubKeyHex, 'Shared the members list with a stranger', { freshProof: true });
    if (!abePaused.success || !abePaused.decision) throw new Error(`setup: could not pause Abe: ${abePaused.error}`);
    r = await decide(ottoPhone(), abePaused.decision.id, 'Only two could vote, and Abe shared the list');
    assert(r.status === 403 && r.body?.error === de.NODE_OPERATOR_VOTE_REFUSAL && !row(abePaused.decision.id).owner_decided_at,
        `a vote on an admin: refused, no vote removes an owner or admin (${r.status})`);

    // Enough voters: the community decides.
    const crowd = ['Ali', 'Bo', 'Cy'].map(n => seed(`Crowd${n}`));
    const kai = seed('KaiKnox');
    const kaiVote = pauseOf(kai);
    r = await decide(ottoPhone(), kaiVote, 'Kai was rude to the crowd at the market');
    assert(r.status === 409 && r.body?.error === de.OWNER_DECISION_ENOUGH_VOTERS && !row(kaiVote).owner_decided_at,
        `with 3 or more who could vote, an owner can't decide it (${r.status} ${r.body?.error})`);
    // A closed vote: nothing to decide.
    closeNow(kaiVote);
    r = await decide(ottoPhone(), kaiVote, 'Deciding a vote that has already closed');
    assert(r.status === 409 && r.body?.error === de.OWNER_DECISION_CLOSED, `a closed vote can't be decided (${r.status} ${r.body?.error})`);
    gone([...crowd, kai]);

    // Votes off: no owner's decision either.
    const lea = seed('LeaLong');
    const leaVote = pauseOf(lea);
    setSwitchOverride('decisions', false);
    try {
        r = await decide(ottoPhone(), leaVote, 'Votes are off on this node, deciding anyway');
        assert(r.status === 404 && !row(leaVote).owner_decided_at, `with votes off, the route answers 404 and writes nothing (${r.status} ${r.body?.code ?? r.body?.error})`);
    } finally {
        setSwitchOverride('decisions', true);
    }
    closeNow(leaVote);
    gone([lea, tia, uma]);

    // ── 5. Reinstatement keeps no floor ─────────────────────────────────────────────────────────────────────────────
    console.log('\n5. Reinstatement: a simple majority, with no Yes floor');
    {
        const voters = ['Ora', 'Pip', 'Qin'].map(n => seed(`Reinstater${n}`));
        const back = seed('BackBea');
        db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(back.pubKeyHex);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, status, opens_at, closes_at, created_at, updated_at)
            VALUES (?, ?, 'Reinstate BackBea?', 'She was removed by mistake.', 'member', 'reinstate_member', ?, '{}', '1m1v', 'open', ?, ?, ?, ?)`)
            .run(id, voters[0].pubKeyHex, back.pubKeyHex, now, new Date(Date.now() + 7 * DAY).toISOString(), now, now);
        vote(id, voters.slice(0, 2), voters.slice(2));
        t = de.tallyDecision(id);
        assert(t.passed && t.minYes === undefined, `2 Yes to 1 No reinstates: no Yes floor on the cheaper direction (passed ${t.passed})`);
        gone(voters);
    }

    assert(offMachine.length === 0, `nothing off this machine was asked (${offMachine.join(', ')})`);
    await ntfy.close();
    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch((err) => {
    console.error('test-removal-small crashed:', err);
    process.exit(1);
});
