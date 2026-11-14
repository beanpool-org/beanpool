/**
 * The Chat tab's Forum side on the web (slice T0; scratch/fable-design/DESIGN-forums-messaging-joint-fable.md §2.1, §3.2):
 * drawn under the Chats · Forum switch (pages/ChatTabPage.tsx) where this community's forum is on. Empty on purpose: slice
 * F4 fills it (its sections, topics, the first-look row for moderators and the "Worldwide forum ›" row) and owns everything
 * under it, without touching MessagesPage.tsx.
 */
export function ForumPage() {
    return <div data-testid="forum-page" />;
}
