import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  alignCategoryAndContextForDb,
  parseTasksFromWorkflowResult,
  runDifyWorkflow,
  type ParsedTaskFields,
} from './dify'
import { getSupabase, isSupabaseConfigured } from './supabaseClient'
import type { TaskItem } from './taskTypes'
import {
  fetchTodoTasks,
  markTaskCompleted,
  persistSortOrders,
  appendTodoTasks,
  updateTaskById,
} from './tasksDb'
import { isSpeechRecognitionSupported, useSpeechDictation } from './useSpeechDictation'

type MainMetaField = 'time' | 'context' | 'tags'

type QueueEditField = 'title' | 'time' | 'context' | 'tags'

const COMPLETE_MS = 650
const STORAGE_KEY = 'execution-navigator-v1'
const LAST_INPUT_KEY = 'execution-navigator-last-input'

const REMOTE = isSupabaseConfigured()

/** 固定フッター＋キーボード表示時も本文が隠れないよう余白を確保 */
const FOOTER_BOTTOM_PAD =
  'pb-[max(12.5rem,calc(env(safe-area-inset-bottom,0px)+11rem))]'

const CARD_ROUND = 'rounded-[2.5rem]'

const PLACEHOLDER_MAIN = 'タスクを入力してください'

/** カテゴリ×時間のフィルターに1件も合わないとき（メイン青カード内） */
const FILTER_NO_MATCH_MSG =
  '今この条件でやるべきことはありません。ゆっくり休んでください'

type CategoryFilterValue = 'all' | '仕事' | '副業' | '家事' | 'プライベート'
type TimeFilterValue = 'all' | 15 | 30 | 60

const FILTER_CATEGORY_LABELS = new Set<string>(['仕事', '副業', '家事', 'プライベート'])

/** カードに出すのはフィルターと同じ4カテゴリのみ（外出・家の中などはバッジにしない） */
function taskCategoryBadgeLabel(task: TaskItem): CategoryFilterValue | null {
  const c = task.category?.trim()
  if (!c) return null
  return FILTER_CATEGORY_LABELS.has(c) ? (c as CategoryFilterValue) : null
}

/** メイン青カード：カテゴリバッジ（仕事/副業/家事/プライベートのみ） */
const mainCategoryBadgeClass =
  'inline-flex shrink-0 items-center rounded-full border border-white/50 bg-white/22 px-2.5 py-1 text-[10px] font-semibold tracking-wide text-white sm:text-xs'

/** キュー行：カテゴリバッジ */
const queueCategoryBadgeClass =
  'inline-flex shrink-0 items-center rounded-full border border-slate-300/90 bg-slate-100 px-2.5 py-0.5 text-[10px] font-semibold text-slate-700 sm:text-xs'

/** メイン：ユーザー用タグ（context とは別） */
const mainTagsChipClass =
  'inline-flex max-w-[min(100%,20rem)] shrink-0 items-center truncate rounded-lg border border-white/35 bg-white/14 px-2.5 py-1.5 text-left text-[11px] font-medium leading-tight text-white/90 ring-1 ring-white/20 transition hover:border-white/50 hover:bg-white/22 sm:text-xs'

const queueTagsChipClass =
  'inline-flex max-w-full min-w-0 flex-1 items-center truncate rounded-lg border border-slate-200/90 bg-white px-2.5 py-1 text-left text-[11px] font-medium leading-tight text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50/90 sm:text-xs'

/**
 * Dify の time（5min / 15min / 30min / 60min）および「5分」などから分数を取得。
 * 時間チップは「持ち時間（タイムバジェット）」: 許容スロットのみ表示（例 15分→5・15のみ）。
 */
function parseTaskDurationMinutes(time: string | undefined): number | null {
  if (time === undefined || time === '') return null
  const s = time.trim()
  const sl = s.toLowerCase()
  const minLabel = sl.match(/^(\d+)\s*min(?:ute)?s?$/)
  if (minLabel) {
    const n = parseInt(minLabel[1], 10)
    return Number.isFinite(n) ? n : null
  }
  const embedded = s.match(/(\d+)\s*(?:分|min(?:ute)?s?)/i)
  if (embedded) {
    const n = parseInt(embedded[1], 10)
    return Number.isFinite(n) ? n : null
  }
  if (/^\d+$/.test(sl)) {
    const n = parseInt(sl, 10)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** [15分]→5・15のみ、[30分]→5・15・30、[60分]→5・15・30・60（[All] は taskMatchesFilters 側で全通過） */
const TIME_BUDGET_ALLOWED_MINUTES: Record<15 | 30 | 60, readonly number[]> = {
  15: [5, 15],
  30: [5, 15, 30],
  60: [5, 15, 30, 60],
}

function taskMinutesInBudget(m: number, timeFilter: TimeFilterValue): boolean {
  if (timeFilter === 'all') return true
  return TIME_BUDGET_ALLOWED_MINUTES[timeFilter].includes(m)
}

/**
 * カテゴリ（1段目）と時間バジェット（2段目）の AND。
 * 場所（context）は絞り込みに使わない。
 */
function taskMatchesFilters(
  task: TaskItem,
  category: CategoryFilterValue,
  timeFilter: TimeFilterValue,
): boolean {
  if (category !== 'all') {
    if ((task.category?.trim() ?? '') !== category) return false
  }
  if (timeFilter !== 'all') {
    const m = parseTaskDurationMinutes(task.time)
    if (m === null) return false
    if (!taskMinutesInBudget(m, timeFilter)) return false
  }
  return true
}

/** 条件に合うタスクを sort_order 昇順（同値・未設定は一覧での位置）で並べ、先頭をメインカードに昇格 */
function tasksMatchingFiltersOrdered(
  tasks: TaskItem[],
  category: CategoryFilterValue,
  timeFilter: TimeFilterValue,
): TaskItem[] {
  return tasks
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => taskMatchesFilters(t, category, timeFilter))
    .sort((a, b) => {
      const sa = a.t.sort_order
      const sb = b.t.sort_order
      const hasA = typeof sa === 'number' && Number.isFinite(sa)
      const hasB = typeof sb === 'number' && Number.isFinite(sb)
      if (hasA && hasB && sa !== sb) return sa - sb
      if (hasA && !hasB) return -1
      if (!hasA && hasB) return 1
      return a.index - b.index
    })
    .map(({ t }) => t)
}

function chipClass(active: boolean): string {
  const base =
    'rounded-full border px-3 py-1.5 text-xs font-medium transition-[background-color,border-color,box-shadow,color] sm:px-3.5 sm:py-2 sm:text-[13px]'
  if (active) {
    return `${base} border-sky-500 bg-sky-500 text-white shadow-sm ring-1 ring-sky-400/40`
  }
  return `${base} border-slate-200/90 bg-white/85 text-slate-600 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-slate-300 hover:bg-white`
}

function newTaskId(): string {
  return crypto.randomUUID()
}

function fieldsToTask(f: ParsedTaskFields): TaskItem {
  const { category, context } = alignCategoryAndContextForDb(f.category, f.context)
  return {
    id: newTaskId(),
    title: f.title,
    ...(f.time ? { time: f.time } : {}),
    ...(context ? { context } : {}),
    ...(f.tags?.length ? { tags: f.tags } : {}),
    ...(category ? { category } : {}),
  }
}

/** localStorage v2: タスク全フィールド + ざっくり入力の直近1件 */
type PersistedV2 = {
  v: 2
  tasks: TaskItem[]
  /** ざっくり入力で最後に送信したテキスト（1件のみ保持） */
  lastSubmittedText: string | null
}

function reviveTask(x: unknown): TaskItem | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? o.id : newTaskId()
  const title =
    typeof o.title === 'string'
      ? o.title
      : typeof o.text === 'string'
        ? o.text
        : ''
  if (!title.trim()) return null
  const time = typeof o.time === 'string' ? o.time.trim() : undefined
  const contextRaw = typeof o.context === 'string' ? o.context.trim() : undefined
  let tags: string[] | undefined
  if (Array.isArray(o.tags)) {
    tags = o.tags.filter((t): t is string => typeof t === 'string').map((s) => s.trim()).filter(Boolean)
  }
  const categoryRaw = typeof o.category === 'string' ? o.category.trim() : ''
  const categoryIn = categoryRaw || undefined
  let sort_order: number | undefined
  if (typeof o.sort_order === 'number' && Number.isFinite(o.sort_order)) sort_order = o.sort_order
  else if (typeof o.sort_order === 'string' && /^\d+$/.test(o.sort_order.trim())) {
    const n = parseInt(o.sort_order.trim(), 10)
    if (Number.isFinite(n)) sort_order = n
  }
  const { category, context } = alignCategoryAndContextForDb(categoryIn, contextRaw)
  return {
    id,
    title: title.trim(),
    ...(typeof sort_order === 'number' ? { sort_order } : {}),
    ...(time ? { time } : {}),
    ...(context ? { context } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(category ? { category } : {}),
  }
}

function loadPersisted(): Pick<PersistedV2, 'tasks' | 'lastSubmittedText'> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<PersistedV2> & { v?: number; lastRoughInput?: string }
    if (!p || !Array.isArray(p.tasks)) return null
    if (p.v !== 2 && p.v !== 1) return null
    const tasks = p.tasks.map(reviveTask).filter((t): t is TaskItem => t !== null)
    const lastSubmittedText =
      typeof p.lastSubmittedText === 'string'
        ? p.lastSubmittedText
        : typeof p.lastRoughInput === 'string'
          ? p.lastRoughInput
          : null
    return { tasks, lastSubmittedText }
  } catch {
    return null
  }
}

/** 順序・フィールドを落とさずにスナップショット（「あとで」入れ替え後もそのまま復元） */
function snapshotTasksForStorage(tasks: TaskItem[]): TaskItem[] {
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    ...(typeof t.sort_order === 'number' && Number.isFinite(t.sort_order) ? { sort_order: t.sort_order } : {}),
    ...(t.time !== undefined && t.time !== '' ? { time: t.time } : {}),
    ...(t.context !== undefined && t.context !== '' ? { context: t.context } : {}),
    ...(t.tags !== undefined && t.tags.length > 0 ? { tags: [...t.tags] } : {}),
    ...(t.category !== undefined && t.category !== '' ? { category: t.category } : {}),
  }))
}

function savePersisted(tasks: TaskItem[], lastSubmittedText: string | null) {
  try {
    const payload: PersistedV2 = {
      v: 2,
      tasks: snapshotTasksForStorage(tasks),
      lastSubmittedText,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch (e) {
    console.warn('localStorage に保存できませんでした', e)
  }
}

let cachedInitial: ReturnType<typeof loadPersisted> | undefined
function initialSnapshot() {
  if (cachedInitial === undefined) cachedInitial = loadPersisted()
  return cachedInitial
}

function loadLastSubmittedFromStorage(): string | null {
  try {
    const a = localStorage.getItem(LAST_INPUT_KEY)
    if (a) return a
    return initialSnapshot()?.lastSubmittedText ?? null
  } catch {
    return null
  }
}

export default function App() {
  /** 送信時は React state より先に確定する音声ドラフト（onresult と送信の競合対策） */
  const inputDraftRef = useRef('')
  const taskInputRef = useRef<HTMLInputElement>(null)
  const [inputValue, setInputValueState] = useState('')
  /** ref と state を同時に更新（音声 onresult は setState より先に送信されることがある） */
  const setInputValue = useCallback((u: string | ((prev: string) => string)) => {
    if (typeof u === 'function') {
      setInputValueState((prev) => {
        const next = u(prev)
        inputDraftRef.current = next
        return next
      })
    } else {
      inputDraftRef.current = u
      setInputValueState(u)
    }
  }, [])
  const [isSending, setIsSending] = useState(false)
  const [loadingRemote, setLoadingRemote] = useState(REMOTE)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [tasks, setTasks] = useState<TaskItem[]>(() => (REMOTE ? [] : (initialSnapshot()?.tasks ?? [])))
  const [demoNextTasks] = useState<string[]>([
    'メールを一通だけ返す',
    '資料の目次だけ決める',
  ])
  const [completingId, setCompletingId] = useState<string | null>(null)
  const [showCheck, setShowCheck] = useState(false)
  const [lastSubmittedText, setLastSubmittedText] = useState<string | null>(() =>
    REMOTE ? loadLastSubmittedFromStorage() : (initialSnapshot()?.lastSubmittedText ?? null),
  )
  const [editingMainTitle, setEditingMainTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [mainMetaEditing, setMainMetaEditing] = useState<MainMetaField | null>(null)
  const [mainMetaDraft, setMainMetaDraft] = useState('')
  const [queueEditing, setQueueEditing] = useState<{ id: string; field: QueueEditField } | null>(null)
  const [queueDraft, setQueueDraft] = useState('')
  const [filterCategory, setFilterCategory] = useState<CategoryFilterValue>('all')
  const [filterTime, setFilterTime] = useState<TimeFilterValue>('all')
  /** キューから選んで青枠に出すタスク。null ならフィルター内で sort 最古をメインに */
  const [mainFocusTaskId, setMainFocusTaskId] = useState<string | null>(null)
  const [micAvailable, setMicAvailable] = useState(false)

  useEffect(() => {
    setMicAvailable(isSpeechRecognitionSupported())
  }, [])

  const speechDictation = useSpeechDictation(
    inputValue,
    setInputValue,
    isSending || loadingRemote,
    inputDraftRef,
  )

  const skipBlurCommit = useRef(false)
  const skipMainMetaBlur = useRef(false)
  const skipQueueBlur = useRef(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const mainMetaInputRef = useRef<HTMLInputElement>(null)
  const queueInputRef = useRef<HTMLInputElement>(null)
  const completeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tasksRef = useRef(tasks)
  const lastSubmittedRef = useRef(lastSubmittedText)
  /** メインカードでタイトル／メタを編集中に対象とするタスク id（並び≠先頭でも正しく保存する） */
  const mainInteractionTaskIdRef = useRef<string | null>(null)

  const closeAllEdits = useCallback(() => {
    mainInteractionTaskIdRef.current = null
    setEditingMainTitle(false)
    setMainMetaEditing(null)
    setQueueEditing(null)
  }, [])

  const filteredTasks = useMemo(
    () => tasksMatchingFiltersOrdered(tasks, filterCategory, filterTime),
    [tasks, filterCategory, filterTime],
  )

  const { displayCurrent, displayQueued } = useMemo(() => {
    if (filteredTasks.length === 0) {
      return { displayCurrent: undefined as TaskItem | undefined, displayQueued: [] as TaskItem[] }
    }
    const picked =
      mainFocusTaskId !== null ? filteredTasks.find((t) => t.id === mainFocusTaskId) : undefined
    if (picked) {
      return {
        displayCurrent: picked,
        displayQueued: filteredTasks.filter((t) => t.id !== mainFocusTaskId),
      }
    }
    return {
      displayCurrent: filteredTasks[0],
      displayQueued: filteredTasks.slice(1),
    }
  }, [filteredTasks, mainFocusTaskId])

  const filterNoMatch = tasks.length > 0 && filteredTasks.length === 0

  useEffect(() => {
    if (mainFocusTaskId === null) return
    if (!filteredTasks.some((t) => t.id === mainFocusTaskId)) {
      setMainFocusTaskId(null)
    }
  }, [filteredTasks, mainFocusTaskId])

  const focusQueueTaskInMain = useCallback(
    (id: string) => {
      if (completingId) return
      closeAllEdits()
      setMainFocusTaskId(id)
    },
    [completingId, closeAllEdits],
  )

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])
  useEffect(() => {
    lastSubmittedRef.current = lastSubmittedText
  }, [lastSubmittedText])

  const persistFallback = useCallback(() => {
    savePersisted(tasksRef.current, lastSubmittedRef.current)
  }, [])

  useEffect(() => {
    if (!REMOTE) savePersisted(tasks, lastSubmittedText)
  }, [tasks, lastSubmittedText])

  useEffect(() => {
    if (!REMOTE) return
    try {
      if (lastSubmittedText) localStorage.setItem(LAST_INPUT_KEY, lastSubmittedText)
      else localStorage.removeItem(LAST_INPUT_KEY)
    } catch {
      /* ignore */
    }
  }, [lastSubmittedText])

  useEffect(() => {
    if (!REMOTE) return
    const client = getSupabase()
    if (!client) return
    let cancelled = false
    void (async () => {
      setLoadingRemote(true)
      setSyncError(null)
      const { data, error } = await fetchTodoTasks(client)
      if (cancelled) return
      if (error) {
        setSyncError(`Supabase からの読み込みに失敗しました: ${error}`)
        const fb = loadPersisted()
        if (fb?.tasks.length) setTasks(fb.tasks)
      } else {
        setTasks(data)
        setMainFocusTaskId((fid) => (fid && data.some((t) => t.id === fid) ? fid : null))
      }
      setLoadingRemote(false)
    })()
    return () => {
      cancelled = true
    }
  }, [persistFallback])

  useEffect(() => {
    if (editingMainTitle) titleInputRef.current?.focus()
    else if (mainMetaEditing) mainMetaInputRef.current?.focus()
    else if (queueEditing) queueInputRef.current?.focus()
  }, [editingMainTitle, mainMetaEditing, queueEditing])

  const clearCompleteTimer = useCallback(() => {
    if (completeTimer.current) {
      clearTimeout(completeTimer.current)
      completeTimer.current = null
    }
  }, [])

  useEffect(() => () => clearCompleteTimer(), [clearCompleteTimer])

  const submitInput = () => {
    const text = (
      inputDraftRef.current ||
      inputValue ||
      taskInputRef.current?.value ||
      ''
    ).trim()
    if (!text || isSending) return
    setInputValue('')
    console.log(text)
    void (async () => {
      setIsSending(true)
      try {
        const raw = await runDifyWorkflow(text)
        const { main, next } = parseTasksFromWorkflowResult(raw)
        if (import.meta.env.DEV) {
          console.debug('[Dify] 送信した文と API の result', { 送信: text, result: raw, パース: { main, next } })
        }
        if (!main?.title.trim()) {
          console.warn('Dify: メインタスクが空です', raw)
          setSyncError(
            'タスクを生成できませんでした。Dify の応答形式（outputs.result）を確認してください。',
          )
          return
        }
        const newTasks = [fieldsToTask(main), ...next.map(fieldsToTask)]
        let tasksUpdatedAfterRemoteAppend = false
        if (REMOTE) {
          const client = getSupabase()
          if (client) {
            const msg = await appendTodoTasks(client, newTasks)
            if (msg) {
              setSyncError(`クラウドへの保存に失敗しました。ローカルに退避しました: ${msg}`)
              savePersisted([...tasksRef.current, ...newTasks], text)
            } else {
              setSyncError(null)
              const { data: refreshed, error: refetchErr } = await fetchTodoTasks(client)
              if (refetchErr) {
                setSyncError(`タスクは保存されましたが、一覧の再取得に失敗しました: ${refetchErr}`)
                setTasks((prev) => [...prev, ...newTasks])
              } else {
                setTasks(refreshed)
              }
              tasksUpdatedAfterRemoteAppend = true
            }
          }
        }
        setLastSubmittedText(text)
        setMainFocusTaskId(null)
        if (!tasksUpdatedAfterRemoteAppend) {
          setTasks((prev) => [...prev, ...newTasks])
        }
        closeAllEdits()
      } catch (e) {
        console.error(e)
        const msg =
          e instanceof Error
            ? e.message
            : '送信に失敗しました。Vercel の環境変数（VITE_DIFY_*）とブラウザの Console を確認してください。'
        setSyncError(msg)
      } finally {
        setIsSending(false)
      }
    })()
  }

  const completeCurrent = () => {
    if (!displayCurrent || completingId) return
    const idToComplete = displayCurrent.id
    clearCompleteTimer()
    setCompletingId(displayCurrent.id)
    setShowCheck(true)
    closeAllEdits()
    completeTimer.current = setTimeout(() => {
      void (async () => {
        if (REMOTE) {
          const client = getSupabase()
          if (client) {
            const msg = await markTaskCompleted(client, idToComplete)
            if (msg) {
              setSyncError(`完了状態の保存に失敗しました: ${msg}`)
              persistFallback()
              setCompletingId(null)
              setShowCheck(false)
              completeTimer.current = null
              return
            }
          }
        }
        setTasks((prev) => prev.filter((x) => x.id !== idToComplete))
        setMainFocusTaskId((fid) => (fid === idToComplete ? null : fid))
        setCompletingId(null)
        setShowCheck(false)
        completeTimer.current = null
      })()
    }, COMPLETE_MS)
  }

  const deferCurrent = () => {
    if (!displayCurrent || completingId) return
    const nInFilter = tasksMatchingFiltersOrdered(
      tasksRef.current,
      filterCategory,
      filterTime,
    ).length
    if (nInFilter < 2) return
    closeAllEdits()
    void (async () => {
      const prev = tasksRef.current
      const id = displayCurrent.id
      const idx = prev.findIndex((t) => t.id === id)
      if (idx < 0) return
      const item = prev[idx]
      const reordered = [...prev.slice(0, idx), ...prev.slice(idx + 1), item].map((t, i) => ({
        ...t,
        sort_order: i,
      }))
      if (REMOTE) {
        const client = getSupabase()
        if (client) {
          const msg = await persistSortOrders(client, reordered)
          if (msg) {
            setSyncError(`並び順の保存に失敗しました: ${msg}`)
            persistFallback()
            return
          }
        }
      }
      setTasks(reordered)
    })()
  }

  const startEditTitle = () => {
    if (!displayCurrent || completingId) return
    setMainMetaEditing(null)
    setQueueEditing(null)
    mainInteractionTaskIdRef.current = displayCurrent.id
    setTitleDraft(displayCurrent.title)
    setEditingMainTitle(true)
  }

  const commitTitleEdit = () => {
    const t = titleDraft.trim()
    const id = mainInteractionTaskIdRef.current
    mainInteractionTaskIdRef.current = null
    setEditingMainTitle(false)
    if (!t || !id) return
    setTasks((prev) => {
      const idx = prev.findIndex((c) => c.id === id)
      if (idx < 0) return prev
      const c = prev[idx]
      return [...prev.slice(0, idx), { ...c, title: t }, ...prev.slice(idx + 1)]
    })
    if (REMOTE) {
      void (async () => {
        const client = getSupabase()
        if (!client) return
        const msg = await updateTaskById(client, id, { title: t })
        if (msg) {
          setSyncError(`タイトルの保存に失敗しました: ${msg}`)
          persistFallback()
        }
      })()
    }
  }

  const cancelTitleEdit = () => {
    skipBlurCommit.current = true
    setEditingMainTitle(false)
    const id = mainInteractionTaskIdRef.current
    mainInteractionTaskIdRef.current = null
    const task = id ? tasksRef.current.find((x) => x.id === id) : undefined
    if (task) setTitleDraft(task.title)
  }

  const onTitleBlur = () => {
    if (skipBlurCommit.current) {
      skipBlurCommit.current = false
      return
    }
    commitTitleEdit()
  }

  const startMainMeta = (field: MainMetaField) => {
    if (!displayCurrent || completingId) return
    setEditingMainTitle(false)
    setQueueEditing(null)
    mainInteractionTaskIdRef.current = displayCurrent.id
    if (field === 'tags') {
      setMainMetaDraft('')
    } else {
      setMainMetaDraft(displayCurrent[field] ?? '')
    }
    setMainMetaEditing(field)
  }

  const commitMainMeta = () => {
    const field = mainMetaEditing
    const id = mainInteractionTaskIdRef.current
    if (!field || !id) {
      setMainMetaEditing(null)
      mainInteractionTaskIdRef.current = null
      return
    }
    const draftSnapshot = mainMetaDraft.trim()
    const base = tasksRef.current.find((x) => x.id === id)
    if (!base) {
      setMainMetaEditing(null)
      mainInteractionTaskIdRef.current = null
      return
    }
    setMainMetaEditing(null)
    mainInteractionTaskIdRef.current = null

    if (field === 'tags') {
      const additions = draftSnapshot
        .split(/[,、]/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (additions.length === 0) return
      const merged = [...(base.tags ?? [])]
      for (const a of additions) {
        if (!merged.includes(a)) merged.push(a)
      }
      setTasks((prev) => {
        const idx = prev.findIndex((c) => c.id === id)
        if (idx < 0) return prev
        const c = prev[idx]
        return [...prev.slice(0, idx), { ...c, tags: merged }, ...prev.slice(idx + 1)]
      })
      if (REMOTE) {
        void (async () => {
          const client = getSupabase()
          if (!client) return
          const msg = await updateTaskById(client, id, { tags: merged })
          if (msg) {
            setSyncError(`タグの保存に失敗しました: ${msg}`)
            persistFallback()
          }
        })()
      }
      return
    }

    setTasks((prev) => {
      const idx = prev.findIndex((c) => c.id === id)
      if (idx < 0) return prev
      const c = prev[idx]
      const next: TaskItem = { ...c }
      if (field === 'time') {
        if (draftSnapshot) next.time = draftSnapshot
        else delete next.time
      } else if (field === 'context') {
        if (draftSnapshot) next.context = draftSnapshot
        else delete next.context
      }
      return [...prev.slice(0, idx), next, ...prev.slice(idx + 1)]
    })
    if (REMOTE) {
      void (async () => {
        const client = getSupabase()
        if (!client) return
        const patch =
          field === 'time'
            ? { time: draftSnapshot ? draftSnapshot : null }
            : { context: draftSnapshot ? draftSnapshot : null }
        const msg = await updateTaskById(client, id, patch)
        if (msg) {
          setSyncError(`メモの保存に失敗しました: ${msg}`)
          persistFallback()
        }
      })()
    }
  }

  const cancelMainMeta = () => {
    skipMainMetaBlur.current = true
    setMainMetaEditing(null)
    mainInteractionTaskIdRef.current = null
  }

  const onMainMetaBlur = () => {
    if (skipMainMetaBlur.current) {
      skipMainMetaBlur.current = false
      return
    }
    commitMainMeta()
  }

  const startEditQueue = (id: string, field: QueueEditField, initial: string) => {
    if (completingId) return
    setEditingMainTitle(false)
    setMainMetaEditing(null)
    setQueueDraft(initial)
    setQueueEditing({ id, field })
  }

  const commitQueueEdit = () => {
    if (!queueEditing) return
    const { id, field } = queueEditing
    const raw = queueDraft.trim()
    if (field === 'title' && !raw) {
      setQueueEditing(null)
      return
    }
    if (field === 'tags') {
      const additions = raw
        .split(/[,、]/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (additions.length === 0) {
        setQueueEditing(null)
        return
      }
      setQueueEditing(null)
      const idxBase = tasksRef.current.findIndex((t) => t.id === id)
      const base = idxBase >= 0 ? tasksRef.current[idxBase] : undefined
      if (!base) return
      const mergedOut = [...(base.tags ?? [])]
      for (const a of additions) {
        if (!mergedOut.includes(a)) mergedOut.push(a)
      }
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === id)
        if (idx < 0) return prev
        const t = prev[idx]
        const updated: TaskItem = { ...t, tags: mergedOut }
        const next = [...prev]
        next[idx] = updated
        return next
      })
      if (REMOTE) {
        void (async () => {
          const client = getSupabase()
          if (!client) return
          const msg = await updateTaskById(client, id, { tags: mergedOut })
          if (msg) {
            setSyncError(`タグの保存に失敗しました: ${msg}`)
            persistFallback()
          }
        })()
      }
      return
    }
    setQueueEditing(null)
    const prev = tasksRef.current
    const idx = prev.findIndex((t) => t.id === id)
    if (idx < 0) return
    const t = prev[idx]
    const updated: TaskItem = { ...t }
    let remotePatch: Record<string, unknown> = {}
    if (field === 'title') {
      updated.title = raw
      remotePatch = { title: raw }
    } else if (field === 'time') {
      if (raw) updated.time = raw
      else delete updated.time
      remotePatch = { time: raw ? raw : null }
    } else if (field === 'context') {
      if (raw) updated.context = raw
      else delete updated.context
      remotePatch = { context: raw ? raw : null }
    }
    const next = [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)]
    setTasks(next)
    if (REMOTE) {
      void (async () => {
        const client = getSupabase()
        if (!client) return
        const msg = await updateTaskById(client, id, remotePatch)
        if (msg) {
          setSyncError(`タスクの保存に失敗しました: ${msg}`)
          persistFallback()
        }
      })()
    }
  }

  const cancelQueueEdit = () => {
    skipQueueBlur.current = true
    setQueueEditing(null)
  }

  const onQueueBlur = () => {
    if (skipQueueBlur.current) {
      skipQueueBlur.current = false
      return
    }
    if (queueEditing?.field === 'title' && !queueDraft.trim()) {
      setQueueEditing(null)
      return
    }
    commitQueueEdit()
  }

  const metaInputClass =
    'min-w-[4rem] max-w-[min(100%,20rem)] rounded-full border border-white/50 bg-white/20 px-2 py-1 text-center text-[10px] font-medium text-white outline-none ring-2 ring-white/35 placeholder:text-white/50 sm:text-xs'

  const queueInputClass = `flex-1 min-w-0 ${CARD_ROUND} border border-sky-200/60 bg-white/90 px-2 py-1 text-xs text-slate-700 outline-none ring-1 ring-sky-200/40`

  return (
    <div
      className={`font-sans relative flex min-h-svh flex-col bg-gradient-to-br from-[#F9FBFD] via-[#F4F8FB] to-[#FAFCFE] text-slate-600 antialiased ${FOOTER_BOTTOM_PAD}`}
    >
      <main className="mx-auto flex min-h-0 w-full max-w-[52rem] flex-1 flex-col px-5 sm:px-8">
        {syncError ? (
          <div
            className="mx-auto mt-3 flex w-full max-w-3xl items-start justify-between gap-3 rounded-2xl border border-amber-200/80 bg-amber-50/95 px-4 py-3 text-sm text-amber-950 shadow-sm backdrop-blur-sm sm:mt-4"
            role="alert"
          >
            <p className="min-w-0 flex-1 leading-relaxed">{syncError}</p>
            <button
              type="button"
              onClick={() => setSyncError(null)}
              className="shrink-0 rounded-full border border-amber-300/80 bg-white/80 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-white"
            >
              閉じる
            </button>
          </div>
        ) : null}
        {loadingRemote ? (
          <p className="shrink-0 pt-4 text-center text-sm text-slate-500 sm:pt-5">Supabase から読み込み中…</p>
        ) : (
          <p className="shrink-0 pt-4 text-center text-sm font-normal text-slate-400 sm:pt-5">いま、これだけ</p>
        )}

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center py-4 sm:py-6">
          <div className="flex w-[90%] max-w-3xl flex-col items-center gap-7 sm:gap-8 md:w-full">
            <div className="relative w-full">
              {completingId === displayCurrent?.id && (
                <>
                  <span
                    className={`animate-celebrate-ring pointer-events-none absolute inset-0 ${CARD_ROUND} border-2 border-white/35`}
                    aria-hidden
                  />
                  <span
                    className={`animate-celebrate-ring pointer-events-none absolute inset-0 ${CARD_ROUND} border-2 border-white/18 [animation-delay:110ms]`}
                    aria-hidden
                  />
                </>
              )}

              <div
                className={`relative flex aspect-video w-full flex-col items-center justify-center overflow-hidden ${CARD_ROUND} bg-gradient-to-br from-cyan-400 to-blue-600 px-6 py-10 shadow-[0_20px_50px_rgba(8,112,184,0.2)] ring-1 ring-white/30 sm:px-14 sm:py-12 md:px-20 md:py-16 ${
                  completingId === displayCurrent?.id ? 'animate-task-complete' : ''
                }`}
              >
                <div
                  className={`pointer-events-none absolute inset-0 ${CARD_ROUND} bg-gradient-to-br from-white/16 via-white/[0.05] to-blue-950/10 ring-1 ring-inset ring-white/25 backdrop-blur-sm`}
                  aria-hidden
                />
                <div
                  className="pointer-events-none absolute inset-0 bg-gradient-to-t from-blue-950/10 to-transparent"
                  aria-hidden
                />

                {showCheck && completingId === displayCurrent?.id && (
                  <div
                    className="pointer-events-none absolute right-7 top-7 text-white sm:right-9 sm:top-9"
                    aria-hidden
                  >
                    <svg
                      className="animate-check-draw drop-shadow-md"
                      width="44"
                      height="44"
                      viewBox="0 0 40 40"
                      fill="none"
                    >
                      <circle cx="20" cy="20" r="18" stroke="currentColor" strokeWidth="1.25" />
                      <path
                        d="M12 20.5l5 5 11-12"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                )}

                <div className="relative flex max-h-full w-full flex-col items-center justify-center overflow-y-auto overscroll-contain px-4 sm:px-8">
                  {filterNoMatch ? (
                    <p className="max-w-[92%] text-center text-2xl font-medium leading-snug tracking-tight text-white/95 sm:text-3xl md:text-4xl md:leading-tight">
                      {FILTER_NO_MATCH_MSG}
                    </p>
                  ) : displayCurrent ? (
                    <>
                      {lastSubmittedText ? (
                        <p className="mb-3 max-w-[95%] text-center text-xs font-normal leading-relaxed text-white/70 sm:mb-4 sm:text-sm">
                          分解のもと：{lastSubmittedText}
                        </p>
                      ) : null}

                      {editingMainTitle ? (
                        <input
                          ref={titleInputRef}
                          type="text"
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onBlur={onTitleBlur}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              commitTitleEdit()
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              cancelTitleEdit()
                            }
                          }}
                          aria-label="メインタスクのタイトルを編集"
                          className={`mb-3 max-w-[95%] w-full bg-white/15 text-center text-3xl font-medium leading-snug tracking-tight text-white outline-none ring-2 ring-white/40 placeholder:text-white/50 sm:text-4xl md:text-6xl md:leading-tight ${CARD_ROUND} px-3 py-2`}
                        />
                      ) : (
                        <p
                          role="button"
                          tabIndex={0}
                          onClick={startEditTitle}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              startEditTitle()
                            }
                          }}
                          className="max-w-[95%] cursor-text break-words text-center text-3xl font-medium leading-snug tracking-tight text-white decoration-white/40 underline-offset-4 sm:text-4xl md:text-6xl md:leading-tight hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/70"
                        >
                          {displayCurrent.title}
                        </p>
                      )}

                      <div className="mt-3 flex max-w-[95%] flex-wrap items-center justify-center gap-2 sm:mt-4">
                        {mainMetaEditing === 'time' ? (
                          <input
                            ref={mainMetaInputRef}
                            type="text"
                            value={mainMetaDraft}
                            onChange={(e) => setMainMetaDraft(e.target.value)}
                            onBlur={onMainMetaBlur}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitMainMeta()
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelMainMeta()
                              }
                            }}
                            placeholder="所要時間"
                            aria-label="時間を編集"
                            className={metaInputClass}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => startMainMeta('time')}
                            className="rounded-full border border-white/40 bg-white/18 px-2.5 py-1 text-[10px] font-medium tracking-wide text-white transition hover:bg-white/25 sm:text-xs"
                          >
                            {displayCurrent.time ? displayCurrent.time : '＋ 時間'}
                          </button>
                        )}

                        {mainMetaEditing === 'context' ? (
                          <input
                            ref={mainMetaInputRef}
                            type="text"
                            value={mainMetaDraft}
                            onChange={(e) => setMainMetaDraft(e.target.value)}
                            onBlur={onMainMetaBlur}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitMainMeta()
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelMainMeta()
                              }
                            }}
                            placeholder="例: 家の中、外出、PC、スマホ（Difyの値をそのまま）"
                            aria-label="コンテキスト（場所）を編集"
                            className={`${metaInputClass} max-w-[min(100%,22rem)]`}
                          />
                        ) : mainMetaEditing === 'tags' ? (
                          <input
                            ref={mainMetaInputRef}
                            type="text"
                            value={mainMetaDraft}
                            onChange={(e) => setMainMetaDraft(e.target.value)}
                            onBlur={onMainMetaBlur}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitMainMeta()
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelMainMeta()
                              }
                            }}
                            placeholder="追加するタグ（例: 重要、移動中）"
                            aria-label="メインにタグを追加"
                            className={`${metaInputClass} max-w-[min(100%,24rem)]`}
                          />
                        ) : (
                          <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
                            {taskCategoryBadgeLabel(displayCurrent) ? (
                              <span className={mainCategoryBadgeClass}>
                                {taskCategoryBadgeLabel(displayCurrent)}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => startMainMeta('tags')}
                              className={mainTagsChipClass}
                              aria-label="タグを編集"
                            >
                              {(displayCurrent.tags ?? []).length > 0
                                ? (displayCurrent.tags ?? []).join(' · ')
                                : '＋ タグ'}
                            </button>
                            <button
                              type="button"
                              onClick={() => startMainMeta('context')}
                              className="text-[10px] font-normal text-white/55 underline decoration-white/35 underline-offset-2 hover:text-white/80 sm:text-[11px]"
                              aria-label={
                                displayCurrent.context
                                  ? `場所（外出・PC 等）を編集: 現在 ${displayCurrent.context}`
                                  : '場所（外出・PC 等）を追加'
                              }
                            >
                              {displayCurrent.context ? '場所を編集' : '場所を追加'}
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="mt-7 flex flex-wrap items-center justify-center gap-3 sm:mt-9 md:mt-10">
                        <button
                          type="button"
                          onClick={completeCurrent}
                          disabled={!!completingId}
                          className="rounded-full border border-white/55 bg-white/96 px-8 py-2.5 text-sm font-medium text-blue-900/88 shadow-sm transition-[background-color,opacity] enabled:cursor-pointer enabled:hover:bg-white disabled:pointer-events-none disabled:opacity-45"
                        >
                          完了
                        </button>
                        <button
                          type="button"
                          onClick={deferCurrent}
                          disabled={!!completingId || filteredTasks.length < 2}
                          className="rounded-full border border-white/45 bg-white/12 px-8 py-2.5 text-sm font-medium text-white/95 shadow-sm backdrop-blur-sm transition-[background-color,opacity] enabled:cursor-pointer enabled:hover:bg-white/20 disabled:pointer-events-none disabled:opacity-40"
                        >
                          あとで
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="max-w-[92%] text-center text-2xl font-medium leading-snug tracking-tight text-white/95 sm:text-3xl md:text-5xl md:leading-tight">
                      {PLACEHOLDER_MAIN}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <section
              className="my-6 w-full space-y-2.5 sm:my-7 md:my-8"
              aria-label="次にやるタスク"
            >
              <p className="text-center text-[10px] font-normal tracking-[0.2em] text-slate-400">
                次にやる
              </p>
              {tasks.length > 0 && !filterNoMatch && displayQueued.length > 0 ? (
                <p className="text-center text-[10px] font-normal text-slate-400/90">
                  行をクリックで上のカードに表示（タイトルはダブルクリックで編集）
                </p>
              ) : null}
              {tasks.length === 0 ? (
                <ul className="space-y-2" aria-hidden>
                  {demoNextTasks.map((label, i) => (
                    <li
                      key={`demo-${i}-${label}`}
                      className={`${CARD_ROUND} border border-slate-200/50 bg-white/65 px-4 py-2.5 text-xs font-normal leading-relaxed text-slate-400 shadow-[0_4px_24px_-8px_rgba(15,23,42,0.06)] backdrop-blur-sm`}
                    >
                      <span className="mr-1.5 tabular-nums text-slate-400/65">{i + 1}</span>
                      {label}
                    </li>
                  ))}
                </ul>
              ) : filterNoMatch ? (
                <p
                  className={`${CARD_ROUND} border border-dashed border-slate-200/70 bg-white/55 px-4 py-3.5 text-center text-[11px] font-normal leading-relaxed text-slate-400 shadow-[0_4px_24px_-8px_rgba(15,23,42,0.05)] backdrop-blur-sm`}
                >
                  この条件に合う次のタスクはありません
                </p>
              ) : displayQueued.length === 0 ? (
                <p
                  className={`${CARD_ROUND} border border-dashed border-slate-200/70 bg-white/55 px-4 py-3.5 text-center text-[11px] font-normal leading-relaxed text-slate-400 shadow-[0_4px_24px_-8px_rgba(15,23,42,0.05)] backdrop-blur-sm`}
                >
                  キューに次のタスクはありません
                </p>
              ) : (
                <ul className="space-y-2">
                  {displayQueued.map((t, i) => (
                    <li
                      key={t.id}
                      onClick={(e) => {
                        if (completingId) return
                        if (queueEditing) return
                        if ((e.target as HTMLElement).closest('button, input, textarea, a')) return
                        focusQueueTaskInMain(t.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || completingId || queueEditing) return
                        if ((e.target as HTMLElement).closest('button, input, textarea')) return
                        e.preventDefault()
                        focusQueueTaskInMain(t.id)
                      }}
                      tabIndex={queueEditing ? -1 : 0}
                      aria-label={`${t.title}。クリックでメインに表示`}
                      className={`${CARD_ROUND} flex flex-col gap-1.5 border border-slate-200/50 bg-white/65 px-4 py-2.5 text-xs font-normal leading-relaxed text-slate-500 shadow-[0_4px_24px_-8px_rgba(15,23,42,0.06)] backdrop-blur-sm transition-[border-color,box-shadow] hover:border-sky-200/70 hover:shadow-[0_6px_28px_-10px_rgba(8,112,184,0.12)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400/80 ${completingId || queueEditing ? '' : 'cursor-pointer'}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="shrink-0 tabular-nums text-slate-400/75">{i + 1}</span>
                        {queueEditing?.id === t.id && queueEditing.field === 'title' ? (
                          <input
                            ref={queueInputRef}
                            type="text"
                            value={queueDraft}
                            onChange={(e) => setQueueDraft(e.target.value)}
                            onBlur={onQueueBlur}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitQueueEdit()
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelQueueEdit()
                              }
                            }}
                            aria-label={`タスク${i + 1}のタイトルを編集`}
                            className={queueInputClass}
                          />
                        ) : (
                          <span
                            onDoubleClick={(e) => {
                              e.stopPropagation()
                              startEditQueue(t.id, 'title', t.title)
                            }}
                            className="min-w-0 flex-1 cursor-pointer select-text text-left text-slate-600 underline decoration-transparent underline-offset-2 hover:decoration-slate-300"
                            title="ダブルクリックでタイトル編集"
                          >
                            {t.title}
                          </span>
                        )}
                        {queueEditing?.id === t.id && queueEditing.field === 'time' ? (
                          <input
                            ref={queueInputRef}
                            type="text"
                            value={queueDraft}
                            onChange={(e) => setQueueDraft(e.target.value)}
                            onBlur={onQueueBlur}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitQueueEdit()
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelQueueEdit()
                              }
                            }}
                            placeholder="時間"
                            aria-label={`タスク${i + 1}の時間を編集`}
                            className={`w-24 shrink-0 ${queueInputClass}`}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              startEditQueue(t.id, 'time', t.time ?? '')
                            }}
                            className="shrink-0 tabular-nums text-[10px] text-slate-400 underline decoration-slate-300/80 underline-offset-2 hover:text-slate-600"
                          >
                            {t.time ? t.time : '＋時間'}
                          </button>
                        )}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-5 sm:pl-6">
                        {queueEditing?.id === t.id && queueEditing.field === 'context' ? (
                          <input
                            ref={queueInputRef}
                            type="text"
                            value={queueDraft}
                            onChange={(e) => setQueueDraft(e.target.value)}
                            onBlur={onQueueBlur}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitQueueEdit()
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelQueueEdit()
                              }
                            }}
                            placeholder="例: 家の中、外出、PC、スマホ（Difyの値をそのまま）"
                            aria-label={`タスク${i + 1}のコンテキストを編集`}
                            className={`min-w-0 flex-1 basis-[min(100%,14rem)] ${queueInputClass}`}
                          />
                        ) : queueEditing?.id === t.id && queueEditing.field === 'tags' ? (
                          <input
                            ref={queueInputRef}
                            type="text"
                            value={queueDraft}
                            onChange={(e) => setQueueDraft(e.target.value)}
                            onBlur={onQueueBlur}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                commitQueueEdit()
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                cancelQueueEdit()
                              }
                            }}
                            placeholder="追加するタグ（例: 重要、移動中）"
                            aria-label={`タスク${i + 1}にタグを追加`}
                            className={`min-w-0 flex-1 basis-[min(100%,14rem)] ${queueInputClass}`}
                          />
                        ) : (
                          <>
                            {taskCategoryBadgeLabel(t) ? (
                              <span className={queueCategoryBadgeClass}>{taskCategoryBadgeLabel(t)}</span>
                            ) : null}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                startEditQueue(t.id, 'tags', '')
                              }}
                              className={queueTagsChipClass}
                              aria-label="タグを編集"
                            >
                              {(t.tags ?? []).length > 0 ? (t.tags ?? []).join(' · ') : '＋ タグ'}
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                startEditQueue(t.id, 'context', t.context ?? '')
                              }}
                              className="shrink-0 text-[10px] font-normal text-slate-400 underline decoration-slate-300/80 underline-offset-2 hover:text-slate-600 sm:text-[11px]"
                              aria-label={
                                t.context
                                  ? `場所を編集（現在: ${t.context}）`
                                  : '場所（外出・家の中 等）を追加'
                              }
                            >
                              {t.context ? '場所を編集' : '場所を追加'}
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </main>

      <footer className="fixed bottom-0 left-0 right-0 z-30 w-full border-t border-white/25 bg-white/35 px-4 py-4 pb-[max(1rem,calc(env(safe-area-inset-bottom,0px)+0.875rem))] pt-4 backdrop-blur-xl sm:px-8 sm:py-5 sm:pb-[max(1.125rem,calc(env(safe-area-inset-bottom,0px)+1rem))]">
        <form
          className="mx-auto flex w-full max-w-3xl items-center gap-2 sm:gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            submitInput()
          }}
        >
          <label htmlFor="task-input" className="sr-only">
            タスクを入力
          </label>
          <input
            ref={taskInputRef}
            id="task-input"
            type="text"
            autoComplete="off"
            placeholder="ざっくり入力…"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={isSending || loadingRemote}
            className={`min-w-0 flex-1 ${CARD_ROUND} border border-white/20 bg-white/40 px-4 py-4 text-[16px] font-normal leading-relaxed text-slate-600 outline-none ring-0 backdrop-blur-xl transition-[border-color,box-shadow,background-color] placeholder:text-slate-400/90 focus:border-sky-300/50 focus:bg-white/55 focus:shadow-[0_0_0_2px_rgba(186,230,253,0.45)] disabled:opacity-55 sm:px-5 sm:py-4 md:py-[1.125rem]`}
          />
          {micAvailable ? (
            <button
              type="button"
              {...speechDictation.micPointerHandlers}
              disabled={isSending || loadingRemote}
              aria-label={
                speechDictation.isListening
                  ? '音声入力を終了（タップ）または押し続けて入力'
                  : '音声入力を開始（タップ）または長押しで入力'
              }
              aria-pressed={speechDictation.isListening}
              title="タップで開始／終了。約0.3秒以上押し続けると離すまで入力します。"
              className={`flex h-12 w-12 shrink-0 touch-manipulation items-center justify-center ${CARD_ROUND} border shadow-[0_4px_20px_-6px_rgba(8,112,184,0.2)] backdrop-blur-xl transition-[background-color,box-shadow,opacity,border-color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300/60 disabled:pointer-events-none disabled:opacity-40 sm:h-[3.25rem] sm:w-[3.25rem] ${
                speechDictation.isListening
                  ? 'border-sky-400/80 bg-sky-100/90 text-sky-800 ring-2 ring-sky-400/50'
                  : 'border-white/35 bg-white/50 text-slate-600 hover:bg-white/65'
              }`}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z" />
                <path d="M19 11a7 7 0 0 1-14 0" />
                <path d="M12 18v3M8 21h8" />
              </svg>
            </button>
          ) : null}
          <button
            type="submit"
            aria-label={isSending ? '送信中' : '送信'}
            aria-busy={isSending}
            className={`flex h-12 w-12 shrink-0 items-center justify-center ${CARD_ROUND} border border-white/35 bg-white/50 text-sky-700/90 shadow-[0_4px_20px_-6px_rgba(8,112,184,0.25)] backdrop-blur-xl transition-[background-color,box-shadow,opacity] hover:bg-white/65 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300/60 disabled:pointer-events-none disabled:opacity-40 sm:h-[3.25rem] sm:w-[3.25rem]`}
            disabled={!inputValue.trim() || isSending || loadingRemote}
          >
            {isSending ? (
              <svg
                className="h-6 w-6 animate-spin text-sky-700/85"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                <path
                  className="opacity-90"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 12L20 4 12 20l-2-6-6-2z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </form>
        {speechDictation.speechError ? (
          <p
            className="mx-auto mt-1.5 w-full max-w-3xl px-1 text-center text-[12px] font-medium leading-snug text-rose-700/95 sm:text-[13px]"
            role="alert"
          >
            {speechDictation.speechError}
          </p>
        ) : null}
        {!loadingRemote ? (
          <div
            className="mx-auto mt-2 w-full max-w-3xl space-y-2 sm:mt-2.5"
            aria-label="カテゴリとスキマ時間でフィルター（AND）"
          >
            <div className="flex flex-wrap justify-center gap-1.5 sm:gap-2" role="group" aria-label="カテゴリ">
              <button type="button" onClick={() => setFilterCategory('all')} className={chipClass(filterCategory === 'all')}>
                All
              </button>
              <button type="button" onClick={() => setFilterCategory('仕事')} className={chipClass(filterCategory === '仕事')}>
                仕事
              </button>
              <button type="button" onClick={() => setFilterCategory('副業')} className={chipClass(filterCategory === '副業')}>
                副業
              </button>
              <button type="button" onClick={() => setFilterCategory('家事')} className={chipClass(filterCategory === '家事')}>
                家事
              </button>
              <button
                type="button"
                onClick={() => setFilterCategory('プライベート')}
                className={chipClass(filterCategory === 'プライベート')}
              >
                プライベート
              </button>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5 sm:gap-2" role="group" aria-label="スキマ時間">
              <button type="button" onClick={() => setFilterTime('all')} className={chipClass(filterTime === 'all')}>
                All
              </button>
              <button type="button" onClick={() => setFilterTime(15)} className={chipClass(filterTime === 15)}>
                15分
              </button>
              <button type="button" onClick={() => setFilterTime(30)} className={chipClass(filterTime === 30)}>
                30分
              </button>
              <button type="button" onClick={() => setFilterTime(60)} className={chipClass(filterTime === 60)}>
                60分
              </button>
            </div>
          </div>
        ) : null}
      </footer>
    </div>
  )
}
