import type { Metadata } from "next";
import "./globals.css";
import { LiveRefresh } from "./live";

export const metadata: Metadata = {
  title: "Zupersync log",
  description: "What Zuper and Tuper sent, the API calls Zupersync made about it, and what is going back to Zuper.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="site">
          <strong>Zupersync</strong>
          <a href="/">Webhooks</a>
          <a href="/tuper">To Tuper</a>
          <a href="/pushes">To Zuper</a>
          <a href="/calls">API calls</a>
          <LiveRefresh />
        </nav>
        {children}
      </body>
    </html>
  );
}
