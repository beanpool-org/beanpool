/**
 * A group's roster as one shared answer per group, view and filters (roster-snapshots.ts; docs/global-heavy-lists.md
 * §5(d), slice 3).
 *
 * Boots the real server and reads `GET /api/groups/:id/members` through the real middleware:
 *   1. The #828 rules come first, and touch no snapshot: an invite-only group is 404 to an outsider, refused to a
 *      signed-out read (the read gate's 401), and 403 to an invitee; nothing is built or kept for any of them.
 *   2. The views: an acting convenor sees requests and invitations, a member sees the active roster, a suspended
 *      convenor gets the member's view (bytes and ETag), a visitor of an open group the active roster under its own
 *      view. Each view's ETag names it, and no view's ETag gets a 304 from another's.
 *   3. Every answer is byte for byte the unshared build of the same rows (getGroupMembers, as the route sent it before),
 *      plain and gzipped, for each view and filter.
 *   4. Every write that changes what a roster shows moves its key and is in the very next read, also to a reader
 *      holding the last ETag (no 304, no window): a join, a leave, a convenor's removal, a role change, a request
 *      approved, an invitation issued and revoked, the lead handed over, a member's new name and new photo.
 *   5. The ETag: If-None-Match on an unchanged roster gets 304; 40 readers at once after a write cost one build.
 *   6. The LRU holds its byte budget across many groups, and a roster bigger than the budget alone is sent, not kept.
 *   7. Readers who stop reading a big roster hold a window each (the directory's send, under the cap and its deadline):
 *      the server still answers a fresh read at once.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-roster-snapshots.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';

let PORT = 0;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
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
        const req = https.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers, rejectUnauthorized: false, agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}
const roster = (groupId: string, id: Id | null, query = '', extra: Record<string, string> = {}) => {
    const path = `/api/groups/${groupId}/members${query}`;
    return raw(path, { ...(id ? signedHeaders('GET', path, '', id) : {}), ...extra });
};
const etagOf = (g: Got) => String(g.headers.etag ?? '');
const keys = (g: Got): string[] => (JSON.parse(g.body.toString('utf8')) as any[]).map(r => r.memberPubkey);

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_OTHER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
    console.log('A roster is one shared answer per group, view and filters...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { db } = await import('./db/db.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const snaps = await import('./roster-snapshots.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    PORT = await startHttpsServer(0);

    const founder = keypair();
    se.seedGenesisMember(founder.pk, 'Founder');
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    let n = 0;
    const member = (name: string, photo = false): Id => {
        const id = keypair();
        insert.run(id.pk, name, new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), `seed-${n++}`);
        if (photo) setMemberPhoto(db as any, id.pk, PNG_1PX);
        return id;
    };
    const admin = member('Admin');
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')`).run(admin.pk);
    const lead = member('Lead', true);
    const conv2 = member('Conv2', true);
    const m1 = member('M1', true);
    const m2 = member('M2');
    const m3 = member('M3', true);
    const asker = member('Asker');
    const invitee = member('Invitee');
    const outsider = member('Outsider');
    se.bumpMembersVersion();

    const open = se.createGroup({ name: 'Open roster', createdBy: lead.pk, joinPolicy: 'open' } as any);
    const asking = se.createGroup({ name: 'Ask roster', createdBy: lead.pk, joinPolicy: 'request_to_join' } as any);
    const hidden = se.createGroup({ name: 'Hidden roster', createdBy: lead.pk, joinPolicy: 'invite_only' } as any);
    for (const g of [open.id]) for (const m of [conv2, m1, m2, m3]) se.joinGroup(g, m.pk);
    for (const m of [conv2, m1, m2]) { se.inviteGroupMember(asking.id, lead.pk, m.pk); se.joinGroup(asking.id, m.pk); }
    for (const m of [conv2, m1, m2]) { se.inviteGroupMember(hidden.id, lead.pk, m.pk); se.joinGroup(hidden.id, m.pk); }
    se.setMemberRole(open.id, lead.pk, conv2.pk, 'convenor');
    se.setMemberRole(asking.id, lead.pk, conv2.pk, 'convenor');
    se.joinGroup(asking.id, asker.pk); // a request, waiting
    se.inviteGroupMember(hidden.id, lead.pk, invitee.pk); // an invitation, waiting
    snaps.setRosterSnapshotsForTests(undefined);

    /** The route's answer built afresh from the same rows, as it was sent for every read before this change. */
    const unshared = (groupId: string, status?: string, role?: string) =>
        Buffer.from(JSON.stringify(se.getGroupMembers(groupId, { status: status as any, role: role as any })), 'utf8');

    // ---- 1. The #828 rules first, and no snapshot touched ----
    {
        const before = snaps.rosterSnapshotsHeld();
        const out = await roster(hidden.id, outsider);
        const anon = await roster(hidden.id, null);
        const inv = await roster(hidden.id, invitee);
        const askAll = await roster(asking.id, asker, '?status=all');
        const memAll = await roster(open.id, m1, '?status=pending');
        const after = snaps.rosterSnapshotsHeld();
        assert(out.status === 404, `invite-only: an outsider gets 404 (got ${out.status})`);
        // The read gate (read auth on, the default) refuses it before the route; with it off the route's 404 would.
        assert(anon.status === 401 || anon.status === 404, `invite-only: a signed-out read is refused, 401 or 404 (got ${anon.status})`);
        assert(inv.status === 403, `invite-only: an invitee gets 403 (got ${inv.status})`);
        assert(askAll.status === 403 && memAll.status === 403, `requests and invitations: 403 to one asking and to a member (got ${askAll.status}, ${memAll.status})`);
        assert(after.builds === before.builds && after.count === before.count && after.bytes === before.bytes,
            `none of those refusals built or kept a snapshot (builds ${before.builds}→${after.builds}, kept ${before.count}→${after.count})`);
        assert(!out.body.includes(Buffer.from(m1.pk)) && !inv.body.includes(Buffer.from(m1.pk)), 'no refusal carries a member key');
    }

    // ---- 2 + 3. The views, each byte for byte the unshared build ----
    const convAsk = await roster(asking.id, lead);
    const memAsk = await roster(asking.id, m1);
    const outAsk = await roster(asking.id, outsider);
    const convOpenActive = await roster(open.id, lead, '?status=active');
    const memOpenActive = await roster(open.id, m1);
    {
        assert(convAsk.status === 200 && keys(convAsk).includes(asker.pk), 'the convenor sees the waiting request');
        assert(memAsk.status === 200 && !keys(memAsk).includes(asker.pk), 'a member does not');
        assert(outAsk.status === 200 && !keys(outAsk).includes(asker.pk), 'nor does a visitor');
        assert(convAsk.body.equals(unshared(asking.id)), "convenor's view: byte for byte the unshared build (every live row)");
        assert(memAsk.body.equals(unshared(asking.id, 'active')), "member's view: byte for byte the unshared build (active)");
        assert(outAsk.body.equals(unshared(asking.id, 'active')), "visitor's view: byte for byte the unshared build (active)");
        assert(convOpenActive.body.equals(unshared(open.id, 'active')), "convenor's ?status=active: byte for byte the unshared build");
        const convRole = await roster(asking.id, lead, '?role=convenor');
        assert(convRole.body.equals(unshared(asking.id, undefined, 'convenor')), "convenor's ?role=convenor: byte for byte the unshared build");
        const memRole = await roster(asking.id, m1, '?role=convenor');
        assert(memRole.body.equals(unshared(asking.id, 'active', 'convenor')), "member's ?role=convenor: byte for byte the unshared build");
        const hid = await roster(hidden.id, m1);
        assert(hid.status === 200 && hid.body.equals(unshared(hidden.id, 'active')), 'invite-only, a member: 200, byte for byte the unshared build');
        const gz = await roster(asking.id, lead, '', { 'Accept-Encoding': 'gzip' });
        assert(gz.headers['content-encoding'] === 'gzip' && zlib.gunzipSync(gz.body).equals(unshared(asking.id)), "convenor's view gzipped: the same bytes unzipped");
        const gzm = await roster(asking.id, m1, '', { 'Accept-Encoding': 'gzip' });
        assert(gzm.headers['content-encoding'] === 'gzip' && zlib.gunzipSync(gzm.body).equals(unshared(asking.id, 'active')), "member's view gzipped: the same bytes unzipped");
        assert(etagOf(convAsk).includes('roster-convenor-') && etagOf(memAsk).includes('roster-member-') && etagOf(outAsk).includes('roster-outside-'),
            `each view's ETag names it (${etagOf(convAsk)}, ${etagOf(memAsk)}, ${etagOf(outAsk)})`);
        assert(etagOf(memOpenActive) !== etagOf(convOpenActive), "the same rows in two views still carry two ETags");
        const cross = await roster(open.id, m1, '', { 'If-None-Match': etagOf(convOpenActive) });
        assert(cross.status === 200, `a member holding the convenor view's ETag gets 200, not 304 (got ${cross.status})`);
        const cross2 = await roster(asking.id, outsider, '', { 'If-None-Match': etagOf(memAsk) });
        assert(cross2.status === 200, `a visitor holding the member view's ETag gets 200, not 304 (got ${cross2.status})`);
        assert(String(convAsk.headers['cache-control']).includes('private'), 'Cache-Control: private');
    }

    // A suspended convenor gets the member's view.
    {
        const convBefore = await roster(asking.id, conv2);
        assert(keys(convBefore).includes(asker.pk) && etagOf(convBefore).includes('roster-convenor-'), 'an acting second convenor sees the request (convenor view)');
        se.adminEmergencySuspend(conv2.pk, admin.pk, 'Roster snapshot suite');
        const suspended = await roster(asking.id, conv2);
        const asMember = await roster(asking.id, m1);
        assert(suspended.status === 200 && !keys(suspended).includes(asker.pk), 'suspended, they no longer see the request');
        assert(suspended.body.equals(asMember.body) && etagOf(suspended) === etagOf(asMember),
            `a suspended convenor gets the member's bytes and ETag (${etagOf(suspended)})`);
        const held = await roster(asking.id, conv2, '', { 'If-None-Match': etagOf(convBefore) });
        assert(held.status === 200 && !keys(held).includes(asker.pk), "holding the convenor view's ETag, they get the member's view, not 304");
        const all = await roster(asking.id, conv2, '?status=all');
        assert(all.status === 403, `suspended, ?status=all is 403 (got ${all.status})`);
        se.adminLiftSuspension(conv2.pk, admin.pk);
        const back = await roster(asking.id, conv2);
        assert(keys(back).includes(asker.pk), 'the suspension lifted, the convenor view is back');
    }

    // ---- 4. Every roster write is in the very next read ----
    {
        const step = async (label: string, groupId: string, reader: Id, write: () => void, shows: (rows: any[]) => boolean, query = '') => {
            const warm = await roster(groupId, reader, query);
            const keyBefore = snaps.rosterSnapshotsHeld().builds;
            write();
            resetGatewayRateLimit();
            const next = await roster(groupId, reader, query, { 'If-None-Match': etagOf(warm) });
            const rows = next.status === 200 ? JSON.parse(next.body.toString('utf8')) : [];
            assert(next.status === 200 && shows(rows) && snaps.rosterSnapshotsHeld().builds === keyBefore + 1,
                `${label}: in the very next read, holding the last ETag (status ${next.status})`);
            assert(next.body.equals(unshared(groupId, query.includes('status=') ? query.split('status=')[1] : (etagOf(next).includes('convenor') ? undefined : 'active'))),
                `${label}: byte for byte the unshared build`);
        };
        const has = (pk: string) => (rows: any[]) => rows.some(r => r.memberPubkey === pk);
        const lacks = (pk: string) => (rows: any[]) => !rows.some(r => r.memberPubkey === pk);
        const newcomer = member('Newcomer'); se.bumpMembersVersion();
        await step('a join', open.id, m1, () => se.joinGroup(open.id, newcomer.pk), has(newcomer.pk));
        await step('a leave', open.id, m1, () => se.removeGroupMember(open.id, newcomer.pk, newcomer.pk), lacks(newcomer.pk));
        await step("a convenor's removal", open.id, m1, () => se.removeGroupMember(open.id, lead.pk, m2.pk), lacks(m2.pk));
        await step('a role change', open.id, m1, () => se.setMemberRole(open.id, lead.pk, m3.pk, 'convenor'),
            rows => rows.find(r => r.memberPubkey === m3.pk)?.role === 'convenor');
        await step('a request approved', asking.id, m1, () => se.approveGroupMember(asking.id, lead.pk, asker.pk), has(asker.pk));
        await step('an invitation issued', hidden.id, lead, () => se.inviteGroupMember(hidden.id, lead.pk, outsider.pk), has(outsider.pk));
        await step('an invitation revoked', hidden.id, lead, () => se.removeGroupMember(hidden.id, lead.pk, outsider.pk), lacks(outsider.pk));
        await step('the lead handed over', open.id, m1, () => se.handOverGroupLead(open.id, lead.pk, m1.pk),
            rows => rows.find(r => r.memberPubkey === m1.pk)?.role === 'convenor');
        await step("a member's new name", open.id, m1, () => se.updateProfile(m3.pk, { callsign: 'M3renamed' }),
            rows => rows.find(r => r.memberPubkey === m3.pk)?.callsign === 'M3renamed');
        const photoBefore = (JSON.parse((await roster(open.id, m1)).body.toString('utf8')) as any[]).find(r => r.memberPubkey === m3.pk)?.avatarUrl;
        await step("a member's new photo", open.id, m1, () => se.updateProfile(m3.pk, { avatar: PNG_OTHER, avatarUrl: PNG_OTHER }),
            rows => rows.find(r => r.memberPubkey === m3.pk)?.avatarUrl !== photoBefore);
        // The removed member reads nothing of a hidden group afterwards.
        const gone = await roster(hidden.id, outsider);
        assert(gone.status === 404, `after the revoke, the hidden roster is 404 to them again (got ${gone.status})`);
    }

    // ---- 5. The ETag and a burst ----
    {
        const a = await roster(open.id, m1);
        const b = await roster(open.id, m1, '', { 'If-None-Match': etagOf(a) });
        assert(b.status === 304, `If-None-Match on an unchanged roster: 304 (got ${b.status})`);
        se.updateProfile(m1.pk, { callsign: 'M1burst' });
        const builds = snaps.rosterSnapshotsHeld().builds;
        resetGatewayRateLimit();
        const burst = await Promise.all(Array.from({ length: 40 }, () => roster(open.id, m1)));
        assert(burst.every(r => r.status === 200 && r.body.equals(burst[0].body)), '40 readers at once: all 200, the same bytes');
        assert(snaps.rosterSnapshotsHeld().builds === builds + 1, `40 readers at once after a write: one build (${snaps.rosterSnapshotsHeld().builds - builds})`);
    }

    // ---- 6. The LRU's byte budget ----
    {
        const many: string[] = [];
        for (let i = 0; i < 30; i++) {
            const g = se.createGroup({ name: `Many ${i}`, createdBy: lead.pk, joinPolicy: 'open' } as any);
            for (const m of [m1, m3, conv2]) se.joinGroup(g.id, m.pk);
            many.push(g.id);
        }
        const one = await roster(many[0], m1);
        const budget = one.body.length * 5 + 10;
        snaps.setRosterSnapshotsForTests({ byteBudget: budget });
        resetGatewayRateLimit();
        for (const g of many) { const r = await roster(g, m1); if (r.status !== 200) assert(false, `many: ${r.status}`); }
        const held = snaps.rosterSnapshotsHeld();
        assert(held.bytes <= budget && held.count <= 5 && held.count >= 4, `30 groups read: kept ${held.count} rosters, ${held.bytes} of ${budget} bytes`);
        const last = await roster(many[29], m1);
        const builds = snaps.rosterSnapshotsHeld().builds;
        await roster(many[29], m1);
        assert(snaps.rosterSnapshotsHeld().builds === builds && last.status === 200, 'the most recent group is still kept (no build)');
        await roster(many[0], m1);
        assert(snaps.rosterSnapshotsHeld().builds === builds + 1, 'the oldest was evicted (one build)');
        snaps.setRosterSnapshotsForTests({ byteBudget: 16 });
        const big = await roster(open.id, m1);
        assert(big.status === 200 && big.body.equals(unshared(open.id, 'active')) && snaps.rosterSnapshotsHeld().count === 0,
            'a roster bigger than the budget on its own: sent whole, not kept');
        snaps.setRosterSnapshotsForTests(undefined);
    }

    // ---- 7. Readers who stop reading a big roster ----
    {
        const bigGroup = se.createGroup({ name: 'Big roster', createdBy: lead.pk, joinPolicy: 'open' } as any);
        const tx = db.transaction(() => {
            for (let i = 0; i < 3000; i++) {
                const pk = crypto.randomBytes(32).toString('hex');
                insert.run(pk, `big${i}-${'x'.repeat(40)}`, new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString(), `big-${i}`);
                db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at) VALUES (?, ?, 'member', 'active', ?, ?)`)
                    .run(bigGroup.id, pk, new Date().toISOString(), new Date().toISOString());
            }
        });
        tx();
        se.bumpGroupsVersion();
        const full = await roster(bigGroup.id, m1);
        assert(full.status === 200 && full.body.equals(unshared(bigGroup.id, 'active')), `a big roster (${(full.body.length / 1e6).toFixed(2)} MB): byte for byte`);
        const stalled: tls.TLSSocket[] = [];
        const rssBefore = process.memoryUsage().rss;
        for (let i = 0; i < 24; i++) {
            const path = `/api/groups/${bigGroup.id}/members`;
            const h = signedHeaders('GET', path, '', m1);
            const s = tls.connect({ host: '127.0.0.1', port: PORT, rejectUnauthorized: false });
            s.pause();
            s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
            stalled.push(s);
        }
        await new Promise(r => setTimeout(r, 1500));
        const rssGrowth = process.memoryUsage().rss - rssBefore;
        const t0 = Date.now();
        const fresh = await roster(open.id, m1);
        const took = Date.now() - t0;
        assert(fresh.status === 200 && took < 3000, `24 readers stalled on the big roster: a fresh read still answers (${took} ms)`);
        assert(rssGrowth < 24 * full.body.length / 2, `24 stalled readers hold a window each, not the roster: RSS +${(rssGrowth / 1e6).toFixed(1)} MB (one roster ${(full.body.length / 1e6).toFixed(1)} MB)`);
        for (const s of stalled) s.destroy();
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
