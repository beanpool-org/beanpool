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

    describe('Enterprise Card Avatar Rendering', () => {
        it('renders an img with resolved src and name as alt for bundled:// avatar', async () => {
            const bundledTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_pk_beanpool',
                    name: 'BeanPool Central',
                    avatar: 'bundled://sprout',
                    balance: 100,
                    creditLine: 0,
                    liveOffers: 0,
                },
            ];
            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(bundledTreasury);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={mockNodeData}
                        onRefresh={vi.fn()}
                    />
                );
            });

            const img = screen.getByRole('img', { name: 'BeanPool Central' });
            expect(img).toBeInTheDocument();
            expect(img).toHaveAttribute('src', '/avatars/avatar_sprout.jpg');
            expect(img).toHaveAttribute('alt', 'BeanPool Central');
            expect(screen.queryByText('bundled://sprout')).not.toBeInTheDocument();
        });

        it('renders an img for an /api/avatar URL with name as alt', async () => {
            const apiAvatarUrl = '/api/avatar/7d566ff87a5fd0dc35a81214388bfcca78a91406284f5dfc165dd20d9383ff46?size=thumb';
            const apiTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_pk_eggs',
                    name: 'Community Eggs',
                    avatar: apiAvatarUrl,
                    balance: 50,
                    creditLine: 0,
                    liveOffers: 0,
                },
            ];
            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(apiTreasury);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={mockNodeData}
                        onRefresh={vi.fn()}
                    />
                );
            });

            const img = screen.getByRole('img', { name: 'Community Eggs' });
            expect(img).toBeInTheDocument();
            expect(img).toHaveAttribute('src', apiAvatarUrl);
            expect(img).toHaveAttribute('alt', 'Community Eggs');
            expect(screen.queryByText(apiAvatarUrl)).not.toBeInTheDocument();
        });

        it('renders emoji as text for emoji avatar', async () => {
            const emojiTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_pk_tools',
                    name: 'Tool Shed',
                    avatar: '🛠️',
                    balance: 200,
                    creditLine: 0,
                    liveOffers: 0,
                },
            ];
            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(emojiTreasury);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={mockNodeData}
                        onRefresh={vi.fn()}
                    />
                );
            });

            expect(screen.getByText('🛠️')).toBeInTheDocument();
            expect(screen.getByRole('img', { name: 'Tool Shed' })).toBeInTheDocument();
        });

        it('renders fallback glyph for an empty avatar', async () => {
            const emptyTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_pk_empty',
                    name: 'No Avatar Co-op',
                    avatar: '',
                    balance: 10,
                    creditLine: 0,
                    liveOffers: 0,
                },
            ];
            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(emptyTreasury);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={mockNodeData}
                        onRefresh={vi.fn()}
                    />
                );
            });

            expect(screen.getByText('🌾')).toBeInTheDocument();
            expect(screen.getByRole('img', { name: 'No Avatar Co-op' })).toBeInTheDocument();
        });

        it('does not render raw URL string when image fails to load and falls back to glyph', async () => {
            const brokenUrl = 'https://example.com/broken-image.jpg';
            const brokenTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_pk_broken',
                    name: 'Broken Image Co-op',
                    avatar: brokenUrl,
                    balance: 10,
                    creditLine: 0,
                    liveOffers: 0,
                },
            ];
            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(brokenTreasury);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={mockNodeData}
                        onRefresh={vi.fn()}
                    />
                );
            });

            const img = screen.getByRole('img', { name: 'Broken Image Co-op' });
            expect(img).toBeInTheDocument();

            // Simulate image load error
            await act(async () => {
                fireEvent.error(img);
            });

            expect(screen.getByText('🌾')).toBeInTheDocument();
            expect(screen.getByRole('img', { name: 'Broken Image Co-op' })).toBeInTheDocument();
            expect(screen.queryByText(brokenUrl)).not.toBeInTheDocument();
        });
    });

    describe('Keeper resolution and identity resilience (Defect 2)', () => {
        it('resolves a keeper given as a bare pubkey string to the member callsign', async () => {
            const barePubkeyTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_eggs_1',
                    name: 'Community Eggs',
                    avatar: '🥚',
                    balance: 35.82,
                    creditLine: 200,
                    liveOffers: 1,
                    keepers: ['89aa85a84d1234567890abcdef'],
                },
            ];

            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(barePubkeyTreasury);
            vi.spyOn(nodeClient, 'fetchTreasuryKeepers').mockResolvedValue(['89aa85a84d1234567890abcdef']);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={{
                            members: [
                                {
                                    publicKey: '89aa85a84d1234567890abcdef',
                                    callsign: 'MOnsta MAGic',
                                    tier: 'Resident',
                                },
                            ],
                        }}
                        onRefresh={vi.fn()}
                    />
                );
            });

            expect(screen.getByText('Community Eggs')).toBeInTheDocument();
            expect(screen.getByText('@MOnsta MAGic')).toBeInTheDocument();
        });

        it('resolves a keeper given as a bare pubkey string case-insensitively', async () => {
            const barePubkeyTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_eggs_case',
                    name: 'Community Eggs',
                    avatar: '🥚',
                    balance: 35.82,
                    creditLine: 200,
                    liveOffers: 1,
                    keepers: ['89AA85A84D1234567890ABCDEF'],
                },
            ];

            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(barePubkeyTreasury);
            vi.spyOn(nodeClient, 'fetchTreasuryKeepers').mockResolvedValue(['89AA85A84D1234567890ABCDEF']);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={{
                            members: [
                                {
                                    publicKey: '89aa85a84d1234567890abcdef',
                                    callsign: 'MOnsta MAGic',
                                    tier: 'Resident',
                                },
                            ],
                        }}
                        onRefresh={vi.fn()}
                    />
                );
            });

            expect(screen.getByText('@MOnsta MAGic')).toBeInTheDocument();
        });

        it('shows a keeper given as an object with callsign without needing the members list', async () => {
            const objectKeeperTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_eggs_2',
                    name: 'Community Eggs',
                    avatar: '🥚',
                    balance: 35.82,
                    creditLine: 200,
                    liveOffers: 1,
                    keepers: [
                        {
                            publicKey: 'bd3e4acb8b1234567890abcdef',
                            callsign: 'Marty Party2',
                            avatarUrl: null,
                            grantedAt: '2026-09-02T00:00:00Z',
                        },
                    ],
                },
            ];

            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(objectKeeperTreasury);
            vi.spyOn(nodeClient, 'fetchTreasuryKeepers').mockResolvedValue(objectKeeperTreasury[0].keepers as any);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={{ members: [] }}
                        onRefresh={vi.fn()}
                    />
                );
            });

            expect(screen.getByText('Community Eggs')).toBeInTheDocument();
            expect(screen.getByText('@Marty Party2')).toBeInTheDocument();
        });

        it('degrades an unknown pubkey to a short hash without crashing', async () => {
            const unknownKeeperTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_unknown_keeper',
                    name: 'Unknown Co-op',
                    avatar: '🌾',
                    balance: 0,
                    creditLine: 0,
                    liveOffers: 0,
                    keepers: ['1234567890abcdef1234567890'],
                },
            ];

            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(unknownKeeperTreasury);
            vi.spyOn(nodeClient, 'fetchTreasuryKeepers').mockResolvedValue(['1234567890abcdef1234567890']);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={{ members: [] }}
                        onRefresh={vi.fn()}
                    />
                );
            });

            expect(screen.getByText('Unknown Co-op')).toBeInTheDocument();
            expect(screen.getByText('@1234567890...')).toBeInTheDocument();
        });

        it('shows keeper names in manage keepers drawer for both string and object shapes', async () => {
            const mixedTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_mixed_keepers',
                    name: 'Community Eggs',
                    avatar: '🥚',
                    balance: 35.82,
                    creditLine: 200,
                    liveOffers: 1,
                    keepers: [
                        '89aa85a84d1234567890abcdef',
                        {
                            publicKey: 'bd3e4acb8b1234567890abcdef',
                            callsign: 'Marty Party2',
                        },
                    ],
                },
            ];

            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(mixedTreasury);
            vi.spyOn(nodeClient, 'fetchTreasuryKeepers').mockResolvedValue(mixedTreasury[0].keepers as any);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={{
                            members: [
                                {
                                    publicKey: '89aa85a84d1234567890abcdef',
                                    callsign: 'MOnsta MAGic',
                                },
                            ],
                        }}
                        onRefresh={vi.fn()}
                    />
                );
            });

            // Open Manage Keepers modal
            const manageBtn = screen.getByRole('button', { name: /manage/i });
            await act(async () => {
                fireEvent.click(manageBtn);
            });

            expect(screen.getByText(/Manage Keepers — Community Eggs/i)).toBeInTheDocument();
            expect(screen.getAllByText('@MOnsta MAGic')).toHaveLength(2);
            expect(screen.getAllByText('@Marty Party2')).toHaveLength(2);
        });

        it('resolves member name when keeper object has empty string publicKey and populated alias', async () => {
            const aliasKeeperTreasury: nodeClient.NodeTreasury[] = [
                {
                    publicKey: 'treasury_alias_keeper',
                    name: 'Bakery Co-op',
                    avatar: '🍞',
                    balance: 10,
                    creditLine: 50,
                    liveOffers: 1,
                    keepers: [
                        {
                            publicKey: '',
                            pubkey: 'pk_baker_bob',
                        } as any,
                    ],
                },
            ];

            vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue(aliasKeeperTreasury);
            vi.spyOn(nodeClient, 'fetchTreasuryKeepers').mockResolvedValue(aliasKeeperTreasury[0].keepers as any);

            await act(async () => {
                render(
                    <EconomySection
                        activeNode={mockProfile}
                        nodeData={{
                            members: [
                                {
                                    publicKey: 'pk_baker_bob',
                                    callsign: 'Baker Bob',
                                },
                            ],
                        }}
                        onRefresh={vi.fn()}
                    />
                );
            });

            expect(screen.getByText('Bakery Co-op')).toBeInTheDocument();
            expect(screen.getByText('@Baker Bob')).toBeInTheDocument();
        });
    });
});
