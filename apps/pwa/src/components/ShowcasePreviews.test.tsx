/**
 * The web previews (components/ShowcasePreviews.tsx, LocalCommunityMark.tsx; DESIGN-global-showcase-fable.md §2, §6 W2):
 * no number from Example Valley may reach the node. Proven three ways here: every request a preview makes, through every
 * action and the sheet, is the node's info and nothing else, and none is a write; the marker never looks locked; and
 * only ShowcasePreviews.tsx imports the sample. The Ledger in preview is the real LedgerPage drawn from the sample
 * (design §1 row 3), so it is rendered here whole, both tabs, with the real api module under the fetch spy.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, SAMPLE_COMMUNITY, TIER_LEVELS } from '@beanpool/core';
import { CommonsPreview, DealsPreviewDialog } from './ShowcasePreviews';
import { LedgerPage } from '../pages/LedgerPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { modeFor } from '../lib/features';
import type { CommunityInfo } from '../lib/api';

const GLOBAL_INFO = {
    name: 'A worldwide community', profile: 'global', commonsBalance: 0,
    features: { beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true },
    startCommunityUrl: 'https://example.org/start',
} as unknown as CommunityInfo;

/** A member's own key on the worldwide community: in preview the Ledger never asks about it. */
const MEMBER: BeanPoolIdentity = { publicKey: 'real-member-key', privateKey: 'real-member-private', callsign: 'RealMember', createdAt: '2026-10-01T00:00:00.000Z' };
const S = SAMPLE_COMMUNITY;

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
    for (const [who, identity] of [['a member', MEMBER], ['a visitor with no key (the lobby)', null]] as const) {
        it(`Ledger, ${who}: the strip, its ✕ and back, both tabs, every action, the sheet and its ways forward`, async () => {
            const onNearYou = vi.fn();
            const onGuide = vi.fn();
            render(<LedgerPage identity={identity} isMember={identity !== null} preview onNearYou={onNearYou} onGuide={onGuide} />);
            expect(screen.getByTestId('ledger-balance')).toHaveTextContent(`+${S.balance.toFixed(1)}B`);
            expect(screen.getByText(LOCAL_COMMUNITY_STRIP.header)).toBeInTheDocument();
            expect(screen.queryByText('RealMember')).toBeNull();

            // Levels: Send Beans is the marker's action; then the Wallet: Send Beans and Export mine.
            const actions = () => screen.getAllByTestId('local-community-action');
            const press = async (name: RegExp) => {
                fireEvent.click(screen.getByRole('button', { name }));
                const sheet = await screen.findByTestId('local-community-sheet');
                expect(sheet).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.beans);
                expect(sheet).toHaveTextContent(LOCAL_COMMUNITY_SHEET.common);
            };
            expect(actions()).toHaveLength(1);
            await press(/^Send Beans/);
            // Start a community opens the in-app Start screen, whose link is the node's own start link.
            fireEvent.click(screen.getByTestId('local-community-start'));
            await waitFor(() => expect(screen.getByTestId('start-community-run-a-node')).toHaveAttribute('href', 'https://example.org/start'));
            fireEvent.click(screen.getByRole('button', { name: 'Back' }));
            expect(screen.queryByTestId('start-community-screen')).toBeNull();

            fireEvent.click(screen.getByRole('button', { name: /Wallet/ }));
            expect(screen.getByTestId('ledger-wallet')).toBeInTheDocument();
            expect(actions()).toHaveLength(2);
            for (const name of [/^Send Beans/, /^Export mine/]) {
                await press(name);
                fireEvent.click(screen.getByRole('button', { name: 'Close' }));
            }
            await press(/^Send Beans/);
            fireEvent.click(await screen.findByTestId('local-community-guide'));
            expect(onGuide).toHaveBeenCalledWith(LOCAL_COMMUNITY_SHEET.guide.beans);
            await press(/^Export mine/);
            fireEvent.click(await screen.findByTestId('local-community-near-you'));
            expect(onNearYou).toHaveBeenCalled();
            // No send form, no member picker: the member's own Send never opens here.
            expect(screen.queryByPlaceholderText('Amount (B)')).toBeNull();
            expect(screen.queryByText('Select recipient...')).toBeNull();
            // The explainers stay live: the Commons pool opens its modal with the sample's pool.
            fireEvent.click(screen.getByRole('button', { name: /Commons Pool/ }));

            fireEvent.click(screen.getByTestId('local-community-strip-start'));
            expect(await screen.findByTestId('start-community-screen')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Back' }));
            fireEvent.click(screen.getByTestId('local-community-strip-close'));
            expect(screen.getByTestId('local-community-strip-collapsed')).toHaveTextContent(LOCAL_COMMUNITY_STRIP.collapsed);
            fireEvent.click(screen.getByText(LOCAL_COMMUNITY_STRIP.collapsed));
            expect(await screen.findByTestId('local-community-sheet')).toBeInTheDocument();
            fireEvent.click(screen.getByRole('button', { name: 'Close' }));

            // Let anything the page started land, then: the node's info only, and nothing about anyone's ledger.
            await new Promise(r => setTimeout(r, 20));
            expect(calls.some(c => /\/api\/(ledger|members|community\/me|repay)/.test(c.url))).toBe(false);
            onlyInfo();
        });
    }

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

    it('Commons, each part by its own feature: enterprises alone, or the Decision alone under the Decisions strip', () => {
        const { unmount } = render(<CommonsPreview enterprises decisions={false} />);
        expect(screen.getByTestId('sample-enterprise')).toBeInTheDocument();
        expect(screen.queryByTestId('sample-decision')).toBeNull();
        unmount();
        const second = render(<CommonsPreview enterprises={false} decisions />);
        expect(screen.getByTestId('sample-decision')).toBeInTheDocument();
        expect(screen.queryByTestId('sample-enterprise')).toBeNull();
        expect(screen.getByTestId('local-community-strip')).toHaveTextContent(LOCAL_COMMUNITY_STRIP.lead.decisions);
        expect(screen.getByTestId('local-community-strip')).toHaveTextContent(LOCAL_COMMUNITY_STRIP.body.decisions);
        second.unmount();
        const { container } = render(<CommonsPreview enterprises={false} decisions={false} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('My Deals: two sample deals; Approve and release opens the sheet', async () => {
        render(<DealsPreviewDialog onClose={() => {}} />);
        expect(screen.getAllByText(/Beans$/).length).toBeGreaterThanOrEqual(SAMPLE_COMMUNITY.deals.length);
        fireEvent.click(screen.getByRole('button', { name: /Approve and release/ }));
        expect(await screen.findByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.escrow);
        onlyInfo();
    });
});

describe('the Ledger in preview is the member\'s real screen, drawn from Example Valley', () => {
    const tier = TIER_LEVELS[S.level - 1];
    const next = TIER_LEVELS[S.level];

    it('Levels: the example member with their tier chip and balance, the credit bar, level 2 of 4 with the sample\'s trust, the four tiles', () => {
        render(<LedgerPage identity={MEMBER} preview />);
        expect(screen.getByTestId('sample-header')).toHaveTextContent(`${S.name} · ${S.member}`);
        expect(screen.getByRole('heading', { name: S.member })).toBeInTheDocument();
        expect(screen.getAllByText(tier.name).length).toBeGreaterThanOrEqual(2);
        expect(screen.getByTestId('ledger-balance')).toHaveTextContent(`+${S.balance.toFixed(1)}B`);
        // The credit bar, as a member's: zero the sweet spot, the fee-free ceiling above it.
        expect(screen.getByText('sweet spot')).toBeInTheDocument();
        expect(screen.getByText('fee-free')).toBeInTheDocument();
        expect(screen.getByText(`Level ${S.level} of ${S.levels} · ${S.trust} trust`)).toBeInTheDocument();
        expect(document.body.textContent).toContain(`${next.minCredit - S.trust} more trust to ${next.emoji} ${next.name}`);
        const tiles = within(screen.getByTestId('levels-shelf')).getAllByRole('button');
        expect(tiles.map(b => b.textContent)).toEqual(TIER_LEVELS.map((l, i) =>
            `${l.emoji}${l.name}${i === S.level - 1 ? "You're here" : i < S.level - 1 ? 'Reached' : `${l.minCredit} trust`}`));
        const builders = screen.getByTestId('trust-builders');
        expect(builders).toHaveTextContent(String(S.valueTraded));
        expect(builders).toHaveTextContent(`+${S.trust} trust`);
        expect(builders).toHaveTextContent(String(S.partners));
        expect(builders).toHaveTextContent(S.rating.toFixed(1));
        expect(builders).toHaveTextContent(`${S.reviews} reviews`);
    });

    it('Wallet: the floor, the Commons pool, and the six recent rows with who each was with and when', () => {
        render(<LedgerPage identity={MEMBER} preview />);
        fireEvent.click(screen.getByRole('button', { name: /Wallet/ }));
        const wallet = screen.getByTestId('ledger-wallet');
        expect(wallet).toHaveTextContent(`Overdraft Floor${S.floor}`);
        expect(wallet).toHaveTextContent(S.pool.toFixed(1));
        for (const tx of S.transactions) {
            expect(wallet).toHaveTextContent(tx.what);
            expect(wallet).toHaveTextContent(`${tx.amount < 0 ? '−' : '+'}${Math.abs(tx.amount).toFixed(1)}`);
        }
        expect(wallet).toHaveTextContent('from a neighbour · yesterday');
        expect(wallet).toHaveTextContent('to the Example Valley Bakery · 12 days ago');
        // No circulation fee row: the Wallet itself says nothing goes to the Commons at 200 Beans or less, and the sample holds 85.
        expect(wallet).not.toHaveTextContent('Circulation fee');
        expect(wallet).not.toHaveTextContent('to the Commons ·');
        expect(wallet).not.toHaveTextContent('No transactions yet');
    });
});

describe('the marker never looks locked', () => {
    it('no lock, no greying, no reduced opacity, no tier colour, and Beans never Ʀ', () => {
        const { container } = render(<><CommonsPreview /><DealsPreviewDialog onClose={() => {}} /></>);
        const html = container.innerHTML;
        expect(html).not.toMatch(/🔒|Locked|locked|Ʀ/);
        expect(html).not.toMatch(/opacity-(?:[1-6]0)|grayscale|cursor-not-allowed|\bamber-|\bred-/);
        for (const el of Array.from(container.querySelectorAll('[data-testid="local-community-action"]'))) {
            expect(el).not.toBeDisabled();
        }
    });

    it('the Ledger in preview, both tabs: Send is the marker, never a lock, never disabled; nothing reads tier-locked', () => {
        const { container } = render(<LedgerPage identity={MEMBER} preview />);
        const check = () => {
            const html = container.innerHTML;
            expect(html).not.toMatch(/🔒|Locked|locked|needs 1st trade|needs \+ve balance|Ʀ/);
            expect(html).not.toMatch(/grayscale|cursor-not-allowed/);
            for (const el of Array.from(container.querySelectorAll('button'))) expect(el).not.toBeDisabled();
            for (const el of Array.from(container.querySelectorAll('[data-testid="local-community-action"]'))) {
                expect(el.className).not.toMatch(/opacity|amber|red-|grayscale/);
            }
        };
        check();
        fireEvent.click(screen.getByRole('button', { name: /Wallet/ }));
        check();
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

describe('the strip\'s ✕ is remembered, per node and feature, in this browser', () => {
    it('collapsed, it stays one line when the screen is drawn again; ▾ opens it for good; another feature\'s strip stays open', async () => {
        const { LocalCommunityStrip } = await import('./LocalCommunityMark');
        const key = (f: string) => `bp_local_strip_collapsed:${window.location.host}:${f}`;
        const first = render(<LocalCommunityStrip feature="beans" />);
        fireEvent.click(screen.getByTestId('local-community-strip-close'));
        expect(localStorage.getItem(key('beans'))).toBe('1');
        first.unmount();

        const again = render(<LocalCommunityStrip feature="beans" />);
        expect(screen.getByTestId('local-community-strip-collapsed')).toHaveTextContent(LOCAL_COMMUNITY_STRIP.collapsed);
        expect(screen.queryByTestId('local-community-strip')).toBeNull();
        again.unmount();

        const other = render(<LocalCommunityStrip feature="escrow" />);
        expect(screen.getByTestId('local-community-strip')).toBeInTheDocument();
        other.unmount();

        const reopened = render(<LocalCommunityStrip feature="beans" />);
        fireEvent.click(screen.getByTestId('local-community-strip-open'));
        expect(screen.getByTestId('local-community-strip')).toBeInTheDocument();
        expect(localStorage.getItem(key('beans'))).toBeNull();
        reopened.unmount();
        render(<LocalCommunityStrip feature="beans" />);
        expect(screen.getByTestId('local-community-strip')).toBeInTheDocument();
        onlyInfo();
    });
});
