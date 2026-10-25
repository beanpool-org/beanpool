import { describe, it, expect } from 'vitest';
import { word } from '../words.js';
import { startRows, type StartNodeFeatures } from '../start-something.js';

describe('startRows in @beanpool/core by shape (Fable 5.1 §3.2, §5 S2)', () => {
    const ALL_ON: StartNodeFeatures = { beans: true, enterprises: true, decisions: true };

    it('Beans on + enterprises on + decisions on + canPropose: true → 6 rows in exact order', () => {
        const rows = startRows(ALL_ON, { canPropose: true });
        expect(rows.map(r => r.key)).toEqual(['chat', 'project', 'enterprise', 'decision', 'poll', 'event']);
        expect(rows[0]).toEqual({
            key: 'chat',
            emoji: '👥',
            title: word('Chat group'),
            line: word('A place to talk with some people. Holds no Beans.'),
            section: 'commons',
        });
        expect(rows[1]).toEqual({
            key: 'project',
            emoji: '🌱',
            title: word('Project'),
            line: word('A goal in Beans, a leader, usually an end date.'),
            section: 'commons',
        });
        expect(rows[2]).toEqual({
            key: 'enterprise',
            emoji: '🏛️',
            title: word('Enterprise'),
            line: word('Keeps going and trades. Its keepers run it.'),
            section: 'commons',
        });
        expect(rows[3]).toEqual({
            key: 'decision',
            emoji: '🗳️',
            title: word('Decision'),
            line: word('A binding vote for the whole community.'),
            section: 'commons',
        });
        expect(rows[4]).toEqual({
            key: 'poll',
            emoji: '📊',
            title: word('Poll'),
            line: word('A quick question for everyone. Open vote.'),
            section: 'market',
        });
        expect(rows[5]).toEqual({
            key: 'event',
            emoji: '📅',
            title: word('Event'),
            line: word("A time and a place. People say they're going."),
            section: 'market',
        });
    });

    it('beans:false → no Project/Enterprise (4 rows: chat, decision, poll, event)', () => {
        const rows = startRows({ beans: false, decisions: true }, { canPropose: true });
        expect(rows.map(r => r.key)).toEqual(['chat', 'decision', 'poll', 'event']);
    });

    it('decisions:false → no Decision (5 rows: chat, project, enterprise, poll, event)', () => {
        const rows = startRows({ beans: true, enterprises: true, decisions: false }, { canPropose: true });
        expect(rows.map(r => r.key)).toEqual(['chat', 'project', 'enterprise', 'poll', 'event']);
    });

    it('enterprises:false → no Project/Enterprise (4 rows: chat, decision, poll, event)', () => {
        const rows = startRows({ beans: true, enterprises: false, decisions: true }, { canPropose: true });
        expect(rows.map(r => r.key)).toEqual(['chat', 'decision', 'poll', 'event']);
    });

    it('canPropose:false with Beans on → standing line "Opens after your first completed trade."', () => {
        const rows = startRows(ALL_ON, { canPropose: false });
        const decisionRow = rows.find(r => r.key === 'decision');
        expect(decisionRow).toBeDefined();
        expect(decisionRow?.standingLine).toEqual(word('Opens after your first completed trade.'));
    });

    it('canPropose:false with Beans off → standing line "Node admins propose here."', () => {
        const rows = startRows({ beans: false, decisions: true }, { canPropose: false });
        const decisionRow = rows.find(r => r.key === 'decision');
        expect(decisionRow).toBeDefined();
        expect(decisionRow?.standingLine).toEqual(word('Node admins propose here.'));
    });

    it('enterprises preview → no Project/Enterprise even if features say true', () => {
        const rows = startRows(ALL_ON, { canPropose: true, enterprisesPreview: true });
        expect(rows.map(r => r.key)).toEqual(['chat', 'decision', 'poll', 'event']);
    });

    it('decisions preview → Decision row shown even if decisions is false, without standing line', () => {
        for (const beans of [true, false]) {
            const rows = startRows({ beans, enterprises: true, decisions: false }, { canPropose: false, decisionsPreview: true });
            expect(rows.map(r => r.key)).toEqual(beans ? ['chat', 'project', 'enterprise', 'decision', 'poll', 'event'] : ['chat', 'decision', 'poll', 'event']);
            const decisionRow = rows.find(r => r.key === 'decision');
            expect(decisionRow).toBeDefined();
            expect(decisionRow?.standingLine).toBeUndefined();
        }
    });
});
