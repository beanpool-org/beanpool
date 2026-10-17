import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWithNodeName } from './member-name';
import * as api from './api';
import type { BeanPoolIdentity } from './identity';

const ID: BeanPoolIdentity = {
    publicKey: 'pk-test',
    privateKey: 'sk-test',
    callsign: 'Sam',
    createdAt: '2026-10-01T00:00:00.000Z',
};

describe('openWithNodeName', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('returns isMember: false when checkMembership throws 403 private_preview', async () => {
        const error = Object.assign(new Error('This community is in a private preview.'), {
            status: 403,
            code: 'private_preview',
        });
        vi.spyOn(api, 'checkMembership').mockRejectedValue(error);

        const result = await openWithNodeName(ID);
        expect(result).toEqual({ isMember: false, identity: null });
    });

    it('returns isMember: false when checkMembership throws 403 account_closed', async () => {
        const error = Object.assign(new Error('Closed'), {
            status: 403,
            code: 'account_closed',
        });
        vi.spyOn(api, 'checkMembership').mockRejectedValue(error);

        const result = await openWithNodeName(ID);
        expect(result).toEqual({ isMember: false, identity: null });
    });

    it('throws when checkMembership throws a network error', async () => {
        const error = new TypeError('Failed to fetch');
        vi.spyOn(api, 'checkMembership').mockRejectedValue(error);

        await expect(openWithNodeName(ID)).rejects.toThrow('Failed to fetch');
    });

    it('throws when checkMembership throws 403 with other codes (e.g. not_your_key)', async () => {
        const error = Object.assign(new Error('Forbidden'), {
            status: 403,
            code: 'not_your_key',
        });
        vi.spyOn(api, 'checkMembership').mockRejectedValue(error);

        await expect(openWithNodeName(ID)).rejects.toThrow('Forbidden');
    });

    it('returns isMember: true for recognized member', async () => {
        vi.spyOn(api, 'checkMembership').mockResolvedValue({ isMember: true, callsign: 'Sam' });

        const result = await openWithNodeName(ID);
        expect(result.isMember).toBe(true);
    });
});
