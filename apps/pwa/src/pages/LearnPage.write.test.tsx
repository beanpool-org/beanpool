/**
 * Learn on the web, writing (slice K4), the real page with the node stubbed at lib/api: "＋ Suggest knowledge" and the form, an
 * owner's or admin's "＋ Add local knowledge" that publishes at once, My suggestions with "Take it back", To check with Approve,
 * the assistant's tick and "Not this one", and the doors that open each screen straight. What it sends, and what it never does.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as api from '../lib/api';
import { learnFrontOf, learnSearchOf, type LearnPost } from '../lib/learn';
import type { BeanPoolIdentity } from '../lib/identity';
import type { KnowledgeDraftMine, KnowledgeDraftToCheck, KnowledgeDraftWhole, KnowledgePhotoCredit } from '@beanpool/core';
import { LearnPage, type LearnTarget } from './LearnPage';

const info = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useCommunityInfo: () => info.current,
    useReaderFeatures: () => null,
}));
vi.mock('../components/StartCommunityScreen', () => ({ StartCommunityScreen: () => <div data-testid="start-community" /> }));

const identity: BeanPoolIdentity = { publicKey: 'me-pk', privateKey: 'k', callsign: 'Damo', createdAt: '2026-09-17T00:00:00.000Z' };
const PAGE = {
    id: 'tip', type: 'knowledge', category: 'local-services', title: 'How recycling works at the tip', description: 'Sort it first.',
    authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: '2026-10-01T00:00:00.000Z', status: 'active', photos: [],
    knowledge: { sources: [], place: null, lang: null, checkedAt: '2026-10-20T00:00:00.000Z', outdatedAt: null, outdatedNote: null, helped: 0, gathered: false },
} as LearnPost;

const mine = (id: string, extra: Partial<KnowledgeDraftMine> = {}): KnowledgeDraftMine => ({
    id, kind: 'new', title: `Suggestion ${id}`, topic: 'good-to-know', state: 'waiting', createdAt: '2026-11-03T00:00:00.000Z', answeredAt: null,
    postId: null, reason: null, reasonWords: null, ...extra,
});
const waitingRow = (id: string, extra: Partial<KnowledgeDraftToCheck> = {}): KnowledgeDraftToCheck => ({
    id, kind: 'new', title: `To check ${id}`, topic: 'emergencies', from: { pubkey: 'ada-pk', name: 'Ada' }, assistant: null, createdAt: '2026-11-14T00:00:00.000Z', ...extra,
});
const whole = (id: string, extra: Partial<KnowledgeDraftWhole> = {}): KnowledgeDraftWhole => ({
    ...waitingRow(id), body: 'Call the council roads line first.', place: 'The low bridge', sources: [{ url: 'https://council.example/roads', label: 'Council roads' }],
    lang: 'en', about: null, note: null, photos: [], needsSourcesTicked: false, ...extra,
});

const node = {
    role: null as string | null,
    posts: [PAGE] as LearnPost[],
    mine: { waiting: [] as KnowledgeDraftMine[], answered: [] as KnowledgeDraftMine[] },
    toCheck: [] as KnowledgeDraftToCheck[],
    drafts: {} as Record<string, KnowledgeDraftWhole>,
    refuse: null as null | { status: number; error: string; code: string },
};
let request: MockInstance<typeof api.request>;
const writes = () => request.mock.calls.filter((c) => c[0] === 'POST').map((c) => ({ path: String(c[1]), body: c[2] as Record<string, unknown> }));
const asked = () => request.mock.calls.map((c) => String(c[1]));

function stubNode() {
    vi.spyOn(api, 'myNodeRoleOnce').mockImplementation(async () => node.role);
    request = vi.spyOn(api, 'request').mockImplementation((async (method: string, path: string, body?: unknown) => {
        if (method === 'POST') {
            if (node.refuse) throw Object.assign(new Error(node.refuse.error), { status: node.refuse.status, code: node.refuse.code });
            if (path === '/api/knowledge/drafts') return { draft: mine('new-one', { title: String((body as { title: string }).title) }) };
            if (path === '/api/knowledge/posts') return { post: { ...PAGE, id: 'mine' } };
            if (/\/api\/knowledge\/drafts\/[^/]+\/(withdraw|no)$/.test(path)) return { ok: true };
            if (/\/api\/knowledge\/drafts\/[^/]+\/approve$/.test(path)) return { post: PAGE };
            // An owner's or admin's Edit: the page as the node now holds it, with the pictures the Edit kept (slice 3).
            const edited = path.match(/^\/api\/knowledge\/posts\/([^/]+)\/edit$/);
            if (edited) {
                const page = node.posts.find((p) => p.id === decodeURIComponent(edited[1])) ?? PAGE;
                const kept = (body as { photos?: string[] }).photos;
                return { post: { ...page, photos: kept ? kept.map((u) => u.replace(/v=1/, 'v=2')) : page.photos } };
            }
        }
        if (path === '/api/knowledge/front') return learnFrontOf(node.posts);
        if (path.startsWith('/api/knowledge/front?q=')) return learnSearchOf(node.posts, new URLSearchParams(path.split('?')[1]).get('q')!);
        if (path === '/api/knowledge/drafts/mine') return node.mine;
        if (path.startsWith('/api/knowledge/drafts?')) {
            if (node.role !== 'owner' && node.role !== 'admin') throw Object.assign(new Error('admins only'), { status: 403 });
            return { drafts: node.toCheck, total: node.toCheck.length, limit: 50, offset: 0 };
        }
        const one = path.match(/^\/api\/knowledge\/drafts\/([^/?]+)$/);
        if (one) {
            const d = node.drafts[decodeURIComponent(one[1])];
            if (!d) throw Object.assign(new Error('not waiting'), { status: 404 });
            return { draft: d };
        }
        if (path.startsWith('/api/marketplace/posts?')) return node.posts.filter((p) => path.includes(`id=${p.id}`));
        throw new Error(`unexpected ${method} ${path}`);
    }) as never);
}

const wait = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const props = { identity, target: null as LearnTarget | null, onTargetTaken: vi.fn(), onBack: vi.fn(), onOpenProfile: vi.fn(), onNavigate: vi.fn(), onNearYou: vi.fn() };
async function openLearn(extra: Partial<typeof props> = {}) {
    render(<LearnPage {...props} {...extra} />);
    await wait();
}
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

beforeEach(() => {
    vi.restoreAllMocks();
    info.current = { features: { knowledge: true } };
    Object.assign(node, { role: null, posts: [PAGE], mine: { waiting: [], answered: [] }, toCheck: [], drafts: {}, refuse: null });
    Object.values(props).forEach((v) => { if (typeof v === 'function' && 'mockClear' in v) (v as ReturnType<typeof vi.fn>).mockClear(); });
    stubNode();
});
afterEach(() => { cleanup(); });

describe('a member suggests', () => {
    it('"＋ Suggest knowledge" sits at the foot of the front and opens the form, the box first, with the design\'s words', async () => {
        await openLearn();
        const button = screen.getByTestId('learn-suggest');
        expect(button.textContent).toBe('＋ Suggest knowledge');
        // After the standing line: at the end of the list it never covers the last row.
        expect(screen.getByTestId('learn-standing').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        fireEvent.click(button);
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Suggest knowledge');
        const form = within(screen.getByTestId('learn-form'));
        expect(form.getByText('Share something worth knowing about this place: how something works, where to go, who to call. Not about private people. In your own words.')).toBeInTheDocument();
        expect(form.getByPlaceholderText('e.g. How recycling works at the tip')).toHaveAttribute('maxLength', '80');
        expect(form.getByPlaceholderText('Put the answer first. Then the details.')).toHaveAttribute('maxLength', '3000');
        expect(form.getByPlaceholderText('e.g. The tip on Manse Road')).toHaveAttribute('maxLength', '80');
        expect(within(screen.getByTestId('learn-form-topics')).getAllByRole('button')).toHaveLength(7);
        expect(form.getByText('Your own photo. Without one, a picture for the topic is shown.')).toBeInTheDocument();
        expect(screen.getByTestId('learn-form-send').textContent).toBe('Send to the admins');
        expect(form.getByText('An owner or admin checks it before anyone sees it.')).toBeInTheDocument();
    });

    it('says the first thing missing and sends nothing: a title, the words, a topic, a link that is not http(s)', async () => {
        await openLearn();
        fireEvent.click(screen.getByTestId('learn-suggest'));
        const send = () => fireEvent.click(screen.getByTestId('learn-form-send'));
        const said = () => screen.getByTestId('learn-form-refusal').textContent;
        send();
        expect(said()).toBe('Give it a title.');
        type('learn-form-title', 'Bins day');
        send();
        expect(said()).toBe('Write what people should know.');
        type('learn-form-body', 'Tuesday, kerbside by 7.');
        send();
        expect(said()).toBe('Pick a topic.');
        fireEvent.click(within(screen.getByTestId('learn-form-topics')).getByRole('button', { name: 'Local services' }));
        fireEvent.click(screen.getByTestId('learn-form-add-link'));
        fireEvent.change(screen.getByPlaceholderText('https://'), { target: { value: 'javascript:alert(1)' } });
        send();
        expect(said()).toBe('A link must start with https:// or http://');
        expect(writes()).toEqual([]);
    });

    it('sends the suggestion trimmed, empty links left out, then says "Sent" and that they will hear back here', async () => {
        await openLearn();
        fireEvent.click(screen.getByTestId('learn-suggest'));
        type('learn-form-title', '  Bins day  ');
        type('learn-form-body', 'Tuesday, kerbside by 7.');
        type('learn-form-place', 'Every street');
        fireEvent.click(within(screen.getByTestId('learn-form-topics')).getByRole('button', { name: 'Local services' }));
        fireEvent.click(screen.getByTestId('learn-form-add-link'));
        fireEvent.click(screen.getByTestId('learn-form-add-link'));
        fireEvent.change(screen.getAllByPlaceholderText('https://')[0], { target: { value: ' https://council.example/bins ' } });
        fireEvent.change(screen.getAllByPlaceholderText('What is this page? (optional)')[0], { target: { value: 'Council bins' } });
        fireEvent.click(screen.getByTestId('learn-form-send'));
        await wait();
        expect(writes()).toEqual([{ path: '/api/knowledge/drafts', body: {
            title: 'Bins day', body: 'Tuesday, kerbside by 7.', topic: 'local-services', place: 'Every street',
            sources: [{ url: 'https://council.example/bins', label: 'Council bins' }], lang: 'en', photos: [],
            // Learn's tags: the form sends the tags it holds, none here.
            freeTags: [],
        } }]);
        const sent = within(screen.getByTestId('learn-sent'));
        expect(sent.getByRole('heading').textContent).toBe('Sent');
        expect(sent.getByText("An owner or admin will check it. You'll hear back here.")).toBeInTheDocument();
        fireEvent.click(sent.getByTestId('learn-sent-open'));
        expect(screen.getByTestId('learn-suggest')).toBeInTheDocument();
    });

    it('shows the node\'s own refusal (three waiting already) under the button, and stays on the form', async () => {
        node.refuse = { status: 429, error: 'You have 3 waiting already. Wait for an answer, or take one back.', code: 'too_many_waiting' };
        await openLearn();
        fireEvent.click(screen.getByTestId('learn-suggest'));
        type('learn-form-title', 'Bins day');
        type('learn-form-body', 'Tuesday.');
        fireEvent.click(within(screen.getByTestId('learn-form-topics')).getByRole('button', { name: 'Local services' }));
        fireEvent.click(screen.getByTestId('learn-form-send'));
        await wait();
        expect(screen.getByTestId('learn-form-refusal').textContent).toBe('You have 3 waiting already. Wait for an answer, or take one back.');
        expect(screen.queryByTestId('learn-sent')).toBeNull();
    });

    it('a door to the form (the New Post panel, Home) opens it straight, and Back from it leaves Learn', async () => {
        await openLearn({ target: { kind: 'suggest' } });
        expect(screen.getByTestId('learn-form')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('learn-back'));
        expect(props.onBack).toHaveBeenCalledTimes(1);
    });

    it('the empty front asks "Know something locals should know?"; an empty search offers Suggest knowledge beside the Market', async () => {
        node.posts = [];
        await openLearn();
        expect(screen.getByTestId('learn-empty').textContent).toBe('Nothing here yet. Know something locals should know?');
        expect(screen.getByTestId('learn-suggest')).toBeInTheDocument();
        cleanup();
        await openLearn({ target: { kind: 'search', q: 'zeppelin' } });
        await wait(340);
        fireEvent.click(within(screen.getByTestId('learn-search-empty')).getByRole('button', { name: 'Suggest knowledge' }));
        expect(screen.getByTestId('learn-form')).toBeInTheDocument();
    });
});

describe('My suggestions', () => {
    it('"1 of yours is waiting for an admin ›" opens the list; "Take it back" asks once more, then takes it back', async () => {
        node.mine = { waiting: [mine('w1')], answered: [] };
        await openLearn();
        fireEvent.click(screen.getByTestId('learn-mine-line'));
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My suggestions');
        await wait();
        const row = within(screen.getByTestId('learn-mine-waiting'));
        expect(row.getByText('Suggestion w1')).toBeInTheDocument();
        expect(row.getByText('New')).toBeInTheDocument();
        expect(row.getByText(/^Waiting since /)).toBeInTheDocument();
        fireEvent.click(row.getByTestId('learn-mine-take-back'));
        expect(row.getByText("Take this back? The admins won't see it.")).toBeInTheDocument();
        expect(writes()).toEqual([]);
        fireEvent.click(row.getByTestId('learn-mine-confirm'));
        await wait();
        expect(writes()).toEqual([{ path: '/api/knowledge/drafts/w1/withdraw', body: undefined }]);
        expect(screen.queryByTestId('learn-mine-waiting')).toBeNull();
    });

    it('two waiting read "2 of yours are waiting for an admin ›"; none waiting, no line', async () => {
        node.mine = { waiting: [mine('a'), mine('b')], answered: [] };
        await openLearn();
        expect(screen.getByTestId('learn-mine-line').textContent).toBe('2 of yours are waiting for an admin ›');
        cleanup();
        node.mine = { waiting: [], answered: [mine('c', { state: 'approved', postId: 'tip' })] };
        await openLearn();
        expect(screen.queryByTestId('learn-mine-line')).toBeNull();
    });

    it('lists answers: "Added" opens its page; "Not added: {reason}" with the admin\'s words, never who answered', async () => {
        node.mine = { waiting: [], answered: [
            mine('ok', { state: 'approved', postId: 'tip', title: 'How recycling works at the tip' }),
            mine('no', { state: 'declined', reason: 'duplicate', reasonWords: 'See the bins page.' }),
        ] };
        await openLearn({ target: { kind: 'mine' } });
        await wait();
        const [added, declined] = screen.getAllByTestId('learn-mine-answered');
        expect(added.textContent).toContain('Added');
        expect(declined.textContent).toContain('Not added: We already have this');
        expect(declined.textContent).toContain('See the bins page.');
        fireEvent.click(within(added).getByRole('button', { name: 'How recycling works at the tip' }));
        await wait();
        expect(asked()).toContain('/api/marketplace/posts?type=knowledge&id=tip');
        expect(screen.getByTestId('learn-post')).toBeInTheDocument();
    });
});

describe('an owner or admin', () => {
    beforeEach(() => { node.role = 'admin'; });

    it('reads "＋ Add local knowledge", and their page publishes at once: "Published" / "It\'s in Learn."', async () => {
        await openLearn();
        await wait();
        fireEvent.click(screen.getByTestId('learn-suggest'));
        expect(screen.getByTestId('learn-form-send').textContent).toBe('Publish');
        expect(screen.getByText('It goes into Learn, and the Pulse announces it.')).toBeInTheDocument();
        type('learn-form-title', 'Bins day');
        type('learn-form-body', 'Tuesday.');
        fireEvent.click(within(screen.getByTestId('learn-form-topics')).getByRole('button', { name: 'Local services' }));
        fireEvent.click(screen.getByTestId('learn-form-send'));
        await wait();
        expect(writes().map((w) => w.path)).toEqual(['/api/knowledge/posts']);
        expect(screen.getByTestId('learn-sent').textContent).toContain('Published');
        expect(screen.getByTestId('learn-sent').textContent).toContain("It's in Learn.");
    });

    it('"2 to check ›" (amber, a ▲ beside it) opens To check: the longest waiting first, who sent it, New or Fix', async () => {
        node.toCheck = [waitingRow('d1', { createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() }), waitingRow('d2', { assistant: 'Claude', from: { pubkey: 'me-pk', name: 'Damo' } })];
        await openLearn();
        await wait();
        const line = screen.getByTestId('learn-check-line');
        expect(line.textContent).toBe('▲2 to check ›');
        expect(line.className).toContain('text-bp-ink-warning');
        fireEvent.click(line);
        await wait();
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('To check');
        expect(screen.getByText('Waiting (2)')).toBeInTheDocument();
        const rows = screen.getAllByTestId('learn-check-row');
        expect(rows[0].textContent).toContain('To check d1');
        expect(within(rows[0]).getByText('New')).toBeInTheDocument();
        expect(within(rows[0]).getByText('from Ada')).toBeInTheDocument();
        // How long it has waited, from when it was sent (never the date read as a length of time).
        expect(within(rows[0]).getByText('2 hours ago')).toBeInTheDocument();
        expect(rows[1].textContent).toContain('gathered with Claude for Damo');
    });

    it('opens one as members would see it, with "Before you approve"; Approve answers it and returns to the list', async () => {
        node.toCheck = [waitingRow('d1')];
        node.drafts = { d1: whole('d1') };
        await openLearn({ target: { kind: 'check' } });
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-row'));
        await wait();
        const one = within(screen.getByTestId('learn-check-one'));
        expect(one.getByTestId('learn-check-body').textContent).toBe('Call the council roads line first.');
        expect(one.getByText('council.example')).toBeInTheDocument();
        expect(one.getByText("It's about a place, a service or how to do something, not a private person.")).toBeInTheDocument();
        expect(one.getByText('Approving adds it to Learn and announces it in the Pulse.')).toBeInTheDocument();
        expect(one.queryByTestId('learn-check-tick')).toBeNull();
        fireEvent.click(one.getByTestId('learn-check-approve'));
        await wait();
        expect(writes()).toEqual([{ path: '/api/knowledge/drafts/d1/approve', body: {} }]);
        expect(screen.getByTestId('learn-check-said').textContent).toBe('Approved. It is in Learn.');
        expect(screen.getByTestId('learn-check-list')).toBeInTheDocument();
    });

    it('an assistant\'s draft waits for the tick "I opened the sources and they say this." and sends it', async () => {
        node.drafts = { d2: whole('d2', { assistant: 'Claude', needsSourcesTicked: true }) };
        node.toCheck = [waitingRow('d2', { assistant: 'Claude' })];
        await openLearn({ target: { kind: 'check' } });
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-row'));
        await wait();
        expect(screen.getByTestId('learn-check-gathered').textContent).toBe('GATHERED WITH THE ASSISTANT');
        expect(screen.getByTestId('learn-check-approve')).toBeDisabled();
        expect(screen.getByTestId('learn-check-edit')).toBeDisabled();
        fireEvent.click(screen.getByTestId('learn-check-tick'));
        fireEvent.click(screen.getByTestId('learn-check-approve'));
        await wait();
        expect(writes()).toEqual([{ path: '/api/knowledge/drafts/d2/approve', body: { checkedSources: true } }]);
    });

    it('"Edit first" is the form filled with the suggestion, and Approve sends the edits', async () => {
        node.drafts = { d1: whole('d1') };
        node.toCheck = [waitingRow('d1')];
        await openLearn({ target: { kind: 'check' } });
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-row'));
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-edit'));
        expect((screen.getByTestId('learn-form-title') as HTMLInputElement).value).toBe('To check d1');
        type('learn-form-title', 'When the low bridge floods');
        expect(screen.getByTestId('learn-form-send').textContent).toBe('Approve');
        fireEvent.click(screen.getByTestId('learn-form-send'));
        await wait();
        expect(writes()).toEqual([{ path: '/api/knowledge/drafts/d1/approve', body: {
            title: 'When the low bridge floods', body: 'Call the council roads line first.', topic: 'emergencies', place: 'The low bridge',
            sources: [{ url: 'https://council.example/roads', label: 'Council roads' }], lang: 'en', photos: [],
            // Learn's tags: "Edit first" sends the tags it holds (what Approve writes), none here.
            freeTags: [],
        } }]);
    });

    it('"Edit first" keeps or takes off a member\'s own photo but adds none (the node refuses it); an assistant\'s draft takes the checker\'s', async () => {
        const PHOTO = 'data:image/jpeg;base64,AAAA';
        node.drafts = { d1: whole('d1', { photos: [PHOTO] }), d2: whole('d2', { assistant: 'Claude', needsSourcesTicked: true }) };
        node.toCheck = [waitingRow('d1'), waitingRow('d2', { assistant: 'Claude' })];
        await openLearn({ target: { kind: 'check' } });
        await wait();
        fireEvent.click(screen.getAllByTestId('learn-check-row')[0]);
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-edit'));
        expect(screen.getByAltText('photo 1')).toHaveAttribute('src', PHOTO);
        expect(screen.queryByLabelText('Add photo')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }));
        expect(screen.queryByLabelText('Add photo')).toBeNull();
        fireEvent.click(screen.getByTestId('learn-form-send'));
        await wait();
        expect(writes()[0].body.photos).toEqual([]);
        // The assistant's: no photo of its own, and the checker may add theirs.
        fireEvent.click(screen.getAllByTestId('learn-check-row')[1]);
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-tick'));
        fireEvent.click(screen.getByTestId('learn-check-edit'));
        expect(screen.getByLabelText('Add photo')).toBeInTheDocument();
    });

    // Pictures (Damo's ask; Marty, 16 Nov 2026: "Yes, through the upload link only, the checker approves it"): each picture shows
    // with Remove photo before Approve; Approve sends back only the kept ones, so only those are published; Edit first keeps the choice.
    describe('the pictures a draft brings: Keep or Remove each before Approve', () => {
        const P1 = 'data:image/jpeg;base64,AAAA';
        const P2 = 'data:image/jpeg;base64,BBBB';
        const openOne = async (draft: KnowledgeDraftWhole) => {
            node.drafts = { [draft.id]: draft };
            node.toCheck = [waitingRow(draft.id, { assistant: draft.assistant })];
            await openLearn({ target: { kind: 'check' } });
            await wait();
            fireEvent.click(screen.getByTestId('learn-check-row'));
            await wait();
            if (draft.needsSourcesTicked) fireEvent.click(screen.getByTestId('learn-check-tick'));
        };
        const byAssistant = () => whole('d3', { assistant: 'Claude', needsSourcesTicked: true, photos: [P1, P2] });
        const toggles = () => screen.getAllByTestId('learn-check-photo-toggle');

        it('shows each picture with Remove photo and the rule, before Approve', async () => {
            await openOne(byAssistant());
            const photos = screen.getAllByTestId('learn-check-photo');
            expect(photos.map((p) => within(p).getByRole('img').getAttribute('src'))).toEqual([P1, P2]);
            // Slice 2 of DESIGN-learn-web-pictures-fable.md (§6.2): the line names the two kinds a checker may keep; the old "never a
            // picture from the web" is gone, since a picture from Wikimedia Commons with its credit now may be kept.
            expect(screen.getByText('Approve adds only the photos you keep. Keep one if it is the writer’s own, or if it shows who made it and its licence.')).toBeInTheDocument();
            expect(screen.queryByText(/never a picture from the web/)).toBeNull();
            expect(toggles().map((b) => b.textContent)).toEqual(['Remove photo', 'Remove photo']);
            fireEvent.click(toggles()[0]);
            expect(photos[0]).toHaveAttribute('data-kept', 'false');
            expect(toggles()[0].textContent).toBe('Keep this photo');
            // A plain action button: its words say what a tap does; no aria-pressed to contradict them (#3230 review).
            expect(toggles()[0]).not.toHaveAttribute('aria-pressed');
            expect(within(photos[0]).getByText('Left out: Approve won’t add it.')).toBeInTheDocument();
            fireEvent.click(toggles()[0]);
            expect(photos[0]).toHaveAttribute('data-kept', 'true');
        });

        const table: Array<[string, (t: HTMLElement[]) => void, string[]]> = [
            ['Approve with every picture kept', () => {}, [P1, P2]],
            ['remove one, then Approve', (t) => fireEvent.click(t[0]), [P2]],
            ['remove all, then Approve', (t) => { fireEvent.click(t[0]); fireEvent.click(t[1]); }, []],
            ['remove one and keep it again, then Approve', (t) => { fireEvent.click(t[1]); fireEvent.click(t[1]); }, [P1, P2]],
        ];
        for (const [what, doIt, sent] of table) {
            it(`${what}: sends back only the kept pictures`, async () => {
                await openOne(byAssistant());
                doIt(toggles());
                fireEvent.click(screen.getByTestId('learn-check-approve'));
                await wait();
                expect(writes()).toEqual([{ path: '/api/knowledge/drafts/d3/approve', body: { photos: sent, checkedSources: true } }]);
            });
        }

        it('Edit first keeps the choice: the form opens on the kept pictures and sends those', async () => {
            await openOne(byAssistant());
            fireEvent.click(toggles()[0]);
            fireEvent.click(screen.getByTestId('learn-check-edit'));
            expect(screen.getByAltText('photo 1')).toHaveAttribute('src', P2);
            expect(screen.queryByAltText('photo 2')).toBeNull();
            fireEvent.click(screen.getByTestId('learn-form-send'));
            await wait();
            expect(writes()[0].body.photos).toEqual([P2]);
            expect(writes()[0].body.checkedSources).toBe(true);
        });

        // Pictures from Wikimedia Commons (DESIGN-learn-web-pictures-fable.md §6.2, §9 slice 2 table G): under each, what the node
        // read; under one the assistant uploaded, whose it must be. Keep, Remove and Approve send exactly what they sent before.
        const CREDIT: KnowledgePhotoCredit = {
            url: 'https://commons.wikimedia.org/wiki/File:Sanderling_Westkapelle_02.jpg', file: 'File:Sanderling Westkapelle 02.jpg', maker: 'Stephan Sprinz',
            licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/', restrictions: [], readAt: '2026-11-21T09:00:00.000Z',
        };
        const withCommons = (restrictions: string[] = []) =>
            whole('d5', { assistant: 'Claude', needsSourcesTicked: true, photos: [P1, P2], photoCredits: [null, { ...CREDIT, restrictions }] });

        it('a Commons picture shows its credit, the day it was read and "Open its page" (its file page, a new tab); an upload says whose it must be', async () => {
            await openOne(withCommons());
            const [up, commons] = screen.getAllByTestId('learn-check-photo');
            expect(within(up).getByTestId('learn-check-uploaded')).toHaveTextContent('Uploaded by the assistant. Keep it only if it is your own.');
            expect(within(up).queryByTestId('learn-check-credit')).toBeNull();
            const credit = within(commons).getByTestId('learn-check-credit');
            expect(credit).toHaveTextContent('📷 Stephan Sprinz · CC BY 4.0');
            expect(credit).toHaveTextContent(/From Wikimedia Commons\. Read by this server on .*2026\./);
            const link = within(credit).getByTestId('learn-check-credit-page');
            expect(link).toHaveTextContent('Open its page');
            expect(link).toHaveAttribute('href', CREDIT.url);
            expect(link).toHaveAttribute('target', '_blank');
            expect(link).toHaveAttribute('rel', 'noopener noreferrer');
            expect(within(commons).queryByTestId('learn-check-uploaded')).toBeNull();
            expect(within(commons).queryByTestId('learn-check-credit-note')).toBeNull();
        });

        it("Commons' note shows only when Commons has one", async () => {
            await openOne(withCommons(['personality', 'trademarked', 'insignia']));
            const notes = screen.getAllByTestId('learn-check-credit-note').map((n) => n.textContent);
            expect(notes).toEqual(['Wikimedia Commons notes: shows a person.', 'Wikimedia Commons notes: shows a trademark.', 'Wikimedia Commons notes: other rights may apply.']);
        });

        it("a member's own photo carries neither line", async () => {
            await openOne(whole('d6', { photos: [P1], photoCredits: [null] }));
            expect(screen.queryByTestId('learn-check-uploaded')).toBeNull();
            expect(screen.queryByTestId('learn-check-credit')).toBeNull();
        });

        for (const [what, doIt, sent] of [
            ['Approve with both kept', () => {}, [P1, P2]],
            ['the Commons one removed', (t: HTMLElement[]) => fireEvent.click(t[1]), [P1]],
        ] as Array<[string, (t: HTMLElement[]) => void, string[]]>) {
            it(`with a Commons picture, ${what}: sends what it sent before, never a credit`, async () => {
                await openOne(withCommons());
                doIt(toggles());
                fireEvent.click(screen.getByTestId('learn-check-approve'));
                await wait();
                expect(writes()).toEqual([{ path: '/api/knowledge/drafts/d5/approve', body: { photos: sent, checkedSources: true } }]);
            });
        }

        it("a member's suggestion: the same Keep or Remove, and Approve sends the kept ones", async () => {
            await openOne(whole('d4', { photos: [P1] }));
            fireEvent.click(toggles()[0]);
            fireEvent.click(screen.getByTestId('learn-check-approve'));
            await wait();
            expect(writes()).toEqual([{ path: '/api/knowledge/drafts/d4/approve', body: { photos: [] } }]);
        });
    });

    // A page's credit rows (DESIGN-learn-web-pictures-fable.md §6.3): the node wrote them; the page shows them after its own sources,
    // each a link; Edit and Suggest a fix list and send the page's own sources only.
    describe("a page's credit rows for its pictures from Wikimedia Commons", () => {
        const OWN = { url: 'https://council.example/tip', label: 'Council: the tip' };
        const CREDITED = { url: 'https://commons.wikimedia.org/wiki/File:Sanderling_Westkapelle_02.jpg', label: '📷 1 · Stephan Sprinz · CC BY 4.0', photo: 1 };
        const credited = () => ({ ...PAGE, knowledge: { ...PAGE.knowledge, sources: [OWN, CREDITED] } }) as LearnPost;

        it('the page shows the 📷 row after its own sources, a link to the file page', async () => {
            node.posts = [credited()];
            await openLearn({ target: { kind: 'page', id: 'tip' } });
            await wait();
            const links = within(screen.getByTestId('learn-post-sources')).getAllByRole('link');
            expect(links.map((a) => a.textContent?.replace('↗', '').trim())).toEqual([`${OWN.label}council.example`, `${CREDITED.label}commons.wikimedia.org`]);
            expect(links[1]).toHaveAttribute('href', CREDITED.url);
        });

        for (const use of ['edit', 'fix'] as const) {
            it(`${use === 'edit' ? 'Edit' : 'Suggest a fix'} lists the page's own sources only and sends only those`, async () => {
                node.posts = [credited()];
                node.role = use === 'edit' ? 'owner' : null;
                await openLearn({ target: { kind: 'page', id: 'tip' } });
                await wait();
                fireEvent.click(screen.getByTestId(use === 'edit' ? 'learn-post-edit' : 'learn-post-fix'));
                await wait();
                expect(screen.getAllByTestId('learn-form-source')).toHaveLength(1);
                if (use === 'fix') {
                    fireEvent.change(screen.getByTestId('learn-form-note'), { target: { value: 'New hours' } });
                    fireEvent.change(screen.getByTestId('learn-form-body'), { target: { value: 'Sort it first. Open till 4.' } });
                }
                fireEvent.click(screen.getByTestId('learn-form-send'));
                await wait();
                const body = writes()[0]?.body ?? {};
                // Edit sends the whole form, its own sources only; a fix that left the sources alone sends none (the credit is no change).
                if (use === 'edit') expect(body.sources).toEqual([OWN]);
                else expect(body).not.toHaveProperty('sources');
                expect(JSON.stringify(body)).not.toContain('📷');
            });
        }
    });

    // Take one picture off a page (DESIGN-learn-web-pictures-fable.md §9 slice 3): Edit lists the page's pictures, each with Remove
    // photo; Save sends the ones kept, each as the page gave it, and only when one was taken off; leaving changes nothing.
    describe('taking a picture off a page', () => {
        const ADDR = [0, 1, 2].map((n) => `/api/marketplace/posts/tip/photos/${n}?v=1&k=key${n}`);
        const pictured = () => ({ ...PAGE, photos: [...ADDR] }) as LearnPost;
        const openEdit = async () => {
            node.posts = [pictured()];
            node.role = 'owner';
            await openLearn({ target: { kind: 'page', id: 'tip' } });
            await wait();
            fireEvent.click(screen.getByTestId('learn-post-edit'));
            await wait();
        };
        const toggles = () => screen.getAllByTestId('learn-form-photo-toggle');

        it('Edit shows each picture with Remove photo and says what removing does', async () => {
            await openEdit();
            const shown = screen.getAllByTestId('learn-form-page-photo');
            expect(shown).toHaveLength(3);
            expect(shown.map((f) => f.querySelector('img')?.getAttribute('src'))).toEqual(ADDR);
            expect(toggles().map((b) => b.textContent)).toEqual(['Remove photo', 'Remove photo', 'Remove photo']);
            // A screen reader hears which picture each button is for (review of #3353, N6).
            expect(toggles().map((b) => b.getAttribute('aria-label'))).toEqual(['Remove photo 1', 'Remove photo 2', 'Remove photo 3']);
            fireEvent.click(toggles()[1]);
            expect(toggles()[1].getAttribute('aria-label')).toBe('Keep photo 2');
            fireEvent.click(toggles()[1]);
            expect(screen.getByTestId('learn-form-page-photos').textContent).toContain('A photo you remove is taken off this page for everyone when you save.');
            expect(screen.queryByLabelText('Add photo')).toBeNull();
        });

        it('Remove the second, Save: sends the other two, each as the page gave it, and the page shows them', async () => {
            await openEdit();
            fireEvent.click(toggles()[1]);
            expect(screen.getAllByTestId('learn-form-page-photo').map((f) => f.getAttribute('data-kept'))).toEqual(['true', 'false', 'true']);
            expect(toggles()[1].textContent).toBe('Keep this photo');
            fireEvent.click(screen.getByTestId('learn-form-send'));
            await wait();
            expect(writes()).toHaveLength(1);
            expect(writes()[0].path).toBe('/api/knowledge/posts/tip/edit');
            expect(writes()[0].body.photos).toEqual([ADDR[0], ADDR[2]]);
            expect(screen.queryByTestId('learn-form')).toBeNull();
            expect(screen.getByTestId('learn-post-photos').querySelectorAll('img')).toHaveLength(2);
        });

        it('Keep this photo puts it back; an Edit that takes nothing off sends no picture list', async () => {
            await openEdit();
            fireEvent.click(toggles()[0]);
            fireEvent.click(toggles()[0]);
            fireEvent.change(screen.getByTestId('learn-form-title'), { target: { value: 'How recycling works now' } });
            fireEvent.click(screen.getByTestId('learn-form-send'));
            await wait();
            expect(writes()).toHaveLength(1);
            expect(writes()[0].body).not.toHaveProperty('photos');
            expect(writes()[0].body.title).toBe('How recycling works now');
        });

        it('every picture removed: sends an empty list', async () => {
            await openEdit();
            for (const b of toggles()) fireEvent.click(b);
            fireEvent.click(screen.getByTestId('learn-form-send'));
            await wait();
            expect(writes()[0].body.photos).toEqual([]);
        });

        it('leaving without saving changes nothing', async () => {
            await openEdit();
            fireEvent.click(toggles()[2]);
            fireEvent.click(screen.getAllByRole('button', { name: /back/i })[0]);
            await wait();
            expect(writes()).toHaveLength(0);
            expect(screen.getByTestId('learn-post-photos').querySelectorAll('img')).toHaveLength(3);
        });

        it('"This page\'s photos changed. Open it again.": shown under Save, and the page behind the form is read again', async () => {
            await openEdit();
            const readsBefore = asked().filter((p) => p.startsWith('/api/marketplace/posts?')).length;
            node.refuse = { status: 409, error: 'This page’s photos changed. Open it again.', code: 'photos_changed' };
            node.posts = [{ ...pictured(), photos: [ADDR[0].replace('v=1', 'v=5'), ADDR[2].replace('v=1', 'v=5').replace('/2?', '/1?')] }];
            fireEvent.click(toggles()[1]);
            fireEvent.click(screen.getByTestId('learn-form-send'));
            await wait();
            expect(screen.getByTestId('learn-form-refusal').textContent).toBe('This page’s photos changed. Open it again.');
            expect(asked().filter((p) => p.startsWith('/api/marketplace/posts?')).length).toBe(readsBefore + 1);
            node.refuse = null;
            fireEvent.click(screen.getAllByRole('button', { name: /back/i })[0]);
            await wait();
            fireEvent.click(screen.getByTestId('learn-post-edit'));
            await wait();
            expect(screen.getAllByTestId('learn-form-page-photo').map((f) => f.querySelector('img')?.getAttribute('src'))).toEqual(node.posts[0].photos);
        });

        it('Save again after "photos changed", the form still open: the list is the one the form opened on, never one built from the re-read page (review of #3353, N1)', async () => {
            await openEdit();
            node.refuse = { status: 409, error: 'This page’s photos changed. Open it again.', code: 'photos_changed' };
            // Another admin took picture 1 off meanwhile: the node now holds the old pictures 2 and 3, at places 0 and 1, new versions.
            node.posts = [{ ...pictured(), photos: [ADDR[1].replace('v=1', 'v=5').replace('/1?', '/0?'), ADDR[2].replace('v=1', 'v=5').replace('/2?', '/1?')] }];
            fireEvent.click(toggles()[1]);
            fireEvent.click(screen.getByTestId('learn-form-send'));
            await wait();
            // The form still shows the pictures it opened on, the same one marked off.
            expect(screen.getAllByTestId('learn-form-page-photo').map((f) => `${f.getAttribute('data-kept')}:${f.querySelector('img')?.getAttribute('src')}`))
                .toEqual([`true:${ADDR[0]}`, `false:${ADDR[1]}`, `true:${ADDR[2]}`]);
            fireEvent.click(screen.getByTestId('learn-form-send'));
            await wait();
            expect(writes().map((w) => w.body.photos)).toEqual([[ADDR[0], ADDR[2]], [ADDR[0], ADDR[2]]]);
        });

        it('a page with no picture shows no list; Suggest a fix shows none either', async () => {
            node.role = 'owner';
            await openLearn({ target: { kind: 'page', id: 'tip' } });
            await wait();
            fireEvent.click(screen.getByTestId('learn-post-edit'));
            await wait();
            expect(screen.queryByTestId('learn-form-page-photos')).toBeNull();
            cleanup();
            node.posts = [pictured()];
            node.role = null;
            await openLearn({ target: { kind: 'page', id: 'tip' } });
            await wait();
            fireEvent.click(screen.getByTestId('learn-post-fix'));
            await wait();
            expect(screen.queryByTestId('learn-form-page-photos')).toBeNull();
        });
    });

    it('"Not this one" needs a reason from the list; the few words go with it, and the writer is told', async () => {
        node.drafts = { d1: whole('d1') };
        node.toCheck = [waitingRow('d1')];
        await openLearn({ target: { kind: 'check' } });
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-row'));
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-not'));
        const no = within(screen.getByTestId('learn-check-no'));
        expect(no.getAllByRole('radio').map((r) => (r.parentElement as HTMLElement).textContent)).toEqual([
            "It's about a person", 'It looks copied', "I couldn't check it", 'We already have this', "It isn't about this area", 'Another reason',
        ]);
        expect(no.getByTestId('learn-check-no-send')).toBeDisabled();
        fireEvent.click(no.getByRole('radio', { name: 'We already have this' }));
        fireEvent.change(no.getByTestId('learn-check-no-words'), { target: { value: ' See the bins page. ' } });
        fireEvent.click(no.getByTestId('learn-check-no-send'));
        await wait();
        expect(writes()).toEqual([{ path: '/api/knowledge/drafts/d1/no', body: { reason: 'duplicate', words: 'See the bins page.' } }]);
        expect(screen.getByTestId('learn-check-said').textContent).toBe('Answered. The writer is told.');
    });

    it('one another admin answered first says so', async () => {
        node.toCheck = [waitingRow('gone')];
        await openLearn({ target: { kind: 'check' } });
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-row'));
        await wait();
        expect(screen.getByTestId('learn-check-gone').textContent).toBe('This one was already answered.');
    });

    // Every door into To check (the bell's line, a push, Home's Needs line and the Learn card's row all reach it as App's
    // `{ kind: 'check' }`: NeedsYouIcons.learn, HomePage.learn) starts it afresh, as Learn's own "2 to check ›" does.
    describe('a door into To check starts it afresh', () => {
        beforeEach(() => {
            node.toCheck = [waitingRow('d1'), waitingRow('d2')];
            node.drafts = { d1: whole('d1'), d2: whole('d2') };
        });
        const door = (rerender: (ui: React.ReactElement) => void) => rerender(<LearnPage {...props} target={{ kind: 'check' }} />);

        it('after an answer and Back to the front: no "Approved. It is in Learn." from before', async () => {
            const { rerender } = render(<LearnPage {...props} />);
            await wait();
            await wait();
            fireEvent.click(screen.getByTestId('learn-check-line'));
            await wait();
            fireEvent.click(screen.getAllByTestId('learn-check-row')[0]);
            await wait();
            fireEvent.click(screen.getByTestId('learn-check-approve'));
            await wait();
            expect(screen.getByTestId('learn-check-said').textContent).toBe('Approved. It is in Learn.');
            fireEvent.click(screen.getByTestId('learn-back'));
            await wait();
            expect(screen.getByTestId('learn-check-line')).toBeInTheDocument();
            door(rerender);
            await wait();
            expect(props.onTargetTaken).toHaveBeenCalled();
            expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('To check');
            expect(screen.getByTestId('learn-check-list')).toBeInTheDocument();
            expect(screen.queryByTestId('learn-check-said')).toBeNull();
        });

        it('while an answer is still said on To check itself: the door clears it', async () => {
            const { rerender } = render(<LearnPage {...props} target={{ kind: 'check' }} />);
            await wait();
            fireEvent.click(screen.getAllByTestId('learn-check-row')[0]);
            await wait();
            fireEvent.click(screen.getByTestId('learn-check-approve'));
            await wait();
            expect(screen.getByTestId('learn-check-said')).toBeInTheDocument();
            door(rerender);
            await wait();
            expect(screen.queryByTestId('learn-check-said')).toBeNull();
            expect(screen.getByTestId('learn-check-list')).toBeInTheDocument();
        });

        it('with a suggestion open: the door shows the list, not that suggestion', async () => {
            const { rerender } = render(<LearnPage {...props} target={{ kind: 'check' }} />);
            await wait();
            fireEvent.click(screen.getAllByTestId('learn-check-row')[1]);
            await wait();
            expect(screen.getByTestId('learn-check-one')).toBeInTheDocument();
            door(rerender);
            await wait();
            expect(screen.queryByTestId('learn-check-one')).toBeNull();
            expect(screen.getByTestId('learn-check-list')).toBeInTheDocument();
        });

        it('during "Edit first": the door shows the list, and the next one opened is read first, not the form', async () => {
            const { rerender } = render(<LearnPage {...props} target={{ kind: 'check' }} />);
            await wait();
            fireEvent.click(screen.getAllByTestId('learn-check-row')[0]);
            await wait();
            fireEvent.click(screen.getByTestId('learn-check-edit'));
            expect(screen.getByTestId('learn-form')).toBeInTheDocument();
            door(rerender);
            await wait();
            expect(screen.queryByTestId('learn-form')).toBeNull();
            fireEvent.click(screen.getAllByTestId('learn-check-row')[1]);
            await wait();
            expect(screen.getByTestId('learn-check-one')).toBeInTheDocument();
            expect(screen.queryByTestId('learn-form')).toBeNull();
            expect(writes()).toEqual([]);
        });
    });

    describe('Back during "Edit first"', () => {
        const ASK = "Leave without approving? Your changes won't be kept.";
        beforeEach(() => {
            node.toCheck = [waitingRow('d1')];
            node.drafts = { d1: whole('d1') };
        });
        async function editFirst() {
            await openLearn({ target: { kind: 'check' } });
            await wait();
            fireEvent.click(screen.getByTestId('learn-check-row'));
            await wait();
            fireEvent.click(screen.getByTestId('learn-check-edit'));
            expect(screen.getByTestId('learn-form')).toBeInTheDocument();
        }

        it('asks before the changes go; "Cancel" keeps the form as typed', async () => {
            await editFirst();
            type('learn-form-title', 'When the low bridge floods');
            const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
            fireEvent.click(screen.getByTestId('learn-back'));
            expect(ask).toHaveBeenCalledWith(ASK);
            expect((screen.getByTestId('learn-form-title') as HTMLInputElement).value).toBe('When the low bridge floods');
            expect(screen.queryByTestId('learn-check-list')).toBeNull();
        });

        it('"OK" returns to the same suggestion (not the list), its words as sent, and nothing is sent', async () => {
            await editFirst();
            type('learn-form-title', 'When the low bridge floods');
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            fireEvent.click(screen.getByTestId('learn-back'));
            const one = screen.getByTestId('learn-check-one');
            expect(within(one).getByRole('heading', { level: 2 }).textContent).toBe('To check d1');
            expect(screen.queryByTestId('learn-check-list')).toBeNull();
            expect(writes()).toEqual([]);
            // Edit first again starts from the suggestion, not from what was left.
            fireEvent.click(screen.getByTestId('learn-check-edit'));
            expect((screen.getByTestId('learn-form-title') as HTMLInputElement).value).toBe('To check d1');
        });

        it('nothing changed: Back asks nothing and returns to the suggestion; Back again, the list', async () => {
            await editFirst();
            const ask = vi.spyOn(window, 'confirm');
            fireEvent.click(screen.getByTestId('learn-back'));
            expect(ask).not.toHaveBeenCalled();
            expect(screen.getByTestId('learn-check-one')).toBeInTheDocument();
            fireEvent.click(screen.getByTestId('learn-back'));
            await wait();
            expect(screen.getByTestId('learn-check-list')).toBeInTheDocument();
        });

        it('a change typed back to how it was asks nothing', async () => {
            await editFirst();
            type('learn-form-title', 'Something else');
            type('learn-form-title', 'To check d1');
            const ask = vi.spyOn(window, 'confirm');
            fireEvent.click(screen.getByTestId('learn-back'));
            expect(ask).not.toHaveBeenCalled();
            expect(screen.getByTestId('learn-check-one')).toBeInTheDocument();
        });
    });

    it('"Edit first" keeps the suggestion\'s language, never the checker\'s: one sent with none stays with none', async () => {
        node.toCheck = [waitingRow('d1'), waitingRow('d2')];
        node.drafts = { d1: whole('d1', { lang: null, assistant: 'Claude', needsSourcesTicked: true }), d2: whole('d2', { lang: 'pt' }) };
        await openLearn({ target: { kind: 'check' } });
        await wait();
        fireEvent.click(screen.getAllByTestId('learn-check-row')[0]);
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-tick'));
        fireEvent.click(screen.getByTestId('learn-check-edit'));
        fireEvent.click(screen.getByTestId('learn-form-send'));
        await wait();
        expect(writes()[0].path).toBe('/api/knowledge/drafts/d1/approve');
        // No `lang` at all: the node keeps the suggestion's own (none), and the page never says it was written in English.
        expect('lang' in writes()[0].body).toBe(false);
        expect(writes()[0].body.checkedSources).toBe(true);
        fireEvent.click(screen.getAllByTestId('learn-check-row')[1]);
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-edit'));
        fireEvent.click(screen.getByTestId('learn-form-send'));
        await wait();
        expect(writes()[1].body.lang).toBe('pt');
    });

    it('"Not this one" on an assistant\'s draft never says the writer is told (no notice goes out), named or not', async () => {
        node.toCheck = [waitingRow('d2', { assistant: 'Claude' }), waitingRow('d3', { assistant: '' })];
        node.drafts = { d2: whole('d2', { assistant: 'Claude', needsSourcesTicked: true }), d3: whole('d3', { assistant: '', needsSourcesTicked: true }) };
        await openLearn({ target: { kind: 'check' } });
        await wait();
        for (const [i, id] of [[0, 'd2'], [1, 'd3']] as const) {
            fireEvent.click(screen.getAllByTestId('learn-check-row')[i]);
            await wait();
            // An assistant's draft with no name is still an assistant's: the chip shows.
            expect(screen.getByTestId('learn-check-gathered')).toBeInTheDocument();
            fireEvent.click(screen.getByTestId('learn-check-not'));
            fireEvent.click(screen.getByRole('radio', { name: "I couldn't check it" }));
            fireEvent.click(screen.getByTestId('learn-check-no-send'));
            await wait();
            expect(writes().at(-1)?.path).toBe(`/api/knowledge/drafts/${id}/no`);
            expect(screen.getByTestId('learn-check-said').textContent).toBe("Answered. It won't be added to Learn.");
        }
    });

    it('"Edit first" on an assistant\'s draft with no name still lets the checker add their own photo', async () => {
        node.toCheck = [waitingRow('d3', { assistant: '' })];
        node.drafts = { d3: whole('d3', { assistant: '', needsSourcesTicked: true }) };
        await openLearn({ target: { kind: 'check' } });
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-row'));
        await wait();
        fireEvent.click(screen.getByTestId('learn-check-tick'));
        fireEvent.click(screen.getByTestId('learn-check-edit'));
        expect(screen.getByLabelText('Add photo')).toBeInTheDocument();
    });
});

describe('where nothing is written', () => {
    it('a member never sees To check or its line, and the node is never asked for the list', async () => {
        await openLearn();
        await wait();
        expect(screen.queryByTestId('learn-check-line')).toBeNull();
        expect(asked().some((p) => p.startsWith('/api/knowledge/drafts?'))).toBe(false);
    });

    it('the preview (Example Valley) has no Suggest button and asks the node for nothing', async () => {
        info.current = { features: { knowledge: false, showcase: true } };
        await openLearn();
        expect(screen.queryByTestId('learn-suggest')).toBeNull();
        expect(request).not.toHaveBeenCalled();
    });

    it('a visitor with no key has no Suggest button', async () => {
        await openLearn({ identity: null as unknown as BeanPoolIdentity });
        expect(screen.queryByTestId('learn-suggest')).toBeNull();
    });
});
