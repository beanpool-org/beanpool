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

    it('lands=enterprise, with or without the cards and a point', async () => {
        const { getHome } = await import('./api');
        await getHome({ cards: ['needs', 'decide'] }).catch(() => undefined);
        await getHome({}).catch(() => undefined);
        expect(calls.length).toBe(2);
        expect(new URL(calls[0], 'https://node.example').searchParams.get('lands')).toBe('enterprise');
        expect(new URL(calls[0], 'https://node.example').searchParams.get('cards')).toBe('needs,decide');
        expect(new URL(calls[1], 'https://node.example').searchParams.get('lands')).toBe('enterprise');
    });
});
