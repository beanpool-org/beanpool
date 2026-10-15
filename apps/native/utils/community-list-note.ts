/**
 * The line above People → Community on a community that says `membersOnDemand` (DESIGN-global-members-by-area §2.3),
 * and what the list says when it is empty. Never "Loading" for a list that will not load: with no area there is nothing
 * near to show, and offline the cards held are what there is. One letter typed asks the node nothing (a search is 2 or
 * more): the cards held, with the words for that ('short'), never the offline ones while the phone is online.
 */
export type CommunityListNote = 'near' | 'search' | 'noArea' | 'held' | 'short';

export function communityListNote(note: CommunityListNote, typed: string): string {
    switch (note) {
        case 'near': return 'Near you: the 50 closest members. Search a name to find anyone else.';
        case 'search': return `Members whose name starts with “${typed.trim()}”.`;
        case 'noArea': return "Set your area to see who's near you. Search a name to find anyone.";
        case 'held': return "People you've dealt with. Connect to search everyone.";
        case 'short': return "People you've dealt with. Type at least 2 letters to search everyone.";
    }
}

/**
 * The New message picker on a community that says `membersOnDemand`: its list is the cards held (recents, friends, the
 * people this member has dealt with) plus what the node answered a search of 2 letters or more. `node` is what became of
 * that search: 'none' (nothing asked), 'answered', or 'unreachable' (offline, busy, refused). Never "sync to populate":
 * no sync fills a directory here.
 */
export function pickerHeading(typed: string): string {
    return typed.trim() ? '🔍 Results' : "People you've dealt with";
}

export function pickerEmpty(typed: string, node: 'none' | 'answered' | 'unreachable'): { title: string; subtitle: string } {
    const q = typed.trim();
    if (q === '') return { title: 'No one here yet', subtitle: 'Type 2 letters of a name to find anyone in the community.' };
    if (q.length < 2) return { title: 'No one you have dealt with matches', subtitle: 'Type at least 2 letters of a name to search everyone.' };
    if (node === 'unreachable') return { title: 'No one you have dealt with matches', subtitle: 'Connect to search everyone.' };
    return { title: 'No members match your search', subtitle: 'Try a different name.' };
}

export function communityListEmpty(note: CommunityListNote | null, typed: string): string {
    if (note === 'search') return 'No members match your search.';
    if (note === 'near') return 'No one near you yet.';
    if (note === 'noArea') return 'Type at least 2 letters of a name.';
    if (note === 'held') return typed.trim() ? 'No one you have dealt with matches. Connect to search everyone.' : 'No one yet. Connect to search everyone.';
    if (note === 'short') return 'No one you have dealt with matches. Type at least 2 letters to search everyone.';
    return typed ? 'No members match your search.' : 'Loading community...';
}
