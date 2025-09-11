import fs from 'fs';
import type {GithubData, HotfixDeploy, Repository, SuccessfulDeploy} from "./model.ts";
import {BigQuery, Dataset} from "@google-cloud/bigquery";
import type {TableSchema, RowMetadata} from "@google-cloud/bigquery";
import {BIGQUERY_TABLE_SCHEMAS} from "./bigqueryTableSchemas.ts";
import {logger} from "./logger.ts";

//Bigquery project id
const {dataset} = setupBiqQuery('pensjon_dora_metrics')
const {repositories} = getGithubDataFromFile('github.json')

const {successfulDeploys, hotfixDeploys} = await processRepositories(repositories)
await pushToBigQuery({successfulDeploys, hotfixDeploys, dataset});

async function processRepositories(repositories: Repository[]): Promise<{successfulDeploys: SuccessfulDeploy[], hotfixDeploys: HotfixDeploy[]}> {
    const successfulDeploys: SuccessfulDeploy[] = [];
    const hotfixDeploys: HotfixDeploy[] = [];
    for (const repository of repositories) {
        const {successfulDeploys: s, hotfixDeploys: h} = await createDoraMetricsFromRepository(repository, dataset);
        successfulDeploys.push(...s);
        hotfixDeploys.push(...h);
    }
    return {successfulDeploys, hotfixDeploys};
}

async function createDoraMetricsFromRepository(repository: Repository, dataset: Dataset): Promise<{
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

async function getExistingSuccesfulDeployFromBigQuery(dataset: Dataset, pull: number, repo: string): Promise<SuccessfulDeploy | null> {
    const table = dataset.table('successful_deploys');
    const gcpTeamProjectId = 'pesys-felles-prod-2e54';
    const tableRef = `\`${gcpTeamProjectId}.${dataset.id}.${table.id}\``;
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
    // Wait for the query to finish
    const [rows] = await job.getQueryResults();

    // If we found a row, return it and map to SuccessfulDeploy
    if (rows.length > 0) {
        const row = rows[0];
        logger.info("row: ",JSON.stringify(row))
        return {
            pull: row.pull,
            repo: row.repo,
            team: row.team,
            deployedAt: row.deployedAt,
            leadTime: row.leadTime,
        };
    }

  } catch (error) {
      logger.error("Error querying BigQuery for existing successful deploy: " + error);
      return null;
  }

    logger.warn("No existing successful deploy found in BigQuery for PR #" + pull + " in repo " + repo);
    return undefined;
}


async function pushToBigQuery({successfulDeploys, hotfixDeploys, dataset}: {
    successfulDeploys: SuccessfulDeploy[],
    hotfixDeploys: HotfixDeploy[],
    dataset: Dataset
}) {

    //filter out entries that are already in the table
    const successfulDeploysTable = dataset.table('successful_deploys');
    const [successfulDeploysRows] = await successfulDeploysTable.getRows();
    const successfulDeploysToInsert = successfulDeploys.filter(sd => !successfulDeploysRows.some(row => row.pull === sd.pull && row.repo === sd.repo));
    logger.info(`Filtered successful deploys to insert: ${successfulDeploysToInsert.length} out of ${successfulDeploys.length}`);
    const hotfixDeploysTable = dataset.table('hotfix_deploys');
    const [hotfixDeploysRows] = await hotfixDeploysTable.getRows();
    const hotfixDeploysToInsert = hotfixDeploys.filter(hd => !hotfixDeploysRows.some(row => row.pull === hd.pull && row.repo === hd.repo));
    logger.info(`Filtered hotfix deploys to insert: ${hotfixDeploysToInsert.length} out of ${hotfixDeploys.length}`);


    //insert only new rows
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
            const failedDetails = error.errors.map((e: any) => (e));
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
