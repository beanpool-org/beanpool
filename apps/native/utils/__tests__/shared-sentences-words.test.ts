// @vitest-environment jsdom
/**
 * The phone's sentences from shared code that reached a screen without t() (words: member-visible sentences in shared
 * code), in the member's language: the consent text's "Read all of it" / "Show less", the calm line a forged notification's
 * tap shows and its OK, Android's notification channels as the phone's settings list them, a claim the phone stops before
 * it is sent (components/key-lines.ts), a delete the community refused with only a status and a sign-in it wouldn't
 * disconnect (components/settings/settings-lines.ts), and the phone's own lock prompt, which carries no English label of
 * ours (iOS words its own buttons).
 *
 * Each is shown in Portuguese from a catalog that has it (the words round drafts the real ones after merge), in the
 * pseudo-locale with no letters outside a bracket, and in English exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock('react-native', async () => (await import('./key-words-harness')).nativeMock(alerts));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-router', () => ({ router: { push() {}, replace() {}, back() {} } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, getAllKeys: async () => [], multiRemove: async () => {} },
}));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)) };
});
vi.mock('../db', () => ({ clearDB: async () => {}, closeDB: async () => {}, initDB: async () => {} }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: async () => {} }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: () => {} }));
const prompts = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => true, isEnrolledAsync: async () => true, getEnrolledLevelAsync: async () => 3,
    authenticateAsync: async (options: Record<string, unknown>) => { prompts.options.push(options); return { success: true }; },
}));

import { pseudoLocalise, setLanguage, type Catalog } from '@beanpool/core';
import { ConsentText } from '../../components/ConsentText';
import { PushNoticeWarning } from '../../components/PushNoticeWarning';
import { keyLineWords } from '../../components/key-lines';
import { settingsLineWords } from '../../components/settings/settings-lines';
import { FORGED_NOTICE_LINE, warnAboutNotice } from '../push-notice-check';
import { notificationChannels } from '../notification-channels';
import { authenticateUser } from '../LocalAuth';
import { requireDeviceUnlock } from '../node-admin';
import { NoWordsNotice } from '../../components/NoWordsNotice';
import { ExampleHeader } from '../../components/showcase/LocalCommunityMark';
import { NO_WORDS_WAY_BACK, noWordsBeforeWipe } from '../no-words-copy';
import { beansLines } from '../home-cards';
import { bypassing } from './key-words-harness';

const ROOT = path.resolve(__dirname, '../..');
const source = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Portuguese for the sentences below: what a drafted catalog will hold. */
const PT: Catalog = {
    'Read all of it': 'Ler tudo',
    'Show less': 'Mostrar menos',
    [FORGED_NOTICE_LINE]: 'Essa notificação não veio da sua comunidade. Ignore o que dizia. O BeanPool nunca pede as suas 12 palavras nem uma palavra-passe numa notificação.',
    OK: 'Certo',
    'Held in Trust Alerts': 'Alertas de valores retidos',
    'Alerts for trust events (credits locked, released, cancelled)': 'Alertas de valores retidos (créditos bloqueados, libertados, cancelados)',
    'Direct Messages': 'Mensagens diretas',
    'Notifications for new messages': 'Notificações de mensagens novas',
    Marketplace: 'Mercado',
    'Requests and offers on your marketplace posts': 'Pedidos e ofertas nas suas publicações do mercado',
    'Account Recovery Alerts': 'Alertas de recuperação da conta',
    'Urgent alerts when someone tries to recover your account': 'Alertas urgentes quando alguém tenta recuperar a sua conta',
    'That is not a whole claim code.': 'Esse não é um código de reivindicação completo.',
    "The server's answer can't be used.": 'A resposta do servidor não pode ser usada.',
    "This phone's key can't be read.": 'A chave deste telemóvel não pode ser lida.',
    "This version of the app can't check claim codes safely.": 'Esta versão da app não consegue verificar códigos de reivindicação com segurança.',
    'No community node connection found.': 'Não foi encontrada nenhuma ligação a uma comunidade.',
    'Server returned {status}': 'O servidor respondeu {status}',
    'Could not disconnect {provider}: {reason}': 'Não foi possível desligar {provider}: {reason}',
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said = [];
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setLanguage('en');
});

const draw = (el: ReactNode) => act(() => root.render(el as any));
const click = (el: Element | null) => act(() => { (el as HTMLElement).click(); });

describe('a known community\'s consent text: "Read all of it" and "Show less"', () => {
    // A summary, then a list the card folds away (utils/known-consent.ts consentTextParts).
    const TEXT = 'Admins can see your balance when you are in debit. They see: your balance; your floor; your last sale.';

    it('in Portuguese from the catalog, in the pseudo-locale bracketed, and in English as before; the node\'s text as it came', () => {
        for (const [lang, more, less] of [['en', 'Read all of it', 'Show less'], ['pt', 'Ler tudo', 'Mostrar menos']] as const) {
            setLanguage(lang, lang === 'pt' ? [PT] : []);
            draw(createElement(ConsentText, { text: TEXT }));
            const button = host.querySelector('[data-testid="consent-read-all"]');
            expect(button?.textContent, lang).toBe(more);
            click(button);
            expect(host.querySelector('[data-testid="consent-read-all"]')?.textContent, lang).toBe(less);
            act(() => root.unmount());
            root = createRoot(host);
        }
        setLanguage('xx');
        draw(createElement(ConsentText, { text: TEXT }));
        const written = ['Admins can see your balance when you are in debit.', 'They see:', 'your balance;', 'your floor;', 'your last sale.'];
        expect(bypassing(host, written)).toEqual([]);
        click(host.querySelector('[data-testid="consent-read-all"]'));
        expect(host.querySelector('[data-testid="consent-read-all"]')?.textContent).toBe(pseudoLocalise('Show less'));
        expect(bypassing(host, written)).toEqual([]);
    });
});

describe('the calm line a forged notification\'s tap shows', () => {
    it('the line and its button in Portuguese, bracketed in the pseudo-locale, and the English the design asks for', () => {
        setLanguage('pt', [PT]);
        warnAboutNotice();
        draw(createElement(PushNoticeWarning));
        expect(host.textContent).toContain(PT[FORGED_NOTICE_LINE] as string);
        expect(host.querySelector('[role="button"]')?.textContent).toBe('Certo');
        act(() => root.unmount());
        root = createRoot(host);

        setLanguage('xx');
        warnAboutNotice();
        draw(createElement(PushNoticeWarning));
        expect(host.textContent).toContain(pseudoLocalise(FORGED_NOTICE_LINE));
        expect(bypassing(host)).toEqual([]);
        act(() => root.unmount());
        root = createRoot(host);

        setLanguage('en');
        warnAboutNotice();
        draw(createElement(PushNoticeWarning));
        expect(host.textContent).toBe(`${FORGED_NOTICE_LINE}OK`);
    });
});

describe('Android\'s notification channels, as the phone\'s settings list them', () => {
    it('the same ids and English as before; named and described in Portuguese from the catalog; BeanPool stays its name', () => {
        const en = notificationChannels();
        expect(en.map((c) => c.id)).toEqual(['default', 'escrow', 'chat', 'marketplace', 'recovery']);
        expect(en.map((c) => c.name)).toEqual(['BeanPool', 'Held in Trust Alerts', 'Direct Messages', 'Marketplace', 'Account Recovery Alerts']);
        setLanguage('pt', [PT]);
        const pt = notificationChannels();
        expect(pt.map((c) => c.name)).toEqual(['BeanPool', 'Alertas de valores retidos', 'Mensagens diretas', 'Mercado', 'Alertas de recuperação da conta']);
        expect(pt.find((c) => c.id === 'recovery')?.description).toBe('Alertas urgentes quando alguém tenta recuperar a sua conta');
        setLanguage('xx');
        for (const c of notificationChannels().filter((x) => x.id !== 'default')) {
            expect(c.name, c.id).toMatch(/^\[.*\]$/);
            expect(c.description, c.id).toMatch(/^\[.*\]$/);
        }
    });

    it('set from that list each time the phone gets its token, so a language change renames them', () => {
        const service = source('services/push-notifications.ts');
        expect(service).toContain('of notificationChannels()');
        expect(service).not.toMatch(/name: '[A-Z][a-z]+ [A-Za-z ]+'/);
    });
});

describe('a claim the phone stops before it is sent (utils/node-claim.ts buildClaimBody), as the claim screen shows it', () => {
    const STOPS = [
        "This version of the app can't check claim codes safely.", 'That is not a whole claim code.', "The server's answer can't be used.",
        "This phone's key can't be read.",
    ];

    it('each is written in node-claim.ts, reads in English as written, in Portuguese from the catalog, and bracketed in the pseudo-locale', () => {
        const claim = source('utils/node-claim.ts');
        for (const english of STOPS) {
            expect(claim, english).toContain(english);
            expect(keyLineWords(english)).toBe(english);
        }
        setLanguage('pt', [PT]);
        expect(STOPS.map(keyLineWords)).toEqual(STOPS.map((s) => PT[s]));
        setLanguage('xx');
        for (const english of STOPS) expect(keyLineWords(english)).toBe(pseudoLocalise(english));
    });
});

describe('Settings: a delete the community refused with only a status, and a sign-in it wouldn\'t disconnect', () => {
    it('the same English as node-post.ts and keeper-enrolment.ts write it; the status and the community\'s own answer as they came', () => {
        expect(source('utils/node-post.ts')).toContain("throw new Error('No community node connection found.')");
        expect(source('utils/node-post.ts')).toContain('`Server returned ${res.status}`');
        expect(source('utils/keeper-enrolment.ts')).toContain('`Could not disconnect ${provider}: ${detail.slice(0, 150)}`');
        for (const english of ['No community node connection found.', 'Server returned 503', 'Could not disconnect google: {"error":"not_found"}']) {
            expect(settingsLineWords(english)).toBe(english);
        }
        setLanguage('pt', [PT]);
        expect(settingsLineWords('No community node connection found.')).toBe('Não foi encontrada nenhuma ligação a uma comunidade.');
        expect(settingsLineWords('Server returned 503')).toBe('O servidor respondeu 503');
        expect(settingsLineWords('Could not disconnect google: {"error":"not_found"}')).toBe('Não foi possível desligar google: {"error":"not_found"}');
        setLanguage('xx');
        expect(settingsLineWords('Server returned 503')).toBe(pseudoLocalise('Server returned {status}').replace('{status}', '503'));
    });
});

describe('a phone with no 12 words: the notice on Settings and the not-recognised screen', () => {
    it('both kinds in the pseudo-locale, and in English exactly as utils/no-words-copy.ts writes them', () => {
        for (const kind of ['way-back', 'before-wipe'] as const) {
            setLanguage('en');
            draw(createElement(NoWordsNotice, { kind }));
            const english = host.textContent ?? '';
            expect(english, kind).toBe(kind === 'way-back' ? `🔑 ${NO_WORDS_WAY_BACK}` : `⚠️ ${noWordsBeforeWipe()}`);
            act(() => root.unmount());
            root = createRoot(host);
            setLanguage('xx');
            draw(createElement(NoWordsNotice, { kind }));
            expect(bypassing(host), kind).toEqual([]);
            act(() => root.unmount());
            root = createRoot(host);
        }
        setLanguage('xx');
        draw(createElement(NoWordsNotice, { kind: 'before-wipe', name: 'Riverbend' }));
        expect(bypassing(host, ['Riverbend'])).toEqual([]);
    });
});

describe('the global showcase\'s example header, and Your Beans\' tier', () => {
    it('"Example Valley · an example member" through t(); the tier the node names by its English id, as its word', () => {
        setLanguage('xx');
        draw(createElement(ExampleHeader));
        expect(bypassing(host)).toEqual([]);
        setLanguage('pt', [{ 'Resident\u0004trust tier': 'Residente' }]);
        expect(beansLines({ balance: 12, room: 200, tier: 'Resident', activated: true, frozen: false }).sub).toBe('Residente');
        // A tier a newer node names that this build doesn't know: as it came.
        expect(beansLines({ balance: 12, room: 200, tier: 'Sage', activated: true, frozen: false }).sub).toBe('Sage');
    });
});

describe('the phone\'s own lock prompt', () => {
    beforeEach(() => { prompts.options = []; });

    it('carries the reason it is given (the screen\'s, through t()) and no English button label of ours: iOS words its own', async () => {
        // Whether a pass counts is the door's clock's to judge (LocalAuth.ts timeDoorPrompt): here, only what was asked.
        await authenticateUser('Confirme que é você');
        await requireDeviceUnlock('Riverbend', 'Confirme que é você para gerir Riverbend');
        expect(prompts.options.map((o) => o.promptMessage)).toEqual(['Confirme que é você', 'Confirme que é você para gerir Riverbend']);
        for (const o of prompts.options) {
            expect(o).not.toHaveProperty('fallbackLabel');
            expect(o).not.toHaveProperty('cancelLabel');
            // The device's own fallback stays on, so Android shows no cancel label of ours either.
            expect(o.disableDeviceFallback).toBe(false);
        }
    });
});
