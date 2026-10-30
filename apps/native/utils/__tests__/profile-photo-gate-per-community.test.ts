/**
 * Profile S2 (scratch/fable-design/DESIGN-per-community-profile-fable.md §5 question 3, Marty 29 Oct: "Yes, per community"):
 * the "you need a photo before you can accept / post" gate asks about THIS community's own row. A photo chosen in another
 * community (the phone keeps a copy of the last one, utils/canonical-profile.ts) used to satisfy it in a fresh community,
 * so a member listed there with a picture they never chose there. Now the gate asks again, in the words it always had.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const phone = vi.hoisted(() => ({
    /** This community's own row for the member, as the copy open holds it. */
    row: null as null | { avatar_url: string | null },
    /** The last photo chosen in ANY community, kept phone-wide. */
    elsewhere: null as string | null,
}));
vi.mock('../db', () => ({ getMemberProfile: vi.fn(async () => phone.row) }));
const canonicalAvatar = vi.hoisted(() => vi.fn(async () => null as string | null));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: canonicalAvatar }));
vi.mock('../identity', () => ({}));

import { getProfileStatus, hasUsableAvatar } from '../profile-status';

const ME = 'ab'.repeat(32);
const identity = { publicKey: ME, privateKey: 'k', callsign: 'Marty' } as any;

beforeEach(() => {
    phone.row = null;
    phone.elsewhere = null;
    canonicalAvatar.mockReset();
    canonicalAvatar.mockImplementation(async () => phone.elsewhere);
});

describe('the photo gate asks about this community\'s own row', () => {
    it('a fresh community (a row with no photo) asks for one, though a photo was chosen in another', async () => {
        phone.elsewhere = 'bundled://bean-green';
        phone.row = { avatar_url: null };
        expect(await hasUsableAvatar(ME)).toBe(false);
        expect(await getProfileStatus(identity)).toEqual({ complete: false, missingName: false, missingAvatar: true });
    });

    it('a community that holds no row for you yet asks for one too', async () => {
        phone.elsewhere = 'data:image/jpeg;base64,/9j/UElDSw==';
        phone.row = null;
        expect(await hasUsableAvatar(ME)).toBe(false);
    });

    it('a photo in this community\'s row opens the gate', async () => {
        phone.row = { avatar_url: `/api/avatar/${ME}?size=thumb&v=1` };
        expect(await hasUsableAvatar(ME)).toBe(true);
        expect(await getProfileStatus(identity)).toEqual({ complete: true, missingName: false, missingAvatar: false });
    });

    it('the phone-wide copy is not even read', async () => {
        phone.elsewhere = 'bundled://bean-green';
        phone.row = { avatar_url: null };
        await hasUsableAvatar(ME);
        expect(canonicalAvatar).not.toHaveBeenCalled();
    });
});
