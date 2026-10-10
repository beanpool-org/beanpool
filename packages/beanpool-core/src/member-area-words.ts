/**
 * "Roughly where are you?": one wording for both apps (design DESIGN-global-sync-by-area §3.2), asked at signup after
 * the photo on a community that gives each member the listings near their area (`features.nearbyListings`), and again
 * in Settings → Your area. Plain words, says why, says the limits honestly: 0.1° is 11 km north-south and narrower
 * east-west, so "about 10 km". No currency.
 */
export const AREA_STEP_WORDS = {
    title: 'Roughly where are you?',
    privacy: 'We keep your area to about 10 km, never your exact spot. Other members see only a distance in km.',
    useLocation: 'Use my location',
    typeTown: 'Type a town or suburb',
    skip: 'Skip for now',
    later: 'You can change or clear this any time in Settings → Your area.',
    settingsRow: 'Your area',
    notSet: 'Not set',
} as const;

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
