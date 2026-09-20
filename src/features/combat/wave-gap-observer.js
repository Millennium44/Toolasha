/**
 * Wave gap observer — the live half.
 *
 * {@link ./wave-gap.js} decides what a wave gap is and what a sample of them
 * means; this hooks the battle stream, supplies the zone context the arithmetic
 * cannot read for itself, and keeps the running tally somewhere a reload cannot
 * reach.
 *
 * ## Why the tally is durable and the ticks are not
 *
 * A useful sample is hundreds of wave transitions, which is hours of fighting,
 * and the combat recorder rotates its raw ticks away long before that. So
 * nothing here depends on a tick still existing: a transition is judged the
 * moment the next wave opens, and what lands in storage is counts, a ten
 * millisecond histogram and a bounded list of raw intervals — tens of kilobytes
 * that survive a reload, not a transcript that does not.
 *
 * Writes are debounced. A dungeon closes a wave every few seconds and a write
 * per wave would be an IndexedDB round trip inside a tick handler.
 *
 * ## Off by default
 *
 * It settles one argument about one constant and then has nothing left to say,
 * like the other measurement switches here.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import {
    createWaveGapWatch,
    emptyTally,
    foldDiscard,
    foldJitter,
    foldObservation,
    summarize,
    CATEGORIES,
    CATEGORY_LABELS,
    CYCLE_BINS,
    MIN_OBSERVATIONS,
    MIN_PER_BIN,
} from './wave-gap.js';
import { webSocketHook as sharedWebSocketHook } from '../../utils/bundle-bridge.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { runningCombatAction } from '../../utils/combat-actions.js';
import { captureOwner, noteTeardown, stillOurs } from '../../utils/init-ownership.js';
import { registerRow, TILE_CLASS } from '../../utils/overlay-rows.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { formatRelativeTime } from '../../utils/formatters.js';

/** Where the tally lives */
const STORAGE_KEY = 'waveGapTally';

/** Which object store it lives in */
const STORAGE_STORE = 'settings';

/** How long a burst of closed transitions accumulates before a write */
const WRITE_DEBOUNCE_MS = 4000;

/** Panel accent — the amber the other "this is a measurement" panels use */
const ACCENT = '#f0c674';

/** Widest histogram bar, in characters */
const BAR_WIDTH = 24;

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
let tally = emptyTally();
let loaded = false;
let writeTimer = null;
let dirty = false;
let onNewBattle = null;
let onBattleUpdated = null;

/**
 * Which zone the running fight belongs to, and whether it is a dungeon.
 *
 * Read off the *running* action rather than the front of the queue: a requeued
 * repeat sits first in the array with a higher ordinal, and taking it would
 * label a dungeon's waves with a queued open zone's key — which is the exact
 * mislabelling that would pool the two categories this measurement exists to
 * keep apart.
 *
 * @param {Object} data - `new_battle` payload, which carries the wave number
 * @returns {Object} Context for the watch
 */
function contextFor(data) {
    const action = runningCombatAction(dataManager.getCurrentActions() || []);
    const zoneInfo = action ? dataManager.getActionDetails(action.actionHrid)?.combatZoneInfo : null;
    return {
        zoneKey: action ? `${action.actionHrid}:${action.difficultyTier ?? ''}` : null,
        isDungeon: zoneInfo?.isDungeon === true,
        wave: Number(data?.wave) || 0,
        hidden: typeof document !== 'undefined' && document.hidden === true,
    };
}

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
            console.error('[WaveGap] Could not save the tally:', error);
        }
    }, WRITE_DEBOUNCE_MS);
    registry.registerTimeout(writeTimer, 'wave-gap:write');
}

/**
 * Take whatever the watch has finished and fold it in.
 * @returns {void}
 */
function collect() {
    const { observations, discards, jitter } = watch?.drain() || { observations: [], discards: [], jitter: [] };
    if (!observations.length && !discards.length && !jitter.length) return;
    for (const observation of observations) foldObservation(tally, observation);
    for (const reason of discards) foldDiscard(tally, reason);
    for (const residual of jitter) foldJitter(tally, residual);
    scheduleWrite();
}

const waveGap = {
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
            console.error('[WaveGap] Could not clear the tally:', error);
        }
    },

    name: 'Wave Gap',

    /**
     * Start watching. Does nothing at all unless the setting is on.
     * @returns {Promise<void>} Resolves once the stored tally is back
     */
    initialize: async () => {
        if (!config.getSetting('waveGapWatch')) return;

        // A character switch tears this down while the read below is in flight,
        // and a tail that resumed afterwards would hook the websocket for a
        // character no longer here, with nothing left holding the handles that
        // would take it off again
        const ticket = captureOwner(waveGap);

        try {
            const stored = await storage.get(STORAGE_KEY, STORAGE_STORE, null);
            if (!stillOurs(ticket)) return;
            if (stored && stored.version === 1) tally = stored;
        } catch (error) {
            console.error('[WaveGap] Could not read the tally back:', error);
        }
        if (!stillOurs(ticket)) return;
        loaded = true;

        watch = createWaveGapWatch();

        onNewBattle = (data) => {
            try {
                watch.newBattle(data, Date.now(), contextFor(data));
                collect();
            } catch (error) {
                console.error('[WaveGap] new_battle failed:', error);
            }
        };
        onBattleUpdated = (data) => {
            try {
                watch.battleUpdated(data, Date.now(), {
                    hidden: typeof document !== 'undefined' && document.hidden === true,
                });
                collect();
            } catch (error) {
                console.error('[WaveGap] battle_updated failed:', error);
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
        noteTeardown(waveGap);
        registry.cleanupAll();
        writeTimer = null;
        if (dirty) {
            dirty = false;
            storage.set(STORAGE_KEY, tally, STORAGE_STORE).catch((error) => {
                console.error('[WaveGap] Could not save the tally on teardown:', error);
            });
        }
        watch = null;
    },
};

/**
 * A text bar, because a histogram of a 67 ms range needs shape more than it
 * needs numbers.
 * @param {number} count - This bin's count
 * @param {number} most - The tallest bin's count
 * @returns {string} Bar
 */
function bar(count, most) {
    if (!most) return '';
    return '█'.repeat(Math.max(1, Math.round((count / most) * BAR_WIDTH)));
}

/**
 * One category's block.
 * @param {HTMLElement} body - Panel body
 * @param {string} title - Heading
 * @param {Object} category - A category summary
 * @returns {void}
 */
function drawCategory(body, title, category) {
    const card = panelCard(body, title, ACCENT);
    card.appendChild(panelLine('Observations', String(category.n)));
    if (!category.n) {
        card.appendChild(panelNote('None yet.'));
        return;
    }

    if (category.sem !== null) {
        card.appendChild(
            panelLine(
                'Mean gap',
                `${category.mean.toFixed(1)} ms (95% CI ${category.low.toFixed(1)}–${category.high.toFixed(1)})`,
                category.n >= MIN_OBSERVATIONS ? ACCENT : '#9aa4bb',
                'Death tick arrival to the next new_battle arrival. The interval is the sampling error on the ' +
                    'mean only — it does not include a constant bias in either endpoint.'
            )
        );
    }
    card.appendChild(panelLine('Spread (sd)', `${category.sd.toFixed(1)} ms`, '#e8ecf5'));

    const p = category.percentiles;
    card.appendChild(
        panelLine(
            'Percentiles',
            `p5 ${p.p5} · p25 ${p.p25} · p50 ${p.p50} · p75 ${p.p75} · p95 ${p.p95}`,
            '#e8ecf5',
            `Range seen: ${category.min}–${category.max} ms. Taken from the most recent retained intervals.`
        )
    );

    const most = category.histogram.reduce((top, row) => Math.max(top, row.count), 0);
    for (const row of category.histogram) {
        card.appendChild(
            panelLine(`  ${row.fromMs}–${row.toMs} ms`, `${bar(row.count, most)} ${row.count}`, '#9aa4bb')
        );
    }
}

export const waveGapPanel = createPanel({
    id: 'waveGap',
    title: 'Wave Gap',
    size: { width: 470, height: 540 },
    accent: ACCENT,
    refreshMs: 3000,
    draw: (body) => {
        if (!config.getSetting('waveGapWatch')) {
            body.appendChild(panelNote('The wave gap observer is switched off in settings.'));
            return;
        }

        body.appendChild(
            panelNote(
                'How long from the last monster of a wave dying to the next wave starting. The simulator uses ' +
                    'one constant for this in both open zones and dungeons; this is our own measurement of ' +
                    'whether that is right.'
            )
        );

        const summary = waveGap.summary();

        const verdict = panelCard(body, 'Verdict', ACCENT);
        verdict.appendChild(panelNote(summary.verdict.text));
        if (summary.updatedAt) {
            verdict.appendChild(
                panelLine('Last transition', formatRelativeTime(Date.now() - summary.updatedAt), '#9aa4bb')
            );
        }

        const ruler = panelCard(body, 'How good the ruler is', ACCENT);
        ruler.appendChild(
            panelNote(
                'Both ends of the measurement are client arrival times, so every reading carries network ' +
                    'jitter. This is that jitter, measured rather than assumed: each player delta states the ' +
                    "server's own delay to that player's next action, so the arrival gap between two of one " +
                    "player's consecutive actions minus that stated delay is a sample of the same noise."
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
                    'Robust because the residual sample is contaminated by design — a player who was stunned, ' +
                        'dead or between waves had their next action rescheduled by the server.'
                )
            );
            ruler.appendChild(
                panelNote(
                    `A single reading is good to roughly ±${(2 * summary.jitter.sd).toFixed(0)} ms, so no one ` +
                        'interval tells you anything. Only the mean of many does.'
                )
            );
        }

        for (const [key, label] of CATEGORY_LABELS) drawCategory(body, label, summary.categories[key]);

        const compare = panelCard(body, 'Do the categories agree?', ACCENT);
        if (summary.openVsDungeon) {
            compare.appendChild(
                panelLine(
                    'Open zone − dungeon wave',
                    `${summary.openVsDungeon.difference.toFixed(1)} ms ` +
                        `(95% CI ${summary.openVsDungeon.low.toFixed(1)}–${summary.openVsDungeon.high.toFixed(1)})`,
                    ACCENT,
                    summary.openVsDungeon.verdict
                )
            );
        } else {
            compare.appendChild(panelNote('Needs observations in both an open zone and a dungeon.'));
        }
        if (summary.boundaryVsWave) {
            compare.appendChild(
                panelLine(
                    'Run boundary − ordinary wave',
                    `${summary.boundaryVsWave.difference.toFixed(1)} ms ` +
                        `(95% CI ${summary.boundaryVsWave.low.toFixed(1)}–${summary.boundaryVsWave.high.toFixed(1)})`,
                    ACCENT,
                    summary.boundaryVsWave.verdict
                )
            );
        }

        const cycle = panelCard(body, 'Is it tied to a repeating clock?', ACCENT);
        cycle.appendChild(
            panelNote(
                `Each interval is binned by where its kill fell inside a candidate cycle, ${CYCLE_BINS} bins per ` +
                    'cycle. The phase comes from this machine’s clock, which is offset from the server’s ' +
                    'by an unknown constant — that rotates every observation equally, so it can reveal structure ' +
                    'but cannot say where in the cycle it sits.'
            )
        );
        if (!summary.cycles.length) {
            cycle.appendChild(panelNote('Nothing to bin yet.'));
        } else {
            cycle.appendChild(panelLine('Tested on', summary.cycleSubject || '—', '#9aa4bb'));
            for (const result of summary.cycles) {
                const populated = result.bins.filter((entry) => entry.n >= MIN_PER_BIN).length;
                const detail =
                    result.f === null
                        ? 'not enough per bin'
                        : `F ${result.f.toFixed(2)} · ${populated}/${CYCLE_BINS} bins populated · ` +
                          `smallest detectable bin difference ±${result.detectableMs.toFixed(0)} ms` +
                          (result.spread === null ? '' : ` · observed spread ${result.spread.toFixed(0)} ms`);
                cycle.appendChild(
                    panelLine(
                        `${result.cycleMs / 1000} s cycle`,
                        detail,
                        result.resolved ? '#e8ecf5' : '#9aa4bb',
                        'F near 1 means the bins agree. A conclusion either way is only worth having once the ' +
                            'smallest detectable difference is below the structure being looked for.'
                    )
                );
            }
        }

        const discards = panelCard(body, `Discarded transitions (${summary.discarded})`, ACCENT);
        discards.appendChild(
            panelNote(
                'Why a transition was thrown away matters as much as the headline: a wipe restarts the wave ' +
                    'rather than clearing it, and counting those would drag the mean toward a different mechanism.'
            )
        );
        for (const row of summary.discards) {
            discards.appendChild(panelLine(row.label, String(row.count), '#9aa4bb'));
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
            await waveGap.forget();
            waveGapPanel.render();
        });
        body.appendChild(reset);
    },
});

registerRow({
    key: 'waveGap',
    name: 'Wave Gap',
    empty: 'No wave transitions yet',
    defaultVisible: false,
    defaultSize: { width: 250, height: 30 },
    tileClass: TILE_CLASS.MEASUREMENT,
    onOpen: () => waveGapPanel.toggle(),
    render: (container) => {
        container.replaceChildren();
        if (!config.getSetting('waveGapWatch')) return;

        const summary = waveGap.summary();
        const category =
            summary.categories[CATEGORIES.openZone].n >= summary.categories[CATEGORIES.dungeonWave].n
                ? summary.categories[CATEGORIES.openZone]
                : summary.categories[CATEGORIES.dungeonWave];
        if (!category.n) return;

        Object.assign(container.style, { display: 'flex', justifyContent: 'space-between', gap: '10px' });

        const label = document.createElement('span');
        label.textContent = 'Wave gap';

        const value = document.createElement('span');
        value.textContent = `${category.mean.toFixed(0)} ms of ${category.n}`;
        value.style.color = category.n >= MIN_OBSERVATIONS ? ACCENT : '#9aa4bb';
        value.style.whiteSpace = 'nowrap';

        container.append(label, value);
        container.title = 'Double-click for the distribution, the cycle bins and how good the ruler is.';
    },
});

export default waveGap;
