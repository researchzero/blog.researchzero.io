import { getAllTags, getSortedBlogPosts, POSTS_PER_PAGE, slugifyTag } from '../lib/blog';

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export async function GET({ site }: { site: URL }) {
  const posts = await getSortedBlogPosts();
  const totalPages = Math.ceil(posts.length / POSTS_PER_PAGE);
  const base = new URL(import.meta.env.BASE_URL, site);
  const newestPostDate = posts[0]?.data.updated ?? posts[0]?.data.date ?? new Date();
  const urls = [
    {
      loc: base.href,
      lastmod: newestPostDate,
      changefreq: 'weekly',
      priority: '1.0'
    },
    {
      loc: new URL('tokenized-asset-security-checklist/', base).href,
      lastmod: newestPostDate,
      changefreq: 'monthly',
      priority: '0.9'
    },
    ...Array.from({ length: Math.max(totalPages - 1, 0) }, (_, index) => ({
      loc: new URL(`page/${index + 2}/`, base).href,
      lastmod: newestPostDate,
      changefreq: 'weekly',
      priority: '0.6'
    })),
    ...getAllTags(posts).map((tag) => ({
      loc: new URL(`topics/${slugifyTag(tag)}/`, base).href,
      lastmod: newestPostDate,
      changefreq: 'weekly',
      priority: '0.8'
    })),
    ...posts.map((post) => ({
      loc: new URL(`post/${post.slug}/`, base).href,
      lastmod: post.data.updated ?? post.data.date,
      changefreq: 'monthly',
      priority: '0.9'
    }))
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (url) => `  <url>
    <loc>${escapeXml(url.loc)}</loc>
    <lastmod>${url.lastmod.toISOString().slice(0, 10)}</lastmod>
    <changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8'
    }
  });
}
