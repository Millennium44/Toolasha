/**
 * Stable JSON text
 *
 * `JSON.stringify` writes an object's keys in insertion order, which makes it a
 * poor identity for anything assembled by walking a Map: the game's equipment
 * map is rebuilt by `delete`/`set`, so unequipping and re-equipping the same
 * item moves its key to the end and an identical kit serializes to different
 * bytes. Anything that compares two builds by their text has to sort first.
 *
 * Arrays are left in the order they came in — ability and consumable order is
 * the rotation, and normalizing it would call two different builds the same.
 */

/**
 * JSON text with every object's keys in sorted order, arrays left in theirs.
 *
 * @param {*} value - Anything JSON can hold
 * @returns {string}
 */
export function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const body = Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',');
        return `{${body}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

export default stableStringify;
