/**
 * Combat Level panel
 *
 * How close the next combat level is, which skill gets you there, and what the
 * session has actually earned.
 *
 * The game shows a whole number. That hides both facts worth acting on: combat
 * level is a weighted average, so the fraction you have already earned is
 * invisible, and the skill that would finish it soonest is usually not the one
 * being trained.
 *
 * ## The bar is not the fraction of the formula
 *
 * The obvious reading of "how far to the next combat level" is the fraction the
 * displayed whole number throws away — `126.300` is 30% of the way to 127. That
 * is wrong, and wrong in a way that matters. Combat level is computed from whole
 * skill levels, so it steps; feed it the part-finished levels instead and it
 * becomes continuous. A build at `126.300` whose Melee is 81.7% of the way to
 * its next level is **79%** of the way to Combat 127, not 30% — because most of
 * the Melee level carrying the doubled term is already in the bank.
 *
 * So the panel runs the formula twice. Whole levels give the number the game
 * shows and the arithmetic spelled out beside it; fractional levels give the
 * bar. The bar is drawn in two colours for the same reason: the part banked from
 * completed levels, then the part contributed by the level in progress.
 *
 * ## What is on it
 *
 * - the session: when it started, how long, how much experience, at what rate
 * - a target selector: any skill, any level, the time to get there
 * - the combat level, the formula, and the two-tone bar above
 * - a block per skill actually gaining, with its share of the experience
 * - Time to Level, where reassigning the primary and focus skills answers "what
 *   if I trained something else instead" without training it
 * - the skills not gaining, compactly, and the charms and wisdom multiplying it
 * - experience between any two levels
 *
 * The arithmetic is in `utils/combat-level.js` and `utils/exp-session.js`,
 * checked against the figures GWhiz shows for the same build — `126.300`, the
 * 79% bar, "2 Levels of Melee", and the 8d 22h behind it are all reproduced.
 *
 * The panel is GWhiz's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatWithSeparator, formatKMB, timeReadable } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { shortDuration, row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import {
    COMBAT_SKILLS,
    OFFENSE_SKILLS,
    combatLevel,
    combatValueOf,
    levelsToNextCombat,
    cheapestRouteToNextCombat,
    levelFraction,
    fractionalLevels,
    experienceBetween,
    timeToTargetLevel,
} from '../../utils/combat-level.js';
import { beginSession, sessionProgress, sessionIsStale } from '../../utils/exp-session.js';
import { calculateExperienceMultiplier } from '../../utils/experience-parser.js';
import { experiencePerHour, skillName } from '../../utils/skill-progress.js';
import { registerRow } from '../../utils/overlay-rows.js';

const PANEL_ID = 'toolasha-combat-level-panel';
const GEOMETRY_KEY = 'combatLevelPanel';
const DEFAULT_PANEL = { width: 560, height: 720 };
const REFRESH_MS = 5000;
const COMBAT_ACTION_TYPE = '/action_types/combat';

/** How far back the rate behind each countdown is measured */
const WINDOW_MS = 10 * 60 * 1000;
const SAMPLE_MS = 5000;

/** How many segments the combat bar is divided into, as GWhiz draws it */
const BAR_SEGMENTS = 10;

const COLORS = {
    background: 'rgba(14, 16, 22, 0.97)',
    card: 'rgba(255, 255, 255, 0.04)',
    headerBg: 'rgba(28, 20, 34, 0.9)',
    border: 'rgba(190, 150, 255, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    track: 'rgba(255, 255, 255, 0.08)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#c9a0ff',
    combat: '#f0a030',
};

/**
 * A colour per combat skill, so the formula reads as the build it describes.
 *
 * The terms of a weighted average are anonymous numbers in a row; colouring them
 * is what lets you see at a glance which of the five the doubled term repeats.
 */
const SKILL_COLORS = {
    stamina: '#f0776c',
    intelligence: '#4fc3d9',
    attack: '#e8c14a',
    defense: '#7fd6c0',
    melee: '#e05555',
    ranged: '#5fd0a0',
    magic: '#b47ae8',
};

/** skillHrid → [{t, xp}], oldest first */
const history = new Map();
let lastSampleAt = 0;

/**
 * The session, kept at module scope so closing the panel does not reset it.
 *
 * Closing a panel is not the same gesture as starting a new measurement, and
 * conflating them means the one number you cannot recover — how long you have
 * been at this — is thrown away by tidying up.
 */
let session = null;

/**
 * Take a reading of every combat skill, if one is due.
 *
 * Kept here rather than shared with the Time to Level row because the two want
 * different windows and neither should be able to reset the other's history by
 * being opened or closed.
 */
function sample() {
    const now = Date.now();
    if (now - lastSampleAt < SAMPLE_MS) return;
    lastSampleAt = now;

    for (const skill of dataManager.getSkills?.() || []) {
        if (!skill?.skillHrid || !Number.isFinite(skill.experience)) continue;

        const readings = history.get(skill.skillHrid) || [];
        readings.push({ t: now, xp: skill.experience });
        while (readings.length > 2 && readings[1].t < now - WINDOW_MS) readings.shift();
        history.set(skill.skillHrid, readings);
    }
}

/**
 * The current character's combat skills, levels and measured rates.
 *
 * Exported because it is the join between the game's data and the arithmetic,
 * and a disagreement between the panel and the game would be here rather than
 * in the formula.
 *
 * @returns {{levels: Object, skills: Array<Object>, table: number[], totalPerHour: number}|null}
 */
export function combatSkillState() {
    const all = dataManager.getSkills?.();
    const table = dataManager.getInitClientData?.()?.levelExperienceTable;
    if (!all || !table) return null;

    const levels = {};
    const skills = [];
    let totalPerHour = 0;

    for (const name of COMBAT_SKILLS) {
        const hrid = `/skills/${name}`;
        const skill = all.find((entry) => entry.skillHrid === hrid);
        if (!skill) continue;

        levels[name] = skill.level;

        const readings = history.get(hrid) || [];
        const perHour = experiencePerHour(readings[0], readings[readings.length - 1]);
        if (perHour) totalPerHour += perHour;

        skills.push({
            name,
            hrid,
            level: skill.level,
            experience: skill.experience,
            perHour,
            fraction: levelFraction(skill.experience, skill.level, table),
            remaining: Math.max(0, (table[skill.level + 1] ?? skill.experience) - skill.experience),
            atCap: table[skill.level + 1] === undefined,
        });
    }

    // Share of the run's experience, which is what makes "what if I trained
    // something else" answerable — the split is a property of the setup, not of
    // the skills that happen to be receiving it
    for (const skill of skills) skill.share = totalPerHour > 0 ? (skill.perHour || 0) / totalPerHour : 0;

    return { levels, skills, table, totalPerHour };
}

/**
 * The skill gaining fastest, which is the one a selector should open on.
 *
 * @param {Object} state - From `combatSkillState`
 * @returns {Object|null} The skill, or null when nothing is measurably moving
 */
export function busiest(state) {
    let best = null;
    for (const skill of state?.skills || []) {
        if (skill.perHour && (!best || skill.perHour > best.perHour)) best = skill;
    }
    return best;
}

/**
 * Start or restart the session against the current readings.
 * @param {Array<Object>} skills - From `combatSkillState`
 */
export function resetSession(skills) {
    session = beginSession(
        skills.map((skill) => ({ hrid: skill.hrid, experience: skill.experience })),
        Date.now()
    );
}

/**
 * The session so far, starting one if there is not one yet.
 *
 * A session whose baseline is above the current readings belongs to a different
 * character, so it is replaced rather than reported as a loss.
 *
 * @param {Array<Object>} skills - From `combatSkillState`
 * @returns {Object} From `sessionProgress`, plus when it started
 */
function sessionFor(skills) {
    const readings = skills.map((skill) => ({ hrid: skill.hrid, experience: skill.experience }));
    if (!session || sessionIsStale(session, readings)) resetSession(skills);

    return { ...sessionProgress(session, readings, Date.now()), startedAt: session.startedAt };
}

/**
 * The combat level as a continuous figure, from part-finished levels.
 *
 * @param {Object} state - From `combatSkillState`
 * @returns {{whole: Object, partial: Object}} The formula run on whole and on fractional levels
 */
export function combatProgress(state) {
    return {
        whole: combatLevel(state.levels),
        partial: combatLevel(fractionalLevels(state.skills, state.table)),
    };
}

/**
 * How long the next combat level is away, by the shortest route.
 *
 * The route is a number of levels of one skill; the time is what those levels
 * cost at the rate that skill is actually gaining. Both parts have to come from
 * the same skill or the answer is a mixture of two plans.
 *
 * @param {Object} state - From `combatSkillState`
 * @returns {{skill: string, levels: number, seconds: number|null}|null}
 */
export function nextCombatLevel(state) {
    const route = cheapestRouteToNextCombat(state.levels);
    if (!route) return null;

    const skill = state.skills.find((entry) => entry.name === route.skill);
    if (!skill) return { ...route, seconds: null };

    return {
        ...route,
        seconds: timeToTargetLevel({
            experience: skill.experience,
            target: skill.level + route.levels,
            table: state.table,
            perHour: skill.perHour,
        }),
    };
}

class CombatLevelPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.refreshId = null;
        /** Per skill, the level being aimed at; blank means the next one */
        this.targets = {};
        /** The two ends of the experience lookup */
        this.lookup = { from: null, to: null };
        /** The standalone selector at the top */
        this.ttl = { skill: null, level: null };
        /** Which skills the measured shares are being applied to */
        this.assigned = { primary: null, focus: null };
        /** Sections folded away */
        this.collapsed = {};
    }

    /** Open the panel, or raise it if it is already up */
    show() {
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    hide() {
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '120px',
            left: '90px',
            zIndex: String(config.Z_FLOATING_PANEL),
            width: `${DEFAULT_PANEL.width}px`,
            height: `${DEFAULT_PANEL.height}px`,
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        this.headerEl = this._header();
        this.panel.appendChild(this.headerEl);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, this.headerEl, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 420,
            minHeight: 240,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 420, height: 240 });

        this._render();
        this.refreshId = setInterval(() => this._render(), REFRESH_MS);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Combat Level';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        // The two figures worth having on the title bar when the rest is scrolled
        // away: what the run is earning, and when the next level lands
        this.headerRate = document.createElement('span');
        this.headerRate.style.color = ROW_COLORS.good;

        this.headerNext = document.createElement('span');
        this.headerNext.style.color = COLORS.combat;

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 4px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            this.hide();
        });

        header.append(title, this.headerRate, this.headerNext, spacer, close);
        return header;
    }

    _render() {
        if (!this.bodyEl) return;

        // Rebuilding the body under a field being used takes the caret or the
        // open dropdown with it, so anything half-entered on the five-second
        // boundary is lost
        const active = document.activeElement;
        if (this.panel.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;

        sample();

        const state = combatSkillState();
        this.bodyEl.replaceChildren();

        if (!state?.skills.length) {
            this.headerRate.textContent = '';
            this.headerNext.textContent = '';
            this.bodyEl.appendChild(this._note('No combat skills loaded yet.'));
            return;
        }

        const next = nextCombatLevel(state);
        this.headerRate.textContent = state.totalPerHour
            ? `${formatWithSeparator(Math.round(state.totalPerHour))} exp/hr`
            : '';
        this.headerNext.textContent =
            next && next.seconds !== null
                ? `Combat ${combatLevel(state.levels).level + 1}: ${shortDuration(next.seconds)}`
                : '';

        const sections = [
            () => this._sessionBar(state),
            () => this._targetSelector(state),
            () => this._combatBlock(state, next),
            ...state.skills.filter((entry) => entry.perHour).map((skill) => () => this._skillBlock(skill, state)),
            () => this._timeToLevel(state),
            () => this._charms(state),
            () => this._expLookup(state),
        ];
        for (const build of sections) this._section(build);
    }

    /**
     * Draw one section, or say which one could not be drawn.
     *
     * Without this the panel is all-or-nothing: one section that throws takes
     * every section after it with it, and what you see is a panel that stops
     * halfway with nothing to say why. Half a panel looks like a missing feature
     * rather than a bug, which is exactly the wrong thing for it to look like.
     *
     * @param {Function} build - Returns the section's element
     */
    _section(build) {
        try {
            this.bodyEl.appendChild(build());
        } catch (error) {
            console.error('[CombatLevel] A section could not be drawn:', error);
            const failed = this._note(`This section could not be drawn: ${error.message}`);
            failed.style.color = ROW_COLORS.bad;
            this.bodyEl.appendChild(failed);
        }
    }

    /**
     * When the session started, how long it has run, and what it earned.
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _sessionBar(state) {
        const card = this._card();
        Object.assign(card.style, { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' });

        const progress = sessionFor(state.skills);
        const started = new Date(progress.startedAt);

        card.append(
            this._label('Start:'),
            this._value(
                started.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            ),
            this._label('Duration:'),
            this._value(timeReadable(Math.round(progress.seconds))),
            this._label('Exp:'),
            this._value(formatWithSeparator(Math.round(progress.total)), ROW_COLORS.gold),
            this._label('Exp/Hr:'),
            // Nothing rather than a made-up figure for the first twenty seconds,
            // so the panel is not briefly claiming millions an hour on opening
            this._value(
                progress.perHour === null ? 'measuring…' : `${formatWithSeparator(Math.round(progress.perHour))}/hr`,
                progress.perHour === null ? COLORS.textDim : ROW_COLORS.good
            )
        );

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const reset = this._button('Reset', () => {
            resetSession(state.skills);
            this._render();
        });
        reset.title = 'Start the clock and the totals again from right now.';

        card.append(spacer, reset);
        return card;
    }

    /**
     * Any skill, any level, how long.
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _targetSelector(state) {
        const card = this._card('Target Selector');
        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '8px' });

        const chosen = this.ttl.skill ?? busiest(state)?.name ?? state.skills[0].name;
        const skill = state.skills.find((entry) => entry.name === chosen) || state.skills[0];
        const target = this.ttl.level ?? skill.level + 1;

        const picker = this._select(state, chosen, (value) => {
            this.ttl.skill = value;
            // The level was for the old skill, so it is not carried across —
            // "level 135" means something different for a skill at 106
            this.ttl.level = null;
            this._render();
        });
        picker.style.width = '128px';

        const level = this._number(target, (value) => {
            this.ttl.level = value;
            this._render();
        });
        level.style.width = '68px';

        const seconds = timeToTargetLevel({
            experience: skill.experience,
            target,
            table: state.table,
            perHour: skill.perHour,
        });
        const answer = this._value(seconds === null ? '—' : shortDuration(seconds), COLORS.accent);
        answer.title = skill.perHour
            ? `At ${formatWithSeparator(Math.round(skill.perHour))} exp/hr.`
            : 'No measured rate for this skill, so there is no honest time to give.';

        line.append(picker, level, answer);
        card.appendChild(line);
        return card;
    }

    /**
     * The combat level, the formula, and how far through the next one you are.
     *
     * @param {Object} state - From `combatSkillState`
     * @param {Object|null} next - From `nextCombatLevel`
     * @returns {HTMLElement}
     */
    _combatBlock(state, next) {
        const card = this._card();
        const { whole, partial } = combatProgress(state);

        const top = document.createElement('div');
        Object.assign(top.style, { display: 'flex', alignItems: 'baseline', gap: '10px' });

        const level = document.createElement('span');
        level.textContent = String(whole.level);
        Object.assign(level.style, { fontSize: '22px', fontWeight: 'bold', color: COLORS.combat });

        const heading = document.createElement('span');
        heading.textContent = 'Combat';
        heading.style.fontWeight = 'bold';

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const eta = this._value(next?.seconds != null ? shortDuration(next.seconds) : '—', COLORS.accent);
        eta.title = next
            ? `${next.levels} level(s) of ${skillName(next.skill)} at the rate it is currently gaining.`
            : 'No route measured yet.';

        top.append(level, heading, spacer, eta);
        card.appendChild(top);

        // The terms coloured by the skill each one is, so the repeated one is
        // visible rather than inferred
        card.appendChild(this._formula(state, whole));
        card.appendChild(this._combatBar(whole.progress, partial.progress, partial.doubled));

        const note = document.createElement('div');
        note.style.color = COLORS.textDim;
        if (next) {
            note.append(
                document.createTextNode(`${next.levels} level${next.levels === 1 ? '' : 's'} of `),
                this._value(skillName(next.skill), SKILL_COLORS[next.skill]),
                document.createTextNode(' needed to level Combat')
            );
        } else {
            note.textContent = 'No single skill reaches the next combat level within the search.';
        }
        card.appendChild(note);
        return card;
    }

    /**
     * The formula, spelled out and coloured.
     *
     * The doubled term is its own skill's level rather than the last term of the
     * sum: the sum takes the best of the three offensive skills and the doubled
     * term the best of five, and they part company whenever Attack or Defense
     * leads.
     *
     * @param {Object} state - From `combatSkillState`
     * @param {Object} whole - `combatLevel` on whole levels
     * @returns {HTMLElement}
     */
    _formula(state, whole) {
        const line = document.createElement('div');
        Object.assign(line.style, {
            fontFamily: 'monospace',
            fontSize: '13px',
            margin: '4px 0',
            whiteSpace: 'nowrap',
            overflowX: 'auto',
        });

        const named = ['stamina', 'intelligence', 'attack', 'defense'];
        line.append(this._value('0.1×(', COLORS.textDim));

        named.forEach((skill, index) => {
            if (index) line.append(this._value('+', COLORS.textDim));
            line.append(this._value(String(state.levels[skill] ?? 0), SKILL_COLORS[skill]));
        });
        line.append(
            this._value('+', COLORS.textDim),
            this._value(String(whole.terms[4]), SKILL_COLORS[whole.best]),
            this._value(')+0.5×', COLORS.textDim),
            this._value(String(whole.doubledLevel), SKILL_COLORS[whole.doubled]),
            this._value('=', COLORS.textDim),
            this._value(whole.exact.toFixed(3), COLORS.combat)
        );

        line.title =
            `The sum takes the highest of Melee, Ranged and Magic (${skillName(whole.best)}); ` +
            `the doubled term takes the highest of those three plus Attack and Defense (${skillName(whole.doubled)}).`;
        return line;
    }

    /**
     * The two-tone segmented bar.
     *
     * @param {number} banked - Progress from whole levels alone
     * @param {number} earned - Progress including the level in progress
     * @param {string} doubled - The skill carrying the doubled term
     * @returns {HTMLElement}
     */
    _combatBar(banked, earned, doubled) {
        const wrap = document.createElement('div');
        Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 5px' });

        const track = document.createElement('div');
        Object.assign(track.style, {
            position: 'relative',
            flex: '1',
            height: '12px',
            background: COLORS.track,
            borderRadius: '3px',
            overflow: 'hidden',
        });

        // Drawn as one fill under another rather than two side by side, so a
        // rounding disagreement between them cannot leave a seam
        const partial = document.createElement('div');
        Object.assign(partial.style, {
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${(Math.min(1, earned) * 100).toFixed(2)}%`,
            background: SKILL_COLORS[doubled] || COLORS.accent,
        });
        const whole = document.createElement('div');
        Object.assign(whole.style, {
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${(Math.min(1, banked) * 100).toFixed(2)}%`,
            background: COLORS.combat,
        });

        // Ten notches, which is what makes a bar readable as a fraction without
        // reading the number beside it
        const notches = document.createElement('div');
        Object.assign(notches.style, {
            position: 'absolute',
            inset: '0',
            display: 'grid',
            gridTemplateColumns: `repeat(${BAR_SEGMENTS}, 1fr)`,
        });
        for (let index = 1; index < BAR_SEGMENTS; index++) {
            const notch = document.createElement('div');
            notch.style.borderRight = `1px solid ${COLORS.background}`;
            notches.appendChild(notch);
        }

        track.append(partial, whole, notches);

        const percent = this._value(`${(earned * 100).toFixed(1)}%`, COLORS.combat);
        percent.style.fontWeight = 'bold';
        percent.title =
            `${(banked * 100).toFixed(1)}% from levels already finished, and the rest from the ` +
            `${skillName(doubled)} level in progress.`;

        wrap.append(track, percent);
        return wrap;
    }

    /**
     * One skill that is actually gaining: level, remaining, rate, share, bar.
     *
     * @param {Object} skill - From `combatSkillState`
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _skillBlock(skill, state) {
        const card = this._card();
        const color = SKILL_COLORS[skill.name];

        const top = document.createElement('div');
        Object.assign(top.style, { display: 'flex', alignItems: 'baseline', gap: '8px' });

        const level = document.createElement('span');
        level.textContent = String(skill.level);
        Object.assign(level.style, { fontSize: '18px', fontWeight: 'bold', color });

        const name = document.createElement('span');
        name.textContent = skillName(skill.hrid);
        name.style.fontWeight = 'bold';

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const remaining = this._value(
            skill.atCap ? 'At the cap' : `Remaining: ${formatWithSeparator(Math.round(skill.remaining))}`,
            ROW_COLORS.good
        );

        const seconds = timeToTargetLevel({
            experience: skill.experience,
            target: skill.level + 1,
            table: state.table,
            perHour: skill.perHour,
        });
        const eta = this._value(seconds === null ? '—' : shortDuration(seconds), COLORS.accent);

        top.append(level, name, spacer, remaining, eta);
        card.appendChild(top);

        const bar = document.createElement('div');
        Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 3px' });

        const track = document.createElement('div');
        Object.assign(track.style, {
            flex: '1',
            height: '10px',
            background: COLORS.track,
            borderRadius: '3px',
            overflow: 'hidden',
        });
        const fill = document.createElement('div');
        Object.assign(fill.style, {
            height: '100%',
            width: `${(skill.fraction * 100).toFixed(2)}%`,
            background: color,
        });
        track.appendChild(fill);

        const percent = this._value(`${(skill.fraction * 100).toFixed(1)}%`, color);
        percent.style.fontWeight = 'bold';

        bar.append(track, percent);
        card.appendChild(bar);

        const progress = sessionFor(state.skills);
        const earned = progress.bySkill.find((entry) => entry.hrid === skill.hrid)?.gained ?? 0;

        const footer = document.createElement('div');
        footer.style.color = COLORS.textDim;
        footer.textContent =
            `${formatWithSeparator(Math.round(skill.perHour))}/hr (${(skill.share * 100).toFixed(1)}%)` +
            `  ·  ${formatWithSeparator(Math.round(earned))} exp this session`;
        card.appendChild(footer);

        return card;
    }

    /**
     * What every skill would take, and what it would take if you trained
     * something else instead.
     *
     * The split between the two skills receiving experience is a property of the
     * setup rather than of those skills — swap which style you attack with and
     * the same proportions land somewhere else. So the shares are measured and
     * the skills they apply to are yours to reassign, which answers "how long
     * would Ranged take" without spending a day finding out.
     *
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _timeToLevel(state) {
        const card = this._card();
        card.appendChild(this._foldHeading('Time to Level', 'ttl'));
        if (this.collapsed.ttl) return card;

        const gaining = state.skills.filter((entry) => entry.perHour).sort((a, b) => b.perHour - a.perHour);
        const measuredFocus = gaining.find((entry) => OFFENSE_SKILLS.includes(entry.name)) || gaining[0] || null;
        const measuredPrimary = gaining.find((entry) => entry !== measuredFocus) || null;

        const focus = this.assigned.focus ?? measuredFocus?.name ?? null;
        const primary = this.assigned.primary ?? measuredPrimary?.name ?? null;

        if (!gaining.length) {
            card.appendChild(this._note('Nothing measurable yet — the split appears once experience is coming in.'));
        } else {
            card.appendChild(
                this._assignment('Primary', primary, measuredPrimary, state, (value) => {
                    this.assigned.primary = value;
                    this._render();
                })
            );
            card.appendChild(
                this._assignment('Focus', focus, measuredFocus, state, (value) => {
                    this.assigned.focus = value;
                    this._render();
                })
            );
        }

        // The rate each skill would see under the current assignment, rather
        // than the rate it is seeing — that is the whole point of the selectors
        const projected = {};
        if (measuredPrimary && primary) projected[primary] = measuredPrimary.perHour;
        if (measuredFocus && focus) projected[focus] = measuredFocus.perHour;

        const heading = this._tableRow();
        heading.style.color = COLORS.textDim;
        heading.style.borderBottom = `1px solid ${COLORS.hairline}`;
        heading.style.padding = '4px 0 3px';
        for (const text of ['Skill', 'Current', 'Exp/Hr', 'To Combat', 'Target', 'Time']) {
            const cell = document.createElement('span');
            cell.textContent = text;
            if (text !== 'Skill') cell.style.textAlign = 'right';
            heading.appendChild(cell);
        }
        card.appendChild(heading);

        const doubled = combatLevel(state.levels).doubled;
        for (const skill of state.skills)
            card.appendChild(this._skillRow(skill, state, doubled, projected[skill.name]));
        return card;
    }

    /**
     * One of the two reassignable shares.
     *
     * @param {string} label - "Primary" or "Focus"
     * @param {string|null} chosen - Which skill it is pointed at
     * @param {Object|null} measured - The skill the share was measured from
     * @param {Object} state - From `combatSkillState`
     * @param {Function} onChange - Called with the new skill name
     * @returns {HTMLElement}
     */
    _assignment(label, chosen, measured, state, onChange) {
        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '7px', padding: '2px 0' });

        const name = this._label(`${label}:`);
        name.style.minWidth = '52px';

        const detail = document.createElement('span');
        if (measured) {
            detail.append(
                this._value(`${(measured.share * 100).toFixed(1)}%`, ROW_COLORS.gold),
                document.createTextNode(' '),
                this._value(`(${formatWithSeparator(Math.round(measured.perHour))} exp/hr)`, COLORS.textDim)
            );
        } else {
            detail.append(this._value('not measured', COLORS.textDim));
        }

        const picker = this._select(state, chosen, onChange);
        picker.style.width = '128px';
        picker.title = `Apply this share to a different skill to see what training it instead would take.`;

        line.append(name, detail, picker);
        return line;
    }

    /**
     * @param {Object} skill - One combat skill
     * @param {Object} state - From `combatSkillState`
     * @param {string} doubled - The skill carrying the doubled term
     * @param {number|undefined} projected - The rate under the current assignment
     * @returns {HTMLElement}
     */
    _skillRow(skill, state, doubled, projected) {
        const line = this._tableRow();
        line.style.padding = '2px 0';

        const name = document.createElement('span');
        name.textContent = skillName(skill.hrid);
        name.style.color = SKILL_COLORS[skill.name];
        // The doubled skill is the one every plan turns on, so it reads as such
        if (skill.name === doubled) {
            name.style.fontWeight = 'bold';
            name.title = 'Carries the doubled term, so a level of it is worth six of anything else.';
        }

        const level = this._cell(String(skill.level));
        const rate = this._cell(projected ? formatWithSeparator(Math.round(projected)) : '—');
        rate.style.color = projected ? ROW_COLORS.good : COLORS.textDim;
        if (projected && projected !== skill.perHour) {
            rate.style.fontStyle = 'italic';
            rate.title = 'Projected from the measured share, not measured on this skill.';
        }

        // What a level of this is worth, and how many of them are needed
        const needed = levelsToNextCombat(state.levels, skill.name);
        const worth = combatValueOf(state.levels, skill.name);
        const toCombat = this._cell(needed === null ? '—' : `${needed} × ${worth.toFixed(1)}`);
        toCombat.style.color = needed === null ? COLORS.textDim : ROW_COLORS.gold;
        toCombat.title =
            needed === null
                ? 'More levels than the search looks ahead, so no honest number to give.'
                : `Each level is worth ${worth.toFixed(1)} combat levels right now.`;

        const target = this.targets[skill.name] ?? skill.level + 1;
        const targetInput = this._number(target, (value) => {
            this.targets[skill.name] = value;
            this._render();
        });

        const seconds = timeToTargetLevel({
            experience: skill.experience,
            target,
            table: state.table,
            perHour: projected,
        });
        const time = this._cell(seconds === null ? '—' : shortDuration(seconds));
        time.style.color = seconds === null ? COLORS.textDim : COLORS.accent;

        const owed = experienceBetween(skill.level, target, state.table);
        time.title =
            owed === null
                ? 'That level is not on the game’s experience table.'
                : `${formatWithSeparator(owed)} experience from level ${skill.level} to ${target}.`;

        line.append(name, level, rate, toCombat, targetInput, time);
        return line;
    }

    /**
     * The skills not gaining, and what is multiplying the ones that are.
     *
     * The compact half is GWhiz's: a skill with no rate has nothing to say about
     * time, so it gets a tile with its level and how far into it rather than a
     * row of dashes. The wisdom and charm figures beneath come from Toolasha's
     * own experience parser, so they agree with the action panels.
     *
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _charms(state) {
        const card = this._card();
        card.appendChild(this._foldHeading('Charms & Idle Skills', 'charms'));
        if (this.collapsed.charms) return card;

        const idle = state.skills.filter((skill) => !skill.perHour);
        if (idle.length) {
            const grid = document.createElement('div');
            Object.assign(grid.style, {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: '5px',
                margin: '2px 0 6px',
            });

            for (const skill of idle) {
                const tile = document.createElement('div');
                Object.assign(tile.style, {
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '6px',
                    background: COLORS.track,
                    borderRadius: '4px',
                    padding: '3px 7px',
                });

                const level = this._value(String(skill.level), SKILL_COLORS[skill.name]);
                level.style.fontWeight = 'bold';

                const name = document.createElement('span');
                name.textContent = skillName(skill.hrid);
                name.style.flex = '1';

                const percent = this._value(`${Math.round(skill.fraction * 100)}%`, ROW_COLORS.good);
                percent.title = 'How far into this level it already is.';

                tile.append(level, name, percent);
                grid.appendChild(tile);
            }
            card.appendChild(grid);
        }

        let wisdom = null;
        const charmed = [];
        for (const skill of state.skills) {
            let result = null;
            try {
                result = calculateExperienceMultiplier(skill.hrid, COMBAT_ACTION_TYPE);
            } catch (error) {
                console.error('[CombatLevel] Could not read the experience multiplier:', error);
                continue;
            }
            if (wisdom === null) wisdom = result.totalWisdom;
            if (result.charmExperience > 0) charmed.push({ skill, result });
        }

        if (wisdom === null) {
            card.appendChild(this._note('Nothing loaded to read bonuses from yet.'));
            return card;
        }

        const summary = document.createElement('div');
        summary.append(
            this._label('Wisdom'),
            document.createTextNode(' '),
            this._value(`${wisdom.toFixed(2)}%`, ROW_COLORS.good),
            document.createTextNode(' on every combat skill')
        );
        summary.title = 'Wisdom and charm experience add together before multiplying, rather than compounding.';
        card.appendChild(summary);

        if (!charmed.length) {
            card.appendChild(this._note('No charm is boosting a combat skill.'));
            return card;
        }

        for (const { skill, result } of charmed) {
            const line = document.createElement('div');
            Object.assign(line.style, { display: 'flex', gap: '8px', padding: '1px 0' });

            const name = this._value(skillName(skill.hrid), SKILL_COLORS[skill.name]);
            name.style.minWidth = '86px';

            const source = document.createElement('span');
            Object.assign(source.style, {
                color: COLORS.textDim,
                flex: '1',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
            });
            source.textContent = result.charmBreakdown.map((entry) => entry.name).join(', ');

            line.append(
                name,
                this._value(`+${result.charmExperience.toFixed(2)}%`, COLORS.accent),
                source,
                this._value(`×${result.totalMultiplier.toFixed(3)}`, ROW_COLORS.gold)
            );
            card.appendChild(line);
        }
        return card;
    }

    /**
     * Experience between any two levels, which the game never shows.
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _expLookup(state) {
        const card = this._card();
        card.appendChild(this._foldHeading('Exp Lookup', 'lookup'));
        if (this.collapsed.lookup) return card;

        const from = this.lookup.from ?? 1;
        const to = this.lookup.to ?? Math.min(from + 99, state.table.length - 1);

        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '8px' });

        const fromInput = this._number(from, (value) => {
            this.lookup.from = value;
            this._render();
        });
        fromInput.style.width = '72px';

        const toInput = this._number(to, (value) => {
            this.lookup.to = value;
            this._render();
        });
        toInput.style.width = '72px';

        line.append(fromInput, this._label('→'), toInput);
        card.appendChild(line);

        // The subtraction rather than only its result, because the thresholds
        // are the answer to the next question you were going to ask
        const answer = document.createElement('div');
        answer.style.marginTop = '3px';
        const owed = experienceBetween(from, to, state.table);
        if (owed === null) {
            answer.append(this._value('One of those levels is not on the game’s table.', COLORS.textDim));
        } else {
            answer.append(
                this._value(formatWithSeparator(state.table[to]), ROW_COLORS.good),
                this._label(' − '),
                this._value(formatWithSeparator(state.table[from]), ROW_COLORS.good),
                this._label(' = '),
                this._value(`${formatWithSeparator(owed)} exp`, ROW_COLORS.gold)
            );
        }
        card.appendChild(answer);
        return card;
    }

    /**
     * A block, optionally titled, so the panel reads as cards rather than a list.
     * @param {string} [title] - Heading text
     * @returns {HTMLElement}
     */
    _card(title) {
        const card = document.createElement('div');
        Object.assign(card.style, {
            background: COLORS.card,
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '6px',
            padding: '7px 9px',
        });

        if (title) {
            const heading = document.createElement('div');
            heading.textContent = title;
            Object.assign(heading.style, { color: ROW_COLORS.good, fontWeight: 'bold', marginBottom: '4px' });
            card.appendChild(heading);
        }
        return card;
    }

    /**
     * A heading that folds its section away.
     * @param {string} title - Heading text
     * @param {string} key - Where the folded state is remembered
     * @returns {HTMLElement}
     */
    _foldHeading(title, key) {
        const heading = document.createElement('div');
        Object.assign(heading.style, {
            color: ROW_COLORS.good,
            fontWeight: 'bold',
            cursor: 'pointer',
            userSelect: 'none',
            marginBottom: '4px',
        });
        heading.textContent = `${this.collapsed[key] ? '▶' : '▼'} ${title}`;
        heading.addEventListener('click', () => {
            this.collapsed[key] = !this.collapsed[key];
            this._render();
        });
        return heading;
    }

    /** The one grid every table line shares, so the columns line up */
    _tableRow() {
        const line = document.createElement('div');
        Object.assign(line.style, {
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 52px 76px 72px 62px 66px',
            gap: '6px',
            alignItems: 'center',
        });
        return line;
    }

    /**
     * @param {string} text - Cell contents
     * @returns {HTMLElement}
     */
    _cell(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        cell.style.textAlign = 'right';
        cell.style.whiteSpace = 'nowrap';
        return cell;
    }

    /**
     * @param {string} text - Label contents
     * @returns {HTMLElement}
     */
    _label(text) {
        const label = document.createElement('span');
        label.textContent = text;
        label.style.color = COLORS.textDim;
        return label;
    }

    /**
     * @param {string} text - Contents
     * @param {string} [color] - Ink
     * @returns {HTMLElement}
     */
    _value(text, color) {
        const value = document.createElement('span');
        value.textContent = text;
        if (color) value.style.color = color;
        value.style.whiteSpace = 'nowrap';
        return value;
    }

    /**
     * A combat-skill dropdown.
     *
     * @param {Object} state - From `combatSkillState`
     * @param {string|null} chosen - Which is selected
     * @param {Function} onChange - Called with the new skill name
     * @returns {HTMLElement}
     */
    _select(state, chosen, onChange) {
        const select = document.createElement('select');
        Object.assign(select.style, {
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '2px 4px',
        });

        for (const skill of state.skills) {
            const option = document.createElement('option');
            option.value = skill.name;
            option.textContent = `${skillName(skill.hrid)} ${skill.level}`;
            option.style.background = COLORS.background;
            if (skill.name === chosen) option.selected = true;
            select.appendChild(option);
        }
        select.addEventListener('change', () => onChange(select.value));
        select.addEventListener('keydown', (event) => event.stopPropagation());
        return select;
    }

    /**
     * A level box.
     *
     * Committed on change and on Enter rather than on every keystroke, because
     * re-rendering mid-type takes the caret away — and typing "120" through a
     * live render means being told about levels 1 and 12 on the way.
     *
     * @param {number} value - What it starts at
     * @param {Function} onCommit - Called with the new number
     * @returns {HTMLElement}
     */
    _number(value, onCommit) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.value = String(value);
        Object.assign(input.style, {
            width: '100%',
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '2px 3px',
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
        });

        const commit = () => {
            const parsed = Math.max(1, Math.round(Number(input.value)));
            if (!Number.isFinite(parsed)) return;
            onCommit(parsed);
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                input.blur();
            }
            // The game listens for keys globally, and a level typed into a box
            // should not also be a hotkey
            event.stopPropagation();
        });
        return input;
    }

    /**
     * @param {string} text - Button label
     * @param {Function} onClick - What it does
     * @returns {HTMLElement}
     */
    _button(text, onClick) {
        const button = document.createElement('button');
        button.textContent = text;
        Object.assign(button.style, {
            background: 'rgba(255, 255, 255, 0.1)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 10px',
        });
        button.addEventListener('click', onClick);
        return button;
    }

    /**
     * @param {string} text - What there is to say
     * @returns {HTMLElement}
     */
    _note(text) {
        const note = document.createElement('div');
        note.textContent = text;
        note.style.color = COLORS.textDim;
        return note;
    }

    _remove() {
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
    }
}

export const combatLevelPanel = new CombatLevelPanel();

registerRow({
    key: 'combatLevel',
    name: 'Combat Level',
    defaultSize: { width: 220, height: 30 },
    render: (container) => {
        sample();

        const state = combatSkillState();
        if (!state?.skills.length) return blank(container);

        const { whole, partial } = combatProgress(state);
        const next = nextCombatLevel(state);

        row(container, [
            { text: 'Combat', color: ROW_COLORS.dim },
            { text: String(whole.level), color: COLORS.combat, bold: true },
            { text: `${(partial.progress * 100).toFixed(1)}%`, color: ROW_COLORS.dim, push: true },
            next ? { text: `${next.levels}× ${skillName(next.skill)}`, color: ROW_COLORS.gold, ellipsis: true } : null,
        ]);
        container.title = next
            ? `${next.levels} level(s) of ${skillName(next.skill)} is the shortest route to Combat ${whole.level + 1}` +
              (next.seconds === null ? '.' : `, about ${shortDuration(next.seconds)} away.`)
            : `${(partial.progress * 100).toFixed(1)}% of the way to Combat ${whole.level + 1}.`;
    },
    onOpen: () => combatLevelPanel.toggle(),
});

registerRow({
    key: 'combatSession',
    name: 'Combat Session',
    defaultSize: { width: 220, height: 30 },
    render: (container) => {
        sample();

        const state = combatSkillState();
        if (!state?.skills.length) return blank(container);

        const progress = sessionFor(state.skills);
        row(container, [
            { text: 'Session', color: ROW_COLORS.dim },
            { text: timeReadable(Math.round(progress.seconds)), color: ROW_COLORS.accent },
            { text: `${formatKMB(progress.total)} exp`, color: ROW_COLORS.gold, push: true },
            progress.perHour === null
                ? null
                : { text: `${formatKMB(progress.perHour)}/hr`, color: ROW_COLORS.good, ellipsis: true },
        ]);
        container.title = 'Combat experience since the session started. Reset it from the Combat Level panel.';
    },
    onOpen: () => combatLevelPanel.toggle(),
});
