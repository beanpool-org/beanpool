/**
 * A listing's deals by who you are (scratch/fable-design/DESIGN-deals-fable.md §3.2, slice S4), over real HTTPS through the
 * signature middleware, with Expo stubbed (nothing leaves this machine):
 *
 *   1. Every deal step's alert lands ON the deal: its details (GET /api/notices/push/:id, read by its recipient as the phone
 *      reads them) carry `txId` beside `screen: 'post'` and `postId`, for a request, an approval, a decline, a one-step accept,
 *      a release and a cancel.
 *   2. The apps' one rule for deal buttons (@beanpool/core dealMoves, fed the member's keeperOf from their own balance read)
 *      against the node itself, on an enterprise's listings: for every reader (two keepers, a keeper paid by the enterprise,
 *      the member on the other side, a stranger, a keeper of another enterprise, a keeper switched off), Release, Cancel hold
 *      and Deny show exactly when the node lets them do it. A "no" is tried at every door (the marketplace's, and the
 *      enterprise's own in routes/treasury.ts) under every key the reader could name, and must be refused with the deal left
 *      as it was; a "yes" is taken as the apps take it (as themselves, or as the rule's actingAs at the enterprise's door)
 *      and must go through. A keeper never cancels the enterprise's hold: the node has no door for it.
 *
 * Not in the rule, and so not here: an enterprise paused while a keeper's own pay is held is refused its release with its own
 * words (engine/escrow.ts "Enterprise is paused — wage payments…"), a state of the enterprise as holiday mode is a member's.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-deal-listing-keepers.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
for (const k of ['CF_RECORD_NAME', 'NODE_ROLE', 'NODE_PROFILE', 'EXPO_ACCESS_TOKEN', 'ENFORCE_READ_AUTH', 'ENFORCE_WS_AUTH']) delete process.env[k];

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { dealMoves, type DealRow } from '@beanpool/core';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 40)); };

type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

let BASE = '';
let beforeCall: () => void = () => {};
async function call(method: 'GET' | 'POST', id: Id, route: string, body?: unknown): Promise<Res> {
    beforeCall();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now(); const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text(); let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* */ }
    return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
    console.log('A listing\'s deals by who you are: alerts land on the deal, and keepers see what the node lets them do\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { initTls } = await import('./services/tls.js');
    const { wrapCreatePost } = await import('./post-test-helper.js');
    const se = await import('./state-engine.js');
    const createPost = wrapCreatePost(se.createPost);
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const escrow: any = await import('./engine/escrow.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };
    await initTls();
    se.initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        const host = new URL(url).hostname;
        if (host === 'exp.host' || host.endsWith('expo.dev')) {
            const batch = JSON.parse(init?.body ?? '[]');
            sent.push(...batch);
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (host === 'localhost' || host === '127.0.0.1') return realFetch(input, init);
        throw new Error(`the test refused to contact ${host}`);
    };
    const tokenOwner = new Map<string, Id>();

    const owner = newId('Olive');
    se.seedGenesisMember(owner.pk, 'Olive');
    const member = (name: string, beans = 0, opts: { treasury?: boolean } = {}): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury) VALUES (?, ?, ?, ?, ?, 'active', ?)`)
            .run(id.pk, name, new Date(Date.now() - 60 * 86_400_000).toISOString(), owner.pk, `INV-${name.toUpperCase().replace(/\W/g, '')}`, opts.treasury ? 1 : 0);
        setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        if (beans > 0 && !(se as any).transfer('genesis', id.pk, beans, 'Seed grant', 'direct', true)) throw new Error('seed grant failed');
        if (!opts.treasury) {
            const token = `ExponentPushToken[${name}-${crypto.randomBytes(8).toString('hex')}]`;
            putPushTokenRow(id.pk, token, 'android');
            tokenOwner.set(token, id);
        }
        // An Offer of their own, so the contribution gate lets them take one up (and an enterprise post a Need).
        createPost('offer', 'general', `${name}'s jam`, 'A jar of plum jam', 5, 'fixed', id.pk);
        return id;
    };
    const keep = (ent: Id, k: Id) => {
        db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(ent.pk, k.pk);
        db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(k.pk);
    };
    const statusOf = (txId: string) => (db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(txId) as any)?.status;
    /** The deal as the apps hold it: the node's own transaction read, with the listing's author and kind. */
    const rowOf = (txId: string): DealRow => {
        const r = db.prepare(`SELECT mt.*, p.author_pubkey, p.type, p.repeatable, p.lendable FROM marketplace_transactions mt JOIN posts p ON p.id = mt.post_id WHERE mt.id = ?`).get(txId) as any;
        return { id: r.id, postId: r.post_id, status: r.status, buyerPublicKey: r.buyer_pubkey, sellerPublicKey: r.seller_pubkey, createdAt: r.created_at,
            postAuthorPublicKey: r.author_pubkey, postType: r.type, postRepeatable: !!r.repeatable, postLendable: r.lendable === 1 };
    };
    /** What the apps read for a member's enterprises: their own balance, signed (keeperOf). */
    const keeperOfRead = async (who: Id): Promise<string[]> => {
        const b = await call('GET', who, `/api/ledger/balance/${who.pk}`);
        return Array.isArray(b.body?.keeperOf) ? b.body.keeperOf : [];
    };

    // ── 1. An alert lands on the deal ─────────────────────────────────────────────────────────────────────────────────
    console.log('--- 1. Every deal step\'s alert carries the deal ---');
    escrow.resetRepeatDealPushes?.();
    const ana = member('Ana', 300);
    const ben = member('Ben', 300);
    const cleo = member('Cleo', 300);
    /** The details of the newest alert to `who`, as their phone reads them (signed by them, through the middleware). */
    const lastAlertTo = async (who: Id): Promise<any> => {
        await flush();
        const mine = sent.filter(m => tokenOwner.get(m.to) === who);
        const id = mine[mine.length - 1]?.data?.i;
        if (!id) return null;
        const r = await call('GET', who, `/api/notices/push/${id}`);
        return r.status === 200 ? r.body?.data : null;
    };
    const landsOn = (data: any, postId: string, txId: string) => data?.screen === 'post' && data?.postId === postId && data?.txId === txId;

    const fence = createPost('need', 'services', 'Fix the fence', 'Two panels down', 20, 'fixed', ana.pk)!;
    const asked = await call('POST', ben, '/api/marketplace/posts/request', { postId: fence.id, buyerPublicKey: ben.pk });
    const askId = asked.body?.transaction?.id as string;
    let alert = await lastAlertTo(ana);
    assert(asked.status === 200 && landsOn(alert, fence.id, askId), `a request's alert to the author names the request (${show(asked)} / ${JSON.stringify(alert)})`);
    const approved = await call('POST', ana, '/api/marketplace/transactions/approve', { transactionId: askId, authorPublicKey: ana.pk });
    alert = await lastAlertTo(ben);
    assert(approved.status === 200 && landsOn(alert, fence.id, askId), `the approval's alert to the helper names the deal (${show(approved)} / ${JSON.stringify(alert)})`);
    const released = await call('POST', ana, '/api/marketplace/transactions/complete', { transactionId: askId, confirmerPublicKey: ana.pk });
    alert = await lastAlertTo(ben);
    assert(released.status === 200 && landsOn(alert, fence.id, askId), `the release's alert to the payee names the deal (${show(released)} / ${JSON.stringify(alert)})`);

    const gutter = createPost('need', 'services', 'Clear the gutter', 'Leaves', 10, 'fixed', ana.pk)!;
    const asked2 = await call('POST', cleo, '/api/marketplace/posts/request', { postId: gutter.id, buyerPublicKey: cleo.pk });
    const ask2Id = asked2.body?.transaction?.id as string;
    const declined = await call('POST', ana, '/api/marketplace/transactions/reject', { transactionId: ask2Id, authorPublicKey: ana.pk });
    alert = await lastAlertTo(cleo);
    assert(declined.status === 200 && landsOn(alert, gutter.id, ask2Id), `a decline's alert to the one who asked names their request (${show(declined)} / ${JSON.stringify(alert)})`);

    const lessons = createPost('offer', 'education', 'Guitar lessons', 'Weekly', 30, 'fixed', ana.pk, undefined, undefined, undefined, true)!;
    const took = await call('POST', ben, '/api/marketplace/posts/accept', { postId: lessons.id, buyerPublicKey: ben.pk });
    const tookId = took.body?.transaction?.id as string;
    alert = await lastAlertTo(ana);
    assert(took.status === 200 && landsOn(alert, lessons.id, tookId), `a one-step accept's alert to the author names the deal (${show(took)} / ${JSON.stringify(alert)})`);
    const took2 = await call('POST', cleo, '/api/marketplace/posts/accept', { postId: lessons.id, buyerPublicKey: cleo.pk });
    const took2Id = took2.body?.transaction?.id as string;
    const cancelled = await call('POST', ana, '/api/marketplace/transactions/cancel', { transactionId: took2Id, cancellerPublicKey: ana.pk });
    alert = await lastAlertTo(cleo);
    assert(cancelled.status === 200 && landsOn(alert, lessons.id, took2Id),
        `a cancel's alert to the other side names that deal, not the listing's other one (${show(cancelled)} / ${JSON.stringify(alert)})`);

    // ── 2. Keepers: the apps' rule against the node ───────────────────────────────────────────────────────────────────
    console.log('\n--- 2. Who sees Release, Cancel hold and Approve/Deny on an enterprise\'s listing ---');
    const farm = member('Farm Co-op', 400, { treasury: true });
    const other = member('Other Co-op', 50, { treasury: true });
    const kai = member('Kai', 100);       // a keeper of the farm
    const lee = member('Lee', 100);       // another keeper of the farm
    const mo = member('Mo', 300);         // a member trading with the farm
    const zoe = member('Zoe', 100);       // a stranger to every deal here
    const oli = member('Oli', 100);       // keeps another enterprise
    const sid = member('Sid', 100);       // a keeper of the farm, switched off
    for (const k of [kai, lee, sid]) keep(farm, k);
    keep(other, oli);
    db.prepare('UPDATE members SET can_operate = 0 WHERE public_key = ?').run(sid.pk);
    db.prepare('UPDATE members SET earned_surplus = 300 WHERE public_key = ?').run(farm.pk);
    const readers = [kai, lee, mo, zoe, oli, sid];
    const keeperOf = new Map<string, string[]>();
    for (const r of readers) keeperOf.set(r.pk, await keeperOfRead(r));
    assert(JSON.stringify(keeperOf.get(kai.pk)) === JSON.stringify([farm.pk]) && keeperOf.get(sid.pk)!.length === 0 && keeperOf.get(zoe.pk)!.length === 0,
        `the apps' keeperOf read: Kai keeps the farm, Sid (switched off) and Zoe keep nothing (${JSON.stringify([...keeperOf.values()].map(v => v.length))})`);

    const keysFor = (who: Id) => [who.pk, farm.pk, other.pk];
    type Step = 'release' | 'cancelHold' | 'answer';
    /** Every door to a step named with `as`: the member's own (the marketplace's) and, for an enterprise, its own doors too. */
    const doors = (step: Step, who: Id, txId: string, as: string): Array<() => Promise<Res>> => {
        const own = step === 'release' ? ['/api/marketplace/transactions/complete', { transactionId: txId, confirmerPublicKey: as }]
            : step === 'cancelHold' ? ['/api/marketplace/transactions/cancel', { transactionId: txId, cancellerPublicKey: as }]
            : ['/api/marketplace/transactions/reject', { transactionId: txId, authorPublicKey: as }];
        const out: Array<() => Promise<Res>> = [() => call('POST', who, own[0] as string, own[1])];
        // The enterprise's doors (routes/treasury.ts): there is none to cancel a hold.
        if (as !== who.pk && step !== 'cancelHold') out.push(() => call('POST', who, `/api/treasury/${as}/${step === 'release' ? 'complete' : 'reject'}`, { transactionId: txId }));
        return out;
    };
    /** The step as the apps take it: as themselves through the marketplace; as a keeper through the enterprise's door. */
    const tryStep = (step: Step, who: Id, txId: string, as: string): Promise<Res> => {
        const all = doors(step, who, txId, as);
        return (as === who.pk ? all[0] : all[all.length - 1])();
    };
    /**
     * For each reader in turn on a fresh deal from `make`: the rule's answer for `step`, then the node's. A "no" tries every
     * key the reader could name and must leave the deal as it was; a "yes" is named as the rule says and must go through.
     */
    async function matrix(label: string, step: Step, make: () => Promise<string>, expectYes: Id[], closer: Id): Promise<void> {
        let txId = await make();
        const before = statusOf(txId);
        for (const who of readers) {
            const moves = dealMoves(rowOf(txId), who.pk, keeperOf.get(who.pk));
            const shown = !!moves?.[step];
            assert(shown === expectYes.includes(who), `${label}: ${who.name} ${shown ? 'sees' : 'does not see'} ${step} (rule)`);
            if (shown) {
                const r = await tryStep(step, who, txId, moves!.actingAs);
                assert(r.status === 200 && statusOf(txId) !== before, `${label}: ${who.name}'s ${step} as ${moves!.actingAs === who.pk ? 'themselves' : 'the enterprise'} goes through (${show(r)})`);
                txId = await make();
            } else {
                const tries: Res[] = [];
                for (const as of keysFor(who)) for (const door of doors(step, who, txId, as)) tries.push(await door());
                assert(tries.every(r => r.status !== 200) && statusOf(txId) === before,
                    `${label}: the node refuses ${who.name} at every door under every key, and the deal stays ${before} (${tries.map(r => r.status).join('/')})`);
            }
        }
        // The last fresh deal closed, so the next matrix's member may open one (one open deal per member per listing): a
        // hold cancelled by the member on its other side, a request denied by a keeper at the enterprise's door.
        if (statusOf(txId) === 'pending') await call('POST', closer, '/api/marketplace/transactions/cancel', { transactionId: txId, cancellerPublicKey: closer.pk });
        else if (statusOf(txId) === 'requested') await call('POST', kai, `/api/treasury/${farm.pk}/reject`, { transactionId: txId });
        assert(!['pending', 'requested'].includes(statusOf(txId)), `${label}: the last deal closed (${statusOf(txId)})`);
    }

    // The farm's Need, a member helping: the farm pays, so its keepers release; either side cancels.
    const farmNeed = createPost('need', 'services', 'Mend the polytunnel', 'One sheet torn', 20, 'fixed', farm.pk, undefined, undefined, undefined, true)!;
    const needDeal = (helper: Id, approver: Id) => async (): Promise<string> => {
        const a = await call('POST', helper, '/api/marketplace/posts/request', { postId: farmNeed.id, buyerPublicKey: helper.pk });
        const id = a.body?.transaction?.id as string;
        const ok = await call('POST', approver, `/api/treasury/${farm.pk}/approve`, { transactionId: id });
        if (ok.status !== 200) throw new Error(`approve failed: ${show(a)} / ${show(ok)}`);
        return id;
    };
    await matrix("the farm's Need, Mo helping", 'release', needDeal(mo, kai), [kai, lee], mo);
    // No keeper cancels the farm's hold: the node has no door for it (routes/treasury.ts); Mo, the other side, does.
    await matrix("the farm's Need, Mo helping", 'cancelHold', needDeal(mo, kai), [mo], mo);
    // A keeper paid by the farm's Need: their own pay is another keeper's to release (two-person rule); they cancel as the payee.
    await matrix("the farm's Need, Kai helping", 'release', needDeal(kai, lee), [lee], kai);
    await matrix("the farm's Need, Kai helping", 'cancelHold', needDeal(kai, lee), [kai], kai);
    // Requests on the farm's Need: its keepers answer them at the enterprise's door.
    const ask = (helper: Id) => async (): Promise<string> => {
        const a = await call('POST', helper, '/api/marketplace/posts/request', { postId: farmNeed.id, buyerPublicKey: helper.pk });
        if (a.status !== 200) throw new Error(`request failed: ${show(a)}`);
        return a.body.transaction.id as string;
    };
    await matrix("a request on the farm's Need from Mo", 'answer', ask(mo), [kai, lee], mo);

    // The farm's recurring Offer, a member buying: the member releases; either side cancels.
    const eggs = createPost('offer', 'food', 'Dozen eggs', 'Laid this week', 6, 'fixed', farm.pk, undefined, undefined, undefined, true)!;
    const eggsDeal = async (): Promise<string> => {
        const a = await call('POST', mo, '/api/marketplace/posts/accept', { postId: eggs.id, buyerPublicKey: mo.pk });
        if (a.status !== 200) throw new Error(`accept failed: ${show(a)}`);
        return a.body.transaction.id as string;
    };
    await matrix("the farm's recurring Offer, Mo buying", 'release', eggsDeal, [mo], mo);
    await matrix("the farm's recurring Offer, Mo buying", 'cancelHold', eggsDeal, [mo], mo);

    (globalThis as any).fetch = realFetch;
    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

main().catch((e) => { console.error(e); process.exit(1); });
