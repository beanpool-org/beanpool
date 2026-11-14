/**
 * Learn on the web (slice K2), the real page with the node stubbed at lib/api: the front, a topic, a search and one page; what
 * it asks the node and what it never does; the preview on a community that shows samples; the doors that open it.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as api from '../lib/api';
import { learnFrontOf, learnSearchOf, learnTopicOf, type LearnPost } from '../lib/learn';
import type { BeanPoolIdentity } from '../lib/identity';
import { LearnPage, type LearnTarget } from './LearnPage';

const info = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useCommunityInfo: () => info.current,
    useReaderFeatures: () => null,
}));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: ({ photos, initialIndex }: { photos: string[]; initialIndex?: number }) => <div data-testid="lightbox">{photos[initialIndex ?? 0]}</div> }));
vi.mock('../components/ReportModal', () => ({ ReportModal: ({ targetPostId, targetPubkey }: { targetPostId?: string; targetPubkey: string }) => <div data-testid="report-sheet">{targetPostId}:{targetPubkey}</div> }));
vi.mock('../components/StartCommunityScreen', () => ({ StartCommunityScreen: () => <div data-testid="start-community" /> }));

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Damo', createdAt: '2026-09-17T00:00:00.000Z' };

function page(id: string, extra: Record<string, any> = {}): LearnPost {
    const { helped = 0, place = null, outdated = false, outdatedNote = null, sources = [], gathered = false, lang = null, ...rest } = extra;
    return {
        id, type: 'knowledge', category: 'good-to-know', title: `Title ${id}`, description: `First line of ${id}\n\nThe rest of ${id}.`,
        authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: '2026-10-01T00:00:00.000Z', status: 'active', photos: [],
        knowledge: { sources, place, lang, checkedAt: '2026-10-20T00:00:00.000Z', outdatedAt: outdated ? '2026-11-01T00:00:00.000Z' : null, outdatedNote, helped, gathered },
        ...rest,
    } as LearnPost;
}

const FLOOD = page('flood', {
    category: 'emergencies', title: 'Who to call when the creek floods the road', helped: 14, place: 'The low bridge by the creek',
    description: 'Call the council roads line first.\n\nThen <b>emergency</b> services. See https://evil.example/now',
    sources: [
        { url: 'https://www.council.example/roads/flood', label: 'Council roads line' },
        { url: 'http://ses.example/', label: '' },
        { url: 'javascript:alert(1)', label: 'Not a link' },
    ],
});
const SERVICES = ['s1', 's2', 's3', 's4', 's5'].map((id, i) => page(id, { category: 'local-services', title: `Service ${i + 1}`, helped: 10 - i }));
const OLD = page('old', { category: 'good-to-know', title: 'The old bus times', outdated: true, outdatedNote: 'The timetable changed in March' });
const POSTS = [FLOOD, ...SERVICES, OLD];

// `gate`: a later page of a topic (offset > 0) waits for it. `failTopic` / `failMore`: the first page of a topic / a later one is refused.
const node = { posts: POSTS as LearnPost[], failFront: false, failTopic: false, failMore: false, gate: null as Promise<void> | null };
let request: MockInstance<typeof api.request>;
const asked = () => request.mock.calls.map((c) => String(c[1]));

function stubNode() {
    // A plain member (K4's writing screens: LearnPage.write.test.tsx); their own suggestions are none.
    vi.spyOn(api, 'myNodeRoleOnce').mockResolvedValue(null);
    request = vi.spyOn(api, 'request').mockImplementation((async (_m: string, path: string) => {
        if (path === '/api/knowledge/drafts/mine') return { waiting: [], answered: [] };
        if (path === '/api/knowledge/front') {
            if (node.failFront) throw new Error('offline');
            return learnFrontOf(node.posts);
        }
        const q = new URLSearchParams(path.split('?')[1] ?? '');
        if (path.startsWith('/api/knowledge/front?topic=')) {
            const offset = Number(q.get('offset') ?? 0);
            if (offset === 0 && node.failTopic) throw new Error('offline');
            if (offset > 0 && node.gate) await node.gate;
            if (offset > 0 && node.failMore) throw new Error('offline');
            return learnTopicOf(node.posts, q.get('topic')!, offset);
        }
        if (path.startsWith('/api/knowledge/front?q=')) return learnSearchOf(node.posts, q.get('q')!);
        if (path.startsWith('/api/marketplace/posts?')) return node.posts.filter((p) => p.id === q.get('id'));
        throw new Error(`unexpected ${path}`);
    }) as never);
}

const wait = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const props = { identity, target: null as LearnTarget | null, onTargetTaken: vi.fn(), onBack: vi.fn(), onOpenProfile: vi.fn(), onNavigate: vi.fn(), onNearYou: vi.fn() };
async function openLearn(extra: Partial<typeof props> = {}) {
    render(<LearnPage {...props} {...extra} />);
    await wait(30);
}

beforeEach(() => {
    vi.restoreAllMocks();
    info.current = { features: { knowledge: true } };
    node.posts = POSTS;
    node.failFront = false;
    node.failTopic = false;
    node.failMore = false;
    node.gate = null;
    Object.values(props).forEach((v) => { if (typeof v === 'function' && 'mockClear' in v) (v as ReturnType<typeof vi.fn>).mockClear(); });
    stubNode();
});
afterEach(() => { cleanup(); });

describe('the front', () => {
    it('is the place\'s name and line, a search box, the topics that hold something with their counts, in core\'s order', async () => {
        await openLearn();
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Learn');
        expect(screen.getByText('Things worth knowing about your community.')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Search Learn')).toBeInTheDocument();
        const chips = within(screen.getByTestId('learn-topic-chips'));
        expect(chips.getAllByRole('button').map((b) => b.textContent)).toEqual(['All topics', '🚨Emergencies 1', '🚰Local services 5', '💡Good to know 1']);
        // The glyph is decoration: a screen reader reads the topic and its count.
        expect(chips.getByRole('button', { name: 'Local services 5' })).toBeInTheDocument();
        const blocks = ['learn-topic-emergencies', 'learn-topic-local-services', 'learn-topic-good-to-know'].map((id) => screen.getByTestId(id));
        expect(blocks.every((b, i) => !i || (blocks[i - 1].compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)).toBe(true);
        expect(screen.getByText('Local knowledge is written by members. Check the source before you rely on it.')).toBeInTheDocument();
    });

    it('shows three rows of a topic of five and "See all 5 ›", which shows that topic alone, every row, with Show more at 50', async () => {
        await openLearn();
        const services = within(screen.getByTestId('learn-topic-local-services'));
        expect(services.getAllByTestId('learn-row')).toHaveLength(3);
        fireEvent.click(services.getByRole('button', { name: 'See all 5 ›' }));
        await wait(30);
        expect(asked()).toContain('/api/knowledge/front?topic=local-services&offset=0');
        const view = within(screen.getByTestId('learn-topic-view'));
        expect(view.getAllByTestId('learn-row')).toHaveLength(5);
        expect(screen.queryByTestId('learn-topic-emergencies')).toBeNull();
        expect(screen.queryByTestId('learn-show-more')).toBeNull();
        fireEvent.click(within(screen.getByTestId('learn-topic-chips')).getByRole('button', { name: 'All topics' }));
        expect(screen.getByTestId('learn-topic-emergencies')).toBeInTheDocument();
    });

    it('a topic of more than a page asks for the next page with Show more and adds it to the list', async () => {
        node.posts = Array.from({ length: 53 }, (_, i) => page(`p${String(i).padStart(2, '0')}`, { category: 'emergencies', title: `Page ${String(i).padStart(2, '0')}` }));
        await openLearn({ target: { kind: 'topic', topic: 'emergencies' } });
        expect(within(screen.getByTestId('learn-topic-view')).getAllByTestId('learn-row')).toHaveLength(50);
        fireEvent.click(screen.getByTestId('learn-show-more'));
        await wait(30);
        expect(asked()).toContain('/api/knowledge/front?topic=emergencies&offset=50');
        expect(within(screen.getByTestId('learn-topic-view')).getAllByTestId('learn-row')).toHaveLength(53);
    });

    // Review of #3074, round 1: a double tap, and a failed page, on a topic of more than a page.
    const MANY = (n: number) => Array.from({ length: n }, (_, i) => page(`p${String(i).padStart(3, '0')}`, { category: 'emergencies', title: `Page ${String(i).padStart(3, '0')}` }));
    const rowNames = () => within(screen.getByTestId('learn-topic-view')).getAllByTestId('learn-row').map((r) => r.getAttribute('aria-label'));

    it('a double tap on Show more asks once, and no row appears twice', async () => {
        node.posts = MANY(120);
        let release!: () => void;
        node.gate = new Promise<void>((r) => { release = r; });
        await openLearn({ target: { kind: 'topic', topic: 'emergencies' } });
        const button = screen.getByTestId('learn-show-more');
        // Both taps in one frame, before the screen has drawn the first: only a guard that is not a render stops the second.
        act(() => { fireEvent.click(button); fireEvent.click(button); });
        // Out for the answer: the button says so and cannot be pressed again.
        expect(screen.getByTestId('learn-show-more')).toBeDisabled();
        expect(screen.getByTestId('learn-show-more').textContent).toBe('Loading...');
        release();
        await wait(30);
        expect(asked().filter((p) => p.includes('offset=50'))).toHaveLength(1);
        const names = rowNames();
        expect(names).toHaveLength(100);
        expect(new Set(names).size).toBe(100);
        expect(screen.getByTestId('learn-show-more').textContent).toBe('Show more');
        expect(screen.getByTestId('learn-show-more')).toBeEnabled();
    });

    it('a failed Show more keeps the rows already shown and offers Try again, which asks for that page again', async () => {
        node.posts = MANY(53);
        await openLearn({ target: { kind: 'topic', topic: 'emergencies' } });
        expect(rowNames()).toHaveLength(50);
        node.failMore = true;
        fireEvent.click(screen.getByTestId('learn-show-more'));
        await wait(30);
        expect(rowNames()).toHaveLength(50);
        const view = within(screen.getByTestId('learn-topic-view'));
        expect(view.getByRole('alert').textContent).toContain("Couldn't load Learn. Check your connection and try again.");
        expect(screen.queryByTestId('learn-show-more')).toBeNull();
        node.failMore = false;
        fireEvent.click(view.getByRole('button', { name: 'Try again' }));
        await wait(30);
        expect(rowNames()).toHaveLength(53);
        expect(new Set(rowNames()).size).toBe(53);
        expect(within(screen.getByTestId('learn-topic-view')).queryByRole('alert')).toBeNull();
        expect(asked().filter((p) => p.includes('offset=50'))).toHaveLength(2);
    });

    it('a topic whose first page fails says so with Try again, which reads it again', async () => {
        node.failTopic = true;
        await openLearn({ target: { kind: 'topic', topic: 'emergencies' } });
        expect(screen.getByTestId('learn-failed')).toBeInTheDocument();
        expect(screen.queryByTestId('learn-topic-view')).toBeNull();
        node.failTopic = false;
        fireEvent.click(within(screen.getByTestId('learn-failed')).getByRole('button', { name: 'Try again' }));
        await wait(30);
        expect(screen.queryByTestId('learn-failed')).toBeNull();
        expect(within(screen.getByTestId('learn-topic-view')).getAllByTestId('learn-row')).toHaveLength(1);
        expect(asked().filter((p) => p === '/api/knowledge/front?topic=emergencies&offset=0')).toHaveLength(2);
    });

    it('draws a row: topic chip, title, first line only, "Checked Oct 2026 · Helped 14", the topic tile for no photo, MAY BE OUT OF DATE in amber', async () => {
        await openLearn();
        const row = within(screen.getByTestId('learn-topic-emergencies')).getByTestId('learn-row');
        expect(within(row).getByTestId('learn-row-topic').textContent).toBe('EMERGENCIES');
        expect(row.textContent).toContain('Who to call when the creek floods the road');
        expect(row.textContent).toContain('Call the council roads line first.');
        expect(row.textContent).not.toContain('emergency</b>');
        expect(within(row).getByTestId('learn-row-checked').textContent).toBe('Checked Oct 2026');
        expect(within(row).getByTestId('learn-row-helped').textContent).toBe('Helped 14');
        expect(within(row).getByTestId('learn-topic-tile')).toBeInTheDocument();
        expect(row.getAttribute('aria-label')).toBe('Local knowledge: Who to call when the creek floods the road, checked Oct 2026');
        const old = within(screen.getByTestId('learn-topic-good-to-know')).getByTestId('learn-row');
        expect(within(old).getByTestId('learn-row-outdated').textContent).toBe('MAY BE OUT OF DATE');
        expect(within(old).queryByTestId('learn-row-helped')).toBeNull();
    });

    it('says "Nothing here yet." when nothing is showing, and asks a member for what they know (slice K4: the form)', async () => {
        node.posts = [];
        await openLearn();
        expect(screen.getByTestId('learn-empty').textContent).toBe('Nothing here yet. Know something locals should know?');
        expect(screen.getByRole('button', { name: '＋ Suggest knowledge' })).toBeInTheDocument();
    });

    it('says it could not load, and asks again on Try again', async () => {
        node.failFront = true;
        await openLearn();
        expect(screen.getByTestId('learn-failed')).toBeInTheDocument();
        node.failFront = false;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await wait(30);
        expect(screen.queryByTestId('learn-failed')).toBeNull();
        expect(screen.getByTestId('learn-topic-emergencies')).toBeInTheDocument();
    });

    it('leaves Learn on Back', async () => {
        await openLearn();
        fireEvent.click(screen.getByTestId('learn-back'));
        expect(props.onBack).toHaveBeenCalledTimes(1);
    });
});

describe('searching Learn', () => {
    it('asks the node 300 ms after the last key, and shows one flat list, best match first', async () => {
        await openLearn();
        fireEvent.change(screen.getByTestId('learn-search'), { target: { value: 'creek' } });
        expect(asked().some((p) => p.includes('?q='))).toBe(false);
        await wait(340);
        expect(asked()).toContain('/api/knowledge/front?q=creek');
        const rows = screen.getAllByTestId('learn-row');
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('Who to call when the creek floods the road');
        expect(screen.queryByTestId('learn-topic-chips')).toBeNull();
    });

    it('says what it found nothing for and offers the Market\'s search of the same words', async () => {
        await openLearn();
        fireEvent.change(screen.getByTestId('learn-search'), { target: { value: 'zeppelin' } });
        await wait(340);
        expect(screen.getByText('Nothing in Learn for "zeppelin".')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Search the Market for "zeppelin" ›' }));
        expect(props.onNavigate).toHaveBeenCalledWith('marketplace-search', 'zeppelin');
    });

    it('clearing the words is the front again', async () => {
        await openLearn({ target: { kind: 'search', q: 'creek' } });
        await wait(340);
        expect(screen.getAllByTestId('learn-row')).toHaveLength(1);
        fireEvent.change(screen.getByTestId('learn-search'), { target: { value: '' } });
        await wait(30);
        expect(screen.getByTestId('learn-topic-emergencies')).toBeInTheDocument();
    });
});

describe('a page', () => {
    async function openFlood() {
        await openLearn();
        fireEvent.click(within(screen.getByTestId('learn-topic-emergencies')).getByTestId('learn-row'));
        await wait(30);
    }

    it('reads the page whole by id, naming the type, answer first: title, body as plain text, place, sources, Checked, writer, the standing line', async () => {
        await openFlood();
        expect(asked()).toContain('/api/marketplace/posts?type=knowledge&id=flood');
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('LOCAL KNOWLEDGE');
        expect(screen.getByTestId('learn-post-topic').textContent).toBe('EMERGENCIES');
        expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Who to call when the creek floods the road');
        const body = screen.getByTestId('learn-post-body');
        expect(body.textContent).toContain('Then <b>emergency</b> services. See https://evil.example/now');
        expect(body.querySelector('a, b')).toBeNull();
        expect(screen.getByTestId('learn-post-place').textContent).toBe('Where: The low bridge by the creek');
        expect(screen.getByTestId('learn-post-checked').textContent).toBe('Checked Oct 2026');
        expect(screen.getByTestId('learn-post-writer').textContent).toBe('Ada');
        expect(screen.getByText('Local knowledge is written by members. Check the source before you rely on it.')).toBeInTheDocument();
        expect(screen.queryByText('This may be out of date.')).toBeNull();
    });

    it('lists the sources with their host under them; only http and https are links, opened in a new tab without the opener', async () => {
        await openFlood();
        const sources = within(screen.getByTestId('learn-post-sources'));
        const links = sources.getAllByRole('link');
        expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://www.council.example/roads/flood', 'http://ses.example/']);
        expect(links.every((a) => a.getAttribute('target') === '_blank' && /noopener/.test(a.getAttribute('rel') ?? ''))).toBe(true);
        expect(links[0].textContent).toContain('Council roads line');
        expect(links[0].textContent).toContain('council.example');
        expect(links[1].textContent).toContain('ses.example');
        expect(sources.getByText('Not a link')).toBeInTheDocument();
        expect(sources.getAllByRole('listitem')).toHaveLength(3);
    });

    it('Back returns to the list it was opened from, with the topic still chosen', async () => {
        await openLearn({ target: { kind: 'topic', topic: 'local-services' } });
        fireEvent.click(within(screen.getByTestId('learn-topic-view')).getAllByTestId('learn-row')[0]);
        await wait(30);
        fireEvent.click(screen.getByTestId('learn-back'));
        await wait(30);
        expect(props.onBack).not.toHaveBeenCalled();
        expect(screen.getByTestId('learn-topic-view')).toBeInTheDocument();
    });

    it('a page a door opened straight leaves Learn on Back', async () => {
        await openLearn({ target: { kind: 'page', id: 'flood' } });
        expect(screen.getByTestId('learn-post')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('learn-back'));
        expect(props.onBack).toHaveBeenCalledTimes(1);
    });

    it('a door is taken once', async () => {
        await openLearn({ target: { kind: 'search', q: 'creek' } });
        expect(props.onTargetTaken).toHaveBeenCalledTimes(1);
        expect((screen.getByTestId('learn-search') as HTMLInputElement).value).toBe('creek');
    });

    it('a page that is no longer showing says so, and Back leaves it', async () => {
        await openLearn({ target: { kind: 'page', id: 'gone' } });
        expect(screen.getByTestId('learn-page-gone').textContent).toBe("This page of Local knowledge isn't showing any more.");
    });

    it('marks a page that may be out of date, with the note and when', async () => {
        await openLearn();
        fireEvent.click(within(screen.getByTestId('learn-topic-good-to-know')).getByTestId('learn-row'));
        await wait(30);
        const box = within(screen.getByTestId('learn-post-outdated'));
        expect(box.getByText('This may be out of date.')).toBeInTheDocument();
        expect(box.getByText('The timetable changed in March')).toBeInTheDocument();
        expect(box.getByText(/^Marked .*2026$/)).toBeInTheDocument();
    });

    it('says when it is written in another language than the screens', async () => {
        node.posts = [page('es', { lang: 'es', category: 'emergencies' }), page('en', { lang: 'en', category: 'emergencies' })];
        await openLearn({ target: { kind: 'page', id: 'es' } });
        expect(screen.getByTestId('learn-post-lang').textContent).toBe('Written in Español');
        // A screen reader reads the page in its own language, not the screens'.
        expect(screen.getByTestId('learn-post-body').getAttribute('lang')).toBe('es');
        expect(screen.getByRole('heading', { level: 2 }).getAttribute('lang')).toBe('es');
        cleanup();
        await openLearn({ target: { kind: 'page', id: 'en' } });
        expect(screen.queryByTestId('learn-post-lang')).toBeNull();
    });

    it('a page gathered with the assistant names the checker, and no writer\'s card', async () => {
        node.posts = [page('g', { gathered: true, authorCallsign: 'Bea', category: 'emergencies' })];
        await openLearn({ target: { kind: 'page', id: 'g' } });
        expect(screen.getByTestId('learn-post-gathered').textContent).toBe('Gathered with the assistant from the sources above. Checked by Bea.');
        expect(screen.queryByTestId('learn-post-writer')).toBeNull();
    });

    it('opens the writer\'s profile from their card, and reports the page by its id (never one\'s own)', async () => {
        await openFlood();
        fireEvent.click(screen.getByTestId('learn-post-writer'));
        expect(props.onOpenProfile).toHaveBeenCalledWith('ada-pk');
        fireEvent.click(screen.getByTestId('learn-post-report'));
        expect(screen.getByTestId('report-sheet').textContent).toBe('flood:ada-pk');
        cleanup();
        node.posts = [page('mine', { authorPublicKey: ME, category: 'emergencies' })];
        await openLearn({ target: { kind: 'page', id: 'mine' } });
        expect(screen.queryByTestId('learn-post-report')).toBeNull();
    });

    it('opens a photo whole in the lightbox', async () => {
        node.posts = [page('ph', { category: 'emergencies', photos: ['/photos/a.jpg', '/photos/b.jpg'] })];
        await openLearn({ target: { kind: 'page', id: 'ph' } });
        const buttons = screen.getAllByRole('button', { name: /^View enlarged photo/ });
        expect(buttons).toHaveLength(2);
        fireEvent.click(buttons[1]);
        expect(screen.getByTestId('lightbox').textContent).toBe('/photos/b.jpg');
    });

    it('draws only the photos the web\'s image allow-list lets through: a refused address is never drawn', async () => {
        node.posts = [page('ph', { category: 'emergencies', photos: ['/photos/a.jpg', 'http://tracker.example/p.png', 'javascript:alert(1)', 'https://img.example/b.jpg'] })];
        await openLearn({ target: { kind: 'page', id: 'ph' } });
        const imgs = Array.from(document.querySelectorAll('[data-testid="learn-post-photos"] img')).map((i) => i.getAttribute('src'));
        expect(imgs).toEqual(['/photos/a.jpg', 'https://img.example/b.jpg']);
        expect(screen.getAllByRole('button', { name: /^View enlarged photo \d of 2:/ })).toHaveLength(2);
        fireEvent.click(screen.getAllByRole('button', { name: /^View enlarged photo/ })[1]);
        expect(screen.getByTestId('lightbox').textContent).toBe('https://img.example/b.jpg');
    });

    it('has no action of the later slices: no helped, share, fix, edit or take-down', async () => {
        await openFlood();
        expect(screen.queryByRole('button', { name: /helped|share|fix|edit|take.?down|thank|pin/i })).toBeNull();
    });
});

describe('where Learn is off, and where it is previewed', () => {
    it('waits for the node to say, and asks it for nothing before', async () => {
        info.current = null;
        await openLearn();
        expect(screen.getByText('Loading...')).toBeInTheDocument();
        expect(request).not.toHaveBeenCalled();
    });

    it('is not shown where the node has it off and shows no previews: a line, no reads', async () => {
        info.current = { features: { knowledge: false } };
        await openLearn();
        expect(screen.getByTestId('learn-off').textContent).toBe("Learn isn't switched on in this community.");
        expect(request).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('learn-back'));
        expect(props.onBack).toHaveBeenCalled();
    });

    it('is not shown by a node from before Learn, which says nothing: that is off, not on', async () => {
        info.current = { features: { beans: true } };
        await openLearn();
        expect(screen.getByTestId('learn-off')).toBeInTheDocument();
    });

    describe('previewed from Example Valley (a node with Learn off and showcase on)', () => {
        beforeEach(() => { info.current = { features: { knowledge: false, showcase: true } }; });

        it('draws the three sample pages under the strip, asks the node for nothing, and leads to a local community', async () => {
            await openLearn();
            expect(request).not.toHaveBeenCalled();
            const strip = screen.getByTestId('learn-preview-strip');
            expect(within(strip).getByText('Local community')).toBeInTheDocument();
            expect(screen.getAllByTestId('learn-row')).toHaveLength(3);
            expect(screen.getByText('Who to call when the creek floods the road')).toBeInTheDocument();
            fireEvent.click(screen.getByTestId('learn-preview-start'));
            expect(screen.getByTestId('start-community')).toBeInTheDocument();
            fireEvent.click(within(strip).getByRole('button', { name: 'Communities near you' }));
            expect(props.onNearYou).toHaveBeenCalledTimes(1);
        });

        it('opens a sample page from the sample, with no writer to open or report, no source and no photo', async () => {
            await openLearn();
            fireEvent.click(screen.getAllByTestId('learn-row')[0]);
            await wait(30);
            expect(screen.getByTestId('learn-post-body').textContent).toContain('council roads line');
            expect(screen.queryByTestId('learn-post-writer')).toBeNull();
            expect(screen.queryByTestId('learn-post-report')).toBeNull();
            expect(screen.queryByTestId('learn-post-sources')).toBeNull();
            expect(request).not.toHaveBeenCalled();
        });

        it('searches the sample by a plain match, and gives no Market door (the sample is not the Market\'s)', async () => {
            await openLearn({ target: { kind: 'search', q: 'recycling' } });
            await wait(340);
            expect(screen.getAllByTestId('learn-row')).toHaveLength(1);
            fireEvent.change(screen.getByTestId('learn-search'), { target: { value: 'zeppelin' } });
            await wait(340);
            expect(screen.getByTestId('learn-search-empty')).toBeInTheDocument();
            expect(screen.queryByTestId('learn-search-market')).toBeNull();
            expect(request).not.toHaveBeenCalled();
        });

        it('a live community shows no strip', async () => {
            cleanup();
            info.current = { features: { knowledge: true } };
            await openLearn();
            expect(screen.queryByTestId('learn-preview-strip')).toBeNull();
        });
    });
});
