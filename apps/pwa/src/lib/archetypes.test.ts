import { describe, it, expect } from 'vitest';
import {
    ARCHETYPES,
    parseArchetype,
    calculateSynergy,
    scoreQuiz,
    QUICK_SPARK_QUESTIONS,
    DEEP_RESONANCE_QUESTIONS,
    type ArchetypeKey,
    type QuizResult,
} from '@beanpool/core';
import {
    buildSynergyCollabMessage,
    buildSynergyNudgeMessage,
    setChatPrefill,
    consumeChatPrefill,
} from './archetypes';

describe('Archetype Quiz Parity & Logic', () => {
    it('has all 9 canonical archetypes defined with full metadata', () => {
        const expectedKeys: ArchetypeKey[] = [
            'weaver',
            'connector',
            'catalyst',
            'artisan',
            'sage',
            'guardian',
            'spark',
            'champion',
            'harmonizer',
        ];

        for (const key of expectedKeys) {
            const arch = ARCHETYPES[key];
            expect(arch).toBeDefined();
            expect(arch.name).toBeTruthy();
            expect(arch.emoji).toBeTruthy();
            expect(arch.tagline).toBeTruthy();
            expect(arch.description).toBeTruthy();
            expect(Array.isArray(arch.superpowers)).toBe(true);
            expect(arch.superpowers.length).toBe(3);
            expect(Array.isArray(arch.idealPartners)).toBe(true);
            expect(arch.idealPartners.length).toBeGreaterThan(0);
        }
    });

    it('parses valid archetype JSON correctly', () => {
        const payload: QuizResult = scoreQuiz(['catalyst', 'catalyst', 'weaver'], 'quick');
        const str = JSON.stringify(payload);
        const parsed = parseArchetype(str);
        expect(parsed).not.toBeNull();
        expect(parsed?.primary).toBe('catalyst');
        expect(parsed?.secondary).toBe('weaver');
        expect(parsed?.mode).toBe('quick');
    });

    it('parses minimal/public archetype JSON without scores', () => {
        const publicStr = JSON.stringify({
            primary: 'sage',
            secondary: 'guardian',
            mode: 'deep',
            updatedAt: new Date().toISOString(),
        });
        const parsed = parseArchetype(publicStr);
        expect(parsed).not.toBeNull();
        expect(parsed?.primary).toBe('sage');
        expect(parsed?.secondary).toBe('guardian');
        expect(parsed?.mode).toBe('deep');
    });

    it('returns null for null, empty, or invalid archetype strings', () => {
        expect(parseArchetype(null)).toBeNull();
        expect(parseArchetype(undefined)).toBeNull();
        expect(parseArchetype('')).toBeNull();
        expect(parseArchetype('not-json')).toBeNull();
        expect(parseArchetype('{"primary": "invalid_archetype"}')).toBeNull();
    });

    it('calculates collaboration synergy between two members', () => {
        const synergy = calculateSynergy('catalyst', 'weaver');
        expect(synergy).not.toBeNull();
        expect(synergy.title).toBeTruthy();
        expect(synergy.emoji).toBeTruthy();
        expect(synergy.headline).toBeTruthy();
        expect(synergy.summary).toBeTruthy();
        expect(Array.isArray(synergy.strengths)).toBe(true);
        expect(synergy.collaborationTip).toBeTruthy();
    });

    it('scores quick spark quiz accurately', () => {
        expect(QUICK_SPARK_QUESTIONS.length).toBe(9);
        const answers: ArchetypeKey[] = [
            'catalyst', 'catalyst', 'catalyst',
            'weaver', 'weaver',
            'spark', 'sage', 'guardian', 'artisan'
        ];
        const res = scoreQuiz(answers, 'quick');
        expect(res.primary).toBe('catalyst');
        expect(res.secondary).toBe('weaver');
        expect(res.mode).toBe('quick');
    });

    it('scores deep resonance quiz accurately', () => {
        expect(DEEP_RESONANCE_QUESTIONS.length).toBe(27);
        const answers: ArchetypeKey[] = Array(27).fill('champion');
        const res = scoreQuiz(answers, 'deep');
        expect(res.primary).toBe('champion');
        expect(res.mode).toBe('deep');
    });

    it('builds synergy collaboration outreach message with headline and archetypes', () => {
        const msg = buildSynergyCollabMessage('Alice', 'Strong Synergy', 'Catalyst', 'Weaver');
        expect(msg).toBe("Hey Alice! I saw on your profile that we have Strong Synergy (Catalyst + Weaver). Let's collaborate! 🤝");

        const msgFallback = buildSynergyCollabMessage(undefined, 'High Resonance', 'Sage', 'Guardian');
        expect(msgFallback).toBe("Hey there! I saw on your profile that we have High Resonance (Sage + Guardian). Let's collaborate! 🤝");
    });

    it('builds synergy quiz nudge message matching native verbatim', () => {
        const msg = buildSynergyNudgeMessage('Bob');
        expect(msg).toBe('Hey Bob! Take the 60-second Archetype quiz on your profile so we can unlock our Collaboration Chemistry! ⚡');

        const msgFallback = buildSynergyNudgeMessage(undefined);
        expect(msgFallback).toBe('Hey there! Take the 60-second Archetype quiz on your profile so we can unlock our Collaboration Chemistry! ⚡');
    });

    it('stores and consumes recipient-scoped chat prefill preventing cross-chat leaks', () => {
        const alicePubkey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const bobPubkey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
        const message = buildSynergyCollabMessage('Alice', 'Strong Synergy', 'Catalyst', 'Weaver');

        // Store prefill targeted specifically to Alice
        setChatPrefill(message, alicePubkey);

        // Attempting to consume in Bob's chat must NOT return Alice's prefill
        const bobDraft = consumeChatPrefill('conv-bob', [bobPubkey]);
        expect(bobDraft).toBeNull();
        expect(sessionStorage.getItem('bp_chat_prefill')).not.toBeNull();

        // Consuming in Alice's chat must succeed and clear storage
        const aliceDraft = consumeChatPrefill('conv-alice', [alicePubkey]);
        expect(aliceDraft).toBe(message);
        expect(sessionStorage.getItem('bp_chat_prefill')).toBeNull();
    });
});
