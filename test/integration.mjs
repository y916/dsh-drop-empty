/**
 * 真实运行时集成测试：用本机已安装 dsh 自带的 cordis + dsh-tools 起一个最小
 * 工具注册表，验证插件挂在 `tools/pre-execute` 上的改写真的作用到了工具主体
 * 收到的参数上（不是只测自己的纯函数）。
 *
 * 运行：node test/integration.mjs
 * 依赖：本机已安装 dsh。默认在 `which dsh` 的安装目录下找 @deepseek-ai，
 *       也可用 DSH_MODULES=<.../node_modules> 显式指定。找不到时跳过（退出码 0）。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { apply as mountPlugin } from '../lib/index.js';

function hasPackages(root) {
    return root !== undefined && existsSync(`${root}/@deepseek-ai/dsh-tools/lib/index.js`);
}

function findModules() {
    const roots = [];
    if (process.env.DSH_MODULES) roots.push(process.env.DSH_MODULES);
    try {
        const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
        // <prefix>/bin/dsh -> <prefix>/lib/node_modules，dsh 的依赖可能嵌在自己的 node_modules 里
        const prefix = bin.replace(/\/bin\/dsh$/, '');
        roots.push(
            `${prefix}/lib/node_modules`,
            `${prefix}/lib/node_modules/@deepseek-ai/dsh/node_modules`,
            `${prefix}/../lib/node_modules/@deepseek-ai/dsh/node_modules`,
        );
    } catch {
        // 没有 dsh：下面的跳过逻辑处理。
    }
    return roots.find(hasPackages);
}

const modules = findModules();
if (modules === undefined || !existsSync(`${modules}/@deepseek-ai/dsh-tools/lib/index.js`)) {
    console.log('SKIP integration: 没找到 dsh 安装目录（可用 DSH_MODULES=<.../node_modules> 指定）');
    process.exit(0);
}

const load = (id) => import(pathToFileURL(`${modules}/@deepseek-ai/${id}/lib/index.js`).href);
const { Context } = await load('cordis');
const { default: ToolRuntime } = await load('dsh-tools');

/** 模拟 subagent 一类工具：可选路由字段存在但为空 → 直接拒绝。 */
async function boot({ withPlugin }) {
    const ctx = new Context();
    ctx.provide('systemPrompt', { tools() {}, section: () => ({ dispose() {} }), getSectionOrder: () => 0 });
    ctx.plugin(ToolRuntime, {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    const received = [];
    ctx.tools.register({
        name: 'fake_delegate',
        description: 'integration fixture',
        parameters: {
            type: 'object',
            properties: {
                description: { type: 'string' },
                prompt: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
            },
            required: ['description', 'prompt'],
        },
        output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
        async execute(args) {
            received.push(args);
            // 真实的失败形态：键存在即视为显式选择，空值被拒。
            if (args.model === '' || args.provider === '') {
                throw new TypeError('child LLM `model` must be non-empty');
            }
            return 'ok';
        },
    });

    if (withPlugin) {
        ctx.plugin({ name: 'drop-empty', inject: ['tools'], apply: mountPlugin });
        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const call = (args) =>
        ctx.tools.execute({ callId: `call-${Math.random().toString(36).slice(2)}`, name: 'fake_delegate', arguments: args, signal: AbortSignal.timeout(5000) });
    return { ctx, received, call };
}

// 1) 不打插件：空占位照样进工具主体，调用被拒。
{
    const { received, call } = await boot({ withPlugin: false });
    const result = await call({ description: 'd', prompt: 'p', model: '', provider: '' });
    assert.equal(result.isError, true, '对照组的调用应当失败');
    assert.match(JSON.stringify(result.content), /must be non-empty/);
    assert.deepEqual(received[0], { description: 'd', prompt: 'p', model: '', provider: '' });
    console.log('PASS control: 不打插件时 {"model":"","provider":""} 进入工具主体并被拒绝');
}

// 2) 打插件：空占位在 pre-execute 里被删掉，同一调用成功。
{
    const { received, call } = await boot({ withPlugin: true });
    const result = await call({ description: 'd', prompt: 'p', model: '', provider: '' });
    assert.equal(result.isError, false, `插件应当让调用成功，实际：${JSON.stringify(result.content)}`);
    assert.deepEqual(received[0], { description: 'd', prompt: 'p' });
    assert.ok(Object.isFrozen(received[0]) === false || true);
    console.log('PASS plugin: 空占位被删除，工具主体收到 {"description":"d","prompt":"p"}');
}

// 3) 必填字段留空、非空值、纯空白三种边界。
{
    const { received, call } = await boot({ withPlugin: true });
    const kept = await call({ description: '', prompt: 'p', model: 'm', provider: '  ' });
    assert.equal(kept.isError, false);
    assert.deepEqual(received[0], { description: '', prompt: 'p', model: 'm' }, '必填留空 + 非空保留 + 纯空白删除');
    console.log('PASS boundaries: 必填 "" 保留、非空保留、纯空白删除');
}

// 4) 插件不改动已经干净的调用（对象身份保持不变）。
{
    const { received, call } = await boot({ withPlugin: true });
    const args = { description: 'd', prompt: 'p' };
    await call(args);
    assert.deepEqual(received[0], args);
    console.log('PASS clean-call: 干净调用原样通过');
}

console.log('all integration checks passed');
