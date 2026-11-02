/**
 * Remembers the tier the character last ran each combat zone at, so a task card's estimate and Go can
 * use it once the zone has left the action queue. The logic lives in `utils/zone-tier-memory.js`.
 *
 * Always on, whatever the task estimate setting says: it is a few bytes per zone of data the server
 * already sends, and a player who switches the estimate on later expects it to know their tiers.
 */

import { startZoneTierMemory, stopZoneTierMemory } from '../../utils/zone-tier-memory.js';

export default {
    name: 'Zone Tier Recorder',
    initialize() {
        startZoneTierMemory();
    },
    disable() {
        stopZoneTierMemory();
    },
    cleanup() {
        stopZoneTierMemory();
    },
};
