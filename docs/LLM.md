# docs/LLM.md — Estrategia de LLM

> **Leelo antes de tocar `apps/api/src/llm/` o `scripts/enrich-batch.ts`.** No hace falta
> para nada más: por eso vive acá y no en `CLAUDE.md`.
>
> Las reglas duras que aplican siempre (una llamada por libro, nunca datos de usuario,
> model IDs por env, `fixture` en desarrollo) están en `CLAUDE.md`. Esto es el detalle.

---

## El principio

La carga de trabajo **no es tráfico en vivo**. Por la regla 2 el LLM se llama una vez por
libro y nunca más: son ~2.000–16.000 llamadas en toda la vida del MVP, sin requisitos de
latencia. Eso habilita el free tier de una forma que no funcionaría en un producto normal.

Además **nunca se manda dato de usuario al LLM**. Solo metadata pública de libros. El
costo de privacidad habitual del free tier acá es cero.

---

## El split: cabeza paga, cola gratis

La distribución de escaneos es zipfiana. Aprovechalo:

```
CABEZA  — top ~500 títulos, los que la gente realmente escanea
          modelo: gpt-5.6-luna  ($0.20/$1.20 por M)
          costo:  500 × $0.0012 = $0.60
          confidence: sin penalización

COLA    — el resto del catálogo
          modelo: free tier
          confidence: × 0.8 (penalización por modelo económico)

UPGRADE PEREZOSO
          si un libro de la cola acumula 3+ escaneos, se encola para
          re-enriquecimiento con el modelo pago. El sistema se auto-repara
          hacia donde está la demanda real.
```

El contador ya existe: `enrichments.scan_count`, que incrementa
`apps/api/src/db/books.ts` en cada cache hit. Lo que falta es el disparador a los 3.

---

## Proveedores y cuándo usar cada uno

| Proveedor | Límite gratis | Rol |
|---|---|---|
| Cloudflare Workers AI | 10.000 neuronas/día | **Default de la cola.** Binding nativo, ya estás en Workers, sin API key extra |
| Google AI Studio | 1.500 req/día, sin tarjeta | Respaldo de la cola, buen multilingüe |
| Cerebras | 1M tokens/día | Corridas batch grandes |
| Groq | 30 RPM / 6K TPM | Alternativa rápida |
| OpenAI `gpt-5.6-luna` | pago, $0.0012/libro | **Cabeza y golden set** |
| `fixture` | — | Desarrollo y tests |

**Prohibidos en este proyecto:** `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4-pro`.
Rompen el presupuesto en horas.

---

## El adapter

`apps/api/src/llm/providers/` — un archivo por proveedor, interfaz común:

```ts
interface LlmProvider {
  name: string;
  complete(req: EnrichRequest): Promise<EnrichRaw>;
  supportsStrictSchema: boolean;   // decide si hace falta el retry por JSON
}
```

Se elige con `LLM_PROVIDER` (cabeza) y `LLM_PROVIDER_TAIL` (cola). Los model IDs van en
`LLM_MODEL` / `LLM_MODEL_TAIL` — **nunca hardcodeados**.

Motivo: el 31 de mayo de 2026 un proveedor borró en silencio la mayoría de sus modelos
gratis y las pipelines que los tenían hardcodeados murieron sin aviso. Al arrancar, el
Worker consulta la lista de modelos del proveedor y **falla ruidoso** si el configurado no
está.

`LLM_ENABLED=false` es el kill switch: devuelve `null` y degrada a metadata cruda. Ese
modo degradado ya funciona hoy — es exactamente lo que devuelve `GET /api/book/:isbn13`
mientras la Fase 3 no exista.

---

## Salida estructurada — varía por proveedor

- **OpenAI**: `response_format` con `json_schema` y `strict: true`. Restringe en tiempo de
  decodificación: el JSON siempre parsea. Requiere todos los campos en `required` y
  `additionalProperties: false` en **cada** nivel.
- **Workers AI / Ollama**: soportan JSON schema, garantía algo menor.
- **Groq / Cerebras**: JSON mode, soporte de schema estricto variable por modelo.
- **llama.cpp local**: gramáticas GBNF, decodificación realmente restringida.

Por eso el pipeline **conserva** el reintento por JSON malformado, activado cuando
`supportsStrictSchema === false`.

El JSON Schema garantiza la **forma**; no garantiza los **rangos**. Zod valida siempre
rangos y semántica antes de tocar la base — `AppealVectorSchema` ya clampea a 0–1.

---

## Anclas del appeal vector

Para cada una de las 14 dimensiones, darle al modelo **un ejemplo de libro en 0.1 y otro
en 0.9**. Sin anclas, los modelos económicos devuelven todo entre 0.5 y 0.7 y el scoring
se convierte en ruido. Esto es lo que mide la Puerta 2 de la Fase 3 (`golden-set.ts`):
desvío estándar por dimensión y coseno medio entre libros distintos.

---

## Tokens de razonamiento — riesgo de presupuesto

Los GPT-5.x pueden emitir tokens de razonamiento facturados como output ($1.20/M en Luna).
Esta tarea es extracción y no los necesita. Si el SDK expone `reasoning_effort`, al mínimo.

En la primera corrida, loguear `usage` completo y comparar `completion_tokens` contra el
largo real del texto: una brecha grande son tokens de razonamiento.

---

## Caché de prompt (solo OpenAI)

Automático, factura al 10% del input estándar. El bloque de sistema es idéntico en todas
las llamadas → primero y sin variaciones (nada de fechas ni IDs adentro). Las escrituras
cuestan 1,25× y el contenido vive 30 minutos mínimo, así que solo rinde en corridas batch
seguidas. **No lo cuentes en el presupuesto.**

---

## Batch API

50% de descuento, entrega hasta 24 h. Obligatoria en `scripts/enrich-batch.ts`, con
estimación de costo y confirmación antes de arrancar. **Nunca en el endpoint en vivo.**

---

## Modo fixture

`LLM_PROVIDER=fixture` reproduce respuestas guardadas en `apps/api/fixtures/llm/`. Un
junior corre el mismo código 200 veces debuggeando sin gastar un centavo. **Es el default
en desarrollo**, tanto en `wrangler.toml` como en `.env.example`.

---

## Presupuesto — números reales

Por libro: ~2.500 tokens in + ~600 out ≈ 3.100 tokens.

```
  cabeza   500 libros × $0.00122 (gpt-5.6-luna)  = $0.61
  cola     free tier                             = $0.00
  ──────────────────────────────────────────────────────
  total MVP                                      ≈ $0.61
```

Quedan **~$9.40 de reserva** para re-enriquecimientos por upgrade perezoso, el golden set,
y ampliar la cabeza si el producto crece.

Solo pago, si preferís saltear el free tier:

| Modo | Costo/libro | USD 10 alcanza para |
|---|---|---|
| Luna estándar | $0.00122 | ~8.200 libros |
| Luna + Batch (−50%) | $0.00061 | ~16.400 libros |

Los $10 **nunca fueron el cuello de botella** — el recurso escaso son tus 50-80 horas. Si
un setup gratuito te cuesta un fin de semana, gastaste algo más caro que $10. Usá el free
tier donde es trivial (Workers AI ya está en el stack) y no pelees por centavos donde no
lo es.

**Ojo con el medidor de contexto largo:** Luna sube de $0.20/$1.20 a $0.40/$1.80 en
prompts largos. Los nuestros son de ~2.500 tokens, bien dentro del tramo corto.

### Reglas de gasto

- Enriquecimiento **solo en cache miss**
- `max_tokens: 700`
- `reasoning_effort` al mínimo
- Batch API en la precarga de catálogo
- Sin LLM multimodal hasta Fase 6, y ahí rate limit de 5/día por dispositivo
- `LLM_PROVIDER=fixture` en desarrollo
- Kill switch `LLM_ENABLED=false` → degrada a metadata cruda, no rompe
- Guardar `prompt_tokens`, `output_tokens` y `model_used` en cada fila de `enrichments`
  para auditar gasto real contra estimado

---

## Verificá la documentación vigente

Los SDKs y los catálogos de modelos cambian seguido. Antes de escribir cada provider,
confirmá la doc actual del proveedor, y mantené toda llamada externa detrás de
`llm/providers/*.ts` para que un cambio toque un solo archivo.
