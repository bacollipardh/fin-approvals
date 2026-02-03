import multer from 'multer';
import path from 'path';
import fs from 'fs';

const root = process.cwd();
const uploadDir = path.join(root, 'server', 'files', 'requests');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/\s+/g,'_');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { files: 5, fileSize: 5 * 1024 * 1024 } // 5 file, 5MB secila
});

export const uploadPhotos = upload.array('photos', 5);
