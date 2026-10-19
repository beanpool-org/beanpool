/**
 * A member's profile, the profile editor, the profile wizard and the how-it-works cards in the member's language (words
 * S3, web sweep W3), in the pseudo-locale (`xx`): any text, label, title, placeholder or alert with letters outside a
 * bracket bypassed t(). Shown as written: what members wrote (names, a bio, a listing's title, a review), a key's
 * first characters, and a tier's name, which the node sends and the Ledger's sweep (W2) words.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicProfilePage } from './PublicProfilePage';
import { ProfilePage } from './ProfilePage';
import { ProfileSetup } from '../components/ProfileSetup';
import { OnboardingGuide } from '../components/OnboardingGuide';
import * as api from '../lib/api';
import { isUserBlocked } from '../lib/blocklist';
import { backToEnglish, bracketed, showIn, xx } from '../words-xx.test-support';
import { AS_WRITTEN, bypassing } from '../words-w3.test-support';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(async () => {}),
    unblockUser: vi.fn(async () => {}),
    onBlocklistUpdated: vi.fn(() => () => {}),
    getBlocklistFullNote: vi.fn(() => null),
}));

const ME: any = { publicKey: 'my-user-pubkey', privateKey: 'priv', callsign: 'Alice', createdAt: '2026-01-01T00:00:00.000Z' };
const PEER = 'peer-pubkey-123456789';
const archetype = (primary: string, secondary: string) => JSON.stringify({ primary, secondary, mode: 'quick', updatedAt: '2026-10-01T00:00:00Z' });
const peerProfile = (over: Record<string, unknown> = {}) => ({
    publicKey: PEER, callsign: 'Bob', avatar: 'https://example.org/bob.jpg', bio: 'Fixes bikes on Sundays', role: 'member',
    joinedAt: '2026-03-14T00:00:00Z', elderVouchedBy: 'sponsor-pk', elderVouchedByCallsign: 'Carol', archetype: archetype('weaver', 'connector'),
    ...over,
});
const myProfile = (over: Record<string, unknown> = {}) => ({
    publicKey: ME.publicKey, callsign: 'Alice', avatar: null, bio: 'Bakes on Fridays', role: 'member', archetype: archetype('catalyst', 'spark'),
    joinedAt: '2026-01-01T00:00:00Z', contact: { value: 'alice@example.org', visibility: 'friends' }, ...over,
});

vi.mock('../lib/api', () => ({
    getMemberProfile: vi.fn(),
    updateMemberProfile: vi.fn(async () => ({})),
    registerMember: vi.fn(async () => null),
    getMemberRatings: vi.fn(async () => ({
        average: 4.5, count: 2, asProvider: { average: 5, count: 1 }, asReceiver: { average: 4, count: 1 },
        ratings: [
            { stars: 5, comment: 'Lovely bread', role: 'provider', createdAt: '2026-09-02T00:00:00Z' },
            { stars: 4, comment: '', role: 'receiver', createdAt: '2026-09-20T00:00:00Z' },
        ],
    })),
    getMarketplacePosts: vi.fn(async () => [{ id: 'p1', type: 'offer', title: 'Sourdough loaves', status: 'active', credits: 12, photos: null }]),
    getBalance: vi.fn(async () => ({ balance: 12.5, floor: -50, earnedCredit: 140, canVouch: true, tier: { name: 'Green Bean', emoji: '🌱' }, trustStats: { tradeCount: 3 } })),
    getRatingsGiven: vi.fn(async () => ({ ratings: [{ id: 'r1', stars: 4, comment: '', target_callsign: 'Dan', transactionId: 'tx1', targetPubkey: 'dan-pk', createdAt: '2026-08-01T00:00:00Z' }] })),
    getFriends: vi.fn(async () => [{ publicKey: 'f1' }, { publicKey: 'f2' }]),
    submitRating: vi.fn(async () => ({})),
    vouchMemberApi: vi.fn(async () => ({})),
    getPublicChannels: vi.fn(async () => ({ channels: [] })),
}));

/** What members wrote, and a tier's name (the node's, worded by the Ledger's sweep). */
const OTHERS = ['Alice', 'Bob', 'Carol', 'Dan', 'Fixes bikes on Sundays', 'Bakes on Fridays', 'Sourdough loaves', 'Lovely bread', 'Green Bean',
    'alice@example.org', `${PEER.slice(0, 16)}...`, `${ME.publicKey.slice(0, 16)}...`, 'A', 'B', ...AS_WRITTEN];
const unwrapped = (said: string[] = []) => bypassing(document.body, { others: OTHERS, said });
const said: string[] = [];

beforeEach(() => {
    said.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { said.push(String(m)); });
    vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { said.push(String(m)); return false; });
    vi.mocked(api.getMemberProfile).mockImplementation(async (pk: string) => (pk === PEER ? peerProfile() : myProfile()) as any);
    vi.mocked(isUserBlocked).mockReturnValue(false);
});
afterEach(() => {
    cleanup();
    backToEnglish();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const openPeer = () => render(<PublicProfilePage identity={ME} pubkey={PEER} onBack={() => {}} onMessage={() => {}} onNavigatePost={() => {}} />);
const openSelf = () => render(<PublicProfilePage identity={ME} pubkey={ME.publicKey} onBack={() => {}} onMessage={() => {}} onNavigatePost={() => {}} onEditProfile={() => {}} onNavigateTab={() => {}} />);

describe('a member\'s profile in the pseudo-locale: every word on it came through t() (words W3)', () => {
    it('another member, both quizzes taken: the header, the banner, the vouch, Collaboration Chemistry, the ratings and a listing', async () => {
        await showIn('xx');
        openPeer();
        expect(await screen.findByText('Fixes bikes on Sundays', { exact: false })).toBeInTheDocument();
        expect(await screen.findByText(xx('Collaboration tip:'))).toBeInTheDocument();
        expect(await screen.findByText('Sourdough loaves')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Block user {name}').replace('{name}', 'Bob') })).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(25);
        expect(unwrapped()).toEqual([]);
        fireEvent.click(screen.getByText(xx('Reviews ({n})').replace('{n}', '2')));
        expect(await screen.findByText('"Lovely bread"')).toBeInTheDocument();
        expect(screen.getByText(xx('No comment provided.'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        // Block: the confirm in the member's language, the name as they wrote it.
        fireEvent.click(screen.getByRole('button', { name: xx('Block user {name}').replace('{name}', 'Bob') }));
        expect(said.at(-1)).toContain('Bob');
        expect(unwrapped(said)).toEqual([]);
    });

    it('a member nobody has vouched for, to a viewer who may vouch: the three levels', async () => {
        vi.mocked(api.getMemberProfile).mockImplementation(async (pk: string) => (pk === PEER ? peerProfile({ elderVouchedBy: null, elderVouchedByCallsign: null }) : myProfile()) as any);
        await showIn('xx');
        openPeer();
        expect(await screen.findByText(xx('🤝 Vouch — extend a credit line (no beans leave your wallet)'))).toBeInTheDocument();
        for (const level of ['Light', 'Standard', 'Deep']) expect(screen.getByText(xx(level))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('the quiz cards: the viewer has not taken it; the member has not; neither has', async () => {
        await showIn('xx');
        vi.mocked(api.getMemberProfile).mockImplementation(async (pk: string) => (pk === PEER ? peerProfile() : myProfile({ archetype: null })) as any);
        openPeer();
        expect(await screen.findByText(xx('Take the 60-second quiz to get tips for working with {name}.').replace('{name}', 'Bob'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        cleanup();
        vi.mocked(api.getMemberProfile).mockImplementation(async (pk: string) => (pk === PEER ? peerProfile({ archetype: null }) : myProfile()) as any);
        openPeer();
        expect(await screen.findByText(xx('💬 Nudge {name} in Chat').replace('{name}', 'Bob'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('a member you blocked: the line that says so, and Unblock', async () => {
        vi.mocked(isUserBlocked).mockReturnValue(true);
        await showIn('xx');
        openPeer();
        expect(await screen.findByText(xx('You have blocked this member. Messaging is disabled.'))).toBeInTheDocument();
        expect(screen.getByText(xx('Unblock Member'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('your own profile: the trust card, the counts, your working style, the reviews you gave and editing one', async () => {
        await showIn('xx');
        openSelf();
        expect(await screen.findByText(xx('My Profile'))).toBeInTheDocument();
        expect(await screen.findByText(xx('{n} trust points').replace('{n}', '140'))).toBeInTheDocument();
        expect(await screen.findByText(xx('How you work best:'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        fireEvent.click(screen.getByText(xx('Given ({n})').replace('{n}', '1')));
        fireEvent.click(await screen.findByText(xx('✏️ Edit Review')));
        expect(await screen.findByText(xx('Edit Your Review'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Rate {n} stars').replace('{n}', '3') })).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        openPeer();
        expect(await screen.findByText('Collaboration tip:')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
        expect(screen.getByText('📅 Joined March 2026')).toBeInTheDocument();
        expect(screen.getByText('🤝 Vouched by Carol')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Collaborate with Bob' })).toBeInTheDocument();
    });
});

describe('the profile editor, the profile wizard and the how-it-works cards in the pseudo-locale (words W3)', () => {
    it('the profile editor: photo, callsign, bio, contact and who can see it, the working style card, Save', async () => {
        await showIn('xx');
        render(<ProfilePage identity={ME} onBack={() => {}} />);
        expect(await screen.findByText(xx('Who can see this?'))).toBeInTheDocument();
        expect(screen.getByText(xx('Trade Partners'))).toBeInTheDocument();
        expect(screen.getByPlaceholderText(xx('A short bio about yourself...'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('the profile wizard: the name, the photo and how BeanPool works', async () => {
        await showIn('xx');
        // A name too short to keep opens the wizard at its first step.
        render(<ProfileSetup identity={{ ...ME, callsign: 'A' }} onDone={() => {}} />);
        expect(await screen.findByText(xx('👋 Your name'))).toBeInTheDocument();
        expect(screen.getByText(xx('Step {n} of {total}').replace('{n}', '1').replace('{total}', '3'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        fireEvent.change(screen.getByLabelText(xx('Your name')), { target: { value: 'Ana' } });
        fireEvent.click(screen.getByText(xx('Next →')));
        expect(await screen.findByText(xx('📸 Choose your look'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('the how-it-works cards: every card, the bold words inside their sentences, the emoji hidden from screen readers', async () => {
        await showIn('xx');
        render(<OnboardingGuide />);
        expect(screen.getByRole('heading', { name: xx('Energy Exchange Marketplace') })).toBeInTheDocument();
        // The bold word is drawn inside its sentence, which came through t() whole.
        expect(document.body.textContent).toContain(xx('Explore the **Map** to find offers (green) and needs (orange) near you.').replace(/\*\*/g, ''));
        expect([...document.querySelectorAll('strong')].map((s) => s.textContent)).toContain(xx('Explore the **Map** to find offers (green) and needs (orange) near you.').split('**')[1]);
        expect(bracketed()).toBeGreaterThan(12);
        expect(unwrapped()).toEqual([]);
    });
});

describe('the profile pages\' dates and numbers come from core\'s formatters', () => {
    it('a rating\'s month and the stats in English as they were', async () => {
        openPeer();
        fireEvent.click(await screen.findByText('Reviews (2)'));
        await waitFor(() => expect(screen.getAllByText('Sep 2026').length).toBe(2));
        expect(screen.getByText('4.5')).toBeInTheDocument();
    });
});
