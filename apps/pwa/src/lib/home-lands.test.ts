import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Home's read says this app opens an enterprise's own screen (`lands=enterprise`, apps/server routes/home-answer.ts
 * parseLands), so the node may point a keepers' vote line there (DESIGN-group-decisions S2). The landing ships with it:
 * HomePage's needsLine opens { to: 'enterprise', id } as onNavigate('enterprise', id) (pages/HomePage.test.tsx).
 */
vi.mock('./identity', () => ({ loadIdentity: vi.fn(async () => null) }));

describe('GET /api/home names the landings this app opens', () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    beforeEach(() => {
        calls.length = 0;
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
            calls.push(String(input));
            return new Response(JSON.stringify({ generatedAt: new Date().toISOString(), cards: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }) as typeof fetch;
    });
    afterEach(() => { globalThis.fetch = realFetch; });

    it('lands=enterprise,group,invite,people,asks,first-need,words, with or without the cards and a point', async () => {
        const { getHome } = await import('./api');
        await getHome({ cards: ['needs', 'decide'] }).catch(() => undefined);
        await getHome({}).catch(() => undefined);
        expect(calls.length).toBe(2);
        // `invite`: HomePage's needsLine opens { to: 'invite', id } on the group (its info, with Join), and { to: 'invites' } on Commons.
        // `people`: { to: 'people' } opens People → Invites, which lists requests to join on the web since front doors S2
        // (PR #2625 review: before, the web never got the line, and an owner's count sat in the admin line, landing on settings).
        // `first-need`: First steps' line "Ask for one thing you'd pay a neighbour for" opens the composer on a Need (cold-start N2); the node keeps
        // First steps up for that line alone only for an app that says it draws it (routes/home-answer.ts parseLands).
        // `words`: First steps' line "Keep your 12 words safe" (DESIGN-home-default-fable.md §2.4, slice D3), the same rule.
        expect(new URL(calls[0], 'https://node.example').searchParams.get('lands')).toBe('enterprise,group,invite,people,asks,first-need,words');
        expect(new URL(calls[0], 'https://node.example').searchParams.get('cards')).toBe('needs,decide');
        expect(new URL(calls[1], 'https://node.example').searchParams.get('lands')).toBe('enterprise,group,invite,people,asks,first-need,words');
    });
});
