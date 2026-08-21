/**
 * SQLite 连接工厂与 migration runner。
 *
 * 复用：`node:sqlite`（Node ≥22 内置）— 零外部依赖、无原生编译步骤。
 * 排除：better-sqlite3（需要 node-gyp 编译，Docker 构建变重）。
 *
 * 约定（spec §5）：按域分库；WAL 模式；migration 用有序数组声明，
 * 已执行的记入 `_migrations` 表，重复执行是幂等的。
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

/**
 * `node:sqlite` 通过 `createRequire` 动态加载，而不是静态 import。
 *
 * 原因：Vite/Vitest 判定内置模块时会剥掉 `node:` 前缀再查 `module.builtinModules`，
 * 而 Node 只在带前缀时才列出 `node:sqlite`（实验模块），静态 import 会被打包器
 * 当成待解析的第三方包而失败。动态 require 绕过静态分析，运行期行为完全一致。
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

export type Db = DatabaseSyncType

/** 一条 migration：`id` 全库唯一且单调递增，`sql` 可含多条语句。 */
export interface Migration {
  readonly id: number
  readonly name: string
  readonly sql: string
}

/** 内存库路径常量：测试用，避免各处手写字面量。 */
export const IN_MEMORY = ':memory:'

/**
 * 打开（并按需创建）一个 SQLite 库，应用 WAL + 外键约束，然后执行未应用的 migration。
 *
 * @param path - 文件路径，或 {@link IN_MEMORY}。
 * @param migrations - 按 `id` 升序的 migration 列表。
 * @returns 已就绪的连接。
 * @throws {Error} migration 的 id 非严格递增，或 SQL 执行失败。
 */
export function openDb(path: string, migrations: readonly Migration[] = []): Db {
  if (path !== IN_MEMORY) {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new DatabaseSync(path)
  // 内存库没有 WAL 语义，设置会被忽略；对文件库启用以支持读写并发
  if (path !== IN_MEMORY) db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  applyMigrations(db, migrations)
  return db
}

/**
 * 幂等地应用 migration。
 *
 * @param db - 目标连接。
 * @param migrations - 按 `id` 升序的 migration 列表。
 * @throws {Error} id 未严格递增。
 */
export function applyMigrations(db: Db, migrations: readonly Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)

  let previous = -Infinity
  for (const migration of migrations) {
    if (migration.id <= previous) {
      throw new Error(`migration id 必须严格递增：${migration.name} (id=${migration.id}) 未大于 ${previous}`)
    }
    previous = migration.id
  }

  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((row) => Number((row as { id: number }).id)),
  )

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${migration.id}/${migration.name} 执行失败: ${String(error)}`, { cause: error })
    }
  }
}

/**
 * 在单个事务里执行 `fn`；抛错则回滚。
 *
 * @param db - 目标连接。
 * @param fn - 事务体。
 * @returns `fn` 的返回值。
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
