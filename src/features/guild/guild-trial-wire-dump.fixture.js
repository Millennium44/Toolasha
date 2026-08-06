/**
 * Six consecutive `guild_battle_updated` messages, exactly as the game sent them.
 *
 * Captured from a live client watching a T2 Trial Chameleon through the In
 * Progress fight view — the capture that proved a trial fight is a real,
 * server-run battle and that spectating streams it. 127 messages arrived in
 * about a minute; these are the six the dump kept.
 *
 * Kept verbatim, and used verbatim: asserting against invented ticks would test
 * the invention. Note what the `pMap` entries do *not* carry — no `atkCounter`,
 * no `dmgCounter` — which is why the per-player damage split refuses to name an
 * attacker from this capture, and why the module counts the ticks that did.
 */
export const TRIAL_WIRE_DUMP = [
    {
        type: 'guild_battle_updated',
        battleId: 1,
        tier: 2,
        pMap: {
            1: {
                cHP: 2612,
                mHP: 2612,
                cMP: 2180,
                mMP: 2180,
                isActive: true,
                leftCombat: false,
            },
        },
        mMap: {},
    },
    {
        type: 'guild_battle_updated',
        battleId: 1,
        tier: 2,
        pMap: {
            1: {
                cHP: 2612,
                mHP: 2612,
                cMP: 2180,
                mMP: 2180,
                isActive: true,
                leftCombat: false,
            },
        },
        mMap: {
            0: {
                cHP: 454807,
                mHP: 618000,
                cMP: 595430,
                mMP: 600000,
                isActive: true,
                leftCombat: false,
                atkCounter: 237,
                isAutoAtk: true,
                int: 1706161137,
                dmgCounter: 301,
                critCounter: 301,
            },
        },
    },
    {
        type: 'guild_battle_updated',
        battleId: 1,
        tier: 2,
        pMap: {
            1: {
                cHP: 2577,
                mHP: 2612,
                cMP: 2180,
                mMP: 2180,
                isActive: true,
                leftCombat: false,
            },
        },
        mMap: {
            0: {
                cHP: 454807,
                mHP: 618000,
                cMP: 595430,
                mMP: 600000,
                isActive: true,
                leftCombat: false,
                atkCounter: 238,
                abilityHrid: '/abilities/penetrating_shot',
                int: 473933649,
                dmgCounter: 301,
                critCounter: 301,
            },
        },
    },
    {
        type: 'guild_battle_updated',
        battleId: 1,
        tier: 2,
        pMap: {
            1: {
                cHP: 2612,
                mHP: 2612,
                cMP: 2180,
                mMP: 2180,
                isActive: true,
                leftCombat: false,
            },
        },
        mMap: {
            0: {
                cHP: 453402,
                mHP: 618000,
                cMP: 595430,
                mMP: 600000,
                isActive: true,
                leftCombat: false,
                atkCounter: 238,
                abilityHrid: '/abilities/penetrating_shot',
                int: 473933649,
                dmgCounter: 302,
                critCounter: 302,
            },
        },
    },
    {
        type: 'guild_battle_updated',
        battleId: 1,
        tier: 2,
        pMap: {
            1: {
                cHP: 2499,
                mHP: 2612,
                cMP: 2180,
                mMP: 2180,
                isActive: true,
                leftCombat: false,
            },
        },
        mMap: {
            0: {
                cHP: 453402,
                mHP: 618000,
                cMP: 595375,
                mMP: 600000,
                isActive: true,
                leftCombat: false,
                atkCounter: 239,
                abilityHrid: '/abilities/rain_of_arrows',
                int: 473933649,
                dmgCounter: 302,
                critCounter: 302,
            },
        },
    },
    {
        type: 'guild_battle_updated',
        battleId: 1,
        tier: 2,
        pMap: {
            1: {
                cHP: 2499,
                mHP: 2612,
                cMP: 2180,
                mMP: 2180,
                isActive: true,
                leftCombat: false,
            },
        },
        mMap: {
            0: {
                cHP: 453402,
                mHP: 618000,
                cMP: 595340,
                mMP: 600000,
                isActive: true,
                leftCombat: false,
                atkCounter: 240,
                abilityHrid: '/abilities/steady_shot',
                int: 473933649,
                dmgCounter: 302,
                critCounter: 302,
            },
        },
    },
];

export default TRIAL_WIRE_DUMP;
