/**
 * Pushes go with the node's Expo access token when it has one, and the token goes nowhere else
 * (scratch/reviews/FABLE-sec-outbound.md M1).
 *
 * Every push is caught where it leaves for Expo: nothing here contacts exp.host, expo.dev or any other outside host. The
 * token is made up here, in the shape of a real one.
 *   1. EXPO_ACCESS_TOKEN unset, or blank: the request is exactly what it always was, POST with `Content-Type` and no
 *      Authorization header at all
 *   2. set: the same request with `Authorization: Bearer <token>` added, on every batch; the spaces or line ending .env
 *      can leave around it are dropped
 *   3. set to something a header can't carry (a line break in it): sent without it, and one warning that never quotes it
 *   4. the admin diagnostics say set / not set / unusable, never the value
 *   5. with it set, the token is in no system_logs row (an Expo error, a send that failed quoting its headers, a line that
 *      quotes it bare), no line this process printed, no file in the data folder, no plain backup, and no standby's copy
 *      (the whole snapshot, and a copy in pages)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-push-access-token.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_ROLE;
delete process.env.EXPO_ACCESS_TOKEN;

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { execFileSync } from 'node:child_process';
import Koa from 'koa';

/** Made up here: an Expo robot token is a run of letters, digits, `-` and `_`. Never a real one. */
const TOKEN = `bptest_${crypto.randomBytes(24).toString('base64url')}`;

// Everything this process prints, console or not, so section 5 can look for the token in it. The checks below never
// print a header or the token themselves.
const printed: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: any[]) => boolean;
    (stream as any).write = (chunk: unknown, ...rest: any[]) => {
        printed.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return write(chunk, ...rest);
    };
}

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 50)); };
const holds = (text: string) => text.includes(TOKEN);

/** Every file under `dir` that holds the token, by its path relative to `dir`. Also returns how many files were read. */
function filesHolding(dir: string): { found: string[]; read: number } {
    const found: string[] = [];
    let read = 0;
    const needle = Buffer.from(TOKEN, 'utf8');
    const walk = (at: string) => {
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
            const full = path.join(at, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                read++;
                if (fs.readFileSync(full).includes(needle)) found.push(path.relative(dir, full));
            }
        }
    };
    walk(dir);
    return { found, read };
}

async function main() {
    console.log('Expo pushes and the access token...\n');
    const DATA_DIR = process.env.BEANPOOL_DATA_DIR!;
    if (!DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const se = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { logger } = await import('./logger.js');
    const { startP2P } = await import('./p2p.js');
    const { createAdminRoutes } = await import('./routes/admin.js');
    const { createPlainBackup } = await import('./services/sealed-backup.js');
    const { openCopy, copyPage } = await import('./engine/copy-pages.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');

    se.initStateEngine();
    // The node's own key, for the standby's copies in section 5: they are signed.
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();

    const member = (callsign: string, tokens = 1): string => {
        const pk = crypto.randomBytes(32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed')`).run(pk, callsign);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
        for (let i = 0; i < tokens; i++) {
            putPushTokenRow(pk, `ExponentPushToken[${callsign}-${i}]`, 'android');
        }
        return pk;
    };
    const ann = member('AnnPhone');
    const crowd = Array.from({ length: 120 }, (_v, i) => member(`Crowd${i}`));
    const actor = crypto.randomBytes(32).toString('hex');

    // Pushes, caught where they leave for Expo. `expo` says how the stand-in answers: as Expo does, with a 500, or by
    // throwing the way fetch does for a header it can't send, quoting the header's value.
    type Sent = { url: string; init: any };
    const sent: Sent[] = [];
    let expo: 'ok' | '500' | 'throw-quoting-headers' = 'ok';
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        const host = new URL(url).hostname;
        if (host === 'exp.host' || host === 'expo.dev' || host.endsWith('.expo.dev')) {
            sent.push({ url, init });
            if (expo === 'throw-quoting-headers') {
                const auth = new Headers(init?.headers).get('authorization') ?? '';
                throw new TypeError(`Headers.append: "${auth}" is an invalid header value.`);
            }
            if (expo === '500') return new Response(JSON.stringify({ errors: [{ code: 'INTERNAL' }] }), { status: 500 });
            return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (host === 'localhost' || host === '127.0.0.1') return realFetch(input, init);
        throw new Error(`the test refused to contact ${host}`);
    };
    const pushTo = async (who: string[]) => {
        sent.length = 0;
        const n = se.dispatchPushNotification(who, actor, 'A test notice', 'A line of text', { screen: 'chat' }, 'chat', 'chat.message');
        await flush();
        return n;
    };
    const authOf = (s: Sent) => new Headers(s.init?.headers).get('authorization');
    const bearerIsToken = (s: Sent) => authOf(s) === `Bearer ${TOKEN}`;

    // The admin routes, with a stand-in for checkAdminAuth (an owner), for the diagnostics in section 4.
    const app = new Koa();
    const router = createAdminRoutes({
        checkAdminAuth: async (ctx: any) => { ctx.state.adminRole = 'owner'; return true; },
        rateLimit: () => true,
        clampLimit: (v: any, def = 50) => typeof v === 'number' ? v : Number(v) || def,
        clampOffset: (v: any) => Math.max(0, Number(v) || 0),
        activeConnections: new Map(), calculateAnalytics: () => ({}) as any, enforceReadAuth: false,
    } as any);
    app.use(router.routes());
    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const diagnostics = async () => {
        const res = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/api/local/admin/diagnostics`);
        const text = await res.text();
        let body: any = null;
        try { body = JSON.parse(text); } catch { /* reported below */ }
        return { status: res.status, text, body };
    };

    try {
        // ── 1. Unset, or blank: the request it always was ─────────────────────────────────────────────
        console.log('--- 1. No token: the request is unchanged ---');
        const n1 = await pushTo([ann]);
        assert(n1 === 1 && sent.length === 1 && sent[0].url === 'https://exp.host/--/api/v2/push/send',
            `one push to Expo's send address (${n1} message(s), ${sent.length} request(s))`);
        const plain = sent[0];
        assert(util.isDeepStrictEqual(Object.keys(plain.init).sort(), ['body', 'headers', 'method']) && plain.init.method === 'POST',
            `POST with a body and headers, nothing else (${Object.keys(plain.init).sort().join(', ')})`);
        assert(util.isDeepStrictEqual(plain.init.headers, { 'Content-Type': 'application/json' }),
            `the headers are exactly { Content-Type: application/json } (${JSON.stringify(plain.init.headers)})`);
        assert(authOf(plain) === null, 'no Authorization header in any spelling');
        const plainBody = plain.init.body;
        assert(JSON.parse(plainBody)[0]?.to === 'ExponentPushToken[AnnPhone-0]', 'the body is the batch of messages, as before');

        for (const blank of ['', '   ', '\n']) {
            process.env.EXPO_ACCESS_TOKEN = blank;
            await pushTo([ann]);
            assert(sent.length === 1 && util.isDeepStrictEqual(sent[0].init.headers, { 'Content-Type': 'application/json' }),
                `EXPO_ACCESS_TOKEN=${JSON.stringify(blank)} counts as unset: the same headers, no Authorization`);
        }
        delete process.env.EXPO_ACCESS_TOKEN;

        // ── 2. Set: the same request, with the token ───────────────────────────────────────────────────
        console.log('\n--- 2. With a token: Authorization: Bearer on every request ---');
        process.env.EXPO_ACCESS_TOKEN = TOKEN;
        await pushTo([ann]);
        assert(sent.length === 1 && bearerIsToken(sent[0]), 'the push carries Authorization: Bearer <the token>');
        assert(sent.length === 1 && util.isDeepStrictEqual(Object.keys(sent[0].init.headers).sort(), ['Authorization', 'Content-Type'])
            && sent[0].init.headers['Content-Type'] === 'application/json',
            'beside the same Content-Type, and no other header');
        // Each push is a new notice, with its own id, time and signature (@beanpool/core push-notice.ts): those three are
        // the only bytes two pushes of the same thing may differ in, with or without a token.
        const ownNoticeFields = (body: string) => JSON.stringify(JSON.parse(body).map((m: any) => ({ ...m, data: { ...m.data, i: null, t: null, s: null } })));
        assert(sent.length === 1 && sent[0].init.method === 'POST' && ownNoticeFields(sent[0].init.body) === ownNoticeFields(plainBody)
            && JSON.parse(sent[0].init.body)[0]?.data?.i !== JSON.parse(plainBody)[0]?.data?.i && sent[0].url === plain.url,
            "the address, method and body are byte for byte the ones sent without a token, but for the notice's own id, time and signature");

        const nCrowd = await pushTo(crowd);
        assert(nCrowd === 120 && sent.length === 2, `120 messages go as two batches (${sent.length} request(s))`);
        assert(sent.length === 2 && sent.every(bearerIsToken), 'and every batch carries the token');

        process.env.EXPO_ACCESS_TOKEN = `  ${TOKEN}\r\n`;
        await pushTo([ann]);
        assert(sent.length === 1 && bearerIsToken(sent[0]), 'spaces and a line ending around it in .env are dropped');

        // ── 3. Set to something no header can carry ────────────────────────────────────────────────────
        console.log('\n--- 3. A token no header can carry ---');
        process.env.EXPO_ACCESS_TOKEN = `${TOKEN}\nX-Injected: 1`;
        const printedBefore = printed.length;
        await pushTo([ann]);
        await pushTo([ann]);
        assert(sent.length === 1 && authOf(sent[0]) === null
            && util.isDeepStrictEqual(sent[0].init.headers, { 'Content-Type': 'application/json' }),
            'a value with a line break in it is not sent: the push goes as it would without one');
        const warned = printed.slice(printedBefore).filter(l => l.includes('EXPO_ACCESS_TOKEN') && l.includes('[Push]'));
        assert(warned.length === 1, `the server says so, once (${warned.length} warning line(s))`);
        assert(!warned.some(holds), 'and the warning never quotes the value');

        // ── 4. Diagnostics: set or not, never the value ────────────────────────────────────────────────
        console.log('\n--- 4. Diagnostics ---');
        const unusable = await diagnostics();
        assert(unusable.status === 200 && unusable.body?.pushAccessToken === 'unusable',
            `with that value, diagnostics say "unusable" (${unusable.status} ${unusable.body?.pushAccessToken})`);
        delete process.env.EXPO_ACCESS_TOKEN;
        const unset = await diagnostics();
        assert(unset.status === 200 && unset.body?.pushAccessToken === 'not set', `unset, they say "not set" (${unset.body?.pushAccessToken})`);
        process.env.EXPO_ACCESS_TOKEN = TOKEN;
        const set = await diagnostics();
        assert(set.status === 200 && set.body?.pushAccessToken === 'set', `set, they say "set" (${set.body?.pushAccessToken})`);
        assert(![unusable, unset, set].some(d => holds(d.text)), 'no diagnostics answer carries the token');

        // ── 5. With the token set, it goes nowhere else ────────────────────────────────────────────────
        console.log('\n--- 5. The token is in no log, file, backup or copy ---');
        expo = '500';
        await pushTo([ann]);
        assert(sent.length === 1 && bearerIsToken(sent[0]), 'a push Expo answers with a 500 was sent with the token');
        expo = 'throw-quoting-headers';
        await pushTo([ann]);
        assert(sent.length === 1 && bearerIsToken(sent[0]), 'a push whose send failed quoting its headers was sent with the token');
        expo = 'ok';
        assert(printed.some(l => l.includes('[Push] Expo API returned 500')), 'the 500 is logged');
        const failedLine = printed.find(l => l.includes('[Push] Failed to send push notification'));
        assert(!!failedLine && failedLine.includes('is an invalid header value') && !holds(failedLine),
            'the failed send is logged, its error text kept and the token taken out of it');

        logger.warn('SYS', `Expo turned down the access token ${TOKEN} for this project`);
        logger.error('SYS', 'A push request failed', { headers: { Authorization: `Bearer ${TOKEN}` }, quoted: TOKEN, url: 'https://exp.host/--/api/v2/push/send' });
        logger.info('SYS', `Authorization: Bearer ${TOKEN}`);
        const rows = db.prepare(`SELECT message, metadata FROM system_logs`).all() as { message: string; metadata: string | null }[];
        const ours = rows.filter(r => r.message.includes('Expo turned down') || r.message.includes('A push request failed') || r.message.startsWith('Authorization'));
        assert(ours.length === 3, `the three log lines that quoted the token were written (${ours.length})`);
        assert(rows.length > 0 && !rows.some(r => holds(r.message) || holds(r.metadata ?? '')),
            `no system_logs row holds the token (${rows.length} rows read)`);
        assert(ours.some(r => r.message.includes('Expo turned down the access token [REDACTED_CREDENTIAL]')),
            'a line that quotes it bare keeps its words and loses the token');

        db.pragma('wal_checkpoint(TRUNCATE)');
        const onDisk = filesHolding(DATA_DIR);
        assert(onDisk.read > 0 && onDisk.found.length === 0,
            `no file in the data folder holds it (${onDisk.read} files read${onDisk.found.length ? `; found in ${onDisk.found.join(', ')}` : ''})`);

        const backup = await createPlainBackup();
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'push-token-backup-'));
        const archive = path.join(work, 'backup.tar.gz');
        await new Promise<void>((resolve, reject) => {
            const out = fs.createWriteStream(archive);
            backup.body.pipe(out);
            out.on('finish', () => resolve());
            out.on('error', reject);
        });
        const unpacked = path.join(work, 'unpacked');
        fs.mkdirSync(unpacked);
        execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
        const inBackup = filesHolding(unpacked);
        assert(fs.existsSync(path.join(unpacked, 'state.db')) && inBackup.found.length === 0,
            `no file in a plain backup holds it (${inBackup.read} files, state.db among them${inBackup.found.length ? `; found in ${inBackup.found.join(', ')}` : ''})`);
        backup.cleanup();
        fs.rmSync(work, { recursive: true, force: true });

        const snapshot = JSON.stringify(await se.exportSyncState(nodeId));
        assert(snapshot.includes('AnnPhone') && !holds(snapshot), 'a standby\'s whole snapshot carries the members and not the token');

        const pages: string[] = [];
        const opened = await openCopy({ nodeId, since: null, commonsBalance: se.getCommonsBalanceExact, sign: se.signSyncBody });
        if (opened.status === 200) {
            pages.push(opened.page);
            let head = JSON.parse(opened.page);
            while (!head.last && pages.length < 1000) {
                const next = await copyPage(head.copyId, head.n + 1);
                if (next.status !== 200) break;
                pages.push(next.page);
                head = JSON.parse(next.page);
            }
            assert(head.last === true, `a copy in pages is served to its last page (${pages.length} page(s))`);
        } else assert(false, `a copy in pages opens (${opened.status} ${JSON.stringify(opened.error)})`);
        assert(pages.some(p => p.includes('AnnPhone')) && !pages.some(holds), 'no page of it carries the token');

        assert(!printed.some(holds), `nothing this process printed holds the token (${printed.length} writes)`);

        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log('⭐️ Expo access token checks PASSED.');
    } finally {
        (globalThis as any).fetch = realFetch;
        server.close();
        await p2p.stop();
    }
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
