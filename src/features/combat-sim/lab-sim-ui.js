/**
 * Lab Sim UI
 * Floating panel for configuring and running labyrinth simulations.
 * Four tabs: Configure (editor + crate selectors), Max Level, Upgrade, Skilling.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import {
    buildGameDataPayload,
    buildAllPlayerDTOs,
    getCombatZones,
    getCommunityBuffs,
    getLabyrinthMonsters,
} from './combat-sim-adapter.js';
import { runLabyrinthSimulation, cancelSimulation } from './combat-sim-runner.js';
import { findMaxLabyrinthLevel } from './labyrinth-level-finder.js';
import {
    runLabyrinthUpgradeAnalysis,
    runLabyrinthAllFightsAnalysis,
    computeSkillingClearRatesFromEditor,
    runSkillingUpgradeAnalysis,
    getStyleExcludedSkills,
} from './upgrade-advisor.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { SimEditor } from './sim-editor.js';
import labyrinthClearRate from '../combat/labyrinth-clear-rate.js';
import loadoutSnapshot from '../combat/loadout-snapshot.js';

const PANEL_ID = 'mwi-lab-sim-panel';
const ACCENT = '#4a9eff';
const ACCENT_BORDER = 'rgba(74, 158, 255, 0.5)';
const ACCENT_BG = 'rgba(74, 158, 255, 0.12)';
const ACCENT_BTN_BG = 'rgba(74, 158, 255, 0.2)';
const ACCENT_BTN_BORDER = 'rgba(74, 158, 255, 0.4)';

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatElapsed(seconds) {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(0);
    return `${m}m ${s}s`;
}

class LabSimUI {
    constructor() {
        this.panel = null;
        this._editor = null;
        this._skillingEditor = null;
        this.isRunning = false;
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        this.elapsedTimer = null;
        this._activeTab = 'configure';
        this._maxLevel = null;
        this._labyFindMaxMode = false;
        this._labyResults = null;
        this._upgradeAborted = false;
        this._skillingAborted = false;
        this._skillLoadouts = {};
        this._skillLoadoutsLoaded = false;
        this._loadoutsCollapsed = true;
        this._upgradeSortHandler = null;
        this._skillingSortHandler = null;
    }

    buildPanel() {
        if (this.panel) return;

        // Labyrinth tile right-clicks request a preconfigured open via this event
        this._openRequestHandler = (e) => {
            this.openPreconfigured(e.detail || {});
        };
        document.addEventListener('mwi-labsim-open', this._openRequestHandler);

        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        this.panel.style.cssText = `
            position: fixed;
            top: 60px;
            right: 60px;
            z-index: ${config.Z_FLOATING_PANEL};
            background: rgba(10, 10, 20, 0.97);
            border: 2px solid ${ACCENT_BORDER};
            border-radius: 10px;
            width: 560px;
            height: 600px;
            min-width: 400px;
            min-height: 300px;
            max-width: 90vw;
            max-height: 90vh;
            display: none;
            flex-direction: column;
            font-family: 'Segoe UI', sans-serif;
            color: #e0e0e0;
            font-size: 13px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            cursor: grab;
            background: ${ACCENT_BG};
            border-bottom: 1px solid ${ACCENT_BORDER};
            border-radius: 8px 8px 0 0;
            flex-shrink: 0;
        `;
        header.innerHTML = `
            <span style="font-weight:700; font-size:14px; color:${ACCENT};">Lab Simulator</span>
            <button id="mwi-labsim-close" style="
                background:none; border:none; color:#aaa; font-size:22px;
                cursor:pointer; padding:0; line-height:1;">\u00d7</button>
        `;
        this._setupDrag(header);

        // Tab bar
        const tabBar = document.createElement('div');
        tabBar.id = 'mwi-labsim-tabbar';
        tabBar.style.cssText = 'display:flex; gap:0; padding:0; flex-shrink:0; border-bottom:1px solid #222;';
        const tabStyle = (active) => `
            flex: 1;
            padding: 7px 0;
            text-align: center;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            border: none;
            font-family: inherit;
            transition: all 0.1s;
            background: ${active ? ACCENT_BG : 'transparent'};
            color: ${active ? ACCENT : '#888'};
            border-bottom: 2px solid ${active ? ACCENT : 'transparent'};
        `;
        tabBar.innerHTML = `
            <button id="mwi-labsim-tab-configure" style="${tabStyle(true)}">Configure</button>
            <button id="mwi-labsim-tab-maxlevel" style="${tabStyle(false)}">Max Level</button>
            <button id="mwi-labsim-tab-upgrade" style="${tabStyle(false)}">Upgrade</button>
            <button id="mwi-labsim-tab-skilling" style="${tabStyle(false)}">Skilling</button>
        `;

        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; flex:1; min-width:0;';
        const inputStyle =
            'width:60px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; text-align:center;';

        // ── Configure tab ──
        const configureContent = document.createElement('div');
        configureContent.id = 'mwi-labsim-configure-content';
        configureContent.style.cssText = 'display:flex; flex-direction:column; flex:1; overflow:hidden;';

        const configureControls = document.createElement('div');
        configureControls.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
            padding: 10px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        configureControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Monster</label>
            <select id="mwi-labsim-monster" style="${selectStyle}"></select>
            <label style="color:#888; font-size:12px;">Level</label>
            <input id="mwi-labsim-level" type="number" min="20" max="300" value="100" style="${inputStyle}">
            <label style="color:#888; font-size:12px;">Hours</label>
            <input id="mwi-labsim-hours" type="number" min="1" max="10000" value="${config.getSettingValue('labyrinthRecommendSimHours', 10)}" style="${inputStyle}">
        `;

        const crateRow = document.createElement('div');
        crateRow.style.cssText = `
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
            font-size: 12px;
        `;
        const crateSelectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px;';
        crateRow.innerHTML = `
            <label style="color:#888;">Tea</label>
            <select id="mwi-labsim-tea" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_tea_crate">Basic</option>
                <option value="/items/advanced_tea_crate">Advanced</option>
                <option value="/items/expert_tea_crate" selected>Expert</option>
            </select>
            <label style="color:#888;">Coffee</label>
            <select id="mwi-labsim-coffee" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_coffee_crate">Basic</option>
                <option value="/items/advanced_coffee_crate">Advanced</option>
                <option value="/items/expert_coffee_crate" selected>Expert</option>
            </select>
            <label style="color:#888;">Food</label>
            <select id="mwi-labsim-food" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_food_crate">Basic</option>
                <option value="/items/advanced_food_crate">Advanced</option>
                <option value="/items/expert_food_crate" selected>Expert</option>
            </select>
        `;

        const editorArea = document.createElement('div');
        editorArea.id = 'mwi-labsim-editor';
        editorArea.style.cssText = 'flex:1; overflow-y:auto; padding:10px 14px;';
        editorArea.innerHTML =
            '<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">Loading loadout...</div>';

        this._editor = new SimEditor({ editorEl: editorArea, labMode: true });

        configureContent.appendChild(configureControls);
        configureContent.appendChild(crateRow);

        // Collapsible Labyrinth Buffs section
        const buffsSection = document.createElement('div');
        buffsSection.style.cssText = 'border-bottom:1px solid #222; flex-shrink:0;';

        const buffsHeader = document.createElement('div');
        buffsHeader.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; padding:6px 14px; cursor:pointer; color:#888; font-size:12px;';
        buffsHeader.innerHTML = `
            <span>Labyrinth Buffs</span>
            <span id="mwi-labsim-buffs-toggle" style="font-size:10px;">\u25B6</span>
        `;

        const buffsBody = document.createElement('div');
        buffsBody.id = 'mwi-labsim-buffs-body';
        buffsBody.style.cssText = 'display:none; padding:4px 14px 8px; font-size:11px;';

        buffsHeader.addEventListener('click', () => {
            const isOpen = buffsBody.style.display !== 'none';
            buffsBody.style.display = isOpen ? 'none' : 'block';
            this.panel.querySelector('#mwi-labsim-buffs-toggle').textContent = isOpen ? '\u25B6' : '\u25BC';
            if (!isOpen) this._renderBuffsSection();
        });

        buffsSection.appendChild(buffsHeader);
        buffsSection.appendChild(buffsBody);
        configureContent.appendChild(buffsSection);

        configureContent.appendChild(editorArea);

        // ── Max Level tab ──
        const maxLevelContent = document.createElement('div');
        maxLevelContent.id = 'mwi-labsim-maxlevel-content';
        maxLevelContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow:hidden;';

        const maxLevelControls = document.createElement('div');
        maxLevelControls.style.cssText = `
            display: flex; align-items: center; gap: 12px;
            padding: 8px 14px; border-bottom: 1px solid #222; flex-shrink: 0; font-size: 12px;
        `;
        maxLevelControls.innerHTML = `
            <button id="mwi-labsim-run" style="
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;">Simulate</button>
            <label style="display:flex; align-items:center; gap:4px; color:#888; cursor:pointer;" title="Binary search for highest beatable level at the specified win rate threshold">
                <input type="checkbox" id="mwi-labsim-findmax" style="margin:0; cursor:pointer;">
                Find Max \u2265
            </label>
            <input id="mwi-labsim-threshold" type="number" min="1" max="100" value="${config.getSettingValue('labyrinthRecommendTargetRate', 95)}" style="width:44px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
            <span style="color:#888; font-size:12px;">%</span>
        `;

        const maxLevelProgress = document.createElement('div');
        maxLevelProgress.id = 'mwi-labsim-progress';
        maxLevelProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        maxLevelProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-labsim-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-labsim-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0%</span>
                </div>
                <button id="mwi-labsim-stop" style="
                    background:rgba(255,80,80,0.2); color:#f44; border:1px solid rgba(255,80,80,0.4);
                    border-radius:4px; padding:2px 10px; font-size:11px; cursor:pointer; font-weight:600;">Stop</button>
            </div>
        `;

        const maxLevelResults = document.createElement('div');
        maxLevelResults.id = 'mwi-labsim-results';
        maxLevelResults.style.cssText = 'flex:1; overflow-y:auto; padding:10px 14px;';

        maxLevelContent.appendChild(maxLevelControls);
        maxLevelContent.appendChild(maxLevelProgress);
        maxLevelContent.appendChild(maxLevelResults);

        // ── Upgrade tab ──
        const upgradeContent = document.createElement('div');
        upgradeContent.id = 'mwi-labsim-upgrade-content';
        upgradeContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow:hidden;';

        const upgradeControls = document.createElement('div');
        upgradeControls.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
            padding: 10px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        upgradeControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Player</label>
            <select id="mwi-labsim-upgrade-player" style="${selectStyle}"></select>
            <label style="color:#888; font-size:12px;">Mode</label>
            <select id="mwi-labsim-upgrade-mode" style="${selectStyle}">
                <option value="equipment">Equipment</option>
                <option value="ability_level">Ability Levels</option>
                <option value="ability_swap">Ability Swaps</option>
                <option value="combined">Equipment + Abilities</option>
                <option value="combat_level">Combat Levels</option>
                <option value="combat_level_all">Combat Levels — All Fights</option>
            </select>
            <span id="mwi-labsim-upgrade-level-group" style="display:none; align-items:center; gap:4px;">
                <select id="mwi-labsim-upgrade-level-type" style="${selectStyle}">
                    <option value="increment">+Levels</option>
                    <option value="target">Target Lv</option>
                </select>
                <input id="mwi-labsim-upgrade-target-level" type="number" min="1" max="200" value="5" style="
                    width:55px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                    border-radius:3px; padding:3px 5px; font-size:12px; text-align:center;"
                    title="Number of levels to add to each ability">
                <button id="mwi-labsim-ability-targets-toggle" title="Set a desired target level per ability instead of a uniform boost" style="
                    background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa;
                    padding:3px 8px; border-radius:4px; font-size:11px; cursor:pointer; font-family:inherit;">Targets</button>
            </span>
            <button id="mwi-labsim-combat-targets-toggle" title="Set a desired target level per skill instead of a uniform boost" style="
                display:none; background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa;
                padding:3px 8px; border-radius:4px; font-size:11px; cursor:pointer; font-family:inherit;">Targets</button>
            <button id="mwi-labsim-upgrade-run" style="
                margin-left: auto;
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;">Analyze</button>
            <button id="mwi-labsim-upgrade-stop" style="
                display:none;
                background:rgba(244, 67, 54, 0.2);
                border:1px solid rgba(244, 67, 54, 0.4);
                color:#f44336;
                border-radius:4px;
                padding:5px 10px;
                font-size:12px;
                font-weight:600;
                cursor:pointer;
                font-family:inherit;">Stop</button>
        `;

        // Per-ability target levels for Ability Levels / combined modes
        // (hidden until toggled; inputs built from equipped abilities on open)
        const labAbilityTargets = document.createElement('div');
        labAbilityTargets.id = 'mwi-labsim-ability-targets';
        labAbilityTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center;';

        // Per-skill target levels for the Combat Levels modes (hidden until toggled)
        const labCombatTargets = document.createElement('div');
        labCombatTargets.id = 'mwi-labsim-combat-targets';
        labCombatTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center;';
        labCombatTargets.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;">Target levels (blank or ≤ current level skips the skill; used instead of the +Levels boost while open):</span>' +
            [
                ['staminaLevel', 'Stamina'],
                ['intelligenceLevel', 'Int'],
                ['attackLevel', 'Attack'],
                ['meleeLevel', 'Melee'],
                ['defenseLevel', 'Defense'],
                ['rangedLevel', 'Ranged'],
                ['magicLevel', 'Magic'],
            ]
                .map(
                    ([key, label]) => `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${label}</label>
                    <input type="number" min="1" max="200" data-lab-combat-target="${key}" style="
                        width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`
                )
                .join('');

        const upgradeProgress = document.createElement('div');
        upgradeProgress.id = 'mwi-labsim-upgrade-progress';
        upgradeProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        upgradeProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-labsim-upgrade-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-labsim-upgrade-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0 / 0</span>
                </div>
            </div>
        `;

        const upgradeResults = document.createElement('div');
        upgradeResults.id = 'mwi-labsim-upgrade-results';
        upgradeResults.style.cssText = 'flex:1; overflow-y:auto; padding:10px 14px;';

        upgradeContent.appendChild(upgradeControls);
        upgradeContent.appendChild(labAbilityTargets);
        upgradeContent.appendChild(labCombatTargets);
        upgradeContent.appendChild(upgradeProgress);
        upgradeContent.appendChild(upgradeResults);

        // ── Skilling tab ──
        const skillingContent = document.createElement('div');
        skillingContent.id = 'mwi-labsim-skilling-content';
        // The whole tab scrolls as one page so expanded sections (Player Setup,
        // loadouts) are never clipped by their own tiny scroll areas
        skillingContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow-y:auto;';

        const skillingControls = document.createElement('div');
        skillingControls.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
            padding: 10px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        skillingControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Room Level</label>
            <input id="mwi-labsim-skilling-level" type="number" min="1" max="300" value="100" disabled style="${inputStyle}">
            <label style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;"
                title="Use each skill's automation skip level to derive its room level (effective level + skip - 1)">
                <input type="checkbox" id="mwi-labsim-skilling-useskip" checked style="margin:0; cursor:pointer;">
                Use Skip Levels
            </label>
            <label style="color:#888; font-size:12px;">Skill</label>
            <select id="mwi-labsim-skilling-filter" title="Restrict calculations, upgrade analysis, and the loadout table to one skill" style="
                background:#1a1a2e;
                color:#e0e0e0;
                border:1px solid #444;
                border-radius:4px;
                padding:4px 6px;
                font-size:11px;
                font-family:inherit;">
                <option value="">All Skills</option>
                <option value="/skills/woodcutting">Woodcutting</option>
                <option value="/skills/foraging">Foraging</option>
                <option value="/skills/milking">Milking</option>
                <option value="/skills/cooking">Cooking</option>
                <option value="/skills/brewing">Brewing</option>
                <option value="/skills/cheesesmithing">Cheesesmithing</option>
                <option value="/skills/crafting">Crafting</option>
                <option value="/skills/tailoring">Tailoring</option>
                <option value="/skills/alchemy">Alchemy</option>
                <option value="/skills/enhancing">Enhancing</option>
            </select>
            <button id="mwi-labsim-skilling-calc" style="
                margin-left: auto;
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;">Calculate</button>
            <button id="mwi-labsim-skilling-upgrade" title="Sims token upgrades one level up and each equipment piece at its next enhancement breakpoint — when a breakpoint doesn't move the clear rate, the target keeps ticking up one level at a time until it has a positive impact (which is why some rows show a higher level than the next breakpoint)" style="
                background: rgba(255,255,255,0.04);
                border: 1px solid #333;
                color: #aaa;
                border-radius: 6px;
                padding: 5px 10px;
                font-size: 12px;
                cursor: pointer;
                font-family: inherit;">Analyze Upgrades</button>
            <button id="mwi-labsim-skilling-stop" style="
                display:none;
                background:rgba(244, 67, 54, 0.2);
                border:1px solid rgba(244, 67, 54, 0.4);
                color:#f44336;
                border-radius:4px;
                padding:5px 10px;
                font-size:12px;
                font-weight:600;
                cursor:pointer;
                font-family:inherit;">Stop</button>
        `;

        const skillingCrateRow = document.createElement('div');
        skillingCrateRow.style.cssText = `
            display: flex; align-items: center; gap: 10px;
            padding: 6px 14px; border-bottom: 1px solid #222; flex-shrink: 0; font-size: 12px;
        `;
        skillingCrateRow.innerHTML = `
            <label style="color:#888;">Tea</label>
            <select id="mwi-labsim-skilling-tea" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_tea_crate">Basic</option>
                <option value="/items/advanced_tea_crate">Advanced</option>
                <option value="/items/expert_tea_crate" selected>Expert</option>
            </select>
            <label style="color:#888;">Coffee</label>
            <select id="mwi-labsim-skilling-coffee" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_coffee_crate">Basic</option>
                <option value="/items/advanced_coffee_crate">Advanced</option>
                <option value="/items/expert_coffee_crate" selected>Expert</option>
            </select>
            <label style="color:#888;">Food</label>
            <select id="mwi-labsim-skilling-food" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_food_crate">Basic</option>
                <option value="/items/advanced_food_crate">Advanced</option>
                <option value="/items/expert_food_crate" selected>Expert</option>
            </select>
        `;

        const skillingLoadoutArea = document.createElement('div');
        skillingLoadoutArea.id = 'mwi-labsim-skilling-loadouts';
        skillingLoadoutArea.style.cssText = 'padding:8px 14px; border-bottom:1px solid #222; flex-shrink:0;';

        // Player setup (skill levels, house rooms, token upgrades, community
        // buffs) is collapsed by default to keep the tab compact — it's only
        // needed when overriding the live character's values
        const skillingEditorSection = document.createElement('div');
        skillingEditorSection.style.cssText = 'border-bottom:1px solid #222; flex-shrink:0;';
        const skillingEditorHeader = document.createElement('div');
        skillingEditorHeader.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; padding:6px 14px; cursor:pointer; color:#888; font-size:12px;';
        skillingEditorHeader.innerHTML = `
            <span>Player Setup</span>
            <span id="mwi-labsim-skilling-editor-toggle" style="font-size:10px;">▶</span>
        `;

        const skillingEditorArea = document.createElement('div');
        skillingEditorArea.id = 'mwi-labsim-skilling-editor';
        skillingEditorArea.style.cssText = 'display:none; padding:10px 14px; flex-shrink:0;';
        skillingEditorArea.innerHTML =
            '<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">Loading loadout...</div>';

        skillingEditorHeader.addEventListener('click', () => {
            const isOpen = skillingEditorArea.style.display !== 'none';
            skillingEditorArea.style.display = isOpen ? 'none' : 'block';
            skillingEditorHeader.querySelector('#mwi-labsim-skilling-editor-toggle').textContent = isOpen ? '▶' : '▼';
        });
        skillingEditorSection.appendChild(skillingEditorHeader);
        skillingEditorSection.appendChild(skillingEditorArea);

        this._skillingEditor = new SimEditor({ editorEl: skillingEditorArea, labMode: true, skillingMode: true });

        const skillingProgress = document.createElement('div');
        skillingProgress.id = 'mwi-labsim-skilling-progress';
        skillingProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        skillingProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-labsim-skilling-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-labsim-skilling-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0 / 0</span>
                </div>
            </div>
        `;

        const skillingResults = document.createElement('div');
        skillingResults.id = 'mwi-labsim-skilling-results';
        skillingResults.style.cssText = 'padding:10px 14px; flex-shrink:0;';

        skillingContent.appendChild(skillingControls);
        skillingContent.appendChild(skillingCrateRow);
        skillingContent.appendChild(skillingLoadoutArea);
        skillingContent.appendChild(skillingEditorSection);
        skillingContent.appendChild(skillingProgress);
        skillingContent.appendChild(skillingResults);

        // Status bar
        const status = document.createElement('div');
        status.id = 'mwi-labsim-status';
        status.style.cssText =
            'padding:6px 14px; color:#555; font-size:11px; border-top:1px solid #1a1a1a; flex-shrink:0; text-align:center;';
        status.textContent = 'Select a monster in Configure, then use Max Level or Upgrade to simulate.';

        // Assemble
        this.panel.appendChild(header);
        this.panel.appendChild(tabBar);
        this.panel.appendChild(configureContent);
        this.panel.appendChild(maxLevelContent);
        this.panel.appendChild(upgradeContent);
        this.panel.appendChild(skillingContent);
        this.panel.appendChild(status);

        const resizeHandle = document.createElement('div');
        resizeHandle.style.cssText = `
            position: absolute;
            bottom: 0;
            right: 0;
            width: 16px;
            height: 16px;
            cursor: nwse-resize;
            background: linear-gradient(135deg, transparent 50%, rgba(74, 158, 255, 0.4) 50%);
            border-radius: 0 0 8px 0;
            z-index: 1;
        `;
        this.panel.appendChild(resizeHandle);
        this._setupResize(resizeHandle);

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);

        // Event listeners
        this.panel.querySelector('#mwi-labsim-close').addEventListener('click', () => {
            this.panel.style.display = 'none';
        });
        this.panel.addEventListener('mousedown', () => bringPanelToFront(this.panel));

        // Tab switching
        this.panel
            .querySelector('#mwi-labsim-tab-configure')
            .addEventListener('click', () => this._switchTab('configure'));
        this.panel
            .querySelector('#mwi-labsim-tab-maxlevel')
            .addEventListener('click', () => this._switchTab('maxlevel'));
        this.panel.querySelector('#mwi-labsim-tab-upgrade').addEventListener('click', () => this._switchTab('upgrade'));
        this.panel
            .querySelector('#mwi-labsim-tab-skilling')
            .addEventListener('click', () => this._switchTab('skilling'));

        // Configure listeners
        this.panel.querySelector('#mwi-labsim-monster').addEventListener('change', (e) => {
            this._onMonsterChange(e.target.value);
        });

        // Max Level listeners
        this.panel.querySelector('#mwi-labsim-run').addEventListener('click', () => this._onSimulate());
        this.panel.querySelector('#mwi-labsim-stop').addEventListener('click', () => {
            cancelSimulation();
            this.isRunning = false;
            this._setStatus('Labyrinth simulation cancelled.');
            this.panel.querySelector('#mwi-labsim-progress').style.display = 'none';
        });
        this.panel.querySelector('#mwi-labsim-findmax').addEventListener('change', (e) => {
            this._labyFindMaxMode = e.target.checked;
            const levelInput = this.panel.querySelector('#mwi-labsim-level');
            levelInput.disabled = e.target.checked;
            levelInput.style.opacity = e.target.checked ? '0.4' : '1';
        });

        // Upgrade listeners
        this.panel.querySelector('#mwi-labsim-upgrade-run').addEventListener('click', () => this._onUpgradeAnalyze());
        this.panel.querySelector('#mwi-labsim-upgrade-mode').addEventListener('change', (e) => {
            const levelGroup = this.panel.querySelector('#mwi-labsim-upgrade-level-group');
            const levelType = this.panel.querySelector('#mwi-labsim-upgrade-level-type');
            const levelInput = this.panel.querySelector('#mwi-labsim-upgrade-target-level');
            const isLevelMode = e.target.value === 'ability_level' || e.target.value === 'combined';
            const isCombatLevelMode = e.target.value === 'combat_level' || e.target.value === 'combat_level_all';
            levelGroup.style.display = isLevelMode || isCombatLevelMode ? 'inline-flex' : 'none';
            // Combat Levels modes reuse the number input as the +N levels per
            // skill; the increment/target selector doesn't apply
            if (levelType) levelType.style.display = isCombatLevelMode ? 'none' : '';
            if (levelInput && isCombatLevelMode) levelInput.value = 5;
            const targetsToggle = this.panel.querySelector('#mwi-labsim-combat-targets-toggle');
            if (targetsToggle) targetsToggle.style.display = isCombatLevelMode ? '' : 'none';
            if (!isCombatLevelMode) {
                this.panel.querySelector('#mwi-labsim-combat-targets').style.display = 'none';
            }
            // Per-ability targets only apply to ability-level candidates
            const abilityTargetsToggle = this.panel.querySelector('#mwi-labsim-ability-targets-toggle');
            if (abilityTargetsToggle) abilityTargetsToggle.style.display = isLevelMode ? '' : 'none';
            if (!isLevelMode) {
                this.panel.querySelector('#mwi-labsim-ability-targets').style.display = 'none';
            }
        });
        this.panel.querySelector('#mwi-labsim-ability-targets-toggle').addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-labsim-ability-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) {
                this._prefillAbilityTargets(grid, '#mwi-labsim-upgrade-player', '#mwi-labsim-upgrade-target-level');
            }
        });
        this.panel.querySelector('#mwi-labsim-combat-targets-toggle').addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-labsim-combat-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) {
                this._prefillLabCombatTargets();
            }
        });
        this.panel.querySelector('#mwi-labsim-upgrade-stop').addEventListener('click', () => {
            this._upgradeAborted = true;
        });

        // Skilling listeners
        this.panel
            .querySelector('#mwi-labsim-skilling-calc')
            .addEventListener('click', () => this._onSkillingCalculate());
        this.panel
            .querySelector('#mwi-labsim-skilling-upgrade')
            .addEventListener('click', () => this._onSkillingUpgradeAnalyze());
        this.panel.querySelector('#mwi-labsim-skilling-useskip').addEventListener('change', (e) => {
            const levelInput = this.panel.querySelector('#mwi-labsim-skilling-level');
            if (levelInput) levelInput.disabled = e.target.checked;
        });
        this.panel.querySelector('#mwi-labsim-skilling-stop').addEventListener('click', () => {
            this._skillingAborted = true;
        });
        this.panel.querySelector('#mwi-labsim-skilling-filter').addEventListener('change', () => {
            this._renderSkillLoadoutTable();
        });

        this._populateMonsters();
    }

    /** @private */
    _populateMonsters() {
        const select = this.panel?.querySelector('#mwi-labsim-monster');
        if (!select) return;

        const monsters = getLabyrinthMonsters();
        select.innerHTML = '';
        for (const monster of monsters) {
            const option = document.createElement('option');
            option.value = monster.hrid;
            option.textContent = monster.name;
            select.appendChild(option);
        }
    }

    /** @private */
    _onMonsterChange(monsterHrid) {
        if (!monsterHrid || !this._editor?.isInitialized()) return;
        const monsterId = monsterHrid.split('/').pop();
        const pascal = monsterId
            .split('_')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join('');
        const loadoutId = dataManager.characterData?.characterSetting?.[`labyrinthLoadout${pascal}`];
        if (!loadoutId) return;
        const snapshot = loadoutSnapshot.snapshots[loadoutId];
        if (!snapshot?.name) return;
        this._editor.applyLoadoutByName(snapshot.name);
    }

    /** @private */
    _populateUpgradePlayerSelector() {
        const select = this.panel?.querySelector('#mwi-labsim-upgrade-player');
        if (!select) return;

        const playerInfo = this._editor?.getPlayerInfo() || [];
        select.innerHTML = '';
        playerInfo.forEach((p, i) => {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = p.name || `Player ${i + 1}`;
            select.appendChild(option);
        });

        if (playerInfo.length === 0) {
            const option = document.createElement('option');
            option.value = 0;
            option.textContent = 'Player 1';
            select.appendChild(option);
        }
    }

    /** @private */
    _renderBuffsSection() {
        const container = this.panel?.querySelector('#mwi-labsim-buffs-body');
        if (!container) return;

        const info = dataManager.characterData?.characterInfo;
        if (!info) {
            container.innerHTML = '<div style="color:#555;">No character data available.</div>';
            return;
        }

        const groups = [
            {
                label: 'Combat',
                buffs: [
                    { key: 'labyrinthCombatDamageLevel', name: 'Damage' },
                    { key: 'labyrinthAttackSpeedLevel', name: 'Atk Speed' },
                    { key: 'labyrinthCastSpeedLevel', name: 'Cast Speed' },
                    { key: 'labyrinthCriticalRateLevel', name: 'Crit Rate' },
                ],
            },
            {
                label: 'Skilling',
                buffs: [
                    { key: 'labyrinthSkillActionSpeedLevel', name: 'Speed' },
                    { key: 'labyrinthSkillingEfficiencyLevel', name: 'Efficiency' },
                    { key: 'labyrinthSkillingSuccessLevel', name: 'Success' },
                    { key: 'labyrinthSkillingDoubleProgressLevel', name: 'Double' },
                ],
            },
            {
                label: 'Other',
                buffs: [
                    { key: 'labyrinthExperienceLevel', name: 'Experience' },
                    { key: 'labyrinthCooldownLevel', name: 'Cooldown' },
                    { key: 'labyrinthTorchLevel', name: 'Torch' },
                    { key: 'labyrinthShroudLevel', name: 'Shroud' },
                    { key: 'labyrinthBeaconLevel', name: 'Beacon' },
                    { key: 'labyrinthAutomationLevel', name: 'Automation' },
                ],
            },
        ];

        let html = '';
        for (const group of groups) {
            html += `<div style="color:#666; font-weight:600; font-size:10px; text-transform:uppercase; margin-top:4px; margin-bottom:2px;">${group.label}</div>`;
            html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:1px 16px;">';
            for (const b of group.buffs) {
                const level = Math.max(0, Math.floor(Number(info[b.key]) || 0));
                const isMaxed = level >= 12;
                const color = isMaxed ? '#4caf50' : '#e0e0e0';
                html += `<div style="display:flex; justify-content:space-between; padding:1px 0;">
                    <span style="color:#aaa;">${b.name}</span>
                    <span style="color:${color}; font-weight:${isMaxed ? '600' : '400'};">${level}/12</span>
                </div>`;
            }
            html += '</div>';
        }
        container.innerHTML = html;
    }

    /**
     * Get selected crate HRIDs from the Configure tab.
     * @returns {string[]}
     */
    getSelectedCrates() {
        const crates = [];
        const teaHrid = this.panel?.querySelector('#mwi-labsim-tea')?.value;
        const coffeeHrid = this.panel?.querySelector('#mwi-labsim-coffee')?.value;
        const foodHrid = this.panel?.querySelector('#mwi-labsim-food')?.value;
        if (teaHrid) crates.push(teaHrid);
        if (coffeeHrid) crates.push(coffeeHrid);
        if (foodHrid) crates.push(foodHrid);
        return crates;
    }

    /** @private */
    _switchTab(tab) {
        this._activeTab = tab;
        const configureContent = this.panel.querySelector('#mwi-labsim-configure-content');
        const maxLevelContent = this.panel.querySelector('#mwi-labsim-maxlevel-content');
        const upgradeContent = this.panel.querySelector('#mwi-labsim-upgrade-content');
        const skillingContent = this.panel.querySelector('#mwi-labsim-skilling-content');
        const tabConfigure = this.panel.querySelector('#mwi-labsim-tab-configure');
        const tabMaxLevel = this.panel.querySelector('#mwi-labsim-tab-maxlevel');
        const tabUpgrade = this.panel.querySelector('#mwi-labsim-tab-upgrade');
        const tabSkilling = this.panel.querySelector('#mwi-labsim-tab-skilling');

        const activeStyle = `flex:1; padding:7px 0; text-align:center; font-size:12px; font-weight:600; cursor:pointer; border:none; font-family:inherit; transition:all 0.1s; background:${ACCENT_BG}; color:${ACCENT}; border-bottom:2px solid ${ACCENT};`;
        const inactiveStyle =
            'flex:1; padding:7px 0; text-align:center; font-size:12px; font-weight:600; cursor:pointer; border:none; font-family:inherit; transition:all 0.1s; background:transparent; color:#888; border-bottom:2px solid transparent;';

        configureContent.style.display = 'none';
        maxLevelContent.style.display = 'none';
        upgradeContent.style.display = 'none';
        skillingContent.style.display = 'none';
        tabConfigure.style.cssText = inactiveStyle;
        tabMaxLevel.style.cssText = inactiveStyle;
        tabUpgrade.style.cssText = inactiveStyle;
        tabSkilling.style.cssText = inactiveStyle;

        if (tab === 'configure') {
            configureContent.style.display = 'flex';
            tabConfigure.style.cssText = activeStyle;
        } else if (tab === 'maxlevel') {
            maxLevelContent.style.display = 'flex';
            tabMaxLevel.style.cssText = activeStyle;
        } else if (tab === 'upgrade') {
            upgradeContent.style.display = 'flex';
            tabUpgrade.style.cssText = activeStyle;
            this._populateUpgradePlayerSelector();
        } else if (tab === 'skilling') {
            skillingContent.style.display = 'flex';
            tabSkilling.style.cssText = activeStyle;
            void this._showSkillingTab();
        }
    }

    /** @private */
    async _showSkillingTab() {
        try {
            if (!this._skillingEditor.isInitialized()) {
                await this._skillingEditor.initEditor();
            }
            await this._renderSkillLoadoutTable();
        } catch (error) {
            console.error('[LabSimUI] Failed to show skilling tab:', error);
        }
    }

    /** @private */
    _setStatus(text) {
        const el = this.panel?.querySelector('#mwi-labsim-status');
        if (el) el.textContent = text;
    }

    /** @private */
    async _onSimulate() {
        if (this.isRunning) {
            cancelSimulation();
            this._setStatus('Labyrinth simulation cancelled.');
            return;
        }

        const monsterHrid = this.panel.querySelector('#mwi-labsim-monster')?.value;
        const roomLevel = parseInt(this.panel.querySelector('#mwi-labsim-level')?.value) || 100;
        const hours = Math.min(
            10000,
            Math.max(1, parseInt(this.panel.querySelector('#mwi-labsim-hours')?.value) || 10)
        );

        if (!monsterHrid) {
            this._setStatus('Select a monster first.');
            return;
        }

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        const crates = this.getSelectedCrates();
        const labyrinthCombatBuffs = labyrinthClearRate.getLabyrinthCombatBuffs();

        let selfDTO;
        const editedDTOs = this._editor?.getEditedDTOs();
        if (editedDTOs) {
            const selfHrid = this._editor.getSelfHrid();
            selfDTO = editedDTOs[selfHrid] || Object.values(editedDTOs)[0];
        } else {
            const result = await buildAllPlayerDTOs();
            selfDTO = result.players.find((p) => p.hrid === result.selfHrid) || result.players[0];
        }

        if (!selfDTO) {
            this._setStatus('No character data available.');
            return;
        }

        const playerDTOs = [selfDTO];

        const communityBuffs = getCommunityBuffs();
        const zones = getCombatZones();
        const zoneHrid = zones[0]?.hrid || '/actions/combat/fly';

        this.isRunning = true;
        const runBtn = this.panel.querySelector('#mwi-labsim-run');
        runBtn.disabled = true;
        runBtn.style.opacity = '0.5';
        runBtn.style.cursor = 'not-allowed';

        const progressContainer = this.panel.querySelector('#mwi-labsim-progress');
        const progressFill = this.panel.querySelector('#mwi-labsim-progress-fill');
        const progressText = this.panel.querySelector('#mwi-labsim-progress-text');
        progressContainer.style.display = 'block';
        progressFill.style.width = '0%';
        progressText.textContent = '0%';

        const simStartTime = Date.now();

        try {
            if (this._labyFindMaxMode) {
                const threshold =
                    Math.min(
                        100,
                        Math.max(1, parseInt(this.panel.querySelector('#mwi-labsim-threshold')?.value) || 95)
                    ) / 100;
                const maxResult = await findMaxLabyrinthLevel(
                    {
                        gameData,
                        playerDTOs,
                        zoneHrid,
                        monsterHrid,
                        crates,
                        simHours: hours,
                        communityBuffs,
                        labyrinthCombatBuffs,
                        threshold,
                    },
                    (progress) => {
                        const percent = Math.round((progress.step / progress.totalSteps) * 100);
                        progressFill.style.width = `${percent}%`;
                        progressText.textContent = `Level ${progress.level} — ${(progress.winRate * 100).toFixed(0)}% (step ${progress.step}/${progress.totalSteps})`;
                    }
                );

                this._maxLevel = maxResult.maxLevel;
                const levelInput = this.panel.querySelector('#mwi-labsim-level');
                if (levelInput) levelInput.value = maxResult.maxLevel;

                this._displayFindMaxResults(maxResult, monsterHrid, simStartTime);
            } else {
                const simResult = await runLabyrinthSimulation(
                    {
                        gameData,
                        playerDTOs,
                        zoneHrid,
                        monsterHrid,
                        roomLevel,
                        crates,
                        hours,
                        communityBuffs,
                        labyrinthCombatBuffs,
                    },
                    (percent) => {
                        progressFill.style.width = `${percent}%`;
                        progressText.textContent = `${percent}%`;
                    }
                );

                this._displaySimResults(simResult, monsterHrid, roomLevel, hours, simStartTime, playerDTOs[0].hrid);
            }
        } catch (error) {
            if (error.message !== 'Cancelled') {
                console.error('[LabSimUI] Simulation failed:', error);
                this._setStatus('Simulation failed: ' + error.message);
            }
        } finally {
            this.isRunning = false;
            runBtn.disabled = false;
            runBtn.style.opacity = '1';
            runBtn.style.cursor = 'pointer';
            progressContainer.style.display = 'none';
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
        }
    }

    /** @private */
    _displaySimResults(simResult, monsterHrid, roomLevel, hours, simStartTime, playerHrid) {
        const container = this.panel?.querySelector('#mwi-labsim-results');
        if (!container) return;

        const totalElapsed = formatElapsed((Date.now() - simStartTime) / 1000);
        const attempts = simResult.labyAttemptCount || 0;
        const encounters = simResult.encounters || 0;
        const deaths = simResult.deaths?.[playerHrid || 'player1'] || 0;
        const simHours = (simResult.simulatedTime || 0) / (3600 * 1e9) || hours;
        const winRate = attempts > 0 ? ((encounters / attempts) * 100).toFixed(2) : '0.00';

        const monsterName = monsterHrid
            .split('/')
            .pop()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());

        container.innerHTML = `
            <div style="margin-bottom:12px;">
                <div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:6px;">
                    ${monsterName} \u2014 Level ${roomLevel}
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 20px; font-size:12px;">
                    <div><span style="color:#888;">Win Rate:</span> <span style="color:${parseFloat(winRate) >= 95 ? '#4caf50' : parseFloat(winRate) >= 50 ? '#ff9800' : '#f44336'}; font-weight:600;">${winRate}%</span></div>
                    <div><span style="color:#888;">Encounters:</span> ${formatWithSeparator(attempts)}</div>
                    <div><span style="color:#888;">Deaths:</span> <span style="color:${deaths > 0 ? '#f44336' : '#4caf50'};">${formatWithSeparator(deaths)}</span></div>
                    <div><span style="color:#888;">Sim Time:</span> ${simHours.toFixed(1)}h</div>
                </div>
                <div style="color:#555; font-size:10px; margin-top:6px;">Completed in ${totalElapsed}</div>
            </div>
        `;

        this._setStatus(`Simulation complete \u2014 ${winRate}% win rate at level ${roomLevel}.`);
    }

    /** @private */
    _displayFindMaxResults(maxResult, monsterHrid, simStartTime) {
        const container = this.panel?.querySelector('#mwi-labsim-results');
        if (!container) return;

        const totalElapsed = formatElapsed((Date.now() - simStartTime) / 1000);
        const monsterName = monsterHrid
            .split('/')
            .pop()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());
        const effectiveCombatLevel = labyrinthClearRate.getPlayerEffectiveCombatLevel();
        const recommendedSkip = maxResult.maxLevel - effectiveCombatLevel + 1;

        container.innerHTML = `
            <div style="margin-bottom:12px;">
                <div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:6px;">
                    ${monsterName} \u2014 Find Max Result
                </div>
                <div style="font-size:24px; font-weight:700; color:#4caf50; margin-bottom:6px;">
                    Level ${maxResult.maxLevel}
                </div>
                <div style="font-size:12px; color:#888;">
                    Win Rate: <span style="color:#e0e0e0; font-weight:600;">${(maxResult.winRate * 100).toFixed(1)}%</span>
                    at level ${maxResult.maxLevel}
                </div>
                <div style="font-size:12px; color:#888; margin-top:4px;">
                    Recommended skip: <span style="color:#e0e0e0; font-weight:600;">${recommendedSkip}</span>
                </div>
                <div style="color:#555; font-size:10px; margin-top:6px;">Completed in ${totalElapsed} (${maxResult.steps} steps)</div>
            </div>
        `;

        this._setStatus(
            `Max beatable level: ${maxResult.maxLevel} (${(maxResult.winRate * 100).toFixed(1)}% win rate).`
        );
    }

    /** @private */
    async _onUpgradeAnalyze() {
        const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const roomLevel = parseInt(this.panel.querySelector('#mwi-labsim-level')?.value) || 100;
        const monsterHrid = this.panel.querySelector('#mwi-labsim-monster')?.value;
        const hours = Math.min(
            10000,
            Math.max(1, parseInt(this.panel.querySelector('#mwi-labsim-hours')?.value) || 10)
        );
        const isAllFights = this.panel.querySelector('#mwi-labsim-upgrade-mode')?.value === 'combat_level_all';

        if (!monsterHrid && !isAllFights) {
            this._setStatus('Select a monster in the Configure tab first.');
            return;
        }

        const crates = this.getSelectedCrates();

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        let playerDTOs;
        const editedDTOs = this._editor?.getEditedDTOs();
        if (editedDTOs) {
            playerDTOs = Object.values(editedDTOs);
        } else {
            const result = await buildAllPlayerDTOs();
            playerDTOs = result.players;
        }

        if (!playerDTOs?.length || !playerDTOs[playerIndex]) {
            this._setStatus('No player data available.');
            return;
        }

        const communityBuffs = getCommunityBuffs();
        const labyrinthCombatBuffs = labyrinthClearRate.getLabyrinthCombatBuffs();

        const progressEl = this.panel.querySelector('#mwi-labsim-upgrade-progress');
        const resultsEl = this.panel.querySelector('#mwi-labsim-upgrade-results');
        const runBtn = this.panel.querySelector('#mwi-labsim-upgrade-run');
        const stopBtn = this.panel.querySelector('#mwi-labsim-upgrade-stop');
        progressEl.style.display = 'block';
        resultsEl.innerHTML = '';
        runBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        this._upgradeAborted = false;

        const upgradeMode = this.panel.querySelector('#mwi-labsim-upgrade-mode')?.value || 'equipment';
        const abilityLevelType = this.panel.querySelector('#mwi-labsim-upgrade-level-type')?.value || 'increment';
        const abilityTargetLevel = Math.min(
            200,
            parseInt(this.panel.querySelector('#mwi-labsim-upgrade-target-level')?.value, 10) || 0
        );
        const isCombatLevelMode = upgradeMode === 'combat_level' || upgradeMode === 'combat_level_all';
        const combatLevelTargets = isCombatLevelMode ? this._getLabCombatLevelTargets() : null;
        const abilityTargets =
            upgradeMode === 'ability_level' || upgradeMode === 'combined'
                ? this._getAbilityTargets('#mwi-labsim-ability-targets')
                : null;

        if (isAllFights) {
            try {
                const fights = this._collectLabyrinthFights();
                if (!fights.length) {
                    this._setStatus(
                        'No labyrinth fights found — set combat skip levels in the game (or enter the labyrinth) so fights have room levels.'
                    );
                    return;
                }
                const analysisResult = await runLabyrinthAllFightsAnalysis(
                    {
                        fights,
                        crates,
                        hours,
                        communityBuffs,
                        labyrinthCombatBuffs,
                        abilityTargetLevel,
                        combatLevelTargets,
                    },
                    ({ current, total, description }) => {
                        if (this._upgradeAborted) return;
                        const fill = this.panel.querySelector('#mwi-labsim-upgrade-progress-fill');
                        const text = this.panel.querySelector('#mwi-labsim-upgrade-progress-text');
                        if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                        if (text) text.textContent = `${current} / ${total}: ${description}`;
                    },
                    { abortSignal: () => this._upgradeAborted }
                );

                this._renderAllFightsResults(analysisResult, resultsEl);
            } catch (error) {
                if (error.message !== 'Cancelled' && error.message !== 'Aborted') {
                    console.error('[LabSimUI] All-fights analysis failed:', error);
                    this._setStatus('All-fights analysis failed: ' + error.message);
                }
            } finally {
                progressEl.style.display = 'none';
                runBtn.style.display = '';
                stopBtn.style.display = 'none';
            }
            return;
        }

        try {
            const analysisResult = await runLabyrinthUpgradeAnalysis(
                {
                    playerDTOs,
                    playerIndex,
                    monsterHrid,
                    roomLevel,
                    crates,
                    hours,
                    communityBuffs,
                    labyrinthCombatBuffs,
                    upgradeMode,
                    abilityLevelType,
                    abilityTargetLevel,
                    combatLevelTargets,
                    abilityTargets,
                },
                ({ current, total, description }) => {
                    if (this._upgradeAborted) return;
                    const fill = this.panel.querySelector('#mwi-labsim-upgrade-progress-fill');
                    const text = this.panel.querySelector('#mwi-labsim-upgrade-progress-text');
                    if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                    if (text) text.textContent = `${current} / ${total}: ${description}`;
                },
                { abortSignal: () => this._upgradeAborted }
            );

            this._renderUpgradeResults(analysisResult, resultsEl);
        } catch (error) {
            if (error.message !== 'Cancelled' && error.message !== 'Aborted') {
                console.error('[LabSimUI] Upgrade analysis failed:', error);
                this._setStatus('Upgrade analysis failed: ' + error.message);
            }
        } finally {
            progressEl.style.display = 'none';
            runBtn.style.display = '';
            stopBtn.style.display = 'none';
        }
    }

    /**
     * Prefill the per-skill target inputs from the selected player's current
     * levels plus the +Levels boost. In the single-monster Combat Levels mode
     * skills the weapon style can't train are hidden; the All Fights mode
     * keeps every skill visible since assigned loadouts can differ in style.
     * @private
     */
    _prefillLabCombatTargets() {
        const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const boost = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-target-level')?.value) || 5;
        const isAllFights = this.panel.querySelector('#mwi-labsim-upgrade-mode')?.value === 'combat_level_all';

        const gameData = buildGameDataPayload();
        const excluded = !isAllFights && dto && gameData ? getStyleExcludedSkills(dto, gameData) : new Set();

        this.panel.querySelectorAll('[data-lab-combat-target]').forEach((input) => {
            const isExcluded = excluded.has(input.dataset.labCombatTarget);
            const wrapper = input.closest('span');
            if (wrapper) wrapper.style.display = isExcluded ? 'none' : 'inline-flex';
            if (isExcluded) {
                input.value = '';
                return;
            }
            const current = Math.max(1, Math.floor(dto?.[input.dataset.labCombatTarget] || 1));
            input.value = Math.min(200, current + boost);
        });
    }

    /**
     * Rebuild and prefill the per-ability target inputs from the selected
     * player's equipped abilities (current level + the +Levels boost).
     * @private
     */
    _prefillAbilityTargets(grid, playerSelector, levelSelector) {
        const playerIndex = parseInt(this.panel.querySelector(playerSelector)?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const abilities = (dto?.abilities || []).filter(Boolean);
        const boost = parseInt(this.panel.querySelector(levelSelector)?.value) || 5;
        const gameData = buildGameDataPayload();

        if (!abilities.length) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No abilities equipped — configure a simulation first.</span>';
            return;
        }

        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;">Target levels (blank or ≤ current level skips the ability; used instead of the +Levels boost while open):</span>' +
            abilities
                .map((ability) => {
                    const name = gameData?.abilityDetailMap?.[ability.hrid]?.name || ability.hrid.split('/').pop();
                    const target = Math.min(200, (ability.level || 1) + boost);
                    return `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${name} (${ability.level})</label>
                    <input type="number" min="1" max="200" data-ability-target="${ability.hrid}" value="${target}" style="
                        width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`;
                })
                .join('');
    }

    /**
     * Read the per-ability target map when the grid is open.
     * @private
     * @returns {Object|null} {abilityHrid: targetLevel} or null when not in use
     */
    _getAbilityTargets(gridSelector) {
        const grid = this.panel.querySelector(gridSelector);
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-ability-target]').forEach((input) => {
            const value = parseInt(input.value);
            if (Number.isFinite(value) && value > 0) {
                targets[input.dataset.abilityTarget] = Math.min(200, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * Read the per-skill target map when the targets grid is open.
     * @private
     * @returns {Object|null} {skillKey: targetLevel} or null when not in use
     */
    _getLabCombatLevelTargets() {
        const grid = this.panel.querySelector('#mwi-labsim-combat-targets');
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-lab-combat-target]').forEach((input) => {
            const value = parseInt(input.value);
            if (Number.isFinite(value) && value > 0) {
                targets[input.dataset.labCombatTarget] = Math.min(200, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * Collect every labyrinth combat fight: each monster with a resolvable
     * room level (live room while in a run, otherwise effective combat level +
     * skip threshold − 1) paired with the player DTO wearing its assigned
     * labyrinth loadout.
     * @private
     * @returns {Array<{monsterHrid: string, monsterName: string, roomLevel: number, dto: Object, loadoutName: string}>}
     */
    _collectLabyrinthFights() {
        const fights = [];
        for (const monster of getLabyrinthMonsters()) {
            const roomLevel = labyrinthClearRate.getCombatRoomLevel(monster.hrid);
            if (!roomLevel) continue; // no skip threshold configured for this monster
            const loadoutId = labyrinthClearRate.getLabyrinthLoadoutId(monster.hrid);
            const dto = labyrinthClearRate.buildLabyrinthPlayerDTO(loadoutId);
            if (!dto) continue;
            const loadoutName =
                loadoutSnapshot.snapshots[loadoutId]?.name || (loadoutId ? `Loadout #${loadoutId}` : 'Current gear');
            fights.push({ monsterHrid: monster.hrid, monsterName: monster.name, roomLevel, dto, loadoutName });
        }
        return fights;
    }

    /**
     * Render the all-fights combat level analysis: candidates ranked by how
     * many expected combat attempts they save across the whole run (retrying
     * failed rooms), with a per-fight breakdown on click.
     * @private
     */
    _renderAllFightsResults(analysisResult, container) {
        const baseline = analysisResult?.baseline;
        const results = analysisResult?.results;
        if (!baseline || !results?.length) {
            container.innerHTML =
                '<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No results — check that combat skip levels and loadouts are set.</div>';
            this._setStatus('All-fights analysis produced no results.');
            return;
        }

        const pct = (v) => `${(v * 100).toFixed(1)}%`;
        const deltaPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
        const deltaColor = (v) => (v > 0.0001 ? '#4caf50' : v < -0.0001 ? '#f44336' : '#888');
        // Fewer expected attempts = better, so the good direction is negative
        const attemptsDeltaColor = (v) => (v < -0.05 ? '#4caf50' : v > 0.05 ? '#f44336' : '#888');
        const fmtAttempts = (v) => v.toFixed(1);
        const fmtAttemptsDelta = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
        const expectedTries = (winRate) => 1 / Math.max(winRate, 0.001);
        const thStyle =
            'padding:4px 6px; text-align:left; border-bottom:1px solid #333; color:#888; font-weight:600; white-space:nowrap;';
        const tdStyle = 'padding:4px 6px; border-bottom:1px solid #1a1a2e; white-space:nowrap;';
        const bestDelta = Math.min(...results.map((r) => r.attemptsDelta));

        let html = `
            <div style="margin-bottom:8px; font-size:12px; color:#888;">
                Baseline: <span style="color:#e0e0e0; font-weight:700;">${fmtAttempts(baseline.expectedAttempts)}</span>
                expected combat attempts to clear all ${baseline.fights.length} fights
                <span style="color:#555; font-size:10px; margin-left:6px;">Σ 1/win rate per fight, at its skip level with its assigned loadout — retries included</span>
            </div>
            <table style="width:100%; border-collapse:collapse; font-size:11px;">
            <thead><tr>
                <th style="${thStyle}">Skill</th>
                <th style="${thStyle}" title="Expected combat attempts to clear every fight once (retrying failed rooms)">Attempts</th>
                <th style="${thStyle}" title="Change in expected attempts vs baseline — negative is better">ΔAttempts</th>
                <th style="${thStyle}" title="Average per-fight win rate change">Avg ΔWin</th>
            </tr></thead><tbody>`;

        results.forEach((r, i) => {
            const isBest = r.attemptsDelta === bestDelta && bestDelta < -0.05;
            const attemptsStyle = isBest ? 'color:#4caf50; font-weight:700;' : '';
            html += `<tr style="cursor:pointer; color:#e0e0e0;" data-allfights-row="${i}">
                <td style="${tdStyle}">${r.candidate.description}</td>
                <td style="${tdStyle} ${attemptsStyle}">${fmtAttempts(r.expectedAttempts)}</td>
                <td style="${tdStyle} color:${attemptsDeltaColor(r.attemptsDelta)}; ${isBest ? 'font-weight:700;' : ''}">${fmtAttemptsDelta(r.attemptsDelta)}</td>
                <td style="${tdStyle} color:${deltaColor(r.avgWinDelta)};">${deltaPct(r.avgWinDelta)}</td>
            </tr>`;

            // Per-fight breakdown (hidden until the row is clicked)
            let fightRows = '';
            for (let f = 0; f < r.fights.length; f++) {
                const fight = r.fights[f];
                const base = baseline.fights[f];
                const triesBase = expectedTries(base.winRate);
                const triesNew = expectedTries(fight.winRate);
                fightRows += `<div style="display:flex; justify-content:space-between; gap:10px; padding:2px 0;">
                    <span style="color:#aaa;">${fight.monsterName} <span style="color:#666;">(Lv ${fight.roomLevel}, "${fight.loadoutName}")</span></span>
                    <span style="white-space:nowrap;">${pct(base.winRate)} → ${pct(fight.winRate)}
                        <span style="color:${deltaColor(fight.winRateDelta)};">(${deltaPct(fight.winRateDelta)})</span>
                        <span style="color:#666;">| ${fmtAttempts(triesBase)} → ${fmtAttempts(triesNew)} tries</span></span>
                </div>`;
            }
            html += `<tr data-allfights-detail="${i}" style="display:none;">
                <td colspan="4" style="padding:6px 12px; background:#0d0d1a; border-bottom:1px solid #222; font-size:11px;">${fightRows}</td>
            </tr>`;
        });

        html += '</tbody></table>';
        container.innerHTML = html;

        container.querySelectorAll('[data-allfights-row]').forEach((row) => {
            row.addEventListener('click', () => {
                const detail = container.querySelector(`[data-allfights-detail="${row.dataset.allfightsRow}"]`);
                if (detail) {
                    detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                }
            });
        });

        this._setStatus(
            `All-fights analysis complete: ${results.length} skill upgrades × ${baseline.fights.length} fights.`
        );
    }

    /** @private */
    _renderUpgradeResults(analysisResult, container) {
        const results = analysisResult?.results;
        if (!results || !results.length) {
            container.innerHTML =
                '<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No upgrade candidates found.</div>';
            this._setStatus('No upgrade candidates found.');
            return;
        }

        const tokenResults = results.filter((r) => r.costType === 'token');
        const goldResults = results.filter((r) => r.costType === 'gold');
        const thStyle =
            'text-align:right; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        const thLeftStyle =
            'text-align:left; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        const tdStyle = 'padding:3px 4px; text-align:right;';

        // Pre-compute row data for sorting
        const tokenRows = tokenResults.map((r) => {
            let rateVal, deltaVal, rateStr;

            if (r.metricType === 'clearRate') {
                rateVal = (r.clearRate || 0) * 100;
                deltaVal = (r.clearRateDelta || 0) * 100;
                rateStr = rateVal.toFixed(1) + '%';
            } else if (r.metricType === 'experience') {
                rateVal = 0;
                deltaVal = r.xpDeltaPct || 0;
                rateStr = 'XP';
            } else {
                rateVal = (r.winRate || 0) * 100;
                deltaVal = (r.winRateDelta || 0) * 100;
                rateStr = rateVal.toFixed(2) + '%';
            }

            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const deltaStr = (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%';

            const tokenCost = r.tokenCost || 0;
            const tokensPerPct = deltaVal > 0 ? Math.round(tokenCost / deltaVal) : Infinity;
            const tokensPerPctStr = deltaVal > 0 ? formatWithSeparator(tokensPerPct) : '\u2014';

            return {
                desc: r.candidate?.description || '',
                tokenCost,
                rateVal,
                rateStr,
                deltaVal,
                deltaStr,
                deltaColor,
                tokensPerPct,
                tokensPerPctStr,
            };
        });

        const goldRows = goldResults.map((r) => {
            const delta = (r.winRateDelta || 0) * 100;
            const deltaColor = delta > 0 ? '#4caf50' : delta < 0 ? '#f44336' : '#888';
            const cost = r.cost || 0;
            const winRate = (r.winRate || 0) * 100;
            const goldPerPct = delta > 0 && cost ? Math.round(cost / delta) : Infinity;

            return {
                desc: r.candidate?.description || '',
                cost,
                costStr: cost ? formatWithSeparator(cost) : '\u2014',
                winRate,
                winRateStr: winRate.toFixed(2) + '%',
                deltaVal: delta,
                deltaStr: (delta >= 0 ? '+' : '') + delta.toFixed(2) + '%',
                deltaColor,
                goldPerPct,
                goldPerPctStr: delta > 0 && cost ? formatWithSeparator(goldPerPct) : '\u2014',
            };
        });

        // Sort state
        const sortState = { token: { key: 'tokensPerPct', dir: 'asc' }, gold: { key: 'goldPerPct', dir: 'asc' } };

        const sortRows = (rows, key, dir) => {
            rows.sort((a, b) => {
                const av = a[key],
                    bv = b[key];
                if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
                return dir === 'asc' ? av - bv : bv - av;
            });
        };

        const arrow = (dir) => (dir === 'asc' ? ' \u25B2' : ' \u25BC');

        const renderTokenTable = () => {
            const s = sortState.token;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="token" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Token Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:12px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Tokens', 'tokenCost', 'right')}
                ${th('Rate', 'rateVal', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${th('Tokens/1%', 'tokensPerPct', 'right')}
            </tr></thead><tbody>`;

            for (const row of tokenRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    <td style="padding:3px 4px; color:#e0e0e0;">${row.desc}</td>
                    <td style="${tdStyle} color:#ccc;">${row.tokenCost || '\u2014'}</td>
                    <td style="${tdStyle} color:#ccc;">${row.rateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    <td style="${tdStyle} color:#888;">${row.tokensPerPctStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            return html;
        };

        const renderGoldTable = () => {
            const s = sortState.gold;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="gold" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Gold Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Cost', 'cost', 'right')}
                ${th('Win Rate', 'winRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${th('Gold/1%', 'goldPerPct', 'right')}
            </tr></thead><tbody>`;

            for (const row of goldRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    <td style="padding:3px 4px; color:#e0e0e0;">${row.desc}</td>
                    <td style="${tdStyle} color:#ccc;">${row.costStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.winRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    <td style="${tdStyle} color:#888;">${row.goldPerPctStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            return html;
        };

        const renderAll = () => {
            sortRows(tokenRows, sortState.token.key, sortState.token.dir);
            sortRows(goldRows, sortState.gold.key, sortState.gold.dir);
            let html = '';
            if (tokenResults.length > 0) html += renderTokenTable();
            if (goldResults.length > 0) html += renderGoldTable();
            container.innerHTML = html;
        };

        renderAll();

        // The container persists across Analyze runs — replace the previous
        // sort handler instead of stacking a new one each analysis
        if (this._upgradeSortHandler) {
            container.removeEventListener('click', this._upgradeSortHandler);
        }
        this._upgradeSortHandler = (e) => {
            const th = e.target.closest('th[data-sort-key]');
            if (!th) return;
            const table = th.dataset.table;
            const key = th.dataset.sortKey;
            const state = sortState[table];
            if (state.key === key) {
                state.dir = state.dir === 'desc' ? 'asc' : 'desc';
            } else {
                state.key = key;
                state.dir = key === 'desc' ? 'asc' : 'desc';
            }
            renderAll();
        };
        container.addEventListener('click', this._upgradeSortHandler);

        this._setStatus(`${results.length} upgrade candidates analyzed.`);
    }

    /** @private */
    _getSkillingCrates() {
        const crates = [];
        const tea = this.panel?.querySelector('#mwi-labsim-skilling-tea')?.value;
        const coffee = this.panel?.querySelector('#mwi-labsim-skilling-coffee')?.value;
        const food = this.panel?.querySelector('#mwi-labsim-skilling-food')?.value;
        if (tea) crates.push(tea);
        if (coffee) crates.push(coffee);
        if (food) crates.push(food);
        return crates;
    }

    /** @private */
    async _renderSkillLoadoutTable() {
        const container = this.panel?.querySelector('#mwi-labsim-skilling-loadouts');
        if (!container) return;

        const allSnapshots = loadoutSnapshot.getAllSnapshots();
        const nonCombatSnapshots = allSnapshots.filter(
            (s) => s.actionTypeHrid && s.actionTypeHrid !== '/action_types/combat'
        );
        const allSkillsSnapshots = allSnapshots.filter((s) => !s.actionTypeHrid);

        const skills = [
            { hrid: '/skills/woodcutting', label: 'Woodcutting', actionType: '/action_types/woodcutting' },
            { hrid: '/skills/foraging', label: 'Foraging', actionType: '/action_types/foraging' },
            { hrid: '/skills/milking', label: 'Milking', actionType: '/action_types/milking' },
            { hrid: '/skills/cooking', label: 'Cooking', actionType: '/action_types/cooking' },
            { hrid: '/skills/brewing', label: 'Brewing', actionType: '/action_types/brewing' },
            { hrid: '/skills/cheesesmithing', label: 'Cheesesmithing', actionType: '/action_types/cheesesmithing' },
            { hrid: '/skills/crafting', label: 'Crafting', actionType: '/action_types/crafting' },
            { hrid: '/skills/tailoring', label: 'Tailoring', actionType: '/action_types/tailoring' },
            { hrid: '/skills/alchemy', label: 'Alchemy', actionType: '/action_types/alchemy' },
            { hrid: '/skills/enhancing', label: 'Enhancing', actionType: '/action_types/enhancing' },
        ];

        // Load persisted overrides once
        if (!this._skillLoadoutsLoaded) {
            this._skillLoadoutsLoaded = true;
            const persisted = await storage.get('labSimSkillingLoadouts', 'settings', null);
            if (persisted && typeof persisted === 'object') {
                this._skillLoadouts = persisted;
            }
        }

        // Auto-populate from game's lab automation settings for any skill not already set
        if (Object.keys(this._skillLoadouts).length < skills.length) {
            const charSetting = dataManager.characterData?.characterSetting;
            const snapshots = loadoutSnapshot.snapshots || {};
            for (const skill of skills) {
                if (this._skillLoadouts[skill.hrid]) continue;
                const skillId = skill.hrid.replace('/skills/', '');
                const pascal = skillId.charAt(0).toUpperCase() + skillId.slice(1);
                const loadoutId = charSetting?.[`labyrinthLoadout${pascal}`];
                if (loadoutId && snapshots[loadoutId]?.name) {
                    this._skillLoadouts[skill.hrid] = snapshots[loadoutId].name;
                } else {
                    const match = nonCombatSnapshots.find((s) => s.actionTypeHrid === skill.actionType);
                    if (match) {
                        this._skillLoadouts[skill.hrid] = match.name;
                    } else if (allSkillsSnapshots.length > 0) {
                        this._skillLoadouts[skill.hrid] = allSkillsSnapshots[0].name;
                    }
                }
            }
        }

        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:1px 4px; font-size:11px; width:100%;';

        const targetSkill = this.panel.querySelector('#mwi-labsim-skilling-filter')?.value || '';
        const visibleSkills = targetSkill ? skills.filter((s) => s.hrid === targetSkill) : skills;
        const collapsed = this._loadoutsCollapsed || false;

        const arrow = collapsed ? '&#9654;' : '&#9660;';
        let html = `<div id="mwi-labsim-loadout-toggle" style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px; cursor:pointer; user-select:none;">
            <span style="display:inline-block; width:14px; font-size:10px;">${arrow}</span> Skill Loadouts
        </div>`;
        html += `<div id="mwi-labsim-loadout-grid" style="display:${collapsed ? 'none' : 'grid'}; grid-template-columns:1fr 1fr; gap:3px 10px;">`;

        for (const skill of visibleSkills) {
            const current = this._skillLoadouts[skill.hrid] || '';
            html += `<div style="display:flex; align-items:center; gap:4px; font-size:11px;">`;
            html += `<span style="color:#888; width:85px; flex-shrink:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${skill.label}">${skill.label}</span>`;
            html += `<select data-skill-loadout="${skill.hrid}" style="${selectStyle}">`;
            html += `<option value=""${!current ? ' selected' : ''}>Current Gear</option>`;
            for (const snap of [...nonCombatSnapshots, ...allSkillsSnapshots]) {
                const label = snap.name + (snap.actionTypeHrid ? '' : ' (All)');
                const selected = current === snap.name ? ' selected' : '';
                html += `<option value="${snap.name}"${selected}>${label}</option>`;
            }
            html += '</select></div>';
        }

        html += '</div>';
        container.innerHTML = html;

        container.querySelectorAll('[data-skill-loadout]').forEach((select) => {
            select.addEventListener('change', () => {
                const skillHrid = select.dataset.skillLoadout;
                this._skillLoadouts[skillHrid] = select.value;
                storage.set('labSimSkillingLoadouts', this._skillLoadouts, 'settings');
            });
        });

        container.querySelector('#mwi-labsim-loadout-toggle')?.addEventListener('click', () => {
            this._loadoutsCollapsed = !this._loadoutsCollapsed;
            this._renderSkillLoadoutTable();
        });
    }

    /**
     * Build per-skill equipment map from loadout assignments.
     * @param {Object} gameData
     * @returns {Object} { '/skills/woodcutting': { '/equipment_types/...': { hrid, enhancementLevel } }, ... }
     */
    _buildSkillEquipmentMap(gameData) {
        const itemDetailMap = gameData?.itemDetailMap || {};
        const liveEquipment = dataManager.characterEquipment;
        const allSnapshots = loadoutSnapshot.getAllSnapshots();
        const equipmentMap = {};

        for (const [skillHrid, loadoutName] of Object.entries(this._skillLoadouts)) {
            if (!loadoutName) continue;
            const snapshot = allSnapshots.find((s) => s.name === loadoutName);
            if (!snapshot?.equipment?.length) continue;

            const equipment = {};
            for (const equip of snapshot.equipment) {
                const itemDetail = itemDetailMap[equip.itemHrid];
                const equipType = itemDetail?.equipmentDetail?.type;
                if (!equipType) continue;
                let enhancementLevel = equip.enhancementLevel || 0;
                if (enhancementLevel === 0 && liveEquipment) {
                    for (const [, liveItem] of liveEquipment) {
                        if (liveItem.itemHrid === equip.itemHrid) {
                            enhancementLevel = liveItem.enhancementLevel || 0;
                            break;
                        }
                    }
                }
                equipment[equipType] = { hrid: equip.itemHrid, enhancementLevel };
            }
            equipmentMap[skillHrid] = equipment;
        }

        return equipmentMap;
    }

    /** @private */
    /**
     * Room level(s) for skilling calculations: a per-skill map derived from
     * each skill's automation skip level when "Use Skip Levels" is checked,
     * otherwise the single manual room level.
     * @private
     */
    _getSkillingRoomLevels() {
        const useSkip = this.panel.querySelector('#mwi-labsim-skilling-useskip')?.checked;
        if (!useSkip) {
            return parseInt(this.panel.querySelector('#mwi-labsim-skilling-level')?.value, 10) || 100;
        }
        const skillHrids = [
            '/skills/milking',
            '/skills/foraging',
            '/skills/woodcutting',
            '/skills/cheesesmithing',
            '/skills/crafting',
            '/skills/tailoring',
            '/skills/cooking',
            '/skills/brewing',
            '/skills/alchemy',
            '/skills/enhancing',
        ];
        const levels = {};
        for (const skillHrid of skillHrids) {
            levels[skillHrid] = labyrinthClearRate.getTargetRoomLevel(skillHrid);
        }
        return levels;
    }

    _onSkillingCalculate() {
        const roomLevel = this._getSkillingRoomLevels();
        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        const editedDTOs = this._skillingEditor?.getEditedDTOs();
        if (!editedDTOs) {
            this._setStatus('No character data. Wait for editor to load.');
            return;
        }

        const selfHrid = this._skillingEditor.getSelfHrid();
        const dto = editedDTOs[selfHrid] || Object.values(editedDTOs)[0];
        if (!dto) {
            this._setStatus('No player data available.');
            return;
        }

        const crateHrids = this._getSkillingCrates();
        const skillEquipmentMap = this._buildSkillEquipmentMap(gameData);
        const results = computeSkillingClearRatesFromEditor(roomLevel, dto, crateHrids, gameData, skillEquipmentMap);
        const targetSkill = this.panel.querySelector('#mwi-labsim-skilling-filter')?.value || null;
        const filtered = targetSkill ? results.filter((r) => r.skillHrid === targetSkill) : results;
        this._renderSkillingClearResults(filtered, roomLevel);
    }

    /** @private */
    _renderSkillingClearResults(results, roomLevel) {
        const container = this.panel?.querySelector('#mwi-labsim-skilling-results');
        if (!container) return;

        const usesSkipLevels = roomLevel && typeof roomLevel === 'object';
        const activeResults = results.filter((r) => !r.skipped);
        const avgClearRate = activeResults.length
            ? activeResults.reduce((s, r) => s + (r.clearChance || 0), 0) / activeResults.length
            : 0;

        const thStyle = 'text-align:right; padding:4px; color:#888; border-bottom:1px solid #333; font-size:10px;';
        const thLeftStyle = 'text-align:left; padding:4px; color:#888; border-bottom:1px solid #333; font-size:10px;';
        const tdStyle = 'padding:3px 4px; text-align:right; font-size:11px;';

        const headerText = usesSkipLevels ? 'Skip-Level Rooms' : `Skilling Room Level ${roomLevel}`;
        let html = `<div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:6px;">
            ${headerText}
            <span style="color:#888; font-weight:400; font-size:11px; margin-left:8px;">
                Avg Clear: <span style="color:${avgClearRate >= 0.95 ? '#4caf50' : avgClearRate >= 0.5 ? '#ff9800' : '#f44336'}; font-weight:600;">${(avgClearRate * 100).toFixed(1)}%</span>
            </span>
        </div>`;

        html += '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
        html += `<thead><tr>
            <th style="${thLeftStyle}">Skill</th>
            <th style="${thStyle}">Room</th>
            <th style="${thStyle}">Level</th>
            <th style="${thStyle}">Eff. Lvl</th>
            <th style="${thStyle}">Success</th>
            <th style="${thStyle}">Clear</th>
            <th style="${thStyle}">Actions</th>
        </tr></thead><tbody>`;

        for (const r of results) {
            if (r.skipped) {
                html += `<tr style="border-bottom:1px solid #1a1a1a; opacity:0.55;">
                    <td style="padding:3px 4px; color:#e0e0e0;">${r.skillName}</td>
                    <td style="${tdStyle} color:#888;">Skip</td>
                    <td style="${tdStyle} color:#ccc;">${r.baseLevel}</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                </tr>`;
                continue;
            }
            const clearColor = r.clearChance >= 0.95 ? '#4caf50' : r.clearChance >= 0.5 ? '#ff9800' : '#f44336';
            const successPct = ((r.successChance || 0) * 100).toFixed(1);
            const clearPct = ((r.clearChance || 0) * 100).toFixed(1);
            const rowRoomLevel = r.roomLevel ?? roomLevel;

            html += `<tr style="border-bottom:1px solid #1a1a1a;">
                <td style="padding:3px 4px; color:#e0e0e0;">${r.skillName}</td>
                <td style="${tdStyle} color:#ccc;">${rowRoomLevel}</td>
                <td style="${tdStyle} color:#ccc;">${r.baseLevel}</td>
                <td style="${tdStyle} color:#ccc;">${r.effectiveLevel}</td>
                <td style="${tdStyle} color:#ccc;">${successPct}%</td>
                <td style="${tdStyle} color:${clearColor}; font-weight:600;">${clearPct}%</td>
                <td style="${tdStyle} color:#888;">${r.attempts || 0}</td>
            </tr>`;
        }

        html += '</tbody></table>';
        container.innerHTML = html;
        this._setStatus(
            usesSkipLevels
                ? 'Skilling clear rates calculated from automation skip levels.'
                : `Skilling clear rates calculated for level ${roomLevel}.`
        );
    }

    /** @private */
    async _onSkillingUpgradeAnalyze() {
        const roomLevel = this._getSkillingRoomLevels();
        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        const editedDTOs = this._skillingEditor?.getEditedDTOs();
        if (!editedDTOs) {
            this._setStatus('No character data. Wait for editor to load.');
            return;
        }

        const selfHrid = this._skillingEditor.getSelfHrid();
        const dto = editedDTOs[selfHrid] || Object.values(editedDTOs)[0];
        if (!dto) {
            this._setStatus('No player data available.');
            return;
        }

        const crateHrids = this._getSkillingCrates();
        const skillEquipmentMap = this._buildSkillEquipmentMap(gameData);
        const targetSkill = this.panel.querySelector('#mwi-labsim-skilling-filter')?.value || null;

        const progressEl = this.panel.querySelector('#mwi-labsim-skilling-progress');
        const resultsEl = this.panel.querySelector('#mwi-labsim-skilling-results');
        const calcBtn = this.panel.querySelector('#mwi-labsim-skilling-calc');
        const upgradeBtn = this.panel.querySelector('#mwi-labsim-skilling-upgrade');
        const stopBtn = this.panel.querySelector('#mwi-labsim-skilling-stop');
        progressEl.style.display = 'block';
        resultsEl.innerHTML = '';
        calcBtn.style.display = 'none';
        upgradeBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        this._skillingAborted = false;

        try {
            const analysisResult = await runSkillingUpgradeAnalysis(
                { editorDTO: dto, roomLevel, crateHrids, skillEquipmentMap, targetSkill },
                ({ current, total, description }) => {
                    if (this._skillingAborted) return;
                    const fill = this.panel.querySelector('#mwi-labsim-skilling-progress-fill');
                    const text = this.panel.querySelector('#mwi-labsim-skilling-progress-text');
                    if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                    if (text) text.textContent = `${current} / ${total}: ${description}`;
                },
                { abortSignal: () => this._skillingAborted }
            );

            this._renderSkillingUpgradeResults(analysisResult, resultsEl);
        } catch (error) {
            console.error('[LabSimUI] Skilling upgrade analysis failed:', error);
            this._setStatus('Skilling upgrade analysis failed: ' + error.message);
        } finally {
            progressEl.style.display = 'none';
            calcBtn.style.display = '';
            upgradeBtn.style.display = '';
            stopBtn.style.display = 'none';
        }
    }

    /** @private */
    _renderSkillingUpgradeResults(analysisResult, container) {
        const results = analysisResult?.results;
        if (!results || !results.length) {
            container.innerHTML =
                '<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No upgrade candidates found.</div>';
            this._setStatus('No skilling upgrade candidates found.');
            return;
        }

        const baseline = analysisResult.baseline;
        const tokenResults = results.filter((r) => r.costType === 'token');
        const goldResults = results.filter((r) => r.costType === 'gold');
        const thStyle =
            'text-align:right; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        const thLeftStyle =
            'text-align:left; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        const tdStyle = 'padding:3px 4px; text-align:right;';

        const tokenRows = tokenResults.map((r) => {
            const clearRate = (r.clearRate || 0) * 100;
            const deltaVal = (r.clearRateDelta || 0) * 100;
            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const tokenCost = r.tokenCost || 0;
            const tokensPerPct = deltaVal > 0 ? Math.round(tokenCost / deltaVal) : Infinity;

            return {
                desc: r.candidate?.description || '',
                tokenCost,
                clearRate,
                clearRateStr: clearRate.toFixed(1) + '%',
                deltaVal,
                deltaStr: (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%',
                deltaColor,
                tokensPerPct,
                tokensPerPctStr: deltaVal > 0 ? formatWithSeparator(tokensPerPct) : '\u2014',
            };
        });

        const goldRows = goldResults.map((r) => {
            const clearRate = (r.clearRate || 0) * 100;
            const deltaVal = (r.clearRateDelta || 0) * 100;
            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const cost = r.cost || 0;
            const goldPerPct = deltaVal > 0 && cost ? Math.round(cost / deltaVal) : Infinity;

            return {
                desc: r.candidate?.description || '',
                cost,
                costStr: cost ? formatWithSeparator(cost) : '\u2014',
                clearRate,
                clearRateStr: clearRate.toFixed(1) + '%',
                deltaVal,
                deltaStr: (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%',
                deltaColor,
                goldPerPct,
                goldPerPctStr: deltaVal > 0 && cost ? formatWithSeparator(goldPerPct) : '\u2014',
            };
        });

        const sortState = { token: { key: 'tokensPerPct', dir: 'asc' }, gold: { key: 'goldPerPct', dir: 'asc' } };

        const sortRows = (rows, key, dir) => {
            rows.sort((a, b) => {
                const av = a[key],
                    bv = b[key];
                if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
                return dir === 'asc' ? av - bv : bv - av;
            });
        };

        const arrow = (dir) => (dir === 'asc' ? ' \u25B2' : ' \u25BC');

        const renderTokenTable = () => {
            const s = sortState.token;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="token" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Token Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:12px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Tokens', 'tokenCost', 'right')}
                ${th('Clear Rate', 'clearRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${th('Tokens/1%', 'tokensPerPct', 'right')}
            </tr></thead><tbody>`;

            for (const row of tokenRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    <td style="padding:3px 4px; color:#e0e0e0;">${row.desc}</td>
                    <td style="${tdStyle} color:#ccc;">${row.tokenCost || '\u2014'}</td>
                    <td style="${tdStyle} color:#ccc;">${row.clearRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    <td style="${tdStyle} color:#888;">${row.tokensPerPctStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            return html;
        };

        const renderGoldTable = () => {
            const s = sortState.gold;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="gold" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Equipment Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Cost', 'cost', 'right')}
                ${th('Clear Rate', 'clearRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${th('Gold/1%', 'goldPerPct', 'right')}
            </tr></thead><tbody>`;

            for (const row of goldRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    <td style="padding:3px 4px; color:#e0e0e0;">${row.desc}</td>
                    <td style="${tdStyle} color:#ccc;">${row.costStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.clearRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    <td style="${tdStyle} color:#888;">${row.goldPerPctStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            return html;
        };

        const renderAll = () => {
            sortRows(tokenRows, sortState.token.key, sortState.token.dir);
            sortRows(goldRows, sortState.gold.key, sortState.gold.dir);
            let html = `<div style="color:#888; font-size:11px; margin-bottom:8px;">
                Baseline Avg Clear: <span style="color:#e0e0e0; font-weight:600;">${((baseline?.clearRate || 0) * 100).toFixed(1)}%</span>
            </div>`;
            if (tokenRows.length > 0) html += renderTokenTable();
            if (goldRows.length > 0) html += renderGoldTable();
            container.innerHTML = html;
        };

        renderAll();

        // The container persists across Analyze runs — replace the previous
        // sort handler instead of stacking a new one each analysis
        if (this._skillingSortHandler) {
            container.removeEventListener('click', this._skillingSortHandler);
        }
        this._skillingSortHandler = (e) => {
            const th = e.target.closest('th[data-sort-key]');
            if (!th) return;
            const table = th.dataset.table;
            const key = th.dataset.sortKey;
            const state = sortState[table];
            if (state.key === key) {
                state.dir = state.dir === 'desc' ? 'asc' : 'desc';
            } else {
                state.key = key;
                state.dir = key === 'desc' ? 'asc' : 'desc';
            }
            renderAll();
        };
        container.addEventListener('click', this._skillingSortHandler);

        this._setStatus(`${results.length} skilling upgrade candidates analyzed.`);
    }

    toggle() {
        if (!this.panel) return;
        const visible = this.panel.style.display !== 'none';
        this.panel.style.display = visible ? 'none' : 'flex';
        if (!visible) {
            bringPanelToFront(this.panel);
            this._populateMonsters();
            if (!this._editor.isInitialized()) {
                this._editor.initEditor();
            }
        }
    }

    /**
     * Open the panel preconfigured from a labyrinth tile: combat tiles select
     * the monster (applying its assigned labyrinth loadout) at the tile's room
     * level; skilling tiles open the Skilling tab with the room level set and
     * the skill's loadout row filtered.
     * @param {Object} detail - { monsterHrid?, skillHrid?, roomLevel? }
     */
    async openPreconfigured(detail = {}) {
        if (!this.panel) return;
        if (this.panel.style.display === 'none') {
            this.toggle();
        } else {
            bringPanelToFront(this.panel);
        }

        const roomLevel = Math.round(Number(detail.roomLevel) || 0);

        if (detail.monsterHrid) {
            this._switchTab('configure');
            const select = this.panel.querySelector('#mwi-labsim-monster');
            if (select) select.value = detail.monsterHrid;
            if (roomLevel > 0) {
                const levelInput = this.panel.querySelector('#mwi-labsim-level');
                if (levelInput) levelInput.value = roomLevel;
            }
            // Applying the assigned loadout needs the editor loaded
            await this._whenEditorReady();
            this._onMonsterChange(detail.monsterHrid);
        } else if (detail.skillHrid) {
            this._switchTab('skilling');
            if (roomLevel > 0) {
                const useSkip = this.panel.querySelector('#mwi-labsim-skilling-useskip');
                const levelInput = this.panel.querySelector('#mwi-labsim-skilling-level');
                if (useSkip) useSkip.checked = false;
                if (levelInput) {
                    levelInput.disabled = false;
                    levelInput.value = roomLevel;
                }
            }
            const filter = this.panel.querySelector('#mwi-labsim-skilling-filter');
            if (filter && [...filter.options].some((o) => o.value === detail.skillHrid)) {
                filter.value = detail.skillHrid;
                filter.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    }

    /**
     * Wait (up to ~10s) for the configure editor to finish initializing.
     * @private
     * @returns {Promise<boolean>} True when the editor is ready
     */
    async _whenEditorReady() {
        for (let i = 0; i < 40; i++) {
            if (this._editor?.isInitialized()) return true;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return this._editor?.isInitialized() || false;
    }

    destroy() {
        if (this._openRequestHandler) {
            document.removeEventListener('mwi-labsim-open', this._openRequestHandler);
            this._openRequestHandler = null;
        }
        if (this.elapsedTimer) {
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
        }
        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
        }
        this.isRunning = false;
        if (this._editor) this._editor.reset();
        if (this._skillingEditor) this._skillingEditor.reset();
        this._maxLevel = null;
        this._labyResults = null;
    }

    /** @private */
    _setupDrag(handle) {
        handle.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            this.isDragging = true;
            handle.style.cursor = 'grabbing';
            const rect = this.panel.getBoundingClientRect();
            this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };

            const onMove = (e2) => {
                if (!this.isDragging) return;
                this.panel.style.left = `${e2.clientX - this.dragOffset.x}px`;
                this.panel.style.top = `${e2.clientY - this.dragOffset.y}px`;
                this.panel.style.right = 'auto';
            };

            const onUp = () => {
                this.isDragging = false;
                handle.style.cursor = 'grab';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    /** @private */
    _setupResize(handle) {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = this.panel.offsetWidth;
            const startHeight = this.panel.offsetHeight;
            bringPanelToFront(this.panel);

            const onMove = (ev) => {
                const newWidth = Math.max(400, startWidth + (ev.clientX - startX));
                const newHeight = Math.max(300, startHeight + (ev.clientY - startY));
                this.panel.style.width = `${newWidth}px`;
                this.panel.style.height = `${newHeight}px`;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }
}

const labSimUI = new LabSimUI();
export default labSimUI;
