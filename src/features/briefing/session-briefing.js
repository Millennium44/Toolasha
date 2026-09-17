/**
 * Session briefing
 *
 * One card, on arrival, answering "what needs me right now".
 *
 * Everything on it is already known somewhere: the queue monitor measures the
 * queue, the task forecast the board, the consumable forecast the drinks, the
 * undercut alerts the listings. What none of them can do is meet you at the
 * door. They are all *watchers* — they fire when something changes while you
 * are here — and the one moment they are structurally unable to cover is the
 * moment you were not here to be told. A player who logs in after eight hours
 * away arrives to a page that has nothing to say about those eight hours, and
 * has to go looking through six panels to reconstruct them.
 *
 * So this reads the same sources at the one moment they are all interesting at
 * once, and shows only the ones with something to say. It computes nothing of
 * its own: every figure below is a store read or a call into the module that
 * already owns that arithmetic, which is what keeps a card that appears on
 * every login from costing anything on every login.
 *
 * ## Why it is not a notification
 *
 * The notification service is edge-triggered by design — it says what *changed*
 * — and eight hours away is not an edge, it is a gap. Replaying eight hours of
 * missed edges as eight toasts would be worse than the silence it replaces.
 * A digest read once, on arrival, is the right shape.
 *
 * ## Where it appears, and why it has no panel
 *
 * Inside the game's own "Welcome Back!" offline-progress modal, as a section
 * appended to the bottom of it — not in a floating card of its own.
 *
 * It used to be its own draggable panel, and the complaint about that was not
 * about the content: it was that arriving after a night away meant dismissing
 * two things, the game's modal and then ours, every single time. The modal is
 * already the game's way of saying "here is what happened while you were gone",
 * which is the same sentence this feature exists to finish. Putting the briefing
 * in it means the arrival has exactly one thing to close, and closing it closes
 * everything.
 *
 * The price is deliberate and accepted: **no modal, no briefing.** A character
 * switch does not produce one, and neither does an absence too short for the
 * game to count. There is no fallback panel and no setting to bring one back —
 * a second surface is the thing being removed, and half-removing it would leave
 * the double dismissal in exactly the cases that provoked this.
 *
 * ## Two signals, either order
 *
 * The modal's appearance is a game DOM insertion and the facts become readable
 * on Toolasha's own `character_switched`; nothing synchronises them, and either
 * can land first. So both sides meet in the middle: a modal seen before the
 * facts are ready is held (`pendingModal`) and filled in when they arrive, a
 * dialog already open when this feature starts is found by looking rather than
 * listening (`currentWelcomeBackModal`), and
 * facts that were ready first are drawn the moment a modal appears. Nothing is
 * drawn from a half-read store — an unknown figure is left off the line rather
 * than printed as zero, which is `undercutCount()`'s rule and the reason it
 * returns null instead of 0.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { currentWelcomeBackModal, onWelcomeBackModal } from '../../utils/welcome-back-modal.js';
import { formatRelativeTime } from '../../utils/formatters.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { navigateToAction } from '../../utils/item-navigation.js';
import { buildBriefingLines } from './briefing-lines.js';
import { computeAwayDiff, markAwayDiffSeen } from './away-diff.js';
import { queueTimeLeft } from '../queue-monitor/queue-time-row.js';
import queueSnapshot from '../queue-monitor/queue-snapshot.js';
import { forecastTaskSlots, countActiveTasks } from '../tasks/task-slot-forecast.js';
import { readFreeRerollOffer } from '../tasks/task-reroll-options.js';
import { soonestCombatConsumable } from '../notifications/combat-consumable-alerts.js';
import { forecastLabyrinthEntries } from '../notifications/labyrinth-entry-forecast.js';
import { newlyIdleCharacters } from '../notifications/notification-predicates.js';
// Soft coupling: the briefing reports the notice log's unread count and links
// to its panel, but never writes to it and works fine if the count throws.
import { unreadNoticeCount } from '../notifications/notice-log.js';
import { noticePanel } from '../notifications/notice-log-panel.js';
import marketUndercutAlerts from '../notifications/market-undercut-alerts.js';
import enhancementTracker from '../enhancement/enhancement-tracker.js';
import { guildXpTracker, consumablesPanel } from '../../utils/bundle-bridge.js';

/** The setting that turns the whole thing on */
export const MASTER_SETTING = 'sessionBriefing';

/** The mark the section leaves, so a redraw does not stack a second one */
export const SECTION_CLASS = 'toolasha-session-briefing';

/** Where the previous session's listing snapshot lives */
const LISTING_BASELINE_PREFIX = 'sessionBriefingListings_';

/** A current enhancement session whose last attempt is older than this is a stopped run, not news */
const ENHANCEMENT_STALE_MS = 60 * 60 * 1000;

/**
 * Telling a refresh from a return
 *
 * A briefing is a digest of a gap, and sixty seconds is not a gap. Reloading to
 * pick up a build, or recovering from a disconnect, used to pop the card back up
 * over facts the player had finished reading seconds earlier, and moving into
 * the game's modal does not settle that question: the game decides whether to
 * show an offline-progress dialog on its own terms — how much it produced while
 * the socket was shut — which is not the same question as whether the player has
 * already read this. A refresh's userscript-load-and-reconnect stretch runs
 * 10-25 s, so the gap between "this character's page was alive" and "it is alive
 * again" is the only signal that survives the reload to tell the two apart.
 *
 * The stamp lives in its own key, per character, in the same `settings` store as
 * everything else here — deliberately not the snapshot `briefing-snapshot.js`
 * writes on `character_switching`, which answers a different question ("what did
 * this character's board look like when I left it") and is what `away-diff.js`
 * builds its own baseline from. Reusing that key for this would mean a quick
 * refresh silently dragging the away-diff's baseline forward, so a genuine
 * absence right after would report a shorter gap than the player actually had.
 * Keeping the two stamps apart is what keeps that baseline honest across a
 * skipped quick refresh: nothing here ever touches `briefingSnapshot_*` or
 * `briefingAwayDiffSeen_*`.
 *
 * A write started from `pagehide` may never finish — the tab can be gone before
 * the transaction commits — so the periodic tick below bounds the loss instead
 * of relying on that write landing.
 */

/** A character whose page was alive this recently is being refreshed, not returned to */
export const QUICK_REFRESH_WINDOW_MS = 60_000;

/** At most one heartbeat write per this interval while the tab is open and visible */
const PRESENCE_HEARTBEAT_MS = 12_000;

/** Where the last moment a character's page was known to be alive lives, per character */
const PRESENCE_PREFIX = 'sessionBriefingLastAlive_';

/**
 * The presence key for one character.
 * @param {string} characterId - Whose
 * @returns {string} Storage key
 */
function presenceKey(characterId) {
    return `${PRESENCE_PREFIX}${characterId}`;
}

/**
 * Stamp a character's page as alive right now, best-effort.
 *
 * Fire-and-forget rather than awaited: the unload listeners below call this
 * synchronously from `pagehide`/`beforeunload`, where there is no time left to
 * wait on a promise, and a failed stamp is worth logging, not surfacing.
 *
 * @param {string|null} [characterId] - Defaults to whoever is current right now
 * @returns {void}
 */
function recordPresence(characterId = currentCharacterId()) {
    if (!characterId || !config.getSetting(MASTER_SETTING, true)) return;
    storage.set(presenceKey(characterId), Date.now(), 'settings', true).catch((error) => {
        console.error('[SessionBriefing] Could not record this character as alive:', error);
    });
}

/**
 * Whether this arrival is a refresh of `characterId` rather than a return to it.
 *
 * @param {string|null} characterId - Captured by the caller before this read
 * @param {number} [now] - Clock, injectable for tests
 * @returns {Promise<boolean>} Whether the page was alive for this character inside the window
 */
async function wasAliveRecently(characterId, now = Date.now()) {
    if (!characterId) return false;
    try {
        const lastAlive = await storage.get(presenceKey(characterId), 'settings', null);
        // The pointer may have moved on while this read was in flight — a
        // character switch is not a refresh of whoever is arriving now, and an
        // answer about a character that is no longer arriving is not an answer
        // about this arrival at all
        if (characterId !== currentCharacterId()) return false;
        return Number.isFinite(lastAlive) && now - lastAlive < QUICK_REFRESH_WINDOW_MS;
    } catch (error) {
        console.error('[SessionBriefing] Could not read whether this character was alive recently:', error);
        return false;
    }
}

/** This feature's own timer, for the presence heartbeat */
const presenceTimers = createTimerRegistry();

/** Whether the heartbeat interval and unload listeners have been installed */
let presenceStarted = false;

/**
 * Start stamping "still here" — once, ever.
 *
 * Never torn down on `cleanup()`, for the reason `initializeBriefingSnapshots()`
 * gives its own listener: `cleanup()` runs on every character switch, and a
 * listener that exists to catch the *tab* going away must survive every switch
 * that happens before that.
 *
 * @returns {void}
 */
function startPresenceHeartbeat() {
    if (presenceStarted) return;
    presenceStarted = true;

    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', () => recordPresence(), true);
        window.addEventListener('beforeunload', () => recordPresence(), true);
    }
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') recordPresence();
        });
    }

    presenceTimers.registerInterval(
        setInterval(() => {
            // The unload listeners above already cover the transition to hidden;
            // this tick only needs to bound the gap while the tab stays visible
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            recordPresence();
        }, PRESENCE_HEARTBEAT_MS),
        'sessionBriefingPresence'
    );
}

/**
 * What the market did between the last session and this one.
 *
 * Computed once, at initialize, against a snapshot persisted when the previous
 * session started — and then held, because "since you were last here" must not
 * quietly become "since fifteen seconds ago" on the next redraw.
 * @type {{filled: number}|null}
 */
let listingDelta = null;

/**
 * What changed about this character since it was last switched away from.
 *
 * Computed once, on arrival, and then held for the same reason `listingDelta`
 * is: a diff recomputed every fifteen seconds against a moving `now` would go on
 * shifting its own wording ("ran dry at 14:20" is stable, but the transitions
 * around it are not), and a card whose sentences change while you read them is
 * not a card about the past.
 *
 * Null means one of three silences — no snapshot, already read, or nothing
 * differed — and the card draws in none of them. See `away-diff.js`.
 * @type {{at: number, lines: Array<Object>}|null}
 */
let awayDiff = null;

/**
 * A welcome modal that turned up before the facts did.
 *
 * Held rather than drawn into, and drawn into the moment `initialize()` finishes
 * gathering. Released as soon as it is used, so a dismissed modal is not kept
 * alive by this reference.
 * @type {HTMLElement|null}
 */
let pendingModal = null;

/** Whether `initialize()` has finished gathering this arrival's facts */
let factsReady = false;

/** Whether this arrival is a quick refresh, and so gets no section */
let suppressed = false;

/** Unregisters the modal watcher, or null when it is not installed */
let unwatchModal = null;

/** Whether this arrival's away diff has been marked read */
let awayDiffMarked = false;

/**
 * The current character, or null before the game has said.
 * @returns {string|null} Character id
 */
function currentCharacterId() {
    try {
        return dataManager.getCurrentCharacterId?.() || null;
    } catch (error) {
        console.error('[SessionBriefing] Could not read the current character:', error);
        return null;
    }
}

/**
 * Run a reader, and treat a failure as "nothing to say about this subject".
 *
 * Every fact below comes from a different feature, and a feature that is
 * switched off, mid-switch or newly broken must cost its own line and no more.
 * @param {string} subject - What was being read, for the log
 * @param {Function} read - The reader
 * @returns {any} What it returned, or null
 */
function attempt(subject, read) {
    try {
        return read();
    } catch (error) {
        console.error(`[SessionBriefing] Could not read ${subject}:`, error);
        return null;
    }
}

/**
 * When this character's queue ran out, if it has.
 *
 * The snapshot is taken as a character is switched *away* from, so it is the
 * only record of a queue that emptied while nobody was watching. Projected
 * rather than observed: the queue held so many seconds at the moment of the
 * switch, so it ended that many seconds later.
 *
 * @param {string|null} characterId - Who to ask about
 * @param {number} now - Epoch ms
 * @returns {number|null} When it emptied, or null when it has not or cannot be said
 */
function queueEmptySince(characterId, now) {
    if (!characterId) return null;
    const snapshot = queueSnapshot.getSnapshot?.(characterId);
    if (!snapshot || snapshot.hasInfiniteAction || !snapshot.timestamp) return null;

    const emptiedAt = snapshot.timestamp + (Number(snapshot.totalQueueSeconds) || 0) * 1000;
    return emptiedAt <= now ? emptiedAt : null;
}

/**
 * Community buffs and when they lapse.
 * @returns {Array<{name: string, expiresAt: number}>} Live buffs with a parseable expiry
 */
function readCommunityBuffs() {
    const buffs = dataManager.characterData?.communityBuffs;
    if (!Array.isArray(buffs)) return [];

    const detailMap = dataManager.getInitClientData?.()?.communityBuffTypeDetailMap;
    return buffs
        .filter((buff) => buff && !buff.isDone)
        .map((buff) => ({
            name:
                detailMap?.[buff.hrid]?.name ||
                String(buff.hrid || '')
                    .split('/')
                    .pop() ||
                'A buff',
            expiresAt: Date.parse(buff.expireTime ?? ''),
        }))
        .filter((buff) => Number.isFinite(buff.expiresAt));
}

/**
 * How many active listings are currently beaten.
 *
 * Read off the undercut watcher's own state rather than recomputed: it has
 * already compared every listing against the market, and a second comparison
 * here would mean a second set of price fetches for an answer that is sitting
 * in a Map. `armed: false` is exactly "this listing has been reported beaten
 * and not repriced since".
 *
 * An empty map is *unknown*, not zero. The briefing is built at login, which
 * is generally before the watcher's first pass has compared anything — reading
 * an unpopulated map as "no listings are undercut" prints a reassurance nobody
 * checked. Null omits the figure and the next refresh picks it up.
 *
 * @returns {number|null} Beaten listings, or null when the watcher has not run
 */
export function undercutCount() {
    const states = marketUndercutAlerts?.listingStates;
    if (!states || typeof states.values !== 'function') return null;
    if (typeof states.size === 'number' && states.size === 0) return null;
    let beaten = 0;
    for (const state of states.values()) {
        if (state?.armed === false) beaten += 1;
    }
    return beaten;
}

/**
 * The listing snapshot key for one character.
 * @param {string} characterId - Whose listings
 * @returns {string} Storage key
 */
function listingBaselineKey(characterId) {
    return `${LISTING_BASELINE_PREFIX}${characterId}`;
}

/**
 * Reduce the listing list to the little that the next session needs.
 * @param {Array<Object>} listings - `dataManager.getMarketListings()`
 * @returns {Object} id → status
 */
function listingFingerprint(listings) {
    const fingerprint = {};
    for (const listing of listings) {
        if (listing?.id === undefined || listing?.id === null) continue;
        fingerprint[listing.id] = listing.status || '';
    }
    return fingerprint;
}

/**
 * One listing's stored status, from either fingerprint shape.
 *
 * A short-lived version stored an object per listing so that expiries could be
 * a delta; those baselines are still on disk, and a session that read one as a
 * string would see no status at all and report the whole board as newly filled.
 *
 * @param {Object|null} baseline - The stored fingerprint
 * @param {string|number} id - The listing
 * @returns {string} The status stored for it, or `''`
 */
function baselineStatus(baseline, id) {
    const entry = baseline?.[id];
    if (entry && typeof entry === 'object') return entry.status || '';
    return entry || '';
}

/**
 * What changed about the listings since the last session, and record this one.
 *
 * Only a *new* filled status counts. A listing that was already filled when the
 * last session ended was reported then; reporting it every login until the
 * coins are claimed would make the line permanent and therefore invisible.
 *
 * @param {string|null} characterId - Whose listings
 * @returns {Promise<void>}
 */
async function loadListingDelta(characterId) {
    listingDelta = null;
    if (!characterId) return;

    try {
        const key = listingBaselineKey(characterId);
        const baseline = (await storage.get(key, 'settings', null))?.listings || null;
        const listings = dataManager.getMarketListings?.() || [];

        // Expiries are deliberately not counted here. The only list this can
        // read is `getMarketListings()`, and `mergeMarketListings` drops
        // expired listings the moment the game reports them, so an expiry
        // never reaches this loop — the count was structurally zero. The
        // listing-age log does keep expired entries, but it only learns of an
        // expiry from the marketplace's own My Listings table, which nobody
        // has opened at login; a listing that expired while you were away is
        // reconciled to 'unknown' there, indistinguishable from a cancel. So
        // there is no source for "expired since you were last here".
        let filled = 0;
        for (const listing of listings) {
            if (!listing) continue;
            if (
                listing.status === '/market_listing_status/filled' &&
                baselineStatus(baseline, listing.id) !== '/market_listing_status/filled'
            )
                filled += 1;
        }

        listingDelta = { filled };
        // The fresh baseline is for the NEXT session's comparison; awaiting
        // its debounced write here blocked feature init for three seconds
        storage.set(key, { at: Date.now(), listings: listingFingerprint(listings) }, 'settings');
    } catch (error) {
        console.error('[SessionBriefing] Could not compare listings against the last session:', error);
    }
}

/**
 * Everything the briefing might mention, read from the stores that already
 * hold it.
 *
 * @param {number} [now] - Clock, injectable for tests
 * @returns {Object} Facts for {@link buildBriefingLines}
 */
export function collectFacts(now = Date.now()) {
    const characterId = currentCharacterId();
    const characterInfo = dataManager.characterData?.characterInfo;

    const queue = attempt('the action queue', () => queueTimeLeft());
    const taskSlots = attempt('the task board', () =>
        forecastTaskSlots({
            characterInfo,
            activeTaskCount: countActiveTasks(dataManager.characterQuests),
            now,
        })
    );

    return {
        queue: queue ? { ...queue, emptySince: queueEmptySince(characterId, now) } : null,
        tasksReady: Math.max(0, Math.floor(Number(characterInfo?.unreadTaskCount) || 0)),
        taskSlots,
        rerolls: attempt('the reroll offer', () => readFreeRerollOffer()),
        buffs: attempt('the community buffs', () => readCommunityBuffs()) || [],
        consumable: attempt('the consumable forecast', () => soonestCombatConsumable()),
        listings: {
            filled: listingDelta?.filled || 0,
            // Null rather than zero when the watcher has not compared anything
            // yet; the line leaves the figure out instead of claiming none
            undercut: attempt('the undercut listings', () => undercutCount()) ?? null,
        },
        enhancement: attempt('the enhancement session', () =>
            enhancementFact(enhancementTracker.getCurrentSession?.(), now)
        ),
        guild: attempt('the guild trial signup', () => readGuildTrial(characterId)),
        labyrinth: attempt('the labyrinth entries', () =>
            labyrinthFact(forecastLabyrinthEntries({ characterInfo, now }))
        ),
        idle: attempt('the other characters', () =>
            newlyIdleCharacters(queueSnapshot.getOtherCharacterSnapshots?.() || [], now, new Map())
        ),
        notices: attempt('the notice log', () => unreadNoticeCount()) || 0,
    };
}

/**
 * An enhancement session as the briefing wants it, or nothing.
 *
 * The tracker only closes a session when a DIFFERENT enhancement starts —
 * simply stopping leaves it "current" for ever, and the briefing was still
 * announcing a run from weeks ago. An attempt lands every few seconds while
 * enhancing actually runs, so a last-attempt stamp older than an hour is a
 * stopped run, not news.
 *
 * Exported because the account snapshot writer needs the same judgement about
 * the departing character, and two copies of an hour would drift.
 *
 * @param {Object|null} session - `enhancementTracker.getCurrentSession()`
 * @param {number} now - Epoch ms
 * @returns {Object|null} The fact, or null when there is no live run
 */
export function enhancementFact(session, now) {
    if (!session) return null;
    const lastTouch = session.lastUpdateTime || session.startTime || 0;
    if (session.state !== 'tracking' || now - lastTouch > ENHANCEMENT_STALE_MS) return null;
    return {
        itemName: session.itemName,
        currentLevel: session.currentLevel,
        targetLevel: session.targetLevel,
        protectionsUsed: session.protectionCount || 0,
    };
}

/**
 * The labyrinth forecast as the briefing wants it.
 *
 * The forecast's own `available` is a boolean — "is the next entry due" — and
 * the line wants the number of banked entries, which the forecast calls
 * `entries`. Handed the boolean, the line printed "true available" and "true —
 * capped", and did so for every character with a cooldown that had elapsed.
 *
 * @param {Object|null} forecast - `forecastLabyrinthEntries()`
 * @returns {Object|null} `{ok, available, isFull}`, or null
 */
export function labyrinthFact(forecast) {
    if (!forecast?.ok) return null;
    return { ok: true, available: forecast.entries, isFull: Boolean(forecast.isFull) };
}

/**
 * Whether this character signed up for a trial this week.
 *
 * Reached through the namespace rather than imported: the guild tracker is a
 * combat-bundle singleton, and importing it would give this bundle a second,
 * empty copy that answers "not signed up" to everything.
 *
 * @param {string|null} characterId - Who to ask about
 * @returns {{signedUp: boolean, trialName: string|null}|null} Null when it cannot be said
 */
export function readGuildTrial(characterId) {
    const tracker = guildXpTracker();
    if (!tracker || !characterId) return null;

    const meta = tracker.getMemberMeta?.(characterId);
    if (!meta) return null;

    // A signup from a previous week is not a signup; the tracker stamps the
    // week it was seen in so a stale one can be told apart from none
    const weekStart = tracker.getCurrentWeekStartAt?.();
    if (weekStart && meta.signupWeekStartAt && meta.signupWeekStartAt !== weekStart) {
        return { signedUp: false, trialName: null };
    }

    const hrid = meta.signedUpCombatTrialHrid || meta.signedUpSkillingTrialHrid || null;
    if (!hrid) return { signedUp: false, trialName: null };
    return { signedUp: true, trialName: String(hrid).split('/').pop() || null };
}

/**
 * Click the game's own navigation button by the icon it carries.
 * @param {string} ariaLabel - The svg's aria-label
 * @returns {boolean} Whether one was found and clicked
 */
function clickNav(ariaLabel) {
    const navs = document.querySelectorAll('[class*="NavigationBar_nav__"]');
    const target = Array.from(navs).find((nav) => nav.querySelector(`svg[aria-label="${ariaLabel}"]`));
    if (!target) return false;
    target.click();
    return true;
}

/**
 * What each line opens.
 *
 * A briefing line that only *reports* is half a feature — the point of naming
 * the problem is to be one click from where it is fixed. A subject with nowhere
 * to send you has no entry here and renders as plain text rather than as a link
 * that does nothing.
 */
export const OPENERS = {
    queue: () => clickNav('navigationBar.combat'),
    tasks: () => clickNav('navigationBar.tasks'),
    consumables: () => consumablesPanel()?.show(),
    listings: () => clickNav('navigationBar.marketplace'),
    enhancement: () => navigateToAction('/actions/enhancing/enhance'),
    guild: () => clickNav('navigationBar.guild'),
    labyrinth: () => clickNav('navigationBar.labyrinth'),
    notices: () => noticePanel.toggle(),
};

/**
 * Draw one line, as a link when there is somewhere to go.
 * @param {HTMLElement} card - Where it goes
 * @param {Object} line - From {@link buildBriefingLines}
 * @returns {HTMLElement} The row
 */
function drawLine(card, line) {
    const row = document.createElement('div');
    row.className = 'toolasha-briefing-line';
    row.dataset.briefingKey = line.key;
    Object.assign(row.style, { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '1px 0' });

    const label = document.createElement('span');
    label.textContent = line.label;
    Object.assign(label.style, { color: 'rgba(232, 236, 245, 0.55)', flex: '1' });

    const value = document.createElement('span');
    value.textContent = line.value;
    Object.assign(value.style, { color: ROW_COLORS[line.tone] || ROW_COLORS.neutral, textAlign: 'right' });

    row.append(label, value);

    const open = line.target ? OPENERS[line.target] : null;
    if (open) {
        row.style.cursor = 'pointer';
        row.title = 'Open';
        value.style.textDecoration = 'underline dotted';
        row.addEventListener('click', () => {
            try {
                open();
            } catch (error) {
                console.error('[SessionBriefing] Could not open what a line points at:', error);
            }
        });
    }

    card.appendChild(row);
    return row;
}

/**
 * Remember that this arrival's away diff has been seen.
 *
 * Shown is read, here. The modal is one-shot — the game opens it once per
 * arrival and the player closes it — so there is no second viewing to preserve
 * the card for, and no close button of its own to press. The mark records the
 * instant the diff was computed from, which `away-diff.js` explains is a mark
 * rather than a delete: the next switch away writes a newer snapshot and earns
 * its own card.
 *
 * @returns {void}
 */
function markAwayDiffShown() {
    const diff = awayDiff;
    if (!diff || awayDiffMarked) return;
    awayDiffMarked = true;
    // Fire and forget: the mark only has to have landed before the next arrival
    markAwayDiffSeen(currentCharacterId(), diff.at);
}

/**
 * A heading inside the modal section.
 * @param {string} label - What it says
 * @param {string} color - Its color
 * @returns {HTMLElement} The heading
 */
function sectionHeading(label, color) {
    const heading = document.createElement('div');
    heading.textContent = label;
    Object.assign(heading.style, { color, fontWeight: 'bold', marginBottom: '3px' });
    return heading;
}

/**
 * A block of lines under one heading.
 *
 * Each line is drawn in its own try/catch: this is an addition to somebody
 * else's dialog, and one line that cannot be built must cost its own row rather
 * than the modal's layout.
 *
 * @param {HTMLElement} section - Where it goes
 * @param {string} heading - Its title
 * @param {string} color - The title color
 * @param {Array<Object>} lines - From {@link buildBriefingLines}
 * @param {string} [rowTitle] - A tooltip to put on every row
 * @returns {void}
 */
function drawBlock(section, heading, color, lines, rowTitle) {
    const block = document.createElement('div');
    block.style.marginTop = '6px';
    block.appendChild(sectionHeading(heading, color));

    for (const line of lines) {
        try {
            const row = drawLine(block, line);
            if (rowTitle) row.title = rowTitle;
        } catch (error) {
            console.error('[SessionBriefing] A line could not be drawn:', error);
            const failed = document.createElement('div');
            failed.textContent = `This line could not be drawn: ${error.message}`;
            failed.style.color = ROW_COLORS.bad;
            block.appendChild(failed);
        }
    }

    section.appendChild(block);
}

/**
 * The whole section, as it goes into the modal.
 *
 * The away diff sits above the live briefing for the same reason it used to sit
 * above it on the card: it is about the gap the modal is already describing, and
 * the briefing under it is about now.
 *
 * @param {Array<Object>} lines - The live briefing lines
 * @param {{at: number, lines: Array<Object>}|null} diff - The away diff, if any
 * @returns {HTMLElement} The section
 */
function buildSection(lines, diff) {
    const section = document.createElement('div');
    section.className = SECTION_CLASS;
    Object.assign(section.style, {
        marginTop: '8px',
        paddingTop: '6px',
        borderTop: '1px solid rgba(255, 255, 255, 0.15)',
        fontSize: '13px',
        lineHeight: '1.35',
        textAlign: 'left',
    });

    const hasDiff = Boolean(diff?.lines?.length);

    if (hasDiff) {
        const age = formatRelativeTime(Math.max(0, Date.now() - diff.at));
        drawBlock(
            section,
            `Toolasha · Since you were away (${age})`,
            ROW_COLORS.gold,
            diff.lines,
            // Two instants cannot see a round trip, and the section must not be
            // read as if they could
            `Net change since ${new Date(diff.at).toLocaleString()}. Anything that happened and reversed in between is not shown.`
        );
    }

    if (lines.length) {
        drawBlock(section, hasDiff ? 'Needs you now' : 'Toolasha · Needs you now', ROW_COLORS.accent, lines);
    }

    return section;
}

/**
 * Put the briefing at the bottom of the welcome modal.
 *
 * Every way of failing here ends in the modal being left exactly as the game
 * drew it — the same contract the offline value line is under, and for the same
 * reason: an addition that can break somebody else's dialog is not worth having.
 *
 * Idempotent, because the observer that calls it is not: the game inserts into
 * the dialog in bursts, and a second pass must find the section already there
 * and leave.
 *
 * @param {HTMLElement} modal - The welcome modal content element
 * @returns {HTMLElement|null} The section that was added, or null
 */
export function renderBriefingSection(modal) {
    try {
        if (!modal?.appendChild || !config.getSetting(MASTER_SETTING, true)) return null;
        // A refresh is not a return, and the game's own reason for opening this
        // dialog is not an answer to whether this player has already read this
        if (suppressed) return null;
        if (modal.querySelector?.(`.${SECTION_CLASS}`)) return null;

        const lines = attempt('the briefing lines', () => buildBriefingLines(collectFacts())) || [];
        const diff = awayDiff;
        // Nothing to say is said by saying nothing: "all clear" appended to a
        // modal the player is about to close is noise, and the old card's own
        // note only existed because a panel that opened empty looked broken
        if (lines.length === 0 && !diff?.lines?.length) return null;

        const section = buildSection(lines, diff);
        placeSection(modal, section);
        markAwayDiffShown();
        return section;
    } catch (error) {
        console.error('[SessionBriefing] Could not put the briefing in the welcome modal:', error);
        return null;
    }
}

/**
 * Put the section where it will be read, not merely where it fits.
 *
 * Appending lands it under the dialog's own Close button, which is the button
 * the player is on their way to press — a digest below it is a digest most
 * returns never see. It goes above that button instead, and falls back to the
 * end for a dialog that has no such button.
 *
 * @param {HTMLElement} modal - The dialog's content element
 * @param {HTMLElement} section - The briefing section
 * @returns {void}
 */
function placeSection(modal, section) {
    const closer = [...(modal.querySelectorAll?.('button, [class*="closeButton"], [class*="Button_button"]') || [])]
        .reverse()
        .find((el) => /close/i.test(el.textContent || '') || /close/i.test(el.className?.toString() || ''));
    // The button may sit in a row of its own, so climb to whichever child of
    // the modal contains it — that is what the section has to go in front of
    let anchor = closer;
    while (anchor && anchor.parentElement && anchor.parentElement !== modal) anchor = anchor.parentElement;
    if (anchor?.parentElement === modal) modal.insertBefore(section, anchor);
    else modal.appendChild(section);
}

/**
 * The modal turned up. Fill it now, or remember it until the facts arrive.
 * @param {HTMLElement} modal - The welcome modal content element
 * @returns {void}
 */
function onModalAppeared(modal) {
    if (factsReady) {
        pendingModal = null;
        renderBriefingSection(modal);
        return;
    }
    pendingModal = modal;
}

/**
 * The facts arrived. Fill the modal if one is waiting and still open.
 * @returns {void}
 */
function renderIntoPendingModal() {
    // Watching only hears about insertions. The game draws this dialog as the
    // player arrives — before `character_switched` brings this feature up — so
    // on a real return there is nothing left for the observer to catch, and
    // the briefing was silently never drawn. Look for one already open.
    const modal = pendingModal || currentWelcomeBackModal();
    pendingModal = null;
    if (!modal) return;
    // The player may have closed it during the awaits; a detached modal is not
    // somewhere to write, and dropping the reference is what releases it
    if (modal.isConnected === false) return;
    renderBriefingSection(modal);
}

/**
 * Watch for the welcome modal — once per arrival.
 *
 * Installed before `initialize()`'s first await, so a modal the game draws
 * during those awaits is caught rather than missed.
 *
 * @returns {void}
 */
function watchForModal() {
    if (unwatchModal) return;
    unwatchModal = onWelcomeBackModal('SessionBriefing', onModalAppeared);
}

/**
 * Stop watching, and forget what was being watched for.
 * @returns {void}
 */
function stopWatchingForModal() {
    if (unwatchModal) {
        unwatchModal();
        unwatchModal = null;
    }
    pendingModal = null;
}

/**
 * How many things want attention, for the overlay tile.
 * @returns {number} Line count
 */
function briefingCount() {
    try {
        return buildBriefingLines(collectFacts()).length;
    } catch (error) {
        console.error('[SessionBriefing] Could not count the briefing:', error);
        return 0;
    }
}

// The tile survives the panel it used to open. It answers a different question —
// "is anything waiting for me right now" — which is true at any moment, not only
// on arrival, and is the only place the briefing's subjects are readable once
// the welcome modal has been closed. It has no `onOpen`: there is no panel to
// open any more, and a click target that does nothing is worse than none.
registerRow({
    key: 'sessionBriefing',
    name: 'Briefing',
    empty: 'All clear',
    defaultVisible: false,
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        const count = briefingCount();
        const line = document.createElement('div');
        line.textContent = count === 0 ? 'All clear' : `${count} need${count === 1 ? 's' : ''} you`;
        line.style.color = count === 0 ? ROW_COLORS.good : ROW_COLORS.gold;
        container.appendChild(line);
    },
});

/**
 * Forget this arrival's state.
 *
 * For tests; the live script has no reason to, since a page load is already a
 * fresh session.
 * @returns {void}
 */
export function _resetBriefingState() {
    stopWatchingForModal();
    listingDelta = null;
    awayDiff = null;
    awayDiffMarked = false;
    factsReady = false;
    suppressed = false;
}

export default {
    name: 'Session Briefing',
    initialize: async () => {
        if (!config.getSetting(MASTER_SETTING, true)) return;
        const characterId = currentCharacterId();
        startPresenceHeartbeat();

        // Before the awaits below, so a welcome modal that arrives while the
        // facts are still being gathered is held rather than missed. Nothing is
        // drawn until `factsReady`
        watchForModal();

        // Asked first, before anything else below moves the clock forward with
        // its own awaits: a page that was alive for this very character inside
        // QUICK_REFRESH_WINDOW_MS did not go anywhere, and only a genuine return
        // earns a briefing. This gates drawing only — the facts below are still
        // collected and the away diff still computed, exactly as they would be
        // on a real arrival, so the overlay tile still reads the truth.
        const isQuickRefresh = await wasAliveRecently(characterId);

        await loadListingDelta(characterId);
        // After the listing delta, because `collectFacts()` reads it — and this
        // whole initialize is itself the arrival hook: feature-registry runs it
        // on `character_switched` once the switch has settled, which is the only
        // moment at which the arriving character's live facts are readable
        awayDiff = await computeAwayDiff(
            characterId,
            attempt('the live facts', () => collectFacts())
        );
        awayDiffMarked = false;

        // This arrival's own stamp, so a switch back within the window (or the
        // next reload) finds this instant rather than whatever the last tick
        // wrote — but only for the character that is still actually here
        if (characterId === currentCharacterId()) recordPresence(characterId);

        // Re-checked rather than trusted from the read above: a second switch
        // landing during the awaits between them would make a quick-refresh
        // verdict for the character that arrived first meaningless for whoever
        // is current now, and the safe default is to draw rather than guess
        suppressed = isQuickRefresh && characterId === currentCharacterId();

        factsReady = true;
        renderIntoPendingModal();
    },
    cleanup: () => {
        // The watcher belongs to one arrival. A character switch ends it, and
        // the next initialize() installs a fresh one — otherwise the departing
        // character's handler would still be live to write the departing
        // character's facts into a modal that belongs to whoever arrives
        stopWatchingForModal();
        // Anything already in a modal on screen goes with it: a section about
        // the character you just left is worse than none
        document.querySelectorAll(`.${SECTION_CLASS}`).forEach((section) => section.remove());
        factsReady = false;
        suppressed = false;
        // Dropped rather than marked read: the departing character's diff
        // belongs to the departing character, and marking it read here would
        // silence a card nobody saw. The mark it would have written is not
        // needed either — the snapshot this switch is about to write supersedes
        // the one the diff was computed from
        awayDiff = null;
        awayDiffMarked = false;
        // The overlay panel re-initializes and redraws well before this
        // feature's own initialize() reaches loadListingDelta() — it is far
        // earlier in the registry and not `concurrent`, so it is fully
        // awaited first. Left uncleared, that redraw (and every one-second
        // tick after it, until our own init eventually runs) shows the
        // outgoing character's filled-listing count under the incoming
        // character's name. Cleared here, at the moment the switch begins,
        // so the tile reads "nothing to report" for that gap instead.
        listingDelta = null;
    },
};
