# ClipCut — Lossless Video Cutter

ClipCut is a local Node.js + Express app with an HTML interface. Upload a video, preview it, choose start and end times, calculate the selected duration, and download the cut clip.

The cutter uses FFmpeg stream copying (`-c copy`) rather than re-encoding. This avoids video/audio quality loss from re-encoding and preserves the encoded streams where the source container and codecs permit it.

## Requirements

- Node.js 20 or newer
- FFmpeg and FFprobe installed and available on `PATH` (or configured in `.env`)
- A browser with HTML5 video support

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install ffmpeg
```

Check the tools:

```bash
ffmpeg -version
ffprobe -version
node --version
npm --version
```

## Install and run

```bash
cd ClipCut
npm install
npm start
```

Open <http://localhost:3000>.

For development with automatic Node.js restart:

```bash
npm run dev
```

## Configuration

Edit `.env`:

```dotenv
PORT=3000
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
UPLOAD_DIR=uploads
OUTPUT_DIR=outputs
TEMP_DIR=temp
MAX_FILE_SIZE_MB=2048
```

`FFMPEG_PATH` and `FFPROBE_PATH` can be absolute paths if the binaries are not on `PATH`. Upload size is limited to 2048 MB by default.

## How to use

1. Select a video or drag it into the upload area.
2. Preview it in the browser.
3. Enter start and end times as `HH:MM:SS` (for example, `00:01:20` to `00:01:50`).
4. Check the automatically calculated selected duration.
5. Click **Cut video**, then preview or download the output.

The preview's **Use preview** buttons copy the current player position into the start or end field. Sliders provide rough positioning.

## Lossless cutting and keyframe limitation

ClipCut invokes FFmpeg in stream-copy mode. It does not encode the video or audio again. This preserves encoded quality and avoids re-encoding, but there is a fundamental trade-off:

- Most inter-frame codecs (such as H.264/H.265) use keyframes and dependent frames.
- When stream-copy seeking, FFmpeg may seek to a nearby keyframe. The resulting cut's first or last displayed frame can differ from the requested timestamp.
- Stream copying does not guarantee frame-accurate cuts. A true frame-accurate cut commonly requires re-encoding at least part of the clip.
- Some stream/container combinations cannot be copied into the same container. The app retains the original filename extension and asks FFmpeg to copy all streams; unsupported combinations can fail rather than silently re-encode.
- The output duration reported by FFprobe may differ slightly from the requested duration.

The app uses `-map 0 -c copy` to copy all input streams. Some unusual subtitle, data, or attachment streams may not be supported by every output container.

## Project structure

```text
ClipCut/
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── uploads/
├── outputs/
├── temp/
├── .env
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── README.md
└── server.js
```

## API overview

- `GET /api/health` — check FFmpeg and FFprobe availability
- `POST /api/upload` — upload a video and read metadata
- `GET /api/videos/:id/preview` — preview an uploaded video
- `POST /api/cut` — cut the selected time range
- `GET /api/outputs/:id/preview` — preview a result
- `GET /api/outputs/:id/download` — download a result

## Storage and cleanup

Uploaded files and outputs are kept in local `uploads/` and `outputs/` folders. This starter app does not automatically delete them. Remove files from those folders manually when you no longer need them. Do not expose this server to an untrusted network without adding authentication, cleanup policies, and stricter upload controls.

## Notes

- Supported extensions are configured in `server.js`.
- `temp/` is reserved for future temporary processing needs.
- The app does not alter the uploaded source file.
