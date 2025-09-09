import fs from 'fs';
import type {GithubData, HotfixDeploy, SuccessfulDeploy} from "./model.ts";
import {findPullReference} from "./utils.ts";
import {BigQuery} from "@google-cloud/bigquery";
import type {TableSchema, RowMetadata} from "@google-cloud/bigquery";

const githubData = JSON.parse(fs.readFileSync('github.json', 'utf8')) as GithubData;

const {pullRequests} = githubData;

const successfulDeploys: SuccessfulDeploy[] = pullRequests.map(deploy => {
    const lastCommit = deploy.commits.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
    const leadTime = (new Date(deploy.deployment.deployedAt).getTime() - new Date(lastCommit.timestamp).getTime()) / (1000 * 60);
    console.log(`Successful deploy PR #${deploy.pullNumber} lead time: ${leadTime.toFixed(2)} minutes`);
    return {pull: deploy.pullNumber, deployedAt: deploy.deployment.deployedAt, leadTime: leadTime.toFixed(2)};
})

const hotfixDeploys: HotfixDeploy[] = pullRequests
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
        console.log(`Hotfix deploy PR #${deploy.pullNumber} time to recovery: ${timeToRecovery.toFixed(2)} minutes (referenced PR #${hotfixPull})`);
        return {
            pull: deploy.pullNumber,
            deployedAt: deploy.deployment.deployedAt,
            timeToRecovery: timeToRecovery.toFixed(2)
        };
    }).filter(deploy => deploy !== null) as HotfixDeploy[];

const bigqueryClient = new BigQuery();
const dataset = bigqueryClient.dataset('pensjon_dora_metrics');

const schemaSuccessfulDeploys: TableSchema = {
    fields: [
        {name: 'pull', type: 'INTEGER', mode: 'REQUIRED'},
        {name: 'deployedAt', type: 'TIMESTAMP', mode: 'REQUIRED'},
        {name: 'leadTime', type: 'FLOAT', mode: 'REQUIRED'},
    ],
}

const schemaHotfixDeploys: TableSchema = {
    fields: [
        {name: 'pull', type: 'INTEGER', mode: 'REQUIRED'},
        {name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED'},
        {name: 'timeToRecovery', type: 'FLOAT', mode: 'NULLABLE'},
    ],
}

// Ensure tables exist
async function ensureTable(tableName: string, schema: TableSchema) {
    const table = dataset.table(tableName);
    const [exists] = await table.exists();
    if (!exists) {
        await table.create({schema});
        console.log(`Table ${tableName} created.`);
    } else {
        console.log(`Table ${tableName} already exists.`);
    }
}

await ensureTable('successful_deploys', schemaSuccessfulDeploys);
await ensureTable('hotfix_deploys', schemaHotfixDeploys);

// Insert data into BigQuery
async function insertData(tableName: string, rows: RowMetadata[]) {
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
    }
}

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
await insertData('successful_deploys', successfulDeploysToInsert);
await insertData('hotfix_deploys', hotfixDeploysToInsert);



