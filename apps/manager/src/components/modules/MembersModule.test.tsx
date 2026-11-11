import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import * as nodeClient from '../../lib/node-client';
import { PICKED_PHOTO, pickOfferPhoto } from '../common/__tests__/offer-photo-helpers';

// jsdom decodes no pictures: a picked photo comes back as PICKED_PHOTO (offer-photo-helpers).
vi.mock('../../lib/photo-resize', () => ({ resizePhotoFile: vi.fn(async () => 'data:image/jpeg;base64,cmVzaXplZA==') }));
import {
    MembersModule,
    getMemberDisplayName,
    getMemberAvatar,
    fmtDate,
    fmtLastActive,
    getMemberTier,
} from './MembersModule';

describe('MembersModule helper functions', () => {
    const mockProfiles = [
        { publicKey: 'pk-alice-12345678', name: 'Alice Smith', avatar: 'http://avatar.example/alice.png' },
        { pubkey: 'pk-bob-87654321', displayName: 'Bob Jones', avatarUrl: 'http://avatar.example/bob.png' },
    ];

    const mockProfilesMap = new Map<string, any>([
        ['pk-alice-12345678', mockProfiles[0]],
        ['pk-bob-87654321', mockProfiles[1]],
    ]);

    describe('getMemberDisplayName', () => {
        it('resolves name using Array lookup', () => {
            expect(getMemberDisplayName({ publicKey: 'pk-alice-12345678' }, mockProfiles)).toBe('Alice Smith');
            expect(getMemberDisplayName({ pubkey: 'pk-bob-87654321' }, mockProfiles)).toBe('Bob Jones');
        });

        it('resolves name using Map lookup', () => {
            expect(getMemberDisplayName({ publicKey: 'pk-alice-12345678' }, mockProfilesMap)).toBe('Alice Smith');
            expect(getMemberDisplayName({ pubkey: 'pk-bob-87654321' }, mockProfilesMap)).toBe('Bob Jones');
        });

        it('returns System Node Operator for SYSTEM pubkey', () => {
            expect(getMemberDisplayName({ publicKey: 'SYSTEM' }, mockProfilesMap)).toBe('System Node Operator');
            expect(getMemberDisplayName({ pubkey: 'SYSTEM-1' }, mockProfilesMap)).toBe('System Node Operator');
        });

        it('resolves name using Array lookup with memberPubkey alias case-insensitively', () => {
            const profilesWithAlias = [
                { memberPubkey: 'PK-ALICE-12345678', name: 'Alice Alias' } as any,
            ];
            expect(getMemberDisplayName({ publicKey: 'pk-alice-12345678' }, profilesWithAlias)).toBe('Alice Alias');
        });

        it('falls back to member object properties if not in profiles', () => {
            expect(getMemberDisplayName({ publicKey: 'pk-charlie', name: 'Charlie' }, mockProfilesMap)).toBe('Charlie');
        });
    });

    describe('getMemberAvatar', () => {
        it('resolves avatar URL using Array lookup', () => {
            expect(getMemberAvatar({ publicKey: 'pk-alice-12345678' }, mockProfiles)).toBe('http://avatar.example/alice.png');
            expect(getMemberAvatar({ pubkey: 'pk-bob-87654321' }, mockProfiles)).toBe('http://avatar.example/bob.png');
        });

        it('resolves avatar URL using Map lookup', () => {
            expect(getMemberAvatar({ publicKey: 'pk-alice-12345678' }, mockProfilesMap)).toBe('http://avatar.example/alice.png');
            expect(getMemberAvatar({ pubkey: 'pk-bob-87654321' }, mockProfilesMap)).toBe('http://avatar.example/bob.png');
        });

        it('returns null if no avatar is found', () => {
            expect(getMemberAvatar({ publicKey: 'unknown-pk' }, mockProfilesMap)).toBeNull();
        });
    });

    describe('fmtDate', () => {
        it('returns N/A when iso date string is missing or invalid', () => {
            expect(fmtDate(null)).toBe('N/A');
            expect(fmtDate(undefined)).toBe('N/A');
            expect(fmtDate('invalid-date')).toBe('N/A');
        });

        it('formats valid ISO date string correctly', () => {
            const formatted = fmtDate('2026-01-15T00:00:00.000Z');
            expect(formatted).toContain('2026');
            expect(formatted).toContain('Jan');
        });
    });

    describe('fmtLastActive', () => {
        it('returns Unknown for missing or invalid date strings', () => {
            expect(fmtLastActive(null)).toBe('Unknown');
            expect(fmtLastActive('invalid')).toBe('Unknown');
        });

        it('returns Active today for current timestamp', () => {
            expect(fmtLastActive(new Date().toISOString())).toBe('Active today');
        });

        // The node serves other members' last activity as the UTC day only (secret ballots), e.g.
        // "2026-09-18T00:00:00.000Z". Any time of day, today's day reads as today and yesterday's as yesterday.
        it('reads the day-only value the node serves', () => {
            const today = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
            const yesterday = `${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
            expect(fmtLastActive(today)).toBe('Active today');
            expect(fmtLastActive(yesterday)).toBe('Active yesterday');
        });
    });

    describe('getMemberTier', () => {
        it('returns Citizen as default for null/undefined member', () => {
            expect(getMemberTier(null)).toBe('Citizen');
            expect(getMemberTier(undefined)).toBe('Citizen');
        });

        it('returns Elder for SYSTEM pubkeys', () => {
            expect(getMemberTier({ publicKey: 'SYSTEM' })).toBe('Elder');
        });

        it('returns explicitly set tier or standing', () => {
            expect(getMemberTier({ tier: 'Steward' })).toBe('Steward');
            expect(getMemberTier({ standing: 'Resident' })).toBe('Resident');
        });

        // The node's earnedCredit is whole hundredths of a Bean (engine members.ts earned_credit_c), as core's thresholds are.
        it('calculates tier based on earned credit thresholds', () => {
            expect(getMemberTier({ earnedCredit: 150000 })).toBe('Elder');
            expect(getMemberTier({ earnedCredit: 70000 })).toBe('Steward');
            expect(getMemberTier({ earnedCredit: 25000 })).toBe('Resident');
            expect(getMemberTier({ earnedCredit: 5000 })).toBe('Citizen');
            // Exactly at the line, to the hundredth: 1,400 Beans is Elder, 1,399.99 is not.
            expect(getMemberTier({ earnedCredit: 140000 })).toBe('Elder');
            expect(getMemberTier({ earnedCredit: 139999 })).toBe('Steward');
        });
    });
});

describe('MembersModule Component', () => {
    const mockNodeData = {
        members: [
            { publicKey: 'pk-alice-12345678', name: 'Alice Smith', tier: 'Steward', platform: 'ios' },
            { pubkey: 'pk-bob-87654321', name: 'Bob Jones', tier: 'Resident', platform: 'android' },
        ],
        profiles: [
            { publicKey: 'pk-alice-12345678', name: 'Alice Smith' },
            { pubkey: 'pk-bob-87654321', name: 'Bob Jones' },
        ],
        posts: [],
        health: { healthScore: 98, flags: [] },
        reports: [],
    };

    it('renders unauthenticated fallback message when nodeData is null', () => {
        render(
            <MembersModule
                nodeData={null}
                nodeDataLoading={false}
                onRefresh={vi.fn()}
            />
        );

        expect(
            screen.getByText(/Authenticate with Admin Password to view node member standing/i)
        ).toBeInTheDocument();
    });

    it('renders member roster and triggers onRefresh when button is clicked', () => {
        const onRefresh = vi.fn();
        render(
            <MembersModule
                nodeData={mockNodeData}
                nodeDataLoading={false}
                onRefresh={onRefresh}
            />
        );

        expect(screen.getByText('Alice Smith')).toBeInTheDocument();
        expect(screen.getByText('Bob Jones')).toBeInTheDocument();
        expect(screen.getByText('98%')).toBeInTheDocument();

        const refreshBtn = screen.getByRole('button', { name: /Refresh Roster/i });
        fireEvent.click(refreshBtn);
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('filters member roster using search input', () => {
        render(
            <MembersModule
                nodeData={mockNodeData}
                nodeDataLoading={false}
                onRefresh={vi.fn()}
            />
        );

        const searchInput = screen.getByPlaceholderText(/Filter members by name or pubkey/i);
        fireEvent.change(searchInput, { target: { value: 'Alice' } });

        expect(screen.getByText('Alice Smith')).toBeInTheDocument();
        expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument();
    });

    it('preserves explicit viewerRole={null} and restricts role actions in detail modal', () => {
        render(
            <MembersModule
                nodeData={mockNodeData}
                nodeDataLoading={false}
                viewerRole={null}
                onRefresh={vi.fn()}
            />
        );

        const inspectButtons = screen.getAllByRole('button', { name: 'Inspect' });
        fireEvent.click(inspectButtons[0]);

        expect(screen.getByText("Only an owner can change this member's role.")).toBeInTheDocument();
        expect(screen.queryByText(/Grant Owner/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Grant Admin/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Grant Moderator/i)).not.toBeInTheDocument();
    });
});

describe('MembersModule seed offer', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('says "📷 Add a photo" and posts nothing until a photo is chosen, then sends the Offer with it (the node refuses an Offer with none)', async () => {
        vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue([
            { publicKey: 'pk-eggs', name: 'Community Eggs', balance_c: 0, creditLine_c: 20000, liveOffers: 0 },
        ]);
        vi.spyOn(nodeClient, 'fetchKnownFloorMarks').mockResolvedValue({});
        const seed = vi.spyOn(nodeClient, 'seedTreasuryOffer').mockResolvedValue({ success: true, post: {} });

        await act(async () => {
            render(
                <MembersModule
                    nodeData={{ members: [], profiles: [], posts: [], health: { healthScore: 98, flags: [] }, reports: [] }}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    activeNodeUrl="https://node.example.com"
                    credential="admin-pw"
                />
            );
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: '+ Post Offer' }));
        });

        const addPhotoBtn = screen.getByRole('button', { name: '📷 Add a photo' });
        expect(addPhotoBtn).toBeDisabled();
        expect(screen.queryByRole('button', { name: /Post Offer to Market/ })).not.toBeInTheDocument();
        await act(async () => { fireEvent.click(addPhotoBtn); });
        expect(seed).not.toHaveBeenCalled();

        await pickOfferPhoto();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Post Offer to Market/ }));
        });

        expect(seed).toHaveBeenCalledTimes(1);
        // The form's 12 Beans as the node takes a price: price_c, whole hundredths, never the old `credits`.
        expect(seed).toHaveBeenCalledWith(
            'https://node.example.com',
            'pk-eggs',
            expect.objectContaining({ title: 'Dozen free-range eggs', photos: [PICKED_PHOTO], repeatable: true, price_c: 1200 }),
            'admin-pw',
            undefined
        );
        expect(seed.mock.calls[0][2]).not.toHaveProperty('credits');
    });

    it("marks a member whose known floor an admin changed, the amount whole hundredths in words", async () => {
        vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue([]);
        vi.spyOn(nodeClient, 'fetchKnownFloorMarks').mockResolvedValue({
            'pk-kim-12345678': { amount_c: 49925, frozen: false },
            'pk-lee-12345678': { amount_c: null, frozen: true },
        });
        await act(async () => {
            render(
                <MembersModule
                    nodeData={{
                        members: [{ publicKey: 'pk-kim-12345678', name: 'Kim' }, { publicKey: 'pk-lee-12345678', name: 'Lee' }],
                        profiles: [], posts: [], health: { healthScore: 98, flags: [] }, reports: [],
                    }}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    activeNodeUrl="https://node.example.com"
                    credential="admin-pw"
                />
            );
        });
        const marks = await screen.findAllByTestId('known-floor-mark');
        expect(marks.map((m) => m.textContent)).toEqual(['Known floor 499.25', 'Known floor frozen']);
    });

    it("lists each treasury's balance and limit as whole hundredths in words", async () => {
        vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue([
            { publicKey: 'pk-eggs', name: 'Community Eggs', balance_c: 4925, creditLine_c: 20000, liveOffers: 2 },
            { publicKey: 'pk-tools', name: 'Tool Shed', balance_c: -982, creditLine_c: 0, liveOffers: 0 },
        ]);
        vi.spyOn(nodeClient, 'fetchKnownFloorMarks').mockResolvedValue({});
        await act(async () => {
            render(
                <MembersModule
                    nodeData={{ members: [], profiles: [], posts: [], health: { healthScore: 98, flags: [] }, reports: [] }}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    activeNodeUrl="https://node.example.com"
                    credential="admin-pw"
                />
            );
        });
        expect(await screen.findByText('49.25 🫘 · Limit: 200 🫘 · 2 offer(s)')).toBeInTheDocument();
        expect(screen.getByText('−9.82 🫘 · Limit: 0 🫘 · 0 offer(s)')).toBeInTheDocument();
    });

    it('creates a treasury with its typed credit line as creditLine_c', async () => {
        vi.spyOn(nodeClient, 'fetchNodeTreasuries').mockResolvedValue([]);
        vi.spyOn(nodeClient, 'fetchKnownFloorMarks').mockResolvedValue({});
        const create = vi.spyOn(nodeClient, 'createNodeTreasury').mockResolvedValue({ success: true, publicKey: 'pk-new' });
        await act(async () => {
            render(
                <MembersModule
                    nodeData={{ members: [], profiles: [], posts: [], health: { healthScore: 98, flags: [] }, reports: [] }}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    activeNodeUrl="https://node.example.com"
                    credential="admin-pw"
                />
            );
        });
        await act(async () => {
            fireEvent.click(await screen.findByRole('button', { name: /Create Treasury/ }));
        });
        fireEvent.change(screen.getByPlaceholderText('e.g. Community Eggs'), { target: { value: 'Seed Bank' } });
        fireEvent.change(screen.getByPlaceholderText('200'), { target: { value: '150.75' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Create Treasury' }));
        });
        expect(create).toHaveBeenCalledWith(
            'https://node.example.com',
            expect.objectContaining({ name: 'Seed Bank', creditLine_c: 15075 }),
            'admin-pw',
            undefined,
        );
        expect(create.mock.calls[0][1]).not.toHaveProperty('creditLine');
    });
});
