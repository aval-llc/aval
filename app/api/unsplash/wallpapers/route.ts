import { env } from "cloudflare:workers";

interface UnsplashPhoto {
  id: string;
  alt_description?: string | null;
  description?: string | null;
  color?: string | null;
  urls?: { raw?: string; regular?: string; small?: string };
  links?: { html?: string; download_location?: string };
  user?: { name?: string; username?: string; links?: { html?: string } };
}

const UTM = "utm_source=aval&utm_medium=referral";

const fallbackWallpapers = [
  {
    id: "aval-fallback-lake",
    imageUrl: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1800&q=86",
    thumbnailUrl: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=360&q=72",
    alt: "Mountain lake beneath a cloudy sky",
    color: "#526d67",
    photographer: "Luca Bravo",
    photographerUrl: `https://unsplash.com/@lucabravo?${UTM}`,
    photoUrl: `https://unsplash.com/photos/landscape-photography-of-mountains-near-body-of-water-during-daytime-lake-and-mountain-O453M2Liufs?${UTM}`,
    downloadLocation: null,
  },
  {
    id: "aval-fallback-valley",
    imageUrl: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1800&q=86",
    thumbnailUrl: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=360&q=72",
    alt: "A green landscape at golden hour",
    color: "#6f7655",
    photographer: "Robert Lukeman",
    photographerUrl: `https://unsplash.com/@robertlukeman?${UTM}`,
    photoUrl: `https://unsplash.com/photos/green-grass-field-during-sunset-_RBcxo9AU-U?${UTM}`,
    downloadLocation: null,
  },
] as const;

function withImageParameters(value: string | undefined, width: number, quality: number) {
  if (!value) return null;
  const url = new URL(value);
  url.searchParams.set("auto", "format");
  url.searchParams.set("fit", "crop");
  url.searchParams.set("w", String(width));
  url.searchParams.set("q", String(quality));
  return url.toString();
}

export async function GET() {
  const bindings = env as unknown as Record<string, unknown>;
  const accessKey = typeof bindings.UNSPLASH_ACCESS_KEY === "string" ? bindings.UNSPLASH_ACCESS_KEY : "";

  if (!accessKey) {
    return Response.json(
      { wallpapers: fallbackWallpapers, source: "fallback" },
      { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } },
    );
  }

  try {
    const response = await fetch("https://api.unsplash.com/topics/wallpapers/photos?orientation=landscape&order_by=latest&per_page=12", {
      headers: { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" },
    });
    if (!response.ok) throw new Error(`Unsplash returned ${response.status}`);
    const photos = (await response.json()) as UnsplashPhoto[];
    const wallpapers = photos.flatMap((photo) => {
      const imageUrl = withImageParameters(photo.urls?.raw ?? photo.urls?.regular, 1800, 86);
      const thumbnailUrl = withImageParameters(photo.urls?.raw ?? photo.urls?.small, 360, 72);
      const username = photo.user?.username;
      if (!imageUrl || !thumbnailUrl || !photo.user?.name || !username || !photo.links?.html) return [];
      return [{
        id: photo.id,
        imageUrl,
        thumbnailUrl,
        alt: photo.alt_description ?? photo.description ?? "Unsplash wallpaper",
        color: photo.color ?? "#55645d",
        photographer: photo.user.name,
        photographerUrl: `${photo.user.links?.html ?? `https://unsplash.com/@${username}`}?${UTM}`,
        photoUrl: `${photo.links.html}?${UTM}`,
        downloadLocation: photo.links.download_location ?? null,
      }];
    });
    if (!wallpapers.length) throw new Error("Unsplash returned no usable wallpapers");
    return Response.json(
      { wallpapers, source: "live" },
      { headers: { "Cache-Control": "public, max-age=900, stale-while-revalidate=3600" } },
    );
  } catch {
    return Response.json(
      { wallpapers: fallbackWallpapers, source: "fallback" },
      { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" } },
    );
  }
}

export async function POST(request: Request) {
  const bindings = env as unknown as Record<string, unknown>;
  const accessKey = typeof bindings.UNSPLASH_ACCESS_KEY === "string" ? bindings.UNSPLASH_ACCESS_KEY : "";
  if (!accessKey) return new Response(null, { status: 204 });
  const body = await request.json().catch(() => ({})) as { downloadLocation?: string };
  if (!body.downloadLocation) return Response.json({ error: "Missing download location" }, { status: 400 });
  let url: URL;
  try { url = new URL(body.downloadLocation); } catch { return Response.json({ error: "Invalid download location" }, { status: 400 }); }
  if (url.protocol !== "https:" || url.hostname !== "api.unsplash.com" || !/^\/photos\/[^/]+\/download$/.test(url.pathname)) {
    return Response.json({ error: "Invalid download location" }, { status: 400 });
  }
  await fetch(url, { headers: { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" } }).catch(() => null);
  return new Response(null, { status: 204 });
}
