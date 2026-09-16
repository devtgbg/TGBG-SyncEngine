import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zupersync — delivery log",
  description: "What Zuper sent, and what Zupersync did with it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
