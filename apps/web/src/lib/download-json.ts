export function downloadJson(value: unknown, filename: string) {
  downloadBlob(JSON.stringify(value, null, 2), filename);
}

/** Keep the URL alive until the browser has consumed the attached download link. */
export function downloadBlob(content: BlobPart, filename: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
