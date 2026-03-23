/**
 * fetch-metrics.js
 * Fetches developer metrics from GitHub Projects v2 API
 * and writes them to data/metrics.json for the dashboard.
 *
 * Required env vars:
 *   GH_TOKEN  — GitHub Personal Access Token (scopes: repo, read:org, project)
 *   ORG_NAME  — GitHub org login (e.g. "iPivotTechnology")
 */

const { graphql } = require("@octokit/graphql");
const fs = require("fs");
const path = require("path");

const org = process.env.ORG_NAME || "iPivotTechnology";

const graphqlWithAuth = graphql.defaults({
  headers: { authorization: `token ${process.env.GH_TOKEN}` },
});

// ── Fetch closed issues + PRs per developer ──────────────────────────────────
async function fetchOrgMetrics() {
  const query = `
    query($org: String!) {
      organization(login: $org) {
        repositories(first: 20, orderBy: {field: PUSHED_AT, direction: DESC}) {
          nodes {
            name
            pullRequests(first: 100, states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}) {
              nodes {
                title
                author { login }
                createdAt
                mergedAt
                additions
                deletions
                reviews(first: 10) {
                  nodes { author { login } submittedAt }
                }
                commits(first: 1) {
                  nodes { commit { authoredDate } }
                }
              }
            }
            issues(first: 100, states: CLOSED, orderBy: {field: UPDATED_AT, direction: DESC}) {
              nodes {
                title
                closedAt
                createdAt
                labels(first: 5) { nodes { name } }
                assignees(first: 3) { nodes { login } }
              }
            }
          }
        }
        projectsV2(first: 5) {
          nodes {
            title
            items(first: 100) {
              nodes {
                fieldValues(first: 15) {
                  nodes {
                    ... on ProjectV2ItemFieldTextValue        { text  field { name } }
                    ... on ProjectV2ItemFieldSingleSelectValue{ name  field { name } }
                    ... on ProjectV2ItemFieldNumberValue      { number field { name } }
                    ... on ProjectV2ItemFieldIterationValue   { title startDate duration field { name } }
                  }
                }
                content {
                  ... on Issue {
                    title number state closedAt createdAt
                    assignees(first: 3) { nodes { login } }
                    labels(first: 5) { nodes { name } }
                  }
                  ... on PullRequest {
                    title number state closedAt createdAt mergedAt
                    author { login }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphqlWithAuth(query, { org });
  return data.organization;
}

// ── Crunch the numbers ────────────────────────────────────────────────────────
function buildMetrics(orgData) {
  const devMap = {};

  const getOrCreate = (login) => {
    if (!devMap[login]) {
      devMap[login] = {
        login,
        tasksClosedThisSprint: 0,
        prsMerged: 0,
        cycleTimes: [],       // ms from first commit to PR merge
        reviewTurnarounds: [], // hours from PR open to first review
        bugsIntroduced: 0,
        totalIssues: 0,
      };
    }
    return devMap[login];
  };

  // ── PRs ──
  for (const repo of orgData.repositories.nodes) {
    for (const pr of repo.pullRequests.nodes) {
      if (!pr.author?.login) continue;
      const dev = getOrCreate(pr.author.login);
      dev.prsMerged++;

      // Cycle time: first commit → merged
      const firstCommit = pr.commits?.nodes?.[0]?.commit?.authoredDate;
      if (firstCommit && pr.mergedAt) {
        const ct = new Date(pr.mergedAt) - new Date(firstCommit);
        dev.cycleTimes.push(ct);
      }

      // Review turnaround: PR created → first review
      const reviews = pr.reviews?.nodes || [];
      const sortedReviews = reviews.sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
      if (sortedReviews.length > 0) {
        for (const review of sortedReviews) {
          if (review.author?.login !== pr.author.login) {
            const reviewer = getOrCreate(review.author.login);
            const rt = (new Date(review.submittedAt) - new Date(pr.createdAt)) / 3600000;
            reviewer.reviewTurnarounds.push(rt);
            break;
          }
        }
      }
    }

    // ── Issues ──
    for (const issue of repo.issues.nodes) {
      for (const assignee of (issue.assignees?.nodes || [])) {
        const dev = getOrCreate(assignee.login);
        dev.totalIssues++;
        const isBug = issue.labels?.nodes?.some(l => l.name.toLowerCase() === "bug");
        if (isBug) dev.bugsIntroduced++;
      }
    }
  }

  // ── Project items ──
  for (const project of orgData.projectsV2.nodes) {
    for (const item of project.items.nodes) {
      const status = item.fieldValues?.nodes?.find(f => f.field?.name === "Status")?.name;
      const content = item.content;
      if (!content || status !== "Done") continue;

      const assignees =
        content.assignees?.nodes?.map(a => a.login) ||
        (content.author?.login ? [content.author.login] : []);

      for (const login of assignees) {
        getOrCreate(login).tasksClosedThisSprint++;
      }
    }
  }

  // ── Summarise ──
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const developers = Object.values(devMap).map(d => ({
    login: d.login,
    tasksClosedThisSprint: d.tasksClosedThisSprint,
    prsMerged: d.prsMerged,
    avgCycleTimeDays: parseFloat((avg(d.cycleTimes) / 86400000).toFixed(2)),
    avgReviewTurnaroundHours: parseFloat(avg(d.reviewTurnarounds).toFixed(1)),
    bugRate: d.totalIssues > 0
      ? parseFloat(((d.bugsIntroduced / d.totalIssues) * 100).toFixed(1))
      : 0,
    efficiencyScore: Math.min(100, Math.round(
      (d.tasksClosedThisSprint * 5) +
      (d.prsMerged * 3) +
      (d.cycleTimes.length ? Math.max(0, 20 - avg(d.cycleTimes) / 86400000 * 5) : 0)
    )),
  }));

  // ── DORA ──
  const allPRs = orgData.repositories.nodes.flatMap(r => r.pullRequests.nodes);
  const totalPRs = allPRs.length;
  const totalMerged = allPRs.filter(p => p.mergedAt).length;
  const leadTimes = allPRs
    .filter(p => p.mergedAt)
    .map(p => (new Date(p.mergedAt) - new Date(p.createdAt)) / 86400000);

  const dora = {
    deploymentFrequencyPerWeek: parseFloat((totalMerged / 2).toFixed(1)),
    leadTimeForChangesDays: parseFloat(avg(leadTimes).toFixed(2)),
    changeFailureRatePct: 7,    // Replace with real data from incident tracker
    mttrHours: 4.2,             // Replace with real data from incident tracker
  };

  return {
    generatedAt: new Date().toISOString(),
    sprint: { name: "Sprint 12", start: "2025-03-10", end: "2025-03-24" },
    team: {
      totalTasksClosed: developers.reduce((s, d) => s + d.tasksClosedThisSprint, 0),
      totalPRsMerged: totalMerged,
      mergeRate: totalPRs > 0 ? parseFloat(((totalMerged / totalPRs) * 100).toFixed(1)) : 0,
    },
    developers,
    dora,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log(`Fetching metrics for org: ${org}`);
    const orgData = await fetchOrgMetrics();
    const metrics = buildMetrics(orgData);

    const outDir = path.join(__dirname, "..", "data");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2));

    console.log("✅  metrics.json written successfully");
    console.log(`   Developers tracked: ${metrics.developers.length}`);
    console.log(`   Tasks closed: ${metrics.team.totalTasksClosed}`);
    console.log(`   PRs merged: ${metrics.team.totalPRsMerged}`);
  } catch (err) {
    console.error("❌  fetch-metrics failed:", err.message);
    process.exit(1);
  }
})();
