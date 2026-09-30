import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FEEDBACK_TEXT_MAX } from '@beanpool/core';
import { SuggestChangePanel } from './SuggestChangePanel';

const TEXT = 'Backups should show how old the newest snapshot is.';

const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /Suggest a change to BeanPool/i }));

describe('SuggestChangePanel', () => {
    it('opens a form that says where it goes, with the community field empty', () => {
        render(<SuggestChangePanel appVersion="1.2.37" submit={vi.fn()} />);
        openPanel();
        expect(screen.getByText(/This goes to the BeanPool project team, not to your community/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Your community/i)).toHaveValue('');
    });

    it('sends source=settings-app with the node version and community name', async () => {
        const submit = vi.fn().mockResolvedValue({ ok: true });
        render(<SuggestChangePanel appVersion="1.2.37" submit={submit} />);
        openPanel();

        fireEvent.click(screen.getByRole('radio', { name: 'Problem' }));
        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: TEXT } });
        fireEvent.change(screen.getByLabelText(/Your community/i), { target: { value: 'Alpha Node' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
        expect(submit).toHaveBeenCalledWith(expect.objectContaining({
            text: TEXT,
            kind: 'problem',
            source: 'settings-app',
            appVersion: '1.2.37',
            community: 'Alpha Node',
            platform: 'web',
        }));
    });

    it('validates empty input and clears error when typing', async () => {
        const submit = vi.fn();
        render(<SuggestChangePanel appVersion="1.2.37" submit={submit} />);
        openPanel();

        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(submit).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: 'Now typed something' } });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('disables submit button and shows counter alert when text exceeds maximum limit', () => {
        render(<SuggestChangePanel appVersion="1.2.37" submit={vi.fn()} />);
        openPanel();

        const longText = 'a'.repeat(FEEDBACK_TEXT_MAX + 10);
        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: longText } });

        const sendButton = screen.getByRole('button', { name: 'Send' });
        expect(sendButton).toBeDisabled();
        expect(screen.getByText(new RegExp(`${FEEDBACK_TEXT_MAX + 10} / ${FEEDBACK_TEXT_MAX}`))).toBeInTheDocument();
    });

    it('shows sending state while submit request is in-flight', async () => {
        let resolveSubmit!: (res: { ok: boolean }) => void;
        const submitPromise = new Promise<{ ok: boolean }>((res) => { resolveSubmit = res; });
        const submit = vi.fn().mockReturnValue(submitPromise);

        render(<SuggestChangePanel appVersion="1.2.37" submit={submit} />);
        openPanel();

        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: TEXT } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        expect(screen.getByText('Sending…')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Sending…/i })).toBeDisabled();

        resolveSubmit({ ok: true });
        await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    });

    it('allows cancelling form and closing success view', async () => {
        const submit = vi.fn().mockResolvedValue({ ok: true });
        render(<SuggestChangePanel appVersion="1.2.37" submit={submit} />);

        // Cancel from form
        openPanel();
        expect(screen.getByLabelText(/Your suggestion/i)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByLabelText(/Your suggestion/i)).not.toBeInTheDocument();

        // Close after success
        openPanel();
        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: TEXT } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('on failure keeps the text and shows the error', async () => {
        const submit = vi.fn().mockResolvedValue({ ok: false, error: "Couldn't reach the BeanPool project just now." });
        render(<SuggestChangePanel appVersion="1.2.37" submit={submit} />);
        openPanel();

        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: TEXT } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't reach/));
        expect(screen.getByLabelText(/Your suggestion/i)).toHaveValue(TEXT);
    });
});
