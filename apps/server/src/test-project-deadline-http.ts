/**
 * A project's deadline, over REAL HTTP — the signature middleware and body parser, not the router alone.
 *
 * Three routes set a project's deadline: POST /api/enterprise (and /api/treasury) for a bounded enterprise, which is
 * how both apps make a project, and POST /api/crowdfund/projects and /update. #1705 checked the crowdfund two with
 * V8's lenient `new Date(x)`; /api/enterprise stored `String(deadlineAt)`: garbage, '9999-12-31' past the 365-day
 * limit, {} as '[object Object]', true as 'true'. Now all three share routes/project-deadline.ts.
 *
 * Verifies, on each route:
 *  1. Refused with a 400 and a plain sentence, never a 500, and nothing stored: an unparseable string, 'garbage 1'
 *     and '1' (V8 reads both as 2001), 'December 1, 2026', '2027-02-30' (V8 reads it as 2 March), {}, true, 0,
 *     '9999-12-31' (past maxProjectExpiryDays), and a deadline in the past: two days ago, as a date-time and as a date
 *     alone (Marty, 9 Oct: "Refuse it" — a new or edited project must end today or later).
 *  2. Accepted: '' (no deadline, stored as null), the ISO date-time both apps send (stored exactly as sent), a date
 *     alone and a date-time with an offset (each stored as the same instant in toISOString() form), today's date
 *     alone, and an hour from now.
 *  3. On /update: a refused value leaves the stored deadline as it was; a valid one still updates it; '' clears it;
 *     leaving deadlineAt out leaves it as it is, and an expired project can still be edited without sending one.
 *  4. "Today" in every time zone, against a fixed clock: the PWA's date field sends the member's day as UTC midnight,
 *     which is still today at UTC-12 until 36 hours after it, so it is taken until then and refused after.
 *
 * Run: node scripts/run-server-suites.mjs with SERVER_SUITES_ONLY=test-project-deadline-http
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { getThresholds } from './config/local-config.js';
import { setMemberPhoto } from '@beanpool/engine';
import { PROJECT_DEADLINE_FORMAT_ERROR, projectDeadlineTooFarError, readProjectDeadline } from './routes/project-deadline.js';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// The sentence Marty's decision asks for (9 Oct), pinned here word for word.
const PAST = "A project's deadline can't be in the past.";

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
let made = 0;

/** A fresh active member: a member may start 3 enterprises a day, so every create that should succeed gets its own. */
function makeMember(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(pubKeyHex, `Member${++made}`);
    setMemberPhoto(db, pubKeyHex, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

/** The replay-proof scheme the real middleware requires: method + path + timestamp + nonce + body. */
async function signedPost(path: string, body: unknown, id: Id) {
    const bodyString = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `POST\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pubKeyHex,
            'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: bodyString,
    });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

const show = (v: unknown) => (v === undefined ? 'undefined' : JSON.stringify(v));
const storedDeadlines = (id: string) => ({
    project: (db.prepare('SELECT deadline_at AS d FROM projects WHERE id = ?').get(id) as any)?.d,
    member: (db.prepare('SELECT deadline_at AS d FROM members WHERE public_key = ?').get(id) as any)?.d,
});
const projectCount = () => (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as any).n as number;

async function main(): Promise<void> {
    console.log('\nA project’s deadline, over real HTTP\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const maxDays = getThresholds().maxProjectExpiryDays;
    const TOO_FAR = projectDeadlineTooFarError(maxDays);
    const now = Date.now();
    const inSeven = new Date(now + 7 * DAY).toISOString();
    const inNine = new Date(now + 9 * DAY).toISOString();
    const dateOnly = new Date(now + 10 * DAY).toISOString().slice(0, 10);
    const offsetInstant = Math.floor((now + 5 * DAY) / 1000) * 1000;
    const withOffset = new Date(offsetInstant + 10 * 60 * 60 * 1000).toISOString().slice(0, 19) + '+10:00';
    const twoDaysAgo = new Date(now - 2 * DAY).toISOString();
    const twoDaysAgoDate = twoDaysAgo.slice(0, 10);
    const todayDate = new Date(now).toISOString().slice(0, 10);
    const inAnHour = new Date(now + HOUR).toISOString();

    const refused: { value: unknown; error: string }[] = [
        { value: 'not-a-valid-date-string', error: PROJECT_DEADLINE_FORMAT_ERROR },
        { value: 'garbage 1', error: PROJECT_DEADLINE_FORMAT_ERROR },
        { value: '1', error: PROJECT_DEADLINE_FORMAT_ERROR },
        { value: 'December 1, 2026', error: PROJECT_DEADLINE_FORMAT_ERROR },
        { value: '2027-02-30', error: PROJECT_DEADLINE_FORMAT_ERROR },
        { value: {}, error: PROJECT_DEADLINE_FORMAT_ERROR },
        { value: true, error: PROJECT_DEADLINE_FORMAT_ERROR },
        { value: 0, error: PROJECT_DEADLINE_FORMAT_ERROR },
        { value: '9999-12-31', error: TOO_FAR },
        { value: twoDaysAgo, error: PAST },
        { value: twoDaysAgoDate, error: PAST },
    ];
    const accepted: { value: unknown; stored: string | null; label: string }[] = [
        { value: '', stored: null, label: "'' (no deadline)" },
        { value: inSeven, stored: inSeven, label: 'the ISO date-time the apps send' },
        { value: dateOnly, stored: `${dateOnly}T00:00:00.000Z`, label: 'a date alone' },
        { value: withOffset, stored: new Date(offsetInstant).toISOString(), label: 'a date-time with +10:00' },
        { value: todayDate, stored: `${todayDate}T00:00:00.000Z`, label: "today's date alone" },
        { value: inAnHour, stored: inAnHour, label: 'an hour from now' },
    ];

    // ── 1. POST /api/enterprise (and /api/treasury): what both apps use ─────────────────────────────────
    console.log('── 1. POST /api/enterprise ──');
    // Each attempt has its own name and member, so a value that slips through cannot hide the next one behind
    // "That name is already taken" or the 3-a-day limit.
    for (const [i, { value, error }] of refused.entries()) {
        const before = projectCount();
        const res = await signedPost('/api/enterprise', {
            name: `Refused Garden ${i + 1}`, purpose: 'Raise a shed', lifecycle: 'bounded', goalAmount: 100, deadlineAt: value,
        }, makeMember());
        assert(res.status === 400 && res.error === error,
            `/api/enterprise refuses deadlineAt ${show(value)} with a 400 and a plain sentence (got ${res.status} ${res.error ?? ''})`);
        assert(projectCount() === before, `...and stores no project for ${show(value)}`);
    }
    const viaTreasury = await signedPost('/api/treasury', {
        name: 'Treasury Garden', lifecycle: 'bounded', goalAmount: 100, deadlineAt: 'garbage 1',
    }, makeMember());
    assert(viaTreasury.status === 400 && viaTreasury.error === PROJECT_DEADLINE_FORMAT_ERROR,
        `/api/treasury, the same handler, refuses it too (got ${viaTreasury.status} ${viaTreasury.error ?? ''})`);
    for (const [i, { value, stored, label }] of accepted.entries()) {
        // Enterprise names are unique on a node.
        const res = await signedPost('/api/enterprise', {
            name: `Bounded Garden ${i + 1}`, purpose: 'Raise a shed', lifecycle: 'bounded', goalAmount: 100, deadlineAt: value,
        }, makeMember());
        const key = res.body?.publicKey;
        const rows = key ? storedDeadlines(key) : { project: 'none', member: 'none' };
        assert(res.status === 200 && res.body?.deadlineAt === stored,
            `/api/enterprise takes ${label} (got ${res.status} ${res.error ?? ''} deadlineAt ${show(res.body?.deadlineAt)})`);
        assert(rows.project === stored && rows.member === stored,
            `...and stores ${show(stored)} on the project and the enterprise (got ${show(rows.project)} / ${show(rows.member)})`);
    }

    // ── 2. POST /api/crowdfund/projects ──────────────────────────────────────────────────────────────
    console.log('── 2. POST /api/crowdfund/projects ──');
    const someone = makeMember();
    for (const { value, error } of refused) {
        const before = projectCount();
        const res = await signedPost('/api/crowdfund/projects', {
            title: 'Crowdfunded Shed', description: 'A shed', goalAmount: 100, deadlineAt: value,
        }, someone);
        assert(res.status === 400 && res.error === error,
            `crowdfund create refuses deadlineAt ${show(value)} with a 400 and a plain sentence (got ${res.status} ${res.error ?? ''})`);
        assert(projectCount() === before, `...and stores no project for ${show(value)}`);
    }
    for (const { value, stored, label } of accepted) {
        const res = await signedPost('/api/crowdfund/projects', {
            title: 'Crowdfunded Shed', description: 'A shed', goalAmount: 100, deadlineAt: value,
        }, makeMember());
        const id = res.body?.project?.id;
        const rows = id ? storedDeadlines(id) : { project: 'none', member: 'none' };
        assert(res.status === 200 && rows.project === stored && rows.member === stored,
            `crowdfund create takes ${label} and stores ${show(stored)} (got ${res.status} ${res.error ?? ''}, ${show(rows.project)} / ${show(rows.member)})`);
    }

    // ── 3. POST /api/crowdfund/projects/update ───────────────────────────────────────────────────────
    console.log('── 3. POST /api/crowdfund/projects/update ──');
    const owner = makeMember();
    const made1 = await signedPost('/api/crowdfund/projects', {
        title: 'Edited Shed', description: 'A shed', goalAmount: 100, deadlineAt: inSeven,
    }, owner);
    const projectId = made1.body?.project?.id as string;
    assert(made1.status === 200 && !!projectId, `a project to edit is made (got ${made1.status} ${made1.error ?? ''})`);
    const update = (deadline: Record<string, unknown>) => signedPost('/api/crowdfund/projects/update', {
        id: projectId, title: 'Edited Shed', description: 'A shed', goalAmount: 100, ...deadline,
    }, owner);
    for (const { value, error } of refused) {
        const res = await update({ deadlineAt: value });
        const rows = storedDeadlines(projectId);
        assert(res.status === 400 && res.error === error,
            `update refuses deadlineAt ${show(value)} with a 400 and a plain sentence (got ${res.status} ${res.error ?? ''})`);
        assert(rows.project === inSeven && rows.member === inSeven,
            `...and the stored deadline is unchanged (got ${show(rows.project)} / ${show(rows.member)})`);
    }
    const toNine = await update({ deadlineAt: inNine });
    let rows = storedDeadlines(projectId);
    assert(toNine.status === 200 && rows.project === inNine && rows.member === inNine,
        `a valid update still moves the deadline (got ${toNine.status} ${toNine.error ?? ''}, ${show(rows.project)})`);
    const withOffsetUpdate = await update({ deadlineAt: withOffset });
    rows = storedDeadlines(projectId);
    assert(withOffsetUpdate.status === 200 && rows.project === new Date(offsetInstant).toISOString(),
        `an update with an offset is stored as the same instant in Z form (got ${withOffsetUpdate.status}, ${show(rows.project)})`);
    const leftOut = await update({});
    rows = storedDeadlines(projectId);
    assert(leftOut.status === 200 && rows.project === new Date(offsetInstant).toISOString(),
        `an update that leaves deadlineAt out leaves the deadline as it is (got ${leftOut.status}, ${show(rows.project)})`);
    const cleared = await update({ deadlineAt: '' });
    rows = storedDeadlines(projectId);
    assert(cleared.status === 200 && rows.project === null && rows.member === null,
        `an update with '' clears the deadline to null, as a create stores none (got ${cleared.status}, ${show(rows.project)} / ${show(rows.member)})`);

    // A project whose deadline has passed: an edit that does not send one leaves it alone and still succeeds; one that
    // sends the passed date again is refused, as any other sent deadline in the past.
    db.prepare('UPDATE projects SET deadline_at = ? WHERE id = ?').run(twoDaysAgo, projectId);
    db.prepare('UPDATE members SET deadline_at = ? WHERE public_key = ?').run(twoDaysAgo, projectId);
    const expiredEdit = await signedPost('/api/crowdfund/projects/update', {
        id: projectId, title: 'Edited Shed, renamed', description: 'A shed', goalAmount: 100,
    }, owner);
    rows = storedDeadlines(projectId);
    const title = (db.prepare('SELECT title FROM projects WHERE id = ?').get(projectId) as any)?.title;
    assert(expiredEdit.status === 200 && title === 'Edited Shed, renamed' && rows.project === twoDaysAgo && rows.member === twoDaysAgo,
        `an expired project can be edited without sending a deadline, which stays as it was (got ${expiredEdit.status} ${expiredEdit.error ?? ''}, ${show(title)}, ${show(rows.project)} / ${show(rows.member)})`);
    const resent = await update({ deadlineAt: twoDaysAgo });
    rows = storedDeadlines(projectId);
    assert(resent.status === 400 && resent.error === PAST && rows.project === twoDaysAgo,
        `...but sending its passed deadline again is refused (got ${resent.status} ${resent.error ?? ''}, ${show(rows.project)})`);

    // ── 4. "Today" in every time zone ─────────────────────────────────────────────────────────────────
    // Against a fixed clock, so the time zones can be named: the server's own clock cannot be moved over HTTP.
    console.log('── 4. "Today" in every time zone ──');
    const at = (iso: string) => Date.parse(iso);
    const read = (value: string, clock: string) => readProjectDeadline(value, maxDays, at(clock));
    // 21:00 on 9 Oct in New York (UTC-4): the PWA's date field sends the member's 9 Oct as UTC midnight, 25 hours ago.
    const newYork = read('2026-10-09T00:00:00.000Z', '2026-10-10T01:00:00Z');
    assert('deadline' in newYork && newYork.deadline === '2026-10-09T00:00:00.000Z',
        `today at 21:00 in New York, as the PWA sends it (UTC midnight, 25 h ago), is taken (got ${show(newYork)})`);
    // 23:59 on 9 Oct at UTC-12, the last place 9 Oct is still today: its UTC midnight is 35 h 59 min ago.
    const lastPlace = read('2026-10-09', '2026-10-10T11:59:00Z');
    assert('deadline' in lastPlace && lastPlace.deadline === '2026-10-09T00:00:00.000Z',
        `9 Oct is taken at 23:59 on 9 Oct at UTC-12, where it is still today (got ${show(lastPlace)})`);
    // At that moment it is 10 Oct or 11 Oct everywhere else, so 8 Oct is yesterday everywhere.
    const yesterdayEverywhere = read('2026-10-08', '2026-10-10T11:59:00Z');
    assert('error' in yesterdayEverywhere && yesterdayEverywhere.error === PAST,
        `8 Oct is refused then: it is yesterday in every time zone (got ${show(yesterdayEverywhere)})`);
    // 9 Oct ends everywhere at 12:00 UTC on 10 Oct, 36 hours after its UTC midnight.
    const justOver = read('2026-10-09', '2026-10-10T12:00:01Z');
    assert('error' in justOver && justOver.error === PAST,
        `9 Oct is refused once it has ended everywhere, 36 h after its UTC midnight (got ${show(justOver)})`);
    // 09:00 on 10 Oct in Sydney (UTC+11): a deadline at the start of the member's day, sent with its offset, is taken.
    const sydney = read('2026-10-10T00:00:00+11:00', '2026-10-09T22:00:00Z');
    assert('deadline' in sydney && sydney.deadline === '2026-10-09T13:00:00.000Z',
        `today from midnight in Sydney, sent with +11:00, is taken (got ${show(sydney)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Project deadline over HTTP PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
