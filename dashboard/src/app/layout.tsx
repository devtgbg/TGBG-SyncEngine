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
          <a href="/calls">API calls</a>
          <a href="/pushes">To Zuper</a>
          <LiveRefresh />
        </nav>
        {children}
      </body>
    </html>
  );
}
