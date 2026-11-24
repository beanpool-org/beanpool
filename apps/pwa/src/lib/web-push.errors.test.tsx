/**
 * Web push error truth (lane web-push-error-truth): every failure point says which side refused, with plain words through
 * word()/t() and no raw error text. Covers WebPushRow, TellMeCard (waiting page and Home's Find card via tellMeAtHome),
 * NotifyAsk, and keepWebPushAtOpen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { notifyJoinWords } from '@beanpool/core';
import {
    TELL_ME_WORDS, WEB_PUSH_FAILURE_WORDS, isWebPushFailure, keepWebPushAtOpen, tellMeAtHome, tellMeWhenTheyAnswer, turnOnWebPush,
    webPushFailureMessage, type PushEnv, type WebPushFailure,
} from './web-push';
import { getNodeApiUrl, signedFetchAt } from './api';
import { NodeTooOldError, hearNodeVersionForTests, resetNodeVersionGateForTests } from './node-version-gate';
import { WebPushRow } from '../components/WebPushRow';
import { TellMeCard } from '../components/TellMeCard';
import { NotifyAsk } from '../components/NotifyAsk';

vi.mock('./api', () => ({
    signedFetchAt: vi.fn(),
    sendSignedAt: vi.fn(async () => {}),
    getNodeApiUrl: vi.fn(() => ''),
    getPushNoticeDetails: vi.fn(),
}));

const MEMBER = 'ab'.repeat(32);
const identity = { publicKey: MEMBER, privateKey: '00'.repeat(48) } as any;
const VAPID_KEY = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
const RAW_SECRET_ERR = 'RAW_INTERNAL_ERROR_DO_NOT_SHOW_98765';

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    maxTouchPoints: 0,
    secure: true,
    serviceWorker: true,
    pushManager: true,
    notification: true,
    permission: 'default',
    standalone: false,
    brave: false,
    ...over,
});

interface FailureCase {
    name: string;
    setup: () => void;
    expectedKind: 'blocked' | 'dismissed' | 'failed';
    expectedSentence: string | null;
    expectedReason?: WebPushFailure['reason'];
    expectedCode?: string | null;
}

function setupHappyBrowser() {
    const subscribe = vi.fn(async () => ({
        toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'P', auth: 'A' } }),
    }));
    const registration: any = {
        installing: null,
        waiting: null,
        active: {},
        pushManager: { getSubscription: async () => null, subscribe },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
        value: { register: vi.fn(async () => registration), getRegistration: vi.fn(async () => registration) },
        configurable: true,
    });
    (globalThis as any).Notification = {
        permission: 'default',
        requestPermission: vi.fn(async () => {
            (globalThis as any).Notification.permission = 'granted';
            return 'granted';
        }),
    };
    (window as any).PushManager = function PushManager() {};
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ vapidKey: VAPID_KEY }), { status: 200 }));
    vi.mocked(signedFetchAt).mockImplementation(async () => new Response(JSON.stringify({ success: true, subId: 'c'.repeat(64), pushKey: 'd'.repeat(64), vapidKey: VAPID_KEY }), { status: 201 }));
    return { registration, subscribe };
}

const FAILURE_TABLE: FailureCase[] = [
    {
        name: 'permission denied',
        setup: () => {
            setupHappyBrowser();
            (globalThis as any).Notification.requestPermission = vi.fn(async () => {
                (globalThis as any).Notification.permission = 'denied';
                return 'denied';
            });
        },
        expectedKind: 'blocked',
        expectedSentence: TELL_ME_WORDS.blocked,
    },
    {
        name: 'permission dismissed',
        setup: () => {
            setupHappyBrowser();
            (globalThis as any).Notification.requestPermission = vi.fn(async () => 'default');
        },
        expectedKind: 'dismissed',
        expectedSentence: null,
    },
    {
        name: 'requestPermission throws',
        setup: () => {
            setupHappyBrowser();
            (globalThis as any).Notification.requestPermission = vi.fn(async () => { throw new Error(RAW_SECRET_ERR); });
        },
        expectedKind: 'failed',
        expectedReason: 'browser',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.browser,
    },
    {
        name: 'serviceWorker.register throws',
        setup: () => {
            setupHappyBrowser();
            Object.defineProperty(navigator, 'serviceWorker', {
                value: { register: vi.fn(async () => { throw new Error(RAW_SECRET_ERR); }) },
                configurable: true,
            });
        },
        expectedKind: 'failed',
        expectedReason: 'browser',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.browser,
    },
    {
        name: 'service worker activation fails (redundant)',
        setup: () => {
            setupHappyBrowser();
            const worker: any = {
                state: 'installing',
                listeners: [] as (() => void)[],
                addEventListener(_: string, fn: () => void) { this.listeners.push(fn); },
                removeEventListener() {},
            };
            const registration: any = { installing: worker, waiting: null, active: null, pushManager: { getSubscription: async () => null, subscribe: vi.fn() } };
            Object.defineProperty(navigator, 'serviceWorker', {
                value: {
                    register: vi.fn(async () => {
                        setTimeout(() => { worker.state = 'redundant'; worker.listeners.forEach((f: () => void) => f()); }, 5);
                        return registration;
                    }),
                },
                configurable: true,
            });
        },
        expectedKind: 'failed',
        expectedReason: 'browser',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.browser,
    },
    {
        name: 'pushManager.subscribe throws (e.g. Brave push off)',
        setup: () => {
            const { registration } = setupHappyBrowser();
            registration.pushManager.subscribe = vi.fn(async () => { throw new DOMException(RAW_SECRET_ERR, 'AbortError'); });
        },
        expectedKind: 'failed',
        expectedReason: 'browser',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.browser,
    },
    {
        name: 'key read refused (503)',
        setup: () => {
            setupHappyBrowser();
            vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: RAW_SECRET_ERR }), { status: 503 }));
        },
        expectedKind: 'failed',
        expectedReason: 'key',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.key,
    },
    {
        name: 'key read network error',
        setup: () => {
            setupHappyBrowser();
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError(RAW_SECRET_ERR));
        },
        expectedKind: 'failed',
        expectedReason: 'key',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.key,
    },
    {
        name: 'node too old (named version)',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockRejectedValue(new NodeTooOldError('1.3.0'));
        },
        expectedKind: 'failed',
        expectedReason: 'node_too_old',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.nodeTooOld,
    },
    {
        name: 'node version unreadable',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockRejectedValue(new NodeTooOldError(null));
        },
        expectedKind: 'failed',
        expectedReason: 'node_too_old',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.nodeUnreachable,
    },
    {
        name: 'POST /api/web-push network error',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockRejectedValue(new TypeError(RAW_SECRET_ERR));
        },
        expectedKind: 'failed',
        expectedReason: 'network',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.network,
    },
    {
        name: 'node refused: 429 key_rate_limited',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'key_rate_limited' }), { status: 429 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: 'key_rate_limited',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.rateLimited,
    },
    {
        name: 'node refused: 503 standby',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'standby' }), { status: 503 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: 'standby',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.standby,
    },
    {
        name: 'node refused: 503 no_seal_key',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'no_seal_key' }), { status: 503 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: 'no_seal_key',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.noSealKey,
    },
    {
        name: 'node refused: 503 no_key',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'no_key' }), { status: 503 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: 'no_key',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.noKey,
    },
    {
        name: 'node refused: 403 no_open_request',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'no_open_request' }), { status: 403 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: 'no_open_request',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.noOpenRequest,
    },
    {
        name: 'node refused: 404 feature_off',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'feature_off', feature: 'knocks' }), { status: 404 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: 'feature_off',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.featureOff,
    },
    {
        name: 'node refused: 400 bad_subscription',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'bad_subscription' }), { status: 400 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: 'bad_subscription',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.badSubscription,
    },
    {
        name: 'node refused: 400 bad_host',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'bad_host' }), { status: 400 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: 'bad_host',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.badHost,
    },
    {
        name: 'node refused: 401 unsigned',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'unsigned' }), { status: 401 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: 'unsigned',
        expectedSentence: WEB_PUSH_FAILURE_WORDS.unsigned,
    },
    {
        name: 'node refused: 400 with no code',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR }), { status: 400 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: null,
        expectedSentence: WEB_PUSH_FAILURE_WORDS.badRequest,
    },
    {
        name: 'node refused: 500 with no code',
        setup: () => {
            setupHappyBrowser();
            vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR }), { status: 500 }));
        },
        expectedKind: 'failed',
        expectedReason: 'refused',
        expectedCode: null,
        expectedSentence: WEB_PUSH_FAILURE_WORDS.fallback,
    },
];

describe('web push failure table: every failure point -> exact sentence shown', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.mocked(getNodeApiUrl).mockReturnValue('');
        vi.mocked(signedFetchAt).mockReset();
        resetNodeVersionGateForTests();
        hearNodeVersionForTests(window.location.origin);
    });
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        document.documentElement.classList.remove('dark');
    });

    it.each(FAILURE_TABLE)('$name -> shows the right side and never raw error text', async (tc) => {
        tc.setup();
        render(createElement(WebPushRow, { identity }));
        fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));

        if (tc.expectedKind === 'blocked') {
            await waitFor(() => expect(screen.getByTestId('web-push-row').getAttribute('data-state')).toBe('blocked'));
            expect(screen.getByTestId('web-push-why').textContent).toBe(tc.expectedSentence);
            expect(screen.queryByTestId('web-push-failed')).toBeNull();
        } else if (tc.expectedKind === 'dismissed') {
            await waitFor(() => expect(screen.getByRole('button', { name: 'Turn on' })).not.toBeDisabled());
            expect(screen.getByTestId('web-push-row').getAttribute('data-state')).toBe('off');
            expect(screen.queryByTestId('web-push-failed')).toBeNull();
            expect(screen.queryByTestId('web-push-why')).toBeNull();
        } else {
            const alert = await screen.findByTestId('web-push-failed');
            expect(alert.textContent).toBe(tc.expectedSentence);
            expect(alert.getAttribute('role')).toBe('alert');
            expect(alert.className).toContain('break-words');
            expect(alert.className).toContain('text-bp-ink-danger');
        }
        expect(document.body.textContent).not.toContain(RAW_SECRET_ERR);
    });

    it('turnOnWebPush returns the structured WebPushFailure reason and code for each failure case', async () => {
        for (const tc of FAILURE_TABLE) {
            if (tc.expectedKind !== 'failed') continue;
            vi.restoreAllMocks();
            tc.setup();
            const r = await turnOnWebPush(window.location.origin, identity, 'en', env());
            expect(isWebPushFailure(r), tc.name).toBe(true);
            if (isWebPushFailure(r)) {
                expect(r.reason, tc.name).toBe(tc.expectedReason);
                if (tc.expectedReason === 'refused' && r.reason === 'refused') {
                    expect(r.code, tc.name).toBe(tc.expectedCode);
                }
                expect(webPushFailureMessage(r), tc.name).toBe(tc.expectedSentence);
            }
        }
    });
});

describe('other callers sharing these steps (TellMeCard, tellMeAtHome, keepWebPushAtOpen, NotifyAsk)', () => {
    const RIVERSIDE = 'https://riverside.example';

    beforeEach(() => {
        localStorage.clear();
        vi.mocked(getNodeApiUrl).mockReturnValue('');
        vi.mocked(signedFetchAt).mockReset();
        resetNodeVersionGateForTests();
        hearNodeVersionForTests(window.location.origin);
        hearNodeVersionForTests(RIVERSIDE);
    });
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        document.documentElement.classList.remove('dark');
    });

    it('TellMeCard on the waiting page shows browser-side and node-code sentences, and falls back to TELL_ME_WORDS.failed on unknown 500', async () => {
        const { registration } = setupHappyBrowser();
        registration.pushManager.subscribe = vi.fn(async () => { throw new Error(RAW_SECRET_ERR); });
        render(createElement(TellMeCard, { origin: window.location.origin, identity, name: 'Byron', subscribe: tellMeWhenTheyAnswer }));
        fireEvent.click(screen.getByTestId('tell-me'));
        const off = await screen.findByTestId('tell-me-off');
        expect(off.textContent).toBe(WEB_PUSH_FAILURE_WORDS.browser);
        expect(off.textContent).not.toContain(RAW_SECRET_ERR);
        cleanup();

        setupHappyBrowser();
        vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'no_open_request' }), { status: 403 }));
        render(createElement(TellMeCard, { origin: window.location.origin, identity, name: 'Byron', subscribe: tellMeWhenTheyAnswer }));
        fireEvent.click(screen.getByTestId('tell-me'));
        expect((await screen.findByTestId('tell-me-off')).textContent).toBe(WEB_PUSH_FAILURE_WORDS.noOpenRequest);
        cleanup();

        setupHappyBrowser();
        vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR }), { status: 500 }));
        render(createElement(TellMeCard, { origin: window.location.origin, identity, name: 'Byron', subscribe: tellMeWhenTheyAnswer }));
        fireEvent.click(screen.getByTestId('tell-me'));
        expect((await screen.findByTestId('tell-me-off')).textContent).toBe(TELL_ME_WORDS.failed);
    });

    it('TellMeCard compact (Home Find card via tellMeAtHome) shows bad_host on non-https and code-specific sentences on refusal', async () => {
        setupHappyBrowser();
        render(createElement(TellMeCard, { origin: 'http://riverside.example', identity, name: 'Riverside', subscribe: tellMeAtHome, compact: true }));
        fireEvent.click(screen.getByTestId('tell-me'));
        expect((await screen.findByTestId('tell-me-off')).textContent).toBe(WEB_PUSH_FAILURE_WORDS.badHost);
        cleanup();

        setupHappyBrowser();
        vi.mocked(signedFetchAt).mockResolvedValue(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'standby' }), { status: 503 }));
        render(createElement(TellMeCard, { origin: RIVERSIDE, identity, name: 'Riverside', subscribe: tellMeAtHome, compact: true }));
        fireEvent.click(screen.getByTestId('tell-me'));
        expect((await screen.findByTestId('tell-me-off')).textContent).toBe(WEB_PUSH_FAILURE_WORDS.standby);
    });

    it('keepWebPushAtOpen returns the structured WebPushFailure on network error, node_too_old, and node refusal', async () => {
        setupHappyBrowser();
        const pin = [{ origin: window.location.origin, publicKey: MEMBER, subId: 'e'.repeat(64), pushKey: 'd'.repeat(64), vapidKey: VAPID_KEY, for: 'member' }];
        localStorage.setItem('beanpool_web_push', JSON.stringify(pin));
        const sub = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'P', auth: 'A' } }) };
        Object.defineProperty(navigator, 'serviceWorker', {
            value: { getRegistration: vi.fn(async () => ({ pushManager: { getSubscription: async () => sub } })) },
            configurable: true,
        });

        vi.mocked(signedFetchAt).mockRejectedValueOnce(new TypeError(RAW_SECRET_ERR));
        expect(await keepWebPushAtOpen(window.location.origin, identity, 'en', env({ permission: 'granted' }))).toEqual({ reason: 'network' });

        vi.mocked(signedFetchAt).mockRejectedValueOnce(new NodeTooOldError('1.3.0'));
        expect(await keepWebPushAtOpen(window.location.origin, identity, 'en', env({ permission: 'granted' }))).toEqual({ reason: 'node_too_old', nodeVersion: '1.3.0' });

        vi.mocked(signedFetchAt).mockResolvedValueOnce(new Response(JSON.stringify({ error: RAW_SECRET_ERR, code: 'no_seal_key' }), { status: 503 }));
        expect(await keepWebPushAtOpen(window.location.origin, identity, 'en', env({ permission: 'granted' }))).toEqual({ reason: 'refused', status: 503, code: 'no_seal_key' });
    });

    it('NotifyAsk shows the specific failure sentence in light and dark mode with wrap-safe classes', () => {
        const words = notifyJoinWords({ kind: 'community' });
        for (const dark of [false, true]) {
            document.documentElement.classList.toggle('dark', dark);
            render(createElement(NotifyAsk, {
                form: 'card',
                words,
                busy: false,
                failed: { reason: 'browser' },
                onTurnOn: vi.fn(),
                onLater: vi.fn(),
            }));
            const alert = screen.getByTestId('notify-ask-failed');
            expect(alert.textContent).toBe(WEB_PUSH_FAILURE_WORDS.browser);
            expect(alert.className).toContain('break-words');
            expect(alert.className).toContain('text-bp-ink-danger');
            cleanup();
        }
    });
});
