export type IgdbAuth = {
  clientId: string;
  clientSecret: string;
};

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_BASE = "https://api.igdb.com/v4";

export type IgdbGame = {
  id: number;
  name?: string;
  slug?: string;
  summary?: string;
  storyline?: string;
  url?: string;
  first_release_date?: number;
  rating?: number;
  cover?: { id?: number; image_id?: string; url?: string };
  artworks?: Array<{ id?: number; image_id?: string }>;
  screenshots?: Array<{ id?: number; image_id?: string }>;
  genres?: Array<{ id?: number; name?: string }>;
  themes?: Array<{ id?: number; name?: string }>;
  game_modes?: Array<{ id?: number; name?: string }>;
  involved_companies?: Array<{
    developer?: boolean;
    publisher?: boolean;
    company?: { id?: number; name?: string };
  }>;
  videos?: Array<{ id?: number; video_id?: string; name?: string }>;
  websites?: Array<{ id?: number; url?: string; category?: number }>;
};

export type IgdbExternalGame = {
  id: number;
  uid?: string;
  category?: number;
  game?: IgdbGame;
};

/** IGDB external_games.category enum values. */
export const IGDB_EXTERNAL_CATEGORY = {
  steam: 1,
  gog: 5,
  epic: 26,
  itch: 36
} as const;

export class IgdbClient {
  private token?: CachedToken;
  private tokenInflight?: Promise<CachedToken>;

  constructor(
    private readonly auth: IgdbAuth,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async getToken(): Promise<CachedToken> {
    if (this.token && this.token.expiresAt - 30_000 > Date.now()) {
      return this.token;
    }
    if (!this.tokenInflight) {
      this.tokenInflight = this.refreshToken().finally(() => {
        this.tokenInflight = undefined;
      });
    }
    return this.tokenInflight;
  }

  private async refreshToken(): Promise<CachedToken> {
    const params = new URLSearchParams({
      client_id: this.auth.clientId,
      client_secret: this.auth.clientSecret,
      grant_type: "client_credentials"
    });
    const response = await this.fetchImpl(`${TOKEN_URL}?${params.toString()}`, { method: "POST" });
    if (!response.ok) {
      throw new Error(`Twitch OAuth failed: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as { access_token: string; expires_in: number };
    const cached: CachedToken = {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000
    };
    this.token = cached;
    return cached;
  }

  async query<T = unknown>(endpoint: string, body: string): Promise<T> {
    const token = await this.getToken();
    const response = await this.fetchImpl(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        "Client-ID": this.auth.clientId,
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "text/plain",
        Accept: "application/json"
      },
      body
    });
    if (!response.ok) {
      throw new Error(`IGDB ${endpoint} failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  searchGames(query: string, limit = 10): Promise<IgdbGame[]> {
    const sanitized = query.replace(/"/g, "\\\"");
    const body =
      `search "${sanitized}"; ` +
      `fields name,slug,summary,first_release_date,cover.image_id,cover.url,` +
      `genres.name,themes.name,game_modes.name,` +
      `involved_companies.developer,involved_companies.publisher,involved_companies.company.name,` +
      `screenshots.image_id,artworks.image_id,videos.video_id,websites.url,websites.category; ` +
      `limit ${limit};`;
    return this.query<IgdbGame[]>("games", body);
  }

  getGame(id: number): Promise<IgdbGame | undefined> {
    const body =
      `where id = ${id}; ` +
      `fields name,slug,summary,storyline,url,first_release_date,rating,cover.image_id,cover.url,` +
      `genres.name,themes.name,game_modes.name,` +
      `involved_companies.developer,involved_companies.publisher,involved_companies.company.name,` +
      `screenshots.image_id,artworks.image_id,videos.video_id,websites.url,websites.category; ` +
      `limit 1;`;
    return this.query<IgdbGame[]>("games", body).then((rows) => rows[0]);
  }

  async lookupByExternal(uid: string, category: number): Promise<IgdbGame | undefined> {
    const sanitized = uid.replace(/"/g, "\\\"");
    const body =
      `where category = ${category} & uid = "${sanitized}"; ` +
      `fields game; ` +
      `limit 1;`;
    const rows = await this.query<IgdbExternalGame[]>("external_games", body);
    const gameId = rows[0]?.game;
    if (typeof gameId === "number") return this.getGame(gameId);
    return undefined;
  }
}

export function buildIgdbImageUrl(imageId: string, size: "cover_big" | "logo_med" | "screenshot_big" | "thumb" | "1080p"): string {
  return `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg`;
}
