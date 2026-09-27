import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('IS_FLEET_MODE mode detection', () => {
    const originalFleetModeGlobal = (globalThis as any).__FLEET_MODE__;

    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        if (originalFleetModeGlobal === undefined) {
            delete (globalThis as any).__FLEET_MODE__;
        } else {
            (globalThis as any).__FLEET_MODE__ = originalFleetModeGlobal;
        }
        vi.unstubAllEnvs();
    });

    it('evaluates to true when __FLEET_MODE__ global is true', async () => {
        (globalThis as any).__FLEET_MODE__ = true;
        const { IS_FLEET_MODE } = await import('./mode');
        expect(IS_FLEET_MODE).toBe(true);
    });

    it('evaluates to false when __FLEET_MODE__ global is false', async () => {
        (globalThis as any).__FLEET_MODE__ = false;
        const { IS_FLEET_MODE } = await import('./mode');
        expect(IS_FLEET_MODE).toBe(false);
    });

    it('evaluates based on import.meta.env.VITE_FLEET_MODE when __FLEET_MODE__ is undefined', async () => {
        delete (globalThis as any).__FLEET_MODE__;
        vi.stubEnv('VITE_FLEET_MODE', 'true');
        const { IS_FLEET_MODE } = await import('./mode');
        expect(IS_FLEET_MODE).toBe(true);
    });

    it('evaluates to false when VITE_FLEET_MODE is not "true"', async () => {
        delete (globalThis as any).__FLEET_MODE__;
        vi.stubEnv('VITE_FLEET_MODE', 'false');
        const { IS_FLEET_MODE } = await import('./mode');
        expect(IS_FLEET_MODE).toBe(false);
    });
});
