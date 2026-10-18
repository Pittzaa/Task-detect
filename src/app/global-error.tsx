"use client";

/**
 * Last resort: used only when the root layout itself fails, so none of the app's providers, styles or dictionary exist here.
 * It therefore carries its own two-language text and minimal inline styling (a nonce-less inline `style` attribute is allowed
 * by `style-src-attr`).
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : "";
  return (
    <html lang="th">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem 1rem", background: "#fff", color: "#111" }}>
        <main style={{ maxWidth: 480, margin: "0 auto" }} role="alert">
          <h1 style={{ fontSize: "1.4rem" }}>เกิดข้อผิดพลาด / Something went wrong</h1>
          <p>ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง<br />A temporary problem occurred. Please try again.</p>
          {digest && <p style={{ color: "#555", fontSize: "0.85rem" }}>Ref: {digest}</p>}
          <button onClick={() => retry()} style={{ padding: "0.5rem 1rem", fontSize: "1rem" }}>ลองใหม่ / Retry</button>
        </main>
      </body>
    </html>
  );
}
