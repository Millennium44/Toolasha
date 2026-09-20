/**
 * Tick period observer — the live half.
 *
 * {@link ./tick-period.js} decides what a periodic tick is and what a sample of
 * intervals means; this hooks the battle stream, keeps the running tally
 * somewhere a reload cannot reach, and draws it.
 *
 * ## Why the tally is durable and the ticks are not
 *
 * Four periods, one of them a minute long, is hours of fighting. What lands in
 * storage is counts, a bounded list of raw intervals and the discard reasons —
 * tens of kilobytes that survive a reload, not a transcript that does not.
 * Writes are debounced, because a regeneration tick every ten seconds across a
 * party is more IndexedDB round trips than the answer is worth.
 *
 * ## Off by default
 *
 * It settles four arguments about four constants and then has nothing left to
 * say, like the other measurement switches here.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import {
    createTickPeriodWatch,
    emptyTally,
    foldHpFall,
    foldObservation,
    foldRejection,
    summarize,
    EFFECTS,
} from './tick-period.js';
import { createArrivalCalibration, foldJitter } from './wave-gap.js';
import { webSocketHook as sharedWebSocketHook } from '../../utils/bundle-bridge.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { captureOwner, noteTeardown, stillOurs } from '../../utils/init-ownership.js';
import { registerRow, TILE_CLASS } from '../../utils/overlay-rows.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { formatRelativeTime } from '../../utils/formatters.js';

/** Where the tally lives */
const STORAGE_KEY = 'tickPeriodTally';

/** Which object store it lives in */
const STORAGE_STORE = 'settings';

/** How long a burst of intervals accumulates before a write */
const WRITE_DEBOUNCE_MS = 4000;

/** Panel accent — the amber the other "this is a measurement" panels use */
const ACCENT = '#f0c674';

/** What each verdict state is drawn in */
const STATE_COLORS = {
    consistent: '#8ec07c',
    differs: '#f2777a',
    settled: '#8ec07c',
    provisional: ACCENT,
    unresolved: '#9aa4bb',
    empty: '#9aa4bb',
};

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

let watch = null;
let calibration = null;
let tally = emptyTally();
let loaded = false;
let writeTimer = null;
let dirty = false;
let onNewBattle = null;
let onBattleUpdated = null;

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
            console.error('[TickPeriod] Could not save the tally:', error);
        }
    }, WRITE_DEBOUNCE_MS);
    registry.registerTimeout(writeTimer, 'tick-period:write');
}

/**
 * Take whatever the watch has finished and fold it in.
 * @returns {void}
 */
function collect() {
    const drained = watch?.drain();
    if (!drained) return;
    const { observations, rejections, hpFalls } = drained;
    if (!observations.length && !rejections.length && !hpFalls.length) return;
    for (const observation of observations) foldObservation(tally, observation);
    for (const rejection of rejections) foldRejection(tally, rejection.effect, rejection.reason);
    for (const attributed of hpFalls) foldHpFall(tally, attributed);
    scheduleWrite();
}

const tickPeriod = {
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
        return summarize(tally);
    },

    /** @returns {boolean} Whether the stored tally has been read back yet */
    ready() {
        return loaded;
    },

    /**
     * Throw the sample away and start again — for when the game changes under
     * it, which is the only way a measurement like this goes wrong in a way
     * more data cannot fix.
     * @returns {Promise<void>} Resolves once the empty tally is stored
     */
    async forget() {
        tally = emptyTally();
        try {
            await storage.set(STORAGE_KEY, tally, STORAGE_STORE);
        } catch (error) {
            console.error('[TickPeriod] Could not clear the tally:', error);
        }
    },

    name: 'Tick Period',

    /**
     * Start watching. Does nothing at all unless the setting is on.
     * @returns {Promise<void>} Resolves once the stored tally is back
     */
    initialize: async () => {
        if (!config.getSetting('tickPeriodWatch')) return;

        // A character switch tears this down while the read below is in flight,
        // and a tail that resumed afterwards would hook the websocket for a
        // character no longer here, with nothing left holding the handles that
        // would take it off again
        const ticket = captureOwner(tickPeriod);

        try {
            const stored = await storage.get(STORAGE_KEY, STORAGE_STORE, null);
            if (!stillOurs(ticket)) return;
            if (stored && stored.version === 1) tally = stored;
        } catch (error) {
            console.error('[TickPeriod] Could not read the tally back:', error);
        }
        if (!stillOurs(ticket)) return;
        loaded = true;

        watch = createTickPeriodWatch();
        calibration = createArrivalCalibration();

        onNewBattle = () => {
            try {
                watch.newBattle();
                calibration.reset();
                collect();
            } catch (error) {
                console.error('[TickPeriod] new_battle failed:', error);
            }
        };
        onBattleUpdated = (data) => {
            try {
                const at = Date.now();
                watch.battleUpdated(data, at, {
                    hidden: typeof document !== 'undefined' && document.hidden === true,
                });
                for (const residual of calibration.residualsFor(data?.pMap, at)) foldJitter(tally, residual);
                collect();
            } catch (error) {
                console.error('[TickPeriod] battle_updated failed:', error);
            }
        };

        hook().on('new_battle', onNewBattle);
        hook().on('battle_updated', onBattleUpdated);
        registry.registerCleanup(() => {
            if (onNewBattle) hook().off('new_battle', onNewBattle);
            if (onBattleUpdated) hook().off('battle_updated', onBattleUpdated);
            onNewBattle = null;
            onBattleUpdated = null;
        });
    },

    /**
     * Stop watching, and do not lose the last few seconds on the way out.
     * @returns {void}
     */
    cleanup: () => {
        noteTeardown(tickPeriod);
        registry.cleanupAll();
        writeTimer = null;
        if (dirty) {
            dirty = false;
            storage.set(STORAGE_KEY, tally, STORAGE_STORE).catch((error) => {
                console.error('[TickPeriod] Could not save the tally on teardown:', error);
            });
        }
        watch = null;
        calibration = null;
    },
};

/**
 * Seconds, to the millisecond, because every one of these constants is quoted
 * in whole or near-whole seconds and the argument is about the milliseconds.
 * @param {number} ms - Milliseconds
 * @returns {string} Text
 */
function seconds(ms) {
    return `${(ms / 1000).toFixed(3)} s`;
}

/**
 * One effect's block.
 * @param {HTMLElement} body - Panel body
 * @param {Object} effect - An effect summary
 * @returns {void}
 */
function drawEffect(body, effect) {
    const card = panelCard(body, effect.label, ACCENT);
    card.appendChild(panelNote(effect.signature));
    card.appendChild(panelLine('Engine assumes', seconds(effect.assumedMs), '#e8ecf5'));
    card.appendChild(panelLine('Verdict', effect.text, STATE_COLORS[effect.state] || '#e8ecf5'));

    if (!effect.cluster) {
        card.appendChild(panelLine('Intervals', '0', '#9aa4bb'));
    } else {
        card.appendChild(
            panelLine(
                'Measured',
                `${seconds(effect.cluster.median)} ± ${effect.band === null ? '—' : `${effect.band.toFixed(0)} ms`}`,
                STATE_COLORS[effect.state] || '#e8ecf5',
                `The densest cluster of intervals: ${effect.cluster.n} of ${effect.kept} kept, spread ` +
                    `${effect.cluster.sd.toFixed(1)} ms. The band is the 95% interval on the cluster median, so ` +
                    'a real difference larger than it would have been visible in this sample.'
            )
        );
        card.appendChild(
            panelLine(
                'Whole multiples',
                `2× ${effect.echo.x2} · 3× ${effect.echo.x3} · elsewhere ${effect.echo.other}`,
                '#9aa4bb',
                'A tick with nothing to add is never sent, so a missed one shows up as a double interval. ' +
                    'Clean multiples are corroboration; a large "elsewhere" means the sample is contaminated ' +
                    'and the cluster is not the only thing in it.'
            )
        );
    }

    if (effect.key === EFFECTS.regen && effect.simultaneous) {
        card.appendChild(
            panelLine(
                'Shared with other units',
                `${effect.simultaneous} of ${effect.kept}`,
                '#9aa4bb',
                'Regeneration should land on everyone at once. Intervals whose tick also moved another unit ' +
                    'are the ones that most look like a schedule rather than a coincidence.'
            )
        );
    }

    if (effect.rejected) {
        card.appendChild(panelLine(`Discarded candidates (${effect.rejected})`, '', '#9aa4bb'));
        for (const row of effect.rejections) {
            card.appendChild(panelLine(`  ${row.label}`, String(row.count), '#9aa4bb'));
        }
    }
}

export const tickPeriodPanel = createPanel({
    id: 'tickPeriod',
    title: 'Tick Period',
    size: { width: 480, height: 560 },
    accent: ACCENT,
    refreshMs: 3000,
    draw: (body) => {
        if (!config.getSetting('tickPeriodWatch')) {
            body.appendChild(panelNote('The tick period observer is switched off in settings.'));
            return;
        }

        body.appendChild(
            panelNote(
                'How often the game actually fires its repeating effects. The simulator advances four of them ' +
                    'on four inherited constants that nobody here has ever checked; this is our own measurement ' +
                    'of each, off the live battle stream.'
            )
        );

        const summary = tickPeriod.summary();

        const verdict = panelCard(body, 'Verdict', ACCENT);
        verdict.appendChild(panelNote(summary.verdict));
        if (summary.updatedAt) {
            verdict.appendChild(panelLine('Last interval', formatRelativeTime(Date.now() - summary.updatedAt)));
        }

        const ruler = panelCard(body, 'How good the ruler is', ACCENT);
        ruler.appendChild(
            panelNote(
                'Both ends of an interval are client arrival times, so every reading carries network jitter. ' +
                    "This is that jitter, measured rather than assumed: each player delta states the server's " +
                    "own delay to that player's next action, and the arrival gap between two of one player's " +
                    'consecutive actions minus that stated delay is a sample of the same noise.'
            )
        );
        if (summary.jitter.sd === null) {
            ruler.appendChild(panelNote('No calibration pairs yet.'));
        } else {
            ruler.appendChild(panelLine('Calibration pairs', `${summary.jitter.n} kept of ${summary.jitter.seen}`));
            ruler.appendChild(
                panelLine(
                    'Arrival noise (robust sd)',
                    `${summary.jitter.sd.toFixed(1)} ms, median offset ${summary.jitter.median.toFixed(1)} ms`,
                    ACCENT,
                    'Against a period of seconds this is a fraction of a percent of one reading, so these ' +
                        'periods are limited by how many were seen, not by how well each was timed.'
                )
            );
        }

        const falls = panelCard(body, 'Where the health falls went', ACCENT);
        falls.appendChild(
            panelNote(
                'Damage over time has no signature of its own — it is a health fall with no swing behind it. ' +
                    'A run made to settle that — a fire mage, damage over time landing throughout — gave 539 ' +
                    'falls, all 539 attributed and none unattributed. So a tick raises the damage counter just ' +
                    'as a hit does, and the effect is not measurable from this stream rather than absent from ' +
                    'the game. These are the same counts from your own fighting.'
            )
        );
        falls.appendChild(panelLine('Attributed to a swing', String(summary.hpFalls.attributed), '#9aa4bb'));
        falls.appendChild(
            panelLine(
                'Nothing behind them',
                String(summary.hpFalls.unattributed),
                summary.hpFalls.unattributed ? ACCENT : '#9aa4bb'
            )
        );

        for (const effect of summary.effects) drawEffect(body, effect);

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
            await tickPeriod.forget();
            tickPeriodPanel.render();
        });
        body.appendChild(reset);
    },
});

registerRow({
    key: 'tickPeriod',
    name: 'Tick Period',
    empty: 'No tick intervals yet',
    defaultVisible: false,
    defaultSize: { width: 250, height: 30 },
    tileClass: TILE_CLASS.MEASUREMENT,
    onOpen: () => tickPeriodPanel.toggle(),
    render: (container) => {
        container.replaceChildren();
        if (!config.getSetting('tickPeriodWatch')) return;

        const summary = tickPeriod.summary();
        const resolved = summary.effects.filter(
            (effect) => effect.state === 'consistent' || effect.state === 'differs'
        );
        const seen = summary.effects.reduce((sum, effect) => sum + effect.kept, 0);
        if (!seen) return;

        Object.assign(container.style, { display: 'flex', justifyContent: 'space-between', gap: '10px' });

        const label = document.createElement('span');
        label.textContent = 'Tick period';

        const differing = resolved.filter((effect) => effect.state === 'differs').length;
        const value = document.createElement('span');
        value.textContent = `${resolved.length}/${summary.effects.length} resolved${differing ? `, ${differing} off` : ''}`;
        value.style.color = differing ? STATE_COLORS.differs : resolved.length ? STATE_COLORS.consistent : '#9aa4bb';
        value.style.whiteSpace = 'nowrap';

        container.append(label, value);
        container.title =
            'Double-click for each period, what it was measured against and what could not be told apart.';
    },
});

export default tickPeriod;
