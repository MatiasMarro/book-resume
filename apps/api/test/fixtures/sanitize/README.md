# Fixtures de `llm/sanitize.ts`

HTML **capturado real** de `es.wikipedia.org` el **2026-08-05**, con:

```
https://es.wikipedia.org/w/api.php?action=parse&page=<TÍTULO>&prop=text&formatversion=2&format=json
```

Se guardó el campo `parse.text` tal cual, sin tocar un byte. UTF-8 sin BOM.

| Archivo | Artículo | Por qué está |
|---|---|---|
| `wikipedia-los-siete-locos.html` | *Los siete locos* | `Argumento` + `Personajes principales`: el caso central |
| `wikipedia-el-tunel.html` | *El túnel (novela)* | `Trama por capítulos` + `Personajes`: el encabezado **no** es la palabra pelada, y por eso el regex ancla en `^` |
| `wikipedia-distancia-de-rescate.html` | *Distancia de rescate* | **Control negativo**: no tiene ninguna sección prohibida. Si el sanitizador le borra algo, está cortando de más |

## Qué NO hacer

No los edites para que un test pase. Si Wikipedia cambió la estructura de sus
encabezados —pasó en 2024 con `<div class="mw-heading">`— el que tiene que
cambiar es `sanitize.ts`, y estos archivos se recapturan con el comando de
arriba.

El control negativo es tan importante como los otros dos: un sanitizador que
borra todo pasa cualquier test de spoilers y deja al modelo sin contexto, que es
exactamente cuando empieza a inventar.
