import fs from 'fs';
import {Octokit} from "@octokit/core";
import type {GithubData, PullRequest, Repository} from "./model";
import {findPullReference} from "./utils.ts";

const token = process.env.GITHUB_TOKEN;

const octokit = new Octokit({
    auth: token,
})
const headers = {
    'X-GitHub-Api-Version': '2022-11-28'
}

const owner = 'navikt';
const repositories =['pensjon-pen','pensjon-psak'];

const deploy_jobs = ['deploy pen to production', 'Deploy prod']

async function getGithubData(repo:string): Promise<PullRequest[]> {

    const pulls = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        state: 'closed',
        per_page: 100,
        page: 1,
        headers,
    })

    return (await Promise.all(pulls.data.filter(pull => pull.merged_at).map(async (pull) => {

        const isHotfix = pull.labels.map(label => label.name).includes("hotfix") || pull.head.ref.toLowerCase().startsWith("hotfix");

        if(pull.head.ref.toLowerCase().startsWith("hotfix") && !pull.labels.map(label => label.name).includes("hotfix")) {
            //Add label if missing
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                owner,
                repo,
                issue_number: pull.number,
                labels: ["hotfix"],
                headers,
            });

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
        })).data.workflow_runs.filter(workflow => workflow.name === "Build and deploy main");

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

        if(isHotfix) {
            const referencedPull = findPullReference(comments) || findPullReference(commits.data.map(commit => commit.commit.message)) || null;
            if(referencedPull === null) {
                //Ask for reference in a comment if not already asked
                const body = "Hei! :wave: Dette ser ut som en hotfix. Vennligst legg til en referanse til PR-en som ble fikset i kommentarfeltet. :pray:";
                if(!comments.includes(body)) {
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

        if(workflows.length === 0) {
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

        const deploymentJob = jobs.data.jobs.filter(job => job.conclusion === "success").find(job => deploy_jobs.includes(job.name))

        if(deploymentJob === undefined) {
            console.log(jobs.data.jobs.map(job => job.name + " - " + job.conclusion).join("\n"));
            throw new Error("No deployment job found for pull request " + pull.number + " in repo " + repo);
        }

        return {
            pullNumber: pull.number,
            branch: pull.head.ref,
            comments: comments,
            labels: pull.labels.map(label => label.name),
            mergedAt: pull.merged_at,
            title: pull.title,
            commits: commits.data.map(commit => ({
                message: commit.commit.message,
                timestamp: commit.commit.author?.date,
            })),
            deployment: {
                environment: "prod",
                deployedAt: deploymentJob.completed_at,
            }
        };
    }))).filter(pr => pr !== null) as PullRequest[];
}


const repositoryData: Repository[] = await Promise.all(repositories.map(async (name) => {
    const pulls = await getGithubData(name);
    return {
        name,
        pulls,
    } as Repository;
}));

const githubData: GithubData = {
    repositories: repositoryData,
}

console.log(JSON.stringify(githubData, null, 2));

fs.writeFileSync("github.json", JSON.stringify(githubData))
