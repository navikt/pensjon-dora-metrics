import type {TableSchema} from "@google-cloud/bigquery";

export type GithubData = {
    repositories: Repository[];
}

export type Repository = {
    name: string;
    pulls: PullRequest[];
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
    repo: string;
    deployedAt: string;
    leadTime: string;
}

export type HotfixDeploy = {
    pull: number;
    repo: string;
    timestamp: string;
    timeToRecovery: string | null;
}
