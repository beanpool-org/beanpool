/**
 * Who voted for what in a poll reaches the members of this node, and nobody else — on every read and every live update.
 *
 * GET /api/marketplace/posts is a public read on every node (the marketplace board), and each poll in it carried
 * `pollVotes`: every voter's public key, name and chosen option. So anyone who could reach a node, unsigned, from
 * anywhere, could read how each member voted in every poll (found on main by the director, 2026-09-25). Marty's
 * answer: members only, on every node. Members seeing the voters is the open ballot the apps promise ("Your vote is
 * visible to members", "View voters"); everyone else gets the counts.
 *
 * A member is a verified signer whose member row exists, isn't pruned, and whose key the node hasn't invalidated: the
 * test the People list applies (isNodeMember).
 *
 * Boots the real server and reads every place a poll leaves it — the board, a type filter, a read by id, a sync read and
 * a delta read, the vote and close responses, and the /ws `post_updated` a vote sends — as:
 *   - nobody (unsigned),
 *   - a signed key that is not a member here,
 *   - a pruned member (the row stays and the key can still sign),
 *   - the old key of a member whose phone was lost or stolen: an operator has issued a re-key code (issueRekeyCode), so the
 *     node has invalidated that key, though the row stays and the key can still sign until the new phone binds a new one
 *     (completeRekey). Read on a socket it opened while it was a member, on one it opens after, and over HTTP; then the
 *     member's NEW key once the re-key completes, which gets the voters again,
 *   - members: a reader, the voter and the author.
 * Only the members get `pollVotes`; everyone gets `totalVotes` and each option's `votes` and `percentage`. The check on
 * the non-members is a search of the raw text for the voter's key and name, so a voter riding along under any field
 * name is caught.
 *
 * Runs twice: here with every ENFORCE_* variable REMOVED (the fresh-download default: read auth on, member-only /ws
 * feed), then in a child process with ENFORCE_READ_AUTH=false and ENFORCE_WS_AUTH=false (read auth off, the open /ws
 * feed), where a socket nobody signed gets every post in full.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-poll-voters-members-only.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// The open node is the child run below; the flags are module consts read at import, so they are settled before the
// dynamic imports in main().
const OPEN_NODE = process.env.POLL_VOTERS_OPEN_NODE === '1';
if (!OPEN_NODE) {
    delete process.env.ENFORCE_READ_AUTH;
    delete process.env.ENFORCE_WS_AUTH;
    delete process.env.ENFORCE_LEDGER_AUTH;
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const MODE = OPEN_NODE ? '[read auth off, open /ws feed]' : '[defaults]';
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

function signedHeaders(method: string, path: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

async function get(path: string, id?: Id, extra: Record<string, string> = {}): Promise<{ status: number; text: string; etag: string | null }> {
    const res = await fetch(`${BASE}${path}`, { headers: { ...(id ? signedHeaders('GET', path, '', id) : {}), ...extra } });
    return { status: res.status, text: await res.text(), etag: res.headers.get('etag') };
}

async function post(path: string, payload: unknown, id: Id): Promise<{ status: number; text: string; body: any }> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', path, body, id) },
        body,
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, text, body: json };
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

function openSocket(url: string): Promise<{ ws: WebSocket; events: any[]; raw: string[] }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const events: any[] = [];
        const raw: string[] = [];
        ws.on('message', (d) => { raw.push(d.toString()); try { events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve({ ws, events, raw }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

async function main() {
    console.log(`Poll voters reach members only ${MODE}...\n`);
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, createPost } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const seed = (callsign: string, status = 'active'): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url)
                    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?)`)
            .run(id.pubKeyHex, callsign, status, `INV-${callsign.toUpperCase()}`, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const author = seed('PollAuthor');
    const voter = seed('VoterBob');
    const reader = seed('ReaderCarol');
    const pruned = seed('PrunedPat', 'pruned');
    const rekeyed = seed('RekeyRon'); // a member until the re-key code below invalidates this key
    const guest = keypair(); // signs, but is not a member here

    const poll = createPost('poll', 'community', 'Where should the tool library go?', '', 0, 'fixed', author.pubKeyHex,
        undefined, undefined, undefined, false, undefined, false,
        { pollOptions: [{ id: 'opt_hall', text: 'The hall' }, { id: 'opt_shed', text: 'The shed' }] });
    assert(!!poll?.id, 'the author opens a poll');
    const pollId = poll!.id;

    /** Anything that names the voter: their key or their name. */
    const namesVoter = (text: string) => text.includes(voter.pubKeyHex) || text.includes('VoterBob');

    console.log('── the /ws post_updated a vote sends ──');
    const wsBase = `${BASE.replace('https', 'wss')}/ws`;
    const sockets = {
        member: await openSocket(`${wsBase}?${signedWsQuery(reader)}`),
        pruned: await openSocket(`${wsBase}?${signedWsQuery(pruned)}`),
        guest: await openSocket(`${wsBase}?${signedWsQuery(guest)}`),
        unsigned: await openSocket(wsBase),
        // Opened while RekeyRon is still a member: the re-key must stop it being a member socket, as a prune does.
        rekeyOpenBefore: await openSocket(`${wsBase}?${signedWsQuery(rekeyed)}`),
    };
    await sleep(200);
    // RekeyRon's phone is lost: an operator issues a re-key code. The old key stays on the phone and can still sign.
    const rekeyCode = issueRekeyCode(rekeyed.pubKeyHex, 'owner:password').code;
    const rekeyAfter = await openSocket(`${wsBase}?${signedWsQuery(rekeyed)}`);
    await sleep(200);

    const voted = await post(`/api/marketplace/posts/${pollId}/vote`, { optionId: 'opt_shed' }, voter);
    assert(voted.status === 200 && voted.body?.success === true, `the voter votes over HTTP (got ${voted.status} ${voted.text.slice(0, 120)})`);
    assert(Array.isArray(voted.body?.post?.pollVotes) && voted.body.post.pollVotes.some((v: any) => v.voterPubkey === voter.pubKeyHex && v.optionId === 'opt_shed'),
        'the vote response gives the voter, a member, the voter list with their own vote in it');
    await sleep(400);

    const updatesFor = (s: { events: any[] }) => s.events.filter(e => e.type === 'post_updated');
    {
        const ev = updatesFor(sockets.member).find(e => e.post?.id === pollId);
        assert(!!ev && Array.isArray(ev.post.pollVotes) && ev.post.pollVotes.some((v: any) => v.voterPubkey === voter.pubKeyHex && v.optionId === 'opt_shed'),
            "a member's socket gets post_updated with the voter list");
        const nonMemberSockets = [
            ['a pruned member', sockets.pruned], ['a signed non-member', sockets.guest], ['an unsigned', sockets.unsigned],
            // "…'s already-open socket": opened while a member; "…'s newly opened socket": opened after the re-key code.
            ["a re-key-pending key's already-open", sockets.rekeyOpenBefore],
            ["a re-key-pending key's newly opened", rekeyAfter],
        ] as const;
        for (const [label, s] of nonMemberSockets) {
            const updates = updatesFor(s);
            assert(updates.length > 0, `${label} socket still hears that the poll changed (${updates.length} post_updated)`);
            assert(!s.raw.some(namesVoter), `${label} socket is sent nothing that names the voter`);
            assert(updates.every(e => e.post === undefined || !('pollVotes' in e.post)), `${label} socket gets no pollVotes field`);
            if (OPEN_NODE) {
                // The open feed sends every socket the whole post: the counts still ride along, only the voters come off.
                const full = updates.find(e => e.post?.id === pollId);
                assert(!!full && full.post.totalVotes === 1 && full.post.pollOptions?.find((o: any) => o.id === 'opt_shed')?.votes === 1,
                    `${label} socket on the open feed gets the post with its counts (totalVotes ${full?.post?.totalVotes})`);
            }
        }
    }
    // The re-key sockets stay open for the close below, after the re-key completes.
    for (const s of [sockets.member, sockets.pruned, sockets.guest, sockets.unsigned]) s.ws.close();

    console.log('\n── every read of the poll ──');
    const PATHS = [
        '/api/marketplace/posts',
        '/api/marketplace/posts?type=poll',
        `/api/marketplace/posts?id=${pollId}`,
        '/api/marketplace/posts?sync=true',
        '/api/marketplace/posts?updatedAfter=2000-01-01T00:00:00.000Z',
    ];
    const viewers: [string, Id | undefined, boolean][] = [
        ['nobody (unsigned)', undefined, false],
        ['a signed non-member', guest, false],
        ['a pruned member', pruned, false],
        ['a re-key-pending key', rekeyed, false],
        ['a member', reader, true],
        ['the voter', voter, true],
        ['the author', author, true],
    ];
    for (const path of PATHS) {
        for (const [label, id, isMember] of viewers) {
            const r = await get(path, id);
            if (id === rekeyed) {
                // A replaced key is refused whatever it signs, a public read included (https-server.ts
                // REPLACED_KEY_REFUSAL, #1177). This was a 200 with the counts and no voters, as for any non-member.
                assert(r.status === 403 && JSON.parse(r.text)?.code === 'key_invalidated' && !namesVoter(r.text),
                    `${label} is refused ${path}, 403 key_invalidated, and sent nothing that names the voter (got ${r.status})`);
                continue;
            }
            assert(r.status === 200, `${label} reads ${path} → 200 (got ${r.status})`);
            let rows: any[] = [];
            try { rows = JSON.parse(r.text); } catch { /* */ }
            const p = rows.find(x => x.id === pollId);
            assert(!!p, `${label} finds the poll in ${path}`);
            const shed = p?.pollOptions?.find((o: any) => o.id === 'opt_shed');
            const hall = p?.pollOptions?.find((o: any) => o.id === 'opt_hall');
            assert(p?.totalVotes === 1 && shed?.votes === 1 && shed?.percentage === 100 && hall?.votes === 0,
                `${label} gets the counts on ${path} (totalVotes ${p?.totalVotes}, shed ${shed?.votes}/${shed?.percentage}%)`);
            if (isMember) {
                assert(Array.isArray(p?.pollVotes) && p.pollVotes.length === 1 && p.pollVotes[0].voterPubkey === voter.pubKeyHex
                    && p.pollVotes[0].optionId === 'opt_shed' && p.pollVotes[0].voterCallsign === 'VoterBob',
                    `${label} gets the voter list on ${path}`);
            } else {
                assert(p && !('pollVotes' in p), `${label} gets no pollVotes field on ${path}`);
                assert(!namesVoter(r.text), `${label} is sent nothing that names the voter on ${path}`);
            }
        }
    }

    console.log('\n── the re-key completes: the new key is a member, the old one never again ──');
    const newKey = keypair();
    completeRekey(rekeyed.pubKeyHex, newKey.pubKeyHex, rekeyCode, 'owner:password');
    for (const path of PATHS) {
        for (const [label, id, isMember] of [['the new key', newKey, true], ['the replaced old key', rekeyed, false]] as const) {
            const r = await get(path, id);
            let rows: any[] = [];
            try { rows = JSON.parse(r.text); } catch { /* */ }
            const p = Array.isArray(rows) ? rows.find(x => x.id === pollId) : undefined;
            if (isMember) {
                assert(r.status === 200 && Array.isArray(p?.pollVotes) && p.pollVotes.some((v: any) => v.voterPubkey === voter.pubKeyHex),
                    `${label} gets the voter list on ${path} (got ${r.status})`);
            } else {
                // Refused outright, as above (this was a 200 with the poll and no voters).
                assert(r.status === 403 && JSON.parse(r.text)?.code === 'key_invalidated' && !namesVoter(r.text),
                    `${label} is refused ${path}, 403 key_invalidated, and sent nothing that names the voter (got ${r.status})`);
            }
        }
    }
    const newKeySocket = await openSocket(`${wsBase}?${signedWsQuery(newKey)}`);
    const oldKeySocket = await openSocket(`${wsBase}?${signedWsQuery(rekeyed)}`);
    await sleep(200);

    console.log('\n── a cached copy is not confirmed across joining ──');
    {
        // Membership changes what the board holds without changing any post, so the ETag carries it: a copy fetched
        // before joining must not be confirmed with a 304 afterwards.
        const newcomer = keypair();
        const before = await get('/api/marketplace/posts', newcomer);
        assert(before.status === 200 && !namesVoter(before.text), 'before joining, the newcomer reads the board without the voters');
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url)
                    VALUES (?, 'Newcomer', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'INV-NEWCOMER', ?)`).run(newcomer.pubKeyHex, AVATAR);
        const after = await get('/api/marketplace/posts', newcomer, { 'If-None-Match': before.etag || '' });
        assert(after.status === 200, `after joining, the old ETag no longer answers 304 (got ${after.status})`);
        assert(namesVoter(after.text), 'and the fresh board has the voter list');
    }

    console.log('\n── the close response ──');
    {
        const closed = await post(`/api/marketplace/posts/${pollId}/close`, {}, author);
        assert(closed.status === 200 && closed.body?.post?.status === 'completed', `the author closes the poll (got ${closed.status})`);
        assert(Array.isArray(closed.body?.post?.pollVotes) && closed.body.post.pollVotes.length === 1,
            'the close response gives the author, a member, the voter list');
        await sleep(400);
        const closedEv = (s: { events: any[] }) => updatesFor(s).find(e => e.post?.id === pollId && e.post?.status === 'completed');
        const mine = closedEv(newKeySocket);
        assert(!!mine && Array.isArray(mine.post.pollVotes) && mine.post.pollVotes.some((v: any) => v.voterPubkey === voter.pubKeyHex),
            "the new key's socket gets the close's post_updated with the voter list");
        for (const [label, s] of [
            ['the old key\'s socket opened while a member', sockets.rekeyOpenBefore],
            ['the old key\'s socket opened while the re-key was pending', rekeyAfter],
            ['the old key\'s socket opened after the re-key completed', oldKeySocket],
        ] as const) {
            const updates = updatesFor(s);
            assert(updates.length > 0, `${label} still hears that the poll changed (${updates.length} post_updated)`);
            assert(!s.raw.some(namesVoter), `${label} is sent nothing that names the voter`);
            assert(updates.every(e => e.post === undefined || !('pollVotes' in e.post)), `${label} gets no pollVotes field`);
        }
        for (const s of [sockets.rekeyOpenBefore, rekeyAfter, newKeySocket, oldKeySocket]) s.ws.close();
    }

    console.log(`\n${passed}/${run} checks passed ${MODE}.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed ${MODE}`);

    if (!OPEN_NODE) {
        // The same checks on a node with read auth off and the open /ws feed, in a fresh process and data dir.
        console.log('\nAgain with ENFORCE_READ_AUTH=false and ENFORCE_WS_AUTH=false...\n');
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-poll-voters-open-'));
        const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
            env: { ...process.env, POLL_VOTERS_OPEN_NODE: '1', ENFORCE_READ_AUTH: 'false', ENFORCE_WS_AUTH: 'false', BEANPOOL_DATA_DIR: dataDir },
            stdio: 'inherit',
        });
        fs.rmSync(dataDir, { recursive: true, force: true });
        if (child.status !== 0) throw new Error(`the open-node run failed (exit ${child.status})`);
        console.log('⭐️ Poll voters reach members only, on a default node and on an open one.');
    }
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
