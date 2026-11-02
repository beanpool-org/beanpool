/**
 * How long a new person takes to reach a first real trade (engine/time-to-first-trade.ts), over HTTPS through the real
 * middleware where a reader's role matters. Counts and medians only, of the whole community.
 *
 *   1. who counts: visitors, enterprises and the genesis operator don't; departed and closed accounts do
 *   2. what a first listing is: an Offer or Need of their own; not an event, a poll, a copy, or an assistant's; a keeper's
 *      enterprise listing is theirs; a cancelled one still counts
 *   3. what a first trade is: a finished deal; a cancelled, rejected, refunded or open one isn't; nor one with an enterprise
 *      they keep; a sale of a keeper's enterprise listing is
 *   4. the medians: real numbers from real dates; listed-then-traded only; under 5 people hidden
 *   5. small numbers: trade counts in steps of 5; two windows that differ by 1 to 4 people; a group under 5 says nothing
 *   6. Beans off: no trades to measure, never a false zero; a node with no trades reads plainly; each read goes by an index
 *   7. who reads it: owners and admins; a moderator, a member and a stranger are refused; the public answers don't carry it;
 *      nothing in any answer names a member
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-time-to-first-trade.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'FirstTrade123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { setSwitchOverride } from './config/node-profile.js';
import { grantNodeRole } from './engine/node-roles.js';
import { communityTotals } from './engine/community-health.js';
import { FIRST_TRADE_PEOPLE_SQL, firstTradeFunnel } from './engine/time-to-first-trade.js';
import { AGENT_TOOLS } from './agent/tools.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
let n = 0;
const key = () => crypto.randomBytes(32).toString('hex');

function addMember(joinedDaysAgo: number, opts: { status?: string; visitor?: boolean; treasury?: boolean; home?: string; inviteCode?: string; closed?: boolean; callsign?: string } = {}): string {
    const pk = key();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor, is_treasury, home_node_url, deleted_by_owner_at)
                VALUES (?, ?, ?, 'scene', ?, ?, ?, ?, ?, ?)`)
        .run(pk, opts.callsign ?? `Person${++n}`, ago(joinedDaysAgo), opts.inviteCode ?? 'code', opts.status ?? 'active', opts.visitor ? 1 : 0, opts.treasury ? 1 : 0, opts.home ?? null, opts.closed ? ago(0) : null);
    return pk;
}

function addPost(author: string, daysAgo: number, opts: { type?: string; originNode?: string; shownFrom?: string; createdVia?: string; createdBy?: string; status?: string } = {}): string {
    const id = `post-${++n}`;
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, status, active, origin_node, shown_from_host, created_via, created_by)
                VALUES (?, ?, 'general', ?, '', 5, ?, ?, ?, 1, ?, ?, ?, ?)`)
        .run(id, opts.type ?? 'offer', id, author, ago(daysAgo), opts.status ?? 'active', opts.originNode ?? null, opts.shownFrom ?? null, opts.createdVia ?? null, opts.createdBy ?? null);
    return id;
}

function addDeal(postId: string, buyer: string, seller: string, daysAgo: number, status = 'completed', dispute: string | null = null): void {
    // Every ending writes completed_at, a cancelled deal's and a rejected one's too (engine/escrow.ts).
    const ended = status === 'requested' || status === 'pending' ? null : ago(daysAgo);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at, dispute_resolution)
                VALUES (?, ?, ?, ?, 5, ?, ?, ?, ?)`).run(`deal-${++n}`, postId, buyer, seller, status, ago(daysAgo + 1), ended, dispute);
}

/** Empty the tables each scene reads: every member it made goes, and the readers (genesis rows, so never in the numbers) stay. */
function clearScene(): void {
    db.prepare('DELETE FROM marketplace_transactions').run();
    db.prepare('DELETE FROM posts').run();
    db.prepare('DELETE FROM treasury_operators').run();
    db.prepare(`DELETE FROM members WHERE invited_by = 'scene'`).run();
}

/** The other side of a deal: nobody's new member, so a scene counts only the people it means to. */
function oldTrader(): string { return addMember(4000, { inviteCode: 'genesis' }); }

const all = () => firstTradeFunnel(NOW).allTime;

async function main(): Promise<void> {
    console.log('Time to a first trade\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const base = `https://localhost:${await startHttpsServer(0)}`;

    const founder = crypto.generateKeyPairSync('ed25519');
    const founderPk = founder.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    seedGenesisMember(founderPk, 'Founder');

    const signed = (priv: crypto.KeyObject, pk: string, path: string) => {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        return {
            'X-Public-Key': pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
            'X-Signature': crypto.sign(null, Buffer.from(`GET\n${path}\n${ts}\n${nonce}\n`), priv).toString('base64'),
        };
    };
    const reset = () => { resetGatewayRateLimit(); resetAdminRateLimit(); resetAdminAuthTarpit(); pruneAuthAttempts(Date.now() + 120_000); };
    const get = async (path: string, headers: Record<string, string> = {}) => {
        reset();
        const res = await fetch(`${base}${path}`, { headers });
        const text = await res.text();
        let body: any; try { body = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, body, text };
    };
    const person = (name: string) => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, 'x', 'genesis')`).run(pk, name, ago(1000));
        return { pk, priv: privateKey };
    };
    const ada = person('Ada');
    grantNodeRole(ada.pk, 'admin', founderPk);
    const moe = person('Moe');
    grantNodeRole(moe.pk, 'moderator', founderPk);
    const sam = person('Sam');

    // ── 1. who counts ─────────────────────────────────────────────────────────────────────────────
    console.log('── 1. who counts ──');
    clearScene();
    addMember(10);
    addMember(10, { visitor: true });
    addMember(10, { treasury: true });
    addMember(10, { home: 'https://peer.example' });
    addMember(10, { inviteCode: 'genesis' });
    assert(all().joined === 1, `a visitor, an enterprise, a member of another community and a genesis row aren't new members (${all().joined})`);
    const removed = addMember(10, { status: 'pruned' });
    const suspended = addMember(10, { status: 'disabled' });
    const closed = addMember(10, { status: 'pruned', closed: true, callsign: 'Deleted Member' });
    assert(all().joined === 4, `a removed member, a suspended one and a closed account stay counted: they joined (${all().joined})`);
    addPost(removed, 9);
    addPost(closed, 9, { status: 'cancelled' });
    assert(all().firstListing === 2, `and what they reached stays counted, a closed account's scrubbed post with it (${all().firstListing})`);
    void suspended;

    // ── 2. what a first listing is ────────────────────────────────────────────────────────────────
    console.log('── 2. what a first listing is ──');
    clearScene();
    const eventOnly = addMember(10); addPost(eventOnly, 9, { type: 'event' });
    const pollOnly = addMember(10); addPost(pollOnly, 9, { type: 'poll' });
    assert(all().firstListing === 0, `an event or a poll is no listing (${all().firstListing})`);
    const copyOnly = addMember(10); addPost(copyOnly, 9, { shownFrom: 'mullum.example' });
    const scrubbedCopy = addMember(10); addPost(scrubbedCopy, 9, { shownFrom: '' });
    assert(all().firstListing === 0, `a copy on the global community isn't a member's own listing, nor one its owner deleted (${all().firstListing})`);
    const fromPeer = addMember(10); addPost(fromPeer, 9, { originNode: 'peer-1' });
    assert(all().firstListing === 0, `a listing held from a peer isn't either (${all().firstListing})`);
    const assistantOnly = addMember(10); addPost(assistantOnly, 9, { createdVia: 'assistant:grant-1' });
    assert(all().firstListing === 0, `a listing an owner's assistant made doesn't count as a person's first listing (${all().firstListing})`);
    const offerer = addMember(10); addPost(offerer, 9);
    const needer = addMember(10); addPost(needer, 9, { type: 'need' });
    assert(all().firstListing === 2, `an Offer and a Need do (${all().firstListing})`);
    const withdrawn = addMember(10); addPost(withdrawn, 9, { status: 'cancelled' });
    assert(all().firstListing === 3, `a listing later cancelled still counts: they made it (${all().firstListing})`);
    const enterprise = addMember(10, { treasury: true });
    const keeper = addMember(10);
    addPost(enterprise, 9, { createdBy: keeper });
    assert(all().firstListing === 4, `an enterprise's listing is the first listing of the keeper who made it (${all().firstListing})`);
    const keeperByAssistant = addMember(10);
    addPost(enterprise, 9, { createdBy: keeperByAssistant, createdVia: 'assistant:grant-1' });
    assert(all().firstListing === 4, `one an assistant made for an enterprise isn't (${all().firstListing})`);
    const elsewhere = firstTradeFunnel(NOW);
    assert(elsewhere.allTime.joined === 11, `and the enterprise itself isn't a member in the numbers: eleven people here, no twelfth (${elsewhere.allTime.joined})`);

    // ── 3. what a first trade is ──────────────────────────────────────────────────────────────────
    console.log('── 3. what a first trade is ──');
    // Five people each end one way that isn't a trade, and five more each finish one, so a count can show. Anything that
    // miscounted a non-trade as a trade would lift the 5 to a 10.
    const notTrades: Array<[string, string, string | null]> = [
        ['a cancelled deal', 'cancelled', null], ['a rejected request', 'rejected', null], ['a request still open', 'requested', null],
        ['a deal still in escrow', 'pending', null], ['a dispute refunded to the buyer', 'cancelled', 'refund_to_buyer'],
    ];
    const nonTradeScene = () => {
        clearScene();
        const other = oldTrader();
        const list = addPost(other, 2000);
        for (let i = 0; i < 5; i++) addDeal(list, addMember(10), other, 1);
        return { other, list };
    };
    {
        const { other, list } = nonTradeScene();
        assert(all().firstTrade === 5, `the base scene: five who finished a deal read 5 (${all().firstTrade})`);
        for (const [, status, dispute] of notTrades) addDeal(list, addMember(10), other, 1, status, dispute);
        assert(all().firstTrade === 5, `${notTrades.map(t => t[0]).join(', ')}: none is a trade (${all().firstTrade} of ${all().joined})`);
        for (let i = 0; i < 5; i++) addDeal(list, addMember(10), other, 1, 'cancelled');
        assert(all().firstTrade === 5, `not five more cancelled deals either: the status decides, though each carries a completed_at (${all().firstTrade})`);
        for (let i = 0; i < 5; i++) addDeal(list, addMember(10), other, 1, 'completed', 'split');
        assert(all().firstTrade === 10, `a dispute settled by a split finished as a trade, as Trades this month counts it (${all().firstTrade})`);
    }
    {
        clearScene();
        const other = oldTrader();
        const list = addPost(other, 2000);
        for (let i = 0; i < 5; i++) addDeal(list, other, addMember(10), 1);
        assert(all().firstTrade === 5, `the seller reaches a first trade as much as the buyer (${all().firstTrade})`);
        for (let i = 0; i < 5; i++) addDeal(list, other, addMember(10), 1, 'cancelled');
        assert(all().firstTrade === 5, `and a cancelled deal is no trade for the seller either (${all().firstTrade} of ${all().joined})`);
        const lastDeals = 'SELECT id FROM marketplace_transactions ORDER BY rowid DESC LIMIT 5';
        for (let i = 0; i < 5; i++) addDeal(list, other, addMember(10), 1);
        db.prepare(`UPDATE marketplace_transactions SET completed_at = NULL WHERE id IN (${lastDeals})`).run();
        assert(all().firstTrade === 10, `a finished deal from before completed_at was kept reads by when it began, and still counts (${all().firstTrade})`);
    }
    {
        clearScene();
        const other = oldTrader();
        for (let i = 0; i < 5; i++) {
            const t = addMember(10, { treasury: true });
            const k = addMember(10);
            db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role) VALUES (?, ?, 'keeper')").run(t, k);
            addDeal(addPost(t, 5, { createdBy: k }), other, t, 1, 'cancelled');
        }
        addDeal(addPost(other, 2000), other, oldTrader(), 2000);
        assert(all().firstTrade === null, `a cancelled deal on an enterprise's listing is no trade for the keeper who made it (${all().firstTrade} of ${all().joined})`);
    }
    {
        clearScene();
        const other = oldTrader();
        for (let i = 0; i < 5; i++) {
            const t = addMember(10, { treasury: true });
            const k = addMember(10);
            db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role) VALUES (?, ?, 'keeper')").run(t, k);
            const made = addPost(t, 5, { createdBy: k });
            addDeal(made, other, t, 1);
        }
        assert(all().firstTrade === 5, `a sale of an enterprise's listing is a first trade for the keeper who made it (${all().firstTrade} of ${all().joined})`);
    }
    {
        clearScene();
        const other = oldTrader();
        for (let i = 0; i < 5; i++) addDeal(addPost(other, 2000), addMember(10), other, 1);
        for (let i = 0; i < 5; i++) {
            const t = addMember(10, { treasury: true });
            const k = addMember(10);
            db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role) VALUES (?, ?, 'keeper')").run(t, k);
            const made = addPost(t, 5, { createdBy: k });
            addDeal(made, k, t, 1);
        }
        assert(all().firstTrade === 5, `a keeper buying from the enterprise they keep isn't a trade with anyone (${all().firstTrade} of ${all().joined})`);
        for (let i = 0; i < 5; i++) {
            const t = addMember(10, { treasury: true });
            const k = addMember(10);
            db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role) VALUES (?, ?, 'keeper')").run(t, k);
            addDeal(addPost(t, 5, { type: 'need', createdBy: k }), t, k, 1);
        }
        assert(all().firstTrade === 5, `nor is a keeper paid by the enterprise they keep (${all().firstTrade} of ${all().joined})`);
    }
    {
        clearScene();
        const other = oldTrader();
        const members = Array.from({ length: 5 }, () => addMember(10));
        for (const m of members) addDeal(addPost(m, 5, { createdVia: 'assistant:grant-1' }), other, m, 1);
        const f = all();
        assert(f.firstTrade === 5 && f.firstListing === 0, `a trade on a listing an assistant made is still a trade: two people did it (${JSON.stringify(f)})`);
    }

    // ── 4. the medians ────────────────────────────────────────────────────────────────────────────
    console.log('── 4. the medians ──');
    clearScene();
    {
        const other = oldTrader();
        // Join to listing: 1, 2, 3, 4, 50 days; listing to trade: 2, 4, 6, 8, 100 days. The medians are 3 and 6; a mean is 12 or 24.
        for (const [toList, toTrade] of [[1, 2], [2, 4], [3, 6], [4, 8], [50, 100]]) {
            const m = addMember(300);
            const listedAt = 300 - toList;
            addDeal(addPost(m, listedAt), other, m, listedAt - toTrade);
        }
        const f = all();
        assert(f.daysToFirstListing === 3, `the median days from joining to a first listing, not the mean: 3 of 1, 2, 3, 4, 50 (${f.daysToFirstListing})`);
        assert(f.daysFromListingToTrade === 6, `the median days from a first listing to a first trade: 6 of 2, 4, 6, 8, 100 (${f.daysFromListingToTrade})`);
        const later = addMember(300);
        addPost(later, 299); addPost(later, 290); addPost(later, 200);
        assert(all().daysToFirstListing === 3, `a member's first listing is their earliest, and six people give the middle two's mean (${all().daysToFirstListing})`);
        // Five who listed and bought only before it: no wait for a buyer to measure.
        const before6 = all().daysFromListingToTrade;
        for (let i = 0; i < 5; i++) {
            const m = addMember(300);
            addPost(m, 100);
            addDeal(addPost(other, 2000), m, other, 200);
        }
        assert(all().daysFromListingToTrade === before6, `who traded before they listed isn't in the listing-to-trade median (${all().daysFromListingToTrade} from ${before6})`);
    }
    {
        // Read as local time, in Sydney this date lands 11 hours early, and 2.25 days rounds up to 3.
        const zone = process.env.TZ;
        process.env.TZ = 'Australia/Sydney';
        clearScene();
        for (let i = 0; i < 5; i++) {
            const m = addMember(100);
            db.prepare("UPDATE members SET joined_at = '2026-01-10 08:00:00' WHERE public_key = ?").run(m);
            db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, status) VALUES (?, 'offer', 'general', 't', '', 5, ?, '2026-01-12T14:00:00.000Z', 'active')`).run(`old-${++n}`, m);
        }
        assert(all().daysToFirstListing === 2, `an older row's "YYYY-MM-DD HH:MM:SS" date reads as UTC, whatever the server's time zone (${all().daysToFirstListing})`);
        if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
    {
        clearScene();
        for (let i = 0; i < 5; i++) addPost(addMember(10), 11);
        assert(all().daysToFirstListing === 0, `a listing dated before the join (a restored row) reads 0, never a negative wait (${all().daysToFirstListing})`);
    }

    // ── 5. small numbers ──────────────────────────────────────────────────────────────────────────
    console.log('── 5. small numbers ──');
    clearScene();
    {
        const other = oldTrader();
        const lone = addMember(10);
        addDeal(addPost(lone, 7), other, lone, 3);
        let f = firstTradeFunnel(NOW);
        assert(f.allTime.joined === 1 && f.allTime.firstListing === 1, `one new member: the counts anyone can see are shown (${JSON.stringify(f.allTime)})`);
        assert(f.allTime.daysToFirstListing === null && f.allTime.daysFromListingToTrade === null && f.allTime.firstTrade === null,
            `but "1 member, 3 days" is a person: no median, no trade count (${JSON.stringify(f.allTime)})`);
        for (let i = 0; i < 3; i++) { const m = addMember(10); addDeal(addPost(m, 7), other, m, 3); }
        f = firstTradeFunnel(NOW);
        assert(f.allTime.joined === 4 && f.allTime.daysToFirstListing === null && f.allTime.daysFromListingToTrade === null && f.allTime.firstTrade === null,
            `four people: still too few (${JSON.stringify(f.allTime)})`);
        const fifth = addMember(10);
        addDeal(addPost(fifth, 7), other, fifth, 3);
        f = firstTradeFunnel(NOW);
        assert(f.allTime.joined === 5 && f.allTime.daysToFirstListing === 3 && f.allTime.daysFromListingToTrade === 4 && f.allTime.firstTrade === 5,
            `five people: the medians and the count show (${JSON.stringify(f.allTime)})`);
        // Under 5 in the group, whatever the size of the community.
        for (let i = 0; i < 20; i++) addMember(10);
        f = firstTradeFunnel(NOW);
        assert(f.allTime.daysToFirstListing === 3, `a median reads its own group, not the whole cohort: five who listed of 25 who joined (${f.allTime.daysToFirstListing})`);
    }
    {
        clearScene();
        const other = oldTrader();
        for (let i = 0; i < 4; i++) addPost(addMember(10), 8);
        for (let i = 0; i < 30; i++) addMember(10);
        assert(all().daysToFirstListing === null, `four who listed of 34 who joined: a big community doesn't lift the rule (${all().daysToFirstListing})`);
        const list = addPost(other, 2000);
        const traders = db.prepare("SELECT public_key FROM members WHERE invite_code = 'code' AND joined_at > ? LIMIT 9").pluck().all(ago(20)) as string[];
        for (let i = 0; i < 4; i++) addDeal(list, traders[i], other, 1);
        assert(all().firstTrade === null, `four first trades among 34 read as too few, not as 4 (${all().firstTrade})`);
        const zeroToFour = firstTradeFunnel(NOW);
        db.prepare('DELETE FROM marketplace_transactions WHERE buyer_pubkey != ?').run('x'.repeat(64));
        addDeal(addPost(other, 2000), other, oldTrader(), 2000);
        assert(firstTradeFunnel(NOW).allTime.firstTrade === zeroToFour.allTime.firstTrade, `none reads the same as four: the first new member's trade moves nothing (${firstTradeFunnel(NOW).allTime.firstTrade})`);
        for (let i = 0; i < 7; i++) addDeal(list, traders[i], other, 1);
        const seven = all().firstTrade;
        addDeal(list, traders[7], other, 1);
        assert(seven === 5 && all().firstTrade === 5, `seven and eight both read 5: a count moved by one person doesn't move (${seven}, ${all().firstTrade})`);
        addDeal(list, traders[8], other, 1);
        addDeal(list, addMember(10), other, 1);
        assert(all().firstTrade === 10, `ten reads 10 (${all().firstTrade})`);
    }
    {
        // Two windows that differ by one person: Ana joined 100 days ago, the rest within 90. Whether all time is one higher
        // than the last 90 days would say whether Ana has traded.
        clearScene();
        const other = oldTrader();
        const list = addPost(other, 2000);
        const ana = addMember(100);
        for (let i = 0; i < 10; i++) addDeal(list, addMember(10), other, 1);
        let f = firstTradeFunnel(NOW);
        assert(f.allTime.joined === 11 && f.last90Days.joined === 10, `11 joined, 10 of them in the 90 days (${f.allTime.joined}, ${f.last90Days.joined})`);
        assert(f.last90Days.firstTrade === null && f.allTime.firstTrade === 10,
            `1 to 4 people between the two windows: the 90 days hide their trades, all time stands alone (${f.last90Days.firstTrade}, ${f.allTime.firstTrade})`);
        const without = JSON.stringify([f.last90Days, f.allTime]);
        addDeal(list, ana, other, 1);
        f = firstTradeFunnel(NOW);
        assert(JSON.stringify([f.last90Days, f.allTime]) === without, `and Ana's first trade changes neither window: the two side by side don't say it (${JSON.stringify(f.last90Days)})`);
    }
    {
        // The same with medians, by the listing group.
        clearScene();
        for (let i = 0; i < 6; i++) addPost(addMember(10), 8);
        addPost(addMember(100), 90);
        const f = firstTradeFunnel(NOW);
        assert(f.last90Days.daysToFirstListing === null && f.allTime.daysToFirstListing !== null,
            `a median whose windows differ by 1 to 4 people shows for all time only (${f.last90Days.daysToFirstListing}, ${f.allTime.daysToFirstListing})`);
    }
    {
        // Five or more between them: both show. And no gap: the same people, the same reading.
        clearScene();
        const other = oldTrader();
        const list = addPost(other, 2000);
        for (let i = 0; i < 6; i++) { const m = addMember(10); addPost(m, 8); addDeal(list, m, other, 1); }
        let f = firstTradeFunnel(NOW);
        assert(f.last90Days.firstTrade === 5 && f.allTime.firstTrade === 5 && f.last90Days.daysToFirstListing === 2 && f.allTime.daysToFirstListing === 2,
            `nobody between the two windows: they are the same people, and both show (${JSON.stringify(f.last90Days)})`);
        for (let i = 0; i < 6; i++) { const m = addMember(100); addPost(m, 90); addDeal(list, m, other, 1); }
        f = firstTradeFunnel(NOW);
        assert(f.last90Days.firstTrade === 5 && f.allTime.firstTrade === 10 && f.last90Days.daysToFirstListing === 2 && f.allTime.daysToFirstListing === 6,
            `six between them: both show, each its own reading (${JSON.stringify([f.last90Days, f.allTime])})`);
    }
    {
        clearScene();
        // The window's edge: a UTC midnight, so the answer doesn't creep within a day.
        const midnight = Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()) - 90 * DAY;
        const inside = addMember(0); db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(new Date(midnight).toISOString(), inside);
        const outside = addMember(0); db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(new Date(midnight - 1).toISOString(), outside);
        assert(firstTradeFunnel(new Date(midnight + 90 * DAY + 3_600_000)).last90Days.joined === 1 && firstTradeFunnel(new Date(midnight + 91 * DAY - 1)).last90Days.joined === 1,
            `the 90 days start at a UTC midnight: from one hour into the day to its last moment they hold the same people`);
    }

    // ── 6. Beans off, and no trades ───────────────────────────────────────────────────────────────
    console.log('── 6. Beans off, and no trades ──');
    clearScene();
    for (let i = 0; i < 6; i++) addPost(addMember(10), 8);
    {
        const f = firstTradeFunnel(NOW);
        assert(f.beans === true && f.anyTrades === false && f.allTime.firstTrade === 0 && f.allTime.daysFromListingToTrade === null,
            `a node with no trades reads a plain 0, and has no wait to measure (${JSON.stringify(f)})`);
    }
    {
        setSwitchOverride('beans', false);
        const off = firstTradeFunnel(NOW);
        assert(off.beans === false && off.anyTrades === false, `Beans off: nothing to measure (${JSON.stringify(off)})`);
        assert(off.allTime.firstTrade === null && off.last90Days.firstTrade === null && off.allTime.daysFromListingToTrade === null && off.last90Days.daysFromListingToTrade === null,
            `and never a false zero: no trade figure at all (${JSON.stringify(off.allTime)})`);
        assert(off.allTime.joined === 6 && off.allTime.firstListing === 6, `while who joined and who listed still read (${off.allTime.joined}, ${off.allTime.firstListing})`);
        setSwitchOverride('beans', true);
        const other = oldTrader();
        addDeal(addPost(other, 2000), other, oldTrader(), 2000);
        const f = firstTradeFunnel(NOW);
        assert(f.anyTrades === true && f.allTime.firstTrade === null, `one trade anywhere: none of these people's own number is a plain 0 any more (${JSON.stringify(f.allTime)})`);
    }

    // ── 6b. cheap on a large node ─────────────────────────────────────────────────────────────────
    console.log('── 6b. cheap on a large node ──');
    {
        // Nearly every post has no created_by. ANALYZE reads all those NULLs as one value held by every row, and a planner
        // left to itself then walks every post once per member: 30,000 members never finished.
        clearScene();
        for (let i = 0; i < 300; i++) addPost(addMember(10), 8);
        db.exec('ANALYZE');
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${FIRST_TRADE_PEOPLE_SQL}`).all() as Array<{ detail: string }>).map(r => r.detail);
        const walks = plan.filter(d => /\b(SCAN|SEARCH) (p|t|o)\b/.test(d) && !/USING (COVERING )?INDEX/.test(d));
        const byKeeper = plan.filter(d => /idx_posts_created_by/.test(d)).length;
        assert(byKeeper === 2 && walks.length === 0, `every read of posts and deals goes by an index, ANALYZE or none: both keeper lookups name theirs (${byKeeper}; ${walks.join(' | ') || plan.length + ' steps'})`);
    }

    // ── 7. who reads it ───────────────────────────────────────────────────────────────────────────
    console.log('── 7. who reads it ──');
    clearScene();
    {
        const other = oldTrader();
        const list = addPost(other, 2000);
        const named: string[] = [];
        for (let i = 0; i < 12; i++) { const m = addMember(10, { callsign: `Findable${i}` }); named.push(m); addPost(m, 8); addDeal(list, m, other, 1); }
        const health = '/api/local/admin/community-health';
        const owner = await get(health, ownerSessionHeaders());
        assert(owner.status === 200 && owner.body?.totals?.newMembers?.allTime?.firstTrade === 10, `an owner reads it on the panel (${owner.text.slice(0, 160)})`);
        const asAdmin = await get('/api/names/health', signed(ada.priv, ada.pk, '/api/names/health'));
        assert(asAdmin.status === 200 && asAdmin.body?.totals?.newMembers?.allTime?.joined === 12, `an admin reads it, signed by their own key (${asAdmin.text.slice(0, 160)})`);
        const mod = await get('/api/names/health', signed(moe.priv, moe.pk, '/api/names/health'));
        assert(mod.status === 403 && !mod.text.includes('newMembers'), `a moderator is refused, as the panel's rule says (${mod.status} ${mod.text.slice(0, 120)})`);
        const member = await get('/api/names/health', signed(sam.priv, sam.pk, '/api/names/health'));
        assert(member.status === 403 && !member.text.includes('newMembers'), `a member is refused (${member.status})`);
        const nobody = await get('/api/names/health');
        assert(nobody.status === 401, `an unsigned request is refused (${nobody.status})`);
        const noPassword = await get(health);
        assert(noPassword.status === 401 || noPassword.status === 403, `and the panel's own route needs an admin (${noPassword.status})`);
        for (const path of ['/api/community/info', '/api/community/health', '/api/home', '/api/community/known-rule', '/api/community/directory']) {
            const r = await get(path);
            assert(!r.text.includes('newMembers') && !r.text.includes('firstTrade'), `${path} doesn't carry it (${r.status})`);
        }
        const tool = AGENT_TOOLS.find(t => t.name === 'community_totals')!;
        const answer = await tool.run({ role: 'admin' } as never, {}, 'x') as unknown as { ok: boolean; result: { newMembers: { allTime: { firstTrade: number } } } };
        assert(answer.ok && answer.result.newMembers.allTime.firstTrade === 10, `the assistant's community_totals carries it (${JSON.stringify(answer.result.newMembers.allTime)})`);
        assert(/first trade/.test(tool.reads) && /too few/.test(tool.reads), `and its description says what it reads and what a null means`);
        assert(/names or keys/.test(tool.never), `and what it never does`);
        const everything = [owner.text, asAdmin.text, JSON.stringify(answer.result), JSON.stringify(communityTotals(NOW))];
        const leaks: string[] = [];
        for (const text of everything) {
            const funnel = JSON.stringify(JSON.parse(text).newMembers ?? JSON.parse(text).totals?.newMembers);
            if (/[0-9a-f]{32,}/i.test(funnel)) leaks.push('a key');
            if (/Findable/.test(funnel)) leaks.push('a name');
            if (/\d{4}-\d{2}-\d{2}/.test(funnel)) leaks.push('a date');
            if (named.some(k => text.includes(k))) leaks.push('a member key in the whole answer');
        }
        assert(leaks.length === 0, `no name, key or date in any answer (${leaks.join(', ') || 'none'})`);
        const fields = Object.keys(firstTradeFunnel(NOW).allTime).sort().join();
        assert(fields === 'daysFromListingToTrade,daysToFirstListing,firstListing,firstTrade,joined', `a window is five numbers and nothing else (${fields})`);
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

main().catch(e => { console.error(e); process.exit(1); });
