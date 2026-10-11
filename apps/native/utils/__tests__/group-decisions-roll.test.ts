import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Who votes on a group's vote, on the phone (#1784 review B1, N1, N2, N3): the vote's own roll as the node sends it
 * (each card's canVote), never who is in the group now. Someone removed or made an observer mid-vote still votes; someone
 * who joined since is not offered it. The node's half is test-decisions-group section 7; the web's is
 * GroupDetailModal.votes.test.tsx.
 */
const ROOT = path.join(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, 'components', f), 'utf-8');
const block = read('EnterpriseDecisions.tsx');
const sheet = read('GroupDetailModal.tsx');
const chat = read('GroupChatView.tsx');

describe("a group's votes follow each vote's own roll", () => {
    it('Yes / No are drawn from the card\'s canVote, never the list\'s onRoll', () => {
        expect(block).toContain('{isOpen && !mine && d.canVote === true && (');
        expect(block).not.toMatch(/list\.onRoll/);
    });

    it('"You watch" only for an observer who votes on none of the open votes (the node\'s watching)', () => {
        expect(block).toContain('{list.watching === true && !list.closedAt && <Text');
    });

    it('the info sheet draws the votes for anyone the node answers, not only a member now', () => {
        expect(sheet).not.toMatch(/\{isMember && \(\s*<GroupDecisions/);
        expect(sheet).toMatch(/<GroupDecisions\s/);
    });

    it('the landing shows the votes when the chat read is refused (someone removed mid-vote) and info=1', () => {
        expect(chat).toContain("import { GroupDecisions } from './EnterpriseDecisions';");
        const errorBranch = chat.slice(chat.indexOf('if (error && !view) {'), chat.indexOf('if (!view) {'));
        expect(errorBranch).toContain("{kind === 'group' && openInfo && (");
        expect(errorBranch).toMatch(/<GroupDecisions groupId=\{id\}/);
    });

    it('the pickers offer only the people the node names (no suspended member)', () => {
        expect(block).toContain('people={list.nameable ? people.filter(p => list.nameable!.includes(p.pubkey)) : people}');
    });

    it('no silence vote panel in a closed group', () => {
        expect(sheet).toMatch(/\{isMember && !closed && \(\s*<GroupSuccessionPanel/);
    });
});
