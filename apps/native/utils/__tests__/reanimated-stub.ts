/**
 * Stands in for react-native-reanimated under vitest (vitest.config.ts): its native side doesn't load outside a device, and
 * Home's carried band (components/home/ArrangeGhost.tsx) imports it, so every test that renders Home would otherwise mock
 * it. A shared value is a plain box; an animated style is worked out once per render; a timing lands at once. Nothing here
 * draws a frame, so no test can claim the band moved on a phone (the emulator check is the PR's).
 */
import { createElement, useRef } from 'react';
import { View } from 'react-native';

export interface SharedValue<T> { value: T }
export const useSharedValue = <T,>(v: T): SharedValue<T> => useRef({ value: v }).current;
export const useAnimatedStyle = <T,>(fn: () => T): T => fn();
export const useAnimatedReaction = (): void => {};
export const withTiming = <T,>(v: T): T => v;
const AnimatedView = (props: Record<string, unknown>) => createElement(View as never, props);
const Animated = { View: AnimatedView };
export default Animated;
