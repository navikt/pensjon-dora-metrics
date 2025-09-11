import type {RepostioryToFetch} from "./model.ts";

export const owner = 'navikt';


/**
 * List of repositories to create DORA-metrics from.
 * Each repository must have a name, the exact name of the workflow to look for,
 * and the exact name of the job within the workflow that represents a deploy to production.
 */

export const REPOSITORIES_TO_FETCH: RepostioryToFetch[] = [
    {name: 'pensjon-pen', workflow: 'Build and deploy main', job: 'Deploy pen to production'},
    {name: 'pensjon-psak', workflow: 'Build and deploy main', job: 'Deploy prod'},
]
