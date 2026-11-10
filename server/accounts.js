import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const demoAccount = { username: "portfolio-demo", role: "viewer", demo: true };

// Only trusted server configuration selects a filesystem root. Request paths,
// cookies and usernames supplied by the browser never become directory names.
export async function createAccountStorage(baseDir, users, demoEnabled, { stateDir = baseDir, demoDir } = {}) {
  const context = new AsyncLocalStorage();
  const accounts = new Map(users.map(user => [user.username, user]));
  if (accounts.size !== users.length) throw new Error("Los usuarios de Nube deben tener nombres únicos.");
  if (demoEnabled) {
    if (accounts.has(demoAccount.username)) throw new Error("portfolio-demo está reservado para la demostración.");
    accounts.set(demoAccount.username, demoAccount);
  }
  const independentState = stateDir !== baseDir;
  await directory(stateDir);
  const layoutPath = path.join(stateDir, ".accounts-layout.json");
  let layout;
  try { layout = JSON.parse(await fs.readFile(layoutPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const legacyOwner = process.env.CLOUD_LEGACY_USER || (users.some(user => user.username === process.env.CLOUD_USER) ? process.env.CLOUD_USER : "") || users.find(user => user.role === "admin")?.username || users[0]?.username;
    if (!legacyOwner || !accounts.has(legacyOwner) || legacyOwner === demoAccount.username) throw new Error("Configura un propietario para los archivos existentes.");
    layout = { version: 1, legacyOwner };
    await fs.writeFile(layoutPath, JSON.stringify(layout, null, 2), { flag: "wx", mode: 0o600 });
  }
  if (layout.version !== 1 || typeof layout.legacyOwner !== "string") throw new Error("La distribución de cuentas no es válida; revisa .accounts-layout.json.");
  const scopes = new Map();
  for (const user of accounts.values()) {
    const id = createHash("sha256").update(user.username).digest("hex");
    const root = user.demo && (demoDir || independentState)
      ? demoDir || path.join(stateDir, "demo")
      : user.username === layout.legacyOwner ? baseDir : path.join(baseDir, ".accounts", id);
    scopes.set(user.username, { root, user, ready: false });
  }
  async function prepare(user) {
    const scope = scopes.get(user.username);
    if (!scope) throw new Error("Cuenta de almacenamiento inexistente.");
    try {
      if (independentState && !scope.user.demo) {
        // Never create an empty personal cloud on the boot card when the
        // external drive is missing. The original disk keeps this marker.
        const marker = JSON.parse(await fs.readFile(path.join(baseDir, ".accounts-layout.json"), "utf8"));
        if (marker.version !== layout.version || marker.legacyOwner !== layout.legacyOwner) throw new Error("storage_marker_mismatch");
      }
      if (!scope.ready) {
        await directory(scope.root);
        for (const name of [".trash", ".logs", ".rooms"]) await directory(path.join(scope.root, name));
        scope.ready = true;
      }
      return scope;
    } catch (error) {
      scope.ready = false;
      if (independentState && !scope.user.demo) throw Object.assign(new Error("storage_unavailable"), { statusCode: 503 });
      throw error;
    }
  }
  // With independent state, private directories are opened only on demand.
  // Demo startup never reads from or writes to the external disk.
  for (const scope of scopes.values()) if (scope.user.demo || !independentState) await prepare(scope.user);
  if (demoEnabled) await seedDemo(scopes.get(demoAccount.username).root);
  return {
    current: () => context.getStore(),
    root: () => {
      const scope = context.getStore();
      if (!scope) throw new Error("Falta el contexto de almacenamiento de la cuenta.");
      return scope.root;
    },
    user: username => accounts.get(username),
    prepare,
    enter: user => {
      const scope = scopes.get(user.username);
      if (!scope) throw new Error("Cuenta de almacenamiento inexistente.");
      if (!scope.ready) throw Object.assign(new Error("storage_unavailable"), { statusCode: 503 });
      context.enterWith(scope);
    },
    run: (scope, callback) => context.run(scope, callback),
    scopes: () => [...scopes.values()].filter(scope => scope.ready),
    // A public token is an explicit sharing capability. Locate its owner first;
    // all subsequent file access stays inside that owner's filesystem scope.
    async publicScope(token, kind) {
      if (!/^[a-f0-9]{48}$/.test(token)) return undefined;
      for (const scope of scopes.values()) {
        try {
          await prepare(scope.user);
          const records = JSON.parse(await fs.readFile(path.join(scope.root, kind === "room" ? ".rooms.json" : ".shares.json"), "utf8"));
          if (Object.hasOwn(records, token)) return scope;
        } catch (error) { if (error.code !== "ENOENT" && error.statusCode !== 503) throw error; }
      }
    },
  };
}

async function directory(target) {
  await fs.mkdir(target, { recursive: true });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`El almacenamiento debe ser un directorio real: ${target}`);
}

async function seedDemo(root) {
  // Write exclusively, so a restart never overwrites an existing file.
  const files = {
    "Documentos/Lee primero.txt": "Bienvenido a la demo de Nube Camiska.\nTodos estos archivos son ficticios. Explora carpetas, busca documentos, cambia entre lista y galería y descarga ejemplos.\nEsta cuenta es de solo lectura y tiene un espacio independiente de las cuentas personales.\n",
    "Proyectos/Proyecto Aurora.md": "# Proyecto Aurora\n\nUn proyecto de ejemplo para organizar ideas y documentos.\n\n- Diseñar la propuesta\n- Preparar los recursos\n- Compartir los resultados\n",
    "Notas/Ideas para el fin de semana.txt": "Visitar una exposición\nPreparar un picnic\nAprender una receta nueva\n",
    "Fotos/Paisaje de ejemplo.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500"><rect width="800" height="500" fill="#dcebf4"/><circle cx="625" cy="115" r="55" fill="#f5c875"/><path d="M0 370 240 130 480 390 650 230 800 380V500H0Z" fill="#87aca5"/><path d="M0 440 280 300 520 430 800 340V500H0Z" fill="#476f70"/></svg>',
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await directory(path.dirname(target));
    try { await fs.writeFile(target, content, { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
}
