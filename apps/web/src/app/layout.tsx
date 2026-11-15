import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "a2a — coordination for coding agents",
  description: "A shared inbox and project briefing for Claude Code, Codex, and the humans working with them.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
