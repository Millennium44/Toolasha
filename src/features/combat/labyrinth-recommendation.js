/**
 * Labyrinth Skip-Threshold Recommendations
 *
 * The highest skip threshold whose rooms still clear at least as often as the
 * panel's Target Win % asks for, searched per room, plus the fingerprinting
 * that decides when a previous run has been made untrue by a gear or setting
 * change, and the controls and badges the answer is shown through.
 *
 * Mixed into LabyrinthClearRate.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import loadoutSnapshot from './loadout-snapshot.js';
import { getAnnotationContainer } from './labyrinth-annotations.js';
import { SKIP_THRESHOLD_RANGE } from './labyrinth-formulas.js';

export const RECOMMEND_CLASS = 'mwi-labyrinth-recommend';
export const RECOMMEND_CONTROLS_CLASS = 'mwi-labyrinth-recommend-controls';
/** Fallback for the recommend panel's Target Win %, matching settings-schema */
const DEFAULT_RECOMMEND_TARGET_PCT = 70;

/**
 * What the build fingerprint hashes, for exports to carry — stored records key
 * on the value, so the algorithm must never change; this documents it instead.
 */
export const FINGERPRINT_SPEC =
    'djb2 over loadout snapshots (savedAt excluded) + worn itemHrid+enhancementLevel; excludes levels, abilities, buffs';

/** Prototype methods mixed into LabyrinthClearRate */
export const recommendationMethods = {
    /**
     * Binary search for the maximum skip threshold where clear chance >= targetRate
     */
    findRecommendedThreshold(skillHrid, targetRate) {
        const effectiveLevel = this.getEffectiveLevel(skillHrid);
        const isEnhancing = skillHrid === '/skills/enhancing';
        let low = -SKIP_THRESHOLD_RANGE;
        let high = SKIP_THRESHOLD_RANGE;
        let bestThreshold = null;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const roomLevel = Math.floor(effectiveLevel + mid - 1);
            if (roomLevel <= 0) {
                low = mid + 1;
                continue;
            }
            const result = isEnhancing
                ? this.computeEnhancingClear(roomLevel)
                : this.computeSkillingClear(skillHrid, roomLevel);
            if (result.clearChance >= targetRate) {
                bestThreshold = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return bestThreshold;
    },

    /**
     * Async binary search for combat room recommended threshold
     */
    async findRecommendedThresholdCombat(monsterHrid, targetRate) {
        const effectiveCombatLevel = this.getPlayerEffectiveCombatLevel();
        // No character data means no anchor for the search; a recommendation
        // built on an invented combat level is worse than none
        if (!(effectiveCombatLevel > 0)) return null;
        let low = -SKIP_THRESHOLD_RANGE;
        let high = SKIP_THRESHOLD_RANGE;
        let bestThreshold = null;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const roomLevel = Math.floor(effectiveCombatLevel + mid - 1);
            if (roomLevel <= 0) {
                low = mid + 1;
                continue;
            }
            // The search only needs this level placed above or below the bar,
            // not measured against it
            const result = await this.computeCombatClear(monsterHrid, roomLevel, { decideAgainst: targetRate });
            if (result.cancelled) break;
            if (result.clearChance >= targetRate) {
                bestThreshold = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return bestThreshold;
    },

    /**
     * The room level a Recommend run says this fight should be skipped to.
     *
     * The recommendation is a *threshold* — an offset — and the room it picks
     * out is `effectiveCombatLevel + threshold − 1`, the same arithmetic
     * `getCombatSkipRoomLevel` does for the threshold actually configured. What
     * makes it worth having separately is the objective behind it: a
     * recommendation is the highest offset whose rooms still clear at the
     * panel's Target Win %, where the configured one is only whatever the player
     * last typed into the automation table.
     *
     * Zero when no Recommend run has produced one for this monster — it is a
     * search over simulations and is never run on demand from here. A caller
     * wanting a level regardless falls back to the configured skip.
     *
     * @param {string} monsterHrid - Labyrinth monster
     * @returns {number} Room level, 0 when there is no recommendation
     */
    getRecommendedCombatRoomLevel(monsterHrid) {
        const threshold = this.recommendations?.get(monsterHrid)?.threshold;
        if (!Number.isFinite(threshold)) return 0;

        const effectiveCombatLevel = this.getPlayerEffectiveCombatLevel();
        if (!(effectiveCombatLevel > 0)) return 0;
        return Math.max(0, Math.floor(effectiveCombatLevel + threshold - 1));
    },

    /**
     * djb2 string hash — cheap change detection for snapshot contents
     * @private
     */
    _hashString(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
        }
        return String(hash);
    },

    /**
     * Fingerprint of the settings recommendations depend on: labyrinth loadout
     * assignments and crate selections. Skip thresholds are deliberately not
     * included — changing one doesn't change what any room's recommendation is.
     * @private
     */
    _recommendSettingsFingerprint() {
        const charSetting = dataManager.characterData?.characterSetting || {};
        const parts = [];
        for (const [key, value] of Object.entries(charSetting)) {
            if (key.startsWith('labyrinthLoadout')) {
                parts.push(`${key}=${value}`);
            }
        }
        parts.sort();
        parts.push(`crates=${this.getCrateHrids().join(',')}`);
        return parts.join('|');
    },

    /**
     * Fingerprint of loadout snapshot contents (gear + enhancement levels).
     * savedAt is excluded — snapshots are rebuilt with a fresh timestamp every
     * time the game re-broadcasts loadouts (e.g. when the lab equips the next
     * room's loadout), which is not a content change.
     *
     * Inputs and algorithm are pinned by {@link FINGERPRINT_SPEC}: stored
     * records key on the value, so neither may change.
     * @private
     */
    _snapshotContentFingerprint() {
        try {
            const stored = JSON.stringify(loadoutSnapshot.snapshots || {}, (key, value) =>
                key === 'savedAt' ? undefined : value
            );
            // The stored level is not the worn level for a loadout in "highest
            // owned" mode: enhancing an item changes what it puts on without
            // changing anything above, and a sim cached against the old level
            // would otherwise outlive the upgrade that made it wrong
            const worn = Object.values(loadoutSnapshot.snapshots || {})
                .map((snapshot) =>
                    loadoutSnapshot
                        .resolveEquipment(snapshot)
                        .map((equip) => `${equip.itemHrid}+${equip.enhancementLevel}`)
                        .join(',')
                )
                .join('|');
            return this._hashString(`${stored}||${worn}`);
        } catch {
            // Unhashable → treat as changed so stale sims never survive
            return `err-${Date.now()}`;
        }
    },

    /**
     * Drop recommendations (and, for loadout content changes, cached sims)
     * only when the inputs they were computed from actually changed. Events
     * like setting_updated and snapshot rebuilds fire constantly — on every
     * skip-threshold edit and every lab room switch — and used to wipe
     * minutes of recommendation work for no reason.
     * @private
     * @returns {boolean} True when something was invalidated
     */
    _invalidateIfInputsChanged() {
        const settingsFp = this._recommendSettingsFingerprint();
        const snapshotFp = this._snapshotContentFingerprint();
        let stale = false;

        if (this._settingsFingerprint !== null && settingsFp !== this._settingsFingerprint) {
            stale = true;
        }
        this._settingsFingerprint = settingsFp;

        if (this._snapshotFingerprint !== null && snapshotFp !== this._snapshotFingerprint) {
            stale = true;
            // Snapshot content is not part of the combat cache key — gear
            // changes genuinely invalidate cached sims, in memory and in the
            // persisted mirror alike
            this.combatCache.clear();
            this._clearPersistedCombatCache();
        }
        this._snapshotFingerprint = snapshotFp;

        if (stale) {
            this.recommendations.clear();
        }
        return stale;
    },

    /**
     * The recommend panel's Target Win %, read from the input, clamped, and
     * written back to the setting.
     *
     * Persisted the same way the path panel's own threshold is: the two knobs
     * sit in the same UI and used to behave differently, the path one surviving
     * a reload and this one silently reverting to the default. The input is the
     * authority while it exists; the setting is what a fresh panel reads.
     * @returns {number} 1..100
     */
    getRecommendTargetPct() {
        const input = document.getElementById('mwi-recommend-target-rate');
        const stored = config.getSettingValue('labyrinthRecommendTargetRate', DEFAULT_RECOMMEND_TARGET_PCT);
        const pct = Math.min(100, Math.max(1, Math.floor(Number(input?.value) || stored)));
        if (input) input.value = String(pct);
        config.setSettingValue('labyrinthRecommendTargetRate', pct);
        return pct;
    },

    /**
     * Run recommendations for all visible rooms
     */
    async runRecommendations() {
        if (this.recommendRunning) return;
        this.recommendRunning = true;
        this.recommendations.clear();
        // The combat cache is deliberately kept. A search run does not make a
        // cached sim wrong — only a gear change does, and
        // _invalidateIfInputsChanged already clears both layers for that.
        // Clearing it here threw away the sims just read back off disk and,
        // because _persistCombatCacheEntry rebuilds the stored list from what
        // is still in the Map, the next completed sim wrote that empty Map back
        // out — so one Recommend press also evicted the whole persisted cache.
        // Anchor the invalidation baselines to the state this run computes from
        this._settingsFingerprint = this._recommendSettingsFingerprint();
        this._snapshotFingerprint = this._snapshotContentFingerprint();

        this._recommendTargetPct = this.getRecommendTargetPct();
        const targetRate = this._recommendTargetPct / 100;

        const cells = document.querySelectorAll('[class*="LabyrinthPanel_skipThreshold"]');
        const rooms = [];

        for (const cell of cells) {
            const roomHrid = this.extractRoomHrid(cell);
            if (!roomHrid) continue;
            const isSkill = roomHrid.startsWith('/skills/');
            const isMonster = roomHrid.startsWith('/monsters/');
            if (!isSkill && !isMonster) continue;
            rooms.push({ roomHrid, isSkill });
        }

        const button = document.querySelector(`.${RECOMMEND_CONTROLS_CLASS} button`);
        const totalRooms = rooms.length;
        let completed = 0;

        for (const { roomHrid, isSkill } of rooms) {
            if (isSkill) {
                const threshold = this.findRecommendedThreshold(roomHrid, targetRate);
                this.recommendations.set(roomHrid, { threshold });
            } else {
                if (button) button.textContent = `Recommending... (${completed + 1}/${totalRooms})`;
                const threshold = await this.findRecommendedThresholdCombat(roomHrid, targetRate);
                this.recommendations.set(roomHrid, { threshold });
            }
            completed++;
        }

        if (button) button.textContent = 'Recommend';
        this.recommendRunning = false;
        this.injectRecommendationBadges();
    },

    /**
     * Inject recommendation badges onto visible cells
     */
    injectRecommendationBadges() {
        document.querySelectorAll(`.${RECOMMEND_CLASS}`).forEach((el) => el.remove());
        if (this.recommendations.size === 0) return;

        const cells = document.querySelectorAll('[class*="LabyrinthPanel_skipThreshold"]');
        for (const cell of cells) {
            const roomHrid = this.extractRoomHrid(cell);
            if (!roomHrid) continue;

            const rec = this.recommendations.get(roomHrid);
            if (!rec || rec.threshold === null) continue;

            const isSkill = roomHrid.startsWith('/skills/');
            const currentThreshold = isSkill ? this.getSkipThreshold(roomHrid) : this.getCombatSkipThreshold(roomHrid);

            const badge = document.createElement('span');
            badge.className = RECOMMEND_CLASS;
            badge.style.cssText = 'font-size:0.7rem; white-space:nowrap; font-weight:bold;';
            badge.textContent = `Rec: ${rec.threshold >= 0 ? '+' : ''}${rec.threshold}`;

            // Four states, not three. Sitting below the recommendation used to
            // share the colour of sitting exactly on it, which hid the one case
            // that is costing you rooms rather than risking them: a threshold
            // under the recommendation skips fights you would have cleared.
            // Above it is the opposite error and is graded by how far.
            const gap = currentThreshold - rec.threshold;
            const target = `≥${this._recommendTargetPct}% clear rate`;
            let note;
            if (gap === 0) {
                badge.style.color = '#00c896';
                note = `On the recommendation for a ${target}`;
            } else if (gap < 0) {
                badge.style.color = '#5aa9e6';
                note =
                    `${-gap} below the recommendation — safe, but skipping rooms that would have ` +
                    `cleared at a ${target}`;
            } else if (gap <= 10) {
                badge.style.color = '#f0ad4e';
                note = `${gap} above the recommendation — fighting rooms below a ${target}`;
            } else {
                badge.style.color = '#d9534f';
                note = `${gap} above the recommendation — well below a ${target}`;
            }
            badge.title = this._recommendationTooltip(roomHrid, rec, currentThreshold, note, target);

            getAnnotationContainer(cell).appendChild(badge);
        }
    },

    /**
     * Hover text for a recommendation badge. A skilling row shows its working —
     * the room the recommended trigger maps to (and why it is trigger − 1 above
     * you), the effective level, the success formula, the clear, and the crates
     * behind it — the same breakdown the Lab Sim's Skilling tab now gives. A
     * combat row keeps the short form: its clear rate is an async simulation, not
     * a closed-form formula, so there is nothing to spell out here.
     * @private
     */
    _recommendationTooltip(roomHrid, rec, currentThreshold, note, target) {
        const head = `Recommended skip trigger for a ${target}: ${rec.threshold >= 0 ? '+' : ''}${rec.threshold}`;
        const tail = `Currently set to ${currentThreshold}. ${note}.`;
        if (!roomHrid.startsWith('/skills/')) return `${head}\n${tail}`;

        const lines = [head];
        const effLevel = this.getEffectiveLevel(roomHrid);
        if (Number.isFinite(effLevel) && Number.isFinite(rec.threshold)) {
            const room = Math.floor(effLevel + rec.threshold - 1);
            lines.push(
                `At ${rec.threshold >= 0 ? '+' : ''}${rec.threshold}: room ${room} — the hardest room you still fight`
            );
            lines.push(
                `  a room is skipped once it's ≥${rec.threshold} above you (≥${effLevel + rec.threshold}), so ${room} is the top`
            );
            const result = room > 0 ? this.computeSkillingClear(roomHrid, room) : null;
            if (result) {
                const bonus = Number(result.skillLevelBonus) || 0;
                lines.push(
                    `Effective level ${result.effectiveLevel} = base ${result.baseLevel}${bonus ? ` + ${+bonus.toFixed(2)} buffs` : ''}`
                );
                const lb = Number(result.levelBonus) || 0;
                const sb = Number(result.successBonus) || 0;
                lines.push(
                    `Success = 0.8 × (1 ${lb >= 0 ? '+' : '−'} ${Math.abs(lb * 100).toFixed(1)}%` +
                        `${sb ? ` + ${(sb * 100).toFixed(1)}% gear` : ''}) = ${((result.successChance || 0) * 100).toFixed(1)}%`
                );
                lines.push(`Clear ${((result.clearChance || 0) * 100).toFixed(1)}% at that room`);
            }
        }
        const crates = this._equippedCrateSummary();
        if (crates) lines.push(`Crates: ${crates}`);
        lines.push(tail);
        return lines.join('\n');
    },

    /**
     * The equipped labyrinth crate tiers as "Expert tea · Advanced coffee · …",
     * for the recommendation tooltip's crate line.
     * @private
     */
    _equippedCrateSummary() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        return [
            labyrinth?.teaCrateItemHrid || setting?.labyrinthTeaCrateHrid || '',
            labyrinth?.coffeeCrateItemHrid || setting?.labyrinthCoffeeCrateHrid || '',
            labyrinth?.foodCrateItemHrid || setting?.labyrinthFoodCrateHrid || '',
        ]
            .map((hrid) => {
                const match = /\/items\/(\w+?)_(tea|coffee|food)_crate/.exec(hrid || '');
                return match ? `${match[1].charAt(0).toUpperCase()}${match[1].slice(1)} ${match[2]}` : '';
            })
            .filter(Boolean)
            .join(' · ');
    },

    /**
     * Inject recommend controls (button + target input) into the automation panel
     */
    injectRecommendControls() {
        const defaultRate = config.getSettingValue('labyrinthRecommendTargetRate', DEFAULT_RECOMMEND_TARGET_PCT);

        if (document.querySelector(`.${RECOMMEND_CONTROLS_CLASS}`)) {
            const rateInput = document.getElementById('mwi-recommend-target-rate');
            // The setting is the source of truth, so re-injection just resyncs
            // to it. A `userEdited` flag used to be set on the first keystroke
            // and never cleared, which pinned the input to that session's value
            // and made every later change to the setting invisible here. Edits
            // now write straight through to the setting, so the only thing left
            // to protect is a field being typed into right now.
            if (rateInput && document.activeElement !== rateInput) rateInput.value = defaultRate;
            return;
        }

        const table = document.querySelector('[class*="LabyrinthPanel_automationTable"]');
        if (!table) return;

        const container = document.createElement('div');
        container.className = RECOMMEND_CONTROLS_CLASS;
        container.style.cssText =
            'display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:0.8rem; flex-wrap:wrap;';

        const inputStyle =
            'width:50px; background:#1a1a2e; color:#e0e0e0; border:1px solid #555; border-radius:4px; padding:2px 4px; font-size:0.75rem; text-align:center;';
        const labelStyle = 'color:#888; font-size:0.75rem; white-space:nowrap;';

        const rateLabel = document.createElement('span');
        rateLabel.style.cssText = labelStyle;
        rateLabel.textContent = 'Target Win %';

        const rateInput = document.createElement('input');
        rateInput.type = 'number';
        rateInput.id = 'mwi-recommend-target-rate';
        rateInput.min = '1';
        rateInput.max = '100';
        rateInput.step = '1';
        rateInput.value = defaultRate;
        rateInput.style.cssText = inputStyle;
        rateInput.title =
            'Recommendations pick the highest skip threshold whose rooms still clear at least this often. ' +
            'Saved as you change it, so it survives a reload.';
        // Persist on commit rather than on every keystroke: typing "7" on the
        // way to "70" should not store 7
        rateInput.addEventListener('change', () => this.getRecommendTargetPct());

        const button = document.createElement('button');
        button.textContent = 'Recommend';
        button.style.cssText =
            'padding:2px 10px; cursor:pointer; font-size:0.75rem; border-radius:4px; border:1px solid #555; background:#333; color:#ccc;';
        button.addEventListener('click', () => this.runRecommendations());

        container.appendChild(rateLabel);
        container.appendChild(rateInput);
        container.appendChild(button);
        table.parentNode.insertBefore(container, table);
    },
};
