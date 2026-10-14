import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode, googleConfig, redirectUri, type GoogleTokens } from "@/lib/integrations/google";
import { Integrations } from "@/lib/integrations/store";
import { getBooks } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Google sends the owner back here after they approve (or decline) access. */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const back = (params: Record<string, string>) => {
    const res = NextResponse.redirect(new URL(`/integrations?${new URLSearchParams(params)}`, url));
    res.cookies.delete({ name: "ob_google_oauth", path: "/integrations/google" });
    return res;
  };
  const cfg = googleConfig();
  if (!cfg) return back({ error: "google-not-configured" });
  const [state, features = ""] = (request.cookies.get("ob_google_oauth")?.value ?? "").split(".");
  if (!state || url.searchParams.get("state") !== state) return back({ error: "google-state" });
  const denied = url.searchParams.get("error");
  if (denied) return back({ error: denied === "access_denied" ? "google-denied" : "google-failed" });
  const code = url.searchParams.get("code");
  if (!code) return back({ error: "google-failed" });

  try {
    const granted = await exchangeCode(cfg, code, redirectUri(url.origin));
    const books = await getBooks();
    const integrations = new Integrations(books.db, books.businessId);
    const previous = await integrations.credentials<GoogleTokens>("google");
    const tokens: GoogleTokens = { ...granted.tokens, refreshToken: granted.tokens.refreshToken || previous?.refreshToken || "" };
    if (!tokens.refreshToken) return back({ error: "google-no-refresh" });
    await integrations.saveConnection("google", { account: granted.email, scopes: granted.scopes, credentials: tokens });
    return back({ connected: features || "google" });
  } catch (err) {
    console.warn("[open-books] Google sign-in failed:", (err as Error).message);
    return back({ error: "google-failed" });
  }
}
