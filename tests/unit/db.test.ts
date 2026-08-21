import { describe, expect, it } from 'vitest'

import { fromJsonColumn, toJsonColumn } from '../../src/db/json.js'
import { IN_MEMORY, type Migration, applyMigrations, openDb, transaction } from '../../src/db/sqlite.js'

const M1: Migration = {
  id: 1,
  name: 'create_widgets',
  sql: `CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
}
const M2: Migration = {
  id: 2,
  name: 'add_widget_size',
  sql: `ALTER TABLE widgets ADD COLUMN size INTEGER NOT NULL DEFAULT 0`,
}

describe('openDb / applyMigrations', () => {
  it('应用全部 migration 并记账', () => {
    const db = openDb(IN_MEMORY, [M1, M2])
    const applied = db.prepare('SELECT id, name FROM _migrations ORDER BY id').all()
    expect(applied).toEqual([
      expect.objectContaining({ id: 1, name: 'create_widgets' }),
      expect.objectContaining({ id: 2, name: 'add_widget_size' }),
    ])
    db.close()
  })

  it('重复应用是幂等的', () => {
    const db = openDb(IN_MEMORY, [M1])
    applyMigrations(db, [M1])
    applyMigrations(db, [M1])
    const rows = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }
    expect(rows.n).toBe(1)
    db.close()
  })

  it('增量追加新 migration 只跑新增的那条', () => {
    const db = openDb(IN_MEMORY, [M1])
    applyMigrations(db, [M1, M2])
    db.prepare('INSERT INTO widgets (id, name, size) VALUES (?, ?, ?)').run('w1', 'gear', 3)
    expect(db.prepare('SELECT size FROM widgets WHERE id = ?').get('w1')).toMatchObject({ size: 3 })
    db.close()
  })

  it('id 非严格递增时报错', () => {
    const db = openDb(IN_MEMORY)
    expect(() => applyMigrations(db, [M2, M1])).toThrow(/严格递增/)
    db.close()
  })

  it('migration 失败时回滚，不留下半套 schema', () => {
    const db = openDb(IN_MEMORY)
    const broken: Migration = { id: 1, name: 'broken', sql: 'CREATE TABLE ok (id TEXT); NOT VALID SQL;' }
    expect(() => applyMigrations(db, [broken])).toThrow(/broken/)
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ok'`).all()
    expect(tables).toEqual([])
    db.close()
  })

  it('开启外键约束', () => {
    const db = openDb(IN_MEMORY)
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
    db.close()
  })
})

describe('transaction', () => {
  it('成功时提交并返回结果', () => {
    const db = openDb(IN_MEMORY, [M1])
    const result = transaction(db, () => {
      db.prepare('INSERT INTO widgets (id, name) VALUES (?, ?)').run('a', 'alpha')
      return 'done'
    })
    expect(result).toBe('done')
    expect(db.prepare('SELECT COUNT(*) AS n FROM widgets').get()).toMatchObject({ n: 1 })
    db.close()
  })

  it('抛错时回滚', () => {
    const db = openDb(IN_MEMORY, [M1])
    expect(() =>
      transaction(db, () => {
        db.prepare('INSERT INTO widgets (id, name) VALUES (?, ?)').run('a', 'alpha')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(db.prepare('SELECT COUNT(*) AS n FROM widgets').get()).toMatchObject({ n: 0 })
    db.close()
  })
})

describe('JSON 列', () => {
  it('往返一致', () => {
    const value = { tags: ['vip', '高意向'], nested: { n: 1 } }
    expect(fromJsonColumn(toJsonColumn(value), null)).toEqual(value)
  })

  it('undefined / null 归一化为 null 列值', () => {
    expect(toJsonColumn(undefined)).toBeNull()
    expect(toJsonColumn(null)).toBeNull()
  })

  it('坏数据不抛错，返回 fallback（回放不允许 crash）', () => {
    expect(fromJsonColumn('{ not json', { safe: true })).toEqual({ safe: true })
    expect(fromJsonColumn(null, [])).toEqual([])
    expect(fromJsonColumn(123, 'fb')).toBe('fb')
  })
})
