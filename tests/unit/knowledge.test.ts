import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { IN_MEMORY, openDb, type Db } from '../../src/db/sqlite.js'
import { KnowledgeIngestor } from '../../src/knowledge/ingestor.js'
import { parseMarkdown } from '../../src/knowledge/parser.js'
import { KNOWLEDGE_MIGRATIONS, SqliteKnowledgeStore } from '../../src/knowledge/store.js'

const SAMPLE = `---
category: 售后
owner: 客服组
---

# 售后政策

前言：本文档适用于全部自营商品。

## 退款政策

签收后 7 天内可无理由退款，需商品完好。

### 定制商品

定制类商品一经生产不支持无理由退款。

## 退货运费

无理由退货运费由客户承担。
`

describe('parseMarkdown · 切分', () => {
  const chunks = parseMarkdown('refund.md', SAMPLE)

  it('按二级及更深标题切块，前言单独成块', () => {
    expect(chunks.map((c) => c.heading)).toEqual(['售后政策', '退款政策', '定制商品', '退货运费'])
  })

  it('标题路径体现层级', () => {
    expect(chunks.map((c) => c.headingPath)).toEqual([
      '售后政策',
      '售后政策 / 退款政策',
      '售后政策 / 退款政策 / 定制商品',
      '售后政策 / 退货运费',
    ])
  })

  it('一级标题不进正文', () => {
    expect(chunks[0]?.content).not.toContain('# 售后政策')
    expect(chunks[0]?.content).toContain('前言')
  })

  it('三级标题回到二级时层级正确收敛', () => {
    expect(chunks[3]?.headingPath).toBe('售后政策 / 退货运费')
  })

  it('frontmatter 被解析为 metadata 且不进正文', () => {
    expect(chunks[0]?.metadata).toMatchObject({ category: '售后', owner: '客服组' })
    expect(chunks.map((c) => c.content).join('')).not.toContain('category:')
  })

  it('chunkId 稳定且带源文件前缀', () => {
    expect(chunks.map((c) => c.chunkId)).toEqual(['refund.md#0', 'refund.md#1', 'refund.md#2', 'refund.md#3'])
    expect(parseMarkdown('refund.md', SAMPLE).map((c) => c.chunkId)).toEqual(chunks.map((c) => c.chunkId))
  })

  it('无一级标题时用文件名作文档标题', () => {
    const parsed = parseMarkdown('nested/logistics.md', '## 时效\n\n次日达')
    expect(parsed[0]?.headingPath).toBe('logistics / 时效')
  })

  it('空文件返回空数组', () => {
    expect(parseMarkdown('empty.md', '')).toEqual([])
    expect(parseMarkdown('only-fm.md', '---\na: 1\n---\n')).toEqual([])
  })

  it('坏 frontmatter 不抛错，降级为无 metadata', () => {
    const parsed = parseMarkdown('bad.md', '---\n: : bad yaml [\n---\n\n## 标题\n正文')
    expect(parsed.length).toBeGreaterThan(0)
  })

  it('只有正文没有标题时整篇成一块', () => {
    const parsed = parseMarkdown('flat.md', '就是一段话，没有任何标题。')
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.content).toContain('没有任何标题')
  })
})

describe('SqliteKnowledgeStore', () => {
  let db: Db

  const store = (): SqliteKnowledgeStore => {
    db = openDb(IN_MEMORY, KNOWLEDGE_MIGRATIONS)
    const s = new SqliteKnowledgeStore(db)
    s.replaceFile('default', 'refund.md', parseMarkdown('refund.md', SAMPLE))
    return s
  }

  afterEach(() => {
    db?.close()
  })

  it('中文查询能命中（FTS5 tokenizer 覆盖不到，靠 LIKE 兜底）', () => {
    expect(store().searchSync('default', '退款', 5).length).toBeGreaterThan(0)
  })

  it('标题命中排在正文顺带提及之前', () => {
    const hits = store().searchSync('default', '退款政策', 5)
    expect(hits[0]?.headingPath).toContain('退款政策')
  })

  it('数字与英文混排走 FTS5', () => {
    const s = store()
    s.replaceFile('default', 'sla.md', parseMarkdown('sla.md', '## SLA\n\nresponse within 48 hours'))
    expect(s.searchSync('default', 'hours', 5).length).toBeGreaterThan(0)
  })

  it('无命中返回空数组而不是抛错', () => {
    expect(store().searchSync('default', '完全不相干的词汇xyz', 5)).toEqual([])
  })

  it('空查询返回空数组', () => {
    expect(store().searchSync('default', '   ', 5)).toEqual([])
  })

  it('非法 FTS5 语法不 500，降级为 LIKE 结果', () => {
    expect(() => store().searchSync('default', '退款 "未闭合引号', 5)).not.toThrow()
  })

  it('LIKE 通配符被转义，不会匹配一切', () => {
    expect(store().searchSync('default', '%', 5)).toEqual([])
  })

  it('租户隔离：查不到别的租户的内容', () => {
    expect(store().searchSync('other-corp', '退款', 5)).toEqual([])
  })

  it('limit 生效', () => {
    expect(store().searchSync('default', '退', 2).length).toBeLessThanOrEqual(2)
  })

  it('replaceFile 是替换而不是追加', () => {
    const s = store()
    const before = s.status('default').chunkCount
    s.replaceFile('default', 'refund.md', parseMarkdown('refund.md', SAMPLE))
    expect(s.status('default').chunkCount).toBe(before)
  })

  it('replaceFile 后旧内容检索不到', () => {
    const s = store()
    s.replaceFile('default', 'refund.md', parseMarkdown('refund.md', '## 新政策\n\n一律不退'))
    expect(s.searchSync('default', '无理由', 5)).toEqual([])
    expect(s.searchSync('default', '一律不退', 5).length).toBeGreaterThan(0)
  })

  it('deleteFile 移除该文件全部分块', () => {
    const s = store()
    const removed = s.deleteFile('default', 'refund.md')
    expect(removed).toBeGreaterThan(0)
    expect(s.status('default').chunkCount).toBe(0)
  })

  it('status 报告分块数与文件数', () => {
    const s = store()
    s.replaceFile('default', 'invoice.md', parseMarkdown('invoice.md', '## 开票\n\n48 小时'))
    expect(s.status('default')).toEqual({ chunkCount: 5, sourceFileCount: 2 })
  })

  it('listSources 列出源文件', () => {
    expect(store().listSources('default')).toEqual(['refund.md'])
  })
})

describe('KnowledgeIngestor', () => {
  let dir: string
  let db: Db

  afterEach(() => {
    db?.close()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  })

  const setup = (): { store: SqliteKnowledgeStore; ingestor: KnowledgeIngestor } => {
    dir = mkdtempSync(join(tmpdir(), 'opencs-kb-'))
    db = openDb(IN_MEMORY, KNOWLEDGE_MIGRATIONS)
    const store = new SqliteKnowledgeStore(db)
    return { store, ingestor: new KnowledgeIngestor({ root: dir, tenantId: 'default', store }) }
  }

  it('全量扫描并入库', async () => {
    const { store, ingestor } = setup()
    writeFileSync(join(dir, 'a.md'), '## 甲\n\n甲的内容')
    writeFileSync(join(dir, 'b.md'), '## 乙\n\n乙的内容')
    const report = await ingestor.ingestAll()
    expect(report.files).toBe(2)
    expect(report.chunks).toBe(2)
    expect(store.status('default').sourceFileCount).toBe(2)
  })

  it('递归扫描子目录', async () => {
    const { store, ingestor } = setup()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'c.md'), '## 丙\n\n丙的内容')
    await ingestor.ingestAll()
    expect(store.listSources('default')).toEqual(['sub/c.md'])
  })

  it('忽略非 Markdown 文件', async () => {
    const { store, ingestor } = setup()
    writeFileSync(join(dir, 'notes.txt'), '不该被索引')
    writeFileSync(join(dir, 'a.md'), '## 甲\n\n内容')
    await ingestor.ingestAll()
    expect(store.listSources('default')).toEqual(['a.md'])
  })

  it('目录不存在时不抛错，返回空报告', async () => {
    db = openDb(IN_MEMORY, KNOWLEDGE_MIGRATIONS)
    const ingestor = new KnowledgeIngestor({
      root: join(tmpdir(), 'opencs-does-not-exist-xyz'),
      tenantId: 'default',
      store: new SqliteKnowledgeStore(db),
    })
    await expect(ingestor.ingestAll()).resolves.toMatchObject({ files: 0, chunks: 0 })
  })

  it('热重载：改文件后新内容可检索，旧内容消失', async () => {
    const { store, ingestor } = setup()
    const file = join(dir, 'policy.md')
    writeFileSync(file, '## 政策\n\n旧的说法')
    await ingestor.ingestAll()
    expect(store.searchSync('default', '旧的说法', 5).length).toBe(1)

    const stop = await ingestor.watch()
    writeFileSync(file, '## 政策\n\n新的说法')
    await waitFor(() => store.searchSync('default', '新的说法', 5).length === 1)
    expect(store.searchSync('default', '旧的说法', 5)).toEqual([])
    await stop()
  })

  it('热重载：删文件后内容消失', async () => {
    const { store, ingestor } = setup()
    const file = join(dir, 'temp.md')
    writeFileSync(file, '## 临时\n\n临时内容')
    await ingestor.ingestAll()

    const stop = await ingestor.watch()
    unlinkSync(file)
    await waitFor(() => store.status('default').chunkCount === 0)
    await stop()
  })

  it('stop 后不再响应变更（registrations are effects）', async () => {
    const { store, ingestor } = setup()
    const stop = await ingestor.watch()
    await stop()
    writeFileSync(join(dir, 'late.md'), '## 迟到\n\n不该被索引')
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(store.status('default').chunkCount).toBe(0)
  })
})

/** 轮询等待条件成立，避免依赖固定 sleep 时长导致的偶发失败。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('等待条件超时')
}
