import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CreateGroupModal } from './CreateGroupModal';
import { createGroup } from '../lib/api';

vi.mock('../lib/api', () => ({
    createGroup: vi.fn(async (params) => ({ id: 'g1', ...params })),
}));

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
        expect(emojiTexts).not.toContain('🛠️'); // no Project Team category (group decisions pick 7)
        expect(emojiTexts).toContain('🛡️');
        expect(emojiTexts).toContain('🌻');
        expect(emojiTexts).toContain('💬');
        expect(emojiTexts).toContain('🚪');
        expect(emojiTexts).toContain('⏳');
        expect(emojiTexts).toContain('🔒');
    });

    it('applies focus-visible outline rings to interactive close and option buttons', () => {
        render(<CreateGroupModal isOpen={true} onClose={vi.fn()} onCreated={vi.fn()} onStartWithBeans={vi.fn()} />);

        const closeBtn = screen.getByRole('button', { name: /Close/i });
        expect(closeBtn.className).toContain('focus-visible:ring-2');
        expect(closeBtn.className).toContain('min-w-[44px]');
        expect(closeBtn.className).toContain('min-h-[44px]');

        const nameInput = screen.getByPlaceholderText(/e\.g\. Bindarrabi/i);
        expect(nameInput.className).toContain('focus-visible:ring-2');

        const optionBtns = screen.getAllByRole('button', { pressed: true });
        expect(optionBtns.length).toBeGreaterThan(0);
        optionBtns.forEach((btn) => {
            expect(btn.className).toContain('focus-visible:ring-2');
        });

        const startProjectBtn = screen.getByRole('button', { name: /Start a project/i });
        expect(startProjectBtn.className).toContain('focus-visible:ring-2');

        const submitBtn = screen.getByRole('button', { name: /Create Group/i });
        expect(submitBtn.className).toContain('focus-visible:ring-2');
    });
});

describe('CreateGroupModal Picture (Pictures S4, §4.3)', () => {
    it('has first row Picture with category emblem following category until custom choice, and sends avatarUrl', async () => {
        const onCreated = vi.fn();
        render(<CreateGroupModal isOpen={true} onClose={vi.fn()} onCreated={onCreated} />);

        // Label Picture is present
        expect(screen.getByText(/^Picture$/i)).toBeInTheDocument();

        // Default category is social -> emblem is bundled://sunflower
        const previewImg = screen.getByAltText(/Group picture/i) as HTMLImageElement;
        expect(previewImg).toBeInTheDocument();
        expect(previewImg.src).toContain('avatar_sunflower');

        // Changing category to General updates emblem to bundled://bean-green
        const generalBtn = screen.getByRole('button', { name: /General/i });
        fireEvent.click(generalBtn);
        expect(previewImg.src).toContain('avatar_bean_green');

        // Changing category to Working Group updates emblem to bundled://solartree
        const workingBtn = screen.getByRole('button', { name: /Working Group/i });
        fireEvent.click(workingBtn);
        expect(previewImg.src).toContain('avatar_solartree');

        // Changing category to Guild updates emblem to bundled://crystal
        const guildBtn = screen.getByRole('button', { name: /Guild/i });
        fireEvent.click(guildBtn);
        expect(previewImg.src).toContain('avatar_crystal');

        // Convenor chooses a custom preset ("Choose another")
        const chooseAnotherBtn = screen.getByRole('button', { name: /Choose another/i });
        fireEvent.click(chooseAnotherBtn);

        const leafPreset = screen.getByRole('button', { name: /Select Leaf avatar/i });
        fireEvent.click(leafPreset);

        expect(previewImg.src).toContain('avatar_leaf');

        // Changing category now does NOT change the picture because convenor chose one
        fireEvent.click(generalBtn);
        expect(previewImg.src).toContain('avatar_leaf');

        // Fill name and submit
        const nameInput = screen.getByPlaceholderText(/e\.g\. Bindarrabi/i);
        fireEvent.change(nameInput, { target: { value: 'Herbalists' } });
        fireEvent.click(screen.getByRole('button', { name: /Create Group/i }));

        await waitFor(() => {
            expect(createGroup).toHaveBeenCalledWith(expect.objectContaining({
                name: 'Herbalists',
                category: 'general',
                avatarUrl: 'bundled://leaf',
            }));
        });
    });
});
