/**
 * MCP owner slice S2, the undo (design §2.3, §2.7): an owner's assistant edits and removes only what IT made, and the owner
 * removes everything an assistant made from Settings, after revoke too. End to end with the official TypeScript MCP SDK client
 * over REAL HTTPS through the real Koa middleware; nothing here contacts anything but the server it starts.
 *
 *   1. my_posts lists exactly this grant's posts (as the owner and as an enterprise they keep), titles fenced, no key.
 *   2. update_post changes this grant's post through the route's own updatePost; another grant's post, the owner's own from the
 *      app and another member's are refused in words and unchanged; a title past the form's 50 and a made-up category refused.
 *   3. remove_post takes down this grant's post; the owner's own from the app is refused and stays up.
 *   4. remove_all_i_made: the wrong confirm removes nothing; the right one takes down only this grant's live posts (another
 *      grant's, the owner's own and another member's stay); a second the same day is refused (once a day). Each removal is an
 *      ADMIN line naming the ids, and the AGENT line names them too.
 *   5. The Settings button after revoke: the revoked grant is listed as disconnected with its count; "Remove its posts" from a
 *      computer's key session is sent to the phone (403 phone_required) and removes nothing; from the phone's Manage it takes
 *      down that grant's posts and no other; an unknown id → 404; an admin → 403.
 *   6. MCP-OWNER-POSTS-W: a ticked token with no name, or one too long, is refused 400 before the fresh proof is asked.
 *   7. createdVia is on the author's own read and on no other member's.
 *   8. The ledger audit is the same after as before: no Bean moved.
 *
 * Run: SERVER_SUITES_ONLY=test-mcp-owner-undo TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setMemberPhoto, clearEnterpriseFloorCache } from '@beanpool/engine';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, runLedgerAudit, getPosts, createPost } from './state-engine.js';
import { updateLocalConfig, getLocalConfig } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { ownerPhoneSessionHeaders, ownerSessionHeaders } from './admin-auth-test-harness.js';
import { db } from './db/db.js';
import { enterpriseRef, REMOVE_ALL_CONFIRM } from './agent/owner-posts.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Reply { status: number; body: any; text: string }
async function call(method: string, p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
    const res = await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: 'manual',
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body, text };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 160)}`;
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

interface Key { pub: string; priv: crypto.KeyObject }
function keypair(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'beanpool-test-assistant', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: bearer(token) } }));
    return client;
}

const structured = (r: any): any => r?.structuredContent ?? null;
const errorText = (r: any): string => (r?.content as any)?.[0]?.text ?? '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const statusOf = (id: string): string | undefined => (db.prepare('SELECT status FROM posts WHERE id = ?').get(id) as { status?: string } | undefined)?.status;
const titleOf = (id: string): string | undefined => (db.prepare('SELECT title FROM posts WHERE id = ?').get(id) as { title?: string } | undefined)?.title;
const adminLines = (): Array<{ metadata: string }> =>
    db.prepare("SELECT metadata FROM system_logs WHERE category = 'ADMIN' AND message = 'Posts an AI assistant made removed' ORDER BY rowid").all() as Array<{ metadata: string }>;

async function jpeg(width: number, height: number): Promise<string> {
    const buf = await sharp({ create: { width, height, channels: 3, background: { r: 180, g: 120, b: 60 } } }).jpeg({ quality: 80 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function main(): Promise<void> {
    console.log('\n=== An owner\'s assistant undoes what it made (MCP owner S2) ===\n');
    const webRoot = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'bp-mcp-undo-'));
    fs.mkdirSync(path.join(webRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const owner = keypair(), owner2 = keypair(), mia = keypair(), admin = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    const longAgo = new Date(Date.now() - 60 * DAY).toISOString();
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(longAgo, owner.pub);
    setMemberPhoto(db, owner.pub, AVATAR);
    const addMember = (k: Key, callsign: string) => {
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', ?, ?, 'inv-test')`).run(k.pub, callsign, longAgo, owner.pub);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(k.pub);
        setMemberPhoto(db, k.pub, AVATAR);
    };
    addMember(owner2, 'Ottilie');
    addMember(mia, 'Mia Neighbour');
    addMember(admin, 'Adele Admin');
    grantNodeRole(owner2.pub, 'owner', 'SYSTEM');
    grantNodeRole(admin.pub, 'admin', 'SYSTEM');
    const bakery = keypair().pub;
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, 'Olive Bakery Co-op', ?, ?, 'inv-test', 'active', 1)`).run(bakery, longAgo, owner.pub);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(bakery);
    setMemberPhoto(db, bakery, AVATAR);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(bakery, owner.pub);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(owner.pub);
    clearEnterpriseFloorCache(db);
    updateLocalConfig({ gateway: { ...(getLocalConfig().gateway ?? {}), rateLimiting: { enabled: true, maxRequestsPerMinute: 100000 } } as any });

    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const auditBefore = runLedgerAudit();

    try {
        resetAdminAuthTarpit();
        // ── 6. The name is checked before the proof (MCP-OWNER-POSTS-W) ──────────────────────────────────
        const noName = await call('POST', '/api/local/admin/agent/grants', { headers: ownerSessionHeaders(owner.pub), body: { canPost: true } });
        const longName = await call('POST', '/api/local/admin/agent/grants', { headers: ownerSessionHeaders(owner.pub), body: { name: 'n'.repeat(61), canPost: true } });
        assert(noName.status === 400 && /Give the token a name/.test(noName.body?.error ?? '') && longName.status === 400 && /at most 60/.test(longName.body?.error ?? ''),
            `a ticked token with no name, or one of 61 characters, from a computer's session → 400 in words, before the proof is asked (${show(noName)}; ${show(longName)})`);

        const make = async (name: string) => {
            const r = await call('POST', '/api/local/admin/agent/grants', { headers: ownerPhoneSessionHeaders(owner.pub), body: { name, canPost: true } });
            return { token: r.body?.token as string, id: r.body?.grant?.id as string, status: r.status };
        };
        const A = await make('Olive\'s Claude');
        const B = await make('Olive\'s other helper');
        assert(A.status === 201 && B.status === 201 && !!A.token && !!B.token, `two ticked assistants connected (${A.status}, ${B.status})`);
        const a = await connect(A.token);
        const b = await connect(B.token);
        const photo = await jpeg(640, 480);
        const offer = (title: string) => ({ title, description: 'Seeded for the community.', category: 'food', beans: 3, lat: -28.55, lng: 153.5, photos: [photo] });
        const madeA: string[] = [];
        for (const t of ['Lemons from the tree', 'Duck eggs', 'Rhubarb crowns']) {
            const r = await a.callTool({ name: 'create_offer', arguments: offer(t) });
            madeA.push(structured(r)?.postId);
        }
        const asBakery = await a.callTool({ name: 'create_enterprise_listing', arguments: { ...offer('Bakery rye loaves'), kind: 'offer', as_enterprise: enterpriseRef(bakery) } });
        madeA.push(structured(asBakery)?.postId);
        const madeB = structured(await b.callTool({ name: 'create_offer', arguments: offer('Helper-made marmalade') }))?.postId as string;
        const tiny = await jpeg(64, 48);
        const ownApp = createPost('offer', 'food', 'Olive\'s own jam, from the app', 'From the phone.', 2, 'fixed', owner.pub, -28.55, 153.5, [tiny], false)!.id;
        const miaPost = createPost('offer', 'food', 'Mia\'s kombucha', 'Scoby too.', 2, 'fixed', mia.pub, -28.55, 153.5, [tiny], false)!.id;
        assert(madeA.every(id => typeof id === 'string') && madeA.length === 4 && !!madeB && !!ownApp && !!miaPost,
            `assistant A made 4 (one as the bakery), B made 1, the owner 1 in the app, Mia 1 (${errorText(asBakery) || 'ok'})`);

        // ── 1. my_posts ──────────────────────────────────────────────────────────────────────────────
        const mine = structured(await a.callTool({ name: 'my_posts', arguments: {} }));
        const listed = (mine?.posts ?? []) as any[];
        const mineJson = JSON.stringify(mine);
        assert(mine?.total === 4 && listed.length === 4 && listed.map(p => p.postId).sort().join() === [...madeA].sort().join()
            && listed.filter(p => p.by === 'me').length === 3 && listed.filter(p => p.by === `enterprise:${enterpriseRef(bakery)}`).length === 1
            && listed.every(p => p.title?.untrusted === true && /<<<MEMBER-TEXT [0-9a-f]{8}: post .+, title\./.test(p.title.text)),
            `my_posts lists exactly A's four, as the owner and as the bakery, titles fenced (${listed.map(p => p.by).join(', ')})`);
        assert(![owner.pub, bakery, mia.pub, madeB, ownApp, miaPost].some(s => mineJson.includes(s)) && !/https?:\/\//.test(mineJson),
            'my_posts carries no key, no other post, no URL');

        // ── 2. update_post ───────────────────────────────────────────────────────────────────────────
        const upd = await a.callTool({ name: 'update_post', arguments: { post_id: madeA[0], title: 'Meyer lemons from the tree', beans: 4 } });
        const credits = (db.prepare('SELECT credits FROM posts WHERE id = ?').get(madeA[0]) as any)?.credits;
        assert(!upd.isError && structured(upd)?.postId === madeA[0] && titleOf(madeA[0]) === 'Meyer lemons from the tree' && credits === 4 && structured(upd)?.editsToday === 1,
            `update_post changes A's own post through the app's edit (${errorText(upd) || JSON.stringify(structured(upd))})`);
        const notMine = 'That is not a post this assistant made: edit or remove it in the app. my_posts lists the ones it made.';
        for (const [label, id, before] of [['B\'s', madeB, 'Helper-made marmalade'], ['the owner\'s own from the app', ownApp, 'Olive\'s own jam, from the app'], ['Mia\'s', miaPost, 'Mia\'s kombucha']] as const) {
            const r = await a.callTool({ name: 'update_post', arguments: { post_id: id, title: 'Taken over' } });
            assert(r.isError === true && errorText(r) === notMine && titleOf(id) === before, `update_post on ${label} post → refused in words, unchanged (${errorText(r)})`);
        }
        const tooLong = await a.callTool({ name: 'update_post', arguments: { post_id: madeA[1], title: 'x'.repeat(51) } });
        const badCat = await a.callTool({ name: 'update_post', arguments: { post_id: madeA[1], category: 'weapons' } });
        const nothing = await a.callTool({ name: 'update_post', arguments: { post_id: madeA[1] } });
        assert(tooLong.isError === true && /at most 50/.test(errorText(tooLong)) && badCat.isError === true && /category must be one of/.test(errorText(badCat))
            && nothing.isError === true && /at least one field/.test(errorText(nothing)) && titleOf(madeA[1]) === 'Duck eggs',
            `a title of 51, a made-up category, or no field → refused in words, unchanged (${errorText(tooLong)} | ${errorText(badCat)} | ${errorText(nothing)})`);

        // ── 3. remove_post ───────────────────────────────────────────────────────────────────────────
        const rm = await a.callTool({ name: 'remove_post', arguments: { post_id: madeA[1] } });
        const rmOwn = await a.callTool({ name: 'remove_post', arguments: { post_id: ownApp } });
        assert(!rm.isError && JSON.stringify(structured(rm)?.removed) === JSON.stringify([madeA[1]]) && statusOf(madeA[1]) === 'cancelled',
            `remove_post takes down A's own post (${errorText(rm) || statusOf(madeA[1])})`);
        assert(rmOwn.isError === true && errorText(rmOwn) === notMine && statusOf(ownApp) === 'active', `remove_post on the owner's own post from the app → refused, it stays up (${errorText(rmOwn)})`);

        // ── 4. remove_all_i_made ─────────────────────────────────────────────────────────────────────
        const linesBefore = adminLines().length;
        const wrong = await a.callTool({ name: 'remove_all_i_made', arguments: { confirm: 'yes' } });
        assert(wrong.isError === true && /nothing was removed/.test(errorText(wrong)) && statusOf(madeA[0]) === 'active', `the wrong confirm removes nothing (${errorText(wrong)})`);
        const all = await a.callTool({ name: 'remove_all_i_made', arguments: { confirm: REMOVE_ALL_CONFIRM } });
        const removed = (structured(all)?.removed ?? []) as string[];
        assert(!all.isError && removed.sort().join() === [madeA[0], madeA[2], madeA[3]].sort().join() && [madeA[0], madeA[2], madeA[3]].every(id => statusOf(id) === 'cancelled'),
            `remove_all_i_made takes down A's three live posts, the bakery's one among them (${errorText(all) || removed.length})`);
        assert([madeB, ownApp, miaPost].every(id => statusOf(id) === 'active'), 'B\'s post, the owner\'s own and Mia\'s stay up');
        const again = await a.callTool({ name: 'remove_all_i_made', arguments: { confirm: REMOVE_ALL_CONFIRM } });
        assert(again.isError === true && /once today/.test(errorText(again)), `a second remove_all_i_made the same day → refused (${errorText(again)})`);
        const newLines = adminLines().slice(linesBefore).map(l => JSON.parse(l.metadata));
        assert(newLines.length === 1 && newLines[0].grant === A.id && newLines[0].via === 'assistant' && newLines[0].count === 3
            && [madeA[0], madeA[2], madeA[3]].every(id => newLines[0].posts.includes(id)), `one ADMIN line names the grant and the three ids (${JSON.stringify(newLines)})`);
        const agentLine = (db.prepare("SELECT metadata FROM system_logs WHERE category = 'AGENT' AND message = 'Assistant wrote' AND metadata LIKE '%remove_all_i_made%' ORDER BY rowid DESC LIMIT 1").get() as any)?.metadata ?? '';
        assert(removed.every(id => agentLine.includes(id)), 'the AGENT line of remove_all_i_made names the ids too');

        // ── 7. createdVia on the author's own read only ──────────────────────────────────────────────
        const own = getPosts({ id: madeB, viewerPubkey: owner.pub })[0];
        const other = getPosts({ id: madeB, viewerPubkey: mia.pub })[0];
        assert(own?.createdVia === `assistant:${B.id}` && !!other && other.createdVia === undefined,
            `createdVia is on the author's own read (${own?.createdVia}) and on no other member's (${other?.createdVia})`);

        // ── 5. "Remove its posts" after revoke ───────────────────────────────────────────────────────
        await b.close().catch(() => {});
        const revoked = await call('POST', `/api/local/admin/agent/grants/${encodeURIComponent(B.id)}/revoke`, { headers: ownerSessionHeaders(owner.pub), body: {} });
        const list = await call('GET', '/api/local/admin/agent/grants', { headers: ownerSessionHeaders(owner2.pub) });
        const gone = (list.body?.disconnected ?? []) as Array<{ id: string; madePosts: number }>;
        assert(revoked.status === 200 && gone.some(g => g.id === B.id && g.madePosts === 1) && !(list.body?.grants ?? []).some((g: any) => g.id === B.id),
            `revoked, B is listed as a disconnected assistant with its one post (${JSON.stringify(gone)})`);
        const fromComputer = await call('POST', `/api/local/admin/agent/grants/${encodeURIComponent(B.id)}/remove-made`, { headers: ownerSessionHeaders(owner2.pub), body: {} });
        assert(fromComputer.status === 403 && fromComputer.body?.code === 'phone_required' && statusOf(madeB) === 'active',
            `"Remove its posts" from a computer's key session → 403 phone_required, nothing removed (${show(fromComputer)})`);
        const asAdmin = await call('POST', `/api/local/admin/agent/grants/${encodeURIComponent(B.id)}/remove-made`, { headers: ownerPhoneSessionHeaders(admin.pub), body: {} });
        assert(asAdmin.status === 403 && statusOf(madeB) === 'active', `an admin → 403 (${show(asAdmin)})`);
        const unknown = await call('POST', '/api/local/admin/agent/grants/no-such-grant/remove-made', { headers: ownerPhoneSessionHeaders(owner2.pub), body: {} });
        assert(unknown.status === 404, `an id no assistant and no post has → 404 (${show(unknown)})`);
        const linesBeforeButton = adminLines().length;
        const pressed = await call('POST', `/api/local/admin/agent/grants/${encodeURIComponent(B.id)}/remove-made`, { headers: ownerPhoneSessionHeaders(owner2.pub), body: {} });
        assert(pressed.status === 200 && JSON.stringify(pressed.body?.removed) === JSON.stringify([madeB]) && statusOf(madeB) === 'cancelled',
            `the other owner presses "Remove its posts" on the phone after revoke: B's post is taken down (${show(pressed)})`);
        assert([ownApp, miaPost].every(id => statusOf(id) === 'active'), 'the owner\'s own post and Mia\'s stay up');
        const buttonLine = adminLines().slice(linesBeforeButton).map(l => JSON.parse(l.metadata));
        assert(buttonLine.length === 1 && buttonLine[0].via === 'settings' && buttonLine[0].grant === B.id && buttonLine[0].posts.includes(madeB),
            `its ADMIN line says Settings, the grant and the id (${JSON.stringify(buttonLine)})`);
        const after = await call('GET', '/api/local/admin/agent/grants', { headers: ownerSessionHeaders(owner.pub) });
        assert(!(after.body?.disconnected ?? []).some((g: any) => g.id === B.id), 'with nothing left up, B is no longer listed');
        await a.close().catch(() => {});

        // ── 8. No Bean moved ─────────────────────────────────────────────────────────────────────────
        const auditAfter = runLedgerAudit();
        assert(auditAfter.ok === auditBefore.ok && auditAfter.sumBalances === auditBefore.sumBalances && auditAfter.drift === auditBefore.drift
            && auditAfter.strandedEscrows === auditBefore.strandedEscrows, `the ledger audit is the same after as before (${JSON.stringify(auditBefore)} → ${JSON.stringify(auditAfter)})`);
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        console.log(`\n${passed}/${run} passed`);
        process.exit(process.exitCode ?? 0);
    }
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
