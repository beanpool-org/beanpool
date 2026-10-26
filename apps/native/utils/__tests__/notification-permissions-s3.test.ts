/**
 * Front doors S3: notification permission at the tap, never at account creation (Fable design §0, §1.9, §3.9, §7).
 *
 * Requirements:
 * - No requestPermissionsAsync in the identity effect (app/_layout.tsx:769-772 removed).
 * - "Turn on notifications?" card at the end of How it Works and on Home until answered.
 * - Words:
 *     Title: "Turn on notifications?"
 *     Body: "So you hear when someone answers you, messages you, or asks to join. Nothing else."
 *     Buttons: "Turn on" · "Not now"
 * - Nothing asked after a restore (lands on Home; card asks only when tapped).
 * - Ask again at the first knock or message if declined, with the app's one-line reason first; never on second knock/message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    Alert: {
        alert: vi.fn(),
    },
    Linking: {
        openSettings: vi.fn(async () => {}),
    },
}));

const mem = vi.hoisted(() => ({
    async: new Map<string, string>(),
    secure: new Map<string, string>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));

const identityMock = vi.hoisted(() => ({
    loadIdentity: vi.fn(async () => null as { publicKey: string; privateKey: string } | null),
}));
vi.mock('../identity', () => identityMock);

const notificationsMock = vi.hoisted(() => ({
    getPermissionsAsync: vi.fn(async () => ({ status: 'undetermined' })),
    requestPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    getExpoPushTokenAsync: vi.fn(async () => ({ data: 'ExponentPushToken[test-token]' })),
    setNotificationChannelAsync: vi.fn(async () => {}),
    AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1, NONE: 0 },
}));

vi.mock('expo-notifications', () => ({
    default: notificationsMock,
    ...notificationsMock,
}));

const pushServiceMock = vi.hoisted(() => ({
    registerForPushNotifications: vi.fn(async () => 'ExponentPushToken[test-token]'),
}));

vi.mock('../../services/push-notifications', () => pushServiceMock);

import {
    NOTIFICATION_CARD_WORDS,
    readNotificationPermissionRecord,
    shouldShowNotificationCard,
    turnOnNotifications,
    declineNotifications,
    askNotificationPermissionOnAction,
    NOTIFICATIONS_OFF_IN_SETTINGS,
    type NotificationPermissionRecord,
} from '../notification-permission';

describe('S3: notification permission at the tap, never at account creation', () => {
    beforeEach(() => {
        mem.async.clear();
        mem.secure.clear();
        vi.clearAllMocks();
        notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' } as any);
        notificationsMock.requestPermissionsAsync.mockResolvedValue({ status: 'granted' } as any);
    });

    describe('no requestPermissionsAsync in the identity effect', () => {
        it('_layout.tsx must not register for push notifications or call requestPermissionsAsync on identity set', () => {
            const layoutPath = path.resolve(__dirname, '../../app/_layout.tsx');
            const layoutSource = fs.readFileSync(layoutPath, 'utf8');

            // The old effect at lines 769-772 registered for push notifications as soon as identity.publicKey existed.
            // S3 requires removing this effect so nothing is prompted at account set.
            const hasIdentityPushEffect = /useEffect\(\s*\(\)\s*=>\s*\{[^}]*registerForPushNotifications\(identity\.publicKey\)[^}]*\}\s*,\s*\[\s*identity\?\.publicKey\s*\]\s*\)/.test(layoutSource);
            expect(hasIdentityPushEffect).toBe(false);
        });
    });

    describe("the card's state machine", () => {
        it('starts in unanswered state on a fresh install and shows card until answered', async () => {
            const record = await readNotificationPermissionRecord();
            expect(record.state).toBe('unanswered');
            expect(shouldShowNotificationCard(record, false)).toBe(true);
        });

        it('does not show card if OS permission was already granted', () => {
            const record: NotificationPermissionRecord = { state: 'unanswered', updatedAt: Date.now() };
            expect(shouldShowNotificationCard(record, true)).toBe(false);
        });

        it('tapping Turn on requests permission, records granted state, and registers push token', async () => {
            notificationsMock.requestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' } as any);

            const result = await turnOnNotifications('test-pubkey');
            expect(result).toBe('granted');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);
            expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledWith('test-pubkey');

            const updated = await readNotificationPermissionRecord();
            expect(updated.state).toBe('granted');
            expect(shouldShowNotificationCard(updated, false)).toBe(false);
        });

        it('tapping Turn on without publicKey falls back to stored identity', async () => {
            identityMock.loadIdentity.mockResolvedValueOnce({ publicKey: 'stored-pubkey', privateKey: 'pk' });
            notificationsMock.requestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' } as any);

            const result = await turnOnNotifications();
            expect(result).toBe('granted');
            expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledWith('stored-pubkey');
        });

        it('tapping Turn on when permission is denied records declined state and does not register token', async () => {
            notificationsMock.requestPermissionsAsync.mockResolvedValueOnce({ status: 'denied' } as any);

            const result = await turnOnNotifications('test-pubkey');
            expect(result).toBe('declined');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);
            expect(pushServiceMock.registerForPushNotifications).not.toHaveBeenCalled();

            const updated = await readNotificationPermissionRecord();
            expect(updated.state).toBe('declined');
            expect(shouldShowNotificationCard(updated, false)).toBe(false);
        });

        it('tapping Not now transitions to declined and hides the card', async () => {
            await declineNotifications();

            const record = await readNotificationPermissionRecord();
            expect(record.state).toBe('declined');
            expect(shouldShowNotificationCard(record, false)).toBe(false);
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
        });

        it('after restore, nothing is asked automatically; card is shown on Home until answered', async () => {
            // A restored account has no prior local permission record on this phone
            const record = await readNotificationPermissionRecord();
            expect(record.state).toBe('unanswered');
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();

            // The card is shown on Home until answered
            expect(shouldShowNotificationCard(record, false)).toBe(true);

            // Tapping Turn on on Home asks for permission
            await turnOnNotifications('restored-pubkey');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);

            const after = await readNotificationPermissionRecord();
            expect(shouldShowNotificationCard(after, false)).toBe(false);
        });

        it('if declined, asks again at the first knock with one-line reason, but not on second knock', async () => {
            await declineNotifications();

            // First knock: should prompt with reason and buttons
            const askPromise = askNotificationPermissionOnAction('knock', 'test-pubkey', {
                promptUser: vi.fn(async () => 'turn_on' as const),
            });
            const res1 = await askPromise;
            expect(res1).toBe('granted');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);

            // Record should now have knockRetried: true
            const rec1 = await readNotificationPermissionRecord();
            expect(rec1.knockRetried).toBe(true);

            // Second knock: should not prompt again
            const promptMock2 = vi.fn();
            const res2 = await askNotificationPermissionOnAction('knock', 'test-pubkey', {
                promptUser: promptMock2,
            });
            expect(promptMock2).not.toHaveBeenCalled();
            expect(res2).toBe('granted');
        });

        it('if declined, asks again at the first message with one-line reason, but not on second message', async () => {
            await declineNotifications();

            // First message: should prompt with reason
            const promptMock1 = vi.fn(async () => 'not_now' as const);
            const res1 = await askNotificationPermissionOnAction('message', 'test-pubkey', {
                promptUser: promptMock1,
            });
            expect(promptMock1).toHaveBeenCalledTimes(1);
            expect(res1).toBe('declined');

            // Record should have messageRetried: true
            const rec1 = await readNotificationPermissionRecord();
            expect(rec1.messageRetried).toBe(true);

            // Second message: should not prompt again
            const promptMock2 = vi.fn();
            const res2 = await askNotificationPermissionOnAction('message', 'test-pubkey', {
                promptUser: promptMock2,
            });
            expect(promptMock2).not.toHaveBeenCalled();
            expect(res2).toBe('declined');
        });

        it('if unanswered, asks at the first knock with one-line reason, but not on second knock', async () => {
            // Fresh state is unanswered
            const askPromise = askNotificationPermissionOnAction('knock', 'test-pubkey', {
                promptUser: vi.fn(async () => 'turn_on' as const),
            });
            const res1 = await askPromise;
            expect(res1).toBe('granted');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);

            // Record should now have knockRetried: true
            const rec1 = await readNotificationPermissionRecord();
            expect(rec1.knockRetried).toBe(true);

            // Second knock: should not prompt again
            const promptMock2 = vi.fn();
            const res2 = await askNotificationPermissionOnAction('knock', 'test-pubkey', {
                promptUser: promptMock2,
            });
            expect(promptMock2).not.toHaveBeenCalled();
            expect(res2).toBe('granted');
        });

        it('if unanswered, asks at the first message with one-line reason, but not on second message', async () => {
            // Fresh state is unanswered
            const promptMock1 = vi.fn(async () => 'not_now' as const);
            const res1 = await askNotificationPermissionOnAction('message', 'test-pubkey', {
                promptUser: promptMock1,
            });
            expect(promptMock1).toHaveBeenCalledTimes(1);
            expect(res1).toBe('declined');

            // Record should have messageRetried: true
            const rec1 = await readNotificationPermissionRecord();
            expect(rec1.messageRetried).toBe(true);

            // Second message: should not prompt again
            const promptMock2 = vi.fn();
            const res2 = await askNotificationPermissionOnAction('message', 'test-pubkey', {
                promptUser: promptMock2,
            });
            expect(promptMock2).not.toHaveBeenCalled();
            expect(res2).toBe('declined');
        });

        it('if already granted, action never prompts user', async () => {
            await turnOnNotifications('test-pubkey');

            const promptMock = vi.fn();
            const res = await askNotificationPermissionOnAction('knock', 'test-pubkey', {
                promptUser: promptMock,
            });
            expect(promptMock).not.toHaveBeenCalled();
            expect(res).toBe('granted');
        });
    });

    // #2524 deciding review, finding 2: every Android 8–12 phone, and every member who allowed the old boot prompt, has a
    // phone that already allows notifications while this record is new (unanswered). They are never asked.
    describe('the phone already allows notifications', () => {
        for (const state of ['unanswered', 'declined'] as const) {
            for (const action of ['knock', 'message'] as const) {
                it(`record ${state}, first ${action}: no prompt, the token is registered silently, nothing stored as declined`, async () => {
                    if (state === 'declined') {
                        notificationsMock.getPermissionsAsync.mockResolvedValueOnce({ status: 'undetermined' } as any);
                        await declineNotifications();
                    }
                    notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true } as any);
                    const promptUser = vi.fn(async () => 'not_now' as const);

                    const res = await askNotificationPermissionOnAction(action, 'test-pubkey', { promptUser });

                    expect(promptUser).not.toHaveBeenCalled();
                    expect(res).toBe('granted');
                    expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
                    expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledWith('test-pubkey');
                    expect((await readNotificationPermissionRecord()).state).toBe(state);

                    // Spent: the next start asks nothing and registers nothing again.
                    pushServiceMock.registerForPushNotifications.mockClear();
                    await askNotificationPermissionOnAction(action, 'test-pubkey', { promptUser });
                    expect(pushServiceMock.registerForPushNotifications).not.toHaveBeenCalled();
                    expect(promptUser).not.toHaveBeenCalled();
                });
            }
        }

        it('Not now on the card stores nothing when the phone already allows notifications', async () => {
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true } as any);
            await declineNotifications();
            expect((await readNotificationPermissionRecord()).state).toBe('unanswered');
        });

        it('Not now on the card stores declined when the phone has not allowed them', async () => {
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: true } as any);
            await declineNotifications();
            expect((await readNotificationPermissionRecord()).state).toBe('declined');
        });
    });

    // #2524 deciding review, finding 3: once the phone won't show its dialog again (iOS after Don't Allow, Android 13+
    // after a second denial, notifications off in the phone's settings), requestPermissionsAsync returns "denied" with
    // nothing shown. Turn on then says why in one line and opens BeanPool's page in the phone's settings.
    describe("the phone won't ask again (canAskAgain: false)", () => {
        beforeEach(() => {
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false } as any);
            notificationsMock.requestPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false } as any);
        });

        it("Turn on gives the one-line reason, then opens the phone's settings; the card stays", async () => {
            const confirmSettings = vi.fn(async () => 'turn_on' as const);
            const openSettings = vi.fn(async () => {});

            const res = await turnOnNotifications('test-pubkey', undefined, { confirmSettings, openSettings });

            expect(res).toBe('settings');
            expect(confirmSettings).toHaveBeenCalledTimes(1);
            expect(openSettings).toHaveBeenCalledTimes(1);
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
            const rec = await readNotificationPermissionRecord();
            expect(rec.state).toBe('unanswered');
            expect(shouldShowNotificationCard(rec, false)).toBe(true);
        });

        it('the default Turn on shows the reason in an Alert, and its Open Settings opens Linking.openSettings', async () => {
            const rn = await import('react-native');
            const alert = vi.mocked(rn.Alert.alert);
            alert.mockImplementationOnce((_title, _body, buttons) => { buttons?.[1]?.onPress?.(); });

            const res = await turnOnNotifications('test-pubkey');

            expect(res).toBe('settings');
            expect(alert).toHaveBeenCalledTimes(1);
            const [title, body, buttons] = alert.mock.calls[0];
            expect(title).toBe('Turn on notifications?');
            expect(body).toBe(NOTIFICATIONS_OFF_IN_SETTINGS);
            expect(buttons?.map((b) => b.text)).toEqual(['Not now', 'Open Settings']);
            expect(rn.Linking.openSettings).toHaveBeenCalledTimes(1);
            expect((await readNotificationPermissionRecord()).state).toBe('unanswered');
        });

        it('Not now at that line stores declined and opens nothing', async () => {
            const openSettings = vi.fn(async () => {});
            const res = await turnOnNotifications('test-pubkey', undefined, {
                confirmSettings: vi.fn(async () => 'not_now' as const), openSettings,
            });
            expect(res).toBe('declined');
            expect(openSettings).not.toHaveBeenCalled();
            expect((await readNotificationPermissionRecord()).state).toBe('declined');
        });

        it('once the phone allows them, the card goes (back from settings)', async () => {
            await turnOnNotifications('test-pubkey', undefined, { confirmSettings: async () => 'turn_on', openSettings: async () => {} });
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true } as any);
            const rec = await readNotificationPermissionRecord();
            expect(shouldShowNotificationCard(rec, true)).toBe(false);
        });

        it("first message: one prompt that says they're off in settings; its button opens the settings, with no second dialog", async () => {
            await declineNotifications();
            const promptUser = vi.fn(async (_kind: 'ask' | 'settings') => 'turn_on' as const);
            const openSettings = vi.fn(async () => {});
            const rn = await import('react-native');

            const res = await askNotificationPermissionOnAction('message', 'test-pubkey', { promptUser, openSettings });

            expect(promptUser).toHaveBeenCalledTimes(1);
            expect(promptUser).toHaveBeenCalledWith('settings');
            expect(openSettings).toHaveBeenCalledTimes(1);
            expect(rn.Alert.alert).not.toHaveBeenCalled();
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
            expect(res).toBe('declined');
            expect((await readNotificationPermissionRecord()).messageRetried).toBe(true);
        });

        it('while the phone can still ask, the first-message prompt is the plain ask', async () => {
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true } as any);
            const promptUser = vi.fn(async (_kind: 'ask' | 'settings') => 'not_now' as const);
            await askNotificationPermissionOnAction('message', 'test-pubkey', { promptUser });
            expect(promptUser).toHaveBeenCalledWith('ask');
        });
    });

    // #2524 deciding review, finding 4: the first message's ask lives where every DM start passes, not in each screen.
    describe('the first-message ask covers every way a DM starts', () => {
        const root = path.resolve(__dirname, '../..');
        const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(p);
            return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
        });
        const sources = ['app', 'components', 'utils', 'services', 'tools'].flatMap((d) => walk(path.join(root, d)));

        it('createConversationApi is the only place a DM is made, and it asks before it calls the node', () => {
            const makers = sources.filter((f) => /\/api\/messages\/conversation[`'"]/.test(fs.readFileSync(f, 'utf8')));
            expect(makers.map((f) => path.relative(root, f))).toEqual(['utils/db.ts']);
            const db = fs.readFileSync(path.join(root, 'utils/db.ts'), 'utf8');
            const start = db.indexOf('export async function createConversationApi(');
            const body = db.slice(start, db.indexOf('\n}\n', start));
            const ask = body.indexOf("askNotificationPermissionOnAction('message'");
            expect(ask).toBeGreaterThan(-1);
            expect(ask).toBeLessThan(body.indexOf('/api/messages/conversation'));
            // Loaded lazily, so db.ts's many importers never load expo-notifications through it.
            expect(/^import[^\n]*notification-permission/m.test(db)).toBe(false);
        });

        it('every DM start in the app goes through createConversationApi', () => {
            const starts = sources.filter((f) => /createConversationApi\('dm'/.test(fs.readFileSync(f, 'utf8')))
                .map((f) => path.relative(root, f)).sort();
            // The starts the deciding review counted (post/[id] has six of them).
            expect(starts).toEqual(expect.arrayContaining([
                'app/(tabs)/people.tsx', 'app/new-message.tsx', 'app/post/[id].tsx', 'app/public-profile.tsx',
                'app/shop/[id].tsx', 'app/treasury-detail.tsx',
            ]));
        });
    });

    // #2524 deciding review, non-blocking polish.
    describe('the cards read right and take one tap at a time', () => {
        const root = path.resolve(__dirname, '../..');
        const welcome = fs.readFileSync(path.join(root, 'app/welcome.tsx'), 'utf8');
        const card = welcome.slice(welcome.indexOf('testID="guide-notification-card"'), welcome.indexOf('testID="guide-notification-not-now"') + 40);
        const home = fs.readFileSync(path.join(root, 'components/NotificationPermissionCard.tsx'), 'utf8');

        it("How it Works' card: the title is a header; both buttons are 48 dp, busy-guarded and say so", () => {
            expect(card).toMatch(/accessibilityRole="header">\{t\('Turn on notifications\?'\)\}/);
            expect(card).not.toMatch(/minHeight: 4[0-4]\b/);
            expect(card.match(/minHeight: 48/g)).toHaveLength(2);
            expect(card.match(/disabled=\{notifBusy\}/g)).toHaveLength(2);
            expect(card.match(/if \(notifBusy\) return;/g)).toHaveLength(2);
            expect(card.match(/accessibilityState=\{\{ busy: notifBusy, disabled: notifBusy \}\}/g)).toHaveLength(2);
        });

        it("Home's card: Not now says it is busy, as Turn on does", () => {
            const notNow = home.slice(home.lastIndexOf('<Pressable', home.indexOf('testID="notification-card-not-now"')), home.indexOf('testID="notification-card-not-now"'));
            expect(notNow).toContain('accessibilityState={{ busy, disabled: busy }}');
        });

        it("New message asks before its row's spinner shows", () => {
            const nm = fs.readFileSync(path.join(root, 'app/new-message.tsx'), 'utf8');
            const handler = nm.slice(nm.indexOf('const handleSelectMember'), nm.indexOf('setCreating(null);', nm.indexOf('const handleSelectMember')));
            expect(handler.indexOf("askNotificationPermissionOnAction('message'")).toBeGreaterThan(-1);
            expect(handler.indexOf("askNotificationPermissionOnAction('message'")).toBeLessThan(handler.indexOf('setCreating(pubkey)'));
        });
    });

    describe('words and copy', () => {
        it('matches the exact copy decided in design §3.9', () => {
            expect(NOTIFICATION_CARD_WORDS.title).toBe('Turn on notifications?');
            expect(NOTIFICATION_CARD_WORDS.body).toBe(
                'So you hear when someone answers you, messages you, or asks to join. Nothing else.'
            );
            expect(NOTIFICATION_CARD_WORDS.turnOn).toBe('Turn on');
            expect(NOTIFICATION_CARD_WORDS.notNow).toBe('Not now');
        });
    });
});
