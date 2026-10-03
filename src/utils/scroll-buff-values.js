/**
 * Scroll Buff Values
 * Hardcoded buff definitions for Labyrinth scrolls (formerly "Seals").
 * Numeric values follow the game's personalBuffTypeDetailMap. Scroll items have no
 * consumableDetail, so the item mapping is kept separately.
 */

export const SCROLL_BUFF_VALUES = {
    '/buff_types/efficiency': 0.14,
    '/buff_types/gathering': 0.18,
    '/buff_types/wisdom': 0.2,
    '/buff_types/action_speed': 0.15,
    '/buff_types/rare_find': 0.6,
    '/buff_types/processing': 0.2,
    '/buff_types/gourmet': 0.1,
};

export const SCROLL_BUFF_ITEMS = {
    '/buff_types/efficiency': 'seal_of_efficiency',
    '/buff_types/gathering': 'seal_of_gathering',
    '/buff_types/wisdom': 'seal_of_wisdom',
    '/buff_types/action_speed': 'seal_of_action_speed',
    '/buff_types/rare_find': 'seal_of_rare_find',
    '/buff_types/processing': 'seal_of_processing',
    '/buff_types/gourmet': 'seal_of_gourmet',
};

export const SCROLL_BUFF_LABELS = {
    '/buff_types/efficiency': 'Scroll of Efficiency (+14%)',
    '/buff_types/gathering': 'Scroll of Gathering (+18%)',
    '/buff_types/wisdom': 'Scroll of Wisdom (+20%)',
    '/buff_types/action_speed': 'Scroll of Action Speed (+15%)',
    '/buff_types/rare_find': 'Scroll of Rare Find (+60%)',
    '/buff_types/processing': 'Scroll of Processing (+20%)',
    '/buff_types/gourmet': 'Scroll of Gourmet (+10%)',
};

/** Display order of the scroll buff types, shared by the popup and the action-panel chips */
export const SCROLL_BUFF_ORDER = [
    '/buff_types/efficiency',
    '/buff_types/gathering',
    '/buff_types/wisdom',
    '/buff_types/action_speed',
    '/buff_types/rare_find',
    '/buff_types/processing',
    '/buff_types/gourmet',
];

/**
 * Fired on `document` after a scroll selection is saved, so every reader that drew one
 * (an open popup, the quick-input speed/XP figures) can redraw. `detail.key` is the
 * selection that changed (a loadout name or `__default__`).
 */
export const SELECTION_CHANGED_EVENT = 'toolasha:scroll-selection-changed';
