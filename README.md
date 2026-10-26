# dsh-drop-empty

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/DSH-plugin-5b50ed.svg)](https://github.com/deepseek-ai/deepseek-harness)

DeepSeek Harness（dsh）插件：删掉模型在**非必填参数**上填的空占位（`""` / 纯空白），
让调用按"模型什么都没说"处理，而不是被工具当成显式选择而拒绝。

```
模型给出：{"model": "", "provider": ""}      工具收到：{}
```

仓库：<https://github.com/y916/dsh-drop-empty> · [English summary](#english-summary)

## 解决什么问题

模型（尤其小参数、长会话、或刚从上一个宿主迁过来时）习惯把工具 schema 里
所有可选字段都填满，没有意见的就填一个空串。对一部分工具来说"键存在"就等于
"模型做了显式选择"，于是空串一路走到校验，整次调用失败，例如：

- 子代理派发：`child LLM 'provider' must be non-empty`
- 其它工具把空串当成"选择了空值"而报必填/取值非法

这类失败有一个共同点：**模型的行为和省略该参数完全等价**，只是它把"省略"写成了 `""`。
本插件在工具执行前把这些空占位删掉。

## 行为规则（刻意保守）

只删除同时满足以下四条的参数：

1. 值是非空白的**空字符串**——`""`，或（默认开启时）`"   "`、`"\n"` 这类纯空白；
2. 该参数**在本次工具 schema 的 `properties` 里声明过**（未声明的键不猜）；
3. 该参数**不在 `required` 里**（必填留空应让工具自己报错，而不是被我们悄悄改成"缺失"）；
4. 该属性的 schema **声明了 string 类型**（`type: "string"`、`type` 数组含 `"string"`、
   或 `oneOf`/`anyOf` 分支里有 string）。声明成 `integer` 却给了 `""` 属于值本身有问题，
   删掉会掩盖错误。

不做的事：

- 不删 `null`（部分工具里 `null` 是合法取值，语义与 `""` 不同）；
- 不递归进嵌套对象（子 schema 的必填信息在顶层解析不到，宁可不猜）；
- 不碰数组元素；
- 任何异常（查不到工具定义、`exec` 被未来版本冻结等）都**降级为原样放行**，绝不影响本次调用。

## 实现位置与取舍

挂在官方 `tools/pre-execute` waterfall 上。该 seam 的 `PreToolDecision` 官方不提供改写
参数的通道（源码注释：`Input rewriting is excluded because arguments are already logged
and presented`），但这一阶段传入的 `exec` 对象本身还没被冻结（只有 `exec.arguments` 被
`deepFreeze`），所以做法是：算出要删的键 → 构造新的冻结对象 → 赋给 `exec.arguments`。
宿主随后执行工具主体时读的就是这个新对象（`dsh-tools/lib/index.js` 的 `dispatchToolBody`：
`await tool.execute(exec.arguments, exec)`）。

副作用（已知且可接受）：会话日志里保存的仍是模型原始参数（含空串）。也就是说
"执行"被修好了，"落盘的历史"保持原样。若需要连历史一起干净，应改挂 `llm/stream`
（参考 `dsh-tool-args-unwrap` 的 clone-on-write 写法），代价是那段代码要处理
`deepFreeze` 的请求对象。

## 安装

```bash
# 从 GitHub 安装（pnpm 的 git 宿主简写；本仓库的验证环境未实测成功，见下）
dsh plugin --profile web add github:y916/dsh-drop-empty

# 或从本地目录安装（已验证；开发时也可这样，profile 里是指向该目录的链接）
dsh plugin --profile web add ~/path/to/dsh-drop-empty
```

装完重启 dsh（`dsh web`）生效。尚未发布到 npm，不要用裸包名安装。

用本地目录安装时，profile 里是指向本目录的链接，之后改本目录的 `lib/index.js`
不需要重新安装（profile 的 `patchReload: live` 只有重启后才生效）。

## 配置

默认对所有工具生效、无需配置。需要收窄范围时在自己的 profile `cordis.patch.yml` 里覆盖该行：

```yaml
- id: drop-empty
  config:
    tools: [subagent, subagent_fork]   # 只处理这些工具，空数组/不写 = 所有工具
    excludeTools: [write, edit]        # 永不处理这些工具
    keepKeys: [content, query]         # 这些参数名永不删除
    dropWhitespaceOnly: true           # false 时只删 ""，保留 "   "
```

## 验证

```bash
cd ~/path/to/dsh-drop-empty
node --test test/index.test.js     # 18 个纯函数/监听器用例
node test/integration.mjs          # 真实 dsh 运行时集成测试（需要本机已装 dsh）
```

`test/integration.mjs` 用本机安装的 `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` 起一个
真实工具注册表，注册一个"可选字段存在但为空就报错"的假工具，然后跑四次调用：

| 用例 | 期望 |
|---|---|
| 不打插件 | 工具主体收到 `{"model":"","provider":""}`，调用失败 |
| 打插件 | 工具主体收到 `{"description","prompt"}`，调用成功 |
| 边界 | 必填 `""` 保留、非空保留、纯空白删除 |
| 干净调用 | 原样通过 |

找不到 dsh 安装目录时脚本打印 SKIP 并退出 0；可用 `DSH_MODULES=<.../node_modules>` 指定。

## 已知限制

- 只处理顶层参数，嵌套对象的空串不动。
- 只能修"执行"，不能修会话日志里已经落盘的历史参数。
- 依赖 `exec.arguments` 在 pre-execute 阶段可赋值这一现状。宿主若在将来版本连 `exec`
  一起冻结，插件会静默降级为不改动（集成测试会暴露，插件不会阻断调用）。
- 同时装了别的 `tools/pre-execute` 改写类插件时，以最后写入者为准（本插件只在确有删除时才写）。

## English summary

A DeepSeek Harness (dsh) plugin that deletes blank-string arguments (`""`, or
whitespace-only) that the tool's own JSON Schema does not list as required, so a
model that reflexively fills every optional field with an empty placeholder no
longer kills the call:

```
model sends {"model": "", "provider": ""}   ->   tool receives {}
```

Conservative by construction: only keys declared in `properties`, not in
`required`, and whose schema declares a `string` type are touched; `null`,
nested objects, array elements and undeclared keys are left alone. Any internal
failure degrades to a pass-through, so the plugin can never block a call.

It hooks the official `tools/pre-execute` waterfall and replaces the
(deep-frozen) `exec.arguments` with a cleaned copy — the harness reads that
property when it dispatches the tool body. Session logs keep the model's
original arguments; only execution is repaired.

Install: `dsh plugin --profile web add github:y916/dsh-drop-empty`, then restart
dsh. Not published to npm yet. MIT licensed.
