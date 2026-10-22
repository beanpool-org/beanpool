import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HelpDialog } from './HelpDialog';

describe('HelpDialog', () => {
    const defaultSheet = {
        title: 'Community Guide',
        text: 'This is the guide overview for this section.',
        slug: 'community-guide',
        section: 'general',
    };

    it('renders as an accessible modal dialog with aria-labelledby and aria-label on close button', () => {
        const onClose = vi.fn();
        render(
            <HelpDialog
                sheet={defaultSheet}
                tourOpen={false}
                canTour={true}
                onReadPage={vi.fn()}
                onSearch={vi.fn()}
                onTour={vi.fn()}
                onClose={onClose}
            />
        );

        const dialog = screen.getByRole('dialog', { hidden: true });
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-modal', 'true');

        const title = screen.getByTestId('help-title');
        expect(title).toHaveTextContent('Community Guide');
        expect(dialog).toHaveAttribute('aria-labelledby', title.getAttribute('id'));

        const closeBtn = screen.getByRole('button', { name: 'Close help dialog' });
        expect(closeBtn).toBeInTheDocument();

        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
