/**
 * 运行时配置：环境变量 → 校验后的 `RuntimeConfig`。
 *
 * 纪律（spec §7）：可调参数一律进 validated config，不硬编码 DEFAULT_* 常量；
 * 生产环境配置错误必须 fail loud，不允许静默降级。
 */

import { resolve } from 'node:path'
import { z } from 'zod'

export const ENVIRONMENTS = ['development', 'test', 'production'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

/** LLM 供应方：三选一，均未配置时降级为确定性 mock（离线开发 / CI 无 key 也全绿）。 */
export type LlmKind = 'deepseek' | 'openai-compatible' | 'mock'

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === '') return fallback
      return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
    })

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return fallback
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `期望 ${min}..${max} 的整数，收到 ${raw}` })
        return z.NEVER
      }
      return parsed
    })

const str = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? fallback : raw.trim()))

/** 可选字符串：空串归一化为 undefined，避免 "" 被当成已配置。 */
const optionalStr = z
  .string()
  .optional()
  .transform((raw) => (raw === undefined || raw.trim() === '' ? undefined : raw.trim()))

/** 逗号分隔的风险档列表，如 `0,1,2,3`。 */
const tierList = (fallback: readonly number[]) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return [...fallback]
      const parts = raw.split(',').map((p) => p.trim()).filter((p) => p !== '')
      const out: number[] = []
      for (const part of parts) {
        const n = Number(part)
        if (!Number.isInteger(n) || n < 0 || n > 5) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `风险档必须是 0..5 的整数，收到 ${part}` })
          return z.NEVER
        }
        out.push(n)
      }
      return out
    })

const EnvSchema = z.object({
  OPENCS_ENV: z.enum(ENVIRONMENTS).optional(),
  OPENCS_DATA_DIR: str('./data'),
  OPENCS_KNOWLEDGE_DIR: str('./knowledge'),
  OPENCS_SKILLS_DIR: str('./skills'),
  OPENCS_TENANT_ID: str('default'),
  OPENCS_HOST: str('0.0.0.0'),
  OPENCS_PORT: int(8080, 1, 65535),

  OPENCS_MODEL: str('deepseek-chat'),
  DEEPSEEK_API_KEY: optionalStr,
  DEEPSEEK_BASE_URL: optionalStr,
  OPENAI_API_KEY: optionalStr,
  OPENAI_BASE_URL: optionalStr,

  OPENCS_ACTION_TOKEN_SECRET: optionalStr,
  OPENCS_AUTO_APPROVE_TIERS: tierList([0, 1, 2, 3]),

  OPENCS_NURTURE_ENABLED: bool(true),
  OPENCS_NURTURE_POLL_INTERVAL: int(60, 1, 86_400),
  OPENCS_NURTURE_DRAIN_CONCURRENCY: int(8, 1, 64),
  OPENCS_NURTURE_LEASE_SECONDS: int(300, 30, 7_200),

  WECOM_CORP_ID: optionalStr,
  WECOM_TOKEN: optionalStr,
  WECOM_ENCODING_AES_KEY: optionalStr,

  LANGFUSE_HOST: optionalStr,
  LANGFUSE_PUBLIC_KEY: optionalStr,
  LANGFUSE_SECRET_KEY: optionalStr,
})

export interface LlmConfig {
  readonly kind: LlmKind
  readonly model: string
  readonly apiKey?: string
  readonly baseUrl?: string
}

export interface PathConfig {
  readonly dataDir: string
  readonly knowledgeDir: string
  readonly skillsDir: string
  readonly sessionsDir: string
}

export interface NurtureConfig {
  readonly enabled: boolean
  readonly pollIntervalSeconds: number
  readonly drainConcurrency: number
  readonly leaseSeconds: number
}

export interface WecomConfig {
  readonly corpId: string
  readonly token: string
  readonly encodingAesKey: string
}

export interface RuntimeConfig {
  readonly env: Environment
  readonly tenantId: string
  readonly host: string
  readonly port: number
  readonly paths: PathConfig
  readonly llm: LlmConfig
  readonly actionTokenSecret: string
  /** 自动放行的风险档；不在其中的档位走 HITL（ask）。 */
  readonly autoApproveTiers: readonly number[]
  readonly nurture: NurtureConfig
  readonly wecom?: WecomConfig
  readonly langfuse?: { readonly host: string; readonly publicKey: string; readonly secretKey: string }
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/** 生产环境要求的 action token 密钥最小长度（字节）。 */
export const MIN_SECRET_BYTES = 32

/**
 * 从环境变量解析运行时配置。
 *
 * @param source - 环境变量来源，默认 `process.env`。
 * @returns 校验通过的不可变配置。
 * @throws {ConfigError} 任一字段非法，或生产环境缺失必填项。
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ConfigError(`配置校验失败 — ${detail}`)
  }
  const raw = parsed.data
  const env: Environment = raw.OPENCS_ENV ?? 'development'
  const isProduction = env === 'production'

  const dataDir = resolve(raw.OPENCS_DATA_DIR)
  const paths: PathConfig = {
    dataDir,
    knowledgeDir: resolve(raw.OPENCS_KNOWLEDGE_DIR),
    skillsDir: resolve(raw.OPENCS_SKILLS_DIR),
    sessionsDir: resolve(dataDir, 'sessions'),
  }

  const llm = resolveLlm(raw, isProduction)

  const secret = raw.OPENCS_ACTION_TOKEN_SECRET
  if (isProduction) {
    if (secret === undefined) {
      throw new ConfigError('生产环境必须设置 OPENCS_ACTION_TOKEN_SECRET')
    }
    if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
      throw new ConfigError(`OPENCS_ACTION_TOKEN_SECRET 至少需要 ${MIN_SECRET_BYTES} 字节`)
    }
  }

  const wecom = resolveWecom(raw)
  const langfuse = resolveLangfuse(raw)

  return {
    env,
    tenantId: raw.OPENCS_TENANT_ID,
    host: raw.OPENCS_HOST,
    port: raw.OPENCS_PORT,
    paths,
    llm,
    // 非生产环境允许临时密钥：仅用于本进程生命周期内的 token 签名
    actionTokenSecret: secret ?? ephemeralSecret(),
    autoApproveTiers: Object.freeze(raw.OPENCS_AUTO_APPROVE_TIERS),
    nurture: {
      enabled: raw.OPENCS_NURTURE_ENABLED,
      pollIntervalSeconds: raw.OPENCS_NURTURE_POLL_INTERVAL,
      drainConcurrency: raw.OPENCS_NURTURE_DRAIN_CONCURRENCY,
      leaseSeconds: raw.OPENCS_NURTURE_LEASE_SECONDS,
    },
    ...(wecom === undefined ? {} : { wecom }),
    ...(langfuse === undefined ? {} : { langfuse }),
  }
}

type ParsedEnv = z.infer<typeof EnvSchema>

function resolveLlm(raw: ParsedEnv, isProduction: boolean): LlmConfig {
  if (raw.DEEPSEEK_API_KEY !== undefined) {
    return {
      kind: 'deepseek',
      model: raw.OPENCS_MODEL,
      apiKey: raw.DEEPSEEK_API_KEY,
      ...(raw.DEEPSEEK_BASE_URL === undefined ? {} : { baseUrl: raw.DEEPSEEK_BASE_URL }),
    }
  }
  if (raw.OPENAI_API_KEY !== undefined) {
    return {
      kind: 'openai-compatible',
      model: raw.OPENCS_MODEL,
      apiKey: raw.OPENAI_API_KEY,
      ...(raw.OPENAI_BASE_URL === undefined ? {} : { baseUrl: raw.OPENAI_BASE_URL }),
    }
  }
  if (isProduction) {
    throw new ConfigError('生产环境必须配置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY，不允许降级为 mock 模型')
  }
  return { kind: 'mock', model: 'opencs-mock' }
}

function resolveWecom(raw: ParsedEnv): WecomConfig | undefined {
  const fields = [raw.WECOM_CORP_ID, raw.WECOM_TOKEN, raw.WECOM_ENCODING_AES_KEY]
  const present = fields.filter((f) => f !== undefined).length
  if (present === 0) return undefined
  if (present !== fields.length) {
    throw new ConfigError('WECOM_CORP_ID / WECOM_TOKEN / WECOM_ENCODING_AES_KEY 必须同时配置')
  }
  return {
    corpId: raw.WECOM_CORP_ID as string,
    token: raw.WECOM_TOKEN as string,
    encodingAesKey: raw.WECOM_ENCODING_AES_KEY as string,
  }
}

function resolveLangfuse(raw: ParsedEnv): RuntimeConfig['langfuse'] {
  if (raw.LANGFUSE_PUBLIC_KEY === undefined || raw.LANGFUSE_SECRET_KEY === undefined) return undefined
  return {
    host: raw.LANGFUSE_HOST ?? 'http://localhost:3000',
    publicKey: raw.LANGFUSE_PUBLIC_KEY,
    secretKey: raw.LANGFUSE_SECRET_KEY,
  }
}

function ephemeralSecret(): string {
  return `ephemeral-${crypto.randomUUID()}-${crypto.randomUUID()}`
}
