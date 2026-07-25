import type { Context, Config } from '@netlify/functions'

// Asistente de IA de ArriendoPro (proxy seguro hacia la API de Anthropic).
// La clave nunca sale del servidor: se lee de la variable ANTHROPIC_API_KEY.
//
// POST /api/asistente
//   { system, messages:[{role,content}], files?:[{media_type,data,name}] }        -> { text }
//   { mode:"extraer", files:[{media_type,data,name}], propiedades?:[{id,nombre,direccion}] } -> { text, datos }

const API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'

type Archivo = { media_type?: string; data?: string; name?: string }

const bloqueArchivo = (f: Archivo) => {
  const media = String(f.media_type || 'image/jpeg')
  const data = String(f.data || '')
  if (media === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
  }
  return { type: 'image', source: { type: 'base64', media_type: media, data } }
}

const EXTRACCION = `Eres un lector experto de documentos inmobiliarios chilenos (contratos de arriendo, escrituras, certificados de dominio vigente, avalúos del SII, informes Equifax/DICOM e InfoCheck, liquidaciones de sueldo).
Lee los archivos adjuntos con máxima precisión y devuelve SOLO un objeto JSON válido (sin comentarios, sin markdown, sin texto adicional) con esta estructura exacta; omite las claves que el documento no permita completar con certeza:
{
 "resumen": "3 a 5 frases en español describiendo qué documento es y sus datos clave",
 "coincidenciaId": "id de la propiedad existente que coincide con el documento, o null",
 "propiedad": { "nombre": "", "direccion": "", "comuna": "", "region": "", "tipo": "", "rolSII": "", "inscripcion": "fojas/número/año y CBR", "superficieConstruida": "", "superficieTerreno": "", "dormitorios": "", "banos": "", "estacionamientos": "", "bodega": "", "anoConstruccion": "", "avaluoFiscal": "" },
 "arriendo": { "rentaUF": 0, "rentaCLP": 0, "diaPago": 0, "multaPct": 0, "fechaInicio": "AAAA-MM-DD", "fechaTermino": "AAAA-MM-DD", "reajuste": "UF|IPC" },
 "garantia": { "montoCLP": 0, "montoUF": 0, "fecha": "AAAA-MM-DD" },
 "arrendatario": { "nombre": "", "rut": "", "email": "", "telefono": "", "profesion": "", "nacionalidad": "" },
 "arrendador": { "nombre": "", "rut": "", "representante": "", "repRut": "" },
 "aval": { "nombre": "", "rut": "" },
 "antecedentes": { "equifaxScore": "", "morosidades": "", "protestos": "", "infocheckPuntaje": "", "rentaLiquida": "" }
}
Reglas: montos en números sin puntos ni signos; fechas en formato ISO AAAA-MM-DD; RUT con guion; si la renta está en UF indica rentaUF y calcula rentaCLP solo si el documento lo señala. No inventes datos.`

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Método no permitido' }, { status: 405 })
  }
  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return Response.json(
      { error: 'Falta configurar ANTHROPIC_API_KEY en Netlify (Site settings → Environment variables) y volver a desplegar' },
      { status: 503 },
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }

  const files: Archivo[] = Array.isArray(body.files) ? body.files.slice(0, 8) : []
  const adjuntos = files.filter((f) => f && f.data).map(bloqueArchivo)

  try {
    if (body.mode === 'extraer') {
      if (!adjuntos.length) return Response.json({ error: 'No llegaron archivos para analizar' }, { status: 400 })
      const hint = Array.isArray(body.propiedades) && body.propiedades.length
        ? `\nPropiedades ya existentes en la plataforma (para "coincidenciaId"): ${JSON.stringify(body.propiedades).slice(0, 4000)}`
        : ''
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: MODEL,
          // El modelo razona dentro de este mismo tope, así que dejamos holgura
          // para que el JSON de salida no se corte a la mitad.
          max_tokens: 16000,
          system: EXTRACCION + hint,
          messages: [{ role: 'user', content: [...adjuntos, { type: 'text', text: 'Extrae los datos de estos documentos según el formato indicado.' }] }],
        }),
      })
      const j: any = await r.json()
      if (!r.ok) return Response.json({ error: j?.error?.message || 'Error de la API de IA' }, { status: 502 })
      const texto = (j.content || []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n')
      const limpio = texto.replace(/```json|```/g, '').trim()
      let datos: any = null
      try {
        const ini = limpio.indexOf('{')
        const fin = limpio.lastIndexOf('}')
        datos = JSON.parse(limpio.slice(ini, fin + 1))
      } catch {
        return Response.json({ text: 'Leí el documento pero no pude estructurar los datos. Resumen:\n' + limpio.slice(0, 1200), datos: null })
      }
      return Response.json({ text: datos.resumen || 'Documento leído correctamente.', datos })
    }

    // Modo chat normal (con o sin archivos adjuntos)
    const msgs: any[] = Array.isArray(body.messages) ? body.messages.slice(-24) : []
    if (!msgs.length) return Response.json({ error: 'Sin mensajes' }, { status: 400 })
    const contenido: any[] = msgs.map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }))
    if (adjuntos.length) {
      const ult = contenido[contenido.length - 1]
      ult.content = [...adjuntos, { type: 'text', text: String(ult.content || 'Analiza los archivos adjuntos.') }]
    }
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        // Incluye el razonamiento del modelo, por eso el tope es holgado.
        max_tokens: 8192,
        system: String(body.system || 'Eres el asistente experto de la plataforma chilena de administración de propiedades ArriendoPro. Responde en español, claro, concreto y con cifras cuando corresponda.'),
        messages: contenido,
      }),
    })
    const j: any = await r.json()
    if (!r.ok) return Response.json({ error: j?.error?.message || 'Error de la API de IA' }, { status: 502 })
    if (j.stop_reason === 'refusal') {
      return Response.json({ text: 'No puedo responder esa consulta. Reformúlala o pregunta algo distinto sobre tus propiedades.' })
    }
    const texto = (j.content || []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n')
    return Response.json({ text: texto || 'Sin respuesta.' })
  } catch (e: any) {
    return Response.json({ error: 'No se pudo contactar la IA: ' + (e?.message || 'error de red') }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/asistente',
  method: ['POST'],
}
