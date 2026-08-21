/**
 * The weapon that stands for a class, drawn instead of spelling it out.
 *
 * `class-inference.js` decides what somebody is playing; the panels that show
 * it drew a bordered text chip — `Estevao [WATER] 175.8K`. Six letters and a
 * border is a lot of room on a row whose actual content is a name and a figure,
 * and in the Trial damage panel the chips crowded the names hard enough that a
 * long one ellipsed to make space for a word the reader already had a colour
 * for. A weapon icon is one glyph, and it is the glyph the game itself uses to
 * mean that style — nobody has to learn it.
 *
 * ## Which weapon, and why it is looked up rather than listed
 *
 * A hardcoded list of hrids is a list that is wrong the week a tier ships, and
 * the failure is silent: a missing sprite id draws an empty box. So each bucket
 * is a **query** against the game's own `itemDetailMap`, run against whatever
 * data the client has:
 *
 * - **Melee** — a weapon whose combat style is stab, slash or smash.
 * - **Ranged** — combat style `ranged`.
 * - **Fire / Water Mage** — combat style `magic` with that damage type. The two
 *   damage elements, and the distinction the buckets exist to make.
 * - **Healer** — combat style `magic` with damage type **nature**. Nature is
 *   the element the game's healing is written in, which is why
 *   `class-inference.js` files a nature caster as the healer rather than as a
 *   third mage; the icon follows the same rule, so the drawing and the verdict
 *   cannot disagree.
 * - **Mage** — combat style `magic`, any element, for the verdict that could
 *   not name one.
 * - **Tank** — the **Bulwark** line, matched on the item's name. A bulwark is
 *   the thing a tank is recognisable by on sight; ranking off-hands by a stat
 *   would sooner or later pick some orb nobody associates with tanking. The
 *   detection rule is untouched — threat on the sheet still settles the
 *   verdict — this only decides what gets drawn for it.
 *
 * The tier is the highest item level **at or below** {@link CLASS_WEAPON_LEVEL}
 * that the query matches, rather than an equality test on 95. A client whose
 * data has no T95 nature trident should draw the T90 one rather than nothing,
 * and a future T105 tier should not silently promote every icon past the level
 * these were chosen to read as. A bucket that matches *only* above the ceiling
 * takes the lowest such item rather than drawing nothing.
 *
 * Ties break on hrid so the same client draws the same icon every session — an
 * icon that changed between reloads would read as the inference changing.
 *
 * ## It fails to a chip, not to a blank
 *
 * `itemDetailMap` is absent until the game has sent its init payload, and a
 * bucket can genuinely match nothing. Both return null, and the callers keep
 * drawing the text chip — which is why `classTagText` stays exactly where it
 * was rather than being replaced.
 */

import dataManager from '../core/data-manager.js';
import { spriteIcon, itemSpriteUrl } from './overlay-format.js';

/**
 * The tier the icons are chosen at.
 *
 * A ceiling rather than a target: see the module note. Ninety-five because that
 * is the tier a trial roster is actually wearing, so the icons read as the
 * weapons on screen rather than as museum pieces.
 */
export const CLASS_WEAPON_LEVEL = 95;

/** Where a weapon can sit. A two-hander leaves `main_hand` empty and vice versa */
const WEAPON_SLOTS = ['/equipment_types/two_hand', '/equipment_types/main_hand'];

/** Where a shield sits */
const OFF_HAND = '/equipment_types/off_hand';

/**
 * The last segment of an hrid, which is the only part worth comparing.
 * @param {string} hrid - e.g. `/damage_types/water`
 * @returns {string} e.g. `water`
 */
function tail(hrid) {
    const raw = String(hrid || '');
    return raw.includes('/') ? raw.split('/').pop() : raw;
}

/**
 * One candidate weapon, reduced to the fields the rules read.
 * @param {string} hrid - Item hrid
 * @param {Object} item - Its `itemDetailMap` entry
 * @returns {{hrid: string, name: string, itemLevel: number, slot: string,
 *   style: string, element: string, stats: Object}|null}
 */
function candidate(hrid, item) {
    const equipment = item?.equipmentDetail;
    if (!equipment?.type) return null;

    const stats = equipment.combatStats || {};
    return {
        hrid,
        name: item.name || tail(hrid).replace(/_/g, ' '),
        itemLevel: Number(item.itemLevel) || 0,
        slot: equipment.type,
        style: tail(stats.combatStyleHrids?.[0]),
        element: tail(stats.damageType),
        stats,
    };
}

/**
 * The rule each bucket is resolved by.
 *
 * `match` says what counts; `score` breaks ties among everything at the chosen
 * tier, biggest first. A bucket with no rule (an unknown key) resolves to null
 * rather than to whatever the first entry happened to be.
 */
const RULES = {
    melee: { match: (entry) => ['stab', 'slash', 'smash'].includes(entry.style) },
    ranged: { match: (entry) => entry.style === 'ranged' },
    mage: { match: (entry) => entry.style === 'magic' },
    fireMage: { match: (entry) => entry.style === 'magic' && entry.element === 'fire' },
    waterMage: { match: (entry) => entry.style === 'magic' && entry.element === 'water' },
    // Nature is the healing element — see the module note, and the bucket table
    // in `class-inference.js` that maps a nature caster to this same bucket
    healer: { match: (entry) => entry.style === 'magic' && entry.element === 'nature' },
    tank: {
        slots: [OFF_HAND, ...WEAPON_SLOTS],
        match: (entry) => /bulwark/i.test(entry.name) || /bulwark/i.test(entry.hrid),
    },
};

/**
 * The weapon that stands for one class bucket.
 *
 * @param {string} bucketKey - A key of `CLASS_BUCKETS` from `class-inference.js`
 * @param {Object} [itemDetailMap] - Game data; read from the client by default
 * @returns {{hrid: string, name: string, itemLevel: number}|null} Null when the
 *   data is not loaded, the key is not a bucket, or nothing matches
 */
export function classWeapon(bucketKey, itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap) {
    const rule = RULES[bucketKey];
    if (!rule || !itemDetailMap) return null;

    const slots = rule.slots || WEAPON_SLOTS;
    const matched = [];
    for (const [hrid, item] of Object.entries(itemDetailMap)) {
        // A refined variant is the same weapon at the same tier with a
        // different sprite tail; the plain one is the recognisable drawing
        if (hrid.endsWith('_refined')) continue;

        const entry = candidate(hrid, item);
        if (!entry || !slots.includes(entry.slot)) continue;
        if (!rule.match(entry)) continue;
        matched.push(entry);
    }

    if (!matched.length) return null;

    // The tier is the best available at or under the target, not an equality
    // test — a client missing the T95 piece draws the T90 one. A line that only
    // exists above the ceiling takes its lowest rung rather than nothing
    const atOrBelow = matched.filter((entry) => entry.itemLevel <= CLASS_WEAPON_LEVEL);
    const pool = atOrBelow.length ? atOrBelow : matched;
    const tier = atOrBelow.length
        ? Math.max(...pool.map((entry) => entry.itemLevel))
        : Math.min(...pool.map((entry) => entry.itemLevel));

    const score = rule.score || (() => 0);
    const [best] = pool
        .filter((entry) => entry.itemLevel === tier)
        .sort((a, b) => score(b) - score(a) || a.hrid.localeCompare(b.hrid));

    return { hrid: best.hrid, name: best.name, itemLevel: best.itemLevel };
}

/**
 * The class tag as an icon, or null when there is no icon to draw.
 *
 * The text does not go away — it becomes the tooltip, which is where the
 * honesty lives: the tag is an inference, and the caller's `title` says what it
 * was inferred from. The weapon's own name is appended so a reader who does not
 * recognise a sprite can hover it and find out what they are looking at.
 *
 * @param {Object|null} classTag - A verdict from `class-inference.js`
 * @param {Object} [options] - Drawing options
 * @param {string} [options.title] - The tooltip the chip would have carried
 * @param {number} [options.size] - Pixels
 * @param {Object} [options.itemDetailMap] - Game data; read from the client by default
 * @returns {SVGElement|null}
 */
export function classTagIcon(classTag, { title = '', size = 14, itemDetailMap } = {}) {
    const weapon = classWeapon(
        classTag?.key,
        itemDetailMap === undefined ? dataManager.getInitClientData?.()?.itemDetailMap : itemDetailMap
    );
    // No sprite sheet yet is the same answer as no weapon: a spacer where an
    // icon should be reads as a missing icon, and the chip says more
    if (!weapon || !itemSpriteUrl()) return null;

    const icon = spriteIcon(weapon.hrid, size);
    icon.style.verticalAlign = 'middle';
    icon.style.opacity = '0.9';

    // SVG takes its tooltip from a child <title>, not from the attribute
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    label.textContent = iconTitle(classTag, weapon, title);
    icon.appendChild(label);
    return icon;
}

/**
 * The same icon as markup, for the panels that build their rows as strings.
 *
 * Nothing user-supplied reaches it: the sprite href is the game's own asset URL
 * plus an hrid tail this module resolved out of the game's data, and the title
 * is escaped.
 *
 * @param {Object|null} classTag - A verdict from `class-inference.js`
 * @param {Object} [options] - As {@link classTagIcon}
 * @returns {string} HTML, or '' when there is no icon to draw
 */
export function classTagIconHTML(classTag, { title = '', size = 14, itemDetailMap } = {}) {
    const weapon = classWeapon(
        classTag?.key,
        itemDetailMap === undefined ? dataManager.getInitClientData?.()?.itemDetailMap : itemDetailMap
    );
    const sprite = itemSpriteUrl();
    if (!weapon || !sprite) return '';

    const href = `${sprite}#${tail(weapon.hrid)}`;
    return (
        `<svg width="${size}" height="${size}" style="flex:0 0 auto; vertical-align:middle; opacity:0.9;">` +
        `<title>${escapeText(iconTitle(classTag, weapon, title))}</title>` +
        `<use href="${escapeText(href)}"></use></svg>`
    );
}

/**
 * What the icon says when hovered: the class, its evidence, and the weapon.
 * @param {Object} classTag - The verdict
 * @param {{name: string, itemLevel: number}} weapon - The resolved weapon
 * @param {string} title - The tooltip the chip would have carried
 * @returns {string}
 */
function iconTitle(classTag, weapon, title) {
    const head = title || classTag?.label || '';
    return `${head}${head ? '\n' : ''}Drawn as ${weapon.name} (level ${weapon.itemLevel}) — a stand-in for the class, not this player's weapon.`;
}

/**
 * Markup-safe text.
 * @param {string} value - Anything
 * @returns {string}
 */
function escapeText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
