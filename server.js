require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const webpush = require("web-push");
const { db, uid, ready } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const SUPERADMIN_USER = process.env.SUPERADMIN_USER || "admin";
const SUPERADMIN_PASS = process.env.SUPERADMIN_PASS || "bandeja2026";
const SESSION_COOKIE = "bandeja_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

app.use(express.json({ limit: "3mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* ---------------- db helpers ---------------- */
async function getRow(sql, args) {
  const r = await db.execute({ sql, args: args || [] });
  return r.rows[0] || null;
}
async function getAll(sql, args) {
  const r = await db.execute({ sql, args: args || [] });
  return r.rows;
}
async function run(sql, args) {
  return db.execute({ sql, args: args || [] });
}
function asyncRoute(fn) {
  return function (req, res) {
    fn(req, res).catch(function (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: "Error del servidor." });
    });
  };
}

/* ---------------- notificaciones push ---------------- */
let VAPID_PUBLIC_KEY = "";

async function ensureVapidKeys() {
  const pub = await getRow("SELECT value FROM settings WHERE key='vapidPublicKey'");
  const priv = await getRow("SELECT value FROM settings WHERE key='vapidPrivateKey'");
  if (pub && priv) return { publicKey: pub.value, privateKey: priv.value };
  const keys = webpush.generateVAPIDKeys();
  await run("INSERT OR REPLACE INTO settings (key, value) VALUES ('vapidPublicKey', ?)", [keys.publicKey]);
  await run("INSERT OR REPLACE INTO settings (key, value) VALUES ('vapidPrivateKey', ?)", [keys.privateKey]);
  return keys;
}

async function sendPushToPlayer(playerId, payload) {
  if (!playerId || !VAPID_PUBLIC_KEY) return;
  const subs = await getAll("SELECT * FROM pushSubscriptions WHERE playerId=?", [playerId]);
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(payload));
    } catch (err) {
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        await run("DELETE FROM pushSubscriptions WHERE id=?", [s.id]).catch(() => {});
      } else {
        console.error("Error enviando push:", err && err.message);
      }
    }
  }
}

/* ---------------- helpers ---------------- */
function slugify(s) {
  const accented = "áéíóúñüÁÉÍÓÚÑÜ";
  const plain = "aeiounuAEIOUNU";
  let out = "";
  const str = String(s || "").toLowerCase();
  for (let i = 0; i < str.length; i++) {
    const idx = accented.indexOf(str[i]);
    out += idx > -1 ? plain[idx].toLowerCase() : str[i];
  }
  out = out.replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
  return out || uid();
}

async function createSession(role, clubId) {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  await run(
    "INSERT INTO sessions (token, role, clubId, createdAt, expiresAt) VALUES (?,?,?,?,?)",
    [token, role, clubId || null, now, now + SESSION_MS]
  );
  return token;
}

async function getSession(token) {
  if (!token) return null;
  const row = await getRow("SELECT * FROM sessions WHERE token = ?", [token]);
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    await run("DELETE FROM sessions WHERE token = ?", [token]);
    return null;
  }
  return row;
}

function requireAuth(role) {
  return function (req, res, next) {
    const token = req.cookies[SESSION_COOKIE];
    getSession(token)
      .then((session) => {
        if (!session || (role && session.role !== role)) {
          return res.status(401).json({ error: "No autorizado." });
        }
        req.session = session;
        next();
      })
      .catch((err) => {
        console.error(err);
        res.status(500).json({ error: "Error del servidor." });
      });
  };
}

function rowToRequest(r) {
  return { ...r, categoriaFlex: !!r.categoriaFlex, participantes: JSON.parse(r.participantes || "[]") };
}
function rowToTorneo(t) {
  return { ...t, inscriptos: JSON.parse(t.inscriptos || "[]"), rounds: JSON.parse(t.rounds || "[]"), campeon: t.campeon ? JSON.parse(t.campeon) : null };
}
function rowToClub(c) {
  return { ...c, membershipAlert: !!c.membershipAlert };
}

/* ---------------- auth ---------------- */
app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const { role, username, password } = req.body || {};
  if (!role || !username || !password) return res.status(400).json({ error: "Faltan datos." });

  if (role === "super") {
    if (username === SUPERADMIN_USER && password === SUPERADMIN_PASS) {
      const token = await createSession("super", null);
      res.cookie(SESSION_COOKIE, token, { httpOnly: true, maxAge: SESSION_MS, sameSite: "lax" });
      return res.json({ role: "super" });
    }
    return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
  }

  if (role === "club") {
    const acc = await getRow("SELECT * FROM clubAccounts WHERE username = ?", [username]);
    if (acc && bcrypt.compareSync(password, acc.passwordHash)) {
      const token = await createSession("club", acc.clubId);
      res.cookie(SESSION_COOKIE, token, { httpOnly: true, maxAge: SESSION_MS, sameSite: "lax" });
      return res.json({ role: "club", clubId: acc.clubId });
    }
    return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
  }

  return res.status(400).json({ error: "Rol inválido." });
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await run("DELETE FROM sessions WHERE token = ?", [token]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
}));

app.get("/api/auth/me", asyncRoute(async (req, res) => {
  const session = await getSession(req.cookies[SESSION_COOKIE]);
  if (!session) return res.status(401).json({ error: "No autorizado." });
  res.json({ role: session.role, clubId: session.clubId });
}));

/* ---------------- players ---------------- */
app.get("/api/players", asyncRoute(async (req, res) => {
  res.json(await getAll("SELECT * FROM players ORDER BY updatedAt DESC LIMIT 500"));
}));
app.put("/api/players/:id", asyncRoute(async (req, res) => {
  const id = req.params.id;
  const p = req.body || {};
  await run(
    `INSERT INTO players (id, name, photo, category, side, zona, playingNow, updatedAt)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, photo=excluded.photo, category=excluded.category,
       side=excluded.side, zona=excluded.zona, playingNow=excluded.playingNow, updatedAt=excluded.updatedAt`,
    [id, p.name || "", p.photo || null, p.category || "", p.side || "", p.zona || "", p.playingNow || "", Date.now()]
  );
  res.json({ ok: true });
}));

/* ---------------- friends ---------------- */
app.get("/api/friends", asyncRoute(async (req, res) => {
  res.json(await getAll("SELECT * FROM friends LIMIT 1000"));
}));
app.post("/api/friends", asyncRoute(async (req, res) => {
  const { ownerId, friendId } = req.body || {};
  if (!ownerId || !friendId) return res.status(400).json({ error: "Faltan datos." });
  const now = Date.now();
  await run("INSERT OR IGNORE INTO friends (id, owner, friendId, createdAt) VALUES (?,?,?,?)", [ownerId + "__" + friendId, ownerId, friendId, now]);
  await run("INSERT OR IGNORE INTO friends (id, owner, friendId, createdAt) VALUES (?,?,?,?)", [friendId + "__" + ownerId, friendId, ownerId, now]);
  res.json({ ok: true });
}));
app.delete("/api/friends", asyncRoute(async (req, res) => {
  const { owner, friend } = req.query;
  if (!owner || !friend) return res.status(400).json({ error: "Faltan datos." });
  await run("DELETE FROM friends WHERE id = ? OR id = ?", [owner + "__" + friend, friend + "__" + owner]);
  res.json({ ok: true });
}));

/* ---------------- requests (busqueda de partidos) ---------------- */
app.get("/api/requests", asyncRoute(async (req, res) => {
  const rows = await getAll("SELECT * FROM requests ORDER BY createdAt DESC LIMIT 300");
  res.json(rows.map(rowToRequest));
}));
app.post("/api/requests", asyncRoute(async (req, res) => {
  const d = req.body || {};
  const id = uid();
  await run(
    `INSERT INTO requests (id, creatorId, creatorName, creatorPhoto, creatorCategory, creatorSide, creatorZona,
      tipo, fecha, hora, lugar, zona, cp, direccion, categoria, categoriaFlex, ladoBuscado, notas, estado,
      neededSlots, participantes, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      d.creatorId || "",
      d.creatorName || "",
      d.creatorPhoto || null,
      d.creatorCategory || "",
      d.creatorSide || "",
      d.creatorZona || "",
      d.tipo || "rival",
      d.fecha || "",
      d.hora || "",
      d.lugar || "",
      d.zona || "",
      d.cp || "",
      d.direccion || "",
      d.categoria || "",
      d.categoriaFlex ? 1 : 0,
      d.ladoBuscado || "Indistinto",
      d.notas || "",
      "abierto",
      d.neededSlots || 1,
      "[]",
      Date.now(),
    ]
  );
  res.json({ id });
}));
app.patch("/api/requests/:id", asyncRoute(async (req, res) => {
  const patch = req.body || {};
  const fields = [];
  const args = [];
  if (patch.estado !== undefined) { fields.push("estado=?"); args.push(patch.estado); }
  if (patch.participantes !== undefined) { fields.push("participantes=?"); args.push(JSON.stringify(patch.participantes)); }
  if (!fields.length) return res.json({ ok: true });
  args.push(req.params.id);
  await run(`UPDATE requests SET ${fields.join(", ")} WHERE id=?`, args);
  res.json({ ok: true });
}));
app.post("/api/requests/:id/join", asyncRoute(async (req, res) => {
  const r = await getRow("SELECT * FROM requests WHERE id=?", [req.params.id]);
  if (!r) return res.status(404).json({ error: "Partido no encontrado." });
  const participantes = JSON.parse(r.participantes || "[]");
  const player = req.body || {};
  if (participantes.some((p) => p.id === player.id)) {
    return res.json({ estado: r.estado, participantes });
  }
  if (participantes.length >= r.neededSlots) return res.status(409).json({ error: "Ese partido ya está completo." });
  participantes.push({ id: player.id, name: player.name, category: player.category, side: player.side });
  const estado = participantes.length >= r.neededSlots ? "confirmado" : "abierto";
  await run("UPDATE requests SET participantes=?, estado=? WHERE id=?", [JSON.stringify(participantes), estado, req.params.id]);
  await run(
    `INSERT INTO activity (id, forUserId, type, requestId, actorName, requestLugar, requestFecha, requestHora, timestamp)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [uid(), r.creatorId, "join", r.id, player.name, r.lugar, r.fecha, r.hora, Date.now()]
  );
  res.json({ estado, participantes });
  sendPushToPlayer(r.creatorId, { title: "¡Se unieron a tu partido!", body: player.name + " se sumó en " + r.lugar, url: "/" }).catch(() => {});
}));

/* ---------------- activity (avisos del jugador) ---------------- */
app.get("/api/activity", asyncRoute(async (req, res) => {
  const { forUserId } = req.query;
  const rows = forUserId
    ? await getAll("SELECT * FROM activity WHERE forUserId=? ORDER BY timestamp DESC LIMIT 200", [forUserId])
    : await getAll("SELECT * FROM activity ORDER BY timestamp DESC LIMIT 200");
  res.json(rows);
}));
app.post("/api/activity", asyncRoute(async (req, res) => {
  const d = req.body || {};
  const id = uid();
  await run(
    `INSERT INTO activity (id, forUserId, type, requestId, actorName, requestLugar, requestFecha, requestHora, estado, timestamp)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, d.forUserId || "", d.type || "", d.requestId || null, d.actorName || "", d.requestLugar || "", d.requestFecha || "", d.requestHora || "", d.estado || null, Date.now()]
  );
  res.json({ id });
}));

/* ---------------- canchas (lectura publica) ---------------- */
app.get("/api/canchas", asyncRoute(async (req, res) => {
  res.json(await getAll("SELECT * FROM canchas ORDER BY cancha ASC LIMIT 300"));
}));

/* ---------------- noticias (lectura publica) ---------------- */
app.get("/api/noticias", asyncRoute(async (req, res) => {
  res.json(await getAll("SELECT * FROM noticias ORDER BY updatedAt DESC LIMIT 300"));
}));

/* ---------------- clubs (lectura publica) ---------------- */
app.get("/api/clubs", asyncRoute(async (req, res) => {
  const rows = await getAll("SELECT id, name, zona, descripcion, photo, membershipAlert, updatedAt FROM clubs LIMIT 300");
  res.json(rows.map(rowToClub));
}));

/* ---------------- clubFollows ---------------- */
app.get("/api/clubFollows", asyncRoute(async (req, res) => {
  res.json(await getAll("SELECT * FROM clubFollows LIMIT 1000"));
}));
app.post("/api/clubFollows", asyncRoute(async (req, res) => {
  const { ownerId, clubId } = req.body || {};
  if (!ownerId || !clubId) return res.status(400).json({ error: "Faltan datos." });
  await run("INSERT OR IGNORE INTO clubFollows (id, owner, clubId, createdAt) VALUES (?,?,?,?)", [ownerId + "__" + clubId, ownerId, clubId, Date.now()]);
  res.json({ ok: true });
}));
app.delete("/api/clubFollows", asyncRoute(async (req, res) => {
  const { owner, clubId } = req.query;
  if (!owner || !clubId) return res.status(400).json({ error: "Faltan datos." });
  await run("DELETE FROM clubFollows WHERE owner=? AND clubId=?", [owner, clubId]);
  res.json({ ok: true });
}));

/* ---------------- torneos ---------------- */
app.get("/api/torneos", asyncRoute(async (req, res) => {
  const rows = await getAll("SELECT * FROM torneos ORDER BY createdAt DESC LIMIT 200");
  res.json(rows.map(rowToTorneo));
}));
app.get("/api/torneos/:id", asyncRoute(async (req, res) => {
  const t = await getRow("SELECT * FROM torneos WHERE id=?", [req.params.id]);
  if (!t) return res.status(404).json({ error: "No encontrado." });
  res.json(rowToTorneo(t));
}));
app.post("/api/torneos/:id/join", asyncRoute(async (req, res) => {
  const t = await getRow("SELECT * FROM torneos WHERE id=?", [req.params.id]);
  if (!t) return res.status(404).json({ error: "Torneo no encontrado." });
  const inscriptos = JSON.parse(t.inscriptos || "[]");
  const player = req.body || {};
  if (inscriptos.some((p) => p.id === player.id)) return res.json(rowToTorneo(t));
  if (t.cupo && inscriptos.length >= t.cupo) return res.status(409).json({ error: "Sin cupo." });
  inscriptos.push({ id: player.id, name: player.name, category: player.category, side: player.side, photo: player.photo || null });
  await run("UPDATE torneos SET inscriptos=? WHERE id=?", [JSON.stringify(inscriptos), req.params.id]);
  const updated = await getRow("SELECT * FROM torneos WHERE id=?", [req.params.id]);
  res.json(rowToTorneo(updated));
}));

/* ---------------- reservas ---------------- */
app.get("/api/reservas", asyncRoute(async (req, res) => {
  const { playerId, clubId } = req.query;
  let rows;
  if (playerId) rows = await getAll("SELECT * FROM reservas WHERE playerId=? ORDER BY createdAt DESC LIMIT 300", [playerId]);
  else if (clubId) rows = await getAll("SELECT * FROM reservas WHERE clubId=? ORDER BY createdAt DESC LIMIT 300", [clubId]);
  else rows = await getAll("SELECT * FROM reservas ORDER BY createdAt DESC LIMIT 300");
  res.json(rows);
}));
app.post("/api/reservas", asyncRoute(async (req, res) => {
  const d = req.body || {};
  const id = uid();
  await run(
    `INSERT INTO reservas (id, clubId, clubName, canchaNombre, fecha, hora, playerId, playerName, playerPhoto, estado, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,'pendiente',?)`,
    [id, d.clubId || null, d.clubName || "", d.canchaNombre || "", d.fecha || "", d.hora || "", d.playerId || "", d.playerName || "", d.playerPhoto || null, Date.now()]
  );
  res.json({ id });
}));

/* ---------------- chat entre jugadores de un partido ---------------- */
app.get("/api/messages", asyncRoute(async (req, res) => {
  const { requestId } = req.query;
  const rows = requestId
    ? await getAll("SELECT * FROM messages WHERE requestId=? ORDER BY timestamp ASC LIMIT 500", [requestId])
    : await getAll("SELECT * FROM messages ORDER BY timestamp ASC LIMIT 2000");
  res.json(rows);
}));
app.post("/api/messages", asyncRoute(async (req, res) => {
  const d = req.body || {};
  if (!d.requestId || !d.senderId || !d.text || !d.text.trim()) return res.status(400).json({ error: "Faltan datos." });
  const id = uid();
  const text = String(d.text).slice(0, 2000);
  await run(
    "INSERT INTO messages (id, requestId, senderId, senderName, text, timestamp) VALUES (?,?,?,?,?,?)",
    [id, d.requestId, d.senderId, d.senderName || "", text, Date.now()]
  );
  res.json({ id });

  const reqRow = await getRow("SELECT * FROM requests WHERE id=?", [d.requestId]);
  if (reqRow) {
    const participantes = JSON.parse(reqRow.participantes || "[]");
    const recipients = new Set();
    if (reqRow.creatorId && reqRow.creatorId !== d.senderId) recipients.add(reqRow.creatorId);
    participantes.forEach((p) => { if (p.id !== d.senderId) recipients.add(p.id); });
    recipients.forEach((pid) => {
      sendPushToPlayer(pid, { title: d.senderName || "Nuevo mensaje", body: text, url: "/" }).catch(() => {});
    });
  }
}));

/* ---------------- notificaciones push ---------------- */
app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});
app.post("/api/push/subscribe", asyncRoute(async (req, res) => {
  const { playerId, subscription } = req.body || {};
  if (!playerId || !subscription || !subscription.endpoint) return res.status(400).json({ error: "Faltan datos." });
  await run(
    `INSERT INTO pushSubscriptions (id, playerId, endpoint, keys, createdAt) VALUES (?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET playerId=excluded.playerId, keys=excluded.keys`,
    [uid(), playerId, subscription.endpoint, JSON.stringify(subscription.keys || {}), Date.now()]
  );
  res.json({ ok: true });
}));

/* ---------------- club-owner authenticated routes ---------------- */
const clubAuth = requireAuth("club");

app.post("/api/my/canchas", clubAuth, asyncRoute(async (req, res) => {
  const d = req.body || {};
  const club = await getRow("SELECT * FROM clubs WHERE id=?", [req.session.clubId]);
  const id = uid();
  await run(
    `INSERT INTO canchas (id, clubId, club, cancha, zona, horaApertura, horaCierre, updatedAt)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, req.session.clubId, club ? club.name : req.session.clubId, d.cancha || "", d.zona || (club ? club.zona : ""), d.horaApertura || "", d.horaCierre || "", Date.now()]
  );
  res.json({ id });
}));
app.delete("/api/my/canchas/:id", clubAuth, asyncRoute(async (req, res) => {
  await run("DELETE FROM canchas WHERE id=? AND clubId=?", [req.params.id, req.session.clubId]);
  res.json({ ok: true });
}));

app.post("/api/my/noticias", clubAuth, asyncRoute(async (req, res) => {
  const d = req.body || {};
  const club = await getRow("SELECT * FROM clubs WHERE id=?", [req.session.clubId]);
  const id = uid();
  await run(
    `INSERT INTO noticias (id, clubId, club, tipo, titulo, cuerpo, fecha, updatedAt)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, req.session.clubId, club ? club.name : req.session.clubId, d.tipo || "general", d.titulo || "", d.cuerpo || "", d.fecha || new Date().toISOString().slice(0, 10), Date.now()]
  );
  res.json({ id });
}));
app.delete("/api/my/noticias/:id", clubAuth, asyncRoute(async (req, res) => {
  await run("DELETE FROM noticias WHERE id=? AND clubId=?", [req.params.id, req.session.clubId]);
  res.json({ ok: true });
}));

app.post("/api/my/torneos", clubAuth, asyncRoute(async (req, res) => {
  const d = req.body || {};
  const club = await getRow("SELECT * FROM clubs WHERE id=?", [req.session.clubId]);
  const id = uid();
  await run(
    `INSERT INTO torneos (id, clubId, clubName, nombre, categoria, fecha, cupo, inscriptos, rounds, campeon, estado, createdAt)
     VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'abierto',?)`,
    [id, req.session.clubId, club ? club.name : req.session.clubId, d.nombre || "", d.categoria || "", d.fecha || "", d.cupo || null, Date.now()]
  );
  res.json({ id });
}));

app.patch("/api/my/torneos/:id", clubAuth, asyncRoute(async (req, res) => {
  const t = await getRow("SELECT * FROM torneos WHERE id=? AND clubId=?", [req.params.id, req.session.clubId]);
  if (!t) return res.status(404).json({ error: "Torneo no encontrado." });
  const { rounds, estado, campeon } = req.body || {};
  const fields = [];
  const args = [];
  if (rounds !== undefined) { fields.push("rounds=?"); args.push(JSON.stringify(rounds)); }
  if (estado !== undefined) { fields.push("estado=?"); args.push(estado); }
  if (campeon !== undefined) { fields.push("campeon=?"); args.push(campeon ? JSON.stringify(campeon) : null); }
  if (!fields.length) return res.json({ ok: true });
  args.push(req.params.id);
  await run(`UPDATE torneos SET ${fields.join(", ")} WHERE id=?`, args);
  const updated = await getRow("SELECT * FROM torneos WHERE id=?", [req.params.id]);
  res.json(rowToTorneo(updated));
}));

app.patch("/api/my/reservas/:id", clubAuth, asyncRoute(async (req, res) => {
  const { estado } = req.body || {};
  if (!["confirmada", "rechazada"].includes(estado)) return res.status(400).json({ error: "Estado inválido." });
  const r = await getRow("SELECT * FROM reservas WHERE id=? AND clubId=?", [req.params.id, req.session.clubId]);
  if (!r) return res.status(404).json({ error: "Reserva no encontrada." });
  await run("UPDATE reservas SET estado=? WHERE id=?", [estado, req.params.id]);
  const club = await getRow("SELECT * FROM clubs WHERE id=?", [req.session.clubId]);
  await run(
    `INSERT INTO activity (id, forUserId, type, requestId, actorName, requestLugar, requestFecha, requestHora, estado, timestamp)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [uid(), r.playerId, "reserva", null, club ? club.name : r.clubName, r.canchaNombre, r.fecha, r.hora, estado, Date.now()]
  );
  res.json({ ok: true });
  sendPushToPlayer(r.playerId, {
    title: estado === "confirmada" ? "¡Reserva confirmada!" : "Reserva rechazada",
    body: (club ? club.name : r.clubName) + " · " + r.canchaNombre + " · " + r.fecha + " " + r.hora,
    url: "/",
  }).catch(() => {});
}));

/* ---------------- superadmin authenticated routes ---------------- */
const superAuth = requireAuth("super");

app.get("/api/admin/clubs", superAuth, asyncRoute(async (req, res) => {
  const clubRows = (await getAll("SELECT * FROM clubs")).map(rowToClub);
  const accounts = await getAll("SELECT clubId, username FROM clubAccounts");
  const accByClub = {};
  accounts.forEach((a) => { accByClub[a.clubId] = a; });
  res.json(
    clubRows.map((c) => ({
      ...c,
      hasAccount: !!accByClub[c.id],
      username: accByClub[c.id] ? accByClub[c.id].username : null,
    }))
  );
}));

app.post("/api/admin/clubs", superAuth, asyncRoute(async (req, res) => {
  const { name, zona, photo } = req.body || {};
  if (!name) return res.status(400).json({ error: "Falta el nombre." });
  const id = slugify(name);
  await run(
    "INSERT OR REPLACE INTO clubs (id, name, zona, descripcion, photo, membershipAlert, updatedAt) VALUES (?,?,?,?,?,0,?)",
    [id, name, zona || "", "", photo || null, Date.now()]
  );
  res.json({ id });
}));

app.patch("/api/admin/clubs/:id", superAuth, asyncRoute(async (req, res) => {
  const { membershipAlert, photo } = req.body || {};
  const fields = [];
  const args = [];
  if (membershipAlert !== undefined) { fields.push("membershipAlert=?"); args.push(membershipAlert ? 1 : 0); }
  if (photo !== undefined) { fields.push("photo=?"); args.push(photo); }
  if (!fields.length) return res.json({ ok: true });
  args.push(req.params.id);
  await run(`UPDATE clubs SET ${fields.join(", ")} WHERE id=?`, args);
  res.json({ ok: true });
}));

app.delete("/api/admin/clubs/:id", superAuth, asyncRoute(async (req, res) => {
  const id = req.params.id;
  await db.batch(
    [
      { sql: "DELETE FROM clubs WHERE id=?", args: [id] },
      { sql: "DELETE FROM clubAccounts WHERE clubId=?", args: [id] },
      { sql: "DELETE FROM canchas WHERE clubId=?", args: [id] },
      { sql: "DELETE FROM noticias WHERE clubId=?", args: [id] },
      { sql: "DELETE FROM torneos WHERE clubId=?", args: [id] },
      { sql: "DELETE FROM reservas WHERE clubId=?", args: [id] },
      { sql: "DELETE FROM clubFollows WHERE clubId=?", args: [id] },
    ],
    "write"
  );
  res.json({ ok: true });
}));

app.post("/api/admin/clubs/:id/account", superAuth, asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Faltan datos." });
  await run(
    "INSERT OR REPLACE INTO clubAccounts (clubId, username, passwordHash, createdAt) VALUES (?,?,?,?)",
    [req.params.id, username, bcrypt.hashSync(password, 10), Date.now()]
  );
  res.json({ ok: true });
}));

app.patch("/api/admin/clubs/:id/account", superAuth, asyncRoute(async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Falta la contraseña." });
  const info = await run("UPDATE clubAccounts SET passwordHash=? WHERE clubId=?", [bcrypt.hashSync(password, 10), req.params.id]);
  if (Number(info.rowsAffected) === 0) return res.status(404).json({ error: "Ese club no tiene cuenta todavía." });
  res.json({ ok: true });
}));

ready
  .then(() => ensureVapidKeys())
  .then((keys) => {
    VAPID_PUBLIC_KEY = keys.publicKey;
    webpush.setVapidDetails("mailto:soporte@bandeja.app", keys.publicKey, keys.privateKey);
    app.listen(PORT, () => {
      console.log("Bandeja backend escuchando en el puerto " + PORT);
    });
  })
  .catch((err) => {
    console.error("No se pudo inicializar la base de datos. Revisá TURSO_DATABASE_URL y TURSO_AUTH_TOKEN.", err);
    process.exit(1);
  });
