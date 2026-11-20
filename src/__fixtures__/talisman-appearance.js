/**
 * The talisman icon and marker fields, as read live on the test server (main.a03e75d5, character 32030, 2026-11-20).
 * Most records have iconHrid "" (never chosen). The icon and type maps are a subset of initClientData's
 * talismanIconDetailMap (19 entries) and talismanTypeDetailMap; maxMarker is talismanInfo.maxMarker.
 */

/** characterTalismans entry with a chosen icon, as the wire sent it */
export const CHOSEN_ICON_RECORD = {
    characterID: 32030,
    iconHrid: '/talisman_icons/combat',
    id: 5550,
    lockedModifierHrid: '',
    marker: 0,
    modifiers: [{ grade: 3, hrid: '/talisman_modifiers/elemental_resistance' }],
    pendingModifiers: null,
    slotIndex: 0,
    talismanTypeHrid: '/talisman_types/combat',
};

/** The same shape with the icon never chosen (most records) */
export const NEVER_CHOSEN_RECORD = { ...CHOSEN_ICON_RECORD, id: 5551, iconHrid: '', marker: 4 };

export const APPEARANCE_GAME_DATA = {
    talismanInfo: { maxMarker: 9 },
    talismanIconDetailMap: {
        '/talisman_icons/combat': {
            hrid: '/talisman_icons/combat',
            talismanTypeHrid: '/talisman_types/combat',
            skillHrid: '',
            sortIndex: 1,
        },
        '/talisman_icons/skilling': {
            hrid: '/talisman_icons/skilling',
            talismanTypeHrid: '/talisman_types/skilling',
            skillHrid: '',
            sortIndex: 2,
        },
        '/talisman_icons/alchemy': {
            hrid: '/talisman_icons/alchemy',
            talismanTypeHrid: '/talisman_types/skilling',
            skillHrid: '/skills/alchemy',
            sortIndex: 11,
        },
    },
    talismanTypeDetailMap: {
        '/talisman_types/combat': {
            hrid: '/talisman_types/combat',
            name: 'Combat',
            defaultIconHrid: '/talisman_icons/combat',
            sortIndex: 1,
        },
        '/talisman_types/skilling': {
            hrid: '/talisman_types/skilling',
            name: 'Skilling',
            defaultIconHrid: '/talisman_icons/skilling',
            sortIndex: 2,
        },
    },
};
