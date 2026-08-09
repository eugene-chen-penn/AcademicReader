// Conversions between base64/data-URLs and Blobs, needed now that crop
// images live as IndexedDB Blobs instead of PNG files on a backend disk.

const DATA_URL_PREFIX_RE = /^data:([^;]+);base64,/;

/**
 * Accepts either bare base64 or a `data:image/...;base64,` URL (the
 * natural output of canvas.toDataURL(), used by region-select.ts) and
 * returns a Blob. Mirrors the old backend's
 * app/routers/highlights.py::_decode_image_base64.
 */
export function base64OrDataUrlToBlob(input: string, fallbackMimeType = "image/png"): Blob {
  const trimmed = input.trim();
  const match = trimmed.match(DATA_URL_PREFIX_RE);
  const mimeType = match ? match[1] : fallbackMimeType;
  const base64 = match ? trimmed.slice(match[0].length) : trimmed;

  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    bytes[i] = byteChars.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/** Returns base64 WITHOUT a `data:...;base64,` prefix, for providers that want raw base64. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const idx = result.indexOf(",");
      resolve(idx === -1 ? result : result.slice(idx + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("failed to read blob"));
    reader.readAsDataURL(blob);
  });
}
