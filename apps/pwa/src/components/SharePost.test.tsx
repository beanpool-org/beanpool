// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SharePostButtons } from './SharePost';
import type { MarketplacePost } from '../lib/api';
import * as features from '../lib/features';
import * as api from '../lib/api';

vi.mock('../lib/features', async () => {
    const actual = await vi.importActual('../lib/features');
    return {
        ...actual,
        useCommunityInfo: vi.fn(),
    };
});

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        myNodeRoleOnce: vi.fn(),
    };
});

const samplePost: MarketplacePost = {
    id: 'post-123',
    title: 'Ladder for borrowing',
    type: 'offer',
    category: 'tools',
    description: 'A 6m ladder in good condition',
    credits: 0,
    priceType: 'fixed',
    authorPublicKey: 'author-pk',
    authorCallsign: 'Bob',
    createdAt: new Date().toISOString(),
    status: 'active',
    active: true,
    audienceScope: 'public',
    repeatable: false,
};

describe('SharePostButtons — share-says table rows (web)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('Row 1: Sharing outside on — keeps both buttons, says members only and 7 days line', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: true, door: 'members', knocks: true },
        } as any);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);

        await act(async () => {
            render(<SharePostButtons post={samplePost} />);
        });

        expect(screen.getByTestId('share-members-button')).toBeInTheDocument();
        expect(screen.getByTestId('share-outside-button')).toBeInTheDocument();
        expect(screen.getByTestId('share-members-note')).toHaveTextContent('This link opens for members only.');
        expect(screen.getByTestId('share-outside-line')).toHaveTextContent('Anyone can read this listing for 7 days, then ask to join.');
        expect(screen.queryByTestId('invite-someone-button')).toBeNull();
    });

    it('Row 2: Sharing outside off, any member may invite — Share with members, members only line, Invite someone button', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: false, door: 'members' },
        } as any);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);

        const onNavigate = vi.fn();
        await act(async () => {
            render(<SharePostButtons post={samplePost} onNavigate={onNavigate} />);
        });

        expect(screen.getByTestId('share-members-button')).toBeInTheDocument();
        expect(screen.getByTestId('share-members-note')).toHaveTextContent('This link opens for members only.');
        const inviteBtn = screen.getByTestId('invite-someone-button');
        expect(inviteBtn).toBeInTheDocument();
        expect(inviteBtn).toHaveTextContent('Invite someone');
        expect(screen.queryByTestId('share-outside-button')).toBeNull();
        expect(screen.queryByTestId('share-outside-line')).toBeNull();

        fireEvent.click(inviteBtn);
        expect(onNavigate).toHaveBeenCalledWith('people-invites');
    });

    it('Row 3: Sharing outside off, only admins invite, member not an admin — Share with members, only admins invite line, no button', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: false, door: 'admins' },
        } as any);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);

        await act(async () => {
            render(<SharePostButtons post={samplePost} />);
        });

        await waitFor(() => {
            expect(screen.getByTestId('share-members-note')).toHaveTextContent('This link opens for members only, and only admins invite here.');
        });
        expect(screen.getByTestId('share-members-button')).toBeInTheDocument();
        expect(screen.queryByTestId('invite-someone-button')).toBeNull();
        expect(screen.queryByTestId('share-outside-button')).toBeNull();
    });

    it('Row 4: Sharing outside off, only admins invite, member is owner/admin — as second row', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: false, door: 'admins' },
        } as any);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue('admin');

        await act(async () => {
            render(<SharePostButtons post={samplePost} />);
        });

        await waitFor(() => {
            expect(screen.getByTestId('invite-someone-button')).toBeInTheDocument();
        });
        expect(screen.getByTestId('share-members-button')).toBeInTheDocument();
        expect(screen.getByTestId('share-members-note')).toHaveTextContent('This link opens for members only.');
        expect(screen.queryByTestId('share-outside-button')).toBeNull();
    });

    it('Row 5: Open door (global) — no line under share buttons', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'global',
            features: { door: 'open', openJoin: true, invites: false, shareOutside: false },
        } as any);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);

        await act(async () => {
            render(<SharePostButtons post={samplePost} />);
        });

        expect(screen.getByTestId('share-members-button')).toBeInTheDocument();
        expect(screen.queryByTestId('share-members-note')).toBeNull();
        expect(screen.queryByTestId('invite-someone-button')).toBeNull();
        expect(screen.queryByTestId('share-outside-button')).toBeNull();
    });

    it('Row 6: Private preview — member sees third row, admin sees second row', async () => {
        // Non-admin member
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { privatePreview: true, door: 'admins', shareOutside: false },
        } as any);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);

        let unmountFn: () => void = () => {};
        await act(async () => {
            const { unmount } = render(<SharePostButtons post={samplePost} />);
            unmountFn = unmount;
        });

        await waitFor(() => {
            expect(screen.getByTestId('share-members-note')).toHaveTextContent('This link opens for members only, and only admins invite here.');
        });
        expect(screen.queryByTestId('invite-someone-button')).toBeNull();
        expect(screen.queryByTestId('share-outside-button')).toBeNull();

        unmountFn();

        // Admin member
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue('owner');
        await act(async () => {
            render(<SharePostButtons post={samplePost} />);
        });

        await waitFor(() => {
            expect(screen.getByTestId('invite-someone-button')).toBeInTheDocument();
        });
        expect(screen.getByTestId('share-members-note')).toHaveTextContent('This link opens for members only.');
    });

    it('Fallback: settings cannot be read — shows today buttons and no line', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue(null);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(null);

        await act(async () => {
            render(<SharePostButtons post={samplePost} />);
        });

        expect(screen.getByTestId('share-members-button')).toBeInTheDocument();
        expect(screen.queryByTestId('share-members-note')).toBeNull();
        expect(screen.queryByTestId('share-outside-line')).toBeNull();
        expect(screen.queryByTestId('invite-someone-button')).toBeNull();
    });

    it('Row 1 with joining paused: the outside line never promises to ask to join', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: true, door: 'members', knocks: false },
        } as any);
        await act(async () => { render(<SharePostButtons post={samplePost} />); });
        expect(screen.getByTestId('share-outside-line')).toHaveTextContent('Anyone can read this listing for 7 days.');
        expect(screen.getByTestId('share-outside-line').textContent).not.toMatch(/ask to join/);
    });

    it('Share outside keeps the standing note before the tap: no names or faces, and you can stop it', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: true, door: 'members', knocks: true },
        } as any);
        await act(async () => { render(<SharePostButtons post={samplePost} />); });
        expect(screen.getByTestId('share-outside-privacy')).toHaveTextContent('without names or faces. You can stop it any time.');
    });

    it('an event says "event" under Share outside, not "listing"', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: true, door: 'members', knocks: true },
        } as any);
        await act(async () => { render(<SharePostButtons post={{ ...samplePost, type: 'event' } as MarketplacePost} />); });
        expect(screen.getByTestId('share-outside-line')).toHaveTextContent('Anyone can read this event for 7 days, then ask to join.');
        expect(screen.getByTestId('share-outside-line').textContent).not.toMatch(/listing/);
    });

    it('where only admins invite, a role still loading shows no line and no button, then the real one', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: false, door: 'admins' },
        } as any);
        let answer: (r: string | null) => void = () => {};
        vi.mocked(api.myNodeRoleOnce).mockReturnValue(new Promise(res => { answer = res; }));
        await act(async () => { render(<SharePostButtons post={samplePost} />); });
        expect(screen.getByTestId('share-members-button')).toBeInTheDocument();
        expect(screen.queryByTestId('share-members-note')).toBeNull();
        expect(screen.queryByTestId('invite-someone-button')).toBeNull();
        await act(async () => { answer('owner'); });
        expect(screen.getByTestId('invite-someone-button')).toBeInTheDocument();
        expect(screen.getByTestId('share-members-note')).toHaveTextContent('This link opens for members only.');
    });

    it('where only admins invite, a role that could not be read shows no line and no button (never "only admins invite")', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: false, door: 'admins' },
        } as any);
        vi.mocked(api.myNodeRoleOnce).mockResolvedValue(undefined);
        await act(async () => { render(<SharePostButtons post={samplePost} />); });
        expect(screen.getByTestId('share-members-button')).toBeInTheDocument();
        expect(screen.queryByTestId('share-members-note')).toBeNull();
        expect(screen.queryByTestId('invite-someone-button')).toBeNull();
    });

    it('a guest here (not a member) is not offered Invite someone; a member and a page that does not say are', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: false, door: 'members' },
        } as any);
        const { unmount } = render(<SharePostButtons post={samplePost} isMember={false} />);
        expect(screen.queryByTestId('invite-someone-button')).toBeNull();
        unmount();
        const second = render(<SharePostButtons post={samplePost} isMember={null} />);
        expect(screen.queryByTestId('invite-someone-button')).toBeNull();
        second.unmount();
        const third = render(<SharePostButtons post={samplePost} isMember={true} />);
        expect(screen.getByTestId('invite-someone-button')).toBeInTheDocument();
        third.unmount();
        render(<SharePostButtons post={samplePost} />);
        expect(screen.getByTestId('invite-someone-button')).toBeInTheDocument();
    });

    it('invites off with a members door: no Invite someone and no members line', async () => {
        vi.mocked(features.useCommunityInfo).mockReturnValue({
            profile: 'local',
            features: { shareOutside: false, door: 'members', invites: false },
        } as any);
        await act(async () => { render(<SharePostButtons post={samplePost} />); });
        expect(screen.getByTestId('share-members-button')).toBeInTheDocument();
        expect(screen.queryByTestId('invite-someone-button')).toBeNull();
        expect(screen.queryByTestId('share-members-note')).toBeNull();
    });
});
