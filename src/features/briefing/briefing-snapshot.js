/**
 * Briefing snapshot
 *
 * What needed a character at the moment you left it.
 *
 * `briefing-lines.js` answers "what needs me" for whoever is logged in, and
 * `session-briefing.js` collects the facts it answers from. Neither can say a
 * word about the other four characters on the account, because nothing in the
 * browser can: the game tells this tab about exactly one character, and every
 * reader those two modules use is reading that one character's live data.
 *
 * The one instant at which an *alt's* data is live is the instant you switch
 * away from it. `queue-snapshot.js` has taken that instant for the action queue
 * for a long time and the account panel has been reading it back ever since;
 * this is the same trick for the rest of the briefing's subjects. Data-manager
 * emits `character_switching` before it moves the character pointer and awaits
 * the listeners, so a listener registered here reads the departing character's
 * facts and files them under the departing character's id.
 *
 * ## What is left out
 *
 * A fact that cannot be gathered honestly at that instant is simply not
 * gathered, and the engine already treats an absent fact as a subject with
 * nothing to say — so an omission costs its own line and nothing else.
 *
 * - **The action queue.** Already snapshotted, already read back, and already
 *   drawn beside this section by the account panel's character table. A second
 *   copy would be the same sentence twice on one panel.
 * - **Community buffs.** Server-wide. One buff ending would produce the
 *   identical line under every character's name.
 * - **The free reroll.** `readFreeRerollOffer` reads an open reroll chooser out
 *   of the DOM, and nobody has one open at the moment they switch characters —
 *   it would answer "cannot tell" every time, which is not a fact.
 * - **Idle characters.** A fact about the *other* characters, which inside a
 *   per-character snapshot is a category error, and the account panel is the
 *   thing that answers it anyway.
 * - **Unread notices.** The script's own inbox, counted against the reader
 *   rather than against a character. It is already reported once, live.
 *
 * ## Why the id is captured first
 *
 * Every fact below is read synchronously, before the first `await`. Nothing in
 * this module evaluates `getCurrentCharacterId()` at all — the departing id
 * arrives on the event and is closed over — which is the shape the repeated
 * "wrote the departing character's state under the arriving character's key"
 * bug does not have (see `core/character-switch-ordering.test.js`).
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { forecastTaskSlots, countActiveTasks } from '../tasks/task-slot-forecast.js';
import { soonestCombatConsumable } from '../notifications/combat-consumable-alerts.js';
import { forecastLabyrinthEntries } from '../notifications/labyrinth-entry-forecast.js';
import enhancementTracker from '../enhancement/enhancement-tracker.js';
import { enhancementFact, labyrinthFact, readGuildTrial, undercutCount } from './session-briefing.js';

/** Where a per-character snapshot lives, `settings` store */
export const SNAPSHOT_PREFIX = 'briefingSnapshot_';

/** The store it lives in — the same one the listing baseline uses */
export const SNAPSHOT_STORE = 'settings';

/** Long enough for any name the game allows, short enough to bound the record */
const MAX_NAME_CHARS = 48;

/**
 * A stored snapshot may not exceed this, serialized.
 *
 * Nothing below can plausibly reach it — the facts are a handful of numbers and
 * two item names — so this is a guard against a future fact arriving with a
 * whole inventory attached rather than a budget anybody is spending. Past it,
 * only the two facts that are certainly small are kept.
 */
export const MAX_SNAPSHOT_CHARS = 2000;

/** The facts a snapshot may carry, and therefore the ones the panel may show */
export const SNAPSHOT_FACT_KEYS = [
    'tasksReady',
    'taskSlots',
    'consumable',
    'listings',
    'enhancement',
    'guild',
    'labyrinth',
];

/** The two that are a number and a small object, kept when the cap is hit */
const CHEAPEST_FACT_KEYS = ['tasksReady', 'taskSlots'];

/**
 * A name, bounded.
 * @param {*} value - Whatever the game called it
 * @returns {string|null} A short string, or null
 */
function shortName(value) {
    if (typeof value !== 'string' || value === '') return null;
    return value.length > MAX_NAME_CHARS ? value.slice(0, MAX_NAME_CHARS) : value;
}

/**
 * Read a fact, and treat a failure as "nothing to say about this subject".
 *
 * The same rule `session-briefing.js` applies, and it matters more here: this
 * runs during a character switch, at which point feature-registry has already
 * called `disable()` on every feature, so a reader that keeps its answer in a
 * feature singleton may legitimately have nothing left to give.
 *
 * @param {string} subject - What was being read, for the log
 * @param {Function} read - The reader
 * @returns {*} What it returned, or null
 */
function attempt(subject, read) {
    try {
        return read();
    } catch (error) {
        console.error(`[BriefingSnapshot] Could not read ${subject}:`, error);
        return null;
    }
}

/**
 * Everything worth recording about the character being left, right now.
 *
 * Trimmed to the fields the lines actually read rather than stored whole: a
 * task forecast carries a dozen intermediate values, and a record that keeps
 * them invites a future line to read one and quietly become uncacheable.
 *
 * Every reader is injectable, because the point of this function is the
 * selection and the trimming, and neither needs a game behind it.
 *
 * @param {string|null} characterId - The DEPARTING character, captured by the caller
 * @param {number} now - Epoch ms
 * @param {Object} [sources] - Readers, for tests
 * @returns {Object} Facts for `buildBriefingLines`, with absent subjects left out
 */
export function gatherSnapshotFacts(characterId, now, sources = {}) {
    const {
        characterInfo = () => dataManager.characterData?.characterInfo,
        quests = () => dataManager.characterQuests,
        consumable = soonestCombatConsumable,
        undercut = undercutCount,
        enhancement = () => enhancementTracker.getCurrentSession?.(),
        guild = readGuildTrial,
        labyrinth = forecastLabyrinthEntries,
        taskSlots = forecastTaskSlots,
    } = sources;

    const info = attempt('the character info', characterInfo);
    const facts = {};

    const ready = Math.max(0, Math.floor(Number(info?.unreadTaskCount) || 0));
    if (ready > 0) facts.tasksReady = ready;

    const board = attempt('the task board', () =>
        taskSlots({ characterInfo: info, activeTaskCount: countActiveTasks(attempt('the quests', quests)), now })
    );
    if (board?.ok) {
        facts.taskSlots = {
            ok: true,
            isFull: Boolean(board.isFull),
            msUntilFull: board.msUntilFull,
            msUntilWaste: board.msUntilWaste,
        };
    }

    const drink = attempt('the consumable forecast', consumable);
    if (drink && Number.isFinite(drink.secondsLeft)) {
        facts.consumable = { name: shortName(drink.name), secondsLeft: drink.secondsLeft };
    }

    // Only the beaten count, and only when the watcher has actually compared
    // something. The "filled since you were last here" figure the live briefing
    // shows is a delta against the *previous session*, which is a sentence
    // about the reader's history rather than about this character, and storing
    // one would have it read back as a state.
    const beaten = attempt('the undercut listings', undercut);
    if (Number.isFinite(beaten) && beaten > 0) facts.listings = { filled: 0, undercut: beaten };

    const run = attempt('the enhancement session', () => enhancementFact(enhancement(), now));
    if (run?.itemName) facts.enhancement = { ...run, itemName: shortName(run.itemName) };

    const trial = attempt('the guild trial signup', () => guild(characterId));
    if (trial && trial.signedUp !== null && trial.signedUp !== undefined) {
        facts.guild = { signedUp: Boolean(trial.signedUp), trialName: shortName(trial.trialName) };
    }

    const maze = attempt('the labyrinth entries', () => labyrinthFact(labyrinth({ characterInfo: info, now })));
    if (maze) facts.labyrinth = maze;

    return capFacts(facts);
}

/**
 * Keep the record small enough that a hundred switches cost nothing.
 * @param {Object} facts - Gathered facts
 * @returns {Object} The same facts, or only the cheap ones
 */
export function capFacts(facts) {
    let serialized = '';
    try {
        serialized = JSON.stringify(facts) || '';
    } catch (error) {
        console.error('[BriefingSnapshot] Facts would not serialize:', error);
        return {};
    }
    if (serialized.length <= MAX_SNAPSHOT_CHARS) return facts;

    console.warn(`[BriefingSnapshot] Facts too large (${serialized.length} chars); keeping the small ones`);
    const kept = {};
    for (const key of CHEAPEST_FACT_KEYS) {
        if (facts[key] !== undefined) kept[key] = facts[key];
    }
    return kept;
}

/**
 * Where one character's snapshot lives.
 * @param {string} characterId - Whose
 * @returns {string} Storage key
 */
export function snapshotKey(characterId) {
    return `${SNAPSHOT_PREFIX}${characterId}`;
}

/**
 * The snapshots among a batch of `settings` keys.
 *
 * Handed the key list the account read already has, so enumerating the account's
 * briefings costs no extra key scan — only the reads for keys that exist.
 *
 * @param {Array<string>} settingsKeys - Every key in the settings store
 * @returns {Promise<Object<string, Object>>} Character id → snapshot
 */
export async function readSnapshotsFromKeys(settingsKeys) {
    const byId = {};
    for (const key of settingsKeys || []) {
        if (typeof key !== 'string' || !key.startsWith(SNAPSHOT_PREFIX)) continue;
        const id = key.slice(SNAPSHOT_PREFIX.length);
        if (!id) continue;
        try {
            const snapshot = await storage.get(key, SNAPSHOT_STORE, null);
            if (snapshot && Number.isFinite(snapshot.at)) byId[id] = snapshot;
        } catch (error) {
            console.error(`[BriefingSnapshot] Could not read ${key}:`, error);
        }
    }
    return byId;
}

/** Whether the switching listener is already on */
let listening = false;

/**
 * Record the departing character's facts.
 *
 * An empty gather is written rather than skipped: "nothing needed this
 * character when you left it" is an answer, and a stale record left in place
 * because the fresh one was empty would be a worse one.
 *
 * @param {{oldId: string, oldName: string}} event - From `character_switching`
 * @returns {Promise<void>} Resolves once the record has landed
 */
export async function recordSwitchSnapshot(event) {
    try {
        // Both captured before anything can await, and never re-read from
        // dataManager afterwards — see the module note
        const characterId = event?.oldId;
        const characterName = shortName(event?.oldName);
        if (!characterId) return;

        const at = Date.now();
        const facts = gatherSnapshotFacts(characterId, at);

        await storage.set(snapshotKey(characterId), { characterId, characterName, at, facts }, SNAPSHOT_STORE, true);
    } catch (error) {
        console.error('[BriefingSnapshot] Failed to record a snapshot:', error);
    }
}

/**
 * Start listening, once.
 *
 * Registered once and never removed, for the reason `queue-snapshot.js` gives:
 * feature-registry disables every feature during `character_switching`, so a
 * listener removed on disable would be gone before the switch it exists for.
 *
 * @returns {void}
 */
export function initializeBriefingSnapshots() {
    if (listening) return;
    listening = true;
    dataManager.on('character_switching', recordSwitchSnapshot);
}

/** Test-only: forget that the listener was registered. */
export function _resetBriefingSnapshotListener() {
    listening = false;
}
