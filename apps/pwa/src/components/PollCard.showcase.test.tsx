/**
 * A poll where Decisions live in a local community (DESIGN-global-showcase-fable.md §1 row 7): the 🏘️ line under the
 * note, once, and its sheet offers every way forward (§2). On a node that shows no previews, or has Decisions on, no line.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_COMMUNITY_LINES, LOCAL_COMMUNITY_SHEET } from '@beanpool/core';

vi.mock('../lib/identity', () => ({ loadIdentity: async () => null }));

import { PollCard } from './PollCard';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { resetReaderFeaturesOnce } from '../lib/features';

const POLL = {
    id: 'post_poll_showcase', type: 'poll', category: 'community', title: 'Where should the noticeboard go?', description: '',
    authorPublicKey: 'author_pubkey_1', authorCallsign: 'Alice', createdAt: new Date().toISOString(), status: 'active', active: true,
    credits: 0, priceType: 'fixed', repeatable: false,
    pollOptions: [{ id: 'opt_1', text: 'By the shop', votes: 1, percentage: 100 }],
    pollClosesAt: new Date(Date.now() + 86_400_000).toISOString(), totalVotes: 1,
} as any;

let features: Record<string, unknown> = {};

beforeEach(() => {
    resetCommunityInfoOnce();
    resetReaderFeaturesOnce();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'A community', features }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
    })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the poll\'s 🏘️ line', () => {
    it('Decisions off and the node shows previews: the line, whose sheet offers Start, Communities near you and How it works', async () => {
        features = { decisions: false, showcase: true };
        const onNearYou = vi.fn();
        const onGuide = vi.fn();
        render(<PollCard post={POLL} visitor localWays={{ onNearYou, onGuide }} />);
        const line = await screen.findByTestId('local-community-line');
        expect(line.textContent).toBe(LOCAL_COMMUNITY_LINES.poll);
        expect(screen.getAllByTestId('local-community-line')).toHaveLength(1);
        fireEvent.click(line);
        expect(screen.getByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.decisions);
        expect(screen.getByTestId('local-community-start')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('local-community-guide'));
        expect(onGuide).toHaveBeenCalledWith(LOCAL_COMMUNITY_SHEET.guide.decisions);
        fireEvent.click(line);
        fireEvent.click(screen.getByTestId('local-community-near-you'));
        expect(onNearYou).toHaveBeenCalledTimes(1);
    });

    it('no showcase (a local node with Decisions off, or a server from before it), or Decisions on: no line', async () => {
        for (const f of [{ decisions: false }, { decisions: false, showcase: false }, { decisions: true, showcase: true }, {}]) {
            resetCommunityInfoOnce();
            features = f;
            const fetchMock = vi.mocked(fetch);
            const before = fetchMock.mock.calls.length;
            const { unmount } = render(<PollCard post={POLL} visitor />);
            await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
            await new Promise((r) => setTimeout(r, 0));
            expect(screen.queryByTestId('poll-decision-line')).toBeNull();
            unmount();
        }
    });
});
