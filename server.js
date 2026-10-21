import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";
const UPLOAD_DIR = path.resolve(__dirname, process.env.UPLOAD_DIR || "uploads");
const OUTPUT_DIR = path.resolve(__dirname, process.env.OUTPUT_DIR || "outputs");
const TEMP_DIR = path.resolve(__dirname, process.env.TEMP_DIR || "temp");
const MAX_FILE_SIZE_MB = Math.max(1, Number(process.env.MAX_FILE_SIZE_MB || 2048));
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mpeg", ".mpg", ".ts", ".mts", ".m2ts"
]);
const jobs = new Map();
const outputs = new Map();

function runProcess(command, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    child.on("error", error => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Could not start ${command}: ${error.message}`));
    });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      if (code === 0 && !timedOut) resolve({ stdout, stderr });
      else reject(new Error(timedOut ? "Video processing timed out." : (stderr.trim().split("\n").slice(-5).join("\n") || `${command} exited with code ${code}`)));
    });
  });
}

async function probeVideo(filePath) {
  const { stdout } = await runProcess(FFPROBE_PATH, [
    "-v", "error",
    "-show_entries", "format=duration,format_name,size:stream=index,codec_type,codec_name,width,height,duration",
    "-of", "json",
    filePath
  ], { timeoutMs: 30_000 });
  const data = JSON.parse(stdout);
  const duration = Number(data.format?.duration || data.streams?.find(s => s.codec_type === "video")?.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not determine the video's duration.");
  return {
    duration,
    size: Number(data.format?.size || fs.statSync(filePath).size),
    formatName: data.format?.format_name || "unknown",
    streams: (data.streams || []).map(s => ({
      type: s.codec_type,
      codec: s.codec_name,
      width: s.width || null,
      height: s.height || null
    }))
  };
}

function safeOriginalName(name) {
  const basename = path.basename(name || "video");
  return basename.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 180) || "video";
}

function videoMimeType(ext) {
  const types = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
    ".mpeg": "video/mpeg", ".mpg": "video/mpeg", ".ts": "video/mp2t",
    ".mts": "video/mp2t", ".m2ts": "video/mp2t"
  };
  return types[ext] || "application/octet-stream";
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job) {
    const error = new Error("Video upload not found. Please upload the video again.");
    error.status = 404;
    throw error;
  }
  return job;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`)
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) return cb(new Error("Unsupported video extension. Try MP4, MOV, MKV, WebM, AVI, or another supported video container."));
    cb(null, true);
  }
});

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (_req, res) => {
  let ffmpeg = false;
  let ffprobe = false;
  try { await runProcess(FFMPEG_PATH, ["-version"], { timeoutMs: 5000 }); ffmpeg = true; } catch {}
  try { await runProcess(FFPROBE_PATH, ["-version"], { timeoutMs: 5000 }); ffprobe = true; } catch {}
  res.json({ ok: ffmpeg && ffprobe, ffmpeg, ffprobe });
});

app.post("/api/upload", upload.single("video"), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: "Choose a video file to upload." });
  try {
    const metadata = await probeVideo(req.file.path);
    const id = randomUUID();
    const ext = path.extname(req.file.originalname).toLowerCase();
    const job = {
      id,
      path: req.file.path,
      originalName: safeOriginalName(req.file.originalname),
      extension: ext,
      metadata,
      uploadedAt: Date.now()
    };
    jobs.set(id, job);
    res.json({
      id,
      name: job.originalName,
      duration: metadata.duration,
      size: metadata.size,
      formatName: metadata.formatName,
      streams: metadata.streams,
      previewUrl: `/api/videos/${id}/preview`
    });
  } catch (error) {
    fs.rm(req.file.path, { force: true }, () => {});
    next(new Error(`Unable to read this video. Check that FFmpeg/FFprobe are installed and the file is valid. ${error.message}`));
  }
});

app.get("/api/videos/:id/preview", (req, res, next) => {
  try {
    const job = getJob(req.params.id);
    res.setHeader("Content-Type", videoMimeType(job.extension));
    res.sendFile(job.path, error => { if (error && !res.headersSent) next(error); });
  } catch (error) { next(error); }
});

app.post("/api/cut", async (req, res, next) => {
  const { id, startTime, endTime } = req.body || {};
  try {
    const job = getJob(String(id || ""));
    const start = Number(startTime);
    const end = Number(endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return res.status(400).json({ error: "Enter valid start and end times in seconds." });
    }
    if (start < 0 || end <= start) {
      return res.status(400).json({ error: "The end time must be greater than the start time, and the start time cannot be negative." });
    }
    if (end > job.metadata.duration + 0.001) {
      return res.status(400).json({ error: "The end time cannot exceed the video's duration." });
    }

    const outputId = randomUUID();
    const ext = job.extension;
    const outputName = `${path.basename(job.originalName, path.extname(job.originalName))}-clip-${outputId.slice(0, 8)}${ext}`;
    const outputPath = path.join(OUTPUT_DIR, outputName);
    const clipDuration = end - start;

    // Stream copy: no decoding/re-encoding. Keyframe placement may make the actual
    // first/last displayed frames differ slightly from the requested timestamps.
    const args = [
      "-hide_banner", "-y",
      "-ss", start.toFixed(3),
      "-i", job.path,
      "-t", clipDuration.toFixed(3),
      "-map", "0",
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      "-movflags", "+faststart",
      outputPath
    ];

    await runProcess(FFMPEG_PATH, args, { timeoutMs: 10 * 60 * 1000 });
    const stat = fs.statSync(outputPath);
    if (!stat.size) throw new Error("FFmpeg produced an empty output file.");
    const resultMetadata = await probeVideo(outputPath);
    outputs.set(outputId, { path: outputPath, name: outputName, createdAt: Date.now() });

    res.json({
      id: outputId,
      name: outputName,
      downloadUrl: `/api/outputs/${outputId}/download`,
      previewUrl: `/api/outputs/${outputId}/preview`,
      requestedDuration: clipDuration,
      actualDuration: resultMetadata.duration,
      size: stat.size,
      note: "Stream copying was used; no video or audio re-encoding was performed. Keyframe boundaries may cause the actual cut to differ slightly from the requested timestamps."
    });
  } catch (error) { next(error); }
});

app.get("/api/outputs/:id/download", (req, res, next) => {
  const output = outputs.get(req.params.id);
  if (!output || !fs.existsSync(output.path)) return res.status(404).json({ error: "The output file is no longer available." });
  res.download(output.path, output.name, error => { if (error && !res.headersSent) next(error); });
});

app.get("/api/outputs/:id/preview", (req, res, next) => {
  const output = outputs.get(req.params.id);
  if (!output || !fs.existsSync(output.path)) return res.status(404).json({ error: "The output file is no longer available." });
  res.setHeader("Content-Type", videoMimeType(path.extname(output.name).toLowerCase()));
  res.sendFile(output.path, error => { if (error && !res.headersSent) next(error); });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? `File exceeds the ${MAX_FILE_SIZE_MB} MB upload limit.`
      : error.message;
    return res.status(400).json({ error: message });
  }
  const status = error.status || 500;
  const message = status === 500 && process.env.NODE_ENV === "production"
    ? "Something went wrong while processing the video."
    : error.message || "Unexpected server error.";
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`ClipCut is running at http://localhost:${PORT}`);
  console.log(`Upload limit: ${MAX_FILE_SIZE_MB} MB`);
});
