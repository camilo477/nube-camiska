import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, createReadStream, readFileSync, renameSync, writeFileSync, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { reconcilePresence, updatePresence } from "./room-presence.js";
import { receiveMultipart, writeUnique } from "./uploads.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "dist");
const storageDir = path.resolve(process.env.CLOUD_STORAGE_DIR ?? path.join(rootDir, "data"));
const port = Number(process.env.PORT ?? 8080);
const maxFileBytes = Number(process.env.CLOUD_MAX_FILE_BYTES ?? process.env.CLOUD_MAX_UPLOAD_BYTES ?? 1024 * 1024 * 1024 * 8);
const failWindowMs = Number(process.env.CLOUD_AUTH_WINDOW_MS ?? 15 * 60 * 1000);
const blockMs = Number(process.env.CLOUD_AUTH_BLOCK_MS ?? 15 * 60 * 1000);
const maxFailedAttempts = Number(process.env.CLOUD_AUTH_MAX_ATTEMPTS ?? 5);
const securityApiToken = process.env.CLOUD_SECURITY_TOKEN ?? "";
const securityFileName = ".security.json";
const maxSecurityEvents = 200;
const trashDirName = ".trash";
const logsDirName = ".logs";
const sharesFileName = ".shares.json";
const checksumsFileName = ".checksums.json";
const roomsFileName = ".rooms.json";
const roomsDirName = ".rooms";
const maxRoomBytes = Number(process.env.CLOUD_ROOM_MAX_BYTES ?? 1024 * 1024 * 1024 * 2);

const users = buildUsers();
let checksumMutationQueue = Promise.resolve();
let roomMutationQueue = Promise.resolve();
const guestUploadAttempts = new Map();
const roomFileQueues = new Map();
const roomTextMaxBytes = 64 * 1024;
const roomImageExtensions = new Set([".avif", ".bmp", ".gif", ".heic", ".heif", ".ico", ".jfif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const sessionCookieName = "camiska_session";
const sessionDurationMs = Number(process.env.CLOUD_SESSION_DURATION_MS ?? 1000 * 60 * 60 * 24 * 7);

const mimeTypes = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jfif": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp"
};

if (process.env.NODE_ENV === "production" && users.length === 0) {
  throw new Error("Define CLOUD_USER/CLOUD_PASSWORD o CLOUD_USERS_JSON antes de correr en producción.");
}

await fs.mkdir(storageDir, { recursive: true });
await fs.mkdir(path.join(storageDir, trashDirName), { recursive: true });
await fs.mkdir(path.join(storageDir, logsDirName), { recursive: true });
await fs.mkdir(path.join(storageDir, roomsDirName), { recursive: true });

if (runSecurityCommand()) process.exit();

const server = http.createServer(async (request, response) => {
  try {
    setSecurityHeaders(request, response);
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (requestUrl.pathname.startsWith("/share/") && request.method === "GET") {
      await sendSharedFile(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/internal/security" && request.method === "GET") {
      sendInternalSecurity(request, response);
      return;
    }

    if (requestUrl.pathname.startsWith("/room-file/") && (request.method === "GET" || request.method === "HEAD")) {
      await sendRoomFile(request, requestUrl, response);
      return;
    }

    const publicRoomRoute = requestUrl.pathname.match(/^\/api\/rooms\/public\/([a-f0-9]{48})(?:\/(presence|upload|text))?$/);
    if (publicRoomRoute) {
      response.setHeader("Cache-Control", "no-store");
      const action = publicRoomRoute[2];
      if (request.method === "POST" && !sameOrigin(request)) return sendJson(response, 403, { error: "origin_not_allowed" });
      if (!action && request.method === "GET") await sendPublicRoom(request, requestUrl, response);
      else if (action === "presence" && request.method === "POST") await receiveRoomPresence(request, requestUrl, response);
      else if (action === "upload" && request.method === "POST") await receiveRoomUpload(request, requestUrl, response);
      else if (action === "text" && request.method === "POST") await receiveRoomText(request, requestUrl, response);
      else sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    if (requestUrl.pathname === "/api/login" && request.method === "POST") {
      await login(request, response);
      return;
    }

    if (!requestUrl.pathname.startsWith("/api/") && !requestUrl.pathname.startsWith("/files/")) {
      await sendStatic(requestUrl, response);
      return;
    }

    const auth = authenticate(request);
    if (!auth.ok) {
      sendJson(response, auth.status, { error: auth.error });
      return;
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !sameOrigin(request)) {
      sendJson(response, 403, { error: "origin_not_allowed" });
      return;
    }

    if (requestUrl.pathname === "/api/logout" && request.method === "POST") {
      logout(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/me" && request.method === "GET") {
      sendJson(response, 200, { user: auth.user.username, role: auth.user.role });
      return;
    }

    if (requestUrl.pathname === "/api/health" && request.method === "GET") {
      await sendHealth(response);
      return;
    }

    if (requestUrl.pathname === "/api/dashboard" && request.method === "GET") {
      await sendDashboard(response);
      return;
    }

    if (requestUrl.pathname === "/api/library" && request.method === "GET") {
      await sendLibrary(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/files" && request.method === "GET") {
      await sendDirectory(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/folders" && request.method === "POST") {
      requireAdmin(auth.user);
      await createFolder(request, requestUrl, response, auth);
      return;
    }

    if (requestUrl.pathname === "/api/notes" && request.method === "POST") {
      requireAdmin(auth.user);
      await createNote(request, response, auth);
      return;
    }

    if (requestUrl.pathname === "/api/notes" && request.method === "PUT") {
      requireAdmin(auth.user);
      await updateNote(request, response, auth);
      return;
    }

    if (requestUrl.pathname === "/api/notes/preview" && request.method === "GET") {
      await sendNotePreview(requestUrl, response);
      return;
    }

    if (requestUrl.pathname === "/api/upload" && request.method === "POST") {
      requireAdmin(auth.user);
      await receiveUpload(request, requestUrl, response, auth);
      return;
    }

    if (requestUrl.pathname === "/api/rename" && request.method === "POST") {
      requireAdmin(auth.user);
      await renameEntry(request, response, auth);
      return;
    }

    if (requestUrl.pathname === "/api/move" && request.method === "POST") {
      requireAdmin(auth.user);
      await moveEntry(request, response, auth);
      return;
    }

    if (requestUrl.pathname === "/api/share" && request.method === "POST") {
      requireAdmin(auth.user);
      await createShare(request, response, auth);
      return;
    }

    if (requestUrl.pathname === "/api/rooms" && request.method === "GET") {
      requireAdmin(auth.user);
      await sendRooms(response, auth);
      return;
    }

    if (requestUrl.pathname === "/api/rooms" && request.method === "POST") {
      requireAdmin(auth.user);
      await createRoom(request, response, auth);
      return;
    }

    if (/^\/api\/rooms\/[^/]+$/.test(requestUrl.pathname) && request.method === "PATCH") {
      requireAdmin(auth.user);
      await updateRoom(request, requestUrl, response, auth);
      return;
    }

    if (/^\/api\/rooms\/[^/]+$/.test(requestUrl.pathname) && request.method === "DELETE") {
      requireAdmin(auth.user);
      await deleteRoom(request, requestUrl, response, auth);
      return;
    }

    if (/^\/api\/rooms\/[^/]+\/save$/.test(requestUrl.pathname) && request.method === "POST") {
      requireAdmin(auth.user);
      await saveRoomFiles(request, requestUrl, response, auth);
      return;
    }

    if (requestUrl.pathname === "/api/trash" && request.method === "GET") {
      await sendTrash(response);
      return;
    }

    if (requestUrl.pathname === "/api/trash" && request.method === "DELETE") {
      requireAdmin(auth.user);
      await emptyTrash(response, auth);
      return;
    }

    if (requestUrl.pathname === "/api/files" && request.method === "DELETE") {
      requireAdmin(auth.user);
      await trashEntry(request, requestUrl, response, auth);
      return;
    }

    if (requestUrl.pathname.startsWith("/files/") && request.method === "GET") {
      await sendStoredFile(request, requestUrl, response);
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    const status = error.statusCode ?? 500;
    sendJson(response, status, { error: status === 500 ? "server_error" : error.message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Nube Camiska escuchando en http://0.0.0.0:${server.address().port}`);
  console.log(`Guardando archivos en ${storageDir}`);
});

// Cleanup runs even when every browser has left the room.
setInterval(() => { void removeExpiredRooms().catch(console.error); }, 1000).unref();

function buildUsers() {
  const parsed = parseUsersJson();
  if (parsed.length) {
    return parsed;
  }

  const result = [];
  if (process.env.CLOUD_USER && process.env.CLOUD_PASSWORD) {
    result.push({ username: process.env.CLOUD_USER, password: process.env.CLOUD_PASSWORD, role: "admin" });
  }

  if (process.env.CLOUD_VIEWER_USER && process.env.CLOUD_VIEWER_PASSWORD) {
    result.push({ username: process.env.CLOUD_VIEWER_USER, password: process.env.CLOUD_VIEWER_PASSWORD, role: "viewer" });
  }

  return result;
}

function parseUsersJson() {
  if (!process.env.CLOUD_USERS_JSON) {
    return [];
  }

  try {
    const raw = JSON.parse(process.env.CLOUD_USERS_JSON);
    return Array.isArray(raw)
      ? raw
          .filter((user) => user.username && user.password)
          .map((user) => ({
            username: String(user.username),
            password: String(user.password),
            role: user.role === "viewer" ? "viewer" : "admin"
          }))
      : [];
  } catch {
    throw new Error("CLOUD_USERS_JSON no es JSON válido.");
  }
}

function authenticate(request) {
  const sessionToken = readCookies(request)[sessionCookieName];
  if (!sessionToken) return { ok: false, status: 401, error: "auth_required" };
  const now = Date.now();
  const state = cleanSecurityState(readSecurityState(), now);
  const tokenHash = hashValue(sessionToken);
  const session = state.sessions.find((item) => safeEqual(item.tokenHash, tokenHash));
  if (!session) return { ok: false, status: 401, error: "auth_required" };
  if (now - session.lastSeen > 60_000) {
    session.lastSeen = now;
    session.ip = getClientIp(request);
    writeSecurityState(state);
  }
  return {
    ok: true,
    user: { username: session.username, role: session.role },
    session,
    state
  };
}

async function login(request, response) {
  if (!sameOrigin(request)) {
    sendJson(response, 403, { error: "origin_not_allowed" });
    return;
  }
  const ip = getClientIp(request);
  const now = Date.now();
  const state = cleanSecurityState(readSecurityState(), now);
  const attempt = state.attempts[ip];
  if (attempt?.blockedUntil > now) {
    sendJson(response, 429, { error: "too_many_attempts" });
    return;
  }

  const body = await readJson(request);
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  const user = users.length
    ? users.find((candidate) => safeEqual(candidate.username, username) && safeEqual(candidate.password, password))
    : process.env.NODE_ENV !== "production" && username === "dev" && password === "dev"
      ? { username: "dev", role: "admin" }
      : null;

  if (!user) {
    const blockedUntil = registerFailedAttempt(state, ip, request);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    sendJson(response, blockedUntil ? 429 : 401, { error: blockedUntil ? "too_many_attempts" : "invalid_credentials" });
    return;
  }

  delete state.attempts[ip];
  const token = randomBytes(32).toString("base64url");
  const device = getDeviceName(request.headers["user-agent"]);
  state.sessions.push({
    id: randomUUID(),
    tokenHash: hashValue(token),
    username: user.username,
    role: user.role,
    device,
    ip,
    createdAt: now,
    lastSeen: now,
    expiresAt: now + sessionDurationMs
  });
  addSecurityEvent(state, { result: "success", username: user.username, ip, device });
  writeSecurityState(state);
  response.setHeader("Set-Cookie", serializeSessionCookie(request, token, sessionDurationMs));
  sendJson(response, 200, { user: user.username, role: user.role });
}

function logout(request, response) {
  const token = readCookies(request)[sessionCookieName];
  if (token) {
    const state = cleanSecurityState(readSecurityState());
    const tokenHash = hashValue(token);
    const session = state.sessions.find((item) => safeEqual(item.tokenHash, tokenHash));
    state.sessions = state.sessions.filter((item) => !safeEqual(item.tokenHash, tokenHash));
    if (session) addSecurityEvent(state, {
      result: "logout",
      username: session.username,
      ip: getClientIp(request),
      device: getDeviceName(request.headers["user-agent"])
    });
    writeSecurityState(state);
  }
  response.setHeader("Set-Cookie", serializeSessionCookie(request, "", 0));
  sendJson(response, 200, { ok: true });
}

function readCookies(request) {
  return String(request.headers.cookie ?? "")
    .split(";")
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return cookies;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key) cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function serializeSessionCookie(request, value, maxAgeMs) {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const secure = forwardedProtocol === "https" || request.socket.encrypted;
  return `${sessionCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`;
}

function registerFailedAttempt(state, ip, request) {
  const now = Date.now();
  const previous = state.attempts[ip];
  const attempts = previous && now - previous.firstAttemptAt < failWindowMs ? previous.attempts + 1 : 1;
  const blockedUntil = attempts >= maxFailedAttempts ? now + blockMs : 0;
  state.attempts[ip] = {
    attempts,
    firstAttemptAt: previous && now - previous.firstAttemptAt < failWindowMs ? previous.firstAttemptAt : now,
    lastAttempt: now,
    blockedUntil
  };
  addSecurityEvent(state, {
    result: blockedUntil ? "blocked" : "failure",
    ip,
    device: getDeviceName(request.headers["user-agent"])
  });
  writeSecurityState(state);
  return blockedUntil;
}

function readSecurityState() {
  try {
    return JSON.parse(readFileSync(path.join(storageDir, securityFileName), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return { sessions: [], attempts: {}, events: [] };
  }
}

function writeSecurityState(state) {
  const target = path.join(storageDir, securityFileName);
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function cleanSecurityState(state, now = Date.now()) {
  const clean = state && typeof state === "object" ? state : {};
  clean.sessions = Array.isArray(clean.sessions) ? clean.sessions.filter((session) => Number(session.expiresAt) > now) : [];
  clean.attempts = clean.attempts && typeof clean.attempts === "object" && !Array.isArray(clean.attempts) ? clean.attempts : {};
  clean.events = Array.isArray(clean.events) ? clean.events.slice(-maxSecurityEvents) : [];
  for (const [ip, attempt] of Object.entries(clean.attempts)) {
    if (!attempt || now - Number(attempt.lastAttempt ?? 0) > failWindowMs) delete clean.attempts[ip];
  }
  return clean;
}

function addSecurityEvent(state, event) {
  state.events.push({ id: randomUUID(), timestamp: Date.now(), ...event });
  state.events = state.events.slice(-maxSecurityEvents);
}

function hashValue(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(left, right) {
  const leftHash = Buffer.from(hashValue(left), "hex");
  const rightHash = Buffer.from(hashValue(right), "hex");
  return timingSafeEqual(leftHash, rightHash);
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const protocol = String(request.headers["x-forwarded-proto"] ?? (request.socket.encrypted ? "https" : "http")).split(",")[0].trim();
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",")[0].trim();
  return origin === `${protocol}://${host}`;
}

function setSecurityHeaders(request, response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self'; script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  if (String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function getDeviceName(userAgent = "") {
  let browser = "Navegador";
  let system = "Dispositivo";
  if (/Edg\//i.test(userAgent)) browser = "Edge";
  else if (/Firefox\//i.test(userAgent)) browser = "Firefox";
  else if (/CriOS\//i.test(userAgent) || /Chrome\//i.test(userAgent)) browser = "Chrome";
  else if (/Safari\//i.test(userAgent)) browser = "Safari";
  if (/iPhone/i.test(userAgent)) system = "iPhone";
  else if (/iPad/i.test(userAgent)) system = "iPad";
  else if (/Android/i.test(userAgent)) system = "Android";
  else if (/Windows/i.test(userAgent)) system = "Windows";
  else if (/Macintosh|Mac OS X/i.test(userAgent)) system = "Mac";
  else if (/Linux/i.test(userAgent)) system = "Linux";
  return `${browser} · ${system}`;
}

function sendInternalSecurity(request, response) {
  const header = request.headers.authorization ?? "";
  const suppliedToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!securityApiToken || !safeEqual(securityApiToken, suppliedToken)) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  const state = cleanSecurityState(readSecurityState());
  writeSecurityState(state);
  sendJson(response, 200, {
    sessions: state.sessions.map((session) => ({
      id: session.id,
      user: session.username,
      role: session.role,
      device: session.device,
      ip: session.ip,
      createdAt: session.createdAt,
      lastSeen: session.lastSeen
    })),
    events: state.events.slice(-30).reverse()
  });
}

function runSecurityCommand() {
  const command = process.argv[2];
  if (!command) return false;
  const state = cleanSecurityState(readSecurityState());
  if (command === "--unlock-all") {
    state.attempts = {};
    writeSecurityState(state);
    console.log("Todos los bloqueos de Nube fueron eliminados.");
    return true;
  }
  if (command === "--unlock-ip" && process.argv[3]) {
    delete state.attempts[process.argv[3]];
    writeSecurityState(state);
    console.log(`Bloqueo eliminado para ${process.argv[3]}.`);
    return true;
  }
  if (command === "--list-locks") {
    console.table(Object.entries(state.attempts)
      .filter(([, attempt]) => Number(attempt.blockedUntil) > Date.now())
      .map(([ip, attempt]) => ({ ip, hasta: new Date(attempt.blockedUntil).toISOString() })));
    return true;
  }
  console.error("Usa --list-locks, --unlock-all o --unlock-ip <IP>.");
  process.exitCode = 1;
  return true;
}

function requireAdmin(user) {
  if (user.role !== "admin") {
    const error = new Error("forbidden");
    error.statusCode = 403;
    throw error;
  }
}

async function sendHealth(response) {
  const stat = await fs.stat(storageDir);
  sendJson(response, 200, {
    ok: true,
    storageDir,
    writable: stat.isDirectory(),
    maxFileBytes
  });
}

async function sendDirectory(requestUrl, response) {
  const relativePath = normalizeRelativePath(requestUrl.searchParams.get("path") ?? "");
  const absolutePath = toStoragePath(relativePath);
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const checksums = await readJsonStore(checksumsFileName, {});
  const items = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => {
        const entryRelativePath = joinRelative(relativePath, entry.name);
        const entryPath = path.join(absolutePath, entry.name);
        const stat = await fs.stat(entryPath);
        const kind = entry.isDirectory() ? "folder" : "file";

        const detectedMediaType = kind === "file" ? await detectMediaType(entryPath, entry.name) : "folder";

        return {
          name: entry.name,
          path: entryRelativePath,
          type: kind,
          mediaType: detectedMediaType,
          size: entry.isDirectory() ? null : stat.size,
          modifiedAt: stat.mtime.toISOString(),
          url: entry.isDirectory() ? null : `/files/${encodePath(entryRelativePath)}`,
          checksum: checksums[entryRelativePath] ?? null
        };
      })
  );

  sendJson(response, 200, {
    path: relativePath,
    parent: getParentPath(relativePath),
    items: sortItems(items, "name", "asc")
  });
}

async function createFolder(request, requestUrl, response, auth) {
  const body = await readJson(request);
  const basePath = normalizeRelativePath(body.path ?? requestUrl.searchParams.get("path") ?? "");
  const name = sanitizeName(body.name ?? "");
  const folderPath = joinRelative(basePath, name);
  await fs.mkdir(toStoragePath(folderPath), { recursive: false });
  await writeLog(auth, request, "create_folder", folderPath);
  sendJson(response, 201, { path: folderPath });
}

async function createNote(request, response, auth) {
  const body = await readJson(request);
  const title = sanitizeName(body.title ?? "nota");
  const extension = path.extname(title).toLowerCase();
  const baseName = extension ? title.slice(0, -extension.length) : title;
  const fileName = `${baseName}.txt`;
  const content = String(body.text ?? "");
  const notesDirRelative = "Notas";
  const notesDirAbsolute = toStoragePath(notesDirRelative);
  await fs.mkdir(notesDirAbsolute, { recursive: true });
  const relativePath = joinRelative(notesDirRelative, fileName);
  const absolutePath = toStoragePath(relativePath);
  await fs.writeFile(absolutePath, content, "utf8");
  const checksum = createHash("sha256").update(content).digest("hex");
  await setChecksum(relativePath, checksum);
  await writeLog(auth, request, "create_note", relativePath, { size: Buffer.byteLength(content, "utf8"), checksum });
  sendJson(response, 201, { path: relativePath });
}

async function updateNote(request, response, auth) {
  const body = await readJson(request);
  const relativePath = normalizeRelativePath(body.path ?? "");
  if (!relativePath) {
    sendJson(response, 400, { error: "path_required" });
    return;
  }

  if (!/(\.txt|\.md)$/i.test(relativePath)) {
    sendJson(response, 400, { error: "text_note_required" });
    return;
  }

  const content = String(body.text ?? "");
  const absolutePath = toStoragePath(relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  await fs.writeFile(absolutePath, content, "utf8");
  const checksum = createHash("sha256").update(content).digest("hex");
  await setChecksum(relativePath, checksum);
  await writeLog(auth, request, "update_note", relativePath, { size: Buffer.byteLength(content, "utf8"), checksum });
  sendJson(response, 200, { path: relativePath });
}

async function sendNotePreview(requestUrl, response) {
  const relativePath = normalizeRelativePath(requestUrl.searchParams.get("path") ?? "");
  if (!relativePath) {
    sendJson(response, 400, { error: "path_required" });
    return;
  }

  if (!/(\.txt|\.md)$/i.test(relativePath)) {
    sendJson(response, 400, { error: "text_note_required" });
    return;
  }

  const absolutePath = toStoragePath(relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const maxPreviewBytes = 1024 * 256;
  const fileContent = await fs.readFile(absolutePath, "utf8");
  sendJson(response, 200, { content: fileContent.slice(0, maxPreviewBytes) });
}

async function receiveUpload(request, requestUrl, response, auth) {
  const relativePath = normalizeRelativePath(requestUrl.searchParams.get("path") ?? "");
  const targetDir = toStoragePath(relativePath);
  await fs.mkdir(targetDir, { recursive: true });

  if (!request.headers["content-type"]?.includes("multipart/form-data")) {
    sendJson(response, 400, { error: "multipart_required" });
    return;
  }

  const saved = await streamMultipartFiles(request, targetDir, relativePath, auth);
  if (!saved.length) {
    sendJson(response, 400, { error: "file_required" });
    return;
  }

  for (const item of saved) {
    await writeLog(auth, request, "upload", item.path, { size: item.size, checksum: item.checksum });
  }

  sendJson(response, 201, { saved });
}

async function renameEntry(request, response, auth) {
  const body = await readJson(request);
  const source = normalizeRelativePath(body.path ?? "");
  const newName = sanitizeName(body.name ?? "");
  const target = joinRelative(getParentPath(source) ?? "", newName);
  await fs.rename(toStoragePath(source), toStoragePath(target));
  await moveChecksum(source, target);
  await writeLog(auth, request, "rename", source, { target });
  sendJson(response, 200, { path: target });
}

async function moveEntry(request, response, auth) {
  const body = await readJson(request);
  const source = normalizeRelativePath(body.path ?? "");
  const destinationFolder = normalizeRelativePath(body.destination ?? "");
  const target = joinRelative(destinationFolder, path.basename(source));
  await fs.mkdir(toStoragePath(destinationFolder), { recursive: true });
  await fs.rename(toStoragePath(source), toStoragePath(target));
  await moveChecksum(source, target);
  await writeLog(auth, request, "move", source, { target });
  sendJson(response, 200, { path: target });
}

async function createShare(request, response, auth) {
  const body = await readJson(request);
  const relativePath = normalizeRelativePath(body.path ?? "");
  const hours = Number(body.hours ?? 1);
  const stat = await fs.stat(toStoragePath(relativePath));

  if (!stat.isFile()) {
    sendJson(response, 400, { error: "file_required" });
    return;
  }

  const shares = await readJsonStore(sharesFileName, {});
  const token = randomBytes(24).toString("hex");
  shares[token] = {
    path: relativePath,
    expiresAt: new Date(Date.now() + Math.max(1, Math.min(hours, 24 * 7)) * 60 * 60 * 1000).toISOString()
  };
  await writeJsonStore(sharesFileName, shares);
  await writeLog(auth, request, "share", relativePath, { token, expiresAt: shares[token].expiresAt });
  sendJson(response, 201, { url: `/share/${token}`, expiresAt: shares[token].expiresAt });
}

async function sendRooms(response, auth) {
  await removeExpiredRooms();
  const rooms = await readJsonStore(roomsFileName, {});
  const result = await Promise.all(Object.values(rooms).filter(room => room.owner === auth.user.username).map(room => roomSummary(room, auth)));
  result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  response.setHeader("Cache-Control", "no-store");
  sendJson(response, 200, { rooms: result });
}

async function createRoom(request, response, auth) {
  const body = await readJson(request, 4096);
  const name = sanitizeName(String(body.name || "Sala rápida").slice(0, 80));
  const token = randomBytes(24).toString("hex");
  const room = { token, name, owner: auth.user.username, createdAt: new Date().toISOString(), idleSince: Date.now(), connections: {}, uploadsEnabled: true };
  await fs.mkdir(roomStoragePath(token), { recursive: true });
  await mutateRooms(rooms => { rooms[token] = room; });
  await writeLog(auth, request, "room_create", name, { token });
  sendJson(response, 201, await roomSummary(room, auth));
}

function canSaveRoom(room, auth) {
  return Boolean(auth?.ok && auth.user.role === "admin" && auth.user.username === room.owner);
}

function requireRoomOwner(room, auth) {
  if (!canSaveRoom(room, auth)) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
}

async function updateRoom(request, requestUrl, response, auth) {
  const token = roomTokenFromPath(requestUrl.pathname);
  const body = await readJson(request, 4096);
  const updated = await getActiveRoom(token, room => {
    requireRoomOwner(room, auth);
    if (typeof body.uploadsEnabled === "boolean") room.uploadsEnabled = body.uploadsEnabled;
  });
  if (!updated) return sendJson(response, 404, { error: "room_not_found" });
  await writeLog(auth, request, "room_update", updated.name, { token, uploadsEnabled: updated.uploadsEnabled });
  sendJson(response, 200, await roomSummary(updated, auth));
}

async function deleteRoom(request, requestUrl, response, auth) {
  const token = roomTokenFromPath(requestUrl.pathname);
  let removed;
  await mutateRooms(rooms => {
    if (!rooms[token]) return;
    requireRoomOwner(rooms[token], auth);
    removed = rooms[token];
    delete rooms[token];
  });
  if (!removed) return sendJson(response, 404, { error: "room_not_found" });
  await deleteRoomStorage(token);
  await writeLog(auth, request, "room_delete", removed.name, { token });
  sendJson(response, 200, { ok: true });
}

async function saveRoomFiles(request, requestUrl, response, auth) {
  const token = roomTokenFromPath(requestUrl.pathname);
  const body = await readJson(request, 64 * 1024);
  await withRoomFiles(token, async () => {
    const room = await getActiveRoom(token);
    if (!room) return sendJson(response, 404, { error: "room_not_found" });
    requireRoomOwner(room, auth);
    const requested = Array.isArray(body.files) ? new Set(body.files.map(String)) : null;
    const destination = joinRelative("Salas rápidas", room.name);
    const entries = await fs.readdir(roomStoragePath(token), { withFileTypes: true });
    const saved = [];
    await fs.mkdir(toStoragePath(destination), { recursive: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".") || (requested && !requested.has(entry.name))) continue;
      const source = path.join(roomStoragePath(token), entry.name);
      const target = await writeUnique(joinRelative(destination, entry.name), toStoragePath, target => fs.copyFile(source, target, fsConstants.COPYFILE_EXCL));
      const checksum = await checksumFile(toStoragePath(target));
      await setChecksum(target, checksum);
      saved.push(target);
      await writeLog(auth, request, "room_save", entry.name, { token, target, checksum });
    }
    sendJson(response, 201, { saved, destination });
  });
}

async function sendPublicRoom(request, requestUrl, response) {
  const room = await getActiveRoom(roomTokenFromPath(requestUrl.pathname));
  if (!room) return sendJson(response, 404, { error: "room_not_found" });
  sendJson(response, 200, await roomSummary(room, authenticate(request)));
}

async function receiveRoomPresence(request, requestUrl, response) {
  const body = await readJson(request, 4096);
  if (![body.participantId, body.connectionId].every(id => typeof id === "string" && /^[a-f0-9-]{32,36}$/.test(id))) {
    return sendJson(response, 400, { error: "invalid_participant" });
  }
  if (body.sequence !== undefined && (!Number.isSafeInteger(body.sequence) || body.sequence < 1)) return sendJson(response, 400, { error: "invalid_sequence" });
  const room = await getActiveRoom(roomTokenFromPath(requestUrl.pathname), room => {
    if (body.present !== false && !room.connections[body.connectionId] && Object.keys(room.connections).length >= 100) {
      throw Object.assign(new Error("room_full"), { statusCode: 429 });
    }
    updatePresence(room, body);
  });
  if (!room) return sendJson(response, 404, { error: "room_not_found" });
  sendJson(response, 200, await roomSummary(room, authenticate(request)));
}

async function writableRoom(token) {
  const room = await getActiveRoom(token);
  if (!room) throw Object.assign(new Error("room_not_found"), { statusCode: 404 });
  if (!room.uploadsEnabled) throw Object.assign(new Error("uploads_disabled"), { statusCode: 403 });
  return room;
}

async function receiveRoomText(request, requestUrl, response) {
  const token = roomTokenFromPath(requestUrl.pathname);
  const body = await readJson(request, roomTextMaxBytes * 6 + 1024);
  if (typeof body.text !== "string" || !body.text.trim()) return sendJson(response, 400, { error: "text_required" });
  const bytes = Buffer.byteLength(body.text);
  if (bytes > roomTextMaxBytes) return sendJson(response, 413, { error: "text_too_large" });
  await withRoomFiles(token, async () => {
    const room = await writableRoom(token);
    if (!allowGuestUpload(getClientIp(request), token)) return sendJson(response, 429, { error: "too_many_uploads" });
    const summary = await roomSummary(room);
    if (summary.totalBytes + bytes > maxRoomBytes) return sendJson(response, 413, { error: "room_quota_exceeded" });
    const name = `texto-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.txt`;
    await fs.writeFile(path.join(roomStoragePath(token), name), body.text, { flag: "wx" });
    await writeLog({ user: { username: "invitado", role: "guest" } }, request, "room_text", name, { token, size: bytes });
    sendJson(response, 201, { name });
  });
}

async function receiveRoomUpload(request, requestUrl, response) {
  const token = roomTokenFromPath(requestUrl.pathname);
  if (!request.headers["content-type"]?.includes("multipart/form-data")) return sendJson(response, 400, { error: "multipart_required" });
  await withRoomFiles(token, async () => {
    const room = await writableRoom(token);
    if (!allowGuestUpload(getClientIp(request), token)) return sendJson(response, 429, { error: "too_many_uploads" });
    const summary = await roomSummary(room);
    const saved = await streamMultipartFiles(request, roomStoragePath(token), joinRelative(roomsDirName, token), {
      uniqueNames: true,
      flatNames: true,
      trackChecksum: false,
      maxFiles: 20,
      accept: name => roomImageExtensions.has(path.extname(name).toLowerCase()),
      maximumCombinedBytes: Math.max(0, maxRoomBytes - summary.totalBytes),
      beforeCommit: () => writableRoom(token)
    });
    if (!saved.length) return sendJson(response, 400, { error: "file_required" });
    for (const item of saved) {
      await writeLog({ user: { username: "invitado", role: "guest" } }, request, "room_upload", item.name, { token, size: item.size, checksum: item.checksum });
    }
    sendJson(response, 201, { saved: saved.map(({ name, size }) => ({ name, size })) });
  });
}

async function sendRoomFile(request, requestUrl, response) {
  const match = requestUrl.pathname.match(/^\/room-file\/([a-f0-9]{48})\/([^/]+)$/);
  if (!match) return sendJson(response, 404, { error: "not_found" });
  const [, token, encodedName] = match;
  const filename = decodeURIComponent(encodedName);
  const room = await getActiveRoom(token);
  if (!room || filename.startsWith(".") || filename !== path.basename(filename) || filename.includes("\\")) return sendJson(response, 404, { error: "not_found" });
  await streamAbsoluteFile(path.join(roomStoragePath(token), filename), request, response, { untrusted: true, download: requestUrl.searchParams.has("download") });
}

async function roomSummary(room, auth) {
  const files = [];
  let entries = [];
  try { entries = await fs.readdir(roomStoragePath(room.token), { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const absolutePath = path.join(roomStoragePath(room.token), entry.name);
    try {
      const stat = await fs.stat(absolutePath);
      totalBytes += stat.size;
      const text = entry.name.endsWith(".txt") && stat.size <= roomTextMaxBytes ? await fs.readFile(absolutePath, "utf8") : undefined;
      files.push({ name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString(), mediaType: await detectMediaType(absolutePath, entry.name), text, url: `/room-file/${room.token}/${encodeURIComponent(entry.name)}` });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  files.sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt) || a.name.localeCompare(b.name));
  const { participantCount, expiresAt } = reconcilePresence(room);
  // Explicit public fields: never serialize the owner, sessions, connections,
  // storage paths, or other rooms into a guest response.
  return { token: room.token, name: room.name, createdAt: room.createdAt, uploadsEnabled: room.uploadsEnabled, participantCount, expiresAt, serverTime: Date.now(), canSave: canSaveRoom(room, auth), files, totalBytes, maxBytes: maxRoomBytes };
}

async function getActiveRoom(token, mutation) {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  let result = null;
  let expired = false;
  await mutateRooms(rooms => {
    const room = rooms[token];
    if (!room) return;
    if (reconcilePresence(room).expired) {
      delete rooms[token];
      expired = true;
      return;
    }
    mutation?.(room);
    result = structuredClone(room);
  });
  if (expired) void deleteRoomStorage(token).catch(console.error);
  return result;
}

async function removeExpiredRooms() {
  const expired = [];
  await mutateRooms(rooms => {
    for (const [token, room] of Object.entries(rooms)) {
      if (reconcilePresence(room).expired) { expired.push(token); delete rooms[token]; }
    }
  });
  await Promise.all(expired.map(deleteRoomStorage));
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, attempts] of guestUploadAttempts) {
    if (attempts.at(-1) <= cutoff) guestUploadAttempts.delete(key);
  }
}

function deleteRoomStorage(token) {
  return withRoomFiles(token, () => fs.rm(roomStoragePath(token), { recursive: true, force: true }));
}

function withRoomFiles(token, operation) {
  const result = (roomFileQueues.get(token) ?? Promise.resolve()).then(operation);
  const tail = result.catch(() => undefined);
  roomFileQueues.set(token, tail);
  void tail.then(() => { if (roomFileQueues.get(token) === tail) roomFileQueues.delete(token); });
  return result;
}

function mutateRooms(mutation) {
  const operation = roomMutationQueue.then(async () => {
    const rooms = await readJsonStore(roomsFileName, {});
    const before = JSON.stringify(rooms);
    mutation(rooms);
    if (JSON.stringify(rooms) !== before) await writeJsonStore(roomsFileName, rooms);
  });
  roomMutationQueue = operation.catch(() => undefined);
  return operation;
}

function roomTokenFromPath(pathname) {
  return pathname.split("/").find(part => /^[a-f0-9]{48}$/.test(part)) ?? "";
}

function roomStoragePath(token) {
  if (!/^[a-f0-9]{48}$/.test(token)) throw Object.assign(new Error("room_not_found"), { statusCode: 404 });
  return path.join(storageDir, roomsDirName, token);
}

function allowGuestUpload(ip, token) {
  const key = `${ip}:${token}`;
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recent = (guestUploadAttempts.get(key) ?? []).filter(at => at > cutoff);
  if (recent.length >= 120) return false;
  recent.push(Date.now());
  guestUploadAttempts.set(key, recent);
  return true;
}

async function checksumFile(absolutePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function trashEntry(request, requestUrl, response, auth) {
  const relativePath = normalizeRelativePath(requestUrl.searchParams.get("path") ?? "");
  if (!relativePath) {
    sendJson(response, 400, { error: "path_required" });
    return;
  }

  const targetPath = toStoragePath(relativePath);
  await fs.stat(targetPath);
  const trashedName = `${Date.now()}-${path.basename(relativePath)}`;
  const trashTarget = path.join(storageDir, trashDirName, trashedName);
  await fs.rename(targetPath, trashTarget);
  await removeChecksum(relativePath);
  await writeLog(auth, request, "trash", relativePath, { target: `${trashDirName}/${trashedName}` });
  sendJson(response, 200, { ok: true });
}

async function sendTrash(response) {
  const entries = await fs.readdir(path.join(storageDir, trashDirName), { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(storageDir, trashDirName, entry.name);
      const stat = await fs.stat(absolutePath);
      return {
        name: entry.name,
        type: entry.isDirectory() ? "folder" : "file",
        size: entry.isDirectory() ? null : stat.size,
        modifiedAt: stat.mtime.toISOString()
      };
    })
  );
  sendJson(response, 200, { items });
}

async function emptyTrash(response, auth) {
  const trashPath = path.join(storageDir, trashDirName);
  await fs.rm(trashPath, { recursive: true, force: true });
  await fs.mkdir(trashPath, { recursive: true });
  await writeLog(auth, null, "empty_trash", trashDirName);
  sendJson(response, 200, { ok: true });
}

async function sendDashboard(response) {
  const disk = await getDiskUsage(storageDir);
  const stats = {
    usedBytes: 0,
    freeBytes: disk.freeBytes,
    totalBytes: disk.totalBytes,
    count: 0,
    byType: { images: 0, videos: 0, audio: 0, documents: 0, other: 0 },
    monthlyGrowth: {}
  };

  await walkStorage("", async (relativePath, stat) => {
    stats.usedBytes += stat.size;
    stats.count += 1;
    const type = await detectMediaType(toStoragePath(relativePath), relativePath);
    const bucket = type === "image" ? "images" : type === "video" ? "videos" : type === "audio" ? "audio" : type === "document" ? "documents" : "other";
    stats.byType[bucket] += 1;
    const month = stat.mtime.toISOString().slice(0, 7);
    stats.monthlyGrowth[month] = (stats.monthlyGrowth[month] ?? 0) + stat.size;
  });

  sendJson(response, 200, stats);
}

async function sendLibrary(requestUrl, response) {
  const view = String(requestUrl.searchParams.get("view") ?? "recent");
  const acceptedType = view === "photos" ? "image" : view === "videos" ? "video" : null;
  const checksums = await readJsonStore(checksumsFileName, {});
  const items = [];

  await walkStorage("", async (relativePath, stat) => {
    const mediaType = await detectMediaType(toStoragePath(relativePath), relativePath);
    if (acceptedType && mediaType !== acceptedType) return;
    items.push({
      name: path.basename(relativePath),
      path: relativePath,
      type: "file",
      mediaType,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      url: `/files/${encodePath(relativePath)}`,
      checksum: checksums[relativePath] ?? null
    });
  });

  items.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  sendJson(response, 200, { view, items: items.slice(0, view === "recent" ? 100 : 500) });
}

async function getDiskUsage(targetPath) {
  try {
    const { stdout } = await execFileAsync("df", ["-Pk", targetPath]);
    const lines = stdout.trim().split("\n");
    const columns = lines.at(-1)?.trim().split(/\s+/) ?? [];
    const totalKb = Number(columns[1]);
    const freeKb = Number(columns[3]);

    if (Number.isFinite(totalKb) && Number.isFinite(freeKb)) {
      return {
        totalBytes: totalKb * 1024,
        freeBytes: freeKb * 1024
      };
    }
  } catch (error) {
    console.error("No se pudo leer uso de disco", error);
  }

  return {
    totalBytes: 0,
    freeBytes: 0
  };
}

async function sendStoredFile(request, requestUrl, response) {
  const relativePath = decodeURIComponent(requestUrl.pathname.replace(/^\/files\//, ""));
  await streamStoredFile(normalizeRelativePath(relativePath), request, response);
}

async function sendSharedFile(requestUrl, response) {
  const token = requestUrl.pathname.replace(/^\/share\//, "");
  const shares = await readJsonStore(sharesFileName, {});
  const share = shares[token];

  if (!share || Date.now() > new Date(share.expiresAt).getTime()) {
    if (share) {
      delete shares[token];
      await writeJsonStore(sharesFileName, shares);
    }
    sendJson(response, 404, { error: "share_not_found" });
    return;
  }

  await streamStoredFile(share.path, null, response);
}

async function streamStoredFile(relativePath, request, response) {
  await streamAbsoluteFile(toStoragePath(relativePath), request, response);
}

async function streamAbsoluteFile(absolutePath, request, response, options = {}) {
  let stat;
  try { stat = await fs.stat(absolutePath); }
  catch { return sendJson(response, 404, { error: "not_found" }); }

  if (!stat.isFile()) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const contentType = await detectContentType(absolutePath);
  const range = request?.headers.range;
  const commonHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Content-Disposition": contentDisposition(options.download || options.untrusted && (contentType.includes("html") || contentType.includes("svg")) ? "attachment" : "inline", path.basename(absolutePath)),
    ...(options.untrusted ? { "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } : {})
  };

  if (request?.method === "HEAD") {
    response.writeHead(200, { ...commonHeaders, "Content-Length": stat.size });
    response.end();
    return;
  }

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : stat.size - 1;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= stat.size) {
      response.writeHead(416, {
        ...commonHeaders,
        "Content-Range": `bytes */${stat.size}`
      });
      response.end();
      return;
    }

    response.writeHead(206, {
      ...commonHeaders,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`
    });
    createReadStream(absolutePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    ...commonHeaders,
    "Content-Length": stat.size
  });
  createReadStream(absolutePath).pipe(response);
}

async function sendStatic(requestUrl, response) {
  const pathname = decodeURIComponent(requestUrl.pathname);
  const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
  let staticPath = path.resolve(publicDir, requestedPath);

  if (staticPath !== publicDir && !staticPath.startsWith(`${publicDir}${path.sep}`)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  try {
    const stat = await fs.stat(staticPath);
    if (stat.isDirectory()) {
      staticPath = path.join(staticPath, "index.html");
    }
  } catch {
    staticPath = path.join(publicDir, "index.html");
  }

  const stat = await fs.stat(staticPath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(staticPath).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": stat.size,
    ...(path.basename(staticPath) === "sw.js" ? { "Cache-Control": "no-cache, no-store, must-revalidate" } : {})
  });
  createReadStream(staticPath).pipe(response);
}

async function streamMultipartFiles(request, targetDir, relativePath, options = {}) {
  const saved = await receiveMultipart(request, targetDir, {
    ...options,
    maxFileBytes,
    sanitizeFilename: filename => options.flatNames ? sanitizeName(path.basename(filename)) : sanitizeRelativeFilePath(filename),
    resolvePath: name => toStoragePath(joinRelative(relativePath, name))
  });
  for (const item of saved) {
    item.path = joinRelative(relativePath, item.path);
    if (options.trackChecksum !== false) await setChecksum(item.path, item.checksum);
  }
  return saved;
}

async function readJson(request, limit = Infinity) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw Object.assign(new Error("body_too_large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function walkStorage(relativePath, onFile) {
  const absolutePath = toStoragePath(relativePath);
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryRelative = joinRelative(relativePath, entry.name);
    const entryAbsolute = path.join(absolutePath, entry.name);
    const stat = await fs.stat(entryAbsolute);

    if (stat.isDirectory()) {
      await walkStorage(entryRelative, onFile);
    } else {
      await onFile(entryRelative, stat);
    }
  }
}

async function readJsonStore(name, fallback) {
  try {
    const content = await fs.readFile(path.join(storageDir, name), "utf8");
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function writeJsonStore(name, value) {
  const target = path.join(storageDir, name);
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function setChecksum(relativePath, checksum) {
  await mutateChecksums((checksums) => {
    checksums[relativePath] = checksum;
  });
}

async function moveChecksum(source, target) {
  await mutateChecksums((checksums) => {
    for (const key of Object.keys(checksums)) {
      if (key !== source && !key.startsWith(`${source}/`)) continue;
      const suffix = key.slice(source.length);
      checksums[`${target}${suffix}`] = checksums[key];
      delete checksums[key];
    }
  });
}

async function removeChecksum(relativePath) {
  await mutateChecksums((checksums) => {
    for (const key of Object.keys(checksums)) {
      if (key === relativePath || key.startsWith(`${relativePath}/`)) delete checksums[key];
    }
  });
}

function mutateChecksums(mutation) {
  const operation = checksumMutationQueue.then(async () => {
    const checksums = await readJsonStore(checksumsFileName, {});
    mutation(checksums);
    await writeJsonStore(checksumsFileName, checksums);
  });
  checksumMutationQueue = operation.catch(() => undefined);
  return operation;
}

async function writeLog(auth, request, action, target, extra = {}) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    user: auth.user.username,
    role: auth.user.role,
    ip: request ? getClientIp(request) : null,
    action,
    target,
    ...extra
  });
  const logPath = path.join(storageDir, logsDirName, `${new Date().toISOString().slice(0, 10)}.log`);
  await fs.appendFile(logPath, `${line}\n`);
}

function getClientIp(request) {
  const forwarded = request.headers["cf-connecting-ip"] ?? request.headers["x-forwarded-for"];
  return String(Array.isArray(forwarded) ? forwarded[0] : forwarded ?? request.socket.remoteAddress ?? "unknown").split(",")[0].trim();
}

function toStoragePath(relativePath) {
  const absolutePath = path.resolve(storageDir, relativePath);

  if (absolutePath !== storageDir && !absolutePath.startsWith(`${storageDir}${path.sep}`)) {
    throw new Error("Ruta fuera del almacenamiento");
  }

  return absolutePath;
}

function normalizeRelativePath(input) {
  return String(input)
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== ".." && !part.startsWith("."))
    .map(sanitizeName)
    .join("/");
}

function sanitizeRelativeFilePath(input) {
  const clean = normalizeRelativePath(input);
  if (!clean) {
    return `archivo-${Date.now()}`;
  }
  return clean;
}

function sanitizeName(input) {
  const clean = path
    .basename(String(input))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .trim();

  if (!clean || clean === "." || clean === ".." || clean.startsWith(".")) {
    throw Object.assign(new Error("invalid_name"), { statusCode: 400 });
  }

  return clean;
}

function joinRelative(base, name) {
  return [base, name].filter(Boolean).join("/");
}

function getParentPath(relativePath) {
  if (!relativePath) {
    return null;
  }

  const parts = relativePath.split("/");
  parts.pop();
  return parts.join("/");
}

function sortItems(items, key, direction) {
  const modifier = direction === "desc" ? -1 : 1;
  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    if (key === "size") {
      return ((a.size ?? 0) - (b.size ?? 0)) * modifier;
    }
    if (key === "date") {
      return (new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()) * modifier;
    }
    return a.name.localeCompare(b.name, "es", { sensitivity: "base" }) * modifier;
  });
}

function getMediaType(name) {
  const extension = path.extname(name).toLowerCase().slice(1);
  if (["avif", "bmp", "gif", "heic", "heif", "ico", "jfif", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"].includes(extension)) return "image";
  if (["m4v", "mov", "mp4", "mpeg", "webm"].includes(extension)) return "video";
  if (["aac", "flac", "m4a", "mp3", "ogg", "wav"].includes(extension)) return "audio";
  if (["doc", "docx", "md", "pdf", "txt", "xls", "xlsx"].includes(extension)) return "document";
  return "other";
}

async function detectMediaType(absolutePath, name) {
  const byExtension = getMediaType(name);
  if (byExtension !== "other") {
    return byExtension;
  }

  const contentType = await detectContentType(absolutePath);
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf") return "document";
  return "other";
}

async function detectContentType(absolutePath) {
  const byExtension = mimeTypes[path.extname(absolutePath).toLowerCase()];
  if (byExtension) {
    return byExtension;
  }

  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);

    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
    if (bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) return "image/x-icon";
    if (
      bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
      bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
    ) return "image/tiff";
    if (bytes.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
    if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
      const brand = bytes.subarray(8, 16).toString("ascii");
      if (brand.includes("heic") || brand.includes("heix") || brand.includes("hevc") || brand.includes("heif") || brand.includes("mif1")) return "image/heic";
      if (brand.includes("avif")) return "image/avif";
      return "video/mp4";
    }
    if (bytes.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
    if (bytes.subarray(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
    if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  } finally {
    await handle.close();
  }

  return "application/octet-stream";
}

function encodePath(relativePath) {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

function encodeHeaderFilename(filename) {
  return filename.replace(/[^\x20-\x7E]|["\\]/g, "_");
}

function contentDisposition(disposition, filename) {
  return `${disposition}; filename="${encodeHeaderFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
