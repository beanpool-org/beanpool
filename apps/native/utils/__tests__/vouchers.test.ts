import { describe, it, expect, vi, beforeEach } from 'vitest';
import { askMyVouching, rereadMyVouching, vouchFromProfile } from '../vouchers';

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

    it('vouchFromProfile posts memberPubkey and vouchAmount to /api/vouch', async () => {
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
        });

        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.amount).toBe(50);
            expect(res.id).toBe('gift-1');
        }
        expect(signedPosts.calls[0].path).toBe('/api/vouch');
        expect(signedPosts.calls[0].body).toEqual({
            memberPubkey: 'target-pk',
            vouchAmount: 50,
        });
    });

    it('vouchFromProfile posts a raise as the total it ends at, and reads the difference the node landed (slice I6)', async () => {
        signedPosts.res = {
            ok: true,
            json: async () => ({
                id: 'gift-2',
                memberPubkey: 'target-pk',
                amount: 100,
                total: 200,
                budget: { left: 500 },
            }),
        };

        const res = await vouchFromProfile(ANCHOR, ID, { memberPubkey: 'target-pk', raiseTo: 200 });

        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.amount).toBe(100);
            expect(res.total).toBe(200);
        }
        // The target, never an amount to add, and no retired `raise` flag beside it.
        expect(signedPosts.calls[0].body).toEqual({ memberPubkey: 'target-pk', raiseTo: 200 });
        expect(Object.keys(signedPosts.calls[0].body as object)).not.toContain('raise');
        expect(Object.keys(signedPosts.calls[0].body as object)).not.toContain('vouchAmount');
    });

    it('vouchFromProfile keeps the total a refused raise names, so the card follows it', async () => {
        signedPosts.res = {
            ok: false,
            json: async () => ({ error: 'You’ve vouched 200 Beans for @Sam already. Pick a higher total to raise it to.', code: 'raise_not_above', prior: 200 }),
        };
        const res = await vouchFromProfile(ANCHOR, ID, { memberPubkey: 'target-pk', raiseTo: 200 });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.code).toBe('raise_not_above');
            expect(res.prior).toBe(200);
        }
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

    it('vouchFromProfile leaves prior unset when the node sends none (the apps then guess nothing)', async () => {
        signedPosts.res = { ok: false, json: async () => ({ error: 'You’ve already vouched for @Sam.', code: 'already_vouched' }) };
        const res = await vouchFromProfile(ANCHOR, ID, { memberPubkey: 'target-pk', vouchAmount: 25 });
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.prior).toBeUndefined();
            expect(res.message).toBe('You’ve already vouched for @Sam.');
        }
    });
});

/** #2915 round 4, note 6: a failed re-read after a vouch that landed keeps the card and its banner. */
describe('rereadMyVouching', () => {
    const GOOD = {
        voucher: true,
        budget: { left: 525, held: 100, heldInvites: 1, vouched: 375, peopleVouched: 5, level: 1000 },
        presets: [25, 50, 75, 100],
        vouchMax: 100,
        budgetMax: 2000,
        vouchedBy: [],
    };

    beforeEach(() => {
        signedGets.calls = [];
        signedGets.res = null;
    });

    it('hands the fresh figures over when the read works', async () => {
        signedGets.res = { ok: true, json: async () => GOOD };
        const apply = vi.fn();
        await rereadMyVouching(ANCHOR, ID, apply, 0);
        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(GOOD);
        expect(signedGets.calls).toHaveLength(1);
    });

    it('never hands null over when the read fails, and tries once more quietly', async () => {
        signedGets.res = { ok: false, json: async () => ({}) };
        const apply = vi.fn();
        await rereadMyVouching(ANCHOR, ID, apply, 0);
        expect(apply).not.toHaveBeenCalled();
        expect(signedGets.calls).toHaveLength(2);
    });

    it('a second try that works hands the figures over once', async () => {
        let n = 0;
        const { signedGet } = await import('../node-post');
        vi.mocked(signedGet).mockImplementation(async (anchor: string, path: string, identity: any) => {
            signedGets.calls.push({ anchor, path, identity });
            n += 1;
            return (n === 1 ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => GOOD }) as any;
        });
        const apply = vi.fn();
        await rereadMyVouching(ANCHOR, ID, apply, 0);
        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(GOOD);
        expect(signedGets.calls).toHaveLength(2);
    });

    // The sheet over the credit list says plainly when the budget could not be read (the deciding review of #3096, finding 3).
    describe('onUnread: the screen can say it could not read', () => {
        // The tests above swap signedGet for their own sequence; these read what `signedGets.res` says.
        beforeEach(async () => {
            const { signedGet } = await import('../node-post');
            vi.mocked(signedGet).mockImplementation(async (anchor: string, path: string, identity: any) => {
                signedGets.calls.push({ anchor, path, identity });
                return signedGets.res;
            });
        });

        it('is not called when the read works', async () => {
            signedGets.res = { ok: true, json: async () => GOOD };
            const unread = vi.fn();
            await rereadMyVouching(ANCHOR, ID, vi.fn(), 0, unread);
            expect(unread).not.toHaveBeenCalled();
        });

        it('is called once, as soon as the first read fails (before the quiet second try), and not again when that fails too', async () => {
            signedGets.res = { ok: false, json: async () => ({}) };
            const apply = vi.fn();
            const unread = vi.fn();
            await rereadMyVouching(ANCHOR, ID, apply, 0, unread);
            expect(unread).toHaveBeenCalledTimes(1);
            expect(apply).not.toHaveBeenCalled();
            expect(signedGets.calls).toHaveLength(2);
        });

        it('a second try that works still hands the figures over after it was called', async () => {
            let n = 0;
            const { signedGet } = await import('../node-post');
            vi.mocked(signedGet).mockImplementation(async (anchor: string, path: string, identity: any) => {
                signedGets.calls.push({ anchor, path, identity });
                n += 1;
                return (n === 1 ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => GOOD }) as any;
            });
            const order: string[] = [];
            await rereadMyVouching(ANCHOR, ID, () => order.push('apply'), 0, () => order.push('unread'));
            expect(order).toEqual(['unread', 'apply']);
        });
    });
});
