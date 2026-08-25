import { describe, it, expect, beforeEach } from 'vitest';
import { loadNodeProfiles, saveNodeProfiles, addNodeProfile, removeNodeProfile, updateNodeProfile } from './profiles';

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

    it('updates a node profile', () => {
        const added = addNodeProfile({ name: 'Old Name', url: 'https://update.beanpool.org' });
        updateNodeProfile(added.id, { name: 'New Name' });

        const profiles = loadNodeProfiles();
        const updated = profiles.find(p => p.id === added.id);
        expect(updated?.name).toBe('New Name');
    });
});
