/**
 * Lab Sim condition search: tries different trigger *conditions*, not just different numbers.
 *
 * The threshold tuner (`trigger-tuning.js`) only moves the value in a row that already exists. Players
 * report that unusual structures win in the labyrinth — a consumable on "My Toughness Is Inactive AND
 * Target Enemy's Frenzy Is Active", say — which no threshold search can find. This builds a small set of
 * single conditions per ability or consumable from what the fight actually contains (the buffs the
 * player's own kit grants, the buffs the room's monsters cast on themselves or on the player, and a few
 * standard HP/MP readings), then searches in stages:
 *
 * 1. Screen every single-condition replacement for a slot, and the current rows ANDed with each single,
 *    against its current rows, cheaply (few seeds, few attempts each).
 * 2. Keep the top few singles by screen mean (whatever the sign) and try AND-pairs among them plus each ANDed with the current rows, on
 *    their own seeds.
 * 3. Confirm the best on fresh seeds with the threshold search's own rule (a sequential paired t test,
 *    at least `minGain` attempts saved).
 * 4. Check every accepted change together against the starting rows on seeds nothing above has seen.
 *
 * Measuring is injected, so the staged logic is testable without the simulator. It only ever simulates;
 * nothing here changes a trigger in the game.
 */

import {
    CONFIRM_SEEDS_MIN,
    MAX_TRIGGERS,
    accepts,
    activeRows,
    confirmLooks,
    mean,
    pairedDiff,
    sequentialVerdict,
} from './trigger-tuning.js';

const DEP_SELF = '/combat_trigger_dependencies/self';
const DEP_TARGET = '/combat_trigger_dependencies/targeted_enemy';
const CMP_ACTIVE = '/combat_trigger_comparators/is_active';
const CMP_INACTIVE = '/combat_trigger_comparators/is_inactive';
const CMP_GTE = '/combat_trigger_comparators/greater_than_equal';
const CMP_LTE = '/combat_trigger_comparators/less_than_equal';
const COND_CURRENT_HP = '/combat_trigger_conditions/current_hp';
const COND_MISSING_HP = '/combat_trigger_conditions/missing_hp';
const COND_CURRENT_MP = '/combat_trigger_conditions/current_mp';
const COND_MISSING_MP = '/combat_trigger_conditions/missing_mp';

/** Most single conditions tried per ability or consumable, best-ranked first */
export const CONDITION_CAP = 30;

/** Seeds each candidate gets in the screen */
export const SCREEN_SEEDS = 2;

/** Candidates that beat the current rows in the screen and go on to the pairing stage */
export const SCREEN_KEEP = 3;

/** Upper bound on the fight sims one condition search may run, whatever the loadouts */
export const MAX_CONDITION_SIMS = 12000;

/** Which ability targets land on the caster's own side; any other target is the other side */
const OWN_SIDE_TARGETS = new Set(['self', 'allAllies', 'lowestHpAlly', 'deadAlly']);

/**
 * What Lab trigger tuning considers. The labyrinth allows no food or drink (the worker nulls them), so a
 * food or drink row could only ever measure sim noise: the Lab tunes abilities, whatever was stored.
 */
export const LAB_TRIGGER_SCOPE = 'abilities';

const SLOT_TYPES = { both: ['abilities', 'food', 'drinks'], abilities: ['abilities'], consumables: ['food', 'drinks'] };

/**
 * The game condition that reads a buff, matched the way the engine matches it: the condition's name is
 * the buff's unique name, or the start of it (Toughness's buffs are `toughness_armor`, `toughness_fire_resistance`
 * and so on). The longest match wins, so a later condition named after a longer prefix is not shadowed.
 * @param {string} uniqueHrid - `/buff_uniques/...`
 * @param {Object} conditionMap - `combatTriggerConditionDetailMap`
 * @returns {string|null} Condition hrid, or null when no single-target active/inactive condition reads it
 */
export function conditionForBuff(uniqueHrid, conditionMap) {
    const tail = String(uniqueHrid || '')
        .split('/')
        .pop();
    if (!tail) return null;
    let best = null;
    let bestLength = 0;
    for (const [hrid, detail] of Object.entries(conditionMap || {})) {
        if (!detail?.isSingleTarget) continue;
        if (!(detail.allowedComparatorHrids || []).includes(CMP_ACTIVE)) continue;
        const name = hrid.split('/').pop();
        if ((tail === name || tail.startsWith(name + '_')) && name.length > bestLength) {
            best = hrid;
            bestLength = name.length;
        }
    }
    return best;
}

/**
 * The buffs an ability puts on its caster's side and on the other side.
 * @param {Object} detail - An `abilityDetailMap` entry
 * @returns {{own: Array<string>, foe: Array<string>}} Buff unique hrids
 */
export function abilityBuffSides(detail) {
    const own = [];
    const foe = [];
    for (const effect of detail?.abilityEffects || []) {
        for (const buff of effect?.buffs || []) {
            if (!buff?.uniqueHrid) continue;
            (OWN_SIDE_TARGETS.has(effect.targetType) ? own : foe).push(buff.uniqueHrid);
        }
    }
    return { own, foe };
}

/** One row, as the game stores it */
function row(dependencyHrid, conditionHrid, comparatorHrid, value = 0) {
    return { dependencyHrid, conditionHrid, comparatorHrid, value };
}

/** Identity of a row, value included */
export function rowSignature(r) {
    return `${r.dependencyHrid}|${r.conditionHrid}|${r.comparatorHrid}|${Number(r.value) || 0}`;
}

/** Whether two row lists are the same rows, in any order */
export function sameRows(a, b) {
    if (a.length !== b.length) return false;
    const sa = a.map(rowSignature).sort();
    const sb = b.map(rowSignature).sort();
    return sa.every((s, i) => s === sb[i]);
}

/**
 * The abilities, foods and drinks of a loadout whose trigger rows can be searched: every filled slot
 * whose rows in force (custom, else the game's defaults) fit in the editor's four.
 * @param {Object} dto - Player DTO (`abilities`, `food`, `drinks` of `{ hrid, triggers }`)
 * @param {Object} gameData - Game data payload
 * @param {string} [include] - 'both', 'abilities' or 'consumables'
 * @returns {Array<{key: string, slotType: string, slotIndex: number, itemHrid: string, itemName: string,
 *   rows: Array<Object>, fromDefault: boolean}>}
 */
export function conditionSlots(dto, gameData, include = 'both') {
    const out = [];
    for (const slotType of SLOT_TYPES[include] || SLOT_TYPES.both) {
        (dto?.[slotType] || []).forEach((slot, slotIndex) => {
            if (!slot?.hrid) return;
            const { rows, fromDefault } = activeRows(slot, slotType, gameData);
            if (rows.length > MAX_TRIGGERS) return;
            const detail =
                slotType === 'abilities'
                    ? gameData?.abilityDetailMap?.[slot.hrid]
                    : gameData?.itemDetailMap?.[slot.hrid];
            out.push({
                key: `${slotType}|${slotIndex}`,
                slotType,
                slotIndex,
                itemHrid: slot.hrid,
                itemName: detail?.name || slot.hrid.split('/').pop().replace(/_/g, ' '),
                rows,
                fromDefault,
            });
        });
    }
    return out;
}

/**
 * The buffs in play in a set of fights, by who carries them.
 * @param {Object} dto - Player DTO
 * @param {Object} gameData - Game data payload
 * @param {Array<string>} monsterHrids - The fights' monsters
 * @returns {{monsterSelf: Array<string>, monsterOnMe: Array<string>, mine: Array<string>,
 *   myOnTarget: Array<string>, bySlot: Map<string, Array<string>>}} Buff unique hrids; `bySlot` keys a
 *   slot key to the buffs that slot itself grants its owner
 */
export function buffsInPlay(dto, gameData, monsterHrids) {
    const monsterSelf = [];
    const monsterOnMe = [];
    for (const hrid of monsterHrids || []) {
        for (const entry of gameData?.combatMonsterDetailMap?.[hrid]?.abilities || []) {
            const sides = abilityBuffSides(gameData?.abilityDetailMap?.[entry?.abilityHrid]);
            monsterSelf.push(...sides.own);
            monsterOnMe.push(...sides.foe);
        }
    }
    const mine = [];
    const myOnTarget = [];
    const bySlot = new Map();
    (dto?.abilities || []).forEach((slot, i) => {
        if (!slot?.hrid) return;
        const sides = abilityBuffSides(gameData?.abilityDetailMap?.[slot.hrid]);
        mine.push(...sides.own);
        myOnTarget.push(...sides.foe);
        bySlot.set(`abilities|${i}`, sides.own);
    });
    for (const slotType of ['food', 'drinks']) {
        (dto?.[slotType] || []).forEach((slot, i) => {
            if (!slot?.hrid) return;
            const buffs = (gameData?.itemDetailMap?.[slot.hrid]?.consumableDetail?.buffs || [])
                .map((b) => b?.uniqueHrid)
                .filter(Boolean);
            mine.push(...buffs);
            bySlot.set(`${slotType}|${i}`, buffs);
        });
    }
    return { monsterSelf, monsterOnMe, mine, myOnTarget, bySlot };
}

/**
 * The single conditions to try on one slot, most relevant first, at most `cap`:
 *
 * 1. buffs the room's monsters cast on themselves, read on the target enemy (active and inactive);
 * 2. standard HP/MP readings at a few fractions of the pools (target enemy's HP for abilities, my own
 *    missing HP/MP for both);
 * 3. buffs the monsters put on me, read on me;
 * 4. the buff this slot itself grants, then the rest of my kit's buffs, read on me;
 * 5. debuffs my abilities put on the target, read on the target enemy.
 *
 * Every row is one the game's editor allows: a single-target condition, a comparator from its
 * `allowedComparatorHrids`, a dependency the game has.
 * @param {Object} params
 * @param {Object} params.slot - From `conditionSlots`
 * @param {Object} params.dto - Player DTO
 * @param {Object} params.gameData - Game data payload
 * @param {Array<string>} params.monsterHrids - The fights' monsters
 * @param {{hp: number, mp: number}} [params.pools] - The player's max HP and MP
 * @param {number} [params.enemyHp] - The fights' largest monster max HP
 * @param {number} [params.cap] - Most conditions
 * @returns {Array<Object>} Rows `{ dependencyHrid, conditionHrid, comparatorHrid, value }`
 */
export function buildConditionCandidates({ slot, dto, gameData, monsterHrids, pools, enemyHp, cap = CONDITION_CAP }) {
    const condMap = gameData?.combatTriggerConditionDetailMap || {};
    const depMap = gameData?.combatTriggerDependencyDetailMap || {};
    const out = [];
    const seen = new Set();
    const push = (r) => {
        if (!depMap[r.dependencyHrid] || !condMap[r.conditionHrid]) return;
        if (!(condMap[r.conditionHrid].allowedComparatorHrids || []).includes(r.comparatorHrid)) return;
        const sig = rowSignature(r);
        if (seen.has(sig)) return;
        seen.add(sig);
        out.push(r);
    };
    const buffRows = (uniques, dependencyHrid) => {
        for (const unique of uniques) {
            const cond = conditionForBuff(unique, condMap);
            if (!cond) continue;
            push(row(dependencyHrid, cond, CMP_ACTIVE));
            push(row(dependencyHrid, cond, CMP_INACTIVE));
        }
    };
    const inPlay = buffsInPlay(dto, gameData, monsterHrids);

    buffRows(inPlay.monsterSelf, DEP_TARGET);

    const hp = Math.max(0, Number(pools?.hp) || 0);
    const mp = Math.max(0, Number(pools?.mp) || 0);
    const foe = Math.max(0, Number(enemyHp) || 0);
    const at = (pool, fraction) => Math.max(1, Math.round(pool * fraction));
    if (slot.slotType === 'abilities' && foe > 0) {
        push(row(DEP_TARGET, COND_CURRENT_HP, CMP_GTE, at(foe, 0.5)));
        push(row(DEP_TARGET, COND_CURRENT_HP, CMP_LTE, at(foe, 0.5)));
    }
    if (hp > 0) {
        push(row(DEP_SELF, COND_MISSING_HP, CMP_GTE, at(hp, 0.25)));
        push(row(DEP_SELF, COND_MISSING_HP, CMP_GTE, at(hp, 0.5)));
    }
    if (mp > 0) {
        if (slot.slotType === 'abilities') push(row(DEP_SELF, COND_CURRENT_MP, CMP_GTE, at(mp, 0.5)));
        else push(row(DEP_SELF, COND_MISSING_MP, CMP_GTE, at(mp, 0.5)));
    }

    buffRows(inPlay.monsterOnMe, DEP_SELF);
    buffRows(inPlay.bySlot.get(slot.key) || [], DEP_SELF);
    buffRows(inPlay.mine, DEP_SELF);
    buffRows(inPlay.myOnTarget, DEP_TARGET);

    // A row the slot already has, alone, is no change worth screening
    const current = new Set((slot.rows || []).length === 1 ? [rowSignature(slot.rows[0])] : []);
    return out.filter((r) => !current.has(rowSignature(r))).slice(0, Math.max(0, cap));
}

/**
 * The player DTO with some slots' trigger rows replaced wholesale. Only the changed slots are copied.
 * @param {Object} dto - Source DTO (not mutated)
 * @param {Object} edits - slot key (`abilities|2`) → rows
 * @returns {Object}
 */
export function applyTriggerRows(dto, edits) {
    const keys = Object.keys(edits || {});
    if (!dto || keys.length === 0) return dto;
    const out = { ...dto };
    for (const key of keys) {
        const [slotType, index] = key.split('|');
        const i = Number(index);
        const slots = (out[slotType] || []).slice();
        if (!slots[i]) continue;
        slots[i] = { ...slots[i], triggers: edits[key].map((r) => ({ ...r, value: Number(r.value) || 0 })) };
        out[slotType] = slots;
    }
    return out;
}

/**
 * The AND-combinations the pairing stage tries: every pair of single-row survivors on different
 * conditions, and every survivor added to the slot's current rows, within the editor's four rows.
 * @param {Array<Array<Object>>} survivors - Row lists that beat the current rows in the screen
 * @param {Array<Object>} currentRows - The slot's rows now
 * @returns {Array<{rows: Array<Object>, kind: string}>}
 */
export function combineSurvivors(survivors, currentRows) {
    const out = [];
    const seen = new Set();
    const add = (rows, kind) => {
        if (rows.length === 0 || rows.length > MAX_TRIGGERS) return;
        const sig = rows.map(rowSignature).sort().join('&');
        if (seen.has(sig)) return;
        seen.add(sig);
        out.push({ rows, kind });
    };
    const singles = survivors.filter((rows) => rows.length === 1);
    for (let i = 0; i < singles.length; i++) {
        for (let j = i + 1; j < singles.length; j++) {
            const a = singles[i][0];
            const b = singles[j][0];
            // "Frenzy active AND Frenzy inactive" never fires; two thresholds on one reading are the tuner's job
            if (a.dependencyHrid === b.dependencyHrid && a.conditionHrid === b.conditionHrid) continue;
            add([a, b], 'pair');
        }
    }
    if (currentRows.length > 0) {
        for (const rows of singles) {
            const r = rows[0];
            const clash = currentRows.some(
                (c) => c.dependencyHrid === r.dependencyHrid && c.conditionHrid === r.conditionHrid
            );
            if (!clash) add([...currentRows, r], 'and-current');
        }
    }
    return out;
}

/**
 * Fight sims a condition search will run at most, per fight in the group: the screen of every
 * candidate, the pairing stage, a confirmation per slot, and the all-together check.
 * @param {Array<number>} candidateCounts - Single conditions per slot (the screen adds the "always" row list)
 * @param {Object} precision - A PRECISIONS entry
 * @returns {number} Sims per fight
 */
export function estimateConditionSimsPerFight(candidateCounts, precision) {
    const seeds = precision?.seeds || 4;
    const confirmSeeds = Math.max(CONFIRM_SEEDS_MIN, seeds);
    // The reference, the survivors, "always", their pairs, each survivor with the current rows, and the screen's best
    // current-AND-X entries
    const pairEntries = 1 + SCREEN_KEEP + 1 + (SCREEN_KEEP * (SCREEN_KEEP - 1)) / 2 + SCREEN_KEEP + SCREEN_KEEP;
    let total = 0;
    for (const count of candidateCounts) {
        // Screen: the current rows, each single, "always", and (at most) the current rows with each single
        total += (1 + count + 1 + count) * SCREEN_SEEDS + pairEntries * seeds + 2 * confirmSeeds;
    }
    return candidateCounts.length > 0 ? total + 2 * confirmSeeds : 0;
}

/** Score of one sample: fewer expected attempts is better */
const scoreOf = (sample) => -(Number(sample?.attempts) || 0);

/**
 * Run the staged condition search against an injected measure.
 * @param {Object} params
 * @param {Array<Object>} params.slots - From `conditionSlots`
 * @param {Function} params.candidatesFor - `(slot, referenceSamples) => Array<rows>`: single conditions to
 *   screen on that slot (the reference samples carry the pools)
 * @param {Function} params.measure - `(edits, { stream, count, offset, stage }) => Promise<Array<Sample>|null>`;
 *   `edits` maps slot key → rows over the starting loadout, `stream` names a set of seeds (equal names share
 *   seeds), `stage` is 'screen', 'pair', 'confirm' or 'final' (the caller sizes attempts by it). Samples
 *   carry `attempts`; null means stopped.
 * @param {Object} params.precision - A PRECISIONS entry (seeds per pairing round)
 * @param {number} params.minGain - Smallest saving worth offering, in attempts
 * @param {Function} [params.aborted] - `() => boolean`
 * @param {Function} [params.overBudget] - `(seedRuns) => boolean`: true when running `seedRuns` more seeds
 *   (summed over the batch's measure calls) would pass the sim cap. Each batch is checked before it is
 *   launched, with room kept for the all-together check, so the cap is a real bound.
 * @param {Function} [params.onProgress] - Called with `{ description }`
 * @param {Function} [params.score] - `(sample) => number`, higher is better; defaults to the Lab's fewer
 *   expected attempts. The Combat Sim passes its objective's score, so the same search maximizes that.
 * @returns {Promise<Object>} `{ changes, bestMeasured, rejected, combined, reliable, stopped, capped, screened,
 *   finalSamples }`; each change `{ key, slotType, slotIndex, itemHrid, itemName, fromRows, toRows, kind,
 *   deltaScore, se }`. `bestMeasured` holds, for each slot not changed, its best candidate in the same shape plus
 *   `stage` ('screen', 'pair' or 'confirm': where the figure comes from); `deltaScore` at or below 0 means the
 *   current rows measured best
 */
export async function runConditionSearch({
    slots,
    candidatesFor,
    measure,
    precision,
    minGain,
    aborted,
    overBudget,
    onProgress,
    score = scoreOf,
}) {
    const seeds = precision?.seeds || 4;
    const confirmSeeds = Math.max(CONFIRM_SEEDS_MIN, seeds);
    const accepted = {};
    const changes = [];
    let capped = false;
    let screened = 0;
    const stopped = () => Boolean(aborted?.());
    // The all-together check is kept room for, so slots never spend the budget it needs
    const finalReserve = 2 * confirmSeeds;
    const fits = (seedRuns, reserve = finalReserve) => {
        if (capped) return false;
        if (overBudget?.(seedRuns + reserve)) capped = true;
        return !capped;
    };
    const progress = (description) => onProgress?.({ description });
    // The best candidate measured for each slot, kept even when it did not clear the bar; a later stage's
    // figure replaces an earlier one's (it is the less inflated by having been picked)
    const bestBySlot = new Map();
    const noteBest = (slot, toRows, kind, diff, stage) => {
        bestBySlot.set(slot.key, {
            key: slot.key,
            slotType: slot.slotType,
            slotIndex: slot.slotIndex,
            itemHrid: slot.itemHrid,
            itemName: slot.itemName,
            fromRows: slot.rows,
            toRows,
            kind,
            deltaScore: diff.mean,
            se: diff.se,
            stage,
        });
    };
    const done = (extra = {}) => {
        const result = {
            changes,
            rejected: [],
            combined: null,
            reliable: null,
            stopped: stopped(),
            capped,
            screened,
            finalSamples: null,
            ...extra,
        };
        // Report every slot not in the FINAL kept changes: slots that passed one at a time but were rejected
        // by the all-together check are exactly the candidates worth showing
        const kept = new Set(result.changes.map((c) => c.key));
        return { ...result, bestMeasured: [...bestBySlot.values()].filter((b) => !kept.has(b.key)) };
    };

    for (const slot of slots || []) {
        if (stopped() || !fits(SCREEN_SEEDS)) break;
        const at = (rows) => ({ ...accepted, [slot.key]: rows });
        const reference = slot.rows;

        // 1. Screen: the current rows first (their samples carry the pools the numeric rows need), then
        //    every single-condition replacement and "always", on the same seeds
        progress(`Conditions: screening ${slot.itemName}`);
        const screenStream = `cscreen:${slot.key}`;
        const refScreen = await measure(at(reference), { stream: screenStream, count: SCREEN_SEEDS, stage: 'screen' });
        if (!refScreen || stopped()) break;
        const singles = (candidatesFor(slot, refScreen) || []).map((r) => [r]);
        // Every single replacement and "always", plus the current rows ANDed with each single: a condition
        // that is worse on its own (a buff only the monster has) can still help on top of the current rows
        const hasCurrent = reference.length > 0 && reference.length < MAX_TRIGGERS;
        const replacements = [
            ...[...singles, []]
                .filter((rows) => !sameRows(rows, reference))
                .map((rows) => ({
                    rows,
                    kind: rows.length === 0 ? 'always' : 'replace',
                })),
            ...singles
                .filter(
                    ([r]) =>
                        hasCurrent &&
                        !reference.some(
                            (c) => c.dependencyHrid === r.dependencyHrid && c.conditionHrid === r.conditionHrid
                        )
                )
                .map(([r]) => ({ rows: [...reference, r], kind: 'and-current' })),
        ];
        if (!fits(replacements.length * SCREEN_SEEDS)) break;
        const measured = await Promise.all(
            replacements.map((entry) =>
                measure(at(entry.rows), { stream: screenStream, count: SCREEN_SEEDS, stage: 'screen' })
            )
        );
        if (stopped() || measured.some((m) => !m)) break;
        screened += replacements.length;
        const refScores = refScreen.map(score);
        // Ranked by screen mean whatever the sign: two halves that only help together can each look
        // slightly worse alone, so a positive mean is not required to earn a place in the pairing stage
        const ranked = replacements
            .map((entry, i) => ({ ...entry, diff: pairedDiff(measured[i].map(score), refScores) }))
            .sort((a, b) => b.diff.mean - a.diff.mean);
        if (ranked.length === 0) continue;
        noteBest(slot, ranked[0].rows, ranked[0].kind, ranked[0].diff, 'screen');
        // "Always" competes for a place in the pairing stage but never displaces one of the top real singles,
        // the only rows the AND-pairs are built from
        const replaceRanked = ranked.filter((c) => c.kind !== 'and-current');
        const survivors = replaceRanked
            .filter((c) => c.kind !== 'always')
            .slice(0, SCREEN_KEEP)
            .map((c) => c.rows);
        const alwaysEntry = replaceRanked.slice(0, SCREEN_KEEP).find((c) => c.kind === 'always');
        const topAndCurrent = ranked.filter((c) => c.kind === 'and-current').slice(0, SCREEN_KEEP);

        // 2. Pairing: the survivors again, their AND-pairs and each with the current rows, on new seeds
        progress(`Conditions: combining for ${slot.itemName}`);
        const pairStream = `cpair:${slot.key}`;
        const entries = [
            ...survivors.map((rows) => ({ rows, kind: 'replace' })),
            ...(alwaysEntry ? [{ rows: alwaysEntry.rows, kind: 'always' }] : []),
            ...combineSurvivors(survivors, reference),
        ];
        // The best current-AND-X entries of the screen compete on their own merit
        for (const c of topAndCurrent) {
            const sig = c.rows.map(rowSignature).sort().join('&');
            if (!entries.some((e) => e.rows.map(rowSignature).sort().join('&') === sig)) {
                entries.push({ rows: c.rows, kind: 'and-current' });
            }
        }
        if (!fits((1 + entries.length) * seeds)) break;
        const [refPair, ...entryPair] = await Promise.all(
            [reference, ...entries.map((e) => e.rows)].map((rows) =>
                measure(at(rows), { stream: pairStream, count: seeds, stage: 'pair' })
            )
        );
        if (stopped() || !refPair || entryPair.some((m) => !m)) break;
        const refPairScores = refPair.map(score);
        let best = null;
        entries.forEach((entry, i) => {
            const diff = pairedDiff(entryPair[i].map(score), refPairScores);
            if (!best || diff.mean > best.diff.mean) best = { ...entry, diff };
        });
        // The pick is inflated by having been chosen; half the bar skips hopeless confirmations
        if (best) noteBest(slot, best.rows, best.kind, best.diff, 'pair');
        if (!best || best.diff.mean < minGain / 2) continue;

        // 3. Confirm on fresh seeds, sequentially, as the threshold search does
        progress(`Conditions: confirming ${slot.itemName}`);
        const confirmStream = `cconfirm:${slot.key}`;
        const looks = confirmLooks(confirmSeeds);
        let refSamples = [];
        let winSamples = [];
        let diff = null;
        let verdict = 'continue';
        for (let look = 0; look < looks.length && verdict === 'continue'; look++) {
            const from = look > 0 ? looks[look - 1] : 0;
            const count = looks[look] - from;
            if (!fits(2 * count)) break;
            const [moreRef, moreWin] = await Promise.all([
                measure(at(reference), { stream: confirmStream, count, offset: from, stage: 'confirm' }),
                measure(at(best.rows), { stream: confirmStream, count, offset: from, stage: 'confirm' }),
            ]);
            if (!moreRef || !moreWin || stopped()) break;
            refSamples = refSamples.concat(moreRef);
            winSamples = winSamples.concat(moreWin);
            diff = pairedDiff(winSamples.map(score), refSamples.map(score));
            verdict = sequentialVerdict(diff, look, looks.length, minGain);
        }
        if (stopped() || capped) break;
        if (verdict !== 'accept') {
            if (diff) noteBest(slot, best.rows, best.kind, diff, 'confirm');
            continue;
        }

        // Recorded now so a slot the all-together check later rejects reports this fresh-seed figure, not the
        // pairing stage's selection-biased one
        noteBest(slot, best.rows, best.kind, diff, 'confirm');
        accepted[slot.key] = best.rows;
        changes.push({
            key: slot.key,
            slotType: slot.slotType,
            slotIndex: slot.slotIndex,
            itemHrid: slot.itemHrid,
            itemName: slot.itemName,
            fromRows: reference,
            toRows: best.rows,
            kind: best.kind,
            deltaScore: diff.mean,
            se: diff.se,
        });
    }

    if (changes.length === 0 || stopped()) return done();

    // 4. Everything accepted, together, against the starting rows on seeds nothing above has seen
    // No budget check here: every batch above was only launched with this check's room kept, so it
    // runs even after a later slot hit the cap — otherwise reaching the cap would discard confirmed changes
    progress('Conditions: confirming all changes together');
    const [before, after] = await Promise.all([
        measure({}, { stream: 'cfinal', count: confirmSeeds, stage: 'final' }),
        measure({ ...accepted }, { stream: 'cfinal', count: confirmSeeds, stage: 'final' }),
    ]);
    if (!before || !after || stopped()) return done();
    const diff = pairedDiff(after.map(score), before.map(score));
    const reliable = accepts(diff, minGain);
    const combined = {
        deltaScore: diff.mean,
        se: diff.se,
        seeds: diff.n,
        attemptsBefore: mean(before.map((s) => Number(s?.attempts) || 0)),
        attemptsAfter: mean(after.map((s) => Number(s?.attempts) || 0)),
    };
    return done({
        changes: reliable ? changes : [],
        rejected: reliable ? [] : changes,
        combined,
        reliable,
        finalSamples: { before, after },
    });
}

/**
 * Trigger rows in the game's own wording: "Activate when: My Toughness Is Inactive AND Target Enemy's
 * Frenzy Is Active". Numeric rows read "My Missing Hp >= 300".
 * @param {Array<Object>} rows - Trigger rows
 * @param {Object} gameData - Game data payload (the three trigger detail maps)
 * @returns {string}
 */
export function describeTriggerRows(rows, gameData) {
    if (!rows || rows.length === 0) return 'Activate when: always (no conditions)';
    const name = (map, hrid) =>
        gameData?.[map]?.[hrid]?.name ||
        String(hrid || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ');
    const parts = rows.map((r) => {
        const dep = name('combatTriggerDependencyDetailMap', r.dependencyHrid);
        const cond = name('combatTriggerConditionDetailMap', r.conditionHrid);
        const cmp = name('combatTriggerComparatorDetailMap', r.comparatorHrid);
        const withValue = r.comparatorHrid === CMP_GTE || r.comparatorHrid === CMP_LTE;
        return `${dep} ${cond} ${cmp}${withValue ? ` ${Number(r.value) || 0}` : ''}`;
    });
    return `Activate when: ${parts.join(' AND ')}`;
}
