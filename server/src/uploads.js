const fs = require('fs');
const path = require('path');
const multer = require('multer');

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

function uploader(subdir) {
  return multer({
    storage: makeStorage(subdir),
    limits: { fileSize: 5 * 1024 * 1024 }
  });
}

module.exports = { getUploadRoot, uploader };
