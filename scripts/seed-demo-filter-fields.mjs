/**
 * Supabase の status=todo に category / time を手入力と同様にセットする検証用スクリプト。
 * 実行: プロジェクトルートで node scripts/seed-demo-filter-fields.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

function loadEnv() {
  const raw = readFileSync(join(root, '.env'), 'utf8')
  const out = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

const env = loadEnv()
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY
if (!url || !key) {
  console.error('.env に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY がありません。')
  process.exit(1)
}

const supabase = createClient(url, key)

const { error: probeErr } = await supabase.from('tasks').select('category').limit(1)
if (probeErr && /category/i.test(probeErr.message)) {
  console.error(`
[要対応] tasks テーブルに category 列がありません（API のスキーマに存在しません）。

次を Supabase ダッシュボード → SQL Editor で実行してから、もう一度このスクリプトを実行してください。
  ファイル: scripts/add-category-column.sql

  alter table public.tasks add column if not exists category text;
`)
  process.exit(2)
}

const patches = [
  { category: '仕事', time: '15分' },
  { category: '副業', time: '30分' },
  { category: 'プライベート', time: '60分' },
]

const demos = [
  { title: 'デモ：仕事 15分タスク', time: '15分', category: '仕事' },
  { title: 'デモ：副業 30分タスク', time: '30分', category: '副業' },
  { title: 'デモ：プライベート 60分タスク', time: '60分', category: 'プライベート' },
]

async function main() {
  const { data: rows, error: selErr } = await supabase
    .from('tasks')
    .select('id,sort_order')
    .eq('status', 'todo')
    .order('sort_order', { ascending: true })

  if (selErr) {
    console.error('読み込みエラー:', selErr.message)
    process.exit(1)
  }

  const list = rows ?? []

  if (list.length === 0) {
    const startOrder = 0
    for (let i = 0; i < demos.length; i++) {
      const d = demos[i]
      const { error: insErr } = await supabase.from('tasks').insert({
        id: randomUUID(),
        title: d.title,
        time: d.time,
        category: d.category,
        status: 'todo',
        sort_order: startOrder + i,
      })
      if (insErr) {
        console.error('挿入エラー:', insErr.message)
        process.exit(1)
      }
    }
    console.log(`todo が 0 件だったため、デモ行を ${demos.length} 件追加しました。`)
    return
  }

  const n = Math.min(list.length, patches.length)
  for (let i = 0; i < n; i++) {
    const { error: upErr } = await supabase.from('tasks').update(patches[i]).eq('id', list[i].id)
    if (upErr) {
      console.error(`更新エラー (id ${list[i].id}):`, upErr.message)
      process.exit(1)
    }
  }

  console.log(`既存の todo 先頭 ${n} 件に category / time を設定しました（全 ${list.length} 件中）。`)
  if (list.length < patches.length) {
    console.log(
      `※ 検証用の ${patches.length} パターンすべてを試すには、あと ${patches.length - list.length} 件以上 todo を用意するか、このスクリプトを複数タスクがある状態でもう一度読み込んでください。`,
    )
  }
}

await main()
