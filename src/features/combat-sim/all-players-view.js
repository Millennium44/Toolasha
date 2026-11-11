/**
 * Helpers for the Results tab's "All" view: every party member's figures side by side.
 */

/**
 * One column header per player, in roster order. Players who share a name get a running number
 * ("Ana", "Ana (2)") so no two columns read the same.
 * @param {Array<{hrid: string, name: string}>} playerInfo - The run's roster
 * @returns {Array<{hrid: string, label: string}>}
 */
export function playerColumnLabels(playerInfo) {
    const seen = new Map();
    return (playerInfo || []).map(({ hrid, name }) => {
        const base = String(name ?? '').trim() || hrid;
        const count = (seen.get(base) || 0) + 1;
        seen.set(base, count);
        return { hrid, label: count === 1 ? base : `${base} (${count})` };
    });
}
