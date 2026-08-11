import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, readFileSync, renameSync, writeFileSync, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";

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

const users = buildUsers();
let checksumMutationQueue = Promise.resolve();
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

    if (["POST", "PUT", "DELETE"].includes(request.method) && !sameOrigin(request)) {
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
  console.log(`Nube Camiska escuchando en http://0.0.0.0:${port}`);
  console.log(`Guardando archivos en ${storageDir}`);
});

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
  const absolutePath = toStoragePath(relativePath);
  const stat = await fs.stat(absolutePath);

  if (!stat.isFile()) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const contentType = await detectContentType(absolutePath);
  const range = request?.headers.range;
  const commonHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Content-Disposition": `inline; filename="${encodeHeaderFilename(path.basename(absolutePath))}"`
  };

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

function streamMultipartFiles(request, targetDir, relativePath) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: request.headers,
      preservePath: true,
      limits: {
        fileSize: maxFileBytes
      }
    });
    const saved = [];
    const writes = [];

    busboy.on("file", (_fieldName, file, info) => {
      const safeRelativeFilename = sanitizeRelativeFilePath(info.filename);
      const fileRelativePath = joinRelative(relativePath, safeRelativeFilename);
      const targetPath = toStoragePath(fileRelativePath);
      const temporaryPath = path.join(path.dirname(targetPath), `.upload-${randomBytes(8).toString("hex")}`);
      const hash = createHash("sha256");
      let size = 0;

      const writeDone = (async () => {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        const writeStream = createWriteStream(temporaryPath);

        file.on("data", (chunk) => {
          size += chunk.length;
          hash.update(chunk);
        });

        file.on("limit", () => {
          writeStream.destroy();
          reject(new Error("Archivo demasiado grande"));
        });

        try {
          await pipeline(file, writeStream);
          await fs.rename(temporaryPath, targetPath);
          const checksum = hash.digest("hex");
          const stat = await fs.stat(targetPath);
          await setChecksum(fileRelativePath, checksum);
          saved.push({
            name: path.basename(fileRelativePath),
            path: fileRelativePath,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            checksum
          });
        } catch (error) {
          await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
          throw error;
        }
      })();

      writes.push(writeDone);
    });

    busboy.on("finish", async () => {
      try {
        await Promise.all(writes);
        resolve(saved);
      } catch (error) {
        reject(error);
      }
    });
    busboy.on("error", reject);
    request.on("error", reject);
    request.pipe(busboy);
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
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
  await fs.writeFile(path.join(storageDir, name), `${JSON.stringify(value, null, 2)}\n`);
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
  return filename.replace(/["\\]/g, "_");
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
