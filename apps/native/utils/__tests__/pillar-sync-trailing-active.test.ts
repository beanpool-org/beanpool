import { describe, it, expect, vi, afterEach } from 'vitest';
import Module from 'node:module';
import { isPillarSyncActive, PILLAR_SYNC_ENDED, requestSync } from '../../services/pillar-sync';

// The Market asks for one sync more when a first cycle fails, heard on PILLAR_SYNC_ENDED (app/(tabs)/market.tsx), and
// reads isPillarSyncActive to tell "a sync is still to come" from "nothing is running". Asked for as a cycle ends, that sync
// is a trailing one: it waits out requestSync's 2 s cooldown, then its debounce. The cooldown read as nothing running, so a
// first sync that failed between 10 s and 12 s had the 12 s wait say "Having trouble connecting" with the retry still to
// come (review of PR #2127). The real requestSync and performSync, with no node to read: each cycle fails at once.

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
    },
}));
vi.mock('../db', () => ({
    applyDelta: vi.fn().mockResolvedValue(undefined),
    communityCachesRenamed: vi.fn().mockResolvedValue(true),
    copyGenerationNow: vi.fn(() => 0),
    newCopyGeneration: vi.fn(),
    fetchFriendsFromServer: vi.fn().mockResolvedValue([]),
    getDb: vi.fn().mockResolvedValue({ getFirstAsync: vi.fn().mockResolvedValue({ count: 0 }) }),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('test.db') }));
vi.mock('expo-constants', () => ({ default: { experienceUrl: undefined, expoConfig: undefined } }));

const nodeLoad = (Module as any)._load;
afterEach(() => { (Module as any)._load = nodeLoad; vi.useRealTimers(); });

describe('a sync asked for as a cycle ends', () => {
    it('is active through the 2 s cooldown and its debounce, until it has run', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const start = Date.now();
        const now = () => Date.now() - start;
        const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);
        const ended: number[] = [];
        // pillar-sync tells the screens through `require('react-native')`, which does not load under node: it is stood
        // in for here, with a listener that asks for one sync more as the first cycle ends, as the Market's does.
        (Module as any)._load = function (request: string, ...rest: unknown[]) {
            if (request !== 'react-native') return nodeLoad.call(this, request, ...rest);
            return {
                DeviceEventEmitter: {
                    emit: (name: string) => {
                        if (name !== PILLAR_SYNC_ENDED) return;
                        ended.push(now());
                        if (ended.length === 1) requestSync();
                    },
                },
            };
        };

        requestSync();
        expect(isPillarSyncActive()).toBe(true);
        await pass(150);
        expect(ended).toEqual([150]);
        // The cooldown: no cycle runs and none is in its debounce, yet one is to come.
        for (const step of [0, 300, 700, 900]) {
            await pass(step);
            expect(isPillarSyncActive(), `${now() - 150} ms after the first cycle ended`).toBe(true);
            expect(ended).toHaveLength(1);
        }
        // 2 s, then the debounce's 150 ms: it runs.
        await pass(250);
        expect(ended).toEqual([150, 2_300]);
        expect(isPillarSyncActive()).toBe(false);
    });
});
