/**
 * Shared image processing utilities for BeanPool.
 * 
 * Memory-safe 2-pass pipeline for profile photos:
 * Pass 1: Pre-crop downscale to 1024px — prevents OOM on 48MP camera images
 * Pass 2: Final compress to 512px, 70% JPEG — network-optimal base64 avatar
 */
import * as ImageManipulator from 'expo-image-manipulator';

const PRE_CROP_MAX = 1024;
const FINAL_SIZE = 512;
const FINAL_QUALITY = 0.7;

/**
 * Process a picked image URI into a base64 data URI suitable for profile avatars.
 * Handles memory-safe downscaling to prevent OOM crashes on low-end devices/emulators.
 * 
 * @param uri - Local file URI from ImagePicker
 * @returns base64 data URI string, or null on failure
 */
export async function processProfileImage(uri: string): Promise<string | null> {
    try {
        // Pass 1: Downscale to max 1024px before crop (prevents memory crash)
        const preCrop = await ImageManipulator.manipulateAsync(
            uri,
            [{ resize: { width: PRE_CROP_MAX } }],
            { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
        );
        // Pass 2: Final compress to 512px for ledger storage
        const final = await ImageManipulator.manipulateAsync(
            preCrop.uri,
            [{ resize: { width: FINAL_SIZE } }],
            { compress: FINAL_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true }
        );
        return final.base64 ? `data:image/jpeg;base64,${final.base64}` : null;
    } catch (e) {
        console.error('[ImageProcessing] Profile image processing failed:', e);
        return null;
    }
}

/**
 * Build a cache-busted avatar URI for rendering.
 * Handles data URIs, remote URLs, and adds cache-busting query params.
 * 
 * @param url - The raw avatar URL (data: URI, remote URL, or null)
 * @param pubkey - User's public key (fallback cache key)
 * @param updatedAt - ISO timestamp of last profile update (preferred cache key)
 * @returns Cache-busted URI string, or null if no avatar
 */
export function avatarUri(url: string | null | undefined, pubkey: string, updatedAt?: string | null): string | null {
    if (!url) return null;
    // data: URIs are already unique by content
    if (url.startsWith('data:')) return url;
    // Bundled avatar references don't need cache-busting
    if (url.startsWith('bundled://')) return url;
    // Use profile_updated_at for precise cache-busting, fall back to pubkey slice
    const cacheKey = updatedAt ? new Date(updatedAt).getTime() : pubkey.slice(0, 8);
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}_v=${cacheKey}`;
}
