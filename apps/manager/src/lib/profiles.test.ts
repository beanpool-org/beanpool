import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    loadNodeProfiles,
    loadActiveProfileId,
    saveActiveProfileId,
    saveNodeProfiles,
    updateNodeProfile,
    addNodeProfile,
    removeNodeProfile
} from './profiles';

// Mock node-client to avoid actual network/url normalization issues if any
vi.mock('./node-client', () => ({
    normalizeNodeUrl: (url: string) => url.replace(/\/+$/, '')
}));

describe('profiles', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.spyOn(Storage.prototype, 'getItem');
        vi.spyOn(Storage.prototype, 'setItem');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('loadNodeProfiles', () => {
        it('returns default profiles when empty', () => {
            const profiles = loadNodeProfiles();
            expect(profiles.length).toBeGreaterThan(0);
            expect(profiles[0].id).toBe('local-node');
        });

        it('loads and parses profiles from localStorage', () => {
            const mockProfiles = [{ id: 'mock-1', name: 'Mock', url: 'http://mock' }];
            localStorage.setItem('bp_fleet_profiles', JSON.stringify(mockProfiles));

            const profiles = loadNodeProfiles();
            // Should include local-node by default if not present
            expect(profiles.length).toBe(2);
            expect(profiles.find(p => p.id === 'mock-1')).toBeDefined();
        });
    });

    describe('active profile', () => {
        it('returns local-node by default', () => {
            expect(loadActiveProfileId()).toBe('local-node');
        });

        it('saves and loads active profile', () => {
            saveActiveProfileId('test-id');
            expect(localStorage.setItem).toHaveBeenCalledWith('bp_fleet_active_id', 'test-id');
            expect(loadActiveProfileId()).toBe('test-id');
        });
    });

    describe('saveNodeProfiles', () => {
        it('saves profiles to localStorage', () => {
            const mockProfiles = [{ id: 'mock-1', name: 'Mock', url: 'http://mock' }];
            saveNodeProfiles(mockProfiles);
            expect(localStorage.setItem).toHaveBeenCalledWith('bp_fleet_profiles', JSON.stringify(mockProfiles));
        });
    });

    describe('updateNodeProfile', () => {
        it('updates an existing profile', () => {
            const mockProfiles = [{ id: 'mock-1', name: 'Mock', url: 'http://mock' }];
            localStorage.setItem('bp_fleet_profiles', JSON.stringify(mockProfiles));

            const updated = updateNodeProfile('mock-1', { name: 'Updated Mock' });
            expect(updated.find(p => p.id === 'mock-1')?.name).toBe('Updated Mock');
        });
    });

    describe('addNodeProfile', () => {
        it('adds a new profile', () => {
            const initial = loadNodeProfiles();
            const added = addNodeProfile({ name: 'New Node', url: 'http://new' });

            expect(added.id).toBeDefined();
            expect(added.name).toBe('New Node');

            const final = loadNodeProfiles();
            expect(final.length).toBe(initial.length + 1);
        });
    });

    describe('removeNodeProfile', () => {
        it('removes a profile', () => {
            const added = addNodeProfile({ name: 'To Remove', url: 'http://remove' });
            const initial = loadNodeProfiles();

            removeNodeProfile(added.id);

            const final = loadNodeProfiles();
            expect(final.length).toBe(initial.length - 1);
            expect(final.find(p => p.id === added.id)).toBeUndefined();
        });
    });
});
