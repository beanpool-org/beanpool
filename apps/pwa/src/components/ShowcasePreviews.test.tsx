/**
 * The web previews (components/ShowcasePreviews.tsx, LocalCommunityMark.tsx; DESIGN-global-showcase-fable.md §2, §6 W2):
 * no number from Example Valley may reach the node. Proven three ways here: every request a preview makes, through every
 * action and the sheet, is the node's info and nothing else, and none is a write; the marker never looks locked; and
 * only ShowcasePreviews.tsx imports the sample.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, SAMPLE_COMMUNITY } from '@beanpool/core';
import { CommonsPreview, DealsPreviewDialog, LedgerPreview } from './ShowcasePreviews';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { modeFor } from '../lib/features';
import type { CommunityInfo } from '../lib/api';

const GLOBAL_INFO = {
    name: 'A worldwide community', profile: 'global', commonsBalance: 0,
    features: { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true },
    startCommunityUrl: 'https://example.org/start',
} as unknown as CommunityInfo;

let calls: { url: string; method: string }[] = [];

beforeEach(() => {
    calls = [];
    resetCommunityInfoOnce();
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
        return new Response(JSON.stringify(GLOBAL_INFO), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Every request so far: the node's info only, and never a write. */
function onlyInfo() {
    expect(calls.every(c => c.method === 'GET')).toBe(true);
    expect(calls.every(c => new URL(c.url, 'http://x').pathname === '/api/community/info')).toBe(true);
}

describe('preview mode asks the node for its info and nothing else, and writes nothing', () => {
    it('Ledger: the strip, its ✕ and back, every action, the sheet and its ways forward', async () => {
        const onNearYou = vi.fn();
        const onGuide = vi.fn();
        render(<LedgerPreview onNearYou={onNearYou} onGuide={onGuide} />);
        expect(screen.getByTestId('sample-balance')).toHaveTextContent(`${SAMPLE_COMMUNITY.balance} Beans`);
        expect(screen.getByText(LOCAL_COMMUNITY_STRIP.header)).toBeInTheDocument();
        expect(screen.getByTestId('sample-transactions').querySelectorAll('li')).toHaveLength(SAMPLE_COMMUNITY.transactions.length);

        for (const name of ['Send Beans', 'Export']) {
            fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
            const sheet = await screen.findByTestId('local-community-sheet');
            expect(sheet).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.beans);
            expect(sheet).toHaveTextContent(LOCAL_COMMUNITY_SHEET.common);
            // Start a community opens the in-app Start screen, whose link is the node's own start link.
            fireEvent.click(screen.getByTestId('local-community-start'));
            await waitFor(() => expect(screen.getByTestId('start-community-run-a-node')).toHaveAttribute('href', 'https://example.org/start'));
            fireEvent.click(screen.getByRole('button', { name: 'Back' }));
            expect(screen.queryByTestId('start-community-screen')).toBeNull();
        }
        fireEvent.click(screen.getByTestId('local-community-strip-start'));
        expect(await screen.findByTestId('start-community-screen')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        fireEvent.click(screen.getByRole('button', { name: /Send Beans/ }));
        fireEvent.click(await screen.findByTestId('local-community-guide'));
        expect(onGuide).toHaveBeenCalledWith(LOCAL_COMMUNITY_SHEET.guide.beans);
        fireEvent.click(screen.getByRole('button', { name: /Export/ }));
        fireEvent.click(await screen.findByTestId('local-community-near-you'));
        expect(onNearYou).toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('local-community-strip-close'));
        expect(screen.getByTestId('local-community-strip-collapsed')).toHaveTextContent(LOCAL_COMMUNITY_STRIP.collapsed);
        fireEvent.click(screen.getByText(LOCAL_COMMUNITY_STRIP.collapsed));
        expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));

        expect(calls.length).toBeGreaterThan(0);
        onlyInfo();
    });

    it('Commons: pool, enterprise and Decision; Pledge, Pause and Vote open the sheet', async () => {
        render(<CommonsPreview />);
        expect(screen.getByTestId('sample-enterprise')).toHaveTextContent(SAMPLE_COMMUNITY.enterprises[0].name);
        expect(screen.getByTestId('sample-decision')).toHaveTextContent(SAMPLE_COMMUNITY.decisions[0].question);
        for (const [name, feature] of [['Pledge', 'enterprises'], ['Pause', 'enterprises'], ['Vote', 'decisions']] as const) {
            fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
            expect(await screen.findByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features[feature]);
            fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        }
        onlyInfo();
    });

    it('My Deals: two sample deals; Approve and release opens the sheet', async () => {
        render(<DealsPreviewDialog onClose={() => {}} />);
        expect(screen.getAllByText(/Beans$/).length).toBeGreaterThanOrEqual(SAMPLE_COMMUNITY.deals.length);
        fireEvent.click(screen.getByRole('button', { name: /Approve and release/ }));
        expect(await screen.findByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.escrow);
        onlyInfo();
    });
});

describe('the marker never looks locked', () => {
    it('no lock, no greying, no reduced opacity, no tier colour, and Beans never Ʀ', () => {
        const { container } = render(<><LedgerPreview /><CommonsPreview /><DealsPreviewDialog onClose={() => {}} /></>);
        const html = container.innerHTML;
        expect(html).not.toMatch(/🔒|Locked|locked|Ʀ/);
        expect(html).not.toMatch(/opacity-(?:[1-6]0)|grayscale|cursor-not-allowed|\bamber-|\bred-/);
        for (const el of Array.from(container.querySelectorAll('[data-testid="local-community-action"]'))) {
            expect(el).not.toBeDisabled();
        }
    });
});

describe('modes from the node\'s info', () => {
    it('preview on a showcase node with the feature off; hidden with no info or no showcase; live where it is on', () => {
        expect(modeFor('beans', GLOBAL_INFO)).toBe('preview');
        expect(modeFor('beans', null)).toBe('hidden');
        expect(modeFor('beans', { ...GLOBAL_INFO, features: { beans: false } } as CommunityInfo)).toBe('hidden');
        expect(modeFor('beans', { ...GLOBAL_INFO, features: {} } as CommunityInfo)).toBe('live');
    });
});

describe('the sample is imported by one web file only', () => {
    it('ShowcasePreviews.tsx and its own test are the only files under src that name SAMPLE_COMMUNITY or the fixture', () => {
        const root = join(__dirname, '..');
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) walk(p);
                else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) files.push(p);
            }
        };
        walk(root);
        expect(files.length).toBeGreaterThan(100);
        const naming = files
            .filter(f => /SAMPLE_COMMUNITY|sample-community|SampleTransaction|SampleDeal|SampleEnterprise|SampleDecision/.test(readFileSync(f, 'utf8')))
            .map(f => relative(root, f))
            .sort();
        expect(naming).toEqual(['components/ShowcasePreviews.test.tsx', 'components/ShowcasePreviews.tsx']);
    });
});

describe('the marker inside a tappable card', () => {
    it('a line opens the sheet and neither it nor the sheet reaches the card; the deal action keeps its words, with the pill', async () => {
        const { LocalCommunityLine, LocalCommunityAction, DEAL_ACTION_LABEL } = await import('./LocalCommunityMark');
        const card = vi.fn();
        render(
            <div onClick={card}>
                <LocalCommunityLine feature="decisions" text="🏘️ In a local community a Decision binds ›" />
                <LocalCommunityAction feature="escrow" label={DEAL_ACTION_LABEL} />
            </div>,
        );
        fireEvent.click(screen.getByTestId('local-community-line'));
        const sheet = screen.getByTestId('local-community-sheet');
        fireEvent.click(sheet);
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(card).not.toHaveBeenCalled();
        expect(DEAL_ACTION_LABEL).toBe('Request · Beans held safely');
        const action = screen.getByTestId('local-community-action');
        expect(action.textContent).toContain('Request · Beans held safely');
        expect(action.querySelector('[data-testid="local-community-pill"]')).not.toBeNull();
        fireEvent.click(action);
        expect(card).not.toHaveBeenCalled();
        expect(screen.getByTestId('local-community-sheet').textContent).toContain(LOCAL_COMMUNITY_SHEET.features.escrow);
        onlyInfo();
    });
});
