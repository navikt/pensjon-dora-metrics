import {BigQuery, Dataset, type RowMetadata, type TableSchema} from "@google-cloud/bigquery";
import type {HotfixDeploy, SuccessfulDeploy} from "./model.ts";
import {logger} from "./logger.ts";
import {BIGQUERY_TABLE_SCHEMAS} from "./bigqueryTableSchemas.ts";

export async function getHotfixDeploysNotReferencedInRecoveredIncidents(dataset: Dataset): Promise<HotfixDeploy[]> {
    const query = `
        SELECT hd.pull, hd.repo, hd.team, hd.deployedAt, hd.referencedPull, hd.referencedJira
        FROM \`${dataset.id}.hotfix_deploys\` hd
                 LEFT JOIN \`${dataset.id}.recovered_incidents\` ri ON hd.referencedJira = ri.jira
        WHERE ri.jira IS NULL
          AND hd.referencedJira IS NOT NULL
    `;
    const [job] = await dataset.bigQuery.createQueryJob({query});
    const [rows] = await job.getQueryResults();
    return rows.map((r) => ({
        pull: r.pull,
        referencedPull: r.referencedPull,
        referencedJira: r.referencedJira,
        team: r.team,
        repo: r.repo,
        deployedAt: r.deployedAt,
    } as HotfixDeploy));
}


export async function insertDeployDataToBigQuery({successfulDeploys, hotfixDeploys, dataset}: {
    successfulDeploys: SuccessfulDeploy[],
    hotfixDeploys: HotfixDeploy[],
    dataset: Dataset
}) {

    const successfulDeploysToInsert = await filterNewRows('successful_deploys', successfulDeploys, dataset);
    logger.info(`Filtered successful deploys to insert: ${successfulDeploysToInsert.length} out of ${successfulDeploys.length}`);

    const hotfixDeploysToInsert = await filterNewRows('hotfix_deploys', hotfixDeploys, dataset);
    logger.info(`Filtered hotfix deploys to insert: ${hotfixDeploysToInsert.length} out of ${hotfixDeploys.length}`);

    await insertDataIntoBigQueryTable('successful_deploys', successfulDeploysToInsert, dataset);
    await insertDataIntoBigQueryTable('hotfix_deploys', hotfixDeploysToInsert, dataset);

}


export async function ensureTable(tableName: string, schema: TableSchema, dataset: Dataset) {
    const table = dataset.table(tableName);
    const [exists] = await table.exists();
    if (!exists) {
        await table.create({schema});
        logger.info(`Table ${tableName} created.`);
    } else {
        logger.info(`Table ${tableName} already exists.`);
    }
}


export async function filterNewRows<T extends SuccessfulDeploy | HotfixDeploy>(tableName: string, rows: T[], dataset: Dataset): Promise<T[]> {
    if (rows.length === 0) return [];

    const tableRef = `\`${dataset.id}.${tableName}\``;

    const keys = rows.map(r => ({pull: r.pull, repo: r.repo}));
    const query = `SELECT t.pull, t.repo
                   FROM ${tableRef} t
                            JOIN UNNEST(@keys) k ON t.pull = k.pull AND t.repo = k.repo`;

    const [job] = await dataset.bigQuery.createQueryJob({query, params: {keys}});
    const [existing] = await job.getQueryResults();
    const existingSet = new Set(existing.map((r: { pull: number; repo: string }) => `${r.pull}::${r.repo}`));

    return rows.filter(r => !existingSet.has(`${r.pull}::${r.repo}`));
}


export async function insertDataIntoBigQueryTable(tableName: string, rows: RowMetadata[], dataset: Dataset) {
    if (rows.length === 0) {
        logger.info(`No new data to insert into ${tableName}.`);
        return;
    }
    const table = dataset.table(tableName);
    try {
        await table.insert(rows);
        logger.info(`Inserted ${rows.length} rows into ${tableName}.`);
    } catch (error) {
        if (error.name === 'PartialFailureError' && Array.isArray(error.errors)) {
            logger.error(`Partial failure inserting into ${tableName}. Successful rows may exist.`);
            const failedDetails = error.errors.map((e: Partial<RowMetadata>) => (e));
            logger.error(`Failed row details: ${JSON.stringify(failedDetails, null, 2)}`);
            logger.error(JSON.stringify(error))
        } else {
            logger.error(`Error inserting into ${tableName}: ${error.message}`);
            logger.error(JSON.stringify(error))
        }
    }
}

export function setupBiqQuery(datasetKey: string): { bigqueryClient: BigQuery, dataset: Dataset } {
    const bigqueryClient = new BigQuery();
    const dataset = bigqueryClient.dataset(datasetKey);

    BIGQUERY_TABLE_SCHEMAS.forEach(async ({name, schema}) => {
        await ensureTable(name, schema, dataset);
    })

    return {bigqueryClient, dataset};
}
