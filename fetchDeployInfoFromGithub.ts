import fs from 'fs';
import {Octokit} from "@octokit/core";
import type {GithubData, PullRequest, Repository, RepositoryCache, User} from "./model";
import {findJiraReference, findPullReference} from "./utils.ts";
import {owner, REPOSITORIES_TO_FETCH} from "./repositoriesToFetch.ts";

const token = process.env.GITHUB_TOKEN;

const octokit = new Octokit({
    auth: token,
})
const headers = {
    'X-GitHub-Api-Version': '2022-11-28'
}


const teamsToCommentOn = ["pensjon og uføre felles"];
const bugfixBranches = ["bugfix", "hotfix", "fix", "patch"];

async function scrapeGithubRepository(repo: string, workflowName: string, deployJob: string, teamMembers: User[]): Promise<{
    pullRequests: PullRequest[],
    newRepositoryCache: RepositoryCache,
}> {

    const pulls = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        state: 'closed',
        per_page: 1,
        page: 1,
        headers,
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
                if (bugfixBranches.some(prefix => pull.head.ref.toLowerCase().startsWith(prefix))) {
                    isBugfix = true;
                    if (!hasBugLabel) {
                        //Add bug label if missing
                        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                            owner,
                            repo,
                            issue_number: pull.number,
                            labels: ["bug"],
                            headers,
                        });
                    }
                }

                const commits = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
                    owner,
                    repo,
                    pull_number: pull.number,
                    headers,
                });

                const workflows = (await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
                    owner,
                    repo,
                    branch: 'main',
                    status: 'success',
                    head_sha: pull.merge_commit_sha,
                    workflow_id: 'deployProd.yml',
                    headers,
                })).data.workflow_runs.filter(workflow => workflow.name.toLowerCase() === workflowName.toLowerCase());

                const reviewComments = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
                    owner,
                    repo,
                    pull_number: pull.number,
                    headers,
                })).data.map(comment => comment.body);

                const issueComments = (await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner,
                    repo,
                    issue_number: pull.number,
                    headers,
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
                            //Ask for reference in a comment if not already asked
                            const body = "Hei! :wave: Hvis dette er en feilretting, hadde det vært flott om du kunne oppgi en fagsystemsak i kommentarfeltet dersom det er relevant. :pray: :smile:";
                            if (!comments.includes(body)) {
                                await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                                    owner,
                                    repo: 'pensjon-pen',
                                    issue_number: pull.number,
                                    body,
                                    headers,
                                });
                            }
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
                    headers,
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
        hasUnreferencedBugfix,
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


function getRepositoryCache() {
    //Read repository cache if it exists
    let repositoryCache: RepositoryCache[] = [];
    if (fs.existsSync("repositoryCache.json")) {
        const data = fs.readFileSync("repositoryCache.json", "utf-8");
        repositoryCache = JSON.parse(data) as RepositoryCache[];
        console.log("Loaded repository cache with " + repositoryCache.length + " entries");
    } else {
        console.log("No repository cache found");
    }
    return repositoryCache;
}

const teamMembers = await getTeamMembers();
const repositoryCache = getRepositoryCache();

const {repositories, newRepositoriesCache}: {
    repositories: Repository[],
    newRepositoriesCache: RepositoryCache[]
} = await Promise.all(REPOSITORIES_TO_FETCH.map(async ({name, workflow, job}) => {
    const {pullRequests, newRepositoryCache} = await scrapeGithubRepository(name, workflow, job, teamMembers);

    const repository = {
        name,
        pulls: pullRequests,
    }

    return {
        repository,
        newRepositoryCache,
    }

})).then(results => {
    return {
        repositories: results.map(result => result.repository),
        newRepositoriesCache: results.map(result => result.newRepositoryCache),
    }
});

const githubData: GithubData = {
    repositories,
}

console.log("Writing new repository cache with " + newRepositoriesCache.length + " entries");
fs.writeFileSync("repositoryCache.json", JSON.stringify(newRepositoriesCache));

console.log("Fetched data from GitHub:");
githubData.repositories.forEach((repo) => {
    console.log(`Repository: ${repo.name}, Pull Requests: ${repo.pulls.length}`);
})
fs.writeFileSync("github.json", JSON.stringify(githubData))
