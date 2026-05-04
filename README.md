# Nube Camiska

Web app privada para subir, organizar, ver, compartir y borrar archivos
guardados en el disco conectado a la Raspberry. El frontend está hecho con Vite
+ TypeScript y el backend es un servidor Node pequeño, sin base de datos.

## Funciones

- Subida múltiple de archivos.
- Subida de carpetas completas desde PC.
- Barra de progreso de subida.
- Crear carpetas desde la web.
- Renombrar archivos/carpetas.
- Mover archivos/carpetas a otra carpeta.
- Búsqueda por nombre.
- Orden por nombre, fecha o tamaño, ascendente/descendente.
- Vista lista y modo galería.
- Vista previa de imágenes, videos, audios y PDFs.
- Papelera: eliminar mueve a `.trash`; vaciar papelera borra permanente.
- Roles:
  - `admin`: sube, borra, renombra, mueve, comparte.
  - `viewer`: solo ve y descarga.
- Links compartibles temporales.
- Dashboard básico de almacenamiento y tipos de archivo.
- Logs diarios en `.logs/YYYY-MM-DD.log`.
- Checksum SHA-256 para archivos subidos.
- Bloqueo de IP tras varios intentos fallidos.

## Desarrollo local

```bash
npm install
npm run build
```

Para probar el servidor completo:

```bash
CLOUD_USER=camiska \
CLOUD_PASSWORD="cambia-esta-clave" \
CLOUD_VIEWER_USER=visor \
CLOUD_VIEWER_PASSWORD="clave-solo-lectura" \
CLOUD_STORAGE_DIR="./data" \
npm start
```

Luego abre `http://localhost:8080`.

## Docker en la Raspberry

Construir la imagen:

```bash
docker build -t nube-camiska .
```

Levantarla montando el disco duro como volumen:

```bash
docker run -d \
  --name nube-camiska \
  --restart unless-stopped \
  -p 3002:8080 \
  -e CLOUD_USER="camiska" \
  -e CLOUD_PASSWORD="pon-una-clave-larga" \
  -e CLOUD_VIEWER_USER="visor" \
  -e CLOUD_VIEWER_PASSWORD="otra-clave-larga" \
  -e CLOUD_STORAGE_DIR="/data" \
  -v /ruta/del/disco/nube:/data \
  nube-camiska
```

El reverse proxy o Cloudflare Tunnel puede apuntar el dominio privado a:

```text
http://localhost:3002
```

## Variables

- `CLOUD_USER`: usuario de Basic Auth.
- `CLOUD_PASSWORD`: clave de Basic Auth para admin.
- `CLOUD_VIEWER_USER`: usuario opcional de solo lectura.
- `CLOUD_VIEWER_PASSWORD`: clave opcional de solo lectura.
- `CLOUD_USERS_JSON`: alternativa avanzada para definir varios usuarios.
  Ejemplo: `[{"username":"camilo","password":"...","role":"admin"},{"username":"familia","password":"...","role":"viewer"}]`.
- `CLOUD_STORAGE_DIR`: carpeta donde se guardan los archivos dentro del contenedor.
- `CLOUD_MAX_FILE_BYTES`: límite por archivo. Por defecto son 8 GB.
- `CLOUD_AUTH_MAX_ATTEMPTS`: intentos fallidos antes de bloquear IP. Por defecto `5`.
- `CLOUD_AUTH_BLOCK_MS`: duración del bloqueo. Por defecto `300000`.
- `PORT`: puerto interno del servidor. Por defecto `8080`.

## Notas importantes

- La seguridad real está en Basic Auth del servidor. En producción el servidor
  falla si no defines usuarios/clave.
- Usa una clave larga. Basic Auth es suficiente para uso privado, pero no uses
  claves simples si expones el dominio.
- Si lo publicas, usa HTTPS con Cloudflare Tunnel y no abras puertos directos del
  router.
- Los archivos quedan directamente en el volumen montado.
- Al eliminar desde la app, primero se mueve a `.trash`; al vaciar la papelera sí
  se borra del disco.
- Para celulares, la página usa el selector nativo de archivos; también acepta
  arrastrar y soltar desde computador.
- Backups automáticos a otro disco o servicios tipo Backblaze/S3 quedan como
  siguiente paso; esta versión deja la nube local lista y auditable.
