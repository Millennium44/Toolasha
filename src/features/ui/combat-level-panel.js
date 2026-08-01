/**
 * Combat Level panel
 *
 * How close the next combat level is, and which skill gets you there.
 *
 * The game shows a whole number. That hides both facts worth acting on: combat
 * level is a weighted average, so the fraction you have already earned is
 * invisible, and the skill that would finish it soonest is not the one you are
 * training more often than people expect.
 *
 * A level of the offensive skill you are actually using is worth **six** of any
 * other, because it counts twice in the formula. An offensive skill sitting
 * behind a higher one is worth nothing at all until it overtakes. Neither of
 * those is guessable from a whole number, and both change what you train next.
 *
 * The arithmetic is in `utils/combat-level.js`, checked against the figures
 * GWhiz shows for the same build. This module reads the character, lays it out,
 * and does no maths of its own.
 *
 * The panel is GWhiz's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { formatWithSeparator } from '../../utils/formatters.js';
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
    timeToTargetLevel,
} from '../../utils/combat-level.js';
import { experiencePerHour, skillName } from '../../utils/skill-progress.js';
import { registerRow } from '../../utils/overlay-rows.js';

const PANEL_ID = 'toolasha-combat-level-panel';
const GEOMETRY_KEY = 'combatLevelPanel';
const DEFAULT_PANEL = { width: 460, height: 420 };
const REFRESH_MS = 5000;

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

class CombatLevelPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.refreshId = null;
        /** Per skill, the level being aimed at; defaults to the next one */
        this.targets = {};
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
            minWidth: 360,
            minHeight: 220,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 360, height: 220 });

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
        this.bodyEl.appendChild(this._skillTable(state));
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
        // a number you cannot plan against
        const formula = document.createElement('span');
        formula.textContent = `0.1 × (${result.terms.join(' + ')}) + 0.5 × ${result.terms[4]} = ${result.exact.toFixed(3)}`;
        formula.style.color = COLORS.textDim;
        formula.style.fontFamily = 'monospace';

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
     * Every combat skill: level, rate, what it is worth, and when it lands.
     * @param {Object} state - From `combatSkillState`
     * @returns {HTMLElement}
     */
    _skillTable(state) {
        const table = document.createElement('div');

        const heading = this._row();
        heading.style.color = COLORS.textDim;
        heading.style.borderBottom = `1px solid ${COLORS.border}`;
        heading.style.paddingBottom = '3px';
        for (const [text, align] of [
            ['Skill', 'left'],
            ['Level', 'right'],
            ['Exp/hr', 'right'],
            ['To Combat', 'right'],
            ['Next level', 'right'],
        ]) {
            const cell = document.createElement('span');
            cell.textContent = text;
            cell.style.textAlign = align;
            heading.appendChild(cell);
        }
        table.appendChild(heading);

        const best = combatLevel(state.levels).best;
        for (const skill of state.skills) {
            table.appendChild(this._skillRow(skill, state, best));
        }
        return table;
    }

    /**
     * @param {Object} skill - One combat skill
     * @param {Object} state - From `combatSkillState`
     * @param {string} best - The doubled offensive skill
     * @returns {HTMLElement}
     */
    _skillRow(skill, state, best) {
        const row = this._row();
        row.style.padding = '2px 0';

        const name = document.createElement('span');
        name.textContent = skillName(skill.hrid);
        // The doubled skill is the one every plan turns on, so it reads as such
        if (skill.name === best) {
            name.style.color = COLORS.accent;
            name.style.fontWeight = 'bold';
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
                ? 'Behind a higher offensive skill, so levelling it moves nothing until it overtakes.'
                : `Each level is worth ${worth.toFixed(1)} combat levels.`;

        const seconds = timeToTargetLevel({
            experience: skill.experience,
            target: skill.level + 1,
            table: state.table,
            perHour: skill.perHour,
        });
        const next = this._cell(seconds === null ? '—' : shortDuration(seconds));
        next.style.color = seconds === null ? COLORS.textDim : ROW_COLORS.accent;

        row.append(name, level, rate, toCombat, next);
        return row;
    }

    /** The one grid every line shares, so the columns line up */
    _row() {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 50px 76px 78px 76px',
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
