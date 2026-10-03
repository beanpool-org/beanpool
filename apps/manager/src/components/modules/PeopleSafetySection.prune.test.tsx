/**
 * People & Safety > Triage & Moderation > Prune Stale Posts, against a node that takes at most 200 post ids per
 * bulk-delete request (MAX_BULK_DELETE_POSTS in apps/server/src/routes/admin.ts).
 *
 * Its own file so the post list beside it can be stubbed: PostModerationPanel renders every post it is given, and
 * 950 rows in jsdom take seconds, which is not what these tests are about.
 */
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PeopleSafetySection } from './PeopleSafetySection';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('./PostModerationPanel', () => ({ PostModerationPanel: () => null }));

const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Test Node',
    url: 'https://test-node.local',
    adminPassword: 'admin-password',
};

const stale = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `old_${i}`, createdAt: '2020-01-01T00:00:00Z', title: `Old ${i}` }));
const bulkCalls = (fetchMock: any) =>
    fetchMock.mock.calls.filter(([u]: [string]) => String(u).includes('/api/local/admin/posts/bulk-delete'));
const sizesOf = (calls: any[]) => calls.map(([, init]: any) => JSON.parse(init.body).postIds.length);

function renderPrune(posts: any[], onRefresh = vi.fn()) {
    render(
        <PeopleSafetySection
            activeNode={mockProfile}
            // `reports: []` so the moderation loader never fires: the bulk delete is then the only request made.
            nodeData={{ reports: [], members: [], posts } as any}
            nodeDataLoading={false}
            onRefresh={onRefresh}
            onFreezeUser={vi.fn()}
            onPruneUser={vi.fn()}
            onUpdateTier={vi.fn()}
            onToggleVoucher={vi.fn()}
            onToggleOperator={vi.fn()}
            initialSubTab="moderation"
        />
    );
    return onRefresh;
}

/** The route's success answer for the batch it was sent. */
const okBatch = (init: any) => ({
    ok: true, status: 200,
    json: async () => {
        const n = JSON.parse(init.body).postIds.length;
        return { success: true, deleted: n, deletedCount: n };
    },
});

const prune = async () => {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Prune Stale Posts' })); });
};

describe('Prune Stale Posts sends batches of at most 200, one after another', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('0 stale posts: no request, says none were found, no refresh', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('confirm', vi.fn(() => true));
        const onRefresh = renderPrune([{ id: 'new', createdAt: new Date().toISOString() }]);
        await prune();
        expect(bulkCalls(fetchMock)).toHaveLength(0);
        expect(screen.getByText('No posts older than 30 days found.')).toBeInTheDocument();
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it.each([
        [1, [1]],
        [200, [200]],
        [201, [200, 1]],
        [950, [200, 200, 200, 200, 150]],
    ])('%i stale posts: batches %j, the counts added up, one refresh at the end', async (n, sizes) => {
        let inFlight = 0, maxInFlight = 0;
        const fetchMock = vi.fn(async (_u: string, init: any) => {
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(r => setTimeout(r, 1));
            inFlight--;
            return okBatch(init);
        });
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('confirm', vi.fn(() => true));
        const onRefresh = renderPrune(stale(n));
        await prune();
        await waitFor(() => expect(screen.getByText(`Deleted ${n} post(s).`)).toBeInTheDocument());
        const calls = bulkCalls(fetchMock);
        expect(calls).toHaveLength(sizes.length);
        expect(sizesOf(calls)).toEqual(sizes);
        expect(sizesOf(calls).every((s: number) => s <= 200)).toBe(true);
        // Every stale id sent exactly once, in order, with the admin headers.
        expect(calls.flatMap(([, init]: any) => JSON.parse(init.body).postIds)).toEqual(stale(n).map(p => p.id));
        expect(calls.every(([, init]: any) => init.method === 'POST' && init.headers['X-Admin-Password'] === 'admin-password')).toBe(true);
        // Never in parallel.
        expect(maxInFlight).toBe(1);
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it("a failing 3rd batch of 950 stops there: 'Deleted 400 of 950, then: <reason>', and refreshes once", async () => {
        let call = 0;
        const fetchMock = vi.fn(async (_u: string, init: any) => {
            if (++call === 3) return { ok: false, status: 503, json: async () => ({ error: 'The Commons pot is unknown', code: 'POT_UNKNOWN' }) };
            return okBatch(init);
        });
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('confirm', vi.fn(() => true));
        const onRefresh = renderPrune(stale(950));
        await prune();
        await waitFor(() => expect(screen.getByText('Deleted 400 of 950, then: The Commons pot is unknown')).toBeInTheDocument());
        expect(sizesOf(bulkCalls(fetchMock))).toEqual([200, 200, 200]);
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('a failing first batch reads "Failed: <reason>", sends nothing more and refreshes nothing', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) });
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('confirm', vi.fn(() => true));
        const onRefresh = renderPrune(stale(950));
        await prune();
        await waitFor(() => expect(screen.getByText('Failed: Unauthorized')).toBeInTheDocument());
        expect(bulkCalls(fetchMock)).toHaveLength(1);
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it('cancelling the confirm sends nothing', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('confirm', vi.fn(() => false));
        renderPrune(stale(950));
        await prune();
        expect(bulkCalls(fetchMock)).toHaveLength(0);
    });
});
