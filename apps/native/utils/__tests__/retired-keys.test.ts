/**
 * CUT3, the cutover's one-off deletion of retired phone keys (utils/retired-keys.ts; conversion code, logged): every key on
 * the list goes at start, nothing else is touched, and a store that throws never stops the app.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const disk = vi.hoisted(() => new Map<string, string>());
const failing = vi.hoisted(() => ({ on: false }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => disk.get(k) ?? null),
        multiRemove: vi.fn(async (keys: string[]) => {
            if (failing.on) throw new Error('store unavailable');
            for (const k of keys) disk.delete(k);
        }),
    },
}));

import { RETIRED_KEYS, forgetRetiredKeys } from '../retired-keys';

beforeEach(() => {
    disk.clear();
    failing.on = false;
});

describe('CUT3: the retired keys go at start', () => {
    it('names exactly the keys the cutover retires on this build', () => {
        expect([...RETIRED_KEYS]).toEqual(['bp_trust_sync_v3', 'bp_legacy_post_conv_cleaned_v1', 'beanpool_pending_claim']);
    });

    it('deletes each one, and leaves every other key as it was', async () => {
        for (const k of RETIRED_KEYS) disk.set(k, 'old');
        disk.set('beanpool_anchor_url', 'https://home.example.org');
        disk.set('pillar_sync_x_last-sync', '2026-11-01');
        await forgetRetiredKeys();
        for (const k of RETIRED_KEYS) expect(disk.has(k), k).toBe(false);
        expect(disk.get('beanpool_anchor_url')).toBe('https://home.example.org');
        expect(disk.get('pillar_sync_x_last-sync')).toBe('2026-11-01');
        // Again, with nothing there: nothing to do, nothing thrown.
        await expect(forgetRetiredKeys()).resolves.toBeUndefined();
    });

    it('never throws when the store does', async () => {
        failing.on = true;
        await expect(forgetRetiredKeys()).resolves.toBeUndefined();
    });

    it('nothing reads them any more, and the deletion is marked as conversion code with its row and its end', () => {
        const root = path.resolve(__dirname, '../..');
        const src = fs.readFileSync(path.join(root, 'utils/retired-keys.ts'), 'utf8');
        expect(src).toMatch(/Conversion code, log row CUT3, remove in the first phone build after Play Console shows no device below 1\.4\.0 for 30\s+\* days/);
        const breakGlass = fs.readFileSync(path.join(root, 'utils/break-glass.ts'), 'utf8');
        expect(breakGlass).toMatch(/Conversion code, log row CUT3/);
        for (const file of ['utils/db.ts', 'utils/onboarding-state.ts', 'app/_layout.tsx']) {
            const text = fs.readFileSync(path.join(root, file), 'utf8');
            for (const k of RETIRED_KEYS) expect(text, `${file} ${k}`).not.toContain(`'${k}'`);
        }
    });
});
