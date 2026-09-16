import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EconomySection } from './EconomySection';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';

const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Test Node',
    url: 'https://test-node.local',
    adminPassword: 'admin-password',
};

const mockTreasuries: nodeClient.NodeTreasury[] = [
    {
        publicKey: 'treasury_pk_1234567890',
        name: 'Community Garden',
        avatar: '🌾',
        balance: 150,
        creditLine: 0,
        liveOffers: 2,
        purpose: 'Fresh vegetables for the community',
        workingCapitalCeiling: 250,
        keepers: ['member_pk_alice'],
    },
];

const mockNodeData: nodeClient.NodeDataPayload = {
    members: [
        { publicKey: 'member_pk_alice', name: 'alice', tier: 'Steward' },
        { publicKey: 'member_pk_bob', name: 'bob', tier: 'Resident' },
    ],
};

describe('EconomySection Component', () => {
    beforeEach(() => {
        sessionStorage.clear();
        vi.clearAllMocks();
        vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(mockTreasuries);
        vi.spyOn(nodeClient, 'fetchTreasuryKeepers').mockResolvedValue(['member_pk_alice']);
        vi.spyOn(nodeClient, 'assignTreasuryKeeper').mockResolvedValue(['member_pk_alice', 'member_pk_bob']);
        vi.spyOn(nodeClient, 'revokeTreasuryKeeper').mockResolvedValue([]);
        vi.spyOn(nodeClient, 'createNodeTreasury').mockResolvedValue({
            success: true,
            publicKey: 'treasury_pk_new',
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ proposed: [], activeRound: null, pastRounds: [] }),
        }));
    });

    afterEach(() => {
        sessionStorage.clear();
    });

    it('renders enterprises and displays keeper information', async () => {
        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={mockNodeData}
                    onRefresh={vi.fn()}
                />
            );
        });

        expect(screen.getByText('Shared Projects & Economy')).toBeInTheDocument();
        expect(screen.getByText('Community Garden')).toBeInTheDocument();
        expect(screen.getByText('@alice')).toBeInTheDocument();
        expect(screen.getByText(/Ceiling:/i)).toBeInTheDocument();
        expect(screen.getByText('250 beans')).toBeInTheDocument();
    });

    it('opens Create Enterprise modal and applies preset', async () => {
        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={mockNodeData}
                    onRefresh={vi.fn()}
                />
            );
        });

        const createButton = screen.getByRole('button', { name: /create enterprise/i });
        await act(async () => {
            fireEvent.click(createButton);
        });

        expect(screen.getByText('🌾 Create Community Enterprise')).toBeInTheDocument();
        expect(screen.getByText('Tool Shed & Workshop')).toBeInTheDocument();

        // Click a preset
        const toolShedPreset = screen.getByRole('button', { name: /tool shed & workshop/i });
        await act(async () => {
            fireEvent.click(toolShedPreset);
        });

        const nameInput = screen.getByPlaceholderText(/Community Eggs, Tool Shed, Bakery/i) as HTMLInputElement;
        expect(nameInput.value).toBe('Tool Shed & Workshop');
    });

    it('opens Manage Keepers modal and assigns a keeper', async () => {
        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={mockNodeData}
                    onRefresh={vi.fn()}
                />
            );
        });

        // Click "Manage" or "Keepers" button
        const manageButton = screen.getAllByRole('button', { name: /manage/i })[0];
        await act(async () => {
            fireEvent.click(manageButton);
        });

        expect(screen.getByText(/Manage Keepers — Community Garden/i)).toBeInTheDocument();
        expect(screen.getAllByText('@alice').length).toBeGreaterThanOrEqual(1);

        // Select bob from dropdown
        const select = screen.getByLabelText(/Select Member/i);
        await act(async () => {
            fireEvent.change(select, { target: { value: 'member_pk_bob' } });
        });

        const assignButton = screen.getByRole('button', { name: /\+ assign keeper/i });
        await act(async () => {
            fireEvent.click(assignButton);
        });

        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_1234567890',
            'member_pk_bob',
            mockProfile.adminPassword,
            undefined
        );
    });

    it('revokes a keeper with confirmation', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={mockNodeData}
                    onRefresh={vi.fn()}
                />
            );
        });

        const manageButton = screen.getAllByRole('button', { name: /manage/i })[0];
        await act(async () => {
            fireEvent.click(manageButton);
        });

        const revokeButton = screen.getByRole('button', { name: /revoke/i });
        await act(async () => {
            fireEvent.click(revokeButton);
        });

        expect(nodeClient.revokeTreasuryKeeper).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_1234567890',
            'member_pk_alice',
            mockProfile.adminPassword,
            undefined
        );
    });

    it('confirms Commons Pool tab has NO demurrage slider or protocol-parameter controls', async () => {
        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={mockNodeData}
                    onRefresh={vi.fn()}
                />
            );
        });

        const poolTabButton = screen.getByRole('button', { name: /commons pool/i });
        await act(async () => {
            fireEvent.click(poolTabButton);
        });

        expect(screen.getByText(/Community Commons Pool Health/i)).toBeInTheDocument();
        expect(screen.getByText(/0.0 drift/i)).toBeInTheDocument();
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
        expect(screen.queryByText(/demurrage rate/i)).not.toBeInTheDocument();
    });

    it('forwards 2FA session token to createNodeTreasury when creating an enterprise', async () => {
        nodeClient.setTfaSessionToken(mockProfile.id, 'tfa-sess-economy');

        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={mockNodeData}
                    onRefresh={vi.fn()}
                />
            );
        });

        const createButton = screen.getByRole('button', { name: /create enterprise/i });
        await act(async () => {
            fireEvent.click(createButton);
        });

        const nameInput = screen.getByPlaceholderText(/Community Eggs, Tool Shed, Bakery/i);
        fireEvent.change(nameInput, { target: { value: 'Community Bakery' } });

        const submitBtn = screen.getByRole('button', { name: /^create enterprise$/i });
        await act(async () => {
            fireEvent.click(submitBtn);
        });

        expect(nodeClient.createNodeTreasury).toHaveBeenCalledWith(
            mockProfile.url,
            expect.objectContaining({ name: 'Community Bakery' }),
            mockProfile.adminPassword,
            'tfa-sess-economy'
        );

        nodeClient.setTfaSessionToken(mockProfile.id, undefined);
    });

    it('forwards 2FA session token to seedTreasuryOffer when posting an initial offer', async () => {
        nodeClient.setTfaSessionToken(mockProfile.id, 'tfa-sess-economy');
        vi.spyOn(nodeClient, 'seedTreasuryOffer').mockResolvedValue({
            success: true,
            post: {},
        });

        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={mockNodeData}
                    onRefresh={vi.fn()}
                />
            );
        });

        const seedOfferBtn = screen.getByRole('button', { name: /seed offer/i });
        await act(async () => {
            fireEvent.click(seedOfferBtn);
        });

        expect(screen.getByText(/Post Initial Offer for Community Garden/i)).toBeInTheDocument();

        const titleInput = screen.getByPlaceholderText(/e\.g\. Fresh farm eggs dozen/i);
        fireEvent.change(titleInput, { target: { value: 'Organic Veggie Box' } });

        const postOfferBtn = screen.getByRole('button', { name: /post offer/i });
        await act(async () => {
            fireEvent.click(postOfferBtn);
        });

        expect(nodeClient.seedTreasuryOffer).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_1234567890',
            expect.objectContaining({ title: 'Organic Veggie Box' }),
            mockProfile.adminPassword,
            'tfa-sess-economy'
        );

        nodeClient.setTfaSessionToken(mockProfile.id, undefined);
    });

    it('forwards tfaToken prop to assignTreasuryKeeper and revokeTreasuryKeeper', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={mockNodeData}
                    tfaToken="tfa-prop-xyz"
                    onRefresh={vi.fn()}
                />
            );
        });

        const manageButton = screen.getAllByRole('button', { name: /manage/i })[0];
        await act(async () => {
            fireEvent.click(manageButton);
        });

        expect(nodeClient.fetchTreasuryKeepers).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_1234567890',
            mockProfile.adminPassword,
            'tfa-prop-xyz'
        );

        const select = screen.getByLabelText(/Select Member/i);
        await act(async () => {
            fireEvent.change(select, { target: { value: 'member_pk_bob' } });
        });

        const assignButton = screen.getByRole('button', { name: /\+ assign keeper/i });
        await act(async () => {
            fireEvent.click(assignButton);
        });

        expect(nodeClient.assignTreasuryKeeper).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_1234567890',
            'member_pk_bob',
            mockProfile.adminPassword,
            'tfa-prop-xyz'
        );

        const revokeButton = screen.getAllByRole('button', { name: /revoke/i })[0];
        await act(async () => {
            fireEvent.click(revokeButton);
        });

        expect(nodeClient.revokeTreasuryKeeper).toHaveBeenCalledWith(
            mockProfile.url,
            'treasury_pk_1234567890',
            'member_pk_alice',
            mockProfile.adminPassword,
            'tfa-prop-xyz'
        );
    });
});
