/**
 * Learn on the web, recognition (slice K8; DESIGN-local-knowledge-fable.md §2.10, §3.7): the opener's half of Thank, and the
 * badge on the writer's line. The real page with the node stubbed at lib/api. One table over each reader of a page (a member, the
 * page's writer, an owner, a visitor, a page gathered with the assistant, a community where Beans aren't live, the preview where
 * Learn is off) -> "🫘 Thank {name}" offered or not, and what a tap hands the Ledger: the writer's key and name and the note
 * 'Thanks for "{title}"'. Nothing else: no request leaves the page for it (the Ledger's Send form does the sending, under
 * today's rules: LedgerPage.send-start.test.tsx holds that half, can send / first trade / positive balance).
 * The badge: "🗺️ Local guide" beside the writer's name only where the node's read by id says `writerLocalGuide: true`.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as api from '../lib/api';
import type { LearnPost } from '../lib/learn';
import type { BeanPoolIdentity } from '../lib/identity';
import { sampleLearnPosts } from '../components/ShowcasePreviews';
import { LearnPage, type LearnTarget, type LearnThank } from './LearnPage';

const info = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useCommunityInfo: () => info.current,
    useReaderFeatures: () => null,
}));
vi.mock('../components/StartCommunityScreen', () => ({ StartCommunityScreen: () => <div data-testid="start-community" /> }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Damo', createdAt: '2026-09-17T00:00:00.000Z' };
const page = (extra: Partial<LearnPost> = {}, k: Partial<LearnPost['knowledge']> = {}): LearnPost => ({
    id: 'tip', type: 'knowledge', category: 'local-services', title: 'How recycling works at the tip', description: 'Sort it first.',
    authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: '2026-10-01T00:00:00.000Z', status: 'active', photos: [],
    knowledge: {
        sources: [], place: null, lang: null, checkedAt: '2026-10-20T00:00:00.000Z', outdatedAt: null, outdatedNote: null, helped: 4, gathered: false, ...k,
    },
    ...extra,
}) as LearnPost;

const node = { role: null as string | null, post: page() };
let request: MockInstance<typeof api.request>;
beforeEach(() => {
    vi.restoreAllMocks();
    info.current = { features: { knowledge: true, beans: true } };
    Object.assign(node, { role: null, post: page() });
    vi.spyOn(api, 'myNodeRoleOnce').mockImplementation(async () => node.role);
    request = vi.spyOn(api, 'request').mockImplementation((async (_method: string, path: string) => {
        if (path.startsWith('/api/marketplace/posts?')) return [node.post];
        if (path === '/api/knowledge/front') return { total: 0, pinned: [], topics: [] };
        if (path === '/api/knowledge/drafts/mine') return { waiting: [], answered: [] };
        if (path.startsWith('/api/knowledge/drafts?')) return { drafts: [], total: 0, limit: 50, offset: 0, unchecked: { total: 0, rows: [] } };
        throw new Error(`unexpected ${path}`);
    }) as never);
});
afterEach(() => cleanup());

const wait = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function openPage(opts: { who?: BeanPoolIdentity | null; target?: LearnTarget; onThank?: ((s: LearnThank) => void) | undefined } = {}) {
    render(<LearnPage identity={opts.who === undefined ? identity : opts.who} target={opts.target ?? { kind: 'page', id: node.post.id }}
        onTargetTaken={vi.fn()} onBack={vi.fn()} onOpenProfile={vi.fn()} onNavigate={vi.fn()} onNearYou={vi.fn()} onThank={opts.onThank} />);
    await wait();
}

type Reader = 'member' | 'writer' | 'owner' | 'visitor' | 'gathered' | 'beans-not-live' | 'preview';
async function openAs(reader: Reader, onThank: (s: LearnThank) => void) {
    if (reader === 'writer') node.post = page({ authorPublicKey: ME, authorCallsign: 'Damo' });
    if (reader === 'owner') node.role = 'owner';
    if (reader === 'gathered') node.post = page({ authorCallsign: 'Owen', authorPublicKey: 'owen-pk' }, { gathered: true });
    if (reader === 'preview') {
        info.current = { features: { showcase: true } };
        await openPage({ target: { kind: 'page', id: sampleLearnPosts()[0].id }, onThank });
        return;
    }
    // App.tsx passes onThank only where Beans are live for this reader (beansMode === 'live').
    await openPage({ who: reader === 'visitor' ? null : identity, onThank: reader === 'beans-not-live' ? undefined : onThank });
}

describe('the table: who is offered "🫘 Thank {name}", and what it hands the Ledger (§2.10, §3.7)', () => {
    const TABLE: Array<[Reader, boolean]> = [
        ['member', true],
        ['owner', true],
        // No button for oneself.
        ['writer', false],
        ['visitor', false],
        // Gathered with the assistant: nobody's own writing, and it earns no thanks or badge.
        ['gathered', false],
        // Beans off or previewed here: there is no Send form to open.
        ['beans-not-live', false],
        ['preview', false],
    ];
    it.each(TABLE)('%s: Thank offered %s (red when the button shows where the design says no, or is missing where it says yes)', async (reader, offered) => {
        const onThank = vi.fn();
        await openAs(reader, onThank);
        expect(screen.queryByTestId('learn-post') ?? screen.queryByText(/Example Valley/), 'the page drew').not.toBeNull();
        const button = screen.queryByTestId('learn-post-thank');
        expect(button !== null, `${reader}: Thank shown`).toBe(offered);
        if (!offered) return;
        expect(button!.textContent).toBe('🫘 Thank Ada');
        const before = request.mock.calls.length;
        fireEvent.click(button!);
        await wait();
        // The writer chosen and the note filled, for the Ledger's Send form: nothing is sent from here.
        expect(onThank.mock.calls).toEqual([[{ to: 'ada-pk', name: 'Ada', note: 'Thanks for "How recycling works at the tip"' }]]);
        expect(request.mock.calls.slice(before)).toEqual([]);
    });
});

describe('the badge on the writer\'s line', () => {
    it.each([[true, true], [false, false], [undefined, false]] as const)('writerLocalGuide %s: "🗺️ Local guide" shown %s', async (guide, shown) => {
        node.post = page({}, guide === undefined ? {} : { writerLocalGuide: guide });
        await openPage({ onThank: vi.fn() });
        const badge = screen.queryByTestId('learn-post-writer-guide');
        expect(badge !== null).toBe(shown);
        if (shown) {
            expect(badge!.textContent).toBe('🗺️ Local guide');
            // Beside the writer's name, inside the writer's own button (a tap still opens the profile).
            expect(screen.getByTestId('learn-post-writer').contains(badge)).toBe(true);
        }
    });

    it('a page gathered with the assistant names no writer, so no badge either, whatever the node says', async () => {
        node.post = page({}, { gathered: true, writerLocalGuide: true });
        await openPage({ onThank: vi.fn() });
        expect(screen.queryByTestId('learn-post-writer-guide')).toBeNull();
        expect(screen.queryByTestId('learn-post-gathered')).not.toBeNull();
    });
});
