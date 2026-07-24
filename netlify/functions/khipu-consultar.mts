import type { Config } from '@netlify/functions'

const KHIPU_BASE = 'https://payment-api.khipu.com/v3'

// Doble propósito:
//  - ?check=1            valida que la clave API configurada sea correcta.
//  - ?id=<payment_id>    consulta el estado de un cobro y responde { pagado }.
// La clave API se lee desde la variable de entorno KHIPU_API_KEY.
export default async (req: Request) => {
  const url = new URL(req.url)
  const isCheck = url.searchParams.get('check')
  const apiKey = Netlify.env.get('KHIPU_API_KEY')

  if (!apiKey) {
    const error = 'Falta configurar KHIPU_API_KEY en el servidor'
    return isCheck
      ? Response.json({ ok: false, error })
      : Response.json({ error }, { status: 500 })
  }

  // Validación de la clave: consulta la lista de bancos disponibles.
  if (isCheck) {
    try {
      const res = await fetch(`${KHIPU_BASE}/banks`, {
        headers: { 'x-api-key': apiKey },
      })
      if (res.ok) return Response.json({ ok: true })
      if (res.status === 401 || res.status === 403) {
        return Response.json({ ok: false, error: 'La clave API de Khipu no es válida' })
      }
      return Response.json({ ok: false, error: `Khipu respondió con estado ${res.status}` })
    } catch {
      return Response.json({ ok: false, error: 'No se pudo contactar a Khipu' })
    }
  }

  // Consulta del estado de un pago.
  const id = url.searchParams.get('id')
  if (!id) {
    return Response.json({ error: 'Falta el id del pago' }, { status: 400 })
  }

  let res: Response
  try {
    res = await fetch(`${KHIPU_BASE}/payments/${encodeURIComponent(id)}`, {
      headers: { 'x-api-key': apiKey },
    })
  } catch {
    return Response.json({ error: 'No se pudo contactar a Khipu' }, { status: 502 })
  }

  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    return Response.json(
      { error: data?.message || 'No se pudo consultar el pago' },
      { status: res.status },
    )
  }

  // En Khipu v3 un pago conciliado tiene status "done".
  const pagado = data?.status === 'done'
  return Response.json({ pagado, status: data?.status ?? null })
}

export const config: Config = {
  path: '/api/khipu/consultar',
  method: 'GET',
}
