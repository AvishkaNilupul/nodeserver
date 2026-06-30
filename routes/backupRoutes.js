const express = require("express");
const path = require("path");
const os = require("os");
const multer = require("multer");
const { requireSuperadmin } = require("../middleware/auth");
const backup = require("../utils/backup");

const router = express.Router();

// Uploaded restore archives land in a temp dir, not the repo. Accept only
// .tar.gz, up to 1 GB (a full DB + images snapshot).
const uploadDir = path.join(os.tmpdir(), "redeemer-restore-uploads");
const uploader = multer({
  dest: uploadDir,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.tar\.gz$|\.tgz$/i.test(file.originalname || "");
    cb(null, ok);
  },
});

// LIST existing backups (newest first).
router.get("/backups", requireSuperadmin, async (req, res) => {
  try {
    res.json({ success: true, dir: backup.BACKUP_DIR, backups: await backup.listBackups() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// CREATE a backup now. Returns its manifest so the UI can show what was saved.
router.post("/backups/run", requireSuperadmin, async (req, res) => {
  try {
    const r = await backup.createBackup({ reason: "manual" });
    res.json({ success: true, id: r.id, size: r.size, manifest: r.manifest });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// DOWNLOAD a specific backup archive.
router.get("/backups/download/:id", requireSuperadmin, (req, res) => {
  const p = backup.backupPath(req.params.id);
  if (!p) return res.status(400).json({ success: false, message: "Invalid backup id" });
  res.download(p, path.basename(p), (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ success: false, message: "Backup not found" });
    }
  });
});

// DELETE a backup.
router.delete("/backups/:id", requireSuperadmin, async (req, res) => {
  try {
    await backup.deleteBackup(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// RESTORE from an uploaded archive. Destructive, so it requires confirm=YES and
// always takes a safety backup of the current state first (handled in the util).
router.post(
  "/backups/restore",
  requireSuperadmin,
  uploader.single("backup"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "A .tar.gz backup file is required" });
    }
    if ((req.body.confirm || "") !== "YES") {
      await require("fs/promises").rm(req.file.path, { force: true }).catch(() => {});
      return res.status(400).json({ success: false, message: "Restore not confirmed" });
    }
    const drop = req.body.mode !== "merge"; // default: replace
    try {
      const summary = await backup.restoreBackup(req.file.path, { drop });
      res.json({ success: true, summary });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    } finally {
      require("fs/promises").rm(req.file.path, { force: true }).catch(() => {});
    }
  },
);

module.exports = router;
