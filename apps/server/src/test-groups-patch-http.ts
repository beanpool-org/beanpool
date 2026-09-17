/**
 * Group edits over PATCH — over a REAL HTTPS round trip.
 *
 * The two group edit routes (member role, group details / join policy) are registered as PATCH, and both
 * clients send PATCH with a JSON body. The JSON body parser and the signature middleware used to handle only
 * POST, PUT and DELETE, so a PATCH body was never parsed and never covered by the signature check: the
 * member-role route answered "role is required" every time, and the group update received no fields.
 * test-groups-routes drives the router directly with `requestBody` already filled in, so it could not see
 * this — the same trap as test-request-body and test-keeper-http.
 *
 * The requests are signed exactly as apps/pwa/src/lib/api.ts `request()` and apps/native/utils/crypto.ts
 * `buildSignedHeaders` sign them: METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY, path without the query string, body
 * the exact JSON string sent.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-groups-patch-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createGroup, joinGroup } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8642;
const BASE = `https://localhost:${PORT}`;

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

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pk, callsign);
}

async function send(method: string, path: string, body: unknown, signer?: Identity): Promise<{ status: number; error?: string }> {
    const bodyString = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (signer) {
        const ts = String(Date.now());
        const nonce = crypto.randomUUID();
        const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), signer.priv).toString('base64');
        headers['X-Timestamp'] = ts;
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    let error: string | undefined;
    try { error = (await res.json())?.error; } catch { /* not json */ }
    return { status: res.status, error };
}

const roleOf = (groupId: string, pk: string) =>
    (db.prepare('SELECT role FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(groupId, pk) as any)?.role;
const groupRow = (groupId: string) =>
    db.prepare('SELECT name, description, category, join_policy FROM groups WHERE id = ?').get(groupId) as any;
const lastActive = (pk: string) =>
    (db.prepare('SELECT last_active_at FROM members WHERE public_key = ?').get(pk) as any)?.last_active_at ?? null;

async function main() {
    console.log('Running group PATCH tests (real HTTPS)...\n');
    await initTls();
    initStateEngine();

    const convenor = keypair();
    const member = keypair();
    const outsider = keypair();
    seedMember(convenor.pub, `conv-${convenor.pub.slice(0, 6)}`);
    seedMember(member.pub, `memb-${member.pub.slice(0, 6)}`);
    seedMember(outsider.pub, `outs-${outsider.pub.slice(0, 6)}`);

    const group = createGroup({ name: 'Patch Garden', description: 'before', createdBy: convenor.pub, joinPolicy: 'open' });
    joinGroup(group.id, member.pub);
    if (roleOf(group.id, convenor.pub) !== 'convenor') throw new Error('fixture: creator is not convenor');
    if (roleOf(group.id, member.pub) !== 'member') throw new Error('fixture: joiner is not a member');

    await startHttpsServer(PORT);

    const rolePath = `/api/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(member.pub)}`;
    const groupPath = `/api/groups/${encodeURIComponent(group.id)}`;

    // ── 1. Unsigned PATCH: 401, nothing changes ──────────────────────────────────────────────────────────
    {
        const r = await send('PATCH', rolePath, { role: 'convenor' });
        assert(r.status === 401, `unsigned PATCH member role → 401 (got ${r.status} ${r.error ?? ''})`);
        assert(roleOf(group.id, member.pub) === 'member', `and the role is unchanged (${roleOf(group.id, member.pub)})`);

        const before = JSON.stringify(groupRow(group.id));
        const g = await send('PATCH', groupPath, { joinPolicy: 'invite_only' });
        assert(g.status === 401, `unsigned PATCH group → 401 (got ${g.status} ${g.error ?? ''})`);
        assert(JSON.stringify(groupRow(group.id)) === before, 'and the group is unchanged');
    }

    // ── 2. Signed by a key that does not match the body it sent: refused, nothing changes ───────────────
    {
        const bodyString = JSON.stringify({ role: 'observer' });
        const ts = String(Date.now());
        const nonce = crypto.randomUUID();
        const canonical = `PATCH\n${rolePath}\n${ts}\n${nonce}\n${bodyString}`;
        const res = await fetch(`${BASE}${rolePath}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-Public-Key': convenor.pub,
                'X-Signature': crypto.sign(null, Buffer.from(canonical), convenor.priv).toString('base64'),
                'X-Timestamp': ts,
                'X-Nonce': nonce,
            },
            body: JSON.stringify({ role: 'convenor' }), // not the body that was signed
        });
        assert(res.status === 403, `PATCH whose body differs from the signed body → 403 (got ${res.status})`);
        assert(roleOf(group.id, member.pub) === 'member', `and the role is unchanged (${roleOf(group.id, member.pub)})`);
    }

    // ── 3. Signed by someone who is not a convenor: refused, nothing changes ─────────────────────────────
    {
        const self = await send('PATCH', `/api/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(member.pub)}`,
            { role: 'convenor' }, member);
        assert(self.status === 403, `a member's signed PATCH promoting themselves → 403 (got ${self.status} ${self.error ?? ''})`);
        assert(roleOf(group.id, member.pub) === 'member', `and their role is unchanged (${roleOf(group.id, member.pub)})`);

        const out = await send('PATCH', rolePath, { role: 'convenor' }, outsider);
        assert(out.status === 403, `a non-member's signed PATCH changing a role → 403 (got ${out.status} ${out.error ?? ''})`);
        assert(roleOf(group.id, member.pub) === 'member', `and the role is unchanged (${roleOf(group.id, member.pub)})`);

        const before = JSON.stringify(groupRow(group.id));
        const g = await send('PATCH', groupPath, { joinPolicy: 'invite_only' }, member);
        assert(g.status === 403, `a member's signed PATCH to the join policy → 403 (got ${g.status} ${g.error ?? ''})`);
        assert(JSON.stringify(groupRow(group.id)) === before, 'and the group is unchanged');
    }

    // ── 4. Differently-cased /api path, signed by the convenor: 404, nothing changes (#841 path gate) ────
    for (const variant of [rolePath.replace('/api/groups/', '/API/groups/'), rolePath.replace('/api/groups/', '/api/Groups/')]) {
        const r = await send('PATCH', variant, { role: 'convenor' }, convenor);
        assert(r.status === 404, `signed PATCH ${variant.slice(0, 20)}… → 404 (got ${r.status} ${r.error ?? ''})`);
        assert(roleOf(group.id, member.pub) === 'member', `and the role is unchanged (${roleOf(group.id, member.pub)})`);
    }

    // ── 5. The convenor, correctly signed: the role changes ─────────────────────────────────────────────
    {
        db.prepare('UPDATE members SET last_active_at = NULL WHERE public_key = ?').run(convenor.pub);
        const r = await send('PATCH', rolePath, { role: 'convenor' }, convenor);
        assert(r.status === 200, `the convenor's signed PATCH making a member a convenor → 200 (got ${r.status} ${r.error ?? ''})`);
        assert(roleOf(group.id, member.pub) === 'convenor', `and the member is now a convenor (${roleOf(group.id, member.pub)})`);
        assert(lastActive(convenor.pub) !== null, 'and the verified signer is recorded as active, as for any other write');

        const back = await send('PATCH', rolePath, { role: 'observer' }, convenor);
        assert(back.status === 200, `a second signed PATCH setting observer → 200 (got ${back.status} ${back.error ?? ''})`);
        assert(roleOf(group.id, member.pub) === 'observer', `and the role follows (${roleOf(group.id, member.pub)})`);

        const replayNonce = crypto.randomUUID();
        const bodyString = JSON.stringify({ role: 'member' });
        const ts = String(Date.now());
        const headers = {
            'Content-Type': 'application/json',
            'X-Public-Key': convenor.pub,
            'X-Signature': crypto.sign(null, Buffer.from(`PATCH\n${rolePath}\n${ts}\n${replayNonce}\n${bodyString}`), convenor.priv).toString('base64'),
            'X-Timestamp': ts,
            'X-Nonce': replayNonce,
        };
        const first = await fetch(`${BASE}${rolePath}`, { method: 'PATCH', headers, body: bodyString });
        db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND member_pubkey = ?').run('observer', group.id, member.pub);
        const replay = await fetch(`${BASE}${rolePath}`, { method: 'PATCH', headers, body: bodyString });
        assert(first.status === 200, `a signed PATCH setting member → 200 (got ${first.status})`);
        assert(replay.status === 403, `the same signed PATCH replayed → 403 (got ${replay.status})`);
        assert(roleOf(group.id, member.pub) === 'observer', `and the replay changes nothing (${roleOf(group.id, member.pub)})`);
    }

    // ── 6. The convenor, correctly signed: the join policy and details change ───────────────────────────
    {
        const p = await send('PATCH', groupPath, { joinPolicy: 'request_to_join' }, convenor);
        assert(p.status === 200, `the convenor's signed PATCH to the join policy → 200 (got ${p.status} ${p.error ?? ''})`);
        assert(groupRow(group.id)?.join_policy === 'request_to_join', `and the join policy is request_to_join (${groupRow(group.id)?.join_policy})`);

        const d = await send('PATCH', groupPath, { name: 'Patch Garden Renamed', description: 'after', category: 'social' }, convenor);
        assert(d.status === 200, `the convenor's signed PATCH to the group details → 200 (got ${d.status} ${d.error ?? ''})`);
        const row = groupRow(group.id);
        assert(row?.name === 'Patch Garden Renamed' && row?.description === 'after' && row?.category === 'social',
            `and the details are updated (${JSON.stringify(row)})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ ALL GROUP PATCH CHECKS PASSED.');
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
