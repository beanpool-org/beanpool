/**
 * The section the Forum side opens on next (forum slice F9 part 3): a group's "Topics ›" row, in its sheet, names the group's own
 * section, and the Chat tab's Forum side (components/forum/ForumPane.tsx) takes it once as it shows. Nothing else is kept here.
 */
let next: string | null = null;

/** The Forum side, shown next, opens on section `sectionId`. */
export function openForumAt(sectionId: string): void { next = sectionId; }

/** That section, once; null when nothing asked for one. */
export function takeForumAt(): string | null {
    const at = next;
    next = null;
    return at;
}
