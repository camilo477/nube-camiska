import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";

export async function receiveMultipart(request, targetDir, options) {
  if (request.aborted) throw Object.assign(new Error("upload_aborted"), { statusCode: 400 });
  const parser = Busboy({ headers: request.headers, preservePath: true, limits: { fileSize: options.maxFileBytes, files: options.maxFiles ?? Infinity } });
  const staged = [];
  const writes = [];
  const committed = [];
  let combinedBytes = 0;
  let failure;
  const fail = error => {
    failure ??= error;
    request.unpipe(parser);
    request.resume();
    parser.destroy(error);
  };
  const aborted = () => fail(Object.assign(new Error("upload_aborted"), { statusCode: 400 }));
  request.once("aborted", aborted);
  request.once("error", fail);
  parser.on("file", (_field, file, info) => {
    const temporary = path.join(targetDir, `.upload-${randomBytes(16).toString("hex")}`);
    const item = { temporary };
    staged.push(item);
    const write = (async () => {
      item.relativeName = options.sanitizeFilename(info.filename);
      if (options.accept && !options.accept(item.relativeName)) {
        throw Object.assign(new Error("image_required"), { statusCode: 415 });
      }
      const hash = createHash("sha256");
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          combinedBytes += chunk.length;
          if (options.maximumCombinedBytes !== undefined && combinedBytes > options.maximumCombinedBytes) {
            callback(Object.assign(new Error("room_quota_exceeded"), { statusCode: 413 }));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        }
      });
      await pipeline(file, meter, createWriteStream(temporary, { flags: "wx" }));
      if (file.truncated) throw Object.assign(new Error("file_too_large"), { statusCode: 413 });
      item.checksum = hash.digest("hex");
    })().catch(error => { file.resume(); fail(error); });
    writes.push(write);
  });
  parser.on("filesLimit", () => fail(Object.assign(new Error("too_many_files"), { statusCode: 400 })));
  try {
    await new Promise((resolve, reject) => {
      parser.once("close", resolve);
      parser.once("error", reject);
      request.pipe(parser);
    });
    await Promise.all(writes);
    if (failure) throw failure;
    await options.beforeCommit?.();
    for (const item of staged) {
      let relativeName = item.relativeName;
      const destination = options.resolvePath(relativeName);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (options.uniqueNames) {
        relativeName = await writeUnique(relativeName, options.resolvePath, target => fs.link(item.temporary, target));
      } else {
        await fs.rename(item.temporary, destination);
      }
      committed.push(relativeName);
      const stat = await fs.stat(options.resolvePath(relativeName));
      item.result = { name: path.basename(relativeName), path: relativeName, size: stat.size, modifiedAt: stat.mtime.toISOString(), checksum: item.checksum };
    }
    return staged.map(item => item.result);
  } catch (error) {
    await Promise.all(writes);
    if (options.uniqueNames) await Promise.all(committed.map(name => fs.rm(options.resolvePath(name), { force: true })));
    throw failure ?? error;
  } finally {
    request.off("aborted", aborted);
    request.off("error", fail);
    await Promise.all(staged.map(item => fs.rm(item.temporary, { force: true })));
  }
}

// The write itself must reject an existing target: an existence check followed
// by rename can overwrite another upload that picked the same name.
export async function writeUnique(name, resolvePath, write) {
  const extension = path.extname(name);
  const base = name.slice(0, name.length - extension.length);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = index === 1 ? name : `${base} (${index})${extension}`;
    try { await write(resolvePath(candidate)); return candidate; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  throw new Error("No se pudo generar un nombre disponible");
}
