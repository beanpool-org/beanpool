import { describe, it, expect, vi, beforeEach } from 'vitest';
import { askMyVouching, vouchFromProfile } from '../vouchers';

const signedGets = vi.hoisted(() => ({ calls: [] as any[], res: null as any }));
const signedPosts = vi.hoisted(() => ({ calls: [] as any[], res: null as any }));

vi.mock('../node-post', () => ({
    signedGet: vi.fn(async (anchor: string, path: string, identity: any) => {
        signedGets.calls.push({ anchor, path, identity });
        return signedGets.res;
    }),
    signedPost: vi.fn(async (anchor: string, path: string, body: any, identity: any) => {
        signedPosts.calls.push({ anchor, path, body, identity });
        return signedPosts.res;
    }),
}));

const ID = {
    publicKey: 'a'.repeat(64),
    privateKey: 'b'.repeat(64),
    callsign: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
};
const ANCHOR = 'https://node.test';

describe('Native vouchers utils (slice V3)', () => {
    beforeEach(() => {
        signedGets.calls = [];
        signedPosts.calls = [];
        signedGets.res = null;
        signedPosts.res = null;
    });

    it('askMyVouching returns parsed budget data from /api/vouchers/me', async () => {
        signedGets.res = {
            ok: true,
            json: async () => ({
                voucher: true,
                budget: { left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 1000 },
                presets: [25, 50, 75, 100],
                vouchMax: 100,
                budgetMax: 2000,
                vouchedBy: [],
            }),
        };

        const res = await askMyVouching(ANCHOR, ID);
        expect(res).toBeTruthy();
        expect(res?.voucher).toBe(true);
        expect(res?.budget?.left).toBe(550);
        expect(signedGets.calls[0].path).toBe('/api/vouchers/me');
    });

    it('vouchFromProfile posts memberPubkey, vouchAmount, and raise to /api/vouch', async () => {
        signedPosts.res = {
            ok: true,
            json: async () => ({
                id: 'gift-1',
                memberPubkey: 'target-pk',
                amount: 50,
                total: 50,
                budget: { left: 500 },
            }),
        };

        const res = await vouchFromProfile(ANCHOR, ID, {
            memberPubkey: 'target-pk',
            vouchAmount: 50,
            raise: true,
        });

        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.amount).toBe(50);
            expect(res.id).toBe('gift-1');
        }
        expect(signedPosts.calls[0].body).toEqual({
            memberPubkey: 'target-pk',
            vouchAmount: 50,
            raise: true,
        });
    });

    it('vouchFromProfile returns node refusal sentence when server refuses', async () => {
        signedPosts.res = {
            ok: false,
            json: async () => ({
                error: '@sam is below zero: a credit-line gift or a Decision can help.',
                code: 'below_zero',
            }),
        };

        const res = await vouchFromProfile(ANCHOR, ID, {
            memberPubkey: 'target-pk',
            vouchAmount: 25,
        });

        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.message).toBe('@sam is below zero: a credit-line gift or a Decision can help.');
        }
    });

    it('vouchFromProfile preserves error code on failure', async () => {
        signedPosts.res = {
            ok: false,
            json: async () => ({
                error: 'You’ve already vouched for @Sam.',
                code: 'already_vouched',
            }),
        };

        const res = await vouchFromProfile(ANCHOR, ID, {
            memberPubkey: 'target-pk',
            vouchAmount: 25,
        });

        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.code).toBe('already_vouched');
            expect(res.message).toBe('You’ve already vouched for @Sam.');
        }
    });

    it('vouchFromProfile preserves prior vouch amount on failure', async () => {
        signedPosts.res = {
            ok: false,
            json: async () => ({
                error: 'You’ve already vouched for @Sam.',
                code: 'already_vouched',
                prior: 25,
            }),
        };

        const res = await vouchFromProfile(ANCHOR, ID, {
            memberPubkey: 'target-pk',
            vouchAmount: 25,
        });

        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.code).toBe('already_vouched');
            expect(res.prior).toBe(25);
        }
    });
});
