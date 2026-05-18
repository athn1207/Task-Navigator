import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  server: {
    // PC の localhost はスマホからは見えない。LAN IP で待ち受ける
    host: true,
    // basicSsl により https:// で起動（スマホ Chrome のマイク利用に必須）
  },
})
