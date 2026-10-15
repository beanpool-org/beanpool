import { ErrorBoundary } from 'expo-router';
import TreasuryDetailScreen from './treasury-detail';

/**
 * Unified Enterprise Detail route.
 * Re-exports TreasuryDetailScreen to preserve backwards compatibility for any links
 * or routes referencing /project-detail.
 */
export { ErrorBoundary };
export default TreasuryDetailScreen;
