import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = { title: "Portfolio Review", description: "Portfolio and research review for simulated holdings." };

export default function Layout({children}: {children: React.ReactNode}) {
  return <html lang="en"><body><main>{children}</main></body></html>;
}
