/**
 * The member directory (GET /api/members) costs the server what the request needs, and says exactly what it said before.
 *
 * Found in the global node's load rehearsal (NODE_PROFILE=global, a 256 MB heap as V8 gives a 1 GB droplet), at 26,142
 * members: the route read every member's whole row (`SELECT *`, then a Member object each) for every request, and
 * filtered in JavaScript. A phone's delta read (`?updatedAfter=<its cursor>`, sent on every sync) answered 513 bytes
 * after ~76 ms of CPU, so every member's sync cost the server O(all members); the full directory took ~100-120 ms and
 * ~100 MB of transient heap a request, and 24 at once ran the server out of heap. The route now reads only the columns
 * the response carries, and a delta asks SQLite for the rows changed since the cursor (idx_members_joined_at,
 * idx_members_profile_updated_at), then applies the old comparison to those rows unchanged.
 *
 * Boots the real server (read auth on, the fresh-download default) and reads through the real middleware, signed by a
 * member:
 *   1. With a mix of rows (pruned, a treasury, a treasury flag left NULL, escrow_ and project_ keys, a visitor, a
 *      suspended member, a node role, photos stored three ways, a legacy numeric profile_updated_at, a numeric and a
 *      missing joined_at, rows inserted out of join order), the full directory, every delta cursor below (ISO, equal to
 *      a stored time, numeric-looking, hex, empty, a repeated parameter, characters above U+D800) and the
 *      nearest-first read (`lat`/`lng`) are byte for byte what the old computation (kept below as the oracle) gives.
 *   2. With 30,000 more members, 50 delta reads whose cursor matches nothing take under 1.5 s together (origin/main
 *      before this change: ~4 s on an M4 Pro, every one reading every member), and the full directory is still the
 *      oracle's, byte for byte.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-members-directory-cost.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;

import crypto from 'node:crypto';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

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

async function get(path: string, id: Id): Promise<{ status: number; text: string }> {
    const res = await fetch(`${BASE}${path}`, { headers: signedHeaders('GET', path, '', id) });
    return { status: res.status, text: await res.text() };
}

async function main() {
    console.log('The member directory reads only what it sends, and sends what it sent before...\n');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, getMembers, listNodeRoles } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { db } = await import('./db/db.js');
    const { withAreaDistances } = await import('./engine/member-area.js');
    const { isSelfAvatarUrl } = await import('@beanpool/core');
    const { setMemberPhoto } = await import('@beanpool/engine');

    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    /**
     * The URL the route made from a photo held in the member's row, before photos moved out of it (origin/main 09c2588d
     * @beanpool/core avatarUrlFor; no member-only keys here): the oracle's, from the photo each member was given.
     */
    const oldAvatarUrl = (id: string, stored: string | null | undefined): string | null => {
        if (!stored || !stored.trim() || isSelfAvatarUrl(stored)) return null;
        const trimmed = stored.trim();
        if (trimmed.startsWith('bundled://')) return stored;
        return `/api/avatar/${id}?size=thumb&v=${crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 8)}`;
    };
    // Each member's photo as the test gave it: what their row held before photos moved out.
    const given = new Map<string, string | null>();

    /**
     * The route as it was before this change (origin/main 2a0547c0), the oracle: every non-pruned member as a Member,
     * filtered in JavaScript.
     */
    const oracle = (updatedAfter: any, point: { lat: number; lng: number } | null): string => {
        let all = getMembers()
            .filter(m => !m.publicKey.startsWith('escrow_') && !m.publicKey.startsWith('project_') && !m.isTreasury);
        if (updatedAfter) {
            all = all.filter(m =>
                (m.joinedAt && m.joinedAt > updatedAfter) ||
                (m.profileUpdatedAt != null && String(m.profileUpdatedAt) > updatedAfter)
            );
        }
        const rolesByPubkey = new Map(listNodeRoles().map(r => [r.member_pubkey, r.role]));
        const members = all.map(m => ({
            publicKey: m.publicKey,
            callsign: m.callsign,
            joinedAt: m.joinedAt,
            nodeRole: rolesByPubkey.get(m.publicKey) ?? null,
            avatarUrl: oldAvatarUrl(m.publicKey, given.get(m.publicKey)),
            profileUpdatedAt: m.profileUpdatedAt,
            earnedCredit: m.earnedCredit ?? 0,
            elderVouchedBy: m.elderVouchedBy || null,
            archetype: m.archetype || null,
        }));
        return JSON.stringify(point ? withAreaDistances(members, point.lat, point.lng) : members);
    };

    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status,
                                   profile_updated_at, earned_credit, elder_vouched_by, archetype, is_treasury, is_visitor, area_lat, area_lng)
                               VALUES (@pk, @callsign, @joined, NULL, 'TEST', @status, @profile, @earned, @elder, @archetype,
                                   @treasury, @visitor, @lat, @lng)`);
    // A photo goes in by its one writer (member_photos, and the row's avatar_ref), as a profile save puts it there.
    const row = (pk: string, callsign: string, o: Partial<Record<string, unknown>> = {}) => {
        const { avatar = null, ...rest } = o as Record<string, unknown> & { avatar?: string | null };
        insert.run({
            pk, callsign, joined: '2026-03-01T00:00:00.000Z', status: 'active', profile: null, earned: 0, elder: null,
            archetype: null, treasury: 0, visitor: 0, lat: null, lng: null, ...rest,
        });
        given.set(pk, avatar);
        if (avatar !== null) setMemberPhoto(db as any, pk, avatar);
    };

    // ── 1. the same bytes, for every kind of row and cursor ──────────────────────────────────────────────────────────
    const reader = keypair();
    const elder = keypair().pubKeyHex;
    const admin = keypair().pubKeyHex;
    const photo = 'data:image/jpeg;base64,' + crypto.randomBytes(3000).toString('base64');
    db.transaction(() => {
        // Inserted newest-joined first, so rowid order is not join order.
        row(reader.pubKeyHex, 'Reader', { joined: '2026-06-01T00:00:00.000Z', lat: -28.5, lng: 153.5 });
        row(elder, 'Elder', { joined: '2026-01-01T00:00:00.000Z', earned: 1400, archetype: 'gardener', lat: -28.6, lng: 153.6 });
        row(admin, 'Admin', { joined: '2026-02-01T00:00:00.000Z', avatar: photo, profile: '2026-05-05T05:05:05.555Z',
            elder, lat: 51.5, lng: -0.1 });
        row(keypair().pubKeyHex, 'Bundled', { avatar: 'bundled://avatars/fox.png', earned: null });
        row(keypair().pubKeyHex, 'SelfRef', { avatar: '/api/avatar/abc?size=thumb', archetype: '' });
        row(keypair().pubKeyHex, 'Pruned', { status: 'pruned', profile: '2026-09-01T00:00:00.000Z' });
        row(keypair().pubKeyHex, 'Treasury', { treasury: 1 });
        row(keypair().pubKeyHex, 'TreasuryNull', { treasury: null, profile: '2026-04-04T00:00:00.000Z' });
        row('escrow_' + crypto.randomBytes(8).toString('hex'), 'Escrow', { profile: '2026-09-01T00:00:00.000Z' });
        row('project_' + crypto.randomBytes(8).toString('hex'), 'Project');
        row(keypair().pubKeyHex, 'Visitor', { visitor: 1, joined: '2026-07-07T07:07:07.007Z' });
        row(keypair().pubKeyHex, 'Suspended', { status: 'suspended' });
        row(keypair().pubKeyHex, 'LegacyNumericProfile', { profile: 1727000000000 });
        row(keypair().pubKeyHex, 'NumericJoined', { joined: 5 });
        row(keypair().pubKeyHex, 'NoJoined', { joined: null, profile: '2026-08-08T00:00:00.000Z' });
        row(keypair().pubKeyHex, 'Ünïcødé 名前 😀', { joined: '2025-12-31T23:59:59.999Z', elder: '' });
        row(keypair().pubKeyHex, 'Oldest', { joined: '2024-01-01T00:00:00.000Z' });
        db.prepare(`INSERT INTO node_roles (member_pubkey, role) VALUES (?, 'admin')`).run(admin);
    })();

    const cursors: [string, string][] = [
        ['the full directory', ''],
        ['an old cursor', '?updatedAfter=2000-01-01T00:00:00.000Z'],
        ['a cursor between joins', '?updatedAfter=2026-02-15T00:00:00.000Z'],
        ['a cursor equal to a join (strictly after)', '?updatedAfter=2026-06-01T00:00:00.000Z'],
        ['a cursor equal to a profile time', '?updatedAfter=2026-05-05T05:05:05.555Z'],
        ['a cursor after everything', '?updatedAfter=2999-01-01T00:00:00.000Z'],
        ['a numeric-looking cursor', '?updatedAfter=5'],
        ['a big numeric cursor', '?updatedAfter=1727000000001'],
        ['a hex cursor', '?updatedAfter=0x1'],
        ['a spaced numeric cursor', '?updatedAfter=%2012%20'],
        ['an empty cursor', '?updatedAfter='],
        ['a word cursor', '?updatedAfter=zzz'],
        ['a cursor of a lower-case date', '?updatedAfter=2026-03-01t'],
        ['a repeated cursor', '?updatedAfter=2026-01-01&updatedAfter=2027'],
        ['a cursor with U+E000', '?updatedAfter=' + encodeURIComponent('2026-')],
        ['a cursor with an emoji', '?updatedAfter=' + encodeURIComponent('😀')],
        ['the nearest-first directory', '?lat=-28.5&lng=153.5'],
        ['a nearest-first delta', '?lat=-28.5&lng=153.5&updatedAfter=2026-01-15T00:00:00.000Z'],
    ];
    const queryOf = (q: string) => new URLSearchParams(q.slice(1));
    for (const [label, q] of cursors) {
        const params = queryOf(q);
        const all = params.getAll('updatedAfter');
        const updatedAfter = all.length > 1 ? all : all[0];
        const point = params.has('lat') ? { lat: Number(params.get('lat')), lng: Number(params.get('lng')) } : null;
        const r = await get(`/api/members${q}`, reader);
        const want = oracle(updatedAfter, point);
        assert(r.status === 200, `${label}: 200 (got ${r.status})`);
        assert(r.text === want, `${label}: the same bytes as before (${JSON.parse(want).length} members, ${want.length} bytes)` +
            (r.text === want ? '' : `\n   got:  ${r.text.slice(0, 400)}\n   want: ${want.slice(0, 400)}`));
    }
    const full = JSON.parse((await get('/api/members', reader)).text) as any[];
    const names = full.map(m => m.callsign);
    assert(!names.includes('Pruned') && !names.includes('Treasury') && !names.includes('Escrow') && !names.includes('Project'),
        `the pruned member, the treasury and the escrow_/project_ keys stay out (${names.join(', ')})`);
    assert(full.find(m => m.callsign === 'Admin')?.nodeRole === 'admin' && /^\/api\/avatar\//.test(full.find(m => m.callsign === 'Admin')?.avatarUrl),
        'the admin carries their role and their photo URL');

    // ── 1b. a rename reaches another phone's delta ───────────────────────────────────────────────────────────────────
    // A rename through POST /api/community/register wrote only `callsign`, so a phone holding the list and a cursor from
    // before got the new name from no delta (they select by joined_at / profile_updated_at).
    const renamer = keypair();
    row(renamer.pubKeyHex, 'Before Name', { joined: '2026-01-02T00:00:00.000Z' });
    const heldList = await fetch(`${BASE}/api/members`, { headers: signedHeaders('GET', '/api/members', '', reader) });
    await heldList.text();
    const cursor = new Date(Date.now() - 1000).toISOString();
    await new Promise(r => setTimeout(r, 20));
    const regBody = JSON.stringify({ publicKey: renamer.pubKeyHex, callsign: 'After Name' });
    const reg = await fetch(`${BASE}/api/community/register`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', '/api/community/register', regBody, renamer) }, body: regBody });
    await reg.text();
    const afterRename = JSON.parse((await get(`/api/members?updatedAfter=${encodeURIComponent(cursor)}`, reader)).text) as any[];
    assert(reg.status === 200 && afterRename.some(m => m.publicKey === renamer.pubKeyHex && m.callsign === 'After Name'),
        `a rename through /api/community/register is in another member's delta from before it (register ${reg.status}, delta ${afterRename.map(m => m.callsign).join(', ')})`);
    db.prepare('DELETE FROM members WHERE public_key = ?').run(renamer.pubKeyHex);

    // ── 2. what a delta costs, at a global node's size ───────────────────────────────────────────────────────────────
    const N = 30_000;
    const t0 = Date.now();
    db.transaction(() => {
        for (let i = 0; i < N; i++) {
            row((i + 1).toString(16).padStart(64, '0'), `m${i}`, {
                joined: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
                profile: i % 3 === 0 ? new Date(Date.UTC(2026, 0, 1) + i * 60_000 + 30_000).toISOString() : null,
                earned: i % 7, archetype: i % 5 === 0 ? 'maker' : null, elder: i % 11 === 0 ? elder : null,
            });
        }
    })();
    console.log(`\n(seeded ${N} more members in ${Date.now() - t0} ms)`);

    const nothingNew = '?updatedAfter=2999-01-01T00:00:00.000Z';
    const warm = await get(`/api/members${nothingNew}`, reader);
    assert(warm.status === 200 && warm.text === '[]', `a delta whose cursor matches nothing answers [] (got ${warm.status} ${warm.text.slice(0, 40)})`);
    const DELTAS = 50, BOUND_MS = 1500;
    const d0 = performance.now();
    let all200 = true;
    for (let i = 0; i < DELTAS; i++) {
        const r = await get(`/api/members${nothingNew}`, reader);
        if (r.status !== 200 || r.text !== '[]') all200 = false;
    }
    const deltaMs = performance.now() - d0;
    assert(all200, `all ${DELTAS} deltas answered 200 []`);
    assert(deltaMs < BOUND_MS, `${DELTAS} delta reads at ${N} members take under ${BOUND_MS} ms together (took ${deltaMs.toFixed(0)} ms, ${(deltaMs / DELTAS).toFixed(1)} ms each)`);

    const recent = '?updatedAfter=' + new Date(Date.UTC(2026, 0, 1) + (N - 10) * 60_000).toISOString();
    const r = await get(`/api/members${recent}`, reader);
    const want = oracle(new URLSearchParams(recent.slice(1)).get('updatedAfter'), null);
    assert(r.text === want, `at ${N} members, a delta with a few changes is the same bytes as before (${JSON.parse(want).length} members)`);

    const f0 = performance.now();
    const fullBig = await get('/api/members', reader);
    const fullMs = performance.now() - f0;
    assert(fullBig.text === oracle(undefined, null), `at ${N} members, the full directory is the same bytes as before (${(fullBig.text.length / 1e6).toFixed(1)} MB, ${fullMs.toFixed(0)} ms)`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
