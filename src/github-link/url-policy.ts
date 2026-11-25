/** Plain HTTP is limited to loopback fakes and local development. */
export function secureEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error();
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("GitHub link endpoint must be HTTPS or loopback HTTP, without credentials, query or fragment.");
  }
}
