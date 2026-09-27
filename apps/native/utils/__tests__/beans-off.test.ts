/**
 * The rest of the phone on a node with Beans off (utils/beans-off.ts): no Beans figure anywhere outside the Market,
 * and every local community exactly as it was.
 *
 * Screens can't be drawn here (vitest.config.ts: logic, not screens), so the last block reads their source and checks
 * that each Beans figure, and each element that only makes sense with Beans, is behind `beansOn`.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Device modules, stubbed at the boundary (vitest.config.ts), for node-profile.ts: the signer's random bytes and storage.
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
import {
    groupPostPrice, groupPostPriceInvalid, groupPostMissingFields, howItWorksSubtitle, NO_BEANS_GUIDE_CARD,
} from '../beans-off';
import { beansOn, readNodeProfile, type NodeFeatures } from '../node-profile';

const GLOBAL = readNodeProfile({ profile: 'global', features: { beans: false, escrow: false } })!.features;
const LOCAL = readNodeProfile({ profile: 'local', features: { beans: true, escrow: true } })!.features;
const OLD = readNodeProfile({})!.features;
/** Beans on, and every way of not saying: each must be exactly today's phone. */
const BEANS_ON: Array<[string, NodeFeatures | null | undefined]> = [
    ['local', LOCAL], ['a node that says nothing', OLD], ['no profile yet (null)', null], ['undefined', undefined],
];

const FIELDS = ['', '0', '12', '12.5', ' 7 ', ' ', 'abc', '-3', '1e3'];
const UNITS = ['fixed', 'hourly', 'daily', 'weekly', 'monthly'];

// What app/group-post.tsx computed inline before, copied verbatim, to hold Beans on to it.
const before = {
    credits: (credits: string) => Number(credits) || 0,
    invalid: (credits: string) => !credits.trim() || isNaN(Number(credits)) || Number(credits) < 0,
    missing: 'Please provide a title, category, and price/credits.',
};

describe('the rule is beansOn’s', () => {
    it('hides Beans only where the node says outright they are off', () => {
        // An empty price is wrong exactly where there is a price, so this reads the helpers' rule for each shape.
        const shapes: Array<NodeFeatures | null | undefined> = [GLOBAL, LOCAL, OLD, null, undefined, { beans: true }, {}, { escrow: false }];
        for (const f of shapes) expect(groupPostPriceInvalid('', f)).toBe(beansOn(f));
        expect(beansOn(GLOBAL)).toBe(false);
    });
});

describe('a group’s post form (app/group-post.tsx)', () => {
    it('Beans off: the post goes up at 0 Beans and a total, whatever the field held', () => {
        for (const field of FIELDS) {
            for (const unit of UNITS) expect(groupPostPrice(field, unit, GLOBAL)).toEqual({ credits: 0, price_type: 'fixed' });
        }
    });

    it('Beans off: the price is never wrong, and the alert does not ask for one', () => {
        for (const field of FIELDS) expect(groupPostPriceInvalid(field, GLOBAL)).toBe(false);
        expect(groupPostMissingFields(GLOBAL)).toBe('Please provide a title and category.');
        expect(groupPostMissingFields(GLOBAL)).not.toMatch(/price|credit|bean/i);
    });

    for (const [name, f] of BEANS_ON) {
        it(`Beans on (${name}): exactly today’s form`, () => {
            for (const field of FIELDS) {
                for (const unit of UNITS) expect(groupPostPrice(field, unit, f)).toEqual({ credits: before.credits(field), price_type: unit });
                expect(groupPostPriceInvalid(field, f)).toBe(before.invalid(field));
            }
            expect(groupPostMissingFields(f)).toBe(before.missing);
        });
    }
});

describe('profile setup’s "How BeanPool works" (components/OnboardingGuide.tsx)', () => {
    it('Beans off: one card that says there are no Beans here, and no Beans figure', () => {
        expect(NO_BEANS_GUIDE_CARD.text).toContain('There are no Beans here');
        expect(`${NO_BEANS_GUIDE_CARD.title} ${NO_BEANS_GUIDE_CARD.text}`).not.toMatch(/\d/);
        expect(howItWorksSubtitle(GLOBAL)).toBe('A quick look at this community.');
        expect(howItWorksSubtitle(GLOBAL)).not.toMatch(/econom|bean/i);
    });

    for (const [name, f] of BEANS_ON) {
        it(`Beans on (${name}): today’s line`, () => {
            expect(howItWorksSubtitle(f)).toBe('A quick look at this community economy.');
        });
    }
});

describe('the screens draw Beans only behind beansOn (source check)', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');

    /**
     * The JSX a `{cond && (` (or `{cond ? (`) opens: from the line holding `open` to the first line after it that
     * closes it at the same indent. Throws if `open` is missing, so a check can't pass on an absent gate.
     */
    function block(src: string, open: string): string {
        const lines = src.split('\n');
        const i = lines.findIndex(l => l.includes(open));
        if (i < 0) throw new Error(`not found: ${open}`);
        const indent = lines[i].match(/^\s*/)![0];
        const end = lines.findIndex((l, j) => j > i && l.startsWith(indent) && /^\s*\)}\s*$/.test(l) && l.match(/^\s*/)![0] === indent);
        if (end < 0) throw new Error(`no close for: ${open}`);
        return lines.slice(i, end + 1).join('\n');
    }

    it('My Deals: neither card draws its amount, and the Market passes the rule in', () => {
        const src = read('components/MyDealsSheet.tsx');
        expect(src).toContain("initialTab = 'pending', showsBeans = true }: MyDealsSheetProps");
        const lines = src.split('\n');
        const beans = lines.flatMap((l, i) => (l.includes("require('../assets/images/bean.png')") ? [i] : []));
        expect(beans.length).toBe(2);
        for (const i of beans) expect(lines.slice(i - 5, i).join('\n')).toContain('{showsBeans && (');
        expect(block(src, '{showsBeans && (')).toContain("{isBuyer ? '- ' : '+ '}{item.credits}");
        expect(src.split('{showsBeans && (')[2]).toContain("{item.credits ?? '?'}");
        expect(read('app/(tabs)/index.tsx')).toMatch(/<MyDealsSheet[^>]*showsBeans=\{showsBeans\}/);
    });

    it('a chat about a post: its header has no "0 Beans"', () => {
        const src = read('app/chat/[id].tsx');
        const line = src.split('\n').find(l => l.includes('styles.stickyPostCredits}>'))!;
        expect(line).toContain('{showsBeans && <Text style={styles.stickyPostCredits}>');
        expect(src).toContain('const showsBeans = beansOn(nodeProfile?.features);');
    });

    it('Talk: no "Credits: High / Low" sort', () => {
        const src = read('app/(tabs)/chats.tsx');
        const gated = block(src, '{showsBeans && (');
        expect(gated).toContain('Credits: High');
        expect(gated).toContain('Credits: Low');
        expect(src.split('bean.png').length - 1).toBe(2);
        expect(gated.split('bean.png').length - 1).toBe(2);
    });

    it('a profile: no Beans balance card (nor its way into the hidden Ledger), and no figure on a listing', () => {
        const src = read('app/public-profile.tsx');
        const card = block(src, '{isSelf && balanceInfo && showsBeans && (');
        expect(card).toContain("router.push('/(tabs)/ledger')");
        expect(card).toContain('styles.trustBalance');
        expect(src.split("router.push('/(tabs)/ledger')").length - 1).toBe(1);
        const listing = block(src, '{showsBeans && (');
        expect(listing).toContain("{p.credits ?? '?'}");
        expect(listing).toContain('bean.png');
        expect(src.split('bean.png').length - 1).toBe(1);
    });

    it('Settings: no Community Pricing Guide (Beans estimates)', () => {
        const src = read('app/(tabs)/settings.tsx');
        const gated = block(src, '{showsBeans && (');
        expect(gated).toContain('COMMUNITY PRICING GUIDE');
        expect(gated).toContain('setShowPricingGuide(true)');
        expect(src.split('setShowPricingGuide(true)').length - 1).toBe(1);
    });

    it('Commons (a link still opens it): no pool balance, no voice credits, no pool info', () => {
        const src = read('app/(tabs)/projects.tsx');
        const row = block(src, '{showsBeans && (');
        expect(row).toContain('<CurrencyDisplay amount={(balanceState.commons || 0).toFixed(2)}');
        expect(row).toContain('testID="voice-credits-card"');
        const title = src.slice(src.indexOf('right={showsBeans ? ('), src.indexOf(') : undefined} />'));
        expect(title).toContain('accessibilityLabel="About the Commons Pool"');
        expect(src.split('About the Commons Pool').length - 1).toBe(1);
    });

    it('Create a group: no "Start an enterprise" (its form asks for a goal in Beans)', () => {
        const src = read('components/CreateGroupModal.tsx');
        expect(block(src, '{showsBeans && (')).toContain('router.push(START_ENTERPRISE_BRIDGE.route)');
    });

    it('profile setup: the no-Beans card in place of the three about Beans, and no Ledger tip', () => {
        const setup = read('app/profile-setup.tsx');
        expect(setup).toContain('<OnboardingGuide beansOn={beansOn(nodeProfile?.features)} />');
        expect(setup).toContain('{howItWorksSubtitle(nodeProfile?.features)}');
        const guide = read('components/OnboardingGuide.tsx');
        expect(guide).toContain('export function OnboardingGuide({ beansOn = true }: { beansOn?: boolean })');
        const at = (s: string) => { const i = guide.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
        const open = at('{beansOn ? (');
        const other = at(') : (');
        for (const figure of ['(0 Beans)', '0 Bean limit', '-2000 Beans', 'above 200 Beans', '40 Beans', 'Trust Wallet']) {
            expect(at(figure)).toBeGreaterThan(open);
            expect(at(figure)).toBeLessThan(other);
        }
        expect(at('{NO_BEANS_GUIDE_CARD.text}')).toBeGreaterThan(other);
        expect(block(guide, '{beansOn && (')).toContain('tab to send credits');
        // The join wizard says the same thing on the same kind of community.
        const welcome = read('app/welcome.tsx');
        expect(welcome).toContain(NO_BEANS_GUIDE_CARD.title);
        expect(welcome).toContain(NO_BEANS_GUIDE_CARD.text);
    });

    it('a group’s post form: no price field, and the price never holds the post back', () => {
        const src = read('app/group-post.tsx');
        const field = block(src, '{showsBeans ? (');
        expect(field).toContain('PRICE (BEANS) *');
        expect(field).toContain('{NO_BEANS_EDIT_NOTE}');
        expect(field.indexOf('PRICE (BEANS) *')).toBeLessThan(field.indexOf('{NO_BEANS_EDIT_NOTE}'));
        expect(src).toContain('if (groupPostPriceInvalid(credits, nodeProfile?.features)) errs.add(\'credits\');');
        expect(src).toContain('groupPostMissingFields(nodeProfile?.features)');
        expect(src).toContain('...groupPostPrice(credits, priceType, nodeProfile?.features),');
        expect(src).not.toContain('credits: Number(credits) || 0,');
    });
});
