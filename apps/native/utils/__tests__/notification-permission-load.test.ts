/**
 * #2524 deciding review, finding 1: Home and How it Works import utils/notification-permission.ts, so it must load with
 * nothing but React Native and storage mocked. When it imported services/push-notifications (which require()s
 * expo-notifications, expo-device, expo-router… as it loads) and ./identity at the top, six screen suites that mock only
 * what their screen uses failed to load (find-community-words-render, home-screen-render, home-tips-landing,
 * members-on-demand-screens-render, talk-words-render, welcome-words-render). Both are loaded inside the functions that
 * need them now. No other module is mocked here on purpose.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, Alert: { alert: vi.fn() }, Linking: { openSettings: vi.fn() } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) },
}));

describe('notification-permission loads without the push service, identity or expo-notifications', () => {
    it('imports with only react-native and storage mocked', async () => {
        const mod = await import('../notification-permission');
        expect(typeof mod.turnOnNotifications).toBe('function');
        expect(typeof mod.askNotificationPermissionOnAction).toBe('function');
    });

    it('has no top-level import of services/push-notifications, ./identity or expo-notifications (only its types)', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../notification-permission.ts'), 'utf8');
        const staticImports = src.split('\n').filter((l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l));
        expect(staticImports.some((l) => /push-notifications/.test(l))).toBe(false);
        expect(staticImports.some((l) => /['"]\.\/identity['"]/.test(l))).toBe(false);
        expect(staticImports.some((l) => /['"]expo-notifications['"]/.test(l))).toBe(false);
    });

    it('reads the phone as not allowing notifications where expo-notifications cannot load, and never throws', async () => {
        const { checkOsNotificationPermission } = await import('../notification-permission');
        await expect(checkOsNotificationPermission()).resolves.toBe(false);
    });

    it('asks nothing at a first message or knock where expo-notifications cannot load: there is nothing to turn on', async () => {
        const { askNotificationPermissionOnAction } = await import('../notification-permission');
        const { Alert } = await import('react-native');
        await expect(askNotificationPermissionOnAction('message', 'k')).resolves.toBe('unanswered');
        await expect(askNotificationPermissionOnAction('knock', 'k')).resolves.toBe('unanswered');
        expect(Alert.alert).not.toHaveBeenCalled();
    });
});
