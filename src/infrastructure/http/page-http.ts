// HTTP requests sent from the site's tab (with the user's cookies and session).
// Only what the site does on a click is replayed: no protection is bypassed.

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface HttpRequest {
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * HTTP client of a tab. `url` is a path relative to the tab's origin, or an absolute URL
 * (a call to an API of the same site from the page, subject to its CORS rules). Abstract so tests can fake it.
 */
export interface PageHttp {
  request(url: string, init?: HttpRequest): Promise<HttpResponse>;
}

/** Creates a client for a site's origin; `homePath` is opened if no tab of the site exists. */
export type PageHttpFactory = (origin: string, homePath: string) => PageHttp;
