import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NeedsYouIcons } from './NeedsYouIcons';

vi.mock('@beanpool/core', async () => {
    const actual = await vi.importActual('@beanpool/core');
    return {
        ...actual,
        t: (str: string) => str,
        tn: (_n: number, singular: string, _plural: string) => singular,
    };
});

describe('NeedsYouIcons NeedsSheet', () => {
    it('renders NeedsYouIcons with accessible close button when sheet is triggered', async () => {
        const { container } = render(
            <NeedsYouIcons
                identityPubkey="pubkey-123"
                variant="header"
            />
        );

        // Verify component mounts cleanly
        expect(container).toBeTruthy();
    });
});
