/**
 * SQLite 只存标量，领域模型里的 `tags` / `attributes` / `payload` 等结构化字段
 * 统一以 JSON 文本列落库。此模块收口序列化与「坏数据不 crash」的读取策略。
 */

/** 把值序列化为 JSON 文本列。`undefined` 归一化为 `null` 列值。 */
export function toJsonColumn(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

/**
 * 读取 JSON 文本列。
 *
 * 历史数据可能是旧格式或被截断——**读取路径不允许因此崩溃**（对齐 dsh 的
 * 「回放不允许 crash」纪律），解析失败返回 `fallback`。
 *
 * @param raw - 列值。
 * @param fallback - 解析失败或列为空时的返回值。
 */
export function fromJsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
