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
import type { KnowledgeDraftMine, KnowledgeDraftToCheck, KnowledgeDraftWhole } from '@beanpool/core';
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
        } }]);
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
