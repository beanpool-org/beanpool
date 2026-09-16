import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CreateGroupModal } from './CreateGroupModal';

describe('CreateGroupModal Accessibility', () => {
    it('renders with dialog title linking and aria attributes when open', () => {
        render(<CreateGroupModal isOpen={true} onClose={vi.fn()} onCreated={vi.fn()} />);

        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'create-group-title');

        const title = screen.getByRole('heading', { level: 2 });
        expect(title).toHaveAttribute('id', 'create-group-title');
        expect(title).toHaveTextContent(/Create a Group/i);
    });

    it('hides decorative emojis from assistive technology', () => {
        const { container } = render(
            <CreateGroupModal isOpen={true} onClose={vi.fn()} onCreated={vi.fn()} />
        );

        const hiddenEmojis = container.querySelectorAll('[aria-hidden="true"]');
        const emojiTexts = Array.from(hiddenEmojis).map((el) => el.textContent?.trim());

        expect(emojiTexts).toContain('👥');
        expect(emojiTexts).toContain('ℹ️');
        expect(emojiTexts).toContain('🤝');
        expect(emojiTexts).toContain('🛠️');
        expect(emojiTexts).toContain('🛡️');
        expect(emojiTexts).toContain('☕');
        expect(emojiTexts).toContain('💬');
        expect(emojiTexts).toContain('🚪');
        expect(emojiTexts).toContain('⏳');
        expect(emojiTexts).toContain('🔒');
    });

    it('applies focus-visible outline rings to interactive close and option buttons', () => {
        render(<CreateGroupModal isOpen={true} onClose={vi.fn()} onCreated={vi.fn()} />);

        const closeBtn = screen.getByRole('button', { name: /Close/i });
        expect(closeBtn.className).toContain('focus-visible:ring-2');

        const optionBtns = screen.getAllByRole('button', { pressed: true });
        expect(optionBtns.length).toBeGreaterThan(0);
        optionBtns.forEach((btn) => {
            expect(btn.className).toContain('focus-visible:ring-2');
        });
    });
});
