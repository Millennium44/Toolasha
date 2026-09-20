/**
 * Stun persistence observer — the live half.
 *
 * {@link ../combat/stun-persistence.js} decides what a stun episode is worth;
 * this hooks the open-world battle stream, feeds it, and keeps the running
 * tally somewhere a page refresh cannot reach.
 *
 * ## Why the tally is durable and the ticks are not
 *
 * Thirty qualifying episodes take an hour or more of fighting a zone whose
 * waves mostly *do not* qualify, which is several sessions' work. The combat
 * recorder keeps raw ticks in memory only and rotates them away, so nothing
 * here may depend on a tick still existing: an episode is judged the moment it
 * closes and only the verdict is kept. What lands in storage is counts, a
 * bracket histogram and a few dozen audit rows — a few kilobytes that survive
 * a reload, not a transcript that does not.
 *
 * Writes are debounced rather than per-episode. Episodes close in bursts when a
 * wave wipes, and a write per episode would be several IndexedDB round trips
 * inside one tick's handler.
 *
 * ## Off by default
 *
 * It answers one question and then has nothing left to say, so it is a switch
 * somebody turns on to settle an argument, like the other diagnostics here.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { wilsonInterval } from '../combat-sim/engine/wilson.js';
import { createStunWatch, emptyTally, foldEpisode, summarize, DIRECTIONS, MIN_EPISODES } from './stun-persistence.js';
import { webSocketHook as sharedWebSocketHook } from '../../utils/bundle-bridge.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { captureOwner, noteTeardown, stillOurs } from '../../utils/init-ownership.js';
import { registerRow, TILE_CLASS } from '../../utils/overlay-rows.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { formatRelativeTime } from '../../utils/formatters.js';

/** Where the tally lives */
const STORAGE_KEY = 'stunPersistenceTally';

/** Which object store it lives in */
const STORAGE_STORE = 'settings';

/** How long a burst of closed episodes is allowed to accumulate before a write */
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

let watch = null;
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
            console.error('[StunPersistence] Could not save the tally:', error);
        }
    }, WRITE_DEBOUNCE_MS);
    registry.registerTimeout(writeTimer, 'stun-persistence:write');
}

/**
 * Take whatever the watch has finished and fold it in.
 * @returns {void}
 */
function collect() {
    const episodes = watch?.drain() || [];
    if (!episodes.length) return;
    for (const episode of episodes) foldEpisode(tally, episode);
    scheduleWrite();
}

const stunPersistence = {
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

    /**
     * How many stuns are running right now, for the panel's live line.
     * @returns {number} Open episodes
     */
    watching() {
        return watch?.open() || 0;
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
            console.error('[StunPersistence] Could not clear the tally:', error);
        }
    },

    name: 'Stun Persistence',

    /**
     * Start watching. Does nothing at all unless the setting is on.
     * @returns {Promise<void>} Resolves once the stored tally is back
     */
    initialize: async () => {
        if (!config.getSetting('stunPersistenceWatch')) return;

        // A character switch tears this down while the read below is in flight,
        // and a tail that resumed afterwards would hook the websocket for a
        // character that is no longer here, with nothing left holding the
        // handles that would take it off again
        const ticket = captureOwner(stunPersistence);

        try {
            const stored = await storage.get(STORAGE_KEY, STORAGE_STORE, null);
            if (!stillOurs(ticket)) return;
            if (stored && stored.version === 1) tally = stored;
        } catch (error) {
            console.error('[StunPersistence] Could not read the tally back:', error);
        }
        if (!stillOurs(ticket)) return;
        loaded = true;

        watch = createStunWatch();

        // Open-world only. `guild_battle_updated` is a separate message the
        // combat recorder does not hook either, and a trial's roster does not
        // answer this question any better than a zone's does
        onNewBattle = (data) => {
            try {
                watch.newBattle(data, Date.now());
                collect();
            } catch (error) {
                console.error('[StunPersistence] new_battle failed:', error);
            }
        };
        onBattleUpdated = (data) => {
            try {
                watch.battleUpdated(data, Date.now());
                collect();
            } catch (error) {
                console.error('[StunPersistence] battle_updated failed:', error);
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
        noteTeardown(stunPersistence);
        registry.cleanupAll();
        writeTimer = null;
        if (dirty) {
            dirty = false;
            storage.set(STORAGE_KEY, tally, STORAGE_STORE).catch((error) => {
                console.error('[StunPersistence] Could not save the tally on teardown:', error);
            });
        }
        watch = null;
    },
};

/**
 * One direction's block in the panel.
 * @param {HTMLElement} body - Panel body
 * @param {string} title - Heading
 * @param {Object} direction - A direction summary
 * @returns {void}
 */
function drawDirection(body, title, direction) {
    const card = panelCard(body, title, ACCENT);
    card.appendChild(panelLine('Qualifying episodes', String(direction.episodes)));

    if (!direction.episodes) {
        card.appendChild(panelNote('Nothing qualifying yet.'));
        return;
    }

    const fraction = `${Math.round(direction.fraction * 100)}%`;
    const band = `${Math.round(direction.low * 100)}–${Math.round(direction.high * 100)}%`;
    card.appendChild(
        panelLine(
            'Stun outlived its caster',
            `${fraction} (${direction.outlived}/${direction.episodes}, 95% CI ${band})`,
            ACCENT,
            'The fraction of episodes where the stun flag came back on a tick strictly after the caster died. ' +
                'Needs no duration lookup, so it does not depend on reading stunDuration correctly.'
        )
    );

    if (direction.medianPostDeathSeconds !== null) {
        card.appendChild(
            panelLine(
                'Typical time flagged after the death',
                `${direction.medianPostDeathSeconds.toFixed(2)} s`,
                '#e8ecf5',
                'A long gap here cannot be explained by the unit simply not being sent.'
            )
        );
    }

    card.appendChild(
        panelLine(
            'Typical end bracket',
            direction.medianBracketSeconds || '—',
            '#e8ecf5',
            'A stun end is only ever known to within a bracket: the last tick flagged and the first later ' +
                'tick not flagged. Wide brackets stretch stuns and bias this toward “outlived”.'
        )
    );

    for (const bucket of direction.brackets) {
        if (!bucket.count) continue;
        card.appendChild(panelLine(`  bracket ${bucket.label}`, String(bucket.count), '#9aa4bb'));
    }
}

export const stunPersistencePanel = createPanel({
    id: 'stunPersistence',
    title: 'Stun Persistence',
    size: { width: 430, height: 470 },
    accent: ACCENT,
    refreshMs: 3000,
    draw: (body) => {
        if (!config.getSetting('stunPersistenceWatch')) {
            body.appendChild(panelNote('The stun persistence observer is switched off in settings.'));
            return;
        }

        body.appendChild(
            panelNote(
                'Does a stun outlive the monster that cast it? The battle payload carries one crowd-control ' +
                    'field, isStunned — there is no blind or silence flag anywhere in it, so this measures ' +
                    'stun and nothing else.'
            )
        );

        const summary = stunPersistence.summary();

        const verdict = panelCard(body, 'Verdict', ACCENT);
        verdict.appendChild(panelNote(summary.verdict.text));
        if (summary.updatedAt) {
            verdict.appendChild(
                panelLine('Last episode', formatRelativeTime(Date.now() - summary.updatedAt), '#9aa4bb')
            );
        }
        verdict.appendChild(panelLine('Stuns running now', String(stunPersistence.watching()), '#9aa4bb'));

        drawDirection(body, 'Monster cast the stun, monster died', summary.directions[DIRECTIONS.monsterCaster]);
        drawDirection(body, 'Player cast the stun, player died (control)', summary.directions[DIRECTIONS.playerCaster]);

        const discards = panelCard(body, `Discarded episodes (${summary.discarded})`, ACCENT);
        discards.appendChild(
            panelNote(
                'Why an episode was thrown away matters as much as the headline: it is how you know the ' +
                    'sample was selected honestly rather than to taste.'
            )
        );
        for (const row of summary.discards) {
            discards.appendChild(panelLine(row.label, String(row.count), '#9aa4bb'));
        }

        const audit = panelCard(body, 'Recent qualifying episodes', ACCENT);
        const rows = (stunPersistence.tally().audit || []).slice(0, 8);
        if (!rows.length) audit.appendChild(panelNote('None yet.'));
        for (const row of rows) {
            const caster = row.casterHrid ? row.casterHrid.replace('/monsters/', '') : 'player';
            const observed = row.observedSeconds?.toFixed?.(2) ?? '—';
            const expected = row.durationSeconds ? `${row.durationSeconds.toFixed(1)}` : '—';
            audit.appendChild(
                panelLine(
                    `${caster} ${row.outlivedCaster ? 'outlived' : 'ended at death'}`,
                    `seen ${observed}s / expected ${expected}s, bracket ${row.bracketSeconds ?? '—'}s`,
                    row.outlivedCaster ? ACCENT : '#9aa4bb',
                    `ticks: start ${row.startTick}, caster died ${row.deathTick}, ` +
                        `last flagged ${row.lastStunnedTick}, unflagged ${row.endTick}`
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
            await stunPersistence.forget();
            stunPersistencePanel.render();
        });
        body.appendChild(reset);
    },
});

registerRow({
    key: 'stunPersistence',
    name: 'Stun Persistence',
    empty: 'No stun episodes yet',
    defaultVisible: false,
    defaultSize: { width: 250, height: 30 },
    tileClass: TILE_CLASS.MEASUREMENT,
    onOpen: () => stunPersistencePanel.toggle(),
    render: (container) => {
        container.replaceChildren();
        if (!config.getSetting('stunPersistenceWatch')) return;

        const direction = stunPersistence.summary().directions[DIRECTIONS.monsterCaster];
        if (!direction.episodes) return;

        Object.assign(container.style, { display: 'flex', justifyContent: 'space-between', gap: '10px' });

        const label = document.createElement('span');
        label.textContent = 'Stun outlives caster';

        const value = document.createElement('span');
        value.textContent = `${Math.round(direction.fraction * 100)}% of ${direction.episodes}`;
        value.style.color = direction.episodes >= MIN_EPISODES ? ACCENT : '#9aa4bb';
        value.style.whiteSpace = 'nowrap';

        container.append(label, value);
        container.title = 'Double-click for the brackets, the discards and the verdict.';
    },
});

export default stunPersistence;
