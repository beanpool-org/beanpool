import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AdviseTheOwners } from './AdviseTheOwners';
import * as communityShape from '../../lib/community-shape';
import type { NodeProfile } from '../../lib/profiles';
import type { Shape } from '../../lib/community-shape';

vi.mock('../../lib/community-shape', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/community-shape')>();
    return {
        ...actual,
        adviseOwners: vi.fn(),
    };
});

const mockNode: NodeProfile = {
    id: 'node-1',
    name: 'Primary Node',
    url: 'https://primary.example.com',
    automationToken: 'test-token',
};

const mockUpdatedShape = {
    kind: 'local',
    standby: false,
    version: 2,
} as Shape;

describe('AdviseTheOwners', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders the initial collapsed button', () => {
        render(
            <AdviseTheOwners
                setting="beans"
                settingName="Beans"
                activeNode={mockNode}
                onSent={vi.fn()}
            />,
        );

        const btn = screen.getByTestId('shape-advise-beans');
        expect(btn).toBeInTheDocument();
        expect(btn).toHaveAttribute('aria-expanded', 'false');
        expect(btn).toHaveTextContent('Advise the owners');
    });

    it('expands form on click and can be cancelled', async () => {
        const user = userEvent.setup();
        render(
            <AdviseTheOwners
                setting="beans"
                settingName="Beans"
                activeNode={mockNode}
                onSent={vi.fn()}
            />,
        );

        await user.click(screen.getByTestId('shape-advise-beans'));

        expect(screen.getByTestId('shape-advise-form-beans')).toBeInTheDocument();
        expect(screen.getByLabelText('Your advice about Beans')).toBeInTheDocument();
        expect(screen.getByTestId('shape-advise-count-beans')).toHaveTextContent('0 of 200');

        // Cancel closes the form
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByTestId('shape-advise-form-beans')).not.toBeInTheDocument();
        expect(screen.getByTestId('shape-advise-beans')).toBeInTheDocument();
    });

    it('keeps send button disabled when input is empty or whitespace only', async () => {
        const user = userEvent.setup();
        render(
            <AdviseTheOwners
                setting="join"
                settingName="Who can join"
                activeNode={mockNode}
                onSent={vi.fn()}
            />,
        );

        await user.click(screen.getByTestId('shape-advise-join'));

        const sendBtn = screen.getByTestId('shape-advise-send-join');
        expect(sendBtn).toBeDisabled();

        const textarea = screen.getByTestId('shape-advise-text-join');
        await user.type(textarea, '   ');
        expect(sendBtn).toBeDisabled();

        await user.type(textarea, 'Need more vouchers');
        expect(sendBtn).not.toBeDisabled();
        expect(screen.getByTestId('shape-advise-count-join')).toHaveTextContent('21 of 200');
    });

    it('calls adviseOwners and triggers onSent on successful submit', async () => {
        const user = userEvent.setup();
        const onSentMock = vi.fn();
        vi.mocked(communityShape.adviseOwners).mockResolvedValueOnce({
            shape: mockUpdatedShape,
            told: 'owners',
        });

        render(
            <AdviseTheOwners
                setting="beans"
                settingName="Beans"
                activeNode={mockNode}
                onSent={onSentMock}
            />,
        );

        await user.click(screen.getByTestId('shape-advise-beans'));

        const textarea = screen.getByTestId('shape-advise-text-beans');
        await user.type(textarea, 'Consider reopening beans for summer');

        const sendBtn = screen.getByTestId('shape-advise-send-beans');
        await user.click(sendBtn);

        expect(communityShape.adviseOwners).toHaveBeenCalledTimes(1);
        expect(communityShape.adviseOwners).toHaveBeenCalledWith(
            'https://primary.example.com',
            'test-token',
            'beans',
            'Consider reopening beans for summer',
        );

        await waitFor(() => {
            expect(onSentMock).toHaveBeenCalledWith(mockUpdatedShape);
            expect(screen.queryByTestId('shape-advise-form-beans')).not.toBeInTheDocument();
        });
    });

    it('shows error banner when adviseOwners fails', async () => {
        const user = userEvent.setup();
        vi.mocked(communityShape.adviseOwners).mockRejectedValueOnce(
            new Error('Network error advice failed'),
        );

        render(
            <AdviseTheOwners
                setting="beans"
                settingName="Beans"
                activeNode={mockNode}
                onSent={vi.fn()}
            />,
        );

        await user.click(screen.getByTestId('shape-advise-beans'));
        await user.type(screen.getByTestId('shape-advise-text-beans'), 'Advice text');
        await user.click(screen.getByTestId('shape-advise-send-beans'));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Network error advice failed');
        expect(screen.getByTestId('shape-advise-form-beans')).toBeInTheDocument();
    });

    it('falls back to default message when error is non-Error or has empty message', async () => {
        const user = userEvent.setup();
        vi.mocked(communityShape.adviseOwners).mockRejectedValueOnce(
            new Error(''),
        );

        render(
            <AdviseTheOwners
                setting="beans"
                settingName="Beans"
                activeNode={mockNode}
                onSent={vi.fn()}
            />,
        );

        await user.click(screen.getByTestId('shape-advise-beans'));
        await user.type(screen.getByTestId('shape-advise-text-beans'), 'Advice text');
        await user.click(screen.getByTestId('shape-advise-send-beans'));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Could not send your advice.');
    });
});
