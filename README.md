# Bandeja — backend real

App de pádel (jugadores + panel de administración de clubes), con un backend
propio en Node.js + Express, y una base de datos real en la nube (Turso,
compatible con SQLite) — con contraseñas encriptadas y sesiones reales, para
que se pueda alojar gratis en cualquier servidor.

## Estructura

```
bandeja-app/
  server.js       -> servidor Express (API + sirve las dos webs)
  db.js           -> conexión a Turso, esquema de tablas y datos de ejemplo
  public/
    index.html    -> la app de jugadores
    admin.html    -> la web de administradores y clubes (página aparte)
    sw.js         -> service worker (notificaciones push del navegador)
  package.json
```

## 1. Crear la base de datos gratis en Turso

Turso es gratis (sin tarjeta) y compatible con SQLite — así no hace falta
pagar ningún disco en el servidor donde alojes la app.

1. Entrá a https://turso.tech y creá una cuenta gratis.
2. Creá una base de datos nueva (cualquier nombre, ej: `bandeja`).
3. Desde el panel de esa base, buscá:
   - La **URL de conexión** (empieza con `libsql://...`) — es tu
     `TURSO_DATABASE_URL`.
   - Un **token de acceso** (creálo si no hay uno) — es tu
     `TURSO_AUTH_TOKEN`.

Vas a necesitar estos dos valores tanto para probar en tu computadora como
para desplegar en el servidor.

## 2. Probarlo en tu computadora (antes de subirlo)

Necesitás tener [Node.js](https://nodejs.org) instalado (versión 18 o más
nueva). Después, desde una terminal, parado en la carpeta `bandeja-app`:

```bash
npm install
```

Antes de arrancar, copiá `.env.example` a un archivo nuevo llamado `.env` y
completá ahí tu `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` (y opcionalmente
`SUPERADMIN_USER` / `SUPERADMIN_PASS`). El servidor lee ese archivo solo —
no hace falta exportar nada a mano. Después:

```bash
npm start
```

Vas a ver: `Bandeja backend escuchando en el puerto 3000`.

Abrí en el navegador:
- App de jugadores: http://localhost:3000
- Web de administradores y clubes: http://localhost:3000/admin

La primera vez que arranca, crea automáticamente las tablas en Turso con 3
clubes de ejemplo y sus accesos:

| Club              | Usuario     | Contraseña |
|-------------------|-------------|------------|
| Padel Norte       | padelnorte  | padel123   |
| Set Point Pádel   | setpoint    | padel123   |
| La Bandeja Club   | labandeja   | padel123   |

Administrador de Bandeja (superadmin): usuario `admin`, contraseña
`bandeja2026` (o los valores que pongas en las variables de entorno
`SUPERADMIN_USER` / `SUPERADMIN_PASS`, ver más abajo).

**Importante:** cambiá estas contraseñas de ejemplo antes de usarlo en serio
(desde el panel de superadmin podés restablecer la contraseña de cada club).

## 3. Subir el código a GitHub

Si todavía no tenés el proyecto en GitHub:

```bash
cd bandeja-app
git init
git add .
git commit -m "Bandeja: primera version del backend"
```

Después creá un repositorio nuevo (vacío) en https://github.com/new, y seguí
las instrucciones que te da GitHub para conectarlo y subir el código
(`git remote add origin ...` y `git push -u origin main`). Si no tenés `git`
instalado, también podés arrastrar los archivos directamente desde la
interfaz web de GitHub, sin necesidad de terminal.

## 4. Desplegar en Render (gratis, sin tarjeta)

Como la base de datos ahora vive en Turso, **no hace falta agregar ningún
disco pago en Render** — el plan gratis de Render alcanza.

1. Entrá a https://render.com y creá una cuenta (podés usar tu cuenta de
   GitHub para entrar directo). No pide tarjeta para el plan gratis.
2. Click en **New +** → **Web Service**.
3. Elegí "Build and deploy from a Git repository" y conectá el repositorio
   que subiste en el paso 3.
4. Configuración del servicio:
   - **Name**: el que quieras (ej: `bandeja`)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
5. En **Environment**, agregá estas variables:
   - `TURSO_DATABASE_URL` = la URL que copiaste en el paso 1
   - `TURSO_AUTH_TOKEN` = el token que copiaste en el paso 1
   - `SUPERADMIN_USER` = el usuario que quieras para vos
   - `SUPERADMIN_PASS` = una contraseña fuerte, elegida por vos
6. Click en **Create Web Service**. Render va a instalar todo y arrancar el
   servidor solo. Cuando termine, te da una URL pública (algo como
   `https://bandeja.onrender.com`).
7. Esa es tu app real:
   - Jugadores: `https://bandeja.onrender.com`
   - Web de administradores y clubes: `https://bandeja.onrender.com/admin`

Cada vez que hagas `git push` con cambios nuevos, Render vuelve a desplegar
solo. Como los datos viven en Turso (no en el servidor), un redeploy nunca
te borra información.

**Nota sobre el plan gratis de Render:** el servicio "se duerme" después de
15 minutos sin uso, y tarda unos segundos en despertarse la primera vez que
alguien entra después de eso. No pierde datos por esto — solo tarda un poco
la primera carga.

## Notas técnicas (por si en algún momento seguimos mejorando esto)

- Los datos se actualizan entre pantallas por "polling" (la app pregunta al
  servidor cada 4-8 segundos), no en tiempo real instantáneo. Funciona bien
  para esta escala; si más adelante hace falta que sea instantáneo, se puede
  agregar WebSockets (Socket.io).
- Las contraseñas de las cuentas de club se guardan encriptadas (bcrypt) en
  la base de datos — no como texto plano.
- Las sesiones de login usan una cookie segura (`httpOnly`), no localStorage.
- La base de datos es Turso (libSQL, compatible con SQLite) — gratis hasta
  5GB y varios millones de lecturas/escrituras por mes, más que suficiente
  para este uso. Si en algún momento hace falta más, se puede pasar a un
  plan pago de Turso sin cambiar código.
- **Notificaciones push (que suenan/vibran en el celular):** avisan cuando
  alguien se une a tu partido, cuando el club confirma o rechaza tu reserva,
  y cuando te llega un mensaje de chat. No hace falta configurar nada — el
  servidor genera sus propias claves la primera vez que arranca y las guarda
  en la base de datos. Cada jugador tiene que tocar una vez el botón
  "Activar notificaciones" en su Perfil, y aceptar el permiso que le pide el
  navegador. Funciona en Chrome/Edge en Android y en computadora; en iPhone
  requiere que el jugador agregue la app a la pantalla de inicio primero
  (Safari no permite notificaciones push en una pestaña normal).
