/**
 * Formal Decisions switched off: the `decisions` profile switch (config/node-profile.ts), off on the global profile.
 * Marty's card global-groups-votes (2026-09-27): "Groups findable, no formal votes". Anyone may join the global node
 * with one sign-in and no invite, so one person with several accounts could swing a vote; it is moderated without them.
 *
 * Over REAL HTTPS, through the signature middleware and the feature gate, with signed members:
 *
 *   1. NODE_PROFILE=global on a fresh node: /api/community/info reports `decisions: false`. Proposing a Decision is 404
 *      feature_off for every effect there is (the system's keep_suspension and an unknown one included), from a member
 *      with standing and from an owner; voting on a Decision already there is 404 feature_off; nothing is written.
 *      Reading Decisions still answers (the list, and one by id), but the list serves no open Decision, so no app, old
 *      or new, offers a vote. Underneath the routes, createDecision throws and castDecisionVote refuses.
 *   2. An emergency suspension with votes off: an admin suspends at once; the record it opens is a suspension, not a
 *      question, and nobody can vote on it; the member is still suspended on day 6; when the 7 days end the tick lifts
 *      it and gives back the node role it held aside. An admin can lift one sooner. One opened while votes were on,
 *      with enough yes votes to keep it, lifts all the same once the switch is off. One made while votes were off
 *      stays a suspension nobody votes on after the switch goes back on, and lifts at its end whatever votes it holds.
 *   3. What a vote decided before the switch went off is not carried out: a passed Decision is blocked at the tick, an
 *      open one whose vote passed is blocked too, and a removal in its grace window is not completed (nor can an admin
 *      hurry it); the admin brake still halts it and gives the member back.
 *   4. A local community (NODE_PROFILE unset): unchanged. info reports `decisions: true`, a member proposes and votes,
 *      and an emergency suspension opens "Keep …'s suspension?", which a vote keeps. The operator's override
 *      `nodeProfile.decisions=false` switches them off there too.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-decisions-off.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
process.env.NODE_PROFILE = 'global';
process.env.ADMIN_PASSWORD = 'Decisions-Off-Admin-61!';

import crypto from 'node:crypto';

const PORT = 8766;
const BASE = `https://localhost:${PORT}`;
const ADMIN_PW = process.env.ADMIN_PASSWORD;
const ADMIN = { 'x-admin-password': ADMIN_PW };
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 24 * 60 * 60 * 1000;
const VOTES_OFF = /Community votes are switched off on this node/;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pk: string; privateKey: crypto.KeyObject; callsign: string };

async function call(method: 'GET' | 'POST', path: string, body: unknown, id: Id | null, extra: Record<string, string> = {}) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

const featureOff = (r: { status: number; body: any }) =>
    r.status === 404 && r.body?.code === 'feature_off' && r.body?.feature === 'decisions' && VOTES_OFF.test(r.body?.error ?? '');
const show = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;

async function main() {
    const { db, initSchema } = await import('./db/db.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    initSchema();
    initAdminPassword();
    const se = await import('./state-engine.js');
    await se.initStateEngine();
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    await initTls();
    await startHttpsServer(PORT);
    const de = await import('./decisions-engine.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');

    const setOverride = (value: 'true' | 'false') =>
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`${NODE_PROFILE_KEY}.decisions`, value);
    const clearOverride = () => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.decisions`);
    const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;
    const statusOf = (id: Id) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(id.pk) as { status: string }).status;
    const roleOf = (id: Id) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(id.pk) as { role: string } | undefined)?.role ?? null;
    const decision = (decisionId: string) => db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as any;

    // Members who joined yesterday and were active today: every one of them can propose (earned standing) and vote.
    const joined = new Date(Date.now() - DAY).toISOString();
    const member = (callsign: string): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, avatar_url, status, joined_at, updated_at, invited_by, invite_code, earned_credit, last_active_at)
                    VALUES (?, ?, ?, 'active', ?, ?, 'seed', 'seed', 1, ?)`)
            .run(pk, callsign, AVATAR, joined, joined, new Date().toISOString());
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
        return { pk, privateKey, callsign };
    };
    const olga = member('Olga'), alice = member('Alice'), bob = member('Bob'), carol = member('Carol'), dave = member('Dave');
    const erin = member('Erin'), frank = member('Frank'), gina = member('Gina'), hank = member('Hank'), ivan = member('Ivan');
    const jack = member('Jack'), kate = member('Kate'), lena = member('Lena');
    grantNodeRole(olga.pk, 'owner', 'owner:password');
    grantNodeRole(erin.pk, 'admin', 'owner:password');
    const voters = [alice, bob, carol, dave];

    // A Decision already on this node, as if opened before the switch went off.
    const existing = (effect: string, subject: Id, opts: { status?: string; opensAt?: string; closesAt?: string } = {}): string => {
        const id = crypto.randomUUID();
        const opensAt = opts.opensAt ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const closesAt = opts.closesAt ?? new Date(Date.now() + 6 * DAY).toISOString();
        db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, status,
                        opens_at, closes_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'member', ?, ?, NULL, '1m1v', ?, ?, ?, ?, ?)`)
            .run(id, alice.pk, `${effect} ${subject.callsign}`, 'Opened before votes were switched off', effect, subject.pk,
                opts.status ?? 'open', opensAt, closesAt, opensAt, opensAt);
        return id;
    };

    // ── 1. The global profile: nothing opened, nothing voted, reads answer ──
    console.log('── 1. NODE_PROFILE=global: no Decision is opened or voted on ──');
    const info = await call('GET', '/api/community/info', null, alice);
    assert(info.status === 200 && info.body?.profile === 'global' && info.body?.features?.decisions === false,
        `info says global, with formal Decisions off (${info.status} ${JSON.stringify(info.body?.features)})`);

    const effects = [...Object.keys(de.TOUCHES_FOR_EFFECT), 'set_rule'];
    assert(effects.length === 14 && effects.includes('keep_suspension') && effects.includes('remove_lead_keeper'),
        `every effect there is, the system's own and an unknown one (${effects.join(', ')})`);
    for (const effect of effects) {
        for (const who of [carol, olga]) {
            const r = await call('POST', '/api/commons/decisions', {
                title: `Try ${effect}`, description: 'A proposal on a node without votes', effect,
                touches: (de.TOUCHES_FOR_EFFECT as Record<string, string>)[effect] ?? 'member', subject: dave.pk, params: { amount: 5 },
            }, who);
            assert(featureOff(r), `${who.callsign} proposes ${effect}: 404 feature_off, with the sentence (${show(r)})`);
        }
    }
    assert(count('SELECT COUNT(*) AS c FROM decisions') === 0, 'and no Decision was written');

    const before = existing('freeze_credit', dave);
    const closedBefore = existing('grant_voucher', dave, { status: 'executed', closesAt: new Date(Date.now() - DAY).toISOString() });
    const vote = await call('POST', `/api/commons/decisions/${before}/vote`, { support: true }, bob);
    assert(featureOff(vote), `voting on a Decision already open: 404 feature_off (${show(vote)})`);
    const noSuch = await call('POST', `/api/commons/decisions/${crypto.randomUUID()}/vote`, { support: false }, bob);
    assert(featureOff(noSuch), `voting on one that isn't there gets the same answer (${show(noSuch)})`);
    assert(count('SELECT COUNT(*) AS c FROM decision_votes') === 0, 'and no vote was written');

    const list = await call('GET', '/api/commons/decisions', null, bob);
    const ids = (list.body?.decisions ?? []).map((d: any) => d.id);
    assert(list.status === 200 && ids.includes(closedBefore) && !ids.includes(before),
        `the list still answers, with the closed Decision and without the open one nobody can vote on (${list.status} ${JSON.stringify(ids)})`);
    assert(list.body?.canPropose === false, `and it says the signer can't propose (${list.body?.canPropose})`);
    const openList = await call('GET', '/api/commons/decisions?status=open', null, bob);
    assert(openList.status === 200 && Array.isArray(openList.body?.decisions) && openList.body.decisions.length === 0,
        `the open list, which the header's vote icon reads, is empty (${show(openList)})`);
    const one = await call('GET', `/api/commons/decisions/${before}`, null, bob);
    assert(one.status === 200 && one.body?.decision?.id === before, `one Decision by its id still answers (${one.status})`);

    let thrown: any = null;
    try {
        de.createDecision({ authorPubkey: carol.pk, title: 'Direct', description: 'Straight to the engine', touches: 'member', effect: 'freeze_credit', subject: dave.pk });
    } catch (e) { thrown = e; }
    assert(thrown?.code === 'feature_off' && thrown?.feature === 'decisions', `createDecision refuses underneath the routes (${thrown?.code} ${thrown?.message})`);
    const direct = de.castDecisionVote(before, bob.pk, true) as { success: boolean; error?: string; code?: string };
    assert(!direct.success && direct.code === 'feature_off' && VOTES_OFF.test(direct.error ?? ''), `castDecisionVote refuses underneath the routes (${JSON.stringify(direct)})`);
    db.prepare('DELETE FROM decisions WHERE id IN (?, ?)').run(before, closedBefore);

    // ── 2. Emergency suspension: the moderators decide, and it ends ──
    console.log('\n── 2. an emergency suspension with votes off ──');
    const reason = 'Threats in the market chat, reported twice';
    const suspended = await call('POST', `/api/local/admin/users/${erin.pk}/suspend`, { reason }, null, ADMIN);
    const record = suspended.body?.decision;
    assert(suspended.status === 200 && statusOf(erin) === 'disabled' && roleOf(erin) === null,
        `an admin suspends Erin at once, and her admin role is held aside (${show(suspended)}, ${statusOf(erin)}, ${roleOf(erin)})`);
    const opens = Date.parse(record?.opensAt), closes = Date.parse(record?.closesAt);
    assert(record?.effect === 'keep_suspension' && closes - opens === 7 * DAY, `it lasts 7 days (${record?.opensAt} → ${record?.closesAt})`);
    assert(record?.title === `Erin is suspended until ${record?.closesAt?.slice(0, 10)}` && !String(record?.title).includes('?'),
        `the record says what it is, not a question (${JSON.stringify(record?.title)})`);
    assert(VOTES_OFF.test(record?.description ?? '') && /lifts by itself on \d{4}-\d{2}-\d{2}, or sooner if a moderator lifts it/.test(record?.description ?? '')
        && String(record?.description).endsWith(`Reason given: ${reason}`),
        `and why there is no vote, when it ends, and the reason (${JSON.stringify(record?.description)})`);
    const keepVote = await call('POST', `/api/commons/decisions/${record?.id}/vote`, { support: true }, bob);
    assert(featureOff(keepVote), `nobody can vote to keep it (${show(keepVote)})`);
    const members = await call('GET', '/api/commons/decisions?status=open', null, bob);
    assert(members.status === 200 && members.body?.decisions?.length === 0, `members are not shown a vote about it (${show(members)})`);
    const adminList = await call('POST', '/api/local/admin/decisions', {}, null, ADMIN);
    assert(adminList.status === 200 && (adminList.body?.decisions ?? []).some((d: any) => d.id === record?.id),
        `the admins' list shows it (${adminList.status})`);

    de.tickDecisions(opens + 6 * DAY);
    assert(statusOf(erin) === 'disabled' && decision(record.id).status === 'open', `on day 6 Erin is still suspended (${statusOf(erin)}, ${decision(record.id).status})`);
    de.tickDecisions(closes + 60_000);
    const ended = decision(record.id);
    assert(statusOf(erin) === 'active' && roleOf(erin) === 'admin', `when the 7 days end the suspension lifts, and her admin role comes back (${statusOf(erin)}, ${roleOf(erin)})`);
    assert(ended.status === 'unresolved' && VOTES_OFF.test(ended.execution_reason) && /The suspension has been lifted/.test(ended.execution_reason),
        `the record says why it ended (${ended.status}: ${ended.execution_reason})`);

    const frankSuspended = await call('POST', `/api/local/admin/users/${frank.pk}/suspend`, { reason: 'Spamming every group with the same link' }, null, ADMIN);
    const lifted = await call('POST', `/api/local/admin/users/${frank.pk}/status`, { status: 'active' }, null, ADMIN);
    assert(frankSuspended.status === 200 && lifted.status === 200 && statusOf(frank) === 'active'
        && decision(frankSuspended.body?.decision?.id).status === 'admin_halted',
        `an admin can lift one sooner (${show(lifted)}, ${statusOf(frank)})`);
    const noDisable = await call('POST', `/api/local/admin/users/${frank.pk}/status`, { status: 'disabled' }, null, ADMIN);
    assert(noDisable.status === 400 && /it lasts 7 days/.test(noDisable.body?.error ?? '') && !/community vote/.test(noDisable.body?.error ?? ''),
        `the old status route points at the suspend route without promising a vote (${show(noDisable)})`);

    // Opened while votes were on, with the votes to keep it; the switch goes off before it closes.
    setOverride('true');
    await new Promise(r => setTimeout(r, 5));
    const ginaSuspended = await call('POST', `/api/local/admin/users/${gina.pk}/suspend`, { reason: 'Harassing a member in messages' }, null, ADMIN);
    const ginaRecord = ginaSuspended.body?.decision;
    assert(ginaSuspended.status === 200 && ginaRecord?.title === "Keep Gina's suspension?", `with votes on, it opens as a vote (${JSON.stringify(ginaRecord?.title)})`);
    const keeps = [];
    for (const v of [...voters, olga]) keeps.push((await call('POST', `/api/commons/decisions/${ginaRecord?.id}/vote`, { support: true }, v)).status);
    assert(keeps.every(s => s === 200), `five members vote to keep it (${keeps.join(', ')})`);
    assert(de.tallyDecision(ginaRecord.id, Date.parse(ginaRecord.closesAt) + 60_000).passed, 'enough to keep it, had votes stayed on');
    setOverride('false');
    de.tickDecisions(Date.parse(ginaRecord.closesAt) + 60_000);
    assert(statusOf(gina) === 'active' && decision(ginaRecord.id).status === 'unresolved' && VOTES_OFF.test(decision(ginaRecord.id).execution_reason),
        `switched off before it closed, it lifts all the same: no vote keeps a suspension here (${statusOf(gina)}, ${decision(ginaRecord.id).status})`);
    clearOverride();

    // Made while votes were off; the operator switches them on before it ends. It stays what it said it was, a
    // suspension that ends: nobody can vote on it, members are not shown it as a vote, and it lifts at its end.
    const lenaSuspended = await call('POST', `/api/local/admin/users/${lena.pk}/suspend`, { reason: 'Posting the same scam link in every group' }, null, ADMIN);
    const lenaRecord = lenaSuspended.body?.decision;
    assert(lenaSuspended.status === 200 && statusOf(lena) === 'disabled' && lenaRecord?.title === `Lena is suspended until ${lenaRecord?.closesAt?.slice(0, 10)}`,
        `with votes off, an admin suspends Lena (${show(lenaSuspended)})`);
    setOverride('true');
    const lenaVotes = [];
    for (const v of [...voters, olga]) lenaVotes.push(await call('POST', `/api/commons/decisions/${lenaRecord?.id}/vote`, { support: true }, v));
    assert(lenaVotes.every(r => r.status === 400 && /Nobody votes on this suspension/.test(r.body?.error ?? ''))
        && count('SELECT COUNT(*) AS c FROM decision_votes WHERE decision_id = ?', lenaRecord?.id) === 0,
        `votes switched on, nobody can vote to keep it (${lenaVotes.map(show).join('; ')})`);
    const lenaDirect = de.castDecisionVote(lenaRecord.id, bob.pk, true);
    assert(!lenaDirect.success && /Nobody votes on this suspension/.test(lenaDirect.error ?? ''), `castDecisionVote refuses it underneath the route (${JSON.stringify(lenaDirect)})`);
    const lenaOpen = await call('GET', '/api/commons/decisions?status=open', null, bob);
    const lenaAll = await call('GET', '/api/commons/decisions', null, bob);
    assert(lenaOpen.status === 200 && lenaAll.status === 200
        && ![...(lenaOpen.body?.decisions ?? []), ...(lenaAll.body?.decisions ?? [])].some((d: any) => d.id === lenaRecord?.id),
        `nor are members shown it as a vote (${show(lenaOpen)})`);
    // However many yes votes it holds, they keep nothing.
    for (const v of [...voters, olga]) {
        db.prepare(`INSERT OR REPLACE INTO decision_votes (decision_id, voter_pubkey, support, weight, credits_used, created_at, updated_at)
                    VALUES (?, ?, 1, 1, 1, ?, ?)`).run(lenaRecord.id, v.pk, lenaRecord.opensAt, lenaRecord.opensAt);
    }
    assert(de.tallyDecision(lenaRecord.id, Date.parse(lenaRecord.closesAt) + 60_000).passed, 'yes votes enough to keep it, were it a vote');
    de.tickDecisions(Date.parse(lenaRecord.closesAt) + 60_000);
    const lenaEnded = decision(lenaRecord.id);
    assert(statusOf(lena) === 'active' && lenaEnded.status === 'unresolved'
        && /were switched off on this node when this suspension was made/.test(lenaEnded.execution_reason ?? '')
        && /The suspension has been lifted/.test(lenaEnded.execution_reason ?? ''),
        `when its 7 days end it lifts, as it said it would (${statusOf(lena)}, ${lenaEnded.status}: ${lenaEnded.execution_reason})`);
    clearOverride();

    // ── 3. What a vote decided before the switch went off ──
    console.log('\n── 3. votes from before the switch are not carried out ──');
    const past = new Date(Date.now() - 60_000).toISOString();
    const passedOne = existing('freeze_credit', hank, { status: 'passed', closesAt: past });
    const openPassing = existing('suspend_member', hank, { closesAt: past });
    for (const v of voters) {
        db.prepare(`INSERT INTO decision_votes (decision_id, voter_pubkey, support, weight, credits_used, created_at, updated_at)
                    VALUES (?, ?, 1, 1, 1, ?, ?)`).run(openPassing, v.pk, past, past);
    }
    setOverride('true');
    assert(de.tallyDecision(openPassing).passed, 'the open one has the votes to pass');
    setOverride('false');
    de.tickDecisions();
    const hankRow = db.prepare('SELECT status, COALESCE(credit_frozen, 0) AS frozen FROM members WHERE public_key = ?').get(hank.pk) as any;
    for (const [what, id] of [['a passed Decision', passedOne], ['an open one whose vote passed', openPassing]] as const) {
        const d = decision(id);
        assert(d.status === 'execution_blocked' && VOTES_OFF.test(d.execution_error ?? ''), `${what} is blocked, and says why (${d.status}: ${d.execution_error})`);
    }
    assert(hankRow.status === 'active' && hankRow.frozen === 0, `Hank was neither frozen nor suspended (${JSON.stringify(hankRow)})`);

    setOverride('true');
    const removal = de.createDecision({ authorPubkey: carol.pk, title: 'Remove Ivan', description: 'Voted before the switch went off', touches: 'member', effect: 'remove_member', subject: ivan.pk });
    const graced = de.executeDecision(removal.id);
    assert(graced.status === 'execution_pending_grace' && statusOf(ivan) === 'disabled', `with votes on, a removal starts its grace window (${graced.status})`);
    setOverride('false');
    db.prepare('UPDATE decisions SET grace_period_ends_at = ? WHERE id = ?').run(past, removal.id);
    de.tickDecisions();
    assert(statusOf(ivan) === 'disabled' && decision(removal.id).status === 'execution_pending_grace',
        `its grace ends with votes off: the removal is not completed (${statusOf(ivan)}, ${decision(removal.id).status})`);
    const hurry = await call('POST', `/api/local/admin/decisions/${removal.id}/accelerate`, {}, null, ADMIN);
    assert(featureOff(hurry) && statusOf(ivan) === 'disabled', `nor can an admin hurry it (${show(hurry)})`);
    assert(!de.adminAccelerateDecision(removal.id, 'owner:password').success, 'underneath the route too');
    const halt = await call('POST', `/api/local/admin/decisions/${removal.id}/halt`, { reason: 'Votes are off here now; the moderators will look again.' }, null, ADMIN);
    assert(halt.status === 200 && statusOf(ivan) === 'active' && decision(removal.id).status === 'admin_halted',
        `the admin brake still halts it and gives Ivan back (${show(halt)}, ${statusOf(ivan)})`);
    clearOverride();

    // ── 4. A local community: unchanged ──
    console.log('\n── 4. a local community (NODE_PROFILE unset): unchanged ──');
    delete process.env.NODE_PROFILE;
    const info4 = await call('GET', '/api/community/info', null, alice);
    assert(info4.body?.profile === 'local' && info4.body?.features?.decisions === true, `info says local, with formal Decisions on (${JSON.stringify(info4.body?.features)})`);
    const proposed = await call('POST', '/api/commons/decisions', {
        title: 'Freeze Dave', description: 'Freeze Dave while we talk', touches: 'member', effect: 'freeze_credit', subject: dave.pk,
    }, bob);
    assert(proposed.status === 200 && proposed.body?.success, `a member proposes (${show(proposed)})`);
    const cast = await call('POST', `/api/commons/decisions/${proposed.body?.decision?.id}/vote`, { support: true }, carol);
    assert(cast.status === 200 && cast.body?.success, `and a member votes (${show(cast)})`);
    const listed = await call('GET', '/api/commons/decisions?status=open', null, carol);
    assert((listed.body?.decisions ?? []).some((d: any) => d.id === proposed.body?.decision?.id), 'the open list shows it');

    await new Promise(r => setTimeout(r, 5));
    const jackSuspended = await call('POST', `/api/local/admin/users/${jack.pk}/suspend`, { reason: 'Threats in the market chat, again' }, null, ADMIN);
    const jackRecord = jackSuspended.body?.decision;
    assert(jackSuspended.status === 200 && jackRecord?.title === "Keep Jack's suspension?"
        && String(jackRecord?.description).startsWith(`An admin suspended Jack on ${jackRecord?.opensAt?.slice(0, 10)}. Keep the suspension?`),
        `an emergency suspension opens a vote, as before (${JSON.stringify(jackRecord?.title)})`);
    for (const v of [...voters, olga, kate]) await call('POST', `/api/commons/decisions/${jackRecord?.id}/vote`, { support: true }, v);
    de.tickDecisions(Date.parse(jackRecord.closesAt) + 60_000);
    assert(statusOf(jack) === 'disabled' && decision(jackRecord.id).status === 'executed', `and the vote keeps it (${statusOf(jack)}, ${decision(jackRecord.id).status})`);

    setOverride('false');
    const info5 = await call('GET', '/api/community/info', null, alice);
    const offHere = await call('POST', '/api/commons/decisions', {
        title: 'Unfreeze Dave', description: 'Unfreeze Dave again now', touches: 'member', effect: 'unfreeze_credit', subject: dave.pk,
    }, kate);
    assert(info5.body?.features?.decisions === false && featureOff(offHere),
        `the operator's nodeProfile.decisions=false switches them off on a local community too (${show(offHere)})`);
    clearOverride();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ No formal votes where Decisions are off; emergency suspensions still end; local communities unchanged.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
