/**
 * A member's card edit reaches, live, the people who see that card; on the global node nobody else is sent it, and
 * everyone reads it at their next sync. And a phone's read of the member list never misses a change.
 *
 * Found in the global node's load rehearsal (scratch/global-node/REPORT-global-load-rehearsal.md §3): every member's
 * socket heard `profile_updated` for every new photo, and each app ran its whole sync on it (about ten requests). 2,400
 * photos set in a minute to 3,500 sockets were 8.4 million frames and a whole core, before those syncs. #1422 did the
 * same for `member_joined`. Now on global (node-profile.ts announceProfiles) a card edit goes to the member's own
 * sockets and to the members who share a conversation with them; the versions move as before.
 *
 * Over real HTTP and WebSockets on the plain listener (each client told apart by CF-Connecting-IP), the edits through
 * POST /api/profile/update, signed:
 *   1. Local, unchanged: a card edit reaches every member's socket; a stranger's socket hears nothing of it.
 *   2. Global: a new photo, then a new name, reach the member's own two sockets (a phone and a web app), a member in a
 *      direct conversation with them and one in a group conversation with them, and no other member's socket, nor a
 *      stranger's, nor that of a member in a conversation with the DM partner only. The members' and the listings'
 *      versions still move: an unrelated member's held ETag of the list gets the list again (200, not 304), with the
 *      new photo and name, the delta from before the edit has them, and the board shows the new name on the member's
 *      listing.
 *   3. Global, a change of standing is no card edit and still reaches every member: a tier badge, a vouch. The
 *      operator's node_config row nodeProfile.announceProfiles = true puts card edits back on every socket.
 *   4. The member list never misses a change: a node role granted and revoked, a vouch and its withdrawal, and a tier
 *      badge each move the list's ETag (a held one is answered 200) and put the member's row in the next delta, with
 *      the new role, voucher or credit. Neither moved for a role, and none was in a delta (#1467's finding).
 *
 * On origin/main sections 2 and 4 fail; 1 and 3 pin what must not change, and pass there by design.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-profile-fanout.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { localFetch } from './keepalive-test-fetch.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(id: Id, method: string, path: string, body = ''): Record<string, string> {
    const ts = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`), id.privateKey).toString('base64');
    return { 'X-Public-Key': id.pubKeyHex, 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce };
}
function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}&nr=1`;
}

type Sock = { ws: WebSocket; events: any[] };
function openSocket(url: string, ip: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { headers: { 'cf-connecting-ip': ip } });
        const events: any[] = [];
        ws.on('message', (d) => { try { events.push(JSON.parse(d.toString())); } catch { /* not JSON */ } });
        ws.on('open', () => resolve({ ws, events }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket timeout')), 8000);
    });
}
/** The `profile_updated` events about `pk` a socket has heard since `from`. */
const heard = (s: Sock, pk: string, from = 0) => s.events.slice(from).filter(e => e.type === 'profile_updated' && e.publicKey === pk).length;

async function main() {
    console.log("A member's card edit reaches the people who see that card...\n");
    const wsl: any = await import('./ws-limits.js');
    const { initTls } = await import('./services/tls.js');
    const se: any = await import('./state-engine.js');
    const { startHttpServer } = await import('./http-server.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initAdminPassword, updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { db } = await import('./db/db.js');
    const { getMembersVersion, getPostsVersion } = await import('./engine/versions.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { grantNodeRole, revokeNodeRole } = await import('./engine/node-roles.js');
    const { setMemberPhoto } = await import('@beanpool/engine');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const httpPort = await startHttpServer(0);
    await startHttpsServer(0);
    const BASE = `http://127.0.0.1:${httpPort}`;
    const WS = `ws://127.0.0.1:${httpPort}/ws`;
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    const setProfile = (p: 'local' | 'global') => {
        if (p === 'global') process.env.NODE_PROFILE = 'global'; else delete process.env.NODE_PROFILE;
        wsl.setWsLimitsForTests?.(undefined);
    };

    // Members two months old, past any new account's limits.
    const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days'), 'seed', 'seed')`);
    const insertAccount = db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)');
    const member = (callsign: string): Id => {
        const id = keypair();
        insertMember.run(id.pubKeyHex, callsign);
        setMemberPhoto(db, id.pubKeyHex, 'bundled://avatar-1');
        insertAccount.run(id.pubKeyHex);
        return id;
    };
    const conversation = (type: 'dm' | 'group', ...who: Id[]) => {
        const id = crypto.randomUUID();
        db.prepare('INSERT INTO conversations (id, type, created_by, name) VALUES (?, ?, ?, ?)').run(id, type, who[0].pubKeyHex, type === 'group' ? 'Garden group' : null);
        for (const w of who) db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(id, w.pubKeyHex);
    };

    const pia = member('Pia');        // edits her card
    const dan = member('Dan');        // a DM with Pia
    const gus = member('Gus');        // a group conversation with Pia (and Dan)
    const olive = member('Olive');    // no conversation with Pia
    const vic = member('Vic');        // a DM with Dan only
    conversation('dm', pia, dan);
    conversation('group', gus, pia, dan);
    conversation('dm', dan, vic);
    db.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey, lat, lng) VALUES ('pf-pia-post', 'offer', 'food', 'Lemons', 'From the tree.', ?, -28.5, 153.5)`)
        .run(pia.pubKeyHex);

    async function post(id: Id, path: string, body: any): Promise<{ status: number; json: any }> {
        const raw = JSON.stringify(body);
        const res = await localFetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.20', ...signedHeaders(id, 'POST', path, raw) }, body: raw });
        const text = await res.text();
        let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json };
    }
    async function get(id: Id, path: string, etag?: string): Promise<{ status: number; json: any; etag: string | null }> {
        const headers: Record<string, string> = { 'cf-connecting-ip': '198.51.100.21', ...signedHeaders(id, 'GET', path) };
        if (etag) headers['if-none-match'] = etag;
        const res = await localFetch(`${BASE}${path}`, { headers });
        const text = await res.text();
        let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON, or a 304 */ }
        return { status: res.status, json, etag: res.headers.get('etag') };
    }
    const sockets = async () => ({
        piaPhone: await openSocket(`${WS}?${signedWsQuery(pia)}`, '203.0.113.1'),
        piaWeb: await openSocket(`${WS}?${signedWsQuery(pia)}`, '203.0.113.2'),
        dan: await openSocket(`${WS}?${signedWsQuery(dan)}`, '203.0.113.3'),
        gus: await openSocket(`${WS}?${signedWsQuery(gus)}`, '203.0.113.4'),
        olive: await openSocket(`${WS}?${signedWsQuery(olive)}`, '203.0.113.5'),
        vic: await openSocket(`${WS}?${signedWsQuery(vic)}`, '203.0.113.6'),
        stranger: await openSocket(`${WS}?nr=1`, '203.0.113.7'),
    });
    const closeAll = async (s: Record<string, Sock>) => { for (const x of Object.values(s)) x.ws.close(); await sleep(200); };
    const report = (s: Record<string, Sock>, pk: string, from: Record<string, number> = {}) =>
        Object.entries(s).map(([k, x]) => `${k} ${heard(x, pk, from[k] ?? 0)}`).join(', ');
    const marks = (s: Record<string, Sock>) => Object.fromEntries(Object.entries(s).map(([k, x]) => [k, x.events.length]));

    // ── 1. Local, unchanged ──────────────────────────────────────────────────────────────────────────────────────────
    console.log('— 1. local: every member hears a card edit —');
    {
        setProfile('local');
        const s = await sockets();
        await sleep(200);
        const r = await post(pia, '/api/profile/update', { avatar: 'bundled://avatar-2' });
        await sleep(400);
        assert(r.status === 200, `the edit is saved (${r.status})`);
        const members = ['piaPhone', 'piaWeb', 'dan', 'gus', 'olive', 'vic'] as const;
        assert(members.every(k => heard(s[k], pia.pubKeyHex) === 1) && heard(s.stranger, pia.pubKeyHex) === 0,
            `every member's socket hears it once, a stranger's nothing (${report(s, pia.pubKeyHex)})`);
        await closeAll(s);
    }

    // ── 2. Global: the card's circle only ────────────────────────────────────────────────────────────────────────────
    console.log("\n— 2. global: a card edit reaches the member's circle, and everyone's next read —");
    {
        setProfile('global');
        const s = await sockets();
        await sleep(200);
        const list0 = await get(olive, '/api/members');
        const cursor = new Date(Date.now() - 1).toISOString();
        const board0 = await get(olive, '/api/marketplace/posts');
        const mv = getMembersVersion(), pv = getPostsVersion();
        await sleep(5);

        const photo = await post(pia, '/api/profile/update', { avatar: 'bundled://avatar-3' });
        await sleep(400);
        assert(photo.status === 200, `a new photo is saved (${photo.status})`);
        const inCircle = ['piaPhone', 'piaWeb', 'dan', 'gus'] as const;
        const outside = ['olive', 'vic', 'stranger'] as const;
        assert(inCircle.every(k => heard(s[k], pia.pubKeyHex) === 1),
            `her own two sockets, her DM partner and her group's member hear it (${report(s, pia.pubKeyHex)})`);
        assert(outside.every(k => heard(s[k], pia.pubKeyHex) === 0),
            `no other member's socket, nor a stranger's, nor her DM partner's other contact's (${report(s, pia.pubKeyHex)})`);
        assert(getMembersVersion() > mv && getPostsVersion() > pv, `the members' and listings' versions still move (${mv} → ${getMembersVersion()}, ${pv} → ${getPostsVersion()})`);

        const m1 = marks(s);
        const rename = await post(pia, '/api/profile/update', { callsign: 'Pia Lemon' });
        await sleep(400);
        assert(rename.status === 200 && inCircle.every(k => heard(s[k], pia.pubKeyHex, m1[k]) === 1) && outside.every(k => heard(s[k], pia.pubKeyHex, m1[k]) === 0),
            `a new name goes the same way (${report(s, pia.pubKeyHex, m1)})`);

        // Olive's next sync: the list she held is not confirmed, and both reads of it have the new card.
        const list1 = await get(olive, '/api/members', list0.etag ?? undefined);
        const piaRow = (list1.json ?? []).find((m: any) => m.publicKey === pia.pubKeyHex);
        const piaBefore = (list0.json ?? []).find((m: any) => m.publicKey === pia.pubKeyHex);
        assert(list1.status === 200 && !!piaRow && piaRow.callsign === 'Pia Lemon' && piaRow.avatarUrl !== piaBefore?.avatarUrl,
            `an unrelated member's held list is read again (${list1.status}), with the new name and photo (${piaRow?.callsign}, ${piaBefore?.avatarUrl} → ${piaRow?.avatarUrl})`);
        const delta = await get(olive, `/api/members?updatedAfter=${encodeURIComponent(cursor)}`);
        const piaDelta = (delta.json ?? []).find((m: any) => m.publicKey === pia.pubKeyHex);
        assert(delta.status === 200 && piaDelta?.callsign === 'Pia Lemon' && piaDelta?.avatarUrl === piaRow?.avatarUrl,
            `and her delta from before the edit has the new card (${piaDelta?.callsign})`);
        const board1 = await get(olive, '/api/marketplace/posts', board0.etag ?? undefined);
        const listing = (board1.json ?? []).find((p: any) => p.id === 'pf-pia-post');
        assert(board1.status === 200 && listing?.authorCallsign === 'Pia Lemon',
            `and her held board is read again (${board1.status}), Pia's listing under her new name (${listing?.authorCallsign})`);
        await closeAll(s);
    }

    // ── 3. Global: standing still reaches everyone; the operator can put card edits back ──────────────────────────────
    console.log('\n— 3. global: a change of standing reaches every member; the override puts card edits back —');
    {
        setProfile('global');
        const s = await sockets();
        await sleep(200);
        se.adminSetTier(pia.pubKeyHex, 'Resident');
        await sleep(300);
        const members = ['piaPhone', 'piaWeb', 'dan', 'gus', 'olive', 'vic'] as const;
        assert(members.every(k => heard(s[k], pia.pubKeyHex) === 1), `a tier badge reaches every member's socket (${report(s, pia.pubKeyHex)})`);
        se.adminSetVoucher(gus.pubKeyHex, true);
        const m2 = marks(s);
        se.vouchMember(gus.pubKeyHex, pia.pubKeyHex, 1);
        await sleep(300);
        assert(members.every(k => heard(s[k], pia.pubKeyHex, m2[k]) === 1), `so does a vouch (${report(s, pia.pubKeyHex, m2)})`);

        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.announceProfiles`, 'true');
        const m3 = marks(s);
        await post(pia, '/api/profile/update', { bio: 'Lemons, mostly.' });
        await sleep(400);
        assert(members.every(k => heard(s[k], pia.pubKeyHex, m3[k]) === 1) && heard(s.stranger, pia.pubKeyHex, m3.stranger) === 0,
            `the operator's nodeProfile.announceProfiles = true puts a card edit on every member's socket (${report(s, pia.pubKeyHex, m3)})`);
        db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.announceProfiles`);
        await closeAll(s);
    }

    // ── 4. The member list never misses a change ─────────────────────────────────────────────────────────────────────
    console.log('\n— 4. the member list: every change moves its ETag and is in the next delta —');
    {
        const wes = member('Wes');
        /** Hold the list's ETag and a cursor, make the change, then read both as a phone's sync does. */
        async function afterChange(what: string, change: () => void, field: string, want: (row: any) => boolean) {
            const held = await get(olive, '/api/members');
            const cursor = new Date(Date.now() - 1).toISOString();
            await sleep(5);
            change();
            const full = await get(olive, '/api/members', held.etag ?? undefined);
            const row = (full.json ?? []).find((m: any) => m.publicKey === wes.pubKeyHex);
            assert(full.status === 200 && !!row && want(row),
                `${what}: a held ETag of the list is not confirmed (${full.status}), and the list has it (${field} ${JSON.stringify(row?.[field])})`);
            const delta = await get(olive, `/api/members?updatedAfter=${encodeURIComponent(cursor)}`);
            const inDelta = (delta.json ?? []).find((m: any) => m.publicKey === wes.pubKeyHex);
            assert(delta.status === 200 && !!inDelta && want(inDelta),
                `${what}: the next delta has the member's row (${inDelta ? `${field} ${JSON.stringify(inDelta[field])}` : 'not in it'})`);
        }
        await afterChange('a node role granted', () => grantNodeRole(wes.pubKeyHex, 'moderator', 'owner:password'), 'nodeRole', r => r.nodeRole === 'moderator');
        await afterChange('a node role revoked', () => revokeNodeRole(wes.pubKeyHex, 'moderator', 'owner:password'), 'nodeRole', r => r.nodeRole === null);
        await afterChange('a vouch', () => se.vouchMember(gus.pubKeyHex, wes.pubKeyHex, 1), 'elderVouchedBy', r => r.elderVouchedBy === gus.pubKeyHex);
        await afterChange('a vouch withdrawn', () => se.unvouchMember(gus.pubKeyHex, wes.pubKeyHex), 'elderVouchedBy', r => r.elderVouchedBy === null);
        await afterChange('a tier badge', () => se.adminSetTier(wes.pubKeyHex, 'Steward'), 'earnedCredit', r => r.earnedCredit > 0);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
