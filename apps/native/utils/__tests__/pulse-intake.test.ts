import { describe, it, expect, vi } from 'vitest';

vi.mock('expo', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));

vi.mock('expo-crypto', () => ({
    randomUUID: () => 'test-uuid',
    digestStringAsync: vi.fn(),
    getRandomBytesAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'android', select: (obj: any) => obj.android || obj.default },
    StyleSheet: {
        create: (styles: any) => styles,
    },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    Switch: 'Switch',
    AppState: {
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: 'SafeAreaView',
    useSafeAreaInsets: vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),
}));

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    KeyboardProvider: 'KeyboardProvider',
}));

vi.mock('expo-router', () => ({
    router: {
        push: vi.fn(),
        replace: vi.fn(),
        back: vi.fn(),
    },
    useLocalSearchParams: vi.fn(() => ({})),
}));

vi.mock('expo-clipboard', () => ({
    getStringAsync: vi.fn(async () => ''),
    setStringAsync: vi.fn(async () => true),
}));

vi.mock('expo-haptics', () => ({
    notificationAsync: vi.fn(async () => undefined),
    impactAsync: vi.fn(async () => undefined),
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));

vi.mock('../node-post', () => ({
    anchorUrl: vi.fn(async () => 'https://test.beanpool.org'),
    signedPost: vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: true }),
    })),
}));

import { lightColors, darkColors, earthColors, slateColors } from '../../constants/colors';
import { makeStyles as makeIntakeStyles, safeDecodeURIComponent } from '../../app/pulse-intake';
import { makeStyles as makePreviewStyles } from '../../components/PulsePreviewCard';
import { makeStyles as makeNudgeStyles } from '../../components/PulseNudges';

describe('Pulse Intake Crash Prevention & Theming', () => {
    describe('safeDecodeURIComponent', () => {
        it('handles undefined and empty values', () => {
            expect(safeDecodeURIComponent(undefined)).toBe('');
            expect(safeDecodeURIComponent('')).toBe('');
        });

        it('decodes encoded URI parameters', () => {
            expect(safeDecodeURIComponent('https%3A%2F%2Finstagram.com%2Fp%2FC123')).toBe('https://instagram.com/p/C123');
        });

        it('gracefully returns raw malformed percent strings without throwing', () => {
            expect(safeDecodeURIComponent('https://example.com/bad%99%')).toBe('https://example.com/bad%99%');
        });
    });

    describe('PulseIntakeScreen makeStyles evaluation across all theme palettes', () => {
        const palettes = [
            { name: 'light classic', colors: lightColors, theme: 'light' },
            { name: 'light earth', colors: earthColors as unknown as typeof lightColors, theme: 'light' },
            { name: 'light slate', colors: slateColors as unknown as typeof lightColors, theme: 'light' },
            { name: 'dark', colors: darkColors as unknown as typeof lightColors, theme: 'dark' },
        ];

        for (const { name, colors, theme } of palettes) {
            it(`evaluates pulse-intake styles cleanly for ${name} without throwing or undefined properties`, () => {
                expect(() => {
                    const styles = makeIntakeStyles({ colors, theme });
                    expect(styles).toBeDefined();
                    expect(styles.safeArea).toBeDefined();
                    expect(styles.safeArea.backgroundColor).toBeTruthy();
                    expect(styles.headerTitle.color).toBeTruthy();
                    expect(styles.input.color).toBeTruthy();
                    expect(styles.inputError.borderColor).toBeTruthy();
                    expect(styles.inlineErrorText.color).toBeTruthy();
                }).not.toThrow();
            });

            it(`evaluates PulsePreviewCard styles cleanly for ${name} without throwing or undefined properties`, () => {
                expect(() => {
                    const styles = makePreviewStyles({ colors, theme });
                    expect(styles).toBeDefined();
                    expect(styles.cardContainer).toBeDefined();
                    expect(styles.title.color).toBeTruthy();
                    expect(styles.reviewTitle.color).toBeTruthy();
                }).not.toThrow();
            });

            it(`evaluates PulseNudges styles cleanly for ${name} without throwing or undefined properties`, () => {
                expect(() => {
                    const styles = makeNudgeStyles({ colors, theme });
                    expect(styles).toBeDefined();
                    expect(styles.nudgeCard).toBeDefined();
                    expect(styles.nudgeTitle.color).toBeTruthy();
                }).not.toThrow();
            });
        }
    });
});
