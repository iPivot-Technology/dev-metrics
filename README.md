# 📊 iPivot Technology — Developer Metrics Dashboard

A live developer metrics dashboard for iPivot Technology, hosted on GitHub Pages and powered by GitHub Projects v2 API.

🔗 **Live Dashboard**: `https://iPivotTechnology.github.io/dev-metrics`

---

## 📁 Repo Structure

```
dev-metrics/
├── index.html                  ← Dashboard UI (GitHub Pages entry point)
├── data/
│   └── metrics.json            ← Auto-generated metrics data (committed by CI)
├── scripts/
│   └── fetch-metrics.js        ← Node.js script that calls GitHub GraphQL API
├── .github/
│   └── workflows/
│       └── metrics.yml         ← GitHub Actions: runs nightly, refreshes data
└── package.json
```

---

## 🚀 Setup Instructions

### Step 1 — Create the repo
1. Create a new repo in your GitHub org: `iPivotTechnology/dev-metrics`
2. Push all these files to the `main` branch

### Step 2 — Enable GitHub Pages
1. Go to **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` / Root `/ (root)`
4. Save → your dashboard is live at `https://iPivotTechnology.github.io/dev-metrics`

### Step 3 — Add the Secret Token
1. Generate a **PAT (Classic)** at: GitHub → Settings → Developer Settings → Personal Access Tokens
2. Required scopes: `repo`, `read:org`, `project`
3. Add it as a secret in this repo: **Settings → Secrets → Actions → New secret**
   - Name: `METRICS_TOKEN`
   - Value: your token

### Step 4 — Run the first fetch
1. Go to **Actions tab** → `Refresh Developer Metrics`
2. Click **Run workflow** manually
3. It will fetch data and commit `data/metrics.json`
4. Refresh your GitHub Pages URL — real data is now live!

---

## 📈 Metrics Tracked

| Metric | Source |
|---|---|
| Tasks closed per sprint | GitHub Projects v2 (Status = Done) |
| PRs merged | GitHub Pull Requests API |
| Cycle time (commit → merge) | PR created/merged timestamps |
| Review turnaround | PR open → first review timestamp |
| Bug rate | Issues labeled `bug` / total issues |
| DORA: Deployment frequency | Merged PRs per week |
| DORA: Lead time for changes | PR open → merge time |
| DORA: Change failure rate | Manual / incident tracker |
| DORA: MTTR | Manual / incident tracker |

---

## 🔄 Automatic Refresh

The GitHub Actions workflow runs at **midnight UTC daily**.
To change frequency, edit the `cron` in `.github/workflows/metrics.yml`.

---

## 🛠 Local Development

```bash
# Install dependencies
npm install

# Set your token
export GH_TOKEN=ghp_yourtoken
export ORG_NAME=iPivotTechnology

# Fetch real data
npm run fetch

# Open index.html in browser
open index.html
```

---

Built with ❤️ for iPivot Technology Engineering Team
