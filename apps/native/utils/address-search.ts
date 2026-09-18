/**
 * The phone side of the event form's address search. The lookup itself (Nominatim request, 1 s debounce, abort,
 * 1 req/s floor, cache) is @beanpool/core's createAddressLookup, shared with the settings and web apps.
 */
import type { AddressResult } from '@beanpool/core';

/**
 * Nominatim's usage policy asks each app to name itself in its User-Agent or Referer; a stock library
 * User-Agent ("okhttp/4.x", "CFNetwork") does not count. A phone sends no Referer, so it sets User-Agent, which
 * React Native's fetch passes through on both Android and iOS.
 */
export function nominatimHeaders(appVersion: string | null | undefined, os: string): Record<string, string> {
    const version = appVersion && /^[\w.+-]+$/.test(appVersion) ? appVersion : 'unknown';
    return { 'User-Agent': `BeanPool/${version} (${os}; +https://beanpool.org)` };
}

/** The Place name after an address is picked: the member's own words win; an empty field gets the short name. */
export function placeNameAfterPick(current: string, result: AddressResult, max: number): string {
    if (current.trim()) return current;
    return result.shortName.slice(0, max);
}
