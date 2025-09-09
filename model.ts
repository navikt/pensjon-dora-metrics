
export type GithubData = {
    pullRequests: PullRequest[];
}

export type PullRequest = {
    pullNumber: number;
    branch: string;
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
    deployedAt: string;
    leadTime: string;
}

export type HotfixDeploy = {
    pull: number;
    timestamp: string;
    timeToRecovery: string | null;
}
