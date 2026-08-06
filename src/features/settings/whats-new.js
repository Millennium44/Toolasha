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
import { SETTING_PRESETS, DEFAULT_PRESET_ID, applyPreset, getPreset } from './setting-presets.js';
import {
    buildIdentity,
    identityChanged,
    describeUpdate,
    newSettingIds,
    conservativeOverrides,
} from './whats-new-core.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { askChoice } from '../../utils/choice-dialog.js';
import { toolashaRoot } from '../../utils/bundle-bridge.js';
import forkChangelog from 'virtual:fork-changelog';
import forkOverview from 'virtual:fork-overview';

const STATE_KEY_PREFIX = 'whatsNew_state';

const COLORS = {
    background: 'rgba(10, 10, 20, 0.98)',
    border: 'rgba(96, 165, 250, 0.5)',
    accent: '#60a5fa',
    text: '#e0e0e0',
    dim: '#888',
};

/**
 * Decode the handful of HTML entities the changelog carries. The source is
 * markdown that occasionally escapes angle brackets and quotes (e.g. the
 * "&lt;name&gt; has …" announcement shape), and this popup shows it as plain
 * text, so the escapes have to come back to the characters they stand for.
 * `&amp;` is decoded last so an escaped entity like `&amp;lt;` does not become
 * `<`.
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
    return String(text)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#34;/g, '"')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * Append one line's worth of inline-formatted content to a parent node, built
 * as real DOM nodes rather than injected HTML. `**bold**` becomes a bold span,
 * `` `code` `` is shown as its inner text with the backticks stripped, and HTML
 * entities are decoded. The changelog is build-embedded and therefore trusted,
 * but nodes are constructed anyway so no markdown is ever parsed as HTML.
 * @param {Node} parent
 * @param {string} text
 * @private
 */
function appendInline(parent, text) {
    const pattern = /\*\*([^*]+?)\*\*|`([^`]+?)`/g;
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parent.appendChild(document.createTextNode(decodeEntities(text.slice(lastIndex, match.index))));
        }
        if (match[1] !== undefined) {
            const strong = document.createElement('span');
            strong.style.fontWeight = '700';
            strong.textContent = decodeEntities(match[1]);
            parent.appendChild(strong);
        } else {
            parent.appendChild(document.createTextNode(decodeEntities(match[2])));
        }
        lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) {
        parent.appendChild(document.createTextNode(decodeEntities(text.slice(lastIndex))));
    }
}

/**
 * Render a slice of the embedded fork markdown into `root` as readable DOM.
 *
 * A tiny, dependency-free markdown-to-DOM pass: `##` section headings are
 * skipped (the "Unreleased — branch …" line is not for the reader), `###`
 * becomes an accented heading, `-` becomes a bullet, anything else non-blank is
 * a paragraph, and every text run is inline-formatted through `appendInline`.
 * Shared by the changelog and the newcomer overview.
 * @param {Node} root - Container to append rendered nodes to
 * @param {string} markdown - The embedded markdown to render
 */
function renderForkMarkdown(root, markdown) {
    const lines = String(markdown).split('\n');
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) continue; // spacing comes from element margins
        if (/^##\s/.test(line)) continue; // the "Unreleased — branch …" heading is not shown
        const heading = line.match(/^###\s+(.+)/);
        if (heading) {
            const el = document.createElement('div');
            Object.assign(el.style, {
                fontWeight: '700',
                color: COLORS.accent,
                margin: '10px 0 4px',
                fontSize: '12.5px',
            });
            appendInline(el, heading[1]);
            root.appendChild(el);
            continue;
        }
        const bullet = line.match(/^-\s+(.+)/);
        if (bullet) {
            const el = document.createElement('div');
            Object.assign(el.style, { margin: '2px 0', color: '#bbb', lineHeight: '1.4' });
            el.appendChild(document.createTextNode('• '));
            appendInline(el, bullet[1]);
            root.appendChild(el);
            continue;
        }
        const paragraph = document.createElement('div');
        Object.assign(paragraph.style, { margin: '4px 0', color: '#bbb', lineHeight: '1.4' });
        appendInline(paragraph, line);
        root.appendChild(paragraph);
    }
}

class WhatsNew {
    constructor() {
        this.panel = null;
        this._pending = null;
        this._keyHandler = null;
    }

    /** @private */
    _stateKey() {
        return `${STATE_KEY_PREFIX}_${dataManager.getCurrentCharacterId() || 'default'}`;
    }

    /** @private */
    _identity() {
        return buildIdentity(toolashaRoot() || {});
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
                if (!storedIds || storedIds.length === 0) {
                    // Nothing saved at all: a genuinely fresh install. Nobody
                    // has opinions yet, so the useful question is not "which of
                    // these 40 new switches" but "what kind of player are you".
                    await this._offerFirstRunPreset(current);
                } else {
                    const inherited = newSettingIds(schemaIds, storedIds);
                    if (inherited.length > 0) {
                        await this._offerFirstRunChoice(inherited, current);
                    }
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
                isNewcomer: false,
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
     * A returning user already has opinions saved, so the safe answer is to
     * touch nothing — "Keep my current settings" is the default and the primary
     * button. The presets follow it, for the person who would rather start from
     * a known configuration than reconcile a fork's worth of new switches by
     * hand. The two kinds of answer are not symmetric, and the message says so:
     * keeping changes nothing, whereas a preset overwrites what is there — which
     * is why `applyPreset` snapshots first, so Restore in the Toolasha tab can
     * walk it back.
     *
     * Awaited before features initialise, deliberately: "keep my current
     * settings" is only true if the new features never run — a feature switched
     * off after startup has already announced itself. The page underneath is the
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
        const answer = await askChoice({
            title: `Welcome to ${current.fork}`,
            message:
                `This build has ${inherited.length} setting${inherited.length === 1 ? '' : 's'} that did not exist ` +
                `in the version your settings came from. ${conservative.length} of them switch new behaviour on by ` +
                'default.\n\n' +
                'Keeping your settings changes nothing. A preset replaces your current settings — you can undo it ' +
                'later with Restore in the Toolasha tab.',
            choices: [
                {
                    value: 'keepCurrent',
                    label: 'Keep my current settings',
                    tone: 'primary',
                    hint:
                        'Change nothing — leave every setting exactly where it is now. New features stay off ' +
                        'until you turn them on.',
                },
                ...SETTING_PRESETS.map((preset) => ({
                    value: preset.id,
                    label: preset.label,
                    hint: preset.description,
                })),
            ],
        });

        // A real preset id — and only a real preset id — takes the preset path.
        // `keepCurrent` and dismissal (null) both fall through to the safe path,
        // because the user asked for either "no change" or nothing at all.
        const chosenPreset = getPreset(answer);
        if (chosenPreset) {
            await applyPreset(chosenPreset.id);
            this._pending = {
                headline: `Switched to ${current.fork} ${current.version} — ${chosenPreset.label} preset`,
                forkChanged: true,
                newIds: [],
                turnedOff: new Set(),
                isNewcomer: true,
            };
            return;
        }

        // The safe path: keep every current value, and hold the conservative
        // policy so genuinely-new on-by-default switches stay off until asked
        // for. Dismissal lands here too — the person who closes a dialog unread
        // is exactly the person who least wants their config touched.
        config.setSetting('whatsNew_newDefaultsOff', true);
        for (const id of conservative) config.setSetting(id, false);

        // The full popup still follows after startup, live switches and all —
        // the choice was wholesale, and the list is where it gets refined
        this._pending = {
            headline: `Switched to ${current.fork} ${current.version}`,
            forkChanged: true,
            newIds: inherited,
            turnedOff: new Set(conservative),
            isNewcomer: true,
        };
    }

    /**
     * The first thing a brand-new install is asked.
     *
     * On a fresh install every switch is at its default, which is very nearly
     * "everything on" — hundreds of features arriving at once for somebody who
     * has not yet decided which parts of the game they play. A preset is a
     * one-click answer to that, and the settings panel keeps the same buttons
     * for whenever they change their mind.
     *
     * Awaited before features initialise for the same reason the inherited-
     * settings question is: a feature switched off after startup has already
     * run once. Dismissing the dialog — Escape, or clicking away — is the same
     * as choosing "Defaults", which is what a fresh install would have
     * done anyway, so nothing here can leave a person stuck.
     *
     * @param {{fork: string, version: string}} current - This build
     * @private
     */
    async _offerFirstRunPreset(current) {
        try {
            const answer = await askChoice({
                title: `Welcome to ${current.fork}`,
                message:
                    'Toolasha ships several hundred features. Pick a starting point and the rest stay out of your ' +
                    'way — you can change any of it, or apply a different preset, from the Toolasha tab in ' +
                    'Settings.',
                choices: SETTING_PRESETS.map((preset) => ({
                    value: preset.id,
                    label: preset.label,
                    hint: preset.description,
                    tone: preset.id === DEFAULT_PRESET_ID ? 'primary' : undefined,
                })),
            });

            const chosenId = answer && getPreset(answer) ? answer : DEFAULT_PRESET_ID;
            await applyPreset(chosenId);

            const chosen = getPreset(chosenId);
            this._pending = {
                headline: `Installed ${current.fork} ${current.version} — ${chosen.label} preset`,
                forkChanged: false,
                newIds: [],
                turnedOff: new Set(),
                isNewcomer: true,
            };
        } catch (error) {
            console.error('[WhatsNew] Offering the first-run preset failed:', error);
        }
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
    _buildPanel({ headline, forkChanged, newIds, turnedOff, isNewcomer }) {
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

        // A fresh install, or someone arriving from another build (upstream
        // Toolasha included), gets the at-a-glance tour before the changelog —
        // the changelog answers "what changed", which means nothing to someone
        // who has not seen the thing it changed.
        if ((isNewcomer || forkChanged) && forkOverview?.trim()) {
            const overview = document.createElement('div');
            const heading = document.createElement('div');
            Object.assign(heading.style, {
                fontWeight: '700',
                color: COLORS.accent,
                margin: '4px 0 6px',
                fontSize: '14px',
            });
            heading.textContent = 'Toolasha — at a glance';
            overview.appendChild(heading);
            const box = document.createElement('div');
            Object.assign(box.style, {
                fontSize: '12px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid #222',
                borderRadius: '6px',
                padding: '8px 10px',
                marginBottom: '12px',
            });
            renderForkMarkdown(box, forkOverview.trim());
            overview.appendChild(box);
            body.appendChild(overview);
        }

        if (forkChangelog?.trim()) {
            const log = document.createElement('div');
            const heading = document.createElement('div');
            Object.assign(heading.style, {
                fontWeight: '700',
                color: COLORS.accent,
                margin: '10px 0 6px',
                fontSize: '14px',
            });
            heading.textContent = 'Changelog';
            log.appendChild(heading);
            const box = document.createElement('div');
            Object.assign(box.style, {
                fontSize: '12px',
                color: '#bbb',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid #222',
                borderRadius: '6px',
                padding: '8px 10px',
            });
            renderForkMarkdown(box, forkChangelog.trim());
            log.appendChild(box);
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

        // Escape closes it, captured because the game listens for Escape too
        // and would close whatever is behind this as well
        this._keyHandler = (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            event.preventDefault();
            this.close();
        };
        document.addEventListener('keydown', this._keyHandler, true);

        // Focused so Enter and Tab work from the keyboard, and so the popup
        // takes focus away from whatever was behind it
        ok.focus();
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
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler, true);
            this._keyHandler = null;
        }
        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
        }
    }
}

const whatsNew = new WhatsNew();
export default whatsNew;
export { renderForkMarkdown };
