-- Supabase Dashboard → SQL Editor で 1 回実行してください。
-- アプリ・seed スクリプトが tasks.category を読み書きするために必要です。

alter table public.tasks add column if not exists category text;
