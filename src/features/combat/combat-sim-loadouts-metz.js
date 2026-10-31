/**
 * Saved combat loadouts for the Metz Combat Simulator export
 *
 * Metz's importer reads an optional `loadouts` array on your own character and offers each loadout
 * in a picker. The per-loadout shape below is that external contract: `{id, name, equipment,
 * abilities, food, drinks, triggerMap}`. That the importer reads it is upstream's claim, not
 * something verified from this repo.
 *
 * The "Import from Toolasha" button runs on the Metz site, which never sees the game's WebSocket,
 * so the saved loadouts (Loadout Snapshots) are empty there. The game page therefore publishes the
 * built array to GM storage, and the export reads it back on the Metz site, the same cross-domain
 * route `init_character_data` already takes.
 *
 * GM writes are retained by the userscript manager, so the publisher writes only when the built
 * array actually differs from what is already stored (never on a timer).
 */

import dataManager from '../../core/data-manager.js';
import loadoutSnapshot from './loadout-snapshot.js';
import { highestOwnedEnhancements } from '../../utils/loadout-equipment.js';
import { gmGetValue, gmSetValue } from '../../utils/gm-traffic.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

const COMBAT_ACTION_TYPE = '/action_types/combat';
const TOOL_SLOT_PATTERN = /_tool$/;
const GM_LOADOUTS_KEY = 'toolasha_metz_loadouts';
const PUBLISH_DEBOUNCE_MS = 2000;
// action_completed re-emits items_updated, so these two cover inventory and abilities
const INPUT_EVENTS = ['items_updated', 'abilities_updated'];

const timerRegistry = createTimerRegistry();
let publishTimeout = null;
let lastPublished = null;
let updateListener = null;
let characterListener = null;
let inputsListener = null;
let generation = 0;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const finiteOrNull = (value) =>
    value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const stringOr = (value, fallback) => (value == null || value === '' ? fallback : String(value));

function cleanTrigger(trigger) {
    if (!isObject(trigger) || !trigger.dependencyHrid || !trigger.conditionHrid || !trigger.comparatorHrid) {
        return null;
    }
    return {
        dependencyHrid: String(trigger.dependencyHrid),
        conditionHrid: String(trigger.conditionHrid),
        comparatorHrid: String(trigger.comparatorHrid),
        value: finiteOrNull(trigger.value) ?? 0,
    };
}

function cleanEquipment(list) {
    const equipment = [];
    for (const entry of Array.isArray(list) ? list : []) {
        if (!isObject(entry) || !entry.itemHrid) continue;
        const slot = stringOr(entry.itemLocationHrid, '');
        if (TOOL_SLOT_PATTERN.test(slot)) continue;
        const level = finiteOrNull(entry.enhancementLevel);
        if (level === null) continue;
        equipment.push({
            itemLocationHrid: slot,
            itemHrid: String(entry.itemHrid),
            enhancementLevel: Math.max(0, Math.floor(level)),
        });
    }
    return equipment;
}

function cleanAbilities(list, abilityLevels) {
    const rows = (Array.isArray(list) ? list : [])
        .filter((ability) => isObject(ability) && ability.abilityHrid)
        .map((ability, index) => ({
            hrid: String(ability.abilityHrid),
            slot: finiteOrNull(ability.slot) ?? Number.MAX_SAFE_INTEGER,
            index,
        }))
        .sort((a, b) => a.slot - b.slot || a.index - b.index);

    const abilities = [];
    const seen = new Set();
    for (const { hrid } of rows) {
        if (seen.has(hrid)) continue;
        seen.add(hrid);
        const level = finiteOrNull(isObject(abilityLevels) ? abilityLevels[hrid] : null);
        abilities.push({ abilityHrid: hrid, level: level !== null && level >= 1 ? Math.floor(level) : 1 });
    }
    return abilities;
}

function cleanConsumables(list) {
    const consumables = [];
    const seen = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
        const hrid = isObject(entry) ? entry.itemHrid : typeof entry === 'string' ? entry : '';
        if (!hrid || seen.has(hrid)) continue;
        seen.add(hrid);
        consumables.push({ itemHrid: String(hrid) });
    }
    return consumables;
}

function triggersFor(map, hrid) {
    // null is the game's "activate whenever ready". The site needs it said: a hrid the map omits
    // gets the ability's default triggers instead.
    return Array.isArray(map[hrid]) ? map[hrid].map(cleanTrigger).filter(Boolean) : null;
}

/**
 * Build the `loadouts` array Metz's importer accepts from loadout snapshots.
 * Combat loadouts only, ordered by `ordinal`; tool slots are left out; a loadout with no gear and
 * no abilities is left out. `triggerMap` holds exactly the hrids the loadout carries. Equipment
 * must already carry resolved enhancement levels (a null/absent level drops the piece).
 * @param {Array<Object>} snapshots - Loadout Snapshots entries with resolved `equipment`
 * @param {Object<string, number>} [abilityLevels] - Learned ability levels by hrid
 * @returns {Array<Object>}
 */
export function buildMetzLoadouts(snapshots, abilityLevels = {}) {
    const combat = (Array.isArray(snapshots) ? snapshots : [])
        .map((snapshot, index) => ({ snapshot, index }))
        .filter(({ snapshot }) => isObject(snapshot) && snapshot.actionTypeHrid === COMBAT_ACTION_TYPE)
        .sort(
            (a, b) =>
                (finiteOrNull(a.snapshot.ordinal) ?? Number.MAX_SAFE_INTEGER) -
                    (finiteOrNull(b.snapshot.ordinal) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index
        );

    const loadouts = [];
    for (const { snapshot } of combat) {
        const equipment = cleanEquipment(snapshot.equipment);
        const abilities = cleanAbilities(snapshot.abilities, abilityLevels);
        if (!equipment.length && !abilities.length) continue;

        const food = cleanConsumables(snapshot.food);
        const drinks = cleanConsumables(snapshot.drinks);
        const abilityMap = isObject(snapshot.abilityCombatTriggersMap) ? snapshot.abilityCombatTriggersMap : {};
        const consumableMap = isObject(snapshot.consumableCombatTriggersMap)
            ? snapshot.consumableCombatTriggersMap
            : {};

        const triggerMap = {};
        for (const ability of abilities) {
            triggerMap[ability.abilityHrid] = triggersFor(abilityMap, ability.abilityHrid);
        }
        for (const consumable of [...food, ...drinks]) {
            triggerMap[consumable.itemHrid] = triggersFor(consumableMap, consumable.itemHrid);
        }

        loadouts.push({
            id: stringOr(snapshot.id, String(loadouts.length + 1)),
            name: stringOr(snapshot.name, `Loadout ${loadouts.length + 1}`),
            equipment,
            abilities,
            food,
            drinks,
            triggerMap,
        });
    }
    return loadouts;
}

/**
 * Build the loadouts from the live Loadout Snapshots store (game page only). Enhancement levels go
 * through `resolveEquipment` (highest owned unless the loadout pins exact levels). A loadout that
 * needs a (non-tool) item the character no longer owns is skipped, since the sim would otherwise
 * rate a set the character cannot equip; with no inventory loaded yet nothing is judged unowned.
 * @returns {Array<Object>}
 */
export function collectMetzLoadouts() {
    const snapshots = loadoutSnapshot.getAllSnapshots();
    if (!snapshots.length) {
        return [];
    }
    const owned = highestOwnedEnhancements();
    // Exact-level loadouts wear precisely what they pin, so each piece must be owned at that level
    const ownedPairs = new Set();
    for (const item of dataManager.characterItems || dataManager.characterData?.characterItems || []) {
        if (item?.itemHrid && item.count !== 0) ownedPairs.add(`${item.itemHrid}:${item.enhancementLevel || 0}`);
    }
    const isOwned = (snapshot, equip) =>
        snapshot.useExactEnhancement
            ? ownedPairs.has(`${equip.itemHrid}:${equip.enhancementLevel || 0}`)
            : owned.has(equip.itemHrid);
    const usable = snapshots
        .filter(
            (snapshot) =>
                !owned.size ||
                (snapshot.equipment || []).every(
                    (equip) => TOOL_SLOT_PATTERN.test(equip.itemLocationHrid || '') || isOwned(snapshot, equip)
                )
        )
        .map((snapshot) => ({
            ...snapshot,
            equipment: loadoutSnapshot.resolveEquipment(snapshot).map((equip) =>
                // The shared resolver never goes below the stored level, so a sold +12 would still
                // export. A free loadout wears the best copy owned now; with no inventory, keep stored.
                snapshot.useExactEnhancement || !owned.size || !owned.has(equip.itemHrid)
                    ? equip
                    : { ...equip, enhancementLevel: owned.get(equip.itemHrid) }
            ),
        }));

    const abilityLevels = {};
    for (const ability of dataManager.characterData?.characterAbilities || []) {
        if (ability?.abilityHrid) abilityLevels[ability.abilityHrid] = ability.level || 1;
    }
    return buildMetzLoadouts(usable, abilityLevels);
}

/**
 * Whether an empty live list is a real answer. It is once the snapshot store has loaded and either
 * holds nothing or the inventory is loaded to judge ownership by; before that (the store not loaded,
 * as on the Metz site, or snapshots present but no inventory yet) an empty list only means "not
 * known", and the stored copy may stand in.
 * @returns {boolean}
 */
function liveLoadoutsKnown() {
    if (!loadoutSnapshot.snapshotsReady) return false;
    if (!loadoutSnapshot.getAllSnapshots().length) return true;
    return highestOwnedEnhancements().size > 0;
}

function publish() {
    if (typeof GM_setValue === 'undefined') {
        return;
    }
    // An empty store before it has loaded says nothing about the character's loadouts
    if (!loadoutSnapshot.snapshotsReady) {
        return;
    }
    try {
        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (characterId == null) {
            return;
        }
        const serialized = JSON.stringify({ characterId, loadouts: collectMetzLoadouts() });
        if (lastPublished === null && typeof GM_getValue !== 'undefined') {
            // First publish of this page: compare with what an earlier page already stored
            lastPublished = gmGetValue(GM_LOADOUTS_KEY, null);
        }
        if (serialized === lastPublished) {
            return;
        }
        gmSetValue(GM_LOADOUTS_KEY, serialized);
        lastPublished = serialized;
    } catch (error) {
        console.error('[MetzLoadouts] Failed to publish loadouts:', error);
    }
}

function schedulePublish() {
    if (publishTimeout) {
        return;
    }
    publishTimeout = setTimeout(() => {
        publishTimeout = null;
        publish();
    }, PUBLISH_DEBOUNCE_MS);
    timerRegistry.registerTimeout(publishTimeout);
}

/**
 * Game page only: keep the GM-stored copy of the loadouts current so the Metz site can read it.
 * Publishes when the store reports an update and once after it first loads.
 */
export async function startMetzLoadoutPublisher() {
    stopMetzLoadoutPublisher();
    const mine = generation;
    updateListener = () => schedulePublish();
    loadoutSnapshot.onUpdate(updateListener);
    characterListener = async () => {
        // A character switch re-initializes the store; its first load emits nothing
        await loadoutSnapshot.whenReady();
        if (mine === generation) schedulePublish();
    };
    dataManager.on?.('character_initialized', characterListener);
    // Owned levels and learned ability levels feed the built list without a snapshot update. The
    // publish is debounced and deduplicated, so frequent inventory events cost no GM writes.
    inputsListener = () => schedulePublish();
    for (const event of INPUT_EVENTS) dataManager.on?.(event, inputsListener);
    await loadoutSnapshot.whenReady();
    if (mine === generation) schedulePublish();
}

export function stopMetzLoadoutPublisher() {
    generation += 1;
    if (updateListener) {
        loadoutSnapshot.offUpdate(updateListener);
        updateListener = null;
    }
    if (characterListener) {
        dataManager.off?.('character_initialized', characterListener);
        characterListener = null;
    }
    if (inputsListener) {
        for (const event of INPUT_EVENTS) dataManager.off?.(event, inputsListener);
        inputsListener = null;
    }
    timerRegistry.clearAll();
    publishTimeout = null;
    lastPublished = null;
}

/** Feature-registry module: runs while Loadout Snapshots does. */
export const metzLoadoutPublisher = {
    name: 'Metz Loadout Publisher',
    initialize: startMetzLoadoutPublisher,
    cleanup: stopMetzLoadoutPublisher,
    disable: stopMetzLoadoutPublisher,
};

/**
 * Loadouts for the export: live on the game page, otherwise the GM-stored copy (the Metz site).
 * The stored copy is used only when it belongs to the character being exported.
 * @param {string|number|null} characterId - Character being exported
 * @returns {Array<Object>}
 */
export function getMetzLoadouts(characterId) {
    const live = collectMetzLoadouts();
    if (live.length || liveLoadoutsKnown()) {
        return live;
    }
    if (typeof GM_getValue === 'undefined') {
        return [];
    }
    try {
        const raw = gmGetValue(GM_LOADOUTS_KEY, null);
        const stored = raw ? JSON.parse(raw) : null;
        if (stored && Array.isArray(stored.loadouts) && String(stored.characterId) === String(characterId)) {
            return stored.loadouts;
        }
    } catch (error) {
        console.error('[MetzLoadouts] Failed to read stored loadouts:', error);
    }
    return [];
}
