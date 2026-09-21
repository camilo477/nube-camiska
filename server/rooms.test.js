import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

async function startServer(storageDir) {
  const child = spawn(process.execPath, ["server/index.js"], {
    env: { ...process.env, PORT: "0", NODE_ENV: "production", CLOUD_STORAGE_DIR: storageDir, CLOUD_ROOM_MAX_BYTES: "1024", CLOUD_MAX_FILE_BYTES: "4096", CLOUD_SECURITY_TOKEN: "test-internal-token", CLOUD_USERS_JSON: JSON.stringify([
      { username: "owner", password: "test-password", role: "admin" },
      { username: "other", password: "test-password", role: "admin" },
      { username: "viewer", password: "test-password", role: "viewer" }
    ]) }, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Server did not start: ${errors}`)); }, 10000);
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${errors}`)); });
    child.stdout.on("data", data => {
      output += data;
      const port = output.match(/http:\/\/0\.0\.0\.0:(\d+)/)?.[1];
      if (port) { clearTimeout(timeout); resolve(`http://127.0.0.1:${port}`); }
    });
  });
  return { base, stop: async () => { if (child.exitCode !== null) return; const exit = once(child, "exit"); child.kill(); await exit; } };
}

test("room exchange, authentication, uploads, saving, restart and automatic cleanup", { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "camiska-rooms-test-"));
  let server = await startServer(directory);
  t.after(async () => { await server.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  const request = (url, { cookie, json, ...options } = {}) => fetch(`${server.base}${url}`, { ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...options.headers }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  const login = async username => {
    const response = await request("/api/login", { method: "POST", json: { username, password: "test-password" } });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const owner = await login("owner");
  const other = await login("other");
  const viewer = await login("viewer");
  const create = async name => {
    const response = await request("/api/rooms", { method: "POST", cookie: owner, json: { name } });
    assert.equal(response.status, 201);
    return response.json();
  };
  const upload = (token, entries, cookie) => {
    const body = new FormData();
    for (const [name, content] of entries) body.append("files", new Blob([content], { type: "image/png" }), name);
    return request(`/api/rooms/public/${token}/upload`, { method: "POST", body, cookie });
  };
  const room = await create("Prueba de intercambio");
  const endpoint = `/api/rooms/public/${room.token}`;
  const roomPath = path.join(directory, ".rooms", room.token);
  let textName;
  let imageName;

  await t.test("only a signed-in administrator can create; guest cannot read the cloud", async () => {
    assert.equal((await request("/api/rooms", { method: "POST", json: {} })).status, 401);
    assert.equal((await request("/api/rooms", { method: "POST", cookie: viewer, json: {} })).status, 403);
    for (const url of ["/api/files", "/api/dashboard", "/api/rooms", "/api/library", "/api/health", "/api/internal/security"]) {
      assert.ok([401, 404].includes((await request(url)).status), url);
    }
    const summary = await (await request(endpoint)).json();
    assert.equal(summary.canSave, false);
    assert.equal("owner" in summary, false);
    assert.equal("connections" in summary, false);
    assert.equal("storageDir" in summary, false);
    const own = await (await request(endpoint, { cookie: owner })).json();
    assert.equal(own.canSave, true);
    assert.deepEqual((await (await request("/api/rooms", { cookie: other })).json()).rooms, []);
  });

  await t.test("two devices join and cross-origin guest mutations are denied", async () => {
    const first = { participantId: randomUUID(), connectionId: randomUUID() };
    const second = { participantId: randomUUID(), connectionId: randomUUID() };
    let response = await request(`${endpoint}/presence`, { method: "POST", json: first, cookie: owner });
    assert.equal((await response.json()).participantCount, 1);
    response = await request(`${endpoint}/presence`, { method: "POST", json: second });
    const joined = await response.json();
    assert.equal(joined.participantCount, 2);
    assert.equal(joined.expiresAt, null);
    assert.equal((await request(`${endpoint}/text`, { method: "POST", json: { text: "blocked" }, headers: { Origin: "https://unrelated.invalid" } })).status, 403);
  });

  await t.test("both devices share Unicode text as data and can download it", async () => {
    const text = 'Hola desde el invitado 👋\n<script>alert("texto")</script>';
    const response = await request(`${endpoint}/text`, { method: "POST", json: { text } });
    assert.equal(response.status, 201);
    textName = (await response.json()).name;
    assert.equal((await request(`${endpoint}/text`, { method: "POST", cookie: owner, json: { text: "Respuesta del dueño" } })).status, 201);
    const files = (await (await request(endpoint, { cookie: owner })).json()).files;
    const file = files.find(file => file.name === textName);
    assert.equal(file.text, text);
    const downloaded = await request(`${file.url}?download=1`);
    assert.match(downloaded.headers.get("content-disposition"), /^attachment/);
    assert.equal(await downloaded.text(), text);
    assert.match(downloaded.headers.get("cache-control"), /no-store/);
    assert.equal((await request(`/room-file/${room.token}/.upload-hidden`)).status, 404);
  });

  await t.test("duplicate filenames in one request and concurrent requests never overwrite", async () => {
    const response = await upload(room.token, [["foto ñ.png", "first"], ["foto ñ.png", "second"]]);
    assert.equal(response.status, 201);
    const saved = (await response.json()).saved;
    assert.equal(new Set(saved.map(file => file.name)).size, 2);
    imageName = saved[0].name;
    const concurrent = await Promise.all([upload(room.token, [["foto ñ.png", "third"]]), upload(room.token, [["foto ñ.png", "fourth"]])]);
    assert.ok(concurrent.every(response => response.status === 201));
    const images = (await fs.readdir(roomPath)).filter(name => name.endsWith(".png"));
    assert.equal(images.length, 4);
    assert.deepEqual(new Set(await Promise.all(images.map(name => fs.readFile(path.join(roomPath, name), "utf8")))), new Set(["first", "second", "third", "fourth"]));
    assert.equal((await request(`/room-file/${room.token}/${encodeURIComponent(imageName)}`, { method: "HEAD" })).status, 200);
  });

  await t.test("invalid and oversized uploads are rejected without crashing or leaving files", async () => {
    assert.equal((await upload(room.token, [["bad.svg", "<svg/>"]])).status, 415);
    assert.equal((await upload(room.token, [[".hidden.png", "bad"]])).status, 400);
    assert.equal((await upload(room.token, [["large.png", "x".repeat(2000)]])).status, 413);
    assert.equal((await upload(room.token, [["huge.png", "x".repeat(5000)]])).status, 413);
    assert.ok(!(await fs.readdir(roomPath)).some(name => name.startsWith(".upload")));
    assert.equal((await request(endpoint)).status, 200);
  });

  await t.test("quota remains enforced across concurrent uploads", async () => {
    const small = await create("Cuota");
    const responses = await Promise.all([upload(small.token, [["one.png", "x".repeat(700)]]), upload(small.token, [["two.png", "y".repeat(700)]])]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 413]);
    assert.equal((await (await request(`/api/rooms/public/${small.token}`)).json()).totalBytes, 700);
  });

  await t.test("only the owner can share selected cloud images as independent room copies", async () => {
    await fs.mkdir(path.join(directory, "Fotos", "Vacaciones"), { recursive: true });
    await fs.writeFile(path.join(directory, "Fotos", "foto ñ.png"), "first cloud image");
    await fs.writeFile(path.join(directory, "Fotos", "Vacaciones", "foto ñ.png"), "second cloud image");
    await fs.writeFile(path.join(directory, "Fotos", "privada.png"), "not selected");
    const imported = await create("De mi nube");
    const route = `/api/rooms/${imported.token}/import`;
    const paths = ["Fotos/foto ñ.png", "Fotos/Vacaciones/foto ñ.png"];
    for (const [cookie, expected] of [[undefined, 401], [viewer, 403], [other, 403]]) {
      assert.equal((await request(route, { method: "POST", cookie, json: { paths } })).status, expected);
    }
    assert.equal((await request(route, { method: "POST", cookie: owner, json: { paths }, headers: { Origin: "https://unrelated.invalid" } })).status, 403);
    const response = await request(route, { method: "POST", cookie: owner, json: { paths: [...paths, paths[0]] } });
    assert.equal(response.status, 201);
    const saved = (await response.json()).saved;
    assert.equal(saved.length, 2);
    assert.equal(new Set(saved.map(file => file.name)).size, 2);
    const summary = await (await request(`/api/rooms/public/${imported.token}`)).json();
    assert.equal(summary.files.length, 2);
    assert.ok(!JSON.stringify(summary).includes("Fotos/"));
    assert.ok(summary.files.every(file => file.url.startsWith(`/room-file/${imported.token}/`)));
    for (let i = 0; i < paths.length; i++) {
      const file = summary.files.find(file => file.name === saved[i].name);
      assert.equal(await (await request(file.url)).text(), await fs.readFile(path.join(directory, paths[i]), "utf8"));
      assert.equal((await request(`/files/${paths[i]}`)).status, 401);
    }
    await fs.writeFile(path.join(directory, paths[0]), "original changed");
    assert.equal(await (await request(summary.files.find(file => file.name === saved[0].name).url)).text(), "first cloud image");
    assert.equal((await request(route, { method: "POST", cookie: owner, json: { paths } })).status, 201);
    assert.equal((await (await request(`/api/rooms/public/${imported.token}`)).json()).files.length, 4);
    await request(`/api/rooms/${imported.token}`, { method: "DELETE", cookie: owner });
    assert.equal((await request(summary.files[0].url)).status, 404);
    assert.equal((await request(route, { method: "POST", cookie: owner, json: { paths } })).status, 404);
    assert.equal(await fs.readFile(path.join(directory, paths[0]), "utf8"), "original changed");
    assert.equal(await fs.readFile(path.join(directory, "Fotos", "privada.png"), "utf8"), "not selected");
  });

  await t.test("cloud imports reject hidden, traversal and symlink sources and roll back failed batches", async () => {
    const imported = await create("Validación de imágenes");
    const route = `/api/rooms/${imported.token}/import`;
    const importPaths = paths => request(route, { method: "POST", cookie: owner, json: { paths } });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "camiska-private-test-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.writeFile(path.join(outside, "secret.png"), "outside storage");
    await fs.symlink(path.join(outside, "secret.png"), path.join(directory, "linked.png"));
    await fs.symlink(outside, path.join(directory, "linked-folder"));
    await fs.mkdir(path.join(directory, ".private"));
    await fs.writeFile(path.join(directory, ".private", "secret.png"), "hidden");
    await fs.writeFile(path.join(directory, "huge.png"), "x".repeat(5000));
    const invalid = [
      [[], 400], ["Fotos/foto ñ.png", 400], [[null], 400], [[{}], 400],
      [["Fotos/../huge.png"], 400], [["/huge.png"], 400], [["Fotos\\foto ñ.png"], 400],
      [[".private/secret.png"], 400], [["linked.png"], 400], [["linked-folder/secret.png"], 400],
      [["missing.png"], 400], [["bad.svg"], 415], [["huge.png"], 413],
      [Array(21).fill("Fotos/foto ñ.png"), 400],
      [["Fotos/foto ñ.png", "missing.png"], 400], [["Fotos/foto ñ.png", "huge.png"], 413]
    ];
    for (const [paths, expected] of invalid) {
      assert.equal((await importPaths(paths)).status, expected, JSON.stringify(paths));
      assert.deepEqual(await fs.readdir(path.join(directory, ".rooms", imported.token)), []);
    }
    await request(`/api/rooms/${imported.token}`, { method: "PATCH", cookie: owner, json: { uploadsEnabled: false } });
    assert.equal((await importPaths(["Fotos/foto ñ.png"])).status, 403);
  });

  await t.test("cloud imports and device uploads share the same room quota", async () => {
    const imported = await create("Cuota compartida");
    await fs.writeFile(path.join(directory, "quota.png"), "x".repeat(700));
    const responses = await Promise.all([
      request(`/api/rooms/${imported.token}/import`, { method: "POST", cookie: owner, json: { paths: ["quota.png"] } }),
      upload(imported.token, [["device.png", "y".repeat(700)]])
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 413]);
    assert.equal((await (await request(`/api/rooms/public/${imported.token}`)).json()).totalBytes, 700);
    assert.equal((await fs.readdir(path.join(directory, ".rooms", imported.token))).length, 1);
  });

  await t.test("only the owner can save to the cloud, with unique names and checksums", async () => {
    const route = `/api/rooms/${room.token}/save`;
    for (const [cookie, expected] of [[undefined, 401], [viewer, 403], [other, 403]]) {
      assert.equal((await request(route, { method: "POST", cookie, json: { files: [textName] } })).status, expected);
    }
    const response = await request(route, { method: "POST", cookie: owner, json: { files: [textName, imageName] } });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.saved.length, 2);
    for (const relative of result.saved) {
      assert.equal(await fs.readFile(path.join(directory, relative), "utf8"), await fs.readFile(path.join(roomPath, path.basename(relative)), "utf8"));
    }
    const repeated = await (await request(route, { method: "POST", cookie: owner, json: { files: [imageName] } })).json();
    assert.ok(!result.saved.includes(repeated.saved[0]));
    const checksums = JSON.parse(await fs.readFile(path.join(directory, ".checksums.json"), "utf8"));
    assert.ok(result.saved.every(name => checksums[name]));
  });

  await t.test("pausing stops text and images but preserves downloads", async () => {
    const route = `/api/rooms/${room.token}`;
    assert.equal((await request(route, { method: "PATCH", cookie: owner, json: { uploadsEnabled: false } })).status, 200);
    assert.equal((await request(`${endpoint}/text`, { method: "POST", json: { text: "paused" } })).status, 403);
    assert.equal((await upload(room.token, [["paused.png", "no"]])).status, 403);
    assert.equal((await request(`/room-file/${room.token}/${textName}`)).status, 200);
    await request(route, { method: "PATCH", cookie: owner, json: { uploadsEnabled: true } });
  });

  await t.test("normal cloud uploads still handle folders and checksums", async () => {
    const body = new FormData();
    body.append("files", new Blob(["private file"]), "nested/test.txt");
    assert.equal((await request("/api/upload", { method: "POST", cookie: owner, body })).status, 201);
    assert.equal(await fs.readFile(path.join(directory, "nested/test.txt"), "utf8"), "private file");
    assert.equal((await request("/files/nested/test.txt")).status, 401);
  });

  await t.test("remote security commit remains functional after a server restart", async () => {
    const before = JSON.parse(await fs.readFile(path.join(directory, ".rooms.json"), "utf8"))[room.token];
    await server.stop();
    server = await startServer(directory);
    assert.equal((await request("/api/me", { cookie: owner })).status, 200);
    assert.equal((await request("/api/internal/security", { headers: { Authorization: "Bearer test-internal-token" } })).status, 200);
    const after = JSON.parse(await fs.readFile(path.join(directory, ".rooms.json"), "utf8"))[room.token];
    assert.deepEqual(after.connections, before.connections);
    assert.equal(after.idleSince, before.idleSince);
  });

  await t.test("expired rooms clean themselves without a visitor; saved copies survive", async () => {
    const storePath = path.join(directory, ".rooms.json");
    const store = JSON.parse(await fs.readFile(storePath, "utf8"));
    store[room.token].connections = {};
    store[room.token].idleSince = Date.now() - 8 * 60 * 1000;
    await fs.writeFile(`${storePath}.test`, JSON.stringify(store));
    await fs.rename(`${storePath}.test`, storePath);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try { await fs.access(roomPath); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await assert.rejects(fs.access(roomPath), { code: "ENOENT" });
    assert.equal((await request(endpoint)).status, 404);
    assert.equal((await request(`/room-file/${room.token}/${textName}`)).status, 404);
    assert.ok((await fs.readdir(path.join(directory, "Salas rápidas", room.name))).length >= 2);
  });
});
