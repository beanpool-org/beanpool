import { describe, it, expect } from 'vitest';
import {
    voucherActorWords,
    formatHistoryDate,
    historyLineWords,
    voucherPanelHeader,
    type VoucherHistoryLine,
} from './voucher-words';

describe('voucher-words', () => {
    describe('voucherActorWords', () => {
        it('returns @callsign when actorCallsign is present', () => {
            expect(voucherActorWords({ actorCallsign: 'alice' })).toBe('@alice');
            expect(voucherActorWords({ actor: 'node:claim', actorCallsign: 'bob' })).toBe('@bob');
        });

        it('returns "the community’s first owner" for claim actors', () => {
            expect(voucherActorWords({ actor: 'node:claim' })).toBe('the community’s first owner');
            expect(voucherActorWords({ actor: 'claim:initial' })).toBe('the community’s first owner');
        });

        it('returns "the server’s shell" for server: actors', () => {
            expect(voucherActorWords({ actor: 'server:recover' })).toBe('the server’s shell');
            expect(voucherActorWords({ actor: 'server:cli' })).toBe('the server’s shell');
        });

        it('returns "BeanPool, when vouchers started" for migration: actors', () => {
            expect(voucherActorWords({ actor: 'migration:vouchers' })).toBe('BeanPool, when vouchers started');
        });

        it('returns "someone who has left" for null, empty, or 64-character hex keys', () => {
            expect(voucherActorWords({})).toBe('someone who has left');
            expect(voucherActorWords({ actor: null })).toBe('someone who has left');
            expect(voucherActorWords({ actor: '' })).toBe('someone who has left');
            expect(voucherActorWords({ actor: '   ' })).toBe('someone who has left');
            const hex64 = 'abcdef0123456789'.repeat(4);
            expect(voucherActorWords({ actor: hex64 })).toBe('someone who has left');
        });

        it('returns "the community’s server" for other system/node actors', () => {
            expect(voucherActorWords({ actor: 'node' })).toBe('the community’s server');
            expect(voucherActorWords({ actor: 'SYSTEM' })).toBe('the community’s server');
        });
    });

    describe('formatHistoryDate', () => {
        it('returns empty string for null, undefined, or empty inputs', () => {
            expect(formatHistoryDate(null)).toBe('');
            expect(formatHistoryDate(undefined)).toBe('');
            expect(formatHistoryDate('')).toBe('');
        });

        it('returns empty string for invalid date strings', () => {
            expect(formatHistoryDate('not-a-date')).toBe('');
        });

        it('formats valid ISO date strings in UTC format "D Mon"', () => {
            expect(formatHistoryDate('2026-11-05T12:00:00.000Z')).toBe('5 Nov');
            expect(formatHistoryDate('2026-01-01T00:00:00.000Z')).toBe('1 Jan');
            expect(formatHistoryDate('2026-12-31T23:59:59.999Z')).toBe('31 Dec');
        });
    });

    describe('historyLineWords', () => {
        const baseLine: VoucherHistoryLine = {
            kind: 'grant',
            amount_c: 100000,
            actor: 'node:claim',
            actorCallsign: null,
            at: '2026-11-05T12:00:00.000Z',
        };

        it('formats grant lines', () => {
            expect(historyLineWords(baseLine)).toBe(
                '+1,000 budget, made a voucher by the community’s first owner, 5 Nov'
            );
            expect(historyLineWords({ ...baseLine, at: '' })).toBe(
                '+1,000 budget, made a voucher by the community’s first owner'
            );
        });

        it('says whole hundredths as Beans to the cent, never 100 times over', () => {
            expect(historyLineWords({ ...baseLine, kind: 'top_up', amount_c: 2550, actorCallsign: 'marty' })).toBe('+25.50 top-up by @marty, 5 Nov');
            expect(historyLineWords({ ...baseLine, kind: 'hold', amount_c: -1, for: 'invite' })).toBe('−0.01 held for an invite, 5 Nov');
            expect(voucherPanelHeader({ left: 49925, level: 100000, source: 'role' })).toBe('Voucher · 499.25 of 1,000 left · by role');
        });

        it('formats top_up lines', () => {
            const line: VoucherHistoryLine = {
                ...baseLine,
                kind: 'top_up',
                amount_c: 50000,
                actorCallsign: 'marty',
            };
            expect(historyLineWords(line)).toBe('+500 top-up by @marty, 5 Nov');
        });

        it('formats lower lines with negative or positive amount using absolute value', () => {
            const line: VoucherHistoryLine = {
                ...baseLine,
                kind: 'lower',
                amount_c: -20000,
                actorCallsign: 'marty',
            };
            expect(historyLineWords(line)).toBe('−200 lower by @marty, 5 Nov');
        });

        it('formats hold lines for invites vs profiles', () => {
            const inviteHold: VoucherHistoryLine = {
                ...baseLine,
                kind: 'hold',
                amount_c: -10000,
                for: 'invite',
            };
            expect(historyLineWords(inviteHold)).toBe('−100 held for an invite, 5 Nov');

            const profileHold: VoucherHistoryLine = {
                ...baseLine,
                kind: 'hold',
                amount_c: -5000,
                for: 'profile',
                person: { memberPubkey: 'abc', callsign: 'sam' },
            };
            expect(historyLineWords(profileHold)).toBe('−50 held for @sam, 5 Nov');

            const profileWithoutPerson: VoucherHistoryLine = {
                ...baseLine,
                kind: 'hold',
                amount_c: -5000,
                for: 'profile',
                person: null,
            };
            expect(historyLineWords(profileWithoutPerson)).toBe('−50 held for an invite, 5 Nov');
        });

        it('formats return lines with reasons (expired, stopped, not_landed, or general)', () => {
            expect(
                historyLineWords({ ...baseLine, kind: 'return', amount_c: 10000, why: 'expired' })
            ).toBe('+100 back, invite expired, 5 Nov');

            expect(
                historyLineWords({ ...baseLine, kind: 'return', amount_c: 10000, why: 'stopped' })
            ).toBe('+100 back, budget stopped, 5 Nov');

            expect(
                historyLineWords({ ...baseLine, kind: 'return', amount_c: 10000, why: 'not_landed' })
            ).toBe('+100 back, vouch didn’t land, 5 Nov');

            expect(
                historyLineWords({ ...baseLine, kind: 'return', amount_c: 10000 })
            ).toBe('+100 back, 5 Nov');
        });

        it('formats stop lines', () => {
            const line: VoucherHistoryLine = {
                ...baseLine,
                kind: 'stop',
                amount_c: 0,
                actor: 'server:recover',
            };
            expect(historyLineWords(line)).toBe('Budget stopped by the server’s shell, 5 Nov');
        });

        it('formats unknown kinds with fallback wording', () => {
            const line: VoucherHistoryLine = {
                ...baseLine,
                kind: 'custom_change',
                amount_c: 5000,
                actorCallsign: 'owner',
            };
            expect(historyLineWords(line)).toBe('Budget changed by @owner, 5 Nov');
        });
    });

    describe('voucherPanelHeader', () => {
        it('formats header for role-sourced vouchers', () => {
            expect(voucherPanelHeader({ left: 55000, level: 100000, source: 'role' })).toBe(
                'Voucher · 550 of 1,000 left · by role'
            );
        });

        // Budget figures are whole hundredths of a Bean, as the node sends them: 30000 is 300 Beans.
        it('an owner’s card says by role; an admin an owner made a voucher does not (review, 10 Nov; I5)', () => {
            expect(voucherPanelHeader({ left: 0, level: 0, source: 'role', noLimit: true })).toBe('Voucher · 0 of 0 left · by role');
            const admin = voucherPanelHeader({ left: 30000, level: 30000, source: 'role', noLimit: false, madeBy: 'f'.repeat(64), madeByCallsign: 'marty' });
            expect(admin).toBe('Voucher · 300 of 300 left · made by @marty');
            expect(admin).not.toMatch(/by role/);
            // Made by the shell or from before vouchers started: the actor's words, never a key.
            expect(voucherPanelHeader({ left: 30000, level: 30000, source: 'role', noLimit: false, madeBy: 'server:recover' })).toBe('Voucher · 300 of 300 left · made by the server’s shell');
            expect(voucherPanelHeader({ left: 30000, level: 30000, source: 'role', noLimit: false, madeBy: 'migration:vouchers' })).toBe('Voucher · 300 of 300 left · made by BeanPool, when vouchers started');
            expect(voucherPanelHeader({ left: 30000, level: 30000, source: 'role', noLimit: false, madeBy: null, madeByCallsign: null })).toBe('Voucher · 300 of 300 left · made by an owner');
            expect(admin).not.toMatch(/[0-9a-f]{64}/);
        });

        it('formats header for entry/names list vouchers', () => {
            expect(voucherPanelHeader({ left: 55000, level: 100000, source: 'entry' })).toBe(
                'Voucher · 550 of 1,000 left · made from the names list'
            );
        });

        it('uses default level of 1000 when level is omitted', () => {
            expect(voucherPanelHeader({ left: 20000 })).toBe(
                'Voucher · 200 of 1,000 left · made from the names list'
            );
        });
    });
});
