import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zupersync log",
  description: "What Zuper sent, and what Zupersync did with it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="site">
          <strong>Zupersync</strong>
          <a href="/">From Zuper</a>
          <a href="/pushes">To Zuper</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
