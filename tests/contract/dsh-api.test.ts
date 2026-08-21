/**
 * dsh 依赖面契约测试。
 *
 * dsh 处于 developer preview，官方明确「THERE WILL BE COMPATIBILITY-BREAKING CHANGES」。
 * 对冲手段（research §1.3）：锁 commit SHA + 本测试断言我们**实际依赖的每一个导出符号**
 * 存在且形状正确。升级 dsh 时先跑本测试定位破坏面，再跑全量回归。
 *
 * 纪律：本测试只碰 package 的公开入口，绝不 import dsh 包内部的 src 子路径。
 */

import { describe, expect, it } from 'vitest'

import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

/** 我们依赖的 dsh 版本。升级后必须同步更新此常量与 README。 */
export const PINNED_DSH_VERSION = '0.1.0-rc.5'

describe('dsh 契约 · 模块导出', () => {
  it('cordis 提供 Context 与 Service 基类', () => {
    expect(typeof Context).toBe('function')
    expect(typeof Service).toBe('function')
  })

  it.each([
    ['AgentRegistry', AgentRegistry],
    ['AgentLoop', AgentLoop],
    ['LlmRuntime', LlmRuntime],
    ['SessionStore', SessionStore],
    ['SystemPrompt', SystemPrompt],
    ['ToolRuntime', ToolRuntime],
    ['JsonlSessionPersistence', JsonlSessionPersistence],
  ])('%s 是可挂载的插件', (_name, plugin) => {
    // cordis 插件既可以是函数也可以是 Service 子类；两者都是 function
    expect(typeof plugin).toBe('function')
  })

  it('dsh-llm-deepseek 以命名空间形式导出插件', () => {
    expect(LlmDeepSeek).toBeTypeOf('object')
    // 函数式插件的约定字段：apply 必备，name/inject 可选
    const candidate = LlmDeepSeek as Record<string, unknown>
    const mountable = typeof candidate['apply'] === 'function' || typeof candidate['default'] === 'function'
    expect(mountable).toBe(true)
  })

  it('LlmAdapter 是可继承的抽象基类（自研 mock adapter 依赖它）', () => {
    expect(typeof LlmAdapter).toBe('function')
    expect(typeof LlmAdapter.prototype).toBe('object')
  })

  it('createUserMessage / SessionId / defineTool 是函数', () => {
    expect(typeof createUserMessage).toBe('function')
    expect(typeof SessionId).toBe('function')
    expect(typeof defineTool).toBe('function')
  })
})

describe('dsh 契约 · defineTool 的三段式输出', () => {
  const tool = defineTool({
    name: 'contract_probe',
    description: '契约探针：验证 schema / render / presentationMeta 三段式仍然成立',
    parameters: {
      subject: { type: 'string', required: true, description: '探针主题' },
    },
    output: {
      schema: {
        type: 'object',
        // 契约 ①：object schema 必须显式声明 additionalProperties（省略会在 defineTool 期抛错）
        additionalProperties: false,
        // 契约 ②：未标 `required: true` 的属性在 InferValue 里是可选的（string | undefined），
        // 直接放进 presentationMeta 会因 JsonValue 不接受 undefined 而类型报错。
        // 我们所有业务工具的输出字段都必须显式标 required。
        properties: {
          subject: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `probe:${value.subject}` }],
      presentationMeta: (_args, value) => ({ protocolVersion: 1, subject: value.subject }),
    },
    async execute(args) {
      return { subject: args.subject, ok: true }
    },
  })

  it('产出带 name/description/parameters 的工具定义', () => {
    expect(tool.name).toBe('contract_probe')
    expect(tool.description).toContain('契约探针')
    expect(tool).toHaveProperty('parameters')
  })

  it('保留 output.schema / render / presentationMeta 三段', () => {
    expect(tool.output).toBeTypeOf('object')
    expect(tool.output.schema).toBeTypeOf('object')
    expect(typeof tool.output.render).toBe('function')
    expect(typeof tool.output.presentationMeta).toBe('function')
  })

  it('render 与 presentationMeta 是纯函数：同输入同输出，且不互相影响', () => {
    const args = { subject: 'alpha' }
    const value = { subject: 'alpha', ok: true }
    const first = tool.output.render(args, value)
    const second = tool.output.render(args, value)
    expect(first).toEqual(second)
    expect(tool.output.presentationMeta?.(args, value)).toEqual({ protocolVersion: 1, subject: 'alpha' })
  })

  it('execute 返回符合 schema 的 canonical value', async () => {
    const value = await tool.execute({ subject: 'beta' }, {} as never)
    expect(value).toEqual({ subject: 'beta', ok: true })
  })
})

describe('dsh 契约 · Context 生命周期', () => {
  it('可以构造 Context 并挂载/卸载插件（registrations are effects）', async () => {
    const ctx = new Context()
    let applied = 0
    let disposed = 0

    const fork = await ctx.plugin(function probePlugin(inner: Context) {
      applied += 1
      inner.effect(() => () => {
        disposed += 1
      })
    })

    expect(applied).toBe(1)
    expect(disposed).toBe(0)

    // 契约：Fiber.dispose() 是异步的，卸载后所有 effect 逆序释放
    await fork.dispose()
    expect(disposed).toBe(1)
  })
})
