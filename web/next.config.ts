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
};

export default nextConfig;
