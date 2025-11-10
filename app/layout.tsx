import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Chat",
  description: "ChatKit + Agent Builder",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background:
            "radial-gradient(1200px 800px at 10% -10%, #DDE6FF 0%, #EEF2FF 35%, #F8FAFF 100%)",
          color: "#0F172A",
        }}
      >
        {children}
      </body>
    </html>
  );
}
