/**
 * 联系人存储。
 *
 * schema 的关键设计（RESEARCH.md §身份三分）：渠道身份是**独立的表 + 独立唯一索引**，
 * 不是联系人表上的两个列。Python 版把它们塞在同一行，导致「同一个人在企微和
 * webchat 各建一条」以及「按手机号入站时又建一条」两个生产 bug。
 */

import { randomUUID } from 'node:crypto'

import { fromJsonColumn, toJsonColumn } from '../db/json.js'
import { type Db, type Migration, transaction } from '../db/sqlite.js'
import {
  type ChannelIdentity,
  type Contact,
  type ContactEvent,
  type ContactEventKind,
  type ContactUpsert,
  type LeadStatus,
  type LifecycleStage,
} from './types.js'

export const CRM_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'create_contacts',
    sql: `
      CREATE TABLE contacts (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        dedup_key       TEXT NOT NULL,
        name            TEXT,
        phone           TEXT,
        email           TEXT,
        company         TEXT,
        lifecycle_stage TEXT NOT NULL DEFAULT 'new',
        lead_status     TEXT NOT NULL DEFAULT 'not_contacted',
        score           INTEGER NOT NULL DEFAULT 0,
        owner           TEXT,
        source          TEXT,
        tags            TEXT,
        attributes      TEXT,
        inbound_count   INTEGER NOT NULL DEFAULT 0,
        outbound_count  INTEGER NOT NULL DEFAULT 0,
        last_inbound_at  TEXT,
        last_outbound_at TEXT,
        converted_at    TEXT,
        deal_value      REAL,
        lost_reason     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_contacts_dedup ON contacts (tenant_id, dedup_key);
      CREATE INDEX idx_contacts_stage ON contacts (tenant_id, lifecycle_stage);
      CREATE INDEX idx_contacts_status ON contacts (tenant_id, lead_status);

      -- 渠道身份独立成表：一个联系人可挂多个渠道；
      -- (tenant, channel, external_id) 唯一保证「同一渠道同一个人」只指向一条联系人
      CREATE TABLE contact_identities (
        tenant_id   TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        external_id TEXT NOT NULL,
        contact_id  TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
        linked_at   TEXT NOT NULL,
        PRIMARY KEY (tenant_id, channel_id, external_id)
      );
      CREATE INDEX idx_identities_contact ON contact_identities (contact_id);

      -- seq 是 AUTOINCREMENT 的插入序。
      -- 不能只靠 at 列排序：建档瞬间会连发 imported/identity_linked/inbound/stage_changed
      -- 四条事件，ISO 时间戳只到毫秒，同毫秒内的顺序会退化成按随机 UUID 排，
      -- 导致时间线显示成乱序。
      CREATE TABLE contact_events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        id         TEXT NOT NULL UNIQUE,
        tenant_id  TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        payload    TEXT,
        at         TEXT NOT NULL
      );
      CREATE INDEX idx_events_contact ON contact_events (contact_id, seq);
    `,
  },
]

interface ContactRow {
  readonly id: string
  readonly tenant_id: string
  readonly dedup_key: string
  readonly name: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly company: string | null
  readonly lifecycle_stage: string
  readonly lead_status: string
  readonly score: number
  readonly owner: string | null
  readonly source: string | null
  readonly tags: string | null
  readonly attributes: string | null
  readonly inbound_count: number
  readonly outbound_count: number
  readonly last_inbound_at: string | null
  readonly last_outbound_at: string | null
  readonly converted_at: string | null
  readonly deal_value: number | null
  readonly lost_reason: string | null
  readonly created_at: string
  readonly updated_at: string
}

/** 联系人的行为计数，打分用。不放进 `Contact` 因为它是内部指标而非业务字段。 */
export interface ContactCounters {
  readonly inboundCount: number
  readonly outboundCount: number
}

export interface UpsertResult {
  readonly contact: Contact
  /** 是新建还是更新已有。CSV 导入报告需要区分。 */
  readonly created: boolean
}

export class ContactStore {
  constructor(private readonly db: Db) {}

  /**
   * 按业务去重键插入或更新。
   *
   * `undefined` 字段表示「不改动」而非「清空」——CSV 导入常常只带部分列，
   * 用它覆盖掉已有的电话/公司会造成数据丢失。
   *
   * @param upsert - 写入载荷。
   * @returns 写入后的联系人与是否新建。
   */
  upsert(upsert: ContactUpsert): UpsertResult {
    return transaction(this.db, () => {
      const existing = this.findByDedupKeySync(upsert.tenantId, upsert.dedupKey)
      const now = new Date().toISOString()

      if (existing === undefined) {
        const id = randomUUID()
        this.db
          .prepare(
            `INSERT INTO contacts
               (id, tenant_id, dedup_key, name, phone, email, company, lifecycle_stage, lead_status,
                score, owner, source, tags, attributes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            upsert.tenantId,
            upsert.dedupKey,
            upsert.name ?? null,
            upsert.phone ?? null,
            upsert.email ?? null,
            upsert.company ?? null,
            upsert.lifecycleStage ?? 'new',
            upsert.leadStatus ?? 'not_contacted',
            upsert.owner ?? null,
            upsert.source ?? null,
            toJsonColumn(upsert.tags ?? []),
            toJsonColumn(upsert.attributes ?? {}),
            now,
            now,
          )
        return { contact: this.requireSync(id), created: true }
      }

      // COALESCE 语义：传了就改，没传保持原值
      this.db
        .prepare(
          `UPDATE contacts SET
             name            = COALESCE(?, name),
             phone           = COALESCE(?, phone),
             email           = COALESCE(?, email),
             company         = COALESCE(?, company),
             lifecycle_stage = COALESCE(?, lifecycle_stage),
             lead_status     = COALESCE(?, lead_status),
             owner           = COALESCE(?, owner),
             source          = COALESCE(?, source),
             tags            = COALESCE(?, tags),
             attributes      = COALESCE(?, attributes),
             updated_at      = ?
           WHERE id = ?`,
        )
        .run(
          upsert.name ?? null,
          upsert.phone ?? null,
          upsert.email ?? null,
          upsert.company ?? null,
          upsert.lifecycleStage ?? null,
          upsert.leadStatus ?? null,
          upsert.owner ?? null,
          upsert.source ?? null,
          upsert.tags === undefined ? null : toJsonColumn(upsert.tags),
          upsert.attributes === undefined ? null : toJsonColumn(upsert.attributes),
          now,
          existing.id,
        )
      return { contact: this.requireSync(existing.id), created: false }
    })
  }

  /** 按 id 取联系人。 */
  get(id: string): Contact | undefined {
    const row = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as unknown as ContactRow | undefined
    return row === undefined ? undefined : this.hydrate(row)
  }

  /** 按业务去重键取联系人。 */
  findByDedupKey(tenantId: string, dedupKey: string): Contact | undefined {
    return this.findByDedupKeySync(tenantId, dedupKey)
  }

  /**
   * 按渠道身份取联系人。
   *
   * 这是入站消息的主查询路径——**先按渠道身份找**，找不到再按业务身份找，
   * 都找不到才新建。这个顺序是 Python 版「按手机号建重复联系人」bug 的修复。
   *
   * @param tenantId - 租户。
   * @param channelId - 渠道。
   * @param externalId - 渠道侧用户标识。
   * @returns 联系人；未关联返回 `undefined`。
   */
  findByChannelIdentity(tenantId: string, channelId: string, externalId: string): Contact | undefined {
    const row = this.db
      .prepare(
        `SELECT c.* FROM contacts c
           JOIN contact_identities i ON i.contact_id = c.id
          WHERE i.tenant_id = ? AND i.channel_id = ? AND i.external_id = ?`,
      )
      .get(tenantId, channelId, externalId) as unknown as ContactRow | undefined
    return row === undefined ? undefined : this.hydrate(row)
  }

  /**
   * 关联一个渠道身份。
   *
   * 幂等：同一 (租户, 渠道, external_id) 重复关联到**同一个**联系人无副作用；
   * 关联到**不同**联系人则抛错——那意味着身份冲突，需要人工合并而不是静默覆盖。
   *
   * @param tenantId - 租户。
   * @param contactId - 联系人 id。
   * @param channelId - 渠道。
   * @param externalId - 渠道侧用户标识。
   * @throws {Error} 该渠道身份已属于另一个联系人。
   */
  linkIdentity(tenantId: string, contactId: string, channelId: string, externalId: string): void {
    const owner = this.db
      .prepare('SELECT contact_id FROM contact_identities WHERE tenant_id = ? AND channel_id = ? AND external_id = ?')
      .get(tenantId, channelId, externalId) as unknown as { contact_id: string } | undefined

    if (owner !== undefined) {
      if (owner.contact_id === contactId) return
      throw new Error(
        `渠道身份 ${channelId}:${externalId} 已归属联系人 ${owner.contact_id}，不能改挂到 ${contactId}；请先人工合并`,
      )
    }
    this.db
      .prepare('INSERT INTO contact_identities (tenant_id, channel_id, external_id, contact_id, linked_at) VALUES (?, ?, ?, ?, ?)')
      .run(tenantId, channelId, externalId, contactId, new Date().toISOString())
  }

  /** 更新阶段与状态。调用方负责先过 `checkTransition`。 */
  updateStage(id: string, stage: LifecycleStage, status?: LeadStatus): void {
    this.db
      .prepare(
        `UPDATE contacts SET lifecycle_stage = ?, lead_status = COALESCE(?, lead_status),
           converted_at = CASE WHEN ? = 'customer' AND converted_at IS NULL THEN ? ELSE converted_at END,
           updated_at = ? WHERE id = ?`,
      )
      .run(stage, status ?? null, stage, new Date().toISOString(), new Date().toISOString(), id)
  }

  /** 更新意向分。 */
  updateScore(id: string, score: number): void {
    this.db.prepare('UPDATE contacts SET score = ?, updated_at = ? WHERE id = ?').run(score, new Date().toISOString(), id)
  }

  /** 记一次入站，返回更新后的计数。 */
  recordInbound(id: string, at: Date): ContactCounters {
    this.db
      .prepare('UPDATE contacts SET inbound_count = inbound_count + 1, last_inbound_at = ?, updated_at = ? WHERE id = ?')
      .run(at.toISOString(), at.toISOString(), id)
    return this.counters(id)
  }

  /** 记一次外呼，返回更新后的计数。 */
  recordOutbound(id: string, at: Date): ContactCounters {
    this.db
      .prepare('UPDATE contacts SET outbound_count = outbound_count + 1, last_outbound_at = ?, updated_at = ? WHERE id = ?')
      .run(at.toISOString(), at.toISOString(), id)
    return this.counters(id)
  }

  /** 读取行为计数。 */
  counters(id: string): ContactCounters {
    const row = this.db.prepare('SELECT inbound_count, outbound_count FROM contacts WHERE id = ?').get(id) as unknown as
      | { inbound_count: number; outbound_count: number }
      | undefined
    return { inboundCount: Number(row?.inbound_count ?? 0), outboundCount: Number(row?.outbound_count ?? 0) }
  }

  /** 列出租户下的联系人（分页）。 */
  list(tenantId: string, limit = 100, offset = 0): readonly Contact[] {
    const rows = this.db
      .prepare('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?')
      .all(tenantId, limit, offset) as unknown as ContactRow[]
    return rows.map((row) => this.hydrate(row))
  }

  /** 统计租户下的联系人总数。 */
  count(tenantId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ?').get(tenantId) as unknown as {
      n: number
    }
    return Number(row.n)
  }

  /** 漏斗分布：阶段 → 人数。 */
  funnel(tenantId: string): Readonly<Record<string, number>> {
    const rows = this.db
      .prepare('SELECT lifecycle_stage AS stage, COUNT(*) AS n FROM contacts WHERE tenant_id = ? GROUP BY lifecycle_stage')
      .all(tenantId) as unknown as { stage: string; n: number }[]
    return Object.fromEntries(rows.map((row) => [row.stage, Number(row.n)]))
  }

  /** 追加时间线事件。 */
  appendEvent(tenantId: string, contactId: string, kind: ContactEventKind, payload: Record<string, unknown> = {}): ContactEvent {
    const event: ContactEvent = {
      id: randomUUID(),
      tenantId,
      contactId,
      kind,
      payload,
      at: new Date(),
    }
    this.db
      .prepare('INSERT INTO contact_events (id, tenant_id, contact_id, kind, payload, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.id, tenantId, contactId, kind, toJsonColumn(payload), event.at.toISOString())
    return event
  }

  /** 读取时间线（按时间正序）。 */
  timeline(contactId: string, limit = 100): readonly ContactEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM contact_events WHERE contact_id = ? ORDER BY seq LIMIT ?')
      .all(contactId, limit) as unknown as {
      id: string
      tenant_id: string
      contact_id: string
      kind: string
      payload: string | null
      at: string
    }[]
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      contactId: row.contact_id,
      kind: row.kind as ContactEventKind,
      payload: fromJsonColumn<Record<string, unknown>>(row.payload, {}),
      at: new Date(row.at),
    }))
  }

  private findByDedupKeySync(tenantId: string, dedupKey: string): Contact | undefined {
    const row = this.db
      .prepare('SELECT * FROM contacts WHERE tenant_id = ? AND dedup_key = ?')
      .get(tenantId, dedupKey) as unknown as ContactRow | undefined
    return row === undefined ? undefined : this.hydrate(row)
  }

  private requireSync(id: string): Contact {
    const contact = this.get(id)
    if (contact === undefined) throw new Error(`联系人 ${id} 刚写入却读不到——数据库状态异常`)
    return contact
  }

  private identitiesOf(contactId: string): readonly ChannelIdentity[] {
    const rows = this.db
      .prepare('SELECT channel_id, external_id, linked_at FROM contact_identities WHERE contact_id = ? ORDER BY linked_at')
      .all(contactId) as unknown as { channel_id: string; external_id: string; linked_at: string }[]
    return rows.map((row) => ({
      channelId: row.channel_id,
      externalId: row.external_id,
      linkedAt: new Date(row.linked_at),
    }))
  }

  private hydrate(row: ContactRow): Contact {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      dedupKey: row.dedup_key,
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.phone === null ? {} : { phone: row.phone }),
      ...(row.email === null ? {} : { email: row.email }),
      ...(row.company === null ? {} : { company: row.company }),
      lifecycleStage: row.lifecycle_stage as LifecycleStage,
      leadStatus: row.lead_status as LeadStatus,
      score: Number(row.score),
      ...(row.owner === null ? {} : { owner: row.owner }),
      ...(row.source === null ? {} : { source: row.source }),
      tags: fromJsonColumn<string[]>(row.tags, []),
      attributes: fromJsonColumn<Record<string, string | number | boolean>>(row.attributes, {}),
      identities: this.identitiesOf(row.id),
      ...(row.last_inbound_at === null ? {} : { lastInboundAt: new Date(row.last_inbound_at) }),
      ...(row.last_outbound_at === null ? {} : { lastOutboundAt: new Date(row.last_outbound_at) }),
      ...(row.converted_at === null ? {} : { convertedAt: new Date(row.converted_at) }),
      ...(row.deal_value === null ? {} : { dealValue: Number(row.deal_value) }),
      ...(row.lost_reason === null ? {} : { lostReason: row.lost_reason }),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }
  }
}
