import { PassportManager } from './passport.js';
import { RouterManager, ResourcePin } from './router.js';

export interface GossipPayload {
    nodeId: string;
    standing: number;
    pins: ResourcePin[];
    timestamp: string;
}

export class GossipManager {
    private passportManager: PassportManager;
    private routerManager: RouterManager;

    constructor(passportManager: PassportManager, routerManager: RouterManager) {
        this.passportManager = passportManager;
        this.routerManager = routerManager;
    }

    /**
     * Packages the user's Passport Standing and local Resource Pins into an encrypted JSON string.
     * Note: Encryption is mocked here. In production, this would use a symmetric/asymmetric key.
     */
    prepareSyncPayload(): string {
        const passport = this.passportManager.getPassport();
        // Only send non-expired pins
        const pins = this.routerManager.getPins();

        const payload: GossipPayload = {
            nodeId: passport.id,
            standing: passport.standing,
            pins,
            timestamp: new Date().toISOString(),
        };

        // Return the stringified payload, acting as a mock for the encrypted data packet
        return JSON.stringify(payload);
    }

    /**
     * Processes incoming neighbor data, merging pins using Last-Write-Wins logic to avoid duplicates.
     * Assumes payload has been decrypted prior to calling this method.
     */
    processIncomingGossip(encryptedPayloadStr: string): void {
        try {
            // Mock decryption
            const payload: GossipPayload = JSON.parse(encryptedPayloadStr);

            const incomingPins = payload.pins || [];
            const localPins = this.routerManager.getPins();

            for (const incomingPin of incomingPins) {
                // Last-Write-Wins Logic based on updatedAt or expiresAt fallback
                const existingPin = localPins.find(p => p.id === incomingPin.id);

                if (existingPin) {
                    const incomingTime = new Date(incomingPin.updatedAt || incomingPin.expiresAt).getTime();
                    const existingTime = new Date(existingPin.updatedAt || existingPin.expiresAt).getTime();

                    // If incoming pin is newer, replace it
                    if (incomingTime > existingTime) {
                        this.routerManager.addPin(incomingPin);
                    }
                } else {
                    // New pin entirely, add it securely
                    this.routerManager.addPin(incomingPin);
                }
            }

            // Optionally process the standing of the peer if needed for reputation scores...

        } catch (e) {
            console.error('Failed to parse incoming gossiped payload:', e);
        }
    }
}
