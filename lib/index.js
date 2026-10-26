/**
 * dsh-drop-empty — DeepSeek Harness (dsh) 插件。
 *
 * 模型经常在"自己没意见"的可选参数上填一个空占位（`""` 或纯空白），
 * 例如 subagent 派发时带上 `{"model": "", "provider": ""}`。宿主工具会把
 * "键存在且值为空"当成显式选择而拒绝整次调用。本插件在 `tools/pre-execute`
 * 里删掉「tool schema 未声明为必填」且「值为空白字符串」的顶层参数，
 * 让调用按"模型什么都没说"处理。
 *
 * 设计约束（为什么这样做）：
 * - 只动 schema 声明过的、非必填的键。必填键留空、未声明的键一律不碰 ——
 *   前者应该让工具自己的校验错误暴露出来，后者可能是有意的额外参数。
 * - 不做递归：嵌套对象里的空字符串保持原样（子 schema 的必填信息不在这里解析）。
 * - 默认只删顶层空白字符串，不删 `null` —— `null` 在部分工具里是合法取值。
 * - 任何异常（拿不到 schema、exec 被冻结等）都降级为原样放行，绝不影响这次调用。
 *
 * @see https://github.com/deepseek-ai/deepseek-harness
 */

/** cordis 插件名（与管理面板/日志里的标识一致）。 */
export const name = 'drop-empty';

/** 需要 `ctx.tools` 就绪后才挂载。 */
export const inject = ['tools'];

const CONFIG_DEFAULTS = {
    /** 纯空白（`"   "`、`"\n"`）也算空值。默认 true。 */
    dropWhitespaceOnly: true,
    /** 只处理这些工具名；空数组表示所有工具。 */
    tools: [],
    /** 永不处理这些工具名。 */
    excludeTools: [],
    /** 永不删除的参数名（无论值是否为空）。 */
    keepKeys: [],
};

/** @param {unknown} value */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把用户配置解析成规范形式；非法类型直接抛错（插件配置是外部输入）。 */
export function resolveConfig(raw) {
    const source = isRecord(raw) ? raw : {};
    const list = (key) => {
        const value = source[key];
        if (value === undefined) return [...CONFIG_DEFAULTS[key]];
        if (!Array.isArray(value)) throw new TypeError(`drop-empty: config.${key} 必须是字符串数组`);
        return [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
    };
    const dropWhitespaceOnly = source.dropWhitespaceOnly;
    if (dropWhitespaceOnly !== undefined && typeof dropWhitespaceOnly !== 'boolean') {
        throw new TypeError('drop-empty: config.dropWhitespaceOnly 必须是布尔值');
    }
    return {
        dropWhitespaceOnly: dropWhitespaceOnly ?? CONFIG_DEFAULTS.dropWhitespaceOnly,
        tools: list('tools'),
        excludeTools: list('excludeTools'),
        keepKeys: list('keepKeys'),
    };
}

/**
 * 该属性的 schema 是否声明了字符串类型。
 * 声明成 `integer` / `boolean` 之类却拿到 `""` 属于值本身有问题，删掉会掩盖错误，
 * 所以只有声明了 string 的属性才参与"空占位"判定。
 * @param {unknown} schema 属性级 JSON Schema。
 */
function declaresString(schema) {
    if (!isRecord(schema)) return false;
    if (schema.type === 'string') return true;
    if (Array.isArray(schema.type) && schema.type.includes('string')) return true;
    for (const branch of ['oneOf', 'anyOf']) {
        const candidates = schema[branch];
        if (Array.isArray(candidates) && candidates.some((item) => declaresString(item))) return true;
    }
    return false;
}

/**
 * 找出应当删除的参数名。
 * @param {Record<string, unknown>} args 模型给出的参数对象。
 * @param {Record<string, unknown>} parameters 该工具的 JSON Schema（`{type,properties,required}`）。
 * @param {{dropWhitespaceOnly?: boolean, keepKeys?: Iterable<string>}} [options]
 * @returns {string[]} 要删除的键；空数组表示无需改动。
 */
export function blankKeys(args, parameters, options = {}) {
    const dropWhitespaceOnly = options.dropWhitespaceOnly ?? true;
    const keep = options.keepKeys === undefined ? new Set() : new Set(options.keepKeys);
    if (!isRecord(args) || !isRecord(parameters)) return [];
    const properties = parameters.properties;
    // 没有 properties 的 schema（自由形态参数）不猜。
    if (!isRecord(properties)) return [];
    const required = new Set(
        Array.isArray(parameters.required) ? parameters.required.filter((key) => typeof key === 'string') : [],
    );
    const blank = [];
    for (const [key, value] of Object.entries(args)) {
        if (required.has(key) || keep.has(key)) continue;
        if (!Object.hasOwn(properties, key)) continue;
        if (!declaresString(properties[key])) continue;
        if (typeof value !== 'string') continue;
        if (value === '' || (dropWhitespaceOnly && value.trim() === '')) blank.push(key);
    }
    return blank;
}

/**
 * 在 `tools/pre-execute` 里就地替换 `exec.arguments`。
 * 只做浅层替换：顶层键删除后重新冻结一份新对象，原对象零改动。
 * @param {any} ctx cordis 上下文。
 * @param {any} exec 待执行的调用。
 * @param {{dropWhitespaceOnly: boolean, keepKeys: Set<string>}} config
 * @param {(message: string, error?: unknown) => void} warn 只报警一次的降级报告。
 * @returns {string[]} 实际删除的键；空数组表示未改动。
 */
function rewrite(ctx, exec, config, warn) {
    if (!isRecord(exec)) return [];
    if (typeof exec.name !== 'string') return [];
    if (!isRecord(exec.arguments)) return [];

    let parameters;
    try {
        const definition = ctx.tools.get(exec.name, exec.agent);
        if (isRecord(definition) && isRecord(definition.parameters)) parameters = definition.parameters;
    } catch (error) {
        warn(`could not resolve the definition of ${exec.name}`, error);
    }
    if (parameters === undefined && isRecord(exec.schema) && isRecord(exec.schema.parameters)) {
        // PTC 内层调用只带绑定期 schema，没有注册表定义可查。
        parameters = exec.schema.parameters;
    }
    if (parameters === undefined) return [];

    const dropped = blankKeys(exec.arguments, parameters, config);
    if (dropped.length === 0) return [];

    const drop = new Set(dropped);
    const cleaned = Object.fromEntries(Object.entries(exec.arguments).filter(([key]) => !drop.has(key)));
    // 赋到已经冻结的 exec 上会抛 TypeError，由 apply 的 try/catch 兜住并降级放行。
    exec.arguments = Object.freeze(cleaned);
    return dropped;
}

/**
 * @param {any} ctx cordis 上下文。
 * @param {unknown} [rawConfig] 插件配置（cordis.patch.yml 的 `config`）。
 */
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    const only = new Set(config.tools);
    const excluded = new Set(config.excludeTools);
    const keepKeys = new Set(config.keepKeys);
    const enabled = (toolName) => (only.size === 0 || only.has(toolName)) && !excluded.has(toolName);

    let warned = false;
    const warn = (message, error) => {
        if (warned) return;
        warned = true;
        try {
            ctx.logger.warn(`drop-empty: ${message}`, error);
        } catch {
            // 日志通道失败绝不能影响调用。
        }
    };

    if (only.size === 0 && excluded.size === 0) {
        ctx.logger.info('drop-empty: active for every tool');
    } else {
        ctx.logger.info(
            `drop-empty: active${only.size === 0 ? '' : ` for ${[...only].join(', ')}`}` +
                `${excluded.size === 0 ? '' : ` (excluded: ${[...excluded].join(', ')})`}`,
        );
    }

    ctx.on('tools/pre-execute', (exec, next) => {
        try {
            if (enabled(exec?.name)) {
                const dropped = rewrite(ctx, exec, { dropWhitespaceOnly: config.dropWhitespaceOnly, keepKeys }, warn);
                if (dropped.length > 0) {
                    ctx.logger.debug(
                        `drop-empty: dropped ${dropped.join(', ')} from ${exec.name}` +
                            `${exec.callId === undefined ? '' : ` (${exec.callId})`}`,
                    );
                }
            }
        } catch (error) {
            // 失败即放行：宁可带着空参数让工具自己报错，也不阻断调用。
            warn(`skipped one call for ${String(exec?.name)}: ${error instanceof Error ? error.message : String(error)}`, error);
        }
        return next();
    });
}
