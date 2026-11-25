/**
 * Learn's remembered role (slice K4, round 2): when the node says otherwise (`publish_instead`, or `admins_only` to an owner or
 * admin no longer), the form forgets the role the header remembered for ten minutes, under the same key Learn asks it by (the
 * anchor node and the member's key), so Learn asks again the next time it comes into view.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ anchor: 'https://riverside.example' as string | Error | null }));
vi.mock('expo-router', () => ({ useFocusEffect: vi.fn() }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: null }) }));
vi.mock('../db', () => ({ signedGet: vi.fn() }));
vi.mock('../node-post', () => ({ anchorUrl: vi.fn(async () => { if (h.anchor instanceof Error) throw h.anchor; return h.anchor; }) }));
vi.mock('../node-admin', () => ({ cachedNodeRoleHeard: vi.fn(), forgetNodeRole: vi.fn() }));

import { forgetLearnRole, readMyDrafts, readToCheckCount } from '../../components/learn/useLearnWriter';
import { forgetNodeRole } from '../node-admin';
import { signedGet } from '../db';

const key = 'ab'.repeat(32);

beforeEach(() => {
    h.anchor = 'https://riverside.example';
    vi.clearAllMocks();
});

describe('forgetLearnRole', () => {
    it('forgets the role remembered for this member at the anchor node', async () => {
        await forgetLearnRole({ publicKey: key });
        expect(forgetNodeRole).toHaveBeenCalledWith('https://riverside.example', key);
    });

    it('with no account, or no anchor to name, forgets nothing and never throws', async () => {
        await forgetLearnRole(null);
        await forgetLearnRole({});
        h.anchor = null;
        await forgetLearnRole({ publicKey: key });
        h.anchor = new Error('no anchor');
        await expect(forgetLearnRole({ publicKey: key })).resolves.toBeUndefined();
        expect(forgetNodeRole).not.toHaveBeenCalled();
    });
});

describe('readToCheckCount and readMyDrafts', () => {
    it('readToCheckCount reads knowledge_drafts count from GET /api/node-admin/queue?learn=1 with signal and anchorUrl', async () => {
        const stop = new AbortController();
        vi.mocked(signedGet).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                total: 5,
                items: [
                    { kind: 'reports', count: 2 },
                    { kind: 'knowledge_drafts', count: 3 },
                ],
            }),
        } as unknown as Response);

        const count = await readToCheckCount(stop.signal, 'https://riverside.example');
        expect(count).toBe(3);
        expect(signedGet).toHaveBeenCalledWith('/api/node-admin/queue?learn=1', {
            signal: stop.signal,
            anchorUrl: 'https://riverside.example',
        });
    });

    it('readToCheckCount returns 0 when knowledge_drafts is absent or request fails', async () => {
        vi.mocked(signedGet).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ total: 1, items: [{ kind: 'reports', count: 1 }] }),
        } as unknown as Response);
        expect(await readToCheckCount()).toBe(0);

        vi.mocked(signedGet).mockRejectedValueOnce(new Error('offline'));
        expect(await readToCheckCount()).toBe(0);
    });

    it('readMyDrafts forwards signal and anchorUrl to signedGet', async () => {
        const stop = new AbortController();
        vi.mocked(signedGet).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ waiting: [], answered: [] }),
        } as unknown as Response);

        expect(await readMyDrafts(stop.signal, 'https://riverside.example')).toEqual({ waiting: [], answered: [] });
        expect(signedGet).toHaveBeenCalledWith('/api/knowledge/drafts/mine', {
            signal: stop.signal,
            anchorUrl: 'https://riverside.example',
        });
    });
});
