/**
 * Editing a sim player's talismans (the Combat Sim editor's Belt rows).
 *
 * A sim player carries `dto.talismans` as unscaled records `{slotIndex 1..3, modifiers: [{hrid, grade}]}`. The editor
 * edits that list in place, so everything that already reads it (the engine, the Upgrade tab, the talisman line
 * ranking, copy/export, roster saves) sees the edit with no extra path. These helpers take the list and return a new
 * one; none mutates its input.
 *
 * Rules the game keeps and this keeps: a talisman never holds one line type twice (the same line on two different
 * talismans is fine and adds), a grade is a whole number from 1 to the game's maximum, and a belt has 1 to 3 slots.
 * Slots past the belt's count stay in the list (swapping the belt back restores them) but the engine and the rows
 * ignore them.
 */

/**
 * @param {Array<Object>|null|undefined} talismans
 * @param {number} slot - 1-based slot
 * @returns {Object|null} The record in that slot (the first, as the engine reads only the first), or null
 */
export function talismanInSlot(talismans, slot) {
    return (Array.isArray(talismans) ? talismans : []).find((t) => t && t.slotIndex === slot) || null;
}

/** @returns {number} The grade as a whole number inside 1..maxGrade */
export function clampGrade(grade, maxGrade) {
    const whole = Math.floor(Number(grade));
    if (!Number.isFinite(whole)) return 1;
    return Math.min(Math.max(1, maxGrade), Math.max(1, whole));
}

/**
 * Replace one slot's record with a changed copy of its lines.
 * @private
 */
function withSlot(talismans, slot, change) {
    const list = (Array.isArray(talismans) ? talismans : []).filter((t) => t && typeof t === 'object');
    const at = list.findIndex((t) => t.slotIndex === slot);
    const current = at >= 0 ? list[at] : { slotIndex: slot, modifiers: [] };
    const lines = Array.isArray(current.modifiers) ? current.modifiers.map((m) => ({ ...m })) : [];
    const next = change(lines);
    if (next === null) return list;
    const record = { ...current, slotIndex: slot, modifiers: next };
    if (at >= 0) return list.map((t, i) => (i === at ? record : t));
    return [...list, record].sort((a, b) => (a.slotIndex || 0) - (b.slotIndex || 0));
}

/**
 * Add a line to a slot (creating the talisman when the slot is empty). Refused (list unchanged) when the slot is full
 * or the type is already on that talisman.
 * @param {Array<Object>} talismans
 * @param {number} slot
 * @param {string} hrid - Modifier hrid
 * @param {number} grade
 * @param {{maxGrade: number, linesPerTalisman: number}} limits
 * @returns {Array<Object>}
 */
export function addTalismanLine(talismans, slot, hrid, grade, limits) {
    return withSlot(talismans, slot, (lines) => {
        if (lines.length >= limits.linesPerTalisman || lines.some((m) => m.hrid === hrid)) return null;
        return [...lines, { hrid, grade: clampGrade(grade, limits.maxGrade) }];
    });
}

/**
 * Change the type of one line. Refused when another line of that talisman already has the type.
 * @returns {Array<Object>}
 */
export function setTalismanLineType(talismans, slot, lineIndex, hrid) {
    return withSlot(talismans, slot, (lines) => {
        if (!lines[lineIndex] || lines.some((m, i) => i !== lineIndex && m.hrid === hrid)) return null;
        lines[lineIndex] = { ...lines[lineIndex], hrid };
        return lines;
    });
}

/**
 * Change the grade of one line (clamped to 1..maxGrade).
 * @returns {Array<Object>}
 */
export function setTalismanLineGrade(talismans, slot, lineIndex, grade, maxGrade) {
    return withSlot(talismans, slot, (lines) => {
        if (!lines[lineIndex]) return null;
        lines[lineIndex] = { ...lines[lineIndex], grade: clampGrade(grade, maxGrade) };
        return lines;
    });
}

/**
 * Drop one line. The talisman stays (a worn talisman with no lines is a real state).
 * @returns {Array<Object>}
 */
export function removeTalismanLine(talismans, slot, lineIndex) {
    return withSlot(talismans, slot, (lines) => {
        if (!lines[lineIndex]) return null;
        return lines.filter((_, i) => i !== lineIndex);
    });
}

/**
 * A comparable text of the part of a list the sim uses (slots, lines, grades), so "has this been edited" does not
 * depend on record order, spare fields, or slots the belt does not have.
 * @param {Array<Object>|null|undefined} talismans
 * @returns {string}
 */
export function talismanListSignature(talismans) {
    const rows = (Array.isArray(talismans) ? talismans : [])
        .filter((t) => t && typeof t === 'object' && Array.isArray(t.modifiers) && t.modifiers.length > 0)
        .map((t) => [t.slotIndex, t.modifiers.map((m) => `${m?.hrid}@${m?.grade}`).join(',')])
        .sort((a, b) => (a[0] || 0) - (b[0] || 0));
    return JSON.stringify(rows);
}
