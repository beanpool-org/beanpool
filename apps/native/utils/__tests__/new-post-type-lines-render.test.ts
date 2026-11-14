// @vitest-environment jsdom
/**
 * Where a member picks what kind of post to make, the phone says plainly what each kind is (core post-type-lines.ts; Marty, 9 Nov:
 * "should it have been a need or an offer? and is it free? its confusing?"): the chooser behind every + (components/NewPostTypeSheet.tsx)
 * draws one short line under each choice, an Offer "Something you'll give or do for others" and a Need "Something you're looking
 * for", with the Poll and Event lines it already had, and the new-listing form's own toggle (app/new-listing.tsx) says the same two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sent = vi.hoisted(() => ({ identity: true, picked: [] as string[], learn: 'hidden' as 'live' | 'preview' | 'hidden' | undefined }));
vi.mock('../use-learn-mode', () => ({ useLearnMode: () => sent.learn }));
vi.mock('react-native', async () => {
    // Modal and Platform are the shared harness's: iOS's dismissals are `modalControl`'s (profile-events-words-harness.ts).
    const { modalStandIn, platformStandIn } = await import('./profile-events-words-harness');
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, testID, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        return createElement(tag, attrs, children);
    };
    return {
        Modal: modalStandIn, Platform: platformStandIn(),
        Pressable: el('button'), Text: el('span'), View: el('div'),
        StyleSheet: { create: (s: unknown) => s },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: sent.identity ? { publicKey: 'me', callsign: 'Ana', privateKey: 'p' } : null }) }));
vi.mock('../look-door', () => ({ openLookDoor: () => {} }));

import { pseudoLocalise, setLanguage } from '@beanpool/core';
import { NewPostTypeSheet } from '../../components/NewPostTypeSheet';
import { AFTER_DISMISS_FALLBACK_MS } from '../screen-presented';
import { modalControl } from './profile-events-words-harness';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); sent.identity = true; sent.picked.length = 0; sent.learn = 'hidden'; });
afterEach(() => { vi.useRealTimers(); modalControl.reset(); act(() => root.unmount()); host.remove(); setLanguage('en'); });

const show = async () => { await act(async () => { root.render(createElement(NewPostTypeSheet as any, { visible: true, onClose: () => {}, onSelect: (t: string) => { sent.picked.push(t); } }) as any); }); };
/** The choice rows: the buttons whose screen-reader label is "Title: line" (not the backdrop, the sheet itself or Cancel). */
const rows = () => Array.from(host.querySelectorAll('button')).filter((b) => b.getAttribute('aria-label')?.includes(': '));

describe('the + chooser: one short line under each choice', () => {
    it('Offer says what you give or do, Need says what you are looking for, and Poll and Event keep their lines', async () => {
        await show();
        expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
            "Offer: Something you'll give or do for others",
            "Need: Something you're looking for",
            'Community Poll: Ask a question with 2–4 options in the feed',
            'Event: A gathering with a time and a place',
        ]);
        expect(rows().map((r) => Array.from(r.querySelectorAll('span')).map((s) => s.textContent).filter((x) => x && x.length > 3))).toEqual([
            ['Offer', "Something you'll give or do for others"],
            ['Need', "Something you're looking for"],
            ['Community Poll', 'Ask a question with 2–4 options in the feed'],
            ['Event', 'A gathering with a time and a place'],
        ]);
    });

    it('a line wraps whole (no line limit), so at 320 dp with 1.3x text nothing is cut', async () => {
        await show();
        for (const line of Array.from(host.querySelectorAll('button span')).filter((s) => /^Something |^Ask a question|^A gathering/.test(s.textContent ?? ''))) {
            expect(line.getAttribute('data-lines'), line.textContent ?? '').toBeNull();
        }
    });

    it('every line comes through t(): in the pseudo-locale each is the pseudo-localised English', async () => {
        setLanguage('xx');
        await show();
        const text = host.textContent ?? '';
        for (const line of ["Something you'll give or do for others", "Something you're looking for", 'Ask a question with 2–4 options in the feed', 'A gathering with a time and a place']) {
            expect(text, line).toContain(pseudoLocalise(line));
        }
        expect(text).not.toContain("Something you'll give");
    });

    it('choosing a row still opens that kind', async () => {
        await show();
        await act(async () => { rows()[1].click(); });
        expect(sent.picked).toEqual(['need']);
    });

    it('a visitor with no account sees no rows: Join to post, as before', async () => {
        sent.identity = false;
        await show();
        expect(host.querySelector('[data-testid="new-post-join"]')).not.toBeNull();
        expect(host.textContent).not.toContain("Something you'll give");
    });
});

describe('the fifth row, 📖 Local knowledge (slice K4): only where Learn is live here', () => {
    it('where Learn is live it comes after Event, in the same words as the web, and choosing it opens that kind', async () => {
        sent.learn = 'live';
        await show();
        expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
            "Offer: Something you'll give or do for others",
            "Need: Something you're looking for",
            'Community Poll: Ask a question with 2–4 options in the feed',
            'Event: A gathering with a time and a place',
            'Local knowledge: Something worth knowing about this place',
        ]);
        expect(rows()[4].textContent).toContain('📖');
        await act(async () => { rows()[4].click(); });
        expect(sent.picked).toEqual(['knowledge']);
    });

    for (const mode of ['hidden', 'preview', undefined] as const) {
        it(`not where Learn is ${mode ?? 'not known yet'}: four rows, as before`, async () => {
            sent.learn = mode;
            await show();
            expect(rows()).toHaveLength(4);
            expect(host.textContent).not.toContain('Local knowledge');
        });
    }

    it('a visitor with no account never sees it, even where Learn is live', async () => {
        sent.identity = false;
        sent.learn = 'live';
        await show();
        expect(host.textContent).not.toContain('Local knowledge');
    });

    it('in the pseudo-locale its name and line come through t()', async () => {
        sent.learn = 'live';
        setLanguage('xx');
        await show();
        expect(host.textContent).toContain(pseudoLocalise('Something worth knowing about this place'));
        expect(host.textContent).toContain(pseudoLocalise('Local knowledge'));
    });

    it('on iOS it waits for the chooser to go before the screen is pushed, as the Poll and Event forms do', async () => {
        sent.learn = 'live';
        modalControl.ios = true;
        const closed: boolean[] = [];
        await ask(closed);
        await act(async () => { row('Local knowledge').click(); });
        expect(closed).toEqual([true]);
        expect(sent.picked).toEqual([]);
        await dismissalEnds();
        expect(sent.picked).toEqual(['knowledge']);
    });
});

/**
 * The chooser as a screen holds it: open until it is asked to close (what Market, Map and Home do with `onClose`), so the Modal
 * really goes and, on iOS, really spends time closing (`modalControl`). `closed` is what `onClose` was told: true when a choice
 * is behind the close, false for a Cancel or a tap outside.
 */
function Screen({ closed }: { closed: boolean[] }) {
    const [open, setOpen] = useState(true);
    return createElement(NewPostTypeSheet as any, {
        visible: open,
        onClose: (choosing?: boolean) => { closed.push(choosing === true); setOpen(false); },
        onSelect: (t: string) => { sent.picked.push(t); },
    });
}
/** The screen opens its chooser; a different `visit` is a fresh screen (the chooser open again, as a member opens it a second time). */
const ask = async (closed: boolean[], visit = 0) => { await act(async () => { root.render(createElement(Screen, { closed, key: visit }) as any); }); };
const row = (label: string) => rows().find((b) => b.getAttribute('aria-label')?.startsWith(`${label}:`))!;
const chooserIsUp = () => host.querySelector('[data-modal]') !== null;
/** The chooser's close ending, as iOS reports it: each closed Modal's `onDismiss` fires. */
const dismissalEnds = async () => { await act(async () => { modalControl.finishClosing(); }); };

describe('choosing a row: the sequence each platform runs (round 3 of #2984)', () => {
    describe('Android and the web: every kind arrives at once (a Dialog opens over a Dialog)', () => {
        for (const [label, kind] of [['Offer', 'offer'], ['Need', 'need'], ['Community Poll', 'poll'], ['Event', 'event']] as const) {
            it(`${label}: the chooser is asked to close with a choice behind it, and ${kind} arrives with no wait`, async () => {
                const closed: boolean[] = [];
                await ask(closed);
                expect(chooserIsUp()).toBe(true);
                await act(async () => { row(label).click(); });
                expect(closed, 'asked to close, with a choice behind it').toEqual([true]);
                expect(chooserIsUp(), 'the chooser has gone').toBe(false);
                expect(sent.picked, 'no onDismiss was needed').toEqual([kind]);
            });
        }
    });

    describe('iOS: a view in the screen is not held, a Modal of its own waits for the chooser to go', () => {
        for (const [label, kind] of [['Offer', 'offer'], ['Need', 'need']] as const) {
            it(`${label}: arrives at once, while the chooser is still closing`, async () => {
                modalControl.ios = true;
                const closed: boolean[] = [];
                await ask(closed);
                await act(async () => { row(label).click(); });
                expect(closed).toEqual([true]);
                expect(sent.picked, 'before the dismissal has ended').toEqual([kind]);
                await dismissalEnds();
                expect(sent.picked, 'and the dismissal adds nothing').toEqual([kind]);
            });
        }

        for (const [label, kind] of [['Community Poll', 'poll'], ['Event', 'event']] as const) {
            it(`${label}: held while the chooser closes, then arrives once its onDismiss fires, and only once`, async () => {
                modalControl.ios = true;
                const closed: boolean[] = [];
                await ask(closed);
                await act(async () => { row(label).click(); });
                expect(closed, 'asked to close, with a choice behind it').toEqual([true]);
                expect(chooserIsUp(), 'the chooser has gone from the screen').toBe(false);
                expect(sent.picked, 'UIKit would refuse a Modal now: not asked for yet').toEqual([]);
                await dismissalEnds();
                expect(sent.picked, 'the chooser has gone: now the form may open').toEqual([kind]);
                await dismissalEnds();
                expect(sent.picked, 'once').toEqual([kind]);
            });

            it(`${label}: if the dismissal event never comes, it arrives after the floor, not before, and not twice`, async () => {
                modalControl.ios = true;
                await ask([]);
                vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                act(() => { row(label).click(); });
                act(() => { vi.advanceTimersByTime(AFTER_DISMISS_FALLBACK_MS - 1); });
                expect(sent.picked, 'still inside the floor').toEqual([]);
                act(() => { vi.advanceTimersByTime(1); });
                expect(sent.picked, 'the floor ran it').toEqual([kind]);
                await dismissalEnds();
                expect(sent.picked, 'a late onDismiss runs nothing again').toEqual([kind]);
            });
        }

        it('a Cancel, or a tap outside the sheet, picks nothing: not at once, not after the dismissal, not after the floor', async () => {
            modalControl.ios = true;
            // Fake timers from the start, so a pick wrongly held by either close would have its floor timer advanced below.
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const closed: boolean[] = [];
            await ask(closed);
            await act(async () => { host.querySelector<HTMLElement>('[aria-label="Cancel"]')!.click(); });
            await dismissalEnds();
            await ask(closed, 1);
            expect(chooserIsUp(), 'opened a second time').toBe(true);
            await act(async () => { host.querySelector<HTMLElement>('[aria-label="Close create post sheet"]')!.click(); });
            await dismissalEnds();
            act(() => { vi.advanceTimersByTime(AFTER_DISMISS_FALLBACK_MS * 2); });
            expect(sent.picked).toEqual([]);
            expect(closed, 'told each time that no choice is behind the close').toEqual([false, false]);
        });
    });
});

describe('the new-listing form: its Offer / Need toggle says the same two lines (source check: the form has no render harness)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/new-listing.tsx'), 'utf-8');
    const lines = src.split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));

    it("each button's own line is core's, drawn inside the button, right under its title", () => {
        for (const kind of ['offer', 'need'] as const) {
            const title = at(kind === 'offer' ? "t('🟢 Offer')" : "t('🟠 Need')");
            const hint = at(`t(POST_TYPE_LINES.${kind})`);
            expect(title, kind).toBeGreaterThan(0);
            expect(hint, kind).toBe(title + 1);
            expect(lines[hint]).toContain(`testID="type-hint-${kind}"`);
            expect(lines[hint]).toContain('styles.typeBtnHint');
        }
    });

    it('the hint wraps (no numberOfLines) and takes its colour from the central tokens', () => {
        const hint = lines.find((l) => l.includes('typeBtnHint: {')) ?? '';
        expect(hint).toContain('colors.text.secondary');
        expect(hint).not.toContain('numberOfLines');
        expect(lines.filter((l) => l.includes('styles.typeBtnHint')).every((l) => !l.includes('numberOfLines'))).toBe(true);
    });
});
