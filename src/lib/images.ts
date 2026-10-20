// Client-side image prep for the composer: validate, downscale, base64.
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");
const MAX_SIDE = 2000;
const MAX_BYTES = 3.75 * 1024 * 1024;

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** "very-long-report-name.pdf" -> "very-long-r…name.pdf" (keeps the extension visible). */
export function middleTruncate(name: string, max = 28): string {
  if (name.length <= max) return name;
  const tail = Math.ceil(max / 2) - 1;
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`;
}

export function isImageFile(f: File) {
  return IMAGE_TYPES.includes(f.type);
}

function load(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image"));
    };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode image"))), type, quality));
}

export function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Couldn't read that image"));
    r.readAsDataURL(blob);
  });
}

const stripPrefix = (url: string) => url.replace(/^data:[^,]*,/, "");

/** Downscales when the longest side > 2000 px or the file > 3.75 MB; returns base64 (no data: prefix) and the final type. */
export async function prepareImage(file: File): Promise<{ data: string; mediaType: string }> {
  const big = file.size > MAX_BYTES;
  // Small gifs go through untouched (re-encoding would drop the animation).
  if (file.type === "image/gif" && !big) return { data: stripPrefix(await toDataUrl(file)), mediaType: file.type };
  const img = await load(file);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (!big && longest <= MAX_SIDE) return { data: stripPrefix(await toDataUrl(file)), mediaType: file.type };

  let scale = Math.min(1, MAX_SIDE / longest);
  // png stays png only while it fits; photos and oversized files become jpeg.
  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't resize image");
    const asJpeg = file.type !== "image/png" || attempt > 0;
    if (asJpeg) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const type = asJpeg ? "image/jpeg" : "image/png";
    const blob = await toBlob(canvas, type, asJpeg ? 0.9 : undefined);
    if (blob.size <= MAX_BYTES || attempt === 3) return { data: stripPrefix(await toDataUrl(blob)), mediaType: type };
    scale *= 0.75;
  }
  throw new Error("Couldn't resize image");
}
