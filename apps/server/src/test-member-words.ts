/**
 * The server's words in the member's language (member-words.ts; scratch/global-node/DESIGN-translation-fable.md §3; Marty's
 * M6): refusals on the way out, by the request's X-Language, and pushes in the language each phone registered with.
 *
 * The catalogs are drafted after merge, so the suite brings its own French and Russian for the sentences it looks at
 * (useCatalogsForTests); the loader's own reading of the real files is checked too.
 *
 *   1. The language a request names: X-Language as core's normaliseLang reads it; the pseudo-locale, a language BeanPool
 *      has no version in, and no header are none.
 *   2. The way out, over the real middleware pair (memberWordsOnTheWayOut outside scrubServerFaults): a refusal's
 *      `error` and `message` in the named language, its status, `code` and other fields as the route made them; a shared
 *      body never changed; a code in `error` left alone; a server fault's fixed words translated after the scrub; a 2xx,
 *      the operator's routes and a sentence only core's catalog has never translated; no header, the answer byte for byte
 *      as before and no Vary; `en` and a tag BeanPool doesn't write, English with Vary.
 *   3. A real server: a refusal a route writes ("You may only read your own conversations", 403) and one the engine
 *      throws through a route's catch ("Membership request already pending", 400) come back in French with X-Language: fr,
 *      in English without it and with `en`, with the same status either way.
 *   4. Pushes: POST /api/push-tokens keeps the phone's `lang` (one BeanPool writes; anything else, or none, is English)
 *      and follows it when the phone registers again; a push goes to each phone in its language ("BeanPool" and the kind's
 *      sentence), the same notice data either way; the standby's copy never carries `lang`.
 *   5. Nothing marked for translation is a sentence an app matches on, or starts with a code the apps read: the hand-kept
 *      list (APP_MATCHES), and every match the apps' sources hold today, found where it is written (appMatchers), so a
 *      new `e.message.includes('…')` on a marked sentence fails here.
 *   6. Each family a member meets (the gate, join and profile, ledger, …): one of its refusals in English as before, and
 *      in French with the same status, code and fields; the suite's French is every marked sentence after a sign.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-member-words.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_ROLE;
delete process.env.NODE_PROFILE;
delete process.env.EXPO_ACCESS_TOKEN;

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Koa from 'koa';
import ts from 'typescript';
import { setMemberPhoto } from '@beanpool/engine';
import { PUSH_NOTICE_KINDS, PUSH_NOTICE_TITLE, pluralKey, wordKey } from '@beanpool/core';
import { memberWordsOnTheWayOut, requestLanguage, useCatalogsForTests, wordsIn } from './member-words.js';
import { scrubServerFaults, SERVER_FAULT_TEXT } from './routes/member-error-text.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 50)); };
const DAY = 24 * 60 * 60 * 1000;

const POLL_CLOSED = 'This poll is closed';
const FR: Record<string, unknown> = {
    [POLL_CLOSED]: 'Ce sondage est clos',
    // Sentences with values in them, a count, and one after a code the apps read.
    'A post can have at most {n} photos': 'Une annonce peut avoir au plus {n} photos',
    'You have {n} active trade in progress.|You have {n} active trades in progress.': { one: 'Vous avez {n} échange en cours.', other: 'Vous avez {n} échanges en cours.' },
    'You hold {held} Beans: you can pay the Commons only what you hold.': 'Vous avez {held} Beans : vous ne pouvez payer aux Communs que ce que vous avez.',
    'Only {who} can remove this': 'Seul {who} peut retirer ceci',
    'Only a convenor can do that': 'Seul un animateur peut faire cela',
    'Post another Offer to spend deeper.': 'Publiez une autre Offre pour aller plus loin.',
    'Your {n} active Offer unlock a −{cap} credit line.|Your {n} active Offers unlock a −{cap} credit line.': { one: 'Votre Offre active ouvre un crédit de −{cap}.', other: 'Vos {n} Offres actives ouvrent un crédit de −{cap}.' },
    [SERVER_FAULT_TEXT]: "Une erreur s'est produite sur le serveur. Veuillez réessayer.",
    'You may only read your own conversations': 'Vous ne pouvez lire que vos propres conversations',
    'Membership request already pending': "Une demande d'adhésion est déjà en attente",
};
const FR_CORE = { 'You have a new message.': 'Vous avez un nouveau message.', 'Only a sentence of core': 'Seulement une phrase du cœur' };
const RU_CORE = { 'You have a new message.': 'У вас новое сообщение.' };

// ── 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function testRequestLanguage(): void {
    console.log('\n--- 1. The language a request names ---');
    const named = (tag: string | undefined) => requestLanguage({ get: (h: string) => (h === 'X-Language' && tag !== undefined ? tag : '') } as any);
    assert(named('fr') === 'fr' && named('ru') === 'ru' && named('zh-Hant') === 'zh-Hant' && named('fil') === 'fil', 'a tag of the 25 is that language');
    assert(named('ru-RU') === 'ru' && named('pt_BR') === 'pt' && named('zh-TW') === 'zh-Hant', "a device's tag with a region is its language, as core reads it");
    assert(named('xx') === null && named('he') === null && named('') === null && named(undefined) === null && named('not a tag') === null,
        'the pseudo-locale, a language BeanPool has no version in, an empty or absent header: none');
}

// ── 2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Got { status: number; text: string; body: any; vary: string | null }

async function testWayOut(): Promise<void> {
    console.log('\n--- 2. The way out ---');
    const SHARED = Object.freeze({ error: POLL_CLOSED, code: 'poll_closed', postId: 'p-1' });
    const app = new Koa();
    app.use(memberWordsOnTheWayOut());
    app.use(scrubServerFaults());
    app.use(async (ctx) => {
        const answers: Record<string, [number, unknown]> = {
            '/api/refused': [403, SHARED],
            '/api/coded': [404, { error: 'not_found', message: POLL_CLOSED }],
            '/api/fault': [400, { error: 'SQLITE_BUSY: database is locked' }],
            '/api/ok': [200, { success: true, message: POLL_CLOSED }],
            '/api/unknown': [400, { error: 'A sentence no catalog has' }],
            '/api/core-only': [400, { error: 'Only a sentence of core' }],
            '/api/local/admin/refused': [400, { error: POLL_CLOSED }],
            '/api/admin/refused': [400, { error: POLL_CLOSED }],
            '/api/text': [400, POLL_CLOSED],
            '/api/valued': [400, { error: 'A post can have at most 6 photos' }],
            '/api/count-one': [400, { error: 'You have 1 active trade in progress.' }],
            '/api/count-many': [400, { error: 'You have 3 active trades in progress.' }],
            '/api/decimal': [400, { error: 'You hold 2.5 Beans: you can pay the Commons only what you hold.' }],
            '/api/cents': [400, { error: 'You hold 12.50 Beans: you can pay the Commons only what you hold.' }],
            '/api/odd-value': [400, { error: 'Only Ann (a.k.a. [x]+?) can remove this' }],
            '/api/no-fit': [400, { error: 'A post can have at most photos' }],
            '/api/coded-sentence': [403, { error: 'UNAUTHORIZED: Only a convenor can do that' }],
            '/api/floor': [400, { error: 'FLOOR_LOCKED:1:2:200:500: Post another Offer to spend deeper.' }],
            '/api/coded-unknown': [403, { error: 'UNAUTHORIZED: A sentence no catalog has' }],
            '/api/two': [400, { error: 'FLOOR_LOCKED:2:3:500:1000: Your 2 active Offers unlock a −500 credit line. Post another Offer to spend deeper.' }],
            '/api/two-half-known': [400, { error: 'Your 2 active Offers unlock a −500 credit line. A sentence no catalog has.' }],
        };
        const [status, body] = answers[ctx.path] ?? [404, { error: 'Not found' }];
        ctx.status = status;
        ctx.body = body;
    });
    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const get = async (p: string, lang?: string): Promise<Got> => {
        const res = await fetch(`${base}${p}`, { headers: lang === undefined ? {} : { 'X-Language': lang } });
        const text = await res.text();
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, text, body, vary: res.headers.get('vary') };
    };
    try {
        useCatalogsForTests('fr', { server: FR, core: FR_CORE });

        const fr = await get('/api/refused', 'fr');
        assert(fr.status === 403 && fr.body?.error === FR[POLL_CLOSED], `a refusal's error comes in French with X-Language: fr (${fr.status} ${fr.text})`);
        assert(fr.body?.code === 'poll_closed' && fr.body?.postId === 'p-1' && Object.keys(fr.body).length === 3, 'its status, code and other fields are as the route made them');
        assert(/x-language/i.test(fr.vary ?? ''), `and the answer says it varies by X-Language (Vary: ${fr.vary})`);
        const none = await get('/api/refused');
        assert(none.status === 403 && none.text === JSON.stringify(SHARED) && !/x-language/i.test(none.vary ?? ''),
            `no header: the answer byte for byte as the route made it, and no Vary (${none.text}, Vary: ${none.vary})`);
        assert(SHARED.error === POLL_CLOSED, 'the body a route shares between answers is never changed');
        const en = await get('/api/refused', 'en');
        const unknownTag = await get('/api/refused', 'he');
        const pseudo = await get('/api/refused', 'xx');
        assert(en.text === JSON.stringify(SHARED) && unknownTag.text === JSON.stringify(SHARED) && pseudo.text === JSON.stringify(SHARED),
            'X-Language: en, a tag BeanPool does not write (he) and the pseudo-locale: the English as it was');
        assert(/x-language/i.test(en.vary ?? '') && /x-language/i.test(unknownTag.vary ?? ''), 'and those vary by the header too');
        const regional = await get('/api/refused', 'fr-CA');
        assert(regional.body?.error === FR[POLL_CLOSED], "a device's regional tag (fr-CA) is its language");

        // A language's words are built once, not for each refusal: a catalog changed in place after the first refusal is
        // not seen by the next one; given again (as a new file read would be), it is.
        const live: Record<string, unknown> = { ...FR };
        useCatalogsForTests('fr', { server: live, core: FR_CORE });
        const before = await get('/api/refused', 'fr');
        live[POLL_CLOSED] = 'Ce sondage est fermé';
        const cached = await get('/api/refused', 'fr');
        assert(before.body?.error === FR[POLL_CLOSED] && cached.body?.error === FR[POLL_CLOSED] && wordsIn('fr') === wordsIn('fr'),
            `the words of a language are built once and kept (${cached.body?.error})`);
        useCatalogsForTests('fr', { server: live, core: FR_CORE });
        const rebuilt = await get('/api/refused', 'fr');
        assert(rebuilt.body?.error === 'Ce sondage est fermé', `and built again when its catalogs are read again (${rebuilt.body?.error})`);
        useCatalogsForTests('fr', { server: FR, core: FR_CORE });

        const coded = await get('/api/coded', 'fr');
        assert(coded.status === 404 && coded.body?.error === 'not_found' && coded.body?.message === FR[POLL_CLOSED],
            `a code in error stays as it is, the message beside it comes in French (${coded.text})`);
        const fault = await get('/api/fault', 'fr');
        assert(fault.status === 500 && fault.body?.error === FR[SERVER_FAULT_TEXT],
            `a server fault: scrubbed to its fixed words, answered 500, and those in French (${fault.status} ${fault.text})`);
        const faultEn = await get('/api/fault');
        assert(faultEn.status === 500 && faultEn.body?.error === SERVER_FAULT_TEXT, 'and in English without the header, as before');

        const ok = await get('/api/ok', 'fr');
        assert(ok.status === 200 && ok.body?.message === POLL_CLOSED && !/x-language/i.test(ok.vary ?? ''), 'a 2xx answer is never changed');
        const unknown = await get('/api/unknown', 'fr');
        assert(unknown.body?.error === 'A sentence no catalog has', 'a sentence the catalog lacks stays English');
        const coreOnly = await get('/api/core-only', 'fr');
        assert(coreOnly.body?.error === 'Only a sentence of core', "a sentence only core's catalog has is not the server's: it stays English on the way out");
        const local = await get('/api/local/admin/refused', 'fr');
        const admin = await get('/api/admin/refused', 'fr');
        assert(local.body?.error === POLL_CLOSED && admin.body?.error === POLL_CLOSED && !/x-language/i.test(local.vary ?? ''),
            "the operator's routes stay English (/api/local/…, /api/admin/…)");
        const plain = await get('/api/text', 'fr');
        assert(plain.status === 400 && plain.text === POLL_CLOSED, 'a body that is not a JSON object is left alone');

        // A sentence with values in it: found by the catalog's sentence it fits, its values written into the translation.
        const valued = await get('/api/valued', 'fr');
        assert(valued.status === 400 && valued.body?.error === 'Une annonce peut avoir au plus 6 photos', `a sentence with a value in it comes in French (${valued.text})`);
        const one = await get('/api/count-one', 'fr');
        const many = await get('/api/count-many', 'fr');
        assert(one.body?.error === 'Vous avez 1 échange en cours.' && many.body?.error === 'Vous avez 3 échanges en cours.',
            `a sentence with a count, singular and plural, in French's own forms (${one.body?.error} / ${many.body?.error})`);
        const decimal = await get('/api/decimal', 'fr');
        assert(decimal.body?.error === 'Vous avez 2,5 Beans : vous ne pouvez payer aux Communs que ce que vous avez.',
            `a number read back out of the English is written the language's way (${decimal.body?.error})`);
        const cents = await get('/api/cents', 'fr');
        assert(cents.body?.error === 'Vous avez 12,50 Beans : vous ne pouvez payer aux Communs que ce que vous avez.',
            `with the decimals it was written with (${cents.body?.error})`);
        const odd = await get('/api/odd-value', 'fr');
        assert(odd.body?.error === 'Seul Ann (a.k.a. [x]+?) peut retirer ceci', `a value with a pattern's own characters in it is kept as it was (${odd.body?.error})`);
        const noFit = await get('/api/no-fit', 'fr');
        assert(noFit.body?.error === 'A post can have at most photos', 'a sentence that fits no sentence of the catalog stays English');
        const codeFirst = await get('/api/coded-sentence', 'fr');
        const floor = await get('/api/floor', 'fr');
        const codedUnknown = await get('/api/coded-unknown', 'fr');
        assert(codeFirst.status === 403 && codeFirst.body?.error === 'UNAUTHORIZED: Seul un animateur peut faire cela'
            && floor.body?.error === 'FLOOR_LOCKED:1:2:200:500: Publiez une autre Offre pour aller plus loin.',
            `a code the apps read before the sentence stays as it came, the sentence after it in French (${codeFirst.body?.error} / ${floor.body?.error})`);
        assert(codedUnknown.body?.error === 'UNAUTHORIZED: A sentence no catalog has', 'and with a sentence the catalog lacks, all of it stays English');
        const two = await get('/api/two', 'fr');
        const halfKnown = await get('/api/two-half-known', 'fr');
        assert(two.body?.error === 'FLOOR_LOCKED:2:3:500:1000: Vos 2 Offres actives ouvrent un crédit de −500. Publiez une autre Offre pour aller plus loin.',
            `two sentences each written on its own come in French, each with its own values (${two.body?.error})`);
        assert(halfKnown.body?.error === 'Your 2 active Offers unlock a −500 credit line. A sentence no catalog has.',
            'and when one of them is not the catalog\'s, the whole stays English, never half translated');
        const valuedEn = await get('/api/valued');
        const floorEn = await get('/api/floor');
        assert(valuedEn.text === JSON.stringify({ error: 'A post can have at most 6 photos' })
            && floorEn.text === JSON.stringify({ error: 'FLOOR_LOCKED:1:2:200:500: Post another Offer to spend deeper.' }),
            'without the header, those are the English byte for byte');

        // The loader reads the real files: core's French catalog is drafted, so a sentence of core's comes in French.
        useCatalogsForTests('fr', null);
        const realFr = wordsIn('fr');
        const justNow = realFr.timeAgo(1000);
        assert(justNow !== 'just now' && justNow.length > 0, `the real catalogs are read: core's "just now" in French is "${justNow}"`);
        assert(wordsIn(null).timeAgo(1000) === 'just now' && wordsIn('en').timeAgo(1000) === 'just now', 'no language, or en: English');
    } finally {
        useCatalogsForTests('fr', null);
        await new Promise<void>(r => server.close(() => r()));
    }
}

// ── 3 and 4: a real server ──────────────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
const tokenOf = (name: string) => `ExponentPushToken[${name}-${crypto.randomBytes(12).toString('base64url')}]`;

let BASE = '';
interface Res { status: number; text: string; body: any }
async function call(method: 'GET' | 'POST', id: Id | null, route: string, body?: unknown, lang?: string): Promise<Res> {
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (lang !== undefined) headers['X-Language'] = lang;
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body: parsed };
}

async function testRealServer(): Promise<void> {
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { startP2P } = await import('./p2p.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { exportPlainTables } = await import('@beanpool/engine');
    const { PLAIN_TABLES } = await import('./engine/replication-manifest.js');
    initAdminPassword();
    await initTls();
    se.initStateEngine();
    await startP2P(0, 0);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // Pushes, caught where they leave for Expo; nothing here reaches any host but this machine.
    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        const host = new URL(url).hostname;
        if (host === 'exp.host') {
            const batch = JSON.parse(init?.body ?? '[]');
            sent.push(...batch);
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (host === 'localhost' || host === '127.0.0.1') return realFetch(input, init);
        throw new Error(`the test refused to contact ${host}`);
    };

    const owner = newId('OwnerOlive');
    se.seedGenesisMember(owner.pk, 'OwnerOlive');
    const member = (name: string): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, ?, ?, 'TEST', 'active')`).run(id.pk, name, new Date(Date.now() - 60 * DAY).toISOString(), owner.pk);
        setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const ann = member('Ann'), bob = member('Bob'), cat = member('Cat');

    try {
        console.log('\n--- 3. A real server ---');
        useCatalogsForTests('fr', { server: FR, core: FR_CORE });
        useCatalogsForTests('ru', { core: RU_CORE });

        const route = `/api/messages/conversations/${bob.pk}`;
        const frRefusal = await call('GET', ann, route, undefined, 'fr');
        const enRefusal = await call('GET', ann, route);
        const enNamed = await call('GET', ann, route, undefined, 'en');
        assert(frRefusal.status === 403 && frRefusal.body?.error === FR['You may only read your own conversations'],
            `a route's refusal comes in French with X-Language: fr (${frRefusal.status} ${frRefusal.text})`);
        assert(enRefusal.status === 403 && enRefusal.text === JSON.stringify({ error: 'You may only read your own conversations' }),
            `without the header it is the English, byte for byte (${enRefusal.text})`);
        assert(enNamed.status === 403 && enNamed.text === enRefusal.text, 'and X-Language: en reads the same');

        const group = se.createGroup({ name: 'Seed Library', joinPolicy: 'request_to_join', createdBy: owner.pk });
        const first = await call('POST', cat, `/api/groups/${group.id}/join`, {}, 'fr');
        const again = await call('POST', cat, `/api/groups/${group.id}/join`, {}, 'fr');
        const againEn = await call('POST', cat, `/api/groups/${group.id}/join`, {});
        assert(first.status === 200, `a member asks to join a group that takes requests (${first.status} ${first.text})`);
        assert(again.status === 400 && again.body?.error === FR['Membership request already pending'],
            `asking again: the engine's refusal, through the route's catch, comes in French (${again.status} ${again.text})`);
        assert(againEn.status === 400 && againEn.body?.error === 'Membership request already pending',
            `and in English without the header, with the same status the route chose from the English (${againEn.status})`);

        console.log('\n--- 4. Pushes in each phone\'s language ---');
        const phone = { ann: tokenOf('ann'), bob: tokenOf('bob'), cat: tokenOf('cat') };
        const register = (who: Id, token: string, lang?: unknown) =>
            call('POST', who, '/api/push-tokens', { publicKey: who.pk, token, platform: 'android', ...(lang === undefined ? {} : { lang }) });
        const langOf = (who: Id) => (db.prepare('SELECT lang FROM push_tokens WHERE public_key = ?').get(who.pk) as { lang: string | null } | undefined)?.lang;
        const regs = [await register(ann, phone.ann, 'fr'), await register(bob, phone.bob), await register(cat, phone.cat, 'he')];
        assert(regs.every(r => r.status === 200 && r.body?.success === true), `three phones register (${regs.map(r => r.status).join(', ')})`);
        assert(langOf(ann) === 'fr' && langOf(bob) === null && langOf(cat) === null,
            `the row keeps fr; no lang and a tag BeanPool doesn't write (he) are English, NULL (${langOf(ann)}, ${langOf(bob)}, ${langOf(cat)})`);
        const bad = await register(bob, phone.bob, { lang: 'fr' });
        assert(bad.status === 200 && langOf(bob) === null, 'a lang that is not text never refuses the phone, and is no language');

        sent.length = 0;
        se.dispatchPushNotification([ann.pk, bob.pk, cat.pk], 'SYSTEM', 'From Dee', 'Dee wrote to you', { screen: 'chat' }, 'chat', 'chat.message');
        await flush();
        const to = (token: string) => sent.find(m => m.to === token);
        const english = PUSH_NOTICE_KINDS['chat.message'].body;
        assert(sent.length === 3, `one message for each phone (${sent.length})`);
        assert(to(phone.ann)?.title === PUSH_NOTICE_TITLE && to(phone.ann)?.body === FR_CORE['You have a new message.'],
            `the French phone's lock screen: "BeanPool" and the kind's sentence in French (${to(phone.ann)?.title} / ${to(phone.ann)?.body})`);
        assert(to(phone.bob)?.body === english && to(phone.cat)?.body === english && to(phone.bob)?.title === PUSH_NOTICE_TITLE,
            'the others in English, as before');
        const shape = (m: any) => JSON.stringify(Object.keys(m?.data ?? {}).sort());
        assert(shape(to(phone.ann)) === shape(to(phone.bob)) && to(phone.ann)?.data?.k === 'chat.message',
            'the notice data is the same shape in every language: only the words differ');

        const moved = await register(ann, phone.ann, 'ru');
        sent.length = 0;
        se.dispatchPushNotification([ann.pk], 'SYSTEM', 'From Dee', 'Dee wrote to you', { screen: 'chat' }, 'chat', 'chat.message');
        await flush();
        assert(moved.status === 200 && langOf(ann) === 'ru' && sent[0]?.body === RU_CORE['You have a new message.'],
            `the phone registers again in Russian: the row follows it, and so does the next push (${langOf(ann)}: ${sent[0]?.body})`);
        await register(ann, phone.ann);
        assert(langOf(ann) === null, 'and an app that names no language, English again');

        await register(ann, phone.ann, 'fr');
        const copy = exportPlainTables(db as any, PLAIN_TABLES).push_tokens ?? [];
        assert(copy.length >= 1 && copy.every((row: Record<string, unknown>) => !('lang' in row)) && copy.some((row: any) => row.public_key === ann.pk),
            `the standby's copy of the phones never carries their language (${copy.length} rows)`);

        await testFamilies({ owner, ann, bob, cat, se, db });
    } finally {
        useCatalogsForTests('fr', null);
        useCatalogsForTests('ru', null);
        (globalThis as any).fetch = realFetch;
    }
}

// ── 6: each family ────────────────────────────────────────────────────────────────────────────────────────────────
/** What the suite's French says for every sentence the server and the engine mark: the English after a sign of its own. */
const FR_SIGN = 'FR› ';
let markedSentences: any[] | null = null;
async function marks(): Promise<any[]> {
    if (!markedSentences) {
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
        const words: any = await import(path.join(root, 'scripts/words/words.mjs'));
        const extracted = words.extractRepo(root, words.PACKAGES.filter((p: any) => p.name === 'server' || p.name === 'engine'));
        markedSentences = extracted.flatMap((p: any) => p.calls.filter((c: any) => typeof c.text === 'string'));
    }
    return markedSentences!;
}
async function everyMarkInFrench(): Promise<Record<string, unknown>> {
    return Object.fromEntries((await marks()).map((c: any) => (typeof c.other === 'string'
        ? [pluralKey(c.text, c.other), { one: `${FR_SIGN}${c.text}`, other: `${FR_SIGN}${c.other}` }]
        : [wordKey(c.text, c.context), `${FR_SIGN}${c.text}`])));
}

interface People { owner: Id; ann: Id; bob: Id; cat: Id; se: any; db: any }

/**
 * One refusal of each family a member meets, asked without X-Language and with `fr`: the English as it was, and in French
 * the same status, the same code and every other field, only the sentence in French. The suite's French is every marked
 * sentence after FR_SIGN, so a family whose sentence was never marked fails here.
 */
async function testFamilies({ owner, ann, bob, se }: People): Promise<void> {
    console.log("\n--- 6. Each family's refusals in the member's language ---");
    useCatalogsForTests('fr', { server: await everyMarkInFrench(), core: FR_CORE });
    const family = async (name: string, english: string, method: 'GET' | 'POST', who: Id | null, route: string, body?: unknown,
        field: 'error' | 'message' = 'error'): Promise<void> => {
        const en = await call(method, who, route, body);
        const fr = await call(method, who, route, body, 'fr');
        const same = (a: any, b: any) => JSON.stringify(Object.keys(a ?? {}).sort()) === JSON.stringify(Object.keys(b ?? {}).sort())
            && Object.keys(a ?? {}).every(k => k === field || JSON.stringify(a[k]) === JSON.stringify(b[k]));
        assert(en.status >= 400 && en.body?.[field] === english, `${name}: in English as before (${en.status} ${en.text})`);
        assert(fr.status === en.status && fr.body?.[field] === `${FR_SIGN}${english}` && same(en.body, fr.body),
            `${name}: in French, with the same status, code and fields (${fr.status} ${fr.text})`);
    };

    // The gate (https-server.ts).
    await family('the gate, a community\'s listings to a visitor', "This community's listings are for its members. Join with an invite from a member, or look around the global community at global.beanpool.org.",
        'GET', null, '/api/marketplace/posts');
    await family('the gate, a members-only read to a visitor', "This is for this community's members. Join with an invite from a member, or look around the global community at global.beanpool.org.",
        'GET', null, '/api/home');
    const stranger = newId('Stranger');
    await family('the gate, a gated read to a key that is no member', 'Read access requires a member identity', 'GET', stranger, `/api/ledger/balance/${stranger.pk}`);

    // Join, profile, ledger (routes/community.ts).
    await family('community, invites', 'You may only read your own invites', 'GET', ann, `/api/invite/mine/${bob.pk}`);
    await family('community, profile', 'Your name needs at least 2 characters.', 'POST', ann, '/api/profile/update', { callsign: 'A' }, 'message');
    await family('community, preferences', 'You may only read your own preferences', 'GET', ann, `/api/members/preferences?publicKey=${owner.pk}`);

    // The engine's refusals through a route (state-engine.ts): a sentence, and one with a value in it.
    await family('trust, vouching', 'You cannot vouch for yourself', 'POST', ann, '/api/profile/vouch', { targetPubkey: ann.pk });
    await family('the Commons, a payment', 'You hold 0 Beans: you can pay the Commons only what you hold.', 'POST', ann, '/api/commons/pay', { amount: 5 });

    // Enterprises, the community's Decisions and a group's votes (routes/treasury.ts, decisions-engine.ts).
    await family('enterprises, a read of what is none', 'Not a treasury', 'GET', ann, `/api/enterprise/${bob.pk}`);
    await family("the community's Decisions, standing to propose", 'Proposing a Decision requires earned trade standing (earnedCredit > 0)',
        'POST', ann, '/api/commons/decisions', { title: 'Seeds', touches: 'pool', effect: 'grant', description: 'Seeds for the garden beds', subject: ann.pk, params: { amount: 5 } });
    const tools = se.createGroup({ name: 'Tool Library', joinPolicy: 'open', createdBy: ann.pk });
    // The names list, creator channels and the open join door (routes/names-list.ts, engine/creator-channels.ts, routes/open-join.ts).
    await family('the names list, to a member who is no admin', 'Only the community’s owners and admins can open the names list.', 'GET', ann, '/api/names/state');
    await family('creator channels, a link of another site (a sentence for each article)', 'That is not an Instagram link.',
        'POST', ann, '/api/member/channels', { platform: 'instagram', url: 'https://example.com/ann', category: 'other' }, 'message');
    await family('joining, a community that takes invites only', 'This community is invite-only.', 'POST', stranger, '/api/join', { callsign: 'Stranger' });
    await family('groups, a vote with nobody to vote with', 'Nobody else in this group can vote, so there is nobody to vote with.',
        'POST', ann, `/api/groups/${tools.id}/decisions`, { effect: 'close_group', title: 'Close it', description: 'We have finished with the library' });
}

// ── 5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * What the apps match a node's words on (each found where it is written), so a sentence holding one stays English until
 * its branch reads a code: translated, the app's branch would stop matching.
 */
/**
 * A sentence that holds an app's match but never reaches the place that matches: what the match reads is named, and the
 * sentence comes from elsewhere. The offline check on the People, profile, shop and enterprise screens reads those
 * screens' own loads ('Network request failed'), never a join door's answer, which says "your network".
 */
const NEVER_WHERE_MATCHED: { sentence: RegExp; matcher: RegExp; why: string }[] = [
    { sentence: /^(?:Lots of people|Too many new accounts) have joined from your network/, matcher: /off-grid\|network/,
        why: "a join door's refusal: the offline check reads the People, profile, shop and enterprise screens' own loads" },
];
const neverWhereMatched = (text: string, matcher: string) => NEVER_WHERE_MATCHED.some(n => n.sentence.test(text) && n.matcher.test(matcher));

const APP_MATCHES: { phrase: RegExp; where: string }[] = [
    { phrase: /off-grid|network|fetch failed|failed to fetch|offline|timeout|abort/i, where: 'apps/native/app/(tabs)/people.tsx, public-profile.tsx (offline)' },
    { phrase: /not found|not authorized|not active/i, where: 'apps/native/app/post/[id].tsx (a deal changed elsewhere)' },
    { phrase: /already been used|already used|already a member|already been redeemed/i, where: 'apps/native/app/welcome.tsx, utils/invite-next.ts, apps/pwa WelcomePage.tsx (invites)' },
    { phrase: /set a profile photo/i, where: 'apps/native/utils/db.ts (the profile heal)' },
    { phrase: /relationship not found/i, where: 'apps/native/utils/db.ts' },
    { phrase: /^Request failed/, where: 'apps/native/utils/known-consent.ts' },
    { phrase: /NAT-4/, where: 'apps/native/utils/node-request-signing.ts' },
    { phrase: /nonce already used/i, where: 'apps/native/utils/rekey-redeem.ts, apps/pwa lib/web-rekey.ts' },
    { phrase: /owners are asked|owners can read|no owner|no recovery|not locked/i, where: 'apps/pwa lib/owner-words.ts, lib/takeover-unlock.ts' },
    { phrase: /^Quorum not met/, where: 'packages/beanpool-core/src/scoped-decision.ts' },
    { phrase: /^Epoch record refused|commits to|^Top-up refused|^An unsigned wrap/, where: 'apps/native utils/group-chat-keys.ts, apps/pwa lib/group-chat-keys.ts' },
    { phrase: /try again in |^Too many attempts|Your key stays/i, where: 'apps/pwa lib/web-join.ts, components/key-lines.ts' },
];

/**
 * Every place the apps (and core, which they run) test a node's words, read from their sources: a literal looked for in
 * an error or a message (`e.message.includes('not found')`, `why.startsWith('Top-up refused')`, `msg === '…'`) and a
 * regex with a word in it tested on one (`/set a profile photo/i.test(msg)`, `reason.match(/^Quorum not met/)`). What
 * counts as an error or a message is its name (ERRORISH), so a match on something else (a search term, a URL) is not
 * one; the few on an error that never holds a node's words are in NEVER_A_NODES_WORDS.
 */
const APP_SOURCE_DIRS = ['apps/native/app', 'apps/native/components', 'apps/native/utils', 'apps/native/services', 'apps/native/constants',
    'apps/native/tools', 'apps/pwa/src', 'packages/beanpool-core/src'];
const ERRORISH = /message|msg|err|why|reason|text|detail|sentence|said|body|str\b|^e$|^String\(e\)$/i;
const NEVER_A_NODES_WORDS: { file: string; looksFor: string; why: string }[] = [
    { file: 'apps/native/app/(tabs)/market.tsx', looksFor: 'closed', why: "the phone's own database closing under a wipe or a restore (one more try)" },
    { file: 'apps/native/utils/db.ts', looksFor: 'closed', why: "the phone's own database closing under a wipe or a restore (one more try)" },
    { file: 'apps/native/utils/pulse-oauth.ts', looksFor: 'cancel', why: "a sign-in provider's own error in its redirect" },
];

interface AppMatcher { at: string; file: string; looksFor: string; shown: string; test: (s: string) => boolean }

function appMatchers(root: string, words: any): AppMatcher[] {
    const found: AppMatcher[] = [];
    for (const file of words.sourceFiles(root, APP_SOURCE_DIRS) as string[]) {
        const sf = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true,
            file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
        const lit = (n: ts.Node | undefined) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
        const add = (n: ts.Node, looksFor: string, shown: string, test: (s: string) => boolean) => found.push({ at: at(n), file, looksFor, shown, test });
        /** What a regex literal is tested on: `x` in /re/.test(x), x.match(/re/), x.replace(/re/, …). */
        const testedOn = (n: ts.Node): ts.Node | undefined => {
            const up = n.parent;
            if (ts.isPropertyAccessExpression(up) && up.expression === n && ['test', 'exec'].includes(up.name.text) && ts.isCallExpression(up.parent)) {
                return up.parent.arguments[0];
            }
            if (ts.isCallExpression(up) && up.arguments[0] === n && ts.isPropertyAccessExpression(up.expression)
                && ['match', 'matchAll', 'search', 'replace', 'split'].includes(up.expression.name.text)) return up.expression.expression;
            return undefined;
        };
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const how = node.expression.name.text;
                const looksFor = lit(node.arguments[0]);
                if (looksFor !== null && ['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf'].includes(how)
                    && ERRORISH.test(node.expression.expression.getText(sf))) {
                    add(node, looksFor, `${node.expression.getText(sf)}(${JSON.stringify(looksFor)})`,
                        how === 'startsWith' ? s => s.startsWith(looksFor) : how === 'endsWith' ? s => s.endsWith(looksFor) : s => s.includes(looksFor));
                }
            }
            if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)) {
                const looksFor = lit(node.left) ?? lit(node.right);
                const other = lit(node.left) !== null ? node.right : node.left;
                if (looksFor !== null && /\s/.test(looksFor) && ERRORISH.test(other.getText(sf))) add(node, looksFor, node.getText(sf), s => s === looksFor);
            }
            if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
                const on = testedOn(node);
                const text = node.getText(sf);
                const source = text.slice(1, text.lastIndexOf('/'));
                // A word of three letters or more outside an escape or a character class: /set a profile photo/i, not /^\s+$/.
                const hasWord = /[A-Za-z]{3,}/.test(source.replace(/\\u[0-9a-fA-F]{4}|\\./g, ' ').replace(/\[[^\]]*\]/g, ' '));
                if (on && ERRORISH.test(on.getText(sf)) && hasWord) {
                    const re = new RegExp(source, text.slice(text.lastIndexOf('/') + 1).replace(/[gy]/g, ''));
                    add(node, source, text, s => re.test(s));
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    return found;
}

async function testNothingMatchedIsMarked(): Promise<void> {
    console.log('\n--- 5. Nothing an app matches on is marked for translation ---');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const words: any = await import(path.join(root, 'scripts/words/words.mjs'));
    const extracted = words.extractRepo(root, words.PACKAGES.filter((p: any) => p.name === 'server' || p.name === 'engine'));
    // A sentence of the server's catalog: marked with word() or wordn(), or written with English's own t() / tn() (one with
    // values in it); a count's both forms.
    const marked = extracted.flatMap((p: any) => p.calls.filter((c: any) => typeof c.text === 'string')
        .flatMap((c: any) => (typeof c.other === 'string' ? [c, { ...c, text: c.other }] : [c])));
    const matched = marked.flatMap((c: any) => APP_MATCHES.filter(m => m.phrase.test(c.text) && !neverWhereMatched(c.text, m.phrase.source))
        .map(m => `${c.at} "${c.text}" (${m.where})`));
    const prefixed = marked.filter((c: any) => /^[A-Z_]{3,}:/.test(c.text)).map((c: any) => `${c.at} "${c.text}"`);
    assert(marked.length >= 100, `the server and the engine mark their members' refusals (${marked.length} marks)`);
    assert(matched.length === 0, `no marked sentence is one an app matches on${matched.length ? `: ${matched.join('; ')}` : ''}`);
    assert(prefixed.length === 0, `no marked sentence starts with a code the apps read (UNAUTHORIZED: …)${prefixed.length ? `: ${prefixed.join('; ')}` : ''}`);

    // The apps' sources as they are now: every match on an error or a message, against every marked sentence (a value
    // in it written as a word, as the member would read it).
    const matchers = appMatchers(root, words);
    const known = (m: AppMatcher) => NEVER_A_NODES_WORDS.some(n => n.file === m.file && n.looksFor === m.looksFor);
    const listed = ['set a profile photo', 'nonce already used', '^Quorum not met', 'already a member', 'not found'];
    assert(listed.every(l => matchers.some(m => m.looksFor === l)) && matchers.length >= 40,
        `the apps' matches are found where they are written (${matchers.length}, the hand-kept list's among them)`);
    const filled = (s: string) => s.replace(/\{[A-Za-z0-9_]+\}/g, 'Ann');
    const caught = marked.flatMap((c: any) => matchers.filter(m => !known(m) && m.test(filled(c.text)) && !neverWhereMatched(c.text, m.looksFor))
        .map(m => `${c.at} "${c.text}" (${m.at} ${m.shown})`));
    assert(caught.length === 0, `no marked sentence is one an app's source matches on${caught.length ? `: ${caught.join('; ')}` : ''}`);
    assert(NEVER_A_NODES_WORDS.every(n => matchers.some(m => m.file === n.file && m.looksFor === n.looksFor)),
        "each match set aside as never a node's words is still in its file (else it comes off the list)");
    // The push sentences are core's keys, so the drafting lane finds them where the apps' own are.
    const core = words.extractRepo(root, words.PACKAGES.filter((p: any) => p.name === 'core'))[0];
    const coreKeys = new Set(core.calls.filter((c: any) => c.fn === 'word').map((c: any) => wordKey(c.text)));
    const missing = Object.values(PUSH_NOTICE_KINDS).map(k => k.body as string).filter(b => !coreKeys.has(b));
    assert(missing.length === 0, `every push sentence is a word of core's (${Object.keys(PUSH_NOTICE_KINDS).length} kinds)${missing.length ? `; not: ${missing.join(', ')}` : ''}`);
}

async function main() {
    console.log("The server's words in the member's language...");
    testRequestLanguage();
    await testWayOut();
    await testRealServer();
    await testNothingMatchedIsMarked();
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
