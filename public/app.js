const $ = (selector) => document.querySelector(selector);

const uploadPanel = $("#uploadPanel");
const videoFile = $("#videoFile");
const editor = $("#editor");
const videoPreview = $("#videoPreview");
const startInput = $("#startTime");
const endInput = $("#endTime");
const startRange = $("#startRange");
const endRange = $("#endRange");
const cutButton = $("#cutButton");
const busyOverlay = $("#busyOverlay");
const errorBox = $("#errorBox");
const resultPanel = $("#resultPanel");

let currentVideo = null;
let isBusy = false;

function formatTime(seconds, includeHours = true) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return includeHours || hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseTime(value) {
  const text = String(value).trim();
  if (!/^\d{1,6}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(text)) return NaN;
  const [hours, minutes, seconds] = text.split(":").map(Number);
  if (minutes > 59 || seconds >= 60) return NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}
function clearError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}
function setBusy(busy, title = "Processing video…", message = "This can take a little while for large files.") {
  isBusy = busy;
  busyOverlay.classList.toggle("hidden", !busy);
  $("#busyTitle").textContent = title;
  $("#busyText").textContent = message;
  cutButton.disabled = busy;
  videoFile.disabled = busy;
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function updateSelection({ fromSlider = false } = {}) {
  if (!currentVideo) return;
  const start = fromSlider && document.activeElement === startRange
    ? Number(startRange.value) : parseTime(startInput.value);
  const end = fromSlider && document.activeElement === endRange
    ? Number(endRange.value) : parseTime(endInput.value);

  if (fromSlider && document.activeElement === startRange) startInput.value = formatTime(start);
  if (fromSlider && document.activeElement === endRange) endInput.value = formatTime(end);

  const valid = Number.isFinite(start) && Number.isFinite(end) &&
    start >= 0 && end > start && end <= currentVideo.duration + 0.001;
  if (valid) {
    $("#clipDuration").textContent = formatTime(end - start);
    $("#durationStatus").textContent = "Ready to trim";
    $("#durationStatus").style.color = "var(--accent)";
    cutButton.disabled = isBusy;
    clearError();
  } else {
    $("#clipDuration").textContent = "—";
    $("#durationStatus").textContent = "Check time range";
    $("#durationStatus").style.color = "var(--danger)";
    cutButton.disabled = true;
  }
  if (Number.isFinite(start)) startRange.value = Math.max(0, Math.min(currentVideo.duration, start));
  if (Number.isFinite(end)) endRange.value = Math.max(0, Math.min(currentVideo.duration, end));
}

async function uploadVideo(file) {
  if (!file) return;
  clearError();
  resultPanel.classList.add("hidden");
  setBusy(true, "Loading your video…", "Uploading and reading video metadata.");
  try {
    const form = new FormData();
    form.append("video", file);
    const data = await api("/api/upload", { method: "POST", body: form });
    currentVideo = data;
    $("#videoName").textContent = data.name;
    $("#originalDuration").textContent = formatTime(data.duration);
    $("#originalSize").textContent = formatSize(data.size);
    videoPreview.src = data.previewUrl;
    videoPreview.load();
    uploadPanel.classList.add("hidden");
    editor.classList.remove("hidden");
    const duration = data.duration;
    startRange.min = "0";
    startRange.max = String(duration);
    endRange.min = "0";
    endRange.max = String(duration);
    startRange.step = "0.1";
    endRange.step = "0.1";
    startInput.value = "00:00:00";
    endInput.value = formatTime(Math.min(10, Math.floor(duration)));
    updateSelection();
    videoPreview.addEventListener("loadedmetadata", () => {
      // Browser preview metadata is informational; server-side FFprobe duration is authoritative.
    }, { once: true });
  } catch (error) {
    showError(error.message);
    uploadPanel.classList.remove("hidden");
  } finally {
    setBusy(false);
  }
}

videoFile.addEventListener("change", () => uploadVideo(videoFile.files?.[0]));
$("#changeVideo").addEventListener("click", () => {
  if (isBusy) return;
  currentVideo = null;
  videoPreview.pause();
  videoPreview.removeAttribute("src");
  videoPreview.load();
  editor.classList.add("hidden");
  uploadPanel.classList.remove("hidden");
  videoFile.value = "";
  clearError();
});
$("#setStart").addEventListener("click", () => {
  if (!currentVideo) return;
  startInput.value = formatTime(videoPreview.currentTime);
  updateSelection();
});
$("#setEnd").addEventListener("click", () => {
  if (!currentVideo) return;
  endInput.value = formatTime(videoPreview.currentTime);
  updateSelection();
});
startInput.addEventListener("change", () => updateSelection());
endInput.addEventListener("change", () => updateSelection());
startInput.addEventListener("input", () => updateSelection());
endInput.addEventListener("input", () => updateSelection());
startRange.addEventListener("input", () => updateSelection({ fromSlider: true }));
endRange.addEventListener("input", () => updateSelection({ fromSlider: true }));

cutButton.addEventListener("click", async () => {
  if (!currentVideo || isBusy) return;
  clearError();
  const startTime = parseTime(startInput.value);
  const endTime = parseTime(endInput.value);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime || endTime > currentVideo.duration + 0.001) {
    showError("Please enter a valid start and end time within the original video's duration.");
    return;
  }

  setBusy(true, "Cutting your video…", "ClipCut is copying the selected streams without re-encoding.");
  try {
    const result = await api("/api/cut", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: currentVideo.id, startTime, endTime })
    });
    $("#resultPreview").src = result.previewUrl;
    $("#resultPreview").load();
    $("#resultDuration").textContent = formatTime(result.actualDuration);
    $("#resultSize").textContent = formatSize(result.size);
    $("#resultNote").textContent = result.note;
    $("#downloadButton").href = result.downloadUrl;
    $("#downloadButton").setAttribute("download", result.name);
    resultPanel.classList.remove("hidden");
    resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
});

uploadPanel.addEventListener("dragover", (event) => {
  event.preventDefault();
  uploadPanel.classList.add("dragover");
});
uploadPanel.addEventListener("dragleave", () => uploadPanel.classList.remove("dragover"));
uploadPanel.addEventListener("drop", (event) => {
  event.preventDefault();
  uploadPanel.classList.remove("dragover");
  const file = event.dataTransfer?.files?.[0];
  if (file) uploadVideo(file);
});

(async () => {
  try {
    const health = await api("/api/health");
    $("#uploadLimit").textContent = health.ok
      ? "Maximum upload size is configured by the server. FFmpeg and FFprobe are ready."
      : "FFmpeg or FFprobe could not be found. Install them and check your .env paths.";
    if (!health.ok) $("#uploadLimit").classList.add("warning");
  } catch {
    $("#uploadLimit").textContent = "Could not check server tools.";
  }
})();
