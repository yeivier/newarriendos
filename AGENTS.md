# Notas para trabajar en este repositorio

ArriendoPro es un sitio **de Netlify**: un `index.html` (React + JSX, que el
navegador transpila con Babel) que se sirve tal cual, más funciones modernas en
`netlify/functions/*.mts` (estilo `export default (req: Request) => Response`,
con `export const config = { path, method }`). Los datos viven en **Netlify
Blobs**, no en una base de datos.

## Levantarlo en el sandbox

```bash
docker compose -f docker-compose.base44.yml up -d --build
```

- El sitio queda en el puerto **3000** (`Dockerfile.base44` + `web`).
- Dentro corre `netlify dev`, que sirve el repositorio **desde el código fuente**
  (`--dir .`) y ejecuta las funciones. Por eso una edición en `index.html` o en
  `netlify/functions/` se ve al recargar, sin recompilar ni reconstruir la imagen.
- `npm run build` (`build.mjs`) es solo el paso de compilación de Netlify: genera
  `dist/` con el JSX ya transpilado y sin Babel. **No hace falta en local** y
  `dist/` no se sirve aquí (si se sirviera, los cambios de `index.html` no se
  verían hasta volver a compilar).

### Comprobaciones rápidas

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/                       # 200 (HTML)
curl -s -X POST http://localhost:3000/api/acceso -H 'content-type: application/json' \
     -d '{"accion":"estado"}'                                                          # {"configurada":…}
curl -s http://localhost:3000/api/estado                                               # 401: la puerta de acceso funciona
```

El `healthcheck` del compose hace exactamente eso: comprueba que el HTML se sirva
de verdad y que `POST /api/acceso` (que lee Netlify Blobs) responda 200.

## Particularidades que cuestan tiempo si no se saben

- **Datos en disco, dentro del repo**: Netlify Blobs se emula en `.netlify/`
  (`.netlify/blobs-serve`, `db/`). Ahí quedan los accesos, propiedades, chat,
  aportes y archivos. Borrar esa carpeta es borrar los datos de la plataforma.
- **`NODE_OPTIONS=--dns-result-order=ipv4first` no es opcional.** Dentro del
  contenedor `localhost` resuelve primero a `::1`; el servidor interno que
  ejecuta cada función escuchaba en `::1` y el resto de `netlify dev` lo llamaba
  en `127.0.0.1`, así que toda `/api/*` devolvía **500 con ECONNREFUSED**. Si se
  quita esa variable, las funciones vuelven a fallar.
- **Sin clave de dueño todavía**: en un Blobs vacío la app abre en la pantalla de
  "Crear clave y entrar" (`POST /api/acceso {accion:"crear"}`). Cualquiera que
  entre a la previsualización puede crear esa clave; queda guardada en Blobs.
- **Secretos**: las funciones leen sus claves con `Netlify.env.get(...)` desde
  `/run/base44/app.env` (fuera del repo). El sitio **arranca sin ellas**: donde
  hacen falta responden 503 con un aviso, o modo demo (por ejemplo `codigo.mts`
  devuelve el código en pantalla cuando no hay `RESEND_API_KEY`). Claves que
  existen: `ANTHROPIC_API_KEY` (IA), `RESEND_API_KEY` + `CORREO_REMITENTE`
  (correo), `KHIPU_API_KEY` (pagos por transferencia), `GEMINI_API_KEY`,
  `GROQ_API_KEY`, `OPENROUTER_API_KEY` (respaldo gratuito de IA),
  `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX` (investigación de mercado).
- **Rutas**: además de `/api/*`, hay funciones con ruta propia (`/p/:id`, `/m/*`,
  `/a/*`, `/llenar/:id`). La carpeta `levantamiento/` es otra página estática.
  `ficha-dominio/` es un proyecto aparte (solo redirecciones), no forma parte del
  sitio principal.
