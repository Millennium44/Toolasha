/**
 * Mana tracker
 *
 * What your abilities are costing you, per fight.
 *
 * Mana is the constraint nobody watches. Damage is in the combat log; mana is
 * visible only as the moment an ability does not fire, and by then the fight has
 * already gone differently. The figure worth having is per fight rather than the
 * running total, because a total only says how long you have been playing.
 *
 * ## The game says what was cast, not what it cost
 *
 * `battle_consumable_ability_updated` announces a cast. The cost comes from
 * `abilityDetailMap[hrid].manaCost`, so a cast is a message and its mana is a
 * lookup. An ability the game has never described contributes casts and no mana,
 * and the summary says so rather than reporting a short total as a measurement.
 *
 * The arithmetic is in `utils/mana-spend.js` with tests. This module subscribes,
 * looks costs up, and draws one line.
 *
 * The model is MAna's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS, glyph } from '../../utils/overlay-format.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { newManaTally, recordCast, recordFight, manaSummary } from '../../utils/mana-spend.js';

/**
 * The running tally, at module scope so the row can read it.
 *
 * Kept across the feature being disabled and re-enabled: a mana figure is only
 * useful over a run, and throwing it away on a settings change would make it
 * impossible to measure a long one.
 */
let tally = newManaTally();

/** Start the count again from here */
export function resetManaTally() {
    tally = newManaTally();
}

/** @returns {Object} From `manaSummary` */
export function manaSpend() {
    return manaSummary(tally);
}

/**
 * An ability's readable name.
 * @param {string} abilityHrid - The ability
 * @returns {string}
 */
export function abilityLabel(abilityHrid) {
    const detail = dataManager.getInitClientData?.()?.abilityDetailMap?.[abilityHrid];
    if (detail?.name) return detail.name;

    return String(abilityHrid || '')
        .split('/')
        .pop()
        .replace(/_/g, ' ');
}

/**
 * @param {string} abilityHrid - The ability
 * @returns {number} Its mana cost, or 0 when the game has not said
 */
function manaCostOf(abilityHrid) {
    return dataManager.getInitClientData?.()?.abilityDetailMap?.[abilityHrid]?.manaCost || 0;
}

let onNewBattle = null;
let onAbility = null;

export default {
    name: 'Mana Tracker',
    initialize: () => {
        onNewBattle = () => recordFight(tally);
        onAbility = (data) => {
            // The message carries either the ability object or its hrid, and
            // both shapes have been seen in the wild
            const abilityHrid = data?.ability?.abilityHrid || data?.ability;
            if (typeof abilityHrid !== 'string') return;
            recordCast(tally, abilityHrid, manaCostOf(abilityHrid));
        };

        webSocketHook.on('new_battle', onNewBattle);
        webSocketHook.on('battle_consumable_ability_updated', onAbility);
    },
    cleanup: () => {
        if (onNewBattle) webSocketHook.off('new_battle', onNewBattle);
        if (onAbility) webSocketHook.off('battle_consumable_ability_updated', onAbility);
        onNewBattle = null;
        onAbility = null;
    },
};

/**
 * What the run has cost in mana, ability by ability.
 *
 * The tile carries one figure; the question behind it is which ability is
 * spending it, because that is the one a rotation change moves.
 */
export const manaPanel = createPanel({
    id: 'manaPanel',
    title: 'Mana',
    size: { width: 380, height: 320 },
    accent: '#8fd6ff',
    draw: (body) => {
        const summary = manaSpend();

        const run = panelCard(body, 'This run', '#8fd6ff');
        run.append(
            panelLine('Fights', formatWithSeparator(summary.fights)),
            panelLine('Mana spent', formatWithSeparator(Math.round(summary.mana)), ROW_COLORS.accent),
            panelLine(
                'Per fight',
                summary.manaPerFight === null ? 'measuring…' : formatWithSeparator(Math.round(summary.manaPerFight)),
                summary.manaPerFight === null ? 'rgba(232, 236, 245, 0.5)' : ROW_COLORS.accent
            ),
            panelLine('Casts per fight', summary.castsPerFight === null ? '—' : summary.castsPerFight.toFixed(2))
        );

        const reset = document.createElement('button');
        reset.textContent = 'Reset';
        reset.dataset.resetMana = 'true';
        Object.assign(reset.style, {
            background: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid rgba(255, 255, 255, 0.10)',
            borderRadius: '3px',
            color: '#e8ecf5',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 10px',
            marginTop: '4px',
            alignSelf: 'flex-start',
        });
        reset.addEventListener('click', () => {
            resetManaTally();
            manaPanel.render();
        });
        run.appendChild(reset);

        if (!summary.abilities.length) {
            body.appendChild(panelNote('Nothing cast yet. Mana is counted from the game announcing a cast.'));
            return;
        }

        const byAbility = panelCard(body, 'Where it goes', '#8fd6ff');
        for (const ability of summary.abilities) {
            const share = summary.mana > 0 ? (ability.mana / summary.mana) * 100 : 0;
            byAbility.appendChild(
                panelLine(
                    abilityLabel(ability.abilityHrid),
                    `${formatWithSeparator(Math.round(ability.mana))}  ·  ${share.toFixed(0)}%`,
                    ability.unknownCost ? ROW_COLORS.bad : ROW_COLORS.gold,
                    ability.unknownCost
                        ? 'The game states no mana cost for this ability, so its casts are counted and its mana is not.'
                        : `${formatWithSeparator(ability.casts)} casts` +
                              (ability.perFight === null ? '' : `, ${ability.perFight.toFixed(2)} per fight`)
                )
            );
        }

        if (summary.incomplete) {
            body.appendChild(
                panelNote(
                    'Some abilities have no stated mana cost, so the total is a lower bound rather than a figure.'
                )
            );
        }
    },
});

registerRow({
    key: 'manaPerFight',
    empty: 'No casts yet',
    name: 'Mana/fight',
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        const summary = manaSpend();
        // Nothing rather than a zero: no fights recorded is not a mana cost of
        // nothing, it is not having watched a fight yet
        if (summary.manaPerFight === null) return blank(container);

        row(container, [
            glyph('mana'),
            { text: `${formatWithSeparator(Math.round(summary.manaPerFight))}/fight`, color: ROW_COLORS.accent },
            { text: `${summary.castsPerFight.toFixed(1)} casts`, color: ROW_COLORS.dim, push: true },
            summary.incomplete ? { text: '⚠', color: ROW_COLORS.bad } : null,
        ]);

        const worst = summary.abilities[0];
        container.title =
            `${formatWithSeparator(Math.round(summary.mana))} mana over ${summary.fights} fights.` +
            (worst ? `\nMost of it on ${abilityLabel(worst.abilityHrid)}.` : '') +
            (summary.incomplete ? '\nSome abilities have no stated mana cost, so the total is a lower bound.' : '') +
            '\nDouble-click for the breakdown by ability.';
    },
    onOpen: () => manaPanel.toggle(),
});
