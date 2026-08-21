/**
 * Markdown → 知识块。
 *
 * 切分策略（RESEARCH.md 决策）：**一个二级标题 = 一个可独立回答的知识单元**。
 * 不用「按 token 数切」的通用 splitter——那会把一条政策切成两半，
 * 检索命中后答不完整。
 *
 * 复用：`gray-matter` 解析 frontmatter；分块逻辑自建（业务语义）。
 */

import matter from 'gray-matter'

import type { KnowledgeHit } from '../harness/ports.js'

/** 一个待入库的知识块。`KnowledgeHit` 加上入库需要的租户与排序信息。 */
export interface ParsedChunk extends KnowledgeHit {
  readonly heading: string
  /** 在源文件中的出现顺序，用于稳定排序与 chunkId 生成。 */
  readonly ordinal: number
  readonly metadata: Readonly<Record<string, unknown>>
}

/** 生成分块时的可选覆盖。 */
export interface ParseOptions {
  /** 文档标题；缺省时取一级标题，再缺省取文件名。 */
  readonly title?: string
}

/** 切分深度：`##` 及更深的标题各自成块；`#` 作为文档标题不单独成块。 */
const SECTION_HEADING = /^(#{2,6})\s+(.+?)\s*$/
const DOC_HEADING = /^#\s+(.+?)\s*$/

/**
 * 解析一个 Markdown 文件。
 *
 * @param sourceFile - 相对知识库根目录的路径，用作稳定标识。
 * @param raw - 文件全文。
 * @param options - 可选覆盖。
 * @returns 有序的知识块；文件为空或只有 frontmatter 时返回空数组。
 */
export function parseMarkdown(sourceFile: string, raw: string, options: ParseOptions = {}): readonly ParsedChunk[] {
  const parsed = safeMatter(raw)
  const metadata = parsed.data
  const lines = parsed.content.split(/\r?\n/)

  const docTitle = options.title ?? findDocTitle(lines) ?? stripExtension(sourceFile)

  const chunks: ParsedChunk[] = []
  /** 当前所在的标题栈：index 0 = `##`，index 1 = `###`，以此类推。 */
  let stack: string[] = []
  let currentHeading: string | undefined
  let buffer: string[] = []

  const flush = (): void => {
    const content = buffer.join('\n').trim()
    buffer = []
    // 只有前言（标题之前的正文）也要成块——它常常是最重要的总述
    if (content === '') return
    const heading = currentHeading ?? docTitle
    const path = currentHeading === undefined ? docTitle : [docTitle, ...stack].join(' / ')
    chunks.push({
      chunkId: `${sourceFile}#${chunks.length}`,
      sourceFile,
      heading,
      headingPath: path,
      content,
      ordinal: chunks.length,
      metadata,
    })
  }

  for (const line of lines) {
    const section = SECTION_HEADING.exec(line)
    if (section === null) {
      // 一级标题是文档标题，不进正文
      if (DOC_HEADING.test(line) && currentHeading === undefined && buffer.join('').trim() === '') continue
      buffer.push(line)
      continue
    }
    flush()
    const depth = (section[1] ?? '##').length - 2
    const title = section[2] ?? ''
    stack = [...stack.slice(0, depth), title]
    currentHeading = title
  }
  flush()

  return chunks
}

/**
 * frontmatter 解析失败不应让整个知识库 ingest 崩掉。
 *
 * 一个写错 YAML 的文件只应该丢掉自己的元数据，而不是阻塞其余文件入库。
 */
function safeMatter(raw: string): { data: Record<string, unknown>; content: string } {
  try {
    const result = matter(raw)
    return { data: result.data as Record<string, unknown>, content: result.content }
  } catch {
    return { data: {}, content: raw }
  }
}

function findDocTitle(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = DOC_HEADING.exec(line)
    if (match !== null) return match[1]
    if (SECTION_HEADING.test(line)) return undefined
  }
  return undefined
}

function stripExtension(path: string): string {
  const base = path.split('/').at(-1) ?? path
  return base.replace(/\.mdx?$/i, '')
}
