import { describe, it, expect } from 'vitest';
import {
    groupChoicePeople, groupChoicesFor, groupProposal, joinPolicyChoices, scopedEffectWords, scopedOutcomeWords, scopedTallyWords,
    groupChoiceLabel, GROUP_CHOICES, type GroupPerson,
} from '../scoped-decision';

const people: GroupPerson[] = [
    { pubkey: 'lou', name: 'Lou', role: 'lead' }, { pubkey: 'cyd', name: 'Cyd', role: 'convenor' },
    { pubkey: 'ada', name: 'Ada', role: 'member' }, { pubkey: 'bo', name: 'Bo', role: 'member' }, { pubkey: 'obi', name: 'Obi', role: 'observer' },
];
const names = (ps: GroupPerson[]) => ps.map(p => p.pubkey);

describe("a chat group's vote, as the apps show it (slice S3)", () => {
    it('the pickers offer whom the node allows', () => {
        // The lead: anyone on the roll but the lead (observers watch); a member may name themselves.
        expect(names(groupChoicePeople('lead', people, 'ada'))).toEqual(['cyd', 'ada', 'bo']);
        // A role vote never touches the lead, and an observer is off the roll.
        expect(names(groupChoicePeople('make_convenor', people, 'ada'))).toEqual(['ada', 'bo']);
        expect(names(groupChoicePeople('make_member', people, 'ada'))).toEqual(['cyd']);
        // A removal: anyone in the group, observers too, but the lead and yourself (to leave, leave).
        expect(names(groupChoicePeople('remove', people, 'ada'))).toEqual(['cyd', 'bo', 'obi']);
        expect(groupChoicePeople('close', people, 'ada')).toEqual([]);
    });

    it('a choice with nobody to name is not offered', () => {
        const two: GroupPerson[] = [{ pubkey: 'lou', name: 'Lou', role: 'lead' }, { pubkey: 'ada', name: 'Ada', role: 'member' }];
        expect(groupChoicesFor(two, 'ada')).toEqual(['lead', 'make_convenor', 'join_policy', 'close']);
        expect(groupChoicesFor(people, 'ada')).toEqual([...GROUP_CHOICES]);
        for (const c of GROUP_CHOICES) expect(groupChoiceLabel(c)).toBeTruthy();
    });

    it('what the form sends: one effect per choice, never a recipient or an amount', () => {
        expect(groupProposal('lead', 'cyd', null)).toEqual({ effect: 'replace_lead_convenor', subject: 'cyd' });
        expect(groupProposal('make_convenor', 'bo', null)).toEqual({ effect: 'set_group_role', subject: 'bo', params: { role: 'convenor' } });
        expect(groupProposal('make_member', 'cyd', null)).toEqual({ effect: 'set_group_role', subject: 'cyd', params: { role: 'member' } });
        expect(groupProposal('remove', 'obi', null)).toEqual({ effect: 'remove_group_member', subject: 'obi' });
        expect(groupProposal('join_policy', null, 'invite_only')).toEqual({ effect: 'set_join_policy', params: { policy: 'invite_only' } });
        expect(groupProposal('close', null, null)).toEqual({ effect: 'close_group' });
        expect(groupProposal('lead', null, null)).toBeNull();
        expect(groupProposal('join_policy', null, null)).toBeNull();
        for (const c of GROUP_CHOICES) expect(JSON.stringify(groupProposal(c, 'x', 'open'))).not.toMatch(/amount|"to"/);
    });

    it("the join policies offered are every one but the group's own", () => {
        expect(joinPolicyChoices('open')).toEqual(['request_to_join', 'invite_only']);
        expect(joinPolicyChoices('invite_only')).toEqual(['open', 'request_to_join']);
    });

    it("the card's words for each effect", () => {
        const nameOf = (pk: string) => people.find(p => p.pubkey === pk)?.name ?? 'a member';
        expect(scopedEffectWords({ effect: 'replace_lead_convenor', subject: 'cyd', params: null }, nameOf)).toBe('Make Cyd the lead convenor');
        expect(scopedEffectWords({ effect: 'set_group_role', subject: 'bo', params: { role: 'convenor' } }, nameOf)).toBe('Make Bo a convenor');
        expect(scopedEffectWords({ effect: 'set_group_role', subject: 'cyd', params: { role: 'member' } }, nameOf)).toBe('Make Cyd a member, no longer a convenor');
        expect(scopedEffectWords({ effect: 'remove_group_member', subject: 'obi', params: null }, nameOf)).toBe('Remove Obi from the group');
        expect(scopedEffectWords({ effect: 'set_join_policy', subject: null, params: { policy: 'request_to_join' } }, nameOf)).toBe('Change who can join: people ask, and a convenor lets them in');
        expect(scopedEffectWords({ effect: 'close_group', subject: null, params: null }, nameOf)).toBe('Close the group. Its chat stays to read.');
    });

    it('turnout while open, the split at close; a group says people, not keepers', () => {
        const tally = { voted: 3, roll: 5, quorumRequired: 3, thresholdRequired: 0.5 };
        expect(scopedTallyWords({ status: 'open', tally: { ...tally, yes: 3 } })).toBe('3 of 5 have voted. 3 must vote. Yes and No show when it closes.');
        expect(scopedTallyWords({ status: 'executed', tally: { ...tally, yes: 2, no: 1 } })).toBe('Yes 2 · No 1. 3 of 5 voted.');
        expect(scopedOutcomeWords({ status: 'unresolved', scopeKind: 'group' })).toBe('Not enough people voted');
        expect(scopedOutcomeWords({ status: 'unresolved' })).toBe('Not enough keepers voted');
        expect(scopedOutcomeWords({ status: 'execution_void', executionReason: 'The group is closed', scopeKind: 'group' })).toBe('Passed, but there was nothing to do: The group is closed');
    });
});
