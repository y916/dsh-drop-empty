import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { apply, blankKeys, resolveConfig } from '../lib/index.js';

/** 最小可用的 cordis 上下文替身：记录监听器、工具定义与日志。 */
function createCtx(definitions = {}) {
    const listeners = new Map();
    const logs = { debug: [], info: [], warn: [] };
    const definitionLookups = [];
    const ctx = {
        on(event, listener) {
            listeners.set(event, listener);
        },
        tools: {
            get(toolName, scope) {
                definitionLookups.push([toolName, scope]);
                if (definitions instanceof Error) throw definitions;
                return definitions[toolName];
            },
        },
        logger: {
            debug: (message) => logs.debug.push(message),
            info: (message) => logs.info.push(message),
            warn: (message, error) => logs.warn.push([message, error]),
        },
    };
    return { ctx, listeners, logs, definitionLookups };
}

/** 复刻宿主语义：参数在进入 pre-execute 前被 deepFreeze，exec 外层对象本身未冻结。 */
function deepFreeze(value) {
    if (value === null || typeof value !== 'object') return value;
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
}

function dispatch(harness, exec) {
    const listener = harness.listeners.get('tools/pre-execute');
    assert.ok(listener, 'plugin must register a tools/pre-execute listener');
    const frozen = { ...exec, arguments: deepFreeze(exec.arguments) };
    let delegated = 0;
    listener(frozen, () => {
        delegated += 1;
        return Promise.resolve({ kind: 'allow' });
    });
    assert.equal(delegated, 1, 'next() must always be delegated exactly once');
    return frozen;
}

const DELEGATION = {
    name: 'subagent',
    parameters: {
        type: 'object',
        properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
            provider: { type: 'string' },
            model: { type: 'string' },
            reasoning_effort: { type: 'string' },
        },
        required: ['description', 'prompt'],
    },
};

describe('blankKeys', () => {
    it('finds blank optional strings only', () => {
        const keys = blankKeys({ description: 'd', prompt: 'p', provider: '', model: '   ' }, DELEGATION.parameters);
        assert.deepEqual(keys, ['provider', 'model']);
    });

    it('never touches a required key', () => {
        assert.deepEqual(blankKeys({ description: '', prompt: '' }, DELEGATION.parameters), []);
    });

    it('never touches an undeclared key', () => {
        assert.deepEqual(blankKeys({ description: 'd', prompt: 'p', extra: '' }, DELEGATION.parameters), []);
    });

    it('only drops properties whose schema declares a string type', () => {
        const parameters = {
            type: 'object',
            properties: {
                n: { type: 'integer' },
                s: { type: 'string' },
                u: { type: ['string', 'null'] },
                plain: { description: 'no type declared' },
            },
        };
        // n 声明为 integer 却给了空串：属于值本身有问题，删掉会掩盖错误。
        // plain 没声明类型：不猜。
        assert.deepEqual(blankKeys({ n: '', s: 'x', u: '  ', plain: '' }, parameters), ['u']);
        assert.deepEqual(blankKeys({ n: '', plain: '' }, parameters), []);
    });

    it('honours dropWhitespaceOnly=false', () => {
        const args = { description: 'd', prompt: 'p', provider: '   ', model: '' };
        assert.deepEqual(blankKeys(args, DELEGATION.parameters, { dropWhitespaceOnly: false }), ['model']);
        assert.deepEqual(blankKeys(args, DELEGATION.parameters, { dropWhitespaceOnly: true }), ['provider', 'model']);
    });

    it('honours keepKeys', () => {
        const args = { description: 'd', prompt: 'p', provider: '', model: '' };
        assert.deepEqual(blankKeys(args, DELEGATION.parameters, { keepKeys: ['provider'] }), ['model']);
    });

    it('skips schemas without properties', () => {
        assert.deepEqual(blankKeys({ a: '' }, { type: 'object' }), []);
        assert.deepEqual(blankKeys({ a: '' }, undefined), []);
        assert.deepEqual(blankKeys(undefined, DELEGATION.parameters), []);
        assert.deepEqual(blankKeys([''], DELEGATION.parameters), []);
    });
});

describe('resolveConfig', () => {
    it('defaults', () => {
        assert.deepEqual(resolveConfig(undefined), {
            dropWhitespaceOnly: true,
            tools: [],
            excludeTools: [],
            keepKeys: [],
        });
    });

    it('normalizes lists and rejects bad types', () => {
        assert.deepEqual(resolveConfig({ tools: ['subagent', ' subagent ', 'subagent', 7], keepKeys: ['content'] }), {
            dropWhitespaceOnly: true,
            tools: ['subagent'],
            excludeTools: [],
            keepKeys: ['content'],
        });
        assert.throws(() => resolveConfig({ tools: 'subagent' }), TypeError);
        assert.throws(() => resolveConfig({ dropWhitespaceOnly: 'yes' }), TypeError);
    });
});

describe('apply', () => {
    it('drops blank optional args of a real call', () => {
        const harness = createCtx({ subagent: DELEGATION });
        apply(harness.ctx);
        const exec = dispatch(harness, {
            callId: 'call-1',
            name: 'subagent',
            arguments: { description: 'd', prompt: 'p', model: '', provider: '' },
        });
        assert.deepEqual(exec.arguments, { description: 'd', prompt: 'p' });
        assert.ok(Object.isFrozen(exec.arguments), 'replacement must be frozen');
        assert.match(harness.logs.debug[0], /dropped model, provider from subagent \(call-1\)/);
    });

    it('leaves a clean call untouched (same object identity)', () => {
        const harness = createCtx({ subagent: DELEGATION });
        apply(harness.ctx);
        const exec = dispatch(harness, {
            name: 'subagent',
            arguments: { description: 'd', prompt: 'p', model: 'x' },
        });
        assert.deepEqual(exec.arguments, { description: 'd', prompt: 'p', model: 'x' });
        assert.deepEqual(harness.logs.debug, []);
    });

    it('degrades to pass-through when the definition lookup throws', () => {
        const harness = createCtx(new Error('registry exploded'));
        apply(harness.ctx);
        const exec = dispatch(harness, { name: 'subagent', arguments: { description: 'd', prompt: 'p', model: '' } });
        assert.deepEqual(exec.arguments, { description: 'd', prompt: 'p', model: '' });
        assert.equal(harness.logs.warn.length, 1);
    });

    it('degrades to pass-through when the definition is missing', () => {
        const harness = createCtx({});
        apply(harness.ctx);
        const exec = dispatch(harness, { name: 'unknown_tool', arguments: { a: '' } });
        assert.deepEqual(exec.arguments, { a: '' });
        assert.deepEqual(harness.logs.warn, []);
    });

    it('uses the binding-time schema of a PTC inner call', () => {
        const harness = createCtx({});
        apply(harness.ctx);
        const exec = dispatch(harness, {
            name: 'inner',
            schema: { name: 'inner', description: '', parameters: { type: 'object', properties: { a: { type: 'string' } } } },
            arguments: { a: '' },
        });
        assert.deepEqual(exec.arguments, {});
    });

    it('respects tools / excludeTools / keepKeys', () => {
        const harness = createCtx({ subagent: DELEGATION, write: DELEGATION });
        apply(harness.ctx, { tools: ['subagent', 'write'], excludeTools: ['write'], keepKeys: ['provider'] });
        assert.match(harness.logs.info[0], /active for subagent, write \(excluded: write\)/);

        const written = dispatch(harness, { name: 'write', arguments: { description: 'd', prompt: 'p', model: '' } });
        assert.deepEqual(written.arguments, { description: 'd', prompt: 'p', model: '' }, 'excluded tool untouched');

        const dispatched = dispatch(harness, {
            name: 'subagent',
            arguments: { description: 'd', prompt: 'p', model: '', provider: '' },
        });
        assert.deepEqual(dispatched.arguments, { description: 'd', prompt: 'p', provider: '' });
    });

    it('ignores non-object arguments', () => {
        const harness = createCtx({ subagent: DELEGATION });
        apply(harness.ctx);
        for (const args of [undefined, null, 'text', ['a'], 42]) {
            const exec = dispatch(harness, { name: 'subagent', arguments: args });
            assert.equal(exec.arguments, args);
        }
    });

    it('leaves nested objects alone', () => {
        const parameters = {
            type: 'object',
            properties: { options: { type: 'object', properties: { model: { type: 'string' } } } },
        };
        const harness = createCtx({ t: { name: 't', parameters } });
        apply(harness.ctx);
        const exec = dispatch(harness, { name: 't', arguments: { options: { model: '' } } });
        assert.deepEqual(exec.arguments, { options: { model: '' } });
    });

    it('passes through when the exec object is frozen by a future runtime', () => {
        const harness = createCtx({ subagent: DELEGATION });
        apply(harness.ctx);
        const listener = harness.listeners.get('tools/pre-execute');
        const exec = Object.freeze({
            name: 'subagent',
            arguments: deepFreeze({ description: 'd', prompt: 'p', model: '' }),
        });
        let delegated = 0;
        listener(exec, () => {
            delegated += 1;
            return Promise.resolve({ kind: 'allow' });
        });
        assert.equal(delegated, 1);
        assert.deepEqual(exec.arguments, { description: 'd', prompt: 'p', model: '' });
        assert.equal(harness.logs.warn.length, 1);
    });
});
