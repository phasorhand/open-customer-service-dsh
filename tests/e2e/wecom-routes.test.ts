/**
 * 企微回调路由端到端：真实 runtime + 真实加解密。
 *
 * 只测不需要外呼企微 API 的路径（URL 验证、签名拒绝）——
 * 拉取/发送的闭环在 `tests/unit/wecom.test.ts` 用 stub HTTP 覆盖。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { createApp } from '../../src/gateway/app.js'
import { resetScopes } from '../../src/harness/session-scope.js'
import { buildRuntime, type OpenCsRuntime } from '../../src/runtime.js'

const AES_KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const WECOM_ENV = {
  WECOM_CORP_ID: 'ww-test-corp',
  WECOM_CORP_SECRET: 'secret',
  WECOM_TOKEN: 'callback-token',
  WECOM_ENCODING_AES_KEY: AES_KEY,
  WECOM_OPEN_KFID: 'kf_test',
}

let app: FastifyInstance
let runtime: OpenCsRuntime
let dataDir: string

beforeEach(async () => {
  resetScopes()
  dataDir = mkdtempSync(join(tmpdir(), 'opencs-wecom-'))
  runtime = await buildRuntime({
    config: loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test', ...WECOM_ENV }),
  })
  app = await createApp(runtime)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  await runtime.dispose()
  rmSync(dataDir, { recursive: true, force: true })
  resetScopes()
})

describe('企微回调路由', () => {
  it('配置企微后适配器注册进渠道表', () => {
    expect(runtime.channels.list()).toContain('wecom_kf')
    expect(runtime.wecom).toBeDefined()
  })

  it('URL 验证：签名对时返回解密后的 echostr 纯文本', async () => {
    const crypto = runtime.wecom!.crypto
    const echoPlain = 'echo-plain-42'
    const echostr = crypto.encrypt(echoPlain)
    const signature = crypto.signature('1755763200', 'nonce1', echostr)

    const response = await app.inject({
      method: 'GET',
      url:
        '/channels/wecom/callback?' +
        new URLSearchParams({
          msg_signature: signature,
          timestamp: '1755763200',
          nonce: 'nonce1',
          echostr,
        }).toString(),
    })
    expect(response.statusCode).toBe(200)
    // 企微要求纯文本明文，不能是 JSON
    expect(response.body).toBe(echoPlain)
    expect(response.headers['content-type']).toContain('text/plain')
  })

  it('URL 验证：签名错返回 403', async () => {
    const echostr = runtime.wecom!.crypto.encrypt('echo')
    const response = await app.inject({
      method: 'GET',
      url:
        '/channels/wecom/callback?' +
        new URLSearchParams({ msg_signature: 'forged', timestamp: 't', nonce: 'n', echostr }).toString(),
    })
    expect(response.statusCode).toBe(403)
  })

  it('缺少验证参数返回 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/channels/wecom/callback' })).statusCode).toBe(400)
  })

  it('POST 回调：伪造签名 403，不进入消息拉取', async () => {
    const crypto = runtime.wecom!.crypto
    const encrypt = crypto.encrypt('<xml><OpenKfId><![CDATA[kf_test]]></OpenKfId></xml>')
    const response = await app.inject({
      method: 'POST',
      url:
        '/channels/wecom/callback?' +
        new URLSearchParams({ msg_signature: 'forged', timestamp: 't', nonce: 'n' }).toString(),
      headers: { 'content-type': 'text/xml' },
      payload: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
    })
    expect(response.statusCode).toBe(403)
  })

  it('未配置企微时路由不存在（可选能力不留死端点）', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'opencs-bare-'))
    const bare = await buildRuntime({ config: loadConfig({ OPENCS_DATA_DIR: bareDir, OPENCS_ENV: 'test' }) })
    const bareApp = await createApp(bare)
    await bareApp.ready()
    const response = await bareApp.inject({ method: 'GET', url: '/channels/wecom/callback' })
    await bareApp.close()
    await bare.dispose()
    rmSync(bareDir, { recursive: true, force: true })
    expect(response.statusCode).toBe(404)
  })
})

describe('控制台', () => {
  it('GET /console 返回自包含 HTML', async () => {
    const response = await app.inject({ method: 'GET', url: '/console' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('OpenCS 控制台')
    expect(response.body).toContain('审批')
  })
})
