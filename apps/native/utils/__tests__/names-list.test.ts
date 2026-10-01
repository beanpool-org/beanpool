/**
 * The names list on an admin's phone (utils/names-list.ts, app/names-list.tsx; the server is apps/server/src/routes/
 * names-list.ts, tested over HTTPS by test-names-list.ts and test-standby-names-list.ts).
 *
 * Nothing here contacts a node. The `fetch` stub plays the admin's community: it records every request, and each is
 * checked as the node's middleware checks it (signed by the admin's own key, for that host). What the phone sends is
 * checked for the planted names: nothing readable leaves the phone. The keys and boxes are real (@beanpool/core).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
}));
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.delete(key); }),
    },
}));

import { getPublicKey } from '@noble/ed25519';
import {
    newNamesListKey, wrapNamesListKey, unwrapNamesListKey, sealNamesEntry, openNamesEntry, newNamesEntryId, NAMES_LIMITS, toEd25519Pkcs8,
} from '@beanpool/core';
import { bytesToHex } from '../crypto';
import { boundSignatureValid } from './server-signature-check';
import { lightColors, darkColors } from '../../constants/colors';
import {
    offersNamesList, myListKeys, keyPlan, installKeyFor, waitingAdmins, shareKeyWith, openEntries, filterEntries, sealedFor,
    addNamesEntry, editNamesEntry, reEncryptBatches, sendReEncrypted, confirmableMembers, confirmationActions, confirmationLine,
    logLineText, namesListHtml, fetchNamesState, fetchNamesList, confirmMember, deleteNamesEntry,
    type NamesState, type NamesListBody, type ConfirmationRow,
} from '../names-list';
import { NAMES_TEXT_ON, NAMES_TOUCH_TARGETS, namesListStyleSpec } from '../names-list-style';
import type { BeanPoolIdentity } from '../identity';

const COMMUNITY = 'https://mullum.beanpool.org';
const PLANTED = ['Zebedee Quillfeather', 'Lives by the old cannery'];

async function admin(callsign: string, pkcs8 = false): Promise<BeanPoolIdentity> {
    const seed = new Uint8Array(randomBytes(32));
    const pub = bytesToHex(await getPublicKey(seed));
    return { publicKey: pub, privateKey: bytesToHex(pkcs8 ? toEd25519Pkcs8(seed) : seed), callsign } as BeanPoolIdentity;
}

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }
let sent: Sent[] = [];
let answer: (req: Sent) => { status: number; body?: unknown } = () => ({ status: 500 });

beforeEach(() => {
    mem.clear();
    sent = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        const req = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? '' };
        sent.push(req);
        const a = answer(req);
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (a.body === undefined) throw new Error('no body'); return a.body; } };
    });
});

function stateOf(me: BeanPoolIdentity, over: Partial<NamesState> = {}): NamesState {
    return {
        generation: 0, newKeyNeeded: false, nobodyHoldsKey: false, myKeys: [],
        admins: [{ pubkey: me.publicKey, callsign: me.callsign, role: 'owner', holdsKey: false }],
        settings: { twoAdminsToConfirm: false, namesShownToMembers: false },
        counts: { entries: 0, olderKey: 0, locked: 0, confirmed: 0, awaitingSecond: 0 },
        me: { pubkey: me.publicKey, role: 'owner', owner: true },
        ...over,
    };
}

const nothingReadable = (s: Sent) => PLANTED.every((p) => !s.body.toLowerCase().includes(p.toLowerCase()));

describe('who is offered the names list', () => {
    it('an owner or admin on a local community; never a moderator, a member, or anyone on the global node', () => {
        expect(offersNamesList('owner', 'local')).toBe(true);
        expect(offersNamesList('admin', null)).toBe(true);
        expect(offersNamesList('moderator', 'local')).toBe(false);
        expect(offersNamesList(null, 'local')).toBe(false);
        expect(offersNamesList('owner', 'global')).toBe(false);
        const entry = fs.readFileSync(path.join(__dirname, '../../components/NodeAdminEntry.tsx'), 'utf8');
        expect(entry).toMatch(/offersNamesList\(role, profile\?\.profile\) \? \(/);
        expect(entry).toContain("pathname: '/names-list'");
    });
});

describe('the key: made, opened, and passed on only by a tap', () => {
    it('the first admin makes the key, for themselves alone, signed with their own key; it opens with their key only', async () => {
        const owen = await admin('Owen');
        const st = stateOf(owen);
        const plan = keyPlan(st, owen.publicKey, myListKeys(st, owen));
        expect(plan).toEqual({ kind: 'make_first' });
        answer = () => ({ status: 201, body: { generation: 1 } });
        const made = await installKeyFor(COMMUNITY, owen, st, plan);
        expect(made.ok).toBe(true);
        expect(sent[0].url).toBe(`${COMMUNITY}/api/names/key`);
        expect(boundSignatureValid(sent[0], owen.publicKey)).toBe(true);
        const body = JSON.parse(sent[0].body);
        expect(body.generation).toBe(1);
        expect(body.wraps.map((w: any) => w.holder)).toEqual([owen.publicKey]);
        const key = unwrapNamesListKey(body.wraps[0], owen.privateKey, owen.publicKey, 1);
        expect(made.ok && Buffer.from(made.value.key).equals(Buffer.from(key))).toBe(true);
    });

    it('opens its own wraps, from a raw seed or PKCS8, and none made for anyone else', async () => {
        const ada = await admin('Ada', true);
        const abe = await admin('Abe');
        const key = newNamesListKey();
        const st = stateOf(ada, {
            generation: 2,
            myKeys: [
                { generation: 2, wrappedBy: ada.publicKey, ...wrapNamesListKey(key, ada.publicKey, 2) },
                { generation: 1, wrappedBy: ada.publicKey, ...wrapNamesListKey(newNamesListKey(), abe.publicKey, 1) },
            ],
        });
        const keys = myListKeys(st, ada);
        expect([...keys.keys()]).toEqual([2]);
        expect(Buffer.from(keys.get(2)!).equals(Buffer.from(key))).toBe(true);
    });

    it('after an admin goes, the holder makes a new key for the admins who held the old one, never a newcomer', async () => {
        const [owen, ada, cy] = [await admin('Owen'), await admin('Ada'), await admin('Cy')];
        const k1 = newNamesListKey();
        const st = stateOf(owen, {
            generation: 1, newKeyNeeded: true,
            myKeys: [{ generation: 1, wrappedBy: owen.publicKey, ...wrapNamesListKey(k1, owen.publicKey, 1) }],
            admins: [
                { pubkey: owen.publicKey, callsign: 'Owen', role: 'owner', holdsKey: true },
                { pubkey: ada.publicKey, callsign: 'Ada', role: 'admin', holdsKey: true },
                { pubkey: cy.publicKey, callsign: 'Cy', role: 'admin', holdsKey: false },
            ],
        });
        const plan = keyPlan(st, owen.publicKey, myListKeys(st, owen));
        expect(plan).toEqual({ kind: 'make_new', wrapTo: [owen.publicKey, ada.publicKey] });
        answer = () => ({ status: 201, body: { generation: 2 } });
        await installKeyFor(COMMUNITY, owen, st, plan);
        const body = JSON.parse(sent[0].body);
        expect(body.generation).toBe(2);
        expect(body.wraps.map((w: any) => w.holder).sort()).toEqual([owen.publicKey, ada.publicKey].sort());
        expect(waitingAdmins(st, owen.publicKey)).toEqual([]);
        // Ada, who doesn't hold the current key, waits and is told who can make it.
        const adaPlan = keyPlan({ ...st, myKeys: [] }, ada.publicKey, new Map());
        expect(adaPlan).toMatchObject({ kind: 'wait', newKeyNeeded: true });
    });

    it('nobody holding the key: start again (the screen asks first); an admin who waits is told who to ask', async () => {
        const owen = await admin('Owen');
        expect(keyPlan(stateOf(owen, { generation: 3, nobodyHoldsKey: true }), owen.publicKey, new Map())).toEqual({ kind: 'start_again' });
        const st = stateOf(owen, { generation: 3, admins: [{ pubkey: 'a'.repeat(64), callsign: 'Ada', role: 'admin', holdsKey: true }, { pubkey: owen.publicKey, callsign: 'Owen', role: 'owner', holdsKey: false }] });
        const plan = keyPlan(st, owen.publicKey, new Map());
        expect(plan.kind === 'wait' && plan.holders.map((h) => h.callsign)).toEqual(['Ada']);
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        // Start again is never done without the admin's yes.
        expect(screen.indexOf('Alert.alert(COPY.startAgainTitle')).toBeGreaterThan(-1);
        expect(screen.indexOf('Alert.alert(COPY.startAgainTitle')).toBeLessThan(screen.indexOf('installKeyFor(anchor, identity, state, plan)'));
    });

    it('sharing: only admins waiting; the wrap opens for that admin only; the screen asks before sharing', async () => {
        const [owen, cy] = [await admin('Owen'), await admin('Cy')];
        const key = newNamesListKey();
        const st = stateOf(owen, {
            generation: 1,
            admins: [
                { pubkey: owen.publicKey, callsign: 'Owen', role: 'owner', holdsKey: true },
                { pubkey: cy.publicKey, callsign: 'Cy', role: 'admin', holdsKey: false },
            ],
        });
        const waiting = waitingAdmins(st, owen.publicKey);
        expect(waiting.map((a) => a.callsign)).toEqual(['Cy']);
        answer = () => ({ status: 200, body: { shared: [cy.publicKey] } });
        await shareKeyWith(COMMUNITY, owen, st, key, waiting[0]);
        expect(sent[0].url).toBe(`${COMMUNITY}/api/names/key/share`);
        expect(boundSignatureValid(sent[0], owen.publicKey)).toBe(true);
        const wrap = JSON.parse(sent[0].body).wraps[0];
        expect(wrap.holder).toBe(cy.publicKey);
        expect(Buffer.from(unwrapNamesListKey(wrap, cy.privateKey, cy.publicKey, 1)).equals(Buffer.from(key))).toBe(true);
        expect(() => unwrapNamesListKey(wrap, owen.privateKey, owen.publicKey, 1)).toThrow();
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        const share = screen.slice(screen.indexOf('const share = '), screen.indexOf('const openForm'));
        expect(share.indexOf('Alert.alert(COPY.shareTitle')).toBeLessThan(share.indexOf('shareKeyWith('));
    });
});

describe('entries: sealed before they leave the phone', () => {
    it('add and edit send sealed text only, signed, under the current generation', async () => {
        const owen = await admin('Owen');
        const key = newNamesListKey();
        const sealed = sealedFor(key, 4, { name: `  ${PLANTED[0]} `, note: PLANTED[1] });
        expect(sealed.ok).toBe(true);
        if (!sealed.ok) return;
        answer = () => ({ status: 201, body: { id: sealed.id } });
        await addNamesEntry(COMMUNITY, owen, 4, sealed);
        answer = () => ({ status: 200, body: { id: sealed.id } });
        await editNamesEntry(COMMUNITY, owen, 4, sealed);
        expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['POST /api/names/entries', `PUT /api/names/entries/${sealed.id}`]);
        for (const s of sent) {
            expect(boundSignatureValid(s, owen.publicKey)).toBe(true);
            expect(nothingReadable(s)).toBe(true);
            expect(JSON.parse(s.body).keyGeneration).toBe(4);
        }
        expect(openNamesEntry(key, sealed.id, 4, JSON.parse(sent[0].body).ciphertext)).toEqual({ name: PLANTED[0], note: PLANTED[1] });
        expect(sealedFor(key, 4, { name: ' ', note: '' })).toEqual({ ok: false, error: 'Write the person’s name.' });
    });

    it('opens each entry with its own generation’s key; one it can’t is locked, never guessed', () => {
        const k1 = newNamesListKey();
        const k2 = newNamesListKey();
        const [a, b, c, d] = [newNamesEntryId(), newNamesEntryId(), newNamesEntryId(), newNamesEntryId()];
        const list: NamesListBody = {
            generation: 2,
            entries: [
                { id: a, ciphertext: sealNamesEntry(k2, a, 2, { name: 'Zoe', note: '' }), keyGeneration: 2, createdBy: 'x', createdAt: '2026-10-01', updatedBy: null, updatedAt: '' },
                { id: b, ciphertext: sealNamesEntry(k1, b, 1, { name: 'Abe', note: 'n' }), keyGeneration: 1, createdBy: 'x', createdAt: '2026-10-01', updatedBy: null, updatedAt: '' },
                { id: c, ciphertext: sealNamesEntry(newNamesListKey(), c, 2, { name: 'Tampered', note: '' }), keyGeneration: 2, createdBy: 'x', createdAt: '2026-10-01', updatedBy: null, updatedAt: '' },
                { id: d, ciphertext: sealNamesEntry(newNamesListKey(), d, 7, { name: 'Unknown', note: '' }), keyGeneration: 7, createdBy: 'x', createdAt: '2026-10-02', updatedBy: null, updatedAt: '' },
            ],
            confirmations: [{ id: 'c1', memberPubkey: 'm', callsign: 'Mel', entryId: b, confirmedBy: 'x', confirmedAt: '', needsSecond: false, secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null, status: 'confirmed' }],
        };
        const opened = openEntries(list, new Map([[1, k1], [2, k2]]));
        expect(opened.map((e) => e.text?.name ?? e.locked)).toEqual(['Abe', 'Zoe', 'did_not_open', 'no_key']);
        expect(opened[0].confirmation?.callsign).toBe('Mel');
        expect(filterEntries(opened, 'zo').map((e) => e.text?.name)).toEqual(['Zoe']);
        expect(filterEntries(opened, '  ')).toHaveLength(4);
    });

    it('after a new key, the older entries it can open go back sealed under it, a batch at a time', async () => {
        const owen = await admin('Owen');
        const k1 = newNamesListKey();
        const k2 = newNamesListKey();
        const n = NAMES_LIMITS.batch + 3;
        const entries = Array.from({ length: n }, (_, i) => {
            const id = newNamesEntryId();
            return { id, ciphertext: sealNamesEntry(k1, id, 1, { name: `${PLANTED[0]} ${i}`, note: '' }), keyGeneration: 1, createdBy: 'x', createdAt: '', updatedBy: null, updatedAt: '' };
        });
        const batches = reEncryptBatches({ generation: 2, entries, confirmations: [] }, new Map([[1, k1], [2, k2]]), 2);
        expect(batches.map((b) => b.length)).toEqual([NAMES_LIMITS.batch, 3]);
        expect(openNamesEntry(k2, batches[0][0].id, 2, batches[0][0].ciphertext).name).toBe(`${PLANTED[0]} 0`);
        expect(reEncryptBatches({ generation: 2, entries, confirmations: [] }, new Map([[2, k2]]), 2)).toEqual([]);
        answer = (req) => ({ status: 200, body: { done: JSON.parse(req.body).entries.length, left: 0 } });
        const done = await sendReEncrypted(COMMUNITY, owen, 2, batches);
        expect(done).toEqual({ ok: true, value: { done: n } });
        expect(sent.every((s) => boundSignatureValid(s, owen.publicKey) && nothingReadable(s))).toBe(true);
    });
});

describe('reads and refusals', () => {
    it('the export is fetched as an export (the node logs it), and the PDF is made from that fetch', async () => {
        const owen = await admin('Owen');
        answer = () => ({ status: 200, body: { generation: 1, entries: [], confirmations: [] } });
        await fetchNamesList(COMMUNITY, owen, true);
        expect(sent[0].url).toBe(`${COMMUNITY}/api/names/entries?for=export`);
        expect(boundSignatureValid(sent[0], owen.publicKey)).toBe(true);
        const screen = fs.readFileSync(path.join(__dirname, '../../app/names-list.tsx'), 'utf8');
        const exp = screen.slice(screen.indexOf('const exportPdf'), screen.indexOf('const setTwoAdmins'));
        expect(exp.indexOf('Alert.alert(COPY.exportTitle')).toBeLessThan(exp.indexOf('fetchNamesList(anchor, identity, true)'));
        expect(exp.indexOf('fetchNamesList(anchor, identity, true)')).toBeLessThan(exp.indexOf('printToFileAsync'));
        expect(exp).toContain('openEntries(fresh.value, keys)');
        expect(exp).toContain('deleteAsync(uri');
    });

    it("a refusal comes back in the node's words with its code; no answer is said plainly", async () => {
        const mel = await admin('Mel');
        answer = () => ({ status: 403, body: { error: 'Only the community’s owners and admins can open the names list.', code: 'admins_only' } });
        expect(await fetchNamesState(COMMUNITY, mel)).toEqual({ ok: false, status: 403, code: 'admins_only', message: 'Only the community’s owners and admins can open the names list.' });
        (globalThis as any).fetch = vi.fn(async () => { throw new Error('offline'); });
        const r = await confirmMember(COMMUNITY, mel, 'a'.repeat(64), newNamesEntryId());
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(/Couldn't reach your community/);
    });

    it('a delete is a signed DELETE with no body', async () => {
        const owen = await admin('Owen');
        const id = newNamesEntryId();
        answer = () => ({ status: 200, body: { id } });
        await deleteNamesEntry(COMMUNITY, owen, id);
        expect(sent[0].method).toBe('DELETE');
        expect(sent[0].body).toBe('');
        expect(boundSignatureValid(sent[0], owen.publicKey)).toBe(true);
    });
});

describe('confirming, in words', () => {
    const row = (over: Partial<ConfirmationRow>): ConfirmationRow => ({
        id: 'c', memberPubkey: 'c'.repeat(64), callsign: 'Mel', entryId: 'e', confirmedBy: 'a'.repeat(64), confirmedAt: '2026-10-01T00:00:00Z',
        needsSecond: false, secondedBy: null, secondedAt: null, revokedBy: null, revokedAt: null, revokeReason: null, status: 'confirmed', ...over,
    });

    it('who can be confirmed: members without a live confirmation; yourself only as the only admin', () => {
        const me = 'a'.repeat(64);
        const members = [{ publicKey: me, callsign: 'Ada' }, { publicKey: 'b'.repeat(64), callsign: 'bo' }, { publicKey: 'c'.repeat(64), callsign: 'Mel' }, { publicKey: 'not-a-key', callsign: 'X' }];
        const list: NamesListBody = { generation: 1, entries: [], confirmations: [row({})] };
        expect(confirmableMembers(members, list, me, 2).map((m) => m.callsign)).toEqual(['bo']);
        expect(confirmableMembers(members, list, me, 1).map((m) => m.callsign)).toEqual(['Ada', 'bo']);
        expect(confirmableMembers(members, { ...list, confirmations: [row({ status: 'revoked', revokedAt: 'x' })] }, me, 2).map((m) => m.callsign)).toEqual(['bo', 'Mel']);
    });

    it('a second admin, not the first, seconds; any admin revokes a live one; a revoked one does nothing', () => {
        const first = 'a'.repeat(64);
        const waiting = row({ needsSecond: true, status: 'awaiting_second', confirmedBy: first });
        expect(confirmationActions(waiting, first)).toEqual({ second: false, revoke: true });
        expect(confirmationActions(waiting, 'b'.repeat(64))).toEqual({ second: true, revoke: true });
        expect(confirmationActions(waiting, waiting.memberPubkey)).toEqual({ second: false, revoke: true });
        expect(confirmationActions(row({ status: 'revoked', revokedAt: 'x' }), first)).toEqual({ second: false, revoke: false });
        const nameOf = (pk: string) => (pk === first ? '@Ada' : '@Bo');
        expect(confirmationLine(waiting, nameOf)).toMatch(/^@Mel: confirmed by @Ada .*waiting for a second admin$/);
        expect(confirmationLine(row({ secondedBy: 'b'.repeat(64), secondedAt: 'x' }), nameOf)).toMatch(/^@Mel: confirmed by @Ada and @Bo/);
        expect(confirmationLine(waiting, nameOf)).not.toMatch(/Newcomer|Resident|Steward|Elder|tier/i);
    });

    it('the access log says who did what', () => {
        const nameOf = () => 'an admin';
        expect(logLineText({ id: '1', actor: 'x', actorCallsign: 'Owen', action: 'export', entryId: null, subject: null, subjectCallsign: null, at: '2026-10-01T00:00:00Z' }, nameOf))
            .toMatch(/^@Owen exported the list · /);
        expect(logLineText({ id: '2', actor: 'node', actorCallsign: null, action: 'holder_dropped', entryId: null, subject: 'y', subjectCallsign: 'Abe', at: '2026-10-01T00:00:00Z' }, nameOf))
            .toMatch(/^@Abe no longer holds the key/);
        expect(logLineText({ id: '3', actor: 'x', actorCallsign: 'Ada', action: 'confirm', entryId: 'e', subject: 'm', subjectCallsign: 'Mel', at: '' }, nameOf))
            .toBe('@Ada confirmed @Mel · ');
    });
});

describe('the PDF page', () => {
    it('escapes every value, counts the locked entries, and never shows one', () => {
        const html = namesListHtml({
            communityName: 'Mullum <LETS>', exportedBy: '@Owen', at: new Date('2026-10-01T00:00:00Z'),
            entries: [
                { id: 'a', generation: 1, createdAt: '', updatedAt: '', text: { name: '<script>alert(1)</script>Bob', note: 'line one\nline "two"' }, locked: null, confirmation: null },
                { id: 'b', generation: 1, createdAt: '', updatedAt: '', text: null, locked: 'no_key', confirmation: null },
            ],
        });
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;Bob');
        expect(html).toContain('line one<br>line &quot;two&quot;');
        expect(html).toContain('Mullum &lt;LETS&gt;: names list');
        expect(html).toContain('1 entry, and 1 this phone couldn’t open');
        expect(html).toMatch(/Keep this page as safe as a paper list/);
    });
});

// ── Small screens and both themes: the rules the styles are held to (no device renderer in this runner) ──

function luminance(hex: string): number {
    const m = hex.replace('#', '');
    const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m.slice(0, 6);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

describe.each([['light', lightColors], ['dark', darkColors]] as const)('the names list styles in %s', (_name, colors) => {
    const spec = namesListStyleSpec(colors as typeof lightColors) as Record<string, Record<string, unknown>>;

    it('every touch target is at least 48dp tall', () => {
        for (const k of NAMES_TOUCH_TARGETS) expect(Number(spec[k].minHeight), k).toBeGreaterThanOrEqual(48);
    });
    it('nothing has a fixed width or height, so text wraps and boxes grow at 320dp and 1.3× text', () => {
        for (const [k, v] of Object.entries(spec)) {
            expect(v.width, `${k}.width`).toBeUndefined();
            expect(v.height, `${k}.height`).toBeUndefined();
            expect(v.maxHeight, `${k}.maxHeight`).toBeUndefined();
        }
    });
    it('rows of buttons wrap rather than squeeze: two fit side by side at 320dp less the padding, and stack when they grow', () => {
        expect(spec.buttonRow.flexWrap).toBe('wrap');
        expect(Number(spec.primaryBtn.flexBasis) * 2 + Number(spec.buttonRow.gap)).toBeLessThanOrEqual(320 - 2 * Number(spec.scroll.padding));
        for (const k of ['primaryBtn', 'secondaryBtn', 'dangerBtn', 'smallBtn']) expect(spec[k].flexGrow, k).toBe(1);
    });
    it('text is readable on its background (WCAG AA, 4.5:1)', () => {
        for (const [text, bg] of Object.entries(NAMES_TEXT_ON)) {
            const fg = String(spec[text].color);
            const back = String(spec[bg].backgroundColor);
            expect(fg.startsWith('#') && back.startsWith('#'), `${text} on ${bg}: ${fg} / ${back}`).toBe(true);
            expect(contrast(fg, back), `${text} (${fg}) on ${bg} (${back})`).toBeGreaterThanOrEqual(4.5);
        }
    });
});
