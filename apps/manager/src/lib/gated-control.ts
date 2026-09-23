import type { SyntheticEvent } from 'react';

/**
 * Permission-gated controls — the one way Settings says "you are not allowed to use this".
 *
 * A control the viewer may not USE is not the same as one that is busy, or not filled in yet.
 * Native `disabled` is right for busy and not-yet-valid: there is nothing to read, and the control
 * comes back by itself. It is wrong for a permission rule, because `disabled` takes the control out
 * of the Tab order and out of most screen readers' reading order — and the reason printed beside it
 * goes with it. So the reason reaches sighted mouse users and nobody else (found reviewing #1005).
 *
 * A permission-gated control instead keeps `aria-disabled`, so it is still reachable by Tab and is
 * announced as unavailable; points at the VISIBLE reason with `aria-describedby`; and does nothing
 * when it is activated. Nothing about who may do what changes here: the node is still the authority
 * and refuses the request anyway. This is presentation only.
 *
 *     const blocked = !canManage && held === 'owner';
 *     <button
 *         {...gatedProps(blocked, 'role-blocked-abc')}
 *         onClick={guardGated(blocked, () => pick(key))}
 *         className={blocked ? GATED_LOOK : 'hover:…'}
 *     />
 *     {blocked && <p id="role-blocked-abc">Only an owner can change an owner's role.</p>}
 */

export interface GatedAriaProps {
    'aria-disabled'?: true;
    'aria-describedby'?: string;
}

/**
 * The ARIA for a gated control, to spread onto it. `reasonIds` names the element or elements holding
 * the visible reason — one id, or several separated by spaces, which is how a control blocked by
 * more than one rule points at all of them at once. An empty string leaves `aria-describedby` off
 * rather than pointing at nothing.
 */
export function gatedProps(blocked: boolean, reasonIds: string): GatedAriaProps {
    if (!blocked) return {};
    const ids = reasonIds.trim();
    return ids ? { 'aria-disabled': true, 'aria-describedby': ids } : { 'aria-disabled': true };
}

/**
 * Wraps an activation handler so a gated control does nothing at all. A <button> fires `click` for
 * the mouse, Enter and Space alike, so guarding that one handler covers all three; a checkbox or
 * radio fires `change` the same way. Called with no handler it only blocks, which is what a radio's
 * `onClick` needs so the browser does not tick it before React puts it back.
 */
export function guardGated(
    blocked: boolean,
    run?: (event: SyntheticEvent) => void,
): (event: SyntheticEvent) => void {
    return (event: SyntheticEvent) => {
        if (blocked) {
            event.preventDefault();
            return;
        }
        run?.(event);
    };
}

/**
 * A focus ring for a gated control. It stays in the Tab order, so focus has to be visible on it —
 * and being dimmed, it needs the ring more than an ordinary control does, not less.
 *
 * The shade has to be one `tailwind.config.js` actually defines. `terra` is defined at 500 and 600
 * only, and an undefined shade emits no CSS at all: the outline then falls back to `currentColor`,
 * which on the Confirm & Prune button (`text-nature-500` on `bg-nature-800`) is a 2.4:1 grey — a
 * ring you cannot see, on the one control that most needs one (found reviewing #1077). `terra-500`
 * clears WCAG 1.4.11's 3:1 on every surface these controls sit on: 3.2:1 on `nature-800`, 5.6:1 on
 * `nature-950`, 3.4:1 on white. The test below pins the shade to the palette so this cannot rot.
 */
export const GATED_FOCUS =
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terra-500';

/**
 * The dimmed look for a gated control, focus ring included. The `disabled:opacity-50` in this app's
 * shared button classes never fires on one of these, because it is not natively disabled.
 */
export const GATED_LOOK = `opacity-50 cursor-not-allowed ${GATED_FOCUS}`;
