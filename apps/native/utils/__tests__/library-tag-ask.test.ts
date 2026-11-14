/**
 * "Did you mean …?" (slice F5): loadLibraryTagFor reads the node's answer to GET /api/free-tags?q=, the label's tag and its
 * language, as the web's getLibraryTagFor (apps/pwa/src/lib/library-tag-api.test.ts). What is defended (review of #3164, not
 * blocking): a FAILED ask rejects, never resolves "none", because the picker keeps an answer for the life of the composer
 * and declines to keep a rejection. A word asked during a network blip must be asked again, not remembered as naming nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({ signedGet: vi.fn() }));
vi.mock('../db', () => ({ signedGet: net.signedGet }));

import { loadLibraryTagFor } from '../community-tags';

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => net.signedGet.mockReset());

describe('loadLibraryTagFor', () => {
    it('asks for the word and reads the tag with its language', async () => {
        net.signedGet.mockResolvedValueOnce(reply(200, { library: 'garden.soil.manure', lang: 'de' }));
        await expect(loadLibraryTagFor('mist')).resolves.toEqual({ id: 'garden.soil.manure', lang: 'de' });
        expect(net.signedGet).toHaveBeenCalledWith('/api/free-tags?q=mist');
        net.signedGet.mockResolvedValueOnce(reply(200, { library: 'food.fruit.lime', lang: 'pt' }));
        await loadLibraryTagFor('limão');
        expect(net.signedGet).toHaveBeenLastCalledWith('/api/free-tags?q=lim%C3%A3o');
    });

    it("an answer naming none is none, and so is an F3 node's tag list (it does not read q)", async () => {
        net.signedGet.mockResolvedValueOnce(reply(200, { library: null, lang: null }));
        await expect(loadLibraryTagFor('zzqx')).resolves.toBeNull();
        net.signedGet.mockResolvedValueOnce(reply(200, { tags: [] }));
        await expect(loadLibraryTagFor('zzqx')).resolves.toBeNull();
    });

    it('a failed ask rejects: offline, the node down, a refusal, a node without the route', async () => {
        net.signedGet.mockRejectedValueOnce(new TypeError('Network request failed'));
        await expect(loadLibraryTagFor('mist')).rejects.toThrow();
        for (const status of [502, 403, 404]) {
            net.signedGet.mockResolvedValueOnce(reply(status, { error: 'no' }));
            await expect(loadLibraryTagFor('mist'), String(status)).rejects.toThrow();
        }
    });
});
