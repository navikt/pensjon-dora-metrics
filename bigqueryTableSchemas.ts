import type {TableSchema} from "@google-cloud/bigquery";

export const schemaSuccessfulDeploys: TableSchema = {
    fields: [
        {name: 'pull', type: 'INTEGER', mode: 'REQUIRED'},
        {name: 'repo', type: 'STRING', mode: 'REQUIRED'},
        {name: 'team', type: 'STRING', mode: 'NULLABLE'},
        {name: 'deployedAt', type: 'TIMESTAMP', mode: 'REQUIRED'},
        {name: 'leadTime', type: 'FLOAT', mode: 'REQUIRED'},
    ],
}

export const schemaHotfixDeploys: TableSchema = {
    fields: [
        {name: 'pull', type: 'INTEGER', mode: 'REQUIRED'},
        {name: 'referencedPull', type: 'INTEGER', mode: 'NULLABLE'},
        {name: 'referencedJira', type: 'STRING', mode: 'NULLABLE'},
        {name: 'repo', type: 'STRING', mode: 'REQUIRED'},
        {name: 'team', type: 'STRING', mode: 'NULLABLE'},
        {name: 'deployedAt', type: 'TIMESTAMP', mode: 'REQUIRED'},
        {name: 'timeToRecovery', type: 'FLOAT', mode: 'NULLABLE'},
    ],
}

export const schemaRecoveredIncidents: TableSchema = {
    fields: [
        {name: 'jira', type: 'STRING', mode: 'REQUIRED'},
        {name: 'repo', type: 'STRING', mode: 'REQUIRED'},
        {name: 'team', type: 'STRING', mode: 'NULLABLE'},
        {name: 'detectedAt', type: 'TIMESTAMP', mode: 'REQUIRED'},
        {name: 'recoveredAt', type: 'TIMESTAMP', mode: 'REQUIRED'},
        {name: 'timeToRecovery', type: 'FLOAT', mode: 'REQUIRED'},
    ],
}

export const schemaCachedRepoState: TableSchema = {
    fields: [
        {name: 'repo', type: 'STRING', mode: 'REQUIRED'},
        {name: 'latestPullRequest' , type: 'INTEGER', mode: 'REQUIRED'},
        {name: 'hasUnreferencedBugfixes', type: 'BOOLEAN', mode: 'REQUIRED'},
    ],
}

export const BIGQUERY_TABLE_SCHEMAS = [
    {name: 'successful_deploys', schema: schemaSuccessfulDeploys},
    {name: 'hotfix_deploys', schema: schemaHotfixDeploys},
    {name: 'recovered_incidents', schema: schemaRecoveredIncidents},
    {name: 'cached_repo_state', schema: schemaCachedRepoState},
]