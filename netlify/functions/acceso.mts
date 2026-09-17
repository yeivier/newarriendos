import type { Config, Context } from '@netlify/functions'
import {
  crearSesion, cerrarSesion, guardarConfig, huella, iguales, leerConfig, nuevoId, quienLlama, sinAcceso, soloDueno,
  type Rol,
} from '../lib/auth.mts'

// Puerta de entrada de la plataforma.
//
// POST /api/acceso  { accion: ... }
//   estado          -> { configurada }              (¿ya hay clave creada?)
//   crear           -> { token, rol, nombre }       (primera vez: define la clave)
//   entrar          -> { token, rol, nombre }
//   salir           -> { ok }
//   cambiar         -> { ok }                       (cambia la clave del dueño)
//   accesos         -> { accesos }                  (lista de invitados)
//   crear_acceso    -> { accesos }
//   borrar_acceso   -> { accesos }

const CLAVE_MIN = 6
const publico = (a: any) => ({ id: a.id, nombre: a.nombre, rol: a.rol, creado: a.creado, usuario: a.usuario || '' })
// Normaliza el usuario (correo, alias o nombre) para compararlo sin
// importar mayúsculas, tildes ni espacios de más.
const SIN_TILDE: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n' }
const norm = (s: string) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .split('')
    .map((c) => SIN_TILDE[c] || c)
    .join('')

export default async (req: Request, _context: Context) => {
  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Cuerpo inválido' }, { status: 400 })
  }
  const accion = String(body.accion || '')
  const clave = String(body.clave || '')
  const config = await leerConfig()

  if (accion === 'estado') {
    return Response.json({ configurada: !!config })
  }

  if (accion === 'crear') {
    if (config) return Response.json({ error: 'La clave ya está creada. Ingresa con ella.' }, { status: 409 })
    if (clave.length < CLAVE_MIN) {
      return Response.json({ error: `La clave debe tener al menos ${CLAVE_MIN} caracteres` }, { status: 400 })
    }
    const salt = nuevoId()
    const usuario = String(body.usuario || '').trim() || undefined
    await guardarConfig({ salt, hash: await huella(clave, salt), creado: Date.now(), invitados: [], usuario })
    const nombre = String(body.nombre || 'Propietario')
    return Response.json({ token: await crearSesion('dueño', nombre), rol: 'dueño', nombre })
  }

  if (accion === 'entrar') {
    if (!config) return Response.json({ error: 'Todavía no hay clave creada', codigo: 'sin_clave' }, { status: 404 })
    const usuario = norm(body.usuario)

    // Si escribió el usuario (correo, alias o nombre), se busca ESA persona
    // y solo se comprueba su clave: así dos personas pueden repetir clave
    // sin pisarse. Si no coincide con nadie, se sigue igual que antes.
    if (usuario) {
      if (config.usuario && norm(config.usuario) === usuario) {
        if (iguales(await huella(clave, config.salt), config.hash)) {
          const nombre = 'Propietario'
          return Response.json({ token: await crearSesion('dueño', nombre), rol: 'dueño', nombre })
        }
        await new Promise((r) => setTimeout(r, 400))
        return Response.json({ error: 'Clave incorrecta' }, { status: 401 })
      }
      const inv = config.invitados.find((x) => x.usuario && norm(x.usuario) === usuario)
      if (inv) {
        if (iguales(await huella(clave, inv.salt), inv.hash)) {
          return Response.json({ token: await crearSesion(inv.rol, inv.nombre), rol: inv.rol, nombre: inv.nombre })
        }
        await new Promise((r) => setTimeout(r, 400))
        return Response.json({ error: 'Clave incorrecta' }, { status: 401 })
      }
      // No hay nadie con ese usuario: cae al modo de antes, solo por clave.
    }

    if (iguales(await huella(clave, config.salt), config.hash)) {
      const nombre = 'Propietario'
      return Response.json({ token: await crearSesion('dueño', nombre), rol: 'dueño', nombre })
    }
    for (const inv of config.invitados) {
      if (iguales(await huella(clave, inv.salt), inv.hash)) {
        return Response.json({ token: await crearSesion(inv.rol, inv.nombre), rol: inv.rol, nombre: inv.nombre })
      }
    }
    // Un pequeño retardo desalienta probar claves una tras otra.
    await new Promise((r) => setTimeout(r, 400))
    return Response.json({ error: 'Clave incorrecta' }, { status: 401 })
  }

  const yo = await quienLlama(req)

  if (accion === 'salir') {
    if (yo) await cerrarSesion(yo.token)
    return Response.json({ ok: true })
  }

  if (!yo) return sinAcceso()

  if (accion === 'yo') return Response.json({ rol: yo.rol, nombre: yo.nombre })

  if (accion === 'accesos') {
    return Response.json({ accesos: (config?.invitados || []).map(publico), usuario: config?.usuario || '' })
  }

  // De aquí en adelante, solo el dueño.
  if (yo.rol !== 'dueño') return soloDueno()
  if (!config) return Response.json({ error: 'Falta crear la clave' }, { status: 409 })

  if (accion === 'usuario') {
    const usuario = String(body.usuario || '').trim()
    if (usuario) {
      const tomado = config.invitados.some((x) => x.usuario && norm(x.usuario) === norm(usuario))
      if (tomado) return Response.json({ error: 'Ese usuario ya lo tiene otra persona' }, { status: 409 })
    }
    await guardarConfig({ ...config, usuario: usuario || undefined })
    return Response.json({ ok: true, usuario })
  }

  if (accion === 'cambiar') {
    if (!iguales(await huella(String(body.actual || ''), config.salt), config.hash)) {
      return Response.json({ error: 'La clave actual no coincide' }, { status: 401 })
    }
    const nueva = String(body.nueva || '')
    if (nueva.length < CLAVE_MIN) {
      return Response.json({ error: `La clave debe tener al menos ${CLAVE_MIN} caracteres` }, { status: 400 })
    }
    const salt = nuevoId()
    await guardarConfig({ ...config, salt, hash: await huella(nueva, salt) })
    return Response.json({ ok: true })
  }

  if (accion === 'crear_acceso') {
    const nombre = String(body.nombre || '').trim()
    const rol: Rol = body.rol === 'dueño' ? 'dueño' : body.rol === 'arquitecto' ? 'arquitecto' : 'lectura'
    if (!nombre) return Response.json({ error: 'Ponle un nombre a este acceso' }, { status: 400 })
    if (clave.length < CLAVE_MIN) {
      return Response.json({ error: `La clave debe tener al menos ${CLAVE_MIN} caracteres` }, { status: 400 })
    }
    const usuario = String(body.usuario || '').trim()
    if (usuario) {
      const tomado =
        (config.usuario && norm(config.usuario) === norm(usuario)) ||
        config.invitados.some((x) => x.usuario && norm(x.usuario) === norm(usuario))
      if (tomado) return Response.json({ error: 'Ese usuario ya lo tiene otra persona' }, { status: 409 })
    }
    const salt = nuevoId()
    const inv = {
      id: nuevoId().slice(0, 12),
      nombre,
      rol,
      salt,
      hash: await huella(clave, salt),
      creado: Date.now(),
      usuario: usuario || undefined,
    }
    const invitados = [...config.invitados, inv]
    await guardarConfig({ ...config, invitados })
    return Response.json({ accesos: invitados.map(publico) })
  }

  if (accion === 'borrar_acceso') {
    const invitados = config.invitados.filter((a) => a.id !== String(body.id || ''))
    await guardarConfig({ ...config, invitados })
    return Response.json({ accesos: invitados.map(publico) })
  }

  return Response.json({ error: 'Acción desconocida' }, { status: 400 })
}

export const config: Config = {
  path: '/api/acceso',
  method: ['POST'],
}
