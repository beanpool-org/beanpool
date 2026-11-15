/**
 * Learn on the web, keeping it right (slice K5 B; DESIGN-local-knowledge-fable.md §3.2 items 9-11, §3.5, §2.4, §2.10; the node
 * slice is #3203). The real page with the node stubbed at lib/api. One table over each action ("This helped", "Still right",
 * "Suggest a fix", "Mark as out of date") and each reader (a member, the page's writer, an owner or admin, a visitor, the preview
 * where Learn is off): what the page offers and what a tap sends. Then each refusal the node answers (a standby, the switch off,
 * its own page, an owner's fix, a fix already waiting, a connection that dropped) shows the node's own sentence, and never the
 * success it didn't give. Nothing a tap sends pays Beans: every write goes to /api/knowledge, nowhere else.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as api from '../lib/api';
import { learnFixToSend, learnPageActions, type LearnPost } from '../lib/learn';
import type { BeanPoolIdentity } from '../lib/identity';
import { sampleLearnPosts } from '../components/ShowcasePreviews';
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

const ME = 'me-pk';
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'k', callsign: 'Damo', createdAt: '2026-09-17T00:00:00.000Z' };
const page = (extra: Partial<LearnPost> = {}, k: Partial<LearnPost['knowledge']> = {}): LearnPost => ({
    id: 'tip', type: 'knowledge', category: 'local-services', title: 'How recycling works at the tip', description: 'Sort it first.',
    authorPublicKey: 'ada-pk', authorCallsign: 'Ada', createdAt: '2026-10-01T00:00:00.000Z', status: 'active', photos: [],
    knowledge: {
        sources: [{ url: 'https://council.example/tip', label: 'Council tip page' }], place: 'Manse Road', lang: null,
        checkedAt: '2026-10-20T00:00:00.000Z', outdatedAt: null, outdatedNote: null, helped: 2, gathered: false, ...k,
    },
    ...extra,
}) as LearnPost;

const node = {
    role: null as string | null,
    post: page(),
    refuse: null as null | { status?: number; error: string; code?: string },
};
let request: MockInstance<typeof api.request>;
const writes = () => request.mock.calls.filter((c) => c[0] === 'POST').map((c) => ({ path: String(c[1]), body: c[2] as Record<string, unknown> | undefined }));

function stubNode() {
    vi.spyOn(api, 'myNodeRoleOnce').mockImplementation(async () => node.role);
    request = vi.spyOn(api, 'request').mockImplementation((async (method: string, path: string, body?: any) => {
        if (method === 'POST') {
            if (node.refuse) {
                const r = node.refuse;
                throw Object.assign(new Error(r.error), r.status === undefined ? {} : { status: r.status, code: r.code });
            }
            const p = node.post;
            if (path === `/api/knowledge/posts/${p.id}/helped`) return { helped: p.knowledge.helped + (body.on ? 1 : -1), helpedByMe: body.on };
            if (path === `/api/knowledge/posts/${p.id}/checked`) return { post: page({}, { checkedAt: '2026-11-16T00:00:00.000Z', outdatedAt: null, outdatedNote: null }) };
            if (path === `/api/knowledge/posts/${p.id}/outdated`) return { post: page({}, { outdatedAt: '2026-11-16T00:00:00.000Z', outdatedNote: body.note || null }) };
            if (path === `/api/knowledge/posts/${p.id}/outdated/clear`) return { post: page({}, { outdatedAt: null, outdatedNote: null }) };
            if (path === `/api/knowledge/posts/${p.id}/edit`) return { post: page({ title: body.title }) };
            if (path === '/api/knowledge/drafts') return { draft: { id: 'fix-1', kind: 'fix', fixOf: p.id } };
        }
        if (path.startsWith('/api/marketplace/posts?')) return [node.post];
        if (path === '/api/knowledge/front') return { total: 0, pinned: [], topics: [] };
        if (path === '/api/knowledge/drafts/mine') return { waiting: [], answered: [] };
        if (path.startsWith('/api/knowledge/drafts?')) return { drafts: [], total: 0, limit: 50, offset: 0, unchecked: { total: 0, rows: [] } };
        throw new Error(`unexpected ${method} ${path}`);
    }) as never);
}

const wait = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function openPage(opts: { who?: BeanPoolIdentity | null; target?: LearnTarget } = {}) {
    render(<LearnPage identity={opts.who === undefined ? identity : opts.who} target={opts.target ?? { kind: 'page', id: node.post.id }}
        onTargetTaken={vi.fn()} onBack={vi.fn()} onOpenProfile={vi.fn()} onNavigate={vi.fn()} onNearYou={vi.fn()} />);
    await wait();
}
const has = (id: string) => screen.queryByTestId(id) !== null;
const click = async (id: string) => { fireEvent.click(screen.getByTestId(id)); await wait(); };
const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });

beforeEach(() => {
    vi.restoreAllMocks();
    info.current = { features: { knowledge: true } };
    Object.assign(node, { role: null, post: page(), refuse: null });
    stubNode();
});
afterEach(() => cleanup());

type Reader = 'member' | 'writer' | 'checker' | 'visitor' | 'preview';
async function openAs(reader: Reader) {
    if (reader === 'writer') node.post = page({ authorPublicKey: ME, authorCallsign: 'Damo' });
    if (reader === 'checker') node.role = 'owner';
    if (reader === 'preview') {
        info.current = { features: { showcase: true } };
        await openPage({ target: { kind: 'page', id: sampleLearnPosts()[0].id } });
        return;
    }
    await openPage({ who: reader === 'visitor' ? null : identity });
}

describe('the table: who is offered which action on a page (§2.4)', () => {
    // [reader, helped, fix, still right, mark out of date, edit]
    const TABLE: Array<[Reader, boolean, boolean, boolean, boolean, boolean]> = [
        ['member', true, true, false, false, false],
        ['writer', false, true, false, true, false],
        ['checker', true, false, true, true, true],
        ['visitor', false, false, false, false, false],
        ['preview', false, false, false, false, false],
    ];
    it.each(TABLE)('%s: helped %s, suggest a fix %s, still right %s, mark out of date %s, edit %s', async (reader, helped, fix, still, mark, edit) => {
        await openAs(reader);
        expect(has('learn-post')).toBe(true);
        expect(has('learn-post-helped')).toBe(helped);
        expect(has('learn-post-fix')).toBe(fix);
        expect(has('learn-post-still-right')).toBe(still);
        expect(has('learn-post-mark')).toBe(mark);
        expect(has('learn-post-edit')).toBe(edit);
        // Opening a page sends nothing: no tap, no stamp, no Beans.
        expect(writes()).toEqual([]);
    });

    it('the rule itself: an owner or admin who wrote the page edits it, and has no tap of their own', () => {
        expect(learnPageActions({ signedIn: true, preview: false, own: true, checks: true, outdated: false }))
            .toEqual({ helped: false, fix: false, edit: true, stillRight: true, markOutdated: true, clearMark: false });
        expect(learnPageActions({ signedIn: true, preview: false, own: false, checks: true, outdated: true }))
            .toMatchObject({ markOutdated: false, clearMark: true });
        expect(learnPageActions({ signedIn: true, preview: false, own: true, checks: false, outdated: true }))
            .toMatchObject({ markOutdated: false, clearMark: false });
    });

    it('the count shows from 1 beside the button, and to the writer without one; never at 0', async () => {
        await openAs('member');
        expect(screen.getByTestId('learn-post-helped-count').textContent).toBe('Helped 2');
        cleanup();
        node.post = page({ authorPublicKey: ME }, { helped: 3 });
        await openPage();
        expect(has('learn-post-helped')).toBe(false);
        expect(screen.getByTestId('learn-post-helped-count').textContent).toBe('Helped 3');
        cleanup();
        node.post = page({}, { helped: 0 });
        await openPage();
        expect(has('learn-post-helped-count')).toBe(false);
    });
});

describe('what each action sends, and what the page shows after the node answers', () => {
    it('"This helped": on, shown as done with the new count; a second tap takes it back', async () => {
        await openAs('member');
        expect(screen.getByTestId('learn-post-helped').textContent).toBe('👍 This helped');
        await click('learn-post-helped');
        expect(writes()).toEqual([{ path: '/api/knowledge/posts/tip/helped', body: { on: true } }]);
        expect(screen.getByTestId('learn-post-helped').textContent).toBe('👍 Helped ✓');
        expect(screen.getByTestId('learn-post-helped').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('learn-post-helped-count').textContent).toBe('Helped 3');
        await click('learn-post-helped');
        expect(writes()[1]).toEqual({ path: '/api/knowledge/posts/tip/helped', body: { on: false } });
    });

    it('a member who tapped before reads it as done when the page opens (helpedByMe on the by-id read)', async () => {
        node.post = page({}, { helpedByMe: true });
        await openAs('member');
        expect(screen.getByTestId('learn-post-helped').textContent).toBe('👍 Helped ✓');
    });

    it('"Still right": shown as done, and Checked is this month', async () => {
        await openAs('checker');
        await click('learn-post-still-right');
        expect(writes()).toEqual([{ path: '/api/knowledge/posts/tip/checked', body: undefined }]);
        expect(screen.getByTestId('learn-post-still-right').textContent).toBe('Still right ✓');
        expect(screen.getByTestId('learn-post-still-right').hasAttribute('disabled')).toBe(true);
        expect(screen.getByTestId('learn-post-checked').textContent).toContain('2026');
        expect(screen.getByTestId('learn-post-checked').textContent).toContain('Nov');
    });

    it('"Mark as out of date" with a note: the amber box shows the note; an owner then reads "Clear the mark"', async () => {
        await openAs('checker');
        await click('learn-post-mark');
        type('learn-post-mark-note', '  The tip closes on Mondays now  ');
        await click('learn-post-mark-send');
        expect(writes()).toEqual([{ path: '/api/knowledge/posts/tip/outdated', body: { note: 'The tip closes on Mondays now' } }]);
        expect(screen.getByTestId('learn-post-outdated').textContent).toContain('The tip closes on Mondays now');
        expect(has('learn-post-mark')).toBe(false);
        await click('learn-post-clear');
        expect(writes()[1]).toEqual({ path: '/api/knowledge/posts/tip/outdated/clear', body: undefined });
        expect(has('learn-post-outdated')).toBe(false);
    });

    it('the writer marks their own page with no note at all', async () => {
        await openAs('writer');
        await click('learn-post-mark');
        await click('learn-post-mark-send');
        expect(writes()).toEqual([{ path: '/api/knowledge/posts/tip/outdated', body: { note: '' } }]);
        expect(has('learn-post-outdated')).toBe(true);
    });

    it('"Suggest a fix": "What changed?" first, the page as it shows, no photo picker; it sends only what changed, to the waiting list', async () => {
        await openAs('member');
        expect(screen.getByTestId('learn-post-fix').textContent).toBe('Something changed? Suggest a fix');
        await click('learn-post-fix');
        expect((screen.getByTestId('learn-form-title') as HTMLInputElement).value).toBe('How recycling works at the tip');
        expect((screen.getByTestId('learn-form-place') as HTMLInputElement).value).toBe('Manse Road');
        expect(screen.getByTestId('learn-form').textContent).toContain('An owner or admin checks it first. The page stays as it is until then.');
        expect(screen.getByTestId('learn-form-send').textContent).toBe('Send to the admins');
        expect(screen.queryByText('Photo (optional)')).toBeNull();
        // No note: the form says the node's own words before anything is sent.
        await click('learn-form-send');
        expect(screen.getByTestId('learn-form-refusal').textContent).toBe('Say what changed.');
        expect(writes()).toEqual([]);
        type('learn-form-note', 'Closed on Mondays since March');
        type('learn-form-body', 'Sort it first. Closed on Mondays.');
        await click('learn-form-send');
        expect(writes()).toEqual([{ path: '/api/knowledge/drafts', body: { fixOf: 'tip', note: 'Closed on Mondays since March', body: 'Sort it first. Closed on Mondays.' } }]);
        expect(screen.getByTestId('learn-fix-sent').textContent).toContain('An owner or admin will check it.');
        // Never straight onto the page: nothing was edited.
        expect(writes().some((w) => w.path.endsWith('/edit'))).toBe(false);
    });

    it('the note alone is a fix: no part of the page is sent', () => {
        const p = page();
        expect(learnFixToSend(p, { title: p.title, body: p.description, topic: p.category, place: 'Manse Road', sources: p.knowledge.sources, note: 'Gone' }))
            .toEqual({ fixOf: 'tip', note: 'Gone' });
        // A link removed, the place cleared, the topic changed: each is sent, and nothing else.
        expect(learnFixToSend(p, { title: ` ${p.title} `, body: p.description, topic: 'emergencies', place: '', sources: [], note: 'x' }))
            .toEqual({ fixOf: 'tip', note: 'x', topic: 'emergencies', place: '', sources: [] });
    });

    it('the writer reads "Suggest a fix" (their own edit waits too)', async () => {
        await openAs('writer');
        expect(screen.getByTestId('learn-post-fix').textContent).toBe('Suggest a fix');
    });

    it('an owner\'s "Edit" saves at once, in the page\'s own language, without photos', async () => {
        node.post = page({}, { lang: 'es' });
        await openAs('checker');
        await click('learn-post-edit');
        type('learn-form-title', 'How the tip works now');
        await click('learn-form-send');
        expect(writes()).toEqual([{ path: '/api/knowledge/posts/tip/edit', body: {
            title: 'How the tip works now', body: 'Sort it first.', topic: 'local-services', place: 'Manse Road',
            sources: [{ url: 'https://council.example/tip', label: 'Council tip page' }], lang: 'es',
        } }]);
        expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('How the tip works now');
    });
});

describe('a refusal shows the node\'s own sentence, never a success it didn\'t give', () => {
    const STANDBY = 'This server is a standby copy of the community, so it can’t take this. Please try again at the community’s own address.';
    const OFF = 'Learn isn’t part of this community.';
    const CASES: Array<[string, Reader, { status?: number; error: string; code?: string }, () => Promise<void>, () => void]> = [
        ['helped, standby', 'member', { status: 503, error: STANDBY, code: 'standby' }, () => click('learn-post-helped'),
            () => expect(screen.getByTestId('learn-post-helped').textContent).toBe('👍 This helped')],
        ['helped, switch off', 'member', { status: 404, error: OFF, code: 'feature_off' }, () => click('learn-post-helped'),
            () => expect(screen.getByTestId('learn-post-helped-count').textContent).toBe('Helped 2')],
        ['helped, own page', 'member', { status: 403, error: 'This is your own page: “This helped” is for other members.', code: 'own_page' }, () => click('learn-post-helped'),
            () => expect(screen.getByTestId('learn-post-helped').getAttribute('aria-pressed')).toBe('false')],
        ['still right, standby', 'checker', { status: 503, error: STANDBY, code: 'standby' }, () => click('learn-post-still-right'),
            () => expect(screen.getByTestId('learn-post-still-right').textContent).toBe('Still right')],
        ['still right, not an admin any more', 'checker', { status: 403, error: 'Only this community’s owners and admins can do this to Local knowledge.', code: 'admins_only' },
            () => click('learn-post-still-right'), () => expect(screen.getByTestId('learn-post-still-right').textContent).toBe('Still right')],
        ['mark, switch off', 'writer', { status: 404, error: OFF, code: 'feature_off' }, async () => { await click('learn-post-mark'); await click('learn-post-mark-send'); },
            () => expect(has('learn-post-outdated')).toBe(false)],
        ['mark, a member who is neither', 'writer', { status: 403, error: 'Only its writer, or this community’s owners and admins, can mark it out of date.', code: 'writer_or_admins' },
            async () => { await click('learn-post-mark'); await click('learn-post-mark-send'); }, () => expect(has('learn-post-outdated')).toBe(false)],
        ['still right, dropped connection', 'checker', { error: 'Failed to fetch' }, () => click('learn-post-still-right'),
            () => expect(screen.getByTestId('learn-post-still-right').textContent).toBe('Still right')],
    ];
    it.each(CASES)('%s', async (_name, reader, refuse, go, unchanged) => {
        await openAs(reader);
        node.refuse = refuse;
        await go();
        const said = refuse.status === undefined ? "Couldn't send it. Check your connection and try again." : refuse.error;
        expect(screen.getByTestId('learn-post-refusal').textContent).toBe(said);
        unchanged();
    });

    const FIX_REFUSALS: Array<[string, { status: number; error: string; code: string }]> = [
        ['a fix already waiting', { status: 409, error: 'You’ve already suggested a fix to this page. Wait for an answer, or take it back.', code: 'fix_waiting' }],
        ['an owner or admin (edit instead)', { status: 409, error: 'You’re an owner or admin here, so you change a page at once: edit it instead.', code: 'edit_instead' }],
        ['a standby', { status: 503, error: STANDBY, code: 'standby' }],
        ['the switch off', { status: 404, error: OFF, code: 'feature_off' }],
        ['too many waiting', { status: 429, error: 'You have 3 waiting already. Wait for an answer, or take one back.', code: 'too_many_waiting' }],
    ];
    it.each(FIX_REFUSALS)('a fix refused (%s) says so under the button and shows no "Sent"', async (_name, refuse) => {
        await openAs('member');
        await click('learn-post-fix');
        type('learn-form-note', 'Closed on Mondays');
        node.refuse = refuse;
        await click('learn-form-send');
        expect(screen.getByTestId('learn-form-refusal').textContent).toBe(refuse.error);
        expect(has('learn-fix-sent')).toBe(false);
    });
});

describe('To check: a fix with only its changed parts marked, and the pages not checked for a year (§5.2, §5.3)', () => {
    const fixDraft = (extra: Record<string, unknown> = {}) => ({
        id: 'f1', kind: 'fix', title: 'How recycling works at the tip', topic: 'local-services', from: { pubkey: 'bea-pk', name: 'Bea' }, assistant: null,
        createdAt: '2026-11-14T00:00:00.000Z', body: 'Sort it first. Closed on Mondays.', place: 'Manse Road',
        sources: [{ url: 'https://council.example/tip', label: 'Council tip page' }], lang: null, about: null, note: 'Closed on Mondays since March',
        photos: [], needsSourcesTicked: false,
        post: { id: 'tip', title: 'How recycling works at the tip', body: 'Sort it first.', topic: 'local-services', place: 'Manse Road',
            sources: [{ url: 'https://council.example/tip', label: 'Council tip page' }], lang: null },
        changed: ['body'], pageChanged: [], ...extra,
    });
    const OLD_ROW = { id: 'old', title: 'Old bus times', line: 'Ring first', topic: 'getting-around', photo: null, checkedAt: '2025-09-01T00:00:00.000Z', helped: 0, pinned: false, outdated: false };
    let draft: Record<string, unknown>;
    beforeEach(() => {
        node.role = 'admin';
        draft = fixDraft();
        const base = request.getMockImplementation()!;
        request.mockImplementation((async (method: string, path: string, body?: unknown) => {
            if (path.startsWith('/api/knowledge/drafts?')) {
                return { drafts: [{ id: 'f1', kind: 'fix', title: 'How recycling works at the tip', topic: 'local-services', from: { pubkey: 'bea-pk', name: 'Bea' }, assistant: null, createdAt: '2026-11-14T00:00:00.000Z' }],
                    total: 1, limit: 50, offset: 0, unchecked: { total: 1, rows: [OLD_ROW] } };
            }
            if (path === '/api/knowledge/drafts/f1') return { draft };
            if (method === 'POST' && path === '/api/knowledge/drafts/f1/approve') {
                if (node.refuse) throw Object.assign(new Error(node.refuse.error), { status: node.refuse.status, code: node.refuse.code });
                return { post: node.post };
            }
            return base(method, path, body);
        }) as never);
    });

    it('the list shows "Not checked for a year (1)" under what waits, and a row opens its page', async () => {
        await openPage({ target: { kind: 'check' } });
        expect(screen.getByTestId('learn-check-year').textContent).toContain('Not checked for a year (1)');
        expect(screen.getByTestId('learn-check-year').textContent).toContain('Old bus times');
        node.post = page({ id: 'old', title: 'Old bus times' });
        fireEvent.click(screen.getByText('Old bus times'));
        await wait();
        expect(screen.getByTestId('learn-post').textContent).toContain('Old bus times');
    });

    it('a fix shows "What changed", then only the body as Now beside Suggested; the title, place and sources are not marked', async () => {
        await openPage({ target: { kind: 'check' } });
        await click('learn-check-row');
        expect(screen.getByTestId('learn-check-one').textContent).toContain('Closed on Mondays since March');
        const part = screen.getByTestId('learn-check-part-body');
        expect(part.textContent).toContain('Now');
        expect(part.textContent).toContain('Sort it first.');
        expect(part.textContent).toContain('Suggested');
        expect(part.textContent).toContain('Sort it first. Closed on Mondays.');
        for (const other of ['title', 'topic', 'place', 'sources', 'lang']) expect(has(`learn-check-part-${other}`)).toBe(false);
        expect(has('learn-check-moved')).toBe(false);
        expect(screen.getByTestId('learn-check-one').textContent).toContain('Approving changes the page now.');
        expect(screen.getByTestId('learn-check-one').textContent).not.toContain('announces it in the Pulse');
    });

    it('the note alone says no words changed', async () => {
        draft = fixDraft({ changed: [], body: 'Sort it first.' });
        await openPage({ target: { kind: 'check' } });
        await click('learn-check-row');
        expect(screen.getByTestId('learn-check-note-alone').textContent).toBe('Only the note: no words changed.');
    });

    it('a part the page changed under since is marked amber, and Approve\'s refusal is the node\'s sentence', async () => {
        draft = fixDraft({ pageChanged: ['body'] });
        await openPage({ target: { kind: 'check' } });
        await click('learn-check-row');
        expect(screen.getByTestId('learn-check-moved').textContent).toContain('The page changed here since the fix was sent.');
        const said = 'This page has changed since the fix was sent. Choose the words with “Edit first”, or say “Not this one”.';
        node.refuse = { status: 409, error: said, code: 'page_changed' };
        await click('learn-check-approve');
        expect(screen.getByRole('alert').textContent).toBe(said);
        expect(has('learn-check-one')).toBe(true);
    });

    it('"Edit first" on a fix sends the words and no photos at all (the node refuses any on a fix)', async () => {
        await openPage({ target: { kind: 'check' } });
        await click('learn-check-row');
        await click('learn-check-edit');
        await click('learn-form-send');
        const approve = writes().find((w) => w.path === '/api/knowledge/drafts/f1/approve')!;
        expect(approve).toBeTruthy();
        expect('photos' in approve.body!).toBe(false);
        expect(approve.body).toMatchObject({ title: 'How recycling works at the tip', body: 'Sort it first. Closed on Mondays.' });
    });
});
