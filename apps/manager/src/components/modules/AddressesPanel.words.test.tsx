import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { pseudoLocalise } from '@beanpool/core';
import { AddressesPanel, appsTodayText, formatRelativeTime } from './AddressesPanel';
import type { NodeProfile } from '../../lib/profiles';

/**
 * The Addresses screen through the pseudo-language: English and a sentence typed past the words layer read the same, so
 * only here does one show. The fake catalogue is the words layer's own.
 */
vi.mock('../../lib/fresh-proof', async () => {
    const actual = await vi.importActual<typeof import('../../lib/fresh-proof')>('../../lib/fresh-proof');
    const { wordsFor, PSEUDO_LANG } = await vi.importActual<typeof import('@beanpool/core')>('@beanpool/core');
    const { t, tn, timeAgo } = wordsFor(PSEUDO_LANG);
    return { ...actual, t, tn, timeAgo };
});

const node: NodeProfile = { id: 'n1', name: 'Byron', url: 'http://localhost:8080', automationToken: 'pw' };
const checkedAt = '2026-11-02T05:02:00.000Z';
const report = {
    primaryAddress: 'byron.beanpool.org', named: true, unconfirmed: [], heldBack: [],
    unboundSignaturesUntil: null, unboundSignaturesAccepted: false,
    addresses: [
        { address: 'byron.beanpool.org', source: 'public-address', today: 14, busiestDay: 28 },
        { address: 'old.beanpool.org', source: 'registrar', former: true, today: 1, busiestDay: 2 },
        { address: 'gone.beanpool.org', source: 'registrar', former: true, lost: true, today: 0, busiestDay: 0 },
        { address: '203.0.113.5', source: 'owner', today: 3, busiestDay: 5, reach: { answers: 'silence', dns: null, step: 'no-answer', minutes: null, nextStep: '', checkedAt, ownAt: null } },
    ],
};

describe('Addresses through the words layer (#2738)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(global, 'fetch').mockImplementation(async (url) => new Response(
            JSON.stringify(String(url).includes('/app-addresses') ? report : { logs: [], names: [], notices: [] }), { status: 200 },
        ));
    });

    it('the apps count and how long ago are read from the words, in both plural forms', () => {
        expect(appsTodayText(1)).toBe(pseudoLocalise('{n} app today').replace('{n}', '1'));
        expect(appsTodayText(14)).toBe(pseudoLocalise('{n} apps today').replace('{n}', '14'));
        expect(formatRelativeTime(checkedAt, Date.parse(checkedAt) + 3 * 60_000)).toBe(pseudoLocalise('{n} minutes ago').replace('{n}', '3'));
        expect(formatRelativeTime(checkedAt, Date.parse(checkedAt) + 2 * 3_600_000)).toBe(pseudoLocalise('{n} hours ago').replace('{n}', '2'));
        expect(formatRelativeTime(checkedAt, Date.parse(checkedAt) + 5_000)).toBe(pseudoLocalise('just now'));
    });

    it('Former, Lost, Release and Remove are the words layer\'s', async () => {
        render(<AddressesPanel activeNode={node} />);
        const former = await screen.findByTestId('address-row-old.beanpool.org');
        expect(within(former).getByText(pseudoLocalise('Former'))).toBeInTheDocument();
        expect(within(former).getByText(pseudoLocalise('Release'))).toBeInTheDocument();
        const lost = screen.getByTestId('address-row-gone.beanpool.org');
        expect(within(lost).getByText(pseudoLocalise('Lost'))).toBeInTheDocument();
        expect(within(screen.getByTestId('address-row-203.0.113.5')).getByText(pseudoLocalise('Remove'))).toBeInTheDocument();
    });
});
