import { PassportManager } from './passport.js';
import { LedgerManager } from './ledger.js';
import { RouterManager, ResourcePin, Location } from './router.js';
import { GlobalConfig, BeanPoolMode } from './config.js';

export interface MockNeighbor {
    did: string;
    passport: PassportManager;
    ledger: LedgerManager;
}

/**
 * Generates a mock neighborhood of virtual BeanPool nodes
 */
export function generateMockNeighborhood(centerPoint: Location, count: number): MockNeighbor[] {
    const neighbors: MockNeighbor[] = [];

    // SECURITY SHIELD
    if (GlobalConfig.MODE !== BeanPoolMode.SIMULATION) {
        console.warn(`[Simulator] generateMockNeighborhood bypassed. Mode is ${GlobalConfig.MODE}`);
        return neighbors;
    }

    for (let i = 0; i < count; i++) {
        const did = `did:beanpool:mock-${i}-${Date.now()}`;

        // Random Standing Score between 10 and 80
        const randomStanding = Math.floor(Math.random() * 70) + 10;

        // Setup passport with starting standing mock representation
        const passportManager = new PassportManager(did);
        // We forcibly override standing here for simulation purposes (in reality we'd add badges)
        const passportState = passportManager.getPassport();
        passportState.standing = randomStanding;
        (passportManager as any).passport = passportState; // dirty override for simulator

        // Random Balance between -50 and 500
        const randomBalance = Math.floor(Math.random() * 550) - 50;

        const ledgerManager = new LedgerManager([
            { id: did, balance: randomBalance, lastDemurrageEpoch: Math.floor(Date.now() / 86400000) }
        ]);

        neighbors.push({
            did,
            passport: passportManager,
            ledger: ledgerManager
        });
    }

    return neighbors;
}

/**
 * Randomizes drop location near the designated center
 */
function randomNearbyLocation(center: Location, radiusDegrees = 0.01): Location {
    return {
        lat: center.lat + (Math.random() - 0.5) * radiusDegrees,
        lng: center.lng + (Math.random() - 0.5) * radiusDegrees
    };
}

/**
 * Activity loop simulator. 
 * 'Injects' random Resource Pins from mock neighbors into the local RouterManager.
 * Occasionally decays neighbor balances to simulate Commons Fund growing.
 */
export function simulateGossip(
    localRouterManager: RouterManager,
    localLedgerManager: LedgerManager,
    neighbors: MockNeighbor[],
    centerPoint: Location
): void {
    // SECURITY SHIELD
    if (GlobalConfig.MODE !== BeanPoolMode.SIMULATION) {
        return;
    }

    if (!neighbors || neighbors.length === 0) return;

    const activeNeighbor = neighbors[Math.floor(Math.random() * neighbors.length)];

    // Action 1: 50% chance to drop a random pin into the local router
    if (Math.random() > 0.5) {
        const pinTypes: ('Need' | 'Offer' | 'Commons')[] = ['Need', 'Offer', 'Commons'];
        const randomType = pinTypes[Math.floor(Math.random() * pinTypes.length)];

        const descriptions = [
            'Fresh bread available', 'Need help moving boxes', 'Local community library update',
            'Surplus lemons', 'Looking to borrow a ladder', 'Emergency generator fuel',
            'Artwork swap', 'Community meeting tonight'
        ];

        const newPin: ResourcePin = {
            id: `sim-pin-${Date.now()}`,
            providerId: 'mock-simulator',
            type: randomType,
            location: randomNearbyLocation(centerPoint),
            description: descriptions[Math.floor(Math.random() * descriptions.length)],
            status: 'Active',
            expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour expiry
            updatedAt: new Date().toISOString()
        };

        localRouterManager.addPin(newPin);
        console.log(`[Simulator] ${activeNeighbor.did} gossiped a new ${randomType} pin to local node.`);
    }

    // Action 2: 30% chance for a neighbor to "Decay" their balance artificially inflating the Commons
    if (Math.random() > 0.7) {
        // Find their account in their own ledger
        let account = activeNeighbor.ledger.getAccount(activeNeighbor.did);
        if (account.balance > 0) {
            const originalBalance = account.balance;

            // Force a fast decay for visible simulation
            // Fake aging by 1 month (30 Epochs) to make loss visible
            account.lastDemurrageEpoch = Math.floor(Date.now() / 86400000) - 30;

            // Re-fetch to trigger decay calculation automatically
            account = activeNeighbor.ledger.getAccount(activeNeighbor.did);
            const loss = originalBalance - account.balance;

            console.log(`[Simulator] ${activeNeighbor.did} decayed. +${loss.toFixed(4)} simulated route to Commons.`);
        }
    }
}

