/**
 * The member directory as one shared answer per members version (members-snapshot.ts; docs/global-heavy-lists.md §5(d),
 * slice 2).
 *
 * Boots the real server (read auth on, the fresh-download default) and reads through the real middleware:
 *   1. Every write to a field the directory answer carries moves the members version (the rule a snapshot depends on):
 *      a join, a rename, an archetype, a photo saved with its profile, a vouch and its removal, a tier set by an admin,
 *      a node role granted and revoked, a member pruned.
 *   2. The full directory is byte for byte an unshared build of the same rows, plain and gzipped (Accept-Encoding),
 *      and so are the delta (`updatedAfter`) and the nearest-first read (`lat`/`lng`), which never touch the snapshot.
 *   3. The read gate is unchanged: a signed-out read, a key that isn't a member and a bad signature get what the delta
 *      (built per read, as before) gets; a member and an admin get the same bytes, from one build.
 *   4. The ETag is the snapshot's: If-None-Match gets 304; a write is in the very next answer, also to a reader holding
 *      the last ETag (no 304), and so is a write right after it (no floor holds the last snapshot); 40 readers at once
 *      after a write cost one build. A version move that changes nothing in the directory still gets 304: the ETag is
 *      the bytes' digest alone. Past the 60 s ceiling, even a write that moved no version is in the answer.
 *   5. A pruned member is gone from the answer after the rebuild.
 *   6. No contact details (a member's contact value, at every visibility) are in the shared answer, as they aren't in
 *      today's.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-members-snapshot.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;

import crypto from 'node:crypto';
import https from 'node:https';
import zlib from 'node:zlib';

let BASE = '';
let PORT = 0;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pk: string; priv: crypto.KeyObject };
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

function signedHeaders(method: string, path: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

type Got = { status: number; body: Buffer; headers: Record<string, string | string[] | undefined> };
/** A raw read: no fetch, so nothing decodes the body or adds an Accept-Encoding. */
function raw(path: string, headers: Record<string, string>): Promise<Got> {
    return new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers, rejectUnauthorized: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}
const get = (path: string, id: Id | null, extra: Record<string, string> = {}) =>
    raw(path, { ...(id ? signedHeaders('GET', path, '', id) : {}), ...extra });

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function main() {
    console.log('The member directory is one shared answer per members version...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { db } = await import('./db/db.js');
    const { withAreaDistances } = await import('./engine/member-area.js');
    const { grantNodeRole, revokeNodeRole, listNodeRoles } = await import('./engine/node-roles.js');
    const { avatarUrlOf } = await import('@beanpool/core');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const snapshot = await import('./members-snapshot.js');
    const { bumpMembersVersion } = await import('./engine/versions.js');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    void BASE;

    const owner = keypair();
    se.seedGenesisMember(owner.pk, 'Olive');
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status, contact_value, contact_visibility) VALUES (?, ?, ?, ?, 'active', ?, ?)`);
    const people: Id[] = [];
    const visibilities = ['public', 'members', 'friends', 'trade_partners', 'private'];
    for (let i = 0; i < 40; i++) {
        const id = keypair();
        people.push(id);
        insert.run(id.pk, `member${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), `seed-${i}`, `contact-secret-${i}@example.org`, visibilities[i % visibilities.length]);
        if (i % 3 === 0) setMemberPhoto(db as any, id.pk, PNG_1PX);
    }
    se.bumpMembersVersion();
    const reader = people[1];
    const admin = people[2];
    grantNodeRole(admin.pk, 'admin', owner.pk);

    /** The route's answer built afresh from the same rows, as it was built for every read before this change. */
    const unshared = (updatedAfter: string | undefined, point: { lat: number; lng: number } | null): string => {
        const rows = se.getMemberDirectoryRows(updatedAfter)
            .filter(r => !r.public_key.startsWith('escrow_') && !r.public_key.startsWith('project_') && !r.is_treasury);
        const rolesByPubkey = new Map(listNodeRoles().map(r => [r.member_pubkey, r.role]));
        const members = rows.map(r => ({
            publicKey: r.public_key,
            callsign: r.callsign,
            joinedAt: r.joined_at,
            nodeRole: rolesByPubkey.get(r.public_key) ?? null,
            avatarUrl: avatarUrlOf(r.public_key, r.avatar_ref),
            profileUpdatedAt: r.profile_updated_at || null,
            earnedCredit: r.earned_credit ?? 0,
            elderVouchedBy: r.elder_vouched_by || null,
            archetype: r.archetype || null,
        }));
        return JSON.stringify(point ? withAreaDistances(members, point.lat, point.lng) : members);
    };

    // ── 1. Every write to a directory field moves the members version ────────────────────────────────────────────
    console.log('── 1. Every write to a directory field moves the members version');
    const directoryNow = () => unshared(undefined, null);
    const moves = (label: string, write: () => unknown) => {
        const before = se.getMembersVersion();
        const rowsBefore = directoryNow();
        write();
        const changed = directoryNow() !== rowsBefore;
        assert(changed && se.getMembersVersion() !== before,
            `${label}: ${changed ? '' : 'the directory did not change (the write was refused), and '}the version ${se.getMembersVersion() !== before ? 'moved' : 'DID NOT move'}`);
    };
    const joiner = keypair();
    moves('a join (an invite redeemed)', () => {
        const invite = se.generateInvite(owner.pk);
        const r = se.redeemInvite(invite!.code, joiner.pk, 'Newcomer', true);
        if (!r.success) throw new Error(`join refused: ${r.error}`);
    });
    moves('a rename', () => se.updateProfile(people[5].pk, { callsign: 'renamed5' }));
    moves('an archetype', () => se.updateProfile(people[6].pk, { archetype: 'gardener' }));
    moves('an archetype cleared', () => se.updateProfile(people[6].pk, { archetype: null }));
    moves('a photo saved with its profile', () => se.updateProfile(people[7].pk, { avatar: PNG_1PX }));
    moves('a vouch', () => se.vouchMember(owner.pk, people[8].pk));
    moves('a vouch removed', () => se.unvouchMember(owner.pk, people[8].pk));
    moves('a tier set by an admin', () => se.adminSetTier(people[9].pk, 'trusted' as any));
    moves('a node role granted', () => grantNodeRole(people[10].pk, 'admin', owner.pk));
    moves('a node role revoked', () => revokeNodeRole(people[10].pk, 'admin', owner.pk));
    moves('a member pruned by an admin', () => se.adminPruneUser(people[11].pk, owner.pk));
    // The genesis seed (POST /api/admin/seed-invite on a node with no members; seedGenesisMember): a new member and owner,
    // or an owner made of a member already there. It moved no version before (found by a scan of every SQL write to
    // members and node_roles, 2026-10-03).
    moves('a genesis member seeded', () => se.seedGenesisMember(keypair().pk, 'Genesis'));
    moves('a genesis seed of a member already there', () => se.seedGenesisMember(people[12].pk, 'ignored'));

    // ── 2. Byte for byte an unshared build ───────────────────────────────────────────────────────────────────────
    console.log('\n── 2. The same bytes as an unshared build, plain and gzipped');
    snapshot.setMembersSnapshotForTests(undefined);
    const full = await get('/api/members', reader);
    assert(full.status === 200 && full.body.toString('utf8') === unshared(undefined, null), 'the full directory is byte for byte an unshared build');
    assert(full.headers['content-encoding'] === undefined, 'a reader that sends no Accept-Encoding gets it plain');
    assert(String(full.headers['cache-control']).startsWith('private') || String(full.headers['cache-control']).startsWith('public'), `Cache-Control as before (${full.headers['cache-control']})`);
    const gz = await get('/api/members', reader, { 'Accept-Encoding': 'gzip, deflate, br' });
    assert(gz.status === 200 && gz.headers['content-encoding'] === 'gzip', 'a reader that accepts gzip gets the gzip copy');
    assert(gz.status === 200 && zlib.gunzipSync(gz.body).equals(full.body), 'the gzip copy unzips to the same bytes');
    assert(gz.headers.etag === full.headers.etag, 'plain and gzip carry the same ETag');
    assert(String(gz.headers.vary ?? '').toLowerCase().includes('accept-encoding'), 'Vary: Accept-Encoding');
    const refused = await get('/api/members', reader, { 'Accept-Encoding': 'gzip;q=0' });
    assert(refused.headers['content-encoding'] === undefined && refused.body.equals(full.body), 'gzip;q=0 gets it plain');
    assert(snapshot.membersSnapshotBuilds() === 1, `the three reads cost one build (${snapshot.membersSnapshotBuilds()})`);

    const cursor = new Date(Date.UTC(2026, 0, 1, 0, 20)).toISOString();
    const deltaPath = `/api/members?updatedAfter=${encodeURIComponent(cursor)}`;
    const delta = await get(deltaPath, reader);
    assert(delta.status === 200 && delta.body.toString('utf8') === unshared(cursor, null), 'the delta is byte for byte an unshared build');
    const nearPath = '/api/members?lat=-28.55&lng=153.5';
    const near = await get(nearPath, reader);
    assert(near.status === 200 && near.body.toString('utf8') === unshared(undefined, { lat: -28.55, lng: 153.5 }), 'the nearest-first read is byte for byte an unshared build');
    assert(snapshot.membersSnapshotBuilds() === 1, 'neither the delta nor the nearest-first read built or used a snapshot');
    assert(delta.headers.etag !== full.headers.etag && near.headers.etag !== full.headers.etag, 'the delta and the nearest-first read keep ETags of their own');

    // ── 3. The read gate ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. The read gate is unchanged');
    const stranger = keypair();
    const gateCases: Array<[string, Id | null, Record<string, string>]> = [
        ['signed out', null, {}],
        ['a key that is not a member', stranger, {}],
        ['a bad signature', reader, { 'X-Signature': Buffer.alloc(64).toString('base64') }],
    ];
    for (const [who, id, extra] of gateCases) {
        const f = await get('/api/members', id, extra);
        const d = await get(deltaPath, id, extra);
        assert(f.status !== 200 && f.status === d.status, `${who}: the full read is refused as the delta is (${f.status} / ${d.status})`);
        assert(!f.body.toString('utf8').includes(people[3].pk), `${who}: no member in the answer`);
    }
    const asAdmin = await get('/api/members', admin);
    assert(asAdmin.status === 200 && asAdmin.body.equals(full.body), 'an admin gets the same bytes as a member');
    const asOwner = await get('/api/members', owner);
    assert(asOwner.status === 200 && asOwner.body.equals(full.body), 'the owner gets the same bytes as a member');
    assert(snapshot.membersSnapshotBuilds() === 1, 'still one build');

    // ── 4. The ETag, and a write in the very next answer ─────────────────────────────────────────────────────────
    console.log('\n── 4. The ETag is the snapshot\'s, and a write is in the very next answer');
    const etag = String(full.headers.etag);
    const notModified = await get('/api/members', reader, { 'If-None-Match': etag });
    assert(notModified.status === 304 && notModified.body.length === 0, 'If-None-Match with its ETag gets 304');
    const noWrite = await Promise.all(Array.from({ length: 40 }, () => get('/api/members', reader)));
    assert(noWrite.every(r => r.status === 200 && r.body.equals(full.body) && r.headers.etag === etag), 'with no write, 40 readers at once get the same bytes and ETag');
    assert(snapshot.membersSnapshotBuilds() === 1, '40 readers at once with no write cost no build at all');
    // A directory change shows at once (test-profile-fanout, test-member-photos-out-of-rows): the snapshot is served
    // only for the version it was built for. Here it used to stand for 5 s after a write, and a held ETag got 304.
    se.updateProfile(people[12].pk, { callsign: 'renamed12' });
    const afterWrite = await Promise.all(Array.from({ length: 40 }, () => get('/api/members', reader, { 'If-None-Match': etag })));
    assert(afterWrite.every(r => r.status === 200 && r.body.toString('utf8') === unshared(undefined, null)), 'a write is in the very next answer, also to readers holding the last ETag (200, not 304)');
    assert(afterWrite.every(r => r.headers.etag !== etag && r.headers.etag === afterWrite[0].headers.etag), 'and the ETag moved, the same for every reader');
    assert(snapshot.membersSnapshotBuilds() === 2, `40 readers at once after it cost one build (${snapshot.membersSnapshotBuilds() - 1})`);
    assert(afterWrite[0].body.toString('utf8').includes('renamed12'), 'the rename is there');
    let lastEtag = String(afterWrite[0].headers.etag);
    for (const name of ['renamed12b', 'renamed12c']) {
        se.updateProfile(people[12].pk, { callsign: name });
        const next = await get('/api/members', reader, { 'If-None-Match': lastEtag });
        assert(next.status === 200 && next.body.toString('utf8').includes(name) && next.headers.etag !== lastEtag,
            `a write right after the last one is in the next answer too, its ETag moved (${name}: ${next.status})`);
        lastEtag = String(next.headers.etag);
    }

    // The 60 s ceiling: a write that forgot to move the version is in the answer at the next build past it.
    snapshot.setMembersSnapshotForTests({ maxAgeMs: 0 });
    db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run('silent-rename', people[13].pk);
    const ceiling = await get('/api/members', reader);
    assert(ceiling.body.toString('utf8').includes('silent-rename'), 'past the ceiling, even a write that moved no version is in the answer');
    const again = await get('/api/members', reader, { 'If-None-Match': String(ceiling.headers.etag) });
    assert(again.status === 304, 'a rebuild at the ceiling that found nothing new keeps the ETag: 304');

    // A write that moves the version but changes nothing in the directory (a member's area, holiday mode, a mute): past
    // the rebuild has the same bytes, so the same ETag, and a phone holding them gets 304, not all of it again.
    snapshot.setMembersSnapshotForTests(undefined);
    const held = await get('/api/members', reader);
    bumpMembersVersion();
    const sameBytes = await get('/api/members', reader, { 'If-None-Match': String(held.headers.etag) });
    const rebuilt = await get('/api/members', reader);
    assert(sameBytes.status === 304 && snapshot.membersSnapshotBuilds() === 2, `a version move that changed nothing in the directory: rebuilt, and still 304 (${sameBytes.status}, ${snapshot.membersSnapshotBuilds()} builds)`);
    assert(rebuilt.status === 200 && rebuilt.headers.etag === held.headers.etag && rebuilt.body.equals(held.body), `and the same ETag on the same bytes (${held.headers.etag} → ${rebuilt.headers.etag})`);

    // ── 5. A pruned member ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. A pruned member is gone after the rebuild');
    snapshot.setMembersSnapshotForTests(undefined);
    const prunedPk = people[14].pk;
    assert((await get('/api/members', reader)).body.toString('utf8').includes(prunedPk), 'the member is in the answer');
    se.adminPruneUser(prunedPk, owner.pk);
    const afterPrune = await get('/api/members', reader);
    assert(!afterPrune.body.toString('utf8').includes(prunedPk), 'pruned: gone from the answer');
    assert(afterPrune.body.toString('utf8') === unshared(undefined, null), 'and the answer is an unshared build');
    assert(!(await get('/api/members', reader, { 'Accept-Encoding': 'gzip' })).body.equals(gz.body), 'the gzip copy was rebuilt too');

    // ── 6. Contact details ───────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. No contact details in the shared answer');
    for (const [who, id] of [['a member', reader], ['an admin', admin], ['the owner', owner]] as Array<[string, Id]>) {
        const text = (await get('/api/members', id)).body.toString('utf8');
        assert(!text.includes('contact-secret-') && !/"contact/i.test(text), `${who}: no contact value or contact field`);
        const row = JSON.parse(text)[0];
        assert(Object.keys(row).join(',') === 'publicKey,callsign,joinedAt,nodeRole,avatarUrl,profileUpdatedAt,earnedCredit,elderVouchedBy,archetype', `${who}: the row's fields are today's, no more`);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
