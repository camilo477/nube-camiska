import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const users = [
  { username: "owner", password: "test-password", role: "admin" },
  { username: "second", password: "test-password", role: "admin" },
  { username: "reader", password: "test-password", role: "viewer" },
];

async function start(storage, configuredUsers = users, demo = true, { state = "", examples = "" } = {}) {
  const child = spawn(process.execPath, ["server/index.js"], {
    env: { ...process.env, NODE_ENV: "production", PORT: "0", CLOUD_STORAGE_DIR: storage, CLOUD_STATE_DIR: state, CLOUD_DEMO_STORAGE_DIR: examples, CLOUD_USERS_JSON: JSON.stringify(configuredUsers), CLOUD_DEMO_ENABLED: String(demo), CLOUD_LEGACY_USER: "", CLOUD_MAX_FILE_BYTES: "4096", CLOUD_SECURITY_TOKEN: "test-internal-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Startup timed out: ${errors}`)); }, 10000);
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${errors}`)); });
    child.stdout.on("data", data => {
      const port = String(data).match(/http:\/\/0\.0\.0\.0:(\d+)/)?.[1];
      if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); }
    });
  });
  return {
    base,
    async stop() { if (child.exitCode !== null) return; const stopped = once(child, "exit"); child.kill(); await stopped; },
  };
}

test("accounts isolate files, mutations, metadata, shares, rooms and the portfolio demo", { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nube-accounts-"));
  await fs.writeFile(path.join(directory, "personal.txt"), "PERSONAL SECRET");
  let server = await start(directory);
  t.after(async () => { await server.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  const request = (url, { cookie, json, ...options } = {}) => fetch(`${server.base}${url}`, {
    ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...options.headers },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const login = async username => {
    const response = await request("/api/login", { method: "POST", json: { username, password: "test-password" } });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const owner = await login("owner");
  const second = await login("second");
  const reader = await login("reader");
  let demo;

  await t.test("existing files belong only to the original owner", async () => {
    assert.equal(await (await request("/files/personal.txt", { cookie: owner })).text(), "PERSONAL SECRET");
    for (const cookie of [second, reader]) {
      assert.deepEqual((await (await request("/api/files", { cookie })).json()).items, []);
      assert.equal((await request("/files/personal.txt", { cookie })).status, 404);
      assert.equal((await request("/api/files?path=Documentos", { cookie })).status, 404);
    }
    assert.equal((await request("/files/personal.txt")).status, 401);
  });

  await t.test("concurrent writes and identically named notes stay in their accounts", async () => {
    await Promise.all([[owner, "OWNER NOTE"], [second, "SECOND NOTE"]].map(async ([cookie, text]) => {
      for (let index = 0; index < 4; index++) {
        const response = await request("/api/notes", { method: "POST", cookie, json: { title: `Same ${index}`, text } });
        assert.equal(response.status, 201);
      }
    }));
    assert.equal(await (await request("/files/Notas/Same%200.txt", { cookie: owner })).text(), "OWNER NOTE");
    assert.equal(await (await request("/files/Notas/Same%200.txt", { cookie: second })).text(), "SECOND NOTE");
    assert.equal((await request("/api/notes", { method: "PUT", cookie: second, json: { path: "personal.txt", text: "overwrite" } })).status, 404);
    assert.equal((await request("/api/files?path=personal.txt", { method: "DELETE", cookie: second })).status, 404);
    assert.equal(await fs.readFile(path.join(directory, "personal.txt"), "utf8"), "PERSONAL SECRET");
    const library = await (await request("/api/library", { cookie: second })).json();
    assert.equal(library.items.length, 4);
    assert.ok(!JSON.stringify(library).includes("personal.txt"));
    const dashboard = await (await request("/api/dashboard", { cookie: second })).json();
    assert.equal(dashboard.count, 4);
    const listing = await (await request("/api/files?path=Notas", { cookie: second })).json();
    assert.ok(listing.items.every(item => item.checksum === createHash("sha256").update("SECOND NOTE").digest("hex")));
    const uploaded = new FormData();
    uploaded.append("files", new Blob(["SECOND UPLOAD"]), "uploaded.txt");
    assert.equal((await request("/api/upload", { method: "POST", cookie: second, body: uploaded })).status, 201);
    assert.equal((await request("/files/uploaded.txt", { cookie: owner })).status, 404);
    assert.equal((await request("/api/files?path=uploaded.txt", { method: "DELETE", cookie: second })).status, 200);
    assert.equal((await (await request("/api/trash", { cookie: second })).json()).items.length, 1);
    assert.equal((await (await request("/api/trash", { cookie: owner })).json()).items.length, 0);
  });

  await t.test("public links resolve the owner's files, never the caller's matching filename", async () => {
    for (const [cookie, content] of [[owner, "OWNER NOTE"], [second, "SECOND NOTE"]]) {
      const response = await request("/api/share", { method: "POST", cookie, json: { path: "Notas/Same 0.txt", hours: 1 } });
      assert.equal(response.status, 201);
      const share = await response.json();
      assert.equal(await (await request(share.url)).text(), content);
      assert.equal(await (await request(share.url, { cookie: cookie === owner ? second : owner })).text(), content);
    }
    assert.equal((await request("/share/invalid")).status, 404);
    const created = await request("/api/rooms", { method: "POST", cookie: second, json: { name: "Second room" } });
    assert.equal(created.status, 201);
    const room = await created.json();
    assert.deepEqual((await (await request("/api/rooms", { cookie: owner })).json()).rooms, []);
    assert.equal((await request(`/api/rooms/${room.token}`, { method: "DELETE", cookie: owner })).status, 404);
    const endpoint = `/api/rooms/public/${room.token}`;
    assert.equal((await request(`${endpoint}/text`, { method: "POST", json: { text: "ROOM TEXT" } })).status, 201);
    const summary = await (await request(endpoint)).json();
    assert.equal(await (await request(summary.files[0].url)).text(), "ROOM TEXT");
    assert.equal((await request(`/api/rooms/${room.token}/save`, { method: "POST", cookie: second, json: {} })).status, 201);
    assert.equal((await request(`/api/files?path=${encodeURIComponent("Salas rápidas/Second room")}`, { cookie: owner })).status, 404);
  });

  await t.test("symlinks cannot expose or overwrite another account", async () => {
    const accountRoot = path.join(directory, ".accounts", createHash("sha256").update("second").digest("hex"));
    await fs.symlink(path.join(directory, "personal.txt"), path.join(accountRoot, "escape.txt"));
    await fs.symlink(directory, path.join(accountRoot, "escape-folder"));
    assert.equal((await request("/files/escape.txt", { cookie: second })).status, 400);
    assert.equal((await request("/api/files?path=escape-folder", { cookie: second })).status, 400);
    const listing = await (await request("/api/files", { cookie: second })).json();
    assert.ok(listing.items.every(item => !item.name.startsWith("escape")));
    assert.equal((await request("/api/notes", { method: "PUT", cookie: second, json: { path: "escape.txt", text: "attack" } })).status, 400);
    assert.equal(await fs.readFile(path.join(directory, "personal.txt"), "utf8"), "PERSONAL SECRET");
  });

  await t.test("the demo has fictitious content and cannot mutate any account", async () => {
    assert.equal((await (await request("/api/config")).json()).demoEnabled, true);
    assert.equal((await request("/api/demo", { method: "POST", headers: { Origin: "https://unrelated.invalid" } })).status, 403);
    const response = await request("/api/demo", { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: "portfolio-demo", role: "viewer", demo: true });
    demo = response.headers.get("set-cookie").split(";")[0];
    const listing = await (await request("/api/files", { cookie: demo })).json();
    assert.deepEqual(listing.items.map(item => item.name).sort(), ["Documentos", "Fotos", "Notas", "Proyectos"]);
    assert.equal((await request("/files/personal.txt", { cookie: demo })).status, 404);
    assert.equal((await request("/files/Notas/Same%200.txt", { cookie: demo })).status, 404);
    assert.match(await (await request("/files/Documentos/Lee%20primero.txt", { cookie: demo })).text(), /ficticios/);
    for (const [url, method] of [["/api/folders", "POST"], ["/api/notes", "POST"], ["/api/upload", "POST"], ["/api/share", "POST"], ["/api/rooms", "POST"], ["/api/trash", "DELETE"], ["/api/files?path=personal.txt", "DELETE"]]) {
      assert.equal((await request(url, { method, cookie: demo, json: {} })).status, 403, url);
    }
    const dashboard = await (await request("/api/dashboard", { cookie: demo })).json();
    assert.equal(dashboard.count, 4);
    assert.equal(dashboard.totalBytes, 25 * 1024 * 1024);
    assert.equal((await request("/api/internal/security", { cookie: demo })).status, 404);
  });

  await t.test("restarts and config order never reassign existing personal files", async () => {
    await server.stop();
    server = await start(directory, [users[1], users[0], users[2]], false);
    assert.equal(await (await request("/files/personal.txt", { cookie: owner })).text(), "PERSONAL SECRET");
    assert.equal((await request("/files/personal.txt", { cookie: second })).status, 404);
    assert.equal(await (await request("/files/Notas/Same%200.txt", { cookie: second })).text(), "SECOND NOTE");
    assert.equal((await request("/api/me", { cookie: demo })).status, 401);
    assert.equal((await request("/api/demo", { method: "POST" })).status, 404);
    assert.equal((await (await request("/api/config")).json()).demoEnabled, false);
  });
});

test("demo and sessions survive an absent or disconnected personal disk without creating a replacement cloud", { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nube-independent-demo-"));
  const storage = path.join(directory, "personal-disk");
  const state = path.join(directory, "boot-card", "state");
  const examples = path.join(directory, "boot-card", "demo");
  let server = await start(storage, users, true, { state, examples });
  t.after(async () => { await server.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  const request = (url, { cookie, json, ...options } = {}) => fetch(`${server.base}${url}`, {
    ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const login = async () => {
    const response = await request("/api/login", { method: "POST", json: { username: "owner", password: "test-password" } });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const owner = await login();
  const response = await request("/api/demo", { method: "POST" });
  assert.equal(response.status, 200);
  const demo = response.headers.get("set-cookie").split(";")[0];

  await t.test("a missing disk does not prevent demo startup or account sessions", async () => {
    assert.equal((await request("/api/me", { cookie: owner })).status, 200);
    assert.equal((await request("/api/files", { cookie: owner })).status, 503);
    assert.equal((await request("/api/notes", { method: "POST", cookie: owner, json: { title: "Must not save", text: "private" } })).status, 503);
    assert.equal((await (await request("/api/files", { cookie: demo })).json()).items.length, 4);
    assert.match(await (await request("/files/Documentos/Lee%20primero.txt", { cookie: demo })).text(), /ficticios/);
    assert.equal((await request("/api/notes", { method: "POST", cookie: demo, json: { title: "No write", text: "data" } })).status, 403);
    await assert.rejects(fs.access(storage), { code: "ENOENT" });
  });

  await t.test("the personal disk resumes only with its original ownership marker", async () => {
    await fs.mkdir(storage);
    await fs.writeFile(path.join(storage, ".accounts-layout.json"), JSON.stringify({ version: 1, legacyOwner: "wrong-owner" }));
    assert.equal((await request("/api/files", { cookie: owner })).status, 503);
    await fs.writeFile(path.join(storage, ".accounts-layout.json"), JSON.stringify({ version: 1, legacyOwner: "owner" }));
    await fs.writeFile(path.join(storage, "personal.txt"), "PRIVATE CONTENT");
    assert.equal(await (await request("/files/personal.txt", { cookie: owner })).text(), "PRIVATE CONTENT");
    assert.equal((await request("/files/personal.txt", { cookie: demo })).status, 404);
    await fs.rename(storage, path.join(directory, "disconnected-disk"));
    assert.equal((await request("/api/files", { cookie: owner })).status, 503);
    assert.equal((await request("/api/files", { cookie: demo })).status, 200);
    await assert.rejects(fs.access(storage), { code: "ENOENT" });
  });

  await t.test("demo sessions and contents persist across restart with the disk absent", async () => {
    await server.stop();
    server = await start(storage, users, true, { state, examples });
    assert.equal((await request("/api/me", { cookie: demo })).status, 200);
    assert.equal((await request("/api/dashboard", { cookie: demo })).status, 200);
    assert.equal((await request("/api/files", { cookie: owner })).status, 503);
    assert.equal((await request("/api/logout", { method: "POST", cookie: owner })).status, 200);
    assert.equal((await request("/api/me", { cookie: owner })).status, 401);
    await assert.rejects(fs.access(storage), { code: "ENOENT" });
  });

  await t.test("public demo sessions have a fixed storage bound and leave private sessions intact", async () => {
    const privateCookie = await login();
    const file = path.join(state, ".security.json");
    const security = JSON.parse(await fs.readFile(file, "utf8"));
    security.sessions.push(...Array.from({ length: 150 }, (_, index) => ({ id: `old-demo-${index}`, username: "portfolio-demo", role: "viewer", tokenHash: "unusable-test-token", ip: "old-demo-ip", createdAt: Date.now() - 1000 - index, expiresAt: Date.now() + 3600000, lastSeen: Date.now() })));
    await fs.writeFile(file, JSON.stringify(security));
    assert.equal((await request("/api/demo", { method: "POST" })).status, 200);
    const updated = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(updated.sessions.filter(session => session.username === "portfolio-demo").length, 100);
    assert.equal((await request("/api/me", { cookie: privateCookie })).status, 200);
    assert.ok((await fs.stat(file)).size < 100 * 1024);
  });
});
