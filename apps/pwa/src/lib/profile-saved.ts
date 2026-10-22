/**
 * "The member's own profile was saved": rung by lib/api's updateMemberProfile once the node has taken a save (a new
 * picture, name or words, from Settings, profile setup or the profile page), heard by useOwnAvatar, so the sidebar's
 * picture follows a save at once. A window event of its own, so the api needn't know who listens.
 */
export const PROFILE_SAVED_EVENT = 'bp_profile_saved';

export function ringProfileSaved(): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROFILE_SAVED_EVENT));
}
