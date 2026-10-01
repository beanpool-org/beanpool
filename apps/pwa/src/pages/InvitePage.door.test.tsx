import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Who may invite (the door, community modes slice 1; config/door.ts on the server): a community may choose that only
 * its owners and admins invite (`features.door === 'admins'`). There, a member who is neither gets no generator (no code, QR or
 * ticket to make) on the Invites page, though the Tree and their still-valid pending codes stay: the plain words, and the community's link where it takes requests to join.
 * An owner or admin, a community whose members all invite, and a node too old to say: exactly as before.
 */

vi.mock('../lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/api')>();
    return {
        ...actual,
        generateInvite: vi.fn(async () => ({ success: true, invite: { code: 'INV-ABCD-EFGH', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null } })),
        buildOfflineInviteCode: vi.fn(async () => 'BP-offline-ticket'),
        getMyInvites: vi.fn(async () => ({ invites: [{ code: 'INV-OLD1-CODE', createdBy: 'me', createdAt: new Date().toISOString(), usedBy: null, usedAt: null }] })),
        getInviteTree: vi.fn(async () => []),
        // GET /api/node-admin/me: a member with no role, unless a test says otherwise.
        request: vi.fn(async () => ({ role: null, communityName: 'Mullum' })),
    };
});
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} })),
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

import { InvitePage } from './InvitePage';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import { buildOfflineInviteCode, generateInvite, request, type CommunityInfo } from '../lib/api';
import {
    onlyAdminsInvite, takesKnocks, readInviteRole, mayInviteHere, mayMakeOfflineTicket, adminsOnlyText, adminsOnlyRefusal,
    ADMINS_ONLY_FALLBACK, OFFLINE_ADMINS_ONLY_TEXT,
} from '../lib/node-invites';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(96), callsign: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };
const info = (features: Record<string, unknown>, profile: 'local' | 'global' = 'local') =>
    ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile, features }) as unknown as CommunityInfo;
const ADMINS = info({ beans: true, knocks: true, invites: true, door: 'admins' });
const ADMINS_NO_KNOCKS = info({ beans: true, knocks: false, invites: true, door: 'admins' });
const MEMBERS = info({ beans: true, knocks: true, invites: true, door: 'members' });
const OLD = info({ beans: true, knocks: true });
const GLOBAL = info({ beans: false, openJoin: true, knocks: false, invites: false, door: 'open' }, 'global');
const WORDS = 'In this community only its admins invite people. Ask an admin to bring them in.';

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
});

describe('node-invites: the door', () => {
    it('only a node that says `admins` keeps invites to its admins', () => {
        expect(onlyAdminsInvite(ADMINS)).toBe(true);
        for (const i of [MEMBERS, OLD, GLOBAL, null, undefined]) expect(onlyAdminsInvite(i)).toBe(false);
    });

    it('a role is one the node names, else none', () => {
        expect(readInviteRole('owner')).toBe('owner');
        expect(readInviteRole('admin')).toBe('admin');
        expect(readInviteRole('moderator')).toBe('moderator');
        for (const r of [null, undefined, 'Steward', 'elder', 1, {}]) expect(readInviteRole(r)).toBeNull();
    });

    it('where only admins invite: an owner or admin, never a member or a moderator; not heard yet counts as before', () => {
        expect(mayInviteHere(ADMINS, 'owner')).toBe(true);
        expect(mayInviteHere(ADMINS, 'admin')).toBe(true);
        expect(mayInviteHere(ADMINS, 'moderator')).toBe(false);
        expect(mayInviteHere(ADMINS, null)).toBe(false);
        expect(mayInviteHere(ADMINS, undefined)).toBe(true);
    });

    it('any member on a members door or a node too old to say; nobody where the node takes no invites', () => {
        for (const role of [null, 'moderator', 'admin', 'owner', undefined] as const) {
            expect(mayInviteHere(MEMBERS, role)).toBe(true);
            expect(mayInviteHere(OLD, role)).toBe(true);
            expect(mayInviteHere(null, role)).toBe(true);
            expect(mayInviteHere(GLOBAL, role)).toBe(false);
        }
    });

    it('an offline ticket where only admins invite: only from a known owner or admin', () => {
        expect(mayMakeOfflineTicket(ADMINS, 'owner')).toBe(true);
        expect(mayMakeOfflineTicket(ADMINS, 'admin')).toBe(true);
        for (const role of [null, 'moderator', undefined] as const) expect(mayMakeOfflineTicket(ADMINS, role)).toBe(false);
        for (const role of [null, undefined] as const) {
            expect(mayMakeOfflineTicket(MEMBERS, role)).toBe(true);
            expect(mayMakeOfflineTicket(null, role)).toBe(true);
        }
    });

    it('requests to join: never on the global node, else unless the node says none', () => {
        expect(takesKnocks(ADMINS)).toBe(true);
        expect(takesKnocks(OLD)).toBe(true);
        expect(takesKnocks(ADMINS_NO_KNOCKS)).toBe(false);
        expect(takesKnocks(GLOBAL)).toBe(false);
    });

    it('plain words, no tier', () => {
        for (const knocks of [true, false]) {
            expect(adminsOnlyText(knocks)).toMatch(/only its admins invite people/);
            expect(adminsOnlyText(knocks)).not.toMatch(/tier|Steward|Elder|Resident|Newcomer|badge|locked/i);
        }
        expect(adminsOnlyText(true)).toMatch(/ask to join/);
        expect(adminsOnlyText(false)).not.toMatch(/ask to join|Share/);
    });

    it("only the node's 403 admins_only is read as that refusal", () => {
        expect(adminsOnlyRefusal(Object.assign(new Error(WORDS), { status: 403, code: 'admins_only' }))).toBe(WORDS);
        expect(adminsOnlyRefusal(Object.assign(new Error(''), { status: 403, code: 'admins_only' }))).toBe(ADMINS_ONLY_FALLBACK);
        expect(adminsOnlyRefusal(Object.assign(new Error('Only registered members'), { status: 403 }))).toBeNull();
        expect(adminsOnlyRefusal(Object.assign(new Error('off'), { status: 404, code: 'feature_off' }))).toBeNull();
        expect(adminsOnlyRefusal(new TypeError('Failed to fetch'))).toBeNull();
        expect(adminsOnlyRefusal(null)).toBeNull();
    });
});

describe('the Invites page where only admins invite', () => {
    it('a member: the plain words and the link, the words and link, the tree and pending codes stay, no generator', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValueOnce(ADMINS);
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => expect(screen.getByText(adminsOnlyText(true))).toBeInTheDocument());
        expect(request).toHaveBeenCalledWith('GET', '/api/node-admin/me');
        expect(screen.getByText(/Bring someone here/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: "Share this community's link" })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Generate New Invite/ })).toBeNull();
        expect(screen.queryByText(/Invite Someone/)).toBeNull();
        expect(screen.queryByPlaceholderText(/Who is this invite for/)).toBeNull();
        // The tabs, the tree and the member's still-valid codes stay; only the generator goes.
        expect(screen.getByRole('button', { name: /Tree/ })).toBeInTheDocument();
        expect(await screen.findByText(/INV-OLD1-CODE/)).toBeInTheDocument();
        expect(screen.getByText(/Codes you made earlier still work until they lapse/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Tree/ }));
        expect(await screen.findByText(/Community Tree/)).toBeInTheDocument();
        expect(generateInvite).not.toHaveBeenCalled();
    });

    it('a paper ticket made here before the switch is not listed as a code that still works', async () => {
        localStorage.setItem(`bp_offline_invites_${IDENTITY.publicKey}`, JSON.stringify([
            { code: 'BP-offline-old', createdBy: IDENTITY.publicKey, createdAt: new Date().toISOString(), usedBy: null, usedAt: null },
        ]));
        vi.mocked(communityInfoOnce).mockResolvedValueOnce(ADMINS);
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => expect(screen.getByText(adminsOnlyText(true))).toBeInTheDocument());
        expect(await screen.findByText(/INV-OLD1-CODE/)).toBeInTheDocument();
        expect(screen.queryByText(/BP-OFFLINE-OLD/i)).toBeNull();
    });

    it('a moderator is no admin here either', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValueOnce(ADMINS);
        vi.mocked(request).mockResolvedValueOnce({ role: 'moderator' });
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => expect(screen.getByText(adminsOnlyText(true))).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: /Generate New Invite/ })).toBeNull();
    });

    it('a community that takes no requests to join: the words, and no link to share', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValueOnce(ADMINS_NO_KNOCKS);
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => expect(screen.getByText(adminsOnlyText(false))).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: "Share this community's link" })).toBeNull();
        expect(screen.queryByRole('button', { name: /Generate New Invite/ })).toBeNull();
    });

    for (const role of ['owner', 'admin'] as const) {
        it(`an ${role}: Generate, the pending code and the tree, as before`, async () => {
            vi.mocked(communityInfoOnce).mockResolvedValueOnce(ADMINS);
            vi.mocked(request).mockResolvedValueOnce({ role });
            render(<InvitePage identity={IDENTITY} />);
            await waitFor(() => expect(request).toHaveBeenCalledWith('GET', '/api/node-admin/me'));
            fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
            await waitFor(() => expect(generateInvite).toHaveBeenCalled());
            expect(screen.getByRole('button', { name: /Tree/ })).toBeInTheDocument();
            expect(screen.queryByText(/only its admins invite/)).toBeNull();
        });
    }

    it("a generate the node refuses as admins_only (the page hadn't heard): its words, and no offline ticket", async () => {
        // The info read hasn't answered, so the page is drawn as before; the node answers the generate itself.
        vi.mocked(communityInfoOnce).mockImplementationOnce(() => new Promise(() => {}));
        vi.mocked(generateInvite).mockRejectedValueOnce(Object.assign(new Error(WORDS), { status: 403, code: 'admins_only' }));
        render(<InvitePage identity={IDENTITY} />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
        await waitFor(() => expect(screen.getByText(WORDS)).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: /Generate New Invite/ })).toBeNull();
        expect(buildOfflineInviteCode).not.toHaveBeenCalled();
        expect(localStorage.getItem(`bp_offline_invites_${IDENTITY.publicKey}`)).toBeNull();
    });

    it("offline, with no answer on the member's role: no offline ticket, and it says why", async () => {
        vi.mocked(communityInfoOnce).mockResolvedValueOnce(ADMINS);
        vi.mocked(request).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        vi.mocked(generateInvite).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => expect(request).toHaveBeenCalledWith('GET', '/api/node-admin/me'));
        fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(OFFLINE_ADMINS_ONLY_TEXT));
        expect(buildOfflineInviteCode).not.toHaveBeenCalled();
    });

    it("offline, an admin the node already named: an offline ticket, as before", async () => {
        vi.mocked(communityInfoOnce).mockResolvedValueOnce(ADMINS);
        vi.mocked(request).mockResolvedValueOnce({ role: 'admin' });
        vi.mocked(generateInvite).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        render(<InvitePage identity={IDENTITY} />);
        await waitFor(() => expect(request).toHaveBeenCalledWith('GET', '/api/node-admin/me'));
        fireEvent.click(await screen.findByRole('button', { name: /Generate New Invite/ }));
        await waitFor(() => expect(buildOfflineInviteCode).toHaveBeenCalled());
    });
});

describe('the Invites page where any member invites: as before, and no role is asked', () => {
    for (const [label, answer] of [
        ['a members door', MEMBERS],
        ['a node too old to say', OLD],
    ] as const) {
        it(`${label}: Generate, the pending code and the tree`, async () => {
            vi.mocked(communityInfoOnce).mockResolvedValueOnce(answer);
            render(<InvitePage identity={IDENTITY} />);
            await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
            expect(await screen.findByRole('button', { name: /Generate New Invite/ })).toBeInTheDocument();
            expect(await screen.findByText(/INV-OLD1-CODE/)).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /Tree/ })).toBeInTheDocument();
            expect(screen.queryByText(/only its admins invite/)).toBeNull();
            expect(request).not.toHaveBeenCalledWith('GET', '/api/node-admin/me');
        });
    }
});
