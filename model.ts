
export type GithubData = {
    repositories: Repository[];
}

export type RepostioryToFetch = {
    name: string;
    workflow: string;
    job: string;
}

export type User = {
    githubUsername: string;
    team: string;
}

export type Repository = {
    name: string;
    pulls: PullRequest[];
}

export type PullRequest = {
    pullNumber: number;
    branch: string;
    team: string | null;
    title: string;
    mergedAt: string;
    comments: string[];
    labels: string[];
    commits: Commit[];
    deployment: Deployment
}

export type Commit = {
    message: string;
    timestamp: string;
}

export type Deployment = {
    environment: string;
    deployedAt: string;
}

export type SuccessfulDeploy = {
    pull: number;
    repo: string;
    team: string | null;
    deployedAt: string;
    leadTime: string;
}

export type HotfixDeploy = {
    pull: number;
    repo: string;
    team: string | null;
    deployedAt: string;
    timeToRecovery: string | null;
}
