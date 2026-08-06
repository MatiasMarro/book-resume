# CLAUDE.md — Contexto permanente del proyecto

> Claude Code lee este archivo en cada sesión. No lo borres. Actualizalo cuando una
> decisión cambie — sobre todo la sección "Estado actual".

---

## Qué estamos construyendo

**Lector.** Una PWA que se usa **parada en el pasillo de una librería, con el libro en
la mano**. Escaneás el código de barras y en menos de 5 segundos tenés:

1. De qué trata — **sin spoilers**
2. Qué tipo de libro es (género + factores de apelación)
3. Un puntaje de compatibilidad con tu perfil, **con explicación**

El perfil se arma en un onboarding de menos de 90 segundos, vive en `localStorage` y se
refina con cada escaneo. Sin cuentas, sin login, sin PII en el servidor.

**Restricción dura: USD 10 de infraestructura, total.** Toda decisión técnica se evalúa
contra eso. Si una opción cuesta plata por request, está mal.

---

## Flujo de trabajo (OBLIGATORIO ante cualquier objetivo de desarrollo)

Actuar como **ingeniero senior de TypeScript, PWA y edge computing**, con criterio de
producto.

### 1. Analizar antes de codear
- Leer los módulos relacionados al objetivo, no solo el archivo que se toca. La cascada,
  el merge y los schemas compartidos están acoplados por diseño.
- Si algo del objetivo no se entiende, o hay una decisión de diseño abierta:
  **PREGUNTAR, no inventar.**

### 2. Una fase por vez
- El orden está en `PLAN.md`. No adelantar trabajo de fases posteriores.
- No empezar la fase N+1 sin verificar a mano el criterio de aceptación de la N.

### 3. Proponer el enfoque y esperar el OK
- Antes de escribir código: qué se toca, qué se agrega, qué se rompe.
- **No codear hasta que el usuario apruebe.** El usuario decide el alcance.
- Si el análisis muestra que conviene refactorizar, proponerlo — no hacerlo por cuenta
  propia.

### 4. Al cerrar la tarea
```bash
npm test && npm run typecheck
```
- Reportar la **salida real**. Si algo falla, decirlo con el output. Nunca "debería andar".
- Dejar un **texto de commit de menos de dos renglones** para copiar. El commit lo hace
  siempre el usuario.

### 5. Frenar y preguntar
Si la tarea parece requerir scraping, plata, un servicio nuevo, o romper una de las 6
reglas de abajo: **pará y avisá**. Siempre hay otro camino.

### Reglas de escritura
- **Español rioplatense en la UI**: "Escaneá", "elegí", "guardá".
- Código y comentarios en español, como el resto del repo.
- No refactorizar código ajeno al objetivo. Borrar lo que quede huérfano por el cambio
  (imports, helpers, tipos muertos).
- Ser concreto. Sin explayarse de más.

---

## Las 6 reglas que no se rompen

### 1 · El código de barras es el camino principal, no el OCR
El libro está en la mano; darlo vuelta cuesta 2 segundos.
`L0` EAN-13→ISBN (~99%, $0, ~80% de los casos) · `L1` OCR (~65%, $0) · `L2` LLM multimodal
(~85%, $$). Nunca L1 antes de que L0 funcione; nunca L2 sin rate limit duro por
dispositivo. → `lib/isbn.ts`

### 2 · El LLM se llama UNA VEZ POR LIBRO, JAMÁS POR USUARIO
Pilar de todo el presupuesto.

```
escaneo → ISBN → ¿caché D1?  SÍ → devolver ($0, <100ms)      ← 95%+ de los casos
                             NO → APIs gratis → LLM → GUARDAR → devolver
```

El enriquecimiento es **inmutable y global**: no depende del usuario. El score
personalizado se calcula **en el cliente**. Si escribís código donde el LLM ve datos del
usuario, pará y repensá. → `db/books.ts`, `routes/book.ts`

### 3 · "Sin spoilers" es curaduría de fuentes, no un prompt
Poner "no spoilers" en el prompt **no funciona**: se resuelve controlando qué entra al
contexto.

- **Permitido:** `description` de Google Books (contratapa del editor) · subjects/BISAC ·
  páginas, año, editorial, idioma · **solo el primer párrafo** del extracto de Wikipedia.
- **Prohibido, filtrar antes del prompt:** secciones de Wikipedia
  `Argumento|Trama|Sinopsis|Plot|Resumen|Desenlace|Final|Personajes` · reseñas de usuarios ·
  cualquier cosa de Goodreads o Amazon.

El resumen cubre **solo el planteo**: premisa, protagonista, conflicto inicial, tono,
comparables. Nunca el punto medio ni el desenlace.

Corolario ya implementado: **las descripciones nunca se concatenan** — viajan separadas
con su procedencia (`DescriptionCandidate`), porque cada fuente se filtra distinto.
→ `sources/types.ts`, `resolver/merge.ts`, `llm/sanitize.ts`, `llm/spoilerGuard.ts`

### 4 · El matching es por factores de apelación, no por género
*Reader's advisory* de Joyce Saricks: el género es un predictor pésimo — quien ama
*Ficciones* y quien ama *Dune* comparten estante y nada más.

14 dimensiones `0.0`–`1.0`. **Fuente de verdad: `packages/shared/src/appeal-vector.ts`** —
no las copies acá ni en ningún prompt. Score = coseno ponderado + filtros duros por
`avoids`, **calculado en el cliente**: $0, determinístico, explicable.

### 5 · El puntaje SIEMPRE viene con razones
Nunca un número solo. Las razones salen de comparar dimensiones individuales, **no del
LLM**:

```
82% · Alta compatibilidad
  ✓ Ritmo pausado y foco en personajes, como Stoner
  ⚠ 640 páginas — más largo que tu promedio
  ✗ Contiene maltrato animal (marcado como evitar)
```

### 6 · Fuentes de datos: solo APIs públicas y legales
**Usar:** Open Library, Google Books, Wikipedia/Wikidata REST.
**Nunca:** scraping de Goodreads (API discontinuada en 2020, viola ToS), de Amazon, ni
nada que requiera evadir bloqueos.

---

## Estado actual

> Actualizado: 2026-08-05. **Mantené esta sección al día**: es lo primero que se lee cada
> sesión y lo único que dice dónde estamos.

| Fase | Estado |
|---|---|
| 0 · Andamiaje | Cerrada |
| 1 · Spike de cobertura | **Parcial — go/no-go abierto, ver abajo** |
| 2 · Resolución y caché | Cerrada |
| 3 · Enriquecimiento LLM | **En curso — puntos 1-7 hechos, falta el 8** |
| 4 · Escáner · 5 · Scoring · 6 · OCR | Sin empezar |

**Anda hoy:** los 3 workspaces compilan y testean (347 tests: 334 api, 2 web, 11 shared) ·
`GET /health` · `GET /api/book/:isbn13` de punta a punta —validación de ISBN, caché D1,
cascada de 3 fuentes, merge por campo, **enriquecimiento por LLM en cache miss**, upgrade
perezoso y registro en `scan_events`— · `POST /api/event` · D1 local migra (0001 y 0002) ·
la PWA muestra una pantalla · `npm run spike` mide la cobertura de la Fase 1.

todo `apps/api/src/llm/` con 168 tests: sanitize (contra HTML real de Wikipedia ES),
schema, prompts con 28 anclas, spoilerGuard, los 3 proveedores y el orquestador ·
`npm run check:models`.

**No existe:** escáner · onboarding · `lib/scoring.ts` · `POST /api/identify` ·
`scripts/enrich-batch.ts` · `scripts/golden-set.ts`.

### Fase 3 — dónde quedó

**Hecho (puntos 1-7).** El adapter (`llm/{types,sanitize,schema,prompts,spoilerGuard,enrich}.ts`
y `llm/providers/{openai,workersai,fixture,index}.ts`) y su conexión al endpoint:
`lib/enriquecerEnVivo.ts` (la carrera), `lib/segundoPlano.ts` (`waitUntil`),
`db/upgrades.ts` (la cola) y la migración `0002`.

Verificado a mano el 2026-08-05 contra el Worker local con `LLM_PROVIDER_TAIL=fixture`:
cache miss de un ISBN nuevo → `meta.enrichment: 'listo'` en 2,2 s, `confidence` 0.08
(= 0.1 × la penalización de cola), la ficha guardada; al tercer cache hit aparece la fila
en `enrichment_upgrades` con `reason: 'scan-count'`.

**Falta (punto 8):** `scripts/enrich-batch.ts`. Hasta que exista, **la cola de
`enrichment_upgrades` se llena y nadie la drena**, y los libros que quedaron en `books`
desde la Fase 2 siguen sin ficha.

Cuatro decisiones tomadas que conviene no volver a discutir:

- **La verificación del modelo no puede correr "al arrancar".** `workerd` prohíbe hacer
  fetch en el scope global. Adentro del Worker es perezosa y memoizada por isolate
  (`providers/index.ts`, `modeloUsable`), y loguea ruidoso sin tirar 500. El fallo duro
  (`exit 1`) vive en `npm run check:models`, que corre antes de deployar.
- **Un cache miss en vivo usa siempre la COLA.** Un libro que nadie escaneó todavía no
  es cabeza, por definición. El modelo pago queda para `enrich-batch.ts` y para el
  upgrade perezoso.
- **El presupuesto de la carrera es de 6 s, y sí, se pasa de los 5 s del objetivo.**
  Aceptado: el caso es el 5% del tráfico y a cambio un modelo rápido a veces llega. Cuando
  no llega, el `waitUntil` deja la ficha lista para el escaneo siguiente — el primero que
  escanea un libro paga la espera por todos los demás. El `saveEnrichment` va **adentro**
  de la promesa que corre la carrera: si viviera afuera, un timeout tiraría una llamada ya
  pagada.
- **Un libro cacheado sin ficha NO se reintenta.** Si se reintentara, un libro sin
  descripciones —del que el modelo nunca va a sacar nada— gastaría una llamada por
  escaneo, para siempre. Un intento por libro; el resto es trabajo de `enrich-batch.ts`.

### ⚠️ El go/no-go de la Fase 1 sigue abierto

Medido con `npm run spike` el 2026-08-05 sobre los 30 ISBN de `scripts/isbns.txt`:
**46,7% (14/30) con al menos una descripción de más de 200 caracteres**, debajo de la
línea roja de 60% del PLAN. Detalle en `scripts/spike-results.json`.

**El número sigue sin ser válido, y ya no es por falta de key.** Las tres keys están
cargadas en `.env` y `apps/api/.dev.vars`, pero **la Books API no está habilitada en el
proyecto de Google Cloud** (`132510423534`): responde `403 API_KEY_SERVICE_BLOCKED` a
todo. Google Books resolvió **0/30**. Como `sources/http.ts` traduce cualquier error a
`null` por diseño, desde la cascada eso es indistinguible de "no conoce el libro".

> **Cargar la key no alcanza.** Hay que habilitar la Books API en
> `console.developers.google.com/apis/api/books.googleapis.com/overview` y, si la key
> tiene restricción por API, incluir "Books API" en la lista.

Cuando esté habilitada: `npm run spike` → recapturar los fixtures de Google Books (hoy
**reconstruidos, no capturados**, ver `apps/api/test/fixtures/sources/README.md`) →
`LECTOR_LIVE=1 npm test -w @lector/api` → anotar el número acá.

**El dato que más preocupa, y que Google Books no arregla solo:** los 15 ISBN que no
resuelven en *ninguna* fuente son casi enteros el grupo de editoriales independientes
argentinas — justo el que PLAN.md marca como "el que te va a dar la respuesta real".

---

## Comandos

Todos desde la raíz del repo.

| Qué | Comando |
|---|---|
| **Semáforo — antes de cerrar cualquier tarea** | `npm test && npm run typecheck && npm run build` |
| Dev PWA (`:5173`) | `npm run dev:web` |
| Dev Worker (`:8787`) | `npm run dev:api -- --local` (sin `--local` pide `wrangler login`) |
| Tests de un workspace | `npm test -w @lector/api` (o `@lector/web`, `@lector/shared`) |
| Tests en watch | `npm run test:watch -w @lector/api` |
| Tests contra las APIs reales | `LECTOR_LIVE=1 npm test -w @lector/api` |
| Migrar D1 local | `npm run db:migrate:local -w @lector/api` |
| Spike de cobertura (Fase 1) | `npm run spike` |
| **Verificar los model IDs — antes de cada deploy** | `npm run check:models` |

Los scripts de `scripts/` son TypeScript y Node 20 no los corre solo: `npm run script -- <archivo.ts>`
los bundlea con el `esbuild` que ya trae vite. Leen el `.env` de la raíz, no `.dev.vars`.

Operativa completa, secrets, deploy y troubleshooting: **`RUNBOOK.md`**.

---

## Stack

React 18 + TypeScript + Vite + Tailwind 4 + `vite-plugin-pwa` · cámara con `getUserMedia`
+ `BarcodeDetector` (fallback `zxing-wasm`) · OCR con `tesseract.js` (solo Fase 6,
lazy-loaded) · Cloudflare Workers + Hono · D1 (SQLite) · Zustand con persist a
`localStorage` · Vitest · LLM multi-proveedor detrás de un adapter → **`docs/LLM.md`**.

Motivo de todo: free tier permanente que cubre un MVP entero. Workers da 100k requests/día
y la PWA evita los USD 25 de Google Play y los USD 99/año de Apple.

---

## Estructura

```
lector/
├─ CLAUDE.md · PLAN.md · RUNBOOK.md · docs/LLM.md
├─ apps/
│  ├─ web/src/
│  │  ├─ features/{scanner,onboarding,book,profile}/   # vacías hasta Fase 4
│  │  ├─ lib/scoring.ts        # CORE, 100% testeado (Fase 5)
│  │  └─ store/
│  └─ api/src/
│     ├─ routes/               # health, book, event
│     ├─ sources/              # openlibrary, googlebooks, wikipedia, http, types
│     ├─ resolver/             # cascade (orden + medición), merge (FIELD_PRIORITY)
│     ├─ db/                   # books, events, upgrades (la cola del upgrade)
│     ├─ lib/                  # isbn, enriquecerEnVivo (la carrera), segundoPlano
│     └─ llm/                  # sanitize, schema, prompts, spoilerGuard, enrich
│        └─ providers/         # openai, workersai, fixture, index (la fábrica)
├─ packages/shared/src/        # tipos + Zod compartidos
└─ scripts/                    # spike-coverage, enrich-batch, golden-set
```

### Fuentes de verdad — no duplicar en este archivo

| Qué | Dónde |
|---|---|
| `AppealVector`, las 14 dimensiones | `packages/shared/src/appeal-vector.ts` |
| `Book`, `Enrichment`, `ContentFlag` | `packages/shared/src/` |
| Esquema SQL completo | `apps/api/migrations/0001_init.sql` |
| Bindings y env del Worker | `apps/api/src/env.ts` + `.env.example` |
| Orden de la cascada y su medición | `apps/api/src/resolver/cascade.ts` |
| Prioridad por campo del merge | `apps/api/src/resolver/merge.ts` (`FIELD_PRIORITY`) |
| Secciones que se cortan antes del prompt | `apps/api/src/llm/sanitize.ts` (`SECCION_PROHIBIDA`) |
| Patrones que rechazan una salida | `apps/api/src/llm/spoilerGuard.ts` (`PATRONES_SPOILER`) |
| Las 28 anclas del appeal vector | `apps/api/src/llm/prompts.ts` (`ANCLAS`) |

Si algo de esto cambia, se cambia **ahí**. Copiarlo acá garantiza que una de las dos
copias quede vieja.

---

## Contrato de la API

```
GET  /api/book/:isbn13   → { book, enrichment, source: 'cache'|'fresh', meta }
                           400 ISBN inválido · 404 no resuelto en ninguna fuente
POST /api/identify       → { candidates: [...] }   body: { title?, author?, ocrText? }
POST /api/event          → registro anónimo de escaneo
```

`meta.enrichment` dice qué pasó con la ficha, y la UI necesita los cinco:
`listo` · `pendiente` (perdió la carrera, sigue en `waitUntil`: el próximo escaneo la
tiene) · `ausente` (cacheado sin ficha, no se reintenta) · `apagado` (`LLM_ENABLED=false`)
· `fallo`. Sin esto no se puede distinguir "este libro no tiene resumen" de "el resumen
está saliendo", que son dos mensajes muy distintos parado en el pasillo.

El cliente calcula el score. **El servidor nunca ve el perfil del usuario.**

---

## Convenciones de código

Las que el repo ya sigue. Mantenelas:

- **JSDoc de encabezado en todo módulo, explicando el _porqué_, no el _qué_** (ver
  `sources/http.ts`, `resolver/merge.ts`). Un comentario que repite el nombre de la
  función sobra; uno que explica por qué el orden es ese, no.
- **Las fuentes nunca lanzan.** Red caída, timeout, 404, JSON roto → `null`, y la cascada
  sigue con la siguiente. El usuario está parado en el pasillo.
- **Dependencias inyectables para testear sin red:** `fetchImpl` en `http.ts`,
  `deps.sources` en `cascade.ts`, `now` en `mergeRecords`. No mockear módulos globales.
- **Los campos opcionales se omiten, no se setean en `null`** — los schemas Zod usan
  `.optional()`. De ahí el patrón `...(x && { x })`.
- **Zod valida todo lo que entra.** La *forma* la garantiza el JSON Schema estricto; los
  *rangos* y la semántica, Zod.
- **Fixtures con fecha y procedencia declaradas.** Si un test de fixtures se rompe,
  verificá si la API cambió — **no ajustes el esperado para que pase**.
- **Cero secretos en el cliente.** Toda API key vive solo en el Worker
  (`wrangler secret put`), nunca en `wrangler.toml` ni en `apps/web`.
- **Nunca hardcodear un model ID.** Siempre por env (`LLM_MODEL` / `LLM_MODEL_TAIL`).

---

## Tests

- Todo módulo que se **crea** o se **modifica** queda con su test al día, en `apps/*/test/`
  (o junto al archivo en web), con nombre `<modulo>.test.ts`.
- **`lib/scoring.ts` va 100% cubierto** (Fase 5): es el corazón del producto y es
  matemática pura, no hay excusa.
- **`llm/sanitize.ts` va con tests exhaustivos** sobre HTML real de Wikipedia ES (Fase 3).
  Si falla, el resumen spoilea — es el diferencial del producto.
- **Bugfix:** primero el test que reproduce el bug, para que quede como regresión.
- `describe`/`it` en español: `it('lee la variante { type, value }')`.
- **Ningún test pega a la red.** Las llamadas reales viven solo en `sources.live.test.ts`,
  detrás de `LECTOR_LIVE=1`.

---

## No agregar sin discutir

| Propuesta | Por qué no |
|---|---|
| Vector DB (Pinecone, Weaviate, Chroma) | Con <50k libros: JSON en SQLite y coseno en JS. Gratis. |
| Embeddings para similitud | El vector de 14 dims es mejor **y** explicable |
| Cuentas de usuario / login | El perfil vive en el dispositivo. Sin PII, sin costo. |
| Llamar al LLM por usuario para el score | Rompe el presupuesto en 3 días (regla 2) |
| React Native / Expo | La PWA alcanza y evita USD 25 + USD 99/año |
| Next.js | No necesitamos SSR |
| Redis · Docker · Kubernetes · Firebase · Supabase | Es un Worker y una PWA estática. D1 alcanza. |
| LangChain / LlamaIndex | El adapter son 40 líneas. No 200 dependencias. |
| Scrapear Goodreads o Amazon | Viola ToS y hay APIs legales (regla 6) |
| Fine-tunear visión para portadas | Meses de trabajo, peor que un código de barras de $0 |
| `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4-pro` | Rompen el presupuesto en horas |
| Hardcodear un model ID | Los catálogos gratis desaparecen sin aviso |
| Saltear el golden set "porque los resúmenes se ven bien" | El colapso del vector no se ve: se mide |

---

## Áreas de atención

- **Node 20.19 es el techo del toolchain.** `wrangler ~4.86.0`, `jsdom ^29` (`overrides` en
  la raíz) y `compatibility_date = 2026-05-03` están pineados **juntos**; se sueltan los
  tres en un solo commit al pasar a Node 22 — ver `RUNBOOK.md`.
- **Dos archivos de secrets, a propósito:** `apps/api/.dev.vars` lo lee wrangler, `.env` de
  la raíz lo leen los scripts de Node. Wrangler no lee el `.env` de la raíz. Nunca crees
  `apps/web/.env`: Vite inlinea en el bundle todo lo que empiece con `VITE_`.
- **`LLM_PROVIDER=fixture` es el default de desarrollo.** Si en local dice otra cosa, pará.
- **`GOOGLE_BOOKS_KEY` es obligatoria**, no opcional: el cupo anónimo es cero.
- **El ISBN de la caché es el que leyó el escáner**, no el que devuelven las fuentes —
  Open Library sirve `identifiers.isbn_13` con checksums inválidos.
- **Wikipedia devuelve el artículo equivocado seguido** (el autor en vez del libro, la
  película en vez de la novela). De ahí el guard de `wikipedia.ts` y sus tres fixtures.
- **El `--` final de `dev:web` y `dev:api` es necesario** para pasarles flags
  (`-- --port 5174`). Sin él, npm se come los flags en silencio.
