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
            amount: 1000,
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

        it('formats top_up lines', () => {
            const line: VoucherHistoryLine = {
                ...baseLine,
                kind: 'top_up',
                amount: 500,
                actorCallsign: 'marty',
            };
            expect(historyLineWords(line)).toBe('+500 top-up by @marty, 5 Nov');
        });

        it('formats lower lines with negative or positive amount using absolute value', () => {
            const line: VoucherHistoryLine = {
                ...baseLine,
                kind: 'lower',
                amount: -200,
                actorCallsign: 'marty',
            };
            expect(historyLineWords(line)).toBe('−200 lower by @marty, 5 Nov');
        });

        it('formats hold lines for invites vs profiles', () => {
            const inviteHold: VoucherHistoryLine = {
                ...baseLine,
                kind: 'hold',
                amount: -100,
                for: 'invite',
            };
            expect(historyLineWords(inviteHold)).toBe('−100 held for an invite, 5 Nov');

            const profileHold: VoucherHistoryLine = {
                ...baseLine,
                kind: 'hold',
                amount: -50,
                for: 'profile',
                person: { memberPubkey: 'abc', callsign: 'sam' },
            };
            expect(historyLineWords(profileHold)).toBe('−50 held for @sam, 5 Nov');

            const profileWithoutPerson: VoucherHistoryLine = {
                ...baseLine,
                kind: 'hold',
                amount: -50,
                for: 'profile',
                person: null,
            };
            expect(historyLineWords(profileWithoutPerson)).toBe('−50 held for an invite, 5 Nov');
        });

        it('formats return lines with reasons (expired, stopped, not_landed, or general)', () => {
            expect(
                historyLineWords({ ...baseLine, kind: 'return', amount: 100, why: 'expired' })
            ).toBe('+100 back, invite expired, 5 Nov');

            expect(
                historyLineWords({ ...baseLine, kind: 'return', amount: 100, why: 'stopped' })
            ).toBe('+100 back, budget stopped, 5 Nov');

            expect(
                historyLineWords({ ...baseLine, kind: 'return', amount: 100, why: 'not_landed' })
            ).toBe('+100 back, vouch didn’t land, 5 Nov');

            expect(
                historyLineWords({ ...baseLine, kind: 'return', amount: 100 })
            ).toBe('+100 back, 5 Nov');
        });

        it('formats stop lines', () => {
            const line: VoucherHistoryLine = {
                ...baseLine,
                kind: 'stop',
                amount: 0,
                actor: 'server:recover',
            };
            expect(historyLineWords(line)).toBe('Budget stopped by the server’s shell, 5 Nov');
        });

        it('formats unknown kinds with fallback wording', () => {
            const line: VoucherHistoryLine = {
                ...baseLine,
                kind: 'custom_change',
                amount: 50,
                actorCallsign: 'owner',
            };
            expect(historyLineWords(line)).toBe('Budget changed by @owner, 5 Nov');
        });
    });

    describe('voucherPanelHeader', () => {
        it('formats header for role-sourced vouchers', () => {
            expect(voucherPanelHeader({ left: 550, level: 1000, source: 'role' })).toBe(
                'Voucher · 550 of 1,000 left · by role'
            );
        });

        it('formats header for entry/names list vouchers', () => {
            expect(voucherPanelHeader({ left: 550, level: 1000, source: 'entry' })).toBe(
                'Voucher · 550 of 1,000 left · made from the names list'
            );
        });

        it('uses default level of 1000 when level is omitted', () => {
            expect(voucherPanelHeader({ left: 200 })).toBe(
                'Voucher · 200 of 1,000 left · made from the names list'
            );
        });
    });
});
