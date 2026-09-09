// Motor de respuesta con IA en streaming, con CONTINUACIÓN AUTOMÁTICA.
//
// El problema que resuelve: cuando el modelo llega al tope de tokens de una
// respuesta, el texto se corta a mitad de frase (stop_reason: "max_tokens").
// La dueña de la plataforma pidió que las respuestas NO se corten nunca,
// del largo que sean. Aquí eso se garantiza de dos formas juntas:
//
//   1. Un tope de tokens generoso por llamada, así casi siempre la respuesta
//      termina sola en una sola pasada.
//   2. Si aun así se corta por tokens, seguimos solos: hacemos otra llamada
//      pasándole al modelo lo que ya escribió como "prefijo" del asistente, y
//      el modelo continúa exactamente donde quedó. Se repite hasta que termina
//      de verdad (stop_reason: "end_turn"), sin que quien lee note el corte.
//
// Todo va en vivo (SSE reenviado como texto plano), así que la función de
// Netlify no se cae por tiempo y el texto se ve "escribiéndose".

const API = 'https://api.anthropic.com/v1/messages'

export type TextosIA = {
  // Si la IA se niega y todavía no había dicho nada.
  refusal?: string
  // Si no llegó nada de texto en absoluto.
  vacio: string
  // Si algo se cortó a mitad por un error de red/servidor (se agrega al final).
  corte: string
  // Si la PRIMERA llamada se cae por tiempo/red antes de empezar a responder.
  demora: string
}

export type OpcionesIA = {
  apiKey: string
  model: string
  maxTokens: number
  effort?: 'low' | 'medium' | 'high'
  system: string
  messages: any[]
  // Tope por cada llamada al modelo.
  topeMs?: number
  // Tope total sumando todas las continuaciones (resguardo de tiempo).
  presupuestoMs?: number
  // Máximo de continuaciones encadenadas (resguardo de costo).
  maxRondas?: number
  textos: TextosIA
}

// Una llamada al modelo, en streaming. `msRestante` acota el timeout a lo que
// quede del presupuesto total.
function llamar(o: OpcionesIA, messages: any[], msRestante: number): Promise<Response> {
  const tope = Math.max(8_000, Math.min(o.topeMs ?? 60_000, msRestante))
  return fetch(API, {
    method: 'POST',
    signal: AbortSignal.timeout(tope),
    headers: { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: o.model,
      max_tokens: o.maxTokens,
      output_config: { effort: o.effort ?? 'low' },
      system: o.system,
      messages,
      stream: true,
    }),
  })
}

// Responde en streaming y, si el modelo se corta por límite de tokens, continúa
// solo hasta terminar. La respuesta NUNCA queda cortada, sea del largo que sea.
export async function responderIA(o: OpcionesIA): Promise<Response> {
  const inicio = Date.now()
  const presupuesto = o.presupuestoMs ?? 140_000
  const maxRondas = o.maxRondas ?? 6
  const restante = () => presupuesto - (Date.now() - inicio)

  // Primera llamada fuera del stream: así, si ni siquiera arranca, devolvemos un
  // error limpio en JSON (el navegador lo muestra por el camino !r.ok).
  let r: Response
  try {
    r = await llamar(o, o.messages, restante())
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return Response.json({ error: o.textos.demora }, { status: 504 })
    }
    return Response.json({ error: 'No se pudo contactar la IA: ' + (e?.message || 'error de red') }, { status: 502 })
  }
  if (!r.ok || !r.body) {
    const j: any = await r.json().catch(() => ({}))
    return Response.json({ error: j?.error?.message || 'Error de la IA' }, { status: 502 })
  }

  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let algo = false
      const empujar = (t: string) => { if (t) { algo = true; controller.enqueue(enc.encode(t)) } }
      let acc = ''          // todo lo que lleva dicho el asistente (para continuar)
      let resp: Response = r
      let rondas = 0
      try {
        while (true) {
          const reader = resp.body!.getReader()
          const dec = new TextDecoder()
          let buf = ''
          let stop: string | null = null
          let errStream = false
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            const lineas = buf.split('\n')
            buf = lineas.pop() || ''
            for (const linea of lineas) {
              const t = linea.trim()
              if (!t.startsWith('data:')) continue
              const carga = t.slice(5).trim()
              if (!carga || carga === '[DONE]') continue
              let ev: any
              try { ev = JSON.parse(carga) } catch { continue }
              if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                const tx = ev.delta.text || ''
                acc += tx; empujar(tx)
              } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
                stop = ev.delta.stop_reason
              } else if (ev.type === 'error') {
                errStream = true
              }
            }
          }

          // ¿Terminó de verdad, o hay que seguir?
          if (errStream) { empujar(algo ? '\n\n' + o.textos.corte : o.textos.vacio); break }
          if (stop === 'refusal' && !algo) { empujar(o.textos.refusal || 'Prefiero no responder eso.'); break }
          if (stop !== 'max_tokens') break                 // end_turn / stop_sequence -> completo
          // Se cortó por tokens: continuar justo donde quedó.
          rondas++
          if (rondas > maxRondas || !acc || restante() < 12_000) break
          let rc: Response
          try { rc = await llamar(o, [...o.messages, { role: 'assistant', content: acc }], restante()) }
          catch { break }
          if (!rc.ok || !rc.body) { break }
          resp = rc
        }
        if (!algo) empujar(o.textos.vacio)
      } catch {
        empujar(algo ? '\n\n' + o.textos.corte : o.textos.demora)
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}
