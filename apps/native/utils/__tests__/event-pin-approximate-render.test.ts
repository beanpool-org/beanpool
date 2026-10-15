// @vitest-environment jsdom
/**
 * Where anyone can join in a minute (features.openMembership, the global node), a new event pin starts Approximate,
 * rounded to about 100 m, and the host can still choose the exact spot (DESIGN-global-member-privacy-fable.md, director
 * amendment 1 item 3; #1965). The phone's event form drawn for real, as event-host-lets-in-render.test.ts draws the event
 * screen (react-dom in jsdom, React Native's host components as plain tags), with the map a tap target: on the global
 * node the tap lands Approximate and "Use the exact spot" takes it back; on a local node the tap is the spot, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { freshEventPin, approximatePin } from '../events';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mapPress = vi.hoisted(() => ({ handler: null as null | ((e: any) => void) }));
const profile = vi.hoisted(() => ({ features: {} as Record<string, unknown> }));
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (disabled) attrs['aria-disabled'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: () => null,
        Modal: ({ children, visible }: any) => (visible ? createElement('div', null, children) : null),
        ActivityIndicator: () => null,
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn(), openSettings: vi.fn() }, Keyboard: { dismiss: vi.fn() },
    };
});
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: any) => createElement('div', null, children) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@react-native-community/datetimepicker', () => ({ default: () => null }));
vi.mock('react-native-maps', () => ({
    default: (props: any) => { mapPress.handler = props.onPress; return createElement('div', { 'data-testid': 'map' }, props.children); },
    Marker: () => null, PROVIDER_DEFAULT: 'default',
}));
vi.mock('expo-location', () => ({ getForegroundPermissionsAsync: async () => ({ status: 'denied', canAskAgain: false }), getLastKnownPositionAsync: async () => null }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-image-manipulator', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const colors = m.lightColors ?? m.default?.lightColors;
    return { useTheme: () => ({ theme: 'light', colors }), useStyles: (f: any) => f({ theme: 'light', colors }) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me'.repeat(32) } }) }));
vi.mock('../db', () => ({
    createPost: vi.fn(), updateEvent: vi.fn(),
    fetchGroups: vi.fn(async () => []), getBalance: vi.fn(async () => ({ keeperOf: [] })), getTreasuries: vi.fn(async () => []),
}));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ features: profile.features }) }));
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#0a7' }));
vi.mock('../../components/AddressSearch', () => ({ AddressSearch: () => null }));

import { NewEventModal } from '../../components/NewEventModal';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); mapPress.handler = null; });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const draw = async () => {
    await act(async () => {
        root.render(createElement(NewEventModal, { visible: true, onClose: () => {}, onSuccess: () => {} } as any) as unknown as Parameters<Root['render']>[0]);
        await new Promise((r) => setTimeout(r, 0));
    });
};
const tapMap = async (lat: number, lng: number) => {
    expect(mapPress.handler).toBeTruthy();
    await act(async () => { mapPress.handler!({ nativeEvent: { coordinate: { latitude: lat, longitude: lng } } }); await new Promise((r) => setTimeout(r, 0)); });
};
const exactButton = () => host.querySelector('[data-testid="event-pin-exact"]') as HTMLElement | null;

describe('freshEventPin: the rule both of the form\'s new pins follow', () => {
    it('where anyone can join: about 100 m, the spot kept; elsewhere the spot', () => {
        expect(freshEventPin(-28.55437, 153.50261, true)).toEqual({ pin: approximatePin(-28.55437, 153.50261), approximate: true, exact: { lat: -28.55437, lng: 153.50261 } });
        expect(freshEventPin(-28.55437, 153.50261, true).pin).toEqual({ lat: -28.554, lng: 153.503 });
        expect(freshEventPin(-28.55437, 153.50261, false)).toEqual({ pin: { lat: -28.55437, lng: 153.50261 }, approximate: false, exact: { lat: -28.55437, lng: 153.50261 } });
    });
});

describe('the phone event form (drawn)', () => {
    it('on the global node a tap on the map lands Approximate, and Use the exact spot takes it back', async () => {
        profile.features = { openMembership: true };
        await draw();
        await tapMap(-28.55437, 153.50261);
        expect(host.textContent).toContain('Approximate pin · -28.554, 153.503');
        expect(exactButton()?.textContent).toBe('Use the exact spot');
        await act(async () => { exactButton()!.click(); await new Promise((r) => setTimeout(r, 0)); });
        expect(host.textContent).toContain('Exact pin · -28.55437, 153.50261');
        expect(exactButton()).toBeNull();
    });
    it('on a local node a tap is the spot, as before, with no exact-spot button', async () => {
        profile.features = {};
        await draw();
        await tapMap(-28.55437, 153.50261);
        expect(host.textContent).toContain('Exact pin · -28.55437, 153.50261');
        expect(exactButton()).toBeNull();
    });
});
