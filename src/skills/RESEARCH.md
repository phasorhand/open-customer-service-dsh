# skills · OSS 调研

## 目标
把「客服话术 / SOP」表达为可由运营维护的 Markdown 文件，让 agent 在每轮对话中
选出相关的几条注入 prompt——既不把全部话术塞进 context（成本），也不靠硬编码规则（僵化）。

## 候选对比

| 候选 | License | 最近 commit | 体量 | 评分 | 备注 |
|---|---|---|---|---|---|
| [`@deepseek-ai/dsh-skill`](../../../deepseek-harness/packages/skill/skill) + [`dsh-skill-filesystem`](../../../deepseek-harness/packages/skill/skill-filesystem) | MIT | 2026-08（同 dsh 主版本） | 小 | ✅ **复用** | 已在依赖树内；提供 `ctx.skills` provider 注册表 + SKILL.md 扫描/frontmatter 解析/chokidar 监听/`renderSkillContent()` 规范化渲染。与 Python 版 `SkillRepo` 职责**完全重合** |
| [anthropics/skills](https://github.com/anthropics/skills) 约定 | — | — | — | ⏸ | 是**格式约定**而非库；dsh-skill-filesystem 已实现该约定（SKILL.md + frontmatter），等于间接复用 |
| 自建 SkillRepo（照搬 Python 版） | — | — | ~150 行 | ❌ | 会重写 dsh 已有的扫描/解析/监听/失效逻辑，且丢掉 `ctx.skills` 的 scope 分层能力（未来按租户/预设隔离技能时要重做） |

## 决策

**复用**：`@deepseek-ai/dsh-skill @ 0.1.0-rc.5` + `@deepseek-ai/dsh-skill-filesystem @ 0.1.0-rc.5`，
薄封装在 `src/skills/repo.ts`。

关键配置（避免污染）：

```ts
{ includeDefaultRoots: false, customSkillDirs: [config.paths.skillsDir] }
```

默认 `includeDefaultRoots: true` 会扫描 `$DSH_HOME/skills` 与 `~/.agents` ——
那是**开发者机器上的个人技能**，绝不能混进服务端的客服话术库。

## 自建的部分（dsh 不提供的业务语义）

dsh 的 `SkillSummary` 只有 `name` / `description` / `invocation` 等通用字段。
OpenCS 需要三个额外的**路由语义**，由薄封装解析。

> **实测发现（2026-08-21）**：`dsh-skill-filesystem` 只识别 frontmatter 的
> `name` / `description` / `whenToUse` / `metadata` / 两个 invocation 开关，
> **其余顶层键一律忽略**。因此 OpenCS 的字段必须嵌在 `metadata:` 之下——
> 那正是 dsh 留给下游的开放扩展点：
>
> ```yaml
> ---
> name: refund-escalation
> description: 处理退款请求
> metadata:
>   priority: 80
>   routing: cs_reply
>   intent_signals: [想退款, 退货]
> ---
> ```
>
> 未写 `intent_signals` 时退回 dsh 原生的 `whenToUse` 作为路由线索。

| 字段 | 用途 | 为什么 dsh 不提供 |
|---|---|---|
| `priority` | 紧凑索引里的排序权重 | 通用框架不知道「哪条话术更重要」 |
| `routing` | 该技能由哪个 worker/subagent 处理 | 是 OpenCS 的多 agent 拓扑，不是框架概念 |
| `intent_signals` | 给模型做技能选择的意图线索 | 两轮选择法是 OpenCS 的 prompt 策略 |

以及**两轮技能选择**本身（`src/skills/selection.ts`）：
Round 1 注入紧凑索引 → 模型输出 `[SKILLS: a, b]` → Round 2 注入选中技能正文。
这是 Python 版已验证有效的 context 成本控制手段，属于 prompt 工程而非框架能力。

## 集成边界

```ts
interface SkillPort {
  buildIndex(): Promise<string>              // 紧凑索引，注入 system prompt
  load(names: readonly string[]): Promise<readonly LoadedSkill[]>  // 正文
}
```

工具层与 prompt 注入层只认这个接口。dsh 的 `ctx.skills` 类型不外泄到业务代码，
未来若 dsh 的 skill API 破坏性变更，只需改 `repo.ts` 一处。

## 升级与停更预案

- 与 dsh 主版本同步升级，由 `tests/contract/dsh-api.test.ts` 覆盖 `ctx.skills` 的
  `registerProvider` / `list` / `get` 三个方法
- 若 dsh 移除 skill 子系统：退回自建（~150 行，格式不变，SKILL.md 文件无需迁移）
