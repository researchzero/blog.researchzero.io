export function GET({ site }: { site: URL }) {
  const base = new URL(import.meta.env.BASE_URL, site);
  const body = `User-agent: *
Allow: /

Sitemap: ${new URL('sitemap.xml', base).href}
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8'
    }
  });
}
