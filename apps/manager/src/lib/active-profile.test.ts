import { describe, it, expect, beforeEach } from 'vitest';
import { loadActiveProfileId, saveActiveProfileId } from './profiles';

let store: Record<string, string> = {};
const mockLocalStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; }
};
Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true, configurable: true });

describe('active profile id management', () => {
    beforeEach(() => {
        store = {};
    });

    it('returns local-node default when no active profile is saved', () => {
        expect(loadActiveProfileId()).toBe('local-node');
    });

    it('saves and loads active profile id correctly', () => {
        saveActiveProfileId('custom-node-123');
        expect(loadActiveProfileId()).toBe('custom-node-123');
    });

    it('handles localStorage errors gracefully and returns default', () => {
        const errorLocalStorage = {
            getItem: () => { throw new Error('localStorage disabled'); },
            setItem: () => { throw new Error('localStorage disabled'); }
        };
        Object.defineProperty(globalThis, 'localStorage', { value: errorLocalStorage, writable: true, configurable: true });

        expect(() => saveActiveProfileId('some-id')).not.toThrow();
        expect(loadActiveProfileId()).toBe('local-node');

        // Restore normal mock
        Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true, configurable: true });
    });
});
