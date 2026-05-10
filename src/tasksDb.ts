/**
 * Supabase `tasks` テーブル想定:
 * - id uuid PK
 * - title text not null
 * - time text null
 * - context text null
 * - tags jsonb null（文字列の配列）
 * - category text null（例: 仕事 / 副業 / 家事 / プライベート）
 * - status text not null（'todo' | 'completed'）
 * - sort_order int not null
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { alignCategoryAndContextForDb } from './dify'
import type { TaskItem } from './taskTypes'

export type TaskRow = {
  id: string
  title: string
  time: string | null
  context: string | null
  tags: unknown
  category: string | null
  status: string
  sort_order: number
}

function normalizeTags(raw: unknown): string[] | undefined {
  if (raw == null) return undefined
  if (Array.isArray(raw)) {
    const t = raw.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
    return t.length ? t : undefined
  }
  return undefined
}

export function rowToTaskItem(row: TaskRow): TaskItem {
  const tags = normalizeTags(row.tags)
  const { category, context } = alignCategoryAndContextForDb(
    row.category ?? undefined,
    row.context ?? undefined,
  )
  return {
    id: row.id,
    title: row.title,
    sort_order: row.sort_order,
    ...(row.time ? { time: row.time } : {}),
    ...(context ? { context } : {}),
    ...(tags ? { tags } : {}),
    ...(category ? { category } : {}),
  }
}

export function taskItemToInsertRow(t: TaskItem, sortOrder: number) {
  return {
    id: t.id,
    title: t.title,
    time: t.time ?? null,
    context: t.context ?? null,
    tags: t.tags ?? null,
    category: t.category ?? null,
    status: 'todo' as const,
    sort_order: sortOrder,
  }
}

export async function fetchTodoTasks(client: SupabaseClient): Promise<{ data: TaskItem[]; error: string | null }> {
  const { data, error } = await client
    .from('tasks')
    .select('id,title,time,context,tags,category,status,sort_order')
    .eq('status', 'todo')
    .order('sort_order', { ascending: true })

  if (error) return { data: [], error: error.message }
  const rows = (data ?? []) as TaskRow[]
  return { data: rows.map(rowToTaskItem), error: null }
}

/** 既存の todo をすべて消してから差し替え */
export async function replaceTodoTasks(client: SupabaseClient, items: TaskItem[]): Promise<string | null> {
  const { error: delErr } = await client.from('tasks').delete().eq('status', 'todo')
  if (delErr) return delErr.message
  if (items.length === 0) return null
  const rows = items.map((t, i) => taskItemToInsertRow(t, i))
  const { error: insErr } = await client.from('tasks').insert(rows)
  return insErr?.message ?? null
}

/** 既存 todo は残したまま末尾に追加（sort_order は現在の todo の最大値の次から連番） */
export async function appendTodoTasks(client: SupabaseClient, items: TaskItem[]): Promise<string | null> {
  if (items.length === 0) return null
  const { data: maxRows, error: maxErr } = await client
    .from('tasks')
    .select('sort_order')
    .eq('status', 'todo')
    .order('sort_order', { ascending: false })
    .limit(1)
  if (maxErr) return maxErr.message
  const rawMax = maxRows?.[0]?.sort_order
  const maxSo =
    typeof rawMax === 'number'
      ? rawMax
      : typeof rawMax === 'string'
        ? Number.parseFloat(rawMax)
        : Number.NaN
  const start = Number.isFinite(maxSo) ? maxSo + 1 : 0
  const rows = items.map((t, i) => taskItemToInsertRow(t, start + i))
  const { error: insErr } = await client.from('tasks').insert(rows)
  return insErr?.message ?? null
}

export async function updateTaskById(
  client: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  const { error } = await client.from('tasks').update(patch).eq('id', id)
  return error?.message ?? null
}

export async function markTaskCompleted(client: SupabaseClient, id: string): Promise<string | null> {
  const { error } = await client.from('tasks').update({ status: 'completed' }).eq('id', id)
  return error?.message ?? null
}

export async function persistSortOrders(client: SupabaseClient, ordered: TaskItem[]): Promise<string | null> {
  const results = await Promise.all(
    ordered.map((t, i) => client.from('tasks').update({ sort_order: i }).eq('id', t.id)),
  )
  const firstErr = results.find((r) => r.error)?.error
  return firstErr?.message ?? null
}
