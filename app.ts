import fs from 'fs';
import type {GithubData, HotfixDeploy, Repository, SuccessfulDeploy} from "./model.ts";
import {findPullReference} from "./utils.ts";
import {BigQuery, Dataset} from "@google-cloud/bigquery";
import type {TableSchema, RowMetadata} from "@google-cloud/bigquery";
import {BIGQUERY_TABLE_SCHEMAS} from "./bigqueryTableSchemas.ts";



const {dataset} = setupBiqQuery('pensjon_dora_metrics')
const {repositories} = getGithubDataFromFile('github.json')

const {successfulDeploys, hotfixDeploys} = repositories.reduce(
    (acc, repository) => {
        const {successfulDeploys: s, hotfixDeploys: h} = createDoraMetricsFromRepository(repository);
        acc.successfulDeploys.push(...s);
        acc.hotfixDeploys.push(...h);
        return acc;
    },
    {successfulDeploys: [] as SuccessfulDeploy[], hotfixDeploys: [] as HotfixDeploy[]}
);

await pushToBigQuery({successfulDeploys, hotfixDeploys, dataset});


function createDoraMetricsFromRepository(repository: Repository): {
    successfulDeploys: SuccessfulDeploy[],
    hotfixDeploys: HotfixDeploy[]
} {

    const {pulls} = repository;

    const successfulDeploys: SuccessfulDeploy[] = pulls.map(deploy => {
        const lastCommit = deploy.commits.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
        const leadTime = (new Date(deploy.deployment.deployedAt).getTime() - new Date(lastCommit.timestamp).getTime()) / (1000 * 60);
        console.log(`Successful deploy PR #${deploy.pullNumber} lead time: ${leadTime.toFixed(2)} minutes repo: ${repository.name}`);
        return {
            pull: deploy.pullNumber,
            repo: repository.name,
            team: deploy.team,
            deployedAt: deploy.deployment.deployedAt,
            leadTime: leadTime.toFixed(2)
        };
    })

    const hotfixDeploys: HotfixDeploy[] = pulls
        .filter(pr => pr.labels.includes("hotfix") || pr.branch.toLowerCase().startsWith("hotfix"))
        .map(deploy => {
            const hotfixPull = findPullReference(deploy.comments) || findPullReference(deploy.commits.map(c => c.message)) || null;
            if (hotfixPull === null) {

                //if time is less than a day, ignore and give it som time
                const daysSinceDeploy = (new Date().getTime() - new Date(deploy.deployment.deployedAt).getTime()) / (1000 * 60 * 60 * 24);
                if (daysSinceDeploy < 2) {
                    console.log(`Hotfix deploy PR #${deploy.pullNumber} has no referenced PR, but was deployed less than two days ago (${daysSinceDeploy.toFixed(2)} days), ignoring for now`);
                    return null;
                }
                console.log(`Hotfix deploy PR #${deploy.pullNumber} has no referenced PR`);
                return {pull: deploy.pullNumber, timestamp: deploy.deployment.deployedAt, timeToRecovery: null};
            }
            const referencedDeploy = successfulDeploys.find(pr => pr.pull === hotfixPull);
            if (referencedDeploy === undefined) {
                console.log(`Hotfix deploy PR #${deploy.pullNumber} references PR #${hotfixPull} which is not in list of successful deploys.`);
                return {pull: deploy.pullNumber, timestamp: deploy.deployment.deployedAt, timeToRecovery: null};
            }
            const timeToRecovery = (new Date(referencedDeploy.deployedAt).getTime() - new Date(deploy.deployment.deployedAt).getTime()) / (1000 * 60);
            console.log(`Hotfix deploy PR #${deploy.pullNumber} time to recovery: ${timeToRecovery.toFixed(2)} minutes (referenced PR #${hotfixPull}) repo: ${repository.name}`);
            return {
                pull: deploy.pullNumber,
                repo: repository.name,
                team: deploy.team,
                deployedAt: deploy.deployment.deployedAt,
                timeToRecovery: timeToRecovery.toFixed(2)
            };
        }).filter(deploy => deploy !== null) as HotfixDeploy[];
    return {
        successfulDeploys,
        hotfixDeploys,
    }
}


async function pushToBigQuery({successfulDeploys, hotfixDeploys, dataset}: {
    successfulDeploys: SuccessfulDeploy[],
    hotfixDeploys: HotfixDeploy[],
    dataset: Dataset
}) {

    //filter out entries that are already in the table
    const successfulDeploysTable = dataset.table('successful_deploys');
    const [successfulDeploysRows] = await successfulDeploysTable.getRows();
    const successfulDeploysToInsert = successfulDeploys.filter(sd => !successfulDeploysRows.some(row => row.pull === sd.pull));
    console.log(`Filtered successful deploys to insert: ${successfulDeploysToInsert.length} out of ${successfulDeploys.length}`);
    const hotfixDeploysTable = dataset.table('hotfix_deploys');
    const [hotfixDeploysRows] = await hotfixDeploysTable.getRows();
    const hotfixDeploysToInsert = hotfixDeploys.filter(hd => !hotfixDeploysRows.some(row => row.pull === hd.pull));
    console.log(`Filtered hotfix deploys to insert: ${hotfixDeploysToInsert.length} out of ${hotfixDeploys.length}`);



    //insert only new rows
    await insertData('successful_deploys', successfulDeploysToInsert, dataset);
    await insertData('hotfix_deploys', hotfixDeploysToInsert, dataset);

}

async function ensureTable(tableName: string, schema: TableSchema, dataset: Dataset) {
    const table = dataset.table(tableName);
    const [exists] = await table.exists();
    if (!exists) {
        await table.create({schema});
        console.log(`Table ${tableName} created.`);
    } else {
        console.log(`Table ${tableName} already exists.`);
    }
}


async function insertData(tableName: string, rows: RowMetadata[], dataset: Dataset) {
    if (rows.length === 0) {
        console.log(`No new data to insert into ${tableName}.`);
        return;
    }
    const table = dataset.table(tableName);
    try {
        await table.insert(rows);
        console.log(`Inserted ${rows.length} rows into ${tableName}.`);
    } catch (error) {
        console.error(`Error inserting data into ${tableName}:`, error);
        //log errors for each row BigQuery
        if (error instanceof Array) {
            error.forEach(err => {
                console.error(`Error for row ${JSON.stringify(err.row)}: ${err.message}`);
            });
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
