import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ColdStartWizard } from './ColdStartWizard';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';

const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Fresh Sovereign Node',
    url: 'https://mullum.local',
    adminPassword: 'admin-password',
};

const mockDiag = {
    callsign: 'mullum-node',
    communityName: 'Mullumbimby Commons',
    status: 'healthy',
    uptimeSeconds: 100,
    totalMemoryMb: 512,
    cpuLoadPercent: 5,
    memoryUsageMb: 50,
    dbSizeBytes: 1024 * 1024,
    walSizeBytes: 0,
    activeWsConnections: 1,
    p2pActivePeers: 0,
};

describe('ColdStartWizard Component (settings-ia §4 & §6)', () => {
    beforeEach(() => {
        sessionStorage.clear();
        vi.clearAllMocks();
        localStorage.clear();
        vi.spyOn(nodeClient, 'createNodeTreasury').mockResolvedValue({
            success: true,
            publicKey: 'treasury_pk_first',
        });
        vi.spyOn(nodeClient, 'assignTreasuryKeeper').mockResolvedValue(['operator_key']);
        vi.spyOn(nodeClient, 'seedTreasuryOffer').mockResolvedValue({
            success: true,
            post: {},
        });
        vi.spyOn(nodeClient, 'generateNodeInvite').mockResolvedValue({
            success: true,
            code: 'FOUNDING-777',
            type: 'trusted',
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ success: true }),
        }));
    });

    afterEach(() => {
        sessionStorage.clear();
    });

    it('navigates through all 5 steps of the cold-start wizard and enforces invariants', async () => {
        const handleComplete = vi.fn();

        await act(async () => {
            render(
                <ColdStartWizard
                    activeNode={mockProfile}
                    diag={mockDiag}
                    nodeData={{ members: [] }}
                    onComplete={handleComplete}
                />
            );
        });

        // -------------------------------------------------------------
        // Step 1: Name & Locate
        // -------------------------------------------------------------
        expect(screen.getByText('Step 1: Name & Locate Community')).toBeInTheDocument();
        const nextStep1Button = screen.getByRole('button', { name: /Next: Enrol Owner Key/i });
        await act(async () => {
            fireEvent.click(nextStep1Button);
        });

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/update-identity'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    password: 'admin-password',
                    communityName: 'Mullumbimby Commons',
                    callsign: 'mullum-node',
                }),
            })
        );

        // -------------------------------------------------------------
        // Step 2: Enrol Owner Key & Break-Glass Kit
        // -------------------------------------------------------------
        expect(screen.getByText(/Step 2: Enrol Owner Key/i)).toBeInTheDocument();
        const nextStep2Button = screen.getByRole('button', { name: /Next: Create First Enterprise/i });

        // Guard: cannot proceed until "saved off-node" is checked
        expect(nextStep2Button).toBeDisabled();

        // Download break-glass kit
        const downloadBtn = screen.getByRole('button', { name: /Download Break-Glass Kit/i });
        await act(async () => {
            fireEvent.click(downloadBtn);
        });
        expect(screen.getByText(/Recovery kit downloaded/i)).toBeInTheDocument();

        // Check the required off-node confirmation checkbox
        const checkbox = screen.getByRole('checkbox');
        await act(async () => {
            fireEvent.click(checkbox);
        });

        expect(nextStep2Button).not.toBeDisabled();
        await act(async () => {
            fireEvent.click(nextStep2Button);
        });

        // -------------------------------------------------------------
        // Step 3: Create First Enterprise from Preset & First Offer
        // -------------------------------------------------------------
        expect(screen.getByText(/Step 3: Establish First Community Enterprise/i)).toBeInTheDocument();
        expect(screen.getByText('Food & Produce')).toBeInTheDocument();
        expect(screen.getByText('Tools & Infrastructure')).toBeInTheDocument();
        expect(screen.getByText('Machinery & Transport')).toBeInTheDocument();

        // Switch to Tools preset
        const toolsPreset = screen.getByRole('button', { name: /Tools & Infrastructure/i });
        await act(async () => {
            fireEvent.click(toolsPreset);
        });

        const nextStep3Button = screen.getByRole('button', { name: /Next: Seed the Commons/i });
        await act(async () => {
            fireEvent.click(nextStep3Button);
        });

        expect(nodeClient.createNodeTreasury).toHaveBeenCalled();
        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalled();
        expect(nodeClient.seedTreasuryOffer).toHaveBeenCalled();

        // -------------------------------------------------------------
        // Step 4: Seed the Commons Pool (Guard: NO Demurrage Slider per §6)
        // -------------------------------------------------------------
        expect(screen.getByText(/Step 4: Seed the Commons Pool/i)).toBeInTheDocument();
        expect(screen.getByText(/Demurrage Rate \(Protocol Invariant\)/i)).toBeInTheDocument();
        expect(screen.getByText(/1.5% default/i)).toBeInTheDocument();

        // CRITICAL GUARD: Confirm NO slider or rate setting exists
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/demurrage slider/i)).not.toBeInTheDocument();

        const nextStep4Button = screen.getByRole('button', { name: /Next: Founding Invites/i });
        await act(async () => {
            fireEvent.click(nextStep4Button);
        });

        // -------------------------------------------------------------
        // Step 5: Generate Three Founding Invites & Printable Cards
        // -------------------------------------------------------------
        expect(screen.getByText(/Step 5: Three Founding Invites/i)).toBeInTheDocument();

        const genInvitesButton = screen.getByRole('button', { name: /Generate 3 Founding Invites/i });
        await act(async () => {
            fireEvent.click(genInvitesButton);
        });

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(3);
        expect(screen.getByText('Founding Invite #1')).toBeInTheDocument();
        expect(screen.getByText('Founding Invite #2')).toBeInTheDocument();
        expect(screen.getByText('Founding Invite #3')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Print Founding Cards/i })).toBeInTheDocument();

        // Exit to Dashboard
        const exitButton = screen.getByRole('button', { name: /Exit to Dashboard/i });
        await act(async () => {
            fireEvent.click(exitButton);
        });

        expect(handleComplete).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('bp_cold_start_completed')).toBe('true');
        // This used to assert a '1/3 founding invites claimed' status that nothing on the node backed (no one had
        // claimed anything). The wizard no longer writes a made-up status for the home screen.
        expect(localStorage.getItem('bp_founding_invites_status')).toBeNull();
    });

    /** Walks steps 1–4 with the default mocks and lands on step 5. */
    async function goToStep5(onComplete = vi.fn()) {
        await act(async () => {
            render(
                <ColdStartWizard
                    activeNode={mockProfile}
                    diag={mockDiag}
                    nodeData={{ members: [] }}
                    onComplete={onComplete}
                />
            );
        });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Next: Enrol Owner Key/i })); });
        await act(async () => { fireEvent.click(screen.getByRole('checkbox')); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Next: Create First Enterprise/i })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Next: Seed the Commons/i })); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Next: Founding Invites/i })); });
        expect(screen.getByText(/Step 5: Three Founding Invites/i)).toBeInTheDocument();
        return onComplete;
    }

    it("step 5: when the node refuses, shows its reason and no code, QR or print button — and setup can still finish", async () => {
        vi.mocked(nodeClient.generateNodeInvite).mockRejectedValue(new Error('Invalid password'));
        const onComplete = await goToStep5();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Generate 3 Founding Invites/i }));
        });

        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('No founding invites were made');
        expect(alert).toHaveTextContent('Invalid password');
        // Stopped at the first refusal.
        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(1);

        expect(screen.queryByText(/Founding Invite #/)).not.toBeInTheDocument();
        expect(screen.queryByText(/FOUNDING-/)).not.toBeInTheDocument();
        expect(screen.queryByRole('img', { name: /Founding QR/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Print Founding Cards/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/setup complete/i)).not.toBeInTheDocument();

        // No hard gate: the owner can finish setup and make invites later.
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Finish setup without invites/i }));
        });
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('step 5: retry after a refusal part-way asks only for the missing invites and shows only real codes', async () => {
        vi.mocked(nodeClient.generateNodeInvite)
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-A', type: 'trusted' })
            .mockRejectedValueOnce(new Error('Only an owner or admin of this node can issue invites'))
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-B', type: 'trusted' })
            .mockResolvedValueOnce({ success: true, code: 'INV-REAL-C', type: 'trusted' });
        await goToStep5();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Generate 3 Founding Invites/i }));
        });

        expect(screen.getByRole('alert')).toHaveTextContent('Only 1 of 3 founding invites were made');
        expect(screen.getByRole('alert')).toHaveTextContent('Only an owner or admin of this node can issue invites');
        expect(screen.getByText('INV-REAL-A')).toBeInTheDocument();
        expect(screen.queryByText('Founding Invite #2')).not.toBeInTheDocument();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Try again for the other 2' }));
        });

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledTimes(4);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByText('INV-REAL-A')).toBeInTheDocument();
        expect(screen.getByText('INV-REAL-B')).toBeInTheDocument();
        expect(screen.getByText('INV-REAL-C')).toBeInTheDocument();
        expect(screen.getByText('Founding Invite #3')).toBeInTheDocument();
    });

    it('sets reachabilityStatus to error and displays warning when reachability check fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/community/health')) {
                return Promise.resolve({ ok: false, status: 503 });
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
        }));

        await act(async () => {
            render(
                <ColdStartWizard
                    activeNode={mockProfile}
                    diag={mockDiag}
                    nodeData={{ members: [] }}
                    onComplete={vi.fn()}
                />
            );
        });

        const verifyBtn = screen.getByRole('button', { name: /Verify Reachable/i });
        await act(async () => {
            fireEvent.click(verifyBtn);
        });

        expect(screen.getByText(/Public endpoint unreachable or health check failed/i)).toBeInTheDocument();
        expect(screen.queryByText(/Public endpoint verified reachable/i)).not.toBeInTheDocument();
    });

    it('forwards 2FA session token to identity, treasury, keeper, offer, and invite calls when tfaToken is provided', async () => {
        await act(async () => {
            render(
                <ColdStartWizard
                    activeNode={mockProfile}
                    diag={mockDiag}
                    nodeData={{ members: [] }}
                    tfaToken="tfa-wizard-token"
                    onComplete={vi.fn()}
                />
            );
        });

        // Step 1: Enrol Owner Key -> checks update-identity header
        const nextStep1Button = screen.getByRole('button', { name: /Next: Enrol Owner Key/i });
        await act(async () => {
            fireEvent.click(nextStep1Button);
        });

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/update-identity'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'X-Admin-Password': 'admin-password',
                    'X-Admin-2FA-Session': 'tfa-wizard-token',
                }),
            })
        );

        // Step 2 -> Step 3
        const checkbox = screen.getByRole('checkbox');
        await act(async () => {
            fireEvent.click(checkbox);
        });
        const nextStep2Button = screen.getByRole('button', { name: /Next: Create First Enterprise/i });
        await act(async () => {
            fireEvent.click(nextStep2Button);
        });

        // Step 3: Create Enterprise
        const nextStep3Button = screen.getByRole('button', { name: /Next: Seed the Commons/i });
        await act(async () => {
            fireEvent.click(nextStep3Button);
        });

        expect(nodeClient.createNodeTreasury).toHaveBeenCalledWith(
            mockProfile.url,
            expect.any(Object),
            mockProfile.adminPassword,
            'tfa-wizard-token'
        );
        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_first',
            expect.any(String),
            mockProfile.adminPassword,
            'tfa-wizard-token'
        );
        expect(nodeClient.seedTreasuryOffer).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_first',
            expect.any(Object),
            mockProfile.adminPassword,
            'tfa-wizard-token'
        );

        // Step 4 -> Step 5
        const nextStep4Button = screen.getByRole('button', { name: /Next: Founding Invites/i });
        await act(async () => {
            fireEvent.click(nextStep4Button);
        });

        // Step 5: Founding Invites
        const genInvitesButton = screen.getByRole('button', { name: /Generate 3 Founding Invites/i });
        await act(async () => {
            fireEvent.click(genInvitesButton);
        });

        expect(nodeClient.generateNodeInvite).toHaveBeenCalledWith(
            mockProfile.url,
            mockProfile.adminPassword,
            'trusted',
            'tfa-wizard-token'
        );
    });

    it('re-runs enrollTotp and forwards updated effectiveTfaToken to 2fa setup endpoint', async () => {
        const { rerender } = render(
            <ColdStartWizard
                activeNode={mockProfile}
                diag={mockDiag}
                nodeData={{ members: [] }}
                tfaToken="tfa-initial"
                onComplete={vi.fn()}
            />
        );

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/admin/2fa/setup'),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'X-Admin-Password': 'admin-password',
                    'X-Admin-2FA-Session': 'tfa-initial',
                }),
            })
        );

        await act(async () => {
            rerender(
                <ColdStartWizard
                    activeNode={mockProfile}
                    diag={mockDiag}
                    nodeData={{ members: [] }}
                    tfaToken="tfa-updated"
                    onComplete={vi.fn()}
                />
            );
        });

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/admin/2fa/setup'),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'X-Admin-Password': 'admin-password',
                    'X-Admin-2FA-Session': 'tfa-updated',
                }),
            })
        );
    });
});

