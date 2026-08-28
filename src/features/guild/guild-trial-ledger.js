/**
 * The attendance and contribution ledger: who actually turned up, over months.
 *
 * `guild-trials-store.js` archives four cycles and then forgets. That is the
 * right budget for a panel that draws last week's tiers beside this week's, and
 * it is the wrong one for the question a guild leader actually asks — "who has
 * been showing up, and who has been carrying it?" — because four cycles is a
 * month and a month is not long enough to tell a bad week from a member who
 * stopped coming.
 *
 * So the figures a finished trial produced are folded, once, into a *separate*
 * and much longer-lived tally the moment the recorder closes a session. The
 * archive keeps whole cycles and expires them; this keeps one small row per
 * member per cycle and keeps {@link MAX_LEDGER_CYCLES} of them.
 *
 * ## One record per cycle, which is what makes the write small
 *
 * A ledger in a single key would rewrite every cycle ever recorded each time a
 * trial ended — the write amplification `utils/chunked-history.js` exists to
 * end, in a store whose key budget is measured in hundreds. A cycle is the
 * natural chunk: a finished trial only ever touches the cycle it happened in,
 * so the write is one record holding a couple of dozen member rows, and the key
 * count grows with calendar weeks rather than with trials.
 *
 * Keyed per guild with a per-character fallback, exactly as
 * `guildTrialsStorageKey` is and for the same reported reason: two characters in
 * one tab must never read each other's guilds back.
 *
 * ## What a contribution is, and what it is not
 *
 * The recorder's snapshots are *cumulative for the session*, so the last one is
 * the session's totals and a reader diffs consecutive snapshots rather than
 * summing them. A trial's contribution is therefore read off the final snapshot
 * alone — damage, healing, damage taken, deaths, and the mana figures
 * `guild-trial-support.js` measures.
 *
 * Shares are never stored. A stored percentage cannot be re-windowed: a member
 * who did 30% of one trial and 10% of another did not do 20% of the two unless
 * the two were the same size. Raw totals are kept per member and per cycle, and
 * every share on screen is computed from the sums of whichever window is being
 * looked at.
 *
 * ## Attendance is only ever about trials this client watched
 *
 * Nothing here can see a trial nobody had the panel open for, and pretending
 * otherwise would turn "you were not watching" into "they did not show up".
 * Every count is against `trialsRun` — the trials in the ledger — and
 * {@link observedCoverage} states how much of the guild's actual activity that
 * was, so a no-show flag is read next to the honesty about what was seen.
 */

import storage from '../../core/storage.js';
import { trialWeekStart } from './guild-trials-math.js';

/** Object store the ledger lives in — shared with the rest of the guild history */
export const LEDGER_STORE = 'guildHistory';

/** Key prefix; the scope and the cycle are appended */
export const LEDGER_KEY_PREFIX = 'guildTrialLedger';

/** The separator between the scope and the cycle stamp in a key */
const CYCLE_SEPARATOR = '__';

/**
 * How many cycles the ledger keeps.
 *
 * Half a year. Long enough that "has not turned up since spring" is a thing the
 * table can say, short enough that a guild's whole ledger is a few dozen small
 * records rather than an unbounded pile.
 */
export const MAX_LEDGER_CYCLES = 26;

/** The windows the table offers, in cycles. `null` is everything kept. */
export const LEDGER_WINDOWS = [
    { key: '4', label: 'Last 4 cycles', cycles: 4 },
    { key: '12', label: 'Last 12 cycles', cycles: 12 },
    { key: 'all', label: 'All cycles', cycles: null },
];

/** A guild trial cycle is two trials — a skilling hour and a combat one */
export const TRIALS_PER_CYCLE = 2;

/**
 * The scope a ledger record belongs to.
 *
 * The guild's name where it is known, because the ledger is a fact about the
 * guild and not about whichever alt had the panel open. Before the name has
 * arrived it falls back to the *character*, never to one shared bucket — the
 * data leak `guildTrialsStorageKey` documents at length.
 *
 * @param {string|null} guildName - Guild name, or null before it is known
 * @param {string|number|null} [characterId] - The viewing character, for the fallback
 * @returns {string} A scope token
 */
export function ledgerScope(guildName, characterId = null) {
    if (guildName) return String(guildName);
    if (characterId === null || characterId === undefined) return 'default';
    return `char_${characterId}`;
}

/**
 * The key one cycle's ledger record lives under.
 *
 * @param {string} scope - From {@link ledgerScope}
 * @param {number} weekStart - The cycle's week start, in ms
 * @returns {string} Storage key
 */
export function ledgerCycleKey(scope, weekStart) {
    return `${LEDGER_KEY_PREFIX}_${scope}${CYCLE_SEPARATOR}${weekStart}`;
}

/**
 * The cycle stamps a set of store keys holds for one scope.
 *
 * The stamp is what follows the last `__`, so a guild whose name contains an
 * underscore still parses. A key whose tail is not a number is not one of ours
 * and is skipped rather than guessed at.
 *
 * @param {Array<string>} keys - Keys from the store
 * @param {string} scope - From {@link ledgerScope}
 * @returns {number[]} Week starts, oldest first
 */
export function ledgerCyclesInKeys(keys, scope) {
    const wanted = `${LEDGER_KEY_PREFIX}_${scope}${CYCLE_SEPARATOR}`;
    const stamps = [];
    for (const key of keys || []) {
        if (typeof key !== 'string' || !key.startsWith(wanted)) continue;
        const stamp = Number(key.slice(wanted.length));
        if (Number.isFinite(stamp)) stamps.push(stamp);
    }
    return stamps.sort((a, b) => a - b);
}

/**
 * An empty cycle record.
 * @param {number} weekStart - Week start, in ms
 * @param {string} scope - From {@link ledgerScope}
 * @returns {Object} A fresh record
 */
export function emptyLedgerCycle(weekStart, scope = 'default') {
    return { weekStart, scope, trials: [], members: {} };
}

/** A fresh per-member tally, with every figure at its "nothing recorded" value */
function emptyTally(name) {
    return {
        name,
        trials: 0,
        damage: 0,
        healing: 0,
        damageTaken: 0,
        deaths: 0,
        manaSpent: 0,
        starvedMs: 0,
        lowManaMs: 0,
        seconds: 0,
        firstSeen: null,
        lastSeen: null,
    };
}

/**
 * The key a member is tallied under.
 *
 * Names as the stream spells them, lowercased: a trial roster has no character
 * ids on it, and the display name is the only handle the whole feature has.
 *
 * @param {string} name - As seen
 * @returns {string} Tally key
 */
export function memberKey(name) {
    return String(name || '')
        .trim()
        .toLowerCase();
}

/**
 * What one finished session contributed, per member.
 *
 * Read off the *last* snapshot only. The recorder's snapshots each hold the
 * session's running totals rather than an interval's, so summing them would
 * count the first minute sixty times.
 *
 * A member the roster named but no snapshot row covers still gets an entry, at
 * zero: they were in the trial, and "joined and was never attributed a hit" is a
 * different claim from "did not join" — the whole point of
 * `attributionCoverage` in `guild-trial-damage.js` is that a spectated stream
 * routinely cannot split every player out.
 *
 * @param {Object} session - A finished session from `guild-trial-recorder.js`
 * @param {Object} [context] - What the damage module knew about the trial
 * @param {string|null} [context.encounter] - Which trial it was
 * @param {number|null} [context.tier] - Highest tier the stream stated
 * @param {Array<string>} [context.roster] - Names the game stated for the party
 * @param {number|null} [context.participants] - Party size the game stated
 * @returns {{trialId: string, weekStart: number, at: number, encounter: string|null,
 *   tier: number|null, seconds: number, totals: Object, members: Array<Object>}|null}
 *   The contribution, or null when the session recorded nothing to fold
 */
export function sessionContribution(session, { encounter = null, tier = null, roster = [], participants = null } = {}) {
    const snapshots = Array.isArray(session?.snapshots) ? session.snapshots : [];
    const last = snapshots[snapshots.length - 1] || null;
    const rosterNames = (roster || []).map((name) => String(name || '').trim()).filter(Boolean);
    if (!last && rosterNames.length === 0) return null;

    const at = Number.isFinite(session?.endedAt) ? session.endedAt : Number.isFinite(last?.t) ? last.t : null;
    if (!Number.isFinite(at)) return null;

    const weekStart = Number.isFinite(session?.weekStart) ? session.weekStart : trialWeekStart(at);
    const seconds = Number(last?.seconds) || 0;

    const members = [];
    const seen = new Set();
    for (const player of last?.players || []) {
        const name = String(player?.name || '').trim();
        if (!name) continue;
        const key = memberKey(name);
        if (seen.has(key)) continue;
        seen.add(key);
        members.push({
            name,
            damage: Number(player.damage) || 0,
            healing: Number(player.healingDone) || 0,
            damageTaken: Number(player.damageTaken) || 0,
            deaths: Number(player.deaths) || 0,
            manaSpent: Number(player.manaSpent) || 0,
            starvedMs: Number(player.starvedMs) || 0,
            lowManaMs: Number(player.lowManaMs) || 0,
        });
    }

    // Named by the game, never attributed anything: present at zero rather than
    // absent, so the attendance count is attendance and not attribution
    for (const name of rosterNames) {
        const key = memberKey(name);
        if (seen.has(key)) continue;
        seen.add(key);
        members.push({
            name,
            damage: 0,
            healing: 0,
            damageTaken: 0,
            deaths: 0,
            manaSpent: 0,
            starvedMs: 0,
            lowManaMs: 0,
        });
    }

    if (members.length === 0) return null;

    const sum = (field) => members.reduce((total, member) => total + (member[field] || 0), 0);

    return {
        // The session's own start is what makes a trial unique: two sessions
        // cannot begin at the same millisecond, and re-folding the same one is
        // the failure this guards
        trialId: `${weekStart}:${session?.startedAt ?? at}`,
        weekStart,
        at,
        encounter: encounter || null,
        tier: Number.isFinite(tier) ? tier : null,
        seconds,
        participants: Number.isFinite(participants) ? participants : null,
        totals: {
            damage: sum('damage'),
            healing: sum('healing'),
            damageTaken: sum('damageTaken'),
            deaths: sum('deaths'),
            members: members.length,
        },
        members,
    };
}

/**
 * Fold one trial's contribution into a cycle record.
 *
 * Idempotent on `trialId`: the recorder can stop a session more than once —
 * a manual stop racing the watcher's — and a trial counted twice would put a
 * member's attendance above the number of trials that happened.
 *
 * @param {Object} cycle - The cycle record (not mutated)
 * @param {Object} contribution - From {@link sessionContribution}
 * @returns {Object} The updated cycle
 */
export function accrueTrial(cycle, contribution) {
    if (!contribution?.trialId) return cycle;

    const trials = Array.isArray(cycle?.trials) ? cycle.trials : [];
    if (trials.some((trial) => trial?.trialId === contribution.trialId)) return cycle;

    const members = {};
    for (const [key, tally] of Object.entries(cycle?.members || {})) members[key] = { ...tally };

    for (const member of contribution.members || []) {
        const key = memberKey(member.name);
        if (!key) continue;
        const tally = members[key] || emptyTally(member.name);
        // The freshest spelling wins: a name is re-scraped every trial and the
        // latest reading is the one the player is using
        tally.name = member.name;
        tally.trials += 1;
        tally.damage += member.damage || 0;
        tally.healing += member.healing || 0;
        tally.damageTaken += member.damageTaken || 0;
        tally.deaths += member.deaths || 0;
        tally.manaSpent += member.manaSpent || 0;
        tally.starvedMs += member.starvedMs || 0;
        tally.lowManaMs += member.lowManaMs || 0;
        tally.seconds += contribution.seconds || 0;
        tally.firstSeen = Number.isFinite(tally.firstSeen)
            ? Math.min(tally.firstSeen, contribution.at)
            : contribution.at;
        tally.lastSeen = Number.isFinite(tally.lastSeen) ? Math.max(tally.lastSeen, contribution.at) : contribution.at;
        members[key] = tally;
    }

    return {
        ...cycle,
        weekStart: cycle?.weekStart ?? contribution.weekStart,
        scope: cycle?.scope ?? 'default',
        members,
        trials: [
            ...trials,
            {
                trialId: contribution.trialId,
                at: contribution.at,
                encounter: contribution.encounter,
                tier: contribution.tier,
                seconds: contribution.seconds,
                participants: contribution.participants,
                totals: { ...contribution.totals },
            },
        ],
    };
}

/**
 * Every cycle's tallies folded into one row per member.
 *
 * The window is applied by the caller — this folds whatever it is handed — and
 * the shares are computed here rather than stored, because a share is only
 * meaningful against the window it was taken over.
 *
 * `rosterNames` is how a no-show ever gets a row at all: a member who joined
 * nothing in the window contributed no tally to fold, so the only way to say
 * "they were on the roster and did not come" is to be told who the roster is.
 * Without one, the table is honestly a table of people who turned up.
 *
 * @param {Array<Object>} cycles - Cycle records, any order
 * @param {Object} [options] - Context
 * @param {Array<string>} [options.rosterNames] - The guild's members, for no-show rows
 * @returns {{rows: Array<Object>, trialsRun: number, cycles: number, totals: Object}} The table
 */
export function foldLedgerCycles(cycles, { rosterNames = [] } = {}) {
    const list = (cycles || []).filter(Boolean);
    const byMember = new Map();
    let trialsRun = 0;

    for (const cycle of list) {
        trialsRun += (cycle.trials || []).length;
        for (const [key, tally] of Object.entries(cycle.members || {})) {
            const held = byMember.get(key) || emptyTally(tally?.name || key);
            held.name = tally?.name || held.name;
            for (const field of [
                'trials',
                'damage',
                'healing',
                'damageTaken',
                'deaths',
                'manaSpent',
                'starvedMs',
                'lowManaMs',
                'seconds',
            ]) {
                held[field] += Number(tally?.[field]) || 0;
            }
            if (Number.isFinite(tally?.firstSeen)) {
                held.firstSeen = Number.isFinite(held.firstSeen)
                    ? Math.min(held.firstSeen, tally.firstSeen)
                    : tally.firstSeen;
            }
            if (Number.isFinite(tally?.lastSeen)) {
                held.lastSeen = Number.isFinite(held.lastSeen)
                    ? Math.max(held.lastSeen, tally.lastSeen)
                    : tally.lastSeen;
            }
            byMember.set(key, held);
        }
    }

    // A rostered member with nothing folded is the no-show the table exists to
    // show; one already tallied keeps the tally
    for (const name of rosterNames || []) {
        const key = memberKey(name);
        if (!key || byMember.has(key)) continue;
        byMember.set(key, emptyTally(String(name).trim()));
    }

    const rows = [...byMember.values()];
    const totals = {
        damage: rows.reduce((sum, row) => sum + row.damage, 0),
        healing: rows.reduce((sum, row) => sum + row.healing, 0),
        damageTaken: rows.reduce((sum, row) => sum + row.damageTaken, 0),
        deaths: rows.reduce((sum, row) => sum + row.deaths, 0),
    };

    const share = (value, total) => (total > 0 ? value / total : null);
    for (const row of rows) {
        row.damageShare = share(row.damage, totals.damage);
        row.healingShare = share(row.healing, totals.healing);
        row.tankShare = share(row.damageTaken, totals.damageTaken);
        row.attendance = trialsRun > 0 ? row.trials / trialsRun : null;
        // Only a claim when there was something to turn up to
        row.noShow = trialsRun > 0 && row.trials === 0;
        row.missed = Math.max(0, trialsRun - row.trials);
    }

    return { rows, trialsRun, cycles: list.length, totals };
}

/**
 * One synthetic row summing every member row, for a totals line under the table.
 *
 * Shares are recomputed from the summed figures rather than averaged from the
 * per-row shares, for the reason {@link foldLedgerCycles} recomputes them in
 * the first place: a share only means something against the total it was a
 * fraction of. Summed over every row that total is the whole of it, so damage
 * share, healing share and tank share are always 100% here — the row exists to
 * carry the raw sums a reader would otherwise have to add up by hand, not to
 * say anything the per-member shares did not already say.
 *
 * Attendance stays a dash: "trials attended" summed across members is a count
 * of seats filled, not a fraction of anything a single number could represent
 * as a percentage.
 *
 * @param {Array<Object>} rows - From {@link foldLedgerCycles}
 * @param {number} [trialsRun] - Trials in the window, for the caption
 * @returns {Object|null} A row shaped like the others, or null with nothing to sum
 */
export function ledgerTotalsRow(rows, trialsRun = 0) {
    const list = (rows || []).filter(Boolean);
    if (!list.length) return null;

    const sum = (field) => list.reduce((total, row) => total + (Number(row[field]) || 0), 0);
    const damage = sum('damage');
    const healing = sum('healing');
    const damageTaken = sum('damageTaken');

    return {
        name: 'Total',
        trials: sum('trials'),
        attendance: null,
        damage,
        damageShare: damage > 0 ? 1 : null,
        healing,
        healingShare: healing > 0 ? 1 : null,
        damageTaken,
        tankShare: damageTaken > 0 ? 1 : null,
        deaths: sum('deaths'),
        manaSpent: sum('manaSpent'),
        starvedMs: sum('starvedMs'),
        lowManaMs: sum('lowManaMs'),
        noShow: false,
        isTotal: true,
        trialsRun,
    };
}

/** The sortable columns the table offers, and how each row's value is read */
export const LEDGER_COLUMNS = [
    { key: 'name', label: 'Member', numeric: false, value: (row) => row.name },
    { key: 'trials', label: 'Trials', numeric: true, value: (row) => row.trials },
    { key: 'attendance', label: 'Attendance', numeric: true, value: (row) => row.attendance },
    { key: 'damageShare', label: 'Damage', numeric: true, value: (row) => row.damageShare },
    { key: 'healingShare', label: 'Healing', numeric: true, value: (row) => row.healingShare },
    { key: 'tankShare', label: 'Tanked', numeric: true, value: (row) => row.tankShare },
    { key: 'deaths', label: 'Deaths', numeric: true, value: (row) => row.deaths },
    { key: 'starvedMs', label: 'Starved', numeric: true, value: (row) => row.starvedMs },
];

/**
 * The table, sorted.
 *
 * Nulls sort last whichever way the column is pointed: "not measured" is not a
 * small number, and floating a column of blanks to the top of a descending sort
 * would bury every member who was actually measured.
 *
 * @param {Array<Object>} rows - From {@link foldLedgerCycles}
 * @param {string} [sortKey] - A {@link LEDGER_COLUMNS} key
 * @param {'asc'|'desc'} [direction] - Which way
 * @returns {Array<Object>} A new sorted array
 */
export function sortLedgerRows(rows, sortKey = 'damageShare', direction = 'desc') {
    const column = LEDGER_COLUMNS.find((entry) => entry.key === sortKey) || LEDGER_COLUMNS[0];
    const sign = direction === 'asc' ? 1 : -1;

    return [...(rows || [])].sort((a, b) => {
        const left = column.value(a);
        const right = column.value(b);

        if (!column.numeric) return String(left || '').localeCompare(String(right || '')) * sign;

        const leftBlank = !Number.isFinite(left);
        const rightBlank = !Number.isFinite(right);
        if (leftBlank && rightBlank) return String(a.name || '').localeCompare(String(b.name || ''));
        if (leftBlank) return 1;
        if (rightBlank) return -1;
        if (left === right) return String(a.name || '').localeCompare(String(b.name || ''));
        return (left - right) * sign;
    });
}

/**
 * How much of the guild's trialling this ledger actually saw.
 *
 * A cycle is {@link TRIALS_PER_CYCLE} trials, so a window of N cycles is 2N
 * trials the guild could have run. Anything the panel was shut for is missing
 * from the ledger, and every attendance figure has to be read next to this or
 * it reads as an accusation.
 *
 * The cycle in progress is left out of the ratio entirely. Its second trial
 * has not happened yet, and charging the ledger for a trial the guild has not
 * run reports the panel as having missed something — a window ending mid-week
 * could not read above 75% however faithfully it watched. Expecting only what
 * it has seen was worse: that made the current week `seen of seen`, a perfect
 * score by construction, so a trial actually missed this week was invisible.
 * The week is therefore excluded and said to be excluded; `inProgress` is what
 * the view says it with.
 *
 * Observed is clamped per cycle to what a cycle can hold, so a duplicate
 * recording cannot push the fraction above 1.
 *
 * @param {Array<Object>} cycles - The cycles in the window
 * @param {Object} [options] - Context
 * @param {number} [options.trialsPerCycle] - Trials a cycle runs
 * @param {number} [options.now] - Clock, for deciding which cycle is in progress
 * @returns {{observed: number, expected: number, cycles: number, inProgress: boolean,
 *   fraction: number|null}} The coverage, over the completed cycles only
 */
export function observedCoverage(cycles, { trialsPerCycle = TRIALS_PER_CYCLE, now = Date.now() } = {}) {
    const list = (cycles || []).filter(Boolean);
    const currentWeek = trialWeekStart(now);
    const perCycle = Math.max(0, Number(trialsPerCycle) || 0);

    let observed = 0;
    let expected = 0;
    let counted = 0;
    let inProgress = false;

    for (const cycle of list) {
        if (cycle.weekStart === currentWeek) {
            inProgress = true;
            continue;
        }
        observed += Math.min((cycle.trials || []).length, perCycle);
        expected += perCycle;
        counted += 1;
    }

    return {
        observed,
        expected,
        cycles: counted,
        inProgress,
        fraction: expected > 0 ? observed / expected : null,
    };
}

/** The CSV's columns: raw numbers, so a spreadsheet can sort and chart them */
export const LEDGER_CSV_COLUMNS = [
    { key: 'name', label: 'Member' },
    { key: 'trials', label: 'Trials joined' },
    { key: 'trialsRun', label: 'Trials run' },
    { key: 'missed', label: 'Trials missed' },
    { key: 'attendance', label: 'Attendance fraction' },
    { key: 'damage', label: 'Damage' },
    { key: 'damageShare', label: 'Damage share' },
    { key: 'healing', label: 'Healing' },
    { key: 'healingShare', label: 'Healing share' },
    { key: 'damageTaken', label: 'Damage taken' },
    { key: 'tankShare', label: 'Tank share' },
    { key: 'deaths', label: 'Deaths' },
    { key: 'manaSpent', label: 'Mana spent' },
    { key: 'starvedSeconds', label: 'Mana-starved seconds' },
    { key: 'lowManaSeconds', label: 'Low-mana seconds' },
    { key: 'noShow', label: 'No-show' },
];

/**
 * The table as CSV rows.
 *
 * Milliseconds become seconds and nothing is pre-formatted, per the note at the
 * top of `utils/csv-export.js`: a CSV of display strings is a screenshot with
 * extra steps.
 *
 * @param {Array<Object>} rows - From {@link foldLedgerCycles}
 * @param {number} trialsRun - Trials in the window
 * @returns {Array<Object>} Rows for `toCsv`
 */
export function ledgerCsvRows(rows, trialsRun) {
    return (rows || []).map((row) => ({
        name: row.name,
        trials: row.trials,
        trialsRun,
        missed: row.missed,
        attendance: Number.isFinite(row.attendance) ? row.attendance : null,
        damage: Math.round(row.damage),
        damageShare: Number.isFinite(row.damageShare) ? row.damageShare : null,
        healing: Math.round(row.healing),
        healingShare: Number.isFinite(row.healingShare) ? row.healingShare : null,
        damageTaken: Math.round(row.damageTaken),
        tankShare: Number.isFinite(row.tankShare) ? row.tankShare : null,
        deaths: row.deaths,
        manaSpent: Math.round(row.manaSpent),
        starvedSeconds: Math.round(row.starvedMs / 1000),
        lowManaSeconds: Math.round(row.lowManaMs / 1000),
        noShow: row.noShow,
    }));
}

// ─── Storage ────────────────────────────────────────────────────────────────

/**
 * Read the ledger's cycles back, newest last.
 *
 * One key at a time rather than a whole-store read, for the reason
 * `chunked-history.js` gives: this store holds several other features' keys and
 * pulling all of them into memory to draw one table is the cost this chunking
 * exists to avoid.
 *
 * @param {string|null} guildName - Guild name, or null before it is known
 * @param {string|number|null} [characterId] - The viewing character, for the fallback scope
 * @param {Object} [options] - Windowing
 * @param {number|null} [options.cycles] - How many of the most recent to read; null for all
 * @returns {Promise<Array<Object>>} Cycle records, oldest first
 */
export async function loadLedgerCycles(guildName, characterId = null, { cycles = null } = {}) {
    const scope = ledgerScope(guildName, characterId);
    try {
        const keys = await storage.getAllKeys(LEDGER_STORE);
        let stamps = ledgerCyclesInKeys(keys, scope);
        if (Number.isFinite(cycles) && cycles > 0) stamps = stamps.slice(-cycles);

        const records = [];
        for (const stamp of stamps) {
            const record = await storage.get(ledgerCycleKey(scope, stamp), LEDGER_STORE, null);
            if (record && typeof record === 'object') records.push(record);
        }
        return records;
    } catch (error) {
        console.error('[GuildTrialLedger] Reading the ledger failed:', error);
        return [];
    }
}

/**
 * Drop the oldest cycles past the cap.
 *
 * @param {string} scope - From {@link ledgerScope}
 * @param {Array<number>} stamps - Every cycle stamp held, oldest first
 * @returns {Promise<number>} How many were removed
 */
async function pruneLedger(scope, stamps) {
    const doomed = stamps.slice(0, Math.max(0, stamps.length - MAX_LEDGER_CYCLES));
    let removed = 0;
    for (const stamp of doomed) {
        try {
            await storage.delete(ledgerCycleKey(scope, stamp), LEDGER_STORE);
            removed += 1;
        } catch (error) {
            console.error('[GuildTrialLedger] Pruning an old cycle failed:', error);
        }
    }
    return removed;
}

/**
 * One write at a time per ledger cycle key.
 *
 * `recordFinishedTrial` is a read-accrue-write, and `_accrue` in
 * `guild-trial-recorder.js` calls it without awaiting it — deliberately, so a
 * slow ledger write cannot delay the recorder closing a session. Two of these
 * for the *same* cycle can therefore genuinely overlap in one tab: the idle
 * watcher and a manual stop racing each other, or a session ending just as
 * another one (a different trial, or a different character's own recorder in
 * the same tab session) starts and finishes its own. Without serializing,
 * the second call's read lands before the first call's write, both compute a
 * `next` that only carries their own contribution, and the second `set`
 * silently erases the first trial's attendance row.
 *
 * `accrueTrial`'s own trialId dedup is what makes serializing the whole read
 * step (rather than only the write) safe: replaying a fold that already
 * landed is a no-op, so a queued call that reads a cycle another call just
 * wrote to still gets the right, combined answer.
 *
 * @type {Map<string, Promise<*>>}
 */
const ledgerWriteChains = new Map();

/**
 * Fold a finished trial into the ledger and write the one record it touched.
 *
 * Called by the recorder as a session closes. Deliberately tolerant: a ledger
 * that could not be written is a table with a hole in it, and it must never be
 * the reason a recording fails to be saved.
 *
 * @param {Object} options - What happened
 * @param {Object} options.session - The finished session
 * @param {string|null} [options.guildName] - Whose ledger
 * @param {string|number|null} [options.characterId] - The viewing character, for the fallback scope
 * @param {string|null} [options.encounter] - Which trial it was
 * @param {number|null} [options.tier] - Highest tier the stream stated
 * @param {Array<string>} [options.roster] - Names the game stated for the party
 * @param {number|null} [options.participants] - Party size the game stated
 * @returns {Promise<Object|null>} The contribution folded, or null when there was nothing to fold
 */
export async function recordFinishedTrial({
    session,
    guildName = null,
    characterId = null,
    encounter = null,
    tier = null,
    roster = [],
    participants = null,
} = {}) {
    const contribution = sessionContribution(session, { encounter, tier, roster, participants });
    if (!contribution) return null;

    const scope = ledgerScope(guildName, characterId);
    const key = ledgerCycleKey(scope, contribution.weekStart);

    const run = async () => {
        try {
            const stored = await storage.get(key, LEDGER_STORE, null);
            const cycle =
                stored && typeof stored === 'object' ? stored : emptyLedgerCycle(contribution.weekStart, scope);
            const next = accrueTrial(cycle, contribution);
            // Unchanged means this trial was already folded — an idempotent stop,
            // which is the normal case when a manual stop races the watcher
            if (next === cycle) return null;

            await storage.set(key, next, LEDGER_STORE, true);

            const keys = await storage.getAllKeys(LEDGER_STORE);
            await pruneLedger(scope, ledgerCyclesInKeys(keys, scope));
            return contribution;
        } catch (error) {
            console.error('[GuildTrialLedger] Recording the finished trial failed:', error);
            return null;
        }
    };

    const chain = (ledgerWriteChains.get(key) || Promise.resolve()).then(run, run);
    ledgerWriteChains.set(key, chain);
    return chain;
}

/**
 * Forget one scope's ledger entirely.
 * @param {string|null} guildName - Whose ledger
 * @param {string|number|null} [characterId] - The viewing character, for the fallback scope
 * @returns {Promise<number>} How many cycle records were removed
 */
export async function clearLedger(guildName, characterId = null) {
    const scope = ledgerScope(guildName, characterId);
    let removed = 0;
    try {
        const keys = await storage.getAllKeys(LEDGER_STORE);
        for (const stamp of ledgerCyclesInKeys(keys, scope)) {
            await storage.delete(ledgerCycleKey(scope, stamp), LEDGER_STORE);
            removed += 1;
        }
    } catch (error) {
        console.error('[GuildTrialLedger] Clearing the ledger failed:', error);
    }
    return removed;
}
