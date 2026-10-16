/**
 * The web previews (components/ShowcasePreviews.tsx, LocalCommunityMark.tsx; DESIGN-global-showcase-fable.md §2, §6 W2):
 * no number from Example Valley may reach the node. Proven three ways here: every request a preview makes, through every
 * action and the sheet, is the node's info and nothing else, and none is a write; the marker never looks locked; and
 * only ShowcasePreviews.tsx imports the sample. The Ledger in preview is the real LedgerPage drawn from the sample
 * (design §1 row 3), so it is rendered here whole, both tabs, with the real api module under the fetch spy.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_COMMUNITY_SHEET, LOCAL_COMMUNITY_STRIP, SAMPLE_COMMUNITY, TIER_LEVELS } from '@beanpool/core';
import { CommonsPreview, sampleDealChip, sampleInvites, sampleInviteTree, sampleDecisions, samplePoolVoting, sampleCommonsBalance } from './ShowcasePreviews';
import { MyDealsModal } from './MyDealsModal';
import { LedgerPage } from '../pages/LedgerPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { modeFor } from '../lib/features';
import type { CommunityInfo } from '../lib/api';
import { formatInviteCode, normaliseInviteCode } from '../lib/invite-code';

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

    it('Commons: pool, enterprise and project, no Decision card; Pledge and Pause open the sheet', async () => {
        render(<CommonsPreview />);
        expect(screen.getByTestId('sample-enterprise')).toHaveTextContent(SAMPLE_COMMUNITY.enterprises[0].name);
        expect(screen.getByTestId('sample-project')).toHaveTextContent(SAMPLE_COMMUNITY.projects[0].title);
        expect(screen.queryByTestId('sample-decision')).toBeNull();
        for (const [name, feature] of [['Pledge', 'enterprises'], ['Pause', 'enterprises']] as const) {
            fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
            expect(await screen.findByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features[feature]);
            fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        }
        onlyInfo();
    });

    it('Commons: the enterprise and the project are the list\'s real cards fed the sample, each once, each marked, each opening its page (review of #2063, B2, N3)', async () => {
        const onOpenEnterprise = vi.fn();
        const { container } = render(<CommonsPreview onOpenEnterprise={onOpenEnterprise} />);
        const e = SAMPLE_COMMUNITY.enterprises[0];
        const p = SAMPLE_COMMUNITY.projects[0];
        const cards = screen.getAllByTestId('sample-enterprise-card');
        expect(cards).toHaveLength(2);
        // Under the strip and the Example header, in that order.
        const order = Array.from(container.querySelectorAll('[data-testid="local-community-strip"], [data-testid="sample-header"], [data-testid="sample-enterprise-card"]')).map(el => el.getAttribute('data-testid'));
        expect(order).toEqual(['local-community-strip', 'sample-header', 'sample-enterprise-card', 'sample-enterprise-card']);
        for (const card of cards) expect(within(card).getByTestId('local-community-pill')).toBeInTheDocument();
        expect(container.textContent?.split(e.name).length).toBe(2);
        expect(container.textContent?.split(p.title).length).toBe(2);
        // The numbers are the sample's, as the real card draws them.
        expect(cards[0]).toHaveTextContent(`${e.liveOffers} live offer`);
        expect(cards[0]).toHaveTextContent(`${e.balance} 🫘`);
        expect(cards[1]).toHaveTextContent(`${p.pledged} 🫘 raised of ${p.goal} 🫘`);
        // Each opens the real page in preview, by mouse and by keyboard.
        fireEvent.click(cards[0]);
        expect(onOpenEnterprise).toHaveBeenLastCalledWith(e.id);
        fireEvent.keyDown(cards[1], { key: 'Enter' });
        expect(onOpenEnterprise).toHaveBeenLastCalledWith(p.id);
        fireEvent.keyDown(cards[0], { key: ' ' });
        expect(onOpenEnterprise).toHaveBeenCalledTimes(3);
        expect(cards.every(c => c.getAttribute('role') === 'button' && c.tabIndex === 0)).toBe(true);
        onlyInfo();
    });

    it('Commons, by its own feature: enterprises off draws nothing (Decide is the real screen now, DecideSection.test.tsx)', () => {
        const { container } = render(<CommonsPreview enterprises={false} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('sampleDecisions, samplePoolVoting, and sampleCommonsBalance match the sample community', () => {
        const decisions = sampleDecisions();
        expect(decisions).toHaveLength(SAMPLE_COMMUNITY.decisions.length);
        expect(decisions[0].title).toBe(SAMPLE_COMMUNITY.decisions[0].question);
        expect(decisions[0].touches).toBe(SAMPLE_COMMUNITY.decisions[0].touches);
        expect(decisions[0].effect).toBe(SAMPLE_COMMUNITY.decisions[0].effect);
        expect(decisions[0].franchise).toBe(SAMPLE_COMMUNITY.decisions[0].franchise);
        expect(decisions[0].tally.totalVoters).toBe(9);
        expect(decisions[0].tally.quorumRequired).toBe(6);
        expect(decisions[0].tally.quorumMet).toBe(true);
        expect(decisions[0].tally.yesWeight).toBe(12);
        expect(decisions[0].tally.noWeight).toBe(2);
        expect(decisions[0].tally.thresholdRequired).toBe(0.6);

        const poolVoting = samplePoolVoting();
        expect(poolVoting.voiceCredits).toBe(SAMPLE_COMMUNITY.voiceCredits);
        expect(poolVoting.hasCompletedTrade).toBe(true);

        expect(sampleCommonsBalance()).toBe(SAMPLE_COMMUNITY.pool);
    });

    it('My Deals: the real modal in preview with In Progress / My Posts / History tabs; requested shows Action Required, held Held in trust, sold +30; every button opens the sheet', async () => {
        const onNearYou = vi.fn();
        const onGuide = vi.fn();
        const { unmount } = render(<MyDealsModal visible identity={MEMBER} preview onClose={() => {}} onNearYou={onNearYou} onGuide={onGuide} />);

        // The strip and sample header are rendered in preview inside the scroll container
        expect(screen.getByTestId('deals-preview-head')).toBeInTheDocument();
        expect(screen.getByTestId('sample-header')).toHaveTextContent(LOCAL_COMMUNITY_STRIP.header);

        // Each sample deal, found by its name on its tab, says its own state: a deal in any other state would say none
        // of these, and a status outside the sample's three gets no chip at all (never drawn as Completed).
        const CHIPS: Record<string, { state: string; tab: RegExp; chip: string }> = {
            'Putting up two shelves': { state: 'requested', tab: /^In Progress/, chip: 'Action Required' },
            'Fixing a bike puncture': { state: 'pending', tab: /^In Progress/, chip: 'Held in trust' },
            'Mending a jacket': { state: 'completed', tab: /^History/, chip: 'Completed' },
        };
        expect(S.deals.map(d => d.what).sort()).toEqual(Object.keys(CHIPS).sort());
        for (const d of S.deals) {
            const want = CHIPS[d.what];
            expect(d.state, d.what).toBe(want.state);
            fireEvent.click(screen.getByRole('button', { name: want.tab }));
            expect(screen.getByTestId(`sample-deal-${d.id}`).querySelector('span.uppercase')?.textContent, d.what).toBe(want.chip);
        }
        for (const other of ['cancelled', 'rejected', '']) expect(sampleDealChip(other), other).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /^In Progress/ }));

        // Initial tab is "In Progress"
        // Requested deal (shelves): shows Action Required, explainer, and Approve and hold in trust
        const shelves = screen.getByTestId('sample-deal-sample-deal-shelves');
        expect(within(shelves).getByText('Putting up two shelves')).toBeInTheDocument();
        expect(within(shelves).getByText('Action Required')).toBeInTheDocument();
        expect(within(shelves).getByText('A neighbour offered to do this. Approve to hold the Beans safely.')).toBeInTheDocument();
        const approveHold = within(shelves).getByRole('button', { name: /^Approve and hold in trust/ });
        expect(approveHold).toBeInTheDocument();

        // Held deal (bike): shows Held in trust, explainer, and Approve and release
        const bike = screen.getByTestId('sample-deal-sample-deal-bike');
        expect(within(bike).getByText('Fixing a bike puncture')).toBeInTheDocument();
        expect(within(bike).getByText('Held in trust')).toBeInTheDocument();
        expect(within(bike).getByText('Held in trust until the job is done.')).toBeInTheDocument();
        const approveRelease = within(bike).getByRole('button', { name: /^Approve and release/ });
        expect(approveRelease).toBeInTheDocument();

        // Both buttons open the local community sheet
        fireEvent.click(approveHold);
        expect(await screen.findByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.escrow);
        fireEvent.click(within(screen.getByTestId('local-community-sheet')).getByRole('button', { name: 'Close' }));

        fireEvent.click(approveRelease);
        expect(await screen.findByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.escrow);
        fireEvent.click(within(screen.getByTestId('local-community-sheet')).getByRole('button', { name: 'Close' }));

        // Clicking the card itself in preview also opens the sheet
        fireEvent.click(shelves);
        expect(await screen.findByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.escrow);
        fireEvent.click(within(screen.getByTestId('local-community-sheet')).getByRole('button', { name: 'Close' }));

        // Switch to "My Posts" tab
        fireEvent.click(screen.getByRole('button', { name: /My Posts/ }));
        expect(screen.getByText('Putting up two shelves')).toBeInTheDocument();
        expect(screen.getByText(/Action Required/)).toBeInTheDocument();

        // Switch to "History" tab
        fireEvent.click(screen.getByRole('button', { name: /History/ }));
        const mending = screen.getByTestId('sample-deal-sample-deal-mending');
        expect(within(mending).getByText('Mending a jacket')).toBeInTheDocument();
        expect(within(mending).getByText('+ 30')).toBeInTheDocument();
        const leaveReview = within(mending).getByRole('button', { name: /^Leave Review/ });
        expect(leaveReview).toBeInTheDocument();

        // The sold deal's +30 is the Ledger's row for it
        const sold = S.deals.find(d => d.what === 'Mending a jacket')!;
        expect(S.transactions.find(x => x.what === sold.what)?.amount).toBe(30);

        fireEvent.click(leaveReview);
        expect(await screen.findByTestId('local-community-sheet')).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.escrow);
        fireEvent.click(within(screen.getByTestId('local-community-sheet')).getByRole('button', { name: 'Close' }));

        unmount();
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
        // The held deal's row, as a node's escrow hold reads here: "Held in trust · Fixing a bike puncture", −20, yesterday.
        const held = S.deals.find(d => d.state === 'pending')!;
        const holdNote = within(wallet).getByText(`Held in trust · ${held.what}`);
        const holdRow = holdNote.closest('div.rounded-xl') as HTMLElement;
        expect(holdRow).toHaveTextContent(/↑ Sent/);
        expect(holdRow).toHaveTextContent(`−${held.amount.toFixed(1)}`);
        expect(within(holdRow).getByText('yesterday')).toBeInTheDocument();
        expect(holdRow).not.toHaveTextContent('to a neighbour');
        expect(held.amount).toBe(S.inEscrow);
        expect(wallet).toHaveTextContent('to the Example Valley Bakery · 12 days ago');
        // No circulation fee row: the Wallet itself says nothing goes to the Commons at 200 Beans or less, and the sample holds 85.
        expect(wallet).not.toHaveTextContent('Circulation fee');
        expect(wallet).not.toHaveTextContent('to the Commons ·');
        expect(wallet).not.toHaveTextContent('No transactions yet');
    });
});

describe('the marker never looks locked', () => {
    it('no lock, no greying, no reduced opacity, no tier colour, and Beans never Ʀ', () => {
        const { container } = render(<><CommonsPreview /><MyDealsModal visible identity={MEMBER} preview onClose={() => {}} /></>);
        // All of it, on each of My Deals' three tabs; and each marker on its own. The one exception, by name: the real
        // project card's own lifecycle chip, amber on every community's list. Any other amber or red anywhere, inside the
        // real cards too, still fails.
        for (const tab of [/^In Progress/, /^My Posts/, /^History/]) {
            fireEvent.click(screen.getByRole('button', { name: tab }));
            const shown = container.cloneNode(true) as HTMLElement;
            const chips = Array.from(shown.querySelectorAll('[data-testid="sample-enterprise-card"] [class*="amber-"]'));
            expect(chips.map(c => c.textContent), String(tab)).toEqual(['🌱 Project']);
            chips.forEach(c => c.remove());
            const html = shown.innerHTML;
            expect(html, String(tab)).not.toMatch(/🔒|Locked|locked|Ʀ/);
            expect(html, String(tab)).not.toMatch(/opacity-(?:[1-6]0)|grayscale|cursor-not-allowed|\bamber-|\bred-/);
            const markers = Array.from(container.querySelectorAll('[data-testid^="local-community-"]'));
            expect(markers.length).toBeGreaterThan(0);
            for (const m of markers) {
                expect(m.outerHTML).not.toMatch(/opacity-(?:[1-6]0)|grayscale|cursor-not-allowed|\bamber-|\bred-/);
                if (m instanceof HTMLButtonElement) {
                    expect(m).not.toBeDisabled();
                }
            }
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

describe('sample invites and tree adapters', () => {
    it('sampleInvites provides the pending EXAMPLE-1234 code and the two used codes', () => {
        const invites = sampleInvites();
        expect(invites.map(i => i.code)).toEqual(['EXAMPLE-1234', 'EXAMPLE-5678', 'EXAMPLE-9012']);
        expect(invites[0].usedBy).toBeNull();
        expect(invites[0].intendedFor).toBe('a neighbour');
        expect(invites[1].usedBy).toBe('sample-member-second');
        expect(invites[2].usedBy).toBe('sample-member-first');
    });

    it('sampleInviteTree provides the root example member and two invited members', () => {
        const tree = sampleInviteTree();
        expect(tree).toHaveLength(1);
        expect(tree[0].publicKey).toBe('sample-member-example');
        expect(tree[0].callsign).toBe('an example member');
        expect(tree[0].children).toHaveLength(2);
        expect(tree[0].children.map(c => c.callsign)).toEqual(['a neighbour', 'a neighbour']);
        // Each was brought in with the used invite that names them.
        expect(tree[0].children.map(c => [c.publicKey, c.inviteCode])).toEqual([['sample-member-first', 'EXAMPLE-9012'], ['sample-member-second', 'EXAMPLE-5678']]);
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

/**
 * The sample's example invitations (EXAMPLE-1234) in the web's join box (lib/invite-code.ts, WelcomePage): the box
 * rewrites any code that isn't INV- as an offline ticket, so each reads BP-EXAM-PLE1 and Join sends that. The node's own
 * check (@beanpool/engine members.ts checkInvite, here on an in-memory invite_codes table) must never answer valid: a
 * BP- ticket has to be signed, and a code is looked up exactly. The control: a real-shaped code the node holds, typed
 * loosely, is found by the same path, so "not valid" means no such invitation, not a check that refuses everything.
 */
describe('an example invite code is no invitation in the web\'s join box', () => {
    const engine = resolve(__dirname, '../../../../packages/beanpool-engine');
    type Check = (db: unknown, code: string) => { valid: boolean; reason?: string };
    const load = async () => {
        const Database = createRequire(join(engine, 'package.json'))('better-sqlite3');
        const db = new Database(':memory:');
        db.exec('CREATE TABLE invite_codes (code TEXT PRIMARY KEY, created_by TEXT, created_at TEXT, used_by TEXT, used_at TEXT, intended_for TEXT)');
        const { checkInvite } = await import(/* @vite-ignore */ join(engine, 'src/members.ts')) as { checkInvite: Check };
        return { db, checkInvite };
    };
    /** Each way a member could bring one in: typed, pasted, with or without the dash, encoded, or opened as a join link. */
    const spellings = (code: string) => [
        code, code.toLowerCase(), ` ${code} `, `${code}\n`, code.replace('-', ''), code.replace('-', ' '), code.replace('-', '_'),
        encodeURIComponent(code).replace('-', '%2D'), `/${code}`, `Join my community: ${code}`,
        code.replace(/[A-Z0-9]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)),
        `https://example.org/app?invite=${code}&webjoin=1`, `?invite=${encodeURIComponent(code.toLowerCase())}`,
    ];

    it('every spelling of each example code, as the box shows it and as Join sends it, is refused by the node\'s own check', async () => {
        const { db, checkInvite } = await load();
        const codes = S.invites.map(i => i.code);
        expect(codes).toEqual(['EXAMPLE-1234', 'EXAMPLE-5678', 'EXAMPLE-9012']);
        const seen = new Set<string>();
        for (const code of codes) {
            for (const raw of spellings(code)) {
                // Typed or pasted: the box shows formatInviteCode's answer, and Join sends normaliseInviteCode of what it
                // shows. Opened as a link: the box starts from the link's ?invite= (WelcomePage's first state).
                const fromLink = raw.includes('invite=') ? new URLSearchParams(raw.slice(raw.indexOf('?'))).get('invite') ?? '' : null;
                const shown = [formatInviteCode(raw), ...(fromLink === null ? [] : [formatInviteCode(fromLink)])];
                const sent = [...shown.map(normaliseInviteCode), normaliseInviteCode(raw)].filter(Boolean);
                expect(sent.length, raw).toBeGreaterThan(0);
                for (const s of sent) {
                    seen.add(s);
                    expect(s, raw).not.toMatch(/^INV-/i);
                    const answer = checkInvite(db, s);
                    expect(answer.valid, `${JSON.stringify(raw)} → ${s}`).toBe(false);
                    expect(answer.reason, `${JSON.stringify(raw)} → ${s}`).toBe(s.startsWith('BP-') ? 'malformed' : 'invalid');
                }
            }
        }
        // What the box makes of them: ticket-shaped, as the fixture's header says, and refused as malformed above.
        for (const s of ['BP-EXAM-PLE1', 'BP-EXAM-PLE5', 'BP-EXAM-PLE9']) expect(seen.has(s), s).toBe(true);
    });

    it('the control: a real-shaped code the node holds, typed loosely, is found by the same path', async () => {
        const { db, checkInvite } = await load();
        db.prepare('INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)').run('INV-2345-6789', 'not-a-member', new Date().toISOString());
        for (const raw of ['inv 2345 6789', 'INV23456789', 'https://example.org/app?invite=INV-2345-6789&webjoin=1']) {
            const sent = normaliseInviteCode(formatInviteCode(raw));
            expect(sent, raw).toBe('INV-2345-6789');
            // Found: its maker is no member here, so the node says so, rather than that there is no such code.
            expect(checkInvite(db, sent), raw).toEqual({ valid: false, reason: 'unknown_inviter' });
        }
        expect(checkInvite(db, 'INV-2345-6788')).toEqual({ valid: false, reason: 'invalid' });
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

describe('sampleDecisions and samplePoolVoting match between web and phone (N5)', () => {
    it('web and phone sample decisions and pool voting agree', async () => {
        const PHONE_SAMPLE = '../../../native/components/showcase/sample-screens';
        const phone = await import(/* @vite-ignore */ PHONE_SAMPLE) as { sampleDecisions: () => any[]; samplePoolVoting: () => any };
        const webDecisions = sampleDecisions();
        const phoneDecisions = phone.sampleDecisions();
        expect(webDecisions).toHaveLength(phoneDecisions.length);
        expect(webDecisions[0].id).toBe(phoneDecisions[0].id);
        expect(webDecisions[0].title).toBe(phoneDecisions[0].title);
        expect(webDecisions[0].description).toBe(phoneDecisions[0].description);
        expect(webDecisions[0].tally).toEqual(phoneDecisions[0].tally);
        expect(samplePoolVoting()).toEqual(phone.samplePoolVoting());
    });
});
