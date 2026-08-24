/**
 * 血缘追踪：提案 → 来源/效果的线性事件时间线（spec §3.6）。
 *
 * 验证：
 *   ① append 追加事件、forProposal 按时间返回线性时间线
 *   ② forSkill 反查技能来源（applied）与后续命中（session_hit）
 *   ③ 无事件的提案返回空数组
 */

import { afterEach, describe, expect, it } from 'vitest'

import { IN_MEMORY, openDb, type Db } from '../../src/db/sqlite.js'
import { LineageStore } from '../../src/evolution/lineage.js'
import { EVOLUTION_MIGRATIONS } from '../../src/evolution/store.js'

let db: Db
afterEach(() => db?.close())

function lineage(): LineageStore {
  db = openDb(IN_MEMORY, EVOLUTION_MIGRATIONS)
  return new LineageStore(db)
}

describe('LineageStore', () => {
  it('append + forProposal 返回按时间排序的事件时间线', () => {
    const store = lineage()
    store.append('p1', 'proposed', 'conv-bad')
    store.append('p1', 'shadow_verified', 'badcase_fixed')
    store.append('p1', 'applied', 'skill=proposal-tuikuan')
    const events = store.forProposal('p1')
    expect(events.map((e) => e.kind)).toEqual(['proposed', 'shadow_verified', 'applied'])
    expect(events[0]?.detail).toBe('conv-bad')
  })

  it('forSkill 反查技能来源与后续命中', () => {
    const store = lineage()
    store.append('p1', 'applied', 'skill=proposal-tuikuan')
    store.append('p1', 'session_hit', 'skill=proposal-tuikuan conv=c2')
    const events = store.forSkill('proposal-tuikuan')
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.some((e) => e.kind === 'applied')).toBe(true)
    expect(events.some((e) => e.kind === 'session_hit')).toBe(true)
  })

  it('proposal 无事件时返回空数组', () => {
    const store = lineage()
    expect(store.forProposal('none')).toEqual([])
  })
})
