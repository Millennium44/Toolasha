/**
 * Character Select Resolver
 *
 * Finds the populated slots on the native character-select screen and, where possible, joins
 * each one to the character record the page has already loaded — without issuing a `/characters`
 * request of our own and without reading a single pixel of visible text.
 *
 * Two divergences from upstream, both forced by the February 2026 game update that stripped the
 * `__reactFiber$…` keys off DOM elements:
 *
 * 1. The fiber for an element is found by walking down from `#root`'s `_reactRootContainer`
 *    (`utils/react-click.js`), not by reading a key off the element itself.
 * 2. The fiber read is treated as a bonus, not a precondition. Binding a slot to a character id
 *    needs only the slot's own navigation link, so when the ascent fails — a React internals
 *    change, a version that renders slots as function components — the slots still resolve, just
 *    without the native `lastOfflineTime`. The display model already handles that being null.
 *
 * Binding is by exact id only, never by position, name, or order. Malformed, missing, and
 * duplicated ids are excluded rather than guessed at.
 */

import { fiberFor } from '../../utils/react-click.js';

const MAX_OWNER_DEPTH = 256;

/**
 * Class-name substrings rather than the full `[class*=…]` selectors in `utils/selectors.js`,
 * because the shared DOM observer matches on substrings and these are used both ways.
 */
export const CHARACTER_SELECT_ROOT_CLASS = 'CharacterSelectPage_characterSelectPage';
export const CHARACTER_SLOTS_CLASS = 'CharacterSelectPage_characterSlots';
const SLOT_CLASS = 'CharacterSelectPage_slot';

const REQUIRED_STATE_KEYS = [
    'characters',
    'availableGameModes',
    'gameModeInput',
    'showCreateCharacterModal',
    'isCreateCharacterPending',
];
const REQUIRED_METHODS = ['loadCharacters', 'renderCharacterSlots', 'characterSelected'];

/**
 * Whether a component's state has the exact shape character select's does.
 * @param {Object} state
 * @returns {boolean}
 */
function hasCharacterSelectStateSignature(state) {
    if (!state || typeof state !== 'object') return false;
    if (!Array.isArray(state.characters)) return false;
    return REQUIRED_STATE_KEYS.every((key) => key in state);
}

/**
 * Ascend from a DOM anchor inside character select to the owning page component, validated by
 * exact behavioural (method) and structural (state shape) signature. Fails closed — returns null
 * — if the ascent exceeds its depth bound or resolves to more than one distinct candidate.
 * @param {Element} element - Any element inside the character-select page
 * @returns {Object|null} The page component instance, or null
 */
export function getCharacterSelectOwnerFromElement(element) {
    let fiber = null;
    try {
        fiber = fiberFor(element);
    } catch (error) {
        console.error('[CharacterActivity] React fiber lookup failed:', error);
        return null;
    }

    let depth = 0;
    const candidates = [];
    const seen = new Set();

    while (fiber && depth < MAX_OWNER_DEPTH) {
        const stateNode = fiber.stateNode;
        if (
            stateNode &&
            !seen.has(stateNode) &&
            typeof stateNode.setState === 'function' &&
            REQUIRED_METHODS.every((method) => typeof stateNode[method] === 'function') &&
            hasCharacterSelectStateSignature(stateNode.state)
        ) {
            seen.add(stateNode);
            candidates.push(stateNode);
        }
        fiber = fiber.return;
        depth += 1;
    }

    if (candidates.length !== 1) return null;
    return candidates[0];
}

/**
 * Normalise a timestamp the game may send either as epoch ms or as an ISO string.
 *
 * The game's sentinel for "never been offline" is a year-1 date, which parses fine but is not a
 * fact about this character; anything before 1971 is treated as absent.
 * @param {number|string|null|undefined} value
 * @returns {number|null} Epoch ms, or null
 */
function toEpochMs(value) {
    if (value == null) return null;
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return ms;
}

/**
 * Extract the character id from a slot's native navigation link
 * (`href="/game?characterId=<id>"`), never from visible text.
 * @param {Element} linkElement
 * @returns {string|null}
 */
export function getCharacterIdFromSlotLink(linkElement) {
    const href = linkElement?.getAttribute?.('href');
    if (!href) return null;
    try {
        const url = new URL(href, window.location.origin);
        return url.searchParams.get('characterId') || null;
    } catch {
        return null;
    }
}

/**
 * Find every populated slot under `rootElement`. The empty "create character" slots share the
 * same CSS class but carry no navigation link, which is what distinguishes them.
 *
 * Fails closed on malformed or missing ids (that slot is skipped) and on a duplicate id
 * appearing in more than one slot (every slot sharing it is skipped, since which one is real is
 * ambiguous).
 * @param {Element} rootElement
 * @returns {Array<{slotElement: Element, characterId: string}>}
 */
export function findPopulatedCharacterSlots(rootElement) {
    const slots = rootElement?.querySelectorAll?.(`[class*="${SLOT_CLASS}"]`) || [];
    const slotsById = new Map();

    for (const slot of slots) {
        const link = slot.querySelector('a[href*="characterId="]');
        if (!link) continue;

        const characterId = getCharacterIdFromSlotLink(link);
        if (!characterId) continue;

        if (!slotsById.has(characterId)) slotsById.set(characterId, []);
        slotsById.get(characterId).push(slot);
    }

    const result = [];
    for (const [characterId, slotElements] of slotsById) {
        if (slotElements.length !== 1) continue;
        result.push({ slotElement: slotElements[0], characterId });
    }
    return result;
}

/**
 * Resolve every populated slot to what is known about its character.
 *
 * `character.lastOfflineTime` comes from the page's own loaded character list when the fiber
 * read succeeds, and is null when it does not — which is a real, expected outcome here, not an
 * error path. `nativeStateAvailable` says which happened, so callers can tell "this character
 * has never gone offline" from "we could not find out".
 * @param {Element} rootElement - The character-select root
 * @returns {{slots: Array<{slotElement: Element, character: Object}>, nativeStateAvailable: boolean}}
 */
export function resolveCharacterSelectSlots(rootElement) {
    const slots = findPopulatedCharacterSlots(rootElement);
    if (slots.length === 0) return { slots: [], nativeStateAvailable: false };

    const owner = getCharacterSelectOwnerFromElement(slots[0].slotElement);
    const characters = owner?.state?.characters;
    const charactersById = Array.isArray(characters)
        ? new Map(characters.filter((character) => character?.id != null).map((c) => [String(c.id), c]))
        : null;

    const resolved = [];
    for (const { slotElement, characterId } of slots) {
        const native = charactersById?.get(String(characterId));
        // A slot whose id the page's own list does not contain is excluded when that list is
        // readable at all — it means the two disagree, and guessing is worse than saying nothing.
        if (charactersById && !native) continue;

        resolved.push({
            slotElement,
            character: {
                id: characterId,
                name: native?.name ?? null,
                isOnline: native?.isOnline ?? null,
                lastOfflineTime: toEpochMs(native?.lastOfflineTime),
            },
        });
    }

    return { slots: resolved, nativeStateAvailable: charactersById !== null };
}
