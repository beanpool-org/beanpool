/**
 * A short week: one period of a standing deal lowered (scratch/fable-design/DESIGN-getting-paid-fable.md §3, §5, §7, §9,
 * slice L1; Marty took every recommendation, 11 Nov 2026). The provider lowers a week alone, or the payer asks and the
 * provider says yes; a lowered week is paid at its start like any other and counts as paid in full; a week at 0 moves
 * nothing; a lowered week can be lowered again, never raised; an ask changes nothing until it is a yes.
 *
 * Over real HTTP with real signatures (the lower, answer and withdraw doors, the transactions read, the Home answer), the
 * node's minute tick run as the main server runs it (state-engine.ts runStandingDeals) with a pinned `now`, and the
 * after-commit hook and the steps' own payment in the grace on the same pinned clock (setStandingHookForTests). Every
 * section ends in assertConserved.
 *
 *  1. The provider lowers next week to 100: paid at its start, once: payer −100, provider +100 less 1.5%, the Commons the
 *     fee; one Ledger row "… week 2 · 100 of 200 Beans by agreement"; the payer told (push, bell row, chat line); the week
 *     after is 200 again.
 *  2. A week at 0: one deal row of 0, no Ledger row, nothing moves, no push; the next week pays the full price.
 *  3. An ask alone changes nothing: the full price is paid at the due time and the ask lapses, the payer told; the payee's
 *     Home line (amber, counted) comes and goes; one open ask a period; the provider can't lower alone over an open ask.
 *  4. No keeps the price (the payer told, no chat line); take it back (nobody told); yes before the due time pays the asked
 *     amount at the start (the payer told, the chat records it); a fourth ask is refused; lowered again, never raised; a
 *     retry of a change or an answer writes nothing more.
 *  5. Refusals write nothing: above the price, the price itself, a period already paid, one not next, not whole hundredths,
 *     no id, a stranger, the payer answering, the provider taking back, an id already used for another change.
 *  6. Yes in the grace pays the asked amount at once (dates unchanged, both told it is covered); a second tick pays nothing.
 *  7. Yes in the grace with room below it: still short, at the lowered amount (its warning, its Needs you line, its day-
 *     before push all say it), paid the moment Beans arrive.
 *  8. The provider lowers a short week to 0: it counts as paid at once, nothing moves, the deal carries on.
 *  9. The ahead-warning and the due notices carry the lowered amount.
 * 10. Stop with a lowering agreed pays nothing more; an ask open at Stop lapses.
 * 11. The transactions read carries what the period due costs, its open ask and the asks left, and its ETag moves with them.
 * 12. A standby refuses a lowering; a re-key moves who asked.
 * 13. Random sequences of ask, yes, no, take back, lower, stop, credit and tick over several deals: no payment ever exceeds
 *     the price signed, each payment is what its period cost when it was paid, at most one row a period, Beans conserved.
 *
 * Run: SERVER_SUITES_ONLY=test-standing-lower TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { wrapCreatePost } from './post-test-helper.js';
import * as se from './state-engine.js';
import { initStateEngine, transfer, createPost as rawCreatePost, getCommonsBalanceExact, runLedgerAudit, adminSetCreditFrozen } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { setMemberPhoto } from '@beanpool/engine';
import { STANDING_CHANGE_STATES, feeOf, periodEnd, periodStart, standingAuthorisationText, standingGraceEndsAt, type StandingPeriodUnit } from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
const createPost = wrapCreatePost(rawCreatePost);

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
let BASE = '';
let HOST = '';
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any; etag?: string | null };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 240)}`;
/** Beans in the story, hundredths at the node (exact for every figure here). */
const hc = (beans: number) => Math.round(beans * 100);
const beansOf = (hundredths: number) => hundredths / 100;
/** A date as the node's notices write it (engine/standing-deals.ts dayOf). */
const dayOf = (iso: string | number) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function makeMember(name: string, beans: number): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const id = { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'TEST', 'active', 0)`).run(id.pk, name);
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, hc(beans), `seed ${name}`, 'direct', true);
    // Every buyer has listed an Offer of their own (the contribution rule).
    createPost('offer', 'general', `${name}'s jam`, 'A jar of plum jam', 500, 'fixed', id.pk);
    return id;
}

async function call(id: Id, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Res> {
    resetGatewayRateLimit();
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk,
        'X-Signature': signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString }),
        [SIGNED_FOR_HEADER]: signedForHost(),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json, etag: res.headers.get('etag') };
}
const post = (id: Id, path: string, body: Record<string, unknown>) => call(id, 'POST', path, body);

/** A standing authorisation as an app makes and signs one (@beanpool/core signStandingAuthorisation). */
function authorise(signer: Id, o: { postId: string; payee: string; beans: number; unit: StandingPeriodUnit; max: number | null }) {
    const id = crypto.randomUUID();
    const startsAt = new Date(Date.now()).toISOString();
    const payload = standingAuthorisationText({
        host: HOST, standingId: id, listingId: o.postId, payee: o.payee, beansPerPeriod_c: hc(o.beans), unit: o.unit, maxPeriods: o.max, startsAt,
        nonce: crypto.randomBytes(12).toString('hex'),
    });
    const signature = crypto.sign(null, Buffer.concat([Buffer.from([0xff]), Buffer.from(payload, 'utf-8')]), signer.priv).toString('base64');
    return { id, startsAt, standing: { authorisation: { payload, signature }, ...(o.max === null ? { untilStopped: true } : { periods: o.max }), startsAt } };
}

const standingRow = (id: string) => db.prepare('SELECT * FROM standing_deals WHERE id = ?').get(id) as any;
const periodRows = (id: string) => db.prepare('SELECT * FROM marketplace_transactions WHERE standing_id = ? ORDER BY period_no').all(id) as any[];
const changes = (id: string) => db.prepare('SELECT * FROM standing_period_changes WHERE standing_id = ? ORDER BY created_at, rowid').all(id) as any[];
const ledgerRows = (id: string) => db.prepare(`SELECT * FROM transactions WHERE auth_payload LIKE ? ORDER BY timestamp, rowid`).all(`standing:${id}:%`) as any[];
/** A balance in whole hundredths, so every check is integer arithmetic (a difference of Beans as floats isn't exact). */
const bal = (pk: string) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number } | undefined)?.balance_c ?? 0;
const keptOf = (pk: string, standingId: string) => (db.prepare(`SELECT body, data FROM moderation_notices WHERE recipient = ? ORDER BY created_at, rowid`).all(pk) as { body: string; data: string }[])
    .map(r => { try { return { body: r.body, ...JSON.parse(r.data) }; } catch { return { body: r.body }; } }).filter(d => d.standing === standingId) as Array<{ body: string; kind: string }>;
const keptKinds = (pk: string, standingId: string) => keptOf(pk, standingId).map(d => d.kind);
const chatLines = (text: string) => (db.prepare(`SELECT ciphertext FROM messages WHERE system_type = 'STANDING_DEAL' AND ciphertext LIKE ?`).all(`%${text}%`) as { ciphertext: string }[]).map(r => r.ciphertext);
function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance_c), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t;
    return accounts + getCommonsBalanceExact();
}
function assertConserved(step: string): void {
    const audit = runLedgerAudit();
    assert(audit.ok && audit.drift === 0 && nodeTotal() === 0, `${step}: the Beans are conserved (audit ${audit.ok ? 'ok' : 'FAILED'}, drift ${audit.drift}, total ${nodeTotal()})`);
}

/** Every push the standing deals send (the tick, the hook, the steps): to whom, what it says, its kind. */
const pushes: Array<{ to: string; body: string; kind: string }> = [];
const watch = (h: any) => ({
    ...h,
    dispatchPushNotification: (to: string[], actor: string, title: string, body: string, data: any, cat: any, kind: any, ...rest: any[]) => {
        for (const t of to) pushes.push({ to: t, body, kind });
        return h.dispatchPushNotification(to, actor, title, body, data, cat, kind, ...rest);
    },
});
const pushesTo = (pk: string, about: string) => pushes.filter(p => p.to === pk && p.body.includes(about));
/** The hook's and the steps' clock, pinned per section (the periods run in the suite's future). */
let hookNow = Date.now();
const tick = (now: number) => (se as any).runStandingDeals(now, (h: any) => watch(h)) as { paid: number; short: number; ended: number };
/** What the payee receives of a period, in hundredths: the period less its fee (core feeOf, truncated once). */
const payeeShare = (beans: number) => hc(beans) - feeOf(hc(beans));
const credit = (who: Id, beans: number) => assert(!!transfer('genesis', who.pk, hc(beans), `Beans for ${who.name}`, 'direct', true), `${who.name} receives ${beans} Beans`);

async function main(): Promise<void> {
    console.log('\nA short week: one period of a standing deal lowered\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    HOST = new URL(BASE).hostname;
    (se as any).setStandingHookForTests(watch, () => hookNow);
    const sink = makeMember('Sink', 0);

    /** Short, the way a member is: their own Beans fewer than the week, their credit line frozen by their admins. */
    const drain = (who: Id, keep: number) => {
        const out = bal(who.pk) - hc(keep);
        if (out > 0) assert(!!transfer(who.pk, sink.pk, out, 'sent away for the test', 'direct', true), `${who.name} sends ${beansOf(out)} away, keeping ${keep}`);
        adminSetCreditFrozen(who.pk, true);
    };
    /** A weekly Room at 200 Beans from `provider`, taken up by `payer` until stopped. */
    const takeUp = async (payer: Id, provider: Id, title: string, beans = 200, unit: StandingPeriodUnit = 'week') => {
        const listing = createPost('offer', 'housing', title, 'A room with a view', hc(beans), unit === 'week' ? 'weekly' : 'monthly', provider.pk, undefined, undefined, undefined, true) as any;
        const a = authorise(payer, { postId: listing.id, payee: provider.pk, beans, unit, max: null });
        const r = await post(payer, '/api/marketplace/posts/accept', { postId: listing.id, buyerPublicKey: payer.pk, standing: a.standing });
        assert(r.status === 200 && standingRow(a.id)?.phase === 'paid', `${payer.name} takes up ${title}: week 1 paid (${show(r)})`);
        return { ...a, listing, end: (n: number) => Date.parse(periodEnd(a.startsAt, unit, n)), from: (n: number) => periodStart(a.startsAt, unit, n) };
    };
    const lower = (who: Id, id: string, periodNo: number, beans: number, changeId: string = crypto.randomUUID()) =>
        post(who, `/api/marketplace/standing/${id}/lower`, { id: changeId, periodNo, beans_c: hc(beans) });
    const answer = (who: Id, id: string, changeId: string, yes: unknown) => post(who, `/api/marketplace/standing/${id}/lower/${changeId}/answer`, { yes });
    const withdraw = (who: Id, id: string, changeId: string) => post(who, `/api/marketplace/standing/${id}/lower/${changeId}/withdraw`, {});
    const homeNeeds = async (who: Id) => ((await call(who, 'GET', '/api/home?cards=needs')).body?.cards?.needs?.items ?? []) as any[];
    const currentRow = async (who: Id, id: string) => ((await call(who, 'GET', `/api/marketplace/transactions?publicKey=${who.pk}`)).body as any[])?.find(t => t.standingId === id && t.standingPhase);
    /** Ends a section's standing deal, so a later section's tick far ahead pays nothing on it. */
    const finish = (id: string, payer: Id) => { try { se.stopStandingDeal(id, payer.pk); } catch { /* already ended */ } };

    // The node's table takes exactly the states core names (schema.sql standing_period_changes, @beanpool/core).
    const ddl = String((db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'standing_period_changes'`).get() as { sql: string } | undefined)?.sql ?? '');
    const checked = /state IN \(([^)]*)\)/.exec(ddl)?.[1]?.split(',').map(x => x.trim().replace(/'/g, '')) ?? [];
    assert(checked.length === STANDING_CHANGE_STATES.length && STANDING_CHANGE_STATES.every(st => checked.includes(st)),
        `standing_period_changes takes exactly core's states (${checked.join(', ')})`);

    // ── 1. The provider lowers next week ───────────────────────────────────────────────────────────────────────────────
    console.log('── 1. The provider lowers next week to 100 ──');
    const kim = makeMember('Kim', 1500);
    const rob = makeMember('Rob', 0);
    const room = await takeUp(kim, rob, "Room at Rob's");
    const pushesBefore1 = pushes.length;
    const low1 = await lower(rob, room.id, 2, 100);
    const ch1 = changes(room.id);
    assert(low1.status === 200 && low1.body?.standing?.dueBeans_c === hc(100) && low1.body?.standing?.change?.state === 'agreed' && low1.body?.standing?.change?.side === 'payee'
        && ch1.length === 1 && ch1[0].state === 'agreed' && ch1[0].side === 'payee' && ch1[0].asked_by === rob.pk && ch1[0].beans_c === hc(100) && ch1[0].period_no === 2,
        `the provider lowers week 2 alone: it holds at once (${show(low1)})`);
    const loweredWords = `Rob lowered the week from ${dayOf(room.from(2))} of Room at Rob's to 100 Beans. It counts as paid in full here.`;
    const own1 = pushes.slice(pushesBefore1);
    assert(own1.length === 1 && own1[0].to === kim.pk && own1[0].body === loweredWords && own1[0].kind === 'trade.update'
        && keptOf(kim.pk, room.id).some(k => k.kind === 'standing_lowered' && k.body === loweredWords) && chatLines('Rob lowered the week').length === 1,
        `the payer is told: a push, a bell row and the deal's chat line (${JSON.stringify(own1)})`);
    assert(standingRow(room.id).periods_done === 1 && ledgerRows(room.id).length === 1, 'nothing is paid before the week is due');
    const kimBefore1 = bal(kim.pk), robBefore1 = bal(rob.pk), commonsBefore1 = getCommonsBalanceExact();
    const t1 = tick(room.end(1) + 60_000);
    const rows1 = periodRows(room.id);
    const pay1 = ledgerRows(room.id);
    assert(t1.paid === 1 && rows1.length === 2 && rows1[1].status === 'completed' && rows1[1].amount_c === hc(100) && rows1[1].period_no === 2,
        `week 2 is paid at its start, at 100 (${JSON.stringify(t1)}, ${rows1.map(r => `${r.period_no}:${beansOf(r.amount_c)}`).join(' ')})`);
    assert(kimBefore1 - bal(kim.pk) === hc(100) && bal(rob.pk) - robBefore1 === payeeShare(100) && getCommonsBalanceExact() - commonsBefore1 === feeOf(hc(100)),
        `Kim − 100, Rob + ${beansOf(bal(rob.pk) - robBefore1)} (100 less 1.5%), the Commons the fee`);
    assert(pay1.length === 2 && pay1[1].amount_c === hc(100) && pay1[1].auth_payload === `standing:${room.id}:2` && pay1[1].auth_signer === kim.pk
        && pay1[1].memo === "Standing deal · Room at Rob's · week 2 · 100 of 200 Beans by agreement",
        `one Ledger row for it, the memo says by agreement (${JSON.stringify(pay1[1])})`);
    assert(pushesTo(rob.pk, 'came in from Kim').some(p => p.body === "100 Beans for Room at Rob's came in from Kim · week 2"), "the provider's push says the 100 that came in");
    assert(tick(room.end(1) + 120_000).paid === 0 && periodRows(room.id).length === 2 && ledgerRows(room.id).length === 2, 'a second tick pays nothing');
    const kim1 = await currentRow(kim, room.id);
    assert(kim1?.standingDueBeans_c === undefined && kim1?.amount_c === hc(100) && kim1?.standingAsksLeft === 3, `the week after is 200 again (${JSON.stringify(kim1)?.slice(0, 200)})`);
    assertConserved('after a lowered week');

    // ── 2. A week at 0 ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 2. A week at 0 ──');
    const low2 = await lower(rob, room.id, 3, 0);
    assert(low2.status === 200 && low2.body?.standing?.dueBeans_c === 0, `the provider lowers week 3 to 0 (${show(low2)})`);
    const kimBefore2 = bal(kim.pk), robBefore2 = bal(rob.pk), commonsBefore2 = getCommonsBalanceExact(), pushesBefore2 = pushes.length;
    const t2 = tick(room.end(2) + 60_000);
    const rows2 = periodRows(room.id);
    assert(t2.paid === 1 && rows2.length === 3 && rows2[2].amount_c === 0 && rows2[2].status === 'completed' && standingRow(room.id).phase === 'paid'
        && standingRow(room.id).periods_done === 3 && standingRow(room.id).next_due_at === periodEnd(room.startsAt, 'week', 3),
        `week 3 at 0: one finished deal row of 0, the deal carries on, the dates unchanged (${rows2.map(r => `${r.period_no}:${beansOf(r.amount_c)}`).join(' ')})`);
    assert(ledgerRows(room.id).length === 2 && bal(kim.pk) === kimBefore2 && bal(rob.pk) === robBefore2 && getCommonsBalanceExact() === commonsBefore2,
        'no Ledger row, nothing moves, no fee');
    assert(pushes.length === pushesBefore2, `no push for a week of 0 (${pushes.slice(pushesBefore2).map(p => p.body).join(' | ')})`);
    const robBefore2b = bal(rob.pk);
    assert(tick(room.end(3) + 60_000).paid === 1 && periodRows(room.id)[3].amount_c === hc(200) && bal(rob.pk) - robBefore2b === payeeShare(200),
        'the next week pays the full price');
    assertConserved('after a week at 0');

    // ── 3. An ask alone changes nothing ───────────────────────────────────────────────────────────────────────────────
    console.log('── 3. An ask alone ──');
    const pushesBefore3 = pushes.length;
    const ask3 = crypto.randomUUID();
    const asked3 = await lower(kim, room.id, 5, 100, ask3);
    const askedWords = `Kim asks to pay 100 Beans, not 200, for the week from ${dayOf(room.from(5))} of Room at Rob's.`;
    assert(asked3.status === 200 && asked3.body?.standing?.change?.state === 'asked' && asked3.body?.standing?.dueBeans_c === hc(200)
        && asked3.body?.standing?.ask?.id === ask3 && asked3.body?.standing?.asksLeft === 2, `the payer asks about week 5: it waits, nothing changes (${show(asked3)})`);
    const own3 = pushes.slice(pushesBefore3);
    assert(own3.length === 1 && own3[0].to === rob.pk && own3[0].body === askedWords && keptKinds(rob.pk, room.id).includes('standing_ask') && !keptKinds(kim.pk, room.id).includes('standing_ask'),
        `the provider is told (a push and a bell row); the payer, who asked, is not (${JSON.stringify(own3)})`);
    assert(chatLines('asks to pay').length === 0, 'an ask makes no chat line');
    const robLine = (await homeNeeds(rob)).find(i => i.label === askedWords);
    assert(!!robLine && robLine.kind === 'deal' && robLine.accent === true && robLine.count === 1 && robLine.target?.to === 'deal' && robLine.target?.txId === standingRow(room.id).current_tx_id,
        `the provider's Home has the ask's live line, amber and counted, to the deal (${JSON.stringify(robLine)})`);
    assert(!(await homeNeeds(kim)).some(i => /asks to pay/.test(i.label ?? '')), 'the payer has no line: asking is not a step waiting on them');
    const second = await lower(kim, room.id, 5, 50);
    assert(second.status === 409 && second.body?.code === 'standing_ask_open', `one open ask a period (${show(second)})`);
    const robOver = await lower(rob, room.id, 5, 50);
    assert(robOver.status === 409 && robOver.body?.code === 'standing_ask_open' && changes(room.id).filter(c => c.period_no === 5).length === 1,
        `the provider can't lower alone over an open ask: they answer it (${show(robOver)})`);
    const kimBefore3 = bal(kim.pk);
    tick(room.end(4) + 60_000);
    assert(periodRows(room.id)[4]?.amount_c === hc(200) && kimBefore3 - bal(kim.pk) === hc(200), 'unanswered by the due time: the full price is paid');
    const lapsed3 = changes(room.id).find(c => c.id === ask3);
    const lapseWords = `Your ask to pay less for the week from ${dayOf(room.from(5))} wasn't answered in time.`;
    assert(lapsed3?.state === 'lapsed' && keptOf(kim.pk, room.id).some(k => k.kind === 'standing_ask_lapsed' && k.body === lapseWords)
        && pushesTo(kim.pk, "wasn't answered").length === 0, `the ask lapses and the payer is told: a bell row, no push (${lapsed3?.state})`);
    assert(!(await homeNeeds(rob)).some(i => i.label === askedWords), "the provider's line leaves");
    assertConserved('after an ask alone');

    // ── 4. No, take back, yes, the fourth ask, lowered again, retries ─────────────────────────────────────────────────
    console.log('── 4. No, take it back, yes ──');
    const no4 = crypto.randomUUID();
    assert((await lower(kim, room.id, 6, 150, no4)).status === 200, 'Kim asks to pay 150 for week 6');
    const pushesBeforeNo = pushes.length;
    const said = await answer(rob, room.id, no4, false);
    const noWords = `Rob said no: the week from ${dayOf(room.from(6))} of Room at Rob's stays 200 Beans.`;
    assert(said.status === 200 && said.body?.standing?.change?.state === 'declined' && said.body?.standing?.dueBeans_c === hc(200)
        && pushes.slice(pushesBeforeNo).map(p => p.body).join('|') === noWords && chatLines('said no').length === 0,
        `no: the week stays 200, the payer told, no chat line (${show(said)})`);
    const back4 = crypto.randomUUID();
    assert((await lower(kim, room.id, 6, 120, back4)).status === 200, 'Kim asks again, 120');
    const pushesBeforeBack = pushes.length;
    const took = await withdraw(kim, room.id, back4);
    assert(took.status === 200 && took.body?.standing?.change?.state === 'withdrawn' && took.body?.standing?.ask === null && pushes.length === pushesBeforeBack,
        `the payer takes it back: nothing changes, nobody is told (${show(took)})`);
    const yes4 = crypto.randomUUID();
    assert((await lower(kim, room.id, 6, 100, yes4)).status === 200, 'Kim asks a third time, 100');
    const pushesBeforeYes = pushes.length;
    const yes = await answer(rob, room.id, yes4, true);
    const yesWords = `Rob said yes: the week from ${dayOf(room.from(6))} of Room at Rob's is 100 Beans, not 200. It counts as paid in full here.`;
    assert(yes.status === 200 && yes.body?.standing?.change?.state === 'agreed' && yes.body?.standing?.dueBeans_c === hc(100)
        && pushes.slice(pushesBeforeYes).some(p => p.to === kim.pk && p.body === yesWords) && chatLines('Rob said yes').length === 1,
        `yes: week 6 is 100, the payer told and the chat records it (${show(yes)})`);
    const fourth = await lower(kim, room.id, 6, 50);
    assert(fourth.status === 409 && fourth.body?.code === 'standing_ask_limit' && changes(room.id).filter(c => c.period_no === 6).length === 3,
        `a fourth ask about the week is refused (${show(fourth)})`);
    const again = await lower(rob, room.id, 6, 80);
    assert(again.status === 200 && again.body?.standing?.dueBeans_c === hc(80), `lowered again by the provider: 80 (${show(again)})`);
    const raise = await lower(rob, room.id, 6, 90);
    const same = await lower(rob, room.id, 6, 80);
    assert(raise.status === 400 && raise.body?.code === 'standing_lower_amount' && same.status === 400
        && raise.body?.error === 'Choose fewer Beans than 80: a week can be lowered, never raised.', `never raised back, not even to the same (${show(raise)})`);
    const countBefore = changes(room.id).length;
    const retry = await lower(rob, room.id, 6, 80, again.body?.standing?.change?.id);
    const retryYes = await answer(rob, room.id, yes4, true);
    assert(retry.status === 200 && retryYes.status === 200 && changes(room.id).length === countBefore && retry.body?.standing?.change?.id === again.body?.standing?.change?.id,
        'a retry of a change or of an answer answers the same and writes nothing more');
    const lateNo = await answer(rob, room.id, yes4, false);
    assert(lateNo.status === 409 && lateNo.body?.code === 'standing_ask_gone', `an ask already answered yes can't be turned to no (${show(lateNo)})`);
    const kimBefore4 = bal(kim.pk), robBefore4 = bal(rob.pk);
    tick(room.end(5) + 60_000);
    assert(periodRows(room.id)[5]?.amount_c === hc(80) && kimBefore4 - bal(kim.pk) === hc(80) && bal(rob.pk) - robBefore4 === payeeShare(80),
        `week 6 is paid at its start at the smallest agreed: 80 (${periodRows(room.id).map(r => beansOf(r.amount_c)).join(' ')})`);
    assertConserved('after no, take back and yes');

    // ── 5. Refusals write nothing ─────────────────────────────────────────────────────────────────────────────────────
    console.log('── 5. Refusals ──');
    const stranger = makeMember('Stranger', 10);
    const before5 = changes(room.id).length;
    const kimBefore5 = bal(kim.pk);
    const refusals: Array<[string, () => Promise<Res>, number, string]> = [
        ['above the price', () => lower(rob, room.id, 7, 300), 400, 'standing_lower_amount'],
        ['the price itself', () => lower(rob, room.id, 7, 200), 400, 'standing_lower_amount'],
        ['a week already paid', () => lower(rob, room.id, 6, 50), 409, 'standing_lower_moved'],
        ['a week not next', () => lower(rob, room.id, 8, 50), 409, 'standing_lower_moved'],
        ['not whole hundredths', () => post(rob, `/api/marketplace/standing/${room.id}/lower`, { id: crypto.randomUUID(), periodNo: 7, beans_c: 100.5 }), 400, 'standing_lower_amount'],
        ['Beans as text', () => post(rob, `/api/marketplace/standing/${room.id}/lower`, { id: crypto.randomUUID(), periodNo: 7, beans_c: '100' }), 400, 'standing_lower_amount'],
        ['no id', () => post(rob, `/api/marketplace/standing/${room.id}/lower`, { periodNo: 7, beans_c: 100 }), 400, 'standing_change_body'],
        ['a stranger', () => lower(stranger, room.id, 7, 50), 404, 'standing_gone'],
        ['an id already used for another change', () => lower(rob, room.id, 7, 50, yes4), 409, 'standing_change_taken'],
    ];
    for (const [what, send, status, code] of refusals) {
        const r = await send();
        assert(r.status === status && r.body?.code === code, `${what}: ${status} ${code} (${show(r)})`);
    }
    const ask5 = crypto.randomUUID();
    assert((await lower(kim, room.id, 7, 100, ask5)).status === 200, 'Kim asks about week 7');
    const payerAnswers = await answer(kim, room.id, ask5, true);
    const robTakesBack = await withdraw(rob, room.id, ask5);
    const notBool = await answer(rob, room.id, ask5, 'yes');
    const strangerAnswers = await answer(stranger, room.id, ask5, true);
    assert(payerAnswers.status === 403 && payerAnswers.body?.code === 'standing_payee_only' && robTakesBack.status === 403 && robTakesBack.body?.code === 'standing_payer_only'
        && notBool.status === 400 && strangerAnswers.status === 404, `only the provider answers, only the payer takes back, yes is a yes (${show(payerAnswers)}; ${show(robTakesBack)}; ${show(notBool)})`);
    assert(changes(room.id).length === before5 + 1 && changes(room.id).find(c => c.id === ask5)?.state === 'asked' && bal(kim.pk) === kimBefore5,
        'none of the refusals wrote anything or moved a Bean');
    assert((await withdraw(kim, room.id, ask5)).status === 200, 'Kim takes it back');
    finish(room.id, kim);
    assertConserved('after the refusals');

    // ── 6. Yes in the grace pays at once ──────────────────────────────────────────────────────────────────────────────
    console.log('── 6. Yes in the grace ──');
    const lou = makeMember('Lou', 230);
    const ann = makeMember('Ann', 0);
    const shed = await takeUp(lou, ann, 'Garden Shed');
    drain(lou, 30);
    tick(shed.end(1) + 1000);
    assert(standingRow(shed.id).phase === 'short', 'Lou is short for week 2');
    hookNow = shed.end(1) + 2 * HOUR;
    const ask6 = crypto.randomUUID();
    const asked6 = await lower(lou, shed.id, 2, 20, ask6);
    assert(asked6.status === 200 && standingRow(shed.id).phase === 'short', `Lou asks to pay 20 for this week: still short until a yes (${show(asked6)})`);
    const louBefore6 = bal(lou.pk), annBefore6 = bal(ann.pk);
    const yes6 = await answer(ann, shed.id, ask6, true);
    const sd6 = standingRow(shed.id);
    assert(yes6.status === 200 && sd6.phase === 'paid' && sd6.periods_done === 2 && sd6.short_since === null && sd6.next_due_at === periodEnd(shed.startsAt, 'week', 2),
        `yes in the grace pays week 2 at once, the dates unchanged (${show(yes6)}, ${sd6.phase})`);
    assert(louBefore6 - bal(lou.pk) === hc(20) && bal(ann.pk) - annBefore6 === payeeShare(20) && periodRows(shed.id)[1]?.amount_c === hc(20), `Lou − 20, Ann + ${beansOf(bal(ann.pk) - annBefore6)}`);
    assert(keptKinds(lou.pk, shed.id).includes('standing_covered') && keptKinds(ann.pk, shed.id).includes('standing_covered')
        && pushesTo(lou.pk, 'Garden Shed').some(p => p.body === "Garden Shed: this week's 20 Beans have gone to Ann."), 'both are told it is covered, with the 20');
    assert(tick(shed.end(1) + 3 * HOUR).paid === 0 && periodRows(shed.id).length === 2 && ledgerRows(shed.id).length === 2, 'a second tick pays nothing');
    finish(shed.id, lou);
    assertConserved('after yes in the grace');

    // An ask left unanswered through the grace lapses with the end: the payer hears it, a bell row and no push.
    const pia = makeMember('Pia', 205);
    const gil = makeMember('Gil', 0);
    const hut = await takeUp(pia, gil, 'Hut Room');
    drain(pia, 5);
    tick(hut.end(1) + 1000);
    hookNow = hut.end(1) + HOUR;
    const ask6b = crypto.randomUUID();
    assert((await lower(pia, hut.id, 2, 0, ask6b)).status === 200 && (await homeNeeds(gil)).some(i => (i.label ?? '').startsWith('Pia asks to pay 0 Beans, not 200')),
        "Pia asks to pay 0 for the short week; Gil's Home has the ask beside the short line");
    tick(Date.parse(standingGraceEndsAt(hut.startsAt, 'week', 2)) + 1000);
    assert(standingRow(hut.id).phase === 'ended' && standingRow(hut.id).ended_reason === 'short' && changes(hut.id).find(c => c.id === ask6b)?.state === 'lapsed'
        && keptKinds(pia.pk, hut.id).includes('standing_ask_lapsed') && pushesTo(pia.pk, "wasn't answered").length === 0 && periodRows(hut.id).length === 1,
        'unanswered when the grace runs out: it ends as before, the ask lapses, the payer gets a bell row and no push');
    assertConserved('after an ask left through the grace');

    // ── 7. Yes in the grace, short of even that ──────────────────────────────────────────────────────────────────────
    console.log('── 7. Yes in the grace, still short ──');
    const max = makeMember('Max', 210);
    const bo = makeMember('Bo', 0);
    const loft = await takeUp(max, bo, 'Loft Room');
    drain(max, 10);
    tick(loft.end(1) + 1000);
    hookNow = loft.end(1) + 2 * HOUR;
    const ask7 = crypto.randomUUID();
    await lower(max, loft.id, 2, 50, ask7);
    const yes7 = await answer(bo, loft.id, ask7, true);
    assert(yes7.status === 200 && standingRow(loft.id).phase === 'short' && periodRows(loft.id).length === 1 && bal(max.pk) === hc(10),
        `yes with room below 50: still short, nothing moves (${standingRow(loft.id).phase})`);
    const maxLine = (await homeNeeds(max)).find(i => (i.label ?? '').startsWith('Loft Room:'));
    const boLine = (await homeNeeds(bo)).find(i => (i.label ?? '').startsWith("Max's 50 Beans for Loft Room"));
    assert(!!maxLine && /^Loft Room: 50 Beans /.test(maxLine.label) && !!boLine, `the short lines say the week's own 50 (${maxLine?.label} / ${boLine?.label})`);
    const read7 = await currentRow(max, loft.id);
    assert(read7?.standingPhase === 'short' && read7?.standingDueBeans_c === hc(50) && read7?.standingAsk === null, `the read: short at 50 (${JSON.stringify(read7)?.slice(0, 220)})`);
    const graceEnd7 = Date.parse(standingGraceEndsAt(loft.startsAt, 'week', 2));
    tick(graceEnd7 - 12 * HOUR);
    const dayBefore7 = `Loft Room ends on ${dayOf(graceEnd7)} unless 50 Beans reach Bo by then.`;
    assert(pushesTo(max.pk, 'Loft Room').some(p => p.body === dayBefore7), `the day-before push carries the 50 (${pushesTo(max.pk, 'Loft Room').map(p => p.body).join(' | ')})`);
    hookNow = graceEnd7 - 6 * HOUR;
    const boBefore7 = bal(bo.pk);
    credit(max, 40);
    assert(standingRow(loft.id).phase === 'paid' && bal(max.pk) === 0 && bal(bo.pk) - boBefore7 === payeeShare(50) && periodRows(loft.id)[1]?.amount_c === hc(50),
        'Beans arriving pay the 50 at once (the hook)');
    finish(loft.id, max);
    assertConserved('after yes in the grace, paid when Beans came');

    // ── 8. The provider lowers a short week to 0 ──────────────────────────────────────────────────────────────────────
    console.log('── 8. A short week lowered to 0 ──');
    const ned = makeMember('Ned', 205);
    const cy = makeMember('Cy', 0);
    const bay = await takeUp(ned, cy, 'Boat Bay');
    drain(ned, 5);
    tick(bay.end(1) + 1000);
    assert(standingRow(bay.id).phase === 'short', 'Ned is short');
    hookNow = bay.end(1) + 5 * HOUR;
    const pushesBefore8 = pushes.length;
    const zero8 = await lower(cy, bay.id, 2, 0);
    const sd8 = standingRow(bay.id);
    assert(zero8.status === 200 && sd8.phase === 'paid' && sd8.periods_done === 2 && sd8.next_due_at === periodEnd(bay.startsAt, 'week', 2)
        && periodRows(bay.id)[1]?.amount_c === 0 && ledgerRows(bay.id).length === 1 && bal(ned.pk) === hc(5) && bal(cy.pk) === payeeShare(200),
        `lowered to 0 in the grace: counts as paid at once, nothing moves, the deal carries on (${show(zero8)})`);
    const told8 = pushes.slice(pushesBefore8);
    assert(told8.length === 1 && told8[0].to === ned.pk && told8[0].body.startsWith('Cy lowered the week from') && !keptKinds(ned.pk, bay.id).includes('standing_covered'),
        `only the lowering's own notice: no "covered" for 0 Beans (${JSON.stringify(told8)})`);
    assert(!(await homeNeeds(ned)).some(i => (i.label ?? '').includes('Boat Bay')), 'the short line leaves');
    finish(bay.id, ned);
    assertConserved('after a short week lowered to 0');

    // ── 9. The ahead-warning and the due notices carry the lowered amount ───────────────────────────────────────────
    console.log('── 9. Warned about the lowered amount ──');
    const pat = makeMember('Pat', 280);
    const dee = makeMember('Dee', 0);
    const yard = await takeUp(pat, dee, 'Yard Space');
    assert((await lower(dee, yard.id, 2, 100)).status === 200, 'Dee lowers week 2 to 100');
    drain(pat, 70);
    tick(yard.end(1) - 12 * HOUR);
    const ahead = keptOf(pat.pk, yard.id).find(k => k.kind === 'standing_short_ahead');
    assert(ahead?.body === `Yard Space: 100 Beans go to Dee on ${dayOf(yard.from(2))} and you're 30 short. Earn or receive Beans by then, or stop the standing deal.`,
        `the ahead-warning says 100 and 30 short, not 200 and 130 (${ahead?.body})`);
    tick(yard.end(1) + 1000);
    assert(standingRow(yard.id).phase === 'short'
        && pushesTo(pat.pk, 'Yard Space').some(p => p.body.startsWith("Yard Space: this week's 100 Beans couldn't be paid to Dee today."))
        && pushesTo(dee.pk, 'Yard Space').some(p => p.body.startsWith("Pat's 100 Beans for this week of Yard Space couldn't be paid today.")),
        'the due notices say 100, each side');
    assert(chatLines("Pat's 100 Beans for this week of Yard Space couldn't be paid when due").length === 1, 'and the record');
    hookNow = yard.end(1) + 2 * HOUR;
    credit(pat, 30);
    assert(standingRow(yard.id).phase === 'paid' && bal(pat.pk) === 0, 'Beans arriving pay the 100');
    finish(yard.id, pat);
    assertConserved('after the warnings');

    // ── 10. Stop ──────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 10. Stop ──');
    const ova = makeMember('Ova', 600);
    const eli = makeMember('Eli', 0);
    const desk = await takeUp(ova, eli, 'Desk Corner');
    assert((await lower(eli, desk.id, 2, 100)).status === 200, 'Eli lowers week 2 to 100');
    const stop10 = await post(ova, `/api/marketplace/standing/${desk.id}/stop`, {});
    assert(stop10.status === 200 && (await lower(eli, desk.id, 2, 50)).body?.code === 'standing_lower_moved', 'stopped: nothing left to lower');
    const ovaBefore10 = bal(ova.pk);
    tick(desk.end(1) + 60_000);
    assert(standingRow(desk.id).phase === 'ended' && standingRow(desk.id).ended_reason === 'stopped' && bal(ova.pk) === ovaBefore10 && periodRows(desk.id).length === 1,
        'Stop with a lowering agreed: nothing more is paid');
    const fay = makeMember('Fay', 600);
    const desk2 = await takeUp(fay, eli, 'Desk Window');
    const ask10 = crypto.randomUUID();
    await lower(fay, desk2.id, 2, 100, ask10);
    await post(fay, `/api/marketplace/standing/${desk2.id}/stop`, {});
    assert(changes(desk2.id).find(c => c.id === ask10)?.state === 'lapsed' && !(await homeNeeds(eli)).some(i => /asks to pay/.test(i.label ?? '')),
        "an ask open at Stop lapses, and the provider's line with it");
    tick(desk2.end(1) + 60_000);
    assertConserved('after Stop');

    // ── 11. The transactions read and its ETag ────────────────────────────────────────────────────────────────────────
    console.log('── 11. The transactions read ──');
    const gus = makeMember('Gus', 900);
    const hal = makeMember('Hal', 0);
    const bench = await takeUp(gus, hal, 'Work Bench');
    const r1 = await call(gus, 'GET', `/api/marketplace/transactions?publicKey=${gus.pk}`);
    const c1 = (r1.body as any[]).find(t => t.standingId === bench.id && t.standingPhase);
    assert(c1?.standingAsksLeft === 3 && c1?.standingAsk === null && c1?.standingDueBeans_c === undefined, `a running one: 3 asks left, none open, at the price (${JSON.stringify(c1)?.slice(0, 200)})`);
    const ask11 = crypto.randomUUID();
    await lower(gus, bench.id, 2, 120, ask11);
    const r2 = await call(gus, 'GET', `/api/marketplace/transactions?publicKey=${gus.pk}`);
    const c2 = (r2.body as any[]).find(t => t.standingId === bench.id && t.standingPhase);
    assert(r2.etag !== r1.etag && c2?.standingAsk?.id === ask11 && c2?.standingAsk?.beans_c === hc(120) && c2?.standingAsk?.periodNo === 2 && c2?.standingAsksLeft === 2,
        `an ask shows on the current row, and the ETag moves (${JSON.stringify(c2?.standingAsk)})`);
    const halRow = await currentRow(hal, bench.id);
    assert(halRow?.standingAsk?.id === ask11, 'the provider reads the same ask, to answer it');
    await answer(hal, bench.id, ask11, true);
    const r3 = await call(gus, 'GET', `/api/marketplace/transactions?publicKey=${gus.pk}`);
    const c3 = (r3.body as any[]).find(t => t.standingId === bench.id && t.standingPhase);
    assert(r3.etag !== r2.etag && c3?.standingDueBeans_c === hc(120) && c3?.standingAsk === null, `yes: the week due costs 120 (${c3?.standingDueBeans_c})`);
    tick(bench.end(1) + 60_000);
    const r4 = await call(gus, 'GET', `/api/marketplace/transactions?publicKey=${gus.pk}`);
    const c4 = (r4.body as any[]).find(t => t.standingId === bench.id && t.standingPhase);
    const older = (r4.body as any[]).find(t => t.standingId === bench.id && t.periodNo === 1);
    assert(c4?.periodNo === 2 && c4?.amount_c === hc(120) && c4?.standingDueBeans_c === undefined && c4?.standingAsksLeft === 3,
        `week 2 paid at 120: the current row says so, and week 3 is at the price with 3 asks left (${JSON.stringify(c4)?.slice(0, 200)})`);
    assert(!!older && older.standingPhase === undefined && older.standingAsk === undefined && older.standingAsksLeft === undefined && older.standingDueBeans_c === undefined,
        `an older period's row carries none of it (${JSON.stringify(older)?.slice(0, 160)})`);
    finish(bench.id, gus);
    tick(bench.end(2) + 60_000);
    assertConserved('after the read');

    // ── 12. A standby; a re-key ───────────────────────────────────────────────────────────────────────────────────────
    console.log('── 12. Standby and re-key ──');
    const ida = makeMember('Ida', 900);
    const jon = makeMember('Jon', 0);
    const pen = await takeUp(ida, jon, 'Pen Shed');
    const before12 = changes(pen.id).length;
    setNodeRole('backup');
    let onStandby: Res;
    try { onStandby = await lower(jon, pen.id, 2, 100); } finally { setNodeRole('primary'); }
    assert(onStandby.status >= 400 && changes(pen.id).length === before12, `a standby refuses a lowering, writing nothing (${show(onStandby)})`);
    const ask12 = crypto.randomUUID();
    await lower(ida, pen.id, 2, 100, ask12);
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    const idaNew = crypto.generateKeyPairSync('ed25519');
    const idaNewPk = (idaNew.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    completeRekey(ida.pk, idaNewPk, issueRekeyCode(ida.pk, 'owner:password').code, 'owner:password');
    assert(changes(pen.id).find(c => c.id === ask12)?.asked_by === idaNewPk, 'a re-key moves who asked to the new key');
    finish(pen.id, { ...ida, pk: idaNewPk });
    tick(pen.end(1) + 60_000);
    assertConserved('after the standby and the re-key');

    // ── 13. Random sequences: never more than signed ──────────────────────────────────────────────────────────────────
    console.log('── 13. Random sequences ──');
    let seed = 20261111;
    const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    type Deal = { id: string; payer: Id; payee: Id; price: number; end: (n: number) => number };
    const deals: Deal[] = [];
    for (let i = 0; i < 4; i++) {
        const payer = makeMember(`Payer${i}`, 300 + Math.floor(rand() * 600));
        const payee = makeMember(`Payee${i}`, 0);
        const price = [50, 120, 200, 35.5][i];
        const d = await takeUp(payer, payee, `Lot ${i}`, price);
        if (i % 2 === 1) adminSetCreditFrozen(payer.pk, true);
        deals.push({ id: d.id, payer, payee, price, end: d.end });
    }
    const steps = se as any;
    let clock = Math.max(...deals.map(d => d.end(1))) - 3 * DAY;
    let violations = 0;
    const tried: Record<string, number> = {};
    for (let step = 0; step < 220; step++) {
        const d = pick(deals);
        const sd = standingRow(d.id);
        if (sd.phase === 'ended') continue;
        const n = sd.periods_done + 1;
        const op = pick(['ask', 'yes', 'no', 'back', 'lower', 'tick', 'tick', 'credit', 'stop']);
        tried[op] = (tried[op] ?? 0) + 1;
        hookNow = clock;
        try {
            if (op === 'ask' || op === 'lower') steps.lowerStandingPeriod(d.id, op === 'ask' ? d.payer.pk : d.payee.pk, { id: crypto.randomUUID(), periodNo: pick([n, n, n, n - 1, n + 1]), beans_c: Math.floor(rand() * hc(d.price) * 1.2) });
            else if (op === 'yes' || op === 'no' || op === 'back') {
                const open = changes(d.id).find(c => c.state === 'asked');
                if (open) {
                    if (op === 'back') steps.withdrawStandingAsk(d.id, open.id, d.payer.pk);
                    else steps.answerStandingAsk(d.id, open.id, d.payee.pk, op === 'yes');
                }
            } else if (op === 'tick') { clock += Math.floor(rand() * 2 * DAY); tick(clock); }
            else if (op === 'credit') credit(d.payer, Math.floor(rand() * 150));
            else if (op === 'stop' && rand() < 0.15) steps.stopStandingDeal(d.id, pick([d.payer.pk, d.payee.pk]));
        } catch (e: any) {
            if (!/^standing_/.test(String(e?.code))) { violations++; console.error(`  unexpected refusal on ${op}: ${e?.message}`); }
        }
        for (const x of deals) {
            const price = hc(x.price);
            const rows = periodRows(x.id);
            const pays = ledgerRows(x.id);
            const periods = new Set(rows.map(r => r.period_no));
            if (periods.size !== rows.length) { violations++; console.error(`  two rows for one period on ${x.id}`); }
            for (const r of rows) if (!(r.amount_c >= 0 && r.amount_c <= price)) { violations++; console.error(`  a period of ${r.amount_c} on a price of ${price}`); }
            for (const p of pays) {
                const no = Number(String(p.auth_payload).split(':')[2]);
                const row = rows.find(r => r.period_no === no);
                const agreed = (db.prepare(`SELECT MIN(beans_c) AS m FROM standing_period_changes WHERE standing_id = ? AND period_no = ? AND state = 'agreed'`).get(x.id, no) as any).m;
                if (!(p.amount_c > 0 && p.amount_c <= price && row && row.amount_c === p.amount_c)) { violations++; console.error(`  a payment of ${p.amount_c} for period ${no} (row ${row?.amount_c}, price ${price})`); }
                if (agreed !== null && agreed !== undefined && p.amount_c > agreed) { violations++; console.error(`  period ${no} paid ${p.amount_c} over the ${agreed} agreed before it was paid`); }
            }
        }
    }
    const ops = Object.entries(tried).map(([k, v]) => `${k} ${v}`).join(', ');
    assert(violations === 0, `220 random steps (${ops}): no payment above the price signed or above what was agreed, one row a period (${violations} violations)`);
    assert(deals.some(d => periodRows(d.id).some(r => r.amount_c < hc(d.price))), 'and some periods were paid lowered (the run exercised it)');
    for (const d of deals) finish(d.id, d.payer);
    tick(clock + 10 * DAY);
    assertConserved('after the random sequences');

    (se as any).setStandingHookForTests(null, null);
    console.log(`\n${passed}/${run} assertions passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('Unhandled failure:', e);
    process.exit(1);
});
