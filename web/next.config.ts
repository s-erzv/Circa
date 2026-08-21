import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Wildcards, not the specific subdomain ngrok happens to hand out —
  // ngrok's free tier assigns a new random subdomain every time the tunnel
  // restarts, so pinning one exact hostname breaks on the very next `ngrok
  // http 3000`. This is dev-server HMR/static-asset access control only,
  // not a security boundary the app's own auth relies on (that's initData
  // verification, unrelated to this list).
  allowedDevOrigins: [
    '127.0.0.1',
    'localhost',
    '*.ngrok-free.app',
    '*.ngrok-free.dev',
    '*.ngrok.io',
  ],
  // Declares that WE don't restrict WebAuthn for ourselves or same-origin
  // embeds. This does NOT guarantee WebAuthn works inside Telegram's own
  // iframe (Telegram Desktop/Web) — that delegation is controlled by the
  // `allow` attribute on Telegram's OWN iframe embedding us, which is
  // entirely their call, not something a header on our responses can
  // override. Kept anyway as the correct default; the actual fix for the
  // iframe case is the automatic system-browser fallback in passkey.ts
  // (isWebAuthnBlockedError), which works regardless of this header.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Permissions-Policy',
            value: 'publickey-credentials-create=*, publickey-credentials-get=*',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
