# Graphit — Deploy Guide

## Your project structure
```
graphit/
├── public/
│   └── index.html       ← the website users see
├── api/
│   └── graph.js         ← your secret backend (API key lives here)
├── vercel.json          ← tells Vercel how to route traffic
├── package.json
└── DEPLOY.md            ← this file
```

---

## Step 1 — Install Git (if you don't have it)
Download from https://git-scm.com and install. You can verify it works by opening
Terminal (Mac) or Command Prompt (Windows) and typing:
  git --version

---

## Step 2 — Create a GitHub repository
1. Go to https://github.com and sign in (create a free account if needed)
2. Click the "+" icon → "New repository"
3. Name it: graphit
4. Leave it Public or Private (either works with Vercel free tier)
5. Click "Create repository"

---

## Step 3 — Push your code to GitHub
Open Terminal / Command Prompt, navigate to this folder, then run:

  git init
  git add .
  git commit -m "Initial Graphit deploy"
  git branch -M main
  git remote add origin https://github.com/YOUR_USERNAME/graphit.git
  git push -u origin main

Replace YOUR_USERNAME with your actual GitHub username.

---

## Step 4 — Connect Vercel to GitHub
1. Go to https://vercel.com and sign in with your GitHub account
2. Click "Add New Project"
3. Find your "graphit" repo and click "Import"
4. Leave all settings as default
5. DO NOT click Deploy yet — do Step 5 first

---

## Step 5 — Add your Anthropic API key as a secret
Still on the Vercel import screen:
1. Expand "Environment Variables"
2. Add a new variable:
   - Name:  ANTHROPIC_API_KEY
   - Value: your key (sk-ant-api03-...)
3. Make sure "Production", "Preview", and "Development" are all checked

---

## Step 6 — Deploy!
Click "Deploy". Vercel will build and deploy your site.
In ~30 seconds you'll get a live URL like:
  https://graphit-yourname.vercel.app

That's it — your site is live!

---

## Step 7 (Optional) — Add a custom domain
1. Buy a domain from Namecheap (~$10/yr) or use Cloudflare Registrar (~$9/yr)
2. In Vercel → your project → "Domains"
3. Add your domain and follow the DNS instructions (takes ~5 minutes)

---

## Updating your site in the future
Whenever you change any file, just run:
  git add .
  git commit -m "describe your change"
  git push

Vercel auto-deploys every push. Your site updates in ~20 seconds.

---

## Rate limits (built into the backend)
- 5 graphs per IP per hour (free tier protection)
- 3 web searches per graph (cost control)
- To change limits, edit MAX_REQUESTS in api/graph.js, then git push

---

## Monitoring costs
- Log into https://console.anthropic.com → "Usage" to see real spend
- Set a spending limit under "Billing" → "Usage Limits" to protect yourself
