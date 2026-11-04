/**
 * The words two screens share about a post an assistant took down: "Taken down by assistants" (AssistantTakedownsPanel) and the posts
 * screen (PostModerationPanel). They say the same thing for the same post, so the phrase lives here once.
 *
 * A Child safety report is closed by nothing but a person, so while one is open the 7-day sweep skips the post: it stays hidden and is
 * never removed for good by itself, on any day of the hold (the server sends `childSafetyOpen` for it).
 */

/** Why a post stays hidden past the 7 days. */
export const CHILD_SAFETY_OPEN = 'a Child safety report is open';
