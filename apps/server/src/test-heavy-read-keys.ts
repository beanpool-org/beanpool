/**
 * A heavy read's key holds every input that changes its answer's size (heavy-reads.ts heavyReadKey; #1492's deciding
 * review). A small answer never stands in for the big one.
 *
 * The cap weighs an answer by the last answer under its key, and lets one whose key last answered under 512 KB straight
 * past the line. The roster's key was its group alone, and the list of groups' was 'groups', but `role` and `status`
 * shrink a roster and `q`, `category`, `member` and `offset` the list. So one member's `?role=convenor` (405 bytes) made
 * a 12 MB roster light, and 64 full rosters at once then ran a 512 MB heap out of memory, the crash the cap exists to stop.
 *
 * The list of groups can no longer be heavy: since #1493/#1494 a description is at most 2,000 characters and a list sends
 * only its 300-character preview (engine groups.ts listGroups), so a page of 200 groups at the limit is under 512 KB and
 * goes straight through whatever its key. Section 1 measures that, so a change that lets the list grow again shows here;
 * the weighing cases are the roster's, which is still megabytes.
 *
 * The real server here, in this process, with the cap at a 1 MB budget and a 1.5 s wait (setHeavyReadsForTests), one open
 * group of 25,000 members and 200 groups with descriptions at their 2,000-character limit:
 *   1. Each full answer is read once with nothing in flight, so its size is known: the member's roster, the convenor's
 *      (every status). The list of 200 groups is read too, and is under 512 KB.
 *   2. The small answers under the same routes are read: a member's `?role=convenor` and the convenor's `?status=invited`.
 *   3. A member who stops reading holds a full roster: that answer's whole size is in flight, the budget full.
 *   4. The small answers still go straight through.
 *   5. The full ones are weighed by their own last size: each waits its 1.5 s and is told "busy". At 5257ccc0 each was
 *      let straight through as light, and the reader holding the roster held nothing.
 *   6. When the holder hangs up, a full roster is served again, the same bytes.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-heavy-read-keys.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.HEAVY_READ_BUDGET_MB;

import crypto from 'node:crypto';
import https from 'node:https';
import type http from 'node:http';

const MB = 2 ** 20;
const LIGHT_BYTES = 512 * 1024;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    for (;;) {
        if (check()) return true;
        if (Date.now() > end) return false;
        await sleep(20);
    }
}

type Key = { pk: string; priv: crypto.KeyObject };
function newKey(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

/** A member's signature on a GET, as the apps send one (the older request format, which every node still takes). */
function signed(route: string, key: Key): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`GET\n${route.split('?')[0]}\n${ts}\n${nonce}\n`), key.priv);
    return { 'X-Public-Key': key.pk, 'X-Signature': sig.toString('base64'), 'X-Timestamp': String(ts), 'X-Nonce': nonce };
}

interface Answer { status: number | 'error'; headers: http.IncomingHttpHeaders; bytes: number; sha: string; text: string; ms: number }
interface Open { headers: Promise<http.IncomingMessage | null>; done: Promise<Answer>; hangUp: () => void }

/** One signed GET, its body counted and hashed. `hold`: read nothing after a 200's headers, as a phone that stops reading. */
function open(port: number, route: string, key: Key, o: { hold?: boolean } = {}): Open {
    const t0 = performance.now();
    let req!: http.ClientRequest;
    let response: http.IncomingMessage | null = null;
    let headersResolve!: (r: http.IncomingMessage | null) => void;
    const headers = new Promise<http.IncomingMessage | null>((r) => { headersResolve = r; });
    const done = new Promise<Answer>((resolve) => {
        const hash = crypto.createHash('sha256');
        const kept: Buffer[] = [];
        let bytes = 0, over = false;
        const finish = (status: number | 'error') => {
            if (over) return;
            over = true;
            const text = Buffer.concat(kept).toString('utf8');
            resolve({ status, headers: response?.headers ?? {}, bytes, sha: hash.digest('hex'), text, ms: performance.now() - t0 });
        };
        req = https.request({ host: 'localhost', port, path: route, method: 'GET', headers: signed(route, key), agent: false, rejectUnauthorized: false }, (res) => {
            response = res;
            if (o.hold && res.statusCode === 200) res.pause();
            headersResolve(res);
            res.on('data', (c: Buffer) => {
                bytes += c.length;
                hash.update(c);
                if (bytes <= 4096) kept.push(c);
            });
            res.on('end', () => finish(res.statusCode!));
            res.on('close', () => finish(res.complete ? res.statusCode! : 'error'));
        });
        req.on('error', () => { headersResolve(null); finish('error'); });
        req.end();
    });
    return { headers, done, hangUp: () => { response?.destroy(); req.destroy(); } };
}

/** A 503 from the cap: code heavy_read_busy, Retry-After, no-store, no ETag. */
function isBusy(a: Answer): boolean {
    let code: unknown = null;
    try { code = JSON.parse(a.text).code; } catch { /* not JSON: not the cap's */ }
    return a.status === 503 && code === 'heavy_read_busy' && /^\d+$/.test(String(a.headers['retry-after']))
        && a.headers['cache-control'] === 'no-store' && a.headers.etag === undefined;
}

const rows = (a: Answer): number => { try { return JSON.parse(a.text).length; } catch { return -1; } };

async function main(): Promise<void> {
    console.log('A heavy read is weighed by its own key: a small answer never stands in for the big one...\n');
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const engine = await import('@beanpool/engine');
    const { GROUP_DESCRIPTION_LIMIT } = await import('@beanpool/core');
    const { heavyReadStats, setHeavyReadsForTests } = await import('./heavy-reads.js');
    initAdminPassword();
    await initTls();
    se.initStateEngine();

    // One open group of N members, its convenor and a member who reads it; 200 groups, each description at its limit.
    const N = 25_000, GROUPS = 200;
    const convenor = newKey(), member = newKey();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    insert.run(convenor.pk, 'Convenor', '2026-01-01T00:00:00.000Z', 'INV-CONVENOR');
    insert.run(member.pk, 'Member', '2026-01-01T00:00:00.000Z', 'INV-MEMBER');
    const group = se.createGroup({ name: 'Big', createdBy: convenor.pk, joinPolicy: 'open' });
    engine.joinGroup(db, group.id, member.pk);
    const join = db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at) VALUES (?, ?, 'member', 'active', ?)`);
    db.transaction(() => {
        for (let i = 0; i < N; i++) {
            const pk = crypto.createHash('sha256').update(`heavy-read-keys member ${i}`).digest('hex');
            const at = new Date(Date.UTC(2026, 0, 2) + i * 1000).toISOString();
            insert.run(pk, `Roster${i}`, at, `INV-${i}`);
            join.run(group.id, pk, at);
        }
    })();
    for (let i = 1; i < GROUPS; i++) {
        se.createGroup({ name: `Group ${i}`, description: `Group ${i}: ${'a long description. '.repeat(99)}`.slice(0, GROUP_DESCRIPTION_LIMIT.chars), createdBy: convenor.pk, joinPolicy: 'open' });
    }

    const port = await startHttpsServer(0);
    // A 1 MB budget: a held full roster fills it on its own (nothing in flight, it is served alone), and then anything
    // weighed waits. A 1.5 s wait keeps the refusals quick.
    setHeavyReadsForTests({ budgetBytes: 1 * MB, waitMs: 1500, maxQueue: 8 });
    const inFlight = () => heavyReadStats().inFlightBytes;
    const free = () => until(() => inFlight() === 0, 5000);

    const roster = `/api/groups/${group.id}/members`;
    const routes = {
        memberRoster: { route: roster, key: member },
        convenorRoster: { route: roster, key: convenor },
        convenorsOnly: { route: `${roster}?role=convenor`, key: member },
        invitedOnly: { route: `${roster}?status=invited`, key: convenor },
        allGroups: { route: `/api/groups?limit=${GROUPS}`, key: member },
    };
    const read = (r: { route: string; key: Key }, o: { hold?: boolean } = {}) => open(port, r.route, r.key, o);
    let holder: Open | null = null;

    try {
        // ── 1. Each full answer once, nothing in flight: its size is known from now on ─────────────────────────────
        const full = {
            memberRoster: await read(routes.memberRoster).done,
            convenorRoster: await read(routes.convenorRoster).done,
            allGroups: await read(routes.allGroups).done,
        };
        assert(full.memberRoster.status === 200 && full.memberRoster.bytes >= 4 * MB,
            `a member's full roster is a heavy answer (${full.memberRoster.status}, ${(full.memberRoster.bytes / MB).toFixed(1)} MB)`);
        assert(full.convenorRoster.status === 200 && full.convenorRoster.bytes >= full.memberRoster.bytes,
            `so is the convenor's, every status (${full.convenorRoster.status}, ${(full.convenorRoster.bytes / MB).toFixed(1)} MB)`);
        assert(full.allGroups.status === 200 && full.allGroups.bytes < LIGHT_BYTES,
            `the list of ${GROUPS} groups, each description at its limit, is under 512 KB: previews only, it can't be heavy (${full.allGroups.status}, ${(full.allGroups.bytes / 1024).toFixed(0)} KB)`);
        assert(await free(), `nothing is in flight once they are read (${inFlight()} bytes)`);

        // ── 2. The small answers under the same routes ───────────────────────────────────────────────────────────
        const small = {
            convenorsOnly: await read(routes.convenorsOnly).done,
            invitedOnly: await read(routes.invitedOnly).done,
        };
        assert(small.convenorsOnly.status === 200 && rows(small.convenorsOnly) === 1 && small.convenorsOnly.bytes < 4096,
            `a member's ?role=convenor is one row (${small.convenorsOnly.status}, ${small.convenorsOnly.bytes} bytes)`);
        assert(small.invitedOnly.status === 200 && small.invitedOnly.text === '[]',
            `the convenor's ?status=invited is none (${small.invitedOnly.status}, ${small.invitedOnly.text})`);
        assert(await free(), `nothing is in flight (${inFlight()} bytes)`);

        // ── 3. A member who stops reading holds a full roster ────────────────────────────────────────────────────
        holder = read(routes.memberRoster, { hold: true });
        const held = await holder.headers;
        const holding = await until(() => inFlight() >= full.memberRoster.bytes, 3000);
        assert(held?.statusCode === 200 && holding,
            `a member who stops reading a full roster holds its whole size, the budget full (${held?.statusCode}; ${(inFlight() / MB).toFixed(1)} MB in flight of a ${(full.memberRoster.bytes / MB).toFixed(1)} MB roster)`);

        // ── 4. The small answers still go straight through ───────────────────────────────────────────────────────
        const smallAgain = {
            convenorsOnly: await read(routes.convenorsOnly).done,
            invitedOnly: await read(routes.invitedOnly).done,
        };
        assert(Object.values(smallAgain).every((a) => a.status === 200 && a.ms < 1000),
            `with the budget full, the small answers are still light and go straight through (${Object.values(smallAgain).map((a) => `${a.status} in ${Math.round(a.ms)} ms`).join(', ')})`);

        // ── 5. The full answers are weighed by their own last size, not the small one's ──────────────────────────
        const fullAgain = {
            memberRoster: await read(routes.memberRoster).done,
            convenorRoster: await read(routes.convenorRoster).done,
        };
        const said = (a: Answer) => `${a.status} after ${Math.round(a.ms)} ms`;
        assert(isBusy(fullAgain.memberRoster) && fullAgain.memberRoster.ms >= 1400,
            `after a member's ?role=convenor, a member's full roster is still weighed: it waits its 1.5 s and is told "busy" (${said(fullAgain.memberRoster)})`);
        assert(isBusy(fullAgain.convenorRoster) && fullAgain.convenorRoster.ms >= 1400,
            `after the convenor's ?status=invited, the convenor's full roster is still weighed (${said(fullAgain.convenorRoster)})`);

        // ── 6. The holder hangs up: the budget comes back, and a full roster is served again ─────────────────────
        holder.hangUp();
        holder = null;
        assert(await free(), `the holder gives the budget back when it hangs up (${inFlight()} bytes in flight)`);
        const after = await read(routes.memberRoster).done;
        assert(after.status === 200 && after.sha === full.memberRoster.sha,
            `then a member's full roster is served, the same bytes as before (${after.status}, ${(after.bytes / MB).toFixed(1)} MB)`);
        assert(await free() && heavyReadStats().waiting === 0, `and nothing is left in flight or waiting (${JSON.stringify(heavyReadStats())})`);
    } finally {
        holder?.hangUp();
        setHeavyReadsForTests(undefined);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
