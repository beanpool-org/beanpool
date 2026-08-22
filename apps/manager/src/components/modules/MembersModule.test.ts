import { describe, it, expect } from 'vitest';
import { getMemberDisplayName, getMemberAvatar } from './MembersModule';

describe('MembersModule helper functions with Map / Array lookups', () => {
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
});
