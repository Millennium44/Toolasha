/**
 * What's New — the once-per-update popup, and the conservative-defaults policy.
 *
 * Two jobs that share one piece of bookkeeping. The bookkeeping is a stored
 * record of which build spoke last and which setting IDs the user has already
 * been shown; the popup announces whatever is new since, and the policy — for
 * people who would rather their script never changed itself — forces any newly
 * arrived on-by-default switch off before the features read it.
 *
 * ## Why the policy runs before features initialise
 *
 * A switch turned off *after* startup has already run once. The whole promise
 * of "new settings start off" is that the new thing never happens, so the
 * entrypoint calls `applyPolicy()` between loading settings and initialising
 * features, and `maybeShow()` only after the page is up.
 *
 * ## Why the state is per character
 *
 * Settings themselves are per character, so "which settings have you been
 * shown" has to be too — a policy applied for one character and assumed for
 * another would leave the second character's new switches on.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { getAllSettingIds, getSettingDefinition } from '../../core/settings-schema.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import {
    buildIdentity,
    identityChanged,
    describeUpdate,
    newSettingIds,
    conservativeOverrides,
} from './whats-new-core.js';
import forkChangelog from 'virtual:fork-changelog';

const STATE_KEY_PREFIX = 'whatsNew_state';

const COLORS = {
    background: 'rgba(10, 10, 20, 0.98)',
    border: 'rgba(96, 165, 250, 0.5)',
    accent: '#60a5fa',
    text: '#e0e0e0',
    dim: '#888',
};

class WhatsNew {
    constructor() {
        this.panel = null;
        this._pending = null;
    }

    /** @private */
    _stateKey() {
        return `${STATE_KEY_PREFIX}_${dataManager.getCurrentCharacterId() || 'default'}`;
    }

    /** @private */
    _identity() {
        return buildIdentity(typeof window !== 'undefined' ? window.Toolasha : {});
    }

    /**
     * Reconcile the stored record with this build. Runs before features
     * initialise, because the conservative policy has to land before anything
     * reads the settings it changes.
     */
    async applyPolicy() {
        try {
            const current = this._identity();
            const schemaIds = getAllSettingIds();
            const stored = await storage.getJSON(this._stateKey(), 'settings', null);

            // First run of the what's-new system. Two very different people
            // land here: a genuinely fresh install, and somebody arriving from
            // another build of Toolasha — usually the upstream fork, which
            // saves its settings under the same keys. The saved map's keys are
            // a fingerprint of the schema that wrote it, so the settings this
            // fork added are computable even though the other script never ran
            // a line of our code.
            if (!stored) {
                const storedIds = await config.storedSettingIds();
                const inherited = storedIds ? newSettingIds(schemaIds, storedIds) : [];
                if (inherited.length > 0) {
                    await this._offerFirstRunChoice(inherited, current);
                }
                await this._saveState(current, schemaIds);
                return;
            }

            const fresh = newSettingIds(schemaIds, stored.knownIds || []);
            const changed = identityChanged(stored, current);
            if (!changed && fresh.length === 0) return;

            let turnedOff = [];
            if (fresh.length > 0 && config.getSetting('whatsNew_newDefaultsOff')) {
                turnedOff = conservativeOverrides(fresh, getSettingDefinition);
                for (const id of turnedOff) config.setSetting(id, false);
            }

            this._pending = {
                headline: describeUpdate(stored, current),
                forkChanged: Boolean(stored.fork && stored.fork !== current.fork),
                newIds: fresh,
                turnedOff: new Set(turnedOff),
            };

            // Recorded now rather than after the popup, so a closed tab cannot
            // re-run the policy and flip a switch the user turned back on
            await this._saveState(current, schemaIds);
        } catch (error) {
            console.error('[WhatsNew] Reconciling the update state failed:', error);
        }
    }

    /**
     * The one-time choice for someone arriving with another build's settings.
     *
     * Awaited before features initialise, deliberately: "keep everything as it
     * was" is only true if the new features never run — a feature switched off
     * after startup has already announced itself. The page underneath is the
     * game, which works fine while this waits; closing the dialog counts as
     * keeping things as they were, because the person who dismisses a dialog
     * unread is exactly the person who did not ask for new behaviour.
     *
     * @param {Array<string>} inherited - Setting IDs this fork adds over the
     *   build whose settings were found
     * @param {{fork: string, version: string}} current - This build
     * @private
     */
    async _offerFirstRunChoice(inherited, current) {
        const conservative = conservativeOverrides(inherited, getSettingDefinition);
        const keepAsIs = await this._askChoice({
            title: `Welcome to ${current.fork}`,
            body:
                `This build has ${inherited.length} setting${inherited.length === 1 ? '' : 's'} that did not exist ` +
                `in the version your settings came from. ${conservative.length} of them switch new behaviour on by default.`,
            enableLabel: 'Turn the new things on',
            keepLabel: 'Keep everything as it was',
        });

        let turnedOff = new Set();
        if (keepAsIs) {
            config.setSetting('whatsNew_newDefaultsOff', true);
            for (const id of conservative) config.setSetting(id, false);
            turnedOff = new Set(conservative);
        }

        // The full popup still follows after startup, live switches and all —
        // the choice was wholesale, and the list is where it gets refined
        this._pending = {
            headline: `Switched to ${current.fork} ${current.version}`,
            forkChanged: true,
            newIds: inherited,
            turnedOff,
        };
    }

    /**
     * A modal with two buttons, as a promise.
     * @returns {Promise<boolean>} True to keep things as they were
     * @private
     */
    _askChoice({ title, body, enableLabel, keepLabel }) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            Object.assign(overlay.style, {
                position: 'fixed',
                inset: '0',
                zIndex: config.Z_FLOATING_PANEL,
                background: 'rgba(0,0,0,0.55)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            });

            const box = document.createElement('div');
            Object.assign(box.style, {
                width: 'min(440px, 92vw)',
                background: COLORS.background,
                border: `2px solid ${COLORS.border}`,
                borderRadius: '10px',
                color: COLORS.text,
                fontFamily: "'Segoe UI', sans-serif",
                fontSize: '13px',
                padding: '16px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            });
            box.innerHTML =
                `<div style="font-weight:700; font-size:15px; color:${COLORS.accent}; margin-bottom:8px;">${title}</div>` +
                `<div style="color:#bbb; margin-bottom:14px;">${body}</div>`;

            const done = (keepAsIs) => {
                overlay.remove();
                resolve(keepAsIs);
            };

            const buttons = document.createElement('div');
            Object.assign(buttons.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
            const keep = document.createElement('button');
            keep.textContent = keepLabel;
            Object.assign(keep.style, {
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid #444',
                borderRadius: '4px',
                color: COLORS.text,
                padding: '6px 14px',
                cursor: 'pointer',
            });
            keep.addEventListener('click', () => done(true));
            const enable = document.createElement('button');
            enable.textContent = enableLabel;
            Object.assign(enable.style, {
                background: 'rgba(96, 165, 250, 0.2)',
                border: `1px solid ${COLORS.border}`,
                borderRadius: '4px',
                color: COLORS.accent,
                padding: '6px 14px',
                cursor: 'pointer',
                fontWeight: '700',
            });
            enable.addEventListener('click', () => done(false));
            buttons.appendChild(keep);
            buttons.appendChild(enable);
            box.appendChild(buttons);

            const note = document.createElement('div');
            note.textContent = 'Either way, the full list follows with a switch for each — nothing here is final.';
            Object.assign(note.style, { fontSize: '11px', color: COLORS.dim, marginTop: '10px' });
            box.appendChild(note);

            // Clicking away is the person who did not ask for new behaviour
            overlay.addEventListener('mousedown', (event) => {
                if (event.target === overlay) done(true);
            });

            overlay.appendChild(box);
            document.body.appendChild(overlay);
        });
    }

    /** @private */
    async _saveState(identity, schemaIds) {
        await storage.setJSON(this._stateKey(), { ...identity, knownIds: schemaIds, seenAt: Date.now() }, 'settings');
    }

    /** Show the popup, where there is something to show and it is wanted. */
    maybeShow() {
        if (!this._pending) return;
        if (!config.getSetting('whatsNew_showPopup', true)) return;
        try {
            this._buildPanel(this._pending);
        } catch (error) {
            console.error('[WhatsNew] Building the update popup failed:', error);
        }
        this._pending = null;
    }

    /** @private */
    _buildPanel({ headline, forkChanged, newIds, turnedOff }) {
        this.close();

        const panel = document.createElement('div');
        panel.id = 'toolasha-whats-new';
        Object.assign(panel.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: config.Z_FLOATING_PANEL,
            width: 'min(560px, 92vw)',
            maxHeight: '82vh',
            display: 'flex',
            flexDirection: 'column',
            background: COLORS.background,
            border: `2px solid ${COLORS.border}`,
            borderRadius: '10px',
            color: COLORS.text,
            fontFamily: "'Segoe UI', sans-serif",
            fontSize: '13px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '10px 14px',
            borderBottom: `1px solid ${COLORS.border}`,
        });
        const title = document.createElement('div');
        title.innerHTML =
            `<span style="font-weight:700; font-size:14px; color:${COLORS.accent};">Toolasha — what's new</span>` +
            `<div style="font-size:11px; color:${forkChanged ? '#ffa500' : COLORS.dim}; margin-top:2px;">${headline}</div>`;
        const close = document.createElement('button');
        close.textContent = '×';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: '#aaa',
            fontSize: '22px',
            cursor: 'pointer',
            lineHeight: '1',
        });
        close.addEventListener('click', () => this.close());
        header.appendChild(title);
        header.appendChild(close);
        panel.appendChild(header);

        const body = document.createElement('div');
        Object.assign(body.style, { overflowY: 'auto', padding: '10px 14px', flex: '1' });

        if (newIds.length > 0) {
            const section = document.createElement('div');
            section.innerHTML = `<div style="font-weight:700; color:${COLORS.accent}; margin-bottom:6px;">New settings</div>`;
            if (turnedOff.size > 0) {
                const note = document.createElement('div');
                note.textContent =
                    `${turnedOff.size} of these would normally start on, and start off because ` +
                    `"New settings start turned off" is enabled.`;
                Object.assign(note.style, { fontSize: '11px', color: '#ffa500', marginBottom: '6px' });
                section.appendChild(note);
            }
            for (const id of newIds) {
                const row = this._settingRow(id, turnedOff.has(id));
                if (row) section.appendChild(row);
            }
            body.appendChild(section);
        }

        if (forkChangelog?.trim()) {
            const log = document.createElement('div');
            log.innerHTML = `<div style="font-weight:700; color:${COLORS.accent}; margin:10px 0 6px;">Changelog</div>`;
            const text = document.createElement('pre');
            text.textContent = forkChangelog.trim();
            Object.assign(text.style, {
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                fontSize: '12px',
                color: '#bbb',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid #222',
                borderRadius: '6px',
                padding: '8px 10px',
                margin: '0',
            });
            log.appendChild(text);
            body.appendChild(log);
        }

        panel.appendChild(body);

        const footer = document.createElement('div');
        Object.assign(footer.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 14px',
            borderTop: `1px solid ${COLORS.border}`,
            fontSize: '11px',
            color: COLORS.dim,
        });
        // The opt-out lives on the popup itself: the moment someone decides
        // they never want to see it again is the moment it is on screen
        const optOut = document.createElement('label');
        optOut.style.cursor = 'pointer';
        const optOutBox = document.createElement('input');
        optOutBox.type = 'checkbox';
        optOutBox.checked = !config.getSetting('whatsNew_showPopup', true);
        optOutBox.style.marginRight = '5px';
        optOutBox.addEventListener('change', () => config.setSetting('whatsNew_showPopup', !optOutBox.checked));
        optOut.appendChild(optOutBox);
        optOut.appendChild(document.createTextNode("Don't show this after updates"));
        const ok = document.createElement('button');
        ok.textContent = 'Close';
        Object.assign(ok.style, {
            background: 'rgba(96, 165, 250, 0.15)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: '4px',
            color: COLORS.accent,
            padding: '4px 14px',
            cursor: 'pointer',
        });
        ok.addEventListener('click', () => this.close());
        footer.appendChild(optOut);
        footer.appendChild(ok);
        panel.appendChild(footer);

        document.body.appendChild(panel);
        registerFloatingPanel(panel);
        bringPanelToFront(panel);
        this.panel = panel;
    }

    /**
     * One new setting, with its real control — flipping it here is flipping it,
     * not a preview of somewhere else it could be flipped.
     * @private
     */
    _settingRow(id, wasTurnedOff) {
        const definition = getSettingDefinition(id);
        if (!definition) return null;

        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
            padding: '5px 0',
            borderBottom: '1px solid #1a1a2e',
        });

        const label = document.createElement('div');
        label.innerHTML =
            `<div>${definition.label}${wasTurnedOff ? ' <span style="color:#ffa500; font-size:10px;">(kept off)</span>' : ''}</div>` +
            (definition.help ? `<div style="font-size:11px; color:${COLORS.dim};">${definition.help}</div>` : '');
        label.style.flex = '1';
        row.appendChild(label);

        const type = definition.type || 'checkbox';
        let control = null;
        if (type === 'checkbox') {
            control = document.createElement('input');
            control.type = 'checkbox';
            control.checked = Boolean(config.getSetting(id, definition.default ?? false));
            control.addEventListener('change', () => config.setSetting(id, control.checked));
        } else if (type === 'number') {
            control = document.createElement('input');
            control.type = 'number';
            if (definition.min !== undefined) control.min = definition.min;
            if (definition.max !== undefined) control.max = definition.max;
            control.value = config.getSettingValue(id, definition.default ?? 0);
            control.style.width = '70px';
            control.addEventListener('change', () => config.setSetting(id, Number(control.value)));
        } else if (type === 'select' && Array.isArray(definition.options)) {
            control = document.createElement('select');
            for (const option of definition.options) {
                const el = document.createElement('option');
                el.value = option.value ?? option;
                el.textContent = option.label ?? option;
                control.appendChild(el);
            }
            control.value = config.getSettingValue(id, definition.default ?? '');
            control.addEventListener('change', () => config.setSetting(id, control.value));
        } else {
            control = document.createElement('span');
            control.textContent = 'in Settings';
            control.style.color = COLORS.dim;
            control.style.fontSize = '11px';
        }
        if (control.tagName !== 'SPAN') {
            Object.assign(control.style, {
                background: '#1a1a2e',
                color: COLORS.text,
                border: '1px solid #444',
                borderRadius: '3px',
            });
        }
        row.appendChild(control);
        return row;
    }

    close() {
        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
        }
    }
}

const whatsNew = new WhatsNew();
export default whatsNew;
