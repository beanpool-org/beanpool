/**
 * The words the apps use for the people who run a project or an enterprise (group decisions §3.1, picks 7–8,
 * Marty 2026-10-10). One object holds both kinds (`lifecycle` 'bounded' = a project); the stored names
 * (treasury, keeper, bounded, ongoing) stay in code and are never shown to members.
 *
 * KeeperWords are English: a screen that puts them in a sentence glues words a language may need to inflect, so a
 * translated screen writes one whole sentence per kind instead (apps/native utils/keeper-governance.ts).
 */
import { t } from './words.js';

export interface KeeperWords {
    /** "project" or "enterprise", for the middle of a sentence. */
    kind: 'project' | 'enterprise';
    /** "Project" or "Enterprise", for a chip or a heading. */
    Kind: 'Project' | 'Enterprise';
    /** The one who leads it: "Leader" or "Lead keeper". */
    Lead: string;
    /** One of the people who run it: "Collaborator" or "Keeper". */
    Keeper: string;
    /** All of them: "Collaborators" or "Keepers". */
    Keepers: string;
    /** Mid-sentence forms. */
    lead: string;
    keeper: string;
    keepers: string;
}

export function keeperWords(lifecycle: string | null | undefined): KeeperWords {
    return lifecycle === 'bounded'
        ? { kind: 'project', Kind: 'Project', Lead: 'Leader', Keeper: 'Collaborator', Keepers: 'Collaborators', lead: 'leader', keeper: 'collaborator', keepers: 'collaborators' }
        : { kind: 'enterprise', Kind: 'Enterprise', Lead: 'Lead keeper', Keeper: 'Keeper', Keepers: 'Keepers', lead: 'lead keeper', keeper: 'keeper', keepers: 'keepers' };
}

/** The line under a project's or enterprise's name, in the member's language. */
export function groupKindLine(lifecycle: string | null | undefined): string {
    return lifecycle === 'bounded' ? t('Project · A leader, a goal, an end date') : t('Enterprise · Run by its keepers');
}
