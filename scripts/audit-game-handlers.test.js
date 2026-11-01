import { describe, it, expect } from 'vitest';
import { parseGameHandlers, parseToolashaSubscriptions, compare, formatReport } from './audit-game-handlers.mjs';

// Shaped like the minified main chunk: arrow handlers assigned on `this`, a type -> handler map,
// optional chaining, an inner callback that shadows the message parameter, and a delegating handler.
const BUNDLE = `
class A{constructor(){
this.handleMessageSkillsUpdated=e=>{var t;if((null===(t=e.endCharacterSkills)||void 0===t?void 0:t.length)>=1){e.endCharacterSkills.forEach((e=>{if(e.skillHrid===1)return;const t=e.level}))}},
this.handleMessageCollectionsUpdated=e=>{this.setState({collections:e.collections})},
this.handleMessageDelegating=e=>{this.applyIt(e)},
this.applyIt=e=>{this.setState({a:e.alpha,b:e["beta"]})},
this.handleMessageDestructured=({gamma:e,delta:t})=>{},
this.handleMessageAlias=e=>{const{epsilon:t,...r}=e;return r},
this.handleMessageEmpty=()=>{this.setState({})},
this.messageMap={skills_updated:this.handleMessageSkillsUpdated,collections_updated:this.handleMessageCollectionsUpdated,
delegating:this.handleMessageDelegating,destructured:this.handleMessageDestructured,alias:this.handleMessageAlias,empty:this.handleMessageEmpty,other:this.notAHandler}
}}`;

describe('parseGameHandlers', () => {
    const game = parseGameHandlers(BUNDLE);

    it('maps message types to handlers and reads top-level fields', () => {
        expect([...game.keys()].sort()).toEqual(
            ['alias', 'collections_updated', 'delegating', 'destructured', 'empty', 'skills_updated'].sort()
        );
        expect([...game.get('skills_updated').fields]).toEqual(['endCharacterSkills']);
        expect([...game.get('collections_updated').fields]).toEqual(['collections']);
    });

    it('does not count reads on a shadowing inner parameter', () => {
        expect(game.get('skills_updated').fields.has('skillHrid')).toBe(false);
        expect(game.get('skills_updated').fields.has('level')).toBe(false);
    });

    it('follows the message into a named delegate', () => {
        expect([...game.get('delegating').fields].sort()).toEqual(['alpha', 'beta']);
    });

    it('reads destructured parameters and flags rest spreads', () => {
        expect([...game.get('destructured').fields].sort()).toEqual(['delta', 'gamma']);
        expect(game.get('alias').fields.has('epsilon')).toBe(true);
        expect(game.get('alias').spread).toBe(true);
        expect(game.get('empty').fields.size).toBe(0);
    });
});

const TOOLASHA = `
import webSocketHook from '../core/websocket.js';
const MSG = 'collections_updated';
class D {
    start() {
        this.webSocketHook.on('skills_updated', (data, context) => {
            if (data.characterSkills) this.x = data.characterSkills;
            this.emit('skills_updated', data);
        });
        webSocketHook.on(MSG, this._bound);
        webSocketHook.on('delegating', (m) => this.go(m));
        webSocketHook.on('internal_thing', () => {});
        dataManager.on('skills_updated', (d) => d.notWebsocket);
        webSocketHook.on(someVariable, (d) => d.skipped);
        webSocketHook.on('shadow', (data) => { [1].forEach((data) => data.inner); return data.outer; });
    }
    go(m) { return m.alpha + m.gone; }
}
`;

describe('parseToolashaSubscriptions', () => {
    const subs = parseToolashaSubscriptions(TOOLASHA, 'x.js');
    const by = (t) => subs.filter((s) => s.type === t);

    it('finds webSocketHook subscriptions only, with literal or const types', () => {
        expect(subs.map((s) => s.type).sort()).toEqual(
            ['collections_updated', 'delegating', 'internal_thing', 'shadow', 'skills_updated'].sort()
        );
    });

    it('reads fields off the callback message and flags a message passed on', () => {
        const s = by('skills_updated')[0];
        expect([...s.fields]).toEqual(['characterSkills']);
        expect(s.escapes).toBe(true); // this.emit('skills_updated', data) passes it to an unknown function
    });

    it('follows the message into a same-file method', () => {
        expect([...by('delegating')[0].fields].sort()).toEqual(['alpha', 'gone']);
    });

    it('honors shadowing', () => {
        expect([...by('shadow')[0].fields]).toEqual(['outer']);
    });

    it('marks an unresolvable callback as unresolved/opaque', () => {
        const s = by('collections_updated')[0];
        expect(s.resolved).toBe(false);
        expect(s.escapes).toBe(true);
    });
});

describe('compare / formatReport', () => {
    it('reports the skills_updated bug class, unknown subscriptions and ignored fields', () => {
        const game = parseGameHandlers(BUNDLE);
        const subs = parseToolashaSubscriptions(TOOLASHA, 'x.js');
        const report = compare(game, subs);
        const skills = report.rows.find((r) => r.type === 'skills_updated');
        expect(skills.wrong).toEqual(['characterSkills']);
        expect(skills.ignored).toEqual(['endCharacterSkills']);
        expect(report.noHandler.map((r) => r.type)).toEqual(['internal_thing', 'shadow']);
        expect(report.unsubscribed).toContain('alias');
        const text = formatReport(report);
        expect(text).toContain('skills_updated');
        expect(text).toContain('characterSkills');
    });
});
