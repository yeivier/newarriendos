import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

// Sirve los archivos adjuntos (videos, PDF, fotos, Word, etc.) guardados en
// Netlify Blobs por la función `archivo-subir`. La ruta es /a/<clave>.
export default async (req: Request, _context: Context) => {
  const path = new URL(req.url).pathname
  const key = decodeURIComponent(path.replace(/^\/a\//, ''))
  if (!key) {
    return new Response('No encontrado', { status: 404 })
  }

  const store = getStore('ficha-archivos')
  const res = await store.getWithMetadata(key, { type: 'arrayBuffer' })
  if (!res) {
    return new Response('No encontrado', { status: 404 })
  }

  const contentType = (res.metadata?.contentType as string) || 'application/octet-stream'
  const name = (res.metadata?.name as string) || 'archivo'
  return new Response(res.data, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${encodeURIComponent(name)}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}

export const config: Config = {
  path: '/a/*',
  method: 'GET',
}
