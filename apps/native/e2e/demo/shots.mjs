/**
 * The seven store screens (DESIGN-app-screenshots-fable.md §1), in order: one list read by the capture driver, the caption
 * framer and the website sizes, so the three can never disagree about a name, a caption or which shots the store set holds.
 *
 * `store` is the scheme a shot has in the store set: six light and the Ledger dark (Marty, 9 Nov 2026, decision 3). Every shot
 * is also taken in the other scheme, for the website, which swaps by the visitor's scheme. `web` is the website's name for the
 * five shots beanpool.org shows (Home, Market, Listing, Deal chat, Ledger); the Map and the Event are kept for later.
 */
export const SHOTS = [
    { n: 1, id: 'home', caption: 'Your community, on one screen', store: 'light', web: 'home' },
    { n: 2, id: 'market', caption: 'Offer what you can, ask freely', store: 'light', web: 'market' },
    { n: 3, id: 'listing', caption: 'Agree a price in Beans', store: 'light', web: 'listing' },
    { n: 4, id: 'chat', caption: "Beans held until it's done", store: 'light', web: 'deal' },
    { n: 5, id: 'map', caption: "See what's near you", store: 'light', web: null },
    { n: 6, id: 'event', caption: 'Working bees, swaps, repair cafés', store: 'light', web: null },
    { n: 7, id: 'ledger', caption: 'Every trade in your own Ledger', store: 'dark', web: 'ledger' },
];

export const SCHEMES = ['light', 'dark'];

/** The raw capture's file name: `<n>-<id>-<scheme>.png`. */
export const rawName = (shot, scheme) => `${shot.n}-${shot.id}-${scheme}.png`;

/** The framed store file's name: `<NN>-<id>.png` (the order the store shows them in). */
export const storeName = (shot) => `${String(shot.n).padStart(2, '0')}-${shot.id}.png`;

/** The website's file name: `phone-<web>-<scheme>-<width>.webp`. */
export const webName = (shot, scheme, width) => `phone-${shot.web}-${scheme}-${width}.webp`;

/** The two widths the website shows each shot at (1x and 2x of a 360 px column). */
export const WEB_WIDTHS = [360, 720];
