/**
 * External Links
 * Adds links to external MWI tools in the left sidebar navigation
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { COMBAT_SIM_TARGETS } from '../combat/combat-sim-targets.js';

class ExternalLinks {
    constructor() {
        this.unregisterObserver = null;
        this.addedContainers = new WeakSet(); // Track which specific containers have links
        this.isInitialized = false;
    }

    /**
     * Initialize external links feature
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('ui_externalLinks')) {
            return;
        }

        this.isInitialized = true;
        this.setupObserver();
    }

    /**
     * Setup DOM observer to watch for navigation bar
     */
    setupObserver() {
        // Wait for the minor navigation links container
        this.unregisterObserver = domObserver.onClass(
            'ExternalLinks',
            'NavigationBar_minorNavigationLinks',
            (container) => {
                if (!this.addedContainers.has(container)) {
                    this.addLinks(container);
                    this.addedContainers.add(container);
                }
            }
        );

        // Check for existing container immediately
        const existingContainer = document.querySelector('[class*="NavigationBar_minorNavigationLinks"]');
        if (existingContainer && !this.addedContainers.has(existingContainer)) {
            this.addLinks(existingContainer);
            this.addedContainers.add(existingContainer);
        }
    }

    /**
     * Add external tool links to navigation bar
     * @param {HTMLElement} container - Navigation links container
     */
    addLinks(container) {
        const links = [
            // Every simulator "Import from Toolasha" supports, so a new target shows up here too
            ...COMBAT_SIM_TARGETS.map((target) => ({ label: target.label, url: target.url })),
            {
                label: 'Enhancelator',
                url: 'https://doh-nuts.github.io/Enhancelator/',
            },
            {
                label: 'Milkonomy',
                url: 'https://hyhfish.github.io/milkonomy/#/dashboard',
            },
            {
                label: "Socko's Combat Tracker",
                url: 'https://sockosnewcombattracker.pages.dev/',
            },
            {
                label: 'mwilinks',
                url: 'https://www.mwilinks.site/',
            },
        ];

        // Add each link (in reverse order so they appear in correct order when prepended)
        for (let i = links.length - 1; i >= 0; i--) {
            const link = links[i];
            this.addLink(container, link.label, link.url);
        }
    }

    /**
     * Add a single external link to the navigation
     * @param {HTMLElement} container - Navigation links container
     * @param {string} label - Link label
     * @param {string} url - External URL
     */
    addLink(container, label, url) {
        const div = document.createElement('div');
        div.setAttribute('class', 'NavigationBar_minorNavigationLink__31K7Y mwi-external-link');
        div.style.color = config.COLOR_ACCENT;
        div.style.cursor = 'pointer';
        div.textContent = label;

        div.addEventListener('click', () => {
            window.open(url, '_blank');
        });

        // Insert at the beginning (after Settings if it exists)
        container.insertAdjacentElement('afterbegin', div);
    }

    /**
     * Disable the external links feature
     */
    disable() {
        try {
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }

            // Remove added links (tagged with our marker class when created)
            document.querySelectorAll('.mwi-external-link').forEach((link) => link.remove());

            // Clear the WeakSet (create new instance)
            this.addedContainers = new WeakSet();
            this.isInitialized = false;
        } catch (error) {
            console.error('[External Links] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const externalLinks = new ExternalLinks();

export default externalLinks;
