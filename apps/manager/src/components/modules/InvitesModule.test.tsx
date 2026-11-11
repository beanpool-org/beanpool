import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InvitesModule } from './InvitesModule';
import * as nodeClient from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('../../lib/node-client', async () => {
    const actual = await vi.importActual('../../lib/node-client');
    return {
        ...actual,
        generateNodeInvite: vi.fn(),
        fetchMyVouching: vi.fn(),
    };
});

describe('InvitesModule', () => {
    // The printable sheet's popup, as window.open hands it back (beforeEach).
    let printWindow: any;
    let printButton: any;
    const mockNode: NodeProfile = {
        id: 'node-1',
        name: 'Test Node',
        url: 'https://test-node.beanpool.org',
        credential: 'secretpassword',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        Object.assign(navigator, {
            clipboard: {
                writeText: vi.fn().mockResolvedValue(undefined),
            },
        });
        printButton = { addEventListener: vi.fn() };
        printWindow = {
            document: {
                write: vi.fn(),
                close: vi.fn(),
                getElementById: vi.fn((id: string) => (id === 'print-now' ? printButton : null)),
            },
            setTimeout: vi.fn(),
            print: vi.fn(),
        };
        vi.spyOn(window, 'open').mockImplementation(() => printWindow as unknown as Window);
    });

    it('renders initial form state and empty pass state', () => {
        render(<InvitesModule activeNode={mockNode} />);

        expect(screen.getByText('🎟️ Sovereign Node Invite Generator')).toBeInTheDocument();
        expect(screen.getByText('Test Node')).toBeInTheDocument();
        expect(screen.getByText('No Passes Generated Yet')).toBeInTheDocument();
        expect(screen.getByText('Generate 5 Passes')).toBeInTheDocument();
    });

    it('generates invite passes successfully via node API', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
            success: true,
            code: 'INV-API-PASS-1',
            type: 'standard',
        });

        render(<InvitesModule activeNode={mockNode} />);

        const generateBtn = screen.getByRole('button', { name: /Generate 5 Passes/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (5)')).toBeInTheDocument();
        });

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(5);
        expect(nodeClient.generateNodeInvite).toHaveBeenCalledWith(
            'https://test-node.beanpool.org',
            'secretpassword',
            'standard',
            undefined
        );
        expect(screen.getAllByText('INV-API-PASS-1').length).toBeGreaterThan(0);
    });

    // This used to assert that a made-up INV-XXXX-XXXX code appeared when the node refused. Owners printed those
    // codes on cards and they never worked. A refusal must show the node's reason and no code at all.
    it('shows the node\'s reason and no code, QR or print button when the node refuses', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockRejectedValue(new Error('Invalid password'));

        render(<InvitesModule activeNode={mockNode} />);

        const count1Btn = screen.getByRole('button', { name: '1' });
        await userEvent.click(count1Btn);

        const generateBtn = screen.getByRole('button', { name: /Generate 1 Pass/i });
        await userEvent.click(generateBtn);

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('No invites were made');
        expect(alert).toHaveTextContent('Invalid password');
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();

        expect(screen.queryByText(/Generated Passes/)).not.toBeInTheDocument();
        expect(screen.queryByText(/INV-/)).not.toBeInTheDocument();
        expect(screen.queryByRole('img', { name: /QR Code/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Print/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Copy/i })).not.toBeInTheDocument();
    });

    it('retry after a refusal shows only the codes the node issued', async () => {
        vi.mocked(nodeClient.generateNodeInvite)
            .mockRejectedValueOnce(new Error('Only an owner or admin of this node can issue invites'))
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-RETRY', type: 'standard' });

        render(<InvitesModule activeNode={mockNode} />);

        await userEvent.click(screen.getByRole('button', { name: '1' }));
        await userEvent.click(screen.getByRole('button', { name: /Generate 1 Pass/i }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Only an owner or admin of this node can issue invites');

        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (1)')).toBeInTheDocument();
        });
        expect(screen.getAllByText('INV-REAL-RETRY').length).toBeGreaterThan(0);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('a refusal part-way keeps the real passes, says how many were made, and retries only the rest', async () => {
        vi.mocked(nodeClient.generateNodeInvite)
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-1', type: 'standard' })
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-2', type: 'standard' })
            .mockRejectedValueOnce(new Error('Too many requests'))
            .mockResolvedValue({ success: true, code: 'INV-REAL-LATER', type: 'standard' });

        render(<InvitesModule activeNode={mockNode} />);

        await userEvent.click(screen.getByRole('button', { name: /Generate 5 Passes/i }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Only 2 of 5 invites were made');
        expect(alert).toHaveTextContent('Too many requests');
        expect(screen.getByText('Generated Passes (2)')).toBeInTheDocument();
        // Stopped at the refusal: no further calls, nothing invented for the other three.
        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(3);

        await userEvent.click(screen.getByRole('button', { name: 'Try again for the other 3' }));

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (5)')).toBeInTheDocument();
        });
        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(6);
        expect(screen.getAllByText('INV-REAL-1').length).toBeGreaterThan(0);
        expect(screen.getAllByText('INV-REAL-LATER').length).toBe(3);
    });

    it('allows changing quantity and tier options', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
            success: true,
            code: 'INV-TIER-TEST',
            type: 'trusted',
        });

        render(<InvitesModule activeNode={mockNode} />);

        const select = screen.getByRole('combobox');
        await userEvent.selectOptions(select, 'trusted');

        const count10Btn = screen.getByRole('button', { name: '10' });
        await userEvent.click(count10Btn);

        const generateBtn = screen.getByRole('button', { name: /Generate 10 Passes/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (10)')).toBeInTheDocument();
        });

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledWith(
            'https://test-node.beanpool.org',
            'secretpassword',
            'trusted',
            undefined
        );
        expect(screen.getAllByText('🏠 Resident').length).toBeGreaterThan(0);
    });

    it('handles copy operations and enlarged QR preview modal', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
            success: true,
            code: 'INV-COPY-TEST',
            type: 'standard',
        });

        render(<InvitesModule activeNode={mockNode} />);

        const count1Btn = screen.getByRole('button', { name: '1' });
        await userEvent.click(count1Btn);

        const generateBtn = screen.getByRole('button', { name: /Generate 1 Pass/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (1)')).toBeInTheDocument();
        });

        const copyLinkBtn = screen.getByRole('button', { name: 'Copy Link' });
        await userEvent.click(copyLinkBtn);

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
            'https://test-node.beanpool.org/?invite=INV-COPY-TEST'
        );
        expect(screen.getByText('✓ Copied')).toBeInTheDocument();

        const enlargeBtn = screen.getByRole('button', { name: 'Enlarge' });
        await userEvent.click(enlargeBtn);

        expect(screen.getByText('SINGLE-USE ONBOARDING PASS')).toBeInTheDocument();

        const closeBtn = screen.getAllByRole('button', { name: 'Close' })[0]; // the ✕ (the footer has a Close button too)
        await userEvent.click(closeBtn);

        expect(screen.queryByText('SINGLE-USE ONBOARDING PASS')).not.toBeInTheDocument();
    });

    it('generates custom N invites with offline SVG QR codes', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
            success: true,
            code: 'INV-CUSTOM-N',
            type: 'standard',
        });

        render(<InvitesModule activeNode={mockNode} />);

        const customInput = screen.getByLabelText(/custom quantity/i);
        fireEvent.change(customInput, { target: { value: '3' } });

        const generateBtn = screen.getByRole('button', { name: /Generate 3 Passes/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (3)')).toBeInTheDocument();
        });

        // Verify images use offline data:image/svg+xml and never external server
        const images = screen.getAllByRole('img', { name: /QR Code for INV-CUSTOM-N/i });
        expect(images.length).toBe(3);
        images.forEach((img) => {
            expect((img as HTMLImageElement).src).toContain('data:image/svg+xml');
            expect((img as HTMLImageElement).src).not.toContain('api.qrserver.com');
        });
    });

    it('renders printable QR sheet modal and triggers print cards window', async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
            success: true,
            code: 'INV-PRINT-1',
            type: 'standard',
        });

        render(<InvitesModule activeNode={mockNode} />);

        const count1Btn = screen.getByRole('button', { name: '1' });
        await userEvent.click(count1Btn);

        const generateBtn = screen.getByRole('button', { name: /Generate 1 Pass/i });
        await userEvent.click(generateBtn);

        await waitFor(() => {
            expect(screen.getByText('Generated Passes (1)')).toBeInTheDocument();
        });

        // Test on-screen printable sheet modal
        const viewSheetBtn = screen.getByRole('button', { name: /View Printable Sheet/i });
        await userEvent.click(viewSheetBtn);

        expect(screen.getByText(/Printable QR Onboarding Sheet \(1 Passes\)/i)).toBeInTheDocument();
        expect(screen.getByText(/Face-to-face dinner onboarding/i)).toBeInTheDocument();

        // Test print window trigger
        const printBtn = screen.getAllByRole('button', { name: /Print Sheet/i })[0];
        await userEvent.click(printBtn);
        expect(window.open).toHaveBeenCalled();

        // The popup inherits Settings' strict policy (no inline script runs there), so its page has none: no <script>,
        // no inline handler. The Print button and the print dialog are wired from Settings instead.
        const html = printWindow.document.write.mock.calls.map((c: unknown[]) => String(c[0])).join('');
        expect(html).toContain('INV-PRINT-1');
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
        expect(printButton.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
        printButton.addEventListener.mock.calls[0][1]();
        expect(printWindow.print).toHaveBeenCalledTimes(1);
        expect(printWindow.setTimeout).toHaveBeenCalledWith(expect.any(Function), 400);
    });

    describe('Voucher Presets on Invites & QR (V5)', () => {
        const OWNER_KEY: any = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
        const ADMIN_KEY: any = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' };
        const PASSWORD_VIEWER: any = { kind: 'token' };

        it('does NOT render presets under password session', () => {
            render(<InvitesModule activeNode={mockNode} viewer={PASSWORD_VIEWER} />);
            expect(screen.queryByTestId('vouch-preset-section')).not.toBeInTheDocument();
            expect(nodeClient.fetchMyVouching).not.toHaveBeenCalled();
        });

        it('does NOT render presets when viewer is not provided (defaults to password)', () => {
            render(<InvitesModule activeNode={mockNode} />);
            expect(screen.queryByTestId('vouch-preset-section')).not.toBeInTheDocument();
            expect(nodeClient.fetchMyVouching).not.toHaveBeenCalled();
        });

        it('does NOT render presets under key session if the node says not a voucher', async () => {
            vi.mocked(nodeClient.fetchMyVouching).mockResolvedValue({
                voucher: false,
                presets: [2500, 5000, 7500, 10000],
                vouchMax: 10000,
                budgetMax: 200000,
            });

            render(<InvitesModule activeNode={mockNode} viewer={OWNER_KEY} />);

            await waitFor(() => {
                expect(nodeClient.fetchMyVouching).toHaveBeenCalled();
            });
            expect(screen.queryByTestId('vouch-preset-section')).not.toBeInTheDocument();
        });

        it('renders presets under key session when the node says is a voucher', async () => {
            vi.mocked(nodeClient.fetchMyVouching).mockResolvedValue({
                voucher: true,
                budget: { left: 55000, level: 100000, held: 10000, vouched: 35000 },
                presets: [2500, 5000, 7500, 10000],
                vouchMax: 10000,
                budgetMax: 200000,
            });

            render(<InvitesModule activeNode={mockNode} viewer={ADMIN_KEY} />);

            await waitFor(() => {
                expect(screen.getByTestId('vouch-preset-section')).toBeInTheDocument();
            });

            expect(screen.getByTestId('vouch-budget-left')).toHaveTextContent(
                'From your budget: 550 of 1,000 left'
            );
            expect(screen.getByTestId('vouch-preset-None')).toBeInTheDocument();
            expect(screen.getByTestId('vouch-preset-25')).toBeInTheDocument();
            expect(screen.getByTestId('vouch-preset-50')).toBeInTheDocument();
            expect(screen.getByTestId('vouch-preset-75')).toBeInTheDocument();
            expect(screen.getByTestId('vouch-preset-100')).toBeInTheDocument();
        });

        it('passes selected preset to generateNodeInvite and displays vouch badge on generated card', async () => {
            vi.mocked(nodeClient.fetchMyVouching).mockResolvedValue({
                voucher: true,
                budget: { left: 55000, level: 100000, held: 10000, vouched: 35000 },
                presets: [2500, 5000, 7500, 10000],
                vouchMax: 10000,
                budgetMax: 200000,
            });
            vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
                success: true,
                code: 'INV-VOUCH-25',
                type: 'standard',
                vouchAmount: 2500,
            });

            render(<InvitesModule activeNode={mockNode} viewer={OWNER_KEY} />);

            await waitFor(() => {
                expect(screen.getByTestId('vouch-preset-section')).toBeInTheDocument();
            });

            // Select 1 pass
            const count1Btn = screen.getByRole('button', { name: '1' });
            await userEvent.click(count1Btn);

            // Select 25 Beans preset
            const preset25Btn = screen.getByTestId('vouch-preset-25');
            await userEvent.click(preset25Btn);

            // Generate
            const generateBtn = screen.getByRole('button', { name: /Generate 1 Pass/i });
            await userEvent.click(generateBtn);

            await waitFor(() => {
                expect(screen.getByText('Generated Passes (1)')).toBeInTheDocument();
            });

            // The preset as the node takes it: `vouchAmount` in whole hundredths, 25 Beans is 2500.
            expect(nodeClient.generateNodeInvite).toHaveBeenCalledWith(
                'https://test-node.beanpool.org',
                'secretpassword',
                'standard',
                undefined,
                2500
            );

            expect(screen.getByTestId('card-vouch-badge')).toHaveTextContent('🤝 25 Beans vouched');
        });

        it('does not display vouch badge if node response omits vouchAmount', async () => {
            vi.mocked(nodeClient.fetchMyVouching).mockResolvedValue({
                voucher: true,
                budget: { left: 55000, level: 100000, held: 10000, vouched: 35000 },
                presets: [2500, 5000, 7500, 10000],
                vouchMax: 10000,
                budgetMax: 200000,
            });
            vi.mocked(nodeClient.generateNodeInvite).mockResolvedValue({
                success: true,
                code: 'INV-NOVOUCH',
                type: 'standard',
            });

            render(<InvitesModule activeNode={mockNode} viewer={OWNER_KEY} />);

            await waitFor(() => {
                expect(screen.getByTestId('vouch-preset-section')).toBeInTheDocument();
            });

            const count1Btn = screen.getByRole('button', { name: '1' });
            await userEvent.click(count1Btn);

            const preset25Btn = screen.getByTestId('vouch-preset-25');
            await userEvent.click(preset25Btn);

            const generateBtn = screen.getByRole('button', { name: /Generate 1 Pass/i });
            await userEvent.click(generateBtn);

            await waitFor(() => {
                expect(screen.getByText('Generated Passes (1)')).toBeInTheDocument();
            });

            expect(screen.queryByTestId('card-vouch-badge')).toBeNull();
        });

        it('disables presets that exceed budget and warns when budget is 0', async () => {
            vi.mocked(nodeClient.fetchMyVouching).mockResolvedValue({
                voucher: true,
                budget: { left: 5000, level: 100000, held: 60000, vouched: 35000 },
                presets: [2500, 5000, 7500, 10000],
                vouchMax: 10000,
                budgetMax: 200000,
            });

            const { unmount: unmount1 } = render(<InvitesModule activeNode={mockNode} viewer={OWNER_KEY} />);

            await waitFor(() => {
                expect(screen.getByTestId('vouch-preset-section')).toBeInTheDocument();
            });

            expect(screen.getByTestId('vouch-preset-None')).not.toBeDisabled();
            expect(screen.getByTestId('vouch-preset-25')).not.toBeDisabled();
            expect(screen.getByTestId('vouch-preset-50')).not.toBeDisabled();
            expect(screen.getByTestId('vouch-preset-75')).toBeDisabled();
            expect(screen.getByTestId('vouch-preset-100')).toBeDisabled();

            unmount1();

            // When left === 0
            vi.mocked(nodeClient.fetchMyVouching).mockResolvedValue({
                voucher: true,
                budget: { left: 0, level: 100000, held: 65000, vouched: 35000 },
                presets: [2500, 5000, 7500, 10000],
                vouchMax: 10000,
                budgetMax: 200000,
            });

            render(<InvitesModule activeNode={{ ...mockNode, id: 'node-2' }} viewer={OWNER_KEY} />);

            await waitFor(() => {
                expect(screen.getByText('No budget left. Ask an owner for more.')).toBeInTheDocument();
            });
            expect(screen.getByTestId('vouch-preset-None')).not.toBeDisabled();
            expect(screen.getByTestId('vouch-preset-25')).toBeDisabled();
            expect(screen.getByTestId('vouch-preset-50')).toBeDisabled();
            expect(screen.getByTestId('vouch-preset-75')).toBeDisabled();
            expect(screen.getByTestId('vouch-preset-100')).toBeDisabled();
        });
    });

    describe('presets hold across renders and fit the whole batch (#2923 review)', () => {
        const OWNER_KEY: any = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' };
        // Every figure as GET /api/local/admin/vouchers/me sends it: whole hundredths of a Bean (engine/vouchers.ts myVouching).
        const voucher = (left: number) => ({ voucher: true, budget: { left, level: 100000, held: 0, vouched: 100000 - left },
            presets: [2500, 5000, 7500, 10000], vouchMax: 10000, budgetMax: 200000 });

        it('five cards at 25 with 100 left: refused before the first card, with the reason, and nothing is made', async () => {
            vi.mocked(nodeClient.fetchMyVouching).mockResolvedValue(voucher(10000) as any);
            render(<InvitesModule activeNode={mockNode} viewer={OWNER_KEY} />);
            await waitFor(() => expect(screen.getByTestId('vouch-preset-section')).toBeInTheDocument());
            await userEvent.click(screen.getByRole('button', { name: '5' }));
            await userEvent.click(screen.getByTestId('vouch-preset-25'));
            await userEvent.click(screen.getByRole('button', { name: /Generate 5 Pass/i }));
            expect(await screen.findByText('Not enough budget left for 5 cards at 25 each: 100 left. Choose fewer cards or a smaller amount.')).toBeInTheDocument();
            expect(nodeClient.generateNodeInvite).not.toHaveBeenCalled();
        });

        it('a new viewer object for the same person keeps the chosen amount and reads the budget once', async () => {
            vi.mocked(nodeClient.fetchMyVouching).mockResolvedValue(voucher(55000) as any);
            const view = render(<InvitesModule activeNode={mockNode} viewer={{ ...OWNER_KEY }} />);
            await waitFor(() => expect(screen.getByTestId('vouch-preset-section')).toBeInTheDocument());
            await userEvent.click(screen.getByTestId('vouch-preset-50'));
            expect(screen.getByTestId('vouch-preset-50')).toHaveAttribute('aria-checked', 'true');
            view.rerender(<InvitesModule activeNode={mockNode} viewer={{ ...OWNER_KEY }} />);
            expect(screen.getByTestId('vouch-preset-50')).toHaveAttribute('aria-checked', 'true');
            expect(nodeClient.fetchMyVouching).toHaveBeenCalledTimes(1);
        });

        it('says a budget to the cent as hundredths, never 100 times over', async () => {
            vi.mocked(nodeClient.fetchMyVouching).mockResolvedValue(voucher(4925) as any);
            render(<InvitesModule activeNode={mockNode} viewer={OWNER_KEY} />);
            await waitFor(() => expect(screen.getByTestId('vouch-preset-section')).toBeInTheDocument());
            expect(screen.getByTestId('vouch-budget-left')).toHaveTextContent('From your budget: 49.25 of 1,000 left');
            // 49.25 left: the 25 preset fits, 50 and up do not.
            expect(screen.getByTestId('vouch-preset-25')).not.toBeDisabled();
            expect(screen.getByTestId('vouch-preset-50')).toBeDisabled();
        });

        it('the amounts are a radio group a screen reader can read', async () => {
            vi.mocked(nodeClient.fetchMyVouching).mockResolvedValue(voucher(55000) as any);
            render(<InvitesModule activeNode={mockNode} viewer={OWNER_KEY} />);
            await waitFor(() => expect(screen.getByTestId('vouch-preset-section')).toBeInTheDocument());
            const radios = screen.getAllByRole('radio');
            expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false']);
        });
    });
});

