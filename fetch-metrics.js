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
const PROJECT_START_DATE = new Date('2026-03-10T00:00:00Z'); // sprint cadence anchor

// ── Sprint calculator (2-week sprints from PROJECT_START_DATE) ────────────────
function calcSprint(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  const daysSince = Math.floor((d - PROJECT_START_DATE) / 86400000);
  if (daysSince < 0) return null;
  const num = Math.floor(daysSince / 14) + 1;
  const start = new Date(PROJECT_START_DATE.getTime() + (num - 1) * 14 * 86400000);
  const end   = new Date(start.getTime() + 13 * 86400000);
  const toISO = x => x.toISOString().substring(0, 10);
  return { number: num, name: `Sprint ${num}`, startDate: toISO(start), endDate: toISO(end) };
}

const gql = graphql.defaults({
  headers: { authorization: `token ${process.env.GH_TOKEN}` },
});

// ── 1. Find the "Amigo" project ──────────────────────────────────────────────
async function findProject() {
  const { organization } = await gql(`
    query($org: String!) {
      organization(login: $org) {
        projectsV2(first: 20) {
          nodes { id title number }
        }
      }
    }`, { org: ORG });

  const nodes = (organization?.projectsV2?.nodes || []).filter(Boolean);
  const project =
    nodes.find(p => p.number === PROJECT_NUMBER) ||
    nodes.find(p => p.title.toLowerCase() === PROJECT_NAME.toLowerCase());
  if (!project) throw new Error(
    `Project #${PROJECT_NUMBER} ("${PROJECT_NAME}") not found in org ${ORG}. ` +
    `Available: ${nodes.map(p => `#${p.number} ${p.title}`).join(", ") || "none (check token scopes: repo, read:org, project)"}`
  );
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
                    ... on ProjectV2ItemFieldTextValue         { text   field { ... on ProjectV2Field { name } ... on ProjectV2IterationField { name } ... on ProjectV2SingleSelectField { name } } }
                    ... on ProjectV2ItemFieldSingleSelectValue { name   field { ... on ProjectV2Field { name } ... on ProjectV2IterationField { name } ... on ProjectV2SingleSelectField { name } } }
                    ... on ProjectV2ItemFieldNumberValue       { number field { ... on ProjectV2Field { name } ... on ProjectV2IterationField { name } ... on ProjectV2SingleSelectField { name } } }
                    ... on ProjectV2ItemFieldIterationValue    { title startDate duration field { ... on ProjectV2Field { name } ... on ProjectV2IterationField { name } ... on ProjectV2SingleSelectField { name } } }
                    ... on ProjectV2ItemFieldDateValue         { date   field { ... on ProjectV2Field { name } ... on ProjectV2IterationField { name } ... on ProjectV2SingleSelectField { name } } }
                    ... on ProjectV2ItemFieldUserValue         { users(first:5){ nodes{ login name } } field { ... on ProjectV2Field { name } ... on ProjectV2IterationField { name } ... on ProjectV2SingleSelectField { name } } }
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
        totalClosed: 0,
        storyPoints: 0, additions: 0, deletions: 0, labels: {},
        repos: new Set(),
        dailyOpened: {},
        dailyClosed: {},
      };
    }
    return devMap[login];
  };

  const unassigned = { totalAssigned: 0, totalClosed: 0, repos: new Set(), dailyOpened: {}, dailyClosed: {} };

  // Current sprint from calculated cadence (2-week from project start)
  const currentSprintInfo = calcSprint(new Date());
  console.log(`📅  Current sprint: ${currentSprintInfo.name} (${currentSprintInfo.startDate} → ${currentSprintInfo.endDate})`);

  // Project items → task metrics
  for (const item of projectItems) {
    const fv = item.fieldValues?.nodes || [];
    const status    = fv.find(f => f.field?.name === "Status")?.name || "";
    const pts       = fv.find(f => f.field?.name === "Story Points" || f.field?.name === "Points" || f.field?.name === "Estimate")?.number || 0;
    const iteration = fv.find(f => f.field?.name === "Iteration" || f.field?.name === "Sprint")?.title || "";
    const content   = item.content;
    if (!content) continue;

    const s = status.toLowerCase();
    const isItemClosed = s.includes("done") || s.includes("closed") || s.includes("complete") ||
      content.state === 'CLOSED' || content.state === 'MERGED';
    // Item counts as "current sprint" if: still open (in progress/review) OR closed this sprint
    const closedDateForSprint = content.closedAt || content.mergedAt;
    const isCurrentSprint = !isItemClosed || calcSprint(closedDateForSprint)?.number === currentSprintInfo.number;

    const assignees = content.assignees?.nodes || (content.author ? [content.author] : []);
    const isBug = content.labels?.nodes?.some(l => l.name.toLowerCase().includes("bug"));
    const repoName = content?.url?.split('/')?.[4] || null;
    const openedDate = content.createdAt?.substring(0, 10);
    const closedDate = content.closedAt?.substring(0, 10);

    if (assignees.length === 0) {
      unassigned.totalAssigned++;
      if (isItemClosed) unassigned.totalClosed++;
      if (repoName) unassigned.repos.add(repoName);
      if (openedDate) unassigned.dailyOpened[openedDate] = (unassigned.dailyOpened[openedDate] || 0) + 1;
      if (closedDate) unassigned.dailyClosed[closedDate] = (unassigned.dailyClosed[closedDate] || 0) + 1;
    }

    for (const a of assignees) {
      if (!a?.login) continue;
      const d = getDev(a.login, { name: a.name, avatarUrl: a.avatarUrl });
      d.totalAssigned++;
      if (isItemClosed) d.totalClosed++;
      if (repoName) d.repos.add(repoName);
      if (openedDate) d.dailyOpened[openedDate] = (d.dailyOpened[openedDate] || 0) + 1;
      if (closedDate) d.dailyClosed[closedDate] = (d.dailyClosed[closedDate] || 0) + 1;
      if (isCurrentSprint) d.storyPoints += pts;

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

  const cutoffDate = new Date(Date.now() - 90 * 86400000).toISOString().substring(0, 10);
  const buildDailyTrend = (dailyOpened, dailyClosed) => {
    const allDates = new Set([...Object.keys(dailyOpened), ...Object.keys(dailyClosed)]);
    return [...allDates].sort().filter(d => d >= cutoffDate)
      .map(date => ({ date, opened: dailyOpened[date] || 0, closed: dailyClosed[date] || 0 }));
  };

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
        totalAssigned: d.totalAssigned,
        totalOpen: d.totalAssigned - d.totalClosed,
        totalClosed: d.totalClosed,
        repos: [...d.repos].sort(),
        dailyTrend: buildDailyTrend(d.dailyOpened, d.dailyClosed),
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
    unassigned: {
      totalAssigned: unassigned.totalAssigned,
      totalOpen: unassigned.totalAssigned - unassigned.totalClosed,
      totalClosed: unassigned.totalClosed,
      repos: [...unassigned.repos].sort(),
      dailyTrend: buildDailyTrend(unassigned.dailyOpened, unassigned.dailyClosed),
    },
    sprintSummary: {
      totalItems:           projectItems.length,
      done:                 allStatuses.filter(s => s.includes("done") || s.includes("complete")).length,
      inProgress:           allStatuses.filter(s => s.includes("progress") || s.includes("doing")).length,
      inReview:             allStatuses.filter(s => s.includes("review")).length,
      backlog:              allStatuses.filter(s => s.includes("backlog") || s.includes("todo") || s === "").length,
      currentSprint:        currentSprintInfo.name,
      currentSprintNumber:  currentSprintInfo.number,
      currentSprintStart:   currentSprintInfo.startDate,
      currentSprintEnd:     currentSprintInfo.endDate,
      daysRemaining:        Math.max(0, Math.ceil((new Date(currentSprintInfo.endDate + 'T23:59:59Z') - new Date()) / 86400000)),
      totalSprints:         currentSprintInfo.number,
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
  const sprintMap = {};
  for (const item of projectItems) {
    const fv     = item.fieldValues?.nodes || [];
    const status = (fv.find(f => f.field?.name === "Status")?.name || "").toLowerCase();
    const pts    = fv.find(f => f.field?.name === "Story Points" || f.field?.name === "Points")?.number || 0;
    const content = item.content;
    if (!content) continue;
    const isDone = status.includes("done") || status.includes("complete") ||
      content.state === 'CLOSED' || content.state === 'MERGED';
    if (!isDone) continue;
    const closedDate = content.closedAt || content.mergedAt || content.updatedAt;
    const sprint = calcSprint(closedDate);
    if (!sprint) continue;
    if (!sprintMap[sprint.number]) {
      sprintMap[sprint.number] = { number: sprint.number, name: sprint.name,
        startDate: sprint.startDate, endDate: sprint.endDate, tasksDone: 0, pointsDone: 0 };
    }
    sprintMap[sprint.number].tasksDone++;
    sprintMap[sprint.number].pointsDone += pts;
  }
  return Object.values(sprintMap).sort((a, b) => a.number - b.number);
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
