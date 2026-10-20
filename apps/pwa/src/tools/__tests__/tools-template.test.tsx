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
import { writeToolRecord, readToolRecord, resetToolStoreForTest } from '../store';
import type { ComposerDraft } from '../host';
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

    it('every permission at once: the web grants only the doors it has built; the rest are absent, not undefined', async () => {
        const { seen, c } = spyTool(TOOL_PERMISSIONS);
        await keep('spy', { v: 1, items: [{ id: 'a', name: 'Ladder', addedAt: '2026-10-01T00:00:00.000Z' }] });
        draw(c, { id: 'spy', screen: 'main', key: null });
        await screen.findByRole('button', { name: 'offer' });
        expect(Object.keys(seen.host!).sort()).toEqual(['doc', 'navigate', 'needDoor', 'node', 'now', 'offerDoor', 'owner']);
        for (const absent of ['photos', 'camera', 'place', 'eventDoor', 'deals', 'pricingGuide', 'posts', 'nodeCopy']) {
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
