import {sleep} from "./utils.ts";
import {getGithubData} from "./githubScraper.ts";
import {insertDataIntoBigQueryTable, insertDeployDataToBigQuery, setupBiqQuery} from "./bigqueryUtils.ts";
import {createRecoveredIncidents, processRepositories} from "./doraMetricsProcessor.ts";
import {REPOSITORIES_TO_FETCH} from "./repositoriesToFetch.ts";

await sleep(25000) //Wait for secrets to be available

const {dataset} = setupBiqQuery('pensjon_dora_metrics')

const {repositories} = await getGithubData(REPOSITORIES_TO_FETCH, dataset)
const {successfulDeploys, hotfixDeploys} = await processRepositories(repositories)
await insertDeployDataToBigQuery({successfulDeploys, hotfixDeploys, dataset});

const recoveredIncidents = await createRecoveredIncidents(dataset);
await insertDataIntoBigQueryTable('recovered_incidents', recoveredIncidents, dataset);
