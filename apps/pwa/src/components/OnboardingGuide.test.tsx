import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { OnboardingGuide } from './OnboardingGuide';

describe('OnboardingGuide', () => {
    it('renders all four main onboarding sections', () => {
        render(<OnboardingGuide />);

        expect(screen.getByText('⚡ Energy Exchange Marketplace')).toBeInTheDocument();
        expect(screen.getByText('🪙 The Mutual Credit Ledger')).toBeInTheDocument();
        expect(screen.getByText('🔒 Held in Trust')).toBeInTheDocument();
        expect(screen.getByText('🚀 Where to Start?')).toBeInTheDocument();
    });

    it('displays key rules and guidance text correctly', () => {
        render(<OnboardingGuide />);

        // Check for 0 Beans recommendation and Contributions First rule
        expect(screen.getByText('The best place to be is zero (0 Beans).')).toBeInTheDocument();
        expect(screen.getByText('Contributions First.')).toBeInTheDocument();

        // Check ledger subsection headings
        expect(screen.getByText('Trust-Backed Credit')).toBeInTheDocument();
        expect(screen.getByText('Community Commons Pool')).toBeInTheDocument();
        expect(screen.getByText('Reference Rate')).toBeInTheDocument();

        // Check reference rate explanation
        expect(screen.getByText(/40 Beans represents roughly 1 hour/i)).toBeInTheDocument();
    });

    it('displays action items in the "Where to Start?" section', () => {
        render(<OnboardingGuide />);

        expect(screen.getByText('Map')).toBeInTheDocument();
        expect(screen.getByText('Message')).toBeInTheDocument();
        expect(screen.getByText('Post')).toBeInTheDocument();
        expect(screen.getByText('Ledger')).toBeInTheDocument();
    });
});
