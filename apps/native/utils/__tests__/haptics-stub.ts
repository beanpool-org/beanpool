/** Stands in for expo-haptics under vitest (vitest.config.ts): no phone to tick. A test that counts the ticks mocks it itself. */
export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' } as const;
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' } as const;
export const impactAsync = async (): Promise<void> => {};
export const notificationAsync = async (): Promise<void> => {};
export const selectionAsync = async (): Promise<void> => {};
