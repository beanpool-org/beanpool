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

import { forgetLearnRole } from '../../components/learn/useLearnWriter';
import { forgetNodeRole } from '../node-admin';

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
