// @vitest-environment jsdom
/**
 * Repeating events on the phone, drawn (DESIGN-event-times §3, §4, §8; slice 5), as event-host-lets-in-render.test.ts draws
 * the event screen: react-dom in jsdom, React Native's host components as plain tags carrying their accessibility props, a
 * 320 dp window at 1.3× text, and a stubbed node behind utils/db. The detail's ↻ caption and Next dates, the host's Cancel
 * this date / Bring it back / Change this date only and what each sends; the form's Repeats and Until rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => [] as Array<{ title: string; msg?: string; buttons?: Array<{ text: string; onPress?: () => void }> }>);
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled, testID, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button' || accessibilityRole === 'radio') attrs.role = accessibilityRole;
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines !== undefined) attrs['data-lines'] = String(numberOfLines);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: (title: string, msg?: string, buttons?: any[]) => { alerts.push({ title, msg, buttons }); } },
        Linking: { openURL: vi.fn() },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@react-native-community/datetimepicker', () => ({ default: () => createElement('span', { 'data-testid': 'date-picker' }) }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('expo-router', () => ({ router: { canGoBack: () => false, back: vi.fn(), replace: vi.fn(), push: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
const theme = vi.hoisted(() => ({ name: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const pick = () => (theme.name === 'dark' ? (m.darkColors ?? m.default?.darkColors) : (m.lightColors ?? m.default?.lightColors));
    return { useTheme: () => ({ theme: theme.name, colors: pick() }), useStyles: (f: any) => f({ theme: theme.name, colors: pick() }) };
});
const HOST = 'host'.repeat(16);
const me = vi.hoisted(() => ({ key: '' }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: me.key } }) }));
const node = vi.hoisted(() => ({ view: null as any, after: null as any, refuse: null as string | null, sent: [] as unknown[][] }));
vi.mock('../db', () => ({
    fetchEventDetail: async () => node.view,
    rsvpEvent: vi.fn(), deletePost: vi.fn(), reportAbuse: vi.fn(), letInToEvent: vi.fn(),
    setEventDateCancelled: async (...a: unknown[]) => {
        node.sent.push(a);
        if (node.refuse) throw new Error(node.refuse);
        return { success: true, post: node.after ?? node.view, skips: [] };
    },
}));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#0a7' }));
const copies = vi.hoisted(() => [] as any[]);
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: (p: any) => { if (p.prefill) copies.push(p.prefill); return null; } }));
vi.mock('../../components/EventExtras', () => ({ EventReminder: () => null, EventShareAndCalendar: () => null }));

import { EventDetail } from '../../components/EventDetail';
import { EventRepeatFields } from '../../components/EventRepeatFields';

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div'); host.style.width = '320px'; document.body.appendChild(host); root = createRoot(host);
    alerts.length = 0; copies.length = 0; node.view = null; node.after = null; node.refuse = null; node.sent.length = 0; me.key = HOST; theme.name = 'light';
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const byTestId = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const click = async (el: HTMLElement | undefined) => { expect(el).toBeTruthy(); await act(async () => { el!.click(); await new Promise((r) => setTimeout(r, 0)); }); };
const yes = async () => { const a = alerts.at(-1)!; await act(async () => { a.buttons!.find(b => b.text === 'Yes')!.onPress!(); await new Promise((r) => setTimeout(r, 0)); }); };

const series = {
    id: 'ev-s', type: 'event', title: 'Friday dinner', description: 'Bring a plate', author_pubkey: HOST, authorPublicKey: HOST, authorCallsign: 'Hana',
    eventStartAt: '2027-10-15T07:50:00.000Z', eventEndAt: '2027-10-15T09:50:00.000Z', eventStartLocal: '2027-10-15T18:50', eventEndLocal: '2027-10-15T20:50',
    eventTz: 'Australia/Sydney', eventPlaceName: 'Bangalow Hall', photos: [], goingCount: 2, interestedCount: 0,
    eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR', time: '18:50', minutes: 120 },
    eventNextDates: [
        { date: '2027-10-15', startLocal: '2027-10-15T18:50', startAt: '2027-10-15T07:50:00.000Z', cancelled: false },
        { date: '2027-10-22', startLocal: '2027-10-22T18:50', startAt: '2027-10-22T07:50:00.000Z', cancelled: true },
        { date: '2027-10-29', startLocal: '2027-10-29T18:50', startAt: '2027-10-29T07:50:00.000Z', cancelled: false },
    ],
};
const hostView = { ...series, eventRsvps: [] };
/** Every control's accessible name starts with the words it shows (WCAG 2.5.3, label in name). */
const expectLabelInName = (els: HTMLElement[]) => {
    expect(els.length).toBeGreaterThan(0);
    for (const el of els) {
        const shown = (el.textContent ?? '').trim();
        expect(shown).not.toBe('');
        expect((el.getAttribute('aria-label') ?? shown).startsWith(shown), `"${el.getAttribute('aria-label')}" starts with "${shown}"`).toBe(true);
    }
};
const draw = async (view: any) => {
    node.view = view;
    await act(async () => { root.render(createElement(EventDetail, { post: series }) as unknown as Parameters<Root['render']>[0]); await new Promise((r) => setTimeout(r, 0)); });
};

describe('the detail, drawn at 320 dp and 1.3×', () => {
    it.each(['light', 'dark'] as const)('a member (%s): the ↻ caption, Next dates with the cancelled one marked, no host controls; nothing cut to one line', async (name) => {
        theme.name = name;
        me.key = 'me'.repeat(32);
        await draw(series);
        expect(byTestId('event-repeat-caption')[0].textContent).toBe('↻ Every Friday');
        expect(byTestId('event-next-date').map(d => d.textContent)).toEqual(['Fri 15 Oct', 'Fri 22 OctCancelled', 'Fri 29 Oct']);
        expect(byTestId('event-date-cancel')).toHaveLength(0);
        for (const id of ['event-repeat-caption', 'event-next-date']) for (const el of byTestId(id)) expect(el.getAttribute('data-lines')).toBeNull();
    });

    it('the host cancels the current date: POST, then the line the node tells those going', async () => {
        node.after = { ...hostView, eventStartLocal: '2027-10-29T18:50', eventNextDates: hostView.eventNextDates.slice(2) };
        await draw(hostView);
        await click(byTestId('event-date-cancel')[0]);
        expect(alerts.at(-1)!.msg).toBe('Cancel Fri 15 Oct? Everyone going that day is told.');
        await yes();
        expect(node.sent).toEqual([['ev-s', '2027-10-15', true]]);
        expect(byTestId('event-date-cancelled-line')[0].textContent).toBe('Fri 15 Oct is cancelled. Next: Fri 29 Oct');
    });

    it('Bring it back: DELETE', async () => {
        await draw(hostView);
        await click(byTestId('event-date-restore')[0]);
        expect(node.sent).toEqual([['ev-s', '2027-10-22', false]]);
    });

    it('each host control is named from the words it shows (WCAG 2.5.3; review of #1993, N1)', async () => {
        await draw(hostView);
        expectLabelInName([...byTestId('event-date-cancel'), ...byTestId('event-date-move'), ...byTestId('event-date-restore')]);
        expect(byTestId('event-date-cancel')[0].getAttribute('aria-label')).toBe('Cancel this date: Fri 15 Oct');
        expect(byTestId('event-date-move')[0].getAttribute('aria-label')).toBe('Change this date only: Fri 15 Oct');
        expect(byTestId('event-date-restore')[0].getAttribute('aria-label')).toBe('Bring it back: Fri 22 Oct');
    });

    it('the cancelled current date can be brought back until it ends: DELETE, then "… is back on" (review of #1993, N2)', async () => {
        node.after = { ...hostView, eventStartLocal: '2027-10-29T18:50', eventStartAt: '2027-10-29T07:50:00.000Z', eventEndAt: '2027-10-29T09:50:00.000Z', eventNextDates: hostView.eventNextDates.slice(2) };
        await draw(hostView);
        await click(byTestId('event-date-cancel')[0]);
        await yes();
        const back = byTestId('event-date-restore-current');
        expect(back).toHaveLength(1);
        expectLabelInName(back);
        expect(back[0].getAttribute('aria-label')).toBe('Bring it back: Fri 15 Oct');
        node.after = hostView;
        await click(back[0]);
        expect(node.sent.at(-1)).toEqual(['ev-s', '2027-10-15', false]);
        expect(byTestId('event-date-cancelled-line')[0].textContent).toBe('Fri 15 Oct is back on');
        expect(byTestId('event-date-restore-current')).toHaveLength(0);
    });

    it('once the cancelled current date has ended, its line has no Bring it back', async () => {
        const end = Date.parse(hostView.eventEndAt);
        const now = vi.spyOn(Date, 'now').mockReturnValue(end - 200);
        try {
            node.after = { ...hostView, eventStartLocal: '2027-10-29T18:50', eventNextDates: hostView.eventNextDates.slice(2) };
            await draw(hostView);
            await click(byTestId('event-date-cancel')[0]);
            await yes();
            expect(byTestId('event-date-restore-current')).toHaveLength(1);
            now.mockReturnValue(end + 1000);
            await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
            expect(byTestId('event-date-restore-current')).toHaveLength(0);
            expect(byTestId('event-date-cancelled-line')[0].textContent).toBe('Fri 15 Oct is cancelled. Next: Fri 29 Oct');
        } finally {
            now.mockRestore();
        }
    });

    it("the node's refusal, in its own words", async () => {
        node.refuse = 'This is the last date: change when the event ends, or cancel the event';
        await draw(hostView);
        await click(byTestId('event-date-cancel')[1]);
        await yes();
        expect(byTestId('event-next-dates-problem')[0].textContent).toBe('This is the last date: change when the event ends, or cancel the event');
    });

    it('Change this date only: cancels it, then opens the copy with "Moved from the regular Friday" on top', async () => {
        await draw(hostView);
        await click(byTestId('event-date-move')[1]);
        await yes();
        expect(node.sent).toEqual([['ev-s', '2027-10-29', true]]);
        expect(copies.at(-1).description).toBe('Moved from the regular Friday\n\nBring a plate');
    });
});

describe('the form: Repeats and Until, drawn', () => {
    const drawFields = async (props: any) => {
        await act(async () => { root.render(createElement(EventRepeatFields, props) as unknown as Parameters<Root['render']>[0]); });
    };
    const noop = () => {};

    it.each(['light', 'dark'] as const)('the choices of the first date (%s), one radio each, none cut to one line', async (name) => {
        theme.name = name;
        await drawFields({ start: new Date(2026, 9, 16, 20, 50), repeat: 'never', until: '', onRepeatChange: noop, onUntilChange: noop });
        const radios = Array.from(host.querySelectorAll('[role=radio]')) as HTMLElement[];
        expect(radios.map(r => r.getAttribute('aria-label'))).toEqual(['Does not repeat', 'Every week on Friday', 'Every 2 weeks on Friday', 'Every month on the 16th', 'Every month on the third Friday']);
        expect(radios[0].getAttribute('aria-checked')).toBe('true');
        expect(byTestId('event-repeat-until')).toHaveLength(0);
        for (const r of radios) expect(r.querySelector('[data-lines]')).toBeNull();
    });

    it('picking one tells the form', async () => {
        const picked: string[] = [];
        await drawFields({ start: new Date(2026, 9, 30, 20, 50), repeat: 'never', until: '', onRepeatChange: (k: string) => picked.push(k), onUntilChange: noop });
        await click(byTestId('event-repeat-monthly-last')[0]);
        expect(picked).toEqual(['monthly-last']);
    });

    it('repeating: Until reads "Until I cancel it", then the date with Clear; a bad one says why', async () => {
        await drawFields({ start: new Date(2026, 9, 16, 20, 50), repeat: 'weekly', until: '', onRepeatChange: noop, onUntilChange: noop });
        expect(byTestId('event-repeat-until')[0].textContent).toBe('Until I cancel it');
        await drawFields({ start: new Date(2026, 9, 16, 20, 50), repeat: 'weekly', until: '2026-10-15', onRepeatChange: noop, onUntilChange: noop });
        expect(byTestId('event-repeat-until-clear')).toHaveLength(1);
        expect(byTestId('event-repeat-until-problem')[0].textContent).toBe('The last date must be a date on or after the first one');
        await click(byTestId('event-repeat-until')[0]);
        expect(byTestId('date-picker')).toHaveLength(1);
    });

    it('Until shows the last date with its year, and each button is named from its words (review of #1993, N1, N4)', async () => {
        await drawFields({ start: new Date(2026, 9, 16, 20, 50), repeat: 'weekly', until: '2028-12-15', onRepeatChange: noop, onUntilChange: noop });
        expect(byTestId('event-repeat-until')[0].textContent).toBe('15 Dec 2028');
        expect(byTestId('event-repeat-until')[0].getAttribute('aria-label')).toContain('15 Dec 2028');
        expectLabelInName(byTestId('event-repeat-until-clear'));
        expect(byTestId('event-repeat-until-clear')[0].getAttribute('aria-label')).toBe('Clear: repeat until I cancel it');
    });

    it("a date as long as the gap to the next says so, in the node's sentence (review of #1993, N7)", async () => {
        await drawFields({ start: new Date(2026, 9, 16, 20, 50), end: new Date(2026, 9, 23, 20, 50), repeat: 'weekly', until: '', onRepeatChange: noop, onUntilChange: noop });
        expect(byTestId('event-repeat-length-problem')[0].textContent).toBe('An event that repeats must end before its next date starts');
        await drawFields({ start: new Date(2026, 9, 16, 20, 50), end: new Date(2026, 9, 23, 20, 50), repeat: 'monthly-day', until: '', onRepeatChange: noop, onUntilChange: noop });
        expect(byTestId('event-repeat-length-problem')).toHaveLength(0);
    });

    it('a rule the form cannot make asks for a choice (review of #1993, N3)', async () => {
        await drawFields({ start: new Date(2027, 9, 15, 18, 50), repeat: 'other', until: '', onRepeatChange: noop, onUntilChange: noop });
        expect(byTestId('event-repeat-problem')[0].textContent).toBe('Choose how the event repeats from the list');
    });

    it('a rule the form cannot make, on its own date, is named and kept in a plain line, with Until; red once the date moves (confirmation of #1993, NB1)', async () => {
        const kept = { firstDate: '2027-10-15', rule: { freq: 'monthly', interval: 3, byMonthDay: 15 } };
        await drawFields({ start: new Date(2027, 9, 15, 18, 50), repeat: 'other', until: '2028-12-15', onRepeatChange: noop, onUntilChange: noop, kept });
        expect(byTestId('event-repeat-kept')[0].textContent).toBe('Every 3 months on the 15th — kept unless you choose another');
        expect(byTestId('event-repeat-problem')).toHaveLength(0);
        expect(byTestId('event-repeat-until')[0].textContent).toBe('15 Dec 2028');
        expect(byTestId('event-repeat-until-clear')).toHaveLength(1);
        await drawFields({ start: new Date(2027, 9, 22, 18, 50), repeat: 'other', until: '2028-12-15', onRepeatChange: noop, onUntilChange: noop, kept });
        expect(byTestId('event-repeat-kept')).toHaveLength(0);
        expect(byTestId('event-repeat-problem')[0].textContent).toBe('Choose how the event repeats from the list');
    });

    it('the 31st says which months are skipped; a choice the date does not offer says so', async () => {
        await drawFields({ start: new Date(2026, 9, 31, 10, 0), repeat: 'monthly-day', until: '', onRepeatChange: noop, onUntilChange: noop });
        expect(byTestId('event-repeat-note')[0].textContent).toBe('(months without a 31st are skipped)');
        await drawFields({ start: new Date(2026, 9, 16, 20, 50), repeat: 'monthly-last', until: '', onRepeatChange: noop, onUntilChange: noop });
        expect(byTestId('event-repeat-problem')[0].textContent).toBe('Choose how the event repeats from the list');
    });
});
