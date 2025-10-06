import fs from 'fs';
import type {GithubData, HotfixDeploy, Repository, SuccessfulDeploy} from "./model.ts";
import {BigQuery, Dataset} from "@google-cloud/bigquery";
import type {TableSchema, RowMetadata} from "@google-cloud/bigquery";
import {BIGQUERY_TABLE_SCHEMAS} from "./bigqueryTableSchemas.ts";
import {logger} from "./logger.ts";
import {getTexasClientCredentialsToken} from "./texasClient.ts";

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

await sleep(25000) //Wait for secrets to be available
const token = await getTexasClientCredentialsToken("api://prod-fss.pesys-felles.jira-proxy/.default");
if (!token || !token.access_token) {
    throw new Error("Failed to get token from Texas");
}

//Selftest for jira-proxy
const test = await fetch("https://jira-proxy.prod-fss-pub.nais.io/api/issue/PL-8080", {
    headers: {
        Authorization: `Bearer ${token}`
    }
})

if(!test.ok) {
    console.log("JiraProxy isAlive??",test.status,test.statusText)
    throw new Error("JiraProxy is not reachable")
}

const text = await test.text()

console.log("JiraProxy isAlive??",text)

const {dataset} = setupBiqQuery('pensjon_dora_metrics')
const {repositories} = getGithubDataFromFile('github.json')

const {successfulDeploys, hotfixDeploys} = await processRepositories(repositories)
await pushToBigQuery({successfulDeploys, hotfixDeploys, dataset});

async function processRepositories(repositories: Repository[]): Promise<{
    successfulDeploys: SuccessfulDeploy[],
    hotfixDeploys: HotfixDeploy[]
}> {
    const successfulDeploys: SuccessfulDeploy[] = [];
    const hotfixDeploys: HotfixDeploy[] = [];
    for (const repository of repositories) {
        const {successfulDeploys: s, hotfixDeploys: h} = await createDoraMetricsFromRepository(repository, dataset);
        successfulDeploys.push(...s);
        hotfixDeploys.push(...h);
    }
    return {successfulDeploys, hotfixDeploys};
}

export async function createDoraMetricsFromRepository(repository: Repository, dataset: Dataset): Promise<{
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
                .filter(pr => pr.labels.includes("hotfix") || pr.branch.toLowerCase().startsWith("hotfix"))
                .map(async deploy => {
                    if (deploy.referencedPull === null) {

                        //if time is less than a day, ignore and give it som time
                        const daysSinceDeploy = (new Date().getTime() - new Date(deploy.deployment.deployedAt).getTime()) / (1000 * 60 * 60 * 24);
                        if (daysSinceDeploy < 2) {
                            logger.info(`Hotfix deploy PR #${deploy.pullNumber} has no referenced PR, but was deployed less than two days ago (${daysSinceDeploy.toFixed(2)} days), ignoring for now`);
                            return null;
                        }
                        logger.warn(`Hotfix deploy PR #${deploy.pullNumber} has no referenced PR`);
                        return {
                            pull: deploy.pullNumber,
                            referencedPull: deploy.referencedPull,
                            repo: repository.name,
                            team: deploy.team,
                            deployedAt: deploy.deployment.deployedAt,
                            timeToRecovery: null
                        };
                    }
                    const referencedDeploy = successfulDeploys.find(pr => pr.pull === deploy.referencedPull) || await getExistingSuccesfulDeployFromBigQuery(dataset, deploy.referencedPull, repository.name);
                    if (referencedDeploy === undefined) {
                        logger.warn(`Hotfix deploy PR #${deploy.pullNumber} references PR #${deploy.referencedPull} which is not in list of successful deploys.`);
                        return {
                            pull: deploy.pullNumber,
                            referencedPull: deploy.referencedPull,
                            repo: repository.name,
                            team: deploy.team,
                            deployedAt: deploy.deployment.deployedAt,
                            timeToRecovery: null
                        };
                    }
                    const timeToRecovery = (new Date(deploy.deployment.deployedAt).getTime() - new Date(referencedDeploy.deployedAt).getTime()) / (1000 * 60);
                    logger.info(`Deploy dates: referenced PR #${referencedDeploy.pull} deployed at ${referencedDeploy.deployedAt}, hotfix PR #${deploy.pullNumber} deployed at ${deploy.deployment.deployedAt}`);
                    logger.info(`Hotfix deploy PR #${deploy.pullNumber} time to recovery: ${timeToRecovery.toFixed(2)} minutes (referenced PR #${deploy.referencedPull}) repo: ${repository.name}`);
                    return {
                        pull: deploy.pullNumber,
                        referencedPull: deploy.referencedPull,
                        repo: repository.name,
                        team: deploy.team,
                        deployedAt: deploy.deployment.deployedAt,
                        timeToRecovery: timeToRecovery.toFixed(2)
                    };
                })
        )).filter(deploy => deploy !== null) as HotfixDeploy[];
    return {
        successfulDeploys,
        hotfixDeploys,
    }
}

export async function getExistingSuccesfulDeployFromBigQuery(dataset: Dataset, pull: number, repo: string): Promise<SuccessfulDeploy | null> {
    const table = dataset.table('successful_deploys');
    const tableRef = `\`${dataset.id}.${table.id}\``;
    const query = `SELECT *
                   FROM ${tableRef}
                   WHERE pull = @pull
                     AND repo = @repo LIMIT 1`;
    const options = {
        query: query,
        params: {pull, repo},
    };

    try {

        const [job] = await dataset.bigQuery.createQueryJob(options);
        const [rows] = await job.getQueryResults();
        logger.info(rows)
        if (rows.length > 0) {
            const row = rows[0];
            return {
                pull: row.pull,
                repo: row.repo,
                team: row.team,
                deployedAt: row.deployedAt.value,
                leadTime: row.leadTime,
            };
        }

    } catch (error) {
        if (error?.errors[0]?.errors) {
            logger.error('Error:', error.errors[0].errors);
        } else if (error?.errors[0]?.message) {
            logger.error('Error:', error.errors[0].message);
        } else {
            logger.error('Error:', error);
        }
        throw error;
    }

    logger.warn("No existing successful deploy found in BigQuery for PR #" + pull + " in repo " + repo);
    return undefined;
}


export async function pushToBigQuery({successfulDeploys, hotfixDeploys, dataset}: {
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
