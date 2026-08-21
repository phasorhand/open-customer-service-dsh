import { describe, expect, it } from 'vitest'

import { ConfigError, MIN_SECRET_BYTES, loadConfig } from '../../src/config.js'

/** 生产环境的最小可用环境变量集合。 */
function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCS_ENV: 'production',
    OPENCS_ACTION_TOKEN_SECRET: 'x'.repeat(MIN_SECRET_BYTES),
    OPENCS_ADMIN_TOKEN: 'admin-token-16bytes!',
    DEEPSEEK_API_KEY: 'sk-test',
    ...overrides,
  }
}

describe('loadConfig · 默认值', () => {
  it('空环境下降级为 development + mock 模型', () => {
    const cfg = loadConfig({})
    expect(cfg.env).toBe('development')
    expect(cfg.llm.kind).toBe('mock')
    expect(cfg.tenantId).toBe('default')
    expect(cfg.port).toBe(8080)
    expect(cfg.autoApproveTiers).toEqual([0, 1, 2, 3])
  })

  it('未配置 secret 时生成临时密钥（仅非生产）', () => {
    const a = loadConfig({})
    const b = loadConfig({})
    expect(a.actionTokenSecret).not.toBe(b.actionTokenSecret)
    expect(a.actionTokenSecret.startsWith('ephemeral-')).toBe(true)
  })

  it('nurture 默认开启，并发 8，租约 300s', () => {
    const { nurture } = loadConfig({})
    expect(nurture).toEqual({
      enabled: true,
      pollIntervalSeconds: 60,
      drainConcurrency: 8,
      leaseSeconds: 300,
    })
  })

  it('路径被解析为绝对路径', () => {
    const cfg = loadConfig({ OPENCS_DATA_DIR: './tmp-data' })
    expect(cfg.paths.dataDir.startsWith('/')).toBe(true)
    expect(cfg.paths.sessionsDir.endsWith('/sessions')).toBe(true)
  })
})

describe('loadConfig · LLM 供应方选择', () => {
  it('DEEPSEEK_API_KEY 优先', () => {
    const cfg = loadConfig({ DEEPSEEK_API_KEY: 'sk-ds', OPENAI_API_KEY: 'sk-oa' })
    expect(cfg.llm.kind).toBe('deepseek')
    expect(cfg.llm.apiKey).toBe('sk-ds')
  })

  it('仅有 OPENAI_API_KEY 时走 OpenAI 兼容网关', () => {
    const cfg = loadConfig({ OPENAI_API_KEY: 'sk-oa', OPENAI_BASE_URL: 'https://gw.example/v1' })
    expect(cfg.llm.kind).toBe('openai-compatible')
    expect(cfg.llm.baseUrl).toBe('https://gw.example/v1')
  })

  it('空串不算已配置，仍降级为 mock', () => {
    const cfg = loadConfig({ DEEPSEEK_API_KEY: '   ', OPENAI_API_KEY: '' })
    expect(cfg.llm.kind).toBe('mock')
  })

  it('生产环境不允许降级为 mock', () => {
    expect(() => loadConfig({ OPENCS_ENV: 'production', OPENCS_ACTION_TOKEN_SECRET: 'x'.repeat(32) })).toThrow(
      ConfigError,
    )
  })
})

describe('loadConfig · 生产环境 fail loud', () => {
  it('缺少 action token secret 直接报错', () => {
    const env = productionEnv()
    delete env['OPENCS_ACTION_TOKEN_SECRET']
    expect(() => loadConfig(env)).toThrow(/OPENCS_ACTION_TOKEN_SECRET/)
  })

  it('secret 太短直接报错', () => {
    expect(() => loadConfig(productionEnv({ OPENCS_ACTION_TOKEN_SECRET: 'short' }))).toThrow(
      new RegExp(String(MIN_SECRET_BYTES)),
    )
  })

  it('齐全时通过', () => {
    const cfg = loadConfig(productionEnv())
    expect(cfg.env).toBe('production')
    expect(cfg.llm.kind).toBe('deepseek')
  })
})

describe('loadConfig · 管理凭证', () => {
  it('生产环境缺 OPENCS_ADMIN_TOKEN 直接报错', () => {
    const env = productionEnv()
    delete env['OPENCS_ADMIN_TOKEN']
    expect(() => loadConfig(env)).toThrow(/OPENCS_ADMIN_TOKEN/)
  })

  it('token 太短报错', () => {
    expect(() => loadConfig(productionEnv({ OPENCS_ADMIN_TOKEN: 'short' }))).toThrow(/16 字节/)
  })

  it('开发环境允许缺省（无鉴权，仅限本地）', () => {
    expect(loadConfig({}).adminToken).toBeUndefined()
  })

  it('webhook 频控默认 20 条/分钟', () => {
    expect(loadConfig({}).webhookRateLimit).toBe(20)
  })
})

describe('loadConfig · 数值与列表校验', () => {
  it('端口越界报错', () => {
    expect(() => loadConfig({ OPENCS_PORT: '70000' })).toThrow(ConfigError)
  })

  it('非整数并发数报错', () => {
    expect(() => loadConfig({ OPENCS_NURTURE_DRAIN_CONCURRENCY: '2.5' })).toThrow(ConfigError)
  })

  it('风险档列表可自定义', () => {
    const cfg = loadConfig({ OPENCS_AUTO_APPROVE_TIERS: '0, 1' })
    expect(cfg.autoApproveTiers).toEqual([0, 1])
  })

  it('风险档超出 0..5 报错', () => {
    expect(() => loadConfig({ OPENCS_AUTO_APPROVE_TIERS: '0,9' })).toThrow(ConfigError)
  })

  it('布尔量识别 false/0/off', () => {
    expect(loadConfig({ OPENCS_NURTURE_ENABLED: 'false' }).nurture.enabled).toBe(false)
    expect(loadConfig({ OPENCS_NURTURE_ENABLED: '0' }).nurture.enabled).toBe(false)
    expect(loadConfig({ OPENCS_NURTURE_ENABLED: 'on' }).nurture.enabled).toBe(true)
  })
})

describe('loadConfig · 可选集成', () => {
  it('企微四件套必须同时配置', () => {
    expect(() => loadConfig({ WECOM_CORP_ID: 'corp' })).toThrow(/同时配置/)
    expect(() => loadConfig({ WECOM_CORP_ID: 'corp', WECOM_TOKEN: 'tok' })).toThrow(/同时配置/)
  })

  it('企微四件套齐全时生效', () => {
    const aesKey = 'a'.repeat(43)
    const cfg = loadConfig({
      WECOM_CORP_ID: 'corp',
      WECOM_CORP_SECRET: 'secret',
      WECOM_TOKEN: 'tok',
      WECOM_ENCODING_AES_KEY: aesKey,
    })
    expect(cfg.wecom).toEqual({ corpId: 'corp', corpSecret: 'secret', token: 'tok', encodingAesKey: aesKey })
  })

  it('EncodingAESKey 必须是 43 位', () => {
    expect(() =>
      loadConfig({ WECOM_CORP_ID: 'c', WECOM_CORP_SECRET: 's', WECOM_TOKEN: 't', WECOM_ENCODING_AES_KEY: 'short' }),
    ).toThrow(/43 位/)
  })

  it('Langfuse 缺 key 时整体关闭', () => {
    expect(loadConfig({ LANGFUSE_HOST: 'http://lf' }).langfuse).toBeUndefined()
  })

  it('Langfuse 双 key 齐全时启用并带默认 host', () => {
    const cfg = loadConfig({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' })
    expect(cfg.langfuse).toEqual({ host: 'http://localhost:3000', publicKey: 'pk', secretKey: 'sk' })
  })
})
