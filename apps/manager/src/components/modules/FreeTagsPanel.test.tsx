import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FreeTagsPanel, freeTagsAsText, type FreeTagLine } from './FreeTagsPanel';

const NODE = { id: 'n1', url: 'https://node.example', name: 'Node' } as any;
const TAGS: FreeTagLine[] = [
    { tag: 'vintage', listings: 3, authors: 2, firstSeen: '2026-11-01T10:00:00.000Z', offered: true, rule: null, mergeInto: null },
    { tag: 'limones', listings: 1, authors: 1, firstSeen: '2026-11-10T10:00:00.000Z', offered: true, rule: 'merge', mergeInto: 'food.fruit.lemon' },
    { tag: 'shed', listings: 1, authors: 1, firstSeen: '2026-11-12T10:00:00.000Z', offered: false, rule: null, mergeInto: null },
    { tag: 'retro', listings: 0, authors: 0, firstSeen: null, offered: false, rule: 'hide', mergeInto: null },
];

function serve(answer: unknown, ruleAnswer: { status?: number; body?: unknown } = {}) {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (!init || init.method !== 'POST') return new Response(JSON.stringify(answer));
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(ruleAnswer.body ?? { success: true }), { status: ruleAnswer.status ?? 200 });
    }));
    return calls;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Tags members typed (tags F3)', () => {
    it('lists each tag with its counts and first seen, what members are offered, and the rule: never who', async () => {
        serve({ tags: TAGS, offerAuthors: 2, offerDays: 7 });
        render(<FreeTagsPanel activeNode={NODE} />);
        const rows = await screen.findAllByTestId('free-tag-row');
        expect(rows.map((r) => r.querySelector('span')?.textContent)).toEqual(['#vintage', '#limones', '#shed', '#retro']);
        expect(rows[0].textContent).toContain('3 listings · 2 authors · first seen');
        expect(rows[0].textContent).toContain('Offered to members');
        expect(rows[1].textContent).toContain('Merged into Lemon');
        expect(rows[2].textContent).toContain('Not offered yet');
        expect(rows[3].textContent).toContain('Hidden: not offered');
        expect(rows[3].textContent).toContain('no live listing now');
        expect(screen.getByTestId('free-tags-panel').textContent).toContain('once 2 members use it on live listings, or one member has for 7 days with no report');
    });

    it('draws nothing for a moderator, or for a server older than the route', async () => {
        serve({ tags: TAGS });
        const mod = render(<FreeTagsPanel activeNode={NODE} viewer={{ kind: 'key', role: 'moderator' } as any} />);
        expect(mod.container.textContent).toBe('');
        cleanup();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
        const old = render(<FreeTagsPanel activeNode={NODE} />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(old.container.textContent).toBe('');
    });

    it('Hide, Clear and Merge send the rule for that tag', async () => {
        const calls = serve({ tags: TAGS, offerAuthors: 2, offerDays: 7 });
        render(<FreeTagsPanel activeNode={NODE} />);
        const rows = await screen.findAllByTestId('free-tag-row');
        fireEvent.click(rows[0].querySelector('button')!);
        await waitFor(() => expect(calls.at(-1)?.url).toContain('/api/local/admin/free-tags/vintage/hide'));
        expect(await screen.findByText('#vintage is no longer offered to members.')).toBeInTheDocument();
        fireEvent.click([...rows[3].querySelectorAll('button')].find((b) => b.textContent === 'Clear the rule')!);
        await waitFor(() => expect(calls.at(-1)?.url).toContain('/api/local/admin/free-tags/retro/clear'));
        fireEvent.click([...rows[2].querySelectorAll('button')].find((b) => b.textContent === 'Merge into a library tag')!);
        fireEvent.change(screen.getByLabelText('Find a library tag'), { target: { value: 'lemon' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Lemon' }));
        await waitFor(() => expect(calls.at(-1)?.url).toContain('/api/local/admin/free-tags/shed/merge'));
        expect(calls.at(-1)?.body).toEqual({ into: 'food.fruit.lemon' });
    });

    it("a refusal is shown in the server's words", async () => {
        serve({ tags: TAGS }, { status: 403, body: { error: 'Sign in with your own key to change how a tag is offered, so it is logged in your name.' } });
        render(<FreeTagsPanel activeNode={NODE} />);
        const rows = await screen.findAllByTestId('free-tag-row');
        fireEvent.click(rows[0].querySelector('button')!);
        expect(await screen.findByText('Sign in with your own key to change how a tag is offered, so it is logged in your name.')).toBeInTheDocument();
    });

    it('copies as text, one tab-separated line a tag, for the library', () => {
        expect(freeTagsAsText(TAGS).split('\n')).toEqual([
            'tag\tlistings\tauthors\tfirst seen\trule',
            'vintage\t3\t2\t2026-11-01\t',
            'limones\t1\t1\t2026-11-10\tmerge food.fruit.lemon',
            'shed\t1\t1\t2026-11-12\t',
            'retro\t0\t0\t\thide',
        ]);
    });
});
