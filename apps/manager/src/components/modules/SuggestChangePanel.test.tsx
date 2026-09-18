import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SuggestChangePanel } from './SuggestChangePanel';

const TEXT = 'Backups should show how old the newest snapshot is.';

const open = () => fireEvent.click(screen.getByRole('button', { name: /Suggest a change to BeanPool/i }));

describe('SuggestChangePanel', () => {
    it('opens a form that says where it goes, with the community field empty', () => {
        render(<SuggestChangePanel appVersion="1.2.37" submit={vi.fn()} />);
        open();
        expect(screen.getByText(/goes to the BeanPool project team, not to your community/)).toBeInTheDocument();
        expect(screen.getByText(/Don't include personal details/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Your community/i)).toHaveValue('');
    });

    it('sends source=settings-app with the node version', async () => {
        const submit = vi.fn().mockResolvedValue({ ok: true });
        render(<SuggestChangePanel appVersion="1.2.37" submit={submit} />);
        open();
        fireEvent.click(screen.getByRole('radio', { name: 'Problem' }));
        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: TEXT } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/reached the BeanPool project team/));
        expect(submit).toHaveBeenCalledWith(expect.objectContaining({
            text: TEXT, kind: 'problem', source: 'settings-app', appVersion: '1.2.37', community: '',
        }));
    });

    it('on failure keeps the text and shows the error', async () => {
        const submit = vi.fn().mockResolvedValue({ ok: false, error: "Couldn't reach the BeanPool project just now." });
        render(<SuggestChangePanel appVersion="1.2.37" submit={submit} />);
        open();
        fireEvent.change(screen.getByLabelText(/Your suggestion/i), { target: { value: TEXT } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't reach/));
        expect(screen.getByLabelText(/Your suggestion/i)).toHaveValue(TEXT);
    });
});
