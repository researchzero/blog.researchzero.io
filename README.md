# ResearchZero Blog

Astro-powered static blog for ResearchZero, designed for GitHub Pages and Markdown-based publishing.

## Local Development

Use Node.js `18.20.8` or newer.

```sh
npm install
npm run dev
```

## Add a Post

Create a Markdown file in `src/content/blog`.

```md
---
title: "Post Title"
description: "Short SEO description."
date: 2026-04-30
tags: ["security", "defi"]
---

Post content here.
```

Drafts can be hidden with:

```md
draft: true
```

## Deploy

GitHub Pages deployment is handled by `.github/workflows/deploy.yml`. In the repository settings, set Pages to deploy from GitHub Actions.
