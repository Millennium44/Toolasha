/**
 * Philosopher's Stone Alerts
 *
 * Says so when transmuting produces a Philosopher's Stone — the rare jackpot
 * of the drop table, worth on the order of hundreds of millions and dropping
 * roughly one attempt in ten. Transmuting runs unattended for hours, and this
 * is exactly the kind of moment the notification system already exists for:
 * the player currently only finds out by looking.
 *
 * ## Read from the game, not from the transmute tracker
 *
 * The same reasoning `enhancement-target-alerts.js` gives applies here
 * verbatim. Toolasha's transmute history tracker sees the same
 * `action_completed` message and could, in principle, say whether a stone
 * came out of it. Asking it would still be wrong: its session state is
 * mutated from a handler on this same message, so which of the two runs
 * first would decide whether the drop is seen, and the tracker is a feature
 * the player can switch off — which would silently take this notification
 * off with it for no reason the player could see. The game's own
 * `endCharacterItems` rows are on the wire either way, and this reads them
 * directly.
 *
 * ## The baseline comes from inventory, not from the first message
 *
 * `endCharacterItems` carries only CHANGED stacks — one row per stack whose
 * count moved, holding its new absolute total (see this same note in
 * `transmute-history-tracker.js`). That means a stone row inside a transmute
 * `action_completed` essentially always IS the gain: the row would not exist
 * if the stack had not just moved. Treating the first such row as "no
 * baseline yet, say nothing" would eat the first stone after every page
 * load, character switch, or settings toggle — not a rare edge, the exact
 * moment this feature exists for.
 *
 * So the baseline is seeded from the character's actual inventory
 * (`dataManager.getInventory()`), read once when this module starts and
 * again on `character_initialized` for the ordinary case where it starts
 * before that data has arrived. It is never read from inside the
 * `action_completed` path: `dataManager` mutates `characterItems` from its
 * own handler on that same message, and reading it mid-handler would
 * reintroduce exactly the handler-ordering race this module is written to
 * avoid.
 *
 * A session can still reach `check()` with no baseline seeded — inventory
 * genuinely unavailable, or a stone arriving before `character_initialized`
 * has ever fired. That case announces rather than stays silent, treating the
 * row as a gain of (at least) one. The two ways to get this wrong are not
 * symmetric: a false positive tells the player about a stone they may
 * already have had, a false negative is a missed ~540M jackpot. The module
 * leans the way that costs less.
 *
 * ## Once per stone, not once per session
 *
 * The event key is built from the new absolute count, which only advances
 * when a further stone actually lands, so two stones earned in the same
 * session are two separate announcements rather than one. A batched message
 * that covers several successful attempts reports the whole gain in one
 * line rather than pretending it was one stone.
 *
 * Scoped to transmute: coinify and decompose do not produce stones, and this
 * does not listen for their actions at all.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { PHILO_HRID } from '../alchemy/philosophers-stone-hrid.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_philosophersStone';

/** The one action this cares about */
export const TRANSMUTE_ACTION_HRID = '/actions/alchemy/transmute';

/** Where a stack has to live to count — a stone elsewhere is not a gain here */
const INVENTORY_LOCATION_HRID = '/item_locations/inventory';

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'philosophers-stone';

class PhiloStoneAlerts {
    constructor() {
        /** Last known absolute count of the stone stack, once seeded */
        this.lastCount = null;
        /** Whether `lastCount` came from a real inventory read this session */
        this.hasBaseline = false;
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
        this.characterInitializedHandler = null;
    }

    /**
     * Start watching transmute results for the stone.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        // Covers the case where the character's data is already loaded by the
        // time this feature starts (a re-init after a character switch, or a
        // settings toggle mid-session)
        this.seedBaseline();

        this.registerWebSocketListeners();

        // Covers the ordinary startup case: this feature initializes before
        // `init_character_data` has ever arrived, so there is nothing to seed
        // from yet. Re-seeding here rather than only once means a reload of
        // the same character also refreshes the baseline, which is harmless —
        // the stack cannot have shrunk between two reads of the same login.
        this.characterInitializedHandler = () => this.seedBaseline();
        dataManager.on('character_initialized', this.characterInitializedHandler);

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /**
     * Read the stone stack straight out of inventory and take it as the
     * starting point for future deltas.
     *
     * Never called from the `action_completed` path — see the module comment
     * for why that would race `dataManager`'s own handler on the same message.
     */
    seedBaseline() {
        try {
            const inventory = dataManager.getInventory();
            // Not loaded yet; `character_initialized` will call this again
            // once it is
            if (!inventory) return;

            const row = inventory.find(
                (item) => item?.itemHrid === PHILO_HRID && item?.itemLocationHrid === INVENTORY_LOCATION_HRID
            );
            const count = Number(row?.count);
            this.lastCount = Number.isFinite(count) ? count : 0;
            this.hasBaseline = true;
        } catch (error) {
            console.error('[PhiloStoneAlerts] Seeding the inventory baseline failed:', error);
        }
    }

    /** Listen for finished transmute attempts */
    registerWebSocketListeners() {
        const handler = (data) => {
            try {
                this.check(data);
            } catch (error) {
                console.error('[PhiloStoneAlerts] Reading a transmute result failed:', error);
            }
        };

        webSocketHook.on('action_completed', handler);
        this.unregisterHandlers.push(() => webSocketHook.off('action_completed', handler));
    }

    /**
     * The name the game gives the stone, falling back to a plain label.
     * @returns {string} Display name
     */
    itemName() {
        try {
            const name = dataManager.getInitClientData()?.itemDetailMap?.[PHILO_HRID]?.name;
            if (name) return name;
        } catch (error) {
            console.error('[PhiloStoneAlerts] Reading the item name failed:', error);
        }
        return "Philosopher's Stone";
    }

    /**
     * Decide whether one `action_completed` message reports a fresh stone, and
     * say so.
     * @param {Object} data - `action_completed`'s payload
     */
    check(data) {
        if (!config.getSetting(MASTER_SETTING)) return;
        if (data?.endCharacterAction?.actionHrid !== TRANSMUTE_ACTION_HRID) return;

        // The LAST matching row, not the first. One message can carry several
        // snapshots of the same stack as a batch of attempts plays out — a
        // batch that produced two stones arrives as rows [7, 8] — and only the
        // last of them is the total the stack ended on. Taking the first would
        // under-report the gain AND leave the baseline low, so the next genuine
        // stone would read as a gain of two.
        const rows = (data.endCharacterItems || []).filter(
            (r) => r?.itemHrid === PHILO_HRID && r?.itemLocationHrid === INVENTORY_LOCATION_HRID
        );
        const row = rows[rows.length - 1];
        if (!row) return;

        const count = Number(row.count);
        if (!Number.isFinite(count)) return;

        if (!this.hasBaseline) {
            // Inventory could not be seeded this session — the fallback from
            // the module comment: announce a gain of (at least) one rather
            // than stay silent, and take this row as the baseline going
            // forward so a later, properly-seeded message does not re-count
            // whatever this one already reported.
            const name = this.itemName();
            const result = notificationService.notify(
                `${EVENT_KEY_PREFIX}:${count}`,
                `Transmuting produced a ${name}!`,
                { title: "Philosopher's Stone!" }
            );
            if (result?.fired) {
                this.lastCount = count;
                this.hasBaseline = true;
            }
            return;
        }

        const previous = this.lastCount;
        const gained = count - previous;
        if (gained <= 0) {
            this.lastCount = count;
            return;
        }

        const name = this.itemName();
        const message = gained === 1 ? `Transmuting produced a ${name}!` : `Transmuting produced ${gained} ${name}s!`;

        // The new absolute total is the key: it only advances on a further
        // gain, so each stone (or batch of stones) gets its own announcement
        // rather than being deduplicated against the last one.
        const result = notificationService.notify(`${EVENT_KEY_PREFIX}:${count}`, message, {
            title: "Philosopher's Stone!",
        });

        // Only a delivered alert counts as told; an undelivered one leaves the
        // baseline where it was so the next message recomputes the same gain
        // and retries it
        if (result?.fired) this.lastCount = count;
    }

    /**
     * Cleanup
     */
    disable() {
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }
        if (this.characterInitializedHandler) {
            dataManager.off('character_initialized', this.characterInitializedHandler);
            this.characterInitializedHandler = null;
        }

        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        this.lastCount = null;
        this.hasBaseline = false;
    }
}

const philoStoneAlerts = new PhiloStoneAlerts();

export default philoStoneAlerts;
