import type { Context, Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

// Sirve las imágenes (fotos y panorámicas) guardadas en Netlify Blobs por la
// función `media-subir`. La ruta es /m/<clave>, por ejemplo /m/foto/abc123.jpg
export default async (req: Request, _context: Context) => {
  const path = new URL(req.url).pathname
  const key = decodeURIComponent(path.replace(/^\/m\//, ''))
  if (!key) {
    return new Response('No encontrado', { status: 404 })
  }

  const store = getStore('ficha-media')
  const res = await store.getWithMetadata(key, { type: 'arrayBuffer' })
  if (!res) {
    return new Response('No encontrado', { status: 404 })
  }

  const contentType = (res.metadata?.contentType as string) || 'image/jpeg'
  return new Response(res.data, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}

export const config: Config = {
  path: '/m/*',
  method: 'GET',
}
