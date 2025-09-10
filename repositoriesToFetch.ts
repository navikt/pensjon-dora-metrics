import type {RepostioryToFetch} from "./model.ts";

export const owner = 'navikt';

export const REPOSITORIES_TO_FETCH: RepostioryToFetch[] = [
    {name: 'pensjon-pen', workflow: 'Build and deploy main', deployJob: 'Deploy pen to production'},
    {name: 'pensjon-psak', workflow: 'Build and deploy main', deployJob: 'Deploy prod'},
]
