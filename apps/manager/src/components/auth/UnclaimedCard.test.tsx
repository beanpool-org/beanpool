import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UnclaimedCard } from './UnclaimedCard';
import { CLAIM_COMMAND } from '../../lib/node-claim';

vi.mock('../../lib/qr', () => ({
    generateOfflineQrUrl: (text: string) => `data:text/plain,${encodeURIComponent(text)}`,
}));

describe('UnclaimedCard', () => {
    // The one claim path (DESIGN-new-operator-path-fable.md S4): the phone's two routes by the phone's own labels, the claim
    // is the phone's, and the QR carries the address only. Find a community is no way in from a local community.
    it("names the phone's two routes, says the claim is the phone's, and that the QR carries no code", () => {
        render(<UnclaimedCard codeId="c123" origin="https://town.beanpool.org" />);
        const steps = screen.getByTestId('claim-phone-steps');
        expect(steps).toHaveTextContent('Claiming is done from the phone app only.');
        expect(steps).toHaveTextContent('Installed BeanPool on a server? Claim it');
        expect(steps).toHaveTextContent('tap the bean at the top, then Set up a new community server');
        expect(screen.getByTestId('claim-card')).not.toHaveTextContent('Find a community');
        expect(screen.getByTestId('claim-qr-no-code')).toHaveTextContent("This QR code carries this server's address and the waiting code's short name, never the code itself: the code is read on the server.");
    });

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
