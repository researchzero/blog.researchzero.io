import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

export const POSTS_PER_PAGE = 8;

export async function getSortedBlogPosts(): Promise<CollectionEntry<'blog'>[]> {
  return (await getCollection('blog'))
    .filter((post: CollectionEntry<'blog'>) => !post.data.draft)
    .sort((a: CollectionEntry<'blog'>, b: CollectionEntry<'blog'>) => b.data.date.valueOf() - a.data.date.valueOf());
}

export function slugifyTag(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function formatTag(tag: string): string {
  return tag
    .split('-')
    .map((part) => {
      const normalized = part.toLowerCase();
      if (['aml', 'defi', 'kyc', 'rbac'].includes(normalized)) return normalized.toUpperCase();
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .join(' ');
}

export function getTagHref(tag: string): string {
  return `${import.meta.env.BASE_URL}topics/${slugifyTag(tag)}/`;
}

export function getAllTags(posts: CollectionEntry<'blog'>[]): string[] {
  return Array.from(new Set(posts.flatMap((post) => post.data.tags))).sort((a, b) => a.localeCompare(b));
}

export function getPostsByTag(posts: CollectionEntry<'blog'>[], tag: string): CollectionEntry<'blog'>[] {
  return posts.filter((post) => post.data.tags.includes(tag));
}
