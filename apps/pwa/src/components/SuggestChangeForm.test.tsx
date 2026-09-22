import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SuggestChangeForm } from './SuggestChangeForm';

const TEXT = 'Please let us list firewood by the load.';

describe('SuggestChangeForm', () => {
    it('says plainly where it goes, and the community field starts empty', () => {
        render(<SuggestChangeForm appVersion="1.2.3" onDone={vi.fn()} submit={vi.fn()} />);
        expect(screen.getByText(/goes to the BeanPool project team, not to your community/)).toBeInTheDocument();
        expect(screen.getByText(/Don't include personal details/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Your community/i)).toHaveValue('');
        expect(screen.getByRole('radio', { name: 'Idea' })).toHaveAttribute('aria-checked', 'true');
    });

    it('sends source=web with the chosen kind, version and community', async () => {
        const submit = vi.fn().mockResolvedValue({ ok: true });
        render(<SuggestChangeForm appVersion="1.2.3" onDone={vi.fn()} submit={submit} />);
        fireEvent.click(screen.getByRole('radio', { name: 'Problem' }));
        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: TEXT } });
        fireEvent.change(screen.getByLabelText(/Your community/i), { target: { value: 'Mullum' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/reached the BeanPool project team/));
        expect(submit).toHaveBeenCalledWith(expect.objectContaining({
            text: TEXT, kind: 'problem', source: 'web', appVersion: '1.2.3', platform: 'web', community: 'Mullum',
        }));
    });

    it('on failure keeps the text and shows the error', async () => {
        const submit = vi.fn().mockResolvedValue({ ok: false, error: 'Please try again a bit later.' });
        render(<SuggestChangeForm appVersion="1.2.3" onDone={vi.fn()} submit={submit} />);
        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: TEXT } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Please try again a bit later.'));
        expect(screen.getByLabelText(/Your suggestion/i)).toHaveValue(TEXT);
    });

    it('refuses too-short text without sending', () => {
        const submit = vi.fn();
        render(<SuggestChangeForm appVersion="1.2.3" onDone={vi.fn()} submit={submit} />);
        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: 'hi' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        expect(screen.getByRole('alert')).toHaveTextContent(/at least 10/);
        expect(submit).not.toHaveBeenCalled();
    });

    it('hides decorative heading emoji and applies focus-visible ring classes', () => {
        const { container } = render(<SuggestChangeForm appVersion="1.2.3" onDone={vi.fn()} submit={vi.fn()} />);
        const hiddenEmoji = container.querySelector('h3 span[aria-hidden="true"]');
        expect(hiddenEmoji).toHaveTextContent('💬');

        const radioBtn = screen.getByRole('radio', { name: 'Idea' });
        expect(radioBtn).toHaveClass('focus-visible:ring-2');

        const textarea = screen.getByLabelText(/Your suggestion/i);
        expect(textarea).toHaveClass('focus-visible:ring-2');

        const input = screen.getByLabelText(/Your community/i);
        expect(input).toHaveClass('focus-visible:ring-2');

        const sendBtn = screen.getByRole('button', { name: 'Send' });
        expect(sendBtn).toHaveClass('focus-visible:ring-2');

        const backBtn = screen.getByRole('button', { name: '← Back to Settings' });
        expect(backBtn).toHaveClass('focus-visible:ring-2');
    });
});
