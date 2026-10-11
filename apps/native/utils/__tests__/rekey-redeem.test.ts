/**
 * A new phone takes over a member's account with the admin's re-key code (utils/rekey-redeem.ts, #1768; design
 * DESIGN-rekey-redeem-fable.md §5, §8). Storage, signing and the network are fakes that write down the order of
 * everything they are asked, so the record-before-request rule is checked, not assumed. No node is contacted.
 */

import { describe, it, expect } from 'vitest';
import {
    abandonRekey, askRekey, beginRekey, cleanRekeyCode, finishRekey, isRekeyCode, parseRekeyLink, pollRekey,
    rekeyCommunityUrl, resumeRekey, REKEY_TEXT, type RekeyDeps, type RekeySlot,
} from '../rekey-redeem';
import type { BeanPoolIdentity } from '../identity';

const id = (n: string): BeanPoolIdentity => ({
    publicKey: n.repeat(64).slice(0, 64), privateKey: 'f'.repeat(64), callsign: '', createdAt: '2026-10-11T00:00:00.000Z',
    mnemonic: Array.from({ length: 12 }, (_, i) => `w${i}`),
});

interface World {
    log: string[];
    phone: BeanPoolIdentity | null;
    slot: RekeySlot | null;
    answers: Array<{ status: number; body: unknown } | 'offline'>;
    sent: Array<{ url: string; init: any }>;
    deps: RekeyDeps;
}

function world(opts: { phone?: BeanPoolIdentity | null; answers?: World['answers']; failSlotWrite?: boolean } = {}): World {
    const w: World = { log: [], phone: opts.phone ?? null, slot: null, answers: [...(opts.answers ?? [])], sent: [], deps: null as any };
    let drafts = 0;
    w.deps = {
        slot: {
            get: async () => { w.log.push('slot.get'); return w.slot ? JSON.parse(JSON.stringify(w.slot)) : null; },
            set: async (s) => {
                if (opts.failSlotWrite) throw new Error('disk full');
                w.log.push('slot.set'); w.slot = JSON.parse(JSON.stringify(s));
            },
            clear: async () => { w.log.push('slot.clear'); w.slot = null; },
        },
        loadIdentity: async () => (w.phone ? { ...w.phone } : null),
        draftIdentity: async () => { drafts++; w.log.push('draft'); return id(String(drafts)); },
        importIdentity: async (i) => { w.log.push('import'); w.phone = { ...i }; },
        signStatement: async (url, code) => { w.log.push(`sign ${code}`); return { signature: 'sig', signedFor: new URL(url).hostname }; },
        signedHeaders: async (method, url) => { w.log.push(`headers ${method}`); return { 'X-Signed-For': new URL(url).hostname }; },
        fetch: (async (url: string, init: any) => {
            w.log.push(`fetch ${init?.method ?? 'GET'} ${new URL(url).pathname}`);
            w.sent.push({ url, init });
            const a = w.answers.shift() ?? 'offline';
            if (a === 'offline') throw new TypeError('Network request failed');
            return new Response(JSON.stringify(a.body), { status: a.status });
        }) as typeof fetch,
    };
    return w;
}

const MULLUM = 'https://mullum.example.org';
const CODE = 'RK-AB12-CD34';
const waiting = { status: 200, body: { state: 'waiting', match: '47', expiresAt: '2026-10-12T00:00:00.000Z' } };
const bound = { status: 200, body: { state: 'bound', callsign: 'MiaMember', communityName: 'Mullum', linkSignInAgain: true } };

describe('reading the code and the community', () => {
    it('cleans a typed code to the admin\'s spelling', () => {
        expect(cleanRekeyCode(' rk-ab12-cd34 ')).toBe(CODE);
        expect(cleanRekeyCode('rkab12cd34')).toBe(CODE);
        expect(cleanRekeyCode('AB12 CD34')).toBe(CODE);
        expect(isRekeyCode('RK-AB12-CD3')).toBe(false);
        expect(isRekeyCode('RK-AB12-CDXZ')).toBe(false);
    });

    it('reads the dashboard\'s QR: the community is the link\'s own address, on any domain', () => {
        expect(parseRekeyLink(`${MULLUM}/?rekey=${CODE}`)).toEqual({ community: MULLUM, code: CODE });
        expect(parseRekeyLink('https://village.coop/?rekey=rk-ab12-cd34')).toEqual({ community: 'https://village.coop', code: CODE });
        expect(parseRekeyLink(CODE)).toEqual({ community: null, code: CODE });
        expect(parseRekeyLink(`${MULLUM}/?invite=ABCDEF`)).toBeNull();
        expect(parseRekeyLink('beanpool://x?rekey=RK-AB12-CD34')).toBeNull();
        expect(parseRekeyLink('https://127.0.0.1\\@evil.test/?rekey=RK-AB12-CD34')).toBeNull();
        expect(parseRekeyLink('not a link')).toBeNull();
    });

    it('takes a community by its full address, or its name', () => {
        expect(rekeyCommunityUrl('https://village.coop')).toBe('https://village.coop');
        expect(rekeyCommunityUrl('mullum')).toBe('https://mullum.beanpool.org');
        expect(rekeyCommunityUrl('')).toBeNull();
        expect(rekeyCommunityUrl('https://a.test?x@evil.test/')).toBeNull();
    });
});

describe('asking', () => {
    it('a phone with no account: a new key, written down with the community and code before anything is sent', async () => {
        const w = world({ answers: [waiting] });
        const slot = await beginRekey('mullum.example.org', 'rk-ab12-cd34', w.deps);
        const answer = await askRekey(slot, w.deps);
        expect(answer).toEqual({ state: 'waiting', match: '47', expiresAt: '2026-10-12T00:00:00.000Z' });
        expect(w.log.indexOf('slot.set')).toBeGreaterThanOrEqual(0);
        expect(w.log.indexOf('slot.set')).toBeLessThan(w.log.indexOf('fetch POST /api/member/re-enroll'));
        expect(w.slot).toMatchObject({ community: MULLUM, code: CODE, madeHere: true, publicKey: id('1').publicKey });
        expect(w.slot?.draft?.mnemonic?.length).toBe(12);
        expect(w.phone).toBeNull();
        const body = JSON.parse(w.sent[0].init.body);
        expect(body).toEqual({ code: CODE, newPublicKey: id('1').publicKey, signature: 'sig', signedFor: 'mullum.example.org' });
    });

    it('nothing is sent when the record can\'t be written', async () => {
        const w = world({ answers: [waiting], failSlotWrite: true });
        await expect(beginRekey(MULLUM, CODE, w.deps)).rejects.toThrow('disk full');
        expect(w.sent.length).toBe(0);
    });

    it('a phone with an account asks with that key: nothing new is made, nothing is written over it', async () => {
        const mine = id('a');
        const w = world({ phone: mine, answers: [waiting] });
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        await askRekey(slot, w.deps);
        expect(w.log).not.toContain('draft');
        expect(slot).toMatchObject({ publicKey: mine.publicKey, madeHere: false });
        expect(slot.draft).toBeUndefined();
        expect(JSON.parse(w.sent[0].init.body).newPublicKey).toBe(mine.publicKey);
    });

    it('asking again is the same key, so the node answers the same proposal', async () => {
        const w = world({ answers: [waiting, waiting] });
        const first = await beginRekey(MULLUM, CODE, w.deps);
        await askRekey(first, w.deps);
        const again = await beginRekey(MULLUM, CODE, w.deps);
        await askRekey(again, w.deps);
        expect(again.publicKey).toBe(first.publicKey);
        expect(w.log.filter(l => l === 'draft').length).toBe(1);
        expect(JSON.parse(w.sent[1].init.body).newPublicKey).toBe(first.publicKey);
    });

    it('the node\'s refusals are said in its words; a 421, or fetch\'s re-sent copy of it, says another community', async () => {
        const w = world({ answers: [
            { status: 404, body: { error: 'That code isn’t valid. Ask the admin for a new one.', code: 'code_not_valid' } },
            { status: 421, body: { error: 'wrong', code: 'wrong_community' } },
            { status: 403, body: { error: 'Replay detected: nonce already used' } },
            { status: 500, body: {} },
            'offline',
        ] });
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        expect(await askRekey(slot, w.deps)).toEqual({ state: 'refused', message: 'That code isn’t valid. Ask the admin for a new one.', code: 'code_not_valid' });
        expect(await askRekey(slot, w.deps)).toMatchObject({ state: 'refused', message: REKEY_TEXT.wrongCommunity });
        expect(await askRekey(slot, w.deps)).toMatchObject({ state: 'refused', message: REKEY_TEXT.wrongCommunity });
        expect(await askRekey(slot, w.deps)).toEqual({ state: 'unreachable' });
        expect(await askRekey(slot, w.deps)).toEqual({ state: 'unreachable' });
    });

    it('the poll asks with the same key, signed, the code in the query', async () => {
        const w = world({ answers: [waiting, { status: 429, body: { error: 'Too many' } }, bound] });
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        expect(await pollRekey(slot, w.deps)).toMatchObject({ state: 'waiting', match: '47' });
        expect(await pollRekey(slot, w.deps)).toEqual({ state: 'unreachable' });
        expect(await pollRekey(slot, w.deps)).toEqual({ state: 'bound', callsign: 'MiaMember', communityName: 'Mullum', linkSignInAgain: true });
        expect(w.sent[0].url).toBe(`${MULLUM}/api/member/re-enroll/status?code=${CODE}`);
        expect(w.log).toContain('headers GET');
    });
});

describe('finishing', () => {
    it('bound: the key this flow made becomes the phone\'s account, with the name the node gave', async () => {
        const w = world({ answers: [waiting, bound] });
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        await askRekey(slot, w.deps);
        const answer = await pollRekey(slot, w.deps);
        expect(answer.state).toBe('bound');
        const done = await finishRekey(slot, answer as { callsign: string }, w.deps);
        expect(done.newWords).toBe(true);
        expect(w.phone).toMatchObject({ publicKey: slot.publicKey, callsign: 'MiaMember' });
        expect(w.phone?.mnemonic?.length).toBe(12);
        expect(w.slot).toBeNull();
    });

    it('bound with the phone\'s own key: the account on the phone is left exactly as it was', async () => {
        const mine = { ...id('a'), callsign: 'MyName' };
        const w = world({ phone: mine, answers: [bound] });
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        const done = await finishRekey(slot, { callsign: 'MiaMember' }, w.deps);
        expect(done).toEqual({ identity: mine, newWords: false });
        expect(w.phone).toEqual(mine);
        expect(w.log).not.toContain('import');
    });

    it('never writes over another account that appeared on the phone meanwhile', async () => {
        const w = world({ answers: [bound] });
        const slot = await beginRekey(MULLUM, CODE, w.deps);
        w.phone = id('z');
        await expect(finishRekey(slot, { callsign: 'MiaMember' }, w.deps)).rejects.toThrow(REKEY_TEXT.changedAccount);
        expect(w.phone).toEqual(id('z'));
        expect(w.log).not.toContain('import');
    });

    it('declined or gone: the record goes, and the key it made with it; an account on the phone is never touched', async () => {
        const mine = id('a');
        const w = world({ phone: mine });
        await beginRekey(MULLUM, CODE, w.deps);
        await abandonRekey(w.deps);
        expect(w.slot).toBeNull();
        expect(w.phone).toEqual(mine);
    });
});

describe('the next launch (resume)', () => {
    it('bound with no sign-in copies removed says so: linkSignInAgain is false (review N5)', async () => {
        const w = world({ answers: [{ status: 200, body: { state: 'bound', callsign: 'MiaMember', communityName: 'Mullum', linkSignInAgain: false } }] });
        const r = await resumeRekey(w.deps);
        expect(r).toBeNull();
        const slot = await beginRekey('https://mullum.example.org', 'RK-AB12-CD34', w.deps);
        expect(await askRekey(slot, w.deps)).toEqual({ state: 'bound', callsign: 'MiaMember', communityName: 'Mullum', linkSignInAgain: false });
    });

    it('bound while the app was closed: asked once, told bound, the caller saves it', async () => {
        const w = world({ answers: [bound] });
        w.slot = { community: MULLUM, code: CODE, publicKey: id('1').publicKey, madeHere: true, draft: id('1'), startedAt: 1 };
        const r = await resumeRekey(w.deps);
        expect(r?.answer).toEqual({ state: 'bound', callsign: 'MiaMember', communityName: 'Mullum', linkSignInAgain: true });
        expect(w.slot).not.toBeNull();
        await finishRekey(r!.slot, { callsign: 'MiaMember' }, w.deps);
        expect(w.phone?.publicKey).toBe(id('1').publicKey);
        expect(w.log.filter(l => l.startsWith('fetch')).length).toBe(1);
    });

    it('gone (a dead code): the record and its key go, and nothing is saved', async () => {
        const w = world({ answers: [{ status: 404, body: { error: 'That code isn’t valid. Ask the admin for a new one.', code: 'code_not_valid' } }] });
        w.slot = { community: MULLUM, code: CODE, publicKey: id('1').publicKey, madeHere: true, draft: id('1'), startedAt: 1 };
        const r = await resumeRekey(w.deps);
        expect(r?.answer.state).toBe('refused');
        expect(w.slot).toBeNull();
        expect(w.phone).toBeNull();
    });

    it('declined: the record goes', async () => {
        const w = world({ answers: [{ status: 200, body: { state: 'declined' } }] });
        w.slot = { community: MULLUM, code: CODE, publicKey: id('1').publicKey, madeHere: true, draft: id('1'), startedAt: 1 };
        expect((await resumeRekey(w.deps))?.answer).toEqual({ state: 'declined' });
        expect(w.slot).toBeNull();
    });

    it('unreachable: the record is kept, and the screen shows again', async () => {
        const w = world({ answers: ['offline'] });
        const kept = { community: MULLUM, code: CODE, publicKey: id('1').publicKey, madeHere: true, draft: id('1'), startedAt: 1 };
        w.slot = { ...kept };
        expect((await resumeRekey(w.deps))?.answer).toEqual({ state: 'unreachable' });
        expect(w.slot).toEqual(kept);
    });

    it('no record: nothing asked', async () => {
        const w = world();
        expect(await resumeRekey(w.deps)).toBeNull();
        expect(w.sent.length).toBe(0);
    });
});
