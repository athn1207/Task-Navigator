import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Supabase ダッシュボードの「Project URL」は
 *   https://xxxxxxxx.supabase.co
 * の形だけを .env に書いてください。
 * 末尾に /rest/v1 を付けた値をコピーしていると「Invalid path specified in request URL」になりやすいので除去します。
 */
function normalizeSupabaseUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '')
  if (!u) return ''
  const low = u.toLowerCase()
  if (low.endsWith('/rest/v1')) {
    u = u.slice(0, -'/rest/v1'.length).replace(/\/+$/, '')
  }
  return u
}

function isValidHttpUrl(s: string): boolean {
  try {
    const parsed = new URL(s)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

const rawUrl = import.meta.env.VITE_SUPABASE_URL ?? ''
const rawKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

const supabaseUrl = normalizeSupabaseUrl(String(rawUrl))
const supabaseAnonKey = String(rawKey).trim()

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey && isValidHttpUrl(supabaseUrl))
}

/** 未設定時は null */
export const supabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null

export function getSupabase(): SupabaseClient | null {
  return supabase
}
