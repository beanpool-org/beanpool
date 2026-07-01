export type ResourceType = 'Need' | 'Offer' | 'Commons';

export interface Location {
    lat: number;
    lng: number;
}

export interface ResourcePin {
    id: string; // Unique hash
    providerId: string; // Who created it
    type: ResourceType;
    location: Location;
    description: string;
    signature?: string; // Ed25519 cryptographic signature of the contents
    requiredBadge?: string; // Optional link to a skill in our Passport logic
    expiresAt: Date | string; // To prevent 'ghost' pins
    updatedAt?: Date | string; // For conflict resolution (Last-Write-Wins)
    status?: 'Active' | 'Claimed' | 'Completed'; // For trade lifecycle
}

export class RouterManager {
    private pins: Map<string, ResourcePin>;

    constructor(initialPins?: ResourcePin[]) {
        this.pins = new Map();
        if (initialPins) {
            initialPins.forEach(pin => this.addPin(pin));
        }
    }

    addPin(pin: ResourcePin): boolean {
        const isConflict = this.pins.has(pin.id);
        this.pins.set(pin.id, {
            ...pin,
            expiresAt: pin.expiresAt instanceof Date ? pin.expiresAt : new Date(pin.expiresAt)
        });
        return isConflict;
    }

    removePin(id: string): void {
        this.pins.delete(id);
    }

    getPins(): ResourcePin[] {
        const nowTs = Date.now();
        const activePins: ResourcePin[] = [];
        for (const pin of this.pins.values()) {
            const expiresAtTs = (pin.expiresAt as Date).getTime();
            if (expiresAtTs < nowTs) {
                this.pins.delete(pin.id);
            } else {
                activePins.push(pin);
            }
        }
        return activePins;
    }


    /**
     * Haversine formula to calculate distance between two lat/lng coordinates in kilometers
     */
    private calculateDistanceKm(loc1: Location, loc2: Location): number {
        const toRadians = (degrees: number) => degrees * (Math.PI / 180);
        const R = 6371; // Earth's radius in km

        const dLat = toRadians(loc2.lat - loc1.lat);
        const dLng = toRadians(loc2.lng - loc1.lng);

        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRadians(loc1.lat)) *
            Math.cos(toRadians(loc2.lat)) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    /**
     * Returns pins within a certain radius (in kilometers) from the user's location
     */
    filterNearby(userLocation: Location, radiusKm: number): ResourcePin[] {
        const nearbyPins: ResourcePin[] = [];
        const nowTs = Date.now();

        for (const pin of this.pins.values()) {
            const expiresAtTs = (pin.expiresAt as Date).getTime();
            if (expiresAtTs < nowTs) {
                this.pins.delete(pin.id);
                continue;
            }

            const distance = this.calculateDistanceKm(userLocation, pin.location);
            if (distance <= radiusKm) {
                nearbyPins.push(pin);
            }
        }

        return nearbyPins;
    }
}
