const fs = require('fs');
const path = require('path');
const multer = require('multer');

const DEFAULT_ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp'
]);

const DEFAULT_ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp'
]);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getUploadRoot() {
  // Keep uploads under `server/` by default for predictable paths.
  return path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
}

function makeStorage(subdir) {
  const root = getUploadRoot();
  const dest = path.join(root, subdir);
  ensureDir(dest);
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dest),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 16);
      const name = `${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`;
      cb(null, name);
    }
  });
}

function getMaxUploadSize() {
  const raw = Number(process.env.UPLOAD_MAX_FILE_SIZE_BYTES || 5 * 1024 * 1024);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 1024 * 1024;
}

function buildUploadValidationError(message, status = 400) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function uploader(subdir, options = {}) {
  const allowedMimeTypes = new Set(options.allowedMimeTypes || DEFAULT_ALLOWED_IMAGE_MIME_TYPES);
  const allowedExtensions = new Set(options.allowedExtensions || DEFAULT_ALLOWED_IMAGE_EXTENSIONS);

  return multer({
    storage: makeStorage(subdir),
    limits: { fileSize: getMaxUploadSize() },
    fileFilter: (_req, file, cb) => {
      const mimeType = String(file?.mimetype || '').toLowerCase();
      const extension = path.extname(String(file?.originalname || '')).toLowerCase();

      if (!allowedMimeTypes.has(mimeType)) {
        return cb(buildUploadValidationError('Недопустимый MIME type файла', 415));
      }

      if (!allowedExtensions.has(extension)) {
        return cb(buildUploadValidationError('Недопустимое расширение файла', 415));
      }

      return cb(null, true);
    }
  });
}

module.exports = {
  getUploadRoot,
  uploader,
  getMaxUploadSize,
  DEFAULT_ALLOWED_IMAGE_MIME_TYPES
};
