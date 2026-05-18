/**
 * ビルド前チェック: Vite はビルド時に VITE_* を JS に埋め込む。
 * Vercel で環境変数未設定のままデプロイすると、実行時だけ「キーがない」エラーになる。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const envPath = join(root, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 1) continue
    const key = t.slice(0, i).trim()
    const val = t.slice(i + 1).trim()
    if (key && process.env[key] === undefined) process.env[key] = val
  }
}

const required = ['VITE_DIFY_API_KEY', 'VITE_DIFY_API_URL']

const missing = []
const placeholder = []

for (const name of required) {
  const v = (process.env[name] ?? '').trim()
  if (!v) missing.push(name)
  else if (v.includes('ここにコピー')) placeholder.push(name)
}

if (missing.length || placeholder.length) {
  console.error('\n[verify-env] ビルドに必要な環境変数がありません。\n')
  if (missing.length) {
    console.error('  未設定:', missing.join(', '))
  }
  if (placeholder.length) {
    console.error('  プレースホルダのまま:', placeholder.join(', '))
  }
  console.error(`
  ローカル: プロジェクト直下の .env を確認
  Vercel:   Settings → Environment Variables → Production に追加
            → Deployments → Redeploy（Build Cache はオフ推奨）
`)
  process.exit(1)
}

console.log('[verify-env] OK:', required.join(', '))
