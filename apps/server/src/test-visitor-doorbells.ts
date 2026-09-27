/**
 * A socket with no member's key gets only the doorbells that can change what it may read (#1220's follow-up).
 *
 * A /ws socket with no verified member gets PUBLIC_WS_EVENTS as bare `{ type }` doorbells, and its app reads again what
 * it may read on each one. On a node that shows visitors the listings and not the people (`guestListingsOnly`, the
 * global profile), an unsigned reader, and one signed by a key that is no member here, reads the listings' guest view
 * and nothing of the Commons: the decisions, projects, crowdfunds and enterprises are members-only there, or switched
 * off. So there such a socket gets the listings' doorbells (new_post, post_updated, post_removed) and state_synced, and
 * none for a project, a decision or an enterprise. Everywhere else it gets what it always got.
 *
 * The real server in this process, real sockets over TLS, every change made over HTTP through the signature middleware
 * or by the engine's own functions, where this node can make one:
 *   1. sockets: unsigned, signed by a key that is no member here, a member's, a visitor's row's (a key, so unchanged) and
 *      a suspended member's (a key, so unchanged)
 *   2. a listing posted, edited and taken down over HTTP: the doorbell for each reaches every socket, bare to all but
 *      the member's
 *   3. a Decision proposed and voted on over HTTP: its doorbells reach the key-less sockets only where an unsigned
 *      reader can read the decisions; the member's socket, the visitor's and the suspended member's get them everywhere
 *   4. a Commons project proposed and placed on the map (the engine's createProject and setEnterpriseLocation), where
 *      this node runs them: the same
 *   5. the table: every type in PUBLIC_WS_EVENTS broadcast once, and a state_synced for an import that counted only
 *      groups: the key-less sockets get exactly this node's row of the table, bare, and never a member-only event; the
 *      member's socket gets every one in full; the visitor's and the suspended member's every public one, bare
 *   6. listings that leave the board or come back with no post event of their own (review 4113937195): a community
 *      removal (tickDecisions at the end of the grace), an admin prune of a member with two listings, an enterprise
 *      paused and resumed, winding up and cancelled, and paused when its only keeper, the lead, is unbound; a member on
 *      holiday and back; a report actioned with a suspension; a Delete account over HTTP; a trade's step
 *      (othersGetDoorbell). Every socket off the member feed gets one bare listing doorbell per change, and an unsigned
 *      reader's board changes to match; the member's socket gets that change's own events and no listing doorbell, as
 *      before
 *
 * The node kinds, one per process (the parent is the first, and runs the others as children with fresh data dirs):
 *   - global: NODE_PROFILE=global as it ships: listings only
 *   - local+guest: a local node with `guestListingsOnly` overridden on: listings only (the switch decides, not the
 *     profile), and Beans on, so section 4 runs
 *   - local: NODE_PROFILE unset: unchanged, every public doorbell (section 4 runs)
 *   - standby-read-open: a global standby started with ENFORCE_READ_AUTH=false (a main server refuses to start so), where
 *     every read is open to anyone: every public doorbell, as before (section 5 only: a standby makes no changes)
 * Section 6 runs on each of the other three.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-visitor-doorbells.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
type Combo = 'global' | 'local+guest' | 'local' | 'standby-read-open';
const COMBO: Combo = (process.env.DOORBELL_COMBO as Combo | undefined) || 'global';
// Module consts read at import, so they are settled before the dynamic imports in main().
delete process.env.ENFORCE_WS_AUTH;
if (COMBO === 'standby-read-open') {
    process.env.ENFORCE_READ_AUTH = 'false';
    process.env.NODE_ROLE = 'backup';
} else {
    delete process.env.ENFORCE_READ_AUTH;
    delete process.env.NODE_ROLE;
}
if (COMBO === 'local' || COMBO === 'local+guest') delete process.env.NODE_PROFILE;
else process.env.NODE_PROFILE = 'global';
/** A reader with no member's key here reads the listings and nothing of the Commons. */
const LISTINGS_ONLY = COMBO === 'global' || COMBO === 'local+guest';
/** Beans are on, so the engine makes Commons projects and places enterprises here. */
const MONEY_ON = COMBO === 'local' || COMBO === 'local+guest';
/** A standby: it changes nothing itself, so only section 5 runs. */
const STANDBY = COMBO === 'standby-read-open';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const MODE = `[${COMBO}]`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${MODE} ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;

// ── what this run started, stopped on any exit ──────────────────────────────────────────────────
// The other node kinds run in child processes, each with its own node and data directory. A run that fails, throws or
// is killed takes them with it (test-guest-view's pattern): the children are spawned async and stopped on this
// process's exit, and a child stops when its parent is gone however it went: its IPC channel closes.
const children = new Set<ChildProcess>();
const ownedDirs = new Set<string>();
process.on('exit', () => {
    for (const c of children) c.kill('SIGTERM');
    for (const d of ownedDirs) fs.rmSync(d, { recursive: true, force: true });
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
        console.error(`${MODE} ${sig}: stopping this run and every process it started`);
        process.exit(128 + os.constants.signals[sig]);
    });
}
if (process.env.DOORBELL_CHILD === '1') {
    if (process.env.BEANPOOL_DATA_DIR) ownedDirs.add(process.env.BEANPOOL_DATA_DIR);
    process.on('disconnect', () => process.exit(1));
    process.channel?.unref();
}

// ── members, signed requests and sockets ────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

let BASE = '';
let beforeCall: () => void = () => {};
async function call(id: Id, urlPath: string, body: unknown): Promise<{ status: number; body: any }> {
    beforeCall();
    const raw = JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${urlPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${urlPath}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: raw,
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    return `pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

interface Sock { ws: WebSocket; raw: string[] }
function openSocket(url: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const raw: string[] = [];
        ws.on('message', (d) => raw.push(d.toString()));
        ws.on('open', () => resolve({ ws, raw }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}
/** What a socket got since it was last cleared, the connect greeting (state_snapshot) left out. */
function got(s: Sock): any[] {
    return s.raw.map(m => { try { return JSON.parse(m); } catch { return { type: '?' }; } }).filter(e => e.type !== 'state_snapshot');
}
const typesOf = (s: Sock) => new Set(got(s).map(e => e.type));
const bare = (s: Sock) => got(s).every(e => Object.keys(e).length === 1 && typeof e.type === 'string');
const show = (s: Sock) => JSON.stringify(got(s).map(e => e.type));
/** Waits until the socket has an event of this type, or 2 s. */
async function until(s: Sock, type: string): Promise<void> {
    for (let i = 0; i < 40 && !typesOf(s).has(type); i++) await sleep(50);
    await sleep(150); // the rest of the same broadcast, to the other sockets
}

const LISTING_EVENTS = ['new_post', 'post_updated', 'post_removed'];
const DECISION_EVENTS = ['decision_created', 'decision_vote_cast'];

async function main(): Promise<void> {
    console.log(`\n=== A key-less socket's doorbells ${MODE} ===\n`);
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const https = await import('./https-server.js');
    const { db, initSchema } = await import('./db/db.js');
    const { getProfileSwitches } = await import('./config/node-profile.js');
    const { getNodeRole } = await import('./config/node-role.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    beforeCall = () => resetGatewayRateLimit();

    // The operator's override, written before boot as an operator's would be.
    initSchema();
    if (COMBO === 'local+guest') db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('nodeProfile.guestListingsOnly', 'true')").run();
    // Formal Decisions are off on the global profile (test-decisions-off), and sections 3 and 6 make some: on a global
    // node whose operator has switched them back on, whose readers still see the listings only.
    if (COMBO === 'global') db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('nodeProfile.decisions', 'true')").run();

    await initTls();
    se.initStateEngine();
    const port = await https.startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const switches = getProfileSwitches();
    assert(switches.guestListingsOnly === LISTINGS_ONLY || STANDBY, `setup: guestListingsOnly is ${switches.guestListingsOnly}`);
    assert(switches.beans === MONEY_ON || STANDBY, `setup: Beans are ${switches.beans ? 'on' : 'off'}`);
    assert(switches.decisions || STANDBY, `setup: formal Decisions are ${switches.decisions ? 'on' : 'off'}`);
    assert(getNodeRole() === (STANDBY ? 'backup' : 'primary'), `setup: this node runs as ${getNodeRole()}`);

    const member = (callsign: string, opts: { status?: string; visitor?: boolean; earned?: number } = {}): Id => {
        const id = newId();
        // A profile photo, because posting needs one; joined long ago, so no new account's limits apply.
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status, is_visitor, earned_credit)
                    VALUES (?, ?, ?, 'seed', 'seed', 'https://example.com/a.jpg', ?, ?, ?)`)
            .run(id.pk, callsign, new Date(Date.now() - 60 * DAY).toISOString(), opts.status ?? 'active', opts.visitor ? 1 : 0, opts.earned ?? 0);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const alice = member('DoorbellAlice', { earned: 10 });
    const bob = member('DoorbellBob');
    const carol = member('DoorbellCarol');
    const vera = member('DoorbellVera', { visitor: true });
    const sam = member('DoorbellSam', { status: 'suspended' });
    const outsider = newId();

    // ── 1. sockets ──────────────────────────────────────────────────────────────────────────────
    console.log('── 1. the sockets ──');
    const wsBase = `${BASE.replace('https', 'wss')}/ws`;
    const S = {
        unsigned: await openSocket(wsBase),
        outsider: await openSocket(`${wsBase}?${signedWsQuery(outsider)}`),
        member: await openSocket(`${wsBase}?${signedWsQuery(bob)}`),
        visitor: await openSocket(`${wsBase}?${signedWsQuery(vera)}`),
        suspended: await openSocket(`${wsBase}?${signedWsQuery(sam)}`),
    };
    const keyless = [['an unsigned', S.unsigned], ['a non-member-signed', S.outsider]] as const;
    const keyed = [['a visitor\'s', S.visitor], ['a suspended member\'s', S.suspended]] as const;
    const clear = () => { for (const s of Object.values(S)) s.raw.length = 0; };
    await sleep(200);
    clear();
    // Which socket is which, as the server sees it: a member's socket gets a member-only event; no other does.
    se.broadcast({ type: 'system_announcement', title: 'Doorbell check', body: 'members only', level: 'info' });
    await until(S.member, 'system_announcement');
    assert(typesOf(S.member).has('system_announcement'), "setup: Bob's socket is a member's (it gets the member feed)");
    for (const [who, s] of [...keyless, ...keyed]) assert(got(s).length === 0, `setup: ${who} socket gets no member-only event (${show(s)})`);

    if (!STANDBY) {
        // ── 2. a listing ────────────────────────────────────────────────────────────────────────
        console.log('\n── 2. a listing posted, edited and taken down over HTTP ──');
        clear();
        const made = await call(alice, '/api/marketplace/posts', {
            type: 'offer', category: 'other', title: 'Doorbell offer', description: 'A doorbell test offer', authorPublicKey: alice.pk, lat: -28.5, lng: 153.5,
        });
        const postId = made.body?.post?.id as string | undefined;
        assert(made.status === 200 && !!postId, `Alice posts (got ${made.status} ${JSON.stringify(made.body).slice(0, 120)})`);
        const edited = await call(alice, '/api/marketplace/posts/update', { id: postId, authorPublicKey: alice.pk, description: 'A doorbell test offer, edited' });
        assert(edited.status === 200, `Alice edits it (got ${edited.status} ${JSON.stringify(edited.body).slice(0, 120)})`);
        const removed = await call(alice, '/api/marketplace/posts/remove', { id: postId, authorPublicKey: alice.pk });
        assert(removed.status === 200 && removed.body?.success === true, `Alice takes it down (got ${removed.status} ${JSON.stringify(removed.body).slice(0, 120)})`);
        await until(S.member, 'post_removed');
        for (const [who, s] of [...keyless, ...keyed]) {
            assert(LISTING_EVENTS.every(t => typesOf(s).has(t)), `${who} socket gets a doorbell for the new, the edited and the removed listing (${show(s)})`);
            assert(bare(s), `${who} socket gets them bare: { type } only`);
        }
        assert(LISTING_EVENTS.every(t => typesOf(S.member).has(t)), `the member's socket gets all three (${show(S.member)})`);
        assert(got(S.member).some(e => e.type === 'new_post' && e.post?.title === 'Doorbell offer'), "the member's socket gets the listing itself, as always");

        // ── 3. a Decision ───────────────────────────────────────────────────────────────────────
        console.log('\n── 3. a Decision proposed and voted on over HTTP ──');
        clear();
        const proposed = await call(alice, '/api/commons/decisions', {
            title: 'Freeze Carol', description: 'A doorbell test Decision', touches: 'member', effect: 'freeze_credit', subject: carol.pk,
        });
        const decisionId = proposed.body?.decision?.id as string | undefined;
        assert(proposed.status === 200 && !!decisionId, `Alice proposes a Decision (got ${proposed.status} ${JSON.stringify(proposed.body).slice(0, 160)})`);
        const voted = await call(bob, `/api/commons/decisions/${decisionId}/vote`, { support: true });
        assert(voted.status === 200, `Bob votes on it (got ${voted.status} ${JSON.stringify(voted.body).slice(0, 160)})`);
        await until(S.member, 'decision_vote_cast');
        assert(DECISION_EVENTS.every(t => typesOf(S.member).has(t)), `the member's socket gets decision_created and decision_vote_cast (${show(S.member)})`);
        for (const [who, s] of keyed) {
            assert(DECISION_EVENTS.every(t => typesOf(s).has(t)) && bare(s), `${who} socket still gets both, bare, as before (${show(s)})`);
        }
        for (const [who, s] of keyless) {
            if (LISTINGS_ONLY) {
                assert(got(s).length === 0, `${who} socket gets no doorbell for it: an unsigned reader reads no Decision here (${show(s)})`);
            } else {
                assert(DECISION_EVENTS.every(t => typesOf(s).has(t)) && bare(s), `${who} socket gets both, bare, as before: the decisions are a public read here (${show(s)})`);
            }
        }

        // ── 4. a Commons project, placed on the map ─────────────────────────────────────────────
        if (MONEY_ON) {
            console.log('\n── 4. a Commons project proposed and placed on the map (the engine) ──');
            clear();
            const project = se.createProject(alice.pk, 'Doorbell project', 'A doorbell test project', 10);
            assert(!!project?.id, 'Alice proposes a Commons project');
            let placed = false;
            try { placed = se.setEnterpriseLocation(project!.id, alice.pk, { lat: -28.51, lng: 153.51 }).ok; } catch (e: any) { console.error(`  (threw: ${e?.message})`); }
            assert(placed, "Alice places the project's enterprise on the map");
            await until(S.member, 'enterprise_location_updated');
            const wanted = ['project_created', 'enterprise_location_updated'];
            assert(wanted.every(t => typesOf(S.member).has(t)), `the member's socket gets project_created and enterprise_location_updated (${show(S.member)})`);
            for (const [who, s] of keyed) {
                assert(wanted.every(t => typesOf(s).has(t)) && bare(s), `${who} socket still gets both, bare, as before (${show(s)})`);
            }
            for (const [who, s] of keyless) {
                if (LISTINGS_ONLY) {
                    assert(!wanted.some(t => typesOf(s).has(t)), `${who} socket gets no doorbell for either: projects and enterprises are members-only here (${show(s)})`);
                } else {
                    assert(wanted.every(t => typesOf(s).has(t)) && bare(s), `${who} socket gets both, bare, as before: they are public reads here (${show(s)})`);
                }
            }
        }
    }

    // ── 5. the table ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. the table: every public type, once each ──');
    clear();
    const PUBLIC = [...se.PUBLIC_WS_EVENTS];
    const keylessRow = LISTINGS_ONLY ? new Set([...LISTING_EVENTS, 'state_synced']) : new Set(PUBLIC);
    assert(keylessRow.size <= PUBLIC.length && [...keylessRow].every(t => se.PUBLIC_WS_EVENTS.has(t)), 'setup: this node\'s row of the table is within PUBLIC_WS_EVENTS');
    for (const type of PUBLIC) se.broadcast({ type, sweep: true });
    // An import that counted only groups (engine/sync.ts): its counts miss tables it writes, so it still rings.
    se.broadcast({ type: 'state_synced', newMembers: 0, newPosts: 0, updatedMembers: 0, updatedPosts: 0, tombstonesApplied: 0, groupChanges: 1, from: 'doorbell-test' });
    se.broadcast({ type: 'system_announcement', title: 'Doorbell sweep', body: 'members only', level: 'info' });
    await until(S.member, 'system_announcement');
    await sleep(200);

    const memberTypes = typesOf(S.member);
    assert(PUBLIC.every(t => memberTypes.has(t)) && memberTypes.has('system_announcement'), `the member's socket gets every type (${show(S.member)})`);
    assert(got(S.member).filter(e => e.type !== 'system_announcement' && e.type !== 'state_synced').every(e => e.sweep === true), "the member's socket gets each in full");
    assert(got(S.member).filter(e => e.type === 'state_synced').length === 2, "the member's socket gets both state_synced");
    for (const [who, s] of keyed) {
        const t = typesOf(s);
        assert(PUBLIC.every(x => t.has(x)) && !t.has('system_announcement') && bare(s), `${who} socket gets every public type, bare, and nothing else, as before (${show(s)})`);
    }
    for (const [who, s] of keyless) {
        const t = typesOf(s);
        const extra = [...t].filter(x => !keylessRow.has(x));
        const missing = [...keylessRow].filter(x => !t.has(x));
        assert(extra.length === 0 && missing.length === 0,
            `${who} socket gets exactly ${LISTINGS_ONLY ? 'the listings\' doorbells and state_synced' : 'every public type, as before'} (extra ${JSON.stringify(extra)}, missing ${JSON.stringify(missing)})`);
        assert(bare(s), `${who} socket gets them bare: { type } only`);
        assert(got(s).filter(e => e.type === 'state_synced').length === 2, `${who} socket gets state_synced for the import that counted only groups too`);
        assert(!t.has('system_announcement'), `${who} socket gets no member-only event`);
    }

    if (!STANDBY) {
        // ── 6. listings that leave the board, or come back, with no post event ──────────────────────
        console.log('\n── 6. listings that leave the board or come back with no post event of their own ──');
        const { createDecision, executeDecision, tickDecisions } = await import('./decisions-engine.js');
        /** The listings' ids an unsigned reader reads here: the guest view where the switch is on, the board elsewhere. */
        const board = async (): Promise<string[]> => {
            beforeCall();
            const res = await fetch(`${BASE}/api/marketplace/posts?limit=100`);
            const body = await res.json().catch(() => null);
            return Array.isArray(body) ? body.map((p: any) => p.id) : [];
        };
        const offer = async (who: Id, title: string): Promise<string> => {
            const made = await call(who, '/api/marketplace/posts', {
                type: 'offer', category: 'other', title, description: `${title}, a doorbell test`, authorPublicKey: who.pk, lat: -28.5, lng: 153.5,
            });
            const id = made.body?.post?.id as string | undefined;
            assert(made.status === 200 && !!id, `setup: "${title}" posted over HTTP (got ${made.status} ${JSON.stringify(made.body).slice(0, 120)})`);
            return id ?? '';
        };
        const listingDoorbells = (s: Sock) => got(s).filter(e => LISTING_EVENTS.includes(e.type));
        /**
         * After a change that no post event announces: every socket off the member feed gets exactly one bare `doorbell`
         * for it, however many listings it moved; the member's socket gets that change's own events, and no listing
         * doorbell, as before.
         */
        const rings = async (what: string, doorbell: 'post_removed' | 'post_updated', memberGets: string[]): Promise<void> => {
            await until(S.unsigned, doorbell);
            await until(S.member, memberGets[memberGets.length - 1]);
            for (const [who, s] of [...keyless, ...keyed]) {
                const bells = listingDoorbells(s);
                assert(bells.length === 1 && bells[0].type === doorbell && bare(s), `${what}: ${who} socket gets one bare ${doorbell} (${show(s)})`);
            }
            assert(memberGets.every(t => typesOf(S.member).has(t)), `${what}: the member's socket gets ${memberGets.join(', ')} as before (${show(S.member)})`);
            assert(listingDoorbells(S.member).length === 0, `${what}: the member's socket gets no listing doorbell, as before (${show(S.member)})`);
        };

        // A community removal: the Decision's grace runs out, tickDecisions prunes the member, and their listings go.
        const dora = member('DoorbellDora');
        const doraOffer = await offer(dora, 'Doorbell Dora offer');
        const proposer = member('DoorbellProposer', { earned: 50 });
        const removal = createDecision({ authorPubkey: proposer.pk, title: 'Remove Dora', description: 'A doorbell test of a community removal', touches: 'member',
            effect: 'remove_member', subject: dora.pk });
        const graced = executeDecision(removal.id);
        db.prepare('UPDATE decisions SET grace_period_ends_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), removal.id);
        assert(graced.status === 'execution_pending_grace' && (await board()).includes(doraOffer),
            `setup: the removal of Dora is in its grace, past its end, and an unsigned reader still reads her offer (${graced.status})`);
        await sleep(100);
        clear();
        const tick = tickDecisions();
        assert(tick.graceExpired === 1 && (db.prepare('SELECT status FROM members WHERE public_key = ?').get(dora.pk) as any)?.status === 'pruned',
            `the community removes Dora: tickDecisions prunes her (${JSON.stringify(tick)})`);
        await rings('a community removal', 'post_removed', ['user_pruned', 'decision_updated']);
        assert(!(await board()).includes(doraOffer), 'a community removal: an unsigned reader no longer reads her offer');

        // An admin prune of a member with two listings: one doorbell, not one per listing.
        const erin = member('DoorbellErin');
        const erinOffers = [await offer(erin, 'Doorbell Erin offer 1'), await offer(erin, 'Doorbell Erin offer 2')];
        await sleep(100);
        clear();
        se.adminPruneUser(erin.pk, 'owner:password');
        await rings('an admin prune', 'post_removed', ['profile_updated', 'user_pruned']);
        const afterPrune = await board();
        assert(erinOffers.every(id => !afterPrune.includes(id)), 'an admin prune: an unsigned reader reads neither of her offers');

        // An enterprise with a listing: paused and resumed, winding up and not, and paused when its only keeper, the lead,
        // is unbound (promoteOrPauseAfterLeadLeft).
        const { publicKey: shed } = se.createTreasury('DoorbellShed', 'https://example.com/shed.jpg', 0);
        const lead = member('DoorbellLead', { earned: 10 });
        se.adminAssignTreasuryOperator(shed, lead.pk);
        db.prepare("UPDATE treasury_operators SET role = 'lead' WHERE treasury_pubkey = ? AND member_pubkey = ?").run(shed, lead.pk);
        const shedOffer = se.createPost('offer', 'tools', 'Doorbell shovel', 'A doorbell test listing of an enterprise', 0, 'fixed', shed)?.id ?? '';
        assert(!!shedOffer && (await board()).includes(shedOffer), 'setup: an enterprise lists an offer, and an unsigned reader reads it');
        const step = async (what: string, act: () => unknown, doorbell: 'post_removed' | 'post_updated', shown: boolean, memberGets: string[]): Promise<void> => {
            await sleep(100);
            clear();
            act();
            await rings(what, doorbell, memberGets);
            assert((await board()).includes(shedOffer) === shown, `${what}: an unsigned reader ${shown ? 'reads its offer again' : 'no longer reads its offer'}`);
        };
        await step('an enterprise paused', () => se.pauseEnterprise(shed, 'owner:password'), 'post_removed', false, ['profile_updated', 'enterprise_paused']);
        await step('the enterprise resumed', () => se.resumeEnterprise(shed, 'owner:password'), 'post_updated', true, ['profile_updated', 'enterprise_resumed']);
        await step('the enterprise winding up', () => se.initiateWindUp(shed, lead.pk), 'post_removed', false, ['profile_updated', 'enterprise_winding_up']);
        await step('its wind-up cancelled', () => se.cancelWindUp(shed, lead.pk), 'post_updated', true, ['profile_updated', 'enterprise_wind_up_cancelled']);
        await step('its only keeper, the lead, unbound: it pauses', () => se.adminRevokeTreasuryOperator(shed, lead.pk), 'post_removed', false, ['profile_updated']);

        // Holiday mode, on and off.
        const fay = member('DoorbellFay');
        const fayOffer = await offer(fay, 'Doorbell Fay offer');
        await sleep(100);
        clear();
        se.setHolidayMode(fay.pk, true);
        await rings('a member on holiday', 'post_removed', ['profile_updated']);
        assert(!(await board()).includes(fayOffer), 'a member on holiday: an unsigned reader no longer reads her offer');
        await sleep(100);
        clear();
        se.setHolidayMode(fay.pk, false);
        await rings('back from holiday', 'post_updated', ['profile_updated']);
        assert((await board()).includes(fayOffer), 'back from holiday: an unsigned reader reads her offer again');

        // A report actioned with a suspension: the member's listings are paused.
        const gus = member('DoorbellGus');
        const gusOffer = await offer(gus, 'Doorbell Gus offer');
        db.prepare("INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, reason, status) VALUES ('doorbell-report', ?, ?, 'spam', 'pending')").run(carol.pk, gus.pk);
        await sleep(100);
        clear();
        assert(se.actionReport('doorbell-report', false, true), 'a moderator actions a report on Gus and suspends him');
        await rings("a report's suspension", 'post_removed', ['profile_updated']);
        assert(!(await board()).includes(gusOffer), "a report's suspension: an unsigned reader no longer reads his offer");

        // Delete account, over HTTP.
        const hal = member('DoorbellHal');
        const halOffer = await offer(hal, 'Doorbell Hal offer');
        await sleep(100);
        clear();
        const purged = await call(hal, '/api/member/purge', {});
        assert(purged.status === 200, `Hal deletes his account (got ${purged.status} ${JSON.stringify(purged.body).slice(0, 120)})`);
        await rings('a Delete account', 'post_removed', ['profile_updated', 'user_pruned']);
        assert(!(await board()).includes(halOffer), 'a Delete account: an unsigned reader no longer reads his offer');

        // A trade's step on a members-only listing: the member socket gets the bare doorbell as before,
        // and no socket off the member feed is rung.
        db.prepare("INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope) VALUES ('doorbell-trade-group', 'offer', 'other', 'Group trade', 'desc', 1, ?, 'group')").run(alice.pk);
        await sleep(100);
        clear();
        se.broadcast({ type: 'post_accepted', postId: 'doorbell-trade-group', transaction: { id: 'doorbell-trade-group-tx' } }, [alice.pk], { othersGetDoorbell: true });
        await until(S.member, 'post_accepted');
        await sleep(50);
        for (const [who, s] of [...keyless, ...keyed]) {
            assert(!typesOf(s).has('post_updated') && !typesOf(s).has('post_accepted'), `a trade's step on a members-only listing: ${who} socket gets no doorbell (${show(s)})`);
        }
        assert(typesOf(S.member).has('post_accepted') && bare(S.member) && listingDoorbells(S.member).length === 0,
            `a trade's step on a members-only listing: the member's socket gets the bare post_accepted (${show(S.member)})`);

        // A trade's step on a public listing, sent to its parties with a bare doorbell for the other members (othersGetDoorbell):
        // the listing went pending, came back or went, so every socket off the member feed gets the listings' doorbell.
        db.prepare("INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope) VALUES ('doorbell-trade', 'offer', 'other', 'Public trade', 'desc', 1, ?, 'public')").run(alice.pk);
        await sleep(100);
        clear();
        se.broadcast({ type: 'post_accepted', postId: 'doorbell-trade', transaction: { id: 'doorbell-trade-tx' } }, [alice.pk], { othersGetDoorbell: true });
        await until(S.member, 'post_accepted');
        await until(S.unsigned, 'post_updated');
        for (const [who, s] of [...keyless, ...keyed]) {
            assert(typesOf(s).has('post_updated') && !typesOf(s).has('post_accepted') && bare(s), `a trade's step: ${who} socket gets a bare post_updated, and not the trade's own event (${show(s)})`);
        }
        assert(typesOf(S.member).has('post_accepted') && bare(S.member) && listingDoorbells(S.member).length === 0,
            `a trade's step: the member's socket, no party to it, gets the bare post_accepted as before, and no listing doorbell (${show(S.member)})`);
    }

    for (const s of Object.values(S)) s.ws.close();

    // ── the other node kinds, each in a fresh process ───────────────────────────────────────────
    if (process.env.DOORBELL_CHILD !== '1') {
        for (const combo of ['local+guest', 'local', 'standby-read-open'] as const) {
            console.log(`\n── the ${combo} node, in its own process ──`);
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `beanpool-doorbells-${combo.replace('+', '-')}-`));
            ownedDirs.add(dataDir);
            const env: NodeJS.ProcessEnv = { ...process.env, DOORBELL_COMBO: combo, DOORBELL_CHILD: '1', BEANPOOL_DATA_DIR: dataDir };
            const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
            children.add(child);
            const status = await new Promise<number | null>(resolve => {
                child.on('exit', code => resolve(code));
                child.on('error', () => resolve(null));
            });
            children.delete(child);
            fs.rmSync(dataDir, { recursive: true, force: true });
            ownedDirs.delete(dataDir);
            assert(status === 0, `the ${combo} run passed (exit ${status})`);
        }
    }

    console.log(`\n${MODE} ${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log(`⭐️ ${MODE} a key-less socket's doorbells: PASSED.`);
}
main().then(() => process.exit(0)).catch(e => { console.error(`❌ ${MODE} Test failed:`, e); process.exit(1); });
