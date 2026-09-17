import { describe, it, expect } from 'vitest';
import assert from 'node:assert';
import {
    ARCHETYPES,
    QUICK_SPARK_QUESTIONS,
    DEEP_RESONANCE_QUESTIONS,
    scoreQuiz,
    calculateSynergy,
    parseArchetype,
    type ArchetypeKey,
} from '../archetypes.js';

describe('Archetype Engine', () => {
    it('defines all 9 community archetypes without raw numbers or clinical labels', () => {
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

        assert.strictEqual(Object.keys(ARCHETYPES).length, 9);
        for (const key of expectedKeys) {
            const arch = ARCHETYPES[key];
            assert.ok(arch);
            assert.strictEqual(arch.key, key);
            assert.ok(arch.name);
            assert.ok(arch.emoji);
            assert.ok(arch.tagline);
            assert.ok(arch.description);
            assert.ok(arch.superpowers.length >= 2);
            assert.ok(arch.idealPartners.length >= 1);
        }
    });

    it('has 9 questions in Quick Spark mode and 27 in Deep Resonance mode', () => {
        assert.strictEqual(QUICK_SPARK_QUESTIONS.length, 9);
        assert.strictEqual(DEEP_RESONANCE_QUESTIONS.length, 27);

        for (const q of QUICK_SPARK_QUESTIONS) {
            assert.ok(q.prompt);
            assert.ok(q.options.length >= 2);
        }

        for (const q of DEEP_RESONANCE_QUESTIONS) {
            assert.ok(q.prompt);
            assert.ok(q.options.length >= 2);
        }
    });

    it('accurately scores Quick Spark quiz and identifies primary & secondary archetypes', () => {
        const answers: ArchetypeKey[] = [
            'weaver',
            'weaver',
            'weaver',
            'weaver',
            'connector',
            'connector',
            'spark',
            'sage',
            'guardian',
        ];

        const result = scoreQuiz(answers, 'quick');
        assert.strictEqual(result.primary, 'weaver');
        assert.strictEqual(result.secondary, 'connector');
        assert.strictEqual(result.mode, 'quick');
        assert.strictEqual(result.scores.weaver, 4);
        assert.strictEqual(result.scores.connector, 2);
        assert.strictEqual(result.scores.spark, 1);
    });

    it('accurately scores Deep Resonance quiz and handles tie-breakers with complementary wings', () => {
        const answers: ArchetypeKey[] = new Array(27).fill('spark');
        const result = scoreQuiz(answers, 'deep');

        assert.strictEqual(result.primary, 'spark');
        assert.strictEqual(result.secondary, 'weaver'); // Top ideal partner of spark
        assert.strictEqual(result.scores.spark, 27);
        assert.strictEqual(result.mode, 'deep');
    });

    it('calculates Kindred Spirits synergy when two members share the same archetype', () => {
        const insight = calculateSynergy('weaver', 'weaver');
        assert.strictEqual(insight.relationshipType, 'kindred_spirits');
        assert.strictEqual(insight.emoji, '🌱');
        assert.strictEqual(insight.title, 'Kindred Rhythms');
        assert.strictEqual(insight.headline, 'Similar ways of working');
    });

    it('calculates Dynamic Complements synergy for ideal partner pairings', () => {
        const insight = calculateSynergy('spark', 'weaver');
        assert.strictEqual(insight.relationshipType, 'dynamic_complements');
        assert.strictEqual(insight.emoji, '⚡');
        assert.strictEqual(insight.title, 'Complementary Synergy');
        assert.strictEqual(insight.headline, 'Strengths that complement');
    });

    it('calculates Balanced Allies synergy for general pairings', () => {
        const insight = calculateSynergy('artisan', 'sage');
        assert.strictEqual(insight.relationshipType, 'balanced_allies');
        assert.strictEqual(insight.emoji, '✨');
        assert.strictEqual(insight.title, 'Balanced Collaboration');
    });

    // Everything calculateSynergy returns is shown to a member about ANOTHER member, and no public
    // archetype labels is a standing refusal (docs/the-commons.md). Headlines used to read
    // "The Weaver + The Catalyst"; the kindred case named the shared type, and quoted its tagline.
    it('never names a type, or quotes a tagline, in anything shown about the other member', () => {
        const keys = Object.keys(ARCHETYPES) as ArchetypeKey[];
        // Names match case-sensitively: "brings the spark or vision" is prose, "Spark" is the type.
        const names = keys.flatMap(k => [ARCHETYPES[k].name, ARCHETYPES[k].name.replace(/^The\s+/, '')]);
        const taglines = keys.map(k => ARCHETYPES[k].tagline.toLowerCase());
        for (const viewer of keys) {
            for (const member of keys) {
                const insight = calculateSynergy(viewer, member);
                const shown = [insight.title, insight.headline, insight.summary, ...insight.strengths];
                for (const text of shown) {
                    for (const name of names) {
                        assert.ok(!text.includes(name), `${viewer}→${member}: "${text}" names "${name}"`);
                    }
                    for (const tagline of taglines) {
                        assert.ok(!text.toLowerCase().includes(tagline), `${viewer}→${member}: "${text}" quotes "${tagline}"`);
                    }
                }
            }
        }
    });

    it('parses JSON string, JSON-encoded keys, and raw keys cleanly with parseArchetype', () => {
        const validJson = JSON.stringify({
            primary: 'catalyst',
            secondary: 'sage',
            mode: 'deep',
            scores: { catalyst: 10, sage: 8 },
            updatedAt: '2026-08-16T00:00:00.000Z',
        });

        const parsed = parseArchetype(validJson);
        assert.ok(parsed);
        assert.strictEqual(parsed?.primary, 'catalyst');
        assert.strictEqual(parsed?.secondary, 'sage');

        const parsedRawKey = parseArchetype('guardian');
        assert.strictEqual(parsedRawKey?.primary, 'guardian');

        const parsedJsonStringKey = parseArchetype('"weaver"');
        assert.strictEqual(parsedJsonStringKey?.primary, 'weaver');

        // Rejects prototype properties
        assert.strictEqual(parseArchetype('toString'), null);
        assert.strictEqual(parseArchetype('constructor'), null);
        assert.strictEqual(parseArchetype('valueOf'), null);

        assert.strictEqual(parseArchetype(null), null);
        assert.strictEqual(parseArchetype(''), null);
        assert.strictEqual(parseArchetype('invalid_string'), null);
    });
});
