# Notas para trabajar en ArriendoPro

## Cómo se levanta (entorno Base44 del sandbox)

```bash
docker compose -f docker-compose.base44.yml up -d      # la app queda en http://localhost:3000
docker compose -f docker-compose.base44.yml logs -f    # errores de la app y de las funciones
```

La aplicación no tiene servidor propio: es **un sitio estático de un solo archivo** (`index.html`, con todo su JSX dentro) más las **funciones de Netlify** de `netlify/functions/*.mts`, publicadas en sus rutas `/api/*` (cada una declara su `path` en `export const config`). Por eso se levanta con el mismo `netlify dev` que ya usa el proyecto (ver `netlify.toml`), sin depender de ninguna cuenta de Netlify.

- `index.html` (raíz) es el código fuente real. `dist/` es generado por `node build.mjs` (transpila el bloque `<script type="text/babel">`, lo minifica y sella `version.txt`) y no se versiona.
- El compose instala dependencias con `npm ci`, compila `dist/` y deja un watcher: al editar `index.html` o `build.mjs` se recompila solo y Netlify Dev recarga el navegador. Las funciones `.mts` se recargan solas al editarlas.
- No hay suite de tests en el repo; la comprobación es el build + la app en el navegador.

## Cosas que no son obvias

- **Netlify Blobs en local necesita IPv4 primero.** Los datos de la app (clave de acceso, propiedades, sesiones, respaldos) viven en Blobs. Sin `NODE_OPTIONS=--dns-result-order=ipv4first` (ya está en el compose), el servidor local de Blobs escucha en `::1` mientras las funciones se conectan a `127.0.0.1`, y **todas** las rutas `/api/*` responden 500 con `connect ECONNREFUSED`. La página se ve, pero no se puede ni crear la clave: parece que la app "no arranca". No quitar esa variable.
- **Ninguna etiqueta de documento puede quedar dentro del JS.** Las plantillas de contratos, informes y fichas arman HTML completo, así que el código lleva `</head>`, `</body>` y `</html>` escritos tal cual. Dentro de un `<script>` en línea eso rompe la página: cualquier herramienta que recorra el HTML buscando esas etiquetas (el proxy del preview lo hace) encuentra primero las de adentro del código, inyecta ahí y parte el script — la app queda en blanco con `SyntaxError`. `build.mjs` las escribe escapadas (`<\/head>`), así que no hay que hacer nada al agregar plantillas nuevas; solo no volver a meter esas etiquetas "a mano" en el HTML servido.
- **Datos locales:** `.netlify/blobs-serve/` (no versionado) es la base de datos del sandbox. Borrar sus carpetas `entries` y `metadata` deja la app como recién instalada (vuelve a pedir crear la clave). Al crear la cuenta la app siembra un espacio de trabajo de ejemplo: es comportamiento propio de la app, no datos de prueba del entorno.
- **Claves y secretos:** las leen las funciones con `Netlify.env`, llegan por `/run/base44/app.env` (fuera del repo). `ANTHROPIC_API_KEY` para todas las pantallas de IA; `RESEND_API_KEY` + `CORREO_REMITENTE` para los correos de acceso; `KHIPU_API_KEY` para los cobros; `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX` como respaldo opcional de la investigación de mercado. Sin `ANTHROPIC_API_KEY`, las rutas de IA responden 503 con un mensaje claro: eso **no** es una falla de la app.
- No hay overrides atados a `BASE44_PREVIEW_MODE`: la app se comporta igual dentro y fuera del sandbox (todo es mismo origen, sin allowlists de host/origen que ampliar). Lo único específico del sandbox es el compose.

## Cómo comprobar que quedó bien

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/                    # 200
curl -s -X POST http://localhost:3000/api/acceso \
  -H 'Content-Type: application/json' -d '{"accion":"estado"}'                     # JSON de la app, no un 500
curl -s http://localhost:3000/version.txt                                          # igual a window.__APV de la página
```

En el navegador: aparece la pantalla de acceso, se crea la clave y se entra al panel (Inicio con las tarjetas). Si la página queda **en blanco**, mirar la consola: un `SyntaxError` ahí significa que algo volvió a partir el `<script>` en línea (ver la nota de arriba).

Antes de dar por bueno un cambio: `node build.mjs` debe terminar con "Build listo" y la página debe abrir sin errores de consola ni llamadas `/api/*` fallidas (salvo las 503 propias de las funciones de IA sin clave).
