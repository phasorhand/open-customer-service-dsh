/**
 * 会话作用域绑定：`sessionId → TenantScope`。
 *
 * 为什么需要（spec §4.2）：dsh 的工具 `execute(args, exec)` 只拿得到 `exec.agent.session.id`，
 * 拿不到「这次对话属于哪个租户 / 哪个联系人」。这些是**不能交给模型传参**的
 * 权限事实——否则提示注入就能越权。因此在创建 agent 之前把 scope 绑到 sessionId 上，
 * 工具与 guard 各自反查，形成纵深防御。
 *
 * 生产形态可换成 dsh 的 session 变量；MVP 用进程内注册表（单进程部署）。
 */

/** 一次会话的权限与身份事实。全部由服务端注入，模型无法影响。 */
export interface TenantScope {
  readonly tenantId: string
  readonly conversationId: string
  readonly channelId: string
  /** 渠道侧的用户标识（企微 external_userid / webchat 访客 id）。 */
  readonly customerId: string
  /** 已关联的 CRM 联系人；首次接触时可能还没有。 */
  readonly contactId?: string
}

export class ScopeMissingError extends Error {
  override readonly name = 'ScopeMissingError'
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} 未绑定租户作用域，业务数据访问被拒绝`)
  }
}

const registry = new Map<string, TenantScope>()

/**
 * 绑定作用域。必须在该 session 的第一个 turn 之前调用。
 *
 * @param sessionId - dsh 的 session id（字符串形式）。
 * @param scope - 服务端注入的权限事实。
 * @returns 解绑函数（会话结束时调用，避免长跑进程泄漏）。
 */
export function bindScope(sessionId: string, scope: TenantScope): () => void {
  registry.set(sessionId, scope)
  return () => {
    registry.delete(sessionId)
  }
}

/**
 * 查询作用域。
 *
 * @param sessionId - dsh 的 session id；`undefined` 表示无 agent 上下文（如直接调用）。
 * @returns 绑定的作用域，未绑定则 `undefined`。
 */
export function scopeOf(sessionId: string | undefined): TenantScope | undefined {
  if (sessionId === undefined) return undefined
  return registry.get(sessionId)
}

/**
 * 查询作用域，未绑定即抛错。工具 execute 内使用。
 *
 * @param sessionId - dsh 的 session id。
 * @returns 绑定的作用域。
 * @throws {ScopeMissingError} 未绑定。
 */
export function requireScope(sessionId: string | undefined): TenantScope {
  const scope = scopeOf(sessionId)
  if (scope === undefined) throw new ScopeMissingError(sessionId ?? '<none>')
  return scope
}

/** 从工具执行上下文取 session id。dsh 的 `exec.agent` 在非 agent 调用时为 undefined。 */
export function sessionIdOf(exec: { readonly agent?: { readonly session: { readonly id: unknown } } }): string | undefined {
  const id = exec.agent?.session.id
  return id === undefined ? undefined : String(id)
}

/** 测试用：清空注册表。 */
export function resetScopes(): void {
  registry.clear()
}
