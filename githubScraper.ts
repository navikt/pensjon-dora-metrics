import {Octokit} from "@octokit/core";
import type {GithubData, PullRequest, Repository, RepositoryCache, RepostioryToFetch, User} from "./model";
import {findJiraReference, findPullReference, sleep} from "./utils.ts";
import {owner} from "./repositoriesToFetch.ts";
import {Dataset} from "@google-cloud/bigquery";
import {schemaCachedRepoState} from "./bigqueryTableSchemas.ts";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const GITHUB_HEADERS = {
    'X-GitHub-Api-Version': '2022-11-28'
}
const BUGFIX_BRANCHES = ["bugfix", "hotfix", "fix", "patch"];

const octokit = new Octokit({
    auth: GITHUB_TOKEN,
})


export async function getGithubData(repositoriesToFetch: RepostioryToFetch[], dataset: Dataset): Promise<GithubData> {

    const repositoryCache = await getRepositoryCacheFromBigQuery(dataset);
    const teamMembers = await getTeamMembers();

    const {repositories}: {
        repositories: Repository[],
    } = await Promise.all(repositoriesToFetch.map(async ({name, workflow, job}) => {

        const cachedRepo = repositoryCache.find(repo => repo.repo === name);

        const {
            pullRequests,
            newRepositoryCache
        } = await scrapeGithubRepository(name, workflow, job, teamMembers, cachedRepo);

        const repository = {
            name,
            pulls: pullRequests,
        }

        return {
            repository,
            newRepositoryCache,
        }

    })).then(async results => {

        const repositories = results.map(result => result.repository).filter(repo => repo.pulls.length > 0);
        const newRepositoriesCache = results.map(result => result.newRepositoryCache);

        await writeNewCacheToBigQuery(newRepositoriesCache, dataset);

        return {
            repositories,
        }
    });

    return {
        repositories,
    };
}


async function scrapeGithubRepository(repo: string, workflowName: string, deployJob: string, teamMembers: User[], cache: RepositoryCache | undefined): Promise<{
    pullRequests: PullRequest[],
    newRepositoryCache: RepositoryCache,
}> {

    //Get ratelimit status
    const rateLimit = await octokit.request('GET /rate_limit', {
        headers: GITHUB_HEADERS,
    });
    const remaining = rateLimit.data.rate.remaining;
    const reset = new Date(rateLimit.data.rate.reset * 1000);
    console.log(`GitHub API rate limit remaining: ${remaining}, resets at ${reset.toISOString()}`);
    if (remaining < 100) {
        const waitTime = reset.getTime() - new Date().getTime() + 1000; //Add 1 second buffer
        console.log(`Rate limit low, waiting for ${waitTime / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    //Get latest pull request for caching purposes
    const latestPull = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        state: 'closed',
        sort: 'created',
        direction: 'desc',
        per_page: 1,
        page: 1,
        headers: GITHUB_HEADERS,
    });

    if (latestPull.data.length !== 0) {
        const latestPullNumber = latestPull.data[0].number;
        if (cache && cache.latestPullRequest === latestPullNumber && !cache.hasUnreferencedBugfixes) {
            console.log(`No new pull requests in ${repo} since last check. Skipping...`);
            return {
                pullRequests: [],
                newRepositoryCache: cache,
            }
        } else {
            console.log(`New pull requests found in ${repo}. Fetching...`);
        }
    }

    const pulls = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        state: 'closed',
        per_page: 2,
        page: 1,
        headers: GITHUB_HEADERS,
    })

    let latestPullRequest = -1;
    let hasUnreferencedBugfix = false;

    const pullRequests = (
        await Promise.all(pulls.data.filter(pull => pull.merged_at)
            .map(async (pull) => {

                const team = teamMembers.find(member => member.githubUsername.toLowerCase() === pull.user?.login.toLowerCase())?.team || null;
                let isBugfix = false;
                latestPullRequest = Math.max(...pulls.data.map(p => p.number));

                const hasBugLabel = pull.labels.map(label => label.name).includes("bug");

                if (hasBugLabel) {
                    isBugfix = true;
                }

                //Check if branch name indicates a bugfix using bugfixBranches list
                if (BUGFIX_BRANCHES.some(prefix => pull.head.ref.toLowerCase().startsWith(prefix))) {
                    isBugfix = true;
                    if (!hasBugLabel) {
                        //Add bug label if missing
                        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                            owner,
                            repo,
                            issue_number: pull.number,
                            labels: ["bug"],
                            headers: GITHUB_HEADERS,
                        });
                    }
                }

                const commits = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
                    owner,
                    repo,
                    pull_number: pull.number,
                    headers: GITHUB_HEADERS,
                });

                const workflows = (await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
                    owner,
                    repo,
                    branch: 'main',
                    status: 'success',
                    head_sha: pull.merge_commit_sha,
                    workflow_id: 'deployProd.yml',
                    headers: GITHUB_HEADERS,
                })).data.workflow_runs.filter(workflow => workflow.name.toLowerCase() === workflowName.toLowerCase());

                const reviewComments = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
                    owner,
                    repo,
                    pull_number: pull.number,
                    headers: GITHUB_HEADERS,
                })).data.map(comment => comment.body);

                const issueComments = (await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner,
                    repo,
                    issue_number: pull.number,
                    headers: GITHUB_HEADERS,
                })).data.map(comment => comment.body);


                const comments = reviewComments.concat(issueComments);
                const fagsystemSpace = "FAGSYSTEM"
                const referencedPull = findPullReference(comments) || findPullReference(commits.data.map(commit => commit.commit.message)) || findPullReference(pull.body) || null;
                const referencedFagsystemSak = findJiraReference(comments, fagsystemSpace)
                    || findJiraReference(commits.data.map(commit => commit.commit.message), fagsystemSpace) || findJiraReference(pull.body, fagsystemSpace) || null;

                if (isBugfix) {
                    if (referencedFagsystemSak === null) {
                        hasUnreferencedBugfix = true
                        if (team === "pensjon og uføre felles") {
                            console.log("Pull request #" + pull.number + " is a bugfix but has no referenced FAGSYSTEM sak. Team: " + team + ", Branch: " + pull.head.ref);
                            //Ask for reference in a comment if not already asked
                            const body = "Hei! :wave: Hvis dette er en feilretting, hadde det vært flott om du kunne oppgi en fagsystemsak i kommentarfeltet dersom det er relevant. :pray: :smile:";
                            if (!comments.includes(body)) {
                                console.log("Commenting on pull request #" + pull.number);
                                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                                    owner,
                                    repo: repo,
                                    issue_number: pull.number,
                                    body,
                                    headers: GITHUB_HEADERS,
                                });
                            }
                        } else {
                            console.log("Pull request #" + pull.number + " is a bugfix but has no referenced FAGSYSTEM sak. Team: " + team + ", Branch: " + pull.head.ref + ". Not commenting since team is not in comment list.");
                        }
                    }
                }

                if (workflows.length === 0) {
                    //Not yet deployed
                    return null;
                }

                const workflow = workflows[0]

                const jobs = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
                    owner,
                    repo,
                    run_id: workflow.id,
                    headers: GITHUB_HEADERS,
                })

                const deploymentJob = jobs.data.jobs.filter(job => job.conclusion === "success").find(job => {
                    return job.name.toLowerCase().includes(deployJob.toLowerCase());
                })

                if (deploymentJob === undefined) {
                    console.log("Workflow run: ", workflow.html_url);
                    console.log("Jobs: ");
                    console.log(jobs.data.jobs.map(job => job.name + " - " + job.conclusion).join("\n"));
                    throw new Error("No deployment job found for pull request " + pull.number + " in repo " + repo);
                }

                return {
                    pullNumber: pull.number,
                    branch: pull.head.ref,
                    team: team,
                    comments: comments,
                    labels: pull.labels.map(label => label.name),
                    mergedAt: pull.merged_at,
                    title: pull.title,
                    referencedPull: referencedPull,
                    referencedJira: referencedFagsystemSak,
                    commits: commits.data.map(commit => ({
                        message: commit.commit.message,
                        timestamp: commit.commit.author?.date,
                    })),
                    deployment: {
                        environment: "prod",
                        deployedAt: deploymentJob.completed_at,
                    },
                    isBugfix,
                };
            }))).filter(pr => pr !== null) as PullRequest[];

    const newRepositoryCache: RepositoryCache = {
        repo,
        latestPullRequest,
        hasUnreferencedBugfixes: hasUnreferencedBugfix,
    }

    return {
        pullRequests,
        newRepositoryCache,
    }
}

async function getTeamMembers(): Promise<User[]> {

    const brukernavnoversikt = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: 'navikt',
        repo: 'pensjon-github-to-slack-username',
        path: 'brukernavnoversikt.csv',
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        },
    });


    const data = brukernavnoversikt.data as { content: string, encoding: string };
    const csv = Buffer.from(data.content, 'base64').toString('utf-8');
    const lines = csv.split('\n').slice(1); //Skip header
    const users: User[] = lines.map(line => {
        const [githubUsername, slackUser, slackMemberId, team] = line.split(',');
        return {
            githubUsername,
            team,
        } as User;
    }).filter(user => user.githubUsername && user.team);
    console.log(`Fetched ${users.length} users from pensjon-github-to-slack-username`);
    return users;
}


async function getRepositoryCacheFromBigQuery(dataset: Dataset): Promise<RepositoryCache[]> {
    const table = dataset.table('cached_repo_state');
    const [rows] = await table.getRows();
    return rows.map(row => ({
        repo: row.repo,
        latestPullRequest: row.latestPullRequest,
        hasUnreferencedBugfixes: row.hasUnreferencedBugfix,
    } as RepositoryCache));
}

async function writeNewCacheToBigQuery(newCache: RepositoryCache[], dataset: Dataset) {
    const table = dataset.table('cached_repo_state');

    //Delete table and recreate it to remove old entries
    const [exists] = await table.exists();
    if (exists) {
        await table.delete();
        console.log("Deleted old cache table");
    }
    await table.create({
        schema: schemaCachedRepoState
    });
    console.log("Created new cache table");
    await sleep(2000); //Wait for table to be ready

    try {
        if (newCache.length > 0) {
            await table.insert(newCache);
            console.log("Inserted " + newCache.length + " rows into cache table");
        } else {
            console.log("No new cache entries to insert");
        }
    } catch (error) {
        console.error("Error inserting new cache entries: ", error);
    }

}


