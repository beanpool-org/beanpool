import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { OnboardingGuide } from './OnboardingGuide';

describe('OnboardingGuide Accessibility', () => {
    it('renders all section titles correctly', () => {
        render(<OnboardingGuide />);
        expect(screen.getByRole('heading', { name: /Energy Exchange Marketplace/i })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /The Mutual Credit Ledger/i })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /Held in Trust/i })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /Where to Start\?/i })).toBeInTheDocument();
    });

    it('hides decorative emojis from assistive technology', () => {
        const { container } = render(<OnboardingGuide />);

        const hiddenEmojis = container.querySelectorAll('[aria-hidden="true"]');
        const emojiTexts = Array.from(hiddenEmojis).map((el) => el.textContent?.trim());

        expect(emojiTexts).toContain('⚡');
        expect(emojiTexts).toContain('🟢');
        expect(emojiTexts).toContain('🫘');
        expect(emojiTexts).toContain('🪙');
        expect(emojiTexts).toContain('🤝');
        expect(emojiTexts).toContain('🌾');
        expect(emojiTexts).toContain('⏱️');
        expect(emojiTexts).toContain('🔒');
        expect(emojiTexts).toContain('🚀');
        expect(emojiTexts).toContain('📍');
        expect(emojiTexts).toContain('💬');
        expect(emojiTexts).toContain('➕');
        expect(emojiTexts).toContain('💳');
    });
});
