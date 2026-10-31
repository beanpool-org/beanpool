// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const platform = { OS: 'android' as 'android' | 'ios' };
const intentCalls = vi.hoisted(() => ({ calls: [] as any[], fail: false }));
const sharingCalls = vi.hoisted(() => ({ calls: [] as any[] }));
const fileSystemCalls = vi.hoisted(() => ({ writes: [] as any[], contentUris: [] as string[] }));
const alertCalls = vi.hoisted(() => ({ calls: [] as any[] }));
const linkingCalls = vi.hoisted(() => ({ calls: [] as any[], fail: false }));

vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, disabled, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(typeof style === 'function' ? style({ pressed: false }) : style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (disabled) attrs['aria-disabled'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: {
            get OS() { return platform.OS; },
            select: (obj: Record<string, unknown>) => obj[platform.OS] ?? obj.default,
        },
        View: el('div'),
        Text: el('span'),
        Pressable: el('button'),
        Modal: ({ visible, children }: { visible: boolean; children: any }) => (visible ? createElement('div', { 'data-testid': 'modal-choice' }, children) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        Alert: {
            alert: (...args: any[]) => { alertCalls.calls.push(args); },
        },
        Linking: {
            openURL: async (url: string) => {
                linkingCalls.calls.push(url);
                if (linkingCalls.fail) throw new Error('Cannot open URL');
                return true;
            },
        },
        Share: { share: async () => ({}) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});

vi.mock('expo-intent-launcher', () => ({
    startActivityAsync: async (action: string, options: any) => {
        intentCalls.calls.push({ action, options });
        if (intentCalls.fail) throw new Error('ActivityNotFoundException');
        return { resultCode: -1 };
    },
}));

vi.mock('expo-sharing', () => ({
    shareAsync: async (path: string, options: any) => {
        sharingCalls.calls.push({ path, options });
    },
}));

vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///data/user/0/beanpool/cache/',
    EncodingType: { UTF8: 'utf8' },
    writeAsStringAsync: async (path: string, content: string, options: any) => {
        fileSystemCalls.writes.push({ path, content, options });
    },
    getContentUriAsync: async (path: string) => {
        fileSystemCalls.contentUris.push(path);
        return `content://org.beanpool.files/${path.split('/').pop()}`;
    },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => (key === 'beanpool_anchor_url' ? 'https://mullum.beanpool.org' : null)),
        setItem: vi.fn(),
        removeItem: vi.fn(),
    },
}));

const currentTheme = { theme: 'light', colors: null as any };
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    currentTheme.colors = lightColors;
    return {
        useTheme: () => ({ theme: currentTheme.theme, colors: currentTheme.colors }),
        useStyles: (make: (t: any) => any) => make({ theme: currentTheme.theme, colors: currentTheme.colors }),
    };
});

vi.mock('../db', () => ({
    fetchMyEvents: async () => [],
    fetchMemberPreferences: async () => ({}),
    isRouteMissing: () => false,
    setEventReminder: async () => ({}),
}));

import { EventShareAndCalendar } from '../../components/EventExtras';
import { lightColors, darkColors } from '../../constants/colors';

const POST = {
    id: 'ev-test-1',
    title: 'Bushcare Working Bee',
    eventStartAt: '2026-11-05T09:00:00.000Z',
    eventEndAt: '2026-11-05T12:00:00.000Z',
    eventPlaceName: 'Creek Reserve',
    description: 'Planting native trees',
    eventTz: 'Australia/Sydney',
};

let root: Root;
let host: HTMLElement;

async function renderComponent(colors = lightColors, isDark = false) {
    currentTheme.theme = isDark ? 'dark' : 'light';
    currentTheme.colors = colors;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(createElement(EventShareAndCalendar, { post: POST }));
    });
}

beforeEach(() => {
    platform.OS = 'android';
    intentCalls.calls = [];
    intentCalls.fail = false;
    sharingCalls.calls = [];
    fileSystemCalls.writes = [];
    fileSystemCalls.contentUris = [];
    alertCalls.calls = [];
    linkingCalls.calls = [];
    linkingCalls.fail = false;
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
});

describe('Android calendar-ics intent launch & fallback', () => {
    it('Android path with intent launcher: right action, type, content URI and read flag', async () => {
        await renderComponent();

        // Tap "Add to calendar"
        const addBtn = host.querySelector('[aria-label="Add this event to your calendar"]') as HTMLElement;
        expect(addBtn).toBeTruthy();
        await act(async () => { addBtn.click(); });

        // Choice modal is now open
        const choiceModal = host.querySelector('[data-testid="modal-choice"]');
        expect(choiceModal).toBeTruthy();

        // Choose "Calendar file (.ics)"
        const fileOption = host.querySelector('[data-testid="event-add-calendar-file"]') as HTMLElement;
        expect(fileOption).toBeTruthy();
        await act(async () => { fileOption.click(); });

        // Verified file write
        expect(fileSystemCalls.writes.length).toBe(1);
        expect(fileSystemCalls.writes[0].path).toBe('file:///data/user/0/beanpool/cache/bushcare-working-bee.ics');
        expect(fileSystemCalls.writes[0].content).toContain('SUMMARY:Bushcare Working Bee');

        // Verified content URI was requested
        expect(fileSystemCalls.contentUris).toEqual(['file:///data/user/0/beanpool/cache/bushcare-working-bee.ics']);

        // Verified intent launcher was called with right action, URI, type and read permission flag
        expect(intentCalls.calls.length).toBe(1);
        expect(intentCalls.calls[0].action).toBe('android.intent.action.VIEW');
        expect(intentCalls.calls[0].options).toEqual({
            data: 'content://org.beanpool.files/bushcare-working-bee.ics',
            type: 'text/calendar',
            flags: 1,
        });

        // No fallback triggered on success
        expect(sharingCalls.calls.length).toBe(0);
        expect(alertCalls.calls.length).toBe(0);
    });

    it('no handler falls back to share with the plain message', async () => {
        intentCalls.fail = true; // Simulates ActivityNotFoundException (no calendar app took ACTION_VIEW)
        await renderComponent();

        const addBtn = host.querySelector('[aria-label="Add this event to your calendar"]') as HTMLElement;
        await act(async () => { addBtn.click(); });

        const fileOption = host.querySelector('[data-testid="event-add-calendar-file"]') as HTMLElement;
        await act(async () => { fileOption.click(); });

        // Intent was attempted
        expect(intentCalls.calls.length).toBe(1);

        // Plain message shown to member via Alert
        expect(alertCalls.calls.length).toBe(1);
        expect(alertCalls.calls[0][0]).toBe('No calendar app');
        expect(alertCalls.calls[0][1]).toBe('Nothing on this phone could open a calendar entry.');

        // Falls back to Sharing.shareAsync so the file is saved/shared
        expect(sharingCalls.calls.length).toBe(1);
        expect(sharingCalls.calls[0].path).toBe('file:///data/user/0/beanpool/cache/bushcare-working-bee.ics');
        expect(sharingCalls.calls[0].options).toEqual({
            mimeType: 'text/calendar',
            dialogTitle: 'Add to calendar',
        });
    });

    it('Google Calendar option opens Google template URL on Android', async () => {
        await renderComponent();

        const addBtn = host.querySelector('[aria-label="Add this event to your calendar"]') as HTMLElement;
        await act(async () => { addBtn.click(); });

        const googleOption = host.querySelector('[data-testid="event-add-google-calendar"]') as HTMLElement;
        expect(googleOption).toBeTruthy();
        await act(async () => { googleOption.click(); });

        expect(linkingCalls.calls.length).toBe(1);
        expect(linkingCalls.calls[0]).toContain('https://calendar.google.com/calendar/render?');
        expect(linkingCalls.calls[0]).toContain('text=Bushcare+Working+Bee');
        expect(linkingCalls.calls[0]).toContain('ctz=Australia%2FSydney');
        expect(intentCalls.calls.length).toBe(0);
        expect(sharingCalls.calls.length).toBe(0);
    });
});

describe('iOS path', () => {
    it('iOS file option writes .ics and uses expo-sharing with UTI', async () => {
        platform.OS = 'ios';
        await renderComponent();

        const addBtn = host.querySelector('[aria-label="Add this event to your calendar"]') as HTMLElement;
        await act(async () => { addBtn.click(); });

        const fileOption = host.querySelector('[data-testid="event-add-calendar-file"]') as HTMLElement;
        await act(async () => { fileOption.click(); });

        expect(fileSystemCalls.writes.length).toBe(1);
        expect(intentCalls.calls.length).toBe(0); // Intent launcher not called on iOS
        expect(sharingCalls.calls.length).toBe(1);
        expect(sharingCalls.calls[0].path).toBe('file:///data/user/0/beanpool/cache/bushcare-working-bee.ics');
        expect(sharingCalls.calls[0].options).toEqual({
            mimeType: 'text/calendar',
            UTI: 'com.apple.ical.ics',
            dialogTitle: 'Add to calendar',
        });
    });
});

describe('Choice renders at 320 dp × 1.3, both themes, 44 dp targets', () => {
    for (const [themeName, colors, isDark] of [
        ['light', lightColors, false],
        ['dark', darkColors, true],
    ] as const) {
        it(`renders choices in ${themeName} theme at 320 dp × 1.3 font`, async () => {
            await renderComponent(colors, isDark);

            const addBtn = host.querySelector('[aria-label="Add this event to your calendar"]') as HTMLElement;
            await act(async () => { addBtn.click(); });

            const fileBtn = host.querySelector('[data-testid="event-add-calendar-file"]') as HTMLElement;
            const googleBtn = host.querySelector('[data-testid="event-add-google-calendar"]') as HTMLElement;
            const cancelBtn = host.querySelector('[data-testid="event-add-calendar-cancel"]') as HTMLElement;

            expect(fileBtn).toBeTruthy();
            expect(googleBtn).toBeTruthy();
            expect(cancelBtn).toBeTruthy();

            // Verify wording and labels
            expect(fileBtn.textContent).toContain('Calendar file (.ics)');
            expect(fileBtn.textContent).toContain('For any calendar app');
            expect(googleBtn.textContent).toContain('Google Calendar');
            expect(cancelBtn.textContent).toContain('Cancel');

            // Verify minimum touch target >= 44dp
            const fileStyle = JSON.parse(fileBtn.getAttribute('data-style') || '{}');
            const googleStyle = JSON.parse(googleBtn.getAttribute('data-style') || '{}');
            const cancelStyle = JSON.parse(cancelBtn.getAttribute('data-style') || '{}');

            expect(fileStyle.minHeight).toBeGreaterThanOrEqual(44);
            expect(googleStyle.minHeight).toBeGreaterThanOrEqual(44);
            expect(cancelStyle.minHeight).toBeGreaterThanOrEqual(44);

            // Cancel button closes the modal
            await act(async () => { cancelBtn.click(); });
            expect(host.querySelector('[data-testid="modal-choice"]')).toBeNull();
        });
    }
});
