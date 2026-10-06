import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UnclaimedCard } from './UnclaimedCard';
import { CLAIM_COMMAND } from '../../lib/node-claim';

vi.mock('../../lib/qr', () => ({
    generateOfflineQrUrl: (text: string) => `data:text/plain,${encodeURIComponent(text)}`,
}));

describe('UnclaimedCard', () => {
    it('renders heading, claim command, and QR code when address list is empty', () => {
        render(<UnclaimedCard codeId="c123" origin="http://localhost:3000" />);

        expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('This community has no owner yet.');
        expect(screen.getByTestId('claim-command')).toHaveTextContent(CLAIM_COMMAND);
        expect(screen.getByTestId('claim-qr')).toBeInTheDocument();
        expect(screen.getByTestId('claim-origin')).toHaveTextContent('http://localhost:3000');
        expect(screen.queryByTestId('claim-unlisted-notice')).toBeNull();
    });

    it('renders QR code when the page origin matches listed addresses', () => {
        render(
            <UnclaimedCard
                codeId="c123"
                origin="https://town.beanpool.org"
                primaryAddress="town.beanpool.org"
                addresses={['town.beanpool.org']}
            />,
        );

        expect(screen.getByTestId('claim-qr')).toBeInTheDocument();
        expect(screen.getByTestId('claim-origin')).toHaveTextContent('https://town.beanpool.org');
        expect(screen.queryByTestId('claim-unlisted-notice')).toBeNull();
    });

    it('renders redirect notice when page origin is unlisted and a primary candidate address exists', () => {
        render(
            <UnclaimedCard
                codeId="c123"
                origin="http://localhost:3000"
                primaryAddress="town.beanpool.org"
                addresses={['town.beanpool.org']}
            />,
        );

        expect(screen.queryByTestId('claim-qr')).toBeNull();
        const notice = screen.getByTestId('claim-unlisted-notice');
        expect(notice).toHaveTextContent('Open this page at https://town.beanpool.org to scan.');
    });

    it('falls back to window.location.origin when propOrigin is omitted', () => {
        render(<UnclaimedCard codeId="c456" />);

        expect(screen.getByTestId('claim-origin')).toHaveTextContent(window.location.origin);
    });
});
