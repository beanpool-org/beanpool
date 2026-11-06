/**
 * Needs this month: how many were asked and how many were answered within a week (engine/needs-this-month.ts; cold start N4),
 * over HTTPS through the real middleware where a reader's role matters. Counts only, of the whole community.
 *
 *   1. what is posted: a public Need of a member's own hand; not an Offer, event or poll, a copy, a peer's, a group's or one
 *      person's, or an assistant's; a cancelled one still counts
 *   2. the month: a Need at the first instant of the month counts, the instant before doesn't (both stored forms of a time)
 *   3. what answers: the first request from someone other than the asker or a keeper of the enterprise that asked, however it
 *      ended; the first of several decides
 *   4. the week: seven days to the millisecond counts, one millisecond more doesn't
 *   5. small numbers: answers in steps of 5, rounded down; 1 to 4 is held back and never 0; nothing asked reads a plain 0
 *   6. deals off: a Need can't be answered, so no figure, never a false 0
 *   7. who reads it: owners and admins; a moderator, a member and a stranger are refused; the public answers don't carry it;
 *      nothing in any answer names a member or a Need
 *   8. cheap: the reads go by an index
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-needs-this-month.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'NeedsMonth123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders, ownerTokenHeaders } from './admin-auth-test-harness.js';
import { consumeHandshakeToken, mintHandshakeToken } from './admin-key-auth.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { setSwitchOverride } from './config/node-profile.js';
import { grantNodeRole } from './engine/node-roles.js';
import { communityTotals } from './engine/community-health.js';
import { NEEDS_POSTED_SQL, NEEDS_REQUESTS_SQL, needsThisMonth } from './engine/needs-this-month.js';
import { AGENT_TOOLS } from './agent/tools.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const DAY = 86_400_000;
/** A fixed "now" in the middle of a month, so the boundaries below are exact whatever day the suite runs. */
const MID = new Date('2026-11-15T12:00:00.000Z');
const MONTH_START = Date.UTC(2026, 10, 1);
const iso = (ms: number) => new Date(ms).toISOString();
let n = 0;
const key = () => crypto.randomBytes(32).toString('hex');

interface PostOpts { type?: string; originNode?: string; shownFrom?: string; createdVia?: string; status?: string; audience?: string }

/** A Need (or other post) asked at `at`, by `author`: a stored time as given, so a SQLite-form one can be tried too. */
function addPost(author: string, at: string, opts: PostOpts = {}): string {
    const id = `post-${++n}`;
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, status, active, origin_node, shown_from_host, created_via, audience_scope)
                VALUES (?, ?, 'general', ?, '', 5, ?, ?, ?, 1, ?, ?, ?, ?)`)
        .run(id, opts.type ?? 'need', id, author, at, opts.status ?? 'active', opts.originNode ?? null, opts.shownFrom ?? null, opts.createdVia ?? null, opts.audience ?? 'public');
    return id;
}

/** A neighbour's request on a Need: on a Need the asker is the buyer and the helper the seller. */
function addRequest(postId: string, asker: string, helper: string, at: string, status = 'requested'): void {
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at) VALUES (?, ?, ?, ?, 5, ?, ?)`)
        .run(`deal-${++n}`, postId, asker, helper, status, at);
}

function clearScene(): void {
    db.prepare('DELETE FROM marketplace_transactions').run();
    db.prepare('DELETE FROM posts').run();
    db.prepare('DELETE FROM treasury_operators').run();
    db.prepare(`DELETE FROM members WHERE invited_by = 'scene'`).run();
}

function addMember(opts: { treasury?: boolean } = {}): string {
    const pk = key();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor, is_treasury)
                VALUES (?, ?, ?, 'scene', 'code', 'active', 0, ?)`).run(pk, `Person${++n}`, iso(MID.getTime() - 400 * DAY), opts.treasury ? 1 : 0);
    return pk;
}

/** `asked` Needs posted at `postedAt`, the first `answered` of them requested `afterMs` later. */
function month(asked: number, answered: number, postedAt = iso(MID.getTime() - 3 * DAY), afterMs = DAY): void {
    for (let i = 0; i < asked; i++) {
        const asker = key();
        const id = addPost(asker, postedAt);
        if (i < answered) addRequest(id, asker, key(), iso(Date.parse(postedAt) + afterMs));
    }
}

const read = () => needsThisMonth(MID);

async function main(): Promise<void> {
    console.log('Needs this month\n');
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
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, 'x', 'genesis')`).run(pk, name, iso(Date.now() - 1000 * DAY));
        return { pk, priv: privateKey };
    };
    const ada = person('Ada');
    grantNodeRole(ada.pk, 'admin', founderPk);
    const moe = person('Moe');
    grantNodeRole(moe.pk, 'moderator', founderPk);
    const sam = person('Sam');

    // ── 1. what is posted ─────────────────────────────────────────────────────────────────────────
    console.log('── 1. what is posted ──');
    clearScene();
    const at = iso(MID.getTime() - 2 * DAY);
    addPost(key(), at);
    assert(read().posted === 1, `a public Need a member asked counts (${read().posted})`);
    addPost(key(), at, { type: 'offer' });
    addPost(key(), at, { type: 'event' });
    addPost(key(), at, { type: 'poll' });
    assert(read().posted === 1, `an Offer, an event and a poll are no Need (${read().posted})`);
    addPost(key(), at, { shownFrom: 'mullum.example' });
    addPost(key(), at, { shownFrom: '' });
    assert(read().posted === 1, `a copy on the global community isn't a member's own Need, nor one its owner deleted (${read().posted})`);
    addPost(key(), at, { originNode: 'peer-1' });
    assert(read().posted === 1, `a Need held from a peer isn't either (${read().posted})`);
    addPost(key(), at, { audience: 'group' });
    addPost(key(), at, { audience: 'direct' });
    assert(read().posted === 1, `a Need shown only to a group or to one person isn't on the Market for everyone (${read().posted})`);
    addPost(key(), at, { createdVia: 'agent' });
    assert(read().posted === 1, `a Need an owner's assistant made is seeding, not a neighbour asking (${read().posted})`);
    addPost(key(), at, { status: 'cancelled' });
    addPost(key(), at, { status: 'completed' });
    assert(read().posted === 3, `a Need later cancelled or finished still counts: someone asked (${read().posted})`);

    // ── 2. the month ──────────────────────────────────────────────────────────────────────────────
    console.log('── 2. the month ──');
    clearScene();
    addPost(key(), iso(MONTH_START));
    assert(read().posted === 1, `a Need at the first instant of the month counts`);
    addPost(key(), iso(MONTH_START - 1));
    assert(read().posted === 1, `one a millisecond before it doesn't, even if its answer comes this month`);
    addPost(key(), '2026-11-01 00:00:00');
    assert(read().posted === 2, `a time stored the SQLite way counts at the same instant (${read().posted})`);
    addPost(key(), '2026-10-31 23:59:59');
    assert(read().posted === 2, `and doesn't the second before (${read().posted})`);
    addPost(key(), '2026-11-01T09:00:00+10:00');
    assert(read().posted === 2, `a time written with an offset is read as the instant it is: 9 am on the 1st at +10:00 is still October in UTC (${read().posted})`);
    addPost(key(), '2026-11-01T11:00:00+10:00');
    assert(read().posted === 3, `and one written 2 hours later, at 1 am UTC on the 1st, is this month's (${read().posted})`);
    {
        const old = key();
        const lastMonth = addPost(old, iso(MONTH_START - 2 * DAY));
        addRequest(lastMonth, old, key(), iso(MONTH_START + DAY));
        assert(read().posted === 3 && needsThisMonth(new Date(MID.getTime() + 30 * DAY)).posted === 0, `a month is read on its own: the next month starts from nothing (${needsThisMonth(new Date(MID.getTime() + 30 * DAY)).posted})`);
    }

    // ── 3. what answers ───────────────────────────────────────────────────────────────────────────
    console.log('── 3. what answers ──');
    clearScene();
    month(6, 6);
    assert(read().posted === 6 && read().answeredWithinWeek === 5, `six Needs, six answered: at least 5, in a step (${JSON.stringify(read())})`);
    {
        // Count the answered ones alone, in a scene of ten, so a step shows each decision.
        clearScene();
        month(5, 0);
        assert(read().answeredWithinWeek === null, `five Needs with no request: held back, not 0 (${read().answeredWithinWeek})`);
        clearScene();
        month(4, 4);
        const asker = key();
        addRequest(addPost(asker, at), asker, asker, at);
        assert(read().posted === 5 && read().answeredWithinWeek === null, `a request from the asker themself isn't a neighbour answering (${JSON.stringify(read())})`);
    }
    {
        // The asker's own enterprise: a keeper requesting it isn't a neighbour either.
        clearScene();
        month(4, 4);
        const enterprise = addMember({ treasury: true });
        const keeper = addMember();
        db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role) VALUES (?, ?, 'keeper')").run(enterprise, keeper);
        const theirs = addPost(enterprise, at);
        addRequest(theirs, enterprise, keeper, at);
        assert(read().posted === 5 && read().answeredWithinWeek === null, `a keeper's own request on their enterprise's Need isn't an answer (${JSON.stringify(read())})`);
        addRequest(theirs, enterprise, key(), at);
        assert(read().answeredWithinWeek === 5, `another member's is (${read().answeredWithinWeek})`);
    }
    {
        clearScene();
        for (const status of ['requested', 'pending', 'completed', 'rejected', 'cancelled']) {
            const asker = key();
            addRequest(addPost(asker, at), asker, key(), at, status);
        }
        assert(read().posted === 5 && read().answeredWithinWeek === 5, `however a request ended (open, agreed, done, turned down, withdrawn) a neighbour answered (${JSON.stringify(read())})`);
    }
    {
        clearScene();
        month(4, 4);
        const asker = key();
        const id = addPost(asker, at);
        // The first of several decides: a late one after an early one is no later answer, and an early one after a late one is.
        addRequest(id, asker, key(), iso(Date.parse(at) + 20 * DAY));
        assert(read().answeredWithinWeek === null, `a request after the week isn't within it (${JSON.stringify(read())})`);
        addRequest(id, asker, key(), iso(Date.parse(at) + 2 * DAY));
        assert(read().answeredWithinWeek === 5, `and the Need counts once an earlier one is in, however many came (${JSON.stringify(read())})`);
        addRequest(id, asker, key(), iso(Date.parse(at) + 3 * DAY));
        assert(read().answeredWithinWeek === 5, `two requests on one Need are one answered Need (${JSON.stringify(read())})`);
    }

    // ── 4. the week ───────────────────────────────────────────────────────────────────────────────
    console.log('── 4. the week ──');
    {
        clearScene();
        const posted = iso(MID.getTime() - 9 * DAY);
        month(5, 5, posted, 7 * DAY);
        assert(read().answeredWithinWeek === 5, `an answer exactly seven days after the Need went up is within the week (${JSON.stringify(read())})`);
        clearScene();
        month(5, 5, posted, 7 * DAY + 1);
        assert(read().posted === 5 && read().answeredWithinWeek === null, `a millisecond more isn't (${JSON.stringify(read())})`);
        clearScene();
        month(5, 5, posted, 0);
        assert(read().answeredWithinWeek === 5, `an answer in the same instant is (${JSON.stringify(read())})`);
    }
    {
        // A Need in its first week with no request yet is posted, not answered.
        clearScene();
        month(5, 0, iso(MID.getTime() - 1 * DAY));
        assert(read().posted === 5 && read().answeredWithinWeek === null, `a Need still in its first week with no request is posted only (${JSON.stringify(read())})`);
    }

    // ── 5. small numbers ──────────────────────────────────────────────────────────────────────────
    console.log('── 5. small numbers ──');
    for (const [asked, answered, want] of [[0, 0, 0], [1, 1, null], [4, 4, null], [5, 4, null], [5, 5, 5], [9, 9, 5], [12, 9, 5], [12, 10, 10], [14, 14, 10], [20, 0, null]] as Array<[number, number, number | null]>) {
        clearScene();
        month(asked, answered);
        const r = read();
        assert(r.posted === asked && r.answeredWithinWeek === want, `${asked} asked, ${answered} answered reads ${want === null ? 'held back' : want} (${JSON.stringify(r)})`);
    }

    // ── 6. deals off ──────────────────────────────────────────────────────────────────────────────
    console.log('── 6. deals off ──');
    // A node whose ledger has moved can't run with Beans off (config/node-profile.ts lockToLedger), so the scene has no deal yet.
    clearScene();
    month(7, 0);
    setSwitchOverride('beans', false);
    {
        const off = read();
        assert(off.deals === false && off.posted === 7 && off.answeredWithinWeek === null, `Beans off: Needs asked still read, answers have no figure, never a false 0 (${JSON.stringify(off)})`);
        setSwitchOverride('beans', true);
        const on = read();
        assert(on.deals === true && on.posted === 7 && on.answeredWithinWeek === null, `on again, nothing answered is held back as it always is (${JSON.stringify(on)})`);
        for (const id of (db.prepare("SELECT id, author_pubkey AS a FROM posts WHERE type = 'need' LIMIT 5").all() as Array<{ id: string; a: string }>)) addRequest(id.id, id.a, key(), iso(MID.getTime() - 2 * DAY));
        assert(read().answeredWithinWeek === 5, `and reads the answers once there are some (${JSON.stringify(read())})`);
    }

    // ── 7. who reads it ───────────────────────────────────────────────────────────────────────────
    console.log('── 7. who reads it ──');
    clearScene();
    const now = Date.now();
    const askers: string[] = [];
    for (let i = 0; i < 7; i++) {
        const asker = key(); askers.push(asker);
        const id = addPost(asker, iso(now), { });
        if (i < 6) addRequest(id, asker, key(), iso(now));
    }
    {
        const health = '/api/local/admin/community-health';
        const owner = await get(health, ownerSessionHeaders());
        const ownerNeeds = owner.body?.totals?.needs;
        assert(owner.status === 200 && ownerNeeds?.posted === 7 && ownerNeeds?.answeredWithinWeek === 5, `an owner reads it on the panel (${owner.text.slice(0, 200)})`);
        const asAdmin = await get('/api/names/health', signed(ada.priv, ada.pk, '/api/names/health'));
        assert(asAdmin.status === 200 && asAdmin.body?.totals?.needs?.posted === 7, `an admin reads it, signed by their own key (${asAdmin.text.slice(0, 160)})`);
        const mod = await get('/api/names/health', signed(moe.priv, moe.pk, '/api/names/health'));
        assert(mod.status === 403 && !mod.text.includes('answeredWithinWeek'), `a moderator is refused, as the panel's rule says (${mod.status} ${mod.text.slice(0, 120)})`);
        const member = await get('/api/names/health', signed(sam.priv, sam.pk, '/api/names/health'));
        assert(member.status === 403 && !member.text.includes('answeredWithinWeek') && !member.text.includes('"needs"'), `a member is refused (${member.status})`);
        const nobody = await get('/api/names/health');
        assert(nobody.status === 401, `an unsigned request is refused (${nobody.status})`);
        const noPassword = await get(health);
        assert(noPassword.status === 401 || noPassword.status === 403, `and the panel's own route needs an admin (${noPassword.status})`);
        const session = (pk: string, role: 'admin' | 'moderator') => {
            const opened = consumeHandshakeToken(mintHandshakeToken(pk, role).handshakeToken);
            if (!opened.ok || !opened.sessionId) throw new Error(`could not open a test key session: ${opened.error}`);
            return { 'X-Admin-Session': opened.sessionId };
        };
        const adminSession = await get(health, session(ada.pk, 'admin'));
        assert(adminSession.status === 200 && adminSession.body?.totals?.needs?.posted === 7, `an admin's session reads it on the panel's route (${adminSession.status})`);
        const modSession = await get(health, session(moe.pk, 'moderator'));
        assert(modSession.status === 403 && !modSession.text.includes('answeredWithinWeek'), `a moderator's session is refused on the panel's route too (${modSession.status} ${modSession.text.slice(0, 120)})`);
        const readToken = await get(health, ownerTokenHeaders('read', founderPk));
        assert(readToken.status === 200 && readToken.body?.totals?.needs?.posted === 7, `an owner's read token reads it as an admin does, as the panel's rule is today (${readToken.status})`);
        for (const scope of ['backups', 'agent'] as const) {
            const refused = await get(health, ownerTokenHeaders(scope, founderPk));
            assert(refused.status === 403 && !refused.text.includes('answeredWithinWeek'), `a token of the ${scope} scope is refused: this panel is not its scope (${refused.status})`);
        }
        for (const path of ['/api/community/info', '/api/community/health', '/api/home', '/api/community/known-rule', '/api/community/directory']) {
            const r = await get(path);
            assert(!r.text.includes('answeredWithinWeek') && !r.text.includes('needsThisMonth'), `${path} doesn't carry it (${r.status})`);
        }
        const tool = AGENT_TOOLS.find(t => t.name === 'community_totals')!;
        const answer = await tool.run({ role: 'admin' } as never, {}, 'x') as unknown as { ok: boolean; result: { needs: { posted: number; answeredWithinWeek: number | null } } };
        assert(answer.ok && answer.result.needs.posted === 7 && answer.result.needs.answeredWithinWeek === 5, `the assistant's community_totals carries it (${JSON.stringify(answer.result.needs)})`);
        assert(/needs is this month/.test(tool.reads) && /Need still in its first week/.test(tool.reads), `and its description says what it counts and what a Need in its first week is`);
        assert(/null means held back/.test(tool.reads) && /never read it as 0 or as a small number/.test(tool.reads), `and a null can't be told to an owner as a small number`);
        assert(/names or keys/.test(tool.never), `and what it never does`);
        const everything = [owner.text, asAdmin.text, JSON.stringify(answer.result), JSON.stringify(communityTotals())];
        const leaks: string[] = [];
        for (const text of everything) {
            const needs = JSON.stringify(JSON.parse(text).needs ?? JSON.parse(text).totals?.needs);
            if (/[0-9a-f]{32,}/i.test(needs)) leaks.push('a key');
            if (/\d{4}-\d{2}-\d{2}/.test(needs)) leaks.push('a date');
            if (/post-\d+/.test(needs)) leaks.push('a Need');
            if (askers.some(k => text.includes(k))) leaks.push('an asker key in the whole answer');
        }
        assert(leaks.length === 0, `no key, date or Need in any answer (${leaks.join(', ') || 'none'})`);
        const fields = Object.keys(needsThisMonth()).sort().join();
        assert(fields === 'answeredWithinWeek,deals,minGroup,posted', `a reading is four fields and nothing else (${fields})`);
    }

    // ── 8. cheap ──────────────────────────────────────────────────────────────────────────────────
    console.log('── 8. cheap ──');
    {
        clearScene();
        const askers: string[] = [];
        for (let i = 0; i < 400; i++) { const a = key(); askers.push(a); addRequest(addPost(a, iso(MID.getTime() - DAY)), a, key(), iso(MID.getTime() - DAY / 2)); }
        db.exec('ANALYZE');
        const lookup = (db.prepare(`EXPLAIN QUERY PLAN ${NEEDS_REQUESTS_SQL}`).all('x', 'y', 'y') as Array<{ detail: string }>).map(r => r.detail);
        const walks = lookup.filter(d => /\bSCAN t\b/.test(d));
        assert(walks.length === 0 && lookup.some(d => /idx_marketplace_transactions_post_status/.test(d)), `a Need's requests are found by the post and status index, never by walking the deals (${lookup.join(' | ')})`);
        const started = process.hrtime.bigint();
        const r = needsThisMonth(MID);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        console.log(`   (400 Needs and 400 requests: ${ms.toFixed(1)} ms; posts read: ${(db.prepare(`EXPLAIN QUERY PLAN ${NEEDS_POSTED_SQL}`).all('2026-11-01') as Array<{ detail: string }>).map(p => p.detail).join(' | ')})`);
        assert(r.posted === 400 && r.answeredWithinWeek === 400, `400 Needs, 400 answered (${JSON.stringify(r)})`);
        assert(ms < 1000, `and it reads in well under a second (${ms.toFixed(1)} ms)`);
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

main().catch(e => { console.error(e); process.exit(1); });
