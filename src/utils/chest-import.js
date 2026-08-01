/**
 * Chest history import and export.
 *
 * A chest ledger is only worth keeping if it survives — a new browser, a second
 * machine, or a move from whichever script you were using before. All three are
 * the same problem: read someone else's shape of the same facts, and write ours
 * in a shape that can be read back.
 *
 * Kept pure and apart from the tracker because an import that silently drops
 * half a ledger looks exactly like an import that worked. Every conversion here
 * reports what it could not translate rather than skipping quietly.
 */

/**
 * Our own export, which is the tally plus enough context to read it later.
 *
 * Item counts only — no prices. Prices are a property of the market on the day
 * you exported, and baking them in would make an old file re-import as a ledger
 * priced in last month's money.
 *
 * @param {Object} tally - `{ [chestHrid]: { opened, loot, last } }`
 * @param {Object} settings - Valuation settings to carry along
 * @param {string} [player] - Whose ledger this is, for the reader's benefit
 * @returns {Object} The exportable object
 */
export function toExport(tally, settings, player = '') {
    return {
        format: 'toolasha-treasure',
        version: 1,
        player,
        exportedAt: new Date().toISOString(),
        settings: { ...settings },
        chests: { ...tally },
    };
}

/**
 * Read our own export back.
 * @param {Object} json - Parsed file
 * @returns {{tally: Object, settings: Object}|null} Null when it is not ours
 */
export function fromToolashaExport(json) {
    if (json?.format !== 'toolasha-treasure' || !json.chests) return null;
    return { tally: json.chests, settings: json.settings || {} };
}

/**
 * Read a TReasure export from MWI Combat Suite.
 *
 * Its shape is richer than ours — every entry carries the name, unit price and
 * total value as they stood at export — but the only durable facts are the
 * counts. The rest is re-derived from today's market, so it is dropped rather
 * than trusted.
 *
 * @param {Object} json - Parsed file
 * @returns {{tally: Object, settings: Object}|null} Null when it is not TReasure's
 */
export function fromTreasureExport(json) {
    if (!json?.chests || json.format === 'toolasha-treasure') return null;

    const sample = Object.values(json.chests)[0];
    if (!sample?.total?.loot) return null;

    const tally = {};
    for (const [chestHrid, chest] of Object.entries(json.chests)) {
        const loot = {};
        for (const [itemHrid, entry] of Object.entries(chest.total?.loot || {})) {
            // Entries are objects there and bare counts here
            loot[itemHrid] = typeof entry === 'number' ? entry : entry?.count || 0;
        }

        const lastLoot = {};
        for (const [itemHrid, entry] of Object.entries(chest.last?.loot || {})) {
            lastLoot[itemHrid] = typeof entry === 'number' ? entry : entry?.count || 0;
        }

        tally[chestHrid] = {
            opened: chest.total?.opened || 0,
            loot,
            last: { opened: chest.last?.opened || 0, loot: lastLoot },
        };
    }

    // Their names for the same two choices
    const settings = {};
    if (json.settings?.useMirrorValue) settings.capeValue = json.settings.useMirrorValue;
    if (json.settings?.useCowbell0 !== undefined) settings.valueCowbells = !json.settings.useCowbell0;

    return { tally, settings };
}

/**
 * Read Edible Tools' chest data out of its own storage shape.
 *
 * It keys everything by **display name** rather than hrid, in the language the
 * game was running in, so translating it needs a name index built from the
 * current game data. Anything that does not match is reported rather than
 * dropped in silence — a chest whose name has since changed would otherwise
 * vanish without trace.
 *
 * @param {Object} chestData - The `开箱数据` object for one player
 * @param {Object<string, string>} nameToHrid - Item display name → hrid
 * @returns {{tally: Object, unmatched: string[]}}
 */
export function fromEdibleTools(chestData, nameToHrid) {
    const tally = {};
    const unmatched = [];

    for (const [chestName, chest] of Object.entries(chestData || {})) {
        const chestHrid = nameToHrid[chestName];
        if (!chestHrid) {
            unmatched.push(chestName);
            continue;
        }

        const loot = {};
        for (const [itemName, item] of Object.entries(chest?.获得物品 || {})) {
            const itemHrid = nameToHrid[itemName];
            if (!itemHrid) {
                unmatched.push(itemName);
                continue;
            }
            loot[itemHrid] = item?.数量 || 0;
        }

        tally[chestHrid] = {
            opened: chest?.总计开箱数量 || 0,
            loot,
            // It keeps no record of the most recent opening, and inventing one
            // from the total would report a single opening of hundreds of chests
            last: { opened: 0, loot: {} },
        };
    }

    return { tally, unmatched };
}

/**
 * Find Edible Tools' data for the current character in its localStorage blob.
 * @param {Object} stored - Parsed `Edible_Tools` value
 * @param {string|number} characterId - Current character
 * @param {string} characterName - Current character's name
 * @returns {Object|null} The `开箱数据` object, or null
 */
export function findEdibleToolsData(stored, characterId, characterName) {
    const byPlayer = stored?.Chest_Open_Data;
    if (!byPlayer) return null;

    const byId = byPlayer[characterId] || byPlayer[String(characterId)];
    if (byId?.开箱数据 && Object.keys(byId.开箱数据).length) return byId.开箱数据;

    // Falling back to the name, because the id it stored may predate a move
    // between accounts on the same browser
    for (const entry of Object.values(byPlayer)) {
        if (entry?.玩家昵称 === characterName && Object.keys(entry?.开箱数据 || {}).length) {
            return entry.开箱数据;
        }
    }
    return null;
}

/**
 * Combine an imported ledger with the one already held.
 *
 * `replace` is the honest default for a file that came from this same tool on
 * another machine — the two are the same ledger, and adding them together would
 * double it. `append` is for merging genuinely separate histories, and only ever
 * adds counts, never the `last` opening, which belongs to whichever ledger saw
 * it most recently.
 *
 * @param {Object} current - The tally now
 * @param {Object} incoming - The tally being imported
 * @param {string} mode - `'replace'` or `'append'`
 * @returns {Object} A new tally
 */
export function mergeTally(current, incoming, mode = 'replace') {
    if (mode !== 'append') return { ...incoming };

    const merged = { ...current };
    for (const [chestHrid, entry] of Object.entries(incoming || {})) {
        const existing = merged[chestHrid];
        if (!existing) {
            merged[chestHrid] = entry;
            continue;
        }

        const loot = { ...existing.loot };
        for (const [itemHrid, count] of Object.entries(entry.loot || {})) {
            loot[itemHrid] = (loot[itemHrid] || 0) + count;
        }
        merged[chestHrid] = {
            opened: (existing.opened || 0) + (entry.opened || 0),
            loot,
            last: existing.last || entry.last,
        };
    }
    return merged;
}
