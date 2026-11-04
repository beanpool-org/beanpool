// @vitest-environment jsdom
/**
 * A vote a drawn jury decides on the phone's Decide card (removal jury J3; components/JuryPanel.tsx, core jury-card.ts),
 * rendered for real: react-dom in jsdom, React Native's host components as plain tags carrying their accessibility props
 * and their flattened style, the real light and dark palettes (constants/colors.ts), and a stubbed node behind utils/db
 * serving what GET …/jury and the list serve (decisions-engine juryForReader, tallyForReader).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { juryDraw, type ServedJury } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ calls: [] as Array<{ title: string; message?: string; buttons?: Array<{ text: string; onPress?: () => void }> }> }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio', progressbar: 'progressbar' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[props.style].flat(3).filter(Boolean)));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        Alert: { alert: (title: string, message?: string, buttons?: any[]) => { alerts.calls.push({ title, message, buttons }); } },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors: light, darkColors: dark } = await import('../../constants/colors');
    const ctx = () => ({ theme: theme.dark ? 'dark' : 'light', colors: theme.dark ? dark : light });
    return { useTheme: ctx, useStyles: (factory: (c: unknown) => unknown) => factory(ctx()) };
});
vi.mock('../../components/RemovalReplySheet', () => ({ RemovalReplySheet: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ LocalCommunityMark: () => null, ExampleHeader: () => null }));
vi.mock('../../components/showcase/sample-screens', () => ({ samplePoolVoting: () => ({ voiceCredits: 0, hasCompletedTrade: false }) }));
const node = vi.hoisted(() => ({ jury: null as unknown, answered: null as unknown, votes: [] as unknown[], answers: [] as unknown[] }));
vi.mock('../db', () => ({
    castDecisionVote: vi.fn(async (_id: string, body: unknown) => { node.votes.push(body); return { success: true, creditsUsed: 1 }; }),
    reportRemovalCase: vi.fn(async () => ({ success: true })),
    getDecisionJury: vi.fn(async () => node.jury),
    answerJurySeat: vi.fn(async (_id: string, answer: string) => { node.answers.push(answer); return { success: true, jury: node.answered }; }),
}));

import { DecideSection } from '../../components/DecideSection';

const key = (i: number) => i.toString(16).padStart(64, '0');
const POOL = Array.from({ length: 30 }, (_, i) => key(i + 1));
const DAVE = key(500);
const ME = key(600);
const DAY = '2026-11-03';
const drawn = juryDraw({ pool: POOL, subject: DAVE, snapshotDate: DAY, size: 12, standsAside: k => k === POOL[2] });
const walk = drawn.order.slice(0, drawn.jury.length + drawn.stoodAside.length);

function served(over: Partial<ServedJury> = {}): ServedJury {
    return {
        decisionId: 'jv', subject: DAVE, snapshotDate: DAY, rosterHash: drawn.rosterHash, poolSize: POOL.length, size: 12, mustVote: 9, minYes: 6,
        pool: [...POOL].sort().map(k => ({ publicKey: k, callsign: `M${POOL.indexOf(k) + 1}` })), you: null, ...over,
    };
}
function closedJury(): ServedJury {
    const voted = drawn.jury.slice(0, 10);
    const entry = (k: string) => ({ publicKey: k, callsign: `M${POOL.indexOf(k) + 1}`, drawnAs: k });
    return served({ voted: voted.map(entry), didNotServe: walk.filter(k => !voted.includes(k)).map(entry) });
}
function juryVote(status: string, over: Record<string, unknown> = {}): any {
    const open = status === 'open';
    return {
        id: 'jv', authorPubkey: 'SYSTEM', title: 'Remove Dave?', description: 'Paused for a fake listing.', touches: 'member', effect: 'remove_member',
        subject: DAVE, params: { rule: 2, memberName: 'Dave', pausedAt: '2026-11-03T02:00:00.000Z', decider: 'jury', jury: { size: 12 } },
        franchise: '1m1v', status, opensAt: '2026-11-03T02:00:00.000Z', closesAt: open ? '2099-11-10T02:00:00.000Z' : '2026-11-10T02:00:00.000Z',
        gracePeriodEndsAt: status === 'execution_pending_grace' ? '2026-11-17T02:00:00.000Z' : null, createdAt: '2026-11-03T02:00:00.000Z',
        executedAt: null, executionError: null, executionReason: null, adminHaltedAt: null, adminHaltReason: null, updatedAt: '2026-11-03T02:00:00.000Z',
        proposer: { kind: 'admin', name: 'Ada' },
        tally: open
            ? { decisionId: 'jv', status, totalVoters: 7, electorate: 12, quorumRatio: 0.75, quorumRequired: 9, quorumMet: false, thresholdRequired: 2 / 3, minYes: 6, tooFewToVote: false, decider: 'jury', turnout: { voted: 7, size: 12, mustVote: 9 } }
            : { decisionId: 'jv', status, totalVoters: 10, electorate: 12, quorumRatio: 0.75, quorumRequired: 9, quorumMet: true, yesWeight: 9, noWeight: 1, totalWeight: 10, supportRatio: 0.9, thresholdRequired: 2 / 3, passed: true, minYes: 6, tooFewToVote: false, decider: 'jury', turnout: { voted: 10, size: 12, mustVote: 9 } },
        myVote: null,
        ...over,
    };
}

let host: HTMLDivElement;
let root: Root;
async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) await act(async () => { await Promise.resolve(); });
}
async function render(decisions: any[], view: 'open' | 'history' = 'open', me = ME) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(createElement(DecideSection, {
            decisions, identity: { publicKey: me }, balanceState: { earnedCredit: 0, commons: 0 }, onRefresh: async () => {},
            onOpenPropose: () => {}, canPropose: true, hasOpenDecision: false, activeView: view, onChangeView: () => {},
            features: { beans: true } as any,
        }) as unknown as Parameters<Root['render']>[0]);
    });
    await settle();
}
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const button = (re: RegExp) => Array.from(host.querySelectorAll('button')).find(b => re.test(b.getAttribute('aria-label') || b.textContent || ''));
const voteButtons = () => Array.from(host.querySelectorAll('button')).filter(b => /Vote YES|Vote NO|Change to|Voted/.test(b.getAttribute('aria-label') || ''));
const press = async (el: Element | null | undefined) => {
    expect(el, 'the control is there').toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
const styleOf = (el: Element | null | undefined): Record<string, any> => JSON.parse(el?.getAttribute('data-style') || '{}');

/** WCAG contrast of two #rrggbb colours. */
function contrast(fg: string, bg: string): number {
    const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

beforeEach(() => {
    theme.dark = false;
    node.jury = served();
    node.answered = null;
    node.votes = [];
    node.answers = [];
    alerts.calls = [];
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('an open jury vote on the phone', () => {
    for (const dark of [false, true]) {
        it(`a member not drawn sees who decides and the count, no vote button and no NaN (${dark ? 'dark' : 'light'})`, async () => {
            theme.dark = dark;
            const palette = dark ? darkColors : lightColors;
            await render([juryVote('open')]);
            expect(byTestId('jury-seat-not_on_it')).toBeTruthy();
            expect(host.textContent).toContain('Only the jury votes on this. Anyone can check how it was drawn.');
            expect(byTestId('jury-decides-line')?.textContent).toBe('A jury of 12 members, drawn at random, decides by 10 Nov.');
            expect(host.textContent).toContain('Turnout: 7 of 12 jurors have voted');
            expect(voteButtons()).toHaveLength(0);
            expect(button(/^Serve$/)).toBeUndefined();
            expect(host.textContent).not.toMatch(/NaN|undefined/);
            expect(host.textContent).not.toMatch(/Tally: Yes/);
            // Every line in the jury panel reads on the panel's own surface, from the central tokens.
            const panel = byTestId('jury-panel')!;
            expect(styleOf(panel).backgroundColor).toBe(palette.surface.subtle);
            let measured = 0;
            for (const span of Array.from(panel.querySelectorAll('span'))) {
                const colour = styleOf(span).color;
                if (!colour || !/^#[0-9a-f]{6}$/i.test(colour)) continue;
                measured += 1;
                expect(contrast(colour, palette.surface.subtle), span.textContent ?? '').toBeGreaterThanOrEqual(4.5);
            }
            // The decides line, the seat line, the button's words and the pool line at least: a check that measured nothing proves nothing.
            expect(measured).toBeGreaterThanOrEqual(4);
        });
    }

    it('a juror whose answer is due is asked to serve or step aside, and once they serve gets the vote', async () => {
        node.jury = served({ you: 'seated', answerBy: '2099-11-06T02:00:00.000Z' });
        node.answered = served({ you: 'seated', answerBy: null });
        await render([juryVote('open')]);
        expect(byTestId('jury-seat-ask')).toBeTruthy();
        expect(host.textContent).toContain("You were drawn for this jury. Read the case and Dave's answer, then vote.");
        // The time the seat goes as well as the day: it goes at a set minute, 72 hours after the seat.
        expect(host.textContent).toMatch(/Answer by \d{1,2}:\d{2} on \S+ \d{1,2} \S+: serve, or step aside\./);
        expect(voteButtons()).toHaveLength(0);
        await press(button(/^Serve$/));
        expect(node.answers).toEqual(['serve']);
        expect(byTestId('jury-seat-serving')).toBeTruthy();
        expect(voteButtons().length).toBe(2);
        await press(button(/Vote YES/));
        expect(node.votes).toEqual([expect.objectContaining({ support: true, voterPubkey: ME })]);
    });

    it('stepping aside asks first, then the seat and the vote go', async () => {
        node.jury = served({ you: 'seated', answerBy: '2099-11-06T02:00:00.000Z' });
        node.answered = served({ you: null });
        await render([juryVote('open')]);
        await press(button(/^Step aside$/));
        expect(alerts.calls.at(-1)?.message).toBe('Step aside from this jury? Your seat goes to the next member drawn, and nobody is told why.');
        expect(node.answers).toEqual([]);
        await act(async () => { alerts.calls.at(-1)!.buttons!.find(b => b.text === 'Step aside')!.onPress!(); });
        await settle();
        expect(node.answers).toEqual(['step_aside']);
        expect(byTestId('jury-seat-not_on_it')).toBeTruthy();
        expect(voteButtons()).toHaveLength(0);
    });

    it('Check the draw: an honest pool checks out; a tampered pool shows the hash sentence', async () => {
        await render([juryVote('open')]);
        await press(button(/^Check the draw$/));
        expect(byTestId('jury-check-result')?.textContent).toBe('The draw checks out: the pool is the one this vote recorded. Once it closes, you can check who was drawn.');
        act(() => root.unmount());
        host.remove();
        const tampered = served();
        tampered.pool = tampered.pool.map((e, i) => (i === 4 ? { ...e, publicKey: key(9999) } : e));
        node.jury = tampered;
        await render([juryVote('open')]);
        await press(button(/^Check the draw$/));
        expect(byTestId('jury-check-result')?.textContent).toBe("The list the node served doesn't match its own hash.");
    });

    it('the member it is about reads that the jury sees their answer, and cannot vote', async () => {
        await render([juryVote('open')], 'open', DAVE);
        expect(byTestId('jury-seat-subject')?.textContent).toBe('Your answer is shown to the jury.');
        expect(byTestId('own-removal-note')).toBeTruthy();
        expect(voteButtons()).toHaveLength(0);
    });
});

describe('a closed jury vote on the phone', () => {
    it('says how it ended, names who voted and who did not serve, and checks out over both', async () => {
        node.jury = closedJury();
        await render([juryVote('execution_pending_grace')], 'history');
        expect(byTestId('jury-outcome')?.textContent).toBe('The jury voted to remove Dave (9 of 12).');
        expect(host.textContent).toContain('Turnout: 10 of 12 jurors have voted (Met)');
        expect(byTestId('jury-voted')?.textContent).toMatch(/^Voted: M\d+(, M\d+){9}$/);
        expect(byTestId('jury-did-not-serve')?.textContent).toMatch(/^Didn't serve: M\d+/);
        await press(button(/^Check the draw$/));
        expect(byTestId('jury-check-result')?.textContent).toBe('The draw checks out: everyone listed was drawn in order from the pool this vote recorded.');
    });

    it('a dropped name shows the order sentence', async () => {
        const jury = closedJury();
        jury.voted = jury.voted!.filter(e => e.publicKey !== drawn.order[0]);
        jury.didNotServe = jury.didNotServe!.filter(e => e.publicKey !== drawn.order[0]);
        node.jury = jury;
        await render([juryVote('execution_pending_grace')], 'history');
        await press(button(/^Check the draw$/));
        expect(byTestId('jury-check-result')?.textContent).toBe("The names the node served aren't the first ones the draw picks.");
    });
});
