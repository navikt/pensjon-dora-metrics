import type {HotfixDeploy, RecoveredIncident, Repository, SuccessfulDeploy} from "./model.ts";
import {logger} from "./logger.ts";
import {getJiraIssue} from "./jiraService.ts";
import {Dataset} from "@google-cloud/bigquery";
import {getHotfixDeploysNotReferencedInRecoveredIncidents} from "./bigqueryUtils.ts";

export async function processRepositories(repositories: Repository[]): Promise<{
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


export async function createRecoveredIncidentFromHotfixDeploy(hotfixDeploy: HotfixDeploy): Promise<RecoveredIncident | null> {
    if (hotfixDeploy.referencedJira === null) {
        logger.warn(`Cannot create RecoveredIncident from HotfixDeploy PR #${hotfixDeploy.pull} because referencedJira is null`);
        return null;
    }
    const jiraIssue = await getJiraIssue(hotfixDeploy.referencedJira)

    if (jiraIssue.fields.resolutiondate === null) {
        logger.info(`Jira issue ${hotfixDeploy.referencedJira} is not resolved, cannot be a recovered incident`);
        // Issue is not resolved, cannot be a recovered incident
        return null;
    }

    const detectedAt = new Date(jiraIssue.fields.created);
    const recoveredAt = new Date(jiraIssue.fields.resolutiondate);
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

export async function createRecoveredIncidents(dataset: Dataset): Promise<RecoveredIncident[]> {
    const uniqueHotfixDeploys = await getHotfixDeploysNotReferencedInRecoveredIncidents(dataset)
    const recoveredIncidents: RecoveredIncident[] = [];
    for (const hotfixDeploy of uniqueHotfixDeploys) {
        const recoveredIncident = await createRecoveredIncidentFromHotfixDeploy(hotfixDeploy);
        if (recoveredIncident !== null) {
            recoveredIncidents.push(recoveredIncident);
        }
    }
    return recoveredIncidents;
}