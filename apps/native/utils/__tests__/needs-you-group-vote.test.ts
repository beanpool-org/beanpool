import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { needsTargetHref, groupVoteHref } from '../needs-you';

/**
 * A chat group's vote (DESIGN-group-decisions §2.8, slice S3): Home's vote line and the push both land on the group — its
 * chat, told it is a group, with the info sheet open on its Decisions block — never Talk's list and never Commons → Decide.
 * The node sends the line a target of `{ to: 'group', id }` only to an app that asks with `lands=group`; the two ship
 * together.
 */
const GROUP = '0f8e2c1a-5b6d-4e7f-9a0b-1c2d3e4f5a6b';
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf-8');

describe("a group's vote lands on the group", () => {
    it("Home's line opens the group's chat with its info sheet open", () => {
        expect(needsTargetHref({ to: 'group', id: GROUP })).toEqual({ pathname: '/chat/[id]', params: { id: GROUP, group: '1', info: '1' } });
        expect(groupVoteHref(GROUP).pathname).not.toMatch(/tabs/);
    });

    it("Home's read and the header's say the app opens a group (lands=group; home-store.test.ts checks the address)", () => {
        expect(read('utils/home-store.ts')).toMatch(/return `\/api\/home\?cards=\$\{asked\.join\(','\)\}&lands=enterprise,group/);
    });

    it('the chat screen takes info=1 to the group view, which opens its info sheet once the group has loaded', () => {
        const screen = read('app/chat/[id].tsx');
        expect(screen).toContain("openInfo={info === '1'}");
        const view = read('components/GroupChatView.tsx');
        expect(view).toContain('if (openInfo && !infoOpenedOnArrival.current) {');
        expect(view).toContain('setInfoOpen(true);');
    });

    it("the group's info sheet draws the Decisions block, and a closed group shows closed", () => {
        const modal = read('components/GroupDetailModal.tsx');
        expect(modal).toContain('<GroupDecisions');
        expect(modal).toContain('{closed && (');
        expect(modal).toContain('{isConvenor && !closed && (');
        expect(modal).toContain('{isMember && onPostToGroup && !closed && (');
    });
});
