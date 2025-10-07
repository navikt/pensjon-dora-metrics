import fs from 'fs';
import type {GithubData, HotfixDeploy, RecoveredIncident, Repository, SuccessfulDeploy} from "./model.ts";
import type {RowMetadata, TableSchema} from "@google-cloud/bigquery";
import {BigQuery, Dataset} from "@google-cloud/bigquery";
import {BIGQUERY_TABLE_SCHEMAS} from "./bigqueryTableSchemas.ts";
import {logger} from "./logger.ts";
import {getJiraIssue} from "./jiraService.ts";
import {sleep} from "./utils.ts";

await sleep(25000) //Wait for secrets to be available

const {dataset} = setupBiqQuery('pensjon_dora_metrics')
const {repositories} = getGithubDataFromFile('github.json')

const {successfulDeploys, hotfixDeploys} = await processRepositories(repositories)
await insertDeployDataToBigQuery({successfulDeploys, hotfixDeploys, dataset});

const recoveredIncidents = await createRecoveredIncidents(dataset);
await insertData('recovered_incidents', recoveredIncidents, dataset);

async function processRepositories(repositories: Repository[]): Promise<{
    successfulDeploys: SuccessfulDeploy[],
    hotfixDeploys: HotfixDeploy[],
}> {
    const successfulDeploys: SuccessfulDeploy[] = [];
    const hotfixDeploys: HotfixDeploy[] = [];
    for (const repository of repositories) {
        const {
            successfulDeploys: s,
            hotfixDeploys: h,
        } = await createDeployRows(repository);
        successfulDeploys.push(...s);
        hotfixDeploys.push(...h);
    }
    return {successfulDeploys, hotfixDeploys};
}

export async function createDeployRows(repository: Repository): Promise<{
    successfulDeploys: SuccessfulDeploy[];
    hotfixDeploys: HotfixDeploy[];
}> {

    const {pulls} = repository;

    const successfulDeploys: SuccessfulDeploy[] = pulls.map(deploy => {
        const lastCommit = deploy.commits.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
        const leadTime = (new Date(deploy.deployment.deployedAt).getTime() - new Date(lastCommit.timestamp).getTime()) / (1000 * 60);
        logger.info(`Successful deploy PR #${deploy.pullNumber} lead time: ${leadTime.toFixed(2)} minutes repo: ${repository.name}`);
        return {
            pull: deploy.pullNumber,
            repo: repository.name,
            team: deploy.team,
            deployedAt: deploy.deployment.deployedAt,
            leadTime: leadTime.toFixed(2)
        };
    })

    const hotfixDeploys: HotfixDeploy[] =
        (await Promise.all(
            pulls
                .filter(pr => pr.isBugfix)
                .map(async deploy => {

                    const daysSinceDeploy = (new Date().getTime() - new Date(deploy.deployment.deployedAt).getTime()) / (1000 * 60 * 60 * 24);

                    if (deploy.referencedJira === null) {
                        //if time is less than a day, ignore and give it som time
                        if (daysSinceDeploy < 2) {
                            logger.info(`Hotfix deploy PR #${deploy.pullNumber} has no referenced Jira, but was deployed less than two days ago (${daysSinceDeploy.toFixed(2)} days), ignoring for now`);
                            return null;
                        }
                        logger.warn(`Hotfix deploy PR #${deploy.pullNumber} has no referenced Jira`);
                    }

                    return {
                        pull: deploy.pullNumber,
                        referencedPull: deploy.referencedPull,
                        referencedJira: deploy.referencedJira,
                        repo: repository.name,
                        team: deploy.team,
                        deployedAt: deploy.deployment.deployedAt,
                    };
                })
        )).filter(deploy => deploy !== null) as HotfixDeploy[];

    return {
        successfulDeploys,
        hotfixDeploys,
    }
}



async function createRecoveredIncidentFromHotfixDeploy(hotfixDeploy: HotfixDeploy): Promise<RecoveredIncident | null> {
    if (hotfixDeploy.referencedJira === null) {
        logger.warn(`Cannot create RecoveredIncident from HotfixDeploy PR #${hotfixDeploy.pull} because referencedJira is null`);
        return null;
    }
    const jiraIssue = await getJiraIssue(hotfixDeploy.referencedJira)

    if (jiraIssue.fields.resolved === null) {
        // Issue is not resolved, cannot be a recovered incident
        return null;
    }

    const detectedAt = new Date(jiraIssue.fields.created);
    const recoveredAt = new Date(jiraIssue.fields.resolved);
    const timeToRecovery = (recoveredAt.getTime() - detectedAt.getTime()) / (1000 * 60); //in minutes

    logger.info(`Recovered incident Jira ${hotfixDeploy.referencedJira} time to recovery: ${timeToRecovery.toFixed(2)} minutes repo: ${hotfixDeploy.repo}`);

    return {
        jira: hotfixDeploy.referencedJira,
        repo: hotfixDeploy.repo,
        team: hotfixDeploy.team,
        detectedAt: detectedAt.toISOString(),
        recoveredAt: recoveredAt.toISOString(),
        timeToRecovery: timeToRecovery.toFixed(2)
    };

}

async function createRecoveredIncidents(dataset: Dataset): Promise<RecoveredIncident[]> {
    const uniqueHotfixDeploys = await getHotfixDeploysNotReferencedInRecoveredIncidents( dataset)
    const recoveredIncidents: RecoveredIncident[] = [];
    for (const hotfixDeploy of uniqueHotfixDeploys) {
        const recoveredIncident = await createRecoveredIncidentFromHotfixDeploy(hotfixDeploy);
        if (recoveredIncident !== null) {
            recoveredIncidents.push(recoveredIncident);
        }
    }
    return recoveredIncidents;
}

async function getHotfixDeploysNotReferencedInRecoveredIncidents(dataset: Dataset): Promise<HotfixDeploy[]> {
    const query = `
        SELECT hd.pull, hd.repo
        FROM \`${dataset.id}.hotfix_deploys\` hd
        LEFT JOIN \`${dataset.id}.recovered_incidents\` ri ON hd.referencedJira = ri.jira
        WHERE ri.jira IS NULL AND hd.referencedJira IS NOT NULL
    `;
    const [job] = await dataset.bigQuery.createQueryJob({query});
    const [rows] = await job.getQueryResults();
    return rows.map((r) => ({
        pull: r.pull,
        referencedPull: r.referencedPull,
        referencedJira: r.referencedJira,
        team: r.team,
        repo: r.repo,
        deployedAt: r.deployedAt.time,
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

    await insertData('successful_deploys', successfulDeploysToInsert, dataset);
    await insertData('hotfix_deploys', hotfixDeploysToInsert, dataset);

}


async function ensureTable(tableName: string, schema: TableSchema, dataset: Dataset) {
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


async function insertData(tableName: string, rows: RowMetadata[], dataset: Dataset) {
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

function setupBiqQuery(datasetKey: string): { bigqueryClient: BigQuery, dataset: Dataset } {
    const bigqueryClient = new BigQuery();
    const dataset = bigqueryClient.dataset(datasetKey);

    BIGQUERY_TABLE_SCHEMAS.forEach(async ({name, schema}) => {
        await ensureTable(name, schema, dataset);
    })

    return {bigqueryClient, dataset};
}

function getGithubDataFromFile(filePath: string): GithubData {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data) as GithubData;
}
