/**
 * Fury stacking check — the live half.
 *
 * {@link ./fury-stacking.js} decides what a reading is worth; this feeds it
 * from the wire and keeps the running tally somewhere a page refresh cannot
 * reach.
 *
 * ## Where a reading comes from
 *
 * Two messages carry a player's fully-resolved `combatDetails` next to the
 * live `combatBuffMap` that produced it:
 *
 * - `new_battle`, once per wave, for every player in the fight. This is the
 *   continuous source — Fury does not reset between the waves of one action,
 *   so an auto-fight walks through a whole range of stack counts on its own.
 * - `battle_unit_fetched`, when you click your own portrait mid-fight. Rarer,
 *   but it lands wherever you point it, which is how a specific stack count
 *   gets checked on purpose.
 *
 * Only this character's own entry is read. A party member's snapshot is a
 * perfectly good reading of *their* build, but it arrives on the same message
 * shape and mixing the two would make an audit row unattributable.
 *
 * ## Why the tally is durable and nothing else is
 *
 * Twenty discriminating readings per metric want Fury *and* another buff of the
 * same type up at once, which is a fraction of the waves in any zone. That is
 * more than one session, so counts, a reason breakdown and a few dozen audit
 * rows go to storage — a few kilobytes — and the snapshots themselves are
 * judged on arrival and dropped.
 *
 * Writes are debounced: waves land in bursts and a write per wave would be an
 * IndexedDB round trip inside a socket handler.
 *
 * ## Off by default
 *
 * It settles one argument and then has nothing left to say, like the other
 * measurements in here.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { wilsonInterval } from '../combat-sim/engine/wilson.js';
import { emptyTally, foldReading, readUnit, summarize, METRICS, MIN_READINGS, TALLY_VERSION } from './fury-stacking.js';
import { webSocketHook as sharedWebSocketHook } from '../../utils/bundle-bridge.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { captureOwner, noteTeardown, stillOurs } from '../../utils/init-ownership.js';
import { registerRow, TILE_CLASS } from '../../utils/overlay-rows.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { formatRelativeTime } from '../../utils/formatters.js';

/** Where the tally lives */
const STORAGE_KEY = 'furyStackingTally';

/** Which object store it lives in */
const STORAGE_STORE = 'settings';

/** How long a burst of waves is allowed to accumulate before a write */
const WRITE_DEBOUNCE_MS = 4000;

/** Panel accent — the same amber the other "this is a measurement" panels use */
const ACCENT = '#f0c674';

/**
 * The shared hook instance. In the multi-bundle build each library carries its
 * own copy of the websocket module and only Core's has `install` called, so a
 * listener on a bundle-local copy hears nothing at all.
 * @returns {Object} The hook
 */
function hook() {
    return sharedWebSocketHook() || webSocketHook;
}

const registry = createCleanupRegistry();

let tally = emptyTally();
let loaded = false;
let writeTimer = null;
let dirty = false;
let onNewBattle = null;
let onUnitFetched = null;

/**
 * Write the tally out, at most once per debounce window.
 * @returns {void}
 */
function scheduleWrite() {
    dirty = true;
    if (writeTimer) return;
    writeTimer = setTimeout(async () => {
        writeTimer = null;
        if (!dirty) return;
        dirty = false;
        try {
            if (storage.isQuotaExceeded?.()) return;
            await storage.set(STORAGE_KEY, tally, STORAGE_STORE);
        } catch (error) {
            console.error('[FuryStacking] Could not save the tally:', error);
        }
    }, WRITE_DEBOUNCE_MS);
    registry.registerTimeout(writeTimer, 'fury-stacking:write');
}

/**
 * Whether a unit snapshot is this character's own.
 *
 * A party member's sheet rides the identical message shape with `isPlayer:
 * true` set, and folding it in would tally someone else's gear under our audit
 * rows. A payload naming nobody (an older or trimmed shape) is left passing
 * rather than dropped, matching what the stat-check panel does.
 *
 * @param {Object} unit - A player unit entry
 * @returns {boolean} Whether it is us
 */
function isOwnPlayer(unit) {
    const owner = unit?.character?.id;
    if (owner == null) return true;
    return String(owner) === String(dataManager.getCurrentCharacterId?.());
}

/**
 * Judge one snapshot and fold it in.
 * @param {Object} unit - A player unit with `combatDetails` and `combatBuffMap`
 * @returns {void}
 */
function record(unit) {
    if (!unit?.combatDetails) return;
    if (!isOwnPlayer(unit)) return;
    const readings = readUnit(unit);
    foldReading(tally, readings, Date.now());
    scheduleWrite();
}

const furyStacking = {
    /**
     * The tally as it stands, for the panel and for tests.
     * @returns {Object} Tally
     */
    tally() {
        return tally;
    },

    /**
     * The tally read as an answer.
     * @returns {Object} Summary
     */
    summary() {
        return summarize(tally, wilsonInterval);
    },

    /** @returns {boolean} Whether the stored tally has been read back yet */
    ready() {
        return loaded;
    },

    /**
     * Throw the sample away and start again — for when the game changes under
     * it, which is the only reason a measurement like this is ever wrong in a
     * way more data cannot fix.
     * @returns {Promise<void>} Resolves once the empty tally is stored
     */
    async forget() {
        tally = emptyTally();
        try {
            await storage.set(STORAGE_KEY, tally, STORAGE_STORE);
        } catch (error) {
            console.error('[FuryStacking] Could not clear the tally:', error);
        }
    },

    name: 'Fury Stacking',

    /**
     * Start watching. Does nothing at all unless the setting is on.
     * @returns {Promise<void>} Resolves once the stored tally is back
     */
    initialize: async () => {
        if (!config.getSetting('furyStackingWatch')) return;

        // A character switch tears this down while the read below is in flight,
        // and a tail that resumed afterwards would hook the websocket for a
        // character that is no longer here, with nothing left holding the
        // handles that would take it off again
        const ticket = captureOwner(furyStacking);

        try {
            const stored = await storage.get(STORAGE_KEY, STORAGE_STORE, null);
            if (!stillOurs(ticket)) return;
            // A tally in an older shape is dropped rather than merged: the
            // shape before this one could not tell "Fury never up" from "Fury
            // never found", so its counts are not evidence of either
            if (stored && stored.version === TALLY_VERSION) tally = stored;
        } catch (error) {
            console.error('[FuryStacking] Could not read the tally back:', error);
        }
        if (!stillOurs(ticket)) return;
        loaded = true;

        onNewBattle = (data) => {
            try {
                const players = Array.isArray(data?.players) ? data.players : Object.values(data?.players || {});
                for (const player of players) record(player);
            } catch (error) {
                console.error('[FuryStacking] new_battle failed:', error);
            }
        };
        onUnitFetched = (data) => {
            try {
                const unit = data?.unit;
                if (unit?.isPlayer) record(unit);
            } catch (error) {
                console.error('[FuryStacking] battle_unit_fetched failed:', error);
            }
        };

        hook().on('new_battle', onNewBattle);
        hook().on('battle_unit_fetched', onUnitFetched);
        registry.registerCleanup(() => {
            if (onNewBattle) hook().off('new_battle', onNewBattle);
            if (onUnitFetched) hook().off('battle_unit_fetched', onUnitFetched);
            onNewBattle = null;
            onUnitFetched = null;
        });
    },

    /**
     * Stop watching, and do not lose the last few seconds on the way out.
     * @returns {void}
     */
    cleanup: () => {
        noteTeardown(furyStacking);
        registry.cleanupAll();
        writeTimer = null;
        if (dirty) {
            dirty = false;
            storage.set(STORAGE_KEY, tally, STORAGE_STORE).catch((error) => {
                console.error('[FuryStacking] Could not save the tally on teardown:', error);
            });
        }
    },
};

/**
 * One metric's block in the panel.
 * @param {HTMLElement} body - Panel body
 * @param {string} title - Heading
 * @param {Object} metric - One metric summary
 * @returns {void}
 */
function drawMetric(body, title, metric) {
    const card = panelCard(body, title, ACCENT);
    card.appendChild(panelNote(metric.verdict.text));

    card.appendChild(
        panelLine(
            'Discriminating readings',
            `${metric.discriminating} of ${metric.readings}`,
            metric.discriminating >= MIN_READINGS ? ACCENT : '#9aa4bb',
            'Only a reading with Fury up AND another buff of the same type up can tell the two models apart — ' +
                'the formulas are identical whenever either term is zero. The rest are counted below, not here.'
        )
    );

    if (metric.discriminating) {
        card.appendChild(panelLine('  matched multiplicative', String(metric.multiplicative), ACCENT));
        card.appendChild(panelLine('  matched additive', String(metric.additive), ACCENT));
        card.appendChild(
            panelLine(
                '  matched neither',
                String(metric.neither),
                metric.neither ? '#e56b6b' : '#9aa4bb',
                'Both models wrong. Either the expression has a term neither side of the argument writes down, ' +
                    'or one of this check’s inputs (level, gear ratio) is not what it is assumed to be.'
            )
        );
        card.appendChild(
            panelLine(
                '  styles disagreed',
                String(metric.mixed),
                metric.mixed ? '#e56b6b' : '#9aa4bb',
                'One snapshot where some styles said multiplicative and others did not — impossible for a single ' +
                    'formula, so it points at a per-style term instead.'
            )
        );
    }

    card.appendChild(panelLine(`Non-discriminating (${metric.nonDiscriminating})`, '', '#9aa4bb'));
    for (const row of metric.reasons) {
        if (!row.count) continue;
        card.appendChild(panelLine(`  ${row.label}`, String(row.count), '#9aa4bb'));
    }

    const useful = metric.styles.filter((style) => style.discriminating);
    if (useful.length) {
        card.appendChild(panelLine('Per style (discriminating)', '', '#9aa4bb'));
        for (const style of useful) {
            card.appendChild(
                panelLine(
                    `  ${style.style}`,
                    `${style.multiplicative}× / ${style.additive}+ / ${style.neither}✗ of ${style.discriminating}`,
                    '#9aa4bb',
                    'multiplicative / additive / neither. Styles share one snapshot’s buffs, so these are a ' +
                        'breakdown of the readings above, not extra readings.'
                )
            );
        }
    }
}

export const furyStackingPanel = createPanel({
    id: 'furyStacking',
    title: 'Fury Stacking',
    size: { width: 460, height: 500 },
    accent: ACCENT,
    refreshMs: 3000,
    draw: (body) => {
        if (!config.getSetting('furyStackingWatch')) {
            body.appendChild(panelNote('The Fury stacking check is switched off in settings.'));
            return;
        }

        body.appendChild(
            panelNote(
                'Is Fury its own factor on top of the other buffs — base × (1 + d) × (1 + f) — or pooled with ' +
                    'them — base × (1 + d + f)? Every snapshot of your own resolved stats is checked against both, ' +
                    'using the game’s own levels and gear ratios as the base, so nothing here depends on the sim.'
            )
        );

        const summary = furyStacking.summary();

        // Ahead of every count, because a count from a check that is not
        // finding Fury is not a small number — it is not a number
        body.appendChild(
            panelLine(
                'Fury sightings',
                `${summary.observed.withFury} of ${summary.observed.units} snapshots`,
                summary.health.ok ? ACCENT : '#e56b6b',
                summary.health.text
            )
        );
        if (!summary.health.ok) body.appendChild(panelNote(summary.health.text));

        if (summary.updatedAt) {
            body.appendChild(panelLine('Last reading', formatRelativeTime(Date.now() - summary.updatedAt), '#9aa4bb'));
        }

        drawMetric(body, 'Accuracy rating', summary.metrics.accuracy);
        drawMetric(body, 'Max damage', summary.metrics.damage);

        const audit = panelCard(body, 'Recent discriminating readings', ACCENT);
        const rows = (summary.audit || []).slice(0, 8);
        if (!rows.length) audit.appendChild(panelNote('None yet.'));
        for (const row of rows) {
            const label = `${row.metric} · ${row.style}${row.bulwark ? ' (bulwark base)' : ''}`;
            audit.appendChild(
                panelLine(
                    `${label} → ${row.outcome}`,
                    `game ${row.game} · ×${row.multiplicative} · +${row.additive}`,
                    row.outcome === 'multiplicative' || row.outcome === 'additive' ? ACCENT : '#e56b6b',
                    `d ${row.other}, f ${row.fury}, predicted gap ${row.gap}; error multiplicative ` +
                        `${row.errorMultiplicative}, error additive ${row.errorAdditive}; ` +
                        `${row.styleCount} style(s) discriminated in that snapshot.`
                )
            );
        }

        const reset = document.createElement('button');
        reset.textContent = 'Forget the sample';
        Object.assign(reset.style, {
            background: 'none',
            border: '1px solid #9aa4bb',
            borderRadius: '4px',
            color: '#9aa4bb',
            padding: '5px 10px',
            marginTop: '8px',
            cursor: 'pointer',
        });
        reset.addEventListener('click', async () => {
            await furyStacking.forget();
            furyStackingPanel.render();
        });
        body.appendChild(reset);
    },
});

registerRow({
    key: 'furyStacking',
    name: 'Fury Stacking',
    empty: 'No discriminating readings yet',
    defaultVisible: false,
    defaultSize: { width: 250, height: 30 },
    tileClass: TILE_CLASS.MEASUREMENT,
    onOpen: () => furyStackingPanel.toggle(),
    render: (container) => {
        container.replaceChildren();
        if (!config.getSetting('furyStackingWatch')) return;

        const summary = furyStacking.summary();
        const total = METRICS.reduce((sum, metric) => sum + summary.metrics[metric].discriminating, 0);
        // A broken check is worth a row of its own: with no Fury ever found
        // there will never be a discriminating reading to draw one
        if (!total && summary.health.ok) return;

        Object.assign(container.style, { display: 'flex', justifyContent: 'space-between', gap: '10px' });

        const label = document.createElement('span');
        label.textContent = 'Fury stacking';

        const decided = METRICS.filter((metric) => summary.metrics[metric].verdict.decided);
        const value = document.createElement('span');
        if (!summary.health.ok) value.textContent = 'not finding Fury';
        else if (decided.length)
            value.textContent = `${summary.metrics[decided[0]].fraction > 0.5 ? 'multiplicative' : 'additive'} (${total})`;
        else value.textContent = `${total} discriminating`;
        if (!summary.health.ok) value.style.color = '#e56b6b';
        else value.style.color = decided.length ? ACCENT : '#9aa4bb';
        value.style.whiteSpace = 'nowrap';

        container.append(label, value);
        container.title = summary.health.ok
            ? 'Double-click for the per-metric verdicts, the split and the audit rows.'
            : summary.health.text;
    },
});

export default furyStacking;
