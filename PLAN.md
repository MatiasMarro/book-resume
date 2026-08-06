# PLAN.md — Fases y prompts para Claude Code

> **Cómo usar este archivo.** Cada fase tiene un prompt para copiar y pegar en Claude
> Code. Hacé **una fase por sesión**. Al terminar cada una, verificá el criterio de
> aceptación **vos mismo, a mano** antes de seguir. No saltees fases. La Fase 1 es la
> más importante y la que todos saltean.
>
> **En qué fase estamos** lo dice `CLAUDE.md`, sección "Estado actual" — es la única
> fuente de verdad. Acá abajo el encabezado de cada fase lleva su estado como
> recordatorio, pero si los dos se contradicen, gana `CLAUDE.md`.

| Fase | Estado |
|---|---|
| 0 · Andamiaje | Cerrada |
| 1 · Spike de cobertura | Parcial — go/no-go abierto |
| 2 · Resolución y caché | Cerrada |
| 3 · Enriquecimiento LLM | En curso — puntos 1-7 hechos, falta el 8 |
| 4 · Escáner | Sin empezar |
| 5 · Perfil y scoring | En curso — `scoring.ts` hecho, falta onboarding y ficha |
| 6 · OCR | Sin empezar |

---

## Setup inicial (10 minutos, lo hacés vos)

```bash
mkdir lector && cd lector
git init
# Copiá CLAUDE.md y PLAN.md dentro de esta carpeta
claude
```

Cuentas gratis que vas a necesitar:

| Servicio | Para qué | Costo |
|---|---|---|
| Cloudflare | Workers + D1 + Pages + **Workers AI** | Gratis |
| Google Books API | Metadata | Gratis, 1000/día |
| Google AI Studio | Respaldo free tier de la cola | Gratis, 1.500 req/día |
| platform.openai.com | `gpt-5.6-luna` para la cabeza | ~$0.61 del MVP |

Open Library y Wikipedia no requieren key.

> ⚠️ **Verificá esto antes de escribir código.** Una suscripción a ChatGPT
> (Plus/Pro/Business) **no** genera créditos de API — son productos separados.
> Confirmá saldo real en `platform.openai.com/settings/organization/billing`.
> Si el saldo es $0, corré todo por free tier y ajustá el golden set de la Fase 3.

---

## FASE 0 — Andamiaje · ✅ CERRADA

**Prompt:**

```
Leé CLAUDE.md completo antes de escribir nada.

Armá el andamiaje del monorepo según la estructura que está en CLAUDE.md.
Nada de lógica de negocio todavía — solo que compile y arranque.

1. npm workspaces: apps/web, apps/api, packages/shared
2. apps/web: Vite + React 18 + TypeScript + Tailwind + vite-plugin-pwa.
   Una pantalla que diga "Lector" y nada más.
3. apps/api: Cloudflare Worker con Hono. Un endpoint GET /health que
   devuelva { ok: true }.
4. packages/shared: los tipos AppealVector, Book, Enrichment y ContentFlag
   exactamente como están definidos en CLAUDE.md, con esquemas Zod para cada uno.
5. wrangler.toml con binding de D1 (base "lector-db") y las migraciones SQL
   del esquema de CLAUDE.md en apps/api/migrations/
6. .env.example con:
     GOOGLE_BOOKS_KEY
     LLM_ENABLED=true
     LLM_PROVIDER=fixture          # cabeza: 'openai' | 'workersai' | 'fixture'
     LLM_MODEL=gpt-5.6-luna
     LLM_PROVIDER_TAIL=workersai   # cola larga
     LLM_MODEL_TAIL=
     OPENAI_API_KEY=
     GOOGLE_AI_STUDIO_KEY=
   Nunca hardcodear un model ID en el código: siempre por env.
7. .gitignore que cubra .env, node_modules, .wrangler, dist
8. Vitest configurado en web y api

Al terminar, mostrame los comandos exactos para levantar cada app en local.
```

**Criterio de aceptación:** `npm run dev` levanta la web en `localhost:5173`,
`npm run dev:api` levanta el worker, y `/health` responde. Nada más.

---

## FASE 1 — El spike de cobertura ⚠️ GO / NO-GO · PARCIAL, SIN CERRAR

> **Dónde quedó.** La medición se hizo durante la Fase 2, a mano y sin el script: sobre
> los 29 ISBN de `scripts/isbns.txt` dio **50% con al menos una descripción de más de 200
> caracteres**, o sea **zona roja** según la tabla de abajo.
>
> **Pero el número no es válido todavía**: se midió **sin Google Books**, que es la fuente
> con mejor catálogo en español. `books.googleapis.com` devuelve 429 a toda request sin
> key (cupo anónimo = 0), y no había key cargada. Los detalles están en el encabezado de
> `apps/api/src/resolver/cascade.ts`.
>
> **Para cerrar la fase:** cargar `GOOGLE_BOOKS_KEY`, recapturar los fixtures de Google
> Books (hoy están reconstruidos, no capturados), correr
> `LECTOR_LIVE=1 npm test -w @lector/api`, volver a medir, y anotar el número real en
> `CLAUDE.md`. Escribir `scripts/spike-coverage.ts` como abajo hace la medición repetible
> en vez de artesanal.
>
> **No arranques la Fase 3 sin este número.** Enriquecer con LLM libros que no tienen
> descripción no arregla la cobertura: la empeora, porque el modelo inventa.

**Esta es la fase que decide si el proyecto es viable.** No escribas una sola línea
de UI hasta terminarla. Sin datos no hay producto, y el catálogo en español es el
riesgo número uno.

**Antes de correr el prompt:** andá a una librería, o agarrá tu biblioteca, y anotá
**30 ISBN reales** (están en el código de barras de la contratapa). Mezclá a
propósito:

- 10 bestsellers internacionales traducidos
- 10 de catálogo en español (Anagrama, Alfaguara, Sudamericana, Tusquets)
- 10 de editoriales independientes argentinas (Eterna Cadencia, Sigilo, Fiordo,
  Caja Negra, Godot, El Cuenco de Plata)

Ese tercer grupo es el que te va a dar la respuesta real.

**Prompt:**

```
Leé CLAUDE.md.

Escribí scripts/spike-coverage.ts: un script de Node standalone (sin backend, sin
DB, sin UI). Lee scripts/isbns.txt (un ISBN-13 por línea) y para cada uno consulta:

  1. Open Library  /api/books?bibkeys=ISBN:xxx&format=json&jscmd=data
  2. Open Library  works endpoint (para description a nivel obra)
  3. Google Books  /volumes?q=isbn:xxx
  4. Wikipedia ES  REST summary, buscando por título+autor

Para cada ISBN registrá:
  - resuelto por cada fuente (sí/no)
  - largo en caracteres de la descripción de cada fuente
  - si tiene subjects/categories
  - si tiene tapa
  - idioma detectado

Salida: una tabla en consola + scripts/spike-results.json

Al final imprimí un resumen:
  - % con AL MENOS UNA descripción de más de 200 caracteres  ← LA MÉTRICA CLAVE
  - % resuelto por fuente
  - lista de los ISBN que fallaron completamente

Respetá rate limits (250ms entre requests). Manejá errores sin cortar el script.
No uses el LLM en esta fase.
```

**Criterio de aceptación e interpretación:**

| Resultado | Qué significa |
|---|---|
| **>75%** | Verde. Seguí con el plan tal cual. |
| **60–75%** | Amarillo. Seguí, pero diseñá bien el estado "info limitada". |
| **<60%** | Rojo. **Pará.** El producto tiene que cambiar de forma: o restringís el catálogo a un nicho bien cubierto, o el LLM pasa a ser la fuente primaria (sube el costo y baja la confiabilidad), o pivoteás a que la librería cargue su propio catálogo. |

Anotá el número real en CLAUDE.md antes de seguir.

---

## FASE 2 — Resolución de libros y caché · ✅ CERRADA

> Implementado: `sources/` (openlibrary, googlebooks, wikipedia, http, types), `resolver/`
> (cascade con el orden justificado y medido, merge con `FIELD_PRIORITY` por campo), `db/`
> (books, events), `lib/isbn.ts`, y las rutas `GET /api/book/:isbn13` y `POST /api/event`.
> 125 tests en `@lector/api`, más una suite en vivo detrás de `LECTOR_LIVE=1`.
>
> **Deuda que queda de esta fase:** los fixtures de Google Books están reconstruidos, no
> capturados — es el único normalizador que no se validó contra bytes reales. Ver
> `apps/api/test/fixtures/sources/README.md`.

**Prompt:**

```
Leé CLAUDE.md y scripts/spike-results.json.

Implementá en apps/api:

1. apps/api/src/sources/ — un módulo por fuente (openlibrary, googlebooks,
   wikipedia). Cada uno exporta una función que recibe un ISBN o título+autor y
   devuelve un tipo normalizado. Falla suave: nunca lanza, devuelve null.

2. Un resolver en cascada que prueba las fuentes en orden y las fusiona. La cascada
   la definís según lo que dieron los resultados del spike — priorizá la fuente que
   más cobertura mostró.

3. GET /api/book/:isbn13 con esta lógica:
   - validar ISBN-13 (checksum incluido)
   - buscar en D1 → si existe books + enrichments, devolver con source:'cache'
   - si no, correr la cascada, guardar en books, devolver con enrichment null
   - si nada resuelve, 404 con un mensaje útil
   - registrar en scan_events

4. POST /api/event

Tests con Vitest para: validación de ISBN, normalización de cada fuente, y la
lógica de merge. Mockeá las respuestas HTTP con fixtures reales tomadas del spike.

Todavía NO llames al LLM.
```

**Criterio de aceptación:** `curl localhost:8787/api/book/9788433920423` devuelve
metadata. La segunda llamada al mismo ISBN responde en <100ms y dice
`source: 'cache'`. Los tests pasan.

---

## FASE 3 — Enriquecimiento con LLM · ← SIGUIENTE

Es la fase más larga y la que define la calidad del producto. Partila en dos
sesiones si hace falta: primero 1-4, después 5-7.

> **Antes de arrancar:** cerrá el go/no-go de la Fase 1. Y leé `docs/LLM.md` completo —
> ahí está el split cabeza/cola, el adapter, la salida estructurada por proveedor y las
> reglas de gasto.

**Prompt:**

```
Leé CLAUDE.md (reglas 2 y 3) y docs/LLM.md completo.

Implementá apps/api/src/llm/:

1. providers/ — un archivo por proveedor con esta interfaz común:

     interface LlmProvider {
       name: string;
       complete(req: EnrichRequest): Promise<EnrichRaw>;
       supportsStrictSchema: boolean;
     }

   Implementá: openai.ts (SDK oficial, response_format json_schema strict:true),
   workersai.ts (binding nativo de Cloudflare, sin API key), fixture.ts (lee de
   apps/api/fixtures/llm/).
   Se eligen con LLM_PROVIDER y LLM_PROVIDER_TAIL. Los model IDs SIEMPRE por env.

   Al arrancar el Worker, consultá la lista de modelos del proveedor y fallá
   ruidoso si el configurado no existe. Los catálogos de modelos gratuitos
   desaparecen sin aviso.

   Respetá LLM_ENABLED: si es false, devolver null y degradar a metadata cruda.

2. sanitize.ts — CRÍTICO, escribilo ANTES que el prompt.
   Recibe el texto crudo de las fuentes y elimina, antes de que llegue al LLM:
     - toda sección de Wikipedia cuyo encabezado matchee
       /^(argumento|trama|sinopsis|resumen|desenlace|final|personajes|plot)/i
     - del extracto de Wikipedia, solo el primer párrafo
     - cualquier bloque de reseñas de usuarios
   Devuelve texto limpio + lista de lo descartado (debug).
   Tests exhaustivos con HTML real de Wikipedia ES.

3. schema.ts — el JSON Schema de la salida, compartido por todos los proveedores:
     { summary, hook, genres[], appeal_vector{14 dims}, content_flags[],
       comparables[], confidence }
   Modo estricto: todos los campos en required, additionalProperties:false en
   CADA nivel, content_flags como array de enum.
   El schema NO garantiza rangos 0-1 → Zod valida rangos y clampea.

4. prompts.ts — bloque de sistema idéntico en todas las llamadas (para el caché),
   sin fechas ni IDs adentro. Requisitos:
     - summary de 60-90 palabras, español rioplatense neutro
     - REGLA EXPLÍCITA: solo el planteo — premisa, protagonista, conflicto inicial,
       tono. Prohibido el punto medio, el giro y el final.
     - confidence bajo cuando hay poca fuente
   Para el appeal_vector, dale al modelo un ANCLA por dimensión: un ejemplo de
   libro en 0.1 y otro en 0.9. Sin anclas los modelos económicos devuelven todo
   entre 0.5 y 0.7 y el scoring se vuelve ruido.

5. spoilerGuard.ts — valida la salida. Rechaza si detecta patrones de revelación
   ("al final", "resulta que", "se revela que", "descubre que en realidad",
   "termina con", "muere"). Un reintento con instrucción reforzada; si falla otra
   vez, guardar con confidence penalizado y flag de revisión.

6. Retry por JSON malformado, activado solo si supportsStrictSchema === false.
   Los proveedores abiertos no garantizan la forma como OpenAI.

7. Conectá el enriquecimiento a GET /api/book/:isbn13, SOLO en cache miss.
   max_tokens: 700. reasoning_effort al mínimo si el SDK lo expone.
   Guardá model_used, prompt_tokens y output_tokens en cada fila.
   Incrementá scan_count en cada lectura; si llega a 3 y model_used es de la cola,
   encolá para re-enriquecimiento con el modelo de la cabeza (upgrade perezoso).

8. scripts/enrich-batch.ts — precarga de catálogo. Batch API si el proveedor la
   tiene. Estimación de costo con confirmación antes de arrancar.
```

**Criterio de aceptación — tres puertas, todas obligatorias:**

**Puerta 1 · Spoilers.** Pedí 5 libros que conozcas bien y leé los 5 resúmenes.
Si alguno spoilea, arreglá `sanitize.ts` antes de seguir. Este es el diferencial.

**Puerta 2 · Calibración del vector (la que más se saltea y la más importante).**

```
Prompt para Claude Code:

Escribí scripts/golden-set.ts.
Toma scripts/golden.json: 20 libros que YO puntué a mano en las 14 dimensiones,
elegidos para cubrir extremos (un thriller veloz, un ensayo denso, una novela
íntima lenta, una saga de fantasía, etc).
Corre el enriquecimiento sobre los 20 y reporta:
  - error absoluto medio por dimensión, modelo vs mis puntajes
  - DESVIACIÓN ESTÁNDAR de cada dimensión entre los 20 libros
  - matriz de similitud coseno entre los 20 vectores generados
Comparalo contra los proveedores configurados en LLM_PROVIDER y LLM_PROVIDER_TAIL.
```

Cómo leer el resultado:

| Señal | Significa |
|---|---|
| Desvío estándar < 0.15 en varias dimensiones | **Colapso del vector.** El modelo devuelve todo parecido. Tu scoring es ruido. |
| Coseno medio entre libros distintos > 0.9 | Mismo problema. Todo va a puntuar ~75%. |
| Error absoluto medio > 0.25 | Mala calibración, pero recuperable con mejores anclas |

Si la cola colapsa el vector: dejá el `summary` en el modelo gratis y mandá **solo
el `appeal_vector`** a `gpt-5.6-luna`. Son ~120 tokens de salida, cuesta centavos, y
te salva el producto.

**Puerta 3 · Costo real.** Mirá `prompt_tokens` / `output_tokens` en la base contra
lo estimado. Si `output_tokens` es mucho mayor que el texto real, son tokens de
razonamiento: apagalos.

---

## FASE 4 — El escáner

**Prompt:**

```
Leé CLAUDE.md, regla 1.

Implementá apps/web/src/features/scanner/:

1. Hook useBarcodeScanner:
   - getUserMedia con facingMode:'environment', preferí resolución alta
   - detección con BarcodeDetector API nativa si existe
   - fallback a zxing-wasm (lazy import, solo si hace falta)
   - formatos: ean_13, ean_8
   - escaneo continuo, debounce, para al primer resultado estable (2 lecturas
     iguales seguidas)

2. UI de cámara:
   - overlay con un rectángulo guía horizontal (proporción de código de barras)
   - texto: "Apuntá al código de barras de la contratapa"
   - feedback háptico (navigator.vibrate) al detectar
   - manejo explícito de: permiso denegado, sin cámara, contexto no-HTTPS

3. Entrada manual de ISBN como fallback siempre visible. No la escondas.

4. Al detectar → fetch a /api/book/:isbn13 → navegar a la ficha
   Estados: cargando (skeleton, no spinner), encontrado, no encontrado.

5. La ficha del libro: tapa, título, autor, hook, resumen, géneros, páginas,
   content_flags visibles. Sin score todavía.

Móvil primero. Se usa con una mano, parado, con el libro en la otra.
Botón de escaneo en el tercio inferior de la pantalla.
```

**Criterio de aceptación:** probalo **con un libro físico real**, en un celular real,
con la iluminación de una librería de verdad. No con una foto en la pantalla de la
compu. Medí cuántos segundos tarda desde abrir la cámara hasta ver el resumen.
Objetivo: menos de 5.

---

## FASE 5 — Perfil y scoring

**Prompt:**

```
Leé CLAUDE.md, reglas 4 y 5.

1. apps/web/src/lib/scoring.ts — el corazón del producto. Matemática pura, sin
   dependencias, 100% cubierto por tests.

   export function scoreBook(book: AppealVector, user: UserProfile): ScoreResult

   - similitud coseno ponderada (el usuario define qué dimensiones le importan más)
   - filtros duros: si el libro tiene un content_flag que el usuario evita, el score
     se marca como bloqueado independientemente de la similitud
   - devuelve: { score: 0-100, band: 'alta'|'media'|'baja'|'bloqueado',
                 reasons: Reason[] }
   - Reason = { kind: 'match'|'warning'|'blocker', dimension, text }
   - las razones se generan comparando dimensiones individuales: las 2-3 más
     cercanas → match, las que se desvían mucho → warning
   - texto de las razones en español rioplatense, concreto, nunca genérico

   Tests: perfiles extremos, vectores idénticos, opuestos, bloqueos,
   dimensiones faltantes.

2. Onboarding en apps/web/src/features/onboarding/ — máximo 90 segundos:

   Paso 1: grilla de 24 tapas, "Elegí 3 a 5 que hayas amado"
           (los 24 títulos los elegís vos para cubrir el espacio de apelación;
            pre-enriquecelos con enrich-batch y hardcodealos)
   Paso 2: 5 pares forzados, del estilo
           "¿Un libro que no puedas soltar, o uno que te siga dando vueltas
            una semana después?"
   Paso 3: multi-select de evitaciones (los ContentFlag)
   Paso 4: tolerancia de extensión

   El vector del usuario = promedio de los vectores de los libros elegidos,
   ajustado por los pares forzados. Guardar en localStorage con Zustand persist.
   Se puede saltear y completar después.

3. Mostrar el ScoreResult en la ficha. El número grande, pero las razones más
   prominentes que el número.
```

**Criterio de aceptación:** hacé el onboarding vos y después escaneá 10 libros que
conozcas. ¿Los scores coinciden con tu intuición? Si no, el problema casi siempre
está en los pesos o en la calidad de los `appeal_vector`, no en el coseno.

---

## FASE 6 — OCR y feedback (solo si las fases 1-5 están sólidas)

**Prompt:**

```
Leé CLAUDE.md.

1. Fallback OCR: si el usuario no encuentra código de barras, botón
   "Sacar foto de la tapa".
   - tesseract.js lazy-loaded (es pesado, no lo cargues hasta que se use)
   - preprocesado: escala de grises + aumento de contraste + reescalado
   - POST /api/identify con el texto crudo
   - el backend hace fuzzy match (trigram similarity) contra Google Books
   - devolver 3-5 candidatos con tapa para que el usuario elija — NUNCA asumir
     el primero

2. Para el nivel L2 (LLM multimodal sobre la tapa), verificá primero si el modelo
   de la cola acepta imágenes. Si no, usá gpt-5.6-terra SOLO para este camino, con
   rate limit duro de 5/día por dispositivo. Las imágenes cuestan ~1.200 tokens.

3. Feedback: en cada ficha, 👍 / 👎 / "Lo compré".
   Actualizá el vector del usuario con media móvil (learning rate 0.1).
   Todo local, sin servidor.

4. Historial de escaneos en localStorage, con búsqueda.

5. Pulido PWA: manifest, íconos, install prompt, offline shell, y que los libros
   ya vistos funcionen sin conexión (las librerías tienen pésima señal).
```

---

## Cosas que Claude Code va a proponer y tenés que rechazar

La lista vive en `CLAUDE.md`, sección **"No agregar sin discutir"** — ahí la lee en cada
sesión, que es cuando sirve.

---

## Orden de prioridad si te quedás sin tiempo

1. Fase 1 (el spike) — sin esto no sabés nada
2. Fases 2+3 (datos + resumen sin spoilers) — este es el producto
3. Fase 4 (escáner) — esta es la magia
4. Fase 5 (perfil + score) — esto es la retención
5. Fase 6 — nice to have

Una app que escanea y da un buen resumen sin spoilers **ya es útil sin perfil**.
Una app con perfil pero mal resumen no sirve para nada.
