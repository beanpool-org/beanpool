import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
        expect(localStorage.getItem('bp_founding_invites_status')).toBe('1/3 founding invites claimed · node ready for trade');
    });
});
