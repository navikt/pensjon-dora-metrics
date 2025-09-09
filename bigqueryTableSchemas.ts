import type {TableSchema} from "@google-cloud/bigquery";

export const schemaSuccessfulDeploys: TableSchema = {
    fields: [
        {name: 'pull', type: 'INTEGER', mode: 'REQUIRED'},
        {name: 'repo', type: 'STRING', mode: 'REQUIRED'},
        {name: 'deployedAt', type: 'TIMESTAMP', mode: 'REQUIRED'},
        {name: 'leadTime', type: 'FLOAT', mode: 'REQUIRED'},
    ],
}

export const schemaHotfixDeploys: TableSchema = {
    fields: [
        {name: 'pull', type: 'INTEGER', mode: 'REQUIRED'},
        {name: 'repo', type: 'STRING', mode: 'REQUIRED'},
        {name: 'deployedAt', type: 'TIMESTAMP', mode: 'REQUIRED'},
        {name: 'timeToRecovery', type: 'FLOAT', mode: 'NULLABLE'},
    ],
}

export const BIGQUERY_TABLE_SCHEMAS = [
    {name: 'successful_deploys', schema: schemaSuccessfulDeploys},
    {name: 'hotfix_deploys', schema: schemaHotfixDeploys},
]