/**
 * A bill with an invite (scratch/fable-design/DESIGN-getting-paid-fable.md §4.5, slice B3): the invite panel's fold, the
 * share sentence (one sentence, no amount), what the invite's row says it carries, Revoke's confirm, and the sender's line
 * while nobody has joined with it. Both apps draw these from here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { billLines, billSentLine, billsOn, inviteBillFromForm, inviteBillLines } from '../bills.js';
import { inviteShareText } from '../invite-share-text.js';
import { inviteCarries, inviteRevokeAsk } from '../invite-rows.js';
import { setLanguage } from '../words.js';

afterEach(() => setLanguage('en'));

describe('billsOn: only where the node says bills are on', () => {
    it('true only for `bills: true`', () => {
        expect(billsOn({ bills: true })).toBe(true);
        for (const f of [undefined, null, {}, { bills: false }, { bills: 'true' }, { bills: 1 }]) expect(billsOn(f as any)).toBe(false);
    });
});

describe('inviteBillFromForm: the fold read as the bill it asks for', () => {
    it('both boxes empty (or blank) is no bill and no refusal: the invite stays as it is', () => {
        expect(inviteBillFromForm('', '')).toEqual({ bill: null, error: null });
        expect(inviteBillFromForm('   ', ' ')).toEqual({ bill: null, error: null });
    });
    it('a bill: what for trimmed, Beans as whole hundredths', () => {
        expect(inviteBillFromForm('  Power,   October ', '60')).toEqual({ bill: { whatFor: 'Power, October', amount_c: 6000 }, error: null });
        expect(inviteBillFromForm('Seedlings', '0.01')).toEqual({ bill: { whatFor: 'Seedlings', amount_c: 1 }, error: null });
        expect(inviteBillFromForm('Seedlings', '2000')).toEqual({ bill: { whatFor: 'Seedlings', amount_c: 200_000 }, error: null });
    });
    it('the amount at its edges: 0, over 2,000, three decimals, words, a minus: the send sheet\'s refusal', () => {
        for (const bad of ['0', '2000.01', '1.005', 'sixty', '-5', '']) {
            expect(inviteBillFromForm('Seedlings', bad)).toEqual({ bill: null, error: billLines.badAmount() });
        }
    });
    it('what for at its edges: 2 or 81 characters refused, 3 and 80 taken', () => {
        expect(inviteBillFromForm('ab', '5')).toEqual({ bill: null, error: billLines.badWhatFor() });
        expect(inviteBillFromForm('x'.repeat(81), '5')).toEqual({ bill: null, error: billLines.badWhatFor() });
        expect(inviteBillFromForm('abc', '5').bill?.whatFor).toBe('abc');
        expect(inviteBillFromForm('x'.repeat(80), '5').bill?.whatFor).toBe('x'.repeat(80));
        expect(inviteBillFromForm('', '5')).toEqual({ bill: null, error: billLines.badWhatFor() });
    });
});

describe('inviteShareText with a bill: one sentence, plainly, and no amount', () => {
    const parts = { name: 'Riverside', link: 'https://riverside.example/?invite=INV-ABCD-EFGH', code: 'INV-ABCD-EFGH', address: 'riverside.example' };

    it('says a bill comes with the invite, right after the link, naming the inviter', () => {
        expect(inviteShareText({ ...parts, billFrom: 'Rob' })).toBe(
            "Join my BeanPool community, Riverside:\nhttps://riverside.example/?invite=INV-ABCD-EFGH\n\nRob has also sent you a bill to pay in Beans once you're in.\n\nIf the link doesn't open, install BeanPool from beanpool.org and paste this code:\nINV-ABCD-EFGH\n\nCommunity address: riverside.example",
        );
    });
    it('carries no figure of the bill: the only digits are the ones in the parts', () => {
        const text = inviteShareText({ ...parts, link: 'https://riverside.example/?invite=INV-WXYZ-QRST', code: 'INV-WXYZ-QRST', billFrom: 'Rob' });
        expect(text).not.toMatch(/\d/);
    });
    it('no bill (absent, null or blank): the message is exactly the one without it', () => {
        const plain = inviteShareText(parts);
        expect(plain).not.toMatch(/bill/i);
        expect(inviteShareText({ ...parts, billFrom: null })).toBe(plain);
        expect(inviteShareText({ ...parts, billFrom: '  ' })).toBe(plain);
    });
    it('goes through the words layer in one piece: in the pseudo-locale one translation, with the parts untouched', () => {
        setLanguage('xx');
        const text = inviteShareText({ ...parts, billFrom: 'Rob' });
        expect(text).toMatch(/^\[.*\]$/s);
        for (const p of [parts.link, parts.code, parts.address, parts.name, 'Rob']) expect(text).toContain(p);
    });
});

describe('the invite rows: what it carries, and Revoke\'s confirm', () => {
    const inv = { code: 'INV-1', createdAt: '2026-11-15T00:00:00.000Z' };
    it('"bill 60 Beans" beside what else it carries; a plain invite stays "Plain invite"', () => {
        expect(inviteCarries({ ...inv, bill: { whatFor: 'Power', amount_c: 6000 } })).toBe('bill 60 Beans');
        expect(inviteCarries({ ...inv, vouchAmount: 20000, bill: { whatFor: 'Power', amount_c: 5050 } })).toBe('200 vouch · bill 50.50 Beans');
        expect(inviteCarries(inv)).toBe('Plain invite');
        expect(inviteCarries({ ...inv, bill: null })).toBe('Plain invite');
        expect(inviteBillLines.carries(6000)).toBe('bill 60 Beans');
    });
    it('Revoke says the bill goes with it; without one, the words are as before', () => {
        expect(inviteRevokeAsk({ bill: { whatFor: 'Power', amount_c: 6000 } }).body).toBe('Whoever has the link can’t use it, and the bill that went with it is withdrawn.');
        expect(inviteRevokeAsk({}).body).toBe('Whoever has the link can’t use it.');
        expect(inviteRevokeAsk({ namesEntryId: 'e1' }, 'Dee').body).toBe('Whoever has the link can’t use it. Dee’s name stays on the names list, not confirmed.');
    });
});

describe('the sender\'s line while nobody has joined with the invite', () => {
    const day = (iso: string) => iso.slice(0, 10);
    const base = { payerName: '', whatFor: 'Power, October', amount_c: 6000, sentAt: '2026-11-15T00:00:00.000Z', paidAt: null };
    it('says it waits for them to join, never "A member"', () => {
        expect(billSentLine({ ...base, state: 'sent', awaitingJoin: true }, day)).toBe('With an invite · Power, October · 60 Beans · waiting for them to join');
    });
    it('once withdrawn or expired with its invite, the usual line; joined, the payer\'s name', () => {
        expect(billSentLine({ ...base, state: 'withdrawn', awaitingJoin: true }, day)).toBe('A member · Power, October · 60 Beans · withdrawn');
        expect(billSentLine({ ...base, state: 'expired', awaitingJoin: true }, day)).toBe('A member · Power, October · 60 Beans · expired, not paid');
        expect(billSentLine({ ...base, payerName: 'Kim', state: 'sent' }, day)).toBe('Kim · Power, October · 60 Beans · sent 2026-11-15 · not paid');
    });
});
