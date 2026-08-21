/**
 * CSV 批量导入。
 *
 * 复用：`csv-parse @ ^5` —— 正确处理引号内的逗号/换行、BOM、CRLF。
 * 手写 `split(',')` 在真实的运营导出文件上必错（公司名里常有逗号）。
 *
 * 容错原则：**单行失败不中断整批**。运营导出的表格总有几行脏数据，
 * 全批回滚会让他们无从下手；逐行报错 + 行号才是可操作的反馈。
 */

import { parse } from 'csv-parse/sync'

import type { ContactStore } from './store.js'
import { normalizeDedupKey, type ContactUpsert, type ImportReport, type ImportRowError } from './types.js'

/** 错误列表上限。超出后只记数量，避免响应体爆炸。 */
const MAX_ERRORS = 100

/**
 * 表头别名。运营导出的文件表头五花八门，这里做归一化。
 * 键是归一化后的字段名，值是可接受的表头写法（小写比对）。
 */
const HEADER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  name: ['name', '姓名', '名字', '客户姓名', '联系人'],
  phone: ['phone', 'mobile', 'tel', '手机', '手机号', '电话', '联系电话'],
  email: ['email', 'mail', '邮箱', '电子邮箱'],
  company: ['company', 'org', '公司', '单位', '企业名称'],
  owner: ['owner', '负责人', '归属人', '销售'],
  source: ['source', '来源', '渠道来源'],
  tags: ['tags', 'tag', '标签'],
  externalId: ['external_id', 'externalid', 'customer_id', '客户id', '渠道id'],
}

export interface ImportOptions {
  readonly tenantId: string
  /** 若 CSV 带 externalId 列，用这个渠道关联身份。 */
  readonly channelId?: string
  /** 导入来源标记，写进 `source` 字段。 */
  readonly source?: string
}

export class ContactImporter {
  constructor(private readonly store: ContactStore) {}

  /**
   * 导入 CSV。
   *
   * @param csv - 文件全文。
   * @param options - 租户与渠道关联选项。
   * @returns 导入报告，含逐行错误与 1-based 原始行号。
   */
  import(csv: string, options: ImportOptions): ImportReport {
    let rows: Record<string, string>[]
    try {
      rows = parse(csv, {
        columns: (header: string[]) => header.map((column) => normalizeHeader(column)),
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
      }) as Record<string, string>[]
    } catch (error) {
      return {
        total: 0,
        imported: 0,
        updated: 0,
        skipped: 0,
        errors: [{ line: 1, error: `CSV 解析失败：${String(error)}`, raw: csv.slice(0, 200) }],
        errorsTruncated: false,
      }
    }

    let imported = 0
    let updated = 0
    let skipped = 0
    const errors: ImportRowError[] = []
    let truncated = false

    rows.forEach((row, index) => {
      // +2：CSV 第 1 行是表头，数组下标从 0 开始
      const line = index + 2
      try {
        const upsert = toUpsert(row, options)
        const result = this.store.upsert(upsert)
        if (result.created) {
          imported += 1
          this.store.appendEvent(options.tenantId, result.contact.id, 'imported', { line })
        } else {
          updated += 1
        }

        const externalId = row['externalId']
        if (options.channelId !== undefined && externalId !== undefined && externalId !== '') {
          this.store.linkIdentity(options.tenantId, result.contact.id, options.channelId, externalId)
        }
      } catch (error) {
        skipped += 1
        if (errors.length < MAX_ERRORS) {
          errors.push({ line, error: String(error instanceof Error ? error.message : error), raw: JSON.stringify(row) })
        } else {
          truncated = true
        }
      }
    })

    return { total: rows.length, imported, updated, skipped, errors, errorsTruncated: truncated }
  }
}

function toUpsert(row: Record<string, string>, options: ImportOptions): ContactUpsert {
  const email = value(row['email'])
  const phone = value(row['phone'])
  const externalId = value(row['externalId'])

  // 三者皆空 → 无法建立稳定身份，这一行必须报错而不是造一个随机 id
  // （随机 id 会让同一份文件重复导入时不断新建，破坏幂等）
  const dedupKey = normalizeDedupKey({
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    ...(externalId === undefined || options.channelId === undefined
      ? {}
      : { fallback: `${options.channelId}:${externalId}` }),
  })

  const tags = value(row['tags'])

  return {
    tenantId: options.tenantId,
    dedupKey,
    ...(value(row['name']) === undefined ? {} : { name: row['name'] as string }),
    ...(phone === undefined ? {} : { phone }),
    ...(email === undefined ? {} : { email }),
    ...(value(row['company']) === undefined ? {} : { company: row['company'] as string }),
    ...(value(row['owner']) === undefined ? {} : { owner: row['owner'] as string }),
    source: value(row['source']) ?? options.source ?? 'csv_import',
    ...(tags === undefined ? {} : { tags: tags.split(/[,，;；|]/).map((t) => t.trim()).filter((t) => t !== '') }),
  }
}

function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * 把表头归一化成内部字段名。
 *
 * 未识别的表头**保留原样**——它们会成为自定义属性的候选，
 * 而不是被静默丢弃（运营常在表里放业务专有列）。
 */
function normalizeHeader(column: string): string {
  const lower = column.trim().toLowerCase()
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(lower)) return field
  }
  return column.trim()
}

export { normalizeHeader }
