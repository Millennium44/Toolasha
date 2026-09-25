/**
 * Feature Registry
 * Centralized feature initialization system
 */

import config from './config.js';
import dataManager from './data-manager.js';
import performanceMonitor from '../utils/performance-monitor.js';

/**
 * Feature Registry
 * Populated at runtime by the entrypoint to avoid bundling feature code in core.
 */
const featureRegistry = [];

/**
 * Feature startup, published as something other code can wait for.
 *
 * Background work used to be scheduled on idleness alone, and idleness is not
 * the same question. On Chrome the feature chain's storage awaits *look* idle:
 * a real trace has net worth's idle callback firing 280 ms after
 * `features:start` and running for 2.06 s straight through the middle of a
 * 3.97 s chain, with both sides roughly doubling as they took turns on
 * IndexedDB. The same build on Firefox happened to fire 268 ms after startup
 * had finished and cost 268 ms. Nothing in `src/` read this completion signal
 * before; the only trace of it was the `features:done` mark below.
 *
 * Set once per session and never cleared: a caller arriving after the first
 * startup must find this half of the gate already open, since an "await the
 * next startup" signal would strand every caller that arrives late on a startup
 * that is not coming. Whether a *later* batch is running is the separate,
 * re-armable question `batchesInFlight` answers.
 */
let startupSettled = false;

/**
 * How many `initializeFeatures()` batches are running right now.
 *
 * The once-only latch above is not enough on its own. `initializeFeatures()`
 * runs again on every character switch, and a latch that settles once and is
 * never re-armed leaves the switch's re-init completely ungated — background
 * work handed over while the arriving character's features are initialising
 * goes straight back to competing with them for the same one-key-per-transaction
 * IndexedDB reads, which is the contention the gate exists to remove.
 *
 * Counting instead of re-arming keeps both properties: the gate cannot open
 * before the *first* startup (a bare "is a batch running" test is open during
 * the seconds of boot before `initializeFeatures()` is even called, which is the
 * original bug), and it closes again for as long as any later batch is actually
 * on the main thread. The early-return path never increments — it starts no
 * features — so a switch that refuses to initialise strands nobody.
 * @type {number}
 */
let batchesInFlight = 0;

/** Resolvers waiting for the gate to be open. Drained by `releaseIfOpen`. */
const startupWaiters = [];

/**
 * Keys whose `initialize()` the registry has called since the feature layer last
 * came up — at startup, on a switch's re-init, or by a live start. Cleared by
 * `disableAllFeatures()`, which takes every one of them down.
 *
 * Only the registry's own calls are counted: a module that stops itself on its
 * own setting and starts itself again on the same listener is not the
 * registry's business. A feature whose module stops itself *without* a matching
 * restart declares `isRunning` on its entry instead — see `isFeatureRunning`.
 * @type {Set<string>}
 */
const startedKeys = new Set();

/** Keys a live start is initializing right now, so no second pass starts them again. */
const liveStartsInFlight = new Set();

/**
 * Per-key registry work in flight: every `initialize()` any path calls — the
 * startup and re-init batch, a live start, a retry, a late-start restart — and
 * every disable a late start owes. Each entry is a never-rejecting promise.
 *
 * Two things read it. A switch's teardown waits all of it out (bounded) before
 * disabling: torn down mid-initialize, a feature finishes building after its
 * disable() has run and keeps running for the arriving character. And a later
 * start of the same key waits out what is already in flight on it (bounded), so a
 * singleton module is never initialized under a disable or another start of itself.
 * @type {Map<string, Set<Promise<void>>>}
 */
const keyWork = new Map();

/**
 * Longest a teardown, or a start queued behind other work on its key, waits.
 * Past it they go ahead — a stuck initializer must not hold the switch — and a
 * start that settles after a teardown is handled by `trackStart`.
 */
const IN_FLIGHT_START_WAIT_MS = 5000;

/** What a tracked start resolves to when a teardown ran while it waited, so it never called `initialize()`. */
const START_SKIPPED = Symbol('start skipped');

/**
 * Bumped by every `disableAllFeatures()`. A tracked start records it when it
 * begins; finding it moved when the start settles means a teardown ran while the
 * start was still in flight — past `IN_FLIGHT_START_WAIT_MS` — so what the start
 * built belongs to a character that has already been torn down.
 */
let teardownGeneration = 0;

/** Keys `restartForArrival` is disabling and restarting, so no live pass or retry touches them meanwhile. */
const lateRestartsInFlight = new Set();

/**
 * Whether a live start, a retry or a late-start restart is bringing `key` up right now.
 * @param {string} key - Feature key
 * @returns {boolean} True when a live pass or a retry must leave it alone
 */
function startInFlight(key) {
    return liveStartsInFlight.has(key) || lateRestartsInFlight.has(key);
}

/**
 * Hold `settled` in `keyWork` under `key` until it settles. Registers synchronously.
 * @param {string} key - Feature key
 * @param {Promise<void>} settled - Never-rejecting settle promise of the work
 * @returns {Promise<void>}
 */
async function holdKeyWork(key, settled) {
    let work = keyWork.get(key);
    if (!work) {
        work = new Set();
        keyWork.set(key, work);
    }
    work.add(settled);
    try {
        await settled;
    } finally {
        work.delete(settled);
        if (work.size === 0 && keyWork.get(key) === work) keyWork.delete(key);
    }
}

/**
 * Snapshot of the work in flight on `key`.
 * @param {string} key - Feature key
 * @returns {Array<Promise<void>>} Settle promises
 */
function keyWorkOf(key) {
    return [...(keyWork.get(key) ?? [])];
}

/**
 * Wait for `promises` to settle, for at most `ms`.
 * @param {Array<Promise<void>>} promises - Never-rejecting settle promises
 * @param {number} [ms] - Bound
 * @returns {Promise<void>}
 */
async function waitBounded(promises, ms = IN_FLIGHT_START_WAIT_MS) {
    if (promises.length === 0) return;
    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
    });
    try {
        await Promise.race([Promise.all(promises), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Call a feature's `disable()`, routing a throw to `noteDisableFailure`.
 * @param {Object} feature - Registry entry
 * @returns {Promise<void>}
 */
async function disableFeature(feature) {
    try {
        const featureInstance = getFeatureInstance(feature.key);
        if (featureInstance && typeof featureInstance.disable === 'function') {
            await featureInstance.disable();
        }
    } catch (error) {
        noteDisableFailure(feature, error);
    }
}

/**
 * `disableFeature`, held in `keyWork` from the call on, so a teardown waits for it
 * and a start of the same key queues behind it.
 * @param {Object} feature - Registry entry
 * @returns {Promise<void>}
 */
function trackedDisable(feature) {
    return holdKeyWork(feature.key, disableFeature(feature));
}

/**
 * Generation in which `initialize()` was last actually called, per key — so a
 * late start can tell whether the arriving character's instance is already built
 * (and would be torn down with its own leftovers) or only queued behind it.
 * @type {Map<string, number>}
 */
const initializedIn = new Map();

/**
 * Restart a feature the arriving character had already built when a start from a
 * torn-down generation settled on top of it, or built while that start's disable
 * was still running and could clear it.
 *
 * A feature module is a singleton holding both starts' resources, and no disable
 * can tell them apart. So once the arriving character's own start has settled,
 * disable the lot and start it again for them through the tracked path — unless
 * its gate has closed meanwhile, or a teardown since has taken both down.
 *
 * The restart's own disable is late work too: should it outlive a teardown and the
 * next character's start stop waiting on it at `IN_FLIGHT_START_WAIT_MS`, that
 * instance is repaired by another pass. Each pass needs another teardown to land
 * mid-disable, so this does not loop on its own.
 * @param {Object} feature - Registry entry
 * @returns {Promise<void>}
 */
async function restartForArrival(feature) {
    while (await restartForArrivalOnce(feature)) {
        // Repeated for the character a teardown during the last pass brought in
    }
}

/**
 * One pass of `restartForArrival`.
 * @param {Object} feature - Registry entry
 * @returns {Promise<boolean>} True when its disable outlived a teardown and the newer
 *   generation's instance was built under it, so the key needs another pass
 */
async function restartForArrivalOnce(feature) {
    const { key } = feature;
    // Another late start is already restarting it; that restart's disable covers this one
    if (lateRestartsInFlight.has(key)) return false;
    lateRestartsInFlight.add(key);
    const arrival = teardownGeneration;
    try {
        await waitBounded(keyWorkOf(key));
        // A teardown since has disabled everything; a live stop has disabled it and dropped its key
        if (teardownGeneration !== arrival || !startedKeys.has(key)) return false;
        await trackedDisable(feature);
        // A teardown ran during the disable. One queued but not yet run is safe to start
        // under: it waits for this tracked start before disabling. `liveStartAllowed()` is
        // no guard here — it stays false until the arriving character's re-init returns.
        // But a start for the newer generation that stopped waiting on this disable at the
        // cap built its instance under it, which the disable may have cleared: repair that.
        if (teardownGeneration !== arrival) return initializedIn.get(key) === teardownGeneration;
        if (!isGateOpen(feature)) {
            startedKeys.delete(key);
            return false;
        }
        try {
            await trackedInitialize(feature);
        } catch (error) {
            console.error(`[Toolasha] Failed to restart ${feature.name} after a late start:`, error);
            if (teardownGeneration === arrival && typeof liveStartFailureHandler === 'function') {
                try {
                    liveStartFailureHandler([
                        { key, name: feature.name, reason: `Initialization threw: ${error?.message}` },
                    ]);
                } catch (handlerError) {
                    console.error('[FeatureRegistry] Live start failure handler threw:', handlerError);
                }
            }
        }
    } finally {
        lateRestartsInFlight.delete(key);
    }
    // A stop pass that ran during the restart skipped it as in flight
    if (!isGateOpen(feature)) scheduleLiveStart();
    return false;
}

/**
 * Hold a start in `keyWork` until it settles, and until a teardown it outlived
 * has been made good.
 *
 * A start that settles in a later generation than it began in built what it built
 * for a character already torn down. If nobody has called `initialize()` on the
 * key since, its disable runs inside this same held work, so a start of the key
 * queued behind it — the arriving character's re-init, a live start — begins
 * only once the leftovers are gone. If the arriving character's instance is
 * already built — or is built while that disable runs, by a start that stopped
 * waiting on it at `IN_FLIGHT_START_WAIT_MS` — see `restartForArrival`.
 *
 * All of it finishes before the caller resumes. The caller must not resume
 * first: a live start's caller holds the key in `liveStartsInFlight` until it
 * does and then runs a stop pass, which would disable the feature a second time.
 * @param {Object} feature - Registry entry
 * @param {Promise<*>} started - The start: what `initialize()` returned, or `START_SKIPPED`
 * @param {number} generation - `teardownGeneration` when the start was reserved
 * @returns {Promise<*>} What `initialize()` resolved to (undefined if skipped)
 */
async function trackStart(feature, started, generation) {
    const { key } = feature;
    let restart = false;
    const work = (async () => {
        let skipped = false;
        try {
            skipped = (await started) === START_SKIPPED;
        } catch {
            // The rejection reaches the caller through `started` below
        }
        if (skipped || generation === teardownGeneration) return;
        if (initializedIn.get(key) === teardownGeneration) {
            restart = true;
            return;
        }
        await disableFeature(feature);
        // Nobody had initialized the key for the current generation when this disable
        // began. If somebody has now, a start queued behind it stopped waiting at the
        // cap and built the arriving instance while the disable was suspended, and the
        // disable may since have cleared it: repair it the same way.
        restart = initializedIn.get(key) === teardownGeneration;
    })();
    await holdKeyWork(key, work);
    if (restart) await restartForArrival(feature);
    const result = await started;
    return result === START_SKIPPED ? undefined : result;
}

/**
 * Call a feature's `initialize()`, held in `keyWork` from this call on. Work
 * already in flight on its key is waited out first (bounded); should a teardown
 * run meanwhile, the start is dropped without calling `initialize()` — it was for
 * the departing character.
 * @param {Object} feature - Registry entry
 * @returns {Promise<*>} What `initialize()` resolves to; a synchronous throw rejects it
 */
function trackedInitialize(feature) {
    const generation = teardownGeneration;
    const prior = keyWorkOf(feature.key);
    const started = (async () => {
        if (prior.length > 0) {
            await waitBounded(prior);
            if (generation !== teardownGeneration) return START_SKIPPED;
        }
        initializedIn.set(feature.key, generation);
        return feature.initialize();
    })();
    return trackStart(feature, started, generation);
}

/**
 * Wait, bounded as a whole, for all work in `keyWork` — including work that
 * begins while waiting — to settle.
 * @returns {Promise<void>}
 */
async function waitForInFlightStarts() {
    const deadline = Date.now() + IN_FLIGHT_START_WAIT_MS;
    while (keyWork.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        await waitBounded(
            [...keyWork.values()].flatMap((work) => [...work]),
            remaining
        );
    }
}

/**
 * Whether a character switch has taken the feature layer down and not yet
 * brought it back up. Owned by `setupCharacterSwitchHandler`; read by live starts,
 * which must not initialize anything into a layer the switch is about to rebuild
 * — `getIsCharacterSwitching()` drops back to false before the rebuild starts.
 */
let layerTornDown = false;

/** A live-start pass is queued and has not begun. Coalesces bursts of changes. */
let liveStartQueued = false;

/** A pass found the layer mid-switch and stood down; the switch's re-init reruns it. */
let liveStartDeferredBySwitch = false;

/** Recovery routine for what a live start fails to bring up — see `setupLiveFeatureStart`. */
let liveStartFailureHandler = null;

/** Unregisters the any-setting listener `setupLiveFeatureStart` installed. */
let unregisterLiveStart = null;

/**
 * Resolve everyone waiting, if the gate is open right now.
 * @returns {void}
 */
function releaseIfOpen() {
    if (!isStartupComplete()) return;
    for (const resolve of startupWaiters.splice(0)) resolve();
}

/**
 * Open the gate, once.
 *
 * Called from a `finally`, so the paths that never reach `features:done` — a
 * `initializeFeatures()` that returns early because a character switch is under
 * way, or one that throws before the mark — release waiters rather than leaving
 * them to the caller-side timeout. There is no startup in progress in either
 * case, which is exactly what a waiter wants to know.
 *
 * @returns {void}
 */
function settleStartup() {
    startupSettled = true;
    releaseIfOpen();
}

/**
 * Is the main thread free of feature startup right now?
 *
 * True once the first startup has settled *and* no later batch — a character
 * switch's re-init — is running. Lets a caller skip the await entirely rather
 * than yielding a microtask for an answer it can have synchronously.
 *
 * @returns {boolean} True when nothing is gating on feature startup
 */
function isStartupComplete() {
    return startupSettled && batchesInFlight === 0;
}

/**
 * A promise that resolves the next time feature startup is out of the way.
 *
 * Already resolved for anyone who asks between batches. It never rejects: a
 * feature that throws is caught and recorded by `initializeFeatures`, and the
 * gate is about *when* startup stopped occupying the main thread, not whether
 * it went well. Callers bound their own wait — see `STARTUP_GATE_TIMEOUT_MS` in
 * `src/utils/background-work.js` — so a batch that never finishes delays work
 * rather than losing it.
 *
 * @returns {Promise<void>} Resolves once the gate is open
 */
function whenStartupComplete() {
    if (isStartupComplete()) return Promise.resolve();
    return new Promise((resolve) => startupWaiters.push(resolve));
}

/**
 * Initialize all enabled features
 *
 * Returns what failed rather than only logging it. An initializer that throws
 * used to reach the player as a feature that is simply absent, with the reason
 * in a console nobody has open; the caller needs the list to be able to say so.
 *
 * Features are initialized in registry order and each is awaited before the next
 * one starts, *unless* its registry entry sets `concurrent: true`. Such a
 * feature is still started in its turn — its synchronous half runs at exactly
 * the same point it always did — but the waiting is deferred to the end, so its
 * `await` overlaps everything after it instead of delaying it.
 *
 * Why that is worth a flag. Almost none of feature startup is our own CPU: six
 * features between them spent 2.9 s inside `initialize()` and half a millisecond
 * of it running code, the rest parked on an IndexedDB read that nothing else
 * wanted. Awaited one after another those reads add up; overlapped, the group
 * costs what its slowest member costs.
 *
 * Why it is opt-in rather than the default. Serial initialization is load-bearing
 * in places that are not obvious from the registry: tooltip sections and the
 * task panel's buttons appear in the order their observers were registered,
 * which for a post-`await` registration means the order the reads happened to
 * finish in; and a feature that populates a shared singleton after its await
 * (loadout snapshots, the expected-value calculator) is read by later features
 * that assume it is already full. A feature is safe to mark only when what it
 * awaits is its own — its own storage record, its own panel — and nothing
 * downstream is ordered against what it does afterwards. (The market data
 * load is no longer a reason to serialize: the entrypoint starts the one
 * startup fetch itself and `marketAPI.fetch()` folds concurrent callers onto
 * the in-flight request.)
 *
 * @returns {Promise<Array<{key: string, name: string, reason: string}>>} Failures, in registry order
 */
async function initializeFeatures() {
    batchesInFlight += 1;
    try {
        return await runFeatureInitialization();
    } finally {
        batchesInFlight -= 1;
        // Whatever happened — an early return, a throw, a clean pass — startup
        // is no longer occupying the main thread, so anything gated on it runs.
        settleStartup();
    }
}

/**
 * The body of `initializeFeatures`, separated only so the gate above can be
 * released in a `finally` without indenting the whole routine.
 *
 * @returns {Promise<Array<{key: string, name: string, reason: string}>>} Failures, in registry order
 */
async function runFeatureInitialization() {
    // Block feature initialization during character switch
    if (dataManager.getIsCharacterSwitching()) {
        return [];
    }

    performanceMonitor.mark('features:start', { registered: featureRegistry.length });

    // One slot per started feature, filled in place, so failures come back in
    // registry order however the promises happen to settle.
    const slots = [];
    const pending = [];
    // A switch's teardown can run while this batch is still going — the startup
    // batch runs outside the switch lifecycle chain. What it starts afterwards
    // would run for the departing character, so it stops at the first sign of one.
    const batchGeneration = teardownGeneration;

    /**
     * Record what a feature's initializer cost, once it has finished.
     *
     * The timing is split on purpose. A single wall-clock span around
     * `await feature.initialize()` blamed a feature for time it merely *parked*
     * in — a sync feature (e.g. autoAllButton) that happens to `await undefined`
     * at the moment a heavy storage read resolves elsewhere would absorb that
     * read's cost and top the "slowest features" list while doing nothing.
     * `own` is the feature's synchronous work up to the point it returns or
     * suspends; `total` still spans the await so a genuinely async initializer
     * is not undercounted. A large gap between them means the cost is time spent
     * waiting, not this feature's own work — and now that the waits overlap,
     * those totals overlap too, so they are a timeline and not a sum.
     *
     * @param {Object} feature - Registry entry
     * @param {number} startedAt - Boot-relative start of its initializer
     * @param {number} ownMs - Synchronous self-time
     * @returns {void}
     */
    const recordTiming = (feature, startedAt, ownMs) => {
        const totalMs = performanceMonitor.sinceBoot() - startedAt;
        performanceMonitor.snapshot(`init:${feature.key}`, totalMs, startedAt);
        if (totalMs - ownMs >= 1) {
            performanceMonitor.snapshot(`init:${feature.key}:own`, ownMs, startedAt);
        }
    };

    for (const feature of featureRegistry) {
        if (dataManager.getIsCharacterSwitching() || teardownGeneration !== batchGeneration) break;

        const isEnabled = (() => {
            try {
                return feature.customCheck ? feature.customCheck() : config.isFeatureEnabled(feature.key);
            } catch (error) {
                console.error(`[Toolasha] Enabled check for ${feature.name} threw:`, error);
                return false;
            }
        })();

        if (!isEnabled) {
            continue;
        }

        startedKeys.add(feature.key);
        const slot = { key: feature.key, name: feature.name, reason: null };
        slots.push(slot);

        const startedAt = performanceMonitor.sinceBoot();

        // Other work still in flight on this key (a late start of the departing
        // character, or the disable it owes): queue behind it through the tracked path.
        if (keyWork.has(feature.key)) {
            const queued = (async () => {
                try {
                    await trackedInitialize(feature);
                } catch (error) {
                    slot.reason = `Initialization threw: ${error?.message}`;
                    console.error(`[Toolasha] Failed to initialize ${feature.name}:`, error);
                } finally {
                    recordTiming(feature, startedAt, 0);
                }
            })();
            if (feature.concurrent) {
                pending.push(queued);
            } else {
                await queued;
            }
            continue;
        }

        let started;
        try {
            initializedIn.set(feature.key, batchGeneration);
            started = feature.initialize();
        } catch (error) {
            // A synchronous throw never becomes a promise, so it is settled here.
            slot.reason = `Initialization threw: ${error.message}`;
            console.error(`[Toolasha] Failed to initialize ${feature.name}:`, error);
            continue;
        }
        const ownMs = performanceMonitor.sinceBoot() - startedAt;

        if (!started || typeof started.then !== 'function') {
            recordTiming(feature, startedAt, ownMs);
            continue;
        }

        // Attached now rather than at the end: an initializer that rejects before
        // anything awaits it is an unhandled rejection otherwise. Held in `keyWork`,
        // so a teardown landing mid-batch waits for it.
        const settled = (async () => {
            try {
                await trackStart(feature, started, batchGeneration);
                recordTiming(feature, startedAt, ownMs);
            } catch (error) {
                recordTiming(feature, startedAt, ownMs);
                slot.reason = `Initialization threw: ${error?.message}`;
                console.error(`[Toolasha] Failed to initialize ${feature.name}:`, error);
            }
        })();

        if (feature.concurrent) {
            pending.push(settled);
        } else {
            await settled;
        }
    }

    if (pending.length > 0) {
        await Promise.all(pending);
    }

    // Cut short by a teardown: its failures are the departing character's, and a
    // retry of them would start features into the arriving one.
    if (teardownGeneration !== batchGeneration) {
        performanceMonitor.mark('features:done', { failed: 0 });
        return [];
    }

    const errors = slots.filter((slot) => slot.reason !== null).map(({ key, name, reason }) => ({ key, name, reason }));

    performanceMonitor.mark('features:done', { failed: errors.length });

    // Log errors if any occurred
    if (errors.length > 0) {
        console.error(`[Toolasha] ${errors.length} feature(s) failed to initialize`, errors);
    }

    return errors;
}

/**
 * Get feature by key
 * @param {string} key - Feature key
 * @returns {Object|null} Feature definition or null
 */
function getFeature(key) {
    return featureRegistry.find((f) => f.key === key) || null;
}

/**
 * Get all features
 * @returns {Array} Feature registry
 */
function getAllFeatures() {
    return [...featureRegistry];
}

/**
 * Get features by category
 * @param {string} category - Category name
 * @returns {Array} Features in category
 */
function getFeaturesByCategory(category) {
    return featureRegistry.filter((f) => f.category === category);
}

/**
 * Check health of all initialized features
 * @returns {Array<Object>} Array of failed features with details
 */
function checkFeatureHealth() {
    const failed = [];

    for (const feature of featureRegistry) {
        // Skip if feature has no health check
        if (!feature.healthCheck) continue;

        // Skip if feature is not enabled
        const isEnabled = (() => {
            try {
                return feature.customCheck ? feature.customCheck() : config.isFeatureEnabled(feature.key);
            } catch (error) {
                console.error(`[Toolasha] Enabled check for ${feature.name} threw:`, error);
                return false;
            }
        })();

        if (!isEnabled) continue;

        try {
            const result = feature.healthCheck();

            // null = can't verify (DOM not ready), false = failed, true = healthy
            if (result === false) {
                failed.push({
                    key: feature.key,
                    name: feature.name,
                    reason: 'Health check returned false',
                });
            }
        } catch (error) {
            failed.push({
                key: feature.key,
                name: feature.name,
                reason: `Health check error: ${error.message}`,
            });
        }
    }

    return failed;
}

/**
 * Setup character switch handler
 * Re-initializes all features when character switches
 */
/**
 * Feature keys whose most recent teardown threw. Read by `getDisableFailures()`.
 * @type {Set<string>}
 */
const disableFailures = new Set();

/**
 * Record — loudly — that a feature's teardown threw.
 *
 * A teardown that throws part-way is the shape of bug that costs a player the
 * feature for the rest of the session: the old log said only "Failed to disable
 * X" among a screenful of other noise, while the actual damage was that the
 * feature had removed its own UI and then thrown before clearing its
 * initialised flag, so the re-initialise on `character_switched` returned early
 * and the feature stayed dead until a page reload. Every feature's teardown now
 * clears that flag in a `finally`, so this should not happen — which is exactly
 * why it deserves a line that names the feature and says what it costs, visible
 * in the first console screenshot anybody sends.
 *
 * @param {Object} feature - Registry entry that failed
 * @param {Error} error - What its teardown threw
 * @returns {void}
 */
function noteDisableFailure(feature, error) {
    disableFailures.add(feature.key);
    console.error(
        `[FeatureRegistry] ${feature.name} (${feature.key}) threw while disabling — if it did not clear its own ` +
            'initialised flag it will not re-initialise cleanly until the page is reloaded:',
        error
    );
}

/**
 * Feature keys whose last teardown threw, newest state only.
 * @returns {Array<string>} Keys, in insertion order
 */
function getDisableFailures() {
    return [...disableFailures];
}

/**
 * Disable every active feature — the cleanup half of a character switch.
 * @returns {Promise<void>}
 */
async function disableAllFeatures() {
    const cleanupPromises = [];
    disableFailures.clear();
    startedKeys.clear();
    teardownGeneration++;
    for (const feature of featureRegistry) {
        try {
            const featureInstance = getFeatureInstance(feature.key);
            if (featureInstance && typeof featureInstance.disable === 'function') {
                const result = featureInstance.disable();
                if (result && typeof result.then === 'function') {
                    cleanupPromises.push(
                        result.catch((error) => {
                            noteDisableFailure(feature, error);
                        })
                    );
                }
            }
        } catch (error) {
            noteDisableFailure(feature, error);
        }
    }
    if (cleanupPromises.length > 0) {
        await Promise.all(cleanupPromises);
    }
    if (disableFailures.size > 0) {
        console.error(
            `[FeatureRegistry] ${disableFailures.size} feature(s) threw while disabling: ${[...disableFailures].join(', ')}`
        );
    }
}

/**
 * Re-initialize all features when the character switches.
 *
 * The switch is driven off two events — `character_switching` (tear down) and
 * `character_switched` (reload settings, re-enable) — and rapid switches used to
 * corrupt the result two ways: a boolean "reinit scheduled" guard silently
 * *dropped* a later switch (A→B→A ended with B's per-character settings applied
 * under A), and `Promise.race([cleanup, setTimeout(500)])` let a rebuild start
 * before the previous character's teardown finished, so init overlapped cleanup.
 *
 * This serializes the whole lifecycle through one promise chain — cleanup and
 * reinit for any switch, and successive switches, run strictly in order, none
 * dropped. And each reinit verifies it is still for the current character
 * (`currentCharacterId` is updated to the new target before `character_switched`
 * fires) before and after every await, so a reinit a newer switch has
 * superseded aborts instead of clobbering the newer character's state — the
 * "latest character wins" invariant. Ported from upstream Celasha/Toolasha#622.
 *
 * A burst of switches — four characters in one browser, clicked through faster
 * than a second apart — is coalesced here rather than upstream. Every switch
 * still emits both events (they are what reloads per-character settings and
 * lets each feature persist and clear the departing character's state), but the
 * *expensive* half runs once per burst: the first switch tears the feature
 * layer down, the rest find it already down and skip, and only the switch that
 * is still current when the burst settles re-initialises. Data-manager used to
 * do this by dropping the events outright, which meant the second character ran
 * on the first character's settings until some later, slower switch fixed it.
 *
 * @param {Function} [onInitFailures] - Called with the array `initializeFeatures()`
 *   returns after each switch's re-init. Boot has always followed its own
 *   `initializeFeatures()` with a health check, one retry pass, and a
 *   user-facing report of what is still broken; before this parameter existed
 *   the switch path discarded that return value entirely, so a feature that
 *   threw during a switch stayed dead — silently — until the page reloaded.
 *   The entrypoint passes the same recovery routine boot uses so both paths
 *   get the same treatment.
 * @param {Function} [onBeforeSettingsLoad] - Awaited with `(characterId, characterName)`
 *   right before this switch's `config.loadSettings()`. The entrypoint's own
 *   boot path offers a settings-mirror restore at the same point for the
 *   first character of the session (see entrypoint.js); a switch to a second
 *   character on the same wiped browser needs the same offer, since nothing
 *   else in the switch pipeline ever calls it again.
 */
function setupCharacterSwitchHandler(onInitFailures, onBeforeSettingsLoad) {
    // One chain that every switch step is appended to, so no two ever overlap.
    let lifecycleChain = Promise.resolve();
    const enqueue = (step) => {
        lifecycleChain = lifecycleChain.then(step).catch((error) => {
            console.error('[FeatureRegistry] Character-switch lifecycle step failed:', error);
        });
        return lifecycleChain;
    };

    // Whether this chain has torn the feature layer down and not yet brought it
    // back up (`layerTornDown`, module scope so live starts can see it). Starts
    // false: at boot the layer is up (entrypoint initialises it before this
    // handler can ever fire), so the first switch of the session does a real
    // teardown.
    layerTornDown = false;

    // Cleanup phase
    dataManager.on('character_switching', () => {
        // Clear the config cache synchronously, before the chain awaits anything,
        // so nothing reads the previous character's settings in the gap.
        if (config && typeof config.clearSettingsCache === 'function') {
            config.clearSettingsCache();
        }
        // Returned, not merely enqueued.
        //
        // `character_switching` is data-manager's one awaited emit, and it is
        // awaited for a reason: it fires *before* `currentCharacterId` moves so
        // that a feature's disable() can persist the departing character's
        // state under the departing character's key, and data-manager must not
        // move the pointer until that has happened. Handing back only
        // `undefined` made the await a formality — the teardown was queued and
        // the pointer moved on the next microtask, so every disable() that
        // crossed an await before writing (a read-modify-write through
        // `readScoped`/`writeScoped` is the normal shape) evaluated
        // `characterKey()` against the *arriving* character and filed the
        // departing character's state under their key, overwriting whatever
        // they had.
        //
        // `enqueue` returns the chain as of this step, so this promise settles
        // when this teardown has run and not when later steps have — the emit
        // waits for the teardown it asked for, and no longer.
        return enqueue(async () => {
            // Mid-burst the layer is already down and every feature's disable()
            // is a no-op — a hundred of them per switch is the storm the old
            // rapid-switch guard was defending against. Skip, and let the
            // settling switch bring the layer back up for whoever is current.
            if (layerTornDown) return;
            layerTornDown = true;
            // Set first, so no pass or retry begins another start meanwhile
            await waitForInFlightStarts();
            await disableAllFeatures();
        });
    });

    // Re-initialization phase
    dataManager.on('character_switched', (data) => {
        const targetId = data?.newId ?? null;
        // Still the character this reinit is for? A newer switch updates
        // currentCharacterId synchronously, so a mismatch means this one is stale.
        const isStale = () => targetId !== null && dataManager.getCurrentCharacterId() !== targetId;

        enqueue(async () => {
            if (isStale()) return;
            // A newer switch is already under way. `currentCharacterId` has not
            // moved yet — it moves after the awaited `character_switching` — so
            // `isStale()` cannot see this one, and doing the work anyway would
            // be worse than wasted now that the newer switch's teardown waits
            // behind this step: `initializeFeatures()` refuses during a switch
            // regardless, so all this could contribute is a settings reload and
            // a settle delay holding up the character the player is actually
            // looking at. Leave `layerTornDown` set, so the switch that settles
            // is the one that brings the layer back up.
            if (dataManager.getIsCharacterSwitching()) return;

            // Offer a settings-mirror restore for the arriving character
            // before its own load, the same point the boot path offers one —
            // see the parameter doc above.
            if (typeof onBeforeSettingsLoad === 'function') {
                try {
                    await onBeforeSettingsLoad(
                        dataManager.getCurrentCharacterId(),
                        dataManager.getCurrentCharacterName()
                    );
                } catch (error) {
                    console.error('[FeatureRegistry] onBeforeSettingsLoad failed:', error);
                }
            }
            if (isStale()) return;

            // Load settings BEFORE any feature initialization so every feature
            // sees the new character's values (loadSettings reads the current id).
            await config.loadSettings();
            config.applyColorSettings();
            if (isStale()) return;

            // Small delay to let game state settle, then re-init with fresh settings
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (isStale()) return;

            const initFailures = await initializeFeatures();
            // The layer is up again for the character that is current now, so
            // the next switch owes a real teardown.
            layerTornDown = false;

            if (typeof onInitFailures === 'function') {
                onInitFailures(initFailures);
            }

            // A setting changed while the layer was down, or while this re-init
            // was running, was stood down for it and is picked up here.
            if (liveStartDeferredBySwitch) {
                liveStartDeferredBySwitch = false;
                scheduleLiveStart();
            }
        });
    });
}

/**
 * Whether a feature's gate is open right now.
 * @param {Object} feature - Registry entry
 * @returns {boolean} True when its customCheck (or its config switch) says it should run
 */
function isGateOpen(feature) {
    try {
        return Boolean(feature.customCheck ? feature.customCheck() : config.isFeatureEnabled(feature.key));
    } catch (error) {
        console.error(`[Toolasha] Enabled check for ${feature.name} threw:`, error);
        return false;
    }
}

/**
 * Whether a feature is up, as far as a live start is concerned.
 *
 * Normally: whether the registry has initialized it since the layer last came
 * up. An entry can answer for itself with `isRunning()` when its module stops
 * itself on its own setting but relies on the registry to start it again —
 * without that, the second switch-on of a session would find the key still
 * recorded as started and do nothing. A throwing `isRunning` counts as running:
 * starting a feature twice is worse than leaving one down until a reload.
 * @param {Object} feature - Registry entry
 * @returns {boolean} True when a live start should leave it alone
 */
function isFeatureRunning(feature) {
    if (typeof feature.isRunning !== 'function') return startedKeys.has(feature.key);
    try {
        return Boolean(feature.isRunning());
    } catch (error) {
        console.error(`[FeatureRegistry] isRunning for ${feature.name} threw:`, error);
        return true;
    }
}

/**
 * Whether a live start may initialize anything right now: startup has finished,
 * no switch batch is running, and no switch has the layer down.
 * @returns {boolean} True when it is safe to start a feature
 */
function liveStartAllowed() {
    return isStartupComplete() && !layerTornDown && !dataManager.getIsCharacterSwitching();
}

/**
 * Start every feature whose gate is open but which is not running, then stop
 * every `liveStop` feature whose gate has closed.
 *
 * Starting applies to every feature. Stopping is opt-in (`liveStop: true` on
 * the registry entry): a feature whose gate has closed is otherwise left to
 * its own module, which owns any teardown on its own keys — see
 * `runLiveStops`. Serial, in registry order, without the startup batch's
 * `concurrent` overlap — a pass normally starts or stops one feature. What
 * fails to start goes to the same recovery routine a startup failure does;
 * what fails to stop goes through `noteDisableFailure`, the same bookkeeping
 * a character switch's teardown uses.
 * @returns {Promise<void>}
 */
async function runLiveStarts() {
    const failures = [];

    for (const feature of featureRegistry) {
        // Rechecked per feature: a switch can begin while an earlier one awaits
        if (!liveStartAllowed()) {
            liveStartDeferredBySwitch = true;
            break;
        }
        if (startInFlight(feature.key) || isFeatureRunning(feature) || !isGateOpen(feature)) continue;

        startedKeys.add(feature.key);
        liveStartsInFlight.add(feature.key);
        const generation = teardownGeneration;
        try {
            await trackedInitialize(feature);
        } catch (error) {
            console.error(`[Toolasha] Failed to initialize ${feature.name} after a setting change:`, error);
            // Not reported once a teardown has outlived it: the recovery routine would
            // retry it into the arriving character, on top of that character's own start.
            if (generation === teardownGeneration) {
                failures.push({
                    key: feature.key,
                    name: feature.name,
                    reason: `Initialization threw: ${error?.message}`,
                });
            }
        } finally {
            liveStartsInFlight.delete(feature.key);
        }
    }

    if (failures.length > 0 && typeof liveStartFailureHandler === 'function') {
        liveStartFailureHandler(failures);
    }

    await runLiveStops();
}

/**
 * Stop every `liveStop` feature the registry started whose gate has since
 * closed.
 *
 * Only `startedKeys` — the registry's own bookkeeping — decides what counts
 * as started here, the same source `disableAllFeatures` reads; a feature with
 * an `isRunning` escape hatch (see `isFeatureRunning`) is not consulted, since
 * that hatch exists for modules that stop *themselves*, which is not this
 * feature's job. Runs under the same guards a start does: `liveStartAllowed()`
 * rechecked per feature so a character switch beginning mid-pass stands the
 * rest down for the switch's own teardown, and `liveStartsInFlight` so a
 * feature whose start has not settled yet is left alone until it has — the
 * next setting change re-evaluates it.
 * @returns {Promise<void>}
 */
async function runLiveStops() {
    for (const feature of featureRegistry) {
        if (!feature.liveStop) continue;
        if (!liveStartAllowed()) {
            liveStartDeferredBySwitch = true;
            break;
        }
        if (startInFlight(feature.key) || !startedKeys.has(feature.key) || isGateOpen(feature)) continue;

        startedKeys.delete(feature.key);
        try {
            const featureInstance = getFeatureInstance(feature.key);
            if (featureInstance && typeof featureInstance.disable === 'function') {
                await featureInstance.disable();
            }
        } catch (error) {
            noteDisableFailure(feature, error);
        }
    }
}

/**
 * Queue one live-start pass, coalescing every change made before it runs.
 *
 * Deferred to a microtask so settings saved together (a preset, a panel that
 * writes several keys) make one pass, and held until startup has finished: a
 * change made during startup is read by the startup batch itself, or by this
 * pass if the batch had already gone past the feature.
 * @returns {void}
 */
function scheduleLiveStart() {
    if (liveStartQueued) return;
    liveStartQueued = true;
    queueMicrotask(async () => {
        try {
            await whenStartupComplete();
            liveStartQueued = false;
            await runLiveStarts();
        } catch (error) {
            liveStartQueued = false;
            console.error('[FeatureRegistry] Live feature start failed:', error);
        }
    });
}

/**
 * Start features whose gate a setting change opens mid-session, and stop the
 * `liveStop` ones whose gate a change closes.
 *
 * The registry otherwise evaluates gates only at startup and on a character
 * switch, so a feature whose settings were all off at page load stayed off
 * until a reload however it was switched on — and, for the `liveStop` opt-in,
 * a feature switched off stayed running until a reload rather than tearing
 * down through its existing `disable()`. Installed once, by the entrypoint.
 * @param {Function} [onInitFailures] - Called with what a live start failed to
 *   bring up, shaped like `initializeFeatures()`'s return — the entrypoint passes
 *   the same health-check/retry/report routine boot and a switch use. A live
 *   stop's failure is not reported here; it goes through `noteDisableFailure`.
 * @returns {Function} Uninstall function
 */
function setupLiveFeatureStart(onInitFailures) {
    unregisterLiveStart?.();
    liveStartFailureHandler = onInitFailures ?? null;
    const offAnyChange = config.onAnySettingChange(() => scheduleLiveStart());
    // A whole-map reload fires no any-setting change, and not every reload is
    // followed by a re-init: a settings-mirror restore accepted after startup
    // replaces the map mid-session. During a switch or at boot the pass stands
    // down or waits, and the re-init covers it.
    const offLoaded =
        typeof config.onSettingsLoaded === 'function' ? config.onSettingsLoaded(() => scheduleLiveStart()) : null;
    unregisterLiveStart = () => {
        offAnyChange?.();
        offLoaded?.();
    };
    return () => {
        unregisterLiveStart?.();
        unregisterLiveStart = null;
        liveStartFailureHandler = null;
    };
}

/**
 * Get feature instance from imported module
 * @param {string} key - Feature key
 * @returns {Object|null} Feature instance or null
 * @private
 */
function getFeatureInstance(key) {
    const feature = getFeature(key);
    if (!feature) {
        return null;
    }

    return feature.module || feature;
}

/**
 * Retry initialization for specific features
 *
 * Reports back what is still broken afterwards, so a caller can tell the
 * difference between a feature that recovered on the second attempt — the
 * common case, where the game panel it anchors to had not been drawn yet — and
 * one that is genuinely not coming up. Only the second is worth interrupting
 * anybody about.
 *
 * @param {Array<Object>} failedFeatures - Array of failed feature objects
 * @returns {Promise<Array<{key: string, name: string, reason: string}>>} Those still failing — none
 *   once a character switch's teardown has run during the retry
 */
async function retryFailedFeatures(failedFeatures) {
    const stillFailed = [];
    const generation = teardownGeneration;

    for (const failed of failedFeatures) {
        // A switch starting inside this retry's delay (retryFailedFeatures is
        // always called from a setTimeout, so there is a window for one) must
        // not initialize features into a character that is already on its way
        // out — the same guard initializeFeatures applies.
        // `layerTornDown` covers the settle window after a switch's teardown,
        // where the switching flag has already dropped but the re-init has not run.
        // A teardown that outlived an earlier retry here (see `waitForInFlightStarts`)
        // ends the list too: it is the departing character's, and the arriving one's
        // re-init has started — and reported — its own features already.
        if (dataManager.getIsCharacterSwitching() || layerTornDown || generation !== teardownGeneration) break;

        const feature = getFeature(failed.key);
        if (!feature) continue;
        // Switched off since it failed (a live stop may already have disabled
        // it), or being brought up by a live start: a retry here would leave it
        // running outside `startedKeys`, where no later stop can reach it.
        if (startInFlight(feature.key) || !isGateOpen(feature)) continue;

        startedKeys.add(feature.key);
        liveStartsInFlight.add(feature.key);
        try {
            await trackedInitialize(feature);

            // Verify the retry actually worked by running health check
            if (feature.healthCheck) {
                const healthResult = feature.healthCheck();
                if (healthResult === false) {
                    console.warn(`[Toolasha] ${feature.name} retry completed but health check still fails`);
                    stillFailed.push({
                        key: feature.key,
                        name: feature.name,
                        reason: 'Retried, but its health check still fails',
                    });
                }
            }
        } catch (error) {
            console.error(`[Toolasha] ${feature.name} retry failed:`, error);
            stillFailed.push({
                key: feature.key,
                name: feature.name,
                reason: `Retry threw: ${error.message}`,
            });
        } finally {
            liveStartsInFlight.delete(feature.key);
        }
        // A stop pass that ran during the retry skipped it as in flight
        if (!isGateOpen(feature)) scheduleLiveStart();
    }

    // Failures of a character already torn down are nobody's to report
    return generation === teardownGeneration ? stillFailed : [];
}

/**
 * Replace the feature registry (for library split)
 * @param {Array} newFeatures - New feature registry array
 */
function replaceFeatures(newFeatures) {
    featureRegistry.length = 0; // Clear existing array
    featureRegistry.push(...newFeatures); // Add new features
}

export default {
    initializeFeatures,
    isStartupComplete,
    whenStartupComplete,
    disableAllFeatures,
    getDisableFailures,
    setupCharacterSwitchHandler,
    setupLiveFeatureStart,
    checkFeatureHealth,
    retryFailedFeatures,
    getFeature,
    getAllFeatures,
    replaceFeatures,
    getFeaturesByCategory,
};
