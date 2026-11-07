/**
 * The tour's record on the account (utils/tour-store.ts saveTourRecord), met by a busy network. Deciding review of #2960
 * (round 2), the 429 sweep: a 429 was read as the node refusing the record outright (4xx), so the phone dropped the record it
 * kept to send again, and the tour's end was lost on a busy moment. A node that refuses it (a node from before the tour)
 * still drops it; no answer and a 5xx keep it. Nothing here contacts a node.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => disk.get(k) ?? null,
        setItem: async (k: string, v: string) => { disk.set(k, v); },
        removeItem: async (k: string) => { disk.delete(k); },
    },
}));
const post = vi.hoisted(() => ({ signedPost: vi.fn() }));
vi.mock('../node-post', () => post);

import { tourRecord } from '@beanpool/core';
import { pendingTourRecord, saveTourRecord } from '../tour-store';

const IDENTITY = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'me', createdAt: '' } as any;
const RECORD = tourRecord('done', Date.parse('2026-11-07T00:00:00Z'));
const answer = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;

beforeEach(() => { disk.clear(); post.signedPost.mockReset(); });

describe('saveTourRecord', () => {
    it('keeps the record on a 429 (a busy network), to be sent again, and says it did not go', async () => {
        post.signedPost.mockResolvedValueOnce(answer(429));
        await expect(saveTourRecord('https://n.example', IDENTITY, RECORD)).resolves.toBe(false);
        await expect(pendingTourRecord(IDENTITY.publicKey)).resolves.toEqual(RECORD);
    });

    it('keeps it on a 5xx and on no answer at all, as before', async () => {
        post.signedPost.mockResolvedValueOnce(answer(503));
        await saveTourRecord('https://n.example', IDENTITY, RECORD);
        await expect(pendingTourRecord(IDENTITY.publicKey)).resolves.toEqual(RECORD);
        disk.clear();
        post.signedPost.mockRejectedValueOnce(new Error('Network request failed'));
        await saveTourRecord('https://n.example', IDENTITY, RECORD);
        await expect(pendingTourRecord(IDENTITY.publicKey)).resolves.toEqual(RECORD);
    });

    it('drops it when the node refuses it outright (a node from before the tour), and when it takes it', async () => {
        for (const status of [400, 403, 404]) {
            disk.set(`beanpool_tour_pending_${IDENTITY.publicKey}`, JSON.stringify(RECORD));
            post.signedPost.mockResolvedValueOnce(answer(status));
            await expect(saveTourRecord('https://n.example', IDENTITY, RECORD), String(status)).resolves.toBe(false);
            await expect(pendingTourRecord(IDENTITY.publicKey), String(status)).resolves.toBeNull();
        }
        post.signedPost.mockResolvedValueOnce(answer(200));
        await expect(saveTourRecord('https://n.example', IDENTITY, RECORD)).resolves.toBe(true);
        await expect(pendingTourRecord(IDENTITY.publicKey)).resolves.toBeNull();
    });
});
