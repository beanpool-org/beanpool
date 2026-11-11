/**
 * Learn in the member's language (slice K2; words S3, web sweep): every word a member reads on Learn's front, a topic, a search,
 * a page and the preview came through t(), the topic names and the standing lines included. What members wrote (a title, a
 * body, a place, a source's label, a name) and a source's host are shown as written. In English nothing is bracketed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as api from '../lib/api';
import { learnFrontOf, learnSearchOf, learnTopicOf, type LearnPost } from '../lib/learn';
import { LearnSearchLine } from '../components/LearnSearchLine';
import { LearnPage, type LearnTarget } from './LearnPage';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

const info = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useCommunityInfo: () => info.current,
    useReaderFeatures: () => null,
}));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/StartCommunityScreen', () => ({ StartCommunityScreen: () => null }));

const ME = 'me-pk';
const identity = { publicKey: ME, privateKey: 'k', callsign: 'Damo', createdAt: '2026-09-17T00:00:00.000Z' };

function page(id: string, extra: Record<string, any> = {}): LearnPost {
    const { helped = 0, place = null, outdated = false, outdatedNote = null, sources = [], gathered = false, lang = null, ...rest } = extra;
    return {
        id, type: 'knowledge', category: 'good-to-know', title: `Title ${id}`, description: `Body ${id}`,
        authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: '2026-10-01T00:00:00.000Z', status: 'active', photos: [],
        knowledge: { sources, place, lang, checkedAt: '2026-10-20T00:00:00.000Z', outdatedAt: outdated ? '2026-11-01T00:00:00.000Z' : null, outdatedNote, helped, gathered },
        ...rest,
    } as LearnPost;
}
const POSTS = [
    page('flood', { category: 'emergencies', title: 'Creek floods', description: 'Ring the roads line', helped: 14, place: 'Low bridge', lang: 'es',
        sources: [{ url: 'https://www.council.example/roads', label: 'Council roads' }] }),
    ...['a', 'b', 'c', 'd'].map((id) => page(`s${id}`, { category: 'local-services', title: `Service ${id}`, helped: 2 })),
    page('old', { category: 'getting-around', title: 'Old bus times', outdated: true, outdatedNote: 'Changed in March' }),
    page('gathered', { category: 'health-help', title: 'Clinic hours', gathered: true, authorCallsign: 'Bea' }),
];
/** What members wrote or other sites hold, shown as written (the topic emoji and counts have no letters). */
const OTHERS = [...POSTS.flatMap((p) => [p.title, p.description, p.authorCallsign]), 'Low bridge', 'Council roads', 'council.example', 'Changed in March', 'Español', 'tip', 'zeppelin'];

const wait = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function open(target: LearnTarget | null = null) {
    render(<LearnPage identity={identity as never} target={target} onTargetTaken={vi.fn()} onBack={vi.fn()} onOpenProfile={vi.fn()} onNavigate={vi.fn()} onNearYou={vi.fn()} />);
    await wait(40);
}

beforeEach(() => {
    vi.restoreAllMocks();
    info.current = { features: { knowledge: true } };
    vi.spyOn(api, 'request').mockImplementation((async (_m: string, path: string) => {
        const q = new URLSearchParams(path.split('?')[1] ?? '');
        if (path === '/api/knowledge/front') return learnFrontOf(POSTS);
        if (path.startsWith('/api/knowledge/front?topic=')) return learnTopicOf(POSTS, q.get('topic')!, Number(q.get('offset') ?? 0));
        if (path.startsWith('/api/knowledge/front?q=')) return learnSearchOf(POSTS, q.get('q')!);
        if (path.startsWith('/api/marketplace/posts?')) return POSTS.filter((p) => p.id === q.get('id'));
        throw new Error(`unexpected ${path}`);
    }) as never);
});
afterEach(() => { cleanup(); backToEnglish(); });

describe('Learn in the pseudo-locale', () => {
    it('the front, a topic and an empty search: every word came through t()', async () => {
        await showIn('xx');
        await open();
        expect(bracketed()).toBeGreaterThan(8);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByText(xx('Things worth knowing about your community.'))).toBeInTheDocument();
        expect(screen.getByPlaceholderText(xx('Search Learn'))).toBeInTheDocument();

        fireEvent.click(screen.getByTestId('learn-see-all-local-services'));
        await wait(40);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        fireEvent.change(screen.getByTestId('learn-search'), { target: { value: 'zeppelin' } });
        await wait(340);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByTestId('learn-search-empty')).toBeInTheDocument();
    });

    it('a page, with its sources, its mark, its language and its writer', async () => {
        await showIn('xx');
        await open({ kind: 'page', id: 'flood' });
        expect(bracketed()).toBeGreaterThan(4);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        cleanup();
        await open({ kind: 'page', id: 'old' });
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByText(xx('This may be out of date.'))).toBeInTheDocument();
        cleanup();
        await open({ kind: 'page', id: 'gathered' });
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it('the preview and the Market\'s line', async () => {
        await showIn('xx');
        info.current = { features: { knowledge: false, showcase: true } };
        await open();
        expect(screen.getByTestId('learn-preview-strip')).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        cleanup();

        info.current = { features: { knowledge: true } };
        render(<LearnSearchLine words="tip" mode="live" onOpen={vi.fn()} />);
        await wait(380);
        expect(bracketed()).toBeGreaterThan(0);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByTestId('market-learn-line').textContent).toContain(String(learnSearchOf(POSTS, 'tip').total));
    });
});

describe('Learn in English', () => {
    it('nothing is bracketed, and the words are as the design has them', async () => {
        await open();
        expect(bracketed()).toBe(0);
        expect(screen.getByText('Local knowledge is written by members. Check the source before you rely on it.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'All topics' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Local services 4/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'See all 4 ›' })).toBeInTheDocument();
        cleanup();
        await open({ kind: 'page', id: 'old' });
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('LOCAL KNOWLEDGE');
    });
});
