# Nube Camiska

Web app privada para subir, organizar, ver, compartir y borrar archivos
guardados en el disco conectado a la Raspberry. El frontend está hecho con Vite
+ TypeScript y el backend es un servidor Node pequeño, sin base de datos.

## Funciones

- Subida múltiple desde PC o celular, con cola, progreso y errores por archivo.
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
- Sesión persistente independiente por dispositivo, válida durante siete días.
- Bloqueo por IP durante 15 minutos después de cinco intentos fallidos.
- Registro de las sesiones y de los 200 eventos de acceso más recientes.
- Links compartibles temporales.
- Dashboard básico de almacenamiento y tipos de archivo.
- Pantalla de acceso propia con sesiones seguras y las mismas credenciales configuradas en el servidor.
- Bibliotecas globales de archivos recientes, fotos y videos.
- PWA instalable en Android, iPhone/iPad y computadores, con iconos adaptativos,
  modo independiente, actualizaciones y una pantalla segura sin conexión.
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

## Instalar como aplicación

En producción abre la nube mediante su dominio HTTPS. En Android y navegadores
de escritorio aparecerá la acción **Instalar** dentro de la aplicación o en la
barra del navegador. En iPhone/iPad abre el menú **Compartir** de Safari y elige
**Añadir a pantalla de inicio**.

El service worker guarda únicamente la interfaz estática necesaria para iniciar
la aplicación. Por seguridad, nunca almacena en caché respuestas de `/api`,
`/files` ni `/share`; los archivos privados siguen requiriendo conexión con la
Raspberry.

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
  -e CLOUD_SECURITY_TOKEN="token-interno-largo" \
  -e CLOUD_STORAGE_DIR="/data" \
  -v /ruta/del/disco/nube:/data \
  nube-camiska:latest
```

## Notas rápidas

Además de pasar archivos entre dispositivos, puedes usar la nube para pasarte texto/notas rápidas.

La forma más simple es crear archivos `.txt` dentro de tu carpeta de nube:

1. Entra a la nube desde cualquier dispositivo.
2. Crea una carpeta llamada `Notas` (opcional, para mantener orden).
3. Crea un archivo nuevo, por ejemplo: `nota-rapida-2026-05-27.txt`.
4. Escribe el texto y guarda.

Así tendrás una sección práctica de notas sincronizadas entre tus dispositivos sin cambiar el flujo actual de la app.
El reverse proxy o Cloudflare Tunnel puede apuntar el dominio privado a:

```text
http://localhost:3002
```

## Variables

- `CLOUD_USER`: usuario administrador.
- `CLOUD_PASSWORD`: contraseña del administrador.
- `CLOUD_VIEWER_USER`: usuario opcional de solo lectura.
- `CLOUD_VIEWER_PASSWORD`: clave opcional de solo lectura.
- `CLOUD_USERS_JSON`: alternativa avanzada para definir varios usuarios.
  Ejemplo: `[{"username":"camilo","password":"...","role":"admin"},{"username":"familia","password":"...","role":"viewer"}]`.
- `CLOUD_STORAGE_DIR`: carpeta donde se guardan los archivos dentro del contenedor.
- `CLOUD_MAX_FILE_BYTES`: límite por archivo. Por defecto son 8 GB.
- `CLOUD_AUTH_MAX_ATTEMPTS`: intentos fallidos antes de bloquear IP. Por defecto `5`.
- `CLOUD_AUTH_WINDOW_MS`: ventana de intentos. Por defecto `900000` (15 minutos).
- `CLOUD_AUTH_BLOCK_MS`: duración del bloqueo. Por defecto `900000` (15 minutos).
- `CLOUD_SESSION_DURATION_MS`: duración de sesión. Por defecto siete días.
- `CLOUD_SECURITY_TOKEN`: secreto compartido con App Hub para consultar sesiones.
- `PORT`: puerto interno del servidor. Por defecto `8080`.

## Notas importantes

- La pantalla de acceso valida las credenciales en el servidor y crea una cookie
  de sesión `HttpOnly`, `SameSite=Strict`, válida durante siete días. En producción
  el servidor falla si no defines usuarios/clave.
- `CLOUD_USER`, `CLOUD_PASSWORD` y `CLOUD_USERS_JSON` siguen siendo la única
  fuente de usuarios: el nuevo login no crea ni cambia contraseñas.
- Usa una clave larga y un valor distinto, largo y aleatorio para `CLOUD_SECURITY_TOKEN`.
- Si lo publicas, usa HTTPS con Cloudflare Tunnel y no abras puertos directos del
  router.
- Los archivos quedan directamente en el volumen montado.
- Al eliminar desde la app, primero se mueve a `.trash`; al vaciar la papelera sí
  se borra del disco.
- Para celulares, la página usa el selector nativo de archivos; también acepta
  arrastrar y soltar desde computador.
- Backups automáticos a otro disco o servicios tipo Backblaze/S3 quedan como
  siguiente paso; esta versión deja la nube local lista y auditable.

## Conectar las sesiones con App Hub

Genera un token una sola vez:

```bash
openssl rand -hex 32
```

Usa el mismo valor como `CLOUD_SECURITY_TOKEN` en Nube y configura en App Hub:

```env
NUBE_SECURITY_URL=https://tu-dominio-nube/api/internal/security
NUBE_SECURITY_TOKEN=el-mismo-token
```

La API interna no expone contraseñas y responde como una ruta inexistente si el
token no coincide.

## Desbloquear accesos

```bash
docker exec nube-camiska node server/index.js --list-locks
docker exec nube-camiska node server/index.js --unlock-ip 192.0.2.10
docker exec nube-camiska node server/index.js --unlock-all
```
