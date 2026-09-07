const { createClient } = require("@libsql/client");
const bcrypt = require("bcryptjs");

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error(
    "Faltan las variables de entorno TURSO_DATABASE_URL y/o TURSO_AUTH_TOKEN. " +
    "Creá una base gratis en https://turso.tech y agregalas antes de arrancar el servidor."
  );
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  photo TEXT,
  category TEXT,
  side TEXT,
  zona TEXT,
  playingNow TEXT DEFAULT '',
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS friends (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  friendId TEXT NOT NULL,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  creatorId TEXT,
  creatorName TEXT,
  creatorPhoto TEXT,
  creatorCategory TEXT,
  creatorSide TEXT,
  creatorZona TEXT,
  tipo TEXT,
  fecha TEXT,
  hora TEXT,
  lugar TEXT,
  zona TEXT,
  cp TEXT,
  direccion TEXT,
  categoria TEXT,
  categoriaFlex INTEGER,
  ladoBuscado TEXT,
  notas TEXT,
  estado TEXT,
  neededSlots INTEGER,
  participantes TEXT DEFAULT '[]',
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  forUserId TEXT NOT NULL,
  type TEXT,
  requestId TEXT,
  actorName TEXT,
  requestLugar TEXT,
  requestFecha TEXT,
  requestHora TEXT,
  estado TEXT,
  timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS canchas (
  id TEXT PRIMARY KEY,
  clubId TEXT,
  club TEXT,
  cancha TEXT,
  zona TEXT,
  horaApertura TEXT,
  horaCierre TEXT,
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS noticias (
  id TEXT PRIMARY KEY,
  clubId TEXT,
  club TEXT,
  tipo TEXT,
  titulo TEXT,
  cuerpo TEXT,
  fecha TEXT,
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS clubs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zona TEXT,
  descripcion TEXT DEFAULT '',
  photo TEXT,
  membershipAlert INTEGER DEFAULT 0,
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS clubFollows (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  clubId TEXT NOT NULL,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS torneos (
  id TEXT PRIMARY KEY,
  clubId TEXT,
  clubName TEXT,
  nombre TEXT,
  categoria TEXT,
  fecha TEXT,
  cupo INTEGER,
  inscriptos TEXT DEFAULT '[]',
  rounds TEXT DEFAULT '[]',
  campeon TEXT,
  estado TEXT DEFAULT 'abierto',
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS reservas (
  id TEXT PRIMARY KEY,
  clubId TEXT,
  clubName TEXT,
  canchaNombre TEXT,
  fecha TEXT,
  hora TEXT,
  playerId TEXT,
  playerName TEXT,
  playerPhoto TEXT,
  estado TEXT DEFAULT 'pendiente',
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS clubAccounts (
  clubId TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  requestId TEXT NOT NULL,
  senderId TEXT,
  senderName TEXT,
  text TEXT,
  timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  clubId TEXT,
  createdAt INTEGER,
  expiresAt INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS pushSubscriptions (
  id TEXT PRIMARY KEY,
  playerId TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  keys TEXT NOT NULL,
  createdAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_request ON messages(requestId);
CREATE INDEX IF NOT EXISTS idx_push_player ON pushSubscriptions(playerId);
`;

// Migraciones idempotentes para bases creadas antes de sumar estas columnas.
const MIGRATIONS = [
  "ALTER TABLE clubs ADD COLUMN photo TEXT",
  "ALTER TABLE torneos ADD COLUMN rounds TEXT DEFAULT '[]'",
  "ALTER TABLE torneos ADD COLUMN campeon TEXT",
  "ALTER TABLE canchas ADD COLUMN horaApertura TEXT",
  "ALTER TABLE canchas ADD COLUMN horaCierre TEXT",
];

async function migrate() {
  await db.executeMultiple(SCHEMA);
  for (const sql of MIGRATIONS) {
    try {
      await db.execute(sql);
    } catch (e) {
      // ya existe la columna: ignorar
    }
  }
}

async function seedIfEmpty() {
  const countRes = await db.execute("SELECT COUNT(*) AS n FROM clubs");
  const n = Number(countRes.rows[0].n);
  if (n > 0) return;

  const now = Date.now();
  function isoInDays(d) {
    return new Date(now + d * 86400000).toISOString().slice(0, 10);
  }

  const writes = [
    { sql: "INSERT INTO clubs (id, name, zona, descripcion, photo, membershipAlert, updatedAt) VALUES (?,?,?,?,NULL,0,?)", args: ["padel-norte", "Padel Norte", "Núñez", "", now] },
    { sql: "INSERT INTO clubs (id, name, zona, descripcion, photo, membershipAlert, updatedAt) VALUES (?,?,?,?,NULL,0,?)", args: ["set-point-padel", "Set Point Pádel", "Vicente López", "", now] },
    { sql: "INSERT INTO clubs (id, name, zona, descripcion, photo, membershipAlert, updatedAt) VALUES (?,?,?,?,NULL,0,?)", args: ["la-bandeja-club", "La Bandeja Club", "Belgrano", "", now] },

    { sql: "INSERT INTO clubAccounts (clubId, username, passwordHash, createdAt) VALUES (?,?,?,?)", args: ["padel-norte", "padelnorte", bcrypt.hashSync("padel123", 10), now] },
    { sql: "INSERT INTO clubAccounts (clubId, username, passwordHash, createdAt) VALUES (?,?,?,?)", args: ["set-point-padel", "setpoint", bcrypt.hashSync("padel123", 10), now] },
    { sql: "INSERT INTO clubAccounts (clubId, username, passwordHash, createdAt) VALUES (?,?,?,?)", args: ["la-bandeja-club", "labandeja", bcrypt.hashSync("padel123", 10), now] },

    { sql: "INSERT INTO canchas (id, clubId, club, cancha, zona, horaApertura, horaCierre, updatedAt) VALUES (?,?,?,?,?,?,?,?)", args: [uid(), "padel-norte", "Padel Norte", "Cancha 2", "Núñez", "09:00", "23:00", now] },
    { sql: "INSERT INTO canchas (id, clubId, club, cancha, zona, horaApertura, horaCierre, updatedAt) VALUES (?,?,?,?,?,?,?,?)", args: [uid(), "set-point-padel", "Set Point Pádel", "Cancha 4", "Vicente López", "10:00", "23:30", now] },
    { sql: "INSERT INTO canchas (id, clubId, club, cancha, zona, horaApertura, horaCierre, updatedAt) VALUES (?,?,?,?,?,?,?,?)", args: [uid(), "la-bandeja-club", "La Bandeja Club", "Cancha 1", "Belgrano", "08:00", "22:00", now] },

    { sql: "INSERT INTO noticias (id, clubId, club, tipo, titulo, cuerpo, fecha, updatedAt) VALUES (?,?,?,?,?,?,?,?)", args: [uid(), "padel-norte", "Padel Norte", "torneo", "Torneo de Primavera - 4ta a 8va", "Inscribite antes del 20/9 en recepción. Cupos limitados por categoría.", isoInDays(0), now] },
    { sql: "INSERT INTO noticias (id, clubId, club, tipo, titulo, cuerpo, fecha, updatedAt) VALUES (?,?,?,?,?,?,?,?)", args: [uid(), "set-point-padel", "Set Point Pádel", "descuento", "20% off en alquiler los martes", "Válido de 14 a 18hs durante todo septiembre, presentando la app en recepción.", isoInDays(-1), now] },
    { sql: "INSERT INTO noticias (id, clubId, club, tipo, titulo, cuerpo, fecha, updatedAt) VALUES (?,?,?,?,?,?,?,?)", args: [uid(), "la-bandeja-club", "La Bandeja Club", "general", "Nueva cancha techada disponible", "Ya podés reservar la Cancha 5, techada y con luz led, para tus partidos nocturnos.", isoInDays(-3), now] },

    { sql: "INSERT INTO torneos (id, clubId, clubName, nombre, categoria, fecha, cupo, inscriptos, rounds, campeon, estado, createdAt) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'abierto',?)", args: [uid(), "padel-norte", "Padel Norte", "Torneo de Primavera", "4ta a 8va", isoInDays(14), 16, now] },
  ];

  await db.batch(writes, "write");
}

const ready = migrate()
  .then(seedIfEmpty)
  .catch((err) => {
    console.error("Error inicializando la base de datos:", err);
    throw err;
  });

module.exports = { db, uid, ready };
