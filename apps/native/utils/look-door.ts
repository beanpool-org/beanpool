/**
 * The door, opened from the look (slice S12, utils/look-around.ts): the visitor tapped Join, Join to post or Join to
 * message. The stack goes back to its bottom and the door replaces it, as the root guard does for a screen that needs a
 * key, so the door is the only screen and its Back returns to the look (app/welcome.tsx). The door's work starts there,
 * at this tap, never before.
 */
import { router } from 'expo-router';
import { LOOK_DOOR } from './look-around';

export function openLookDoor(): void {
    if (router.canDismiss()) router.dismissAll();
    router.replace(LOOK_DOOR);
}
