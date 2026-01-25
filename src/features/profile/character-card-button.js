/**
 * Character Card Button
 * Adds a "View Card" button to profile view that opens character sheet in new tab
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import dataManager from '../../core/data-manager.js';
import { buildCharacterSheetLink, buildSegmentsFromCharacterData } from './character-sheet.js';

/**
 * CharacterCardButton class manages character card export button on profiles
 */
class CharacterCardButton {
    constructor() {
        this.isActive = false;
        this.isInitialized = false;
        this.currentProfileData = null; // Store profile data for food/drinks
    }

    /**
     * Setup settings listeners for feature toggle and color changes
     */
    setupSettingListener() {
        config.onSettingChange('characterCard', (value) => {
            if (value) {
                this.initialize();
            } else {
                this.disable();
            }
        });

        config.onSettingChange('color_accent', () => {
            if (this.isInitialized) {
                this.refresh();
            }
        });
    }

    /**
     * Initialize character card button feature
     */
    initialize() {
        // Check if feature is enabled
        if (!config.getSetting('characterCard')) {
            return;
        }

        // Listen for profile_shared WebSocket messages
        webSocketHook.on('profile_shared', (data) => {
            this.handleProfileShared(data);
        });

        this.isActive = true;
        this.isInitialized = true;
    }

    /**
     * Handle profile_shared WebSocket message
     * @param {Object} profileData - Profile data from WebSocket
     */
    async handleProfileShared(profileData) {
        // Store profile data for food/drinks extraction
        this.currentProfileData = profileData;

        // Wait for profile panel to appear in DOM
        const profilePanel = await this.waitForProfilePanel();
        if (!profilePanel) {
            console.error('[CharacterCardButton] Could not find profile panel');
            return;
        }

        // Inject the character card button
        this.injectButton(profilePanel);
    }

    /**
     * Wait for profile panel to appear in DOM
     * @returns {Promise<Element|null>} Profile panel element or null if timeout
     */
    async waitForProfilePanel() {
        for (let i = 0; i < 20; i++) {
            const panel = document.querySelector('div.SharableProfile_overviewTab__W4dCV');
            if (panel) {
                return panel;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return null;
    }

    /**
     * Inject character card button into profile panel
     * @param {Element} profilePanel - Profile panel element
     */
    injectButton(profilePanel) {
        // Check if button already exists
        const existingButton = document.getElementById('mwi-character-card-btn');
        if (existingButton) {
            return;
        }

        // Find the combat score panel to inject button into
        const combatScorePanel = document.getElementById('mwi-combat-score-panel');
        if (!combatScorePanel) {
            console.warn('[CharacterCardButton] Combat score panel not found - button not injected');
            return;
        }

        // Find the button container (should be the div with both export buttons)
        const buttonContainer = combatScorePanel.querySelector('div[style*="margin-top: 12px"]');
        if (!buttonContainer) {
            console.warn('[CharacterCardButton] Button container not found in combat score panel');
            return;
        }

        // Create button element
        const button = document.createElement('button');
        button.id = 'mwi-character-card-btn';
        button.textContent = 'View Card';
        button.style.cssText = `
            padding: 8px 12px;
            background: ${config.COLOR_ACCENT};
            color: black;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            font-size: 0.85rem;
            width: 100%;
        `;

        // Add click handler
        button.addEventListener('click', () => {
            this.handleButtonClick();
        });

        // Add hover effects
        button.addEventListener('mouseenter', () => {
            button.style.opacity = '0.8';
        });
        button.addEventListener('mouseleave', () => {
            button.style.opacity = '1';
        });

        // Append button to container
        buttonContainer.appendChild(button);
    }

    /**
     * Handle character card button click
     */
    handleButtonClick() {
        try {
            const clientData = dataManager.getInitClientData();

            // Determine if viewing own profile or someone else's
            let characterData = null;

            // If we have profile data from profile_shared event, use it (other player)
            if (this.currentProfileData?.profile) {
                characterData = this.currentProfileData.profile;
                console.log('[CharacterCard] Using profile data (other player):', characterData);
            }
            // Otherwise use own character data from dataManager
            else {
                characterData = dataManager.characterData;
                console.log('[CharacterCard] Using own character data:', characterData);
            }

            if (!characterData) {
                console.error('[CharacterCardButton] No character data available');
                return;
            }

            // === COMPREHENSIVE LOGGING FOR DEBUG ===

            // Log ALL wearableItemMap items to see equipment structure
            if (characterData?.wearableItemMap) {
                const items = Object.values(characterData.wearableItemMap);
                console.log('[CharacterCard] All wearableItemMap items:', items.map(item => ({
                    location: item.itemLocationHrid,
                    item: item.itemHrid,
                    enhancement: item.enhancementLevel
                })));
            }

            // Log actual consumables structure from own character data
            const ownCharacterData = dataManager.characterData;
            if (ownCharacterData?.actionTypeFoodSlotsMap) {
                console.log('[CharacterCard] Food slots structure:', ownCharacterData.actionTypeFoodSlotsMap['/action_types/combat']);
            }
            if (ownCharacterData?.actionTypeDrinkSlotsMap) {
                console.log('[CharacterCard] Drink slots structure:', ownCharacterData.actionTypeDrinkSlotsMap['/action_types/combat']);
            }

            // Log abilities structure
            console.log('[CharacterCard] Abilities check:', {
                hasEquippedAbilities: !!characterData?.equippedAbilities,
                equippedAbilities: characterData?.equippedAbilities,
                hasCombatUnit: !!characterData?.combatUnit,
                hasCombatAbilities: !!characterData?.combatUnit?.combatAbilities
            });

            // Find the profile modal for fallback
            const modal = document.querySelector('.SharableProfile_modal__2OmCQ');

            // Build character sheet link using cached data (preferred) or DOM fallback
            // Pass ownCharacterData for consumables (profile_shared doesn't have consumables)
            const url = buildCharacterSheetLink(
                modal,
                'https://tib-san.github.io/mwi-character-sheet/',
                characterData,
                clientData,
                ownCharacterData  // Always use own character data for consumables
            );

            // Log the ACTUAL segments being built (for debugging)
            const segments = buildSegmentsFromCharacterData(characterData, clientData, ownCharacterData);
            console.log('[CharacterCard] Built segments:', segments);
            console.log('[CharacterCard] URL components:', {
                general: segments.general,
                skills: segments.skills,
                equipment: segments.equipment,
                abilities: segments.abilities,
                food: segments.food,
                housing: segments.housing,
                achievements: segments.achievements
            });

            console.log('[CharacterCard] Generated URL:', url);

            // Open in new tab
            window.open(url, '_blank');

        } catch (error) {
            console.error('[CharacterCardButton] Failed to open character card:', error);
        }
    }

    /**
     * Refresh colors on existing button
     */
    refresh() {
        const button = document.getElementById('mwi-character-card-btn');
        if (button) {
            button.style.background = config.COLOR_ACCENT;
        }
    }

    /**
     * Disable the feature
     */
    disable() {
        const button = document.getElementById('mwi-character-card-btn');
        if (button) {
            button.remove();
        }

        this.currentProfileData = null;
        this.isActive = false;
        this.isInitialized = false;
    }
}

// Create and export singleton instance
const characterCardButton = new CharacterCardButton();
characterCardButton.setupSettingListener();

export default characterCardButton;
