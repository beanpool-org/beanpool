/**
 * "What people who give credit see" on the web's own Ledger, the whole page rendered for real (scratch/fable-design/
 * DESIGN-credit-list-amend-fable.md §5.4; amendment 2 §0 item 20; slice C6; DESIGN-credit-list-fable.md tests 15 and 22), as
 * the phone's (apps/native utils/__tests__/credit-me-ledger-screen.test.ts). The node client is the one lib/api `request`; what
 * the web SENT is recorded and what it DREW comes from the answer alone, through core's creditMeCard. Nothing here contacts a node.
 */
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { creditMeCard, type CreditMeAnswer } from '@beanpool/core';
import { LedgerPage } from './LedgerPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getBalance, request } from '../lib/api';
import { forgetRecentLookups } from '../lib/members-on-demand';
import { resetReaderFeaturesOnce } from '../lib/features';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../components/CommonsInfoModal', () => ({ CommonsInfoModal: () => null }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/api', () => ({
    getBalance: vi.fn(),
    getMyVouching: vi.fn(async () => null),
    getTransactions: vi.fn(async () => []),
    getMembers: vi.fn(async () => []),
    getMemberCards: vi.fn(async () => []),
    sendTransfer: vi.fn(),
    saveHomePreferences: vi.fn(async () => ({ success: true })),
    getCommunityMe: vi.fn(async () => ({ features: null })),
    request: vi.fn(),
}));
vi.mock('../lib/identity', async (orig) => ({
    ...(await orig<typeof import('../lib/identity')>()),
    loadIdentity: vi.fn(async () => ({ publicKey: 'viewer-pubkey', privateKey: 'viewer-private-key', callsign: 'Ana', createdAt: '2026-09-17T00:00:00.000Z' })),
}));
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ profile: 'local', features: { beans: true } })),
    resetCommunityInfoOnce: vi.fn(),
}));

const identity: BeanPoolIdentity = { publicKey: 'viewer-pubkey', privateKey: 'viewer-private-key', callsign: 'Ana', createdAt: '2026-09-17T00:00:00.000Z' };

const node = vi.hoisted(() => ({ me: null as unknown, refuse: null as null | { status: number; message: string }, offline: false }));
const ANSWER = (over: Partial<CreditMeAnswer> = {}): CreditMeAnswer & Record<string, unknown> => ({
    memberPubkey: 'viewer-pubkey', callsign: 'Ana', own: false, owed_c: 42000, over_c: 0, paused: false,
    line_c: 130000, usable_c: 130000, liveOffers: 1, balance_c: -42000, canGive: true, status: 'active',
    risk: { level: 'medium', more: true, reasons: [{ code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 90000, line: 100000, pct: 50, gift: 90000, giftDays: 30 } }] },
    ...over,
});
/** The credit-sight routes asked of the node. The Credit line tab's own offer (/api/credit/gift, slice G1) is another feature's. */
const credit = () => vi.mocked(request).mock.calls.filter(([, p]) => (String(p).startsWith('/api/credit') && String(p) !== '/api/credit/gift') || String(p).startsWith('/api/vouchers/ask'));

beforeEach(() => {
    vi.clearAllMocks();
    forgetRecentLookups();
    resetReaderFeaturesOnce();
    node.me = ANSWER();
    node.refuse = null;
    node.offline = false;
    vi.mocked(communityInfoOnce).mockResolvedValue({ profile: 'local', features: { beans: true } } as never);
    vi.mocked(getBalance).mockResolvedValue({ balance_c: -42000, earnedCredit_c: 200, floor_c: -130000, commonsBalance_c: 0, callsign: 'Ana', tier: { name: 'Newcomer' } } as any);
    vi.mocked(request).mockImplementation(async (_method: string, path: string) => {
        if (path === '/api/credit/me') {
            if (node.offline) throw new TypeError('Failed to fetch');
            if (node.refuse) throw Object.assign(new Error(node.refuse.message), { status: node.refuse.status });
            return { told: 'x', me: node.me };
        }
        throw Object.assign(new Error('not found'), { status: 404 });
    });
});
afterEach(() => { vi.restoreAllMocks(); });

const card = () => screen.queryByTestId('credit-seen-by-givers');
const openLedger = async (props: Record<string, unknown> = {}) => {
    render(<LedgerPage identity={identity} isMember={true} {...props} />);
    await waitFor(() => expect(getBalance).toHaveBeenCalled());
};

describe('a community that trades in Beans: the member\'s own Ledger', () => {
    it('asks the node once for what givers see, on the Levels tab, and draws core\'s card in its order (red when a line moves or a sentence is composed in the app)', async () => {
        await openLedger();
        const c = await screen.findByTestId('credit-seen-by-givers');
        expect(credit().map(([m, p]) => `${m} ${p}`)).toEqual(['GET /api/credit/me']);
        const expected = creditMeCard(ANSWER());
        const body = c.textContent!;
        // Word for word, in this order: title, credit line, live Offers, balance, risk word, each reason, the told sentence.
        const lines = [expected.title, expected.credit, expected.liveOffers!, expected.balance, expected.word, ...expected.reasons, expected.told];
        let at = -1;
        for (const line of lines) {
            const next = body.indexOf(line, at + 1);
            expect(next, `"${line}" is in the card, after the one before it`).toBeGreaterThan(at);
            at = next;
        }
        // The word has its shape beside it (its own span, spaced by the chip), never colour alone.
        const word = within(c).getByTestId('credit-risk-word');
        expect(word.getAttribute('data-level')).toBe(expected.level);
        expect(word.textContent).toBe(`${expected.shape}${expected.word}`);
        expect(body).toContain('What people who give credit see');
        expect(body).toContain('Balance −420 · using 420 of 1,300');
        expect(body).toContain('By their own trading they would owe 900 of 1,000: more than half. A gift of Beans paid 900 of it in the last 30 days.');
        expect(body).toContain('An owner or admin can say more.');
        expect(body).toContain('People who give credit here (the owners, admins and vouchers) can see your balance and your credit line, and each look is recorded.');
        expect(body).not.toContain('They owe');
        // And it sits with the trust figures on the Levels tab, not on the Wallet.
        expect(screen.getByTestId('trust-builders').compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        fireEvent.click(await screen.findByRole('button', { name: /Wallet/ }));
        expect(card()).toBeNull();
    });

    it('draws only the voucher\'s answer: parts, who stands behind and a freeze in an answer are not drawn (red when the card reads what a voucher is not told)', async () => {
        node.me = {
            ...ANSWER({ risk: { level: 'low', more: true, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] } }),
            parts: { known_c: 100000, room_c: 20000, earned_c: 10000, granted_c: 0, cap_c: 200000 },
            standsBehind: { confirmedBy: { memberPubkey: 'k', callsign: 'zedmin', at: '2026-11-01' }, vouchedBy: [{ memberPubkey: 'j', callsign: 'olivia', amount_c: 10000 }] },
            frozen: { credit: true, known: false },
        };
        await openLedger();
        const body = (await screen.findByTestId('credit-seen-by-givers')).textContent!;
        for (const leak of ['Made of', 'known floor', 'zedmin', 'olivia', 'Confirmed by', 'Vouched by', 'froze', 'frozen']) expect(body).not.toContain(leak);
        expect(body).toContain('Credit risk: low');
    });

    it.each([
        ['a node with Beans off (404)', 404, 'Beans are off here.'],
        ['an unsigned request (401)', 401, 'Sign this request with your member key.'],
        ['a refusal (403)', 403, 'Not a member of this community.'],
        ['a node that is down (500)', 500, 'try again later'],
    ])('%s: nothing is drawn, and no error either (red when a refusal reaches the page as a card or a message)', async (_n, status, message) => {
        node.refuse = { status, message };
        await openLedger();
        await waitFor(() => expect(credit()).toHaveLength(1));
        await act(async () => {});
        expect(card()).toBeNull();
        expect(document.body.textContent).not.toContain('What people who give credit see');
        expect(document.body.textContent).not.toContain('Credit risk');
        expect(document.body.textContent).not.toContain(message);
    });

    it('no connection: nothing is drawn and the page stands (red when an offline read throws into the page)', async () => {
        node.offline = true;
        await openLedger();
        await waitFor(() => expect(credit()).toHaveLength(1));
        await act(async () => {});
        expect(card()).toBeNull();
        expect(document.body.textContent).not.toContain('Failed to fetch');
        expect(screen.getByTestId('trust-builders')).toBeTruthy();
    });

    it('keeps nothing: no localStorage, sessionStorage or cache write holds a figure or a word of the card (red when the answer is cached for offline)', async () => {
        const writes: string[] = [];
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => { writes.push(`${k}=${v}`); });
        node.me = ANSWER({ balance_c: -43713 });
        await openLedger();
        expect((await screen.findByTestId('credit-seen-by-givers')).textContent).toContain('437.13');
        const written = writes.join('\n');
        for (const piece of ['43713', '437.13', 'Credit risk', 'credit line', 'over_half', '/api/credit/me']) expect(written).not.toContain(piece);
    });
});

describe('where it is not asked for', () => {
    it('in preview (Example Valley) the page asks the node nothing about credit and draws no card (red when the card is asked for outside a live Beans community)', async () => {
        render(<LedgerPage identity={identity} isMember={true} preview={true} />);
        await act(async () => {});
        expect(credit()).toEqual([]);
        expect(card()).toBeNull();
    });

    it('the worldwide community and a node whose Beans are off are not asked (red when only the node\'s 404 stands between the web and the question)', async () => {
        for (const info of [{ profile: 'global', features: { beans: true } }, { profile: 'local', features: { beans: false } }]) {
            vi.mocked(communityInfoOnce).mockResolvedValue(info as never);
            vi.mocked(request).mockClear();
            const { unmount } = render(<LedgerPage identity={identity} isMember={true} />);
            await waitFor(() => expect(getBalance).toHaveBeenCalled());
            await act(async () => {});
            expect(credit(), JSON.stringify(info)).toEqual([]);
            expect(card()).toBeNull();
            unmount();
        }
    });

    it('a guest (not a member of this node) is not asked either', async () => {
        render(<LedgerPage identity={identity} isMember={false} />);
        await act(async () => {});
        expect(credit()).toEqual([]);
        expect(card()).toBeNull();
    });
});

describe('what the card is made of (red when the web grows its own copy of a sentence or a store)', () => {
    /** A source file's code, without its comments (a comment may name what the code does not use). */
    const src = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('the component draws core\'s creditMeCard and composes no reason, balance or credit sentence itself', () => {
        const s = src('components/CreditSeenByGivers.tsx');
        expect(s).toContain('creditMeCard');
        for (const own of ['riskReasonSentence', 'balanceSentence', 'creditLineSentence', 'position(']) expect(s, own).not.toContain(own);
    });

    it('the credit answer lives in the component\'s state only: no localStorage, sessionStorage, IndexedDB or cache', () => {
        const s = src('components/CreditSeenByGivers.tsx') + src('lib/credit-sight.ts');
        for (const store of ['localStorage', 'sessionStorage', 'indexedDB', 'caches.', 'idb']) expect(s, store).not.toContain(store);
    });
});
