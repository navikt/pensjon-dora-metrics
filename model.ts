
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
    referencedPull: number | null;
    referencedJira: string | null;
    isBugfix: boolean;
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
    referencedPull: number | null;
    referencedJira: string | null;
    repo: string;
    team: string | null;
    deployedAt: string;
}

export type RecoveredIncident = {
    jira: string;
    repo: string;
    team: string | null;
    detectedAt: string;
    recoveredAt: string;
    timeToRecovery: string;
}

export type RepositoryCache = {
    repo: string
    latestPullRequest: number;
    hasUnreferencedBugfix: boolean;
}