/**
 * The tool registry's rules (scratch/tools/DESIGN-tool-template-fable.md §1.2, §1.4–§1.6, slice T0.1): the shelves, a
 * tool's Home card in Home's own registry (the picker's and the ask's rules, the one spread in home-frame.ts), the host
 * narrowed to the manifest's permissions, and the one sync rule on its six cases.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { word } from '../words.js';
import type { HomeNodeFacts } from '../home-frame.js';
import {
    TOOL_PERMISSIONS, TOOL_PERMISSION_GRANTS, narrowHost, reconcile, toolById, toolHomeCardTypes, toolsMore, toolsOnShelf,
    type ToolHostBase, type ToolHostGrants, type ToolManifest,
} from '../tools/index.js';

const local: HomeNodeFacts = { profile: 'local', features: { beans: true } };
const global: HomeNodeFacts = { profile: 'global', features: { beans: false } };

function tool(id: string, over: Partial<ToolManifest> = {}): ToolManifest {
    return {
        id, name: word('Sample tool'), line: word('A tool for the tests.'), icon: '🧪', shelf: 'stock', shopKinds: 'all', owner: 'member',
        permissions: [], doc: { version: 1, empty: () => ({ v: 1 }), read: () => ({ v: 1 }) }, screens: ['main'], row: () => null,
        examples: [word('An example')], ...over,
    };
}

describe('the shelves (toolsOnShelf, toolsMore)', () => {
    const shed = tool('shed', { shopKinds: ['tools', 'seeds'], owner: 'both' });
    const garden = tool('garden', { shopKinds: ['food', 'seeds'] });
    const takings = tool('takings', { shelf: 'books', owner: 'enterprise' });
    const prices = tool('prices', { shelf: 'trade', onNode: (f) => f.profile !== 'global' });
    const all = [shed, garden, takings, prices];
    const ids = (ts: ToolManifest[]) => ts.map((t) => t.id);

    it("with no shop, a member's shelf holds every tool on it for members that the node can have, in the registry's order", () => {
        expect(ids(toolsOnShelf('stock', null, 'member', local, all))).toEqual(['shed', 'garden']);
        expect(ids(toolsOnShelf('trade', null, 'member', local, all))).toEqual(['prices']);
        expect(ids(toolsOnShelf('books', null, 'member', local, all))).toEqual([]);
        expect(ids(toolsMore(null, 'member', local, all))).toEqual([]);
    });

    it("an enterprise's console holds its tools and the ones for both, never a member's own", () => {
        expect(ids(toolsOnShelf('stock', null, 'enterprise', local, all))).toEqual(['shed']);
        expect(ids(toolsOnShelf('books', null, 'enterprise', local, all))).toEqual(['takings']);
    });

    it('for a shop of a kind, the tools for that kind; the rest under More tools', () => {
        expect(ids(toolsOnShelf('stock', 'food', 'member', local, all))).toEqual(['garden']);
        expect(ids(toolsOnShelf('stock', 'seeds', 'member', local, all))).toEqual(['shed', 'garden']);
        expect(ids(toolsMore('food', 'member', local, all))).toEqual(['shed']);
        expect(ids(toolsMore('food', 'member', local, all.map((t) => (t.id === 'prices' ? { ...t, shopKinds: ['tools'] as const } : t))))).toEqual(['shed', 'prices']);
    });

    it("a tool the node can't have is not listed anywhere, never shown locked", () => {
        expect(ids(toolsOnShelf('trade', null, 'member', global, all))).toEqual([]);
        expect(ids(toolsMore('food', 'member', global, all))).toEqual(['shed']);
    });

    it('finds a tool by id, and none for an id this build lacks', () => {
        expect(toolById('garden', all)).toBe(garden);
        expect(toolById('stock', all)).toBeUndefined();
    });
});

describe("a tool's Home card", () => {
    const withCard = tool('shed', {
        name: word('Tool shed'), onNode: (f) => f.profile !== 'global',
        homeCard: { line: word('Your things, and what is out.'), lines: () => [] },
    });

    it('is a `tool-<id>` type under For you, worked out on the device (never asked of the node), only where the tool is', () => {
        const [type, ...rest] = toolHomeCardTypes([withCard, tool('plain')]);
        expect(rest).toEqual([]);
        expect(type).toMatchObject({ id: 'tool-shed', name: withCard.name, line: withCard.homeCard!.line, group: 'you', asks: 'none' });
        expect(type.onNode(local)).toBe(true);
        expect(type.onNode(global)).toBe(false);
        expect(type.fixed).toBeUndefined();
        expect(type.multiple).toBeUndefined();
        expect(toolHomeCardTypes([tool('always', { homeCard: withCard.homeCard })])[0].onNode(global)).toBe(true);
    });

    it("is offered only for a tool on a member's shelves: an enterprise's own has none on Home, one for both has it", () => {
        const [own, both] = toolHomeCardTypes([
            tool('takings', { owner: 'enterprise', homeCard: withCard.homeCard }),
            tool('shed', { owner: 'both', homeCard: withCard.homeCard }),
        ]);
        expect(own.onNode(local)).toBe(false);
        expect(own.onNode(global)).toBe(false);
        expect(both.onNode(local)).toBe(true);
    });

    describe("in Home's registry (home-frame.ts spreads every tool's card in, just before Your community)", () => {
        afterEach(() => {
            vi.doUnmock('../tools/index.js');
            vi.resetModules();
        });

        async function homeFrameWith(tools: ToolManifest[]) {
            vi.resetModules();
            vi.doMock('../tools/index.js', async (importOriginal) => {
                const real = await importOriginal<typeof import('../tools/index.js')>();
                return { ...real, toolHomeCardTypes: () => real.toolHomeCardTypes(tools) };
            });
            return import('../home-frame.js');
        }

        it('the picker and the ask read it like any other type: added once, kept, never asked of the node, community still last', async () => {
            const hf = await homeFrameWith([withCard]);
            const ids = hf.HOME_CARD_TYPES.map((t) => t.id);
            expect(ids.slice(-2)).toEqual(['tool-shed', 'community']);
            expect(hf.homeCardType('tool-shed')).toMatchObject({ group: 'you', asks: 'none' });
            expect(hf.HOME_FIXED_TYPES).toEqual(['needs', 'community']);
            const added = hf.addCard(null, 'tool-shed', { now: 0 });
            expect(added.ok).toBe(true);
            if (!added.ok) return;
            expect(added.layout.cards.map((c) => c.id)).toEqual(['tool-shed', 'start']);
            expect(hf.addCard(added.layout, 'tool-shed')).toEqual({ ok: false, refused: 'on-home' });
            expect(hf.cardsToAsk(added.layout)).not.toContain('tool-shed');
            expect(hf.readHomeLayout(added.layout)?.cards.map((c) => c.type)).toContain('tool-shed');
            expect(hf.HOME_CARD_TYPES.filter((t) => t.onNode(global)).map((t) => t.id)).not.toContain('tool-shed');
        });

        it('with no tools (this build), the registry is what it was', async () => {
            const hf = await homeFrameWith([]);
            expect(hf.HOME_CARD_TYPES.some((t) => t.id.startsWith('tool-'))).toBe(false);
            expect(hf.HOME_CARD_TYPES[hf.HOME_CARD_TYPES.length - 1].id).toBe('community');
        });
    });
});

describe('the host, narrowed to the manifest (narrowHost)', () => {
    const base: ToolHostBase<{ v: number }> = {
        owner: { kind: 'member', publicKey: 'pk', name: 'Ana' },
        node: { url: null, profile: 'local', features: null },
        doc: { get: () => ({ v: 1 }), set: async () => undefined, maxBytes: () => 65_536 },
        navigate: () => undefined,
        back: () => undefined,
        now: () => 0,
    };
    const grants: ToolHostGrants = {
        photos: { pick: async () => null, remove: async () => undefined, uri: (r) => r },
        camera: { take: async () => null },
        place: async () => null,
        offerDoor: () => undefined,
        needDoor: () => undefined,
        eventDoor: () => undefined,
        deals: async () => [],
        pricingGuide: async () => null,
        posts: { pause: async () => undefined, resume: async () => undefined, status: async () => 'active', mine: async () => [] },
        nodeCopy: { on: true },
    };
    const full = { ...base, ...grants };

    it('a tool that asked for nothing gets the base and nothing else', () => {
        expect(Object.keys(narrowHost(full, [])).sort()).toEqual(['back', 'doc', 'navigate', 'node', 'now', 'owner']);
    });

    it('each permission grants its one function, and an undeclared one is absent, not undefined', () => {
        const host = narrowHost(full, ['offer-door', 'photos', 'reminders']);
        expect(Object.keys(host).sort()).toEqual(['back', 'doc', 'navigate', 'node', 'now', 'offerDoor', 'owner', 'photos']);
        expect(host.offerDoor).toBe(grants.offerDoor);
        expect('deals' in host).toBe(false);
        expect('camera' in host).toBe(false);
    });

    it('every permission names a host function or, for reminders, none; no two share one', () => {
        expect(Object.keys(TOOL_PERMISSION_GRANTS).sort()).toEqual([...TOOL_PERMISSIONS].sort());
        const granted = Object.values(TOOL_PERMISSION_GRANTS).filter((g) => g !== null);
        expect(new Set(granted).size).toBe(granted.length);
        expect(granted.sort()).toEqual(Object.keys(grants).sort());
        expect(Object.keys(narrowHost(full, TOOL_PERMISSIONS)).length).toBe(6 + granted.length);
    });

    it("a grant the app's host lacks (a feature not built there yet) is absent too", () => {
        expect('deals' in narrowHost({ ...full, deals: undefined }, ['deals'])).toBe(false);
    });
});

describe('the sync rule (reconcile): the six cases, and both changed', () => {
    const T1 = '2026-10-20T01:00:00.000Z';
    const T2 = '2026-10-20T02:00:00.000Z';
    const T3 = '2026-10-20T03:00:00.000Z';
    const node = (updatedAt: string) => ({ kind: 'copy' as const, body: `{"v":1,"at":"${updatedAt}"}`, updatedAt });

    it('first open: the node copy is taken; with none, nothing to do (the document starts empty)', () => {
        expect(reconcile(null, node(T1))).toEqual({ do: 'take', body: node(T1).body, updatedAt: T1, why: 'first-open' });
        expect(reconcile(null, { kind: 'none' })).toEqual({ do: 'nothing', why: 'first-open' });
    });

    it('equal: nothing changed on either side since the last sync', () => {
        expect(reconcile({ body: '{}', updatedAt: T1, syncedAt: T1 }, node(T1))).toEqual({ do: 'nothing', why: 'equal' });
    });

    it("device newer: written here since the last sync and the node's copy unchanged, it is PUT", () => {
        expect(reconcile({ body: '{}', updatedAt: T2, syncedAt: T1 }, node(T1))).toEqual({ do: 'put', why: 'device-newer' });
    });

    it('node newer: another device wrote it since, and this one did not, so it is taken', () => {
        expect(reconcile({ body: '{}', updatedAt: T1, syncedAt: T1 }, node(T2))).toEqual({ do: 'take', body: node(T2).body, updatedAt: T2, why: 'node-newer' });
    });

    it('a node with the store but no copy yet is given this one', () => {
        expect(reconcile({ body: '{}', updatedAt: T1, syncedAt: null }, { kind: 'none' })).toEqual({ do: 'put', why: 'no-copy' });
    });

    it('404 from an older node: this device only, whatever it holds', () => {
        expect(reconcile({ body: '{}', updatedAt: T2, syncedAt: T1 }, { kind: 'older-node' })).toEqual({ do: 'device-only', why: 'older-node' });
        expect(reconcile(null, { kind: 'older-node' })).toEqual({ do: 'device-only', why: 'older-node' });
    });

    it('offline: keep what the device has and try on the next open', () => {
        expect(reconcile({ body: '{}', updatedAt: T2, syncedAt: T1 }, { kind: 'offline' })).toEqual({ do: 'later', why: 'offline' });
        expect(reconcile(null, { kind: 'offline' })).toEqual({ do: 'later', why: 'offline' });
    });

    it('both changed since the last sync: the later write wins, a tie goes to the node, a time that is not one loses', () => {
        expect(reconcile({ body: '{}', updatedAt: T3, syncedAt: T1 }, node(T2))).toEqual({ do: 'put', why: 'device-newer' });
        expect(reconcile({ body: '{}', updatedAt: T2, syncedAt: T1 }, node(T3)).do).toBe('take');
        expect(reconcile({ body: '{}', updatedAt: T2, syncedAt: T1 }, node(T2.replace('.000Z', 'Z'))).do).toBe('take');
        expect(reconcile({ body: '{}', updatedAt: 'garbage', syncedAt: T1 }, node(T2)).do).toBe('take');
        expect(reconcile({ body: '{}', updatedAt: T2, syncedAt: T1 }, node('garbage')).do).toBe('put');
    });

    it("never compares the device's clock with the node's when only one side changed", () => {
        // The device's clock runs a day behind: its own edit still goes up, because the node's copy hasn't moved.
        expect(reconcile({ body: '{}', updatedAt: '2026-10-19T00:00:00.000Z', syncedAt: T2 }, node(T2)).do).toBe('put');
        // And a node copy older by the clock than the device's last write is still taken when the device hasn't written since.
        expect(reconcile({ body: '{}', updatedAt: T3, syncedAt: T3 }, node(T1)).do).toBe('take');
    });
});

describe('the delete rule (the copy switched off elsewhere): DESIGN-t04-node-copy-delete-fable.md §5, tests 3 and 4', () => {
    const T1 = '2026-10-20T01:00:00.000Z';
    const T2 = '2026-10-20T02:00:00.000Z';
    const T3 = '2026-10-20T03:00:00.000Z';
    const deleted = { kind: 'deleted' as const, deletedAt: T2 };
    const synced = { body: '{"v":1}', updatedAt: T1, syncedAt: T1 };
    const changedSince = { body: '{"v":1,"x":1}', updatedAt: T3, syncedAt: T1 };
    const neverSynced = { body: '{"v":1}', updatedAt: T1, syncedAt: null };
    const node = (updatedAt: string) => ({ kind: 'copy' as const, body: `{"v":1,"at":"${updatedAt}"}`, updatedAt });

    it('3. deleted: switch off whatever the device holds, a change made after the delete included (no time compared); on: put', () => {
        for (const local of [null, synced, changedSince, neverSynced]) {
            expect(reconcile(local, deleted), JSON.stringify(local)).toEqual({ do: 'switch-off', why: 'node-removed' });
            expect(reconcile(local, deleted, 'open'), JSON.stringify(local)).toEqual({ do: 'switch-off', why: 'node-removed' });
            expect(reconcile(local, deleted, 'turn-on'), JSON.stringify(local)).toEqual({ do: 'put', why: 'turn-on' });
        }
    });

    it('4. none: a device that once synced switches off; one that never did gives its copy; with none, nothing; on: put for all three', () => {
        const none = { kind: 'none' as const };
        expect(reconcile(synced, none)).toEqual({ do: 'switch-off', why: 'node-removed' });
        expect(reconcile(changedSince, none)).toEqual({ do: 'switch-off', why: 'node-removed' });
        expect(reconcile(neverSynced, none)).toEqual({ do: 'put', why: 'no-copy' });
        expect(reconcile(null, none)).toEqual({ do: 'nothing', why: 'first-open' });
        for (const local of [synced, neverSynced, null]) expect(reconcile(local, none, 'turn-on')).toEqual({ do: 'put', why: 'turn-on' });
    });

    it('4. offline, older-node and a copy: as before for both intents, and never a switch-off', () => {
        const remotes = [{ kind: 'offline' as const }, { kind: 'older-node' as const }, node(T1), node(T2)];
        for (const local of [null, synced, changedSince, neverSynced]) {
            for (const remote of remotes) {
                const open = reconcile(local, remote, 'open');
                expect(reconcile(local, remote, 'turn-on'), `${JSON.stringify(local)} ${remote.kind}`).toEqual(open);
                expect(open.do).not.toBe('switch-off');
            }
        }
        expect(reconcile(synced, node(T1), 'turn-on')).toEqual({ do: 'nothing', why: 'equal' });
        expect(reconcile(null, node(T2), 'turn-on')).toMatchObject({ do: 'take', why: 'first-open' });
    });
});
