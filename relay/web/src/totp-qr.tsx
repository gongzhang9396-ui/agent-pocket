import React, { useEffect, useRef, useState } from "react";

/** Generate locally: never send the authenticator secret to a QR service. */
export function TotpQr({ uri }: { uri?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null); const [failed, setFailed] = useState(false);
  const valid = uri?.startsWith("otpauth://totp/") ? uri : undefined;
  useEffect(() => {
    let cancelled = false; setFailed(false);
    if (valid) void import("qrcode").then((qr) => { if (!cancelled && canvas.current) return qr.default.toCanvas(canvas.current, valid, { width: 224, margin: 2, errorCorrectionLevel: "M" }); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [valid]);
  if (!valid) return null;
  return <div className="totp-setup">{!failed && <canvas ref={canvas} aria-label="验证器绑定二维码" role="img" />}<a href={valid}>在这台手机的验证器中打开</a><small>也可手动输入下方密钥；二维码和密钥只显示在当前页面。</small></div>;
}
