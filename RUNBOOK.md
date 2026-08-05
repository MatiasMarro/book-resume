# RUNBOOK — levantar y probar Lector en local

Guía operativa: qué correr, en qué orden, y qué tenés que ver en cada paso.

Este archivo es **solo operativo**. El contexto del producto, las reglas, el estado del
proyecto y las convenciones están en `CLAUDE.md`. La estrategia de LLM, en `docs/LLM.md`.

---

## 0. Requisitos

```bash
node -v    # necesita >= 20.19.0
npm -v
```

> **Nota sobre Node 20.** El proyecto está fijado para correr en Node 20.19: `wrangler`
> está pineado a `~4.86.0`, `jsdom` a `^29` (vía `overrides` en el package.json raíz) y
> `compatibility_date` a `2026-05-03`. Node 20 ya es EOL. Si pasás a Node 22 LTS podés
> soltar las tres restricciones juntas — ver "Al pasar a Node 22" al final.

---

## 1. Instalación (una sola vez)

Desde la raíz del repo:

```bash
npm install
```

Instala los tres workspaces (`apps/web`, `apps/api`, `packages/shared`) de una.
Van a aparecer warnings de `EBADENGINE` — son de dependencias transitivas que piden
Node 22 y no se usan en runtime. No rompen nada.

---

## 2. Verificar que todo está sano antes de tocar nada

Estos tres comandos son el semáforo del repo. Corrélos ahora y después de cada cambio:

```bash
npm test          # 138 tests: 125 en api, 2 en web, 11 en shared
npm run typecheck # los 3 workspaces, sin errores
npm run build     # build de producción de la PWA
```

**Qué tenés que ver:**

- `npm test` → tres bloques `Test Files N passed`, ninguno en rojo. En api aparece además
  `1 skipped`: es `sources.live.test.ts`, que solo corre con `LECTOR_LIVE=1` (paso 2b).
- `npm run typecheck` → salida vacía (no news, good news)
- `npm run build` → un resumen de Vite y abajo `PWA v1.3.0` con `dist/sw.js` y
  `dist/manifest.webmanifest` generados

---

## 2b. Tests contra las APIs reales

Los fixtures se congelan; las APIs no. Hay una suite aparte que pega contra Open Library,
Google Books y Wikipedia de verdad:

```bash
LECTOR_LIVE=1 npm test -w @lector/api
```

Es lenta y puede fallar por red. Corréla cuando:

- cargues `GOOGLE_BOOKS_KEY` — es lo único que valida ese normalizador
- un test de fixtures se rompa y quieras saber si la API cambió de forma
- vuelvas a tocar la cascada

---

## 3. Levantar la PWA

```bash
npm run dev:web
```

Abrí **http://localhost:5173** → pantalla negra con "Lector" centrado.

- Hot reload activo: tocá `apps/web/src/App.tsx` y se actualiza sola.
- El service worker **no** corre en `dev` (está desactivado a propósito). Para probar
  la PWA instalable de verdad hace falta el build de producción — ver paso 6.

---

## 4. Levantar el Worker

En **otra terminal** (el paso 3 bloquea la suya):

```bash
npm run dev:api
```

Escucha en **http://localhost:8787**. Probalo:

```bash
curl http://localhost:8787/health
# {"ok":true}
```

Al arrancar, wrangler imprime la tabla de bindings. Tenés que ver:

```
Using secrets defined in .dev.vars
env.DB (lector-db)                         D1 Database               local
env.LLM_ENABLED ("(hidden)")               Environment Variable      local
env.LLM_PROVIDER ("(hidden)")              Environment Variable      local
env.LLM_MODEL ("(hidden)")                 Environment Variable      local
env.LLM_PROVIDER_TAIL ("(hidden)")         Environment Variable      local
env.LLM_MODEL_TAIL ("(hidden)")            Environment Variable      local
env.GOOGLE_BOOKS_KEY ("(hidden)")          Environment Variable      local
env.OPENAI_API_KEY ("(hidden)")            Environment Variable      local
env.GOOGLE_AI_STUDIO_KEY ("(hidden)")      Environment Variable      local
```

Dos cosas que confirmar en esa salida:

- **`Using secrets defined in .dev.vars`** en la primera línea. Si no aparece, wrangler no
  encontró el archivo — tiene que estar en `apps/api/.dev.vars`, no en la raíz.
- Los valores salen como `(hidden)` a propósito: wrangler enmascara todo lo que venga de
  `.dev.vars` para que no termine en un log o un screenshot. Si ves los valores en claro,
  es que el `.dev.vars` no se está cargando y esas vars vienen del `[vars]` de
  `wrangler.toml`.

Como los valores están ocultos, para chequear el proveedor mirá el archivo:

```bash
grep LLM_PROVIDER apps/api/.dev.vars
```

Si `LLM_PROVIDER` no dice `fixture`, pará: en desarrollo nunca querés pegarle a un
proveedor pago (`docs/LLM.md`, "Modo fixture").

---

## 5. Base de datos local (D1)

El binding `DB` ya existe, pero las tablas no hasta que apliques las migraciones.
La base local vive en `apps/api/.wrangler/` y está gitignoreada.

```bash
npm run db:migrate:local -w @lector/api
```

**Qué tenés que ver:** `0001_init.sql ✅` y `4 commands executed successfully`.

Comprobá las tablas:

```bash
cd apps/api
npx wrangler d1 execute lector-db --local \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name"
```

Tienen que salir `books`, `enrichments` y `scan_events`.

Para inspeccionar datos más adelante, mismo comando cambiando el `--command`:

```bash
npx wrangler d1 execute lector-db --local --command "SELECT COUNT(*) FROM books"
```

**Para empezar de cero:** borrá `apps/api/.wrangler/` y volvé a aplicar las migraciones.

---

## 6. Probar la PWA como PWA (build de producción)

El service worker y el manifest solo existen en el build:

```bash
npm run build
npm run preview -w @lector/web
```

Abrí la URL que imprime (por defecto **http://localhost:4173**) y en DevTools:

- **Application → Manifest** → tiene que listar "Lector"
- **Application → Service Workers** → uno activado
- **Network → Offline** + recargar → la app sigue apareciendo (offline shell)

---

## 7. Secrets locales

Los dos archivos **ya están creados**, con las claves vacías listas para completar.
Para arrancar el Worker no hace falta ninguna: con `LLM_PROVIDER=fixture` no se llama a
ningún proveedor de LLM.

> ⚠️ **`GOOGLE_BOOKS_KEY` sí hace falta para que la cascada funcione de verdad.**
> `books.googleapis.com` devuelve 429 a toda request sin key — el cupo anónimo es cero
> (`quota_limit_value: 0`). Sin ella, `GET /api/book/:isbn13` resuelve solo con Open
> Library y Wikipedia, y la cobertura cae al 50%. Es el bloqueante del go/no-go de la
> Fase 1 — ver "Estado actual" en `CLAUDE.md`.

| Archivo | Lo lee | Cuándo |
|---|---|---|
| `apps/api/.dev.vars` | `wrangler dev`, solo | El Worker en local |
| `.env` (raíz) | `node --env-file=.env scripts/...` | Los scripts de Node de `scripts/` |

Los dos están gitignoreados — verificado con `git check-ignore`. Completá las keys y listo:

```bash
# el Worker en local
apps/api/.dev.vars     → GOOGLE_BOOKS_KEY, OPENAI_API_KEY, GOOGLE_AI_STUDIO_KEY

# los scripts de precarga / spike / golden set
.env                   → las mismas tres
```

Sí, están duplicadas. Es a propósito: son dos runtimes distintos y wrangler no lee el
`.env` de la raíz. `.env.example` queda como la plantilla versionada de ambos.

**Nunca crees `apps/web/.env`.** Vite inlinea en el bundle todo lo que empiece con
`VITE_`, y el resto ni siquiera llega al browser — cualquier key ahí termina publicada o
no sirve. El cliente no necesita ninguna: nunca habla con un proveedor de LLM
(`CLAUDE.md`, "Convenciones de código").

**Regla dura:** las API keys nunca van en `wrangler.toml` ni en el cliente. En producción
son secrets de wrangler (paso 9).

---

## 8. Loop de trabajo diario

```bash
# terminal 1
npm run dev:web

# terminal 2
npm run dev:api

# terminal 3 — tests en watch del workspace que estés tocando
npm run test:watch -w @lector/web
npm run test:watch -w @lector/api
npm run test:watch -w @lector/shared
```

Antes de commitear:

```bash
npm test && npm run typecheck && npm run build
```

---

## 9. Deploy real (todavía no hace falta)

Estos pasos requieren cuenta de Cloudflare y `wrangler login`. **No están probados
en este repo** — quedan documentados para cuando toque.

```bash
cd apps/api
npx wrangler login

# 1. crear la base — imprime el database_id real
npm run db:create -w @lector/api

# 2. pegar ese id en apps/api/wrangler.toml, reemplazando REEMPLAZAR_CON_EL_ID_REAL

# 3. migrar la base remota
npm run db:migrate:remote -w @lector/api

# 4. cargar los secrets (uno por uno, pide el valor por stdin)
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_BOOKS_KEY
npx wrangler secret put GOOGLE_AI_STUDIO_KEY

# 5. deploy
npm run deploy -w @lector/api
```

Antes del primer deploy real, acordate de sobreescribir `LLM_PROVIDER` para producción
con un bloque `[env.production.vars]` — el default del `wrangler.toml` es `fixture`.

Para ver qué se subiría sin subir nada:

```bash
npx wrangler deploy --dry-run
```

---

## 10. Referencia de comandos por workspace

| Qué | Comando |
|---|---|
| Dev PWA | `npm run dev:web` |
| Dev Worker | `npm run dev:api` |
| Tests (todos) | `npm test` |
| Tests de uno | `npm test -w @lector/web` (o `@lector/api`, `@lector/shared`) |
| Tests en watch | `npm run test:watch -w @lector/web` |
| Tests contra APIs reales | `LECTOR_LIVE=1 npm test -w @lector/api` |
| Typecheck (todos) | `npm run typecheck` |
| Build PWA | `npm run build` |
| Preview del build | `npm run preview -w @lector/web` |
| Migrar D1 local | `npm run db:migrate:local -w @lector/api` |
| Migrar D1 remota | `npm run db:migrate:remote -w @lector/api` |
| Crear D1 | `npm run db:create -w @lector/api` |

---

## 11. Cuando algo falla

**`Wrangler requires at least Node.js v22.0.0`**
Se te actualizó wrangler más allá de `4.86.x`. O volvés a pinearlo, o pasás a Node 22.

**`This Worker requires compatibility date "X", but the newest date supported by this
server binary is "Y"`**
El `compatibility_date` de `wrangler.toml` es más nuevo que el runtime que trae tu
wrangler. Bajá la fecha o subí wrangler (que necesita Node 22).

**`webidl.util.markAsUncloneable is not a function` al correr los tests de web**
Se coló jsdom 30, que necesita Node 22. Verificá con
`node -p "require('./node_modules/jsdom/package.json').version"` — tiene que decir 29.x.
Si dice 30, ver el punto siguiente.

**Cambiaste `overrides` en el package.json raíz y no pasó nada**
npm no reaplica un `overrides` nuevo sobre un árbol ya instalado. Hay que forzarlo:

```bash
rm -rf node_modules package-lock.json apps/*/node_modules packages/*/node_modules
npm install
```

**`curl http://127.0.0.1:5173` no responde pero el navegador sí**
Vite escucha en `localhost` (IPv6) por defecto. Usá `http://localhost:5173` o levantalo
con `npm run dev:web -- --host 127.0.0.1`.

**El puerto está ocupado**

```bash
npm run dev:web -- --port 5174
npm run dev:api -- --port 8788
```

Los scripts `dev:web` y `dev:api` de la raíz terminan en `--` justamente para que esto
funcione. Si alguna vez le sacás ese `--`, npm se come los flags y arranca en el puerto
que se le canta: vas a ver `> vite 5174` (sin `--port`) en el log en vez de
`> vite --port 5174`.

**Un dev server quedó colgado ocupando el puerto**

En PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 5173 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## Al pasar a Node 22

Las tres restricciones se sueltan juntas, en un solo commit:

1. `apps/api/package.json` → `"wrangler": "^4.119.0"`
2. `apps/api/wrangler.toml` → subir `compatibility_date` a la fecha del día
3. `package.json` raíz → borrar el bloque `"overrides"`, y en `apps/web/package.json`
   subir `"jsdom": "^30.0.1"`

Después: reinstalación limpia (ver punto 11) y `npm test && npm run typecheck && npm run build`.

---

## Estado del proyecto

Vive en `CLAUDE.md`, sección **"Estado actual"** — qué fase está cerrada, qué anda hoy y
qué falta. Una sola fuente de verdad, para que no se contradigan.
