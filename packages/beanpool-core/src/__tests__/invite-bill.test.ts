/**
 * A bill with an invite (scratch/fable-design/DESIGN-getting-paid-fable.md §4.5, slice B3): the invite panel's fold, the
 * share sentence (one sentence, no amount), what the invite's row says it carries, Revoke's confirm, and the sender's line
 * while nobody has joined with it. Both apps draw these from here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { billLines, billSentLine, billsOn, inviteBillAfter, inviteBillAnswerOf, inviteBillFromForm, inviteBillLines, inviteBillToSend, type InviteBillHeld } from '../bills.js';
import { inviteShareText } from '../invite-share-text.js';
import { inviteCarries, inviteRevokeAsk } from '../invite-rows.js';
import { setLanguage, t } from '../words.js';

afterEach(() => setLanguage('en'));

describe('billsOn: only where the node says bills are on', () => {
    it('true only for `bills: true`', () => {
        expect(billsOn({ bills: true })).toBe(true);
        for (const f of [undefined, null, {}, { bills: false }, { bills: 'true' }, { bills: 1 }]) expect(billsOn(f as { bills?: unknown } | null | undefined)).toBe(false);
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

describe('inviteBillToSend: a bill goes only from an open fold, and its id belongs to one exact bill', () => {
    const ids = () => { let n = 0; return () => `id-${++n}`; };
    const open = (whatFor: string, beans: string) => ({ open: true, whatFor, beans });
    it('a closed (or hidden) fold sends no bill and shows no refusal, whatever its boxes hold; the id held stays as it was', () => {
        const held: InviteBillHeld = { key: 'k', id: 'kept' };
        for (const [whatFor, beans] of [['Bread', '12'], ['', '5'], ['ab', ''], ['', '']]) {
            expect(inviteBillToSend({ open: false, whatFor, beans }, held, ids())).toEqual({ bill: null, error: null, held });
            expect(inviteBillToSend({ open: false, whatFor, beans }, null, ids())).toEqual({ bill: null, error: null, held: null });
        }
    });
    it('open: empty is no bill; half-typed is the fold\'s own refusal and nothing to send', () => {
        expect(inviteBillToSend(open('', ''), null, ids())).toEqual({ bill: null, error: null, held: null });
        expect(inviteBillToSend(open('', '5'), null, ids())).toEqual({ bill: null, error: billLines.badWhatFor(), held: null });
        expect(inviteBillToSend(open('Bread', ''), null, ids())).toEqual({ bill: null, error: billLines.badAmount(), held: null });
    });
    it('the same bill again keeps its id (a retry); a change to either box is a new id, and so is a change back after another bill went', () => {
        const next = ids();
        const first = inviteBillToSend(open('Bread', '12'), null, next);
        expect(first.bill).toEqual({ whatFor: 'Bread', amount_c: 1200, id: 'id-1' });
        // As the node stores it: spaces and a written-out .00 are the same bill.
        expect(inviteBillToSend(open('  Bread ', '12.00'), first.held, next).bill?.id).toBe('id-1');
        const priced = inviteBillToSend(open('Bread', '15'), first.held, next);
        expect(priced.bill).toEqual({ whatFor: 'Bread', amount_c: 1500, id: 'id-2' });
        expect(inviteBillToSend(open('Rye bread', '15'), priced.held, next).bill?.id).toBe('id-3');
        expect(inviteBillToSend(open('Bread', '12'), priced.held, next).bill?.id).toBe('id-4');
    });
});

describe('inviteBillAnswerOf and inviteBillAfter: what the member reads when no invite came back with a bill', () => {
    const held: InviteBillHeld = { key: '1200 Bread', id: 'id-1' };
    it('a 4xx in the node\'s words is a refusal (nothing written); anything else is lost: nobody knows', () => {
        expect(inviteBillAnswerOf(429, 'Too many today.', 'bills_new_people_day')).toEqual({ kind: 'refused', words: 'Too many today.', code: 'bills_new_people_day' });
        expect(inviteBillAnswerOf(403, 'Paused.', undefined)).toEqual({ kind: 'refused', words: 'Paused.', code: null });
        for (const [status, words, unsaid] of [[null, null, false], [500, 'Internal error', false], [502, 'Bad Gateway', true], [429, 'Too Many Requests', true], [400, '', false], [200, null, false]] as const) {
            expect(inviteBillAnswerOf(status, words, undefined, unsaid)).toEqual({ kind: 'lost' });
        }
    });
    it('lost: never "nothing was made"; the same id is kept so the same bill again finds out; no offline ticket', () => {
        const after = inviteBillAfter(held, { kind: 'lost' });
        expect(after).toEqual({ held, title: t('No answer'), words: inviteBillLines.answerLost() });
        expect(after.words).not.toMatch(/nothing was (made|sent)/i);
        expect(after.words).toContain("it isn't known whether the invite was made");
        expect(after.words).toContain("A bill can't go with an offline ticket.");
    });
    it('refused: the node\'s words; a bill\'s code under "Could not add the bill"; the id dropped only when the node says it is spent', () => {
        expect(inviteBillAfter(held, { kind: 'refused', words: 'Limit.', code: 'bills_new_people_day' })).toEqual({ held, title: t('Could not add the bill'), words: 'Limit.' });
        expect(inviteBillAfter(held, { kind: 'refused', words: 'Bad amount.', code: 'bill_amount' })).toEqual({ held, title: t('Could not add the bill'), words: 'Bad amount.' });
        expect(inviteBillAfter(held, { kind: 'refused', words: 'Used.', code: 'bill_id_reused' })).toEqual({ held: null, title: t('Could not add the bill'), words: 'Used.' });
        expect(inviteBillAfter(held, { kind: 'refused', words: 'Paused.', code: null })).toEqual({ held, title: t('Invite not made'), words: 'Paused.' });
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
