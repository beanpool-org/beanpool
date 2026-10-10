/**
 * "Roughly where are you?": one wording for both apps (design DESIGN-global-sync-by-area §3.2), asked at signup after
 * the photo on a community that gives each member the listings near their area (`features.nearbyListings`), and again
 * in Settings → Your area. Plain words, says why, says the limits honestly: 0.1° is 11 km north-south and narrower
 * east-west, so "about 10 km". No currency.
 */
export const AREA_STEP_WORDS = {
    title: 'Roughly where are you?',
    // A poll has no place of its own and is shown at its author's area (§3.4, Q4), to every reader of it, so this line
    // says so rather than "only a distance" (deciding review of #1766, B1; wording: director, 2026-10-11).
    privacy: 'We keep your area to about 10 km, never your exact spot. Other members see how far away you are, and a poll you make is shown at your area.',
    useLocation: 'Use my location',
    typeTown: 'Type a town or suburb',
    skip: 'Skip for now',
    later: 'You can change or clear this any time in Settings → Your area.',
    settingsRow: 'Your area',
    notSet: 'Not set',
} as const;

/** What an address search says, so a form that reuses the event form's search can say it in its own words. */
export interface AddressSearchWords {
    /** The box's label (a screen reader's, on the phone). */
    label: string;
    placeholder: string;
    /** The search itself is down. */
    unavailable: string;
    noMatches: string;
    /** Where the matches come from, and that what is typed is sent there. */
    source: string;
    /** A match, to a screen reader. */
    pickLabel?: (place: string) => string;
}

/**
 * The area step's town search (deciding review of #1766, N3): there is no map on the step, so no map or pin; it asks for
 * a town or suburb, not a street address, since only a 10 km area is kept and Nominatim gets whatever is typed.
 */
export const AREA_TOWN_SEARCH_WORDS: AddressSearchWords = {
    label: 'Find your town or suburb',
    placeholder: 'Town or suburb',
    unavailable: "Town search isn't working right now. Use my location instead, or skip for now.",
    noMatches: 'No matches. Try the name of a town or suburb nearby.',
    source: 'Places from OpenStreetMap. What you type here is sent to them.',
    pickLabel: (place) => `Choose ${place}`,
};

/** The why line, with the node's own numbers when it says them (`features.nearbyListings`), else the decided 500 / 250 km. */
export function areaWhyLine(limits?: { radiusKm: number; max: number } | null): string {
    const max = limits?.max ?? 500;
    const km = limits?.radiusKm ?? 250;
    return `The worldwide community shows you what's on offer near you: the nearest ${max} listings within ${km} km.`;
}

/** Settings' line: "About 10 km around <town or lat, lng>", or "Not set". */
export function describeArea(area: { lat: number; lng: number } | null | undefined, placeName?: string | null): string {
    if (!area) return AREA_STEP_WORDS.notSet;
    const where = placeName?.trim() || `${area.lat.toFixed(1)}, ${area.lng.toFixed(1)}`;
    return `About 10 km around ${where}`;
}

/**
 * A listing with no place (a poll) on a community that syncs by area takes its author's area as its place (design §3.4,
 * Q4): the node stores the area as the poll's lat/lng, and every reader of the poll gets it (apps/server
 * engine/member-area.ts). The form says so, before the member posts.
 */
export const PLACELESS_AT_AREA_NOTE = 'This poll is shown at your area (about 10 km around it) to everyone who can read it.';

/**
 * An author with no area: the listing is still accepted with no place, so it is in no member's list of what is near
 * them, and anyone can still find it by searching; the form says so with this line. It says only that much, because a
 * member with no area of their own may still get it among the newest listings (deciding review of #1766, N2). Fully
 * true once phones (S3) and the web Market (S5) read listings by area; until then their plain reads still include it.
 */
export const PLACELESS_NO_AREA_NOTE =
    "You haven't set your area, so members nearby won't see this poll in their list; they can still find it by searching. Set it in Settings → Your area to show it near you.";

/**
 * The note for a placeless listing's form, only on a by-area community: where it is shown when the author has an area,
 * the no-area line when the area is known to be unset, and nothing when the node couldn't be asked (rather than
 * something false).
 */
export function placelessListingNote(byArea: boolean, area: { lat: number; lng: number } | null | undefined): string | null {
    if (!byArea || area === undefined) return null;
    return area === null ? PLACELESS_NO_AREA_NOTE : PLACELESS_AT_AREA_NOTE;
}
