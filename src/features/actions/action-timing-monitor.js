/**
 * Action Timing Monitor
 *
 * A diagnostic for the "bar fills in three seconds, then sits full for
 * twenty-five" report. The game animates the progress bar with
 * `animation: ProgressBar_roundtime calc(var(--duration) * 1s) linear forwards`,
 * and that animation emits DOM events. Two numbers fall straight out of them:
 *
 *   - consecutive `animationstart`s are the action's real wall-clock pacing;
 *   - `animationend` to the next `animationstart` is the dead time the bar
 *     spends parked at full, which `fill: forwards` holds until something
 *     restarts it. That gap is the reported symptom, measured directly.
 *
 * Both are compared against the `--duration` the game declared. When the dead
 * time is material the anomaly is recorded with a snapshot of everything that
 * feeds action speed, so a stale or unhonoured buff can be correlated against
 * it afterwards.
 *
 * Observation only. It listens, it measures, and it writes its own storage
 * record. It never sends a game message and never touches game state.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { calculateActionStats } from '../../utils/action-calculator.js';
import { resolveActionContext } from '../../utils/action-context.js';
import { parseEquipmentSpeedBonuses } from '../../utils/equipment-parser.js';
import { calculateHouseActionSpeed } from '../../utils/house-efficiency.js';
import { getCommunityBuffBonus } from '../../utils/community-buffs.js';
import { SCROLL_BUFF_VALUES } from '../../utils/scroll-buff-values.js';

const SETTING_KEY = 'actionTiming_monitor';
const STORE_NAME = 'settings';
/** Unscoped storage key; the character id is appended, per the `${base}_${id}` idiom */
const RECORD_KEY_BASE = 'actionTimingLog';

/** Ring-buffer cap. Fifty stalls is far more than a diagnosis needs, and bounds the record. */
const MAX_ANOMALIES = 50;
/** Anything older than a week describes a build the maintainer has since replaced. */
const MAX_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When dead time counts as an anomaly. Both bounds must be cleared.
 *
 * A healthy handoff is one server round trip plus a React re-render — tens to
 * low hundreds of milliseconds. The 1.5s floor keeps ordinary network jitter
 * out of the buffer; the 25% fraction keeps a long action from being flagged
 * for a pause that is absolutely large but proportionally trivial. The reported
 * failure — three seconds of animation and twenty-five seconds of nothing —
 * clears both by an order of magnitude.
 */
const DEAD_TIME_FLOOR_MS = 1500;
const DEAD_TIME_FRACTION = 0.25;

/**
 * Above this the gap stops being the reported symptom and becomes an idle
 * client: the queue emptied, the action was stopped and started again later,
 * the window was left in front of something else without the tab going hidden.
 * Nothing observable here separates those from a server stall, so the module
 * declines to claim — and a ten-minute "dead time" would drag the median the
 * report is read from far more than it would inform it. Four times the worst
 * reported stall leaves the symptom itself an ample margin.
 */
const DEAD_TIME_CEILING_MS = 120 * 1000;

/** The game's keyframes name, as it survives the CSS module's hashing. */
const ANIMATION_NAME = 'roundtime';
/** Double underscore: `ProgressBar_innerBarContainer__x` must not match. */
const INNER_BAR_SELECTOR = '[class*="ProgressBar_innerBar__"]';

/** One console line per minute at most — a stalling client stalls repeatedly. */
const LOG_COOLDOWN_MS = 60 * 1000;

/** Community buffs that bear on how long an action takes. */
const SPEED_COMMUNITY_BUFFS = [
    '/community_buff_types/enhancing_speed',
    '/community_buff_types/production_efficiency',
    '/community_buff_types/efficiency',
];

/** The buff types Toolasha can be simulating, per `dataManager.isBuffBeingSimulated`. */
const SIMULATABLE_BUFFS = Object.keys(SCROLL_BUFF_VALUES);

/**
 * This character's record key.
 * @param {string} characterId - Whose log this is
 * @returns {string} `actionTimingLog_<characterId>`
 */
function recordKey(characterId) {
    return `${RECORD_KEY_BASE}_${characterId}`;
}

/**
 * The middle value of a list of numbers.
 * @param {Array<number>} values - Samples, in any order
 * @returns {number|null} The median, or null when there are none
 */
function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

class ActionTimingMonitor {
    constructor() {
        this.initialized = false;
        this.registry = null;
        this.settingChangeHandler = null;

        /** Wall-clock ms of the last `animationstart` seen, or null before the first */
        this.lastStartAt = null;
        /** Wall-clock ms of the last `animationend` seen, or null */
        this.lastEndAt = null;
        /** `--duration` in seconds as declared at `lastStartAt` */
        this.declaredDuration = null;
        /** True when the tab was hidden at any point since `lastStartAt` */
        this.wentHidden = false;

        /** Completed start-to-start intervals seen, this character, all sessions */
        this.observed = 0;
        /** @type {Array<Object>} Ring buffer of anomalies, oldest first */
        this.anomalies = [];

        this.characterId = null;
        /** Bumped by every initialize/cleanup so a load in flight can tell it is stale */
        this.generation = 0;
        this.lastLoggedAt = 0;
    }

    /**
     * Start measuring. Safe to call twice; the second call is a no-op.
     * @returns {Promise<void>} Resolves once the stored log has been read
     */
    async initialize() {
        if (!this.settingChangeHandler) {
            // config.setSetting() notifies on every call, even when the value did
            // not actually change, so an "enabled" notification can arrive with no
            // "disabled" before it. initialize()'s own guard absorbs that only as
            // long as nothing here clears `initialized` first.
            this.settingChangeHandler = (enabled) => {
                if (enabled) {
                    this.initialize();
                } else {
                    this.cleanup();
                }
            };
            config.onSettingChange(SETTING_KEY, this.settingChangeHandler);
        }

        if (this.initialized) return;
        if (!config.getSetting(SETTING_KEY)) return;
        this.initialized = true;

        const generation = ++this.generation;
        // Captured before the await below, and every key built from it. A
        // character switch landing inside the read would otherwise file the
        // departing character's log under the arriving character's key.
        const characterId = dataManager.getCurrentCharacterId() || 'default';
        this.characterId = characterId;

        const registry = createCleanupRegistry();
        this.registry = registry;

        // Animation events bubble, so one delegated pair covers every progress
        // bar the game ever renders — no per-element observer, no re-attaching
        // when React replaces the bar, and nothing to leak.
        registry.registerListener(document, 'animationstart', (event) => this._onAnimationStart(event), true);
        registry.registerListener(document, 'animationend', (event) => this._onAnimationEnd(event), true);
        registry.registerListener(document, 'visibilitychange', () => {
            if (document.hidden) this.wentHidden = true;
        });

        try {
            const stored = await storage.get(recordKey(characterId), STORE_NAME, null);
            if (this.generation !== generation) return;
            this.observed = Number.isFinite(stored?.observed) ? stored.observed : 0;
            this.anomalies = this._prune(Array.isArray(stored?.anomalies) ? stored.anomalies : []);
        } catch (error) {
            console.error('[Action Timing Monitor] Could not read the stored log:', error);
        }
    }

    /**
     * Whether an animation event belongs to a progress bar's roundtime fill.
     * @param {AnimationEvent} event - The event as delivered to the document
     * @returns {boolean} True when this is a bar we measure
     */
    _isRoundtime(event) {
        if (typeof event?.animationName !== 'string' || !event.animationName.includes(ANIMATION_NAME)) return false;
        const target = event.target;
        return typeof target?.matches === 'function' && target.matches(INNER_BAR_SELECTOR);
    }

    _onAnimationStart(event) {
        if (!this._isRoundtime(event)) return;
        const at = Date.now();
        const declared = this._readDeclaredDuration(event.target);

        try {
            if (this.lastStartAt !== null) {
                this.observed += 1;
                this._evaluate(at);
            }
        } catch (error) {
            // A diagnostic that throws while recording a stall must not also
            // poison the next measurement. The state below is advanced either
            // way; leaving `lastStartAt` behind would measure the following
            // interval from a start two actions old and report a fake stall.
            console.error('[Action Timing Monitor] Recording an interval failed:', error);
        }

        this.lastStartAt = at;
        this.declaredDuration = declared;
        this.wentHidden = document.hidden === true;
    }

    _onAnimationEnd(event) {
        if (!this._isRoundtime(event)) return;
        this.lastEndAt = Date.now();
    }

    /**
     * The `--duration` the game declared on the bar that owns this fill.
     * @param {Element} innerBar - The animated element
     * @returns {number|null} Seconds, or null when there is no usable value
     */
    _readDeclaredDuration(innerBar) {
        const progressBar = innerBar?.parentElement?.parentElement;
        if (!progressBar) return null;
        const declared = parseFloat(getComputedStyle(progressBar).getPropertyValue('--duration'));
        return Number.isFinite(declared) && declared > 0 ? declared : null;
    }

    /**
     * Decide whether the interval that just closed was an anomaly, and record it.
     *
     * @param {number} startedAt - Wall clock of the `animationstart` that closed it
     */
    _evaluate(startedAt) {
        const declared = this.declaredDuration;
        const intervalMs = startedAt - this.lastStartAt;
        const deadMs = this.lastEndAt === null ? null : startedAt - this.lastEndAt;

        // A backgrounded tab throttles timers and defers event delivery, so a gap
        // measured across one says nothing about the server.
        if (this.wentHidden) return;
        if (deadMs === null || deadMs < 0 || !(declared > 0)) return;

        // The end has to belong to the interval that just closed. A bar torn
        // out mid-fill — a stopped action, an emptied queue, React replacing
        // the element — fires `animationcancel`, not `animationend`, so
        // `lastEndAt` is left pointing at an EARLIER action's end. Measuring
        // from it invents a stall and hands the record a negative animated
        // span, which no bar can have.
        if (this.lastEndAt <= this.lastStartAt) return;

        const threshold = Math.max(DEAD_TIME_FLOOR_MS, declared * 1000 * DEAD_TIME_FRACTION);
        if (deadMs < threshold) return;
        if (deadMs > DEAD_TIME_CEILING_MS) return;

        const animatedMs = this.lastEndAt - this.lastStartAt;
        this._record({
            intervalSeconds: intervalMs / 1000,
            deadSeconds: deadMs / 1000,
            animatedSeconds: animatedMs / 1000,
            declaredDuration: declared,
        });
    }

    /**
     * Append one anomaly to the ring buffer and persist it.
     * @param {{intervalSeconds: number, deadSeconds: number, animatedSeconds: number,
     *   declaredDuration: number}} timing - What was measured
     */
    _record(timing) {
        const action = this._currentAction();
        const record = {
            at: Date.now(),
            actionHrid: action?.actionHrid ?? null,
            actionName: action?.name ?? null,
            actionTypeHrid: action?.type ?? null,
            declaredDuration: Number(timing.declaredDuration.toFixed(4)),
            intervalSeconds: Number(timing.intervalSeconds.toFixed(3)),
            deadSeconds: Number(timing.deadSeconds.toFixed(3)),
            animatedSeconds: Number(timing.animatedSeconds.toFixed(3)),
            speed: this._speedSnapshot(action),
        };

        this.anomalies.push(record);
        if (this.anomalies.length > MAX_ANOMALIES) {
            this.anomalies.splice(0, this.anomalies.length - MAX_ANOMALIES);
        }

        const now = Date.now();
        if (now - this.lastLoggedAt >= LOG_COOLDOWN_MS) {
            this.lastLoggedAt = now;
            console.warn(
                `[Action Timing Monitor] ${record.actionName || 'action'} declared ${record.declaredDuration}s but the ` +
                    `bar sat full for ${record.deadSeconds}s (start-to-start ${record.intervalSeconds}s). ` +
                    'Toolasha.Debug.actionTimingReport() has the details.'
            );
        }

        this._save();
    }

    /** @returns {{actionHrid: string, name: string|null, type: string|null, details: Object|null}|null} The action being performed */
    _currentAction() {
        const current = dataManager.getCurrentActions?.()?.[0];
        if (!current?.actionHrid) return null;
        const details = dataManager.getActionDetails(current.actionHrid) || null;
        return {
            actionHrid: current.actionHrid,
            name: details?.name ?? null,
            type: details?.type ?? null,
            details,
        };
    }

    /**
     * Everything that feeds this action's speed, as the client believes it.
     *
     * The stale-buff hypothesis is what this field exists for: if a buff is
     * active here and the server is not honouring it, the record says so.
     * Every read is defensive — a diagnostic that throws while recording a
     * stall records nothing.
     *
     * @param {Object|null} action - As returned by `_currentAction`
     * @returns {Object} The snapshot, with nulls where a value was unavailable
     */
    _speedSnapshot(action) {
        const snapshot = {
            drinks: [],
            communityBuffs: {},
            equipmentSpeedBonus: null,
            personalSpeedBonus: null,
            guildSpeedBonus: null,
            houseSpeedBonus: null,
            houseRoomLevels: {},
            isTaskAction: false,
            taskSpeedBonus: 0,
            simulatedBuffs: [],
            predictedSeconds: null,
        };

        const actionTypeHrid = action?.type;
        if (!actionTypeHrid) return snapshot;

        try {
            const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap || {};
            const context = resolveActionContext(actionTypeHrid);

            snapshot.drinks = (context.drinks || []).map((drink) => ({
                itemHrid: drink.itemHrid,
                name: itemDetailMap[drink.itemHrid]?.name ?? null,
                isActive: drink.isActive === true,
                duration: drink.duration ?? null,
            }));

            for (const buffHrid of SPEED_COMMUNITY_BUFFS) {
                const level = dataManager.getCommunityBuffLevel(buffHrid);
                if (level > 0) {
                    snapshot.communityBuffs[buffHrid] = {
                        level,
                        bonus: getCommunityBuffBonus(buffHrid, actionTypeHrid),
                    };
                }
            }

            snapshot.equipmentSpeedBonus = parseEquipmentSpeedBonuses(context.equipment, actionTypeHrid, itemDetailMap);
            snapshot.personalSpeedBonus = dataManager.getPersonalBuffFlatBoost(
                actionTypeHrid,
                '/buff_types/action_speed'
            );

            const guildBuffs = dataManager.characterData?.guildActionTypeBuffsMap?.[actionTypeHrid] || [];
            snapshot.guildSpeedBonus = guildBuffs.reduce(
                (sum, buff) =>
                    buff.typeHrid === '/buff_types/action_speed'
                        ? sum + (buff.flatBoost || 0) + (buff.ratioBoost || 0)
                        : sum,
                0
            );

            snapshot.houseSpeedBonus = calculateHouseActionSpeed(actionTypeHrid);
            for (const [hrid, room] of dataManager.getHouseRooms() || []) {
                if (room?.level > 0) snapshot.houseRoomLevels[hrid] = room.level;
            }

            snapshot.isTaskAction = dataManager.isTaskAction(action.actionHrid) === true;
            if (snapshot.isTaskAction) snapshot.taskSpeedBonus = dataManager.getTaskSpeedBonus();

            snapshot.simulatedBuffs = SIMULATABLE_BUFFS.filter((buffHrid) =>
                dataManager.isBuffBeingSimulated(actionTypeHrid, buffHrid)
            );

            if (action.details) {
                const stats = calculateActionStats(action.details, {
                    skills: dataManager.getSkills(),
                    equipment: context.equipment,
                    itemDetailMap,
                    actionHrid: action.actionHrid,
                });
                snapshot.predictedSeconds =
                    typeof stats?.actionTime === 'number' ? Number(stats.actionTime.toFixed(4)) : null;
            }
        } catch (error) {
            console.error('[Action Timing Monitor] Buff snapshot failed:', error);
        }

        return snapshot;
    }

    /**
     * Drop anomalies older than the retention window.
     * @param {Array<Object>} anomalies - Records, oldest first
     * @returns {Array<Object>} What is still worth keeping
     */
    _prune(anomalies) {
        const cutoff = Date.now() - MAX_RECORD_AGE_MS;
        const kept = anomalies.filter((record) => Number.isFinite(record?.at) && record.at >= cutoff);
        return kept.length > MAX_ANOMALIES ? kept.slice(-MAX_ANOMALIES) : kept;
    }

    /**
     * Persist the log under the character that was current when this started.
     *
     * The key is built before the write and re-checked after it: a character
     * switch landing inside the write would otherwise stamp this character's
     * measurements onto whoever arrived.
     * @returns {Promise<void>} Resolves when the write settles
     */
    async _save() {
        const characterId = this.characterId;
        if (!characterId) return;
        const generation = this.generation;
        const payload = { observed: this.observed, anomalies: this.anomalies };
        try {
            await storage.set(recordKey(characterId), payload, STORE_NAME);
            if (this.generation !== generation) {
                console.warn('[Action Timing Monitor] Character changed mid-write; the log may be short an entry.');
            }
        } catch (error) {
            console.error('[Action Timing Monitor] Could not save the log:', error);
        }
    }

    /**
     * Print the recent anomalies and a summary. Console handle, not a feature.
     * @returns {{observed: number, anomalous: number, medianDeadSeconds: number|null,
     *   anomalies: Array<Object>}} The same numbers, for a caller that wants them
     */
    report() {
        const anomalies = this.anomalies;
        const medianDeadSeconds = median(anomalies.map((record) => record.deadSeconds));

        console.log(
            `[ActionTiming] ${this.observed} action${this.observed === 1 ? '' : 's'} observed, ` +
                `${anomalies.length} anomalous` +
                (medianDeadSeconds === null ? '' : `, median dead time ${medianDeadSeconds.toFixed(2)}s`)
        );

        if (!anomalies.length) {
            console.log('[ActionTiming] Nothing recorded. The setting must be on, and the bar must actually stall.');
            return { observed: this.observed, anomalous: 0, medianDeadSeconds: null, anomalies };
        }

        console.table(
            anomalies.map((record) => ({
                when: new Date(record.at).toLocaleTimeString(),
                action: record.actionName || record.actionHrid || '—',
                'declared s': record.declaredDuration,
                'predicted s': record.speed?.predictedSeconds ?? '—',
                'start→start s': record.intervalSeconds,
                'animated s': record.animatedSeconds,
                'dead s': record.deadSeconds,
                drinks: (record.speed?.drinks || []).map((drink) => drink.name || drink.itemHrid).join(', ') || '—',
                simulated: (record.speed?.simulatedBuffs || []).join(', ') || '—',
            }))
        );
        console.log('[ActionTiming] Full records (buff snapshots included):', anomalies);

        return { observed: this.observed, anomalous: anomalies.length, medianDeadSeconds, anomalies };
    }

    /** Stop measuring and forget this character's in-memory state. */
    cleanup() {
        this.generation += 1;
        this.registry?.cleanupAll();
        this.registry = null;
        this.lastStartAt = null;
        this.lastEndAt = null;
        this.declaredDuration = null;
        this.wentHidden = false;
        this.observed = 0;
        this.anomalies = [];
        this.characterId = null;
        this.lastLoggedAt = 0;
        this.initialized = false;
    }
}

const actionTimingMonitor = new ActionTimingMonitor();

export default {
    name: 'Action Timing Monitor',
    initialize: () => actionTimingMonitor.initialize(),
    cleanup: () => {
        try {
            return actionTimingMonitor.cleanup();
        } catch (error) {
            console.error('[Action Timing Monitor] Disable failed part-way:', error);
        } finally {
            actionTimingMonitor.initialized = false;
        }
    },
    /** Console handle behind `Toolasha.Debug.actionTimingReport()` */
    report: () => actionTimingMonitor.report(),
    /** Test seam: the singleton itself */
    _monitor: actionTimingMonitor,
};
