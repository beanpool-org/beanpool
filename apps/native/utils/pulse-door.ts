/**
 * The Pulse lives behind the Market's door (scratch/fable-design/DESIGN-pulse-home-fable.md §3.1, P2; Marty's pick 1 of
 * 14 Nov 2026): the "Pulse ›" button in the Market's title row opens it, and while it is open the Market tab stays lit.
 */

/** The Pulse's route, a hidden tab. */
export const PULSE_PATH = '/pulse';

/** Whether the Market tab is drawn lit: on the Market itself, and on the Pulse its door opens. */
export function marketTabLit(focused: boolean, pathname: string | null | undefined): boolean {
    return focused || pathname === PULSE_PATH;
}
