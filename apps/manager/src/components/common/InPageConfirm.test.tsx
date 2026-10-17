import React, { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useInPageConfirm, InPageConfirmAsk } from './InPageConfirm';

function TestHarness({
    onResult,
}: {
    onResult?: (result: boolean) => void;
}) {
    const [ask, confirmation] = useInPageConfirm();
    const [lastResult, setLastResult] = useState<string>('idle');

    const handleAsk = async (options: InPageConfirmAsk) => {
        setLastResult('pending');
        const res = await ask(options);
        setLastResult(res ? 'confirmed' : 'cancelled');
        onResult?.(res);
    };

    return (
        <div>
            <div data-testid="result">{lastResult}</div>
            <button
                type="button"
                onClick={() =>
                    handleAsk({
                        title: 'Revoke Token?',
                        body: 'This action cannot be undone.',
                        confirmLabel: 'Revoke Token',
                        cancelLabel: 'Keep Token',
                    })
                }
            >
                Ask Custom
            </button>
            <button
                type="button"
                onClick={() =>
                    handleAsk({
                        title: 'Delete Item?',
                        confirmLabel: 'Delete',
                    })
                }
            >
                Ask Default Cancel
            </button>
            {confirmation}
        </div>
    );
}

describe('InPageConfirm (useInPageConfirm)', () => {
    beforeEach(() => {
        window.history.replaceState({ bpSettings: { tab: 'people', sub: 'directory' } }, '');
    });

    it('renders nothing initially when ask has not been called', () => {
        render(<TestHarness />);
        expect(screen.getByTestId('result')).toHaveTextContent('idle');
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('renders alertdialog portal with title, body, and custom button labels on ask', async () => {
        render(<TestHarness />);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Ask Custom' }));
        });

        expect(screen.getByTestId('result')).toHaveTextContent('pending');

        const dialog = screen.getByRole('alertdialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('Revoke Token?')).toBeInTheDocument();
        expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument();

        expect(screen.getByRole('button', { name: 'Revoke Token' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Keep Token' })).toBeInTheDocument();
    });

    it('resolves ask with true when confirm button is clicked', async () => {
        render(<TestHarness />);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Ask Custom' }));
        });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Revoke Token' }));
        });

        expect(screen.getByTestId('result')).toHaveTextContent('confirmed');
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('resolves ask with false when cancel button is clicked', async () => {
        render(<TestHarness />);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Ask Custom' }));
        });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Keep Token' }));
        });

        expect(screen.getByTestId('result')).toHaveTextContent('cancelled');
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('uses "Cancel" as default cancelLabel when omitted', async () => {
        render(<TestHarness />);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Ask Default Cancel' }));
        });

        const dialog = screen.getByRole('alertdialog');
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('Delete Item?')).toBeInTheDocument();

        const cancelButton = screen.getByRole('button', { name: 'Cancel' });
        expect(cancelButton).toBeInTheDocument();

        await act(async () => {
            fireEvent.click(cancelButton);
        });

        expect(screen.getByTestId('result')).toHaveTextContent('cancelled');
    });

    it('resolves ask with false when clicking the backdrop', async () => {
        render(<TestHarness />);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Ask Custom' }));
        });

        const backdrop = screen.getByTestId('in-page-confirm').parentElement;
        expect(backdrop).not.toBeNull();

        await act(async () => {
            fireEvent.mouseDown(backdrop!);
            fireEvent.click(backdrop!);
        });

        expect(screen.getByTestId('result')).toHaveTextContent('cancelled');
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('resolves previous pending ask promise with false if ask is called again', async () => {
        const results: boolean[] = [];

        function MultipleHarness() {
            const [ask, confirmation] = useInPageConfirm();

            const triggerFirst = async () => {
                const res = await ask({ title: 'First Question', confirmLabel: 'Confirm 1' });
                results.push(res);
            };

            const triggerSecond = async () => {
                const res = await ask({ title: 'Second Question', confirmLabel: 'Confirm 2' });
                results.push(res);
            };

            return (
                <div>
                    <button type="button" onClick={triggerFirst}>Ask 1</button>
                    <button type="button" onClick={triggerSecond}>Ask 2</button>
                    {confirmation}
                </div>
            );
        }

        render(<MultipleHarness />);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Ask 1' }));
        });

        expect(screen.getByText('First Question')).toBeInTheDocument();
        expect(results).toEqual([]);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Ask 2' }));
        });

        // First promise should have resolved with false
        expect(results).toEqual([false]);
        expect(screen.queryByText('First Question')).not.toBeInTheDocument();
        expect(screen.getByText('Second Question')).toBeInTheDocument();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Confirm 2' }));
        });

        expect(results).toEqual([false, true]);
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
});
