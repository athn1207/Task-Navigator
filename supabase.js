/**
 * 実行ナビゲーター — Supabase 接続の下準備（次フェーズ用）
 *
 * 手順:
 * 1. `npm install @supabase/supabase-js`（未インストールの場合）
 * 2. `.env` に次を追加し、ダッシュボードの値を設定する
 *    - VITE_SUPABASE_URL … **Project URL のみ**（例: https://xxxx.supabase.co）。`/rest/v1` は付けない。
 *    - VITE_SUPABASE_ANON_KEY … anon public キー
 * 3. アプリからは `src/supabaseClient.ts` の `supabase` または `getSupabase()` を import する
 *
 * このファイルは環境変数名のメモ用です。Vite のバンドルには含まれません。
 */
export const SUPABASE_ENV_KEYS = {
  url: 'VITE_SUPABASE_URL',
  anonKey: 'VITE_SUPABASE_ANON_KEY',
}
