import { describe, it, expect, beforeEach } from 'vitest';
import { loadNodeProfiles, saveNodeProfiles, addNodeProfile, removeNodeProfile, updateNodeProfile, nodeCredential } from './profiles';

let store: Record<string, string> = {};
const mockLocalStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; }
};
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true, configurable: true });
Object.defineProperty(globalThis, 'window', { value: { location: { port: '3000', origin: 'http://localhost:3000' } }, writable: true, configurable: true });

describe('profiles management', () => {
    beforeEach(() => {
        store = {};
    });

    it('loads default profiles when localStorage is empty', () => {
        const profiles = loadNodeProfiles();
        expect(profiles.length).toBeGreaterThanOrEqual(1);
        expect(profiles.some(p => p.id === 'local-node')).toBe(true);
    });

    it('removes a node profile successfully and does not resurrect local-node', () => {
        // Initial load creates defaults
        const initial = loadNodeProfiles();
        expect(initial.some(p => p.id === 'local-node')).toBe(true);

        // Add a secondary node so we have multiple
        const added = addNodeProfile({ name: 'Custom Node', url: 'https://custom.beanpool.org' });
        expect(loadNodeProfiles().length).toBe(initial.length + 1);

        // Remove local-node
        removeNodeProfile('local-node');

        const remaining = loadNodeProfiles();
        expect(remaining.some(p => p.id === 'local-node')).toBe(false);
        expect(remaining.some(p => p.id === added.id)).toBe(true);
    });

    it('removes a custom node profile successfully', () => {
        const added = addNodeProfile({ name: 'Node to Remove', url: 'https://removeme.beanpool.org' });
        expect(loadNodeProfiles().some(p => p.id === added.id)).toBe(true);

        removeNodeProfile(added.id);
        expect(loadNodeProfiles().some(p => p.id === added.id)).toBe(false);
    });

    // Fable's web review, M1: localStorage on a node is the members' web app's origin too. A profile's automation token
    // is held in memory for the page's lifetime and never written there, and a list an older build stored (with an admin
    // password or a replication token in it) is scrubbed on load.
    it('never writes a profile token to localStorage, and drops the old password and replication token an older build stored', () => {
        store['bp_fleet_profiles'] = JSON.stringify([
            { id: 'local-node', name: 'Local', url: 'http://localhost:3000', adminPassword: 'old-stored-pw', replicationToken: 'old-stored-token', automationToken: 'old-stored-automation' },
        ]);
        const loaded = loadNodeProfiles();
        expect(loaded[0].automationToken).toBeUndefined();
        expect((loaded[0] as unknown as Record<string, unknown>).adminPassword).toBeUndefined();
        expect((loaded[0] as unknown as Record<string, unknown>).replicationToken).toBeUndefined();
        expect(store['bp_fleet_profiles']).not.toContain('old-stored-pw');
        expect(store['bp_fleet_profiles']).not.toContain('old-stored-token');
        expect(store['bp_fleet_profiles']).not.toContain('old-stored-automation');
        expect(store['bp_fleet_profiles']).not.toContain('adminPassword');
        expect(store['bp_fleet_profiles']).not.toContain('replicationToken');

        const added = addNodeProfile({ name: 'Fleet Node', url: 'https://fleet.beanpool.org', automationToken: 'typed-token' });
        const updated = updateNodeProfile(added.id, { automationToken: 'typed-token-2' });
        expect(updated.find(p => p.id === added.id)).toMatchObject({ automationToken: 'typed-token-2' });
        expect(store['bp_fleet_profiles']).not.toContain('typed-token');
        // Still there for this page, until it reloads.
        expect(loadNodeProfiles().find(p => p.id === added.id)).toMatchObject({ automationToken: 'typed-token-2' });
        saveNodeProfiles(loadNodeProfiles());
        expect(store['bp_fleet_profiles']).not.toContain('typed-token');
        removeNodeProfile(added.id);
    });

    it('a profile has one credential, its automation token', () => {
        expect(nodeCredential({ automationToken: 'bp_tok' })).toBe('bp_tok');
        expect(nodeCredential({})).toBeUndefined();
        expect(nodeCredential(null)).toBeUndefined();
        // An old profile's password key is not a credential.
        expect(nodeCredential({ adminPassword: 'old-pw' } as never)).toBeUndefined();
    });

    it('updates a node profile', () => {
        const added = addNodeProfile({ name: 'Old Name', url: 'https://update.beanpool.org' });
        updateNodeProfile(added.id, { name: 'New Name' });

        const profiles = loadNodeProfiles();
        const updated = profiles.find(p => p.id === added.id);
        expect(updated?.name).toBe('New Name');
    });
});
