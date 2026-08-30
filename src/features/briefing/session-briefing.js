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
 * A card you dismiss once is the right shape for a digest.
 *
 * ## Dismissal
 *
 * Per session, in memory, keyed by character. Closing it means "I have read
 * this", and that is true until the facts change — which for this purpose means
 * until you switch character or reload the page. Persisting it would mean a
 * briefing you dismissed on Monday never appearing again, which is the one
 * failure mode a briefing cannot survive.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';
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

/** Panel id, which is also its geometry key */
export const PANEL_ID = 'sessionBriefing';

/** Where the previous session's listing snapshot lives */
const LISTING_BASELINE_PREFIX = 'sessionBriefingListings_';

/** Nothing here moves fast; a slow redraw is the point */
const REFRESH_MS = 15_000;

/** A current enhancement session whose last attempt is older than this is a stopped run, not news */
const ENHANCEMENT_STALE_MS = 60 * 60 * 1000;

/** Character ids whose briefing has been read and closed this page session */
const dismissed = new Set();

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
 * Stop showing the away diff, and remember that it was read.
 *
 * Dismissal is per snapshot rather than per session: the mark records the
 * instant the diff was computed from, so this card stays gone until the next
 * switch away writes a newer one. `away-diff.js` says why that is a mark rather
 * than a delete.
 *
 * @returns {void}
 */
function dismissAwayDiff() {
    const diff = awayDiff;
    awayDiff = null;
    if (!diff) return;
    // Fire and forget: the card is already gone from this page's state, and the
    // mark only has to have landed before the next arrival
    markAwayDiffSeen(currentCharacterId(), diff.at);
}

/**
 * The "since you were away" card, above the briefing it gives context to.
 *
 * Above rather than beside: it is read once and closed, and the briefing under
 * it is the thing that stays. Its own ✕ dismisses it without taking the briefing
 * with it.
 *
 * @param {HTMLElement} body - The panel's body
 * @returns {void}
 */
function drawAwayDiff(body) {
    const diff = awayDiff;
    if (!diff || diff.lines.length === 0) return;

    const card = panelCard(body, '', ROW_COLORS.gold);

    const header = document.createElement('div');
    Object.assign(header.style, { display: 'flex', gap: '8px', alignItems: 'baseline', marginBottom: '3px' });

    const heading = document.createElement('span');
    const age = formatRelativeTime(Math.max(0, Date.now() - diff.at));
    heading.textContent = `Since you were away (${age})`;
    Object.assign(heading.style, { color: ROW_COLORS.gold, fontWeight: 'bold', flex: '1' });

    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'I have read this';
    Object.assign(close.style, {
        background: 'none',
        border: 'none',
        color: 'rgba(232, 236, 245, 0.6)',
        cursor: 'pointer',
        fontSize: '12px',
        padding: '0 2px',
    });
    close.addEventListener('click', (event) => {
        event.stopPropagation();
        dismissAwayDiff();
        briefingPanel.render();
    });

    header.append(heading, close);
    card.appendChild(header);

    for (const line of diff.lines) {
        const row = drawLine(card, line);
        // Two instants cannot see a round trip, and the card must not be read as
        // if they could
        row.title = `Net change since ${new Date(diff.at).toLocaleString()}. Anything that happened and reversed in between is not shown.`;
    }
}

/**
 * Fill the panel body.
 * @param {HTMLElement} body - The panel's body
 */
function draw(body) {
    drawAwayDiff(body);

    const lines = buildBriefingLines(collectFacts());
    if (lines.length === 0) {
        // Only when there is nothing above it either: "nothing needs you" under
        // a list of things that changed reads as a contradiction
        if (!awayDiff) body.appendChild(panelNote('Nothing needs you right now.'));
        return;
    }

    const card = panelCard(body, '', ROW_COLORS.accent);
    for (const line of lines) drawLine(card, line);
}

export const briefingPanel = createPanel({
    id: PANEL_ID,
    title: 'Session Briefing',
    size: { width: 340, height: 260 },
    accent: '#9ec4ff',
    refreshMs: REFRESH_MS,
    draw,
});

// Closing the card is the player saying they have read it, and the close button
// belongs to the shell rather than to us — so the meaning is attached by
// wrapping the returned hide, which is the same function the ✕ calls.
const shellHide = briefingPanel.hide;
briefingPanel.hide = (options) => {
    const characterId = currentCharacterId();
    if (characterId) dismissed.add(characterId);
    // Closing the whole card is also having read the away diff on top of it —
    // otherwise it would come back on the next thing that opens this panel
    dismissAwayDiff();
    return shellHide(options);
};

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
    onOpen: () => briefingPanel.toggle(),
});

/**
 * Show the card if this arrival warrants one.
 *
 * Not shown when the setting is off, when this character's card has already
 * been read this session, or when there is nothing to say — the last being the
 * case that decides whether the feature is welcome, since a card that appears
 * on every login to say "all fine" is a card that gets switched off.
 *
 * @returns {boolean} Whether it was shown
 */
export function maybeShowBriefing() {
    if (!config.getSetting(MASTER_SETTING, true)) return false;

    const characterId = currentCharacterId();
    if (characterId && dismissed.has(characterId)) return false;
    // A diff worth showing is reason enough on its own: "nothing needs you now,
    // but the ale ran dry at 14:20" is exactly the arrival this feature exists
    // for, and the live briefing has no line for it
    if (briefingCount() === 0 && !awayDiff) return false;

    briefingPanel.show({ remember: false });
    return true;
}

/**
 * Forget every dismissal and the cached listing comparison.
 *
 * For tests; the live script has no reason to, since a page load is already a
 * fresh session.
 */
export function _resetBriefingState() {
    dismissed.clear();
    listingDelta = null;
    awayDiff = null;
}

export default {
    name: 'Session Briefing',
    initialize: async () => {
        if (!config.getSetting(MASTER_SETTING, true)) return;
        const characterId = currentCharacterId();
        await loadListingDelta(characterId);
        // After the listing delta, because `collectFacts()` reads it — and this
        // whole initialize is itself the arrival hook: feature-registry runs it
        // on `character_switched` once the switch has settled, which is the only
        // moment at which the arriving character's live facts are readable
        awayDiff = await computeAwayDiff(
            characterId,
            attempt('the live facts', () => collectFacts())
        );
        maybeShowBriefing();
    },
    cleanup: () => {
        // Hidden through the shell rather than through the wrapper above: a
        // character switch is not somebody dismissing anything, and the next
        // character is owed its own briefing
        shellHide({ remember: false });
        // Dropped rather than dismissed: the departing character's diff belongs
        // to the departing character, and marking it read here would silence a
        // card nobody saw. The mark it would have written is not needed either —
        // the snapshot this switch is about to write supersedes the one the diff
        // was computed from
        awayDiff = null;
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
