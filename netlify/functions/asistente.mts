import type { Context, Config } from '@netlify/functions'

const API = 'https://api.openai.com/v1/responses'
const MODEL = 'gpt-5-mini'

type Archivo = { media_type?: string; data?: string; name?: string }

const extraerTexto = (j: any): string => {
  if (typeof j?.output_text === 'string' && j.output_text.trim()) return j.output_text.trim()
  const partes: string[] = []
  for (const item of j?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === 'string') partes.push(c.text)
    }
  }
  return partes.join('\n').trim()
}

const inputArchivo = (f: Archivo) => {
  const media = String(f.media_type || '')
  const data = String(f.data || '')
  if (!data) return null
  if (media.startsWith('image/')) {
    return { type: 'input_image', image_url: `data:${media};base64,${data}` }
  }
  if (media === 'application/pdf') {
    return { type: 'input_file', filename: f.name || 'documento.pdf', file_data: `data:application/pdf;base64,${data}` }
  }
  return null
}

const EXTRACCION = `Eres un lector experto de documentos inmobiliarios chilenos. Devuelve SOLO JSON válido, sin markdown, con esta estructura:
{
 "resumen": "",
 "coincidenciaId": null,
 "propiedad": { "nombre": "", "direccion": "", "comuna": "", "region": "", "tipo": "", "rolSII": "", "inscripcion": "", "superficieConstruida": "", "superficieTerreno": "", "dormitorios": "", "banos": "", "estacionamientos": "", "bodega": "", "anoConstruccion": "", "avaluoFiscal": "" },
 "arriendo": { "rentaUF": 0, "rentaCLP": 0, "diaPago": 0, "multaPct": 0, "fechaInicio": "", "fechaTermino": "", "reajuste": "" },
 "garantia": { "montoCLP": 0, "montoUF": 0, "fecha": "" },
 "arrendatario": { "nombre": "", "rut": "", "email": "", "telefono": "", "profesion": "", "nacionalidad": "" },
 "arrendador": { "nombre": "", "rut": "", "representante": "", "repRut": "" },
 "aval": { "nombre": "", "rut": "" },
 "antecedentes": { "equifaxScore": "", "morosidades": "", "protestos": "", "infocheckPuntaje": "", "rentaLiquida": "" }
}
No inventes datos. Usa fechas AAAA-MM-DD y montos numéricos sin símbolos.`

async function llamarOpenAI(apiKey: string, payload: any) {
  const r = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.error?.message || `OpenAI respondió ${r.status}`)
  return extraerTexto(j)
}

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return Response.json({ error: 'Método no permitido' }, { status: 405 })

  const apiKey = Netlify.env.get('OPENAI_API_KEY')
  if (!apiKey) return Response.json({ error: 'Falta configurar OPENAI_API_KEY en Netlify y volver a desplegar.' }, { status: 503 })

  let body: any
  try { body = await req.json() } catch { return Response.json({ error: 'Cuerpo inválido' }, { status: 400 }) }

  const files: Archivo[] = Array.isArray(body.files) ? body.files.slice(0, 8) : []
  const adjuntos = files.map(inputArchivo).filter(Boolean)

  try {
    if (body.mode === 'extraer') {
      if (!adjuntos.length) return Response.json({ error: 'No llegaron archivos compatibles para analizar' }, { status: 400 })
      const hint = Array.isArray(body.propiedades) && body.propiedades.length
        ? `\nPropiedades existentes para coincidenciaId: ${JSON.stringify(body.propiedades).slice(0, 4000)}`
        : ''
      const text = await llamarOpenAI(apiKey, {
        model: MODEL,
        instructions: EXTRACCION + hint,
        input: [{ role: 'user', content: [...adjuntos, { type: 'input_text', text: 'Extrae los datos de los documentos.' }] }],
        max_output_tokens: 4096,
      })
      const limpio = text.replace(/```json|```/g, '').trim()
      let datos: any = null
      try {
        const ini = limpio.indexOf('{'); const fin = limpio.lastIndexOf('}')
        datos = JSON.parse(limpio.slice(ini, fin + 1))
      } catch {
        return Response.json({ text: 'Leí el documento, pero no pude estructurar los datos.\n' + limpio.slice(0, 1200), datos: null })
      }
      return Response.json({ text: datos.resumen || 'Documento leído correctamente.', datos })
    }

    const msgs: any[] = Array.isArray(body.messages) ? body.messages.slice(-24) : []
    if (!msgs.length) return Response.json({ error: 'Sin mensajes' }, { status: 400 })

    const input = msgs.map((m: any, i: number) => {
      const isLast = i === msgs.length - 1
      const content: any[] = [{ type: 'input_text', text: String(m.content ?? '') }]
      if (isLast && adjuntos.length) content.unshift(...adjuntos)
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content }
    })

    const text = await llamarOpenAI(apiKey, {
      model: MODEL,
      instructions: String(body.system || 'Eres el asistente experto de ArriendoPro, plataforma chilena de administración de propiedades. Responde en español claro, concreto y sin inventar datos.'),
      input,
      max_output_tokens: 2048,
    })
    return Response.json({ text: text || 'Sin respuesta.' })
  } catch (e: any) {
    return Response.json({ error: 'No se pudo contactar OpenAI: ' + (e?.message || 'error de red') }, { status: 502 })
  }
}

export const config: Config = { path: '/api/asistente' }
