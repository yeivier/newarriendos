import type { Config, Context } from '@netlify/functions'

// Lee documentos (imágenes/PDF) con Claude y devuelve los campos extraídos.
// La API key nunca sale del servidor: se lee de la variable de entorno
// ANTHROPIC_API_KEY configurada en Netlify (Site settings → Environment variables).
export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Método no permitido' }, { status: 405 })
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return Response.json(
      { error: 'Falta configurar ANTHROPIC_API_KEY en Netlify (Site configuration → Environment variables).' },
      { status: 500 },
    )
  }

  let payload: { model?: string; content?: unknown }
  try {
    payload = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo JSON inválido' }, { status: 400 })
  }

  const model = payload.model || 'claude-sonnet-5'
  const content = payload.content
  if (!Array.isArray(content) || content.length === 0) {
    return Response.json({ error: 'No se recibió contenido para analizar' }, { status: 400 })
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        messages: [{ role: 'user', content }],
      }),
    })
    const text = await r.text()
    return new Response(text, {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  } catch (e) {
    return Response.json(
      { error: 'No se pudo contactar el servicio de IA: ' + (e instanceof Error ? e.message : String(e)) },
      { status: 502 },
    )
  }
}

// Además de la ruta por omisión (/.netlify/functions/leer-documento) se publica
// en /api/leer-documento: esa es la que puede atravesar la redirección del
// dominio de la ficha, porque Netlify reserva las rutas /.netlify/*.
export const config: Config = {
  path: '/api/leer-documento',
  method: ['POST'],
}
