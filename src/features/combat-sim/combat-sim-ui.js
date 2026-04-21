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

        // Controls
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

        // Results container (hidden by default)
        const resultsContainer = document.createElement('div');
        resultsContainer.id = 'mwi-csim-results';
        resultsContainer.style.cssText = 'display:none; overflow-y:auto; flex:1; padding:10px 14px;';

        // Status bar
        const status = document.createElement('div');
        status.id = 'mwi-csim-status';
        status.style.cssText =
            'padding:6px 14px; color:#555; font-size:11px; border-top:1px solid #1a1a1a; flex-shrink:0; text-align:center;';
        status.textContent = 'Select a zone and click Simulate.';

        this.panel.appendChild(header);
        this.panel.appendChild(controls);
        this.panel.appendChild(progressContainer);
        this.panel.appendChild(resultsContainer);
        this.panel.appendChild(status);
        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);

        // Event listeners
        this.panel.querySelector('#mwi-csim-close').addEventListener('click', () => {
            this.panel.style.display = 'none';
        });
        this.panel.querySelector('#mwi-csim-run').addEventListener('click', () => this._onSimulate());
        this.panel.addEventListener('mousedown', () => bringPanelToFront(this.panel));

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

        const { players: playerDTOs, playerNames: _playerNames, missingMembers } = await buildAllPlayerDTOs();
        if (!playerDTOs.length) {
            this._setStatus('No character data available.');
            return;
        }

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

            this._displayResults(simResult, hours, gameData);
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

        const sectionStyle = 'margin-bottom:12px;';
        const headingStyle = `color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:6px; border-bottom:1px solid #222; padding-bottom:4px;`;
        const rowStyle = 'display:flex; justify-content:space-between; padding:2px 0; font-size:12px;';
        const labelStyle = 'color:#aaa;';
        const valueStyle = 'color:#e0e0e0; font-weight:600;';

        let html = '';

        // Overview: encounters/hr and deaths/hr
        const encountersPerHr = simResult.encounters / hours;
        let totalDeaths = 0;
        for (const [hrid, count] of Object.entries(simResult.deaths)) {
            // Only count player deaths (hrids starting with 'player'), not monster kills
            if (typeof count === 'number' && hrid.startsWith('player')) totalDeaths += count;
        }
        const deathsPerHr = totalDeaths / hours;

        html += `<div style="${sectionStyle}">`;
        html += `<div style="${headingStyle}">Overview</div>`;
        html += `<div style="${rowStyle}">`;
        html += `<span style="${labelStyle}">Encounters/hr</span>`;
        html += `<span style="${valueStyle}">${formatWithSeparator(Math.round(encountersPerHr))}</span>`;
        html += '</div>';
        html += `<div style="${rowStyle}">`;
        html += `<span style="${labelStyle}">Deaths/hr</span>`;
        html += `<span style="${valueStyle}">${this._formatDeaths(deathsPerHr)}</span>`;
        html += '</div>';

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

        // XP/hr by skill — aggregate across all player keys
        const xpTotals = {};
        for (const playerXP of Object.values(simResult.experienceGained)) {
            for (const [skill, amount] of Object.entries(playerXP)) {
                xpTotals[skill] = (xpTotals[skill] || 0) + amount;
            }
        }

        const xpEntries = Object.entries(xpTotals).filter(([, total]) => total > 0);
        if (xpEntries.length > 0) {
            html += `<div style="${sectionStyle}">`;
            html += `<div style="${headingStyle}">XP/hr</div>`;
            for (const [skill, total] of xpEntries) {
                const perHr = Math.round(total / hours);
                const skillLabel = skill.charAt(0).toUpperCase() + skill.slice(1);
                html += `<div style="${rowStyle}">`;
                html += `<span style="${labelStyle}">${skillLabel}</span>`;
                html += `<span style="${valueStyle}">${formatWithSeparator(perHr)}</span>`;
                html += '</div>';
            }
            html += '</div>';
        }

        // Consumable costs — aggregate across all player keys
        const consumableTotals = {};
        for (const playerConsumables of Object.values(simResult.consumablesUsed)) {
            for (const [itemHrid, count] of Object.entries(playerConsumables)) {
                consumableTotals[itemHrid] = (consumableTotals[itemHrid] || 0) + count;
            }
        }

        // Track totals for net profit calculation
        let dropGoldPerHr = 0;
        let dropGoldTotal = 0;
        let consumableGoldPerHr = 0;
        let consumableGoldTotal = 0;

        // Drops — calculated from kill counts × drop tables × multipliers
        if (gameData) {
            const dropMap = calculateExpectedDrops(simResult, gameData);

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
                html += `<span style="${colGold}">Gold/hr</span>`;
                html += `<span style="${colNum}">Total</span>`;
                html += `<span style="${colGold}">Total Gold</span>`;
                html += '</div>';

                for (const drop of dropData) {
                    const perHr = drop.total / hours;
                    const itemDetails = dataManager.getItemDetails(drop.itemHrid);
                    const name = itemDetails?.name || drop.itemHrid.split('/').pop();

                    const perHrStr = perHr >= 1 ? formatWithSeparator(Math.round(perHr)) : perHr.toFixed(2);
                    const totalStr =
                        drop.total >= 1 ? formatWithSeparator(Math.round(drop.total)) : drop.total.toFixed(2);

                    const goldPerHr = perHr * drop.unitValue;
                    dropGoldPerHr += goldPerHr;
                    dropGoldTotal += drop.totalGold;

                    const goldHrStr = drop.unitValue > 0 ? formatKMB(Math.round(goldPerHr)) : '—';
                    const goldTotalStr = drop.unitValue > 0 ? formatKMB(Math.round(drop.totalGold)) : '—';
                    const goldColor = drop.unitValue > 0 ? '#e8a87c' : '#444';

                    html += `<div style="${dropRowStyle}">`;
                    html += `<span style="${labelStyle} flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
                    html += `<span style="${valueStyle} ${colNum}">${perHrStr}</span>`;
                    html += `<span style="color:${goldColor}; font-weight:600; ${colGold}">${goldHrStr}</span>`;
                    html += `<span style="${valueStyle} ${colNum}">${totalStr}</span>`;
                    html += `<span style="color:${goldColor}; font-weight:600; ${colGold}">${goldTotalStr}</span>`;
                    html += '</div>';
                }
                // Totals row
                html += `<div style="display:flex; align-items:center; padding:4px 0 0; font-size:12px; border-top:1px solid #333; margin-top:4px; gap:6px;">`;
                html += `<span style="color:#aaa; font-weight:700; flex:1;">Total Revenue</span>`;
                html += `<span style="${colNum}"></span>`;
                html += `<span style="color:#e8a87c; font-weight:700; ${colGold}">${formatKMB(Math.round(dropGoldPerHr))}</span>`;
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
            html += `<span style="${colGold}">Cost/hr</span>`;
            html += `<span style="${colNum}">Total</span>`;
            html += `<span style="${colGold}">Total Cost</span>`;
            html += '</div>';

            for (const cons of consumableEntries) {
                const perHr = cons.total / hours;
                const itemDetails = dataManager.getItemDetails(cons.itemHrid);
                const name = itemDetails?.name || cons.itemHrid.split('/').pop();

                const perHrStr = formatWithSeparator(Math.round(perHr));
                const totalStr = formatWithSeparator(Math.round(cons.total));

                const costPerHr = perHr * cons.unitCost;
                consumableGoldPerHr += costPerHr;
                consumableGoldTotal += cons.totalCost;

                const costHrStr = cons.unitCost > 0 ? formatKMB(Math.round(costPerHr)) : '—';
                const costTotalStr = cons.unitCost > 0 ? formatKMB(Math.round(cons.totalCost)) : '—';
                const cColor = cons.unitCost > 0 ? costColor : '#444';

                html += `<div style="${costRowStyle}">`;
                html += `<span style="${labelStyle} flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${perHrStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costHrStr}</span>`;
                html += `<span style="${valueStyle} ${colNum}">${totalStr}</span>`;
                html += `<span style="color:${cColor}; font-weight:600; ${colGold}">${costTotalStr}</span>`;
                html += '</div>';
            }
            // Totals row
            html += `<div style="display:flex; align-items:center; padding:4px 0 0; font-size:12px; border-top:1px solid #333; margin-top:4px; gap:6px;">`;
            html += `<span style="color:#aaa; font-weight:700; flex:1;">Total Expenses</span>`;
            html += `<span style="${colNum}"></span>`;
            html += `<span style="color:${costColor}; font-weight:700; ${colGold}">${formatKMB(Math.round(consumableGoldPerHr))}</span>`;
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

        html += `<div style="${sectionStyle}">`;
        html += `<div style="${headingStyle}">Net Profit</div>`;
        const netColGold = 'flex:0; white-space:nowrap; min-width:58px; text-align:right;';
        const netColNum = 'flex:0; white-space:nowrap; min-width:48px; text-align:right;';
        html += `<div style="display:flex; align-items:center; padding:2px 0; font-size:13px; gap:6px;">`;
        html += `<span style="color:#aaa; font-weight:700; flex:1;">Profit</span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="color:${profitColor}; font-weight:700; ${netColGold}">${profitSign}${formatKMB(Math.abs(Math.round(netProfitPerHr)))}/hr</span>`;
        html += `<span style="${netColNum}"></span>`;
        html += `<span style="color:${profitColor}; font-weight:700; ${netColGold}">${totalProfitSign}${formatKMB(Math.abs(Math.round(netProfitTotal)))}</span>`;
        html += '</div>';
        html += '</div>';

        container.innerHTML = html;
        container.style.display = 'block';
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
