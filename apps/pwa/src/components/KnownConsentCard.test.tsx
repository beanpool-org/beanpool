import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { KnownConsentCard } from './KnownConsentCard';
import * as consentLib from '../lib/known-consent';

vi.mock('../lib/known-consent', async () => {
    const actual = await vi.importActual('../lib/known-consent');
    return {
        ...actual,
        fetchMyConsent: vi.fn(),
        agreeToConsent: vi.fn(),
        withdrawConsent: vi.fn(),
    };
});

describe('KnownConsentCard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders nothing if fetchMyConsent returns null or no consent', async () => {
        vi.mocked(consentLib.fetchMyConsent).mockResolvedValue(null);

        const { container } = render(<KnownConsentCard />);
        await waitFor(() => expect(consentLib.fetchMyConsent).toHaveBeenCalled());
        expect(container.firstChild).toBeNull();
    });

    it('renders the consent card with offer buttons and focus-visible classes', async () => {
        const mockConsent: consentLib.KnownConsent = {
            known: true,
            version: '1.0',
            text: 'Admins will see your balance.',
            confirmed: false,
            consentedAt: null,
            consentedVersion: null,
            withdrawnAt: null,
        };
        vi.mocked(consentLib.fetchMyConsent).mockResolvedValue(mockConsent);

        render(<KnownConsentCard />);

        const card = await screen.findByTestId('known-consent-card');
        expect(card).toBeInTheDocument();
        expect(screen.getByText('Admins will see your balance.')).toBeInTheDocument();

        const agreeButton = screen.getByRole('button', { name: 'I agree' });
        const notNowButton = screen.getByRole('button', { name: 'Not now' });

        expect(agreeButton).toHaveClass('focus-visible:ring-2');
        expect(notNowButton).toHaveClass('focus-visible:ring-2');
    });

    it('renders withdraw button with focus-visible classes when consent is already agreed', async () => {
        const mockConsent: consentLib.KnownConsent = {
            known: true,
            version: '1.0',
            text: 'Admins will see your balance.',
            confirmed: true,
            consentedAt: '2026-01-01T00:00:00.000Z',
            consentedVersion: '1.0',
            withdrawnAt: null,
        };
        vi.mocked(consentLib.fetchMyConsent).mockResolvedValue(mockConsent);

        render(<KnownConsentCard />);

        const withdrawButton = await screen.findByTestId('known-consent-withdraw');
        expect(withdrawButton).toBeInTheDocument();
        expect(withdrawButton).toHaveClass('focus-visible:ring-2');
    });

    it('hides card when "Not now" button is clicked', async () => {
        const mockConsent: consentLib.KnownConsent = {
            known: true,
            version: '1.0',
            text: 'Admins will see your balance.',
            confirmed: false,
            consentedAt: null,
            consentedVersion: null,
            withdrawnAt: null,
        };
        vi.mocked(consentLib.fetchMyConsent).mockResolvedValue(mockConsent);

        render(<KnownConsentCard />);

        const notNowButton = await screen.findByRole('button', { name: 'Not now' });
        fireEvent.click(notNowButton);

        expect(screen.queryByTestId('known-consent-card')).toBeNull();
    });
});
