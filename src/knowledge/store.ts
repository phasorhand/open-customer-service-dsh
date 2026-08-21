/**
 * 知识库存储与检索：SQLite FTS5 + CJK LIKE 兜底。
 *
 * 为什么需要兜底（RESEARCH.md §CJK）：FTS5 的 `unicode61` tokenizer 按空白/标点切词，
 * 中文整句会被当成一个 token —— 查「退款」命中不了「申请退款流程」。
 * 因此中文查询走 LIKE，两路结果合并去重，标题命中权重高于正文。
 */

import { fromJsonColumn, toJsonColumn } from '../db/json.js'
import { type Db, type Migration, transaction } from '../db/sqlite.js'
import type { KnowledgeHit, KnowledgePort } from '../harness/ports.js'
import type { ParsedChunk } from './parser.js'

export const KNOWLEDGE_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'create_knowledge_chunks',
    sql: `
      CREATE TABLE knowledge_chunks (
        chunk_id     TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        source_file  TEXT NOT NULL,
        heading      TEXT NOT NULL,
        heading_path TEXT NOT NULL,
        content      TEXT NOT NULL,
        ordinal      INTEGER NOT NULL,
        metadata     TEXT,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (tenant_id, chunk_id)
      );
      CREATE INDEX idx_chunks_source ON knowledge_chunks (tenant_id, source_file);

      CREATE VIRTUAL TABLE knowledge_fts USING fts5 (
        heading_path,
        content,
        content = 'knowledge_chunks',
        content_rowid = 'rowid',
        tokenize = 'unicode61'
      );

      CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts (rowid, heading_path, content)
        VALUES (new.rowid, new.heading_path, new.content);
      END;
      CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts (knowledge_fts, rowid, heading_path, content)
        VALUES ('delete', old.rowid, old.heading_path, old.content);
      END;
      CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts (knowledge_fts, rowid, heading_path, content)
        VALUES ('delete', old.rowid, old.heading_path, old.content);
        INSERT INTO knowledge_fts (rowid, heading_path, content)
        VALUES (new.rowid, new.heading_path, new.content);
      END;
    `,
  },
]

interface ChunkRow {
  readonly chunk_id: string
  readonly source_file: string
  readonly heading_path: string
  readonly content: string
  readonly metadata: string | null
}

export interface KnowledgeStatus {
  readonly chunkCount: number
  readonly sourceFileCount: number
}

/** 标题命中的加权。让「退款政策」这一节排在正文顺带提到退款的段落前面。 */
const HEADING_WEIGHT = 3

export class SqliteKnowledgeStore implements KnowledgePort {
  constructor(private readonly db: Db) {}

  /**
   * 用一个源文件的最新分块替换该文件的全部旧分块。
   *
   * 整体在一个事务里：文件保存到一半被读取时，不会出现「旧块已删、新块未入」的空窗。
   *
   * @param tenantId - 租户。
   * @param sourceFile - 源文件相对路径。
   * @param chunks - 该文件解析出的全部分块。
   */
  replaceFile(tenantId: string, sourceFile: string, chunks: readonly ParsedChunk[]): void {
    const now = new Date().toISOString()
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM knowledge_chunks WHERE tenant_id = ? AND source_file = ?').run(tenantId, sourceFile)
      const insert = this.db.prepare(
        `INSERT INTO knowledge_chunks
           (chunk_id, tenant_id, source_file, heading, heading_path, content, ordinal, metadata, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const chunk of chunks) {
        insert.run(
          chunk.chunkId,
          tenantId,
          sourceFile,
          chunk.heading,
          chunk.headingPath,
          chunk.content,
          chunk.ordinal,
          toJsonColumn(chunk.metadata),
          now,
        )
      }
    })
  }

  /**
   * 删除一个源文件的全部分块（文件被删除时）。
   *
   * @param tenantId - 租户。
   * @param sourceFile - 源文件相对路径。
   * @returns 删除的分块数。
   */
  deleteFile(tenantId: string, sourceFile: string): number {
    const before = this.count(tenantId)
    this.db.prepare('DELETE FROM knowledge_chunks WHERE tenant_id = ? AND source_file = ?').run(tenantId, sourceFile)
    return before - this.count(tenantId)
  }

  async search(tenantId: string, query: string, limit: number): Promise<readonly KnowledgeHit[]> {
    return this.searchSync(tenantId, query, limit)
  }

  /**
   * 同步检索。`search()` 的实现体；测试与内部调用直接用它避免无谓的 async。
   *
   * @param tenantId - 租户。
   * @param query - 查询词。
   * @param limit - 最多返回条数。
   * @returns 按相关度排序的命中；无命中返回空数组（不抛错）。
   */
  searchSync(tenantId: string, query: string, limit: number): readonly KnowledgeHit[] {
    const needle = query.trim()
    if (needle === '' || limit <= 0) return []

    const scored = new Map<string, { row: ChunkRow; score: number }>()
    const add = (row: ChunkRow, score: number): void => {
      const existing = scored.get(row.chunk_id)
      if (existing === undefined || existing.score < score) scored.set(row.chunk_id, { row, score })
    }

    for (const [row, score] of this.ftsCandidates(tenantId, needle, limit)) add(row, score)
    for (const [row, score] of this.likeCandidates(tenantId, needle, limit)) add(row, score)

    return [...scored.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row }) => toHit(row))
  }

  /** FTS5 全文检索。负责英文/数字/混排；查询语法非法时返回空而不是抛错。 */
  private ftsCandidates(tenantId: string, needle: string, limit: number): [ChunkRow, number][] {
    try {
      const rows = this.db
        .prepare(
          `SELECT c.chunk_id, c.source_file, c.heading_path, c.content, c.metadata, bm25(knowledge_fts) AS rank
             FROM knowledge_fts
             JOIN knowledge_chunks c ON c.rowid = knowledge_fts.rowid
            WHERE knowledge_fts MATCH ? AND c.tenant_id = ?
            ORDER BY rank
            LIMIT ?`,
        )
        .all(toMatchQuery(needle), tenantId, limit * 2) as unknown as (ChunkRow & { rank: number })[]
      // bm25 越小越相关；转成「越大越相关」并压到 LIKE 打分的量纲附近
      return rows.map((row) => [row, 10 - Math.min(row.rank, 10)])
    } catch {
      // 用户输入可能构成非法 FTS5 查询语法（如未闭合引号）——检索不应因此 500
      return []
    }
  }

  /** CJK 子串兜底。中文没有词边界，FTS5 的 tokenizer 覆盖不到。 */
  private likeCandidates(tenantId: string, needle: string, limit: number): [ChunkRow, number][] {
    const pattern = `%${escapeLike(needle)}%`
    const rows = this.db
      .prepare(
        `SELECT chunk_id, source_file, heading_path, content, metadata,
                (CASE WHEN heading_path LIKE ? ESCAPE '\\' THEN ${HEADING_WEIGHT} ELSE 0 END) AS heading_hit
           FROM knowledge_chunks
          WHERE tenant_id = ?
            AND (heading_path LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
          LIMIT ?`,
      )
      .all(pattern, tenantId, pattern, pattern, limit * 2) as unknown as (ChunkRow & { heading_hit: number })[]
    return rows.map((row) => [row, 5 + row.heading_hit])
  }

  /**
   * 统计当前索引状态。
   *
   * @param tenantId - 租户。
   * @returns 分块数与源文件数。
   */
  status(tenantId: string): KnowledgeStatus {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS chunks, COUNT(DISTINCT source_file) AS files
           FROM knowledge_chunks WHERE tenant_id = ?`,
      )
      .get(tenantId) as unknown as { chunks: number; files: number }
    return { chunkCount: Number(row.chunks), sourceFileCount: Number(row.files) }
  }

  /** 列出已索引的源文件。 */
  listSources(tenantId: string): readonly string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT source_file FROM knowledge_chunks WHERE tenant_id = ? ORDER BY source_file')
      .all(tenantId) as unknown as { source_file: string }[]
    return rows.map((row) => row.source_file)
  }

  private count(tenantId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE tenant_id = ?').get(tenantId) as unknown as { n: number }
    return Number(row.n)
  }
}

function toHit(row: ChunkRow): KnowledgeHit {
  return {
    chunkId: row.chunk_id,
    sourceFile: row.source_file,
    headingPath: row.heading_path,
    content: row.content,
  }
}

/**
 * 把用户查询转成 FTS5 MATCH 语法。
 *
 * 每个词加引号做短语匹配，避免用户输入里的 `-` `*` `NEAR` 被当成操作符。
 */
function toMatchQuery(needle: string): string {
  const terms = needle
    .split(/[\s,，。？?!！]+/)
    .map((term) => term.replace(/"/g, ''))
    .filter((term) => term !== '')
  if (terms.length === 0) return `"${needle.replace(/"/g, '')}"`
  return terms.map((term) => `"${term}"`).join(' OR ')
}

/** 转义 LIKE 的通配符，避免用户输入的 `%` 变成「匹配一切」。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export { fromJsonColumn }
