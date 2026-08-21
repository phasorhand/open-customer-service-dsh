/**
 * 知识库摄取：全量扫描 + 文件变更热重载。
 *
 * 复用：`chokidar @ ^4` —— 跨平台事件一致性优于原生 `fs.watch`
 * （macOS 上编辑器的原子写常被 `fs.watch` 漏掉）。
 *
 * 防抖的必要性：编辑器保存一个文件常触发 2-4 次事件（写临时文件 → rename → 改 mtime）。
 * 不防抖会导致同一文件被重复解析入库；虽然 `replaceFile` 是幂等的，
 * 但重复解析大文件会拖慢响应。
 */

import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import chokidar, { type FSWatcher } from 'chokidar'

import { parseMarkdown } from './parser.js'
import type { SqliteKnowledgeStore } from './store.js'

/** 文件变更后等待多久再入库（毫秒）。覆盖编辑器的多次写入。 */
const DEBOUNCE_MS = 300

export interface IngestorOptions {
  readonly root: string
  readonly tenantId: string
  readonly store: SqliteKnowledgeStore
  /** 变更入库后的回调，便于日志与测试同步。 */
  readonly onIngested?: (sourceFile: string, chunkCount: number) => void
}

export interface IngestReport {
  readonly files: number
  readonly chunks: number
  readonly failed: readonly { readonly sourceFile: string; readonly error: string }[]
}

export class KnowledgeIngestor {
  private watcher: FSWatcher | undefined
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly options: IngestorOptions) {}

  /**
   * 全量扫描知识库目录并入库。
   *
   * 单个文件解析失败**不会中断整体**——它只出现在 `failed` 里。
   * 一个写坏的文件不应该让整个知识库不可用。
   *
   * @returns 入库报告。
   */
  async ingestAll(): Promise<IngestReport> {
    const root = resolve(this.options.root)
    const files = await listMarkdown(root)
    let chunks = 0
    const failed: { sourceFile: string; error: string }[] = []

    for (const absolute of files) {
      const sourceFile = relative(root, absolute)
      try {
        chunks += await this.ingestFile(absolute, sourceFile)
      } catch (error) {
        failed.push({ sourceFile, error: String(error) })
      }
    }
    return { files: files.length - failed.length, chunks, failed }
  }

  /**
   * 开始监听目录变更。
   *
   * @returns 停止监听的函数（registrations are effects）。
   */
  async watch(): Promise<() => Promise<void>> {
    const root = resolve(this.options.root)
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      // 等文件写完再触发，避免读到写了一半的内容
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    })
    this.watcher = watcher

    const schedule = (absolute: string, action: 'upsert' | 'remove'): void => {
      if (!isMarkdown(absolute)) return
      const sourceFile = relative(root, absolute)
      clearTimeout(this.timers.get(sourceFile))
      this.timers.set(
        sourceFile,
        setTimeout(() => {
          this.timers.delete(sourceFile)
          void this.applyChange(absolute, sourceFile, action)
        }, DEBOUNCE_MS),
      )
    }

    watcher.on('add', (path) => schedule(path, 'upsert'))
    watcher.on('change', (path) => schedule(path, 'upsert'))
    watcher.on('unlink', (path) => schedule(path, 'remove'))

    // 必须等到 ready 再返回：chokidar 在完成初始扫描前不会派发事件，
    // 此时发生的变更会被**静默丢弃**。调用方 await 了 watch() 就应该能相信
    // 之后的改动都被看见。
    await new Promise<void>((resolveReady) => {
      watcher.once('ready', () => resolveReady())
    })

    return async () => {
      await this.stop()
    }
  }

  /** 停止监听并清理待执行的防抖任务。 */
  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await this.watcher?.close()
    this.watcher = undefined
  }

  private async applyChange(absolute: string, sourceFile: string, action: 'upsert' | 'remove'): Promise<void> {
    try {
      if (action === 'remove') {
        this.options.store.deleteFile(this.options.tenantId, sourceFile)
        this.options.onIngested?.(sourceFile, 0)
        return
      }
      const count = await this.ingestFile(absolute, sourceFile)
      this.options.onIngested?.(sourceFile, count)
    } catch {
      // 热重载路径吞掉单文件错误：一个写坏的文件不应该打断 watcher
    }
  }

  private async ingestFile(absolute: string, sourceFile: string): Promise<number> {
    const raw = await readFile(absolute, 'utf8')
    const chunks = parseMarkdown(sourceFile, raw)
    this.options.store.replaceFile(this.options.tenantId, sourceFile, chunks)
    return chunks.length
  }
}

function isMarkdown(path: string): boolean {
  return /\.mdx?$/i.test(path)
}

async function listMarkdown(root: string): Promise<readonly string[]> {
  const { readdir } = await import('node:fs/promises')
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // 知识库目录不存在是合法状态（尚未配置），不应让启动失败
      return
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        await walk(full)
      } else if (entry.isFile() && isMarkdown(entry.name)) {
        out.push(full)
      }
    }
  }
  await walk(root)
  return out.sort()
}
