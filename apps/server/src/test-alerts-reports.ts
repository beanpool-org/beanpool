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
 *     the hour, told in one warning line at start that names the variable, at most 40 of its characters and the hour
 *     (the confirmation review's finding 4: it fell back without a word).
 *  5. One member's 10 child-safety reports (their hour's limit), one every 6 minutes, a tick a minute: the first pushed
 *     at once, the other 9 in one urgent line when their hour ends, so 2 pushes that hour, not 10 (the deciding review
 *     of #1850, finding 2) and not 6 (its confirmation review, finding 2: they went on the 10-minute summary).
 *  6. A flood, 12 members × 8 child-safety reports: 10 pushed at once (each a member's first, the server's hourly cap),
 *     the 2 firsts past the cap in one urgent line 10 minutes on, and the other 84 in one urgent line when the 12 hours
 *     end. The channel is not filled: an owner made by the admin password just after reaches it at once (it went at +61
 *     minutes before). The history counts the lines told at once as one.
 *  7. 250 urgent report lines, each its own (as the unbounded flood told them), with the channel down: the owner made
 *     before them stays in the history (finding 1: it was pushed out), and so does someone made an admin, a security
 *     line that is not high (the confirmation review's finding 1: report lines pushed it out of the history and the
 *     queue, and past it in a held message). When the channel is back the held queue goes as one message of at most
 *     4096 bytes (26 KB before): the owners made first, then the admin made, the report lines after, the rest as a count.
 *  8. A report window closing on the tick that raises disk 95 %: the owner is pushed both, the admin the reports alone
 *     (finding 3: the admin was pushed the owner-only disk alert).
 *  9. Every one of the hour's 10 slots taken (the confirmation review 2's finding 2): a member's first past them, and
 *     another's 4 minutes on, are one summary 10 minutes after the first (a later count does not push it back); while
 *     their hours are open the book keeps each member by a hash, never the key; hours with no repeats end with no line;
 *     a member's hour that ends with every slot taken is not told on its own (so no hour holds more than 10) and its
 *     count goes on the next summary, none dropped, which says "one member" and names nobody, not even by a hash.
 * 10. A held message too long for 4 KB shows the high lines, then a security line that is not high, before the report
 *     lines (the confirmation review 2's finding 2: nothing guarded the ranking).
 * 11. A history of 50 lines none of them a report's (a long-running node's daily reminders): a new report line makes room
 *     with the oldest reminder, never a security line, and stays in "Last 50 alerts" (the confirmation review 2's finding
 *     1: it dropped itself).
 * 12. Nothing in any alert line names a member or quotes what they wrote: no callsign, no key (nor its first 12
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
    const { logger } = await import('./logger.js');
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
    const newAdmin = join('NewAdminAdaR');
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

    assert(alerts.reportFoldWarning({}) === null && alerts.reportFoldWarning({ ALERTS_REPORT_FOLD_MINUTES: ' ' }) === null
        && alerts.reportFoldWarning({ ALERTS_REPORT_FOLD_MINUTES: '15' }) === null && alerts.reportFoldWarning({ ALERTS_REPORT_FOLD_MINUTES: '1441' }) !== null,
        '4. no warning when it is empty or good');
    const warned: string[] = [];
    const realWarn = logger.warn;
    logger.warn = ((_category: string, message: string) => { warned.push(message); }) as typeof logger.warn;
    process.env.ALERTS_REPORT_FOLD_MINUTES = `soon\n${'x'.repeat(100)}`;
    alerts.startServerAlerts();
    alerts.stopServerAlerts();
    await settle(500);
    logger.warn = realWarn;
    delete process.env.ALERTS_REPORT_FOLD_MINUTES;
    const w4 = warned.filter((m) => m.includes('ALERTS_REPORT_FOLD_MINUTES'));
    assert(w4.length === 1 && w4[0].startsWith('[Alerts] ALERTS_REPORT_FOLD_MINUTES="soon\\n') && /reports are folded over the hour \(60 minutes\) instead\.$/.test(w4[0]),
        `4. a bad value is one warning line at start, naming the variable and the hour: ${JSON.stringify(w4)}`);
    assert(!w4[0].includes('\n') && w4[0].includes('x'.repeat(35)) && !w4[0].includes('x'.repeat(36)), '4. one line, at most 40 characters of the value');
    await tick();
    await settle();

    assert(alerts.reportKind('Child safety') === 'child safety' && alerts.reportKind('Other: CSAM link') === 'child safety'
        && alerts.reportKind('Spam or scam') === 'spam or scam' && alerts.reportKind('offensive content: rude') === 'offensive content'
        && alerts.reportKind('He was rude') === 'other' && alerts.reportKind(42) === 'other', '4. a report\'s kind is read from its reason');

    // ── 5. One member's child-safety reports, one every 6 minutes: the first at once, the rest one line at their hour's end
    advance(HOUR + MIN);
    await tick();
    await settle();
    const p5 = ownerPushes().length;
    const h5 = topicHits().length;
    for (let j = 0; j < 10; j++) {
        const r = await report(childReporters[3], targets[j], 'Child safety');
        if (r.status !== 200 || r.json?.duplicate) throw new Error(`setup: child-safety report ${j} not taken (${r.status} ${JSON.stringify(r.json)})`);
        await settle(50);
        if (j === 0) {
            assert(ownerPushes().length === p5 + 1 && topicHits().length === h5 + 1,
                `5. one member's first child-safety report: pushed and told at once (${ownerPushes().length - p5} pushes, ${topicHits().length - h5} lines)`);
        }
        for (let m = 0; m < (j < 9 ? 6 : 5); m++) { advance(MIN); await tick(); }
    }
    await settle();
    assert(ownerPushes().length === p5 + 1 && topicHits().length === h5 + 1,
        `5. 59 minutes and 9 more reports on, nothing more told: not on the 10-minute summary (${ownerPushes().length - p5} pushes, ${topicHits().length - h5} lines)`);
    advance(MIN + 1000);
    await tick();
    await settle();
    assert(ownerPushes().length === p5 + 2 && topicHits().length === h5 + 2,
        `5. their hour over: one push and one line, 2 in their hour, not 10 or 6 (${ownerPushes().length - p5}, ${topicHits().length - h5})`);
    const sum5 = topicHits().at(-1)!;
    assert(/more child-safety reports waiting/.test(String(sum5.headers.title)) && sum5.headers.priority === '5', `5. urgent (${sum5.headers.title} p${sum5.headers.priority})`);
    assert(/9 more child-safety reports came in from the same member in the hour after their first was told: look at them first\./.test(sum5.body),
        `5. it counts them: ${JSON.stringify(sum5.body.split('\n')[2])}`);
    assert(JSON.stringify((ownerPushes().at(-1)?.to ?? []).slice().sort()) === JSON.stringify(pushTo), '5. pushed to the owner and the admin');
    await tick();
    await settle();
    assert(ownerPushes().length === p5 + 2 && topicHits().length === h5 + 2, '5. and told once');

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
    const more6 = () => topicHits().slice(h6).filter((h) => /more child-safety reports waiting/.test(String(h.headers.title)));
    const sum6 = more6();
    assert(sum6.length === 1 && /2 more child-safety reports came in, from 2 members, past the 10 lines an hour this server tells on their own/.test(sum6[0].body)
        && sum6[0].headers.priority === '5', `6. ten minutes on, the 2 firsts past the cap in one urgent line: ${JSON.stringify(sum6.map((h) => h.body.split('\n')[2]))}`);
    const p6b = ownerPushes().length;
    advance(50 * MIN + 30_000);
    await tick();
    await settle();
    const fold6 = more6().slice(1);
    assert(fold6.length === 1 && /84 more child-safety reports came in from 12 members, each in the hour after their first was told/.test(fold6[0].body)
        && fold6[0].headers.priority === '5' && ownerPushes().length === p6b + 1,
        `6. the 12 hours over: the other 84 in one urgent line, one push: ${JSON.stringify(fold6.map((h) => h.body.split('\n')[2]))}`);
    assert(childLines().length === 1 && childLines()[0].count === 3 + 1 + 10,
        `6. the history counts every child-safety line told at once as one (${childLines().length} lines, ×${childLines()[0]?.count})`);

    // ── 7. Report lines never push a security line out; a held queue goes as one message of at most 4 KB ────────────
    advance(HOUR + MIN);
    await tick();
    await settle();
    ntfy.setDown(true);
    grantNodeRole(newOwners[1].pk, 'owner', 'owner:password');
    grantNodeRole(newAdmin.pk, 'admin', owner.pk);
    await settle(1000);
    const adminLine = (b: string) => /Someone was made an admin, by an owner\./.test(b);
    assert(alerts.getAlertsStatus().history.some((e) => e.key === 'sec.role' && adminLine(e.detail) && !e.high), '7. someone made an admin: a security line, not high');
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
    assert(hist7.some((e) => e.key === 'sec.role' && adminLine(e.detail)),
        `7. and so is the admin made, though not high (${hist7.filter((e) => e.key.startsWith('reports.')).length} report lines)`);
    grantNodeRole(newOwners[2].pk, 'owner', 'owner:password');
    await settle(1000);
    assert(alerts.getAlertsStatus().waiting === 50, `7. the channel down: 50 lines wait (${alerts.getAlertsStatus().waiting})`);
    const book7 = JSON.parse(fs.readFileSync(path.join(dataDir!, alerts.ALERTS_STATE_FILE), 'utf8')) as { waiting: Array<{ key: string; detail: string; count?: number }> };
    const roles7 = book7.waiting.filter((e) => e.key === 'sec.role');
    assert(roles7.some((e) => adminLine(e.detail)) && roles7.some((e) => ownerLine(e.detail) && e.count === 2),
        `7. the admin made still waits, and both owners made (one line, ×2): the lines dropped were report lines (${roles7.length} security lines)`);
    ntfy.setDown(false);
    advance(5 * MIN + 1000);
    await tick();
    await settle();
    const held = topicHits().slice(h7);
    assert(held.length === 1, `7. the channel back: what waited goes as one message (${held.length})`);
    const bytes7 = Buffer.byteLength(held[0]?.body ?? '');
    assert(bytes7 > 3000 && bytes7 <= alerts.ALERT_MESSAGE_MAX_BYTES, `7. of at most ${alerts.ALERT_MESSAGE_MAX_BYTES} bytes (${bytes7})`);
    assert(ownerLine(held[0].body), '7. the owners made are in it, though they waited behind 47 report lines');
    assert(adminLine(held[0].body), '7. and the admin made, shown before the report lines');
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

    // ── 9. Every slot of the hour taken: a member's hour-end counts go on the summary, none told on its own, none lost ──
    advance(HOUR + MIN);
    await tick();
    await settle();
    const firstsA = Array.from({ length: 10 }, (_, i) => join(`SlotFayA${i}R`));
    const firstsB = Array.from({ length: 10 }, (_, i) => join(`SlotGusB${i}R`));
    const late = join('LateMiraR');
    const later = join('LaterNedR');
    const child = async (by: Id, j: number) => {
        const r = await report(by, targets[j], 'Child safety');
        if (r.status !== 200 || r.json?.duplicate) throw new Error(`setup: child-safety report not taken (${r.status} ${JSON.stringify(r.json)})`);
    };
    const p9 = ownerPushes().length;
    const h9 = topicHits().length;
    /** The summaries and members' hour-end lines on the channel since step 9 began (a push says only that the server needs you). */
    const more9 = () => topicHits().slice(h9).filter((h) => /more child-safety reports waiting/.test(String(h.headers.title))).map((h) => h.body.split('\n')[2] ?? '');
    for (const m of firstsA) await child(m, 0);
    await settle();
    assert(ownerPushes().length === p9 + 10, `9. 10 members' firsts take the server's 10 slots for the hour (${ownerPushes().length - p9} pushes)`);
    advance(MIN);
    for (let j = 0; j < 3; j++) await child(late, j);
    advance(4 * MIN);
    await child(later, 0);
    await settle();
    assert(ownerPushes().length === p9 + 10, `9. a member's first and 2 repeats past the slots, and another's first 4 minutes on: nothing told yet (${ownerPushes().length - p9 - 10})`);
    await tick();
    const book9 = fs.readFileSync(path.join(dataDir!, alerts.ALERTS_STATE_FILE), 'utf8');
    const open9 = Object.entries((JSON.parse(book9) as { child: { reporters: Record<string, { folded: number }> } }).child.reporters);
    assert(open9.length === 12 && open9.every(([id]) => /^[0-9a-f]{24}$/.test(id)) && open9.filter(([, w]) => w.folded === 2).length === 1
        && ![...firstsA, late, later].some((m) => book9.includes(m.pk) || book9.includes(m.pk.slice(0, 12))),
        `9. while their hours are open the book keeps each by a hash, never the key (${open9.length} hours: ${JSON.stringify(open9.map(([id]) => id.length))})`);
    advance(6 * MIN + 30_000);
    await tick();
    await settle();
    assert(ownerPushes().length === p9 + 11 && more9().length === 1
        && /2 more child-safety reports came in, from 2 members, past the 10 lines an hour this server tells on their own/.test(more9()[0]),
        `9. 10 minutes after the first past the slots, one summary (pushed) counts both: a later count does not push it back (${ownerPushes().length - p9 - 10}: ${JSON.stringify(more9())})`);
    advance(49 * MIN);
    const p9b = ownerPushes().length;
    await tick();
    await settle();
    assert(ownerPushes().length === p9b, `9. the 10 members' hours over with no repeats: nothing told, no "0 more" line (${ownerPushes().length - p9b})`);
    for (const m of firstsB) await child(m, 1);
    await settle();
    assert(ownerPushes().length === p9b + 10, `9. their slots free again, 10 more members' firsts take all 10 (${ownerPushes().length - p9b})`);
    advance(MIN);
    await tick();
    await settle();
    assert(ownerPushes().length === p9b + 10 && more9().length === 1,
        `9. the member's hour over with no slot left: not told on its own, so at most 10 lines in the hour (${ownerPushes().length - p9b} pushes)`);
    advance(10 * MIN + 10_000);
    await tick();
    await settle();
    const sum9b = more9().slice(1);
    assert(ownerPushes().length === p9b + 11 && sum9b.length === 1
        && /2 more child-safety reports came in, from one member, past the 10 lines an hour this server tells on their own/.test(sum9b[0]),
        `9. ten minutes on, the summary (pushed) counts the member's 2 repeats, none dropped (${ownerPushes().length - p9b - 10}: ${JSON.stringify(sum9b)})`);
    assert(!/[0-9a-f]{16}/.test(sum9b[0]), '9. a one-member summary says "one member" and names nobody, not even by a hash');
    advance(HOUR);
    await tick();
    await settle();
    assert(ownerPushes().length === p9b + 11, `9. and nothing more is pending (${ownerPushes().length - p9b - 11})`);

    // ── 10. A held message too long for 4 KB: a security line that is not high goes before the report lines ─────────
    type Ev = Parameters<typeof alerts.composeAlert>[1][number];
    const at10 = Date.now();
    const ev = (key: Ev['key'], detail: string, priority: Ev['priority'], high?: boolean): Ev =>
        ({ key, kind: 'raised', at: at10, since: at10, priority, detail, ...(high ? { high } : {}) });
    const reports10 = Array.from({ length: 60 }, (_, i) => ev('reports.child', `A report in the child-safety category came in: look at it first. ${i + 1} reports wait.`, 5, true));
    const ownerMade10 = ev('sec.role', 'Someone was made an owner, by the admin password.', 5, true);
    const adminMade10 = ev('sec.role', `Someone was made an admin, by an owner. ${'An admin is told of reports and can change what members see. '.repeat(3)}`, 4);
    const lineBytes = (e: Ev) => Buffer.byteLength(alerts.composeAlert('Report Test Commons', [e], null).text);
    if (lineBytes(adminMade10) <= lineBytes(reports10[59]) + 40) throw new Error('setup: the admin-made line must be longer than a report line');
    const m10 = alerts.composeAlert('Report Test Commons', [ownerMade10, ...reports10, adminMade10], null);
    const bytes10 = Buffer.byteLength(m10.text);
    assert(bytes10 <= alerts.ALERT_MESSAGE_MAX_BYTES && /- And \d+ more, too many for one message/.test(m10.text),
        `10. 60 urgent report lines and two security lines: one message of at most 4 KB, the rest a count (${bytes10} bytes, ${m10.events.length} lines shown)`);
    assert(m10.events.includes(ownerMade10) && m10.events.includes(adminMade10),
        '10. the owner made (high) and the admin made (not high, last and longer than a report line) are both shown: report lines fill what is left');
    assert(m10.events.filter((e) => e.key === 'reports.child').length >= 20, `10. as many report lines as fit (${m10.events.filter((e) => e.key === 'reports.child').length})`);

    // ── 11. A history full of other lines keeps a new report line (the confirmation review 2's finding 1) ───────────
    advance(HOUR + MIN);
    await tick();
    await settle();
    const reminder = (i: number) => alerts.updateAlerts([{ key: 'backups.none', active: true, oneShot: true, push: false, detail: `Day ${i}: no backup leaves this server. Open Settings → Backups.` }]);
    let day = 0;
    for (; day < 60; day++) await reminder(day);
    const histAdmin = join('HistAdminHalR');
    grantNodeRole(histAdmin.pk, 'admin', owner.pk);
    await settle(1000);
    const isAdmin11 = (e: { key: string; detail: string }) => e.key === 'sec.role' && /Someone was made an admin, by an owner\./.test(e.detail);
    const high11 = (e: { high?: boolean; priority: number }) => !!e.high || e.priority >= 5;
    // Oldest first (the card lists the newest first).
    const h11 = alerts.getAlertsStatus().history.slice().reverse();
    const at11 = h11.findIndex(isAdmin11);
    assert(at11 >= 0 && !high11(h11[at11]) && !h11.some((e) => e.key.startsWith('reports.')), `11. 60 reminders push every report line out; someone made an admin after them (${h11.length} lines)`);
    // More reminders, until the admin made is the oldest line that is not high.
    const older = h11.slice(0, at11).filter((e) => !high11(e)).length;
    for (let i = 0; i < older; i++) await reminder(day++);
    const h11b = alerts.getAlertsStatus().history.slice().reverse();
    assert(h11b.length === 50 && h11b.find((e) => !high11(e)) === h11b.find(isAdmin11) && h11b.every((e) => !e.key.startsWith('reports.')),
        `11. 50 lines, none a report's, the admin made the oldest not high (${h11b.length}, ${older} more reminders)`);
    const p11 = ownerPushes().length;
    const r11 = await nextReport('Spam or scam');
    await settle();
    assert(r11.status === 200 && ownerPushes().length === p11 + 1, `11. a report comes in and is pushed (${r11.status}, ${ownerPushes().length - p11})`);
    const h11c = alerts.getAlertsStatus().history;
    assert(h11c.some((e) => e.key === 'reports.new'), `11. its line is in the history, the Alerts card's "Last 50 alerts" (it dropped itself: ${h11c.filter((e) => e.key.startsWith('reports.')).length} report lines)`);
    assert(h11c.some(isAdmin11), '11. the security line is still there: a report line made room with a reminder');
    assert(h11c.length === 50, `11. and the history still holds 50 lines (${h11c.length})`);

    // ── 12. Nothing names a member or quotes them ───────────────────────────────────────────────────────────────────
    await settle();
    const st = await adminCall('POST', '/api/local/admin/alerts/status', {});
    assert(st.status === 200 && st.json?.history?.some((e: any) => e.key === 'reports.new'), `12. the Alerts card lists them (${st.status})`);
    const notices = db.prepare(`SELECT recipient, title, body, data FROM push_notices WHERE kind = 'owner.alert'`).all() as any[];
    assert(notices.some((x) => x.recipient === admin.pk) && notices.every((x) => x.recipient === owner.pk || x.recipient === admin.pk),
        `12. ${notices.length} owner.alert notices kept, every one for the owner or the admin`);
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
        `12. ${payloads.length} payloads (${topicHits().length} channel messages, ${n} reports), none names a member or quotes a reason (${leaks.length})`);
    assert(blocked.length === 0, `12. nothing off this machine was asked (${blocked.join(', ')})`);

    await ntfy.close();
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(testsPassed === testsRun ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${testsPassed}/${testsRun} passed`);
    process.exit(1);
});
