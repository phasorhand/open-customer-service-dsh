/**
 * 租户隔离 guard —— 治理管线的最外层。
 *
 * 规则：任何业务工具调用，其 session 必须已绑定 {@link TenantScope}；
 * 若参数里显式带了 `tenant_id`，必须与绑定的租户一致。
 *
 * 为什么放在最外层：越权是**权限事实**，不是风险偏好——不管风险档多低都要先拒。
 * 拒绝走 `{ kind: 'deny' }` 短路，不调 `next()`（dsh waterfall 的短路约定）。
 */

import type { Context } from '@deepseek-ai/cordis'

import { scopeOf, sessionIdOf } from '../session-scope.js'

export const name = 'opencs-guard-scope'
export const inject = ['tools']

/**
 * 免除租户校验的工具。
 *
 * 只放那些**完全不碰租户数据**的工具。默认策略是「不在此表 = 需要 scope」，
 * 新增工具忘记登记时会被拒绝而非放行。
 */
const SCOPE_EXEMPT = new Set<string>([])

export function apply(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (SCOPE_EXEMPT.has(exec.name)) return next()

    const sessionId = sessionIdOf(exec)
    const scope = scopeOf(sessionId)
    if (scope === undefined) {
      return {
        kind: 'deny' as const,
        reason: `缺少租户作用域：session ${sessionId ?? '<none>'} 未经服务端注入，业务数据访问被拒绝`,
      }
    }

    const args = exec.arguments as Record<string, unknown> | undefined
    const claimedTenant = args?.['tenant_id']
    if (typeof claimedTenant === 'string' && claimedTenant !== scope.tenantId) {
      return {
        kind: 'deny' as const,
        reason: `租户 ${claimedTenant} 不在本会话作用域（${scope.tenantId}），已拒绝`,
      }
    }

    const claimedConversation = args?.['conversation_id']
    if (typeof claimedConversation === 'string' && claimedConversation !== scope.conversationId) {
      return {
        kind: 'deny' as const,
        reason: `会话 ${claimedConversation} 不属于当前对话（${scope.conversationId}），已拒绝`,
      }
    }

    return next()
  })
}
