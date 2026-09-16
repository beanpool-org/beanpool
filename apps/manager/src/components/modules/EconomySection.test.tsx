import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

    it('handles keepers returned as objects without crashing on pubkey.slice', async () => {
        const objectKeepers = [
            {
                publicKey: '021234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                callsign: 'doone',
                avatarUrl: null,
                grantedAt: '2026-09-02T00:00:00Z',
            },
        ];

        const treasuriesWithObjectKeepers: any[] = [
            {
                publicKey: 'treasury_pk_object_keepers',
                name: 'Community Bakery',
                avatar: '🥖',
                balance: 100,
                creditLine: 50,
                liveOffers: 1,
                keepers: objectKeepers,
            },
        ];

        vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(treasuriesWithObjectKeepers as any);
        vi.spyOn(nodeClient, 'fetchTreasuryKeepers').mockResolvedValue(objectKeepers as any);

        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={{
                        members: [
                            {
                                publicKey: '021234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                                name: 'doone',
                                tier: 'Steward',
                            },
                        ],
                    }}
                    onRefresh={vi.fn()}
                />
            );
        });

        expect(screen.getByText('Community Bakery')).toBeInTheDocument();
        expect(screen.getByText('@doone')).toBeInTheDocument();
    });

    it('renders safely with empty nodeData and empty treasuries', async () => {
        vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue([]);

        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={{}}
                    onRefresh={vi.fn()}
                />
            );
        });

        expect(screen.getByText('Shared Projects & Economy')).toBeInTheDocument();
        expect(screen.getByText(/No enterprises created yet/i)).toBeInTheDocument();
    });

    it('handles malformed wrong-typed keepers (numbers, nulls, empty objects)', async () => {
        const malformedTreasuries: any[] = [
            {
                publicKey: 'treasury_pk_malformed',
                name: 'Malformed Enterprise',
                avatar: '🌱',
                balance: 0,
                creditLine: 0,
                liveOffers: 0,
                keepers: [12345, null, undefined, {}],
            },
        ];

        vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(malformedTreasuries as any);

        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={{ members: [] }}
                    onRefresh={vi.fn()}
                />
            );
        });

        expect(screen.getByText('Malformed Enterprise')).toBeInTheDocument();
        // Should not throw or crash
    });

    it('revokes a keeper whose public key is stored on pubkey property', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        const keeperWithPubkey = [
            {
                pubkey: 'nostr_pubkey_keeper_999',
                callsign: 'clara',
            },
        ];

        const treasuriesWithCustomKeeper: any[] = [
            {
                publicKey: 'treasury_pk_custom_keeper',
                name: 'Community Bakery',
                avatar: '🥖',
                balance: 100,
                creditLine: 0,
                liveOffers: 1,
                keepers: keeperWithPubkey,
            },
        ];

        vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(treasuriesWithCustomKeeper as any);
        vi.spyOn(nodeClient, 'fetchTreasuryKeepers').mockResolvedValue(keeperWithPubkey as any);
        vi.spyOn(nodeClient, 'revokeTreasuryKeeper').mockResolvedValue([]);

        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={{
                        members: [
                            {
                                pubkey: 'nostr_pubkey_keeper_999',
                                name: 'clara',
                                tier: 'Steward',
                            },
                        ],
                    }}
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
            'treasury_pk_custom_keeper',
            'nostr_pubkey_keeper_999',
            mockProfile.adminPassword,
            undefined
        );
    });

    it('filters out existing keepers with pubkey property from directory dropdown', async () => {
        const keeperWithPubkey = [
            {
                pubkey: 'already_assigned_pk',
                callsign: 'keeper_one',
            },
        ];

        const treasuries: any[] = [
            {
                publicKey: 'treasury_pk_filter_test',
                name: 'Community Farm',
                avatar: '🌱',
                balance: 100,
                creditLine: 0,
                liveOffers: 1,
                keepers: keeperWithPubkey,
            },
        ];

        vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(treasuries as any);
        vi.spyOn(nodeClient, 'fetchTreasuryKeepers').mockResolvedValue(keeperWithPubkey as any);

        await act(async () => {
            render(
                <EconomySection
                    activeNode={mockProfile}
                    nodeData={{
                        members: [
                            {
                                pubkey: 'already_assigned_pk',
                                name: 'keeper_one',
                                tier: 'Steward',
                            },
                            {
                                pubkey: 'unassigned_member_pk',
                                name: 'unassigned_member',
                                tier: 'Resident',
                            },
                        ],
                    }}
                    onRefresh={vi.fn()}
                />
            );
        });

        const manageButton = screen.getAllByRole('button', { name: /manage/i })[0];
        await act(async () => {
            fireEvent.click(manageButton);
        });

        const select = screen.getByLabelText(/Select Member/i) as HTMLSelectElement;
        const optionValues = Array.from(select.options).map((opt) => opt.value);

        expect(optionValues).toContain('unassigned_member_pk');
        expect(optionValues).not.toContain('already_assigned_pk');
    });
});

