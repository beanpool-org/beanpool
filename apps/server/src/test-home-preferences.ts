/**
 * Test Suite: a member's Home, kept on their account (slice H1 of scratch/global-node/DESIGN-home-dashboard-fable.md, §4.2
 * and §4.3): `home.layout` (which cards they moved, hid or dismissed) and `interests` (the categories they starred), two keys
 * of POST/GET /api/members/preferences, through the real signature middleware.
 *
 *  1. A member saves a layout and interests; the answer carries back what was kept, and their own read serves both, the
 *     layout as an object and the interests as a list. A member who never set them reads neither key.
 *  2. Unknown card and category ids are dropped, not refused (a phone newer or older than the node), and so are repeats.
 *     `needs` and `community` can't be hidden, so a hide of either is dropped too.
 *  3. Refused whole, nothing written: more than 32 ids in a list of the layout, more than 17 interests, a layout or a list
 *     of the wrong shape, an id that isn't text, a version other than 1, a date that isn't one; and a body with a valid
 *     push setting beside a refused Home key.
 *  4. The last write wins by `updatedAt`: an older layout leaves the newer one in place (and the answer says which is
 *     kept), a date in the future is held to the node's now, and a layout sent without one is stamped now.
 *  5. Own read and own write only: another member's read is refused under read auth, and under the operator's opt-out it
 *     serves neither Home key (nor does an unsigned read); a write naming another member writes nothing of theirs; a key
 *     with no member row and a visitor's row keep no Home here.
 *  6. A save stamps the member's row, so delta sync carries the keys to a standby (test-standby-standing.ts proves the
 *     copy and the take-over); a row stored under either key before this rule (the setter once stored any key) is read
 *     through the same checks, never served raw.
 *  7. The cost, as the design's §5 asks: one signed request to read and one to write; the most a layout can hold stays
 *     under 1 KB, and the whole own read with it under 2 KB.
 *  8. The interests carry the node's own stamp (`interestsUpdatedAt`, PR #1479 round 2), in the save's answer and the own
 *     read: set when the list changes, left alone by a save of the same list, always later than the one before it (a
 *     clock behind a kept stamp included); interests kept before the stamp read as 1970; none kept, none served; never
 *     served to another reader; and an app can't send it.
 *  9. The card frame's version 2 (scratch/home/CARD-FRAME-DESIGN-fable.md §2.3, §5.2 item 5): a layout with a saved search
 *     and a card of a type no app knows yet (`zzz-future`) round-trips unchanged, settings byte for byte; 25 cards, a
 *     600-byte `settings`, a 9 KB body, a repeated id and a bad date are refused whole with their sentence; a version-1
 *     body is still kept after it, and last write still wins by `updatedAt` across the two versions; a stored version-2
 *     value is read through core's tolerant reader (a malformed instance dropped, the rest kept).
 *
 * Run (read auth on, the default; the opt-out is a second registered run):
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-home-preferences.ts
 *   ENFORCE_READ_AUTH=false BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-home-preferences.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const READ_AUTH = process.env.ENFORCE_READ_AUTH !== 'false'; // https-server.ts's rule: unset means ON

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); }
}

/** The design's catalogue (§3.1) and the 17 categories (@beanpool/core PRICING_CATEGORIES), as the apps send them. */
const CARDS = ['needs', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide',
    'groups', 'joined', 'pulse', 'beans', 'notices', 'invite', 'community'];
const CATEGORIES = ['food', 'services', 'labour', 'tools', 'goods', 'garden', 'housing', 'transport', 'education', 'arts',
    'health', 'care', 'animals', 'tech', 'energy', 'mindset', 'general'];

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
function makeMember(name: string, visitor = false): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_visitor)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis', ?)`).run(id.pk, name, visitor ? 1 : 0);
    return id;
}

interface Answer { status: number; body: any; bytes: number }
async function call(method: 'GET' | 'POST', path: string, as?: Id, body?: unknown): Promise<Answer> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (as) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = as.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), as.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? raw : undefined });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, bytes: Buffer.byteLength(text) };
}
const save = (who: Id, preferences: unknown) => call('POST', '/api/members/preferences', who, { publicKey: who.pk, preferences });
const read = (who: Id, reader: Id | null = who) => call('GET', `/api/members/preferences?publicKey=${who.pk}`, reader ?? undefined);
const rowsOf = (pk: string) => JSON.stringify(db.prepare('SELECT pref_key, pref_value FROM member_preferences WHERE public_key = ? ORDER BY pref_key').all(pk));
const stored = (pk: string, key: string) => (db.prepare('SELECT pref_value FROM member_preferences WHERE public_key = ? AND pref_key = ?').get(pk, key) as { pref_value: string } | undefined)?.pref_value;
const show = (a: Answer) => `${a.status} ${JSON.stringify(a.body)?.slice(0, 220)}`;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function main(): Promise<void> {
    console.log(`\nHome preferences (read auth ${READ_AUTH ? 'on' : 'opted out'})\n`);
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const ann = makeMember('Ann');
    const bob = makeMember('Bob');
    const cy = makeMember('Cy');
    const vic = makeMember('Vic', true);
    const nora = newId('Nora'); // a key with no row here

    // ── 1. Saved, answered back, read back by its owner ──
    console.log('\n— 1. a member saves a layout and interests, and reads them back —');
    const untouched = await read(cy);
    assert(untouched.status === 200 && !('home.layout' in untouched.body) && !('interests' in untouched.body),
        `a member who never set them reads neither key (${Object.keys(untouched.body ?? {}).sort().join(',')})`);
    const annLayout = { v: 1, order: ['events', 'market', 'pulse', 'beans'], hidden: ['joined'], dismissed: { safety: iso(-3_600_000) }, updatedAt: iso(-60_000) };
    const saved = await save(ann, { 'home.layout': annLayout, interests: ['garden', 'food'] });
    assert(saved.status === 200 && saved.body?.success === true, `Ann's layout and interests save (${show(saved)})`);
    assert(JSON.stringify(saved.body?.['home.layout']) === JSON.stringify(annLayout) && JSON.stringify(saved.body?.interests) === '["garden","food"]',
        `the answer carries back what was kept, so the app needs no second read (${show(saved)})`);
    const annRead = await read(ann);
    assert(annRead.status === 200 && JSON.stringify(annRead.body?.['home.layout']) === JSON.stringify(annLayout),
        `her own read serves the layout as an object, every field as she sent it (${JSON.stringify(annRead.body?.['home.layout'])})`);
    assert(JSON.stringify(annRead.body?.interests) === '["garden","food"]', `and her interests as a list, in her order (${JSON.stringify(annRead.body?.interests)})`);
    assert(annRead.body?.notify_chat === 'true' && JSON.stringify(annRead.body?.eventReminderOffsets) === '[1440]',
        `her push settings read as before beside them (${annRead.body?.notify_chat}, ${JSON.stringify(annRead.body?.eventReminderOffsets)})`);

    // ── 2. Unknown and repeated ids dropped; needs and community can't be hidden ──
    console.log('\n— 2. unknown ids are dropped, not refused —');
    const newer = await save(ann, {
        'home.layout': { v: 1, order: ['weather', 'market', 'market', 'events', 'widget-9'], hidden: ['needs', 'community', 'pulse', 'news', 'pulse'],
            dismissed: { safety: iso(-1000), 'first-hint': iso(-1000), needs: iso(-1000) }, updatedAt: iso(-30_000) },
        interests: ['food', 'knitting', 'food', 'tools', 'Garden'],
    });
    const kept = newer.body?.['home.layout'];
    assert(newer.status === 200 && JSON.stringify(kept?.order) === '["market","events"]',
        `a card the node doesn't know, and a repeat, are dropped from the order (${show(newer)})`);
    assert(JSON.stringify(kept?.hidden) === '["pulse"]', `needs and community can't be hidden, and an unknown hidden card is dropped (${JSON.stringify(kept?.hidden)})`);
    assert(JSON.stringify(Object.keys(kept?.dismissed ?? {})) === '["safety"]', `a dismissal of something that isn't a card, or of a card that can't be hidden, is dropped (${JSON.stringify(kept?.dismissed)})`);
    assert(JSON.stringify(newer.body?.interests) === '["food","tools"]', `an unknown category and a repeat are dropped from the interests (${JSON.stringify(newer.body?.interests)})`);
    // The Tips card's "Don't show tips again" is a hide through the layout: the node keeps it, so the member's other devices follow.
    const tipsLayout = { v: 1, order: ['market', 'tips'], hidden: ['pulse', 'tips'], dismissed: {}, updatedAt: iso(-25_000) };
    const tipsSaved = await save(ann, { 'home.layout': tipsLayout });
    const tipsRead = (await read(ann)).body?.['home.layout'];
    assert(tipsSaved.status === 200 && JSON.stringify(tipsSaved.body?.['home.layout']) === JSON.stringify(tipsLayout) && JSON.stringify(tipsRead) === JSON.stringify(tipsLayout),
        `a layout that hides and moves the Tips card is kept as sent, on the save and on a read (${JSON.stringify(tipsRead)})`);
    const allUnknown = await save(cy, { 'home.layout': { v: 1, order: ['weather'], hidden: [], dismissed: {} }, interests: ['knitting'] });
    assert(allUnknown.status === 200 && JSON.stringify(allUnknown.body?.['home.layout']?.order) === '[]' && JSON.stringify(allUnknown.body?.interests) === '[]',
        `a body of nothing but unknown ids saves, as empty lists (${show(allUnknown)})`);
    const shortest = await save(cy, { 'home.layout': {} });
    assert(shortest.status === 200 && JSON.stringify(shortest.body?.['home.layout']?.order) === '[]' && JSON.stringify(shortest.body?.['home.layout']?.hidden) === '[]'
        && JSON.stringify(shortest.body?.['home.layout']?.dismissed) === '{}' && shortest.body?.['home.layout']?.v === 1,
        `a layout with no lists is the defaults: version 1, nothing moved, hidden or dismissed (${show(shortest)})`);

    // ── 3. Refused whole ──
    console.log('\n— 3. refused whole, nothing written —');
    const many = (n: number) => Array.from({ length: n }, (_, i) => `card-${i}`);
    const manyDismissed = Object.fromEntries(many(33).map((k) => [k, iso(-1000)]));
    const refusals: [string, unknown][] = [
        ['33 ids in the order (unknown ones count)', { 'home.layout': { v: 1, order: many(33) } }],
        ['33 ids in the order, every one a real card repeated', { 'home.layout': { v: 1, order: [...CARDS, ...CARDS] } }],
        ['33 hidden ids', { 'home.layout': { v: 1, hidden: many(33) } }],
        ['33 dismissals', { 'home.layout': { v: 1, dismissed: manyDismissed } }],
        ['18 interests', { interests: [...CATEGORIES, 'food'] }],
        ['a layout that is a list', { 'home.layout': ['market'] }],
        ['a layout that is text', { 'home.layout': '{"v":1}' }],
        ['a layout that is null', { 'home.layout': null }],
        ['an order that is text', { 'home.layout': { v: 1, order: 'market' } }],
        ['a hidden list that is an object', { 'home.layout': { v: 1, hidden: { pulse: true } } }],
        ['dismissals that are a list', { 'home.layout': { v: 1, dismissed: ['safety'] } }],
        ['an id that is a number', { 'home.layout': { v: 1, order: ['market', 7] } }],
        ['an id that is null', { 'home.layout': { v: 1, hidden: [null] } }],
        ['version 2', { 'home.layout': { v: 2, order: ['market'] } }],
        ['a version that is text', { 'home.layout': { v: '1' } }],
        ['an updatedAt that is no date', { 'home.layout': { v: 1, updatedAt: 'yesterday' } }],
        ['an updatedAt that is a number', { 'home.layout': { v: 1, updatedAt: Date.now() } }],
        ['a dismissal that is no date', { 'home.layout': { v: 1, dismissed: { safety: true } } }],
        ['interests that are text', { interests: 'food' }],
        ['interests that are an object', { interests: { food: true } }],
        ['an interest that is a number', { interests: ['food', 3] }],
        ['interests that are null', { interests: null }],
        ['a valid push setting beside a refused layout', { notify_chat: false, 'home.layout': { v: 2 } }],
        ['a valid layout beside refused interests', { 'home.layout': { v: 1, order: ['beans'] }, interests: 'food' }],
        ['the layout under another spelling', { home_layout: { v: 1 } }],
    ];
    for (const [what, preferences] of refusals) {
        const before = rowsOf(ann.pk);
        const r = await save(ann, preferences);
        const after = rowsOf(ann.pk);
        assert(r.status === 400 && typeof r.body?.error === 'string' && r.body.error.length > 0 && r.body?.success === undefined && after === before,
            `${what}: refused with 400 and a sentence, nothing written (${show(r)}${after === before ? '' : '; CHANGED'})`);
    }
    const sentence = (await save(ann, { 'home.layout': { v: 1, order: many(33) } })).body?.error ?? '';
    assert(/32/.test(sentence) && !/sqlite|undefined|TypeError/i.test(sentence), `the refusal says the limit in words (${sentence})`);
    const sentence17 = (await save(ann, { interests: [...CATEGORIES, 'food'] })).body?.error ?? '';
    assert(/17/.test(sentence17), `and the interests' limit too (${sentence17})`);
    const unknownKey = (await save(ann, { made_up: true })).body?.error ?? '';
    assert(unknownKey.includes('home.layout') && unknownKey.includes('interests'), `a made-up key's refusal names the Home keys among those saved here (${unknownKey})`);
    const allCards = await save(ann, { 'home.layout': { v: 1, order: [...CARDS].reverse(), updatedAt: iso(-20_000) }, interests: [...CATEGORIES] });
    assert(allCards.status === 200 && allCards.body?.['home.layout']?.order?.length === 18 && allCards.body?.interests?.length === 17,
        `every card in the order and all 17 interests are fine (${allCards.status}, ${allCards.body?.['home.layout']?.order?.length} cards, ${allCards.body?.interests?.length} interests)`);
    const clear = await save(ann, { interests: [] });
    assert(clear.status === 200 && JSON.stringify(clear.body?.interests) === '[]' && JSON.stringify((await read(ann)).body?.interests) === '[]',
        `an empty list clears the interests (${show(clear)})`);

    // ── 4. Last write wins by updatedAt ──
    console.log('\n— 4. the last write wins by updatedAt —');
    const current = (await read(ann)).body?.['home.layout'];
    const beforeOld = rowsOf(ann.pk);
    const older = await save(ann, { 'home.layout': { v: 1, order: ['beans'], updatedAt: iso(-86_400_000) } });
    assert(older.status === 200 && JSON.stringify(older.body?.['home.layout']) === JSON.stringify(current) && rowsOf(ann.pk) === beforeOld,
        `a layout older than the one kept leaves it in place, and the answer is the one kept (${show(older)})`);
    const future = iso(86_400_000);
    const ahead = await save(ann, { 'home.layout': { v: 1, order: ['decide'], updatedAt: future } });
    const aheadAt = Date.parse(ahead.body?.['home.layout']?.updatedAt ?? '');
    assert(ahead.status === 200 && JSON.stringify(ahead.body?.['home.layout']?.order) === '["decide"]' && aheadAt <= Date.now() && aheadAt > Date.now() - 60_000,
        `a phone whose clock runs a day ahead is held to the node's now, so its layout can't outlast every later one (${ahead.body?.['home.layout']?.updatedAt}, sent ${future})`);
    await new Promise((r) => setTimeout(r, 5));
    const unstamped = await save(ann, { 'home.layout': { v: 1, order: ['groups'] } });
    const unstampedAt = unstamped.body?.['home.layout']?.updatedAt;
    assert(unstamped.status === 200 && JSON.stringify(unstamped.body?.['home.layout']?.order) === '["groups"]' && Date.parse(unstampedAt) >= aheadAt,
        `a layout sent with no updatedAt is stamped with the node's now and wins (${unstampedAt})`);
    const same = await save(ann, { 'home.layout': { v: 1, order: ['events'], updatedAt: unstampedAt } });
    assert(same.status === 200 && JSON.stringify(same.body?.['home.layout']?.order) === '["events"]', `a layout as new as the one kept replaces it (${show(same)})`);
    const pushBesideOld = await save(ann, { notify_escrow: false, 'home.layout': { v: 1, order: ['beans'], updatedAt: iso(-86_400_000) } });
    assert(pushBesideOld.status === 200 && (await read(ann)).body?.notify_escrow === 'false' && JSON.stringify(pushBesideOld.body?.['home.layout']?.order) === '["events"]',
        `a push setting beside an older layout still saves; only the layout is kept as it was (${show(pushBesideOld)})`);

    // ── 5. Own read, own write ──
    console.log('\n— 5. own read and own write only —');
    const bobReadsAnn = await read(ann, bob);
    const unsignedRead = await read(ann, null);
    if (READ_AUTH) {
        assert(bobReadsAnn.status === 403 && !JSON.stringify(bobReadsAnn.body).includes('events'), `Bob's read of Ann's preferences is refused (${show(bobReadsAnn)})`);
        assert(unsignedRead.status === 401, `an unsigned read is refused (${unsignedRead.status})`);
    } else {
        assert(bobReadsAnn.status === 200 && !('home.layout' in bobReadsAnn.body) && !('interests' in bobReadsAnn.body) && !('interestsUpdatedAt' in bobReadsAnn.body),
            `with read auth opted out, Bob's read of Ann's preferences serves neither Home key (${Object.keys(bobReadsAnn.body ?? {}).sort().join(',')})`);
        assert(unsignedRead.status === 200 && !('home.layout' in unsignedRead.body) && !('interests' in unsignedRead.body) && !('interestsUpdatedAt' in unsignedRead.body),
            `and nor does an unsigned read (${Object.keys(unsignedRead.body ?? {}).sort().join(',')})`);
        const own = await read(ann);
        assert(own.status === 200 && JSON.stringify(own.body?.['home.layout']?.order) === '["events"]', `while Ann's own read still serves hers (${show(own)})`);
    }
    const annRows = rowsOf(ann.pk);
    const bobAsAnn = await call('POST', '/api/members/preferences', bob, { publicKey: ann.pk, preferences: { 'home.layout': { v: 1, order: ['beans'] }, interests: ['tech'] } });
    assert(rowsOf(ann.pk) === annRows, `a write signed by Bob naming Ann writes nothing of hers (${show(bobAsAnn)})`);
    const noraRows = rowsOf(nora.pk);
    const noRow = await save(nora, { 'home.layout': { v: 1, order: ['market'] }, interests: ['food'] });
    assert(noRow.status >= 400 && noRow.status < 500 && rowsOf(nora.pk) === noraRows, `a key with no member row here keeps no Home (${show(noRow)})`);
    const vicRows = rowsOf(vic.pk);
    const visitor = await save(vic, { 'home.layout': { v: 1, order: ['market'] } });
    const visitorInterests = await save(vic, { interests: ['food'] });
    assert(visitor.status === 403 && visitorInterests.status === 403 && rowsOf(vic.pk) === vicRows,
        `nor does a visitor's row: the gate takes only push settings from it (${show(visitor)} / ${visitorInterests.status})`);
    const vicPush = await save(vic, { notify_chat: false });
    assert(vicPush.status === 200, `while its push settings still save (${show(vicPush)})`);

    // ── 6. The row is stamped; rows from before the rule are read through the checks ──
    console.log('\n— 6. a save stamps the row; an old row is read through the same checks —');
    const stampOf = (pk: string) => (db.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(pk) as { updated_at: string }).updated_at;
    const bobBefore = stampOf(bob.pk);
    await new Promise((r) => setTimeout(r, 5));
    const bobSaves = await save(bob, { interests: ['care'] });
    assert(bobSaves.status === 200 && stampOf(bob.pk) > bobBefore, `saving interests moves the member's row, so a delta carries them (${bobBefore} → ${stampOf(bob.pk)})`);
    const bobBefore2 = stampOf(bob.pk);
    await new Promise((r) => setTimeout(r, 5));
    await save(bob, { 'home.layout': { v: 1, order: ['beans'] } });
    assert(stampOf(bob.pk) > bobBefore2, `and so does saving a layout (${bobBefore2} → ${stampOf(bob.pk)})`);
    const dee = makeMember('Dee');
    const plant = (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?)').run(dee.pk, key, value);
    plant('home.layout', 'not json at all');
    plant('interests', '{"food":true}');
    const garbage = await read(dee);
    assert(garbage.status === 200 && !('home.layout' in garbage.body) && !('interests' in garbage.body),
        `a stored value that isn't a layout or a list is served as nothing (${Object.keys(garbage.body ?? {}).sort().join(',')})`);
    plant('home.layout', JSON.stringify({ v: 1, order: ['market', 'weather', 'market'], hidden: ['needs', 'pulse'], dismissed: { safety: 'x', joined: '2026-09-30T10:00:00.000Z' }, updatedAt: '2026-09-30T10:00:00.000Z', extra: 'x'.repeat(50) }));
    plant('interests', JSON.stringify(['food', 'knitting', 7, 'food', 'tools']));
    const old = await read(dee);
    assert(JSON.stringify(old.body?.['home.layout']) === JSON.stringify({ v: 1, order: ['market'], hidden: ['pulse'], dismissed: { joined: '2026-09-30T10:00:00.000Z' }, updatedAt: '2026-09-30T10:00:00.000Z' }),
        `a stored layout with unknown ids, an unhideable card, a bad date and a field of its own is served as the checks leave it (${JSON.stringify(old.body?.['home.layout'])})`);
    assert(JSON.stringify(old.body?.interests) === '["food","tools"]', `and stored interests the same way (${JSON.stringify(old.body?.interests)})`);
    plant('home.layout', JSON.stringify({ v: 3, order: ['market'] }));
    assert(!('home.layout' in (await read(dee)).body), 'a stored layout of a version this node does not know is served as nothing');

    // ── 7. Cost ──
    console.log('\n— 7. what it costs —');
    const fullest = {
        v: 1, order: [...CARDS], hidden: CARDS.filter((c) => c !== 'needs' && c !== 'community'),
        dismissed: Object.fromEntries(CARDS.map((c) => [c, '2026-10-02T15:40:00.000Z'])), updatedAt: iso(-1000),
    };
    const eve = makeMember('Eve');
    const plain = await read(eve);
    const fullSave = await save(eve, { 'home.layout': fullest, interests: [...CATEGORIES] });
    const layoutBytes = Buffer.byteLength(stored(eve.pk, 'home.layout') ?? '');
    const interestBytes = Buffer.byteLength(stored(eve.pk, 'interests') ?? '');
    const fullRead = await read(eve);
    assert(fullSave.status === 200 && layoutBytes > 0 && layoutBytes < 1024, `the most a layout can hold, every card moved, hidden and dismissed, is stored in ${layoutBytes} bytes (under 1 KB)`);
    assert(interestBytes < 256, `all 17 interests in ${interestBytes} bytes`);
    assert(fullRead.status === 200 && fullRead.bytes < 2048,
        `the whole own read with both is one signed GET of ${fullRead.bytes} bytes (${plain.bytes} without them; under 2 KB), and a save one signed POST answering ${fullSave.bytes} bytes`);
    console.log(`  measured: read ${plain.bytes} B → ${fullRead.bytes} B with the fullest Home; stored layout ${layoutBytes} B, interests ${interestBytes} B; save answer ${fullSave.bytes} B`);

    // ── 8. The interests' stamp ──
    console.log('\n— 8. the node stamps the interests when they change —');
    const fay = makeMember('Fay');
    const none = await read(fay);
    assert(none.status === 200 && !('interestsUpdatedAt' in none.body), `none kept, no stamp served (${Object.keys(none.body ?? {}).sort().join(',')})`);
    const before = Date.now();
    const first = await save(fay, { interests: ['food'] });
    const s1 = first.body?.interestsUpdatedAt;
    assert(first.status === 200 && typeof s1 === 'string' && Date.parse(s1) >= before - 1 && Date.parse(s1) <= Date.now() + 1,
        `a first save is stamped, and the answer says when (${show(first)})`);
    assert((await read(fay)).body?.interestsUpdatedAt === s1, 'and her own read serves the same stamp');
    await new Promise((r) => setTimeout(r, 5));
    const sameList = await save(fay, { interests: ['food'] });
    assert(sameList.body?.interestsUpdatedAt === s1, `a save of the same list leaves the stamp (${sameList.body?.interestsUpdatedAt})`);
    const layoutOnly = await save(fay, { 'home.layout': { v: 1, order: ['beans'] } });
    assert(layoutOnly.status === 200 && !('interestsUpdatedAt' in layoutOnly.body) && (await read(fay)).body?.interestsUpdatedAt === s1,
        `a layout save neither names nor moves it (${show(layoutOnly)})`);
    const changed = await save(fay, { interests: ['food', 'garden'] });
    const s2 = changed.body?.interestsUpdatedAt;
    assert(typeof s2 === 'string' && Date.parse(s2) > Date.parse(s1), `a changed list moves it on (${s1} → ${s2})`);
    // A stamp kept ahead of the node's clock (a standby that took over from a server running fast): the next is still later.
    const stampAhead = new Date(Date.now() + 60_000).toISOString();
    db.prepare(`UPDATE member_preferences SET pref_value = ? WHERE public_key = ? AND pref_key = 'interests.updatedAt'`).run(stampAhead, fay.pk);
    const later = await save(fay, { interests: ['garden'] });
    assert(later.body?.interestsUpdatedAt === new Date(Date.parse(stampAhead) + 1).toISOString(),
        `always later than the one before, even with a clock behind it (${stampAhead} → ${later.body?.interestsUpdatedAt})`);
    const cleared = await save(fay, { interests: [] });
    assert(JSON.stringify(cleared.body?.interests) === '[]' && Date.parse(cleared.body?.interestsUpdatedAt) > Date.parse(stampAhead),
        `clearing them is a change like any other: stamped, and served (${show(cleared)})`);
    const gus = makeMember('Gus');
    db.prepare('INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?)').run(gus.pk, 'interests', JSON.stringify(['tools']));
    assert((await read(gus)).body?.interestsUpdatedAt === new Date(0).toISOString(),
        `interests kept before the node stamped them read as stamped at 1970 (${(await read(gus)).body?.interestsUpdatedAt})`);
    const gusSaves = await save(gus, { interests: ['tools'] });
    assert(Date.parse(gusSaves.body?.interestsUpdatedAt) >= before, `and the next save stamps them, the list unchanged (${gusSaves.body?.interestsUpdatedAt})`);
    const fayRows = rowsOf(fay.pk);
    const sent = await save(fay, { interests: ['arts'], 'interests.updatedAt': '2099-01-01T00:00:00.000Z' });
    assert(sent.status === 400 && rowsOf(fay.pk) === fayRows, `an app can't send the stamp: the body is refused whole (${show(sent)})`);
    if (READ_AUTH) {
        const bobReadsFay = await read(fay, bob);
        assert(bobReadsFay.status === 403, `another member's read of hers is refused (${bobReadsFay.status})`);
    } else {
        const bobReadsFay = await read(fay, bob);
        assert(bobReadsFay.status === 200 && !('interestsUpdatedAt' in bobReadsFay.body), `another member's read never carries it (${Object.keys(bobReadsFay.body ?? {}).sort().join(',')})`);
    }

    // ── 9. The card frame: version 2, kept opaque ──
    console.log('\n— 9. version 2 is kept by shape and bounds, never by type —');
    const hal = makeMember('Hal');
    const frame = {
        v: 2,
        cards: [
            { id: 'steps', type: 'steps' },
            { id: 'search-k7mq', type: 'search', settings: { q: 'eggs', kind: 'any', km: 5 } },
            { id: 'zzz-future-1', type: 'zzz-future', settings: { nested: { list: [1, 'two', null], ünï: 'cödé' }, on: true }, since: 'a field of its own' },
            { id: 'market', type: 'market' },
        ],
        dismissed: { safety: '2026-10-02T15:40:00.000Z' },
        updatedAt: iso(-50_000),
    };
    const frameSaved = await save(hal, { 'home.layout': frame });
    assert(frameSaved.status === 200 && JSON.stringify(frameSaved.body?.['home.layout']) === JSON.stringify(frame),
        `a version-2 layout with a saved search and an unknown type is kept unchanged, and the answer says so (${show(frameSaved)})`);
    const frameRead = await read(hal);
    assert(JSON.stringify(frameRead.body?.['home.layout']) === JSON.stringify(frame) && stored(hal.pk, 'home.layout') === JSON.stringify(frame),
        `her own read and the stored row are the same bytes she sent (${JSON.stringify(frameRead.body?.['home.layout'])?.slice(0, 160)})`);
    const cardsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t-${i}`, type: 't' }));
    const frameRefusals: [string, unknown, RegExp][] = [
        ['25 cards', { v: 2, cards: cardsOf(25) }, /24 cards/],
        ['a settings of 600 bytes', { v: 2, cards: [{ id: 's', type: 'search', settings: { q: 'x'.repeat(600) } }] }, /512 bytes/],
        ['a 9 KB layout', { v: 2, cards: cardsOf(20).map((c) => ({ ...c, settings: { q: 'x'.repeat(450) } })) }, /8 KB/],
        ['a repeated id', { v: 2, cards: [{ id: 'steps', type: 'steps' }, { id: 'steps', type: 'steps' }] }, /own id/],
        ['a bad date', { v: 2, cards: [], updatedAt: 'yesterday' }, /date/],
        ['a dismissal that is no date', { v: 2, cards: [], dismissed: { safety: true } }, /date/],
        ['an id of 33 characters', { v: 2, cards: [{ id: 'x'.repeat(33), type: 'x' }] }, /32 characters/],
        ['settings that are a list', { v: 2, cards: [{ id: 's', type: 's', settings: ['eggs'] }] }, /v: 2/],
        ['cards that are not a list', { v: 2, cards: { steps: true } }, /v: 2/],
    ];
    for (const [what, layout, words] of frameRefusals) {
        const before = rowsOf(hal.pk);
        const r = await save(hal, { 'home.layout': layout });
        assert(r.status === 400 && words.test(r.body?.error ?? '') && rowsOf(hal.pk) === before,
            `version 2, ${what}: refused whole with its sentence, nothing written (${show(r)})`);
    }
    const full24 = { v: 2, cards: cardsOf(24), updatedAt: iso(-45_000) };
    const fits = await save(hal, { 'home.layout': full24 });
    assert(fits.status === 200 && fits.body?.['home.layout']?.cards?.length === 24, `24 cards are fine (${fits.status}, ${fits.body?.['home.layout']?.cards?.length})`);
    const olderFrame = await save(hal, { 'home.layout': { ...frame, updatedAt: iso(-100_000) } });
    assert(olderFrame.status === 200 && olderFrame.body?.['home.layout']?.cards?.length === 24, `an older version-2 layout leaves the newer one kept (${olderFrame.body?.['home.layout']?.cards?.length} cards)`);
    const v1After = { v: 1, order: ['beans', 'market'], hidden: ['pulse'], dismissed: {}, updatedAt: iso(-40_000) };
    const v1Saved = await save(hal, { 'home.layout': v1After });
    assert(v1Saved.status === 200 && JSON.stringify(v1Saved.body?.['home.layout']) === JSON.stringify(v1After),
        `a newer version-1 body is still kept after a version-2 one (${show(v1Saved)})`);
    const olderV2 = await save(hal, { 'home.layout': { ...frame, updatedAt: iso(-90_000) } });
    assert(JSON.stringify(olderV2.body?.['home.layout']) === JSON.stringify(v1After), 'and an older version-2 one leaves it: last write wins across versions');
    const frameUnstamped = await save(hal, { 'home.layout': { v: 2, cards: [{ id: 'tips', type: 'tips' }] } });
    const stampedAt = Date.parse(frameUnstamped.body?.['home.layout']?.updatedAt);
    assert(frameUnstamped.status === 200 && Math.abs(stampedAt - Date.now()) < 5_000 && JSON.stringify(frameUnstamped.body?.['home.layout']?.dismissed) === '{}',
        `a version-2 layout sent without a date is stamped now (${frameUnstamped.body?.['home.layout']?.updatedAt})`);
    const frameAhead = await save(hal, { 'home.layout': { v: 2, cards: [], updatedAt: iso(3_600_000) } });
    assert(Date.parse(frameAhead.body?.['home.layout']?.updatedAt) <= Date.now(), `and one dated in the future is held to the node's now (${frameAhead.body?.['home.layout']?.updatedAt})`);
    const ida = makeMember('Ida');
    db.prepare('INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?)').run(ida.pk, 'home.layout', JSON.stringify({
        v: 2, cards: [{ id: 'steps', type: 'steps' }, { id: 7 }, { id: 'zzz-1', type: 'zzz', settings: { a: 1 } }, { id: 'steps', type: 'steps' }],
        updatedAt: '2026-10-01T00:00:00.000Z', extra: 'dropped',
    }));
    assert(JSON.stringify((await read(ida)).body?.['home.layout']) === JSON.stringify({
        v: 2, cards: [{ id: 'steps', type: 'steps' }, { id: 'zzz-1', type: 'zzz', settings: { a: 1 } }], dismissed: {}, updatedAt: '2026-10-01T00:00:00.000Z',
    }), `a stored version-2 value is read tolerantly: the malformed and repeated instances dropped, the unknown type kept (${JSON.stringify((await read(ida)).body?.['home.layout'])})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Home preferences checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
