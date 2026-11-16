/**
 * Learn's tags on the web (16 Nov 2026; the node is #3219). The real Learn screens with the node stubbed at lib/api. One table
 * over each place tags are written (a suggestion, a fix, an owner's edit, Approve on To check, "Edit first") and each state of
 * the tags (none, some, taken off, only the tags changed): what the form shows, what it sends, and what To check shows. The
 * Tags field is the Market's own picker, free tags alone: a library label typed stays the member's word, and no library id is
 * ever sent. A page shows its tags, and a tap searches Learn for one.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as api from '../lib/api';
import type { KnowledgeDraftWhole } from '@beanpool/core';
import type { LearnPost } from '../lib/learn';
import type { BeanPoolIdentity } from '../lib/identity';
import { LearnPage, type LearnTarget } from './LearnPage';

const info = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../lib/features', async (orig) => ({
    ...(await orig<typeof import('../lib/features')>()),
    useCommunityInfo: () => info.current,
    useReaderFeatures: () => null,
}));
vi.mock('../components/StartCommunityScreen', () => ({ StartCommunityScreen: () => <div data-testid="start-community" /> }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));

const identity: BeanPoolIdentity = { publicKey: 'me-pk', privateKey: 'k', callsign: 'Damo', createdAt: '2026-09-17T00:00:00.000Z' };
const page = (freeTags?: string[]): LearnPost => ({
    id: 'tip', type: 'knowledge', category: 'local-services', title: 'How recycling works at the tip', description: 'Sort it first.',
    authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: '2026-10-01T00:00:00.000Z', status: 'active', photos: [],
    ...(freeTags ? { freeTags } : {}),
    knowledge: {
        sources: [{ url: 'https://council.example/tip', label: 'Council tip page' }], place: 'Manse Road', lang: null,
        checkedAt: '2026-10-20T00:00:00.000Z', outdatedAt: null, outdatedNote: null, helped: 2, gathered: false,
    },
}) as LearnPost;
const draft = (extra: Partial<KnowledgeDraftWhole> = {}): KnowledgeDraftWhole => ({
    id: 'd1', kind: 'new', title: 'Bulk waste days', topic: 'local-services', from: { pubkey: 'ada-pk', name: 'Ada' }, assistant: null,
    createdAt: '2026-11-15T00:00:00.000Z', body: 'Twice a year.', place: null, sources: [], lang: 'en', about: null, note: null, photos: [],
    needsSourcesTicked: false, post: null, changed: null, pageChanged: null, ...extra,
});

const node = { role: null as string | null, post: page(), draft: draft() };
let request: MockInstance<typeof api.request>;
const writes = () => request.mock.calls.filter((c) => c[0] === 'POST').map((c) => ({ path: String(c[1]), body: (c[2] ?? {}) as Record<string, unknown> }));
const reads = () => request.mock.calls.filter((c) => c[0] === 'GET').map((c) => String(c[1]));

function stubNode() {
    vi.spyOn(api, 'myNodeRoleOnce').mockImplementation(async () => node.role);
    request = vi.spyOn(api, 'request').mockImplementation((async (method: string, path: string) => {
        if (method === 'POST') {
            if (path === `/api/knowledge/posts/${node.post.id}/edit`) return { post: node.post };
            if (path === '/api/knowledge/drafts') return { draft: { id: 'x', kind: 'new' } };
            if (path === '/api/knowledge/posts') return { post: node.post };
            if (path === `/api/knowledge/drafts/${node.draft.id}/approve`) return { post: node.post };
        }
        if (path.startsWith('/api/marketplace/posts?')) return [node.post];
        if (path === '/api/knowledge/front' || path.startsWith('/api/knowledge/front?')) return { total: 0, pinned: [], topics: [], rows: [] };
        if (path === '/api/knowledge/drafts/mine') return { waiting: [], answered: [] };
        if (path.startsWith('/api/knowledge/drafts?')) {
            const d = node.draft;
            return { drafts: [{ id: d.id, kind: d.kind, title: d.title, topic: d.topic, from: d.from, assistant: d.assistant, createdAt: d.createdAt }], total: 1, limit: 50, offset: 0, unchecked: { total: 0, rows: [] } };
        }
        if (path === `/api/knowledge/drafts/${node.draft.id}`) return { draft: node.draft };
        throw new Error(`unexpected ${method} ${path}`);
    }) as never);
}

const wait = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function open(target: LearnTarget) {
    render(<LearnPage identity={identity} target={target} onTargetTaken={vi.fn()} onBack={vi.fn()} onOpenProfile={vi.fn()} onNavigate={vi.fn()} onNearYou={vi.fn()} />);
    await wait();
}
const click = async (id: string) => { fireEvent.click(screen.getByTestId(id)); await wait(); };
const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });
/** The chips the form's Tags field holds, as drawn. */
const formTags = () => Array.from(screen.getByTestId('learn-form-tags').querySelectorAll('button[aria-label^="Remove #"]')).map((b) => b.textContent?.replace('✕', '').trim());
/** The Market's picker: "+ Add", type the tag, Enter, Done. */
async function addTag(text: string) {
    fireEvent.click(within(screen.getByTestId('learn-form-tags')).getByRole('button', { name: '+ Add tag' }));
    const field = screen.getByPlaceholderText('Type a tag');
    fireEvent.change(field, { target: { value: text } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await wait();
}
const takeOff = async (tag: string) => { fireEvent.click(within(screen.getByTestId('learn-form-tags')).getByRole('button', { name: `Remove #${tag}` })); await wait(); };

beforeEach(() => {
    vi.restoreAllMocks();
    info.current = { features: { knowledge: true } };
    Object.assign(node, { role: null, post: page(), draft: draft() });
    stubNode();
});
afterEach(() => cleanup());

type Use = 'suggest' | 'fix' | 'edit' | 'approve' | 'edit first';
type Tags = 'none' | 'tags' | 'taken off' | 'only tags';

/** What each cell starts from (the page's or the suggestion's tags), what the member does, and what must be sent and shown. */
interface Cell { start?: string[]; draftExtra?: Partial<KnowledgeDraftWhole>; act: () => Promise<void>; opens: string[]; sent: Record<string, unknown>; absent?: string[]; shows?: () => void }
const CELLS: Record<Use, Record<Tags, Cell>> = {
    suggest: {
        none: { act: async () => {}, opens: [], sent: { freeTags: [] } },
        tags: { act: async () => { await addTag('#Bulk  Waste'); await addTag('Tip'); }, opens: [], sent: { freeTags: ['bulk waste', 'tip'] } },
        'taken off': { act: async () => { await addTag('bulk waste'); await addTag('tip'); await takeOff('bulk waste'); }, opens: [], sent: { freeTags: ['tip'] } },
        // A new page has no tags to change: a library label typed is the member's own word, and no library id goes.
        'only tags': { act: async () => { await addTag('Lemon'); }, opens: [], sent: { freeTags: ['lemon'] }, absent: ['tags'] },
    },
    fix: {
        none: { act: async () => { type('learn-form-body', 'Sort it first. Closed Mondays.'); }, opens: [], sent: { body: 'Sort it first. Closed Mondays.' }, absent: ['freeTags'] },
        tags: { act: async () => { await addTag('ferry'); }, opens: [], sent: { freeTags: ['ferry'] }, absent: ['title', 'body', 'topic', 'place', 'sources'] },
        'taken off': { start: ['tip', 'bulk waste'], act: async () => { await takeOff('tip'); await takeOff('bulk waste'); }, opens: ['#tip', '#bulk waste'], sent: { freeTags: [] }, absent: ['title', 'body'] },
        'only tags': { start: ['tip'], act: async () => { await takeOff('tip'); await addTag('tip shop'); }, opens: ['#tip'], sent: { freeTags: ['tip shop'] }, absent: ['title', 'body', 'topic', 'place', 'sources'] },
    },
    edit: {
        none: { act: async () => { type('learn-form-title', 'Recycling at the tip'); }, opens: [], sent: { title: 'Recycling at the tip', freeTags: [] } },
        tags: { act: async () => { await addTag('ferry'); }, opens: [], sent: { freeTags: ['ferry'] } },
        'taken off': { start: ['tip'], act: async () => { await takeOff('tip'); }, opens: ['#tip'], sent: { freeTags: [] } },
        'only tags': { start: ['tip'], act: async () => { await addTag('ferry'); }, opens: ['#tip'], sent: { title: 'How recycling works at the tip', freeTags: ['tip', 'ferry'] } },
    },
    // Approve as it is: the node writes the suggestion's own tags, so none are sent; To check shows them first.
    approve: {
        none: { act: async () => {}, opens: [], sent: {}, absent: ['freeTags'], shows: () => expect(screen.queryByTestId('learn-check-tags')).toBeNull() },
        tags: {
            draftExtra: { freeTags: ['tip', 'bulk waste'] }, act: async () => {}, opens: [], sent: {}, absent: ['freeTags'],
            shows: () => expect(screen.getByTestId('learn-check-tags').textContent).toContain('#tip #bulk waste'),
        },
        'taken off': {
            draftExtra: { kind: 'fix', note: 'No tags', freeTags: [], post: { id: 'tip', title: 'T', body: 'B', topic: 'local-services', place: null, sources: [], lang: null, freeTags: ['tip'] }, changed: [], pageChanged: [], freeTagsChanged: true, freeTagsPageChanged: false },
            act: async () => {}, opens: [], sent: {}, absent: ['freeTags'],
            shows: () => {
                const part = screen.getByTestId('learn-check-part-tags');
                expect(part.textContent).toContain('#tip');
                expect(part.textContent).toContain('None');
                expect(screen.queryByTestId('learn-check-note-alone')).toBeNull();
            },
        },
        'only tags': {
            draftExtra: { kind: 'fix', note: 'Better tags', freeTags: ['tip shop'], post: { id: 'tip', title: 'T', body: 'B', topic: 'local-services', place: null, sources: [], lang: null, freeTags: ['tip'] }, changed: [], pageChanged: [], freeTagsChanged: true, freeTagsPageChanged: true },
            act: async () => {}, opens: [], sent: {}, absent: ['freeTags'],
            shows: () => {
                const part = screen.getByTestId('learn-check-part-tags');
                expect(part.textContent).toContain('#tip');
                expect(part.textContent).toContain('#tip shop');
                expect(within(part).getByTestId('learn-check-moved')).toBeTruthy();
                expect(screen.queryByTestId('learn-check-note-alone')).toBeNull();
            },
        },
    },
    // "Edit first": the form opens on the suggestion's tags (for a fix, the page's with the member's put in) and sends them.
    'edit first': {
        none: { act: async () => {}, opens: [], sent: { freeTags: [] } },
        tags: { draftExtra: { freeTags: ['tip'] }, act: async () => {}, opens: ['#tip'], sent: { freeTags: ['tip'] } },
        'taken off': { draftExtra: { freeTags: ['tip'] }, act: async () => { await takeOff('tip'); }, opens: ['#tip'], sent: { freeTags: [] } },
        'only tags': {
            draftExtra: { kind: 'fix', note: 'Better tags', freeTags: ['tip shop'], post: { id: 'tip', title: 'Bulk waste days', body: 'Twice a year.', topic: 'local-services', place: null, sources: [], lang: 'en', freeTags: ['ferry'] }, changed: [], pageChanged: [], freeTagsChanged: true, freeTagsPageChanged: true },
            act: async () => { await addTag('ferry'); }, opens: ['#tip shop'], sent: { freeTags: ['tip shop', 'ferry'] },
        },
    },
};

const ROWS = (Object.keys(CELLS) as Use[]).flatMap((use) => (Object.keys(CELLS[use]) as Tags[]).map((tags) => [use, tags] as const));

describe('the table: (suggest, fix, owner edit, Approve, Edit first) x (no tags, tags, taken off, only the tags changed)', () => {
    it.each(ROWS)('%s, %s: what the form opens on, what is sent, what shows', async (use, tags) => {
        const cell = CELLS[use][tags];
        if (use === 'fix' || use === 'edit') node.post = page(cell.start);
        if (use === 'approve' || use === 'edit first') node.draft = draft(cell.draftExtra);
        if (use === 'edit' || use === 'approve' || use === 'edit first') node.role = 'owner';

        if (use === 'suggest') {
            await open({ kind: 'suggest' });
            type('learn-form-title', 'Bulk waste days');
            type('learn-form-body', 'Twice a year.');
            fireEvent.click(within(screen.getByTestId('learn-form-topics')).getByText('Local services'));
        } else if (use === 'fix' || use === 'edit') {
            await open({ kind: 'page', id: 'tip' });
            await click(use === 'fix' ? 'learn-post-fix' : 'learn-post-edit');
            if (use === 'fix') type('learn-form-note', 'Changed');
        } else {
            await open({ kind: 'check' });
            await click('learn-check-row');
            cell.shows?.();
            if (use === 'edit first') await click('learn-check-edit');
        }

        if (use !== 'approve') expect(formTags()).toEqual(cell.opens);
        await cell.act();
        await click(use === 'approve' ? 'learn-check-approve' : 'learn-form-send');

        const sent = writes();
        expect(sent).toHaveLength(1);
        const path = { suggest: '/api/knowledge/drafts', fix: '/api/knowledge/drafts', edit: '/api/knowledge/posts/tip/edit', approve: '/api/knowledge/drafts/d1/approve', 'edit first': '/api/knowledge/drafts/d1/approve' }[use];
        expect(sent[0].path).toBe(path);
        expect(sent[0].body).toMatchObject(cell.sent);
        for (const key of cell.absent ?? []) expect(sent[0].body, key).not.toHaveProperty(key);
        // Learn's tags are free tags only: no library id is ever sent from a Learn form.
        expect(sent[0].body.tags).toBeUndefined();
    });
});

describe('a page shows its tags; a tap searches Learn for one', () => {
    it('each tag as #word, named for a screen reader as a Learn search; the tap opens Learn on that search', async () => {
        node.post = page(['bulk waste', 'tip']);
        await open({ kind: 'page', id: 'tip' });
        const chips = within(screen.getByTestId('post-detail-tags')).getAllByRole('button');
        expect(chips.map((c) => c.textContent)).toEqual(['#bulk waste', '#tip']);
        expect(chips[0].getAttribute('aria-label')).toBe('Search Learn for #bulk waste');
        fireEvent.click(chips[0]);
        await wait(400);
        expect(screen.queryByTestId('learn-post')).toBeNull();
        expect(reads()).toContain(`/api/knowledge/front?${new URLSearchParams({ q: 'bulk waste' })}`);
    });

    it('a page with no tags draws no row', async () => {
        await open({ kind: 'page', id: 'tip' });
        expect(screen.queryByTestId('post-detail-tags')).toBeNull();
    });
});
