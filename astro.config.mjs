import { defineConfig, passthroughImageService } from 'astro/config';

const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const isUserPage = repo?.endsWith('.github.io');
const site = process.env.SITE_URL ?? (process.env.GITHUB_REPOSITORY_OWNER
  ? `https://${process.env.GITHUB_REPOSITORY_OWNER}.github.io`
  : 'https://blog.researchzero.io');
const isCustomDomain = site !== `https://${process.env.GITHUB_REPOSITORY_OWNER}.github.io`;

export default defineConfig({
  site,
  base: process.env.GITHUB_REPOSITORY_OWNER && repo && !isUserPage && !isCustomDomain ? `/${repo}` : '/',
  image: {
    service: passthroughImageService()
  },
  markdown: {
    shikiConfig: {
      theme: 'github-dark'
    }
  }
});
