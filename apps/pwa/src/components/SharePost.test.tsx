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
            features: { shareOutside: true, door: 'members' },
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
});

