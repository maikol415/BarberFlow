// Sesión de WhatsApp (Baileys) guardada en PostgreSQL para que sobreviva reinicios y redeploys.
//
// Render borra el disco en cada deploy o cuando el plan gratuito apaga el servicio, así que la
// carpeta ./auth_info_baileys se perdía y había que volver a escanear el QR. Aquí se guarda lo
// mismo que guarda useMultiFileAuthState (creds + llaves de Signal), serializado con BufferJSON,
// en una tabla de la misma base de datos que usa la API (DATABASE_URL), una sesión por BARBERIA_SLUG.
//
// Sin DATABASE_URL (desarrollo local) se sigue usando la carpeta de archivos de siempre.

import fs from 'fs';
import { BufferJSON, initAuthCreds, proto, useMultiFileAuthState } from '@whiskeysockets/baileys';

const TABLA = 'bot_whatsapp_sesion';

// Acepta los dos formatos que acepta la API: URI (postgres://usuario:clave@host:puerto/db)
// o cadena ADO.NET (Host=...;Port=...;Database=...;Username=...;Password=...).
export function configuracionPg(databaseUrl) {
  const url = String(databaseUrl || '').trim();
  let config;
  if (/^postgres(ql)?:\/\//i.test(url)) {
    const u = new URL(url);
    config = {
      host: u.hostname,
      port: Number(u.port) || 5432,
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password)
    };
  } else {
    const partes = {};
    for (const par of url.split(';')) {
      const i = par.indexOf('=');
      if (i > 0) partes[par.slice(0, i).trim().toLowerCase().replace(/\s+/g, '')] = par.slice(i + 1).trim();
    }
    config = {
      host: partes.host || partes.server,
      port: Number(partes.port) || 5432,
      database: partes.database || 'postgres',
      user: partes.username || partes.userid || partes.user,
      password: partes.password
    };
  }
  if (!config.host) throw new Error('DATABASE_URL no tiene host');

  // Igual que la API (SSL Mode=Require; Trust Server Certificate=true): SSL salvo en localhost.
  const local = ['localhost', '127.0.0.1', '::1'].includes(config.host);
  const ssl = process.env.DATABASE_SSL === '0' ? false : process.env.DATABASE_SSL === '1' ? true : !local;
  config.ssl = ssl ? { rejectUnauthorized: false } : false;
  return config;
}

async function crearTabla(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLA} (
      sesion      TEXT        NOT NULL,
      clave       TEXT        NOT NULL,
      valor       TEXT        NOT NULL,
      actualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (sesion, clave)
    )`);
  // Son las llaves privadas de la cuenta de WhatsApp: en Supabase la tabla no debe quedar
  // expuesta por la API REST pública. Con RLS activo y sin políticas solo el dueño (el bot) la lee.
  await pool.query(`ALTER TABLE ${TABLA} ENABLE ROW LEVEL SECURITY`);
  await pool.query(`
    DO $$
    DECLARE r TEXT;
    BEGIN
      FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE ALL ON ${TABLA} FROM %I', r);
        END IF;
      END LOOP;
    END $$`);
}

/**
 * Mismo contrato que useMultiFileAuthState de Baileys ({ state, saveCreds }), sobre PostgreSQL.
 * `cola` serializa todas las escrituras para que se apliquen en el orden en que Baileys las pide.
 */
export async function usePostgresAuthState(pool, sesion, cola = crearCola()) {
  let activo = true;

  const leer = async (clave) => {
    const { rows } = await pool.query(`SELECT valor FROM ${TABLA} WHERE sesion = $1 AND clave = $2`, [sesion, clave]);
    return rows.length ? JSON.parse(rows[0].valor, BufferJSON.reviver) : null;
  };

  // escrituras: [{ clave, valor }] (valor null = borrar)
  const escribir = (escrituras) => cola(async () => {
    if (!activo || !escrituras.length) return;
    const guardar = escrituras.filter(e => e.valor != null);
    const borrar = escrituras.filter(e => e.valor == null).map(e => e.clave);
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      if (guardar.length) {
        await cliente.query(
          `INSERT INTO ${TABLA} (sesion, clave, valor, actualizado)
           SELECT $1, c, v, now() FROM unnest($2::text[], $3::text[]) AS t(c, v)
           ON CONFLICT (sesion, clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado = now()`,
          [sesion, guardar.map(e => e.clave), guardar.map(e => JSON.stringify(e.valor, BufferJSON.replacer))]
        );
      }
      if (borrar.length) {
        await cliente.query(`DELETE FROM ${TABLA} WHERE sesion = $1 AND clave = ANY($2::text[])`, [sesion, borrar]);
      }
      await cliente.query('COMMIT');
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      cliente.release();
    }
  });

  const creds = (await leer('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const datos = {};
          for (const id of ids) datos[id] = null;
          if (!ids.length) return datos;
          const { rows } = await pool.query(
            `SELECT clave, valor FROM ${TABLA} WHERE sesion = $1 AND clave = ANY($2::text[])`,
            [sesion, ids.map(id => `${tipo}-${id}`)]
          );
          for (const fila of rows) {
            const id = fila.clave.slice(tipo.length + 1);
            let valor = JSON.parse(fila.valor, BufferJSON.reviver);
            if (tipo === 'app-state-sync-key' && valor) valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            datos[id] = valor;
          }
          return datos;
        },
        set: async (data) => {
          const escrituras = [];
          for (const tipo in data) {
            for (const id in data[tipo]) escrituras.push({ clave: `${tipo}-${id}`, valor: data[tipo][id] || null });
          }
          await escribir(escrituras);
        }
      }
    },
    saveCreds: () => escribir([{ clave: 'creds', valor: creds }]),
    // Tras un reset, el socket viejo ya no debe poder volver a escribir su sesión
    desactivar: () => { activo = false; }
  };
}

function crearCola() {
  let ultima = Promise.resolve();
  return (tarea) => {
    const resultado = ultima.then(tarea);
    ultima = resultado.catch(() => {});
    return resultado;
  };
}

/**
 * Elige dónde vive la sesión: PostgreSQL si hay DATABASE_URL, si no la carpeta local.
 * Devuelve { descripcion, cargarEstado(), borrarSesion() }.
 */
export async function crearAlmacenSesion({ databaseUrl, sesion, carpeta = './auth_info_baileys' }) {
  if (!databaseUrl) {
    return {
      descripcion: `archivos (${carpeta})`,
      cargarEstado: () => useMultiFileAuthState(carpeta),
      borrarSesion: async () => { fs.rmSync(carpeta, { recursive: true, force: true }); }
    };
  }

  // Import dinámico: en local sin DATABASE_URL no hace falta tener instalado `pg`
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ ...configuracionPg(databaseUrl), max: 3, idleTimeoutMillis: 30000, keepAlive: true });
  // Supabase cierra conexiones inactivas; sin este handler el proceso se caería
  pool.on('error', (err) => console.error('[Sesión PostgreSQL] Conexión perdida:', err.message));

  const cola = crearCola();
  let estadoActual = null;
  let tablaLista = null;
  const asegurarTabla = () => (tablaLista ||= crearTabla(pool).catch(err => { tablaLista = null; throw err; }));

  return {
    descripcion: `PostgreSQL (tabla ${TABLA}, sesión "${sesion}")`,
    cargarEstado: async () => {
      await asegurarTabla();
      // Al reconectar, esperar a que terminen las escrituras del socket anterior antes de leer
      await cola(async () => {});
      estadoActual = await usePostgresAuthState(pool, sesion, cola);
      return estadoActual;
    },
    borrarSesion: async () => {
      estadoActual?.desactivar();
      estadoActual = null;
      await asegurarTabla();
      // En la misma cola: se ejecuta después de cualquier escritura pendiente del socket viejo.
      // Las claves "bf-…" (qué número tiene cada chat @lid de los clientes) no son de la sesión:
      // se conservan para que, tras volver a vincular WhatsApp, el bot siga reconociendo a los clientes.
      await cola(() => pool.query(`DELETE FROM ${TABLA} WHERE sesion = $1 AND clave NOT LIKE 'bf-%'`, [sesion]));
    },
    pool
  };
}
