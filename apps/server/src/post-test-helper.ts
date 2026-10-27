/**
 * Shared minimal valid photo for test fixtures (Marty, 26 Oct: market-photo-required).
 * Passes validatePostPhotos (base64 PNG data URL, valid image).
 */
export const TEST_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
export const TEST_PHOTOS = [TEST_PHOTO];

/**
 * Wraps createPost so test fixtures creating mock Offers/Needs/Events without photos
 * supply the shared test photo fixture. Polls stay photo-less.
 */
export function wrapCreatePost<T extends (...args: any[]) => any>(rawCreatePost: T): T {
    return ((type: string, category: string, title: string, description: string, credits: number,
             priceType: string, authorPublicKey: string, lat?: number, lng?: number,
             photos?: string[], repeatable?: boolean, id?: string, cashAlsoNeeded?: boolean,
             options?: any) => {
        const p = (type === 'poll' || options?.allowNoPhoto) ? photos : (!photos || photos.length === 0 ? TEST_PHOTOS : photos);
        return rawCreatePost(type, category, title, description, credits, priceType, authorPublicKey, lat, lng, p, repeatable, id, cashAlsoNeeded, options);
    }) as unknown as T;
}
