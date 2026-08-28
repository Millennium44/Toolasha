/**
 * Combat Statistics UI
 * Injects button and displays statistics popup
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import combatStatsDataCollector from './combat-stats-data-collector.js';
import { calculateAllPlayerStats, describeLuckAdjustment } from './combat-stats-calculator.js';
import { loadSessions } from './combat-session-history.js';
import {
    formatWithSeparator,
    coinFormatter,
    formatKMB,
    formatPercentage,
    isAbbreviationEnabled,
} from '../../utils/formatters.js';
import { formatKeyCostNote } from '../../utils/key-cost.js';
import { shortDuration } from '../../utils/overlay-format.js';
import { compareBurnToSim, formatBurnLine } from '../../utils/consumable-burn.js';
import { readScoped } from '../../utils/character-key.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';

/**
 * An archived run as one line in the session picker.
 *
 * "Aug 5 · 6h 12m · Chimerical Den · party of 5" — the four things that tell
 * one stored run from another. Pure, so a picker's labelling is testable: the
 * zone name comes in through `zoneNameOf` because game data lives with the
 * caller, and a session whose zone the archive never recorded simply goes
 * unnamed rather than being guessed.
 *
 * @param {Object} session - A snapshot from the session archive
 * @param {Object} [options]
 * @param {Function} [options.zoneNameOf] - `(actionHrid) => string|null`
 * @param {Function} [options.formatDuration] - Seconds to something readable
 * @returns {string}
 */
export function archivedSessionLabel(session, { zoneNameOf, formatDuration = shortDuration } = {}) {
    const started = session?.combatStartTime ? new Date(session.combatStartTime) : null;
    const when =
        started && !Number.isNaN(started.getTime())
            ? started.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            : 'Unknown date';

    const length = formatDuration(Math.round(session?.durationSeconds || 0));
    const zone = (typeof zoneNameOf === 'function' && zoneNameOf(session?.actionHrid)) || null;
    const count = session?.players?.length || 0;
    const party = count > 1 ? `party of ${count}` : 'solo';

    return [when, length, zone, party].filter(Boolean).join(' · ');
}

/**
 * The whole popup — every player card, flattened — as plain text for the
 * clipboard. Close enough to the on-screen figures that pasting it into a
 * guild chat or a bug report tells the same story, but without the
 * expandable breakdowns, which don't survive a paste.
 *
 * @param {Array<Object>} playerStats - What createPopup is rendering
 * @param {Object} [options]
 * @param {string} [options.header] - First line — states which run this is
 * @param {string} [options.priceKey] - 'ask' | 'bid', so a reader knows which income this is
 * @param {Function} [options.formatNum] - Number formatter matching the cards on screen
 * @returns {string}
 */
export function combatSessionText(
    playerStats,
    { header = 'Combat Statistics', priceKey = 'ask', formatNum = (num) => String(Math.round(num)) } = {}
) {
    const lines = [header];

    if (!playerStats || playerStats.length === 0) {
        lines.push('No data.');
        return lines.join('\n');
    }

    for (const stats of playerStats) {
        lines.push('');
        lines.push(stats.name);
        lines.push(`  Duration: ${stats.durationFormatted || '0s'}`);
        lines.push(`  Encounters/hour: ${formatNum(stats.encountersPerHour)}`);
        lines.push(`  Income (${priceKey}): ${formatNum(stats.income?.[priceKey])}`);
        lines.push(`  Daily income: ${formatNum(stats.dailyIncome?.[priceKey])}/d`);
        lines.push(`  Consumable costs: ${formatNum(stats.consumableCosts)}`);
        lines.push(`  Daily profit: ${formatNum(stats.dailyProfit?.[priceKey])}/d`);
        lines.push(`  Total EXP: ${formatNum(stats.totalExp)}`);
        lines.push(`  EXP/hour: ${formatNum(stats.expPerHour)}`);
        lines.push(`  Deaths: ${stats.deathCount ?? 0} (${(stats.deathsPerHour ?? 0).toFixed(2)}/h)`);
    }

    return lines.join('\n');
}

class CombatStatsUI {
    constructor() {
        this.isInitialized = false;
        this.observer = null;
        this.popup = null;
        /**
         * Which run the popup is showing: 'live', or an archived session's key.
         * On the instance rather than the popup so reopening the popup shows
         * the same run — and showPopup falls back to Live when the remembered
         * session has since dropped off the archive.
         */
        this.viewing = 'live';
        /** Archived runs, newest first; refreshed on every popup open */
        this.sessions = [];
        /** `{actionHrid, difficultyTier, simRecord}` for the burn-vs-sim line */
        this.burnContext = null;
    }

    /**
     * Initialize the UI
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;

        // Setup setting listener
        config.onSettingChange('combatStats', (enabled) => {
            if (enabled) {
                this.injectButton();
            } else {
                this.removeButton();
            }
        });

        // Start observing for Combat panel
        this.startObserver();
    }

    /**
     * Start MutationObserver to watch for Combat panel
     */
    startObserver() {
        this.observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const addedNode of mutation.addedNodes) {
                    if (addedNode.nodeType !== Node.ELEMENT_NODE) continue;

                    // Check for Combat Panel appearing
                    if (addedNode.classList?.contains('MainPanel_subPanelContainer__1i-H9')) {
                        const combatPanel = addedNode.querySelector('[class*="CombatPanel_combatPanel"]');
                        if (combatPanel) {
                            this.injectButton();
                        }
                    }

                    // Check for initial page load
                    if (addedNode.classList?.contains('GamePage_contentPanel__Zx4FH')) {
                        const combatPanel = addedNode.querySelector('[class*="CombatPanel_combatPanel"]');
                        if (combatPanel) {
                            this.injectButton();
                        }
                    }
                }
            }
        });

        this.observer.observe(document.body, { childList: true, subtree: true });

        // Try to inject button immediately if Combat panel is already visible
        setTimeout(() => this.injectButton(), 1000);
    }

    /**
     * Inject Statistics button into Combat panel tabs
     */
    injectButton() {
        // Check if feature is enabled
        if (!config.getSetting('combatStats')) {
            return;
        }

        // Find the tabs container
        const tabsContainer = document.querySelector(
            'div.GamePage_mainPanel__2njyb > div > div:nth-child(1) > div > div > div > div[class*="TabsComponent_tabsContainer"] > div > div > div'
        );

        if (!tabsContainer) {
            return;
        }

        // Verify we're in a Combat panel, not Marketplace or other panels
        const combatPanel = tabsContainer.closest('[class*="CombatPanel_combatPanel"]');
        if (!combatPanel) {
            return;
        }

        // Check if button already exists
        if (tabsContainer.querySelector('.toolasha-combat-stats-btn')) {
            return;
        }

        // Create button
        const button = document.createElement('div');
        button.className =
            'MuiButtonBase-root MuiTab-root MuiTab-textColorPrimary css-1q2h7u5 toolasha-combat-stats-btn';
        button.textContent = 'Statistics';
        button.style.cursor = 'pointer';

        button.onclick = () => this.showPopup();

        // Insert button at the end
        const lastTab = tabsContainer.children[tabsContainer.children.length - 1];
        tabsContainer.insertBefore(button, lastTab.nextSibling);
    }

    /**
     * Remove Statistics button from Combat panel tabs
     */
    removeButton() {
        const button = document.querySelector('.toolasha-combat-stats-btn');
        if (button) {
            button.remove();
        }
    }

    /**
     * Share statistics to chat (triggered by Ctrl+Click on player card)
     * @param {Object} stats - Player statistics
     */
    shareStatsToChat(stats) {
        // Get chat message format from config (use getSettingValue for template type)
        const messageTemplate = config.getSettingValue('combatStatsChatMessage');
        const priceKey = config.getSettingValue('profitCalc_keyPricingMode') || 'ask';

        // Convert array format to string if needed
        let message = '';
        if (Array.isArray(messageTemplate)) {
            // Format numbers
            const useKMB = isAbbreviationEnabled();
            const formatNum = (num) => (useKMB ? coinFormatter(Math.round(num)) : formatWithSeparator(Math.round(num)));

            // Build message from array
            message = messageTemplate
                .map((item) => {
                    if (item.type === 'variable') {
                        // Replace variable with actual value
                        switch (item.key) {
                            case '{income}':
                                return formatNum(stats.income[priceKey]);
                            case '{dailyIncome}':
                                return formatNum(stats.dailyIncome[priceKey]);
                            case '{dailyConsumableCosts}':
                                return formatNum(stats.dailyConsumableCosts);
                            case '{dailyProfit}':
                                return formatNum(stats.dailyProfit[priceKey]);
                            case '{exp}':
                                return formatNum(stats.expPerHour);
                            case '{deathCount}':
                                return stats.deathCount.toString();
                            case '{encountersPerHour}':
                                return formatNum(stats.encountersPerHour);
                            case '{duration}':
                                return stats.durationFormatted || '0s';
                            default:
                                return item.key;
                        }
                    } else {
                        // Plain text
                        return item.value;
                    }
                })
                .join('');
        } else {
            // Legacy string format (shouldn't happen, but handle it)
            const useKMB = isAbbreviationEnabled();
            const formatNum = (num) => (useKMB ? coinFormatter(Math.round(num)) : formatWithSeparator(Math.round(num)));

            message = (messageTemplate || 'Combat Stats: {income} income | {dailyProfit} profit/d | {exp} exp/h')
                .replace('{income}', formatNum(stats.income[priceKey]))
                .replace('{dailyIncome}', formatNum(stats.dailyIncome[priceKey]))
                .replace('{dailyProfit}', formatNum(stats.dailyProfit[priceKey]))
                .replace('{dailyConsumableCosts}', formatNum(stats.dailyConsumableCosts))
                .replace('{exp}', formatNum(stats.expPerHour))
                .replace('{deathCount}', stats.deathCount.toString());
        }

        // Insert into chat
        this.insertToChat(message);
    }

    /**
     * Insert text into chat input
     * @param {string} text - Text to insert
     */
    insertToChat(text) {
        const chatSelector =
            '#root > div > div > div.GamePage_gamePanel__3uNKN > div.GamePage_contentPanel__Zx4FH > div.GamePage_middlePanel__uDts7 > div.GamePage_chatPanel__mVaVt > div > div.Chat_chatInputContainer__2euR8 > form > input';
        const chatInput = document.querySelector(chatSelector);

        if (!chatInput) {
            console.error('[Combat Stats] Chat input not found');
            return;
        }

        // Use native value setter for React compatibility
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const start = chatInput.selectionStart || 0;
        const end = chatInput.selectionEnd || 0;

        // Insert text at cursor position
        const newValue = chatInput.value.substring(0, start) + text + chatInput.value.substring(end);
        nativeInputValueSetter.call(chatInput, newValue);

        // Dispatch input event for React
        const event = new Event('input', {
            bubbles: true,
            cancelable: true,
        });
        chatInput.dispatchEvent(event);

        // Set cursor position after inserted text
        chatInput.selectionStart = chatInput.selectionEnd = start + text.length;
        chatInput.focus();
    }

    /**
     * One archived run's picker line, with the zone named from game data.
     * @param {Object} session - A snapshot from the archive
     * @returns {string}
     */
    describeArchivedSession(session) {
        return archivedSessionLabel(session, {
            zoneNameOf: (actionHrid) => (actionHrid ? dataManager.getActionDetails?.(actionHrid)?.name || null : null),
        });
    }

    /**
     * Show statistics popup
     *
     * Live by default; an archived session when one is picked. The archive is
     * read-only here — choosing a run renders its final snapshot through the
     * same calculator the live view uses, with the archived duration, and
     * switching back to Live restores the run in progress.
     */
    async showPopup() {
        // Ensure market data is loaded
        if (!marketAPI.isLoaded()) {
            const marketData = await marketAPI.fetch();
            if (!marketData) {
                console.error('[Combat Stats] Market data not available');
                alert('Market data not available. Please try again.');
                return;
            }
        }

        // The archive, for the picker. Fresh on every open — a run archives
        // itself the moment the next one starts, and a stale list would hide it.
        try {
            this.sessions = await loadSessions();
        } catch (error) {
            console.error('[Combat Stats] Reading the session archive failed:', error);
            this.sessions = [];
        }

        // A remembered session that has since fallen off the end of the list
        // must not leave the popup claiming to show it
        if (this.viewing !== 'live' && !this.sessions.some((session) => session.key === this.viewing)) {
            this.viewing = 'live';
        }

        const archived = this.viewing !== 'live' ? this.sessions.find((session) => session.key === this.viewing) : null;

        let combatData;
        let durationSeconds = null;

        if (archived) {
            // The stored snapshot is the session's final state, and its stored
            // duration is the run's whole length — never recomputed from a
            // start time that is no longer ticking
            combatData = archived;
            durationSeconds = archived.durationSeconds || null;
        } else {
            // Get latest combat data (live = from a new_battle WS message this page session)
            combatData = combatStatsDataCollector.getLatestData();
            const isLive = !!combatData;

            if (!combatData) {
                // Try to load from storage (may be from a previous combat session)
                combatData = await combatStatsDataCollector.loadLatestData();
            }

            if (!combatData || !combatData.players || combatData.players.length === 0) {
                // With archived runs on file there is still something to show
                if (this.sessions.length === 0) {
                    alert('No combat data available. Start a combat run first.');
                    return;
                }
                combatData = null;
            }

            // Calculate duration:
            // - Live data: recalculate from combatStartTime (real-time, always correct)
            // - Stored fallback: use snapshot durationSeconds (avoids inflated duration when
            //   stored combatStartTime is from a previous combat session)
            if (isLive && combatData?.combatStartTime) {
                const combatStartTime = new Date(combatData.combatStartTime).getTime() / 1000;
                const currentTime = Date.now() / 1000;
                durationSeconds = currentTime - combatStartTime;
            } else if (combatData?.durationSeconds) {
                durationSeconds = combatData.durationSeconds;
            }
        }

        // The sim's own guess at what this zone eats, for the burn-vs-sim line.
        // Read here rather than in the card because the card is synchronous and
        // a row that renders a frame late reads as a bug.
        this.burnContext = await this.loadBurnContext(combatData);

        // Calculate statistics — archived runs go through the same pathway
        const playerStats = combatData ? calculateAllPlayerStats(combatData, durationSeconds) : [];

        // Create and show popup
        this.createPopup(playerStats, { archived });
    }

    /**
     * The sim record this run's consumption should be judged against.
     *
     * Keyed by zone *and* tier, because a tier changes what is hitting you and
     * therefore how often food fires; the comparison itself rejects a record
     * that does not match, so a wrong lookup here shows nothing rather than a
     * wrong ratio.
     *
     * The tier comes from the live action queue, which is the only place it is
     * stated — an archived run does not record one, so its lookup falls back to
     * tier 0 and simply finds nothing when the run was not at tier 0.
     *
     * @param {Object|null} combatData - The snapshot being displayed
     * @returns {Promise<{actionHrid: string, difficultyTier: number, simRecord: Object|null}|null>}
     */
    async loadBurnContext(combatData) {
        const actionHrid = combatData?.actionHrid || null;
        if (!actionHrid) return null;
        // The rates are filed per character; without one there is no record to
        // find, and asking for it would only raise an error to swallow
        if (!dataManager.getCurrentCharacterId?.()) return null;

        try {
            const live = (dataManager.getCurrentActions?.() || []).find((action) => action.actionHrid === actionHrid);
            const difficultyTier = Number(live?.difficultyTier) || 0;
            const byZone = (await readScoped('simConsumableRatesByZone', 'combatExport', {})) || {};
            return { actionHrid, difficultyTier, simRecord: byZone[`${actionHrid}|${difficultyTier}`] || null };
        } catch (error) {
            console.error('[Combat Stats] Reading the sim consumable rates failed:', error);
            return null;
        }
    }

    /**
     * The measured-against-simmed line for one player card, or null.
     *
     * Only the logged-in character has a sim on record — the rates are stored
     * per character, and a party member's appetite was never simulated — so
     * everyone else's card is left alone rather than being judged against
     * somebody else's simulation.
     *
     * @param {Object} stats - One player's stats
     * @returns {{text: string, tone: string, color: string, note: string}|null}
     */
    burnVsSimLine(stats) {
        try {
            if (!this.burnContext?.simRecord) return null;
            if (stats?.name !== dataManager.getCurrentCharacterName?.()) return null;

            const comparison = compareBurnToSim({
                consumables: stats.consumableBreakdown,
                simRecord: this.burnContext.simRecord,
                actionHrid: this.burnContext.actionHrid,
                difficultyTier: this.burnContext.difficultyTier,
                itemDetailFor: (itemHrid) => dataManager.getItemDetails?.(itemHrid),
            });
            return formatBurnLine(comparison, shortDuration);
        } catch (error) {
            console.error('[Combat Stats] Comparing measured consumables against the sim failed:', error);
            return null;
        }
    }

    /**
     * Create and display the statistics popup
     * @param {Array} playerStats - Array of player statistics
     * @param {Object} [context] - `{archived}`: the archived session on show, or null for Live
     */
    createPopup(playerStats, { archived = null } = {}) {
        // Remove existing popup if any
        if (this.popup) {
            this.closePopup();
        }

        // Get text color from config
        const textColor = config.COLOR_TEXT_PRIMARY;

        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'toolasha-combat-stats-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // Create popup container
        const popup = document.createElement('div');
        popup.className = 'toolasha-combat-stats-popup';
        popup.style.cssText = `
            background: #1a1a1a;
            border: 2px solid #3a3a3a;
            border-radius: 8px;
            padding: 20px;
            max-width: 90%;
            max-height: 90%;
            overflow-y: auto;
            color: ${textColor};
        `;

        // Create header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            border-bottom: 2px solid #3a3a3a;
            padding-bottom: 10px;
        `;

        const title = document.createElement('h2');
        title.textContent = archived ? 'Combat Statistics — Archived Session' : 'Combat Statistics';
        title.style.cssText = `
            margin: 0;
            color: ${textColor};
            font-size: 24px;
        `;

        // Button container for reset and close
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = `
            display: flex;
            align-items: center;
            gap: 15px;
        `;

        // Which run: Live, or one from the archive. Only offered when there is
        // an archive to pick from — a picker with one option is furniture.
        if (this.sessions.length > 0) {
            const picker = document.createElement('select');
            picker.className = 'toolasha-combat-stats-session-picker';
            picker.classList.add('toolasha-select');
            picker.style.cssText = `
                background: #2a2a2a;
                color: ${textColor};
                border: 1px solid #4a4a4a;
                border-radius: 4px;
                padding: 5px 8px;
                font-size: 12px;
                max-width: 260px;
            `;

            const option = (value, label) => {
                const element = document.createElement('option');
                element.value = value;
                element.textContent = label;
                element.selected = this.viewing === value;
                picker.appendChild(element);
            };

            option('live', 'Live session');
            for (const session of this.sessions) option(session.key, this.describeArchivedSession(session));

            picker.onchange = async () => {
                this.viewing = picker.value;
                await this.showPopup();
            };
            buttonContainer.appendChild(picker);
        }

        const resetButton = document.createElement('button');
        resetButton.textContent = 'Reset Consumable Tracking';
        resetButton.style.cssText = `
            background: #4a4a4a;
            border: 1px solid #5a5a5a;
            color: ${textColor};
            font-size: 12px;
            cursor: pointer;
            padding: 6px 12px;
            border-radius: 4px;
        `;
        resetButton.onmouseover = () => {
            resetButton.style.background = '#5a5a5a';
        };
        resetButton.onmouseout = () => {
            resetButton.style.background = '#4a4a4a';
        };
        resetButton.onclick = async () => {
            if (confirm('Reset consumable tracking? This will clear all tracked consumption data and start fresh.')) {
                await combatStatsDataCollector.resetConsumableTracking();

                // Clear stale consumable data from the in-memory snapshot so the
                // reopened popup reflects the reset immediately (before the next
                // new_battle WS message recalculates everything).
                const cached = combatStatsDataCollector.getLatestData();
                if (cached?.players) {
                    for (const player of cached.players) {
                        if (player.consumables) {
                            for (const c of player.consumables) {
                                c.actualConsumed = 0;
                                c.consumed = 0;
                                c.consumedPerDay = 0;
                                c.consumptionRate = 0;
                                c.elapsedSeconds = 0;
                            }
                        }
                    }
                }

                // Rebuild popup in-place with fresh data
                await this.showPopup();
            }
        };

        const closeButton = document.createElement('button');
        closeButton.textContent = '×';
        closeButton.style.cssText = `
            background: none;
            border: none;
            color: ${textColor};
            font-size: 32px;
            cursor: pointer;
            padding: 0;
            line-height: 1;
        `;
        closeButton.onclick = () => this.closePopup();

        // A plain-text copy of this run — live or archived alike — for pasting
        // into a guild chat or a bug report. Only offered when there is
        // something on the cards to copy.
        let copyButton = null;
        if (playerStats.length > 0) {
            copyButton = document.createElement('button');
            copyButton.textContent = '⧉ Copy';
            copyButton.title = 'Copy this session (all players) to the clipboard as text';
            copyButton.style.cssText = `
                background: #4a4a4a;
                border: 1px solid #5a5a5a;
                color: ${textColor};
                font-size: 12px;
                cursor: pointer;
                padding: 6px 12px;
                border-radius: 4px;
            `;
            copyButton.onmouseover = () => {
                copyButton.style.background = '#5a5a5a';
            };
            copyButton.onmouseout = () => {
                copyButton.style.background = '#4a4a4a';
            };
            copyButton.onclick = () => {
                const priceKey = config.getSettingValue('profitCalc_keyPricingMode') || 'ask';
                const useKMB = isAbbreviationEnabled();
                const formatNum = (num) =>
                    useKMB ? coinFormatter(Math.round(num)) : formatWithSeparator(Math.round(num));
                const header = archived
                    ? `Combat Statistics — Archived Session (${this.describeArchivedSession(archived)})`
                    : 'Combat Statistics — Live';
                const text = combatSessionText(playerStats, { header, priceKey, formatNum });

                if (!navigator.clipboard) return;
                navigator.clipboard
                    .writeText(text)
                    .then(() => {
                        copyButton.textContent = '✓ Copied';
                        setTimeout(() => (copyButton.textContent = '⧉ Copy'), 1200);
                    })
                    .catch((error) => console.error('[Combat Stats] Copy failed:', error));
            };
        }

        // Consumable tracking is a live measurement; resetting it from a view
        // of last night's run would read as editing the archive
        if (!archived) buttonContainer.appendChild(resetButton);
        if (copyButton) buttonContainer.appendChild(copyButton);
        buttonContainer.appendChild(closeButton);

        header.appendChild(title);
        header.appendChild(buttonContainer);

        // Create player cards container
        const cardsContainer = document.createElement('div');
        cardsContainer.style.cssText = `
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
            justify-content: center;
        `;

        // Create a card for each player
        for (const stats of playerStats) {
            const card = this.createPlayerCard(stats, textColor);
            cardsContainer.appendChild(card);
        }

        if (playerStats.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No live run measured yet — pick an archived session above.';
            empty.style.cssText = 'color: #888; padding: 20px; text-align: center;';
            cardsContainer.appendChild(empty);
        }

        // Assemble popup
        popup.appendChild(header);
        if (archived) {
            // Headed as what it is, so an old run's figures are never mistaken
            // for the one in progress
            const banner = document.createElement('div');
            banner.className = 'toolasha-combat-stats-archived-banner';
            banner.textContent =
                `Archived session — ${this.describeArchivedSession(archived)}. ` +
                'Figures are this run’s final state, at today’s prices. Pick "Live session" to return.';
            banner.style.cssText = `
                margin-bottom: 15px;
                padding: 8px 12px;
                border: 1px solid #6b5a1f;
                border-radius: 4px;
                background: rgba(255, 200, 60, 0.08);
                color: #e8c66c;
                font-size: 13px;
            `;
            popup.appendChild(banner);
        }
        popup.appendChild(cardsContainer);
        overlay.appendChild(popup);

        // Add to page
        document.body.appendChild(overlay);

        // Close on overlay click
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                this.closePopup();
            }
        };

        this.popup = overlay;
    }

    /**
     * Get the current items sprite URL from the DOM
     * Extracts the sprite URL with webpack hash from an existing item icon
     * @returns {string|null} Items sprite URL or null if not found
     */
    getItemsSpriteUrl() {
        // Find any existing item icon in the DOM
        const itemIcon = document.querySelector('use[href*="items_sprite"]');
        if (!itemIcon) {
            return null;
        }

        const href = itemIcon.getAttribute('href');
        // Extract just the sprite URL without the #symbol part
        // e.g., "/static/media/items_sprite.53ef17dc.svg#coin" → "/static/media/items_sprite.53ef17dc.svg"
        return href ? href.split('#')[0] : null;
    }

    /**
     * Clone a symbol from the document into a defs element
     * @param {string} symbolId - Symbol ID to clone
     * @param {SVGDefsElement} defsElement - Defs element to append to
     * @returns {boolean} True if successful
     */
    cloneSymbolToDefs(symbolId, defsElement) {
        // Check if already cloned
        if (defsElement.querySelector(`symbol[id="${symbolId}"]`)) {
            return true;
        }

        // Find symbol in document
        const symbol = document.querySelector(`symbol[id="${symbolId}"]`);
        if (!symbol) {
            return false;
        }

        // Clone and append
        const clonedSymbol = symbol.cloneNode(true);
        defsElement.appendChild(clonedSymbol);
        return true;
    }

    /**
     * Create a player statistics card
     * @param {Object} stats - Player statistics
     * @param {string} textColor - Text color
     * @returns {HTMLElement} Card element
     */
    createPlayerCard(stats, textColor) {
        const card = document.createElement('div');
        card.style.cssText = `
            background: #2a2a2a;
            border: 2px solid #4a4a4a;
            border-radius: 8px;
            padding: 15px;
            min-width: 300px;
            max-width: 400px;
            cursor: pointer;
        `;

        // Add Ctrl+Click handler to share to chat
        card.onclick = (e) => {
            if (e.ctrlKey || e.metaKey) {
                this.shareStatsToChat(stats);
                e.stopPropagation();
            }
        };

        // Player name
        const nameHeader = document.createElement('div');
        nameHeader.textContent = stats.name;
        nameHeader.style.cssText = `
            font-size: 20px;
            font-weight: bold;
            margin-bottom: 15px;
            text-align: center;
            color: ${textColor};
            border-bottom: 1px solid #4a4a4a;
            padding-bottom: 8px;
        `;

        // Statistics rows
        // Use K/M/B formatting if enabled, otherwise use separators
        const useKMB = isAbbreviationEnabled();
        const formatNum = (num) => (useKMB ? coinFormatter(Math.round(num)) : formatWithSeparator(Math.round(num)));
        const formatNumDecimals = (num) =>
            useKMB
                ? coinFormatter(Math.round(num))
                : new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(num);

        const priceKey = config.getSettingValue('profitCalc_keyPricingMode') || 'ask';

        // Chest EVs scaled by the player's own measured luck must say so on
        // every figure that carries them — income, and the profit built on it
        const luckNote = stats.chestLuckAdjustments?.length
            ? stats.chestLuckAdjustments.map(describeLuckAdjustment).join('\n')
            : null;

        const burnLine = this.burnVsSimLine(stats);

        const statsRows = [
            { label: 'Duration', value: stats.durationFormatted || '0s' },
            { label: 'Encounters/Hour', value: formatNum(stats.encountersPerHour) },
            {
                label: 'Income',
                value: formatNum(stats.income[priceKey]),
                note: luckNote,
                ...(stats.isDungeonRun && stats.incomeBreakdown?.length > 0
                    ? { expandable: true, incomeBreakdown: stats.incomeBreakdown }
                    : {}),
            },
            { label: 'Daily Income', value: `${formatNum(stats.dailyIncome[priceKey])}/d`, note: luckNote },
            {
                label: 'Consumable Costs',
                value: formatNumDecimals(stats.consumableCosts),
                color: '#ff6b6b',
                expandable: true,
                breakdown: stats.consumableBreakdown,
            },
            {
                label: 'Daily Consumable Costs',
                value: `${formatNumDecimals(stats.dailyConsumableCosts)}/d`,
                color: '#ff6b6b',
                expandable: true,
                breakdown: stats.consumableBreakdown,
                isDaily: true,
            },
            // What the run ate against what the sim assumed it would. Sits under
            // the consumable costs because that is the figure it qualifies, and
            // above the profit line that inherits the same error.
            ...(burnLine
                ? [
                      {
                          label: 'Consumables vs sim',
                          value: burnLine.text,
                          color: burnLine.color,
                          note: burnLine.note,
                      },
                  ]
                : []),
            ...(stats.keyBreakdown && stats.keyBreakdown.length > 0
                ? [
                      {
                          label: 'Key Costs',
                          value: formatNum(stats.keyCosts[priceKey]),
                          color: '#ff6b6b',
                          expandable: true,
                          breakdown: stats.keyBreakdown,
                          hideTrackingNote: true,
                          showKeyPricingNote: true,
                      },
                      {
                          label: 'Daily Key Costs',
                          value: `${formatNum(stats.dailyKeyCosts)}/d`,
                          color: '#ff6b6b',
                          expandable: true,
                          breakdown: stats.keyBreakdown,
                          isDaily: true,
                          hideTrackingNote: true,
                          showKeyPricingNote: true,
                      },
                  ]
                : []),
            {
                label: 'Daily Profit',
                value: `${formatNum(stats.dailyProfit[priceKey])}/d`,
                color: stats.dailyProfit[priceKey] >= 0 ? '#51cf66' : '#ff6b6b',
                note: luckNote,
            },
            { label: 'Total EXP', value: formatNum(stats.totalExp) },
            { label: 'EXP/hour', value: `${formatNum(stats.expPerHour)}/h` },
            { label: 'Death Count', value: `${stats.deathCount}` },
            { label: 'Deaths/hr', value: `${stats.deathsPerHour.toFixed(2)}/h` },
        ];

        const statsContainer = document.createElement('div');
        statsContainer.style.cssText = 'margin-bottom: 15px;';

        for (const row of statsRows) {
            const rowDiv = document.createElement('div');
            rowDiv.style.cssText = `
                display: flex;
                justify-content: space-between;
                margin-bottom: 5px;
                font-size: 14px;
            `;

            const label = document.createElement('span');
            label.textContent = row.label + ':';
            label.style.color = textColor;

            const value = document.createElement('span');
            value.textContent = row.value;
            value.style.color = row.color || textColor;

            // A figure adjusted by measured luck is marked, never silent
            if (row.note) {
                value.textContent += ' *';
                rowDiv.title = row.note;
            }

            // Add expandable indicator if applicable
            if (row.expandable) {
                rowDiv.style.cursor = 'pointer';
                rowDiv.style.userSelect = 'none';
                label.textContent = '▶ ' + row.label + ':';

                let isExpanded = false;
                let breakdownDiv = null;

                rowDiv.onclick = () => {
                    isExpanded = !isExpanded;
                    label.textContent = (isExpanded ? '▼ ' : '▶ ') + row.label + ':';

                    if (isExpanded) {
                        // Create breakdown
                        breakdownDiv = document.createElement('div');
                        breakdownDiv.style.cssText = `
                            margin-left: 20px;
                            margin-top: 5px;
                            margin-bottom: 10px;
                            padding: 10px;
                            background: #1a1a1a;
                            border-left: 2px solid #4a4a4a;
                            font-size: 13px;
                        `;

                        if (row.incomeBreakdown) {
                            // Pricing mode label
                            const pricingMode = config.getSettingValue('profitCalc_pricingMode') || 'hybrid';
                            const pricingNote = document.createElement('div');
                            pricingNote.style.cssText = `
                                margin-bottom: 8px;
                                font-size: 12px;
                                color: #aaa;
                            `;
                            pricingNote.textContent = `Pricing: ${config.getPricingModeLabel(pricingMode)}`;
                            breakdownDiv.appendChild(pricingNote);

                            // Column header
                            const incomeHeader = document.createElement('div');
                            incomeHeader.style.cssText = `
                                display: grid;
                                grid-template-columns: 2fr 1fr 1fr 1fr;
                                gap: 10px;
                                font-weight: bold;
                                margin-bottom: 5px;
                                padding-bottom: 5px;
                                border-bottom: 1px solid #4a4a4a;
                                color: ${textColor};
                            `;
                            incomeHeader.innerHTML = `
                                <span>Chest</span>
                                <span style="text-align: right;">Received</span>
                                <span style="text-align: right;">EV Each</span>
                                <span style="text-align: right;">Total EV</span>
                            `;
                            breakdownDiv.appendChild(incomeHeader);

                            // One row per chest type
                            for (const chest of row.incomeBreakdown) {
                                const chestRow = document.createElement('div');
                                chestRow.style.cssText = `
                                    display: grid;
                                    grid-template-columns: 2fr 1fr 1fr 1fr;
                                    gap: 10px;
                                    margin-bottom: 3px;
                                    color: ${textColor};
                                    cursor: pointer;
                                    user-select: none;
                                `;
                                let chestExpanded = false;
                                let chestBreakdownDiv = null;

                                const nameCell = document.createElement('span');
                                nameCell.textContent = `▶ ${chest.itemName}`;
                                const countCell = document.createElement('span');
                                countCell.style.textAlign = 'right';
                                countCell.textContent = formatNum(chest.count);
                                const evCell = document.createElement('span');
                                evCell.style.textAlign = 'right';
                                evCell.textContent = formatNum(chest.evPerChest);
                                const totalCell = document.createElement('span');
                                totalCell.style.textAlign = 'right';
                                totalCell.textContent = formatNum(chest.totalValue);

                                // Marked, never silent: this EV is the drop
                                // table's scaled by the player's measured luck
                                if (chest.luckAdjustment) {
                                    evCell.textContent += '*';
                                    chestRow.title = describeLuckAdjustment({
                                        itemName: chest.itemName,
                                        ...chest.luckAdjustment,
                                    });
                                }

                                chestRow.appendChild(nameCell);
                                chestRow.appendChild(countCell);
                                chestRow.appendChild(evCell);
                                chestRow.appendChild(totalCell);

                                chestRow.onclick = (e) => {
                                    e.stopPropagation();
                                    chestExpanded = !chestExpanded;
                                    nameCell.textContent = `${chestExpanded ? '▼' : '▶'} ${chest.itemName}`;
                                    if (chestExpanded) {
                                        chestBreakdownDiv = document.createElement('div');
                                        chestBreakdownDiv.style.cssText = `
                                            margin-left: 20px;
                                            margin-top: 4px;
                                            margin-bottom: 8px;
                                            padding: 8px;
                                            background: #111;
                                            border-left: 2px solid #4a4a4a;
                                            font-size: 12px;
                                            color: ${textColor};
                                        `;
                                        const subHeader = document.createElement('div');
                                        subHeader.style.cssText = `
                                            display: grid;
                                            grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
                                            gap: 8px;
                                            font-weight: bold;
                                            margin-bottom: 4px;
                                            padding-bottom: 4px;
                                            border-bottom: 1px solid #3a3a3a;
                                        `;
                                        subHeader.innerHTML = `
                                            <span>Item</span>
                                            <span style="text-align: right;">Rate</span>
                                            <span style="text-align: right;">Avg Qty</span>
                                            <span style="text-align: right;">@</span>
                                            <span style="text-align: right;">EV</span>
                                        `;
                                        chestBreakdownDiv.appendChild(subHeader);
                                        for (const drop of chest.drops) {
                                            const dropRow = document.createElement('div');
                                            dropRow.style.cssText = `
                                                display: grid;
                                                grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
                                                gap: 8px;
                                                margin-bottom: 2px;
                                            `;
                                            dropRow.innerHTML = `
                                                <span>${drop.itemName}</span>
                                                <span style="text-align: right;">${formatPercentage(drop.dropRate, 1)}</span>
                                                <span style="text-align: right;">${drop.avgCount.toFixed(2)}</span>
                                                <span style="text-align: right;">${drop.hasPriceData ? formatNum(drop.priceEach) : '—'}</span>
                                                <span style="text-align: right;">${drop.hasPriceData ? formatNum(drop.expectedValue) : '—'}</span>
                                            `;
                                            chestBreakdownDiv.appendChild(dropRow);
                                        }
                                        const evTotalRow = document.createElement('div');
                                        evTotalRow.style.cssText = `
                                            margin-top: 4px;
                                            padding-top: 4px;
                                            border-top: 1px solid #3a3a3a;
                                            font-weight: bold;
                                            display: grid;
                                            grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
                                            gap: 8px;
                                        `;
                                        // The drop rows above sum to the drop-table EV; the total is
                                        // that sum scaled by the measured ratio, and says so
                                        evTotalRow.innerHTML = `
                                            <span>Total${chest.luckAdjustment ? ' (luck-adjusted)' : ''}</span>
                                            <span></span>
                                            <span></span>
                                            <span></span>
                                            <span style="text-align: right;">${formatNum(chest.evPerChest)}${chest.luckAdjustment ? '*' : ''}</span>
                                        `;
                                        chestBreakdownDiv.appendChild(evTotalRow);
                                        chestRow.after(chestBreakdownDiv);
                                    } else if (chestBreakdownDiv) {
                                        chestBreakdownDiv.remove();
                                        chestBreakdownDiv = null;
                                    }
                                };

                                breakdownDiv.appendChild(chestRow);
                            }

                            // Grand total
                            const incomeTotalRow = document.createElement('div');
                            incomeTotalRow.style.cssText = `
                                display: grid;
                                grid-template-columns: 2fr 1fr 1fr 1fr;
                                gap: 10px;
                                margin-top: 5px;
                                padding-top: 5px;
                                border-top: 1px solid #4a4a4a;
                                font-weight: bold;
                                color: ${textColor};
                            `;
                            incomeTotalRow.innerHTML = `
                                <span>Total</span>
                                <span></span>
                                <span></span>
                                <span style="text-align: right;">${row.value}</span>
                            `;
                            breakdownDiv.appendChild(incomeTotalRow);
                        } else if (row.breakdown && row.breakdown.length > 0) {
                            // Add key pricing note if applicable
                            if (row.showKeyPricingNote) {
                                const keyPricing = config.getSettingValue('profitCalc_keyPricingMode') || 'ask';
                                const keyPricingNote = document.createElement('div');
                                keyPricingNote.style.cssText = `
                                    font-size: 11px;
                                    color: #aaa;
                                    margin-bottom: 6px;
                                `;
                                keyPricingNote.textContent =
                                    `Pricing: ${keyPricing === 'bid' ? 'Bid (patient buy)' : 'Ask (instant buy)'}` +
                                    ' · each key costed at the cheaper of buying and crafting';
                                breakdownDiv.appendChild(keyPricingNote);
                            }

                            // Add header
                            const header = document.createElement('div');
                            header.style.cssText = `
                                display: grid;
                                grid-template-columns: 2fr 1fr 1fr 1fr;
                                gap: 10px;
                                font-weight: bold;
                                margin-bottom: 5px;
                                padding-bottom: 5px;
                                border-bottom: 1px solid #4a4a4a;
                                color: ${textColor};
                            `;
                            header.innerHTML = `
                                <span>Item</span>
                                <span style="text-align: right;">Consumed</span>
                                <span style="text-align: right;">Price</span>
                                <span style="text-align: right;">Cost</span>
                            `;
                            breakdownDiv.appendChild(header);

                            // Add each item
                            for (const item of row.breakdown) {
                                const itemRow = document.createElement('div');
                                itemRow.style.cssText = `
                                    display: grid;
                                    grid-template-columns: 2fr 1fr 1fr 1fr;
                                    gap: 10px;
                                    margin-bottom: 3px;
                                    color: ${textColor};
                                `;

                                // For daily: use MCS-style consumedPerDay directly
                                // For total: show actual quantities and costs for this session
                                const displayQty = row.isDaily ? item.consumedPerDay : item.count;

                                const displayPrice = item.pricePerItem; // Price stays the same

                                const displayCost = row.isDaily
                                    ? item.consumedPerDay * item.pricePerItem
                                    : item.totalCost;

                                itemRow.innerHTML = `
                                    <span>${item.itemName}</span>
                                    <span style="text-align: right;">${formatNum(displayQty)}</span>
                                    <span style="text-align: right;">${formatNum(displayPrice)}</span>
                                    <span style="text-align: right; color: #ff6b6b;">${formatNum(displayCost)}</span>
                                `;
                                breakdownDiv.appendChild(itemRow);

                                // Keys have two prices — the market's and the
                                // recipe's. The row above shows the one that
                                // was used; this says what the other was.
                                const keyNote = item.keyCost
                                    ? formatKeyCostNote(item.keyCost, { formatNumber: formatNum })
                                    : '';
                                if (keyNote) {
                                    const keyNoteDiv = document.createElement('div');
                                    keyNoteDiv.style.cssText = `
                                        font-size: 11px;
                                        color: #aaa;
                                        margin: -1px 0 5px 0;
                                        padding-left: 8px;
                                    `;
                                    keyNoteDiv.textContent = keyNote;
                                    breakdownDiv.appendChild(keyNoteDiv);
                                }
                            }

                            // Add total row
                            const totalRow = document.createElement('div');
                            totalRow.style.cssText = `
                                display: grid;
                                grid-template-columns: 2fr 1fr 1fr 1fr;
                                gap: 10px;
                                margin-top: 5px;
                                padding-top: 5px;
                                border-top: 1px solid #4a4a4a;
                                font-weight: bold;
                                color: ${textColor};
                            `;
                            totalRow.innerHTML = `
                                <span>Total</span>
                                <span></span>
                                <span></span>
                                <span style="text-align: right; color: #ff6b6b;">${row.value}</span>
                            `;
                            breakdownDiv.appendChild(totalRow);

                            // Add tracking info note (consumables only)
                            if (row.breakdown.length > 0 && !row.hideTrackingNote) {
                                const trackingNote = document.createElement('div');
                                trackingNote.style.cssText = `
                                    margin-top: 8px;
                                    padding-top: 8px;
                                    border-top: 1px solid #3a3a3a;
                                    font-size: 11px;
                                    color: #888;
                                    font-style: italic;
                                `;

                                // Format tracking duration
                                const formatTrackingDuration = (seconds) => {
                                    if (seconds < 60) return `${seconds}s`;
                                    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
                                    if (seconds < 86400) {
                                        const h = Math.floor(seconds / 3600);
                                        const m = Math.floor((seconds % 3600) / 60);
                                        return m > 0 ? `${h}h ${m}m` : `${h}h`;
                                    }
                                    // Days
                                    const d = Math.floor(seconds / 86400);
                                    const h = Math.floor((seconds % 86400) / 3600);
                                    if (d >= 30) {
                                        const months = Math.floor(d / 30);
                                        const days = d % 30;
                                        return days > 0 ? `${months}mo ${days}d` : `${months}mo`;
                                    }
                                    return h > 0 ? `${d}d ${h}h` : `${d}d`;
                                };

                                // Display tracking info with MCS-style calculation note
                                const firstItem = row.breakdown[0];
                                const trackingDuration = Math.floor(firstItem.elapsedSeconds || 0);
                                const hasActualData = firstItem.actualConsumed > 0;

                                if (!hasActualData) {
                                    trackingNote.textContent = `📊 Tracked ${formatTrackingDuration(trackingDuration)} - No consumption yet (rate decreases over time)`;
                                } else {
                                    trackingNote.textContent = `📊 Tracked ${formatTrackingDuration(trackingDuration)} - 90% actual + 10% baseline blend`;
                                }

                                breakdownDiv.appendChild(trackingNote);
                            }
                        } else if (breakdownDiv) {
                            breakdownDiv.textContent = 'No consumables used';
                            breakdownDiv.style.color = '#888';
                        }

                        rowDiv.after(breakdownDiv);
                    } else if (breakdownDiv) {
                        // Collapse - remove breakdown
                        breakdownDiv.remove();
                        breakdownDiv = null;
                    }
                };
            }

            rowDiv.appendChild(label);
            rowDiv.appendChild(value);
            statsContainer.appendChild(rowDiv);
        }

        // Drop list
        if (stats.lootList && stats.lootList.length > 0) {
            const dropHeader = document.createElement('div');
            dropHeader.textContent = 'Drops';
            dropHeader.style.cssText = `
                font-weight: bold;
                margin-top: 10px;
                margin-bottom: 5px;
                color: ${textColor};
                border-top: 1px solid #4a4a4a;
                padding-top: 8px;
            `;

            const dropList = document.createElement('div');
            dropList.style.cssText = `
                font-size: 13px;
                max-height: 200px;
                overflow-y: auto;
                padding-right: 5px;
            `;

            // Get current items sprite URL from DOM (to handle webpack hash changes)
            const itemsSpriteUrl = this.getItemsSpriteUrl();

            // Show ALL items with icons
            for (const item of stats.lootList) {
                const itemDiv = document.createElement('div');
                itemDiv.style.cssText = `
                    margin-bottom: 3px;
                    display: flex;
                    align-items: center;
                    gap: 5px;
                `;

                // Create item icon
                if (item.itemHrid && itemsSpriteUrl) {
                    const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    iconSvg.setAttribute('width', '16');
                    iconSvg.setAttribute('height', '16');
                    iconSvg.style.flexShrink = '0';

                    // Determine icon name based on HRID type
                    let iconName;
                    if (item.itemHrid.startsWith('/items/')) {
                        // Regular items: /items/cheese → cheese
                        iconName = item.itemHrid.split('/').pop();
                    } else if (item.itemHrid.startsWith('/ability_books/')) {
                        // Ability books: /ability_books/fireball → ability_book
                        iconName = 'ability_book';
                    } else if (item.itemHrid === '/consumables/coin') {
                        // Coins: /consumables/coin → coin
                        iconName = 'coin';
                    } else {
                        // Other types: extract last part of HRID
                        iconName = item.itemHrid.split('/').pop();
                    }

                    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
                    use.setAttribute('href', `${itemsSpriteUrl}#${iconName}`);
                    iconSvg.appendChild(use);

                    itemDiv.appendChild(iconSvg);
                }

                // Create text content with KMB formatting
                const textSpan = document.createElement('span');
                const rarityColor = this.getRarityColor(item.rarity);
                textSpan.innerHTML = `<span style="color: ${textColor};">${formatNum(item.count)}</span> <span style="color: ${rarityColor};">× ${item.itemName}</span>`;
                itemDiv.appendChild(textSpan);

                // Attach EV tooltip for openable containers (chests, crates, etc.)
                if (
                    expectedValueCalculator.isInitialized &&
                    expectedValueCalculator.getCachedValue(item.itemHrid) !== null
                ) {
                    itemDiv.style.cursor = 'help';
                    itemDiv.addEventListener('mouseenter', () => this.showChestTooltip(itemDiv, item.itemHrid));
                    itemDiv.addEventListener('mouseleave', () => this.hideChestTooltip());
                }

                dropList.appendChild(itemDiv);
            }

            statsContainer.appendChild(dropHeader);
            statsContainer.appendChild(dropList);
        }

        // Assemble card
        card.appendChild(nameHeader);
        card.appendChild(statsContainer);

        return card;
    }

    /**
     * Get color for item rarity
     * @param {number} rarity - Item rarity
     * @returns {string} Color hex code
     */
    getRarityColor(rarity) {
        switch (rarity) {
            case 6:
                return '#64dbff'; // Mythic
            case 5:
                return '#ff8888'; // Legendary
            case 4:
                return '#ffa844'; // Epic
            case 3:
                return '#e586ff'; // Rare
            case 2:
                return '#a9d5ff'; // Uncommon
            case 1:
                return '#b9f1be'; // Common
            default:
                return '#b4b4b4'; // Normal
        }
    }

    /**
     * Build HTML for chest tooltip matching the inventory EV tooltip format
     * @param {string} itemHrid - Item HRID
     * @returns {string} HTML string
     */
    buildChestTooltipHTML(itemHrid) {
        const evData = expectedValueCalculator.isInitialized
            ? expectedValueCalculator.calculateExpectedValue(itemHrid)
            : null;
        if (!evData) return null;

        const formatPrice = (val) => formatKMB(Math.round(val));
        const showDropsSetting = config.getSettingValue('expectedValue_showDrops', 'All');

        let html = `<div style="font-weight:bold;margin-bottom:4px;">EXPECTED VALUE</div>`;
        html += `<div style="font-size:0.9em;margin-left:8px;">`;
        html += `<div style="color:${config.COLOR_TOOLTIP_PROFIT};font-weight:bold;">Expected Return: ${formatPrice(evData.expectedValue)}</div>`;
        html += `</div>`;

        if (showDropsSetting !== 'None' && evData.drops.length > 0) {
            html += `<div style="border-top:1px solid rgba(255,255,255,0.2);margin:8px 0;"></div>`;

            let dropsToShow = evData.drops;
            let headerLabel = 'All Drops';
            if (showDropsSetting === 'Top 5') {
                dropsToShow = evData.drops.slice(0, 5);
                headerLabel = 'Top 5 Drops';
            } else if (showDropsSetting === 'Top 10') {
                dropsToShow = evData.drops.slice(0, 10);
                headerLabel = 'Top 10 Drops';
            }

            html += `<div style="font-weight:bold;margin-bottom:4px;">${headerLabel} (${evData.drops.length} total):</div>`;
            html += `<div style="font-size:0.9em;margin-left:8px;">`;

            for (const drop of dropsToShow) {
                if (!drop.hasPriceData) {
                    html += `<div style="color:${config.COLOR_TEXT_SECONDARY};">• ${drop.itemName} (${formatPercentage(drop.dropRate, 2)}): ${drop.avgCount.toFixed(2)} avg → No price data</div>`;
                } else {
                    const dropRatePercent = formatPercentage(drop.dropRate, 2);
                    html += `<div>• ${drop.itemName} (${dropRatePercent}): ${drop.avgCount.toFixed(2)} avg → ${formatPrice(drop.expectedValue)}</div>`;
                }
            }

            html += `</div>`;
            html += `<div style="border-top:1px solid rgba(255,255,255,0.2);margin:4px 0;"></div>`;
            html += `<div style="font-size:0.9em;margin-left:8px;font-weight:bold;">Total from ${evData.drops.length} drops: ${formatPrice(evData.expectedValue)}</div>`;
        }

        return html;
    }

    /**
     * Show chest EV tooltip near a drop list item
     * @param {HTMLElement} itemDiv - The hovered item element
     * @param {string} itemHrid - Item HRID
     */
    showChestTooltip(itemDiv, itemHrid) {
        this.hideChestTooltip();

        const html = this.buildChestTooltipHTML(itemHrid);
        if (!html) return;

        const tooltip = document.createElement('div');
        tooltip.className = 'toolasha-chest-ev-tooltip';
        tooltip.style.cssText = `
            position: fixed;
            background: #1a1a1a;
            border: 1px solid #4a4a4a;
            border-radius: 6px;
            padding: 10px 12px;
            font-size: 13px;
            color: ${config.COLOR_TEXT_PRIMARY};
            max-width: 320px;
            overflow-y: auto;
            z-index: 20000;
            pointer-events: none;
            line-height: 1.4;
            visibility: hidden;
        `;
        tooltip.innerHTML = html;
        document.body.appendChild(tooltip);

        // Measure after paint so offsetHeight is accurate
        const rect = itemDiv.getBoundingClientRect();
        const tipW = tooltip.offsetWidth || 320;
        const tipH = tooltip.offsetHeight;

        const spaceAbove = rect.top - 8;
        const spaceBelow = window.innerHeight - rect.bottom - 8;

        let top;
        if (spaceAbove >= tipH || spaceAbove >= spaceBelow) {
            // Show above — cap height to available space
            const maxH = Math.min(tipH, spaceAbove);
            tooltip.style.maxHeight = `${maxH}px`;
            top = rect.top - maxH - 6;
        } else {
            // Show below — cap height to available space
            const maxH = Math.min(tipH, spaceBelow);
            tooltip.style.maxHeight = `${maxH}px`;
            top = rect.bottom + 6;
        }

        let left = rect.left;
        if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
        if (left < 8) left = 8;

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
        tooltip.style.visibility = 'visible';

        this.chestTooltip = tooltip;
    }

    /**
     * Hide and remove the chest EV tooltip
     */
    hideChestTooltip() {
        if (this.chestTooltip) {
            this.chestTooltip.remove();
            this.chestTooltip = null;
        }
    }

    /**
     * Close the popup
     */
    closePopup() {
        this.hideChestTooltip();
        if (this.popup) {
            this.popup.remove();
            this.popup = null;
        }
    }

    /**
     * Cleanup
     */
    cleanup() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        this.closePopup();

        // Remove injected buttons
        const buttons = document.querySelectorAll('.toolasha-combat-stats-btn');
        for (const button of buttons) {
            button.remove();
        }

        this.isInitialized = false;
    }
}

const combatStatsUI = new CombatStatsUI();

export default combatStatsUI;
