/**
 * Chat Commands Module
 * Adds /item, /wiki, /market and /shrines commands to in-game chat
 * Port of MWI Game Commands by Mists, integrated into Toolasha architecture
 *
 * Every command is intercepted before the game sees the Enter key, so nothing
 * typed here is ever sent to the server: `handleKeydown` cancels the event and
 * clears the input, and anything a command has to say is appended straight into
 * the visible chat history element as a local-only message.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { moveScopedData } from '../../utils/scoped-data-repair.js';
import { resetAdoptionDecision, requestAdoptionConsent } from '../../utils/adoption-consent.js';

/**
 * Everything the client currently believes about guild shrines.
 *
 * Two maps decide what the upgrade advisor and the shrine planner can say, and
 * neither is reliably present: they ride along on guild traffic, which for most
 * sessions means they arrive only once the guild page has been opened. When a
 * shrine row reads "unknown" this is the command that says whether that is
 * because nothing arrived, because what arrived was empty, or because what is in
 * memory came out of storage from an earlier session.
 *
 * Pure apart from reading the data manager, and exported so both the chat
 * command and the console helper report the same object.
 *
 * @returns {{buffs: Array<Object>, buildings: Array<Object>, capturedAt: number|null,
 *   capturedAtText: string|null, hydrated: boolean, hasData: boolean}} What is known
 */
export function collectShrineDebug() {
    const buffMap = dataManager.characterGuildBuffMap || {};
    const buildingMap = dataManager.guildBuildingLevelMap || {};
    const detailMap = dataManager.getInitClientData?.()?.guildBuffDetailMap || {};

    const buffs = Object.entries(buffMap)
        .map(([buffHrid, entry]) => ({
            buffHrid,
            level: Number(entry?.level) || 0,
            shrineHrid: detailMap[buffHrid]?.shrineHrid ?? null,
            isCombat: detailMap[buffHrid] ? Boolean(detailMap[buffHrid].isCombat) : null,
        }))
        .sort((a, b) => a.buffHrid.localeCompare(b.buffHrid));

    const buildings = Object.entries(buildingMap)
        .map(([hrid, level]) => ({ hrid, level: Number(level) || 0 }))
        .sort((a, b) => a.hrid.localeCompare(b.hrid));

    const capturedAt = dataManager.getGuildShrineCapturedAt?.() ?? null;

    return {
        buffs,
        buildings,
        capturedAt,
        capturedAtText: Number.isFinite(capturedAt) ? new Date(capturedAt).toLocaleString() : null,
        hydrated: Boolean(dataManager.isGuildShrineHydrated?.()),
        hasData: buffs.length > 0 || buildings.length > 0,
    };
}

/**
 * The shrine report as the lines a chat message shows.
 * @param {Object} report - From {@link collectShrineDebug}
 * @returns {string} Printable report
 */
export function formatShrineReport(report) {
    const lines = ['Toolasha /shrines'];

    if (!report?.hasData) {
        lines.push('no data yet — open the guild page');
        lines.push('Shrine levels only arrive on guild traffic, so nothing is known until the guild panel is opened.');
        return lines.join('\n');
    }

    const age = report.capturedAtText ? `captured ${report.capturedAtText}` : 'capture time unknown';
    const provenance = report.hydrated
        ? 'hydrated from storage (an earlier session), not read this session'
        : 'read live this session';
    lines.push(`${age} — ${provenance}`);

    lines.push(`Buff levels (characterGuildBuffMap): ${report.buffs.length || 'none'}`);
    for (const buff of report.buffs) {
        const kind = buff.isCombat === null ? '' : buff.isCombat ? ' [combat]' : ' [skilling]';
        const shrine = buff.shrineHrid ? ` (${buff.shrineHrid})` : '';
        lines.push(`  ${buff.buffHrid}${shrine} — Lv${buff.level}${kind}`);
    }

    lines.push(`Shrine/building levels (guildBuildingLevelMap): ${report.buildings.length || 'none'}`);
    for (const building of report.buildings) {
        lines.push(`  ${building.hrid} — Lv${building.level}`);
    }

    return lines.join('\n');
}

/**
 * Hang the shrine report off the page global, beside the debug helpers the
 * entrypoint already exposes.
 *
 * Additive and guarded: an existing `Toolasha.debug` namespace keeps everything
 * it already has, and a page where the global is missing entirely (a test, an
 * unbundled import) is left alone rather than having one invented for it.
 *
 * @returns {boolean} True when the helper was attached
 */
export function exposeShrineDebug() {
    try {
        const target =
            typeof unsafeWindow !== 'undefined' ? unsafeWindow : typeof window !== 'undefined' ? window : null;
        if (!target?.Toolasha) return false;
        if (!target.Toolasha.debug) target.Toolasha.debug = {};
        target.Toolasha.debug.shrines = () => {
            const report = collectShrineDebug();
            console.log(formatShrineReport(report));
            return report;
        };
        target.Toolasha.debug.moveScopedData = (fromId, toId, options) =>
            moveScopedData(String(fromId), String(toId), options);
        target.Toolasha.debug.chooseDataOwner = async () => {
            await resetAdoptionDecision();
            return requestAdoptionConsent({});
        };
        return true;
    } catch (error) {
        console.error('[Chat Commands] Failed to expose the shrine debug helper:', error);
        return false;
    }
}

class ChatCommands {
    constructor() {
        this.gameCore = null;
        this.itemData = null;
        this.chatInput = null;
        this.boundKeydownHandler = null;
        this.initialized = false;
        this.timerRegistry = createTimerRegistry();
        this.unregisterObserver = null;
    }

    /**
     * Initialize chat commands feature
     */
    async initialize() {
        if (this.initialized) return;

        const enabled = config.getSetting('chatCommands');
        if (!enabled) return;

        this.loadItemData();
        this.setupGameCore();
        exposeShrineDebug();
        this.initialized = true;

        this.unregisterObserver = domObserver.onClass('ChatCommands', 'Chat_chatInputContainer', (container) => {
            const input = container.querySelector('input');
            if (!input || input === this.chatInput) return;
            this.attachToInput(input);
        });

        // Attach to any already-present input
        const existing = document.querySelector('[class*="Chat_chatInputContainer"] input');
        if (existing) {
            this.attachToInput(existing);
        }
    }

    /**
     * Attach the keydown listener to a chat input element.
     * @param {HTMLInputElement} input
     */
    attachToInput(input) {
        if (this.chatInput && this.boundKeydownHandler) {
            this.chatInput.removeEventListener('keydown', this.boundKeydownHandler, true);
        }
        this.chatInput = input;
        this.boundKeydownHandler = (event) => this.handleKeydown(event);
        this.chatInput.addEventListener('keydown', this.boundKeydownHandler, true);
    }

    /**
     * Disable the feature and cleanup
     */
    disable() {
        if (this.chatInput && this.boundKeydownHandler) {
            this.chatInput.removeEventListener('keydown', this.boundKeydownHandler, true);
            this.chatInput = null;
            this.boundKeydownHandler = null;
        }
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        this.initialized = false;
    }

    /**
     * Cleanup when disabling or character switching
     */
    cleanup() {
        this.disable();
        this.timerRegistry.clearAll();
    }

    /**
     * Load item data from dataManager
     */
    loadItemData() {
        const initClientData = dataManager.getInitClientData();
        if (!initClientData) {
            console.warn('[Chat Commands] Failed to load item data');
            return;
        }

        this.itemData = {
            itemNameToHrid: {},
            itemHridToName: {},
        };

        for (const [hrid, item] of Object.entries(initClientData.itemDetailMap)) {
            if (item?.name) {
                const normalizedName = item.name.toLowerCase();
                this.itemData.itemNameToHrid[normalizedName] = hrid;
                this.itemData.itemHridToName[hrid] = item.name;
            }
        }
    }

    /**
     * Setup game core access via React Fiber tree traversal
     */
    setupGameCore() {
        try {
            const rootEl = document.getElementById('root');
            const rootFiber =
                rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
            if (!rootFiber) return;

            function find(fiber) {
                if (!fiber) return null;
                if (fiber.stateNode?.sendPing) return fiber.stateNode;
                return find(fiber.child) || find(fiber.sibling);
            }

            this.gameCore = find(rootFiber);
        } catch (error) {
            console.error('[Chat Commands] Error accessing game core:', error);
        }
    }

    /**
     * Handle keydown on chat input
     * @param {KeyboardEvent} event - Keyboard event
     */
    handleKeydown(event) {
        if (event.key !== 'Enter') return;

        const command = this.parseCommand(event.target.value);
        if (!command) return;

        // Prevent chat submission
        event.preventDefault();
        event.stopPropagation();

        // Execute command
        this.executeCommand(command);

        // Clear input
        this.clearChatInput(event.target);
    }

    /**
     * Parse command from chat input
     * @param {string} inputValue - Chat input value
     * @returns {Object|null} Command object or null if not a command
     */
    parseCommand(inputValue) {
        const trimmed = inputValue.trim();
        const lower = trimmed.toLowerCase();

        if (lower.startsWith('/item ')) {
            const itemName = trimmed.substring(6).trim();
            if (!itemName) return null;
            return { type: 'item', itemName };
        }

        if (lower.startsWith('/wiki ')) {
            const itemName = trimmed.substring(6).trim();
            if (!itemName) return null;
            return { type: 'wiki', itemName };
        }

        // Takes no argument, so it is the whole line — with or without a
        // trailing space, because an input box collects them
        if (lower === '/shrines' || lower.startsWith('/shrines ')) {
            return { type: 'shrines' };
        }

        if (lower.startsWith('/market ')) {
            let itemName = trimmed.substring(8).trim();
            if (!itemName) return null;
            let enhancementLevel = 0;
            const enhMatch = itemName.match(/\s*\+(\d+)$/);
            if (enhMatch) {
                enhancementLevel = parseInt(enhMatch[1], 10);
                itemName = itemName.slice(0, -enhMatch[0].length).trim();
            }
            return { type: 'market', itemName, enhancementLevel };
        }

        return null;
    }

    /**
     * Execute parsed command
     * @param {Object} command - Command object {type, itemName}
     */
    executeCommand(command) {
        // Nothing to resolve: /shrines reports state, it does not name an item
        if (command.type === 'shrines') {
            this.showLocalMessage(formatShrineReport(collectShrineDebug()));
            return;
        }

        const normalizedName = this.normalizeItemName(command.itemName);

        // normalizedName is null when there are multiple matches (already shown to user)
        if (!normalizedName) return;

        const lowerName = normalizedName.replace(/_/g, ' ').toLowerCase();
        const itemHrid = this.itemData?.itemNameToHrid[lowerName];

        switch (command.type) {
            case 'item':
                if (itemHrid) {
                    this.openItemDictionary(itemHrid);
                } else {
                    // Item not found in game data (best effort normalization was used)
                    this.showError(`Item "${command.itemName}" not found in game data`);
                }
                break;

            case 'wiki':
                // Wiki always works (uses best effort normalization if no match)
                window.open(`https://milkywayidle.wiki.gg/wiki/${normalizedName}`, '_blank');
                break;

            case 'market':
                if (itemHrid) {
                    this.openMarketplace(itemHrid, command.enhancementLevel ?? 0);
                } else {
                    // Item not found in game data (best effort normalization was used)
                    this.showError(`Item "${command.itemName}" not found in game data`);
                }
                break;
        }
    }

    /**
     * Normalize item name with fuzzy matching
     * @param {string} itemName - Raw item name from user
     * @returns {string|null} Normalized name for URL/HRID lookup, or null if multiple matches
     */
    normalizeItemName(itemName) {
        if (!this.itemData) {
            return null;
        }

        const lowerName = itemName.toLowerCase();

        // Try exact match first
        if (this.itemData.itemNameToHrid[lowerName]) {
            const hrid = this.itemData.itemNameToHrid[lowerName];
            return this.itemData.itemHridToName[hrid].replace(/ /g, '_');
        }

        // Try fuzzy match
        const allNames = Object.keys(this.itemData.itemNameToHrid);
        const matches = allNames.filter((name) => name.includes(lowerName));

        if (matches.length === 1) {
            // Single match found
            const hrid = this.itemData.itemNameToHrid[matches[0]];
            return this.itemData.itemHridToName[hrid].replace(/ /g, '_');
        }

        if (matches.length > 1) {
            // Multiple matches - show user
            this.showMultipleMatches(matches);
            return null;
        }

        // No matches - do best effort normalization for wiki
        return itemName
            .split(' ')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('_');
    }

    /**
     * The chat history element the player is actually looking at.
     *
     * Several are in the DOM at once, one per tab, and all but the open one sit
     * inside a hidden TabPanel — appending to those would put the message
     * somewhere the player never sees.
     *
     * @returns {Element|null} The visible chat history, or null when none is
     * @private
     */
    _visibleChatHistory() {
        const allChatHistories = document.querySelectorAll('[class*="ChatHistory_chatHistory"]');
        for (const history of allChatHistories) {
            const grandparent = history.parentElement?.parentElement;
            if (grandparent && !grandparent.classList.contains('TabPanel_hidden__26UM3')) {
                return history;
            }
        }
        return null;
    }

    /**
     * Put a message in the chat history without sending it anywhere.
     *
     * This is the local echo every command's output goes through: a div appended
     * to the visible history element. Nothing here touches the socket, and the
     * keydown that triggered it was cancelled before the game saw it, so the
     * message exists on this screen only.
     *
     * @param {string} message - Text to show; newlines are preserved
     * @param {'info'|'error'} [tone='info'] - Which colour it reads in
     */
    showLocalMessage(message, tone = 'info') {
        const chatHistory = this._visibleChatHistory();
        if (!chatHistory) {
            console.warn('[Chat Commands] No visible chat history found');
            return;
        }

        const isError = tone === 'error';
        const messageDiv = document.createElement('div');
        messageDiv.className = 'mwi-chat-command-message';
        messageDiv.style.cssText = `
            padding: 8px;
            margin: 4px 0;
            background: ${isError ? 'rgba(255, 100, 100, 0.2)' : 'rgba(100, 160, 255, 0.15)'};
            border-left: 3px solid ${isError ? '#ff6464' : '#8fd3ff'};
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
            white-space: pre-wrap;
            color: ${isError ? '#ffcccc' : '#dbe6f5'};
        `;

        messageDiv.textContent = message;

        chatHistory.appendChild(messageDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    /**
     * Show multiple match warning in chat
     * @param {Array<string>} matches - Array of matching item names (lowercase keys)
     */
    showMultipleMatches(matches) {
        // Convert lowercase keys to proper item names
        const properNames = matches.map((lowerName) => {
            const hrid = this.itemData.itemNameToHrid[lowerName];
            return this.itemData.itemHridToName[hrid];
        });

        const matchList = properNames.slice(0, 5).join(', ') + (properNames.length > 5 ? '...' : '');
        this.showLocalMessage(`Multiple items match: ${matchList}. Please be more specific.`, 'error');
    }

    /**
     * Show error message in chat
     * @param {string} message - Error message to display
     */
    showError(message) {
        this.showLocalMessage(message, 'error');
    }

    /**
     * Open Item Dictionary for specific item
     * @param {string} itemHrid - Item HRID (e.g., "/items/radiant_fiber")
     */
    openItemDictionary(itemHrid) {
        if (!this.gameCore?.handleOpenItemDictionary) {
            this.showError('Feature unavailable after 2/21/26 game update');
            return;
        }

        try {
            this.gameCore.handleOpenItemDictionary(itemHrid);
        } catch (error) {
            console.error('[Chat Commands] Failed to open Item Dictionary:', error);
            this.showError('Failed to open Item Dictionary');
        }
    }

    /**
     * Open marketplace for specific item
     * @param {string} itemHrid - Item HRID (e.g., "/items/radiant_fiber")
     * @param {number} enhancementLevel - Enhancement level (default 0)
     */
    openMarketplace(itemHrid, enhancementLevel = 0) {
        if (!this.gameCore?.handleGoToMarketplace) {
            this.showError('Feature unavailable after 2/21/26 game update');
            return;
        }

        try {
            this.gameCore.handleGoToMarketplace(itemHrid, enhancementLevel);
        } catch (error) {
            console.error('[Chat Commands] Failed to open marketplace:', error);
            this.showError('Failed to open marketplace');
        }
    }

    /**
     * Clear chat input using React-compatible method
     * @param {HTMLInputElement} inputElement - Chat input element
     */
    clearChatInput(inputElement) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

        nativeInputValueSetter.call(inputElement, '');
        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

// Module-level register-once switching listener (see queue-snapshot.js): initialize()
// creates a new instance per call, so a per-instance listener would accumulate one
// entry (pinning its dead instance) on every character switch.
let activeInstance = null;
let switchListenerRegistered = false;

// Export as feature module
export default {
    name: 'Chat Commands',
    initialize: async () => {
        const chatCommands = new ChatCommands();
        await chatCommands.initialize();
        activeInstance = chatCommands;
        if (!switchListenerRegistered) {
            switchListenerRegistered = true;
            dataManager.on('character_switching', () => {
                if (activeInstance) {
                    activeInstance.cleanup();
                    activeInstance = null;
                }
            });
        }
        return chatCommands;
    },
    cleanup: (instance) => {
        if (instance) {
            instance.cleanup();
            if (activeInstance === instance) {
                activeInstance = null;
            }
        }
    },
};
