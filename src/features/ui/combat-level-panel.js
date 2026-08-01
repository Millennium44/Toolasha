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
 * A level of the skill carrying the doubled term is worth **six** of any other.
 * An offensive skill sitting behind a higher one is worth nothing at all until
 * it overtakes. Neither is guessable from a whole number, and both change what
 * you train next.
 *
 * ## What is on it
 *
 * - the combat level with the arithmetic spelled out, and the fraction as a bar
 * - the session: how long, how much experience, at what rate, with a Reset
 * - every combat skill, with an editable target level and the time to reach it
 * - the charms and wisdom actually multiplying that experience
 * - experience between any two levels
 *
 * The target column is the whole of GWhiz's separate skill-and-target selector:
 * a target per skill on the row it belongs to, rather than one target for one
 * skill chosen from a dropdown.
 *
 * The arithmetic is in `utils/combat-level.js` and `utils/exp-session.js`,
 * checked against the figures GWhiz shows for the same build. This module reads
 * the character, lays it out, and does no maths of its own.
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
    combatLevel,
    combatValueOf,
    levelsToNextCombat,
    cheapestRouteToNextCombat,
    experienceBetween,
    timeToTargetLevel,
} from '../../utils/combat-level.js';
import { beginSession, sessionProgress, sessionIsStale } from '../../utils/exp-session.js';
import { calculateExperienceMultiplier } from '../../utils/experience-parser.js';
import { experiencePerHour, skillName } from '../../utils/skill-progress.js';
import { registerRow } from '../../utils/overlay-rows.js';

const PANEL_ID = 'toolasha-combat-level-panel';
const GEOMETRY_KEY = 'combatLevelPanel';
const DEFAULT_PANEL = { width: 520, height: 560 };
const REFRESH_MS = 5000;
const COMBAT_ACTION_TYPE = '/action_types/combat';

/** How far back the rate behind each countdown is measured */
const WINDOW_MS = 10 * 60 * 1000;
const SAMPLE_MS = 5000;

const COLORS = {
    background: 'rgba(8, 10, 20, 0.97)',
    headerBg: 'rgba(28, 20, 34, 0.9)',
    border: 'rgba(190, 150, 255, 0.32)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.55)',
    accent: '#c9a0ff',
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
 * @returns {{levels: Object, skills: Array<Object>, table: number[]}|null}
 */
export function combatSkillState() {
    const all = dataManager.getSkills?.();
    const table = dataManager.getInitClientData?.()?.levelExperienceTable;
    if (!all || !table) return null;

    const levels = {};
    const skills = [];

    for (const name of COMBAT_SKILLS) {
        const hrid = `/skills/${name}`;
        const skill = all.find((entry) => entry.skillHrid === hrid);
        if (!skill) continue;

        levels[name] = skill.level;

        const readings = history.get(hrid) || [];
        skills.push({
            name,
            hrid,
            level: skill.level,
            experience: skill.experience,
            perHour: experiencePerHour(readings[0], readings[readings.length - 1]),
        });
    }
    return { levels, skills, table };
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
 * @returns {Object} From `sessionProgress`
 */
function sessionFor(skills) {
    const readings = skills.map((skill) => ({ hrid: skill.hrid, experience: skill.experience }));
    if (!session || sessionIsStale(session, readings)) resetSession(skills);

    return sessionProgress(session, readings, Date.now());
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

        const header = this._header();
        this.panel.appendChild(header);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '9px 11px 11px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, header, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 380,
            minHeight: 220,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 380, height: 220 });

        this._render();
        this.refreshId = setInterval(() => this._render(), REFRESH_MS);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
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

        header.append(title, spacer, close);
        return header;
    }

    _render() {
        if (!this.bodyEl) return;

        // Rebuilding the body under a field being typed into takes the caret
        // with it, so a target half-entered on the five-second boundary is lost
        if (this.panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;

        sample();

        const state = combatSkillState();
        this.bodyEl.replaceChildren();

        if (!state?.skills.length) {
            const empty = document.createElement('div');
            empty.style.color = COLORS.textDim;
            empty.textContent = 'No combat skills loaded yet.';
            this.bodyEl.appendChild(empty);
            return;
        }

        this.bodyEl.appendChild(this._summary(state));
        this.bodyEl.appendChild(this._session(state));
        this.bodyEl.appendChild(this._skillTable(state));
        this.bodyEl.appendChild(this._charms(state));
        this.bodyEl.appendChild(this._expLookup(state));
    }

    /**
     * The combat level, the arithmetic, and the shortest way to the next one.
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _summary(state) {
        const section = document.createElement('div');
        section.style.marginBottom = '10px';

        const result = combatLevel(state.levels);
        const route = cheapestRouteToNextCombat(state.levels);

        const top = document.createElement('div');
        Object.assign(top.style, { display: 'flex', alignItems: 'baseline', gap: '9px' });

        const level = document.createElement('span');
        level.textContent = String(result.level);
        Object.assign(level.style, { fontSize: '22px', fontWeight: 'bold', color: COLORS.accent });

        // The formula spelled out, because a weighted average nobody can see is
        // a number you cannot plan against. The doubled term is its own skill's
        // level rather than the last term of the sum: the sum takes the best of
        // the three offensive skills and the doubled term the best of five, and
        // they part company whenever Attack or Defense leads.
        const formula = document.createElement('span');
        formula.textContent =
            `0.1 × (${result.terms.join(' + ')}) + 0.5 × ${result.doubledLevel} = ` + result.exact.toFixed(3);
        formula.style.color = COLORS.textDim;
        formula.style.fontFamily = 'monospace';
        formula.title =
            `The sum takes the highest of Melee, Ranged and Magic (${skillName(result.best)}); ` +
            `the doubled term takes the highest of those three plus Attack and Defense (${skillName(result.doubled)}).`;

        top.append(level, formula);
        section.appendChild(top);

        // The fraction the displayed whole number throws away
        const track = document.createElement('div');
        Object.assign(track.style, {
            height: '6px',
            background: 'rgba(255, 255, 255, 0.12)',
            borderRadius: '3px',
            overflow: 'hidden',
            margin: '5px 0 4px',
        });
        const fill = document.createElement('div');
        Object.assign(fill.style, {
            height: '100%',
            width: `${(result.progress * 100).toFixed(1)}%`,
            background: COLORS.accent,
        });
        track.appendChild(fill);
        section.appendChild(track);

        const note = document.createElement('div');
        note.style.color = COLORS.textDim;
        if (route) {
            note.textContent = `${route.levels} level${route.levels === 1 ? '' : 's'} of ${skillName(route.skill)} to level Combat · ${(result.progress * 100).toFixed(1)}%`;
        } else {
            note.textContent = `${(result.progress * 100).toFixed(1)}% of the way to ${result.level + 1}`;
        }
        section.appendChild(note);

        return section;
    }

    /**
     * How long you have been at this, and what it has been worth.
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _session(state) {
        const section = this._section('Session');

        const progress = sessionFor(state.skills);
        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'baseline', gap: '10px' });

        const elapsed = document.createElement('span');
        elapsed.textContent = timeReadable(Math.round(progress.seconds));

        const total = document.createElement('span');
        total.textContent = `${formatWithSeparator(Math.round(progress.total))} exp`;
        total.style.color = ROW_COLORS.gold;

        const rate = document.createElement('span');
        // Nothing rather than a made-up figure for the first twenty seconds, so
        // the panel is not briefly claiming millions an hour on opening
        rate.textContent = progress.perHour === null ? 'measuring…' : `${formatKMB(progress.perHour)}/hr`;
        rate.style.color = progress.perHour === null ? COLORS.textDim : ROW_COLORS.good;

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const reset = this._button('Reset', () => {
            resetSession(state.skills);
            this._render();
        });
        reset.title = 'Start the clock and the totals again from right now.';

        line.append(elapsed, total, rate, spacer, reset);
        section.appendChild(line);

        // Which skills the session's experience actually went to, so a session
        // total is attributable rather than a lump
        const earned = progress.bySkill.filter((entry) => entry.gained > 0);
        if (earned.length) {
            const detail = document.createElement('div');
            detail.style.color = COLORS.textDim;
            detail.style.marginTop = '3px';
            detail.textContent = earned
                .map((entry) => `${skillName(entry.hrid)} ${formatKMB(entry.gained)}`)
                .join('  ·  ');
            section.appendChild(detail);
        }

        return section;
    }

    /**
     * Every combat skill: level, rate, what it is worth, and when a target lands.
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _skillTable(state) {
        const section = this._section('Skills');

        const heading = this._row();
        heading.style.color = COLORS.textDim;
        heading.style.borderBottom = `1px solid ${COLORS.border}`;
        heading.style.paddingBottom = '3px';
        for (const [text, align] of [
            ['Skill', 'left'],
            ['Level', 'right'],
            ['Exp/hr', 'right'],
            ['To Combat', 'right'],
            ['Target', 'right'],
            ['Time', 'right'],
        ]) {
            const cell = document.createElement('span');
            cell.textContent = text;
            cell.style.textAlign = align;
            heading.appendChild(cell);
        }
        section.appendChild(heading);

        const doubled = combatLevel(state.levels).doubled;
        for (const skill of state.skills) {
            section.appendChild(this._skillRow(skill, state, doubled));
        }
        return section;
    }

    /**
     * @param {Object} skill - One combat skill
     * @param {Object} state - From `combatSkillState`
     * @param {string} doubled - The skill carrying the doubled term
     * @returns {HTMLElement}
     */
    _skillRow(skill, state, doubled) {
        const row = this._row();
        row.style.padding = '2px 0';

        const name = document.createElement('span');
        name.textContent = skillName(skill.hrid);
        // The doubled skill is the one every plan turns on, so it reads as such
        if (skill.name === doubled) {
            name.style.color = COLORS.accent;
            name.style.fontWeight = 'bold';
            name.title = 'Carries the doubled term, so a level of it is worth six of anything else.';
        }

        const level = this._cell(String(skill.level));
        const rate = this._cell(skill.perHour ? formatWithSeparator(Math.round(skill.perHour)) : '—');
        rate.style.color = skill.perHour ? ROW_COLORS.good : COLORS.textDim;

        // What a level of this is worth, and how many of them are needed
        const needed = levelsToNextCombat(state.levels, skill.name);
        const worth = combatValueOf(state.levels, skill.name);
        const toCombat = this._cell(needed === null ? '—' : `${needed} × ${worth.toFixed(1)}`);
        toCombat.style.color = needed === null ? COLORS.textDim : ROW_COLORS.gold;
        toCombat.title =
            needed === null
                ? 'More levels than the search looks ahead, so no honest number to give.'
                : `Each level is worth ${worth.toFixed(1)} combat levels right now.`;

        // Any level, not just the next one: the whole of GWhiz's separate
        // target selector, on the row it belongs to
        const target = this.targets[skill.name] ?? skill.level + 1;
        const targetInput = this._number(target, (value) => {
            this.targets[skill.name] = value;
            this._render();
        });

        const seconds = timeToTargetLevel({
            experience: skill.experience,
            target,
            table: state.table,
            perHour: skill.perHour,
        });
        const time = this._cell(seconds === null ? '—' : shortDuration(seconds));
        time.style.color = seconds === null ? COLORS.textDim : ROW_COLORS.accent;

        const owed = experienceBetween(skill.level, target, state.table);
        time.title =
            owed === null
                ? 'That level is not on the game’s experience table.'
                : `${formatWithSeparator(owed)} experience from level ${skill.level} to ${target}.`;

        row.append(name, level, rate, toCombat, targetInput, time);
        return row;
    }

    /**
     * What is multiplying the experience in the table above it.
     *
     * Wisdom applies to everything and charms apply to one skill each, so the
     * same exp/hr on two rows can be two different amounts of actual training.
     * Read through Toolasha's own experience parser rather than re-derived here.
     *
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _charms(state) {
        const section = this._section('Charms & Wisdom');

        let wisdom = null;
        const lines = [];

        for (const skill of state.skills) {
            let result = null;
            try {
                result = calculateExperienceMultiplier(skill.hrid, COMBAT_ACTION_TYPE);
            } catch (error) {
                console.error('[CombatLevel] Could not read the experience multiplier:', error);
                continue;
            }
            if (wisdom === null) wisdom = result.totalWisdom;
            if (result.charmExperience > 0) lines.push({ skill, result });
        }

        if (wisdom === null) {
            section.appendChild(this._note('Nothing loaded to read bonuses from yet.'));
            return section;
        }

        const summary = document.createElement('div');
        summary.textContent = `Wisdom ${wisdom.toFixed(2)}% on every combat skill`;
        summary.style.color = ROW_COLORS.good;
        summary.title = 'Wisdom and charm experience add together before multiplying, rather than compounding.';
        section.appendChild(summary);

        if (!lines.length) {
            section.appendChild(this._note('No charm is boosting a combat skill.'));
            return section;
        }

        for (const { skill, result } of lines) {
            const line = document.createElement('div');
            Object.assign(line.style, { display: 'flex', gap: '8px', padding: '1px 0' });

            const name = document.createElement('span');
            name.textContent = skillName(skill.hrid);
            name.style.minWidth = '86px';

            const charm = document.createElement('span');
            charm.textContent = `+${result.charmExperience.toFixed(2)}%`;
            charm.style.color = COLORS.accent;

            const source = document.createElement('span');
            source.style.color = COLORS.textDim;
            source.style.flex = '1';
            source.style.overflow = 'hidden';
            source.style.textOverflow = 'ellipsis';
            source.style.whiteSpace = 'nowrap';
            source.textContent = result.charmBreakdown.map((entry) => entry.name).join(', ');

            const total = document.createElement('span');
            total.textContent = `×${result.totalMultiplier.toFixed(3)}`;
            total.style.color = ROW_COLORS.gold;

            line.append(name, charm, source, total);
            section.appendChild(line);
        }
        return section;
    }

    /**
     * Experience between any two levels, which the game never shows.
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _expLookup(state) {
        const section = this._section('Experience Lookup');

        const line = document.createElement('div');
        Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '6px' });

        const from = this.lookup.from ?? 1;
        const to = this.lookup.to ?? Math.min(from + 10, state.table.length - 1);

        const fromInput = this._number(from, (value) => {
            this.lookup.from = value;
            this._render();
        });
        const toInput = this._number(to, (value) => {
            this.lookup.to = value;
            this._render();
        });

        const answer = document.createElement('span');
        const owed = experienceBetween(from, to, state.table);
        if (owed === null) {
            answer.textContent = 'off the table';
            answer.style.color = COLORS.textDim;
        } else {
            answer.textContent = `${formatWithSeparator(owed)} exp`;
            answer.style.color = ROW_COLORS.gold;
        }

        line.append(this._label('Level'), fromInput, this._label('to'), toInput, this._label('='), answer);
        section.appendChild(line);
        return section;
    }

    /**
     * A titled block, so the panel reads as sections rather than as one list.
     * @param {string} title - The heading
     * @returns {HTMLElement}
     */
    _section(title) {
        const section = document.createElement('div');
        section.style.marginBottom = '10px';

        const heading = document.createElement('div');
        heading.textContent = title;
        Object.assign(heading.style, {
            color: COLORS.accent,
            fontWeight: 'bold',
            borderTop: `1px solid ${COLORS.border}`,
            paddingTop: '6px',
            marginBottom: '4px',
        });
        section.appendChild(heading);
        return section;
    }

    /** The one grid every line shares, so the columns line up */
    _row() {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 44px 68px 72px 52px 66px',
            gap: '6px',
            alignItems: 'baseline',
        });
        return row;
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
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '1px 3px',
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
            background: 'rgba(255, 255, 255, 0.08)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '3px',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '1px 8px',
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

        const result = combatLevel(state.levels);
        const route = cheapestRouteToNextCombat(state.levels);

        row(container, [
            { text: 'Combat', color: ROW_COLORS.dim },
            { text: String(result.level), color: COLORS.accent, bold: true },
            {
                text: `${(result.progress * 100).toFixed(1)}%`,
                color: ROW_COLORS.dim,
                push: true,
            },
            route
                ? { text: `${route.levels}× ${skillName(route.skill)}`, color: ROW_COLORS.gold, ellipsis: true }
                : null,
        ]);
        container.title = route
            ? `${route.levels} level(s) of ${skillName(route.skill)} is the shortest route to Combat ${result.level + 1}.`
            : `${(result.progress * 100).toFixed(1)}% of the way to Combat ${result.level + 1}.`;
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
