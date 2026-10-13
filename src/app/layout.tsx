import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Open Books",
  description: "Free, open-source bookkeeping for small businesses.",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/timeline", label: "Timeline" },
  { href: "/transactions", label: "Transactions" },
  { href: "/import", label: "Import" },
  { href: "/rules", label: "Rules" },
  { href: "/reports", label: "Tax report" },
  { href: "/categories", label: "Categories" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">Open Books</Link>
          <nav aria-label="Main">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}>{n.label}</Link>
            ))}
          </nav>
        </header>
        <main>{children}</main>
        <footer className="footer muted">
          Open Books is free, open-source software. It helps you organize your records; it is not tax or legal advice.
        </footer>
      </body>
    </html>
  );
}
