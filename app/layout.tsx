import Script from "next/script";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentKit demo",
  description: "Demo of ChatKit with hosted workflow",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Preload the web component for non-React usage / fallback */}
        <Script
          src="https://cdn.platform.openai.com/deployments/chatkit/chatkit.js"
          strategy="beforeInteractive"
        />
      </head>
      <body
        className="antialiased"
        style={{
          margin: 0,
          minHeight: "100dvh",
          // Soft radial background (light)
          background:
            "radial-gradient(1200px 800px at 10% -10%, #DDE6FF 0%, #EEF2FF 35%, #F8FAFF 100%)",
          color: "var(--foreground)",
        }}
      >
        {children}
      </body>
    </html>
  );
}
