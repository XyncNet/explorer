import {defineConfig, loadEnv} from "vite";

// Dev-прокси на api-сервисы валидаторов. Так браузер ходит на same-origin
// (/n1../n4), а Vite проксирует на ноду — CORS не нужен, БЭКЕНД НЕ ТРОГАЕМ.
// Схема портов run_local.py: api = 7000 + 100*vid + 5  (v1=7105, v2=7205 …).
// Прод-ноду можно указать в .env: VITE_N1=https://api.xync.net и т.д.
export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), "");
  const node = (vid: number) => env[`VITE_N${vid}`] || `http://127.0.0.1:${7000 + 100 * vid + 5}`;
  const proxy: Record<string, any> = {};
  for (let vid = 1; vid <= 4; vid++) {
    proxy[`/n${vid}`] = {
      target: node(vid),
      changeOrigin: true,
      ws: true,
      rewrite: (p: string) => p.replace(new RegExp(`^/n${vid}`), ""),
    };
  }
  return {
    // База для GitHub Pages: '/' для кастомного домена/user-страницы,
    // '/<repo>/' для project-страницы (задаётся env BASE_PATH в CI).
    base: process.env.BASE_PATH || "/",
    server: {port: 5280, proxy},
    preview: {port: 5280, proxy},
    build: {target: "es2022"},
  };
});
