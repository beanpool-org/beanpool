import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

        it('calculates tier based on earned credit thresholds', () => {
            expect(getMemberTier({ earnedCredit: 1500 })).toBe('Elder');
            expect(getMemberTier({ earnedCredit: 700 })).toBe('Steward');
            expect(getMemberTier({ earnedCredit: 250 })).toBe('Resident');
            expect(getMemberTier({ earnedCredit: 50 })).toBe('Citizen');
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
});
