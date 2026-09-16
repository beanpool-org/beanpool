/**
 * Build and runtime mode detection for BeanPool Manager / Settings.
 *
 * Single-node mode (default):
 * - Target node URL is window.location.origin
 * - Fleet features (node switcher, TopologyModule, AiServicesModule, multi-node compare) are OFF
 * - 4 plain-English navigation sections + Home screen
 *
 * Fleet mode (opt-in via VITE_FLEET_MODE=true):
 * - Multi-node profile switcher
 * - Topology canvas, AI copilot, cross-node comparisons
 */

declare const __FLEET_MODE__: boolean | undefined;

export const IS_FLEET_MODE: boolean =
    typeof __FLEET_MODE__ !== 'undefined'
        ? Boolean(__FLEET_MODE__)
        : (typeof import.meta !== 'undefined' && Boolean((import.meta as any)?.env?.VITE_FLEET_MODE === 'true'));
