/** Dify ワークフロー API（blocking） */

const WORKFLOW_USER = 'abc-123'

/** ワークフロー result から復元するタスク中身（id はアプリ側で付与） */
export type ParsedTaskFields = {
  title: string
  time?: string
  context?: string
  tags?: string[]
  category?: string
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function workflowRunUrl(base: string): string {
  if (base.endsWith('/workflows/run')) return base
  if (base.endsWith('/v1')) return `${base}/workflows/run`
  return `${base}/v1/workflows/run`
}

function getConfig(): { apiKey: string; url: string } {
  const apiKey = import.meta.env.VITE_DIFY_API_KEY?.trim() ?? ''
  const baseUrl = import.meta.env.VITE_DIFY_API_URL?.trim() ?? ''
  if (!apiKey || apiKey.includes('ここにコピー')) {
    throw new Error('.env の VITE_DIFY_API_KEY に実際の API キーを設定してください')
  }
  if (!baseUrl || baseUrl.includes('ここにコピー')) {
    throw new Error('.env の VITE_DIFY_API_URL に実際のベース URL を設定してください')
  }
  return { apiKey, url: workflowRunUrl(normalizeBaseUrl(baseUrl)) }
}

function extractErrorMessage(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const o = json as Record<string, unknown>
  if (typeof o.message === 'string') return o.message
  if (typeof o.code === 'string') return o.code
  return ''
}

/** レスポンスから `data.outputs.result`（なければトップレベル `outputs.result`）を取り出す */
function extractWorkflowResult(json: unknown): unknown {
  if (!json || typeof json !== 'object') return undefined
  const root = json as Record<string, unknown>
  const data = root.data
  if (data && typeof data === 'object') {
    const outputs = (data as Record<string, unknown>).outputs
    if (outputs && typeof outputs === 'object' && 'result' in outputs) {
      return (outputs as Record<string, unknown>).result
    }
  }
  const topOut = root.outputs
  if (topOut && typeof topOut === 'object' && 'result' in topOut) {
    return (topOut as Record<string, unknown>).result
  }
  return undefined
}

function readTags(o: Record<string, unknown>): string[] | undefined {
  const raw = o.tags
  if (!Array.isArray(raw)) return undefined
  const tags = raw
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
  return tags.length ? tags : undefined
}

/** DB の context 列に入れる想定（場所・デバイス） */
const CONTEXT_LIKE_LABELS = new Set(['家の中', '外出', 'PC', 'スマホ'])
/** DB の category 列に入れる想定（仕事/副業/家事/プライベート） */
const WORK_CATEGORY_LABELS = new Set(['仕事', '副業', '家事', 'プライベート'])

function pickTrimmedString(...candidates: unknown[]): string | undefined {
  for (const v of candidates) {
    if (typeof v === 'string') {
      const t = v.trim()
      if (t) return t
    }
  }
  return undefined
}

/**
 * Dify の category / context を DB カラム用に必ず分離する。
 * - JSON の category（＋別名 task_category）だけを「仕事系 category」の候補にする
 * - JSON の context（＋ place / location）だけを「場所 context」の候補にする
 * - ワークフローでキーが逆転している・場所だけが category に入っている場合を補正する
 */
export function alignCategoryAndContextForDb(
  categoryIn: string | undefined,
  contextIn: string | undefined,
): { category?: string; context?: string } {
  let category = categoryIn?.trim() || undefined
  let context = contextIn?.trim() || undefined

  if (
    category &&
    context &&
    CONTEXT_LIKE_LABELS.has(category) &&
    WORK_CATEGORY_LABELS.has(context)
  ) {
    const t = category
    category = context
    context = t
  }

  if (category && CONTEXT_LIKE_LABELS.has(category)) {
    if (!context) {
      context = category
    } else if (context !== category) {
      context = `${category} · ${context}`
    }
    category = undefined
  }

  if (context && WORK_CATEGORY_LABELS.has(context)) {
    category = category ?? context
    context = undefined
  }

  if (category && CONTEXT_LIKE_LABELS.has(category)) {
    if (!context) {
      context = category
    } else if (context !== category) {
      context = `${category} · ${context}`
    }
    category = undefined
  }

  return {
    ...(category ? { category } : {}),
    ...(context ? { context } : {}),
  }
}

/**
 * 文字列・オブジェクトいずれも ParsedTaskFields に。
 * category / context は alignCategoryAndContextForDb で DB カラムと一対一に揃える。
 */
export function normalizeTaskFields(raw: unknown): ParsedTaskFields | null {
  if (typeof raw === 'string') {
    const t = raw.trim()
    return t ? { title: t } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const titleSrc = o.title ?? o.name ?? o.label ?? o.text
  const title = typeof titleSrc === 'string' ? titleSrc.trim() : ''
  if (!title) return null
  const timeRaw = o.time ?? o.duration
  const time = typeof timeRaw === 'string' ? timeRaw.trim() : undefined
  const tags = readTags(o)

  const rawCategory = pickTrimmedString(o.category, o.task_category)
  const rawContext = pickTrimmedString(o.context, o.place, o.location)
  const { category, context } = alignCategoryAndContextForDb(rawCategory, rawContext)

  return {
    title,
    ...(time ? { time } : {}),
    ...(context ? { context } : {}),
    ...(tags ? { tags } : {}),
    ...(category ? { category } : {}),
  }
}

function parseNextTasksArray(arr: unknown[]): ParsedTaskFields[] {
  const out: ParsedTaskFields[] = []
  for (const item of arr) {
    const t = normalizeTaskFields(item)
    if (t) out.push(t)
  }
  return out
}

/**
 * ワークフロー終端の `result` を current_task + next_tasks に正規化。
 * - current_task: `{ title, time, context, tags }` または従来の文字列
 * - next_tasks: オブジェクト配列または文字列配列
 */
export function parseTasksFromWorkflowResult(result: unknown): {
  main: ParsedTaskFields | null
  next: ParsedTaskFields[]
} {
  let value: unknown = result

  if (typeof value === 'string') {
    const t = value.trim()
    if (!t) return { main: null, next: [] }
    try {
      value = JSON.parse(t) as unknown
    } catch {
      return { main: { title: t }, next: [] }
    }
  }

  if (Array.isArray(value)) {
    const items = parseNextTasksArray(value)
    const main = items[0] ?? null
    return { main, next: items.slice(1) }
  }

  if (!value || typeof value !== 'object') {
    return { main: null, next: [] }
  }

  const o = value as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')

  let main: ParsedTaskFields | null = null
  const ct = o.current_task ?? o.current
  if (ct !== undefined) {
    main = normalizeTaskFields(ct)
  }
  if (!main) {
    const flatTitle =
      str('current_task') ||
      str('current') ||
      str('main') ||
      str('task') ||
      str('first') ||
      str('title') ||
      ''
    if (flatTitle) main = { title: flatTitle }
  }

  const nextKey = ['next_tasks', 'next', 'subtasks', 'rest', 'later'] as const
  let next: ParsedTaskFields[] = []
  for (const k of nextKey) {
    const raw = o[k]
    if (Array.isArray(raw)) {
      next = parseNextTasksArray(raw)
      break
    }
  }

  return { main, next }
}

export async function runDifyWorkflow(message: string): Promise<unknown> {
  const { apiKey, url } = getConfig()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: { text: message },
      response_mode: 'blocking',
      user: WORKFLOW_USER,
    }),
  })

  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = extractErrorMessage(json) || res.statusText
    throw new Error(`Dify ワークフロー: ${msg || res.status}`)
  }

  const rawResult = extractWorkflowResult(json)
  if (rawResult === undefined) {
    throw new Error('レスポンスに data.outputs.result がありません（ワークフロー出力名を result にしてください）')
  }

  return rawResult
}
