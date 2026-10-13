/**
 * The line above People → Community on a community that says `membersOnDemand` (DESIGN-global-members-by-area §2.3),
 * and what the list says when it is empty. Never "Loading" for a list that will not load: with no area there is nothing
 * near to show, and offline the cards held are what there is.
 */
export type CommunityListNote = 'near' | 'search' | 'noArea' | 'held';

export function communityListNote(note: CommunityListNote, typed: string): string {
    switch (note) {
        case 'near': return 'Near you: the 50 closest members. Search a name to find anyone else.';
        case 'search': return `Members whose name starts with “${typed.trim()}”.`;
        case 'noArea': return "Set your area to see who's near you. Search a name to find anyone.";
        case 'held': return "People you've dealt with. Connect to search everyone.";
    }
}

export function communityListEmpty(note: CommunityListNote | null, typed: string): string {
    if (note === 'search') return 'No members match your search.';
    if (note === 'near') return 'No one near you yet.';
    if (note === 'noArea') return 'Type at least 2 letters of a name.';
    if (note === 'held') return typed.trim() ? 'No one you have dealt with matches. Connect to search everyone.' : 'No one yet. Connect to search everyone.';
    return typed ? 'No members match your search.' : 'Loading community...';
}
