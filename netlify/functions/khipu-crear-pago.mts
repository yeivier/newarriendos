import type { Context, Config } from '@netlify/functions'

const KHIPU_BASE = 'https://payment-api.khipu.com/v3'

// Crea un cobro real en Khipu (transferencia bancaria automatizada) y devuelve
// el link de pago para redirigir al arrendatario. La clave API nunca sale del
// servidor: se lee desde la variable de entorno KHIPU_API_KEY.
export default async (req: Request, _context: Context) => {
  const apiKey = Netlify.env.get('KHIPU_API_KEY')
  if (!apiKey) {
    return Response.json(
      { error: 'Falta configurar KHIPU_API_KEY en el servidor' },
      { status: 500 },
    )
  }

  let payload: {
    transaction_id?: string
    amount?: number | string
    subject?: string
    body?: string
    payer_email?: string
  }
  try {
    payload = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo de la solicitud inválido' }, { status: 400 })
  }

  const amount = Math.round(Number(payload.amount))
  if (!Number.isFinite(amount) || amount <= 0) {
    return Response.json({ error: 'Monto inválido' }, { status: 400 })
  }

  const origin = new URL(req.url).origin
  const khipuBody: Record<string, unknown> = {
    amount,
    currency: 'CLP',
    subject: String(payload.subject || 'Arriendo').slice(0, 255),
    return_url: `${origin}/?khipu=ok`,
    cancel_url: `${origin}/?khipu=cancel`,
  }
  if (payload.transaction_id) khipuBody.transaction_id = String(payload.transaction_id)
  if (payload.body) khipuBody.body = String(payload.body).slice(0, 255)
  if (payload.payer_email) khipuBody.payer_email = String(payload.payer_email)

  let res: Response
  try {
    res = await fetch(`${KHIPU_BASE}/payments`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(khipuBody),
    })
  } catch {
    return Response.json({ error: 'No se pudo contactar a Khipu' }, { status: 502 })
  }

  const data: any = await res.json().catch(() => ({}))
  if (!res.ok || !data?.payment_url) {
    const msg =
      data?.message ||
      (res.status === 401 || res.status === 403
        ? 'La clave API de Khipu no es válida'
        : 'Khipu rechazó la solicitud de pago')
    return Response.json({ error: msg }, { status: res.status === 200 ? 502 : res.status })
  }

  return Response.json({
    payment_id: data.payment_id,
    payment_url: data.payment_url,
    simplified_transfer_url: data.simplified_transfer_url,
  })
}

export const config: Config = {
  path: '/api/khipu/crear-pago',
  method: 'POST',
}
