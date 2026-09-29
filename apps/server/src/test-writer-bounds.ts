/**
 * W-main: what one key can write to a main server in a day (design scratch/global-node/DESIGN-replica-flood-bounds-opus.md
 * §6.2; every number in config/writer-limits.ts). Over REAL HTTPS through the real signature middleware and gateway,
 * except a Pulse link added by hand (step 10), whose route looks each link's title up over the network: that one goes
 * through its router with the fetch stubbed, as test-pulse-submit does, so nothing leaves the box.
 *
 *  1. The gateway: a member's signed purchase, commission, registration and area are charged to the member bucket (one
 *     past the minute is 429); the peer protocol's reads (/api/community/info, /health) are not.
 *  2. The day budget: 5,000 signed writes across mixed routes (POST, PATCH, DELETE) pass and the 5,001st is 429
 *     day_budget, with Retry-After and nothing written; the key still reads; another key is unaffected; the admin
 *     surface is not counted; the day rolls; a key quiet for a day is forgotten; past DAY_BUDGET_MAX_KEYS the smallest
 *     counts go and a key near its budget is kept.
 *  3. DM lines: 30 a minute (the 31st 429 chat_rate); a line of exactly 64 KB goes, one past it (or past it with its
 *     metadata) is 413 message_too_long and not stored, and so is an edit past it; a photo of 300 KB still goes.
 *  4. New people by DM: 20 keys with no row a day; the 21st is 429 new_people_per_day and gets no row; a member, and a
 *     visitor already met, are never counted; another member is unaffected.
 *  5. Enterprises: 3 a day (the 4th 429 enterprises_per_day); 20 running (the 21st 429 enterprises_live), and winding
 *     one up makes room.
 *  6. Posts: 100 a day (the 101st 429 posts_per_day), a keeper's posts for an enterprise counted with their own.
 *  7. Groups: 5 a day (the 6th 429 groups_per_day).
 *  8. Invites: 20 a day (the 21st 429 invites_per_day); 50 unused (the 51st 429 invites_unused), and a used one makes
 *     room; the codes an owner makes in Settings under the first member never count against that member's own; an
 *     offline ticket counts when someone joins with it, and past 20 that join is refused with nothing written.
 *  9. The unused-invite prune: an unused code (or ticket row) past 30 days goes, with no tombstone; a used one and a
 *     younger one stay; a standby prunes nothing.
 * 10. The Pulse: 50 links by hand a day (the 51st 429 pulse_per_day); a link already there, spelled with share tracking
 *     and a fragment, is the same link and never refused; 300 synced items a day over HTTPS, the rest left for later.
 * 11. Read marks (PR #1312 review): 4,999 read marks, then a DM line, is 200 (it used to be 429 day_budget); past the
 *     budget a read mark (mark-read, notices seen) still goes and a real write is 429 day_budget; no other spelling or
 *     method of the read-mark paths, and no real write dressed as one, rides the exemption; the minute bucket still
 *     counts read marks.
 * 12. The Pulse harvester (PR #1312 review): a feed its owner controls serving 20 new items at every visit stops at
 *     WRITER_LIMITS.pulseHarvestedItemsPerDay for that owner, all their channels together, with no error on the
 *     channel; items already listed still refresh; another owner is unaffected; a day later it resumes. The feed is a
 *     stub at resolveChannel's fetch seam (ssrfSafeFetch refuses localhost), so nothing leaves the box.
 *
 * Local only: the server it starts on localhost, nothing else.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-writer-bounds.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_ROLE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, setNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit, gatewayAdmitDayBudget, pruneGatewayBuckets, dayBudgetKeyCount, DAY_BUDGET_MAX_KEYS } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { updateGatewayConfig } from './config/local-config.js';
import { DEFAULT_GATEWAY_CONFIG } from './config/gateway.js';
import { WRITER_LIMITS } from './config/writer-limits.js';
import { pruneUnusedInvites } from './engine/writer-bounds.js';
import { grantNodeRole } from './engine/node-roles.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { addChannel } from './engine/creator-channels.js';
import { createPulseSubmitRoutes, type PulseSubmitRouteDeps } from './routes/pulse-submit.js';
import { PulseThumbnailService } from './engine/pulse-thumbnail.js';
import { lockedDm } from './dm-test-payload.js';
import { resolveChannel, prunePulseItems, type SsrfSafeResponse } from './engine/pulse-resolver.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

let BASE = '';

// ── members and signed requests ─────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
/** A member who joined a week ago, with a profile photo (posting needs one). */
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`).run(id.pk, name, ago(7 * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any; headers: Headers }
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function call(method: Method, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body ?? null).slice(0, 160)}`;
/** `n` requests, `width` at a time: the statuses, in no particular order. */
async function many(n: number, width: number, one: (i: number) => Promise<Res>): Promise<number[]> {
    const statuses: number[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
        while (next < n) { const i = next++; statuses.push((await one(i)).status); }
    }));
    return statuses;
}

/** A key session for an admin-surface request, as the app signs in: challenge → signature → handshake → session. */
function keySession(id: Id): string {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), id.priv).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: id.pk, signature });
    if (!solved.ok) throw new Error(`no session: ${solved.error}`);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(`no session: ${ex.error}`);
    return ex.sessionId!;
}

// ── what members do ─────────────────────────────────────────────────────────────────────────────────────────────
let n = 0;
const post = (id: Id) => call('POST', id, '/api/marketplace/posts', { type: 'offer', category: 'other', title: `${id.name} offer ${++n}`, description: 'An offer', credits: 0, authorPublicKey: id.pk });
const openDm = (from: Id, toPk: string) => call('POST', from, '/api/messages/conversation', { type: 'dm', participants: [from.pk, toPk], createdBy: from.pk });
const line = (from: Id, conversationId: string, payload: Record<string, unknown> = lockedDm()) =>
    call('POST', from, '/api/messages/send', { conversationId, authorPubkey: from.pk, ...payload });
const invite = (id: Id) => call('POST', id, '/api/invite/generate', { publicKey: id.pk });
const enterprise = (id: Id, name: string) => call('POST', id, '/api/enterprise', { name, purpose: `${name}, a test enterprise` });
const group = (id: Id, name: string) => call('POST', id, '/api/groups', { name });
/** A line's ciphertext of exactly `chars` base64 characters (a multiple of 4), in the encrypted form a DM takes. */
function lineOf(chars: number): { ciphertext: string; nonce: string } {
    const ciphertext = crypto.randomBytes((chars / 4) * 3).toString('base64');
    if (ciphertext.length !== chars) throw new Error(`fixture: ${ciphertext.length} characters, wanted ${chars}`);
    return { ciphertext, nonce: lockedDm().nonce };
}
/** A ticket as the phone makes one (apps/native app/(tabs)/people.tsx), as test-offline-ticket-check makes it. */
function phoneTicket(inviter: Id, t: number): string {
    const payload = JSON.stringify({ i: inviter.pk, t });
    const s = crypto.sign(null, Buffer.from(payload), inviter.priv).toString('base64');
    return Buffer.from(JSON.stringify({ p: Buffer.from(payload).toString('base64'), s })).toString('base64');
}

/** The rate limiter off (the minute bucket), the day budget still on: it is on whatever the operator's switch says. */
function minuteThrottle(enabled: boolean, maxRequestsPerMinute = 120): void {
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled, maxRequestsPerMinute } });
    resetGatewayRateLimit();
}

async function main(): Promise<void> {
    console.log('W-main: what one key can write to a main server in a day\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    owner = newId('Owner');
    seedGenesisMember(owner.pk, owner.name);

    // ── 1. The gateway charges member-signed routes under /api/federation/ and /api/community/ ──────────────
    console.log('\n--- 1. the gateway exempts only the peer protocol\'s reads ---');
    {
        const PER_MINUTE = 5;
        minuteThrottle(true, PER_MINUTE);
        const ann = member('Ann');
        const routes: [string, unknown][] = [
            ['/api/federation/purchase', { postId: 'none', amount: 1 }],
            ['/api/federation/commission', { postId: 'none' }],
            ['/api/community/register', { publicKey: ann.pk, callsign: 'Ann' }],
            ['/api/community/me/area', { lat: -28.5, lng: 153.5 }],
        ];
        for (const [path, body] of routes) {
            resetGatewayRateLimit();
            const within: number[] = [];
            for (let i = 0; i < PER_MINUTE; i++) within.push((await call('POST', ann, path, body)).status);
            const past = await call('POST', ann, path, body);
            assert(!within.includes(429) && past.status === 429 && /rate limit/i.test(past.body?.error ?? ''),
                `POST ${path}, signed by a member: charged to the member bucket, the ${PER_MINUTE + 1}th in a minute is 429 (${within.join(',')} then ${show(past)})`);
        }
        for (const path of ['/api/community/info', '/api/community/health']) {
            resetGatewayRateLimit();
            const statuses: number[] = [];
            for (let i = 0; i < PER_MINUTE * 3; i++) statuses.push((await call('GET', null, path)).status);
            assert(statuses.every(s => s === 200), `GET ${path} (the peer protocol's read): never charged, ${PER_MINUTE * 3} in a row all 200 (${[...new Set(statuses)].join(',')})`);
        }
        resetGatewayRateLimit();
        const statuses: number[] = [];
        for (let i = 0; i <= PER_MINUTE; i++) statuses.push((await call('GET', ann, '/api/community/me')).status);
        assert(statuses.slice(0, PER_MINUTE).every(s => s === 200) && statuses[PER_MINUTE] === 429,
            `GET /api/community/me, a member's own read: charged like any other (${statuses.join(',')})`);
    }

    // The rest runs with the minute throttle off, so what refuses is the rule under test. The day budget is on anyway.
    minuteThrottle(false);

    // ── 2. The day budget ─────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. the day budget: 5,000 signed writes a key a day ---');
    {
        const BUDGET = WRITER_LIMITS.signedWritesPerDay;
        const dee = member('Dee');
        const eve = member('Eve');
        const deeGroup = (await group(dee, 'Dee first group')).body?.id as string;
        assert(!!deeGroup, 'setup: Dee has a group to rename');
        // 11 writes so far (the group above and the 10 below), and the rest in bulk: a write the route refuses still counts.
        const bulk = BUDGET - 11;
        const statuses = await many(bulk, 16, () => call('POST', dee, '/api/community/me/area', {}));
        assert(statuses.length === bulk && statuses.every(s => s === 400), `${bulk} writes the route answers 400 all go through the gateway (${[...new Set(statuses)].join(',')})`);
        const mixed: [string, Res][] = [
            ['a post', await post(dee)],
            ['a post', await post(dee)],
            ['a group', await group(dee, 'Dee second group')],
            ['a rename (PATCH)', await call('PATCH', dee, `/api/groups/${deeGroup}`, { name: 'Dee first group, renamed' })],
            ['an invite', await invite(dee)],
            ['a DM opened', await openDm(dee, eve.pk)],
            ['an area set', await call('POST', dee, '/api/community/me/area', { lat: -28.6, lng: 153.4 })],
            ['a push token removed (DELETE)', await call('DELETE', dee, '/api/push-tokens', { publicKey: dee.pk, token: 'none' })],
            ['a purchase asked', await call('POST', dee, '/api/federation/purchase', { postId: 'none', amount: 1 })],
        ];
        const conv = mixed.find(([what]) => what === 'a DM opened')![1].body?.conversation?.id;
        mixed.push(['a DM line (the 5,000th)', await line(dee, conv)]);
        for (const [what, r] of mixed) assert(r.status !== 429, `write ${what}: not refused by the budget (${show(r)})`);
        const postsBefore = count('SELECT COUNT(*) AS n FROM posts WHERE author_pubkey = ?', dee.pk);
        const over = await post(dee);
        const retry = Number(over.headers.get('retry-after'));
        assert(over.status === 429 && over.body?.code === 'day_budget' && typeof over.body?.resetsAt === 'string' && retry > 0 && retry <= 24 * 3600,
            `the 5,001st write (a post): 429 day_budget, with Retry-After ${retry}s and resetsAt (${show(over)})`);
        assert(/5,000 changes/.test(over.body?.error ?? '') && /carry on in about/.test(over.body?.error ?? ''), `in plain words, with when (${over.body?.error})`);
        assert(count('SELECT COUNT(*) AS n FROM posts WHERE author_pubkey = ?', dee.pk) === postsBefore, 'and nothing is written');
        const groupWrite = await group(dee, 'Dee third group');
        assert(groupWrite.status === 429 && groupWrite.body?.code === 'day_budget', `any route: a group is 429 day_budget too (${show(groupWrite)})`);
        const read = await call('GET', dee, '/api/community/me');
        assert(read.status === 200, `Dee still reads (${read.status})`);
        const other = await call('POST', eve, '/api/community/me/area', { lat: -28.7, lng: 153.3 });
        assert(other.status === 200, `another key's write is unaffected (${show(other)})`);
        grantNodeRole(dee.pk, 'admin', owner.pk);
        const adminWrite = await call('POST', null, '/api/local/admin/diagnostics', {}, { 'x-admin-session': keySession(dee) });
        assert(adminWrite.status === 200, `the admin surface isn't counted: Dee's admin session still writes there (${adminWrite.status})`);

        // The rolling day and the memory bound, on the gateway's own function (the clock can't be moved over HTTPS).
        const ctx = (actor: string, path = '/api/marketplace/posts', method = 'POST') => ({ state: { actor }, method, path, status: 200, body: undefined, set: () => {} }) as any;
        const now = Date.now();
        assert(!gatewayAdmitDayBudget(ctx(dee.pk), now), 'Dee is at the budget now');
        assert(gatewayAdmitDayBudget(ctx(dee.pk, '/api/local/admin/users/x/status'), now), 'an admin-surface write is never counted, even at the budget');
        assert(gatewayAdmitDayBudget(ctx(dee.pk, '/api/marketplace/posts', 'GET'), now), 'a read is never counted');
        assert(gatewayAdmitDayBudget(ctx(dee.pk), now + 25 * HOUR), 'a day later the budget has rolled: Dee writes again');
        const held = dayBudgetKeyCount();
        pruneGatewayBuckets(now + 50 * HOUR);
        assert(held >= 2 && dayBudgetKeyCount() === 0, `keys quiet for a day are forgotten by the cleaner (${held} → ${dayBudgetKeyCount()})`);

        resetGatewayRateLimit();
        const big = 'big-writer';
        for (let i = 0; i < BUDGET - 1_000; i++) gatewayAdmitDayBudget(ctx(big), now);
        for (let i = 0; i < DAY_BUDGET_MAX_KEYS; i++) gatewayAdmitDayBudget(ctx(`k${i}`), now);
        assert(dayBudgetKeyCount() <= DAY_BUDGET_MAX_KEYS, `memory is bounded: ${DAY_BUDGET_MAX_KEYS + 1} keys, ${dayBudgetKeyCount()} held`);
        let admitted = 0;
        while (gatewayAdmitDayBudget(ctx(big), now) && admitted <= 1_000) admitted++;
        assert(admitted === 1_000, `a key near its budget is never the one forgotten: ${BUDGET - 1_000} + ${admitted} writes, then refused`);
        resetGatewayRateLimit();
    }

    // ── 3. DM lines ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. DM lines: 30 a minute, 64 KB each ---');
    {
        const fay = member('Fay');
        const gus = member('Gus');
        const conv = (await openDm(fay, gus.pk)).body?.conversation?.id as string;
        assert(!!conv, 'setup: Fay has a DM with Gus');
        resetChatRateLimit();
        const statuses: number[] = [];
        for (let i = 0; i < WRITER_LIMITS.chatLinesPerMinute; i++) statuses.push((await line(fay, conv)).status);
        const fast = await line(fay, conv);
        assert(statuses.every(s => s === 200) && fast.status === 429 && fast.body?.code === 'chat_rate' && !!fast.headers.get('retry-after'),
            `30 DM lines in a minute go, the 31st is 429 chat_rate with Retry-After (${statuses.length} × 200, then ${show(fast)})`);
        assert(count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND author_pubkey = ?', conv, fay.pk) === 30, 'and 30 are stored');

        resetChatRateLimit();
        const LIMIT = WRITER_LIMITS.dmLineChars;
        const exact = await line(fay, conv, lineOf(LIMIT));
        assert(exact.status === 200, `a line of exactly ${LIMIT} characters goes (${show(exact)})`);
        const before = count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conv);
        const tooLong = await line(fay, conv, lineOf(LIMIT + 4));
        assert(tooLong.status === 413 && tooLong.body?.code === 'message_too_long' && /too long/.test(tooLong.body?.error ?? ''),
            `a line of ${LIMIT + 4} characters is 413 message_too_long, in words (${show(tooLong)})`);
        const withMeta = await line(fay, conv, { ...lineOf(LIMIT - 400), metadata: JSON.stringify({ note: 'x'.repeat(500) }) });
        assert(withMeta.status === 413 && withMeta.body?.code === 'message_too_long', `a line under it whose metadata takes it over is 413 too (${show(withMeta)})`);
        assert(count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conv) === before, 'and neither is stored');
        const photo = await line(fay, conv, {
            ...lockedDm(), type: 'image',
            attachment: { data: crypto.randomBytes(300 * 1024).toString('base64'), nonce: lockedDm().nonce, mime: 'image/jpeg' },
        });
        assert(photo.status === 200, `a photo of 300 KB goes as an attachment, not counted in the line (${show(photo)})`);
        const edit = await call('POST', fay, '/api/messages/edit', { messageId: exact.body?.message?.id, ...lineOf(LIMIT + 4), authorPubkey: fay.pk });
        assert(edit.status === 413 && edit.body?.code === 'message_too_long', `an edit past it is 413 message_too_long (${show(edit)})`);
        // The limit never answers for someone who may not write there at all: their own refusal comes first.
        const outsider = member('Hana');
        const notIn = await line(outsider, conv, lineOf(LIMIT + 4));
        assert(notIn.status === 400 && notIn.body?.code !== 'message_too_long',
            `a line past it from someone not in the conversation gets the not-a-participant refusal, not 413 (${show(notIn)})`);
        const notTheirs = await call('POST', gus, '/api/messages/edit', { messageId: exact.body?.message?.id, ...lineOf(LIMIT + 4), authorPubkey: gus.pk });
        assert(notTheirs.status !== 413 && /only the author/i.test(notTheirs.body?.error ?? ''),
            `an edit past it of someone else's line gets "only the author", not 413 (${show(notTheirs)})`);
        resetChatRateLimit();
    }

    // ── 4. New people by DM ───────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. new people by DM: 20 keys with no row a day ---');
    {
        const hal = member('Hal');
        const ivy = member('Ivy');
        const strangers = Array.from({ length: WRITER_LIMITS.newPeopleByDmPerDay + 1 }, (_v, i) => newId(`Stranger ${i}`));
        const statuses: number[] = [];
        for (const s of strangers.slice(0, -1)) statuses.push((await openDm(hal, s.pk)).status);
        assert(statuses.every(s => s === 200) && strangers.slice(0, -1).every(s => count('SELECT COUNT(*) AS n FROM members WHERE public_key = ? AND is_visitor = 1', s.pk) === 1),
            `Hal opens DMs with 20 people who have no row here: all 200, each gets a visitor's row (${[...new Set(statuses)].join(',')})`);
        const last = strangers[strangers.length - 1];
        const twentyFirst = await openDm(hal, last.pk);
        assert(twentyFirst.status === 429 && twentyFirst.body?.code === 'new_people_per_day' && typeof twentyFirst.body?.resetsAt === 'string',
            `the 21st is 429 new_people_per_day (${show(twentyFirst)})`);
        assert(count('SELECT COUNT(*) AS n FROM members WHERE public_key = ?', last.pk) === 0, 'and no row is made for them');
        const aMember = await openDm(hal, ivy.pk);
        assert(aMember.status === 200, `a member here is never counted (${show(aMember)})`);
        const metAlready = await openDm(hal, strangers[0].pk);
        assert(metAlready.status === 200, `nor someone already met (${show(metAlready)})`);
        const ivyOpens = await openDm(ivy, last.pk);
        assert(ivyOpens.status === 200, `another member is unaffected (${show(ivyOpens)})`);
    }

    // ── 5. Enterprises ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. enterprises: 3 a day, 20 running ---');
    {
        const jo = member('Jo');
        const made: number[] = [];
        for (let i = 1; i <= WRITER_LIMITS.enterprisesPerDay; i++) made.push((await enterprise(jo, `Jo Co ${i}`)).status);
        const fourth = await enterprise(jo, 'Jo Co 4');
        assert(made.every(s => s === 200) && fourth.status === 429 && fourth.body?.code === 'enterprises_per_day',
            `Jo starts 3 enterprises today, the 4th is 429 enterprises_per_day (${made.join(',')}, then ${show(fourth)})`);
        assert(count("SELECT COUNT(*) AS n FROM members WHERE is_treasury = 1 AND callsign LIKE 'Jo Co %'") === 3, 'and it is not made');

        const kim = member('Kim');
        const planted: string[] = [];
        for (let i = 0; i < WRITER_LIMITS.enterprisesLive - 1; i++) {
            const pk = crypto.randomBytes(32).toString('hex');
            planted.push(pk);
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_treasury) VALUES (?, ?, ?, 'active', 1)`).run(pk, `Kim Old ${i}`, ago(3 * DAY));
            db.prepare(`INSERT INTO conversations (id, type, name, created_by, created_at) VALUES (?, 'enterprise_thread', ?, ?, ?)`).run(pk, `Kim Old ${i}`, kim.pk, ago(3 * DAY));
        }
        const twentieth = await enterprise(kim, 'Kim New 1');
        const twentyFirst = await enterprise(kim, 'Kim New 2');
        assert(twentieth.status === 200 && twentyFirst.status === 429 && twentyFirst.body?.code === 'enterprises_live',
            `Kim, with 19 running from before, starts a 20th; the 21st is 429 enterprises_live (${twentieth.status}, then ${show(twentyFirst)})`);
        db.prepare("UPDATE members SET status = 'completed' WHERE public_key = ?").run(planted[0]);
        const afterWindUp = await enterprise(kim, 'Kim New 3');
        assert(afterWindUp.status === 200, `once one is wound up, Kim can start another (${show(afterWindUp)})`);
    }

    // ── 6. Posts ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 6. posts: 100 a day ---');
    {
        const lee = member('Lee');
        const statuses = await many(WRITER_LIMITS.postsPerDay, 8, () => post(lee));
        const over = await post(lee);
        assert(statuses.every(s => s === 200) && over.status === 429 && over.body?.code === 'posts_per_day' && /100 new posts/.test(over.body?.error ?? ''),
            `Lee puts up 100 posts, the 101st is 429 posts_per_day in words (${[...new Set(statuses)].join(',')}, then ${show(over)})`);
        assert(count('SELECT COUNT(*) AS n FROM posts WHERE author_pubkey = ?', lee.pk) === 100, 'and 100 are stored');

        const max = member('Max');
        const ent = (await enterprise(max, 'Max Market')).body?.publicKey as string;
        assert(!!ent, 'setup: Max keeps an enterprise');
        // The marketplace asks every author for a profile photo first, an enterprise too.
        db.prepare("UPDATE members SET avatar_url = 'https://example.com/e.jpg' WHERE public_key = ?").run(ent);
        const own = await many(WRITER_LIMITS.postsPerDay - 1, 8, () => post(max));
        const forEnt = await call('POST', max, `/api/treasury/${ent}/offer`, { title: 'Eggs', category: 'food', credits: 0 });
        const overEnt = await call('POST', max, `/api/treasury/${ent}/offer`, { title: 'More eggs', category: 'food', credits: 0 });
        const overOwn = await post(max);
        assert(own.every(s => s === 200) && forEnt.status === 200 && overEnt.status === 429 && overEnt.body?.code === 'posts_per_day' && overOwn.status === 429,
            `a keeper's 99 own posts and one for the enterprise make 100; the next, either way, is 429 posts_per_day (${forEnt.status}, ${show(overEnt)}, ${overOwn.status})`);
    }

    // ── 7. Groups ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 7. groups: 5 a day ---');
    {
        const ned = member('Ned');
        const statuses: number[] = [];
        for (let i = 1; i <= WRITER_LIMITS.groupsPerDay; i++) statuses.push((await group(ned, `Ned group ${i}`)).status);
        const sixth = await group(ned, 'Ned group 6');
        assert(statuses.every(s => s === 201) && sixth.status === 429 && sixth.body?.code === 'groups_per_day',
            `Ned starts 5 groups, the 6th is 429 groups_per_day (${statuses.join(',')}, then ${show(sixth)})`);
        assert(count('SELECT COUNT(*) AS n FROM groups WHERE created_by = ?', ned.pk) === 5, 'and 5 are stored');
    }

    // ── 8. Invites ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. invites: 20 a day, 50 unused, tickets counted when used ---');
    {
        const pia = member('Pia');
        const statuses: number[] = [];
        for (let i = 0; i < WRITER_LIMITS.invitesPerDay; i++) statuses.push((await invite(pia)).status);
        const over = await invite(pia);
        assert(statuses.every(s => s === 200) && over.status === 429 && over.body?.code === 'invites_per_day',
            `Pia makes 20 invites, the 21st is 429 invites_per_day (${[...new Set(statuses)].join(',')}, then ${show(over)})`);
        assert(count('SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ?', pia.pk) === 20, 'and 20 are stored');

        const quin = member('Quin');
        const oldUnused = WRITER_LIMITS.invitesUnused - 5;
        for (let i = 0; i < oldUnused; i++) {
            db.prepare('INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)').run(`INV-Q${String(i).padStart(3, '0')}-OLD1`, quin.pk, ago(2 * DAY));
        }
        const today: number[] = [];
        for (let i = 0; i < 5; i++) today.push((await invite(quin)).status);
        const fiftyFirst = await invite(quin);
        assert(today.every(s => s === 200) && fiftyFirst.status === 429 && fiftyFirst.body?.code === 'invites_unused' && !fiftyFirst.body?.resetsAt,
            `Quin, holding 45 unused from before, makes 5 more; the 51st is 429 invites_unused (${today.join(',')}, then ${show(fiftyFirst)})`);
        db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = 'INV-Q000-OLD1'").run(owner.pk, ago(DAY));
        const afterUse = await invite(quin);
        assert(afterUse.status === 200, `once one is used, Quin can make another (${show(afterUse)})`);

        const vic = member('Vic');
        for (let i = 0; i < WRITER_LIMITS.invitesUnused + 10; i++) {
            db.prepare('INSERT INTO invite_codes (code, created_by, created_at, issued_by) VALUES (?, ?, ?, ?)').run(`INV-V${String(i).padStart(3, '0')}-CARD`, vic.pk, ago(HOUR), 'owner:password');
        }
        const vicOwn = await invite(vic);
        assert(vicOwn.status === 200, `60 invites an owner made in Settings under Vic (the first member) don't count against Vic's own (${show(vicOwn)})`);

        const rex = member('Rex');
        for (let i = 0; i < WRITER_LIMITS.invitesPerDay - 1; i++) await invite(rex);
        const joinA = newId('Joiner A');
        const joinB = newId('Joiner B');
        const a = await call('POST', joinA, '/api/invite/redeem-offline', { ticketB64: phoneTicket(rex, Date.now()), publicKey: joinA.pk, callsign: joinA.name });
        assert(a.status === 200 && a.body?.success === true, `Rex has made 19 invites today; someone joins with his offline ticket, the 20th (${show(a)})`);
        const rowsBefore = count('SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ?', rex.pk);
        const b = await call('POST', joinB, '/api/invite/redeem-offline', { ticketB64: phoneTicket(rex, Date.now() - 60_000), publicKey: joinB.pk, callsign: joinB.name });
        assert(b.status === 400 && /brought 20 people in today/.test(b.body?.error ?? ''),
            `a join with his next ticket is refused, in words the joiner reads (${show(b)})`);
        assert(count('SELECT COUNT(*) AS n FROM members WHERE public_key = ?', joinB.pk) === 0 && count('SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ?', rex.pk) === rowsBefore,
            'and nothing is written: no member row, the ticket still unused');
    }

    // ── 9. The unused-invite prune ────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 9. unused invites go after 30 days, with no tombstone ---');
    {
        const sam = member('Sam');
        const add = (code: string, made: string, usedBy: string | null = null) =>
            db.prepare('INSERT INTO invite_codes (code, created_by, created_at, used_by, used_at) VALUES (?, ?, ?, ?, ?)').run(code, sam.pk, made, usedBy, usedBy ? made : null);
        add('INV-OLDX-UNSD', ago(31 * DAY));
        add('0123456789abcdef', ago(31 * DAY));             // an offline ticket's row, never used (a join that failed after writing it)
        add('INV-OLDX-USED', ago(40 * DAY), owner.pk);
        add('INV-YNGX-UNSD', ago(29 * DAY));
        const tombstonesBefore = count("SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'invite_codes'");
        setNodeRole('backup');
        const onStandby = pruneUnusedInvites();
        setNodeRole('primary');
        assert(onStandby === 0 && count("SELECT COUNT(*) AS n FROM invite_codes WHERE code = 'INV-OLDX-UNSD'") === 1, 'a standby prunes nothing (its invites are its main server\'s)');
        const gone = pruneUnusedInvites();
        const left = (db.prepare('SELECT code FROM invite_codes WHERE created_by = ? ORDER BY code').all(sam.pk) as { code: string }[]).map(r => r.code);
        assert(gone === 2 && JSON.stringify(left) === JSON.stringify(['INV-OLDX-USED', 'INV-YNGX-UNSD']),
            `the unused code and ticket row past 30 days go; the used one and the 29-day one stay (${gone} gone, left ${left.join(', ')})`);
        assert(count("SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'invite_codes'") === tombstonesBefore, 'with no tombstone');
    }

    // ── 10. The Pulse ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 10. the Pulse: 50 links by hand, 300 synced items a day ---');
    {
        const tia = member('Tia');
        const site = addChannel({ ownerPubkey: tia.pk, platform: 'website', raw: 'https://blog.example.org', category: 'other' });
        // No request leaves the box: the link's title comes from this stub, and no thumbnail is fetched.
        const deps: PulseSubmitRouteDeps = {
            checkAdminAuth: async () => false, rateLimit: () => true, clampLimit: (_v: unknown, def = 20) => def, clampOffset: () => 0,
            activeConnections: new Map(), calculateAnalytics: () => ({}), enforceReadAuth: false,
            probeInstagramPostCountFn: async () => null,
            metadataFetchFn: (async (rawUrl: string) => {
                if (new URL(rawUrl).hostname !== 'blog.example.org') throw new Error(`test stub: unexpected fetch to ${rawUrl}`);
                const html = '<html><head><title>A post</title></head></html>';
                return { status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' }, url: rawUrl, buffer: async () => Buffer.from(html), text: async () => html, json: async () => ({}) };
            }) as PulseSubmitRouteDeps['metadataFetchFn'],
            thumbnailService: new PulseThumbnailService({ diskStore: null, fetchFn: (async () => { throw new Error('test stub: no thumbnails'); }) as any }),
        };
        const router = createPulseSubmitRoutes(deps) as any;
        const layer = router.stack.find((l: any) => l.path === '/api/member/pulse/submit' && l.methods.includes('POST'));
        const submit = async (url: string) => {
            const ctx: any = { state: { actor: tia.pk }, requestBody: { url, channelId: site.id }, params: {}, status: 200, body: undefined, set: () => {} };
            await layer.stack[layer.stack.length - 1](ctx, async () => {});
            return { status: ctx.status, body: ctx.body };
        };
        const statuses: number[] = [];
        for (let i = 1; i <= WRITER_LIMITS.pulseSubmissionsPerDay; i++) statuses.push((await submit(`https://blog.example.org/post-${i}`)).status);
        const over = await submit('https://blog.example.org/post-51');
        assert(statuses.every(s => s === 200) && over.status === 429 && over.body?.code === 'pulse_per_day',
            `Tia adds 50 links by hand, the 51st is 429 pulse_per_day (${[...new Set(statuses)].join(',')}, then ${over.status} ${JSON.stringify(over.body).slice(0, 120)})`);
        const again = await submit('https://blog.example.org/post-1?utm_source=newsletter&fbclid=abc#comments');
        assert(again.status === 200 && again.body?.deduplicated === true,
            `the first link again, with share tracking and a fragment: the same link, never refused at the limit (${again.status} deduplicated ${again.body?.deduplicated})`);
        assert(count("SELECT COUNT(*) AS n FROM pulse_items WHERE owner_pubkey = ? AND source = 'manual'", tia.pk) === 50, 'and 50 are stored');

        // The synced items, over HTTPS: they carry their own titles, so nothing is looked up.
        const uma = member('Uma');
        const tt = addChannel({ ownerPubkey: uma.pk, platform: 'tiktok', raw: '@uma_makes', category: 'other' });
        const already = WRITER_LIMITS.pulseSyncedItemsPerDay - 10;
        const insert = db.prepare(`INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, external_id, url, title, published_at, category, source, created_at, updated_at)
                                   VALUES (?, ?, ?, 'tiktok', ?, ?, 'Synced', ?, 'other', 'oauth', ?, ?)`);
        for (let i = 0; i < already; i++) {
            const at = ago(HOUR);
            insert.run(`item_old_${i}`, tt.id, uma.pk, `9${i}`, `https://www.tiktok.com/@uma_makes/video/9${i}`, at, at, at);
        }
        const items = Array.from({ length: 20 }, (_v, i) => ({ url: `https://www.tiktok.com/@uma_makes/video/7${i}`, externalId: `7${i}`, title: `Video ${i}` }));
        const sync = await call('POST', uma, '/api/member/pulse/oauth-ingest', { channelId: tt.id, items });
        assert(sync.status === 200 && sync.body?.count === 10 && sync.body?.leftForLater === 10,
            `Uma's app syncs 20 new items with ${already} synced today: 10 go in, 10 are left for a later sync (${show(sync)})`);
        const syncAgain = await call('POST', uma, '/api/member/pulse/oauth-ingest', { channelId: tt.id, items });
        assert(syncAgain.status === 200 && syncAgain.body?.deduplicatedCount === 10 && syncAgain.body?.leftForLater === 10,
            `the same sync again: the 10 already in are found, the other 10 still wait (${show(syncAgain)})`);
        assert(count("SELECT COUNT(*) AS n FROM pulse_items WHERE owner_pubkey = ? AND source = 'oauth'", uma.pk) === WRITER_LIMITS.pulseSyncedItemsPerDay,
            `and ${WRITER_LIMITS.pulseSyncedItemsPerDay} are stored`);
    }

    // ── 11. Read marks are not counted in the day budget ──────────────────────────────────────────────────────
    console.log('\n--- 11. read marks: under the minute bucket, outside the day budget ---');
    {
        resetGatewayRateLimit();
        const BUDGET = WRITER_LIMITS.signedWritesPerDay;
        const val = member('Val');
        const wyn = member('Wyn');
        const opened = await openDm(val, wyn.pk);
        const conv = opened.body?.conversation?.id as string;
        assert(!!conv, `setup: Val opens a DM with Wyn, her first change of the day (${show(opened)})`);
        const markRead = () => call('POST', val, '/api/messages/mark-read', { conversationId: conv });
        // The reviewer's repro: a phone with the DM open marks it read every ~12 s, for a day.
        const marks = await many(BUDGET - 1, 16, markRead);
        assert(marks.length === BUDGET - 1 && marks.every(s => s === 200), `${BUDGET - 1} read marks all go (${[...new Set(marks)].join(',')})`);
        const first = await line(val, conv);
        assert(first.status === 200, `then Val's first DM line of the day: 200, not day_budget (${show(first)})`);
        const cursor = (db.prepare('SELECT last_read_at AS t FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(conv, val.pk) as { t: string | null })?.t;
        assert(typeof cursor === 'string' && Date.now() - Date.parse(cursor) < 10 * 60_000, `a read mark is a real one: it moved her read cursor (${cursor})`);

        // Now to the budget with real writes (2 so far: the DM opened and the line).
        const bulk = BUDGET - 2;
        const writes = await many(bulk, 16, () => call('POST', val, '/api/community/me/area', {}));
        assert(writes.length === bulk && writes.every(s => s === 400), `${bulk} more real writes take her to ${BUDGET} (${[...new Set(writes)].join(',')})`);
        const messagesBefore = count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conv);
        const over = await line(val, conv);
        assert(over.status === 429 && over.body?.code === 'day_budget', `past the budget a real write (a DM line) is 429 day_budget (${show(over)})`);
        const markOver = await markRead();
        assert(markOver.status === 200 && markOver.body?.success === true, `past the budget a read mark still goes (${show(markOver)})`);
        const seenOver = await call('POST', val, '/api/notices/seen', { ids: ['no-such-notice'] });
        assert(seenOver.status === 200 && seenOver.body?.success === true, `and so does marking notices seen (${show(seenOver)})`);
        const markWithQuery = await call('POST', val, '/api/messages/mark-read?from=poll', { conversationId: conv });
        assert(markWithQuery.status === 200, `a read mark with a query string is the same path to the gateway, and still a read mark (${show(markWithQuery)})`);

        // Nothing else rides it: other spellings and methods of the read-mark paths are counted as the writes they could
        // be (429 day_budget), or refused before any handler as a spelling nothing lives at (404, isNonCanonicalPath),
        // and a real write never passes for one.
        const dressed: [string, Method, string, unknown, 'day_budget' | 'not_found'][] = [
            ['a trailing slash', 'POST', '/api/messages/mark-read/', { conversationId: conv }, 'day_budget'],
            ['an escaped letter', 'POST', '/api/messages/mark%2Dread', { conversationId: conv }, 'day_budget'],
            ['PATCH', 'PATCH', '/api/messages/mark-read', { conversationId: conv }, 'day_budget'],
            ['DELETE', 'DELETE', '/api/notices/seen', { ids: ['no-such-notice'] }, 'day_budget'],
            ['a DM line with the read-mark path in its query', 'POST', '/api/messages/send?/api/messages/mark-read', { conversationId: conv, authorPubkey: val.pk, ...lockedDm() }, 'day_budget'],
            ['capitals', 'POST', '/api/Messages/mark-read', { conversationId: conv }, 'not_found'],
            ['a double slash', 'POST', '//api/messages/mark-read', { conversationId: conv }, 'not_found'],
        ];
        for (const [what, method, path, body, expect] of dressed) {
            const r = await call(method, val, path, body);
            assert(expect === 'day_budget' ? r.status === 429 && r.body?.code === 'day_budget' : r.status === 404 && r.body?.error === 'Not found',
                `${what} (${method} ${path}): ${expect === 'day_budget' ? 'counted, 429 day_budget' : 'refused before any handler, 404'} (${show(r)})`);
        }
        assert(count('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conv) === messagesBefore, 'and no line was written past the budget');

        // The minute bucket still counts them.
        const PER_MINUTE = 5;
        minuteThrottle(true, PER_MINUTE);
        const minute: number[] = [];
        for (let i = 0; i <= PER_MINUTE; i++) minute.push((await call('POST', wyn, '/api/messages/mark-read', { conversationId: conv })).status);
        assert(minute.slice(0, PER_MINUTE).every(s => s === 200) && minute[PER_MINUTE] === 429,
            `read marks still count in the minute bucket: the ${PER_MINUTE + 1}th in a minute is 429 (${minute.join(',')})`);
        minuteThrottle(false);
    }

    // ── 12. The Pulse harvester: a daily allowance per owner ───────────────────────────────────────────────────
    console.log('\n--- 12. the Pulse harvester: new items a day per owner ---');
    {
        const ALLOWANCE = WRITER_LIMITS.pulseHarvestedItemsPerDay;
        const PER_VISIT = 20;
        const xan = member('Xan');
        const yul = member('Yul');
        // A feed its owner controls, serving 20 items no visit has seen before, every visit. `serve` pins it to one
        // earlier visit's items instead.
        let visit = 0;
        let serve: number | null = null;
        const fetched: string[] = [];
        const feedFetch = async (rawUrl: string): Promise<SsrfSafeResponse> => {
            const host = new URL(rawUrl).hostname;
            if (!host.endsWith('.example.org')) throw new Error(`test stub: unexpected fetch to ${rawUrl}`);
            fetched.push(rawUrl);
            const v = serve ?? ++visit;
            const items = Array.from({ length: PER_VISIT }, (_v, i) => {
                const guid = `${host}-v${v}-i${i}`;
                const at = new Date(Date.UTC(2026, 0, 1) + v * HOUR + i * 60_000).toUTCString();
                return `<item><title>Post ${guid}</title><link>https://${host}/${guid}</link><guid>${guid}</guid><pubDate>${at}</pubDate></item>`;
            }).join('');
            const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>${host}</title><link>https://${host}/</link>${items}</channel></rss>`;
            return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/rss+xml' }, url: rawUrl, buffer: async () => Buffer.from(xml), text: async () => xml, json: async () => ({}) } as SsrfSafeResponse;
        };
        const rows = (owner: Id) => count("SELECT COUNT(*) AS n FROM pulse_items WHERE owner_pubkey = ? AND source = 'autolist'", owner.pk);
        /** One scheduler visit to the channel: the prune the tick runs first, then the resolve. */
        const visitOnce = async (channelId: string) => { prunePulseItems(); return resolveChannel(channelId, { fetchFn: feedFetch }); };

        const feed = addChannel({ ownerPubkey: xan.pk, platform: 'website', raw: 'https://xan.example.org', category: 'other' });
        const visits = ALLOWANCE / PER_VISIT + 5;
        const results: Awaited<ReturnType<typeof resolveChannel>>[] = [];
        for (let i = 0; i < visits; i++) results.push(await visitOnce(feed.id));
        assert(fetched.length > 0 && fetched.every(u => new URL(u).hostname === 'xan.example.org'), `setup: every fetch went to the stub (${fetched.length})`);
        assert(results.every(r => !r.error), `no visit is an error (${[...new Set(results.map(r => r.error ?? 'ok'))].join(', ')})`);
        assert(rows(xan) === ALLOWANCE, `${visits} visits of 20 new items each: ${ALLOWANCE} rows for Xan, and no more (${rows(xan)})`);
        const last = results[results.length - 1];
        assert(last.count === 0 && last.leftForLater === PER_VISIT, `a visit past the allowance adds nothing and says so (${JSON.stringify(last)})`);
        const ch = db.prepare('SELECT fail_count, last_error, is_stale, supports_autolist FROM creator_channels WHERE id = ?').get(feed.id) as any;
        assert(ch.fail_count === 0 && ch.last_error === null && ch.is_stale === 0 && ch.supports_autolist === 1,
            `the channel stays healthy and in the rotation: no error loop (${JSON.stringify(ch)})`);
        serve = ALLOWANCE / PER_VISIT; // the last visit that was listed: its 20 are the channel's live ones
        const refresh = await visitOnce(feed.id);
        assert(refresh.count === PER_VISIT && !refresh.leftForLater && rows(xan) === ALLOWANCE,
            `the items already listed, served again, still refresh and cost nothing (${JSON.stringify(refresh)}, ${rows(xan)} rows)`);
        serve = null;
        const second = addChannel({ ownerPubkey: xan.pk, platform: 'rss', raw: 'https://xan2.example.org/feed.xml', category: 'other' });
        const other = await visitOnce(second.id);
        assert(other.count === 0 && other.leftForLater === PER_VISIT && rows(xan) === ALLOWANCE,
            `the allowance is Xan's, not the channel's: her second feed adds nothing today (${JSON.stringify(other)})`);

        const yulFeed = addChannel({ ownerPubkey: yul.pk, platform: 'website', raw: 'https://yul.example.org', category: 'other' });
        const yulVisit = await visitOnce(yulFeed.id);
        assert(yulVisit.count === PER_VISIT && !yulVisit.leftForLater && rows(yul) === PER_VISIT, `another owner is unaffected: Yul's first visit lists 20 (${JSON.stringify(yulVisit)})`);

        // A day later (her rows made 25 hours ago), the harvest resumes.
        db.prepare("UPDATE pulse_items SET created_at = ? WHERE owner_pubkey = ? AND source = 'autolist'").run(ago(25 * HOUR), xan.pk);
        const nextDay = await visitOnce(feed.id);
        assert(nextDay.count === PER_VISIT && !nextDay.leftForLater && rows(xan) === ALLOWANCE + PER_VISIT,
            `the next day it resumes: 20 new items listed (${JSON.stringify(nextDay)}, ${rows(xan)} rows)`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ writer-bounds checks PASSED.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
