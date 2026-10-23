/**
 * A click on an enterprise opens the enterprise page, never a member's Trust Profile (scratch/tools/
 * DESIGN-shops-round3-enterprise-shopfront-fable.md §0 rows 1–2 and 11, §1.1, slice E1).
 *
 * Every door on the web that opens someone by key (a post's author on the Market and its deal requester, a card in the
 * activity waterfall, a poll's or an event's author, the Pulse feed, People, a keeper row on the enterprise page)
 * calls `onOpenProfile`, which App.tsx turns into the one profile overlay, PublicProfilePage. That page reads the
 * profile by key first; when the node says `isTreasury` (server slice E0) it hands the key to `onOpenTreasury`, which
 * App.tsx turns into the enterprise page, and it never draws a Trust Profile for that key, not even while it waits.
 * The node's own BeanPool account, the author of every curated Pulse card, is a treasury row but no enterprise: its
 * profile says no `isTreasury`, and the Pulse door opens it, with its channel chips.
 * On the enterprise page, Block sits under a "…" menu at the foot (a member may hide a shop; not a header action), and
 * a keeper of the enterprise has none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { PublicProfilePage } from './PublicProfilePage';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import { PostAuthorTrust } from '../components/PostAuthorTrust';
import { PulseFeedCard } from '../components/PulseFeedCard';
import * as api from '../lib/api';
import * as blocklist from '../lib/blocklist';

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../components/EnterpriseDecisions', () => ({ EnterpriseDecisions: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/ArchetypeQuizModal', () => ({ ArchetypeQuizModal: () => null }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(async () => true),
    unblockUser: vi.fn(async () => true),
    onBlocklistUpdated: vi.fn(() => () => {}),
    getBlocklistFullNote: vi.fn(() => null),
}));

const ME = { publicKey: 'member-ana', privateKey: 'k', callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as any;
const ENT = 'enterprise-damo';
const NAME = "Damo's Enterprise";
const KOFI = 'member-kofi';

const ENTERPRISE_PROFILE = { publicKey: ENT, callsign: NAME, avatar: null, bio: '', contact: null, joinedAt: '2026-09-01T00:00:00.000Z', status: 'active', elderVouchedBy: 'member-damo', elderVouchedByCallsign: 'Damo', archetype: null, isTreasury: true };
const KOFI_PROFILE = { publicKey: KOFI, callsign: 'Kofi', avatar: null, bio: 'I fix bikes', contact: null, joinedAt: '2026-03-01T00:00:00.000Z', status: 'active', elderVouchedBy: null, elderVouchedByCallsign: null, archetype: null };
// The node's own BeanPool account: a treasury row that is no enterprise, so its profile says no isTreasury (server, review
// of #2367). It owns the curated learn channel, so it is the author of every curated Pulse card.
const BEANPOOL = 'node-beanpool';
const BEANPOOL_PROFILE = { publicKey: BEANPOOL, callsign: 'BeanPool', avatar: 'bundled://sprout', bio: '', contact: null, joinedAt: '2026-08-01T00:00:00.000Z', status: 'active', elderVouchedBy: null, elderVouchedByCallsign: null, archetype: null };
const BEANPOOL_LEARN = { id: 'chan_beanpool_learn', platform: 'youtube', url: 'https://www.youtube.com/channel/UC-b27mPemXxYje4VkKF7hgw', handle: '@BeanPool', category: 'learn', isPrimaryVideo: true, supportsAutolist: true, isVerified: false };
/** A curated Pulse card, as GET /api/pulse/feed hands it out. */
const pulseCard = (ownerPubkey: string, callsign: string) => ({
    id: `pulse-${ownerPubkey}`, ownerPubkey, url: 'https://www.youtube.com/watch?v=tgsN2LiUVa0', platform: 'youtube', category: 'learn',
    title: 'The BeanPool Economy', thumbnailUrl: null, callsign, avatarUrl: null, source: 'official', isVerified: false, publishedAt: '2026-08-04T00:00:00Z',
}) as api.PulseFeedItem;

/** Words only the member Trust Profile draws: none may show for an enterprise's key, at any moment. */
const TRUST_PROFILE_WORDS = ['Trust Profile', 'Reciprocity', 'Vouch', 'Collaboration Chemistry', 'Joined', 'Block', 'Report'];
function expectNoTrustProfile(when: string) {
    const page = document.body.textContent ?? '';
    for (const w of TRUST_PROFILE_WORDS) expect(page, `${w} (${when})`).not.toContain(w);
    expect(screen.queryByRole('button', { name: /Block|Report/ }), when).toBeNull();
}

/** The profile read, held until the test lets it through: the moment before the node has said what the key is. */
let releaseProfile: (() => void) | null = null;
function profileReads(hold = false) {
    const gate = hold ? new Promise<void>((r) => { releaseProfile = r; }) : Promise.resolve();
    vi.spyOn(api, 'getMemberProfile').mockImplementation(async (key: string) => {
        await gate;
        if (key === ENT) return ENTERPRISE_PROFILE as any;
        if (key === KOFI) return KOFI_PROFILE as any;
        if (key === BEANPOOL) return BEANPOOL_PROFILE as any;
        if (key === ME.publicKey) return { ...KOFI_PROFILE, publicKey: ME.publicKey, callsign: 'Ana' } as any;
        throw new Error('Member not found');
    });
    vi.spyOn(api, 'getMemberRatings').mockResolvedValue({ average: 0, count: 0, ratings: [] } as any);
    vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue([]);
    vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 10, keeperOf: [] } as any);
    vi.spyOn(api, 'getRatingsGiven').mockResolvedValue({ ratings: [] } as any);
    vi.spyOn(api, 'getFriends').mockResolvedValue([]);
    vi.spyOn(api, 'getPublicChannels').mockImplementation(async (key: string) => ({ channels: key === BEANPOOL ? [BEANPOOL_LEARN] : [] }) as any);
    vi.spyOn(api, 'vouchMemberApi').mockResolvedValue({ success: true } as any);
}

beforeEach(() => {
    vi.clearAllMocks();
    releaseProfile = null;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function profilePage(pubkey: string, onOpenTreasury = vi.fn()) {
    render(<PublicProfilePage identity={ME} pubkey={pubkey} onBack={vi.fn()} onMessage={vi.fn()} onNavigatePost={vi.fn()} onOpenTreasury={onOpenTreasury} />);
    return onOpenTreasury;
}

describe('PublicProfilePage: an enterprise key opens the enterprise page', () => {
    it('before the node has said what the key is, nothing of a Trust Profile; then the key goes to onOpenTreasury', async () => {
        profileReads(true);
        const onOpenTreasury = profilePage(ENT);
        expectNoTrustProfile('before the profile read answers');
        expect(screen.getByRole('button', { name: /Back/ })).toBeTruthy();
        expect(onOpenTreasury).not.toHaveBeenCalled();
        await act(async () => { releaseProfile!(); });
        await waitFor(() => expect(onOpenTreasury).toHaveBeenCalledWith(ENT));
        expect(onOpenTreasury).toHaveBeenCalledTimes(1);
        expectNoTrustProfile('after the profile read answered');
        expect(api.vouchMemberApi).not.toHaveBeenCalled();
    });

    it('a member: the Trust Profile as before, and never onOpenTreasury', async () => {
        profileReads(true);
        const onOpenTreasury = profilePage(KOFI);
        await act(async () => { releaseProfile!(); });
        await waitFor(() => expect(screen.getByText('I fix bikes', { exact: false })).toBeTruthy());
        expect(document.body.textContent).toContain('Kofi');
        expect(screen.getByRole('button', { name: /Block user Kofi/ })).toBeTruthy();
        expect(onOpenTreasury).not.toHaveBeenCalled();
    });

    it("the member's own profile: drawn at once, without waiting on the read", () => {
        profileReads(true);
        const onOpenTreasury = profilePage(ME.publicKey);
        expect(document.body.textContent).toContain('My Profile');
        expect(onOpenTreasury).not.toHaveBeenCalled();
    });

    it('a profile read that fails: the page as before (it cannot know), never stuck waiting', async () => {
        profileReads();
        vi.spyOn(api, 'getMemberProfile').mockRejectedValue(new Error('offline'));
        const onOpenTreasury = profilePage(KOFI);
        await waitFor(() => expect(screen.getByRole('button', { name: /Block user/ })).toBeTruthy());
        expect(onOpenTreasury).not.toHaveBeenCalled();
    });
});

describe('every door on the web lands on the enterprise page', () => {
    it("a post's author (PostAuthorTrust on the Market's cards and post sheet) → the profile overlay → the enterprise page", async () => {
        const opened: string[] = [];
        render(<PostAuthorTrust callsign={NAME} publicKey={ENT} onOpenProfile={(k) => opened.push(k)} />);
        fireEvent.click(screen.getByRole('button', { name: `View ${NAME}'s profile` }));
        expect(opened).toEqual([ENT]);
        cleanup();
        profileReads();
        const onOpenTreasury = profilePage(opened[0]);
        await waitFor(() => expect(onOpenTreasury).toHaveBeenCalledWith(ENT));
        expectNoTrustProfile('after the door');
    });

    it("the Pulse card's author (PulseFeedCard) → the profile overlay → the enterprise page, for an enterprise's card", async () => {
        const opened: string[] = [];
        render(<PulseFeedCard item={pulseCard(ENT, NAME)} onOpenProfile={(k) => opened.push(k)} />);
        fireEvent.click(screen.getByRole('button', { name: `View ${NAME}'s public profile` }));
        expect(opened).toEqual([ENT]);
        cleanup();
        profileReads();
        const onOpenTreasury = profilePage(opened[0]);
        await waitFor(() => expect(onOpenTreasury).toHaveBeenCalledWith(ENT));
        expectNoTrustProfile('after the door');
    });

    const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

    it('App.tsx: every onOpenProfile opens the one profile overlay, and that overlay hands an enterprise to the enterprise page', () => {
        const app = src('App.tsx');
        const handlers = [...app.matchAll(/onOpenProfile=\{([^}]*\}?)\}/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
        expect(handlers.length).toBeGreaterThanOrEqual(5);
        for (const h of handlers) expect(h).toBe('(pubkey) => setOpenProfilePubkey(pubkey)');
        // The profile overlay's hand-over: the profile closes and the enterprise page opens on the same key.
        const overlay = app.slice(app.indexOf('<PublicProfilePage'), app.indexOf('/>', app.indexOf('<PublicProfilePage')));
        const handOver = overlay.match(/onOpenTreasury=\{\(pubkey\) => \{([^}]*)\}\}/);
        expect(handOver, 'PublicProfilePage gets onOpenTreasury').toBeTruthy();
        expect(handOver![1]).toContain('setOpenProfilePubkey(null)');
        expect(handOver![1]).toContain('setOpenTreasuryPubkey(pubkey)');
    });

    it('the components that open someone by key do it only through onOpenProfile, and only PublicProfilePage draws a Trust Profile', () => {
        const root = path.resolve(__dirname, '..');
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                if (fs.statSync(p).isDirectory()) walk(p);
                else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
            }
        };
        walk(root);
        const doors: string[] = [];
        for (const f of files) {
            const s = fs.readFileSync(f, 'utf8');
            const rel = path.relative(root, f);
            // A door calls onOpenProfile with a key, or hands it to the card that does.
            if (rel !== 'App.tsx' && /\bonOpenProfile\b/.test(s)) doors.push(rel);
            if (rel !== path.join('pages', 'PublicProfilePage.tsx')) expect(s, rel).not.toMatch(/t\('Trust Profile'\)/);
            // No other screen renders the profile page itself: App.tsx's one overlay is the only way in.
            if (rel !== 'App.tsx' && !rel.endsWith('PublicProfilePage.tsx')) expect(s, rel).not.toMatch(/<PublicProfilePage\b/);
        }
        // §1.1's eleven web components (the header's own-profile button included), and a message request's sender on its
        // card and in the chat's header (message requests S3): each opens someone by key through onOpenProfile, which
        // App.tsx (above) sends to the one profile overlay.
        expect(doors.sort()).toEqual([
            path.join('components', 'ActivityWaterfall.tsx'),
            path.join('components', 'EventCard.tsx'),
            path.join('components', 'HeaderControls.tsx'),
            path.join('components', 'MarketplaceCard.tsx'),
            path.join('components', 'MessageRequests.tsx'),
            path.join('components', 'PollCard.tsx'),
            path.join('components', 'PostAuthorTrust.tsx'),
            path.join('components', 'PulseFeedCard.tsx'),
            path.join('pages', 'MarketplacePage.tsx'),
            path.join('pages', 'MessagesPage.tsx'),
            path.join('pages', 'PeoplePage.tsx'),
            path.join('pages', 'PulsePage.tsx'),
            path.join('pages', 'TreasuryDetailPage.tsx'),
        ].sort());
    });
});

describe("the Pulse card's author door, for the node's own BeanPool account", () => {
    it("opens BeanPool's profile with its learn channel, never the enterprise page", async () => {
        const opened: string[] = [];
        render(<PulseFeedCard item={pulseCard(BEANPOOL, 'BeanPool')} onOpenProfile={(k) => opened.push(k)} />);
        fireEvent.click(screen.getByRole('button', { name: "View BeanPool's public profile" }));
        expect(opened).toEqual([BEANPOOL]);
        cleanup();
        profileReads();
        const onOpenTreasury = profilePage(opened[0]);
        const chips = await screen.findByRole('list', { name: 'External channels' });
        expect(chips.querySelector('a[aria-label="YouTube @BeanPool"]')?.getAttribute('href')).toBe(BEANPOOL_LEARN.url);
        expect(chips.textContent).toContain('YouTube · @BeanPool');
        expect(document.body.textContent).toContain('BeanPool');
        expect(onOpenTreasury).not.toHaveBeenCalled();
    });
});

describe('TreasuryDetailPage: Block under the "…" menu at the foot', () => {
    function enterprise(over: Record<string, unknown> = {}) {
        return {
            publicKey: ENT, name: NAME, purpose: 'We fix bikes', status: 'active', paused: false, lifecycle: 'ongoing',
            balance: 12, creditLine: 50, liveOffers: 1, earnedSurplus: 0, workingCapitalCeiling: null,
            keepers: [{ publicKey: 'member-damo', callsign: 'Damo', role: 'lead', backing: 0 }],
            isLeadOrSoleKeeperOrAdmin: false, keeperRequests: [], keeperChanges: [], deferredClaims: [], pendingBids: [], activeDeals: [],
            posts: [], flow: [],
            ...over,
        };
    }
    function node(detail: unknown, keeperOf: string[] = []) {
        vi.spyOn(api, 'getTreasury').mockResolvedValue(detail as any);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 10, keeperOf } as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue(null as any);
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({ conversation: null, messages: [], readOnly: true } as any);
    }
    async function page(identity = ME) {
        render(<TreasuryDetailPage identity={identity} pubkey={ENT} onBack={vi.fn()} isMember />);
        await waitFor(() => expect(screen.getByRole('button', { name: /Report Enterprise/ })).toBeTruthy());
    }

    it('a member: no Block on the page until "…" is opened; Block asks, then blocks the enterprise key', async () => {
        node(enterprise());
        await page();
        expect(screen.queryByText(`Block ${NAME}`)).toBeNull();
        const more = screen.getByRole('button', { name: 'More options' });
        expect(more.getAttribute('aria-haspopup')).toBe('menu');
        expect(more.getAttribute('aria-expanded')).toBe('false');
        // The 48 px target every overlay control has; at the foot, after Report.
        expect(more.className).toContain('min-h-[48px]');
        expect(more.className).toContain('min-w-[48px]');
        const report = screen.getByRole('button', { name: /Report Enterprise/ });
        expect(report.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        fireEvent.click(more);
        expect(more.getAttribute('aria-expanded')).toBe('true');
        const block = screen.getByRole('menuitem', { name: `Block ${NAME}` });
        // Light and dark from the tokens: the danger chip's ink and tint, as the profile's Block had.
        expect(block.className).toContain('text-bp-chip-danger-ink');
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        await act(async () => { fireEvent.click(block); });
        expect(confirm).toHaveBeenCalledWith(`Block ${NAME}?\n\nThis will instantly hide all posts, offers, and messages from ${NAME}, and notify moderation.`);
        expect(blocklist.blockUser).toHaveBeenCalledTimes(1);
        expect(vi.mocked(blocklist.blockUser).mock.calls[0][0]).toBe(ENT);
        expect(vi.mocked(blocklist.blockUser).mock.calls[0][1]).toBe(ME.publicKey);
        expect(alert).toHaveBeenCalledWith(`${NAME} has been blocked and removed from your feed.`);
    });

    it('declining the question blocks nothing', async () => {
        node(enterprise());
        await page();
        fireEvent.click(screen.getByRole('button', { name: 'More options' }));
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: `Block ${NAME}` })); });
        expect(blocklist.blockUser).not.toHaveBeenCalled();
    });

    it('an enterprise this member has blocked: the menu offers Unblock', async () => {
        vi.mocked(blocklist.isUserBlocked).mockReturnValue(true);
        node(enterprise());
        await page();
        fireEvent.click(screen.getByRole('button', { name: 'More options' }));
        expect(screen.queryByRole('menuitem', { name: `Block ${NAME}` })).toBeNull();
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.spyOn(window, 'alert').mockImplementation(() => {});
        await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: `Unblock ${NAME}` })); });
        expect(blocklist.unblockUser).toHaveBeenCalledWith(ENT);
    });

    it('a keeper of this enterprise: no "…" and no Block; Report as it was', async () => {
        node(enterprise({ keepers: [{ publicKey: ME.publicKey, callsign: 'Ana', role: 'lead', backing: 0 }] }), [ENT]);
        await page();
        expect(screen.queryByRole('button', { name: 'More options' })).toBeNull();
        expect(screen.queryByText(`Block ${NAME}`)).toBeNull();
    });
});
