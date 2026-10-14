import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { authorizationUrl, GOOGLE_FEATURES, gmailEnabled, googleConfig, redirectUri, type GoogleFeature } from "@/lib/integrations/google";
import { Integrations } from "@/lib/integrations/store";
import { getBooks } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Starts Google sign-in for one or more features: /integrations/google/connect?feature=sheets&feature=calendar */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const cfg = googleConfig();
  if (!cfg) return NextResponse.redirect(new URL("/integrations?error=google-not-configured", url));
  const features = url.searchParams
    .getAll("feature")
    .filter((f): f is GoogleFeature => f in GOOGLE_FEATURES && (f !== "gmail" || gmailEnabled()));
  const books = await getBooks();
  const existing = await new Integrations(books.db, books.businessId).connection("google");
  const state = randomBytes(16).toString("base64url");
  const res = NextResponse.redirect(
    authorizationUrl(cfg, { features, state, redirectUri: redirectUri(url.origin), loginHint: existing?.account || undefined }),
  );
  res.cookies.set("ob_google_oauth", `${state}.${features.join(",")}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    maxAge: 600,
    path: "/integrations/google",
  });
  return res;
}
