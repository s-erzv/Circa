import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Circa — Arisan On-Chain",
  description:
    "Arisan bareng temen, tanpa harus percaya satu orang buat pegang uangnya.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="id"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/*
          Telegram's Mini App bridge. Deliberately NOT pinned with
          Subresource Integrity: Telegram updates this file in place at a
          stable URL with no versioned build or published hash, so a pinned
          hash would break every session the moment they ship a change —
          trading a remote supply-chain risk for a guaranteed outage. A
          self-hosted copy is unsupported and would miss their security
          fixes.

          What makes that acceptable is that this script is never trusted for
          authorization. It supplies `initData`, which the server verifies by
          HMAC against the bot token (see lib/telegram-auth.ts). A tampered
          client cannot forge an identity, because the secret needed to sign
          one never reaches the browser.

          beforeInteractive: the app reads window.Telegram.WebApp on mount,
          so the bridge has to exist before hydration.
        */}
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
        {children}
      </body>
    </html>
  );
}
