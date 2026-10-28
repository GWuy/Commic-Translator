/** Capture pixels already displayed by the page when their URL cannot be downloaded by the worker. */
export async function captureImage(image: HTMLImageElement): Promise<{
  imageData: string;
  contentId: string;
}> {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight)
    throw new Error("Ảnh chưa tải xong.");

  const scale = Math.min(
    1,
    3000 / image.naturalWidth,
    6000 / image.naturalHeight,
    Math.sqrt(12_000_000 / (image.naturalWidth * image.naturalHeight)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Trình duyệt không tạo được canvas ảnh.");
  try {
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  } catch {
    throw new Error(
      "Không đọc được ảnh đã hiển thị; trang web chặn truy cập pixel ảnh.",
    );
  }

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("Không mã hóa được ảnh.")),
      "image/jpeg",
      0.88,
    ),
  ).catch(() => {
    throw new Error(
      "Không đọc được ảnh đã hiển thị; trang web chặn truy cập pixel ảnh.",
    );
  });
  if (blob.size > 12 * 1024 * 1024)
    throw new Error("Ảnh sau khi xử lý vẫn quá lớn (12 MB).");

  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  const contentId = `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  const imageData = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Không đọc được dữ liệu ảnh."));
    reader.readAsDataURL(blob);
  });
  return { imageData, contentId };
}
