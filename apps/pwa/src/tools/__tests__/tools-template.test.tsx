/**
 * The web twin of the tool template's generic tests (scratch/tools/DESIGN-tool-template-fable.md §1.5 (c) and (e), slice
 * T0.3), run for every registered tool and for the scaffold (scaffold.test-support.ts; the registry ships none yet):
 *
 * - every screen, in the frame, with every fixture document, in the pseudo-locale `xx`: no letters outside a bracket but
 *   what the member wrote (the words-xx harness), and at 320 px with text at 1.3x every word drawn through t() fits the
 *   narrowest column a tool's text sits in, and every text sits in something that wraps or cuts it (nothing scrolls
 *   sideways);
 * - axe finds nothing on the Tools screen, the frame, the two doors, Settings and the unknown-tool page;
 * - the host a tool is given has no function its manifest did not declare, nor one the web hasn't built;
 * - a tool id or screen this build doesn't have says "This tool isn't in this version of the app", never a crash;
 * - the offer door opens the composer prefilled and posts nothing; the Home card is offered once, never added by itself.
 *
 * jsdom does no layout, so the 320 px check is the phone's width model (apps/native/utils/__tests__/home-layout-320.test.ts:
 * 0.62 of the font size a letter, 1.25 an emoji) on the classes the page draws with.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { useState, type ComponentType } from 'react';
import { TOOLS, TOOL_PERMISSIONS, type AnyToolScreenProps, type ToolApp, type ToolManifest } from '@beanpool/core';
import { ToolsPage, type ToolsPageProps } from '../../pages/ToolsPage';
import { TOOL_APPS } from '../index';
import { ToolHomeCard } from '../home-card';
import { writeToolRecord, readToolRecord, readToolSettings, resetToolStoreForTest } from '../store';
import type { ComposerDraft } from '../builder';
import { memoryIndexedDB } from '../../lib/memory-indexeddb';
import { resetAccountEpochForTest } from '../../lib/account-epoch';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../../words-xx.test-support';
import { scaffoldTool, type ScaffoldTool } from './scaffold.test-support';

vi.mock('../../lib/features', () => ({ useCommunityInfo: () => null }));

type WebApp = ToolApp<ComponentType<AnyToolScreenProps>>;
type Loader = () => Promise<{ default: WebApp }>;
interface Case { manifest: ToolManifest; fixtures: ScaffoldTool['fixtures']; loader: Loader }

const OWNER = 'tools-test-owner-key';
const identity = { publicKey: OWNER, privateKey: 'k', callsign: 'Robin', createdAt: '2026-10-01T00:00:00.000Z' };

let scaffold: ScaffoldTool;
let cases: Case[] = [];

beforeAll(async () => {
    scaffold = await scaffoldTool('scaffold');
    const registered: Case[] = [];
    for (const m of TOOLS) {
        const loader = TOOL_APPS[m.id] as Loader | undefined;
        if (!loader) continue;
        const { FIXTURES } = await import(/* @vite-ignore */ `../../../../../packages/beanpool-core/src/tools/${m.id}/fixtures.ts`);
        registered.push({ manifest: m, fixtures: FIXTURES, loader });
    }
    cases = [...registered, { manifest: scaffold.manifest, fixtures: scaffold.fixtures, loader: scaffold.loader }];
});

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetToolStoreForTest();
    resetAccountEpochForTest();
});
afterEach(() => {
    cleanup();
    backToEnglish();
    vi.unstubAllGlobals();
});

function draw(c: Pick<Case, 'manifest' | 'loader'>, open: ToolsPageProps['open'], over: Partial<ToolsPageProps> = {}) {
    const props: ToolsPageProps = {
        identity,
        open,
        onOpen: vi.fn(),
        onClose: vi.fn(),
        onComposer: vi.fn(),
        onGuide: vi.fn(),
        onAddHomeCard: vi.fn(),
        tools: [c.manifest],
        apps: { [c.manifest.id]: c.loader },
        now: () => Date.parse('2026-10-20T09:00:00.000Z'),
        ...over,
    };
    return { props, ...render(<ToolsPage {...props} />) };
}

async function keep(id: string, doc: unknown) {
    expect(await writeToolRecord(OWNER, id, { body: JSON.stringify(doc), updatedAt: '2026-10-20T08:00:00.000Z', syncedAt: null })).toBe(true);
}

/** Every string a member wrote in a document: shown as written, never through t(). */
function memberText(doc: unknown): string[] {
    const out: string[] = [];
    const walk = (v: unknown) => {
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(doc);
    return out.filter((s) => /\p{L}/u.test(s));
}

// ── The width model at 320 px × 1.3 ──
const SCREEN = 320;
const SCALE = 1.3;
const FONT: Record<string, number> = { 'text-xs': 12, 'text-sm': 14, 'text-base': 16, 'text-lg': 18, 'text-[0.95rem]': 15.2, 'text-2xl': 24, 'text-4xl': 36 };
function fontOf(el: Element): number {
    for (let e: Element | null = el; e; e = e.parentElement) {
        for (const c of Array.from(e.classList)) if (FONT[c]) return FONT[c];
    }
    return 16;
}
function textWidth(text: string, px: number): number {
    return [...text].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) ? 1.25 : 0.62) * px * SCALE, 0);
}
/**
 * The narrowest column a tool's words sit in: a row's title beside its icon and chevron, inside a section, inside the
 * page's gutters (px-4 page, 1 px border, px-3 row, w-8 icon, two gap-3, the › at text-lg).
 */
const NARROWEST = SCREEN - 2 * 16 - 2 * 1 - 2 * 12 - 32 - 12 - 12 - textWidth('›', 18);
const WRAPS = /(^|\s)(break-words|break-all|truncate|line-clamp-\d)(\s|$)/;

/** Words drawn through t() whose longest word is wider than the narrowest column, and text in nothing that wraps it. */
function layoutProblems(root: HTMLElement): string[] {
    const out: string[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? '').join('').trim();
        if (!own || !/\p{L}/u.test(own)) continue;
        let wraps = false;
        for (let e: Element | null = el; e && e !== root.parentElement; e = e.parentElement) if (WRAPS.test(e.className || '')) { wraps = true; break; }
        if (!wraps) out.push(`not wrapped: ${JSON.stringify(own)}`);
        if (!/^\[[\s\S]*\]$/u.test(own)) continue; // a member's words: wrapped, never measured
        const px = fontOf(el);
        // xx's padding carries zero-width spaces, where a line may break, as a long language's words would.
        for (const w of own.split(/[\s\u200b]+/)) {
            if (textWidth(w, px) > NARROWEST) out.push(`too wide at 320 px × 1.3: ${JSON.stringify(w)} (${Math.round(textWidth(w, px))} > ${Math.round(NARROWEST)} px)`);
        }
    }
    return out;
}

async function axeProblems(root: HTMLElement): Promise<string[]> {
    // jsdom computes no colours: contrast is the central tokens' (each with its dark pair) and the browser checks'.
    const result = await axe.run(root, { rules: { 'color-contrast': { enabled: false } } });
    return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

describe('every tool, in the frame, in xx at 320 px × 1.3', () => {
    it('the checks bite: an unwrapped line, a word too wide, a nameless button and a word outside t() are each found', async () => {
        const bad = render(
            <div>
                <p>{'[' + 'Ŵ'.repeat(30) + ']'}</p>
                <button type="button" className="break-words"><span aria-hidden="true">…</span></button>
                <span className="break-words">Plain English</span>
            </div>,
        );
        const root = bad.container.firstChild as HTMLElement;
        const layout = layoutProblems(root);
        expect(layout.some((p) => p.startsWith('not wrapped'))).toBe(true);
        expect(layout.some((p) => p.startsWith('too wide'))).toBe(true);
        expect((await axeProblems(root)).some((p) => p.startsWith('button-name'))).toBe(true);
        expect(bypassing(root)).toContain('text: "Plain English"');
    });

    it('the scaffold is among the cases, and every registered tool with a web half is too', () => {
        expect(cases.map((c) => c.manifest.id)).toContain('scaffold');
        for (const m of TOOLS) if (TOOL_APPS[m.id]) expect(cases.map((c) => c.manifest.id)).toContain(m.id);
    });

    it('every screen with every fixture: every word through t(), each fits, nothing scrolls sideways, axe clean', async () => {
        await showIn('xx');
        for (const c of cases) {
            for (const [name, doc] of Object.entries(c.fixtures.docs)) {
                for (const screenName of c.manifest.screens) {
                    resetToolStoreForTest();
                    vi.stubGlobal('indexedDB', memoryIndexedDB());
                    await keep(c.manifest.id, doc);
                    const view = draw(c, { id: c.manifest.id, screen: screenName, key: null });
                    const page = await view.findByTestId('tools-page');
                    const where = `${c.manifest.id} ${screenName} with ${name}`;
                    // Empty: the two doors first; "I already do this" goes in.
                    if (screenName === 'main' && JSON.stringify(doc) === JSON.stringify(c.manifest.doc.empty())) {
                        await view.findByTestId('tool-doors');
                        expect(layoutProblems(page), `${where}, the doors`).toEqual([]);
                        expect(bypassing(page, { others: memberText(doc) }), `${where}, the doors`).toEqual([]);
                        expect(await axeProblems(page), `${where}, the doors`).toEqual([]);
                        await act(async () => { fireEvent.click(within(page).getByRole('button', { name: xx('I already do this') })); });
                    }
                    await waitFor(() => expect(view.queryByRole('status')).toBeNull());
                    expect(bracketed(page), where).toBeGreaterThan(1);
                    expect(bypassing(page, { others: memberText(doc) }), where).toEqual([]);
                    expect(layoutProblems(page), where).toEqual([]);
                    expect(await axeProblems(page), where).toEqual([]);
                    view.unmount();
                }
            }
        }
    });

    it('the Tools screen, the menu, Settings, About and the unknown tool: the same, in xx', async () => {
        await showIn('xx');
        const c = cases[cases.length - 1];
        await keep(c.manifest.id, c.fixtures.docs.small ?? c.manifest.doc.empty());
        const list = draw(c, { id: null, screen: 'main', key: null });
        const row = await list.findByTestId(`tools-row-${c.manifest.id}`);
        let page = list.getByTestId('tools-page');
        await waitFor(() => expect(row.textContent).not.toContain(xx(String(c.manifest.line))));
        expect(bypassing(page), 'the Tools screen').toEqual([]);
        expect(layoutProblems(page), 'the Tools screen').toEqual([]);
        expect(await axeProblems(page), 'the Tools screen').toEqual([]);
        list.unmount();

        const one = draw(c, { id: c.manifest.id, screen: 'main', key: null });
        page = await one.findByTestId('tools-page');
        await act(async () => { fireEvent.click(await one.findByTestId('tool-menu')); });
        expect(bypassing(page, { others: memberText(c.fixtures.docs.small) }), 'the menu').toEqual([]);
        expect(layoutProblems(page), 'the menu').toEqual([]);
        expect(await axeProblems(page), 'the menu').toEqual([]);
        await act(async () => { fireEvent.click(one.getByTestId('tool-menu-settings')); });
        await act(async () => { fireEvent.click(one.getByTestId('tool-remove')); });
        expect(bypassing(page), 'Settings').toEqual([]);
        expect(layoutProblems(page), 'Settings').toEqual([]);
        expect(await axeProblems(page), 'Settings').toEqual([]);
        await act(async () => { fireEvent.click(one.getByTestId('tool-menu')); });
        await act(async () => { fireEvent.click(one.getByTestId('tool-menu-about')); });
        expect(bypassing(page), 'About').toEqual([]);
        expect(await axeProblems(page), 'About').toEqual([]);
        one.unmount();

        const gone = draw(c, { id: 'not-a-tool', screen: 'main', key: null });
        page = await gone.findByTestId('tool-not-here');
        expect(bypassing(page)).toEqual([]);
        expect(layoutProblems(page)).toEqual([]);
        expect(await axeProblems(gone.getByTestId('tools-page'))).toEqual([]);
    });
});

describe('a tool this build does not have', () => {
    it("an unknown id says \"This tool isn't in this version of the app\", with Refresh and Back, and loads nothing", async () => {
        const loader = vi.fn(scaffold.loader);
        const { props } = draw({ manifest: scaffold.manifest, loader }, { id: 'garden-of-tomorrow', screen: 'main', key: null });
        expect(await screen.findByText("This tool isn't in this version of the app")).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
        fireEvent.click(screen.getAllByRole('button', { name: /Back/ })[0]);
        expect(props.onClose).toHaveBeenCalled();
        expect(loader).not.toHaveBeenCalled();
    });

    it('a manifest with no web half here, and a screen the tool has not got, say the same', async () => {
        const first = draw({ manifest: scaffold.manifest, loader: scaffold.loader }, { id: 'scaffold', screen: 'main', key: null }, { apps: {} });
        expect(await screen.findByText("This tool isn't in this version of the app")).toBeInTheDocument();
        first.unmount();
        draw({ manifest: scaffold.manifest, loader: scaffold.loader }, { id: 'scaffold', screen: 'loans', key: 'x1' });
        expect(await screen.findByText("This tool isn't in this version of the app")).toBeInTheDocument();
    });

    it('the registry as shipped: no tool, the Tools screen says so, and any id is not in this version', async () => {
        expect(TOOLS).toEqual([]);
        expect(Object.keys(TOOL_APPS)).toEqual([]);
        const list = render(<ToolsPage identity={identity} open={{ id: null, screen: 'main', key: null }} onOpen={vi.fn()} onClose={vi.fn()} onComposer={vi.fn()} onGuide={vi.fn()} onAddHomeCard={vi.fn()} />);
        expect(await list.findByTestId('tools-none')).toBeInTheDocument();
        list.unmount();
        render(<ToolsPage identity={identity} open={{ id: 'scaffold', screen: 'main', key: null }} onOpen={vi.fn()} onClose={vi.fn()} onComposer={vi.fn()} onGuide={vi.fn()} onAddHomeCard={vi.fn()} />);
        expect(await screen.findByText("This tool isn't in this version of the app")).toBeInTheDocument();
    });
});

/** A tool whose one screen hands the test the host it was given (and can press its doors). */
function spyTool(permissions: ToolManifest['permissions']) {
    const seen: { host: AnyToolScreenProps['host'] | null } = { host: null };
    const manifest: ToolManifest = { ...scaffold.manifest, id: 'spy', permissions };
    const Main = ({ host }: AnyToolScreenProps) => {
        seen.host = host;
        return <button type="button" onClick={() => (host as unknown as { offerDoor?: (d: unknown) => void }).offerDoor?.({ title: 'Ladder to lend', description: 'Three metres', category: 'tools', credits: 5, priceType: 'daily', lendable: true, shop: true })}>offer</button>;
    };
    const app: WebApp = { id: 'spy', screens: () => ({ main: Main }) };
    return { seen, c: { manifest, loader: async () => ({ default: app }) } };
}

describe('the host: only what the manifest declared', () => {
    it('the scaffold (no permissions) is given the base and nothing else', async () => {
        const { seen, c } = spyTool(scaffold.manifest.permissions);
        await keep('spy', { v: 1, items: [{ id: 'a', name: 'Ladder', addedAt: '2026-10-01T00:00:00.000Z' }] });
        draw(c, { id: 'spy', screen: 'main', key: null });
        await screen.findByRole('button', { name: 'offer' });
        expect(Object.keys(seen.host!).sort()).toEqual(['doc', 'navigate', 'node', 'now', 'owner']);
        expect('offerDoor' in seen.host!).toBe(false);
        expect('deals' in seen.host!).toBe(false);
    });

    it('every permission at once: the web grants only what it has built (the doors, the node copy); the rest are absent, not undefined', async () => {
        // The node copy's open asks the community's server, which keeps none yet, so this browser's copy is sent; answered
        // here, and waited for, so it can't land in a later test.
        const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'PUT'
            ? { success: true, tool: 'spy', updatedAt: '2026-10-21T08:00:00.000Z' }
            : { tool: 'spy', doc: null, updatedAt: null }), { status: 200 }));
        vi.stubGlobal('fetch', fetchSpy);
        const { seen, c } = spyTool(TOOL_PERMISSIONS);
        await keep('spy', { v: 1, items: [{ id: 'a', name: 'Ladder', addedAt: '2026-10-01T00:00:00.000Z' }] });
        draw(c, { id: 'spy', screen: 'main', key: null });
        await screen.findByRole('button', { name: 'offer' });
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
        expect(fetchSpy.mock.calls.map(([url, init]) => [String(url).replace(/^.*(\/api\/)/, '$1'), init?.method])).toEqual([['/api/tools/spy', 'GET'], ['/api/tools/spy', 'PUT']]);
        await waitFor(async () => expect((await readToolRecord(OWNER, 'spy'))?.syncedAt).toBe('2026-10-21T08:00:00.000Z'));
        expect(Object.keys(seen.host!).sort()).toEqual(['doc', 'navigate', 'needDoor', 'node', 'nodeCopy', 'now', 'offerDoor', 'owner']);
        expect((seen.host as unknown as { nodeCopy: { on: boolean } }).nodeCopy).toEqual({ on: true });
        for (const absent of ['photos', 'camera', 'place', 'eventDoor', 'deals', 'pricingGuide', 'posts']) {
            expect(absent in seen.host!, absent).toBe(false);
        }
    });

    it("the offer door opens the composer with the tool's draft, held to the composer's fields, and posts nothing", async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const { c } = spyTool(['offer-door']);
        await keep('spy', { v: 1, items: [{ id: 'a', name: 'Ladder', addedAt: '2026-10-01T00:00:00.000Z' }] });
        const { props } = draw(c, { id: 'spy', screen: 'main', key: null });
        fireEvent.click(await screen.findByRole('button', { name: 'offer' }));
        const draft: ComposerDraft = {
            type: 'offer', title: 'Ladder to lend', description: 'Three metres', category: 'tools', credits: 5, priceType: 'daily',
            repeatable: false, cashAlsoNeeded: false,
        };
        expect(props.onComposer).toHaveBeenCalledTimes(1);
        expect(props.onComposer).toHaveBeenCalledWith(draft);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe("a tool's card on Home (Home's default branch)", () => {
    it("its lines from the tool's kept document, worked out here, each opening the tool; with nothing kept, one line that opens it", async () => {
        const onNavigate = vi.fn();
        const card = (now: number) => (
            <ToolHomeCard id="c1" title="New tool" type="tool-scaffold" publicKey={OWNER} now={now} onNavigate={onNavigate}
                tools={[scaffold.manifest]} apps={{ scaffold: scaffold.loader }} />
        );
        const empty = render(card(0));
        fireEvent.click(await screen.findByTestId('home-tool-open'));
        expect(onNavigate).toHaveBeenCalledWith('tool', 'scaffold');
        expect(screen.getByTestId('home-tool-open')).toHaveTextContent('Open New tool');
        empty.unmount();

        await keep('scaffold', scaffold.fixtures.docs.small);
        render(card(0));
        expect(await screen.findByTestId('home-tool-line-0')).toHaveTextContent('Latest: Tent');
        expect(screen.queryByTestId('home-tool-line-1')).toBeNull();
    });

    it('shows updated lines after a store write without a remount', async () => {
        const onNavigate = vi.fn();
        render(
            <ToolHomeCard id="c1" title="New tool" type="tool-scaffold" publicKey={OWNER} now={0} onNavigate={onNavigate}
                tools={[scaffold.manifest]} apps={{ scaffold: scaffold.loader }} />
        );
        expect(await screen.findByTestId('home-tool-open')).toBeInTheDocument();

        // Write a document while the card remains mounted
        await act(async () => {
            await keep('scaffold', scaffold.fixtures.docs.small);
        });

        // The card updates its lines without being remounted
        expect(await screen.findByTestId('home-tool-line-0')).toHaveTextContent('Latest: Tent');
        expect(screen.queryByTestId('home-tool-open')).toBeNull();
    });

    it('a card type this build has no tool for draws nothing (kept, not drawn)', () => {
        const { container } = render(<ToolHomeCard id="c1" title="x" type="tool-garden" publicKey={OWNER} now={0} onNavigate={vi.fn()}
            tools={[scaffold.manifest]} apps={{ scaffold: scaffold.loader }} />);
        expect(container.innerHTML).toBe('');
    });
});

describe('the frame', () => {
    it('an empty tool: the two doors, the examples and guide behind the second, and its Home card offered once', async () => {
        const manifest: ToolManifest = { ...scaffold.manifest, guide: 'lending-and-borrowing' };
        const c = { manifest, loader: scaffold.loader };
        const first = draw(c, { id: 'scaffold', screen: 'main', key: null });
        await first.findByTestId('tool-doors');
        fireEvent.click(screen.getByRole('button', { name: "I'm starting out" }));
        const examples = screen.getByTestId('tool-examples');
        for (const ex of manifest.examples) expect(within(examples).getByText(String(ex))).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Read the guide' }));
        expect(first.props.onGuide).toHaveBeenCalledWith('lending-and-borrowing');
        // Never added by itself: only the member's Add puts it on Home.
        expect(first.props.onAddHomeCard).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('tool-home-add'));
        expect(first.props.onAddHomeCard).toHaveBeenCalledWith('tool-scaffold');
        first.unmount();
        // Once: the next open offers it no more.
        const again = draw(c, { id: 'scaffold', screen: 'main', key: null });
        await again.findByTestId('tool-doors');
        expect(screen.queryByTestId('tool-home-offer')).toBeNull();
    });

    it('"Not now" is an answer too: not offered again, nothing added', async () => {
        const first = draw({ manifest: scaffold.manifest, loader: scaffold.loader }, { id: 'scaffold', screen: 'main', key: null });
        fireEvent.click(await screen.findByTestId('tool-home-no'));
        expect(first.props.onAddHomeCard).not.toHaveBeenCalled();
        first.unmount();
        draw({ manifest: scaffold.manifest, loader: scaffold.loader }, { id: 'scaffold', screen: 'main', key: null });
        await screen.findByTestId('tool-doors');
        expect(screen.queryByTestId('tool-home-offer')).toBeNull();
    });

    it("a kept document: the tool's screen, its state line in the header, and the kept-here sentence in Settings", async () => {
        await keep('scaffold', scaffold.fixtures.docs.small);
        draw({ manifest: scaffold.manifest, loader: scaffold.loader }, { id: 'scaffold', screen: 'main', key: null });
        expect(await screen.findByText('Ladder')).toBeInTheDocument();
        expect(screen.getByTestId('tool-state-line')).toHaveTextContent('Kept here: 2');
        fireEvent.click(screen.getByTestId('tool-menu'));
        fireEvent.click(screen.getByTestId('tool-menu-settings'));
        expect(screen.getByTestId('tool-kept-line')).toHaveTextContent('Kept in this browser');
    });

    it('Remove my data takes the document out of this browser, after a second tap, and the doors are back', async () => {
        await keep('scaffold', scaffold.fixtures.docs.small);
        draw({ manifest: scaffold.manifest, loader: scaffold.loader }, { id: 'scaffold', screen: 'main', key: null });
        await screen.findByText('Ladder');
        fireEvent.click(screen.getByTestId('tool-menu'));
        fireEvent.click(screen.getByTestId('tool-menu-remove'));
        fireEvent.click(screen.getByTestId('tool-remove'));
        expect(await readToolRecord(OWNER, 'scaffold')).not.toBeNull();
        await act(async () => { fireEvent.click(screen.getByTestId('tool-remove-yes')); });
        expect(await screen.findByText('Removed from this browser.')).toBeInTheDocument();
        expect(await readToolRecord(OWNER, 'scaffold')).toBeNull();
        fireEvent.click(screen.getAllByTestId('tools-back')[0]);
        expect(await screen.findByTestId('tool-doors')).toBeInTheDocument();
    });

    // Review of #2274: Remove after "I already do this" left the doors away, over an empty document.
    it('Remove my data after "I already do this" brings the doors back too', async () => {
        draw({ manifest: scaffold.manifest, loader: scaffold.loader }, { id: 'scaffold', screen: 'main', key: null });
        fireEvent.click(await screen.findByTestId('tool-door-already'));
        expect(screen.queryByTestId('tool-doors')).toBeNull();
        fireEvent.click(screen.getByTestId('tool-menu'));
        fireEvent.click(screen.getByTestId('tool-menu-remove'));
        fireEvent.click(screen.getByTestId('tool-remove'));
        await act(async () => { fireEvent.click(screen.getByTestId('tool-remove-yes')); });
        expect(await screen.findByText('Removed from this browser.')).toBeInTheDocument();
        fireEvent.click(screen.getAllByTestId('tools-back')[0]);
        expect(await screen.findByTestId('tool-doors')).toBeInTheDocument();
    });

    // Review of #2274: Back is the stack's (§1.5). A tool opened from the Tools screen went straight past it, closing the page.
    it('Back from a tool opened on the Tools screen goes back to the Tools screen; from one opened anywhere else, closes the page', async () => {
        await keep('scaffold', scaffold.fixtures.docs.small);
        const onClose = vi.fn();
        function Routed({ start }: { start: ToolsPageProps['open'] }) {
            const [open, setOpen] = useState(start);
            return <ToolsPage identity={identity} open={open} onOpen={setOpen} onClose={onClose} onComposer={vi.fn()} onGuide={vi.fn()}
                onAddHomeCard={vi.fn()} tools={[scaffold.manifest]} apps={{ scaffold: scaffold.loader }} />;
        }
        const listed = render(<Routed start={{ id: null, screen: 'main', key: null }} />);
        fireEvent.click(await screen.findByTestId('tools-row-scaffold'));
        expect(await screen.findByText('Ladder')).toBeInTheDocument();
        fireEvent.click(screen.getAllByTestId('tools-back')[0]);
        expect(await screen.findByTestId('tools-shelf-stock')).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        // The Tools screen's own Back closes the page.
        fireEvent.click(screen.getAllByTestId('tools-back')[0]);
        expect(onClose).toHaveBeenCalledTimes(1);
        listed.unmount();

        render(<Routed start={{ id: 'scaffold', screen: 'main', key: null }} />);
        expect(await screen.findByText('Ladder')).toBeInTheDocument();
        fireEvent.click(screen.getAllByTestId('tools-back')[0]);
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(screen.queryByTestId('tools-shelf-stock')).toBeNull();
    });

    it('the Tools screen lists the tool on its shelf with its state line, and opens it at main', async () => {
        await keep('scaffold', scaffold.fixtures.docs.small);
        const { props } = draw({ manifest: scaffold.manifest, loader: scaffold.loader }, { id: null, screen: 'main', key: null });
        const shelf = await screen.findByTestId('tools-shelf-stock');
        const row = within(shelf).getByTestId('tools-row-scaffold');
        await waitFor(() => expect(row).toHaveTextContent('Kept here: 2'));
        fireEvent.click(row);
        expect(props.onOpen).toHaveBeenCalledWith({ id: 'scaffold', screen: 'main', key: null });
    });

    it("a tool's chunk that fails to load says so and tries again; a screen that throws leaves the document alone", async () => {
        let fail = true;
        const loader = vi.fn(async () => { if (fail) throw new Error('offline'); return scaffold.loader(); });
        await keep('scaffold', scaffold.fixtures.docs.small);
        draw({ manifest: scaffold.manifest, loader }, { id: 'scaffold', screen: 'main', key: null });
        expect(await screen.findByTestId('tool-load-failed')).toBeInTheDocument();
        fail = false;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Ladder')).toBeInTheDocument();
        cleanup();

        const Boom = () => { throw new Error('boom'); };
        const broken: WebApp = { id: 'scaffold', screens: () => ({ main: Boom }) };
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        draw({ manifest: scaffold.manifest, loader: async () => ({ default: broken }) }, { id: 'scaffold', screen: 'main', key: null });
        expect(await screen.findByTestId('tool-failed')).toBeInTheDocument();
        quiet.mockRestore();
        expect(JSON.parse((await readToolRecord(OWNER, 'scaffold'))!.body)).toEqual(scaffold.fixtures.docs.small);
    });
});

describe('the node copy, on the page (slice T0.4; node-copy.test.ts runs the rule in two browsers)', () => {
    const PRIVATE = "Kept in this browser, with a private copy on your community's server that only you can read through the app. Like everything on that server, its operator could.";
    const BROWSER_ONLY = 'Kept in this browser, for you only. Nothing of it leaves this browser, and signing out here removes it.';
    const REMOVED = "Your community's server no longer keeps a copy of this tool, so it is kept in this browser only. You can switch the copy on again in Settings.";
    const OLDER = "Your community's server can't keep a copy yet, so for now it stays in this browser only.";
    const FAILED = "Couldn't reach your community's server, so nothing changed. Try again when you're online.";
    const ONE_DEVICE = 'One device at a time: the copy you changed last is the one kept.';
    const SYNCED_AT = '2026-10-21T07:00:00.000Z';
    /** The community's server: the member's own copies, as engine/tool-state.ts keeps them; today's node unless `sendsDeletedAt`. */
    const server = {
        rows: new Map<string, { doc: unknown; updatedAt: string }>(),
        tombs: new Map<string, string>(),
        log: [] as Array<{ method: string; path: string; body?: unknown; kept?: boolean }>,
        mode: 'up' as 'up' | 'down' | 'older',
        sendsDeletedAt: false,
        clock: Date.parse('2026-10-21T08:00:00.000Z'),
    };
    let kept: Case;
    beforeEach(() => {
        server.rows.clear(); server.tombs.clear(); server.log.length = 0; server.mode = 'up'; server.sendsDeletedAt = false;
        localStorage.setItem('bp_node_url', 'https://mullum.example');
        kept = { manifest: { ...scaffold.manifest, id: 'kept', permissions: ['node-copy'] }, fixtures: scaffold.fixtures, loader: scaffold.loader };
        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            const path = new URL(url).pathname;
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            server.log.push({ method, path, body, kept: !!(await readToolRecord(OWNER, 'kept')) });
            if (server.mode === 'down') throw new TypeError('Failed to fetch');
            const m = /^\/api\/tools\/([a-z0-9-]+)$/.exec(path);
            if (server.mode === 'older' || !m) return new Response('Not Found', { status: 404 });
            const tool = m[1];
            const row = server.rows.get(tool);
            const now = (server.clock += 1000);
            let json: unknown;
            if (method === 'GET') json = { tool, doc: row?.doc ?? null, updatedAt: row?.updatedAt ?? null, ...(server.sendsDeletedAt ? { deletedAt: row ? null : server.tombs.get(tool) ?? null } : {}) };
            else if (method === 'PUT') {
                const updatedAt = new Date(now).toISOString();
                server.rows.set(tool, { doc: body.doc, updatedAt });
                json = { success: true, tool, updatedAt };
            } else {
                if (row) { server.rows.delete(tool); server.tombs.set(tool, new Date(now).toISOString()); }
                json = { success: true, tool, removed: !!row };
            }
            return new Response(JSON.stringify(json), { status: 200 });
        });
    });
    /** This browser holds `doc`, synced with the server's copy of it. */
    async function keptAndSynced(doc: unknown) {
        expect(await writeToolRecord(OWNER, 'kept', { body: JSON.stringify(doc), updatedAt: SYNCED_AT, syncedAt: SYNCED_AT })).toBe(true);
        server.rows.set('kept', { doc, updatedAt: SYNCED_AT });
    }
    const settled = () => waitFor(() => expect(server.log.length).toBeGreaterThan(0));
    async function settings(view: ReturnType<typeof draw>) {
        fireEvent.click(await view.findByTestId('tool-menu'));
        await act(async () => { fireEvent.click(view.getByTestId('tool-menu-settings')); });
    }

    it("the open takes the server's copy (a first open in this browser) and draws it", async () => {
        server.rows.set('kept', { doc: scaffold.fixtures.docs.small, updatedAt: SYNCED_AT });
        const view = draw(kept, { id: 'kept', screen: 'main', key: null });
        expect(await view.findByText('Ladder')).toBeInTheDocument();
        expect(view.queryByTestId('tool-doors')).toBeNull();
        expect(JSON.parse((await readToolRecord(OWNER, 'kept'))!.body)).toEqual(scaffold.fixtures.docs.small);
        await settings(view);
        expect(view.getByTestId('tool-kept-line')).toHaveTextContent(PRIVATE);
        expect(view.getByTestId('tool-node-copy')).toHaveAttribute('aria-checked', 'true');
        expect(view.getByTestId('tool-node-copy-note')).toHaveTextContent(ONE_DEVICE);
        expect(server.log.map((r) => r.method)).toEqual(['GET']);
    });

    for (const [name, deletedAt] of [['S2.1 says when', true], ["today's node says none", false]] as const) {
        it(`switched off in another browser (${name}): the line once, in xx at 320 px × 1.3, axe clean; nothing sent; the copy here kept`, async () => {
            await showIn('xx');
            await keptAndSynced(scaffold.fixtures.docs.small);
            server.rows.clear();
            server.tombs.set('kept', '2026-10-21T07:30:00.000Z');
            server.sendsDeletedAt = deletedAt;
            const view = draw(kept, { id: 'kept', screen: 'main', key: null });
            const page = await view.findByTestId('tools-page');
            expect(await view.findByTestId('tool-copy-removed')).toHaveTextContent(xx(REMOVED));
            const others = memberText(scaffold.fixtures.docs.small);
            expect(bypassing(page, { others })).toEqual([]);
            expect(layoutProblems(page)).toEqual([]);
            expect(await axeProblems(page)).toEqual([]);
            await settings(view);
            expect(view.getByTestId('tool-kept-line')).toHaveTextContent(xx(REMOVED));
            expect(view.getByTestId('tool-node-copy')).toHaveAttribute('aria-checked', 'false');
            expect(bypassing(page)).toEqual([]);
            expect(layoutProblems(page)).toEqual([]);
            expect(await axeProblems(page)).toEqual([]);
            expect(server.log.map((r) => r.method)).toEqual(['GET']);
            expect(await readToolSettings(OWNER, 'kept')).toEqual({ nodeCopy: false });
            expect(JSON.parse((await readToolRecord(OWNER, 'kept'))!.body)).toEqual(scaffold.fixtures.docs.small);
            view.unmount();
            // Once: the next open asks nothing and says this browser only.
            const again = draw(kept, { id: 'kept', screen: 'main', key: null });
            await again.findByText(/Ladder/);
            expect(again.queryByTestId('tool-copy-removed')).toBeNull();
            await settings(again);
            expect(again.getByTestId('tool-kept-line')).toHaveTextContent(xx(BROWSER_ONLY));
            expect(server.log.map((r) => r.method)).toEqual(['GET']);
        });
    }

    it('an older server: its line where it is kept and under the toggle, in xx, and a tool without node-copy has no toggle', async () => {
        await showIn('xx');
        server.mode = 'older';
        await keptAndSynced(scaffold.fixtures.docs.small);
        const view = draw(kept, { id: 'kept', screen: 'main', key: null });
        await settled();
        await settings(view);
        await waitFor(() => expect(view.getByTestId('tool-kept-line')).toHaveTextContent(xx(OLDER)));
        expect(view.getByTestId('tool-node-copy-note')).toHaveTextContent(xx(OLDER));
        const page = view.getByTestId('tools-page');
        expect(bypassing(page)).toEqual([]);
        expect(layoutProblems(page)).toEqual([]);
        expect(await axeProblems(page)).toEqual([]);
        view.unmount();
        await keep('scaffold', scaffold.fixtures.docs.small);
        const plain = draw(cases[cases.length - 1], { id: 'scaffold', screen: 'main', key: null });
        await settings(plain);
        expect(plain.queryByTestId('tool-node-copy')).toBeNull();
        expect(plain.getByTestId('tool-kept-line')).toHaveTextContent(xx(BROWSER_ONLY));
    });

    it("the toggle: while the server can't be reached it stays and says so; then off is one DELETE, and on a GET and a PUT", async () => {
        await showIn('xx');
        await keptAndSynced(scaffold.fixtures.docs.small);
        const view = draw(kept, { id: 'kept', screen: 'main', key: null });
        await settled();
        await settings(view);
        const toggle = view.getByTestId('tool-node-copy');
        server.mode = 'down';
        await act(async () => { fireEvent.click(toggle); });
        expect(await view.findByTestId('tool-node-copy-failed')).toHaveTextContent(xx(FAILED));
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        expect(await readToolSettings(OWNER, 'kept')).toEqual({});
        const page = view.getByTestId('tools-page');
        expect(bypassing(page)).toEqual([]);
        expect(layoutProblems(page)).toEqual([]);
        expect(await axeProblems(page)).toEqual([]);

        server.mode = 'up';
        server.log.length = 0;
        await act(async () => { fireEvent.click(toggle); });
        await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
        expect(server.log.map((r) => r.method)).toEqual(['DELETE']);
        expect(view.queryByTestId('tool-node-copy-failed')).toBeNull();
        expect(view.getByTestId('tool-kept-line')).toHaveTextContent(xx(BROWSER_ONLY));
        expect(await readToolSettings(OWNER, 'kept')).toEqual({ nodeCopy: false });
        expect(server.rows.has('kept')).toBe(false);

        server.log.length = 0;
        await act(async () => { fireEvent.click(toggle); });
        await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
        expect(server.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
        expect(server.log[1].body).toEqual({ doc: scaffold.fixtures.docs.small });
        expect(view.getByTestId('tool-kept-line')).toHaveTextContent(xx(PRIVATE));
        expect(await readToolSettings(OWNER, 'kept')).toEqual({ nodeCopy: true });
    });

    it('Remove my data with the copy on: the words say the server copy goes too; the server first, or nothing', async () => {
        await keptAndSynced(scaffold.fixtures.docs.small);
        const view = draw(kept, { id: 'kept', screen: 'main', key: null });
        await view.findByText('Ladder');
        await settled();
        fireEvent.click(view.getByTestId('tool-menu'));
        fireEvent.click(view.getByTestId('tool-menu-remove'));
        expect(view.getByTestId('tool-settings')).toHaveTextContent(
            "Takes this community's data for New tool out of this browser, and its copy on your community's server. Another device signed in as you keeps what it has and stops sending it. The same tool in another community keeps its own. It can't be undone.");
        server.mode = 'down';
        fireEvent.click(view.getByTestId('tool-remove'));
        await act(async () => { fireEvent.click(view.getByTestId('tool-remove-yes')); });
        expect(await view.findByText(FAILED)).toBeInTheDocument();
        expect(await readToolRecord(OWNER, 'kept')).not.toBeNull();
        expect(await readToolSettings(OWNER, 'kept')).toEqual({});

        server.mode = 'up';
        server.log.length = 0;
        fireEvent.click(view.getByTestId('tool-remove'));
        await act(async () => { fireEvent.click(view.getByTestId('tool-remove-yes')); });
        expect(await view.findByText('Removed from this browser.')).toBeInTheDocument();
        // The DELETE went while this browser still held the document.
        expect(server.log.map((r) => [r.method, r.kept])).toEqual([['DELETE', true]]);
        expect(await readToolRecord(OWNER, 'kept')).toBeNull();
        expect(await readToolSettings(OWNER, 'kept')).toEqual({ nodeCopy: false });
        expect(view.getByTestId('tool-kept-line')).toHaveTextContent(BROWSER_ONLY);
        fireEvent.click(view.getAllByTestId('tools-back')[0]);
        expect(await view.findByTestId('tool-doors')).toBeInTheDocument();
    });

    it("a write through the tool's host: one sync five seconds after the last, not one a write", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        try {
            let n = 0;
            const Writes = ({ host }: AnyToolScreenProps) => {
                const h = host as unknown as { doc: { get(): { v: number; items: unknown[] }; set(d: unknown): Promise<void> } };
                return <button type="button" onClick={() => { const d = h.doc.get(); void h.doc.set({ ...d, items: [...d.items, { id: `i${++n}`, name: `Thing ${n}`, addedAt: '2026-10-21T09:00:00.000Z' }] }); }}>add</button>;
            };
            const app: WebApp = { id: 'kept', screens: () => ({ main: Writes }) };
            await keptAndSynced(scaffold.fixtures.docs.small);
            const view = draw({ manifest: kept.manifest, loader: async () => ({ default: app }) }, { id: 'kept', screen: 'main', key: null });
            const add = await view.findByRole('button', { name: 'add' });
            await settled();
            server.log.length = 0;
            for (let i = 0; i < 4; i++) await act(async () => { fireEvent.click(add); });
            await act(async () => { await vi.advanceTimersByTimeAsync(100); });
            expect(server.log).toEqual([]);
            await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
            await waitFor(() => expect(server.log.map((r) => r.method)).toEqual(['GET', 'PUT']));
            expect((server.rows.get('kept')!.doc as { items: Array<{ name: string }> }).items.map((i) => i.name)).toEqual(['Ladder', 'Tent', 'Thing 1', 'Thing 2', 'Thing 3', 'Thing 4']);
        } finally {
            vi.useRealTimers();
        }
    });
});
