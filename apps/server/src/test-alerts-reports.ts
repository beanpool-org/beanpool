/**
 * Test Suite: owners and admins hear when reports come in (services/alerts.ts reports.new / reports.child; the
 * launch-readiness review's B9).
 *
 * The stand-in ntfy on loopback (as test-alerts.ts runs it) keeps every message; pushes are caught at the Expo door.
 * Nothing leaves this machine. Over the real HTTPS server and its middleware, members report through POST /api/reports:
 *
 *  1. A report raises it: exactly one push (to the owner and the admin, not the moderator or a member) and one line on
 *     the channel, "new reports waiting", saying its kind and how many wait. A repeat of a pending report tells nothing.
 *  2. 50 reports in a minute: the first told at once, the other 49 folded; when the hour is over, one line (pushed)
 *     with their count by kind. So one instant line and one folded line, not 50.
 *  3. A child-safety report pushes at once: inside an open window, each member's is told at once, urgent, and pushed,
 *     while the ordinary ones beside it still fold. The history counts them as one line (×3).
 *  4. The operator's fold window (ALERTS_REPORT_FOLD_MINUTES): 5 minutes folds into "the 5 minutes"; a bad value is
 *     the hour.
 *  5. One member's 10 child-safety reports (their hour's limit): the first pushed at once, the other 9 in one urgent
 *     line 10 minutes on, not 10 pushes (the deciding review of #1850, finding 2).
 *  6. A flood, 12 members × 8 child-safety reports: 10 pushed at once (each a member's first, the server's hourly cap),
 *     the other 86 in one urgent line 10 minutes on. The channel is not filled: an owner made by the admin password
 *     just after reaches it at once (it went at +61 minutes before). The history counts the lines told at once as one.
 *  7. 250 urgent report lines, each its own (as the unbounded flood told them), with the channel down: the owner made
 *     before them stays in the history (finding 1: it was pushed out), and when the channel is back the held queue
 *     goes as one message of at most 4096 bytes (26 KB before), the owners made first, the rest as a count.
 *  8. A report window closing on the tick that raises disk 95 %: the owner is pushed both, the admin the reports alone
 *     (finding 3: the admin was pushed the owner-only disk alert).
 *  9. Nothing in any alert line names a member or quotes what they wrote: no callsign, no key (nor its first 12
 *     characters) and no reason's words in any channel message (headers and body), any push, any push notice kept for
 *     the phone, the Alerts routes' answers or the book.
 *
 * Run (as test-all does, through scripts/run-server-suites.mjs):
 *   SERVER_SUITES_ONLY=test-alerts-reports node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ALERTS_REPORT_FOLD_MINUTES;
for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_OFFBOX_') || k.startsWith('ALERTS_WEBHOOK_')) delete process.env[k];

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

interface NtfyHit { path: string; headers: http.IncomingHttpHeaders; body: string }

/** The stand-in ntfy: every POST kept, a 200 for each; while it is down, a 503 and nothing kept. */
async function startFakeNtfy() {
    const hits: NtfyHit[] = [];
    let down = false;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            if (down) {
                res.writeHead(503);
                res.end();
                return;
            }
            hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"id":"x"}');
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return {
        hits, url: (p: string) => `http://127.0.0.1:${port}${p}`, setDown: (v: boolean) => { down = v; },
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

type Id = { pk: string; privateKey: crypto.KeyObject; callsign: string };

function signedHeaders(method: string, route: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');

    const ntfy = await startFakeNtfy();
    const TOPIC = `bp-rep-${crypto.randomBytes(9).toString('hex')}`;

    const pushes: Array<{ to: string[]; k: string; title: string; body: string }> = [];
    const blocked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
        if (url.hostname === 'exp.host') {
            const batch = JSON.parse(String(init?.body ?? '[]')) as any[];
            pushes.push({ to: batch.map((m) => m.to), k: batch[0]?.data?.k, title: String(batch[0]?.title ?? ''), body: String(batch[0]?.body ?? '') });
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;

    const { initStateEngine, seedGenesisMember, grantNodeRole } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { setSimulatedDiskUsageForTesting } = await import('./engine/storage-health.js');
    const alerts = await import('./services/alerts.js');
    const { initTls } = await import('./services/tls.js');
    const https = await import('./https-server.js');

    initStateEngine();
    await ensureGenesis();
    // This machine's own disk may be full enough to alert: the rows here are the report ones.
    setSimulatedDiskUsageForTesting(10);
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const { hash, salt } = hashPassword('Alerts-Rep-Pw-5512!');
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, communityName: 'Report Test Commons' });

    const ids: Id[] = [];
    const makeId = (callsign: string): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const id = { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
        ids.push(id);
        return id;
    };
    const owner = makeId('OliveOwnerR');
    seedGenesisMember(owner.pk, owner.callsign);
    const join = (callsign: string): Id => {
        const id = makeId(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(id.pk, callsign, new Date().toISOString(), owner.pk, 'TEST');
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
        return id;
    };
    const admin = join('AdamAdminR');
    const moderator = join('ModeratorMoR');
    grantNodeRole(admin.pk, 'admin', owner.pk);
    grantNodeRole(moderator.pk, 'moderator', owner.pk);
    // Reporters (10 reports an hour each at most) and the members they report.
    const reporters = Array.from({ length: 9 }, (_, i) => join(`ReporterRuth${i}R`));
    const targets = Array.from({ length: 10 }, (_, i) => join(`TargetTom${i}R`));
    // Members who file child-safety reports (each in an hour of their own), one who files steps 8's, and owners to make.
    const childReporters = Array.from({ length: 16 }, (_, i) => join(`ChildRepCara${i}R`));
    const mixReporter = join('MixReporterMaxR');
    const newOwners = Array.from({ length: 3 }, (_, i) => join(`NewOwnerNia${i}R`));
    for (const [id, token] of [[owner, 'ExponentPushToken[olive-owner]'], [admin, 'ExponentPushToken[adam-admin]'],
        [moderator, 'ExponentPushToken[mo-moderator]'], [reporters[0], 'ExponentPushToken[ruth-reporter]'], [targets[0], 'ExponentPushToken[tom-target]']] as const) {
        putPushTokenRow(id.pk, token, 'android');
    }
    const ex = consumeHandshakeToken(mintHandshakeToken(owner.pk, 'owner').handshakeToken);
    if (!ex.ok) throw new Error(`setup: no owner session: ${ex.error}`);
    const asOwner = { 'x-admin-session': ex.sessionId! };

    await initTls();
    const port = await https.startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const answers: string[] = [];
    const adminCall = async (method: string, route: string, body: unknown) => {
        resetAdminAuthTarpit();
        https.resetAdminRateLimit();
        const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...asOwner }, body: JSON.stringify(body ?? {}) });
        const text = await res.text();
        answers.push(text);
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json };
    };
    // Every reason carries words of its own, so a line quoting it would be caught (step 5).
    const REASON_WORDS: string[] = [];
    let n = 0;
    const report = async (by: Id, target: Id, choice: string) => {
        const secret = `quoted-words-${crypto.randomBytes(4).toString('hex')}`;
        REASON_WORDS.push(secret);
        const body = JSON.stringify({ reporterPubkey: by.pk, targetPubkey: target.pk, reason: `${choice}: ${secret} about ${target.callsign}` });
        const res = await fetch(`${base}/api/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', '/api/reports', body, by) }, body });
        const json = await res.json().catch(() => null) as any;
        n++;
        return { status: res.status, json };
    };
    /** The next report from a fresh pair: each reporter reports each target once. */
    let pair = 0;
    const nextReport = (choice: string) => {
        const r = reporters[Math.floor(pair / targets.length)];
        const t = targets[pair % targets.length];
        pair++;
        return report(r, t, choice);
    };

    let offset = 0;
    const advance = (ms: number) => { offset += ms; alerts.setAlertsClockForTests(offset); };
    const tick = () => alerts.checkServerAlerts();
    const ownerPushes = () => pushes.filter((p) => p.k === 'owner.alert');
    const topicHits = () => ntfy.hits.filter((h) => h.path === `/${TOPIC}`);

    alerts.resetAlertsForTests();
    const set = await adminCall('POST', '/api/local/admin/alerts/settings', { url: ntfy.url(`/${TOPIC}`) });
    assert(set.status === 200, `setup: the owner sets the channel (${set.status})`);
    await tick();
    const pushTo = ['ExponentPushToken[adam-admin]', 'ExponentPushToken[olive-owner]'];

    // ── 1. A report raises it ───────────────────────────────────────────────────────────────────────────────────────
    const p0 = ownerPushes().length;
    const h0 = topicHits().length;
    const first = await nextReport('Spam or scam');
    assert(first.status === 200 && first.json?.success === true && !first.json?.duplicate, `1. a member reports through the real route (${first.status})`);
    await settle();
    assert(ownerPushes().length === p0 + 1, `1. exactly one push (${ownerPushes().length - p0})`);
    const to1 = (ownerPushes().at(-1)?.to ?? []).slice().sort();
    assert(JSON.stringify(to1) === JSON.stringify(pushTo), `1. to the owner and the admin, not the moderator or a member (${JSON.stringify(to1)})`);
    assert(topicHits().length === h0 + 1, `1. exactly one line on the channel (${topicHits().length - h0})`);
    const line1 = topicHits().at(-1)!;
    assert(/new reports waiting/.test(String(line1.headers.title)), `1. titled "new reports waiting" (${line1.headers.title})`);
    assert(/A new report came in \(spam or scam\)\. 1 report waits in the Manager's Reports queue\./.test(line1.body), `1. its kind and how many wait: ${JSON.stringify(line1.body.split('\n')[2])}`);

    const repeat = await report(reporters[0], targets[0], 'Spam or scam');
    await settle();
    assert(repeat.json?.duplicate === true && ownerPushes().length === p0 + 1 && topicHits().length === h0 + 1, '1. a repeat of a pending report tells nothing');

    // ── 2. 50 reports in a minute: one at once, one folded line ─────────────────────────────────────────────────────
    const choices = ['Spam or scam', 'Offensive content', 'Misleading post', 'Other'];
    for (let i = 0; i < 49; i++) {
        const r = await nextReport(choices[i % 4]);
        if (r.status !== 200 || r.json?.duplicate) throw new Error(`setup: report ${i} not taken (${r.status} ${JSON.stringify(r.json)})`);
    }
    advance(30_000);
    await tick();
    await settle();
    assert(ownerPushes().length === p0 + 1 && topicHits().length === h0 + 1, `2. 49 more inside the window: nothing more yet (${ownerPushes().length - p0} pushes, ${topicHits().length - h0} lines)`);
    advance(HOUR);
    await tick();
    await settle();
    assert(ownerPushes().length === p0 + 2, `2. the hour over: one more push (${ownerPushes().length - p0})`);
    assert(topicHits().length === h0 + 2, `2. 50 reports made one instant line and one folded line (${topicHits().length - h0})`);
    const folded = topicHits().at(-1)!.body;
    assert(/49 more reports came in in the hour after the first was told \(spam or scam 13, offensive content 12, misleading post 12, other 12\)\. 50 reports wait/.test(folded),
        `2. the folded line counts them by kind: ${JSON.stringify(folded.split('\n')[2])}`);
    await tick();
    await settle();
    assert(topicHits().length === h0 + 2, '2. and is told once');

    // ── 3. A child-safety report always pushes ──────────────────────────────────────────────────────────────────────
    const p3 = ownerPushes().length;
    const h3 = topicHits().length;
    await nextReport('Offensive content');
    await settle();
    assert(ownerPushes().length === p3 + 1 && topicHits().length === h3 + 1, '3. the next ordinary report opens a new window, told at once');
    for (let i = 0; i < 3; i++) {
        await report(childReporters[i], targets[0], i === 2 ? 'Other: sexual abuse of a minor' : 'Child safety');
        await nextReport('Spam or scam');
        await settle();
        assert(ownerPushes().length === p3 + 2 + i, `3. child-safety report ${i + 1} pushed at once (${ownerPushes().length - p3 - 1})`);
        assert(topicHits().length === h3 + 2 + i, `3. and told on the channel at once, the ordinary one beside it folded (${topicHits().length - h3 - 1})`);
        const hit = topicHits().at(-1)!;
        assert(/child-safety report waiting/.test(String(hit.headers.title)) && hit.headers.priority === '5',
            `3. urgent (${hit.headers.title} p${hit.headers.priority})`);
        assert(JSON.stringify((ownerPushes().at(-1)?.to ?? []).slice().sort()) === JSON.stringify(pushTo), '3. to the owner and the admin');
    }
    const childLines = () => alerts.getAlertsStatus().history.filter((e) => e.key === 'reports.child');
    assert(childLines().length === 1 && childLines()[0].count === 3, `3. three in the history, none folded: one line, counted (${childLines().length} lines, ×${childLines()[0]?.count})`);
    advance(HOUR + MIN);
    await tick();
    await settle();
    assert(/3 more reports came in in the hour after the first was told \(spam or scam 3\)/.test(topicHits().at(-1)!.body),
        `3. the ordinary ones fold without the child-safety ones: ${JSON.stringify(topicHits().at(-1)!.body.split('\n')[2])}`);

    // ── 4. The operator's fold window ───────────────────────────────────────────────────────────────────────────────
    assert(alerts.reportFoldMs({}) === HOUR && alerts.reportFoldMs({ ALERTS_REPORT_FOLD_MINUTES: '0' }) === HOUR
        && alerts.reportFoldMs({ ALERTS_REPORT_FOLD_MINUTES: 'soon' }) === HOUR && alerts.reportFoldMs({ ALERTS_REPORT_FOLD_MINUTES: '1441' }) === HOUR
        && alerts.reportFoldMs({ ALERTS_REPORT_FOLD_MINUTES: ' 15 ' }) === 15 * MIN, '4. ALERTS_REPORT_FOLD_MINUTES: 1 to 1440 minutes, else the hour');
    process.env.ALERTS_REPORT_FOLD_MINUTES = '5';
    const h4 = topicHits().length;
    await nextReport('Misleading post');
    await nextReport('Misleading post');
    await settle();
    assert(topicHits().length === h4 + 1 && /More in the 5 minutes are told as one line\./.test(topicHits().at(-1)!.body), '4. with 5 minutes set, the first says so');
    advance(4 * MIN);
    await tick();
    await settle();
    assert(topicHits().length === h4 + 1, '4. four minutes on, still folded');
    advance(MIN + 1000);
    await tick();
    await settle();
    assert(topicHits().length === h4 + 2 && /1 more report came in in the 5 minutes after the first was told \(misleading post 1\)/.test(topicHits().at(-1)!.body),
        `4. five minutes on, one folded line: ${JSON.stringify(topicHits().at(-1)!.body.split('\n')[2])}`);
    delete process.env.ALERTS_REPORT_FOLD_MINUTES;

    assert(alerts.reportKind('Child safety') === 'child safety' && alerts.reportKind('Other: CSAM link') === 'child safety'
        && alerts.reportKind('Spam or scam') === 'spam or scam' && alerts.reportKind('offensive content: rude') === 'offensive content'
        && alerts.reportKind('He was rude') === 'other' && alerts.reportKind(42) === 'other', '4. a report\'s kind is read from its reason');

    // ── 5. One member's child-safety reports: the first at once, the rest one urgent line 10 minutes on ─────────────
    advance(HOUR + MIN);
    await tick();
    await settle();
    const p5 = ownerPushes().length;
    const h5 = topicHits().length;
    for (let j = 0; j < 10; j++) {
        const r = await report(childReporters[3], targets[j], 'Child safety');
        if (r.status !== 200 || r.json?.duplicate) throw new Error(`setup: child-safety report ${j} not taken (${r.status} ${JSON.stringify(r.json)})`);
    }
    await settle();
    assert(ownerPushes().length === p5 + 1 && topicHits().length === h5 + 1,
        `5. one member's 10 child-safety reports: their first pushed and told at once, not the other 9 (${ownerPushes().length - p5} pushes, ${topicHits().length - h5} lines)`);
    advance(9 * MIN);
    await tick();
    await settle();
    assert(ownerPushes().length === p5 + 1 && topicHits().length === h5 + 1, '5. nine minutes on, still counted');
    advance(MIN + 1000);
    await tick();
    await settle();
    assert(ownerPushes().length === p5 + 2 && topicHits().length === h5 + 2, `5. ten minutes on, one push and one line (${ownerPushes().length - p5}, ${topicHits().length - h5})`);
    const sum5 = topicHits().at(-1)!;
    assert(/more child-safety reports waiting/.test(String(sum5.headers.title)) && sum5.headers.priority === '5', `5. urgent (${sum5.headers.title} p${sum5.headers.priority})`);
    assert(/9 more child-safety reports came in, from one member, past those pushed one by one/.test(sum5.body), `5. it counts them: ${JSON.stringify(sum5.body.split('\n')[2])}`);
    assert(JSON.stringify((ownerPushes().at(-1)?.to ?? []).slice().sort()) === JSON.stringify(pushTo), '5. pushed to the owner and the admin');

    // ── 6. A flood from 12 members: 10 at once, the rest one line; the channel stays open ───────────────────────────
    advance(HOUR + MIN);
    await tick();
    await settle();
    const p6 = ownerPushes().length;
    const h6 = topicHits().length;
    for (const m of childReporters.slice(4, 16)) {
        for (let j = 0; j < 8; j++) {
            const r = await report(m, targets[j], 'Child safety');
            if (r.status !== 200 || r.json?.duplicate) throw new Error(`setup: flood report not taken (${r.status} ${JSON.stringify(r.json)})`);
        }
    }
    await settle(1000);
    const st6 = alerts.getAlertsStatus();
    assert(ownerPushes().length - p6 === alerts.REPORT_CHILD_AT_ONCE_PER_HOUR,
        `6. 96 child-safety reports from 12 members: 10 pushed at once, each a member's first (${ownerPushes().length - p6})`);
    assert(topicHits().length - h6 <= alerts.REPORT_CHILD_AT_ONCE_PER_HOUR && st6.waiting === 0,
        `6. the channel took ${topicHits().length - h6} messages (${st6.sentLastHour} this hour), none held (${st6.waiting})`);
    const ownerLine = (b: string) => /Someone was made an owner, by the admin password\./.test(b);
    const hS = topicHits().length;
    grantNodeRole(newOwners[0].pk, 'owner', 'owner:password');
    await settle(1000);
    assert(topicHits().slice(hS).some((h) => ownerLine(h.body)), '6. an owner made by the admin password just after reaches the channel at once');
    advance(10 * MIN + 1000);
    await tick();
    await settle();
    const sum6 = topicHits().slice(h6).filter((h) => /more child-safety reports waiting/.test(String(h.headers.title)));
    assert(sum6.length === 1 && /86 more child-safety reports came in, from 12 members/.test(sum6[0].body) && sum6[0].headers.priority === '5',
        `6. ten minutes on, the other 86 in one urgent line: ${JSON.stringify(sum6.map((h) => h.body.split('\n')[2]))}`);
    assert(childLines().length === 1 && childLines()[0].count === 3 + 1 + 10,
        `6. the history counts every child-safety line told at once as one (${childLines().length} lines, ×${childLines()[0]?.count})`);

    // ── 7. Report lines never push a security line out; a held queue goes as one message of at most 4 KB ────────────
    advance(HOUR + MIN);
    await tick();
    await settle();
    ntfy.setDown(true);
    grantNodeRole(newOwners[1].pk, 'owner', 'owner:password');
    await settle(1000);
    const h7 = topicHits().length;
    for (let i = 0; i < 250; i++) {
        await alerts.updateAlerts([{
            key: 'reports.child', active: true, oneShot: true, high: true, priority: 5, push: false,
            detail: `A report in the child-safety category came in: look at it first. ${i + 1} reports wait in the Manager's Reports queue.`,
        }]);
    }
    const hist7 = alerts.getAlertsStatus().history;
    assert(hist7.some((e) => e.key === 'sec.role' && ownerLine(e.detail)),
        `7. 250 urgent report lines, each its own: the owner made before them is still in the history (${hist7.length} lines)`);
    grantNodeRole(newOwners[2].pk, 'owner', 'owner:password');
    await settle(1000);
    assert(alerts.getAlertsStatus().waiting === 50, `7. the channel down: 50 lines wait (${alerts.getAlertsStatus().waiting})`);
    ntfy.setDown(false);
    advance(5 * MIN + 1000);
    await tick();
    await settle();
    const held = topicHits().slice(h7);
    assert(held.length === 1, `7. the channel back: what waited goes as one message (${held.length})`);
    const bytes7 = Buffer.byteLength(held[0]?.body ?? '');
    assert(bytes7 > 3000 && bytes7 <= alerts.ALERT_MESSAGE_MAX_BYTES, `7. of at most ${alerts.ALERT_MESSAGE_MAX_BYTES} bytes (${bytes7})`);
    assert(ownerLine(held[0].body), '7. the owners made are in it, though they waited behind 49 report lines');
    assert(/- And \d+ more, too many for one message: Settings → Alerts lists them\./.test(held[0].body) && alerts.getAlertsStatus().waiting === 0,
        `7. the rest as a count, nothing left waiting (${held[0].body.split('\n').filter((l) => l.startsWith('- And')).join('')})`);
    const largest = Math.max(...topicHits().map((h) => Buffer.byteLength(h.body)));
    assert(largest <= alerts.ALERT_MESSAGE_MAX_BYTES, `7. no message in this suite was longer (${largest} bytes at most)`);

    // ── 8. The admin is pushed the report line alone, never the owners' others ──────────────────────────────────────
    advance(HOUR + MIN);
    await tick();
    await settle();
    await report(mixReporter, targets[0], 'Spam or scam');
    await report(mixReporter, targets[1], 'Spam or scam');
    await settle();
    setSimulatedDiskUsageForTesting(96);
    await tick();
    await tick();
    advance(HOUR);
    const lastNotice = (db.prepare(`SELECT MAX(rowid) AS r FROM push_notices`).get() as { r: number | null }).r ?? 0;
    await tick();
    await settle();
    const noticesOf = (pk: string) => db.prepare(`SELECT title, body FROM push_notices WHERE kind = 'owner.alert' AND recipient = ? AND rowid > ? ORDER BY rowid`)
        .all(pk, lastNotice) as Array<{ title: string; body: string }>;
    const ownerGot = noticesOf(owner.pk);
    const adminGot = noticesOf(admin.pk);
    assert(ownerGot.length === 1 && /disk 95% full \(\+1 more\)$/.test(ownerGot[0].title), `8. the tick that raises disk 95 % and closes a report window: the owner is pushed both (${JSON.stringify(ownerGot.map((x) => x.title))})`);
    assert(adminGot.length === 1 && /new reports waiting$/.test(adminGot[0].title) && /1 more report came in/.test(adminGot[0].body) && !/disk/i.test(adminGot[0].title + adminGot[0].body),
        `8. the admin, the reports alone: ${JSON.stringify(adminGot)}`);
    setSimulatedDiskUsageForTesting(10);

    // ── 9. Nothing names a member or quotes them ────────────────────────────────────────────────────────────────────
    await settle();
    const st = await adminCall('POST', '/api/local/admin/alerts/status', {});
    assert(st.status === 200 && st.json?.history?.some((e: any) => e.key === 'reports.new'), `9. the Alerts card lists them (${st.status})`);
    const notices = db.prepare(`SELECT recipient, title, body, data FROM push_notices WHERE kind = 'owner.alert'`).all() as any[];
    assert(notices.some((x) => x.recipient === admin.pk) && notices.every((x) => x.recipient === owner.pk || x.recipient === admin.pk),
        `9. ${notices.length} owner.alert notices kept, every one for the owner or the admin`);
    const payloads = [
        ...ntfy.hits.map((h) => JSON.stringify(h.headers) + h.body),
        ...ownerPushes().map((p) => p.title + p.body),
        ...notices.map((x) => `${x.title}\n${x.body}\n${x.data}`),
        ...answers,
        JSON.stringify(alerts.getAlertsStatus()),
        fs.readFileSync(path.join(dataDir!, alerts.ALERTS_STATE_FILE), 'utf8'),
    ];
    const leaks = payloads.filter((p) => ids.some((i) => p.includes(i.callsign) || p.includes(i.pk.slice(0, 12)))
        || REASON_WORDS.some((w) => p.includes(w)) || /sexual abuse of a minor|Other:/.test(p));
    assert(n > 55 && payloads.length > 20 && leaks.length === 0,
        `9. ${payloads.length} payloads (${topicHits().length} channel messages, ${n} reports), none names a member or quotes a reason (${leaks.length})`);
    assert(blocked.length === 0, `9. nothing off this machine was asked (${blocked.join(', ')})`);

    await ntfy.close();
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(testsPassed === testsRun ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(1);
});
