/**
 * fetch-metrics.js
 * Fetches developer metrics from the "Amigo" GitHub Project (v2)
 * across all repos in the iPivot-Technology org.
 *
 * Required env vars:
 *   GH_TOKEN  — GitHub PAT (scopes: repo, read:org, project)
 *   ORG_NAME  — defaults to "iPivot-Technology"
 */

const { graphql } = require("@octokit/graphql");
const fs = require("fs");
const path = require("path");

const ORG = process.env.ORG_NAME || "iPivot-Technology";
const PROJECT_NAME = "Amigo";
const PROJECT_NUMBER = 2;

const gql = graphql.defaults({
  headers: { authorization: `token ${process.env.GH_TOKEN}` },
});

// ── 1. Find the "Amigo" project ──────────────────────────────────────────────
async function findProject() {
  const { organization } = await gql(`
    query($org: String!, $number: Int!) {
      organization(login: $org) {
        projectV2(number: $number) {
          id title number
        }
      }
    }`, { org: ORG, number: PROJECT_NUMBER });

  const project = organization.projectV2;
  if (!project) throw new Error(`Project #${PROJECT_NUMBER} not found in org ${ORG}`);
  console.log(`✅  Found project: "${project.title}" (#${project.number})`);
  return project;
}

// ── 2. Fetch all Amigo project items (paginated) ─────────────────────────────
async function fetchProjectItems(projectId) {
  let items = [], cursor = null, hasMore = true;
  while (hasMore) {
    const { node } = await gql(`
      query($id: ID!, $cursor: String) {
        node(id: $id) {
          ... on ProjectV2 {
            items(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldTextValue         { text   field { name } }
                    ... on ProjectV2ItemFieldSingleSelectValue { name   field { name } }
                    ... on ProjectV2ItemFieldNumberValue       { number field { name } }
                    ... on ProjectV2ItemFieldIterationValue    { title startDate duration field { name } }
                    ... on ProjectV2ItemFieldDateValue         { date   field { name } }
                    ... on ProjectV2ItemFieldUserValue         { users(first:5){ nodes{ login name } } field { name } }
                  }
                }
                content {
                  ... on Issue {
                    number title state url createdAt closedAt updatedAt
                    assignees(first: 5) { nodes { login name avatarUrl } }
                    labels(first: 10)   { nodes { name color } }
                  }
                  ... on PullRequest {
                    number title state url createdAt closedAt mergedAt updatedAt
                    author { login avatarUrl }
                    additions deletions
                    reviews(first: 20) { nodes { author { login } submittedAt state } }
                    commits(first: 1)  { nodes { commit { authoredDate } } }
                  }
                }
              }
            }
          }
        }
      }`, { id: projectId, cursor });

    const page = node.items;
    items = items.concat(page.nodes);
    hasMore = page.pageInfo.hasNextPage;
    cursor  = page.pageInfo.endCursor;
    console.log(`  Fetched ${items.length} project items...`);
  }
  return items;
}

// ── 3. Fetch PRs across all org repos ───────────────────────────────────────
async function fetchOrgPRs() {
  const { organization } = await gql(`
    query($org: String!) {
      organization(login: $org) {
        repositories(first: 50, orderBy: {field: PUSHED_AT, direction: DESC}) {
          nodes { name isArchived }
        }
      }
    }`, { org: ORG });

  const repos = organization.repositories.nodes
    .filter(r => !r.isArchived)
    .map(r => r.name);

  console.log(`📦  Scanning ${repos.length} repos: ${repos.join(", ")}`);

  let allPRs = [];
  for (const repo of repos) {
    try {
      const { repository } = await gql(`
        query($org: String!, $repo: String!) {
          repository(owner: $org, name: $repo) {
            pullRequests(first: 100, states: [MERGED, OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
              nodes {
                number title state url createdAt mergedAt closedAt
                author { login }
                additions deletions
                commits(first: 1) { nodes { commit { authoredDate } } }
                reviews(first: 20) { nodes { author { login } submittedAt state } }
                labels(first: 5)  { nodes { name } }
              }
            }
          }
        }`, { org: ORG, repo });
      allPRs = allPRs.concat(
        repository.pullRequests.nodes.map(p => ({ ...p, repo }))
      );
    } catch (e) {
      console.warn(`  ⚠️  Skipping ${repo}: ${e.message}`);
    }
  }
  console.log(`🔀  Total PRs fetched: ${allPRs.length}`);
  return { allPRs, repos };
}

// ── 4. Crunch metrics ────────────────────────────────────────────────────────
function crunchMetrics(projectItems, allPRs) {
  const devMap = {};

  const getDev = (login, extra = {}) => {
    if (!devMap[login]) {
      devMap[login] = {
        login, name: extra.name || login, avatarUrl: extra.avatarUrl || null,
        tasksDone: 0, tasksInProgress: 0, tasksInReview: 0,
        prsMerged: 0, prsOpen: 0,
        cycleTimes: [], reviewTurnarounds: [],
        reviewsGiven: 0, bugsFixed: 0, totalAssigned: 0,
        storyPoints: 0, additions: 0, deletions: 0, labels: {},
      };
    }
    return devMap[login];
  };

  // Detect current iteration
  let currentIteration = null;
  for (const item of projectItems) {
    const f = item.fieldValues?.nodes?.find(
      f => f.field?.name === "Iteration" || f.field?.name === "Sprint"
    );
    if (f?.title) { currentIteration = f.title; break; }
  }
  console.log(`📅  Current iteration: ${currentIteration || "N/A"}`);

  // Project items → task metrics
  for (const item of projectItems) {
    const fv = item.fieldValues?.nodes || [];
    const status    = fv.find(f => f.field?.name === "Status")?.name || "";
    const pts       = fv.find(f => f.field?.name === "Story Points" || f.field?.name === "Points" || f.field?.name === "Estimate")?.number || 0;
    const iteration = fv.find(f => f.field?.name === "Iteration" || f.field?.name === "Sprint")?.title || "";
    const content   = item.content;
    if (!content) continue;

    const assignees = content.assignees?.nodes || (content.author ? [content.author] : []);
    const isBug = content.labels?.nodes?.some(l => l.name.toLowerCase().includes("bug"));
    const isCurrentSprint = !currentIteration || iteration === currentIteration;

    for (const a of assignees) {
      if (!a?.login) continue;
      const d = getDev(a.login, { name: a.name, avatarUrl: a.avatarUrl });
      d.totalAssigned++;
      if (isCurrentSprint) d.storyPoints += pts;

      const s = status.toLowerCase();
      if (s.includes("done") || s.includes("closed") || s.includes("complete")) {
        if (isCurrentSprint) d.tasksDone++;
        if (isBug) d.bugsFixed++;
      } else if (s.includes("review")) {
        d.tasksInReview++;
      } else if (s.includes("progress") || s.includes("doing") || s.includes("active")) {
        d.tasksInProgress++;
      }
      for (const lbl of (content.labels?.nodes || [])) {
        d.labels[lbl.name] = (d.labels[lbl.name] || 0) + 1;
      }
    }
  }

  // PR metrics
  for (const pr of allPRs.filter(p => p.state === "MERGED")) {
    if (!pr.author?.login) continue;
    const d = getDev(pr.author.login);
    d.prsMerged++;
    d.additions += pr.additions || 0;
    d.deletions  += pr.deletions  || 0;

    const firstCommit = pr.commits?.nodes?.[0]?.commit?.authoredDate;
    if (firstCommit && pr.mergedAt) {
      const ct = (new Date(pr.mergedAt) - new Date(firstCommit)) / 86400000;
      if (ct >= 0 && ct < 60) d.cycleTimes.push(parseFloat(ct.toFixed(2)));
    }

    const reviews = (pr.reviews?.nodes || [])
      .filter(r => r.author?.login !== pr.author.login)
      .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
    if (reviews.length > 0) {
      const reviewer = getDev(reviews[0].author.login);
      const rt = (new Date(reviews[0].submittedAt) - new Date(pr.createdAt)) / 3600000;
      if (rt >= 0) reviewer.reviewTurnarounds.push(parseFloat(rt.toFixed(1)));
      reviewer.reviewsGiven++;
    }
  }
  for (const pr of allPRs.filter(p => p.state === "OPEN")) {
    if (pr.author?.login) getDev(pr.author.login).prsOpen++;
  }

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const developers = Object.values(devMap)
    .filter(d => d.totalAssigned > 0 || d.prsMerged > 0)
    .map(d => {
      const avgCycle  = parseFloat(avg(d.cycleTimes).toFixed(2));
      const avgReview = parseFloat(avg(d.reviewTurnarounds).toFixed(1));
      const bugRate   = d.totalAssigned > 0
        ? parseFloat(((d.bugsFixed / d.totalAssigned) * 100).toFixed(1)) : 0;
      const score = Math.min(100, Math.round(
        Math.min(30, d.tasksDone * 3) +
        Math.min(20, d.prsMerged * 2) +
        (avgCycle > 0 ? Math.max(0, 20 - avgCycle * 4) : 10) +
        (avgReview > 0 ? Math.max(0, 15 - avgReview * 0.5) : 8) +
        Math.min(15, d.reviewsGiven * 2)
      ));
      return {
        login: d.login, name: d.name, avatarUrl: d.avatarUrl,
        tasksDone: d.tasksDone, tasksInProgress: d.tasksInProgress, tasksInReview: d.tasksInReview,
        prsMerged: d.prsMerged, prsOpen: d.prsOpen,
        avgCycleTimeDays: avgCycle, avgReviewTurnaroundHours: avgReview,
        reviewsGiven: d.reviewsGiven, bugRate, storyPoints: d.storyPoints,
        additions: d.additions, deletions: d.deletions,
        efficiencyScore: score,
        topLabels: Object.entries(d.labels).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n])=>n),
      };
    })
    .sort((a, b) => b.efficiencyScore - a.efficiencyScore);

  const now = new Date();
  const twoWeeksAgo = new Date(now - 14 * 86400000);
  const recentMerged = allPRs.filter(p => p.state === "MERGED" && p.mergedAt && new Date(p.mergedAt) > twoWeeksAgo);
  const leadTimes = recentMerged
    .map(p => (new Date(p.mergedAt) - new Date(p.createdAt)) / 86400000)
    .filter(t => t >= 0 && t < 30);

  const dora = {
    deploymentFrequencyPerWeek: parseFloat((recentMerged.length / 2).toFixed(1)),
    leadTimeForChangesDays: parseFloat(avg(leadTimes).toFixed(2)),
    changeFailureRatePct: null,
    mttrHours: null,
  };

  const allStatuses = projectItems.map(i =>
    (i.fieldValues?.nodes?.find(f => f.field?.name === "Status")?.name || "").toLowerCase()
  );

  return {
    developers, dora,
    sprintSummary: {
      totalItems:    projectItems.length,
      done:          allStatuses.filter(s => s.includes("done") || s.includes("complete")).length,
      inProgress:    allStatuses.filter(s => s.includes("progress") || s.includes("doing")).length,
      inReview:      allStatuses.filter(s => s.includes("review")).length,
      backlog:       allStatuses.filter(s => s.includes("backlog") || s.includes("todo") || s === "").length,
      currentSprint: currentIteration,
    }
  };
}

function buildLabelSummary(projectItems) {
  const map = {};
  for (const item of projectItems) {
    for (const lbl of (item.content?.labels?.nodes || [])) {
      map[lbl.name] = (map[lbl.name] || 0) + 1;
    }
  }
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([name, count]) => ({ name, count }));
}

function buildVelocityHistory(projectItems) {
  const iterMap = {};
  for (const item of projectItems) {
    const fv = item.fieldValues?.nodes || [];
    const iter   = fv.find(f => f.field?.name === "Iteration" || f.field?.name === "Sprint");
    const status = fv.find(f => f.field?.name === "Status")?.name || "";
    const pts    = fv.find(f => f.field?.name === "Story Points" || f.field?.name === "Points")?.number || 0;
    if (!iter?.title) continue;
    if (!iterMap[iter.title]) iterMap[iter.title] = { done: 0, points: 0, start: iter.startDate };
    if (status.toLowerCase().includes("done") || status.toLowerCase().includes("complete")) {
      iterMap[iter.title].done++;
      iterMap[iter.title].points += pts;
    }
  }
  return Object.entries(iterMap)
    .sort((a,b) => new Date(a[1].start || 0) - new Date(b[1].start || 0))
    .slice(-6)
    .map(([name, v]) => ({ name, tasksDone: v.done, pointsDone: v.points }));
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log(`\n🚀  iPivot-Technology | Project: ${PROJECT_NAME}\n`);
    const project = await findProject();
    const [projectItems, { allPRs, repos }] = await Promise.all([
      fetchProjectItems(project.id),
      fetchOrgPRs(),
    ]);

    console.log(`\n📊  Crunching numbers...`);
    const { developers, dora, sprintSummary } = crunchMetrics(projectItems, allPRs);
    const labelSummary    = buildLabelSummary(projectItems);
    const velocityHistory = buildVelocityHistory(projectItems);

    const output = {
      generatedAt: new Date().toISOString(),
      org: ORG, project: project.title, repos,
      sprintSummary, labelSummary, velocityHistory,
      team: {
        totalDevelopers: developers.length,
        totalTasksDone:  developers.reduce((s,d) => s + d.tasksDone, 0),
        totalPRsMerged:  developers.reduce((s,d) => s + d.prsMerged, 0),
        avgCycleTimeDays: parseFloat(
          (developers.filter(d=>d.avgCycleTimeDays>0)
            .reduce((s,d)=>s+d.avgCycleTimeDays,0) /
           (developers.filter(d=>d.avgCycleTimeDays>0).length || 1)).toFixed(2)
        ),
        mergeRate: allPRs.length > 0
          ? parseFloat(((allPRs.filter(p=>p.state==="MERGED").length / allPRs.length)*100).toFixed(1))
          : 0,
      },
      developers, dora,
    };

    const outDir = path.join(__dirname, "data");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(output, null, 2));

    console.log(`\n✅  metrics.json written!`);
    console.log(`   👥  Developers : ${developers.length}`);
    console.log(`   ✅  Tasks done  : ${output.team.totalTasksDone}`);
    console.log(`   🔀  PRs merged  : ${output.team.totalPRsMerged}`);
    console.log(`   ⏱   Cycle time  : ${output.team.avgCycleTimeDays}d`);
    console.log(`   📦  Repos       : ${repos.length}`);
  } catch (err) {
    console.error("\n❌  fetch-metrics failed:", err.message);
    if (err.errors) console.error(JSON.stringify(err.errors, null, 2));
    process.exit(1);
  }
})();
