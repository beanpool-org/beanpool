/**
 * Learn's tags, the node (Marty, 16 Nov 2026, board learn-tags: "Yes: tags on Learn pages on both apps, then the assistant";
 * the measurement is draft PR #3211): a page of Local knowledge carries its own FREE tags, under the Market's rule for the
 * tags a member types (DESIGN-tags-free-entry-fable.md, @beanpool/core tags/free-tags.ts), through the real HTTPS stack and
 * its signature middleware.
 *
 *  1. Close the class: every path that writes a page or a draft (publish, suggest then approve, approve with "Edit first",
 *     an assistant's draft then approve, an owner's edit, a fix of only the tags, a fix of the tags and the body) x every kind
 *     of tags (none sent, [], tags, each free-entry limit, not a list, the library's ids) -> the stored tags, Learn's search
 *     finds the page by each tag in another case and by none it doesn't carry, and nothing else on the page changed; a refusal
 *     is a 400 `bad_tags` in the rule's words and writes nothing.
 *  2. Every rewrite keeps the tags' words in search: an owner's edit that sends no tags (the apps before Learn's tags) keeps
 *     them; [] takes them off and search no longer finds the page by them; an approved fix of the body keeps them.
 *  3. To check: a fix of only the tags is a fix (`freeTagsChanged`, no word part changed), shows the tags as Now and
 *     Suggested; approving writes the tags and nothing else. Tags the page changed under since: refused, 409 `page_changed`,
 *     until "Edit first" sends them.
 *  4. Search as the Market's: for each word, Learn finds the page exactly when the Market finds a listing with the same tag.
 *  5. A page's tags are never offered on the Market's Tags field (a page is no listing).
 *  6. A standby's copy carries a suggestion's tags.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-knowledge-tags" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { FREE_TAG_HIDDEN_CHARACTER, FREE_TAG_HOLDS_A_COMMA, FREE_TAG_NOT_A_CONTACT, FREE_TAG_TOO_LONG, FREE_TAG_TOO_MANY_WORDS, FREE_TAG_TOO_SHORT,
    FREE_TAGS_TOO_LONG_TOGETHER, FREE_TAGS_TOO_MANY } from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast, exportSyncState } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { registerMemberInternal } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { publishKnowledge, KnowledgeRefusal } from './engine/knowledge.js';
import { fileAssistantKnowledgeDraft } from './engine/knowledge-drafts.js';
import { FREE_TAGS_NOT_A_LIST } from './engine/post-fields.js';
import { forgetFreeTagCounts, offeredFreeTags } from './engine/free-tags.js';
import { TEST_PHOTO } from './post-test-helper.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }
async function call(id: Id | null, method: 'GET' | 'POST', urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const h: Record<string, string> = { ...headers };
    if (method !== 'GET') h['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        h[SIGNED_FOR_HEADER] = signedForHost();
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers: h, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 220)}` : '-');

// No tag word is in the page's title, body or place, so a search that finds the page by one found it by the tag.
const PAGE = {
    title: 'How recycling works at the tip',
    body: 'Bring paper and cans sorted.\nGreen waste is free on the first Saturday.',
    topic: 'local-services',
    place: 'The tip on Manse Road',
    sources: [{ url: 'https://council.example/waste', label: 'Council waste page' }],
    lang: 'en',
};
const FIX_BODY = 'Bring paper and cans sorted.\nThe tip is closed on Mondays since March.';
const rowOf = (id: string) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
const draftRow = (id: string) => db.prepare('SELECT * FROM knowledge_drafts WHERE id = ?').get(id) as any;
const tagsOf = (stored: unknown): string[] => (typeof stored === 'string' && stored ? JSON.parse(stored) : []);
const pageCount = () => (db.prepare("SELECT COUNT(*) AS n FROM posts WHERE type = 'knowledge'").get() as { n: number }).n;
const draftCount = () => (db.prepare('SELECT COUNT(*) AS n FROM knowledge_drafts').get() as { n: number }).n;
/** The page's fields other than its tags and stamps: what "nothing else changed" compares. */
const wordsOf = (id: string) => {
    const r = rowOf(id);
    return JSON.stringify([r.title, r.description, r.category, r.knowledge_place, r.knowledge_sources, r.knowledge_lang, r.author_pubkey, r.tags]);
};

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const owen = newId('Owen');
    const claim = claimGrantor(crypto.randomBytes(4).toString('hex'));
    require_(!!registerMemberInternal(broadcast, owen.pk, owen.name, null, claim), 'Owen claims the community: its first member');
    grantNodeRole(owen.pk, 'owner', claim);
    const OWNER = () => ownerPhoneSessionHeaders(owen.pk);
    const people = ['Ada', 'Mel', 'Pat', 'Wes', 'Kim', 'Lou', 'Sam', 'Ty', 'Uma', 'Vi', 'Xu', 'Yan', 'Zed', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal']
        .map(newId);
    for (const who of people) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    const [ada] = people;
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: ada.pk, role: 'admin' }, OWNER())).status === 200, 'Ada is made admin');
    for (const who of [owen, ...people]) db.prepare("UPDATE members SET avatar_ref = 'bundled://fox' WHERE public_key = ?").run(who.pk);
    // Each member suggests within their own 3 waiting and 5 a day: the table takes the next member when one is full.
    const members = people.slice(1);
    let turn = 0;
    const nextMember = () => members[(turn++) % members.length];
    const clearDrafts = () => db.prepare('DELETE FROM knowledge_drafts').run();

    const search = async (q: string): Promise<string[]> => {
        const r = await call(owen, 'GET', `/api/knowledge/front?q=${encodeURIComponent(q)}`);
        return Array.isArray(r.body?.rows) ? r.body.rows.map((x: any) => x.id as string) : [];
    };

    // ── 1. Close the class ────────────────────────────────────────────────────────────────────
    console.log('── 1. every path that writes a page or a draft x every kind of tags ──');
    const LONG_TOGETHER = Array.from({ length: 5 }, (_, i) => `t${i}${'🍎'.repeat(28)}`);
    type Input = { label: string; send: Record<string, unknown>; stored?: string[]; refusal?: string };
    const INPUTS: Input[] = [
        { label: 'no tags sent', send: {}, stored: [] },
        { label: '[]', send: { freeTags: [] }, stored: [] },
        { label: 'null', send: { freeTags: null }, stored: [] },
        { label: 'three tags', send: { freeTags: ['Kerbside', '#Bottle  Bank', 'LIMÓN', 'kerbside'] }, stored: ['kerbside', 'bottle bank', 'limón'] },
        { label: 'too short', send: { freeTags: ['a'] }, refusal: FREE_TAG_TOO_SHORT },
        { label: 'too long', send: { freeTags: ['x'.repeat(31)] }, refusal: FREE_TAG_TOO_LONG },
        { label: 'five words', send: { freeTags: ['one two three four five'] }, refusal: FREE_TAG_TOO_MANY_WORDS },
        { label: 'a phone number', send: { freeTags: ['call 0412 345 678'] }, refusal: FREE_TAG_NOT_A_CONTACT },
        { label: 'a web address', send: { freeTags: ['tip.example.com'] }, refusal: FREE_TAG_NOT_A_CONTACT },
        { label: 'a hidden character', send: { freeTags: ['kerb​side'] }, refusal: FREE_TAG_HIDDEN_CHARACTER },
        { label: 'a comma', send: { freeTags: ['paper,cans'] }, refusal: FREE_TAG_HOLDS_A_COMMA },
        { label: 'six tags', send: { freeTags: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'] }, refusal: FREE_TAGS_TOO_MANY },
        { label: 'too long together', send: { freeTags: LONG_TOGETHER }, refusal: FREE_TAGS_TOO_LONG_TOGETHER },
        { label: 'not a list', send: { freeTags: 'kerbside' }, refusal: FREE_TAGS_NOT_A_LIST },
        { label: 'the library\'s ids', send: { tags: ['food.fruit'] }, refusal: 'Local knowledge takes its own tags only' },
    ];
    type Outcome = { status: number; code?: string; error?: string; page: string | null; draft: string | null };
    const asOutcome = (r: Res, page: string | null, draft: string | null): Outcome => ({ status: r.status, code: r.body?.code, error: r.body?.error, page, draft });
    const owenPage = (over: Record<string, unknown> = {}) => publishKnowledge(broadcast, owen.pk, { ...PAGE, ...over }).id;
    let grantN = 0;
    type Path = { label: string; fix?: 'tags' | 'tags+body'; write: (send: Record<string, unknown>) => Promise<Outcome> };
    const PATHS: Path[] = [
        {
            label: 'an owner publishes',
            write: async (send) => {
                const r = await call(owen, 'POST', '/api/knowledge/posts', { ...PAGE, ...send });
                return asOutcome(r, r.body?.post?.id ?? null, null);
            },
        },
        {
            label: 'a member suggests, an owner approves',
            write: async (send) => {
                const s = await call(nextMember(), 'POST', '/api/knowledge/drafts', { ...PAGE, ...send });
                if (s.status !== 201) return asOutcome(s, null, null);
                const a = await call(owen, 'POST', `/api/knowledge/drafts/${s.body.draft.id}/approve`, {});
                return asOutcome(a, a.body?.post?.id ?? null, s.body.draft.id);
            },
        },
        {
            label: 'a member suggests none, an admin approves with "Edit first" sending them',
            write: async (send) => {
                const s = await call(nextMember(), 'POST', '/api/knowledge/drafts', PAGE);
                require_(s.status === 201, `the suggestion goes in (${show(s)})`);
                const a = await call(ada, 'POST', `/api/knowledge/drafts/${s.body.draft.id}/approve`, send);
                return asOutcome(a, a.body?.post?.id ?? null, s.body.draft.id);
            },
        },
        {
            label: 'an assistant drafts, an owner approves',
            write: async (send) => {
                let id: string;
                try {
                    id = fileAssistantKnowledgeDraft({ id: `grant-${++grantN}`, member: owen.pk, name: 'Helper' }, { ...PAGE, about: 'service', ...send }).id;
                } catch (e) {
                    const k = e as KnowledgeRefusal;
                    return { status: k.status ?? 500, code: k.code, error: k.message, page: null, draft: null };
                }
                const a = await call(owen, 'POST', `/api/knowledge/drafts/${id}/approve`, { checkedSources: true });
                return asOutcome(a, a.body?.post?.id ?? null, id);
            },
        },
        {
            label: 'an owner edits a page',
            write: async (send) => {
                const P = owenPage();
                const r = await call(owen, 'POST', `/api/knowledge/posts/${P}/edit`, { ...PAGE, ...send });
                return asOutcome(r, P, null);
            },
        },
        {
            label: 'a member\'s fix of only the tags, approved',
            fix: 'tags',
            write: async (send) => {
                const P = owenPage();
                const s = await call(nextMember(), 'POST', '/api/knowledge/drafts', { fixOf: P, note: 'Tags to find it by', ...send });
                if (s.status !== 201) return asOutcome(s, P, null);
                const a = await call(owen, 'POST', `/api/knowledge/drafts/${s.body.draft.id}/approve`, {});
                return asOutcome(a, P, s.body.draft.id);
            },
        },
        {
            label: 'a member\'s fix of the tags and the body, approved',
            fix: 'tags+body',
            write: async (send) => {
                const P = owenPage();
                const s = await call(nextMember(), 'POST', '/api/knowledge/drafts', { fixOf: P, note: 'Closed on Mondays now', body: FIX_BODY, ...send });
                if (s.status !== 201) return asOutcome(s, P, null);
                const a = await call(owen, 'POST', `/api/knowledge/drafts/${s.body.draft.id}/approve`, {});
                return asOutcome(a, P, s.body.draft.id);
            },
        },
    ];
    // What the page's words should be after each path: the fix of the body changes it, nothing else does.
    const control = owenPage();
    const pageWords = (id: string) => {
        const r = rowOf(id);
        return JSON.stringify([r.title, r.description, r.category, r.knowledge_place, r.knowledge_sources, r.knowledge_lang, r.tags]);
    };
    const expectedWords = (path: Path) => {
        const want = JSON.parse(pageWords(control));
        if (path.fix === 'tags+body') want[1] = FIX_BODY;
        return JSON.stringify(want);
    };
    for (const path of PATHS) {
        for (const input of INPUTS) {
            clearDrafts();
            const pagesBefore = pageCount();
            const draftsBefore = draftCount();
            const out = await path.write(input.send);
            const wrong: string[] = [];
            if (input.refusal) {
                if (out.status !== 400 || out.code !== 'bad_tags' || !String(out.error ?? '').startsWith(input.refusal)) {
                    wrong.push(`answered ${out.status} ${out.code} "${out.error}", not 400 bad_tags "${input.refusal}"`);
                }
                // Nothing written: no page made, no draft waiting from the refused write, the edited page's tags as they were.
                const edits = path.label.includes('edits') || path.fix;
                if (!edits && pageCount() !== pagesBefore) wrong.push(`a page was made (${pagesBefore} → ${pageCount()})`);
                if (edits && out.page && (tagsOf(rowOf(out.page).free_tags).length !== 0 || wordsOf(out.page) !== wordsOf(control))) wrong.push('the page changed');
                if (path.label.includes('"Edit first"')) {
                    if (out.draft && draftRow(out.draft)?.state !== 'waiting') wrong.push('the suggestion is not still waiting');
                } else if (draftCount() !== draftsBefore) wrong.push(`a draft was written (${draftsBefore} → ${draftCount()})`);
            } else {
                if (out.status !== 200 && out.status !== 201) wrong.push(`answered ${out.status} ${out.code} "${out.error}"`);
                const page = out.page;
                if (!page || !rowOf(page)) wrong.push('no page');
                else {
                    const stored = tagsOf(rowOf(page).free_tags);
                    if (JSON.stringify(stored) !== JSON.stringify(input.stored)) wrong.push(`the page holds ${JSON.stringify(stored)}, not ${JSON.stringify(input.stored)}`);
                    if (out.draft && path.label.includes('suggests,') && JSON.stringify(tagsOf(draftRow(out.draft)?.free_tags)) !== JSON.stringify(input.stored)) {
                        wrong.push(`the suggestion held ${draftRow(out.draft)?.free_tags}`);
                    }
                    // Its words as the same page without tags holds them (a member's suggestion is its member's page: the writer aside).
                    if (pageWords(page) !== expectedWords(path)) wrong.push(`something else changed: ${pageWords(page)}`);
                    // Learn's search finds the page by each tag in another case, and by none it does not carry.
                    for (const [word, carries] of [['KERBSIDE', input.stored!.includes('kerbside')], ['Bottle', input.stored!.includes('bottle bank')],
                        ['BANK', input.stored!.includes('bottle bank')], ['LIMÓN', input.stored!.includes('limón')]] as const) {
                        const found = (await search(word)).includes(page);
                        if (found !== carries) wrong.push(`search "${word}" ${found ? 'found' : 'did not find'} it`);
                    }
                }
            }
            assert(wrong.length === 0, `1. ${path.label} x ${input.label}: ${wrong.length === 0
                ? (input.refusal ? `400 bad_tags "${input.refusal}", nothing written` : `stores ${JSON.stringify(input.stored)}, found by its tags only, nothing else changed`)
                : wrong.join('; ')}`);
        }
    }

    // ── 2. Every rewrite keeps the tags' words ──────────────────────────────────────────────────
    console.log('── 2. every rewrite keeps the tags in search ──');
    clearDrafts();
    const T = owenPage({ title: 'Where the bottle bank is', freeTags: ['Kerbside', 'Glass jars'] });
    require_(JSON.stringify(tagsOf(rowOf(T).free_tags)) === '["kerbside","glass jars"]', 'a page with two tags');
    require_((await search('kerbside')).includes(T) && (await search('jars')).includes(T), 'found by both');
    const kept = await call(owen, 'POST', `/api/knowledge/posts/${T}/edit`, { ...PAGE, title: 'Where the bottle bank is now' });
    assert(kept.status === 200 && JSON.stringify(tagsOf(rowOf(T).free_tags)) === '["kerbside","glass jars"]' && (await search('KERBSIDE')).includes(T)
        && (await search('Jars')).includes(T) && kept.body?.post?.freeTags?.join() === 'kerbside,glass jars',
    `2. an owner's edit that sends no tags (the apps before Learn's tags) keeps them, and search still finds it by each (${show(kept)})`);
    const body = await call(nextMember(), 'POST', '/api/knowledge/drafts', { fixOf: T, note: 'Mondays', body: FIX_BODY });
    const bodyOk = await call(owen, 'POST', `/api/knowledge/drafts/${body.body?.draft?.id}/approve`, {});
    assert(bodyOk.status === 200 && rowOf(T).description === FIX_BODY && JSON.stringify(tagsOf(rowOf(T).free_tags)) === '["kerbside","glass jars"]'
        && (await search('kerbside')).includes(T), `2. an approved fix of the body keeps the tags and their words (${show(bodyOk)})`);
    const off = await call(owen, 'POST', `/api/knowledge/posts/${T}/edit`, { ...PAGE, title: 'Where the bottle bank is now', freeTags: [] });
    assert(off.status === 200 && rowOf(T).free_tags === '' && !(await search('kerbside')).includes(T) && !(await search('jars')).includes(T),
        `2. [] takes them off, and search no longer finds the page by them (${show(off)})`);

    // ── 3. To check: a fix of only the tags ─────────────────────────────────────────────────────
    console.log('── 3. To check: a fix of only the tags ──');
    clearDrafts();
    const F = owenPage({ title: 'The swap shed', freeTags: ['Reuse'] });
    const mel = nextMember();
    const onlyTags = await call(mel, 'POST', '/api/knowledge/drafts', { fixOf: F, note: 'Two more to find it by', freeTags: ['reuse', 'Free stuff'] });
    require_(onlyTags.status === 201, `${mel.name}'s fix of only the tags waits (${show(onlyTags)})`);
    const whole = await call(owen, 'GET', `/api/knowledge/drafts/${onlyTags.body.draft.id}`);
    const d = whole.body?.draft;
    assert(whole.status === 200 && Array.isArray(d?.changed) && d.changed.length === 0 && d.freeTagsChanged === true && d.freeTagsPageChanged === false
        && d.freeTags?.join() === 'reuse,free stuff' && d.post?.freeTags?.join() === 'reuse',
    `3. To check: no word part changed, the tags did, Suggested ${JSON.stringify(d?.freeTags)} beside Now ${JSON.stringify(d?.post?.freeTags)} (${show(whole)})`);
    const noteAlone = await call(nextMember(), 'POST', '/api/knowledge/drafts', { fixOf: F, note: 'Still right', freeTags: ['Reuse'] });
    const na = (await call(owen, 'GET', `/api/knowledge/drafts/${noteAlone.body?.draft?.id}`)).body?.draft;
    assert(noteAlone.status === 201 && na?.freeTagsChanged === false && na?.changed?.length === 0,
        '3. the page\'s own tags sent back (in another case) are no change: the note alone');
    const before = wordsOf(F);
    const ok = await call(owen, 'POST', `/api/knowledge/drafts/${onlyTags.body.draft.id}/approve`, {});
    assert(ok.status === 200 && JSON.stringify(tagsOf(rowOf(F).free_tags)) === '["reuse","free stuff"]' && wordsOf(F) === before && (await search('stuff')).includes(F),
        `3. approving writes the tags and nothing else (${show(ok)})`);
    // Two fixes over the tags: the second is refused once the first is in, until "Edit first" sends the tags.
    clearDrafts();
    const a1 = await call(nextMember(), 'POST', '/api/knowledge/drafts', { fixOf: F, note: 'one', freeTags: ['reuse', 'swap'] });
    const a2 = await call(nextMember(), 'POST', '/api/knowledge/drafts', { fixOf: F, note: 'two', freeTags: ['reuse', 'repair'] });
    require_(a1.status === 201 && a2.status === 201, 'two fixes over the tags wait');
    require_((await call(owen, 'POST', `/api/knowledge/drafts/${a1.body.draft.id}/approve`, {})).status === 200, 'the first is approved');
    const moved = (await call(owen, 'GET', `/api/knowledge/drafts/${a2.body.draft.id}`)).body?.draft;
    const refused = await call(owen, 'POST', `/api/knowledge/drafts/${a2.body.draft.id}/approve`, {});
    assert(moved?.freeTagsPageChanged === true && refused.status === 409 && refused.body?.code === 'page_changed' && tagsOf(rowOf(F).free_tags).join() === 'reuse,swap',
        `3. the second, over tags the page changed since, is marked and refused: the first stays (${show(refused)})`);
    const chosen = await call(owen, 'POST', `/api/knowledge/drafts/${a2.body.draft.id}/approve`, { freeTags: ['reuse', 'swap', 'repair'] });
    assert(chosen.status === 200 && tagsOf(rowOf(F).free_tags).join() === 'reuse,swap,repair', `3. "Edit first" with the tags chosen goes through (${show(chosen)})`);

    // ── 4. Search as the Market's ───────────────────────────────────────────────────────────────
    console.log('── 4. search finds a tag as the Market does ──');
    const TAG = ['İncir', 'Straße', 'Πόλη'];
    const L = owenPage({ title: 'The market garden', freeTags: TAG });
    const seller = nextMember();
    const offer = await call(seller, 'POST', '/api/marketplace/posts', {
        type: 'offer', category: 'general', title: 'A box', description: '', price_c: 0, priceType: 'fixed', authorPublicKey: seller.pk,
        lat: -28.55, lng: 153.5, photos: [TEST_PHOTO], freeTags: TAG,
    });
    require_(offer.status === 201 || offer.status === 200, `a listing with the same tags (${show(offer)})`);
    const O = offer.body?.post?.id ?? offer.body?.id;
    require_(JSON.stringify(tagsOf(rowOf(L).free_tags)) === JSON.stringify(tagsOf(rowOf(O).free_tags)), 'the page and the listing store the tags alike');
    for (const word of ['incir', 'İNCİR', 'INCIR', 'straße', 'STRASSE', 'STRAßE', 'πόλη', 'ΠΌΛΗ', 'ΠΟΛΗ', 'stra']) {
        const learn = (await search(word)).includes(L);
        const m = await call(seller, 'GET', `/api/marketplace/posts?q=${encodeURIComponent(word)}&limit=200`);
        const market = Array.isArray(m.body) && m.body.some((p: any) => p.id === O);
        assert(learn === market, `4. "${word}": Learn ${learn ? 'finds' : 'does not find'} the page, the Market ${market ? 'finds' : 'does not find'} the listing`);
    }
    assert((await search('İNCİR')).includes(L) && (await search('ΠΌΛΗ')).includes(L), '4. a Turkish and a Greek tag typed in capitals find the page');

    // ── 5. Never offered on the Market's Tags field ─────────────────────────────────────────────
    console.log('── 5. a page is no listing ──');
    const [w1, w2] = [nextMember(), nextMember()];
    publishKnowledge(broadcast, owen.pk, { ...PAGE, title: 'Compost one', freeTags: ['Compost bays'] }, { writer: w1.pk });
    publishKnowledge(broadcast, owen.pk, { ...PAGE, title: 'Compost two', freeTags: ['Compost bays'] }, { writer: w2.pk });
    forgetFreeTagCounts();
    assert(!offeredFreeTags().some((t) => t.tag === 'compost bays'), '5. two writers\' pages carrying one tag: it is not offered as a listing\'s would be');

    // ── 6. A standby's copy ─────────────────────────────────────────────────────────────────────
    console.log('── 6. a standby\'s copy ──');
    clearDrafts();
    const waiting = await call(nextMember(), 'POST', '/api/knowledge/drafts', { ...PAGE, freeTags: ['Kerbside'] });
    require_(waiting.status === 201, 'a suggestion with a tag waits');
    const copy = await exportSyncState('test-knowledge-tags') as any;
    const copied = ((copy.plainTables?.knowledge_drafts ?? []) as any[]).find((r) => r.id === waiting.body.draft.id);
    assert(copied?.free_tags === '["kerbside"]', `6. the copy carries the suggestion's tags (${copied?.free_tags})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
