/**
 * Tests for the PHOTO UPLOAD BUDGET and FREE-DISK FLOOR (storage design row P7):
 *   - Under budget passes.
 *   - The upload that crosses budget is refused (HTTP 429, Retry-After header,
 *     "You've shared a lot of photos today. Try again tomorrow.") across:
 *       1. Chat attachments (POST /api/messages/send)
 *       2. Listing photos (POST /api/marketplace/posts and PATCH /api/marketplace/posts/:id)
 *       3. Avatars (POST /api/profile/update)
 *       4. Group pictures (POST /api/groups and PATCH /api/groups/:id)
 *   - A day later it passes.
 *   - Setting PHOTO_BYTES_PER_MEMBER_PER_DAY=0 turns it off.
 *   - The free-disk floor (PHOTO_MIN_FREE_DISK_MB) refuses on the disk store with HTTP 507
 *     ("This community's storage is nearly full. Tell its owner.") and owners/admins are not exempt.
 *   - The free-disk floor is skipped when IMAGE_STORE=s3.
 *
 * Modelled on apps/server/src/test-photo-pixel-cap-attachment-read.ts.
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-photo-upload-budget.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'ENFORCE_READ_AUTH', 'ENFORCE_WS_AUTH', 'ENFORCE_LEDGER_AUTH', 'NODE_PROFILE', 'PRIVATE_PREVIEW']) delete process.env[k];
if (process.env.READ_AUTH === 'off') process.env.ENFORCE_READ_AUTH = 'false';
process.env.DISABLE_UPDATE_CHECK = 'true';

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
const fails: string[] = [];
function check(id: string, cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ [${id}] ${msg}`); } else { fails.push(id); console.error(`✗ [${id}] ${msg}`); }
}
let BASE = '';
const DAY = 86400_000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
type Id = { pk: string; privateKey: crypto.KeyObject };
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now(); const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return { 'X-Public-Key': id.pk, 'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'), 'X-Timestamp': String(ts), 'X-Nonce': nonce };
}
let beforeCall: () => void = () => {};
async function req(method: string, p: string, id?: Id, body?: any): Promise<{ status: number; headers: Headers; body: any }> {
    beforeCall();
    const s = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = id ? signedHeaders(method, p, s, id) : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : s });
    const t = await res.text(); let json: any; try { json = JSON.parse(t); } catch { json = t; }
    return { status: res.status, headers: res.headers, body: json };
}

const noiseJpeg = async (w: number, h: number) =>
    sharp(crypto.randomBytes(w * h * 3), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
const du = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;
const errorOf = (r: { body: any }) => String(r.body?.message ?? r.body?.error ?? '');

const BUDGET_SENTENCE = "You've shared a lot of photos today. Try again tomorrow.";
const FULL_SENTENCE = "This community's storage is nearly full. Tell its owner.";

async function runRestartChild(): Promise<void> {
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { lockedDm } = await import('./dm-test-payload.js');
    const safeLockedDm = (bytes = 32) => {
        let d = lockedDm(bytes);
        while (d.ciphertext.startsWith('/')) d = lockedDm(bytes);
        return d;
    };
    await initTls();
    se.initStateEngine();
    const base = `https://localhost:${await startHttpsServer(0)}`;
    const pk = process.argv[3];
    const convId = process.argv[4];
    const keyPem = Buffer.from(process.argv[5], 'base64').toString('utf8');
    const reba: Id = { pk, privateKey: crypto.createPrivateKey(keyPem) };
    const ph = safeLockedDm(10_000);
    const s = JSON.stringify({
        conversationId: convId,
        authorPubkey: reba.pk,
        ...safeLockedDm(),
        type: 'image',
        attachment: { data: ph.ciphertext, nonce: ph.nonce }
    });
    const headers = { ...signedHeaders('POST', '/api/messages/send', s, reba), 'Content-Type': 'application/json' };
    const res = await fetch(`${base}/api/messages/send`, { method: 'POST', headers, body: s });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    console.log(`RESTART_CHILD_RESULT:${JSON.stringify({ status: res.status, body })}`);
    process.exit(0);
}

async function main(): Promise<void> {
    if (process.argv[2] === '--restart-child') {
        await runRestartChild();
        return;
    }
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { resetChatRateLimit } = await import('./chat-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { lockedDm } = await import('./dm-test-payload.js');
    const safeLockedDm = (bytes = 32) => {
        let d = lockedDm(bytes);
        while (d.ciphertext.startsWith('/')) d = lockedDm(bytes);
        return d;
    };
    const budgetModule = await import('./engine/photo-upload-budget.js').catch(() => null);
    const resetPhotoBudgetForTests = budgetModule?.resetPhotoBudgetForTests ?? (() => {});
    const advancePhotoBudgetForTests = budgetModule?.advancePhotoBudgetForTests ?? (() => {});
    const setSimulatedFreeDiskBytesForTests = budgetModule?.setSimulatedFreeDiskBytesForTests ?? (() => {});
    const getMemberPhotoUsageForTests = budgetModule?.getMemberPhotoUsageForTests ?? (() => ({ usedBytes: 0, entryCount: 0 }));

    beforeCall = () => { resetGatewayRateLimit(); resetChatRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };
    await initTls(); se.initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    console.log(`read auth ${process.env.ENFORCE_READ_AUTH === 'false' ? 'OFF' : 'ON'}`);

    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, 'seed', ?)`).run(id.pk, callsign, new Date(Date.now() - 60 * DAY).toISOString(), `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, id.pk, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };

    const makeOwner = (id: Id): void => {
        db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')`).run(id.pk);
    };

    const smallImg = du('image/jpeg', await noiseJpeg(30, 30)); // ~1.5 KB
    const bigImg = du('image/jpeg', await noiseJpeg(150, 150)); // ~21 KB

    // ── 1. Under budget passes ──
    {
        resetPhotoBudgetForTests();
        process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '50000'; // 50 KB budget

        const alice = member('BudAlice');
        const bob = member('BudBob');
        const conv = se.createConversation('dm', [alice.pk, bob.pk], alice.pk)!;

        // Small attachment (~10 KB) is well under 50 KB
        const ph = safeLockedDm(10_000);
        const s = await req('POST', '/api/messages/send', alice, {
            conversationId: conv.id,
            authorPubkey: alice.pk,
            ...safeLockedDm(),
            type: 'image',
            attachment: { data: ph.ciphertext, nonce: ph.nonce }
        });
        check('under-budget', s.status === 200, `chat attachment under budget → 200 (got ${s.status})`);
    }

    // ── 2. The upload that crosses budget is refused (each kind: chat, listing, avatar, group) ──
    {
        // 2a. Chat attachment
        {
            resetPhotoBudgetForTests();
            process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '30000'; // 30 KB budget
            const alice = member('BudAlice2');
            const bob = member('BudBob2');
            const conv = se.createConversation('dm', [alice.pk, bob.pk], alice.pk)!;

            // Spend 20 KB
            const ph1 = safeLockedDm(20_000);
            const s1 = await req('POST', '/api/messages/send', alice, {
                conversationId: conv.id,
                authorPubkey: alice.pk,
                ...safeLockedDm(),
                type: 'image',
                attachment: { data: ph1.ciphertext, nonce: ph1.nonce }
            });
            check('chat-first-pass', s1.status === 200, `first attachment passes → 200 (got ${s1.status})`);

            // Try another 20 KB (total 40 KB > 30 KB budget)
            const ph2 = safeLockedDm(20_000);
            const s2 = await req('POST', '/api/messages/send', alice, {
                conversationId: conv.id,
                authorPubkey: alice.pk,
                ...safeLockedDm(),
                type: 'image',
                attachment: { data: ph2.ciphertext, nonce: ph2.nonce }
            });
            check('chat-crossing-refused', s2.status === 429, `chat attachment crossing budget → 429 (got ${s2.status})`);
            check('chat-retry-after', Boolean(s2.headers.get('retry-after')), `has Retry-After header (got ${s2.headers.get('retry-after')})`);
            check('chat-sentence', errorOf(s2) === BUDGET_SENTENCE, `plain sentence returned (got "${errorOf(s2)}")`);
            check('chat-code', s2.body?.code === 'photo_budget', `code is photo_budget (got ${s2.body?.code})`);
        }

        // 2b. Listing photo (POST /api/marketplace/posts and PATCH /api/marketplace/posts/:id)
        {
            resetPhotoBudgetForTests();
            process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '10000'; // 10 KB budget
            const carol = member('BudCarol');

            // bigImg is ~21 KB > 10 KB budget
            const s = await req('POST', '/api/marketplace/posts', carol, {
                type: 'offer',
                title: 'Fresh apples from orchard',
                description: 'Crisp and juicy seasonal apples for trade',
                category: 'food',
                authorPublicKey: carol.pk,
                credits: 5,
                photos: [bigImg]
            });
            check('listing-crossing-refused', s.status === 429, `listing photo crossing budget → 429 (got ${s.status})`);
            check('listing-sentence', errorOf(s) === BUDGET_SENTENCE, `listing plain sentence (got "${errorOf(s)}")`);
            check('listing-retry-after', Boolean(s.headers.get('retry-after')), `listing has Retry-After header`);

            // Edit listing photo crossing budget
            // First create a post with smallImg (under budget: ~1.5 KB < 10 KB)
            const sOk = await req('POST', '/api/marketplace/posts', carol, {
                type: 'offer',
                title: 'Fresh apples from orchard',
                description: 'Crisp and juicy seasonal apples for trade',
                category: 'food',
                authorPublicKey: carol.pk,
                credits: 5,
                photos: [smallImg]
            });
            const postId = sOk.body?.post?.id;
            check('listing-edit-setup', sOk.status === 200 && Boolean(postId), `listing created under budget → 200`);

            // Now edit with bigImg, which crosses the 10 KB budget
            const sEdit = await req('POST', '/api/marketplace/posts/update', carol, {
                id: postId,
                authorPublicKey: carol.pk,
                photos: [bigImg]
            });
            check('listing-edit-crossing-refused', sEdit.status === 429, `listing edit photo crossing budget → 429 (got ${sEdit.status})`);
            check('listing-edit-sentence', errorOf(sEdit) === BUDGET_SENTENCE, `listing edit plain sentence`);

            // 2b-2. Listing edit sending back existing photo URLs records 0 B
            const fiona = member('BudFiona');
            const createRes = await req('POST', '/api/marketplace/posts', fiona, {
                type: 'offer',
                title: 'Handmade pottery bowl',
                description: 'Ceramic bowl',
                category: 'art',
                authorPublicKey: fiona.pk,
                credits: 10,
                photos: [smallImg]
            });
            const pId = createRes.body?.post?.id;
            const u1Post = getMemberPhotoUsageForTests(fiona.pk).usedBytes;
            check('listing-urls-edit-setup', createRes.status === 200 && u1Post > 0, `listing created with photo, recorded ${u1Post} B`);

            const readRes = await req('GET', '/api/marketplace/posts?limit=50', fiona);
            const postsList: any[] = Array.isArray(readRes.body) ? readRes.body : (readRes.body?.posts ?? []);
            const myPost = postsList.find((p: any) => p.id === pId);
            const photoUrls: string[] = Array.isArray(myPost?.photos) ? myPost.photos : JSON.parse(myPost?.photos ?? '[]');
            check('listing-urls-edit-got-urls', photoUrls.length === 1 && photoUrls[0].includes('/photos/'), 'read back listing has photo URL');

            const editRes = await req('POST', '/api/marketplace/posts/update', fiona, {
                id: pId,
                authorPublicKey: fiona.pk,
                title: 'Handmade pottery bowl (typo fix)',
                photos: photoUrls
            });
            const u2Post = getMemberPhotoUsageForTests(fiona.pk).usedBytes;
            check('listing-edit-same-urls-zero-bytes', u2Post - u1Post === 0, `text-only edit that sends photo URLs back records 0 B (got +${u2Post - u1Post} B)`);
        }

        // 2c. Avatar (POST /api/profile/update)
        {
            resetPhotoBudgetForTests();
            process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '10000'; // 10 KB budget
            const dave = member('BudDave');

            const s = await req('POST', '/api/profile/update', dave, {
                avatar: bigImg
            });
            check('avatar-crossing-refused', s.status === 429, `avatar crossing budget → 429 (got ${s.status})`);
            check('avatar-sentence', errorOf(s) === BUDGET_SENTENCE, `avatar plain sentence (got "${errorOf(s)}")`);
            check('avatar-retry-after', Boolean(s.headers.get('retry-after')), `avatar has Retry-After header`);

            // 2c-2. PWA-style profile save with avatar as read records 0 B
            const greg = member('BudGreg');
            const setRes = await req('POST', '/api/profile/update', greg, { avatar: smallImg });
            const u1Prof = getMemberPhotoUsageForTests(greg.pk).usedBytes;
            check('profile-save-setup', setRes.status === 200 && u1Prof > 0, `avatar set, recorded ${u1Prof} B`);

            const profRes = await req('GET', `/api/profile/${greg.pk}`, greg);
            const av = profRes.body?.avatar ?? profRes.body?.profile?.avatar ?? profRes.body?.avatarUrl ?? profRes.body?.profile?.avatarUrl;
            check('profile-save-got-avatar', typeof av === 'string' && av.startsWith('data:'), 'profile read back has data URL avatar');

            const saveRes = await req('POST', '/api/profile/update', greg, { avatar: av, bio: 'Updated bio' });
            const u2Prof = getMemberPhotoUsageForTests(greg.pk).usedBytes;
            check('profile-save-same-avatar-zero-bytes', u2Prof - u1Prof === 0, `PWA-style profile save with avatar as read records 0 B (got +${u2Prof - u1Prof} B)`);
        }

        // 2d. Group picture (POST /api/groups and PATCH /api/groups/:id)
        {
            resetPhotoBudgetForTests();
            process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '10000'; // 10 KB budget
            const erin = member('BudErin');

            const s = await req('POST', '/api/groups', erin, {
                name: 'Photo Club',
                description: 'Group for photography enthusiasts',
                avatarUrl: bigImg
            });
            check('group-crossing-refused', s.status === 429, `group picture crossing budget → 429 (got ${s.status})`);
            check('group-sentence', errorOf(s) === BUDGET_SENTENCE, `group plain sentence (got "${errorOf(s)}")`);
            check('group-retry-after', Boolean(s.headers.get('retry-after')), `group has Retry-After header`);

            // Edit group picture crossing budget
            const sOk = await req('POST', '/api/groups', erin, {
                name: 'Photo Club Two',
                description: 'Second group',
                avatarUrl: smallImg
            });
            const groupId = sOk.body?.id;
            check('group-edit-setup', sOk.status === 201 && Boolean(groupId), `group created under budget → 201`);

            const sEdit = await req('PATCH', `/api/groups/${groupId}`, erin, {
                avatarUrl: bigImg
            });
            check('group-edit-crossing-refused', sEdit.status === 429, `group edit picture crossing budget → 429 (got ${sEdit.status})`);
            check('group-edit-sentence', errorOf(sEdit) === BUDGET_SENTENCE, `group edit plain sentence`);
        }
    }

    // ── 3. A day later it passes ──
    {
        resetPhotoBudgetForTests();
        process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '30000'; // 30 KB budget
        const frank = member('BudFrank');
        const grace = member('BudGrace');
        const conv = se.createConversation('dm', [frank.pk, grace.pk], frank.pk)!;

        // Use up budget
        const ph1 = safeLockedDm(25_000);
        const s1 = await req('POST', '/api/messages/send', frank, {
            conversationId: conv.id,
            authorPubkey: frank.pk,
            ...safeLockedDm(),
            type: 'image',
            attachment: { data: ph1.ciphertext, nonce: ph1.nonce }
        });
        check('day-later-setup', s1.status === 200, `first attachment passes → 200`);

        // Second attachment blocked
        const ph2 = safeLockedDm(15_000);
        const s2 = await req('POST', '/api/messages/send', frank, {
            conversationId: conv.id,
            authorPubkey: frank.pk,
            ...safeLockedDm(),
            type: 'image',
            attachment: { data: ph2.ciphertext, nonce: ph2.nonce }
        });
        check('day-later-blocked', s2.status === 429, `second attachment blocked today → 429 (got ${s2.status} ${JSON.stringify(s2.body)})`);

        // Advance a day later (24 hours + 10 seconds)
        advancePhotoBudgetForTests(DAY + 10_000);

        // Now it passes!
        const s3 = await req('POST', '/api/messages/send', frank, {
            conversationId: conv.id,
            authorPubkey: frank.pk,
            ...safeLockedDm(),
            type: 'image',
            attachment: { data: ph2.ciphertext, nonce: ph2.nonce }
        });
        check('day-later-passes', s3.status === 200, `same attachment a day later passes → 200 (got ${s3.status})`);
    }

    // ── 4. Setting 0 turns it off ──
    {
        resetPhotoBudgetForTests();
        process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '0'; // 0 = off

        const heidi = member('BudHeidi');
        const ivan = member('BudIvan');
        const conv = se.createConversation('dm', [heidi.pk, ivan.pk], heidi.pk)!;

        // Big attachment (~80 KB)
        const ph = safeLockedDm(80_000);
        const s = await req('POST', '/api/messages/send', heidi, {
            conversationId: conv.id,
            authorPubkey: heidi.pk,
            ...safeLockedDm(),
            type: 'image',
            attachment: { data: ph.ciphertext, nonce: ph.nonce }
        });
        check('zero-turns-off', s.status === 200, `0 turns off budget check → 200 (got ${s.status})`);

        // A budget of only spaces ("   ") does not turn the budget off (defaults to 100 MB, N4)
        process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '   ';
        const { photoBytesPerMemberPerDay } = await import('./engine/photo-upload-budget.js');
        check('spaces-env-is-default', photoBytesPerMemberPerDay() === 104_857_600, `budget of spaces defaults to 100 MB (got ${photoBytesPerMemberPerDay()})`);
    }

    // ── 5. Free-disk floor refuses on disk store (HTTP 507), owners/admins not exempt ──
    {
        resetPhotoBudgetForTests();
        delete process.env.IMAGE_STORE; // disk store
        process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '100000000'; // 100 MB budget
        process.env.PHOTO_MIN_FREE_DISK_MB = '2048'; // 2048 MB floor

        const judy = member('BudJudy');
        const owner = member('BudOwner');
        makeOwner(owner);

        // Simulate free disk space below 2048 MB (e.g. 500 MB)
        setSimulatedFreeDiskBytesForTests(500 * 1024 * 1024);

        // Judy tries to update avatar
        const s1 = await req('POST', '/api/profile/update', judy, { avatar: smallImg });
        check('floor-refuses-disk', s1.status === 507, `disk floor refusal → 507 (got ${s1.status})`);
        check('floor-sentence', errorOf(s1) === FULL_SENTENCE, `disk floor plain sentence (got "${errorOf(s1)}")`);
        check('floor-code', s1.body?.code === 'storage_nearly_full', `disk floor code is storage_nearly_full`);

        // Owner is NOT exempt from floor
        const s2 = await req('POST', '/api/profile/update', owner, { avatar: smallImg });
        check('floor-owner-not-exempt', s2.status === 507 && errorOf(s2) === FULL_SENTENCE, `owner is not exempt from disk floor → 507 (got ${s2.status})`);
    }

    // ── 6. Free-disk floor is skipped on S3 ──
    {
        // Set IMAGE_STORE=s3
        process.env.IMAGE_STORE = 's3';
        // Still simulated low disk space
        setSimulatedFreeDiskBytesForTests(500 * 1024 * 1024);

        const mallory = member('BudMallory');
        const s = await req('POST', '/api/profile/update', mallory, { avatar: smallImg });
        check('floor-skipped-on-s3', s.status === 200, `disk floor skipped when IMAGE_STORE=s3 → 200 (got ${s.status})`);

        // Cleanup
        delete process.env.IMAGE_STORE;
        setSimulatedFreeDiskBytesForTests(null);
    }

    // ── 7. Restart safety: budget persists across engine restart / database reopen ──
    {
        resetPhotoBudgetForTests();
        process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '25000'; // 25 KB budget
        const reba = member('BudReba');
        const bob = member('BudBobRestart');
        const conv = se.createConversation('dm', [reba.pk, bob.pk], reba.pk)!;

        // Store 20 KB photo (under 25 KB)
        const ph1 = safeLockedDm(20_000);
        const s1 = await req('POST', '/api/messages/send', reba, {
            conversationId: conv.id,
            authorPubkey: reba.pk,
            ...safeLockedDm(),
            type: 'image',
            attachment: { data: ph1.ciphertext, nonce: ph1.nonce }
        });
        check('restart-first-store', s1.status === 200, `first upload stores 20 KB (got ${s1.status})`);

        // Reopen database and verify photo_budget_log has the stored bytes
        const reopenedDb = new Database(path.join(process.env.BEANPOOL_DATA_DIR!, 'state.db'), { readonly: true });
        let row: { total: number | null } | undefined;
        try {
            row = reopenedDb.prepare("SELECT SUM(bytes) AS total FROM photo_budget_log WHERE member_pubkey = ?").get(reba.pk) as { total: number | null };
        } catch {
            row = undefined;
        }
        reopenedDb.close();
        check('restart-db-has-row', (row?.total ?? 0) >= 20_000, `reopened database has photo_budget_log rows >= 20000 bytes (got ${row?.total})`);

        // Restart in a real child process on the same data dir
        const keyBase64 = Buffer.from(reba.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
        const scriptPath = fileURLToPath(import.meta.url);
        const child = spawnSync(process.execPath, [
            '--import', 'tsx',
            scriptPath,
            '--restart-child',
            reba.pk,
            conv.id,
            keyBase64,
        ], {
            env: {
                ...process.env,
                PHOTO_BYTES_PER_MEMBER_PER_DAY: '25000',
            },
            encoding: 'utf8',
        });
        const match = (child.stdout || '').match(/RESTART_CHILD_RESULT:(.+)/);
        const childResult = match ? JSON.parse(match[1]) : { status: child.status, body: child.stderr || child.stdout };
        const childError = String(childResult.body?.message ?? childResult.body?.error ?? '');
        check('restart-budget-persists', childResult.status === 429, `upload crossing budget refused after restart (got ${childResult.status})`);
        check('restart-budget-sentence', childError === BUDGET_SENTENCE, `refusal after restart has budget sentence`);
    }

    // ── 8. Missed paths: createTreasury, routes/treasury, routes/knocks, crowdfund projects ──
    {
        resetPhotoBudgetForTests();
        process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '25000'; // 25 KB budget
        const hugeImg = du('image/jpeg', await noiseJpeg(200, 200)); // ~35 KB > 25 KB

        // 8.1 createTreasury direct call: checks and records when leadKeeperPubkey is passed
        {
            const lead = member('BudLeadTreasury');
            const t1 = se.createTreasury('TreasuryPass', bigImg, 0, { leadKeeperPubkey: lead.pk });
            check('treasury-create-under-budget', !!t1.publicKey, 'createTreasury under budget succeeds');

            let threwTreasury = false;
            try {
                se.createTreasury('TreasuryRefused', bigImg, 0, { leadKeeperPubkey: lead.pk });
            } catch (e: any) {
                threwTreasury = String(e?.message).includes("You've shared a lot of photos today");
            }
            check('treasury-create-over-budget', threwTreasury, 'createTreasury crossing budget throws');
        }

        // 8.2 POST /api/enterprise (routes/treasury.ts): under budget passes, over budget 429
        {
            const entMember = member('BudEntMember');
            const e1 = await req('POST', '/api/enterprise', entMember, {
                name: 'EntOne',
                purpose: 'Testing enterprise budget',
                avatar: bigImg,
            });
            check('enterprise-route-under-budget', e1.status === 200, `POST /api/enterprise under budget → 200 (got ${e1.status})`);

            const e2 = await req('POST', '/api/enterprise', entMember, {
                name: 'EntTwo',
                purpose: 'Testing enterprise budget over',
                avatar: bigImg,
            });
            check('enterprise-route-over-budget-status', e2.status === 429, `POST /api/enterprise over budget → 429 (got ${e2.status})`);
            check('enterprise-route-over-budget-sentence', errorOf(e2) === BUDGET_SENTENCE, `POST /api/enterprise refusal has budget sentence`);
            check('enterprise-route-retry-after', !!e2.headers.get('retry-after'), `POST /api/enterprise has Retry-After header`);
        }

        // 8.3 POST /api/join/knock (routes/knocks.ts): under budget passes, over budget 429
        {
            const applicant1 = newId();
            const k1 = await req('POST', '/api/join/knock', applicant1, {
                callsign: 'KnockOne',
                message: 'Hello, I want to join the community.',
                avatar: bigImg,
                fromNode: 'https://global.beanpool.org/',
            });
            check('knock-route-under-budget', k1.status === 201, `POST /api/join/knock under budget → 201 (got ${k1.status})`);

            const applicant2 = newId();
            const k2 = await req('POST', '/api/join/knock', applicant2, {
                callsign: 'KnockTwo',
                message: 'Hello again.',
                avatar: hugeImg,
                fromNode: 'https://global.beanpool.org/',
            });
            check('knock-route-over-budget-status', k2.status === 429, `POST /api/join/knock over budget → 429 (got ${k2.status})`);
            check('knock-route-over-budget-sentence', errorOf(k2) === BUDGET_SENTENCE, `POST /api/join/knock refusal has budget sentence`);
            check('knock-route-retry-after', !!k2.headers.get('retry-after'), `POST /api/join/knock has Retry-After header`);
        }

        // 8.4 Crowdfund project creation & update (routes/commons.ts & db.ts)
        {
            const crowdfundCreator = member('BudCrowdCreator');
            const p1 = await req('POST', '/api/crowdfund/projects', crowdfundCreator, {
                title: 'Community Garden Project',
                description: 'Seeds and tools for everyone in town',
                goalAmount: 500,
                photos: [bigImg],
            });
            check('crowdfund-create-under-budget', p1.status === 200, `POST /api/crowdfund/projects under budget → 200 (got ${p1.status})`);

            const p2 = await req('POST', '/api/crowdfund/projects', crowdfundCreator, {
                title: 'Community Bakery Project',
                description: 'Flour and ovens for baking bread',
                goalAmount: 1000,
                photos: [bigImg],
            });
            check('crowdfund-create-over-budget-status', p2.status === 429, `POST /api/crowdfund/projects over budget → 429 (got ${p2.status})`);
            check('crowdfund-create-over-budget-sentence', errorOf(p2) === BUDGET_SENTENCE, `POST /api/crowdfund/projects refusal has budget sentence`);

            const cfMember2 = member('BudCrowdUpdate');
            const p3 = await req('POST', '/api/crowdfund/projects', cfMember2, {
                title: 'Library Project',
                description: 'Books for all members',
                goalAmount: 300,
                photos: [smallImg],
            });
            check('crowdfund-update-init', p3.status === 200, `POST /api/crowdfund/projects initial project → 200 (got ${p3.status})`);
            const projId = p3.body?.project?.id;

            const p4 = await req('POST', '/api/crowdfund/projects/update', cfMember2, {
                id: projId,
                title: 'Library Project Updated',
                description: 'Books and shelves for all members',
                goalAmount: 300,
                photos: [hugeImg],
            });
            check('crowdfund-update-over-budget-status', p4.status === 429, `POST /api/crowdfund/projects/update over budget → 429 (got ${p4.status})`);
            check('crowdfund-update-over-budget-sentence', errorOf(p4) === BUDGET_SENTENCE, `POST /api/crowdfund/projects/update refusal has budget sentence`);

            // 8.4-2 Crowdfund with self URL first + photo crossing budget (N2 / M11)
            const cfMember3 = member('BudCrowdMulti');
            const p5 = await req('POST', '/api/crowdfund/projects', cfMember3, {
                title: 'Multi Photo Project',
                description: 'Several photos in project',
                goalAmount: 200,
                photos: [`/api/avatar/${cfMember3.pk}`, hugeImg],
            });
            check('crowdfund-multi-photos-over-budget', p5.status === 429, `POST /api/crowdfund/projects with self URL first + photo crossing budget → 429 (got ${p5.status})`);
        }
    }

    console.log(`\n${passed}/${run} passed.`);
    if (fails.length > 0) {
        console.error(`FAILS: ${fails.join(', ')}`);
    }
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
    console.error('Test threw unexpected error:', e);
    process.exit(1);
});
