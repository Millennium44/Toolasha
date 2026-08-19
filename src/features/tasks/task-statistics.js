/**
 * Task Statistics
 * Adds a Statistics button to the Tasks panel tab bar
 * Shows task overflow time, expected rewards, and completion estimates
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import marketAPI from '../../api/marketplace.js';
import {
    calculateTaskProfit,
    calculateTaskTokenValue,
    calculateTaskRewardValue,
    getCowbellValue,
} from './task-profit-calculator.js';
import { calculateTaskCompletionSeconds } from './task-profit-display.js';
import taskCompletionTracker from './task-completion-tracker.js';
import taskRerollTracker from './task-reroll-tracker.js';
import { forecastTaskSlots } from './task-slot-forecast.js';
import { timeReadable, formatKMB, formatDateTime } from '../../utils/formatters.js';
import { TOOLASHA } from '../../utils/selectors.js';

class TaskStatistics {
    constructor() {
        this.isInitialized = false;
        this.overlay = null;
        this.unregisterHandlers = [];
    }

    /**
     * Setup setting change listener (always active)
     */
    setupSettingListener() {
        config.onSettingChange('taskStatistics', (enabled) => {
            if (enabled) {
                this.initialize();
            } else {
                this.disable();
            }
        });
    }

    /**
     * Initialize the task statistics feature
     */
    initialize() {
        if (!config.getSetting('taskStatistics')) {
            return;
        }

        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;

        // Try to inject button immediately
        this.injectButton();

        // Watch for Tasks panel appearing
        const unregister = domObserver.onClass('TaskStatistics', 'TasksPanel_tabsComponentContainer', () => {
            this.injectButton();
        });
        this.unregisterHandlers.push(unregister);
    }

    /**
     * Inject Statistics button into Tasks panel tab bar
     */
    injectButton() {
        // Find the tab container within the Tasks panel
        const tabsComponentContainer = document.querySelector('[class*="TasksPanel_tabsComponentContainer"]');
        if (!tabsComponentContainer) {
            return;
        }

        const tabsContainer = tabsComponentContainer.querySelector(
            '[class*="TabsComponent_tabsContainer"] > div > div > div'
        );
        if (!tabsContainer) {
            return;
        }

        // Check if button already exists
        if (tabsContainer.querySelector(TOOLASHA.TASK_STATS_BTN)) {
            return;
        }

        // Create button matching MUI tab styling
        const button = document.createElement('div');
        button.className = 'MuiButtonBase-root MuiTab-root MuiTab-textColorPrimary css-1q2h7u5 toolasha-task-stats-btn';
        button.textContent = 'Statistics';
        button.style.cursor = 'pointer';
        button.onclick = () => this.showPopup();

        // Insert after last tab
        const lastTab = tabsContainer.children[tabsContainer.children.length - 1];
        tabsContainer.insertBefore(button, lastTab.nextSibling);
    }

    /**
     * Remove Statistics button
     */
    removeButton() {
        const buttons = document.querySelectorAll(TOOLASHA.TASK_STATS_BTN);
        for (const button of buttons) {
            button.remove();
        }
    }

    /**
     * Show statistics popup
     */
    async showPopup() {
        // Close any existing popup
        this.closePopup();

        // Ensure market data is loaded for token valuation
        if (!marketAPI.isLoaded()) {
            await marketAPI.fetch();
        }

        const statsData = await this.calculateAllStatistics();
        this.createPopup(statsData);
    }

    /**
     * Calculate all statistics
     * @returns {Object} Statistics data
     */
    async calculateAllStatistics() {
        const overflowData = this.calculateOverflowTime();
        const slotStatus = this.calculateSlotStatus();
        const rewardsSummary = await this.calculateRewardsSummary();
        const completions = await this.calculateCompletions();

        return {
            overflow: overflowData,
            slots: slotStatus,
            rewards: rewardsSummary,
            completions,
        };
    }

    /**
     * What the board has actually paid out, and what it cost to get there.
     *
     * The rest of this panel is a forecast: the board as it stands, priced. This
     * is the only part of it made of things that happened — claims the
     * completion tracker recorded, set against the reroll spend on the tasks
     * that have already left the board. The two come from different recorders
     * and are joined here because that is the only place both are in hand.
     *
     * @param {number} [now] - Milliseconds since the epoch
     * @returns {Promise<Object|null>} Completion figures, or null when they cannot be read
     */
    async calculateCompletions(now = Date.now()) {
        try {
            const { rates, recent } = await taskCompletionTracker.summary(now);
            const week = rates.week;

            const tokenValue = calculateTaskTokenValue();
            const perToken = tokenValue?.totalPerToken;
            const rewardValue = Number.isFinite(perToken) ? week.coins + week.tokens * perToken : null;

            // Only the rerolls paid on tasks retired inside the same window, so
            // the two halves of the net are measuring the same seven days
            const windowStart = now - 7 * 24 * 60 * 60 * 1000;
            const history = await taskRerollTracker.loadHistory();
            let gold = 0;
            let cowbells = 0;
            for (const retired of history) {
                if (!(retired?.retiredAt >= windowStart)) continue;
                gold += retired.goldSpent || 0;
                cowbells += retired.cowbellsSpent || 0;
            }
            const spendValue = gold + cowbells * getCowbellValue();

            return {
                week,
                session: rates.session,
                recent: recent.slice(0, 5),
                rerollSpend: { gold, cowbells, totalValue: spendValue },
                rewardValue,
                netValue: rewardValue === null ? null : rewardValue - spendValue,
            };
        } catch (error) {
            console.error('[TaskStatistics] Reading the recorded completions failed:', error);
            return null;
        }
    }

    /**
     * Get active random tasks from characterQuests
     * @returns {Array} Active random task quests
     */
    getActiveTasks() {
        return (dataManager.characterQuests || []).filter(
            (q) => q.category === '/quest_category/random_task' && q.status === '/quest_status/in_progress'
        );
    }

    /**
     * Calculate task overflow time
     *
     * The arithmetic is `task-slot-forecast.js`, which the task-slot
     * notification projects from too — one definition of when the board fills,
     * so the panel and the alert cannot come to disagree about it. What this
     * panel calls "overflow" is the forecast's `wastesAt`: the first task that
     * arrives with nowhere to go, one cadence after the last free slot is taken.
     *
     * @returns {Object} Overflow time data
     */
    calculateOverflowTime() {
        const forecast = forecastTaskSlots({
            characterInfo: dataManager.characterData?.characterInfo,
            activeTaskCount: this.getActiveTasks().length,
        });
        if (!forecast.ok) {
            return { error: 'Character info not available' };
        }

        return {
            overflowDate: new Date(forecast.wastesAt),
            msUntilOverflow: forecast.msUntilWaste,
            isOverflowing: forecast.msUntilWaste <= 0,
            taskSlotCap: forecast.slotCap,
            taskCooldownHours: forecast.cooldownHours,
            usedSlots: forecast.usedSlots,
            availableSlots: forecast.freeSlots,
        };
    }

    /**
     * Calculate slot status
     * @returns {Object} Slot status data
     */
    calculateSlotStatus() {
        const characterInfo = dataManager.characterData?.characterInfo;
        if (!characterInfo) {
            return { error: 'Character info not available' };
        }

        const unreadTaskCount = characterInfo.unreadTaskCount || 0;
        const activeTaskCount = this.getActiveTasks().length;

        return {
            used: unreadTaskCount + activeTaskCount,
            total: characterInfo.taskSlotCap,
            unread: unreadTaskCount,
            active: activeTaskCount,
        };
    }

    /**
     * Calculate aggregated rewards summary across all active tasks
     * @returns {Object} Rewards summary
     */
    async calculateRewardsSummary() {
        const activeTasks = this.getActiveTasks();

        let totalCoins = 0;
        let totalTokens = 0;
        const taskDetails = [];

        // Parse rewards from itemRewardsJSON
        for (const quest of activeTasks) {
            let coinReward = 0;
            let tokenReward = 0;

            if (quest.itemRewardsJSON) {
                try {
                    const rewards = JSON.parse(quest.itemRewardsJSON);
                    for (const reward of rewards) {
                        if (reward.itemHrid === '/items/coin') {
                            coinReward = reward.count;
                        } else if (reward.itemHrid === '/items/task_token') {
                            tokenReward = reward.count;
                        }
                    }
                } catch (error) {
                    console.error('[TaskStatistics] Failed to parse itemRewardsJSON:', error);
                }
            }

            totalCoins += coinReward;
            totalTokens += tokenReward;

            // Determine task type and description
            const isCombat = quest.type === '/quest_type/monster';
            const actionHrid = quest.actionHrid || '';
            const monsterHrid = quest.monsterHrid || '';

            // Get display name
            let taskName = '';
            if (isCombat && monsterHrid) {
                const monsterDetails = dataManager.getInitClientData()?.combatMonsterDetailMap?.[monsterHrid];
                taskName = monsterDetails?.name || monsterHrid.split('/').pop();
            } else if (actionHrid) {
                const actionDetails = dataManager.getInitClientData()?.actionDetailMap?.[actionHrid];
                taskName = actionDetails?.name || actionHrid.split('/').pop();
            }

            // Calculate action profit for non-combat tasks
            let actionProfit = null;
            let completionSeconds = null;

            if (!isCombat && actionHrid) {
                try {
                    // Get action details to build proper task description
                    const actionDetails = dataManager.getInitClientData()?.actionDetailMap?.[actionHrid];
                    if (actionDetails) {
                        // Build description in format "Skill - Action Name"
                        // Extract skill name from type field like '/action_types/foraging'
                        const skillName = actionDetails.type?.split('/').pop() || '';
                        const formattedSkill =
                            skillName.charAt(0).toUpperCase() + skillName.slice(1).replace(/_/g, ' ');
                        const actionName = actionDetails.name;
                        const description = `${formattedSkill} - ${actionName}`;

                        const taskData = {
                            description,
                            coinReward,
                            taskTokenReward: tokenReward,
                            quantity: quest.goalCount,
                            currentProgress: quest.currentCount || 0,
                        };
                        const profitData = await calculateTaskProfit(taskData);
                        if (profitData && profitData.action) {
                            actionProfit = profitData.action.totalValue || profitData.action.totalProfit || 0;
                            completionSeconds = calculateTaskCompletionSeconds(profitData);
                        }
                    }
                } catch (error) {
                    console.error('[TaskStatistics] Failed to calculate profit for task:', taskName, error);
                }
            }

            taskDetails.push({
                name: taskName,
                isCombat,
                coinReward,
                tokenReward,
                actionProfit,
                completionSeconds,
                goalCount: quest.goalCount,
                currentCount: quest.currentCount || 0,
            });
        }

        // Token valuation — Purple's Gift accrues per task, so the whole board's
        // task count is what prorates it, not the token total
        const tokenValue = calculateTaskTokenValue();
        const rewardValue = calculateTaskRewardValue(totalCoins, totalTokens, activeTasks.length);

        // What the board on screen has already cost in rerolls
        const rerollSpend = this.calculateRerollSpend(activeTasks);

        // Sum action profits
        let totalActionProfit = 0;
        let totalCompletionSeconds = 0;
        let hasActionProfit = false;

        for (const detail of taskDetails) {
            if (detail.actionProfit !== null) {
                totalActionProfit += detail.actionProfit;
                hasActionProfit = true;
            }
            if (detail.completionSeconds !== null) {
                totalCompletionSeconds += detail.completionSeconds;
            }
        }

        const combinedTotal = rewardValue.total + (hasActionProfit ? totalActionProfit : 0);

        return {
            totalCoins,
            totalTokens,
            tokenValue,
            rewardValue,
            rerollSpend,
            totalActionProfit: hasActionProfit ? totalActionProfit : null,
            totalCompletionSeconds: totalCompletionSeconds > 0 ? totalCompletionSeconds : null,
            combinedTotal,
            netTotal: combinedTotal - rerollSpend.totalValue,
            taskDetails,
        };
    }

    /**
     * Sum what the tasks currently on the board have already cost in rerolls.
     *
     * Reroll spend is tracked per task by the reroll tracker; joining it here is
     * what turns "these tasks are worth X" into "these tasks are worth X, and
     * you have already paid Y to be looking at them".
     *
     * @param {Array<Object>} activeTasks - Active quests
     * @returns {{gold: number, cowbells: number, cowbellValue: number, totalValue: number}}
     */
    calculateRerollSpend(activeTasks) {
        let gold = 0;
        let cowbells = 0;

        for (const quest of activeTasks) {
            const tracked = taskRerollTracker.taskRerollData?.get(quest.id);
            const coinCount = tracked?.coinRerollCount ?? quest.coinRerollCount ?? 0;
            const cowbellCount = tracked?.cowbellRerollCount ?? quest.cowbellRerollCount ?? 0;
            gold += taskRerollTracker.calculateGoldSpent(coinCount);
            cowbells += taskRerollTracker.calculateCowbellSpent(cowbellCount);
        }

        // Cowbells have no listing of their own — price them through the Bag of
        // 10 Cowbells, the same basis the net worth calculator uses
        const cowbellValue = getCowbellValue();

        return {
            gold,
            cowbells,
            cowbellValue,
            totalValue: gold + cowbells * cowbellValue,
        };
    }

    /**
     * Create and display the statistics popup
     * @param {Object} statsData - Calculated statistics data
     */
    createPopup(statsData) {
        const textColor = config.COLOR_TEXT_PRIMARY;

        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'toolasha-task-stats-overlay';
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
        popup.style.cssText = `
            background: #1a1a1a;
            border: 2px solid #3a3a3a;
            border-radius: 8px;
            padding: 20px;
            max-width: 500px;
            max-height: 90%;
            overflow-y: auto;
            color: ${textColor};
            min-width: 360px;
        `;

        // Header
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
        title.textContent = 'Task Statistics';
        title.style.cssText = `margin: 0; color: ${textColor}; font-size: 24px;`;

        const closeButton = document.createElement('button');
        closeButton.textContent = '\u00d7';
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

        header.appendChild(title);
        header.appendChild(closeButton);
        popup.appendChild(header);

        // Content sections
        popup.appendChild(this.createOverflowSection(statsData.overflow, textColor));
        popup.appendChild(this.createRewardsSection(statsData.rewards, textColor));
        if (statsData.completions) {
            popup.appendChild(this.createCompletionsSection(statsData.completions, textColor));
        }
        popup.appendChild(this.createActionProfitSection(statsData.rewards));
        popup.appendChild(this.createCompletionTimeSection(statsData.rewards, textColor));

        // Close on overlay click
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                this.closePopup();
            }
        };

        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        this.overlay = overlay;
    }

    /**
     * Create a section card element
     * @param {string} titleText - Section title
     * @returns {HTMLElement} Section container
     */
    createSection(titleText) {
        const section = document.createElement('div');
        section.style.cssText = `
            background: #2a2a2a;
            border: 1px solid #3a3a3a;
            border-radius: 6px;
            padding: 12px;
            margin-bottom: 12px;
        `;

        const sectionTitle = document.createElement('div');
        sectionTitle.textContent = titleText;
        sectionTitle.style.cssText = `
            color: ${config.COLOR_ACCENT};
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 8px;
        `;
        section.appendChild(sectionTitle);

        return section;
    }

    /**
     * Create a row with label and value
     * @param {string} label - Row label
     * @param {string} value - Row value
     * @param {string} valueColor - Value text color
     * @returns {HTMLElement} Row element
     */
    createRow(label, value, valueColor = config.COLOR_TEXT_PRIMARY) {
        const row = document.createElement('div');
        row.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 3px 0;
            font-size: 13px;
        `;

        const labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        labelSpan.style.color = config.COLOR_TEXT_SECONDARY;

        const valueSpan = document.createElement('span');
        valueSpan.textContent = value;
        valueSpan.style.color = valueColor;

        row.appendChild(labelSpan);
        row.appendChild(valueSpan);

        return row;
    }

    /**
     * Create overflow time section
     * @param {Object} overflow - Overflow data
     * @param {string} textColor - Text color
     * @returns {HTMLElement} Section element
     */
    createOverflowSection(overflow, textColor) {
        const section = this.createSection('Task Slots');

        if (overflow.error) {
            section.appendChild(this.createRow('Status', overflow.error, config.COLOR_LOSS));
            return section;
        }

        section.appendChild(this.createRow('Slots Used', `${overflow.usedSlots} / ${overflow.taskSlotCap}`, textColor));
        section.appendChild(this.createRow('Available', `${overflow.availableSlots}`, textColor));
        section.appendChild(
            this.createRow('Cooldown', `${overflow.taskCooldownHours}h per task`, config.COLOR_TEXT_SECONDARY)
        );

        // Overflow time
        if (overflow.isOverflowing) {
            section.appendChild(this.createRow('Status', 'Tasks full!', config.COLOR_LOSS));
        } else {
            const overflowTimeStr = timeReadable(overflow.msUntilOverflow / 1000);
            const overflowDateStr = formatDateTime(overflow.overflowDate);
            section.appendChild(this.createRow('Full in', overflowTimeStr, config.COLOR_INFO));
            section.appendChild(this.createRow('Full at', overflowDateStr, config.COLOR_TEXT_SECONDARY));
        }

        return section;
    }

    /**
     * Create rewards summary section
     * @param {Object} rewards - Rewards data
     * @param {string} textColor - Text color
     * @returns {HTMLElement} Section element
     */
    createRewardsSection(rewards, textColor) {
        const section = this.createSection('Expected Rewards');

        section.appendChild(this.createRow('Total Coins', formatKMB(rewards.totalCoins), config.COLOR_GOLD));
        section.appendChild(this.createRow('Total Task Tokens', String(rewards.totalTokens), textColor));

        if (!rewards.rewardValue.error) {
            const tokenValueStr = `${formatKMB(Math.round(rewards.rewardValue.breakdown.tokenValue))} each`;
            section.appendChild(this.createRow('Token Value', tokenValueStr, config.COLOR_TEXT_SECONDARY));
            section.appendChild(
                this.createRow(
                    'Tokens Value',
                    formatKMB(Math.round(rewards.rewardValue.taskTokens)),
                    config.COLOR_PROFIT
                )
            );
            section.appendChild(
                this.createRow(
                    "Purple's Gift",
                    formatKMB(Math.round(rewards.rewardValue.purpleGift)),
                    config.COLOR_ESSENCE
                )
            );

            // Separator
            const separator = document.createElement('div');
            separator.style.cssText = 'border-top: 1px solid #3a3a3a; margin: 6px 0;';
            section.appendChild(separator);

            section.appendChild(
                this.createRow(
                    'Total Reward Value',
                    formatKMB(Math.round(rewards.rewardValue.total)),
                    config.COLOR_ACCENT
                )
            );
        } else {
            section.appendChild(this.createRow('Token Value', 'Loading...', config.COLOR_TEXT_SECONDARY));
        }

        return section;
    }

    /**
     * Create action profit section with per-task breakdown
     * @param {Object} rewards - Rewards data with task details
     * @returns {HTMLElement} Section element
     */
    createActionProfitSection(rewards) {
        const section = this.createSection('Action Profit');

        for (const detail of rewards.taskDetails) {
            const profitStr = detail.isCombat
                ? 'N/A (combat)'
                : detail.actionProfit !== null
                  ? formatKMB(Math.round(detail.actionProfit))
                  : 'N/A';

            const profitColor = detail.isCombat
                ? config.COLOR_TEXT_SECONDARY
                : detail.actionProfit !== null && detail.actionProfit >= 0
                  ? config.COLOR_PROFIT
                  : detail.actionProfit !== null
                    ? config.COLOR_LOSS
                    : config.COLOR_TEXT_SECONDARY;

            section.appendChild(this.createRow(detail.name, profitStr, profitColor));
        }

        // Separator and total
        const separator = document.createElement('div');
        separator.style.cssText = 'border-top: 1px solid #3a3a3a; margin: 6px 0;';
        section.appendChild(separator);

        const totalStr = rewards.totalActionProfit !== null ? formatKMB(Math.round(rewards.totalActionProfit)) : 'N/A';
        const totalColor =
            rewards.totalActionProfit !== null && rewards.totalActionProfit >= 0
                ? config.COLOR_PROFIT
                : rewards.totalActionProfit !== null
                  ? config.COLOR_LOSS
                  : config.COLOR_TEXT_SECONDARY;

        section.appendChild(this.createRow('Total Action Profit', totalStr, totalColor));

        // Combined total
        const separator2 = document.createElement('div');
        separator2.style.cssText = 'border-top: 1px solid #3a3a3a; margin: 6px 0;';
        section.appendChild(separator2);

        section.appendChild(
            this.createRow('Combined Total', formatKMB(Math.round(rewards.combinedTotal)), config.COLOR_ACCENT)
        );

        // Reroll spend already sunk into this board, and the total net of it
        const spend = rewards.rerollSpend;
        if (spend && spend.totalValue > 0) {
            const spendParts = [];
            if (spend.gold > 0) spendParts.push(`${formatKMB(Math.round(spend.gold))}💰`);
            if (spend.cowbells > 0) spendParts.push(`${spend.cowbells}🔔`);
            section.appendChild(
                this.createRow(
                    'Reroll Spend',
                    `-${formatKMB(Math.round(spend.totalValue))} (${spendParts.join(' + ')})`,
                    config.COLOR_LOSS
                )
            );
            section.appendChild(
                this.createRow(
                    'Cowbell Value',
                    `${formatKMB(Math.round(spend.cowbellValue))} each`,
                    config.COLOR_TEXT_SECONDARY
                )
            );

            const netColor = rewards.netTotal >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS;
            section.appendChild(this.createRow('Net of Rerolls', formatKMB(Math.round(rewards.netTotal)), netColor));
        }

        return section;
    }

    /**
     * Create the recorded-completions section.
     *
     * Everything above it is what the board is worth; this is what tasks have
     * paid. The rate is labelled wall-clock in the panel as well as in the tile,
     * because a number carried between two places loses its caveat exactly once.
     *
     * @param {Object} completions - From {@link calculateCompletions}
     * @param {string} textColor - Text color
     * @returns {HTMLElement} Section element
     */
    createCompletionsSection(completions, textColor) {
        const section = this.createSection('Claimed Tasks (last 7 days)');
        const week = completions.week;

        if (!week.completions) {
            section.appendChild(this.createRow('Claimed', 'Nothing recorded yet', config.COLOR_TEXT_SECONDARY));
            return section;
        }

        section.appendChild(this.createRow('Tasks Claimed', String(week.completions), textColor));
        section.appendChild(this.createRow('Task Tokens', String(week.tokens), textColor));
        section.appendChild(this.createRow('Coins', formatKMB(week.coins), config.COLOR_GOLD));

        if (week.tokensPerHour === null) {
            section.appendChild(this.createRow('Rate', 'Needs a second claim', config.COLOR_TEXT_SECONDARY));
        } else {
            const hours = week.spanMs / 3600000;
            section.appendChild(this.createRow('Tokens / hr', `${week.tokensPerHour.toFixed(1)}`, config.COLOR_ACCENT));
            section.appendChild(
                this.createRow('Coins / hr', formatKMB(Math.round(week.coinsPerHour)), config.COLOR_GOLD)
            );
            section.appendChild(
                this.createRow('Measured over', `${hours.toFixed(1)}h wall-clock`, config.COLOR_TEXT_SECONDARY)
            );
        }

        // What those claims cost: the rerolls paid on tasks retired in the same
        // window, and what is left after them
        const spend = completions.rerollSpend;
        if (spend.totalValue > 0) {
            const parts = [];
            if (spend.gold > 0) parts.push(`${formatKMB(Math.round(spend.gold))}💰`);
            if (spend.cowbells > 0) parts.push(`${spend.cowbells}🔔`);
            section.appendChild(
                this.createRow(
                    'Reroll Spend',
                    `-${formatKMB(Math.round(spend.totalValue))} (${parts.join(' + ')})`,
                    config.COLOR_LOSS
                )
            );
        }

        if (completions.netValue !== null) {
            const separator = document.createElement('div');
            separator.style.cssText = 'border-top: 1px solid #3a3a3a; margin: 6px 0;';
            section.appendChild(separator);
            section.appendChild(
                this.createRow(
                    'Net Task Income',
                    formatKMB(Math.round(completions.netValue)),
                    completions.netValue >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS
                )
            );
        }

        for (const entry of completions.recent) {
            const when = formatDateTime(new Date(entry.completedAt), { includeSeconds: false });
            section.appendChild(
                this.createRow(
                    `${entry.name || 'Task'} — ${when}`,
                    `${entry.tokens}🎫 + ${formatKMB(entry.coins)}`,
                    config.COLOR_TEXT_SECONDARY
                )
            );
        }

        return section;
    }

    /**
     * Create completion time section
     * @param {Object} rewards - Rewards data with task details
     * @param {string} textColor - Text color
     * @returns {HTMLElement} Section element
     */
    createCompletionTimeSection(rewards, textColor) {
        const section = this.createSection('Completion Time');

        for (const detail of rewards.taskDetails) {
            const timeStr = detail.isCombat
                ? 'N/A (combat)'
                : detail.completionSeconds !== null
                  ? timeReadable(detail.completionSeconds)
                  : 'N/A';

            const progressStr = detail.currentCount > 0 ? ` (${detail.currentCount}/${detail.goalCount})` : '';

            section.appendChild(
                this.createRow(
                    detail.name + progressStr,
                    timeStr,
                    detail.isCombat ? config.COLOR_TEXT_SECONDARY : textColor
                )
            );
        }

        // Separator and total
        const separator = document.createElement('div');
        separator.style.cssText = 'border-top: 1px solid #3a3a3a; margin: 6px 0;';
        section.appendChild(separator);

        const totalTimeStr =
            rewards.totalCompletionSeconds !== null ? timeReadable(rewards.totalCompletionSeconds) : 'N/A';

        section.appendChild(this.createRow('Total (non-combat)', totalTimeStr, config.COLOR_INFO));

        return section;
    }

    /**
     * Close the statistics popup
     */
    closePopup() {
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
    }

    /**
     * Disable and cleanup
     */
    disable() {
        try {
            this.closePopup();
            this.removeButton();

            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];

            this.isInitialized = false;
        } catch (error) {
            console.error('[Task Statistics] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const taskStatistics = new TaskStatistics();

taskStatistics.setupSettingListener();

export default taskStatistics;
