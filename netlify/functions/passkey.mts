import type { Config, Context } from '@netlify/functions'
import { getStore } from '@netlify/blobs'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { crearSesion, nuevoId, quienLlama, sinAcceso, type Rol } from '../lib/auth.mts'

// Entrar con Face ID / Touch ID (llaves de acceso, "passkeys").
//
// En vez de escribir una clave, el teléfono guarda una llave secreta que solo
// se desbloquea con la cara o la huella de su dueño. La llave secreta nunca
// sale del teléfono: lo único que viaja es una firma que el servidor verifica
// con la parte pública. Por eso no hay nada que se pueda robar de aquí, ni
// clave que adivinar, ni nada que anotar.
//
// La clave sigue existiendo: es la que se usa para activar Face ID la primera
// vez y la que queda de respaldo si se pierde el teléfono.
//
// POST /api/passkey  { accion: ... }
//   activar_opciones  -> reto para registrar este dispositivo   (requiere sesión)
//   activar           -> guarda la llave de este dispositivo    (requiere sesión)
//   entrar_opciones   -> reto para entrar                       (sin sesión)
//   entrar            -> { token, rol, nombre }                 (sin sesión)
//   dispositivos      -> lista de dispositivos activados        (requiere sesión)
//   olvidar           -> borra un dispositivo                   (requiere sesión)
//   hay               -> { hay } ¿alguien activó Face ID aquí?  (sin sesión)

const TIENDA_LLAVES = 'app-passkeys'
const TIENDA_RETOS = 'app-passkey-retos'
const RETO_VIVE = 5 * 60 * 1000 // 5 minutos para completar el gesto
const NOMBRE_APP = 'ArriendoPro'

type Llave = {
  id: string // credentialID (base64url)
  publica: string // clave pública (base64url)
  contador: number
  transportes: string[]
  rol: Rol
  nombre: string // de quién es la sesión que abre
  dispositivo: string // cómo llamarle en la lista ("iPhone de Javier")
  creado: number
  ultimoUso: number
}

const llaves = () => getStore({ name: TIENDA_LLAVES, consistency: 'strong' })
const retos = () => getStore({ name: TIENDA_RETOS, consistency: 'strong' })

/** El dominio manda: una llave creada en un dominio no sirve en otro. */
const dominio = (req: Request) => {
  const u = new URL(req.url)
  return { rpID: u.hostname, origen: u.origin }
}

async function guardarReto(reto: string) {
  const id = nuevoId()
  await retos().setJSON(id, { reto, exp: Date.now() + RETO_VIVE })
  return id
}

/** Un reto se usa una sola vez: se lee y se borra en el mismo acto. */
async function tomarReto(id: string): Promise<string | null> {
  if (!id) return null
  const r = (await retos().get(id, { type: 'json' }).catch(() => null)) as { reto: string; exp: number } | null
  await retos().delete(id).catch(() => {})
  if (!r || !r.exp || r.exp < Date.now()) return null
  return r.reto
}

async function listar(): Promise<Llave[]> {
  const { blobs } = await llaves().list().catch(() => ({ blobs: [] as { key: string }[] }))
  const todas = await Promise.all(blobs.map((b) => llaves().get(b.key, { type: 'json' }).catch(() => null)))
  return (todas.filter(Boolean) as Llave[]).sort((a, b) => a.creado - b.creado)
}

const publica = (l: Llave) => ({
  id: l.id,
  dispositivo: l.dispositivo,
  nombre: l.nombre,
  rol: l.rol,
  creado: l.creado,
  ultimoUso: l.ultimoUso,
})

/** Nombre para reconocer el dispositivo en la lista, sacado del navegador. */
function comoSeLlama(ua: string) {
  const s = String(ua || '')
  if (/iPhone/i.test(s)) return 'iPhone'
  if (/iPad/i.test(s)) return 'iPad'
  if (/Macintosh|Mac OS X/i.test(s)) return 'Mac'
  if (/Android/i.test(s)) return 'Teléfono Android'
  if (/Windows/i.test(s)) return 'Computador Windows'
  return 'Este dispositivo'
}

export default async (req: Request, _context: Context) => {
  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }
  const accion = String(body.accion || '')
  const { rpID, origen } = dominio(req)

  // ---- Sin sesión: solo lo necesario para entrar --------------------------

  if (accion === 'hay') {
    // La pantalla de ingreso pregunta esto para saber si mostrar el botón.
    // No dice de quién es ninguna llave, solo si hay alguna.
    const { blobs } = await llaves().list().catch(() => ({ blobs: [] as { key: string }[] }))
    return Response.json({ hay: blobs.length > 0 })
  }

  if (accion === 'entrar_opciones') {
    const opciones = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required', // la cara o la huella, no basta con tener el aparato
    })
    return Response.json({ opciones, reto: await guardarReto(opciones.challenge) })
  }

  if (accion === 'entrar') {
    const esperado = await tomarReto(String(body.reto || ''))
    if (!esperado) return Response.json({ error: 'Se demoró demasiado. Inténtalo otra vez.' }, { status: 400 })

    const respuesta = body.respuesta
    const id = String(respuesta?.id || '')
    const llave = (await llaves().get(id, { type: 'json' }).catch(() => null)) as Llave | null
    if (!llave) return Response.json({ error: 'Este dispositivo no está activado' }, { status: 401 })

    let v
    try {
      v = await verifyAuthenticationResponse({
        response: respuesta,
        expectedChallenge: esperado,
        expectedOrigin: origen,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: llave.id,
          publicKey: Buffer.from(llave.publica, 'base64url'),
          counter: llave.contador,
          transports: llave.transportes as any,
        },
      })
    } catch (e: any) {
      return Response.json({ error: 'No se pudo verificar: ' + (e?.message || 'error') }, { status: 401 })
    }
    if (!v.verified) return Response.json({ error: 'No se pudo verificar' }, { status: 401 })

    // El contador que sube evita que sirva repetir una firma vieja.
    await llaves().setJSON(id, {
      ...llave,
      contador: v.authenticationInfo.newCounter,
      ultimoUso: Date.now(),
    })
    return Response.json({
      token: await crearSesion(llave.rol, llave.nombre),
      rol: llave.rol,
      nombre: llave.nombre,
    })
  }

  // ---- De aquí en adelante hay que haber entrado ---------------------------

  const yo = await quienLlama(req)
  if (!yo) return sinAcceso()

  if (accion === 'dispositivos') {
    const todas = await listar()
    // Cada quien ve los suyos; el dueño ve todos.
    const mias = yo.rol === 'dueño' ? todas : todas.filter((l) => l.nombre === yo.nombre)
    return Response.json({ dispositivos: mias.map(publica) })
  }

  if (accion === 'activar_opciones') {
    const todas = await listar()
    const mias = todas.filter((l) => l.nombre === yo.nombre)
    const opciones = await generateRegistrationOptions({
      rpName: NOMBRE_APP,
      rpID,
      // El identificador del usuario es su nombre de acceso: así el teléfono
      // reemplaza la llave anterior en vez de acumular una por activación.
      userID: new TextEncoder().encode(yo.nombre || 'dueño'),
      userName: yo.nombre || 'Propietario',
      userDisplayName: yo.nombre || 'Propietario',
      attestationType: 'none', // no queremos saber marca ni modelo del aparato
      authenticatorSelection: {
        residentKey: 'required', // así no hay que escribir ningún usuario
        userVerification: 'required', // cara o huella siempre
      },
      excludeCredentials: mias.map((l) => ({ id: l.id, transports: l.transportes as any })),
    })
    return Response.json({ opciones, reto: await guardarReto(opciones.challenge) })
  }

  if (accion === 'activar') {
    const esperado = await tomarReto(String(body.reto || ''))
    if (!esperado) return Response.json({ error: 'Se demoró demasiado. Inténtalo otra vez.' }, { status: 400 })

    let v
    try {
      v = await verifyRegistrationResponse({
        response: body.respuesta,
        expectedChallenge: esperado,
        expectedOrigin: origen,
        expectedRPID: rpID,
        requireUserVerification: true,
      })
    } catch (e: any) {
      return Response.json({ error: 'No se pudo activar: ' + (e?.message || 'error') }, { status: 400 })
    }
    if (!v.verified || !v.registrationInfo) return Response.json({ error: 'No se pudo activar' }, { status: 400 })

    const c = v.registrationInfo.credential
    const llave: Llave = {
      id: c.id,
      publica: Buffer.from(c.publicKey).toString('base64url'),
      contador: c.counter,
      transportes: (c.transports || []) as string[],
      rol: yo.rol,
      nombre: yo.nombre || 'Propietario',
      dispositivo: String(body.dispositivo || '').trim().slice(0, 40) || comoSeLlama(req.headers.get('user-agent') || ''),
      creado: Date.now(),
      ultimoUso: Date.now(),
    }
    await llaves().setJSON(llave.id, llave)
    const todas = await listar()
    const mias = yo.rol === 'dueño' ? todas : todas.filter((l) => l.nombre === yo.nombre)
    return Response.json({ ok: true, dispositivos: mias.map(publica) })
  }

  if (accion === 'olvidar') {
    const id = String(body.id || '')
    const llave = (await llaves().get(id, { type: 'json' }).catch(() => null)) as Llave | null
    if (!llave) return Response.json({ error: 'Ese dispositivo ya no está' }, { status: 404 })
    // Cada quien borra los suyos; el dueño puede borrar cualquiera.
    if (yo.rol !== 'dueño' && llave.nombre !== yo.nombre) {
      return Response.json({ error: 'Solo puedes quitar tus propios dispositivos' }, { status: 403 })
    }
    await llaves().delete(id).catch(() => {})
    const todas = await listar()
    const mias = yo.rol === 'dueño' ? todas : todas.filter((l) => l.nombre === yo.nombre)
    return Response.json({ ok: true, dispositivos: mias.map(publica) })
  }

  return Response.json({ error: 'Acción desconocida' }, { status: 400 })
}

export const config: Config = {
  path: '/api/passkey',
  method: ['POST'],
}
