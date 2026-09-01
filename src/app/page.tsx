import { redirect } from "next/navigation";

// The app has no landing page — / is just an entry point to the dashboard.
// Server-side redirect: no client render, no flash.
export default function Home() {
  redirect("/dashboard");
}
