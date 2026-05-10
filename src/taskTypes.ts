export type TaskItem = {
  id: string
  title: string
  time?: string
  /** Dify 判定の場所ラベル（例: 家の中 / 外出 / PC / スマホ）。そのまま表示する */
  context?: string
  tags?: string[]
  /** 仕事 / 副業 / 家事 / プライベート など（Dify・DB から） */
  category?: string
  /** Supabase の並び。未設定時は一覧上の出現順で代用 */
  sort_order?: number
}
