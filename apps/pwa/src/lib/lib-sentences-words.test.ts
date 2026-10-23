/**
 * Sentences web lib files build that reached a screen in English, in the member's language (words: member-visible
 * sentences in shared code): paying the Commons (lib/debts.ts), the consent card's heading (lib/known-consent.ts), an
 * online event's link (lib/event-zone.ts), the profile's chat prefills (lib/archetypes.ts) and a tier's name
 * (lib/trust-tier.ts). English exactly as before; Portuguese from a catalog that has the sentence; the pseudo-locale
 * bracketed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@beanpool/core';
import { PAY_WORDS, REPAYMENT_WORDS, payFailureWords } from './debts';
import { consentHeading, type KnownConsent } from './known-consent';
import { eventLinkProblem } from './event-zone';
import { buildSynergyCollabMessage, buildSynergyNudgeMessage } from './archetypes';
import { tierWords } from './trust-tier';

afterEach(() => setLanguage('en'));

const bracketed = (s: string | null) => expect(s).toMatch(/^\[.*\]$/s);

describe('paying the Commons', () => {
    it('in English as before, in Portuguese from a catalog, bracketed in the pseudo-locale', () => {
        expect(REPAYMENT_WORDS.payConfirm(12.5, false)).toBe('Pay 12.50 Beans to the Commons? This can’t be undone.');
        expect(REPAYMENT_WORDS.paid(300, 'tx-1', true, { settled: true })).toBe('Paid 300 Beans to the Commons. Your debt is paid off and settled.');
        expect(payFailureWords(null)).toBe(PAY_WORDS.unanswered);
        setLanguage('pt', [{
            '{amount} Beans|{amount} Beans': { one: '{amount} Bean', other: '{amount} Beans' },
            'Pay {amount} to the Commons? This can’t be undone.': 'Pagar {amount} aos Comuns? Isto não pode ser desfeito.',
            [PAY_WORDS.unanswered]: 'O servidor da sua comunidade não respondeu, por isso este pagamento pode ter sido feito. Veja o seu Livro antes de pagar de novo.',
        }]);
        expect(REPAYMENT_WORDS.payConfirm(12, false)).toBe('Pagar 12 Beans aos Comuns? Isto não pode ser desfeito.');
        expect(payFailureWords(null)).toMatch(/^O servidor da sua comunidade não respondeu/);
        setLanguage('xx');
        for (const s of [REPAYMENT_WORDS.banner({ amount: 300, repaid: 0, left: 300 }), REPAYMENT_WORDS.linkLeft(5), REPAYMENT_WORDS.paid(5, 'r', false, {}, true),
            REPAYMENT_WORDS.payConfirm(5, true, 9)]) bracketed(s);
    });
});

describe('the consent card, an event\'s link, the chat prefills and a tier', () => {
    const consent = (v: number | null) => ({ version: 2, consentedVersion: v }) as unknown as KnownConsent;

    it('in English as before', () => {
        expect(consentHeading(consent(null))).toBe("What this community's admins can see");
        expect(consentHeading(consent(1))).toBe('Your community changed what its admins can see');
        expect(eventLinkProblem('zoom.example/abc')).toBe('The link to join must start with https:// or http://');
        expect(eventLinkProblem(`https://x.example/${'a'.repeat(600)}`)).toBe('The link to join can be at most 500 characters');
        expect(buildSynergyNudgeMessage('Ana')).toBe('Hey Ana! Take the 60-second working style quiz on your profile so we can see how we work best together! ⚡');
        expect(buildSynergyCollabMessage(undefined)).toBe("Hey there! I saw on your profile that we could work well together. Let's collaborate! 🤝");
        expect(tierWords('Elder')).toBe('Elder');
        expect(tierWords('Sage')).toBe('Sage');
    });

    it('in Portuguese from a catalog; a tier this build doesn\'t know, as it came', () => {
        setLanguage('pt', [{
            "What this community's admins can see": 'O que os administradores desta comunidade podem ver',
            'Hey {name}! Take the 60-second working style quiz on your profile so we can see how we work best together! ⚡': 'Olá {name}! Faz o questionário de 60 segundos no teu perfil para vermos como trabalhamos melhor juntos! ⚡',
            'Elder\u0004trust tier': 'Ancião',
        }]);
        expect(consentHeading(consent(null))).toBe('O que os administradores desta comunidade podem ver');
        expect(buildSynergyNudgeMessage('Ana')).toBe('Olá Ana! Faz o questionário de 60 segundos no teu perfil para vermos como trabalhamos melhor juntos! ⚡');
        expect(tierWords('Elder')).toBe('Ancião');
        expect(tierWords('Sage')).toBe('Sage');
        setLanguage('xx');
        for (const s of [consentHeading(consent(1)), eventLinkProblem('nope'), buildSynergyCollabMessage('Kofi'), tierWords('Steward')]) bracketed(s);
    });
});
