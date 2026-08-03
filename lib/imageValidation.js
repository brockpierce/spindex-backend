// Validation for base64 image data URLs coming from clients.
//
// The frontend compresses images before upload, but the client can be bypassed,
// so the server independently enforces media type + size. Shared by avatar
// uploads (routes/auth.js) and post images (routes/posts.js, phase 2).

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

// Approx decoded byte length of a base64 data URL payload, without decoding it.
// 4 base64 chars encode 3 bytes; subtract padding.
function dataUrlByteLength(value) {
  const comma = value.indexOf(",");
  if (comma === -1) return 0;
  const b64 = value.slice(comma + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// Returns an error string if invalid, or null if the value is an acceptable
// image data URL under maxBytes.
function validateImageDataUrl(value, maxBytes) {
  if (typeof value !== "string") return "Invalid image.";
  const m = value.match(/^data:([a-z0-9/+.\-]+);base64,/i);
  if (!m) return "Image must be a base64 data URL.";
  if (!ALLOWED_IMAGE_TYPES.has(m[1].toLowerCase())) {
    return "Unsupported image type. Use JPEG, PNG, WebP or GIF.";
  }
  if (dataUrlByteLength(value) > maxBytes) {
    const kb = Math.round(maxBytes / 1024);
    return `Image is too large. Please use one under ${kb} KB.`;
  }
  return null;
}

module.exports = { validateImageDataUrl, dataUrlByteLength, ALLOWED_IMAGE_TYPES };
