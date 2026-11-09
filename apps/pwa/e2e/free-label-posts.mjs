/** The listings e2e/free-label-harness.tsx draws and e2e/free-label-shots.mjs answers with: free ones and priced ones. */
const base = {
    category: 'food', description: 'Come and pick with us on Saturday.', credits: 0, priceType: 'fixed', authorPublicKey: 'b'.repeat(64),
    authorCallsign: 'Bea', createdAt: new Date(Date.now() - 3600_000).toISOString(), active: true, status: 'active', repeatable: false, photos: [],
    lat: -28.64, lng: 153.5,
};
export const POSTS = [
    { ...base, id: 'free-need', type: 'need', title: 'Invites to harvest any sort of spray free food' },
    { ...base, id: 'free-offer', type: 'offer', title: 'Windfall lemons, take what you like' },
    { ...base, id: 'free-hourly', type: 'offer', priceType: 'hourly', title: 'Help with the garden, no charge' },
    { ...base, id: 'paid-need', type: 'need', credits: 20, priceType: 'hourly', title: 'Help moving a sofa' },
    { ...base, id: 'paid-offer', type: 'offer', credits: 12, title: 'Sourdough loaf' },
];
