/**
 * Findings parked from the deciding reviews of Slice 6 (#837, #838, #844, #845) and #840/#841 — over a REAL
 * HTTPS round trip where a route is involved, so the signature middleware is part of what is tested.
 *
 *  1. keeperOf leaves out enterprises of a keeper whose account a Decision suspended.
 *  2. Commons and crowdfund project creation refuse a member whose account is not active.
 *  3. Escrow's enterprise keeper check has no raw treasury_operators fallback.
 *  4. A suspended or switched-off keeper is refused by every Operator Controls route.
 *  5. Read routes and the pricing report take the actor from authentication only; the spoof check's
 *     "names someone else" exemptions match whole field names.
 *  6. Editing a message whose conversation row is missing fails closed.
 *  7. Messaging routes answer server faults with 5xx and keep 4xx for refusals.
 *  8. Redeeming an offline ticket does not stamp the inviter active; the lead succession lookup uses an index.
 *  9. Enterprise thread rows carry a created_at that the delta backup exporter ships.
 * 10. ensureFederationLink never switches a switched-off keeper's operator access back on.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-slice6-review-findings.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, createTreasury, adminAssignTreasuryOperator, adminSetOperator, setUserStatusRow,
    keeperOf, getBalance, createProject, createConversation, sendMessage, addFriend, createPost, requestPost,
    approvePostRequest, transfer, ensureEnterpriseThread, exportSyncState, reconcileLedgerFromDb,
    canOperateTreasury,
} from './state-engine.js';
import {
    approvePostRequest as approvePostRequestEngine,
    completePostTransaction as completePostTransactionEngine,
    type EscrowCallbacks,
} from './engine/escrow.js';
import { startHttpsServer } from './https-server.js';
import { db, createCrowdfundProject, initSchema } from './db/db.js';
import { getPricingGuideItems, savePricingGuideItem } from './db/pricing-guide-db.js';
import { ensureFederationLink } from './federation-link.js';
import { ledger } from './engine/ledger.js';

const PORT = 8663;
const BASE = `https://localhost:${PORT}`;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

interface Identity { pub: string; priv: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

function seedMember(callsign: string, balance = 0, extra: { status?: string } = {}): Identity {
    const id = keypair();
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, avatar_url, invited_by, invite_code)
                VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'seed', 'seed')`)
        .run(id.pub, `${callsign}-${id.pub.slice(0, 6)}`, extra.status || 'active', AVATAR);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)`)
        .run(id.pub, balance, ledger.getCurrentEpoch());
    return id;
}

async function send(method: string, path: string, body: unknown, signer?: Identity, extraHeaders: Record<string, string> = {}):
    Promise<{ status: number; json: any }> {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const signPath = path.split('?')[0];
        const canonical = `${method}\n${signPath}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), signer.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
}

const count = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params) as any)?.c ?? 0);

async function main() {
    console.log('Running Slice 6 / #840 / #841 review-finding tests (real HTTPS)...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // ── 1. keeperOf and a Decision-suspended keeper ────────────────────────────────────────────
    console.log('\n── 1. keeperOf ──');
    {
        const kept = seedMember('keptlead');
        const other = seedMember('otherkeeper');
        const ent = createTreasury(`Keeper Shed ${kept.pub.slice(0, 4)}`, AVATAR, 0, { leadKeeperPubkey: kept.pub }).publicKey;
        adminAssignTreasuryOperator(ent, other.pub, 'admin');
        assert(keeperOf(kept.pub).includes(ent), 'an active keeper lists the enterprise in keeperOf');

        setUserStatusRow(kept.pub, 'disabled'); // the suspend_member Decision's exact write
        assert(!keeperOf(kept.pub).includes(ent), 'a Decision-suspended keeper no longer lists the enterprise in keeperOf');
        assert(!getBalance(kept.pub).keeperOf.includes(ent), 'getBalance().keeperOf leaves it out too');
        const bal = await send('GET', `/api/ledger/balance/${kept.pub}`, undefined, other); // member-only read
        assert(bal.status === 200 && Array.isArray(bal.json?.keeperOf) && !bal.json.keeperOf.includes(ent),
            `GET /api/ledger/balance keeperOf leaves it out (got ${bal.status} ${JSON.stringify(bal.json?.keeperOf)})`);
        assert(keeperOf(other.pub).includes(ent), 'the unsuspended keeper still lists the enterprise');

        setUserStatusRow(kept.pub, 'active');
        assert(keeperOf(kept.pub).includes(ent), 'unsuspending restores the listing');
    }

    // ── 2. Project creation needs an active account ────────────────────────────────────────────
    console.log('\n── 2. project creation and member status ──');
    {
        const suspended = seedMember('suspendedproposer', 0, { status: 'disabled' });
        const active = seedMember('activeproposer');
        const before = { members: count('SELECT COUNT(*) c FROM members'), projects: count('SELECT COUNT(*) c FROM projects'), ops: count('SELECT COUNT(*) c FROM treasury_operators WHERE member_pubkey = ?', suspended.pub) };

        const commons = await send('POST', '/api/commons/projects', { title: 'Suspended commons', description: 'x', requestedAmount: 10 }, suspended);
        assert(commons.status === 403, `POST /api/commons/projects refuses a suspended member with 403 (got ${commons.status} ${commons.json?.error})`);
        const crowd = await send('POST', '/api/crowdfund/projects', { title: 'Suspended crowdfund', description: 'x', goalAmount: 50, photos: [] }, suspended);
        assert(crowd.status === 403, `POST /api/crowdfund/projects refuses a suspended member with 403 (got ${crowd.status} ${crowd.json?.error})`);
        assert(count('SELECT COUNT(*) c FROM members') === before.members, 'no enterprise row was created');
        assert(count('SELECT COUNT(*) c FROM projects') === before.projects, 'no projects row was created');
        assert(count('SELECT COUNT(*) c FROM treasury_operators WHERE member_pubkey = ?', suspended.pub) === before.ops, 'no keeper binding was created');

        let threw = '';
        try { createProject(suspended.pub, 'Engine suspended', 'x', 10); } catch (e: any) { threw = e.message; }
        assert(/active community members/.test(threw), `createProject throws for a suspended member (got "${threw}")`);
        threw = '';
        try { createCrowdfundProject(crypto.randomUUID(), suspended.pub, 'Engine suspended crowdfund', 'x', [], 10, null); } catch (e: any) { threw = e.message; }
        assert(/active community members/.test(threw), `createCrowdfundProject throws for a suspended member (got "${threw}")`);

        const ok1 = await send('POST', '/api/commons/projects', { title: `Active commons ${active.pub.slice(0, 4)}`, description: 'x', requestedAmount: 10 }, active);
        assert(ok1.status === 200 && ok1.json?.success, `an active member still proposes a commons project (got ${ok1.status} ${ok1.json?.error})`);
        const ok2 = await send('POST', '/api/crowdfund/projects', { title: `Active crowdfund ${active.pub.slice(0, 4)}`, description: 'x', goalAmount: 50, photos: [] }, active);
        assert(ok2.status === 200 && ok2.json?.success, `an active member still creates a crowdfund project (got ${ok2.status} ${ok2.json?.error})`);
    }

    // ── 3. Escrow keeper check has no fallback ─────────────────────────────────────────────────
    console.log('\n── 3. escrow keeper check ──');
    {
        const seller = seedMember('needseller', 500);
        const keeperA = seedMember('bakeryA', 500);
        const keeperB = seedMember('bakeryB', 500);
        reconcileLedgerFromDb();
        const bakery = createTreasury(`Escrow Bakery ${seller.pub.slice(0, 4)}`, AVATAR, 200).publicKey;
        adminAssignTreasuryOperator(bakery, keeperA.pub, 'admin');
        adminAssignTreasuryOperator(bakery, keeperB.pub, 'admin');
        transfer('genesis', bakery, 100, 'seed bakery', 'direct', true);
        createPost('offer', 'food', 'Bakery bread', 'bread', 5, 'fixed', bakery);
        const need = createPost('need', 'work', 'Bake sourdough', 'loaves', 30, 'fixed', bakery)!;
        const tx = requestPost(need.id, seller.pub)!;

        const REACHED = 'REACHED_PAST_KEEPER_CHECK';
        const stop = () => { throw new Error(REACHED); };
        const cb = {
            broadcast: () => {}, transfer: stop, ensureTransactionConversation: stop, injectSystemMessage: stop,
            dispatchPushNotification: () => {}, getBalance, floorLockedError: () => new Error('floor'), SystemMessageType: {},
            conservingTransaction: stop,
        } as any;
        setUserStatusRow(keeperB.pub, 'disabled');
        const outcome = (fn: () => unknown) => { try { fn(); return 'returned'; } catch (e: any) { return e.message as string; } };

        const noCallback = outcome(() => approvePostRequestEngine(cb as EscrowCallbacks, tx.id, bakery, { authSigner: keeperB.pub }));
        assert(/not an authorized keeper/.test(noCallback), `approve without the keeper callback refuses a suspended keeper (got "${noCallback}")`);
        const noCallbackActive = outcome(() => approvePostRequestEngine(cb as EscrowCallbacks, tx.id, bakery, { authSigner: keeperA.pub }));
        assert(/not an authorized keeper/.test(noCallbackActive), `approve without the keeper callback fails closed even for an active keeper (got "${noCallbackActive}")`);
        const withCallback = outcome(() => approvePostRequestEngine({ ...cb, canOperateTreasury } as EscrowCallbacks, tx.id, bakery, { authSigner: keeperB.pub }));
        assert(/not an authorized keeper/.test(withCallback), `approve with canOperateTreasury refuses the suspended keeper (got "${withCallback}")`);
        const activeWithCallback = outcome(() => approvePostRequestEngine({ ...cb, canOperateTreasury } as EscrowCallbacks, tx.id, bakery, { authSigner: keeperA.pub }));
        assert(activeWithCallback === REACHED, `an active keeper passes the check (got "${activeWithCallback}")`);
        assert((db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(tx.id) as any)?.status === 'requested', 'the transaction is still requested');

        setUserStatusRow(keeperB.pub, 'active');
        const approved = approvePostRequest(tx.id, bakery, { authSigner: keeperB.pub });
        assert(approved?.status === 'pending', 'fixture: the deal is approved by an active second keeper');
        setUserStatusRow(keeperB.pub, 'disabled');
        const completeNoCallback = outcome(() => completePostTransactionEngine(cb as EscrowCallbacks, tx.id, bakery, undefined, { authSigner: keeperB.pub }));
        assert(/not an authorized keeper/.test(completeNoCallback), `complete without the keeper callback refuses a suspended keeper (got "${completeNoCallback}")`);
        assert((db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(tx.id) as any)?.status === 'pending', 'the transaction is still pending, nothing paid');
        setUserStatusRow(keeperB.pub, 'active');
    }

    // ── 4. Operator Controls refuse a suspended keeper ─────────────────────────────────────────
    console.log('\n── 4. operator controls ──');
    {
        const lead = seedMember('oplead', 100);
        const decisionSuspended = seedMember('opsuspended', 100);
        const switchedOff = seedMember('opswitchedoff', 100);
        reconcileLedgerFromDb();
        const ent = createTreasury(`Operator Yard ${lead.pub.slice(0, 4)}`, AVATAR, 0, { leadKeeperPubkey: lead.pub }).publicKey;
        adminAssignTreasuryOperator(ent, decisionSuspended.pub, 'admin');
        adminAssignTreasuryOperator(ent, switchedOff.pub, 'admin');
        transfer('genesis', ent, 50, 'seed yard', 'direct', true);
        ensureEnterpriseThread(ent);
        const threadMsg = crypto.randomUUID();
        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp)
                    VALUES (?, ?, ?, 'aGk=', 'bm9uY2U=', 'text', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(threadMsg, ent, lead.pub);
        setUserStatusRow(decisionSuspended.pub, 'disabled');
        adminSetOperator(switchedOff.pub, false);

        const snapshot = () => JSON.stringify({
            ent: db.prepare('SELECT status, paused, lat, lng, working_capital_ceiling FROM members WHERE public_key = ?').get(ent),
            posts: count('SELECT COUNT(*) c FROM posts WHERE author_pubkey = ?', ent),
            ops: db.prepare('SELECT member_pubkey, role, backing FROM treasury_operators WHERE treasury_pubkey = ? ORDER BY member_pubkey').all(ent),
            pledges: count('SELECT COUNT(*) c FROM enterprise_pledges WHERE enterprise = ?', ent),
            proposals: count('SELECT COUNT(*) c FROM enterprise_succession_proposals WHERE enterprise_pubkey = ?', ent),
            msg: db.prepare('SELECT type, ciphertext FROM messages WHERE id = ?').get(threadMsg),
            balance: (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(ent) as any)?.balance,
        });
        const routes: Array<[string, string, any]> = [
            ['POST', `/api/treasury/${ent}/offer`, { title: 'x', category: 'food', credits: 1 }],
            ['POST', `/api/treasury/${ent}/need`, { title: 'x', category: 'food', credits: 1 }],
            ['POST', `/api/treasury/${ent}/approve`, { transactionId: 'nope' }],
            ['POST', `/api/treasury/${ent}/complete`, { transactionId: 'nope' }],
            ['POST', `/api/treasury/${ent}/reject`, { transactionId: 'nope' }],
            ['POST', `/api/treasury/${ent}/sweep`, {}],
            ['POST', `/api/enterprise/${ent}/pause`, {}],
            ['POST', `/api/enterprise/${ent}/resume`, {}],
            ['POST', `/api/enterprise/${ent}/wind-up/initiate`, {}],
            ['POST', `/api/enterprise/${ent}/wind-up/cancel`, {}],
            ['POST', `/api/enterprise/${ent}/wind-up/finalise`, {}],
            ['POST', `/api/enterprise/${ent}/location`, { lat: -28.5, lng: 153.5 }],
            ['DELETE', `/api/enterprise/${ent}/location`, {}],
            ['POST', `/api/enterprise/${ent}/backing`, { amount: 5 }],
            ['POST', `/api/enterprise/${ent}/keepers/requests/nope/approve`, {}],
            ['POST', `/api/enterprise/${ent}/keepers/requests/nope/decline`, {}],
            ['POST', `/api/enterprise/${ent}/succession/propose`, { candidatePubkey: lead.pub }],
            ['POST', `/api/enterprise/${ent}/succession/nope/vote`, {}],
            ['POST', `/api/enterprise/${ent}/thread/remove`, { messageId: threadMsg }],
        ];
        const before = snapshot();
        for (const [who, signer] of [['Decision-suspended', decisionSuspended], ['switched-off', switchedOff]] as const) {
            for (const [method, path, body] of routes) {
                const res = await send(method, path, body, signer);
                const refused = who === 'Decision-suspended' ? res.status === 403 : res.status >= 400 && res.status < 500;
                assert(refused, `${who} keeper refused: ${method} ${path.replace(ent, ':ent')} (got ${res.status} ${res.json?.error ?? ''})`);
            }
        }
        assert(snapshot() === before, 'nothing about the enterprise changed');
    }

    // ── 5. Actor from authentication only ──────────────────────────────────────────────────────
    console.log('\n── 5. actor from authentication ──');
    {
        const subject = seedMember('contactsubject');
        const friend = seedMember('contactfriend');
        const stranger = seedMember('stranger');
        db.prepare(`UPDATE members SET contact_value = 'secret@example.org', contact_visibility = 'friends' WHERE public_key = ?`).run(subject.pub);
        addFriend(subject.pub, friend.pub);

        const spoofed = await send('GET', `/api/profile/${subject.pub}?requester=${friend.pub}`, undefined);
        // Read auth is on by default, so the unsigned read is refused before the handler; the signed-stranger
        // case below is what proves the handler itself ignores ?requester=.
        assert(spoofed.status === 401 && !spoofed.json?.contact, `unsigned ?requester=<friend> is refused and reveals no contact (got ${spoofed.status} ${JSON.stringify(spoofed.json?.contact)})`);
        const spoofedSigned = await send('GET', `/api/profile/${subject.pub}?requester=${friend.pub}`, undefined, stranger);
        assert(spoofedSigned.status === 200 && !spoofedSigned.json?.contact, 'a signed stranger naming a friend in ?requester= sees no contact');
        const realFriend = await send('GET', `/api/profile/${subject.pub}`, undefined, friend);
        assert(realFriend.status === 200 && !!realFriend.json?.contact, 'the friend, signed, still sees the contact');

        const decisionId = crypto.randomUUID();
        db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, status, opens_at, closes_at, created_at, updated_at)
                    VALUES (?, ?, 'A poll', 'A poll for the test', 'nothing', 'poll', '1m1v', 'open',
                            strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days'),
                            strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(decisionId, subject.pub);
        const dSpoof = await send('GET', `/api/commons/decisions/${decisionId}?voterPubkey=${subject.pub}`, undefined);
        assert(dSpoof.status === 200 && dSpoof.json?.voiceCredits === undefined, `unsigned ?voterPubkey= gets no voice credits (got ${JSON.stringify(dSpoof.json?.voiceCredits)})`);
        const dSigned = await send('GET', `/api/commons/decisions/${decisionId}`, undefined, subject);
        assert(dSigned.status === 200 && dSigned.json?.voiceCredits !== undefined, 'the signed voter still gets their voice credits');

        const nodeWide = (await send('GET', '/api/community/info', undefined)).json?.transactionCount;
        const qSpoof = await send('GET', `/api/community/info?publicKey=${subject.pub}`, undefined);
        const hSpoof = await send('GET', '/api/community/info', undefined, undefined, { 'X-Public-Key': subject.pub });
        assert(qSpoof.json?.transactionCount === nodeWide && nodeWide > 0, `unsigned ?publicKey= gets node-wide figures (got ${qSpoof.json?.transactionCount} vs ${nodeWide})`);
        assert(hSpoof.json?.transactionCount === nodeWide, `an unverified X-Public-Key header gets node-wide figures (got ${hSpoof.json?.transactionCount} vs ${nodeWide})`);
        const signedInfo = await send('GET', '/api/community/info', undefined, subject);
        assert(signedInfo.json?.transactionCount === 0, `the signed member gets their own count (got ${signedInfo.json?.transactionCount})`);

        let item = getPricingGuideItems()[0];
        if (!item) item = savePricingGuideItem({ category: 'food' as any, emoji: '🥚', name: 'Eggs', description: 'dozen', priceBeans: 6 });
        const reporterOf = (id?: string) => (db.prepare('SELECT reporter_pubkey FROM pricing_reports WHERE id = ?').get(id) as any)?.reporter_pubkey ?? null;
        const anon = await send('POST', '/api/pricing-guide/report', { itemId: item.id, reportType: 'too_high', reporterPubkey: subject.pub });
        assert(anon.status === 200 && reporterOf(anon.json?.reportId) === null, `an unsigned report naming a member is stored anonymously (got ${anon.status} reporter=${reporterOf(anon.json?.reportId)})`);
        const mismatch = await send('POST', '/api/pricing-guide/report', { itemId: item.id, reportType: 'too_high', reporterPubkey: subject.pub }, stranger);
        assert(mismatch.status === 403, `a signed report naming someone else is refused (got ${mismatch.status})`);
        const signedReport = await send('POST', '/api/pricing-guide/report', { itemId: item.id, reportType: 'too_low', reporterPubkey: stranger.pub }, stranger);
        assert(signedReport.status === 200 && reporterOf(signedReport.json?.reportId) === stranger.pub, `a signed report is attributed to the signer (got ${signedReport.status} reporter=${reporterOf(signedReport.json?.reportId)})`);
        const badSig = await send('POST', '/api/pricing-guide/report', { itemId: item.id, reportType: 'other' }, undefined,
            { 'X-Public-Key': subject.pub, 'X-Signature': 'AAAA', 'X-Timestamp': String(Date.now()), 'X-Nonce': crypto.randomUUID() });
        assert(badSig.status === 403, `a report with a forged signature is refused, not stored as that member (got ${badSig.status})`);

        const conv = createConversation('dm', [subject.pub, friend.pub], subject.pub)!;
        const tokenSpoof = await send('POST', '/api/messages/mark-read', { conversationId: conv.id, tokenPubkey: friend.pub }, subject);
        assert(tokenSpoof.status === 403 && /Signature validation failed/.test(tokenSpoof.json?.error || ''),
            `an identity-shaped field that merely starts with "to" must match the signer (got ${tokenSpoof.status} ${tokenSpoof.json?.error})`);
        const memberSince = await send('POST', '/api/messages/mark-read', { conversationId: conv.id, memberSincePubkey: friend.pub }, subject);
        assert(memberSince.status === 403, `…and one that merely starts with "member" (got ${memberSince.status})`);
        const legit = await send('POST', '/api/messages/mark-read', { conversationId: conv.id, targetPubkey: friend.pub, memberPubkey: friend.pub, to_pubkey: friend.pub, sellerPublicKey: friend.pub }, subject);
        assert(legit.status === 200, `fields that name someone else on purpose still pass (got ${legit.status} ${legit.json?.error})`);
    }

    // ── 6. Edit with a missing conversation fails closed ───────────────────────────────────────
    console.log('\n── 6. missing conversation ──');
    {
        const author = seedMember('orphanauthor');
        const orphanId = crypto.randomUUID();
        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp)
                    VALUES (?, ?, ?, 'b3JpZ2luYWw=', 'bm9uY2U=', 'text', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .run(orphanId, `ghost-${orphanId}`, author.pub);
        const res = await send('POST', '/api/messages/edit', { messageId: orphanId, ciphertext: 'ZWRpdGVk', nonce: 'bjI=' }, author);
        const row = db.prepare('SELECT ciphertext, edited_at FROM messages WHERE id = ?').get(orphanId) as any;
        assert(res.status === 404, `editing a message whose conversation is missing is refused (got ${res.status} ${res.json?.error})`);
        assert(row.ciphertext === 'b3JpZ2luYWw=' && !row.edited_at, 'the message is unchanged');
    }

    // ── 7. Messaging: server faults are 5xx, refusals stay 4xx ────────────────────────────────
    console.log('\n── 7. messaging error classes ──');
    {
        const a = seedMember('msgA');
        const b = seedMember('msgB');
        const disabled = seedMember('msgDisabled', 0, { status: 'disabled' });
        const conv = createConversation('dm', [a.pub, b.pub], a.pub)!;
        const existing = sendMessage(conv.id, a.pub, 'Zmlyc3Q=', 'bjE=')!;

        db.exec(`CREATE TEMP TRIGGER fault_msg_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'database is locked (injected)'); END;`);
        db.exec(`CREATE TEMP TRIGGER fault_msg_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'database is locked (injected)'); END;`);
        db.exec(`CREATE TEMP TRIGGER fault_conv_insert BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT, 'database is locked (injected)'); END;`);
        try {
            const s = await send('POST', '/api/messages/send', { conversationId: conv.id, authorPubkey: a.pub, ciphertext: 'c2Vjb25k', nonce: 'bjI=' }, a);
            assert(s.status === 500, `send: a database fault is 500 (got ${s.status})`);
            assert(!/locked|injected/i.test(s.json?.error || ''), `send: the driver text is not echoed (got "${s.json?.error}")`);
            const e = await send('POST', '/api/messages/edit', { messageId: existing.id, ciphertext: 'ZWRpdA==', nonce: 'bjM=' }, a);
            assert(e.status === 500, `edit: a database fault is 500 (got ${e.status})`);
            const r = await send('POST', '/api/messages/react', { messageId: existing.id, emoji: '👍' }, a);
            assert(r.status === 500, `react: a database fault is 500 (got ${r.status})`);
            const c = await send('POST', '/api/messages/conversation', { type: 'group', participants: [a.pub, b.pub], createdBy: a.pub, name: 'g' }, a);
            assert(c.status === 500, `conversation: a database fault is 500 (got ${c.status})`);
        } finally {
            db.exec('DROP TRIGGER IF EXISTS temp.fault_msg_insert; DROP TRIGGER IF EXISTS temp.fault_msg_update; DROP TRIGGER IF EXISTS temp.fault_conv_insert;');
        }

        const refusedSend = await send('POST', '/api/messages/send', { conversationId: conv.id, authorPubkey: disabled.pub, ciphertext: 'eA==', nonce: 'bjQ=' }, disabled);
        assert(refusedSend.status === 400 && refusedSend.json?.error === 'Account is disabled', `send: a disabled account is still 400 with its message (got ${refusedSend.status} ${refusedSend.json?.error})`);
        const refusedEdit = await send('POST', '/api/messages/edit', { messageId: existing.id, ciphertext: 'ZWRpdA==', nonce: 'bjU=' }, b);
        assert(refusedEdit.status === 400 && /Only the author/.test(refusedEdit.json?.error || ''), `edit: a non-author is still 400 (got ${refusedEdit.status})`);
        const dupId = crypto.randomUUID();
        await send('POST', '/api/messages/send', { conversationId: conv.id, authorPubkey: a.pub, ciphertext: 'ZHVw', nonce: 'bjY=', id: dupId }, a);
        const conflict = await send('POST', '/api/messages/send', { conversationId: conv.id, authorPubkey: b.pub, ciphertext: 'ZHVw', nonce: 'bjc=', id: dupId }, b);
        assert(conflict.status === 409, `send: an id conflict is still 409 (got ${conflict.status})`);
        const ok = await send('POST', '/api/messages/send', { conversationId: conv.id, authorPubkey: a.pub, ciphertext: 'b2s=', nonce: 'bjg=' }, a);
        assert(ok.status === 200, `send works once the fault clears (got ${ok.status})`);
    }

    // ── 8. Offline ticket redeem and the succession lookup ────────────────────────────────────
    console.log('\n── 8. offline ticket and succession index ──');
    {
        const lead = seedMember('quietlead');
        const k1 = seedMember('successorA');
        const k2 = seedMember('successorB');
        const ent = createTreasury(`Quiet Orchard ${lead.pub.slice(0, 4)}`, AVATAR, 0, { leadKeeperPubkey: lead.pub }).publicKey;
        adminAssignTreasuryOperator(ent, k1.pub, 'admin');
        adminAssignTreasuryOperator(ent, k2.pub, 'admin');
        const longAgo = new Date(Date.now() - 35 * 86400000).toISOString();
        db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(longAgo, lead.pub);

        // A keeper proposes ANOTHER keeper as lead over signed HTTP. candidatePubkey is not the signer, so
        // the spoof check must not treat it as an impersonation.
        const proposed = await send('POST', `/api/enterprise/${ent}/succession/propose`, { candidatePubkey: k2.pub }, k1);
        assert(proposed.status === 200 && proposed.json?.success, `a keeper proposes another keeper as lead over signed HTTP (got ${proposed.status} ${proposed.json?.error})`);
        const proposalRow = db.prepare("SELECT id, candidate_pubkey FROM enterprise_succession_proposals WHERE enterprise_pubkey = ? AND status = 'active'").get(ent) as any;
        assert(proposalRow?.candidate_pubkey === k2.pub, 'the proposal is recorded for the named candidate');
        const proposalId: string = proposalRow?.id;
        db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(longAgo, lead.pub);

        // A paper ticket the lead signed three weeks ago, redeemed today by someone else.
        const payload = JSON.stringify({ i: lead.pub, t: Date.now() - 21 * 86400000 });
        const sig = crypto.sign(null, Buffer.from(payload), lead.priv).toString('base64');
        const ticketB64 = Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64');
        const joiner = keypair();
        const res = await send('POST', '/api/invite/redeem-offline', { ticketB64, publicKey: joiner.pub, callsign: `joiner${joiner.pub.slice(0, 5)}` });
        assert(res.status === 200 && res.json?.success, `fixture: the ticket redeems (got ${res.status} ${res.json?.error})`);
        const leadRow = db.prepare('SELECT last_active_at FROM members WHERE public_key = ?').get(lead.pub) as any;
        assert(leadRow.last_active_at === longAgo, `redeeming does not stamp the inviter active (got ${leadRow.last_active_at})`);
        const prop = db.prepare('SELECT status FROM enterprise_succession_proposals WHERE id = ?').get(proposalId) as any;
        assert(prop.status === 'active', `the succession proposal is not cancelled (got ${prop.status})`);

        const plan = (db.prepare(
            "EXPLAIN QUERY PLAN SELECT id, enterprise_pubkey FROM enterprise_succession_proposals WHERE lead_pubkey = ? AND status = 'active'"
        ).all(lead.pub) as any[]).map(r => r.detail).join(' | ');
        assert(/USING INDEX idx_succession_lead_active/.test(plan) && !/^SCAN/.test(plan), `the lead succession lookup uses an index (plan: ${plan})`);
        const cancelPlan = (db.prepare(
            "EXPLAIN QUERY PLAN UPDATE enterprise_succession_proposals SET status = 'cancelled' WHERE lead_pubkey = ? AND status = 'active'"
        ).all(lead.pub) as any[]).map(r => r.detail).join(' | ');
        assert(/USING INDEX idx_succession_lead_active/.test(cancelPlan), `the cancel update uses it too (plan: ${cancelPlan})`);
    }

    // ── 9. Thread rows reach the delta backup ─────────────────────────────────────────────────
    console.log('\n── 9. thread created_at and the delta exporter ──');
    {
        const oldEnt = keypair().pub;
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, avatar_url, is_treasury)
                    VALUES (?, ?, 'active', '2025-01-01T00:00:00.000Z', ?, 1)`).run(oldEnt, `Old Mill ${oldEnt.slice(0, 4)}`, AVATAR);
        db.prepare('DELETE FROM conversations WHERE id = ?').run(oldEnt);
        const cursor = new Date(Date.now() - 1000).toISOString();
        ensureEnterpriseThread(oldEnt);
        const delta = await exportSyncState('test-node', cursor);
        assert(!!delta.conversations?.some((c: any) => c.id === oldEnt), 'a thread created lazily for an old enterprise ships in the next delta');

        const migratedEnt = keypair().pub;
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, avatar_url, is_treasury)
                    VALUES (?, ?, 'active', '2025-02-01T00:00:00.000Z', ?, 1)`).run(migratedEnt, `Old Kiln ${migratedEnt.slice(0, 4)}`, AVATAR);
        db.prepare('DELETE FROM conversations WHERE id = ?').run(migratedEnt);
        const cursor2 = new Date(Date.now() - 1000).toISOString();
        initSchema(); // the boot backfill
        const delta2 = await exportSyncState('test-node', cursor2);
        assert(!!delta2.conversations?.some((c: any) => c.id === migratedEnt), 'a thread created by the boot backfill ships in the next delta');
    }

    // ── 10. Federation link never re-enables a switched-off keeper ─────────────────────────────
    console.log('\n── 10. ensureFederationLink operator switch ──');
    {
        const createTreasuryFn = (n: string, a: string, c?: number, o?: any) => createTreasury(n, a, c, o);
        const keeper = seedMember('linkkeeper');
        const home = createTreasury(`Link Home ${keeper.pub.slice(0, 4)}`, AVATAR, 0, { leadKeeperPubkey: keeper.pub }).publicKey;
        adminSetOperator(keeper.pub, false);
        const canOp = (pk: string) => (db.prepare('SELECT can_operate FROM members WHERE public_key = ?').get(pk) as any)?.can_operate;

        const peerNew = `12D3KooWSwitchNew${crypto.randomBytes(6).toString('hex')}`;
        const link = ensureFederationLink(peerNew, 'SwitchPeer', createTreasuryFn, keeper.pub);
        assert(!!link, 'fixture: link created');
        assert(canOp(keeper.pub) === 0, `creating a link with a switched-off keeper leaves the switch off (got ${canOp(keeper.pub)})`);
        assert(!canOperateTreasury(keeper.pub, home), 'their existing enterprise stays off');

        const peerExisting = `12D3KooWSwitchOld${crypto.randomBytes(6).toString('hex')}`;
        ensureFederationLink(peerExisting, 'SwitchPeerOld', createTreasuryFn);
        ensureFederationLink(peerExisting, 'SwitchPeerOld', createTreasuryFn, keeper.pub);
        assert(canOp(keeper.pub) === 0, `binding a switched-off keeper to an existing link leaves the switch off (got ${canOp(keeper.pub)})`);

        const fresh = seedMember('linkfresh');
        const peerFresh = `12D3KooWSwitchFresh${crypto.randomBytes(6).toString('hex')}`;
        ensureFederationLink(peerFresh, 'FreshPeer', createTreasuryFn, fresh.pub);
        assert(canOp(fresh.pub) === 1, `a first-time keeper still gains the switch (got ${canOp(fresh.pub)})`);
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
}

main().then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
});
