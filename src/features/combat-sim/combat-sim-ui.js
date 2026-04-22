/**
 * Combat Simulator UI
 * Floating panel for configuring and running combat simulations.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import {
    buildGameDataPayload,
    buildAllPlayerDTOs,
    getCombatZones,
    getCurrentCombatZone,
    getCommunityBuffs,
    calculateExpectedDrops,
} from './combat-sim-adapter.js';
import { runSimulation } from './combat-sim-runner.js';

const PANEL_ID = 'mwi-combat-sim-panel';
const ACCENT = '#4a9eff';
const ACCENT_BORDER = 'rgba(74, 158, 255, 0.5)';
const ACCENT_BG = 'rgba(74, 158, 255, 0.12)';
const ACCENT_BTN_BG = 'rgba(74, 158, 255, 0.2)';
const ACCENT_BTN_BORDER = 'rgba(74, 158, 255, 0.4)';

class CombatSimUI {
    constructor() {
        this.panel = null;
        this.isRunning = false;
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        this.elapsedTimer = null;
        this._activePlayerTab = 'player1';
        this._playerInfo = [];
        this._lastSimResult = null;
        this._lastSimHours = null;
        this._lastGameData = null;
        this._previousSimResult = null;
        this._previousSimHours = null;
        this._previousNetProfitPerHr = null;
        this._previousRevenuePerHr = null;
        this._previousExpensesPerHr = null;
        this._lastNetProfitPerHr = null;
        this._lastRevenuePerHr = null;
        this._lastExpensesPerHr = null;
        // Loadout editor state
        this._editedDTOs = null;
        this._editedPlayerInfo = null;
        this._originalDTOs = null;
        this._activeMainTab = 'configure';
        this._activeEditPlayer = null;
        this._selfHrid = null;
        this._missingMembers = [];
        this._editorInitialized = false;
    }

    /**
     * Build and append the floating panel to the document body.
     */
    buildPanel() {
        if (this.panel) return;

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
            width: 500px;
            max-height: 600px;
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
            <span style="font-weight:700; font-size:14px; color:${ACCENT};">Combat Simulator</span>
            <button id="mwi-csim-close" style="
                background:none; border:none; color:#aaa; font-size:22px;
                cursor:pointer; padding:0; line-height:1;">×</button>
        `;
        this._setupDrag(header);

        // Tab bar (Configure | Results)
        const tabBar = document.createElement('div');
        tabBar.id = 'mwi-csim-tabbar';
        tabBar.style.cssText = `
            display: flex;
            gap: 0;
            padding: 0;
            flex-shrink: 0;
            border-bottom: 1px solid #222;
        `;
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
            <button id="mwi-csim-tab-configure" style="${tabStyle(true)}">Configure</button>
            <button id="mwi-csim-tab-results" style="${tabStyle(false)}">Results</button>
        `;

        // Configure tab content
        const configureContent = document.createElement('div');
        configureContent.id = 'mwi-csim-configure-content';
        configureContent.style.cssText = 'display:flex; flex-direction:column; flex:1; overflow:hidden;';

        // Controls (zone, tier, hours, simulate)
        const controls = document.createElement('div');
        controls.style.cssText = `
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            padding: 10px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
        `;

        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; flex:1; min-width:0;';
        const inputStyle =
            'width:60px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; text-align:center;';

        controls.innerHTML = `
            <label style="color:#888; font-size:12px;">Zone</label>
            <select id="mwi-csim-zone" style="${selectStyle}"></select>
            <label style="color:#888; font-size:12px;">Tier</label>
            <select id="mwi-csim-tier" style="${selectStyle} flex:0; width:64px; min-width:64px;">
                ${Array.from({ length: 11 }, (_, i) => `<option value="${i}">${i}</option>`).join('')}
            </select>
            <label style="color:#888; font-size:12px;">Hours</label>
            <input id="mwi-csim-hours" type="number" min="1" max="10000" value="100" style="${inputStyle}">
            <button id="mwi-csim-run" style="
                margin-left: auto;
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;">Simulate</button>
        `;

        // Loadout editor area (scrollable)
        const editorArea = document.createElement('div');
        editorArea.id = 'mwi-csim-editor';
        editorArea.style.cssText = 'flex:1; overflow-y:auto; padding:10px 14px;';
        editorArea.innerHTML = `<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">Loading loadout...</div>`;

        configureContent.appendChild(controls);
        configureContent.appendChild(editorArea);

        // Results tab content (hidden by default)
        const resultsContent = document.createElement('div');
        resultsContent.id = 'mwi-csim-results-content';
        resultsContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow:hidden;';

        // Progress bar container (hidden by default)
        const progressContainer = document.createElement('div');
        progressContainer.id = 'mwi-csim-progress-container';
        progressContainer.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        progressContainer.innerHTML = `
            <div style="
                background:#1a1a2e;
                border-radius:4px;
                height:18px;
                overflow:hidden;
                position:relative;
                border:1px solid #333;">
                <div id="mwi-csim-progress-fill" style="
                    height:100%;
                    width:0%;
                    background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT});
                    border-radius:3px;
                    transition:width 0.2s ease;"></div>
                <span id="mwi-csim-progress-text" style="
                    position:absolute;
                    top:0; left:0; right:0;
                    text-align:center;
                    font-size:11px;
                    line-height:18px;
                    color:#e0e0e0;
                    font-weight:600;">0%</span>
            </div>
        `;

        // Results container
        const resultsContainer = document.createElement('div');
        resultsContainer.id = 'mwi-csim-results';
        resultsContainer.style.cssText = 'display:none; overflow-y:auto; flex:1; padding:10px 14px;';

        resultsContent.appendChild(progressContainer);
        resultsContent.appendChild(resultsContainer);

        // Status bar
        const status = document.createElement('div');
        status.id = 'mwi-csim-status';
        status.style.cssText =
            'padding:6px 14px; color:#555; font-size:11px; border-top:1px solid #1a1a1a; flex-shrink:0; text-align:center;';
        status.textContent = 'Select a zone and click Simulate.';

        this.panel.appendChild(header);
        this.panel.appendChild(tabBar);
        this.panel.appendChild(configureContent);
        this.panel.appendChild(resultsContent);
        this.panel.appendChild(status);
        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);

        // Event listeners
        this.panel.querySelector('#mwi-csim-close').addEventListener('click', () => {
            this.panel.style.display = 'none';
        });
        this.panel.querySelector('#mwi-csim-run').addEventListener('click', () => this._onSimulate());
        this.panel.addEventListener('mousedown', () => bringPanelToFront(this.panel));

        // Tab switching
        this.panel
            .querySelector('#mwi-csim-tab-configure')
            .addEventListener('click', () => this._switchTab('configure'));
        this.panel.querySelector('#mwi-csim-tab-results').addEventListener('click', () => this._switchTab('results'));

        this.populateZones();
    }

    /**
     * Fill the zone dropdown from getCombatZones() and select the current zone.
     */
    populateZones() {
        const zoneSelect = this.panel?.querySelector('#mwi-csim-zone');
        if (!zoneSelect) return;

        const zones = getCombatZones();
        zoneSelect.innerHTML = '';

        for (const zone of zones) {
            const option = document.createElement('option');
            option.value = zone.hrid;
            option.textContent = zone.isDungeon ? `[D] ${zone.name}` : zone.name;
            zoneSelect.appendChild(option);
        }

        // Select current zone and tier if available
        const current = getCurrentCombatZone();
        if (current) {
            zoneSelect.value = current.zoneHrid;
            const tierSelect = this.panel.querySelector('#mwi-csim-tier');
            if (tierSelect) {
                tierSelect.value = String(current.difficultyTier);
            }
        }
    }

    /**
     * Switch between Configure and Results tabs.
     * @param {string} tab - 'configure' or 'results'
     * @private
     */
    _switchTab(tab) {
        this._activeMainTab = tab;
        const configureContent = this.panel.querySelector('#mwi-csim-configure-content');
        const resultsContent = this.panel.querySelector('#mwi-csim-results-content');
        const tabConfigure = this.panel.querySelector('#mwi-csim-tab-configure');
        const tabResults = this.panel.querySelector('#mwi-csim-tab-results');

        const activeStyle = `flex:1; padding:7px 0; text-align:center; font-size:12px; font-weight:600; cursor:pointer; border:none; font-family:inherit; transition:all 0.1s; background:${ACCENT_BG}; color:${ACCENT}; border-bottom:2px solid ${ACCENT};`;
        const inactiveStyle =
            'flex:1; padding:7px 0; text-align:center; font-size:12px; font-weight:600; cursor:pointer; border:none; font-family:inherit; transition:all 0.1s; background:transparent; color:#888; border-bottom:2px solid transparent;';

        if (tab === 'configure') {
            configureContent.style.display = 'flex';
            resultsContent.style.display = 'none';
            tabConfigure.style.cssText = activeStyle;
            tabResults.style.cssText = inactiveStyle;
        } else {
            configureContent.style.display = 'none';
            resultsContent.style.display = 'flex';
            tabConfigure.style.cssText = inactiveStyle;
            tabResults.style.cssText = activeStyle;
        }
    }

    /**
     * Initialize the loadout editor by loading DTOs from live data.
     * @private
     */
    async _initEditor() {
        const editorArea = this.panel?.querySelector('#mwi-csim-editor');
        if (!editorArea) return;

        try {
            const { players, playerInfo, selfHrid, missingMembers } = await buildAllPlayerDTOs();
            if (!players.length) {
                editorArea.innerHTML =
                    '<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">No character data available.</div>';
                return;
            }

            // Build DTO map keyed by hrid
            const dtoMap = {};
            for (const p of players) {
                dtoMap[p.hrid] = p;
            }

            this._originalDTOs = structuredClone(dtoMap);
            this._editedDTOs = structuredClone(dtoMap);
            this._editedPlayerInfo = playerInfo;
            this._selfHrid = selfHrid;
            this._activeEditPlayer = selfHrid;
            this._missingMembers = missingMembers;
            this._editorInitialized = true;

            this._renderEditor();
        } catch (error) {
            console.error('[CombatSimUI] Failed to init editor:', error);
            editorArea.innerHTML =
                '<div style="color:#f66; font-size:12px; text-align:center; padding:20px 0;">Failed to load character data.</div>';
        }
    }

    /**
     * Render the loadout editor for the active player.
     * @private
     */
    _renderEditor() {
        const editorArea = this.panel?.querySelector('#mwi-csim-editor');
        if (!editorArea || !this._editedDTOs) return;

        const playerInfo = this._editedPlayerInfo || [];
        const activePlayer = this._activeEditPlayer;
        const dto = this._editedDTOs[activePlayer];
        if (!dto) return;

        const gameData = buildGameDataPayload();
        if (!gameData) return;

        let html = '';

        // Player tabs (party mode)
        if (playerInfo.length > 1) {
            html += `<div style="display:flex; gap:4px; margin-bottom:10px; flex-wrap:wrap;">`;
            for (const { hrid, name } of playerInfo) {
                const isActive = hrid === activePlayer;
                const tabStyle = isActive
                    ? `background:${ACCENT_BG}; border:1px solid ${ACCENT_BORDER}; color:${ACCENT}; font-weight:700;`
                    : 'background:rgba(255,255,255,0.04); border:1px solid #333; color:#aaa;';
                html += `<button data-edit-tab="${hrid}" style="
                    ${tabStyle}
                    padding:3px 10px; border-radius:5px; font-size:12px; cursor:pointer;
                    font-family:inherit; transition:all 0.1s;
                ">${name}</button>`;
            }
            html += '</div>';
        }

        // Reset button
        html += `<div style="display:flex; justify-content:flex-end; margin-bottom:8px;">`;
        html += `<button id="mwi-csim-reset" style="
            background:rgba(255,255,255,0.04); border:1px solid #333; color:#aaa;
            padding:2px 8px; border-radius:4px; font-size:11px; cursor:pointer;
            font-family:inherit;">Reset to Current</button>`;
        html += '</div>';

        // Equipment section
        html += this._renderEquipmentSection(dto, gameData);

        // Abilities section
        html += this._renderAbilitiesSection(dto, gameData);

        // Skill levels section
        html += this._renderSkillLevelsSection(dto);

        editorArea.innerHTML = html;

        // Wire event listeners
        this._wireEditorEvents(editorArea, dto);
    }

    /**
     * Render equipment section with enhancement level inputs.
     * @private
     */
    _renderEquipmentSection(dto, gameData) {
        const itemDetailMap = gameData.itemDetailMap || {};
        const slotOrder = [
            '/equipment_types/head',
            '/equipment_types/body',
            '/equipment_types/legs',
            '/equipment_types/feet',
            '/equipment_types/hands',
            '/equipment_types/main_hand',
            '/equipment_types/two_hand',
            '/equipment_types/off_hand',
            '/equipment_types/pouch',
            '/equipment_types/back',
            '/equipment_types/neck',
            '/equipment_types/earrings',
            '/equipment_types/ring',
            '/equipment_types/charm',
        ];
        const slotLabels = {
            '/equipment_types/head': 'Head',
            '/equipment_types/body': 'Body',
            '/equipment_types/legs': 'Legs',
            '/equipment_types/feet': 'Feet',
            '/equipment_types/hands': 'Hands',
            '/equipment_types/main_hand': 'Main Hand',
            '/equipment_types/two_hand': 'Two Hand',
            '/equipment_types/off_hand': 'Off Hand',
            '/equipment_types/pouch': 'Pouch',
            '/equipment_types/back': 'Back',
            '/equipment_types/neck': 'Neck',
            '/equipment_types/earrings': 'Earrings',
            '/equipment_types/ring': 'Ring',
            '/equipment_types/charm': 'Charm',
        };

        const equippedCount = slotOrder.filter((s) => dto.equipment[s]).length;
        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="equip-section">`;
        html += `<span data-arrow="equip-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Equipment (${equippedCount} items)`;
        html += '</div>';
        html += `<div id="mwi-csim-equip-section" style="display:none;">`;

        for (const slotType of slotOrder) {
            const equip = dto.equipment[slotType];
            if (!equip) continue;

            const item = itemDetailMap[equip.hrid];
            const name = item?.name || equip.hrid.split('/').pop();
            const label = slotLabels[slotType] || slotType.split('/').pop();

            html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:12px;">`;
            html += `<span style="color:#888; width:70px; flex-shrink:0;">${label}</span>`;
            html += `<span style="color:#e0e0e0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
            html += `<span style="color:#666; font-size:11px;">+</span>`;
            html += `<input type="number" min="0" max="20" value="${equip.enhancementLevel}"
                data-enhance-slot="${slotType}"
                style="width:36px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:3px; padding:1px 3px; font-size:12px; text-align:center;">`;
            html += '</div>';
        }

        html += '</div></div>';
        return html;
    }

    /**
     * Render abilities section with level inputs.
     * @private
     */
    _renderAbilitiesSection(dto, gameData) {
        const abilityDetailMap = gameData.abilityDetailMap || {};
        const abilityCount = dto.abilities.filter((a) => a).length;

        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="ability-section">`;
        html += `<span data-arrow="ability-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Abilities (${abilityCount} equipped)`;
        html += '</div>';
        html += `<div id="mwi-csim-ability-section" style="display:none;">`;

        for (let i = 0; i < dto.abilities.length; i++) {
            const ability = dto.abilities[i];
            if (!ability) continue;

            const detail = abilityDetailMap[ability.hrid];
            const name = detail?.name || ability.hrid.split('/').pop();
            const slotLabel = i === 0 ? 'Special' : `Slot ${i}`;

            html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:12px;">`;
            html += `<span style="color:#888; width:50px; flex-shrink:0;">${slotLabel}</span>`;
            html += `<span style="color:#e0e0e0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
            html += `<span style="color:#666; font-size:11px;">Lv</span>`;
            html += `<input type="number" min="1" max="200" value="${ability.level}"
                data-ability-idx="${i}"
                style="width:42px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:3px; padding:1px 3px; font-size:12px; text-align:center;">`;
            html += '</div>';
        }

        html += '</div></div>';
        return html;
    }

    /**
     * Render skill levels section.
     * @private
     */
    _renderSkillLevelsSection(dto) {
        const skills = [
            { key: 'staminaLevel', label: 'Stamina' },
            { key: 'intelligenceLevel', label: 'Intelligence' },
            { key: 'attackLevel', label: 'Attack' },
            { key: 'meleeLevel', label: 'Melee' },
            { key: 'defenseLevel', label: 'Defense' },
            { key: 'rangedLevel', label: 'Ranged' },
            { key: 'magicLevel', label: 'Magic' },
        ];

        const summary = skills.map((s) => `${s.label.slice(0, 3)} ${dto[s.key]}`).join(' / ');

        let html = `<div style="margin-bottom:10px;">`;
        html += `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; cursor:pointer; user-select:none;" data-toggle="skill-section">`;
        html += `<span data-arrow="skill-section" style="display:inline-block; width:14px; font-size:10px;">&#9654;</span> Skill Levels`;
        html += `<span style="color:#888; font-weight:400; font-size:11px; margin-left:6px;">${summary}</span>`;
        html += '</div>';
        html += `<div id="mwi-csim-skill-section" style="display:none;">`;
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 12px;">`;

        for (const skill of skills) {
            html += `<div style="display:flex; align-items:center; gap:6px; font-size:12px;">`;
            html += `<span style="color:#888; width:70px;">${skill.label}</span>`;
            html += `<input type="number" min="1" max="200" value="${dto[skill.key]}"
                data-skill="${skill.key}"
                style="width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:3px; padding:1px 3px; font-size:12px; text-align:center;">`;
            html += '</div>';
        }

        html += '</div></div></div>';
        return html;
    }

    /**
     * Wire event listeners for the editor area.
     * @private
     */
    _wireEditorEvents(editorArea, dto) {
        // Collapsible section toggles
        editorArea.querySelectorAll('[data-toggle]').forEach((el) => {
            el.addEventListener('click', () => {
                const sectionId = el.dataset.toggle;
                const section = editorArea.querySelector(`#mwi-csim-${sectionId}`);
                const arrow = editorArea.querySelector(`[data-arrow="${sectionId}"]`);
                if (section) {
                    const isOpen = section.style.display !== 'none';
                    section.style.display = isOpen ? 'none' : 'block';
                    if (arrow) arrow.innerHTML = isOpen ? '&#9654;' : '&#9660;';
                }
            });
        });

        // Enhancement level inputs
        editorArea.querySelectorAll('[data-enhance-slot]').forEach((input) => {
            input.addEventListener('change', () => {
                const slotType = input.dataset.enhanceSlot;
                const val = Math.min(20, Math.max(0, parseInt(input.value) || 0));
                input.value = val;
                if (dto.equipment[slotType]) {
                    dto.equipment[slotType].enhancementLevel = val;
                }
            });
        });

        // Ability level inputs
        editorArea.querySelectorAll('[data-ability-idx]').forEach((input) => {
            input.addEventListener('change', () => {
                const idx = parseInt(input.dataset.abilityIdx);
                const val = Math.max(1, parseInt(input.value) || 1);
                input.value = val;
                if (dto.abilities[idx]) {
                    dto.abilities[idx].level = val;
                }
            });
        });

        // Skill level inputs
        editorArea.querySelectorAll('[data-skill]').forEach((input) => {
            input.addEventListener('change', () => {
                const key = input.dataset.skill;
                const val = Math.max(1, parseInt(input.value) || 1);
                input.value = val;
                dto[key] = val;
            });
        });

        // Reset button
        const resetBtn = editorArea.querySelector('#mwi-csim-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this._editedDTOs = structuredClone(this._originalDTOs);
                this._renderEditor();
            });
        }

        // Player edit tabs
        editorArea.querySelectorAll('[data-edit-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._activeEditPlayer = btn.dataset.editTab;
                this._renderEditor();
            });
        });
    }

    /**
     * Handle the Simulate button click.
     * @private
     */
    async _onSimulate() {
        if (this.isRunning) return;

        const zoneHrid = this.panel.querySelector('#mwi-csim-zone')?.value;
        const difficultyTier = parseInt(this.panel.querySelector('#mwi-csim-tier')?.value) || 0;
        const hours = Math.min(10000, Math.max(1, parseInt(this.panel.querySelector('#mwi-csim-hours')?.value) || 100));

        if (!zoneHrid) {
            this._setStatus('No zone selected.');
            return;
        }

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        // Use edited DTOs if available, otherwise auto-fill
        let playerDTOs;
        let playerInfo;
        let selfHrid;
        let missingMembers;

        if (this._editedDTOs) {
            playerDTOs = Object.values(this._editedDTOs);
            playerInfo = this._editedPlayerInfo || [];
            selfHrid = this._selfHrid || playerDTOs[0]?.hrid || 'player1';
            missingMembers = this._missingMembers || [];
        } else {
            const result = await buildAllPlayerDTOs();
            playerDTOs = result.players;
            playerInfo = result.playerInfo;
            selfHrid = result.selfHrid;
            missingMembers = result.missingMembers;
        }

        if (!playerDTOs.length) {
            this._setStatus('No character data available.');
            return;
        }

        this._playerInfo = playerInfo;
        this._activePlayerTab = selfHrid;

        const communityBuffs = getCommunityBuffs();

        // Show party info
        const partyInfo =
            playerDTOs.length > 1
                ? `Party (${playerDTOs.length} loaded${missingMembers.length ? ', ' + missingMembers.length + ' missing' : ''})`
                : 'Solo';

        // Disable button, show progress
        this.isRunning = true;
        const runBtn = this.panel.querySelector('#mwi-csim-run');
        runBtn.disabled = true;
        runBtn.style.opacity = '0.5';
        runBtn.style.cursor = 'not-allowed';

        const progressContainer = this.panel.querySelector('#mwi-csim-progress-container');
        const progressFill = this.panel.querySelector('#mwi-csim-progress-fill');
        const progressText = this.panel.querySelector('#mwi-csim-progress-text');
        const resultsContainer = this.panel.querySelector('#mwi-csim-results');

        progressContainer.style.display = 'block';
        progressFill.style.width = '0%';
        progressText.textContent = '0%';
        resultsContainer.style.display = 'none';

        // Switch to results tab to show progress
        this._switchTab('results');

        const simStartTime = Date.now();
        this.elapsedTimer = setInterval(() => {
            const elapsed = ((Date.now() - simStartTime) / 1000).toFixed(1);
            this._setStatus(`Simulating (${partyInfo})... ${elapsed}s`);
        }, 100);

        try {
            const simResult = await runSimulation(
                { gameData, playerDTOs, zoneHrid, difficultyTier, hours, communityBuffs },
                (percent) => {
                    progressFill.style.width = `${percent}%`;
                    progressText.textContent = `${percent}%`;
                }
            );

            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
            const totalElapsed = ((Date.now() - simStartTime) / 1000).toFixed(1);

            // Save previous result for comparison deltas
            this._previousSimResult = this._lastSimResult;
            this._previousSimHours = this._lastSimHours;
            this._previousNetProfitPerHr = this._lastNetProfitPerHr ?? null;
            this._previousRevenuePerHr = this._lastRevenuePerHr ?? null;
            this._previousExpensesPerHr = this._lastExpensesPerHr ?? null;
            this._lastSimResult = simResult;
            this._lastSimHours = hours;
            this._lastGameData = gameData;
            this._displayResults(simResult, hours, gameData);
            this._switchTab('results');
            const modeLabels = {
                conservative: 'Buy: Ask / Sell: Bid',
                hybrid: 'Buy: Ask / Sell: Ask',
                optimistic: 'Buy: Bid / Sell: Ask',
                patientBuy: 'Buy: Bid / Sell: Bid',
            };
            const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
            const modeLabel = modeLabels[mode] || mode;
            const missingNote = missingMembers.length
                ? ` | Missing: ${missingMembers.join(', ')} (open their profiles)`
                : '';
            this._setStatus(
                `Simulation complete in ${totalElapsed}s: ${formatWithSeparator(hours)} hours · ${partyInfo} · Pricing: ${modeLabel}${missingNote}`
            );
        } catch (error) {
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
            console.error('[CombatSimUI] Simulation failed:', error);
            this._setStatus(`Simulation error: ${error.message || 'Unknown error'}`);
        } finally {
            this.isRunning = false;
            runBtn.disabled = false;
            runBtn.style.opacity = '1';
            runBtn.style.cursor = 'pointer';
            progressContainer.style.display = 'none';
        }
    }

    /**
     * Format and display simulation results.
     * @param {Object} simResult - SimResult from the combat simulator engine
     * @param {number} hours - Number of hours simulated
     * @param {Object} gameData - Game data maps for drop calculation
     * @private
     */
    _displayResults(simResult, hours, gameData) {
        const container = this.panel.querySelector('#mwi-csim-results');
        if (!container) return;

        const activeTab = this._activePlayerTab;
        const playerInfo = this._playerInfo;
        const numberOfPlayers = simResult.numberOfPlayers || 1;

        const sectionStyle = 'margin-bottom:12px;';
        const headingStyle = `color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; border-bottom:1px solid #222; padding-bottom:4px;`;
        const rowStyle = 'display:flex; justify-content:space-between; padding:2px 0; font-size:12px;';
        const labelStyle = 'color:#aaa;';
        const valueStyle = 'color:#e0e0e0; font-weight:600;';

        let html = '';

        // Player tabs (only shown for party sims)
        if (numberOfPlayers > 1) {
            html += `<div style="display:flex; gap:4px; margin-bottom:10px; flex-wrap:wrap;">`;
            for (const { hrid, name } of playerInfo) {
                const isActive = hrid === activeTab;
                const tabStyle = isActive
                    ? `background:${ACCENT_BG}; border:1px solid ${ACCENT_BORDER}; color:${ACCENT}; font-weight:700;`
                    : 'background:rgba(255,255,255,0.04); border:1px solid #333; color:#aaa;';
                html += `<button data-tab="${hrid}" style="
                    ${tabStyle}
                    padding:3px 10px; border-radius:5px; font-size:12px; cursor:pointer;
                    font-family:inherit; transition:all 0.1s;
                ">${name}</button>`;
            }
            html += '</div>';
        }

        // Compute previous values for delta comparison
        const prev = this._previousSimResult;
        const prevHours = this._previousSimHours;
        const hasPrev = prev && prevHours;
        const prevEncPerHr = hasPrev ? prev.encounters / prevHours : null;
        const prevDeathsPerHr = hasPrev ? (prev.deaths?.[activeTab] || 0) / prevHours : null;

        // Overview: encounters/hr (party-wide) + deaths/hr (per active player)
        const encountersPerHr = simResult.encounters / hours;
        const playerDeaths = simResult.deaths?.[activeTab] || 0;
        const deathsPerHr = playerDeaths / hours;

        html += `<div style="${sectionStyle}">`;
        html += `<div style="${headingStyle}">Overview</div>`;
        html += `<div style="${rowStyle}">`;
        html += `<span style="${labelStyle}">Encounters/hr</span>`;
        html += `<span style="${valueStyle}">${formatWithSeparator(Math.round(encountersPerHr))}${this._formatDelta(encountersPerHr, prevEncPerHr)}</span>`;
        html += '</div>';
        html += `<div style="${rowStyle}">`;
        html += `<span style="${labelStyle}">Deaths/hr</span>`;
        html += `<span style="${valueStyle}">${this._formatDeaths(deathsPerHr)}${this._formatDelta(deathsPerHr, prevDeathsPerHr, false)}</span>`;
        html += '</div>';

        // DPS — estimated from monster kills × max HP / time
        if (gameData) {
            const monsterDetailMap = gameData.combatMonsterDetailMap || {};
            let totalDamage = 0;
            let prevTotalDamage = 0;
            for (const [hrid, count] of Object.entries(simResult.deaths)) {
                if (hrid.startsWith('player')) continue;
                const monster = monsterDetailMap[hrid];
                if (monster?.combatDetails?.maxHitpoints) {
                    totalDamage += count * monster.combatDetails.maxHitpoints;
                }
            }
            const dps = totalDamage / (hours * 3600);
            let prevDps = null;
            if (hasPrev) {
                for (const [hrid, count] of Object.entries(prev.deaths)) {
                    if (hrid.startsWith('player')) continue;
                    const monster = monsterDetailMap[hrid];
                    if (monster?.combatDetails?.maxHitpoints) {
                        prevTotalDamage += count * monster.combatDetails.maxHitpoints;
                    }
                }
                prevDps = prevTotalDamage / (prevHours * 3600);
            }
            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">Party DPS (est.)</span>`;
            html += `<span style="${valueStyle}">${formatWithSeparator(Math.round(dps))}${this._formatDelta(dps, prevDps)}</span>`;
            html += '</div>';
        }

        // Dungeon stats if applicable
        if (simResult.isDungeon) {
            const completedPerHr = simResult.dungeonsCompleted / hours;
            const failedPerHr = simResult.dungeonsFailed / hours;
            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">Dungeons completed/hr</span>`;
            html += `<span style="${valueStyle}">${this._formatRate(completedPerHr)}</span>`;
            html += '</div>';
            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">Dungeons failed/hr</span>`;
            html += `<span style="${valueStyle}">${this._formatRate(failedPerHr)}</span>`;
            html += '</div>';
            html += `<div style="${rowStyle}">`;
            html += `<span style="${labelStyle}">Max wave reached</span>`;
            html += `<span style="${valueStyle}">${simResult.maxWaveReached}</span>`;
            html += '</div>';
        }
        html += '</div>';

        // XP/hr by skill — per active tab player
        const xpTotals = {};
        if (simResult.experienceGained[activeTab]) {
            for (const [skill, amount] of Object.entries(simResult.experienceGained[activeTab])) {
                xpTotals[skill] = (xpTotals[skill] || 0) + amount;
            }
        }

        // Build previous XP map for delta comparison
        const prevXpPerHr = {};
        if (hasPrev && prev.experienceGained?.[activeTab]) {
            for (const [skill, amount] of Object.entries(prev.experienceGained[activeTab])) {
                prevXpPerHr[skill] = Math.round(amount / prevHours);
            }
        }

        const xpEntries = Object.entries(xpTotals).filter(([, total]) => total > 0);
        if (xpEntries.length > 0) {
            html += `<div style="${sectionStyle}">`;
            html += `<div style="${headingStyle}">XP/hr</div>`;
            for (const [skill, total] of xpEntries) {
                const perHr = Math.round(total / hours);
                const prevVal = hasPrev ? prevXpPerHr[skill] || null : null;
                const skillLabel = skill.charAt(0).toUpperCase() + skill.slice(1);
                html += `<div style="${rowStyle}">`;
                html += `<span style="${labelStyle}">${skillLabel}</span>`;
                html += `<span style="${valueStyle}">${formatWithSeparator(perHr)}${this._formatDelta(perHr, prevVal)}</span>`;
                html += '</div>';
            }
            // Total XP/hr row
            const totalXpPerHr = xpEntries.reduce((sum, [, total]) => sum + Math.round(total / hours), 0);
            const prevTotalXpPerHr = hasPrev ? Object.values(prevXpPerHr).reduce((sum, v) => sum + v, 0) : null;
            html += `<div style="display:flex; justify-content:space-between; padding:4px 0 0; font-size:12px; border-top:1px solid #333; margin-top:4px;">`;
            html += `<span style="color:#aaa; font-weight:700;">Total</span>`;
            html += `<span style="${valueStyle}">${formatWithSeparator(totalXpPerHr)}${this._formatDelta(totalXpPerHr, prevTotalXpPerHr)}</span>`;
            html += '</div>';
            html += '</div>';
        }

        // Consumable costs — per active tab player
        const consumableTotals = {};
        const selfConsumables = simResult.consumablesUsed?.[activeTab] || {};
        for (const [itemHrid, count] of Object.entries(selfConsumables)) {
            consumableTotals[itemHrid] = (consumableTotals[itemHrid] || 0) + count;
        }

        // Track totals for net profit calculation
        let dropGoldPerHr = 0;
        let dropGoldTotal = 0;
        let consumableGoldPerHr = 0;
        let consumableGoldTotal = 0;

        // Drops — calculated from kill counts × drop tables × multipliers
        if (gameData) {
            const dropMap = calculateExpectedDrops(simResult, gameData, activeTab);

            // Pre-compute gold values for sorting
            const dropData = [...dropMap.entries()]
                .filter(([, total]) => total > 0)
                .map(([itemHrid, total]) => {
                    const price = marketAPI.getPrice(itemHrid);
                    // Revenue: use sell price based on pricing mode
                    let unitValue = this._getSellPrice(price);
                    if (unitValue === 0 && itemHrid === '/items/coin') {
                        unitValue = 1;
                    }
                    if (unitValue === 0) {
                        const evData = expectedValueCalculator.calculateExpectedValue(itemHrid);
                        if (evData?.expectedValue > 0) unitValue = evData.expectedValue;
                    }
                    return { itemHrid, total, unitValue, totalGold: total * unitValue };
                })
                .sort((a, b) => b.totalGold - a.totalGold); // Sort by gold value descending

            if (dropData.length > 0) {
                const dropRowStyle = 'display:flex; align-items:center; padding:2px 0; font-size:12px; gap:6px;';
                const colNum = 'flex:0; white-space:nowrap; min-width:48px; text-align:right;';
                const colGold = 'flex:0; white-space:nowrap; min-width:58px; text-align:right;';

                html += `<div style="${sectionStyle}">`;
                html += `<div style="${headingStyle}">Drops</div>`;
                // Column headers
                html += `<div style="display:flex; align-items:center; padding:0 0 4px; font-size:10px; gap:6px; color:#666;">`;
                html += `<span style="flex:1;">Item</span>`;
                html += `<span style="${colNum}">/hr</span>`;
                html += `<span style="${colNum}">/day</span>`;
                html += `<span style="${colGold}">Gold/hr</span>`;
                html += `<span style="${colGold}">Gold/day</span>`;
                html += `<span style="${colNum}">Total</span>`;
                html += `<span style="${colGold}">Total Gold</span>`;
                html += '</div>';

                for (const drop of dropData) {
                    const perHr = drop.total / hours;
                    const itemDetails = dataManager.getItemDetails(drop.itemHrid);
                    const name = itemDetails?.name || drop.itemHrid.split('/').pop();

                    const perHrStr = perHr >= 1 ? formatWithSeparator(Math.round(perHr)) : perHr.toFixed(2);
                    const perDay = perHr * 24;
                    const perDayStr = perDay >= 1 ? formatWithSeparator(Math.round(perDay)) : perDay.toFixed(2);
                    const totalStr =
                        drop.total >= 1 ? formatWithSeparator(Math.round(drop.total)) : drop.total.toFixed(2);

                    const goldPerHr = perHr * drop.unitValue;
                    dropGoldPerHr += goldPerHr;
                    dropGoldTotal += drop.totalGold;

                    const goldHrStr = drop.unitValue > 0 ? formatKMB(Math.round(goldPerHr)) : '—';
                    const goldDayStr = drop.unitValue > 0 ? formatKMB(Math.round(goldPerHr * 24)) : '—';
                    const goldTotalStr = drop.unitValue > 0 ? formatKMB(Math.round(drop.totalGold)) : '—';
                    const goldColor = drop.unitValue > 0 ? '#e8a87c' : '#444';

                    html += `<div style="${dropRowStyle}">`;
                    html += `<span style="${labelStyle} flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
                    html += `<span style="${valueStyle} ${colNum}">${perHrStr}</span>`;
                    html += `<span style="${valueStyle} ${colNum}">${perDayStr}</span>`;
                    html += `<span style="color:${goldColor}; font-weight:600; ${colGold}">${goldHrStr}</span>`;
                    html += `<span style="color:${goldColor}; font-weight:600; ${colGold}">${goldDayStr}</span>`;
                    html += `<span style="${valueStyle} ${colNum}">${totalStr}</span>`;
                    html += `<span style="color:${goldColor}; font-weight:600; ${colGold}">${goldTotalStr}</span>`;
                    html += '</div>';
                }
                // Totals row
                const prevRevPerHr = this._previousRevenuePerHr;
                const revDelta =
                    prevRevPerHr !== null && prevRevPerHr !== undefined
                        ? this._formatDelta(dropGoldPerHr, prevRevPerHr, true, true)
                        : '';
                html += `<div style="display:flex; align-items:center; padding:4px 0 0; font-size:12px; border-top:1px solid #333; margin-top:4px; gap:6px;">`;
                html += `<span style="color:#aaa; font-weight:700; flex:1;">Total Revenue</span>`;
                const revDayDelta =
                    prevRevPerHr !== null && prevRevPerHr !== undefined
                        ? this._formatDelta(dropGoldPerHr * 24, prevRevPerHr * 24, true, true)
                        : '';
                html += `<span style="${colNum}"></span>`;
                html += `<span style="${colNum}"></span>`;
                html += `<span style="color:#e8a87c; font-weight:700; ${colGold}">${formatKMB(Math.round(dropGoldPerHr))}${revDelta}</span>`;
                html += `<span style="color:#e8a87c; font-weight:700; ${colGold}">${formatKMB(Math.round(dropGoldPerHr * 24))}${revDayDelta}</span>`;
                html += `<span style="${colNum}"></span>`;
                html += `<span style="color:#e8a87c; font-weight:700; ${colGold}">${formatKMB(Math.round(dropGoldTotal))}</span>`;
                html += '</div>';
                html += '</div>';
            }
        }

        // Consumable costs — same column layout as drops
        const consumableEntries = Object.entries(consumableTotals)
            .map(([itemHrid, total]) => {
                const price = marketAPI.getPrice(itemHrid);
                const unitCost = this._getBuyPrice(price);
                return { itemHrid, total, unitCost, totalCost: total * unitCost };
            })
            .sort((a, b) => b.totalCost - a.totalCost);

        if (consumableEntries.length > 0) {
            const costRowStyle = 'display:flex; align-items:center; padding:2px 0; font-size:12px; gap:6px;';
            const colNum = 'flex:0; white-space:nowrap; min-width:48px; text-align:right;';
            const colGold = 'flex:0; white-space:nowrap; min-width:58px; text-align:right;';
            const costColor = '#ff6b6b';

            html += `<div style="${sectionStyle}">`;
            html += `<div style="${headingStyle}">Consumable Costs</div>`;
            // Column headers
            html += `<div style="display:flex; align-items:center; padding:0 0 4px; font-size:10px; gap:6px; color:#666;">`;
            html += `<span style="flex:1;">Item</span>`;
            html += `<span style="${colNum}">/hr</span>`;
            html += `<span style="${colNum}">/day</span>`;
            html += `<span style="${colGold}">Cost/hr</span>`;
            html += `<span style="${colGold}">Cost/day</span>`;
            html += `<span style="${colNum}">Total</span>`;
            html += `<span style="${colGold}">Total Cost</span>`;
            html += '</div>';

            for (const cons of consumableEntries) {
                const perHr = cons.total / hours;
                const itemDetails = dataManager.getItemDetails(cons.itemHrid);
                const name = itemDetails?.name || cons.itemHrid.split('/').pop();

                const perHrStr = formatWithSeparator(Math.round(perHr));
                const perDayStr = formatWithSeparator(Math.round(perHr * 24));
                const totalStr = formatWithSeparator(Math.round(cons.total));

                const costPerHr = perHr * cons.unitCost;
                consumableGoldPerHr += costPerHr;
                consumableGoldTotal += cons.totalCost;

                const costHrStr = cons.unitCost > 0 ? formatKMB(Math.round(costPerHr)) : '—';
                const costDayStr = cons.unitCost > 0 ? formatKMB(Math.round(costPerHr * 24)) : '—';
                const costTotalStr = cons.unitCost > 0 ? formatKMB(Math.round(cons.totalCost)) : '—';
                const cColor = cons.unitCost > 0 ? costColor : '#444';

                html += `<div style="${costRowStyle}">`;
                html += `<span style="${labelStyle} flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${perHrStr}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${perDayStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costHrStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costDayStr}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${totalStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costTotalStr}</span>`;
                html += '</div>';
            }
            // Totals row
            const prevExpPerHr = this._previousExpensesPerHr;
            const expDelta =
                prevExpPerHr !== null && prevExpPerHr !== undefined
                    ? this._formatDelta(consumableGoldPerHr, prevExpPerHr, false, true)
                    : '';
            const expDayDelta =
                prevExpPerHr !== null && prevExpPerHr !== undefined
                    ? this._formatDelta(consumableGoldPerHr * 24, prevExpPerHr * 24, false, true)
                    : '';
            html += `<div style="display:flex; align-items:center; padding:4px 0 0; font-size:12px; border-top:1px solid #333; margin-top:4px; gap:6px;">`;
            html += `<span style="color:#aaa; font-weight:700; flex:1;">Total Expenses</span>`;
            html += `<span style="${colNum}"></span>`;
            html += `<span style="${colNum}"></span>`;
            html += `<span style="color:${costColor}; font-weight:700; ${colGold}">${formatKMB(Math.round(consumableGoldPerHr))}${expDelta}</span>`;
            html += `<span style="color:${costColor}; font-weight:700; ${colGold}">${formatKMB(Math.round(consumableGoldPerHr * 24))}${expDayDelta}</span>`;
            html += `<span style="${colNum}"></span>`;
            html += `<span style="color:${costColor}; font-weight:700; ${colGold}">${formatKMB(Math.round(consumableGoldTotal))}</span>`;
            html += '</div>';
            html += '</div>';
        }

        // Net Profit
        const netProfitPerHr = dropGoldPerHr - consumableGoldPerHr;
        const netProfitTotal = dropGoldTotal - consumableGoldTotal;
        const profitColor = netProfitPerHr >= 0 ? '#7ec87e' : '#ff6b6b';
        const profitSign = netProfitPerHr >= 0 ? '' : '-';
        const totalProfitSign = netProfitTotal >= 0 ? '' : '-';

        // Store for future delta comparison
        this._lastNetProfitPerHr = netProfitPerHr;
        this._lastRevenuePerHr = dropGoldPerHr;
        this._lastExpensesPerHr = consumableGoldPerHr;

        // Compute delta from previous sim
        const prevProfit = this._previousNetProfitPerHr;
        const profitDelta =
            prevProfit !== null && prevProfit !== undefined
                ? this._formatDelta(netProfitPerHr, prevProfit, true, true)
                : '';

        const netProfitPerDay = netProfitPerHr * 24;
        const profitDaySign = netProfitPerDay >= 0 ? '' : '-';

        html += `<div style="${sectionStyle}">`;
        html += `<div style="${headingStyle}">Net Profit</div>`;
        const netColGold = 'flex:0; white-space:nowrap; min-width:58px; text-align:right;';
        const netColNum = 'flex:0; white-space:nowrap; min-width:48px; text-align:right;';
        // Column headers
        html += `<div style="display:flex; align-items:center; padding:0 0 4px; font-size:10px; gap:6px; color:#666;">`;
        html += `<span style="flex:1;"></span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="${netColGold}">/hr</span>`;
        html += `<span style="${netColGold}">/day</span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="${netColGold}">Total</span>`;
        html += '</div>';
        html += `<div style="display:flex; align-items:center; padding:2px 0; font-size:13px; gap:6px;">`;
        html += `<span style="color:#aaa; font-weight:700; flex:1;">Profit</span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="${netColNum}"></span>`;
        const profitDayDelta =
            prevProfit !== null && prevProfit !== undefined
                ? this._formatDelta(netProfitPerDay, prevProfit * 24, true, true)
                : '';
        html += `<span style="color:${profitColor}; font-weight:700; ${netColGold}">${profitSign}${formatKMB(Math.abs(Math.round(netProfitPerHr)))}${profitDelta}</span>`;
        html += `<span style="color:${profitColor}; font-weight:700; ${netColGold}">${profitDaySign}${formatKMB(Math.abs(Math.round(netProfitPerDay)))}${profitDayDelta}</span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="color:${profitColor}; font-weight:700; ${netColGold}">${totalProfitSign}${formatKMB(Math.abs(Math.round(netProfitTotal)))}</span>`;
        html += '</div>';
        html += '</div>';

        container.innerHTML = html;
        container.style.display = 'block';

        // Tab click handler — re-render with new active player
        container.querySelectorAll('[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._activePlayerTab = btn.dataset.tab;
                this._displayResults(this._lastSimResult, this._lastSimHours, this._lastGameData);
            });
        });
    }

    /**
     * Format a delta value as colored HTML span.
     * Returns empty string if no previous value or delta is zero.
     * @param {number} current - Current value
     * @param {number|null} previous - Previous value (null if no comparison)
     * @param {boolean} [higherIsBetter=true] - Whether higher values are positive
     * @param {boolean} [useKMB=false] - Use KMB formatting for the delta
     * @returns {string} HTML span or empty string
     * @private
     */
    _formatDelta(current, previous, higherIsBetter = true, useKMB = false) {
        if (previous === null || previous === undefined) return '';
        const delta = current - previous;
        if (Math.abs(delta) < 0.5) return '';
        const isPositive = higherIsBetter ? delta > 0 : delta < 0;
        const color = isPositive ? '#7ec87e' : '#ff6b6b';
        const sign = delta > 0 ? '+' : '';
        const formatted = useKMB ? formatKMB(Math.round(delta)) : formatWithSeparator(Math.round(delta));
        return ` <span style="color:${color}; font-size:11px;">(${sign}${formatted})</span>`;
    }

    /**
     * Format a deaths/hr value, showing decimals for low rates.
     * @param {number} value
     * @returns {string}
     * @private
     */
    _formatDeaths(value) {
        if (value === 0) return '0';
        if (value < 0.1) return value.toFixed(2);
        if (value < 1) return value.toFixed(1);
        return formatWithSeparator(Math.round(value));
    }

    /**
     * Format a rate value with one decimal place.
     * @param {number} value
     * @returns {string}
     * @private
     */
    _formatRate(value) {
        if (value === 0) return '0';
        if (value < 0.1) return value.toFixed(2);
        return (Math.round(value * 10) / 10).toString();
    }

    /**
     * Set the status bar text.
     * @param {string} text
     * @private
     */
    _setStatus(text) {
        const status = this.panel?.querySelector('#mwi-csim-status');
        if (status) status.textContent = text;
    }

    /**
     * Set up drag handling on the header element.
     * @param {HTMLElement} header
     * @private
     */
    _setupDrag(header) {
        header.addEventListener('mousedown', (e) => {
            if (e.target.id === 'mwi-csim-close') return;
            this.isDragging = true;
            header.style.cursor = 'grabbing';
            const rect = this.panel.getBoundingClientRect();
            this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            bringPanelToFront(this.panel);

            const onMove = (ev) => {
                if (!this.isDragging) return;
                this.panel.style.left = `${ev.clientX - this.dragOffset.x}px`;
                this.panel.style.top = `${ev.clientY - this.dragOffset.y}px`;
                this.panel.style.right = 'auto';
            };
            const onUp = () => {
                this.isDragging = false;
                header.style.cursor = 'grab';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    /**
     * Toggle panel visibility.
     */
    toggle() {
        if (!this.panel) return;
        const visible = this.panel.style.display !== 'none';
        this.panel.style.display = visible ? 'none' : 'flex';
        if (!visible) {
            bringPanelToFront(this.panel);
            this.populateZones();
            if (!this._editorInitialized) {
                this._initEditor();
            }
        }
    }

    /**
     * Remove the panel and clean up.
     */
    destroy() {
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
    }

    /**
     * Get the sell price for an item based on the global pricing mode.
     * @param {Object} priceData - { bid, ask } from marketAPI
     * @returns {number}
     * @private
     */
    _getSellPrice(priceData) {
        if (!priceData) return 0;
        const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
        // conservative/patientBuy → bid; hybrid/optimistic → ask
        if (mode === 'conservative' || mode === 'patientBuy') {
            return priceData.bid > 0 ? priceData.bid : 0;
        }
        return priceData.ask > 0 ? priceData.ask : 0;
    }

    /**
     * Get the buy price for an item based on the global pricing mode.
     * @param {Object} priceData - { bid, ask } from marketAPI
     * @returns {number}
     * @private
     */
    _getBuyPrice(priceData) {
        if (!priceData) return 0;
        const mode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
        // optimistic/patientBuy → bid; conservative/hybrid → ask
        if (mode === 'optimistic' || mode === 'patientBuy') {
            return priceData.bid > 0 ? priceData.bid : 0;
        }
        return priceData.ask > 0 ? priceData.ask : 0;
    }
}

const combatSimUI = new CombatSimUI();
export default combatSimUI;
