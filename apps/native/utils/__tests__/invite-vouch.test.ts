import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { offersInviteVouch } from '@beanpool/core';
import { readNodeProfile } from '../node-profile';

/**
 * Vouch for them on the phone's invite screen (Marty, 3 Nov). The node's word on whether an invite can carry a vouch has to
 * survive the phone's reading of it, or the control never shows. The control itself is measured in e2e/invite-vouch-320.mjs,
 * and invite-vouch-screen.test.ts drives the whole screen for real; what that mount can't reach, such as a tab coming back, is
 * read off people.tsx's source here, as NewEventModal's is in event-times.test.ts.
 */
const people = fs.readFileSync(path.join(__dirname, '../../app/(tabs)/people.tsx'), 'utf8');

describe('the phone reads the node\'s word on a vouch', () => {
    it('keeps features.inviteVouch, and shows the control only with canVouch beside it', () => {
        const on = readNodeProfile({ profile: 'local', features: { inviteVouch: true } })?.features;
        expect(on?.inviteVouch).toBe(true);
        expect(offersInviteVouch(on, true)).toBe(true);
        expect(offersInviteVouch(on, false)).toBe(false);
    });
    it('offers nothing on a node that says no, or is too old to say', () => {
        const off = readNodeProfile({ profile: 'global', features: { inviteVouch: false } })?.features;
        expect(offersInviteVouch(off, true)).toBe(false);
        expect(offersInviteVouch(readNodeProfile({ profile: 'local', features: {} })?.features, true)).toBe(false);
        expect(readNodeProfile({ profile: 'local', features: { inviteVouch: 'yes' } })?.features.inviteVouch).toBeUndefined();
    });
});

describe('the phone\'s invite screen', () => {
    it('sends only what the control on screen shows, and never offers it to a guest, a preview or a phone offline', () => {
        expect(people).toMatch(/const offersVouch = !isGuest && !invitesPreview && makesInvites && mayInvite && isOnline && offersInviteVouch\(nodeProfile\?\.features, canVouch\);/);
        expect(people).toMatch(/const vouch = offersVouch \? vouchLevel : null;/);
        expect(people).toMatch(/vouchLevel: vouch \?\? undefined/);
    });
    it('opens on None however it is reached: the view, a tab coming back, the +person button, and after each invite', () => {
        expect(people).toMatch(/useFocusEffect\(useCallback\(\(\) => \{\s+setVouchLevel\(null\);\s+if \(view !== 'invites'\) return;/);
        expect(people).toMatch(/\}, \[view, identity\?\.publicKey, nodeProfile\?\.features\.inviteVouch\]\)\);/);
        expect(people).toMatch(/if \(data\.view === 'invites'\) setVouchLevel\(null\);/);
        expect(people).toMatch(/setNewCode\(code\);\s+setVouchLevel\(null\);/);
    });
    it('asks the node each time it opens, through askCanVouch (invite-vouch-right.test.ts), never only this phone\'s copy', () => {
        expect(people).toMatch(/askCanVouch\(me\)\.then\(can => \{ if \(alive\) setCanVouch\(can\); \}\)/);
        expect(people).not.toMatch(/getBalance\(/);
    });
    it('makes no offline ticket in place of a vouch: a refusal and no connection both stop before the ticket', () => {
        const refused = people.indexOf("if (vouch !== null) {\n                        Alert.alert(t('Could not vouch')");
        const unreachable = people.indexOf('Alert.alert(t(\'Could not vouch\'), t(INVITE_VOUCH_WORDS.noOfflineVouch));');
        const ticket = people.indexOf('// Offline Fallback');
        expect(refused).toBeGreaterThan(0);
        expect(unreachable).toBeGreaterThan(refused);
        expect(ticket).toBeGreaterThan(unreachable);
    });
});
