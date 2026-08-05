# Fixtures de fuentes

Payloads crudos usados por los tests de normalización. **No los edites a mano
para que un test pase** — si una fuente cambió de forma, volvé a capturarla y
arreglá el normalizador.

## Procedencia

| Archivo | Origen |
|---|---|
| `openlibrary-*` | **Capturado real** el 2026-08-05 contra `openlibrary.org` |
| `wikipedia-*` | **Capturado real** el 2026-08-05 contra `es.wikipedia.org` |
| `googlebooks-*` | ⚠️ **Reconstruido**, no capturado — ver abajo |

## ⚠️ Los fixtures de Google Books están reconstruidos

Al momento de escribir la Fase 2, `books.googleapis.com` devuelve **429 a toda
request sin API key**:

```
"quota_limit": "defaultPerDayPerProject",
"quota_limit_value": "0"
```

El cupo anónimo es **cero**: `GOOGLE_BOOKS_KEY` no es opcional, es obligatorio.
Como no había key configurada, estos fixtures replican la forma documentada del
endpoint `/books/v1/volumes` en vez de una respuesta real.

**Pendiente:** cuando cargues la key, recapturá contra la API real y verificá
que `googlebooks.test.ts` siga pasando. Es el único normalizador que todavía no
se validó contra bytes de verdad.

## Casos que cubren los fixtures de Wikipedia

Los tres son reales y existen a propósito: la búsqueda de Wikipedia devuelve el
artículo equivocado seguido, y el guard de `wikipedia.ts` se testea contra estos.

- `wikipedia-summary-cien-anios` — match bueno, la página **es** la novela
- `wikipedia-summary-autor` — buscar "El Principito" devuelve **Antoine de Saint-Exupéry**
- `wikipedia-summary-pelicula` — buscar "The Da Vinci Code" devuelve **la película de 2006**
