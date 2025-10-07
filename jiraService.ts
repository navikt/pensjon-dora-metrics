import {getTexasClientCredentialsToken} from "./texasClient.ts";


const JIRA_URL = 'https://jira-proxy.prod-fss-pub.nais.io/api';
const SCOPE = "api://prod-fss.pesys-felles.jira-proxy/.default";


export async function getJiraIssue(issueKey: string) {

    const token = await getTexasClientCredentialsToken(SCOPE);
    if (!token || !token.access_token) {
        throw new Error("Failed to get token from Texas");
    }

    console.log("Fetching issue from Jira: ", issueKey);
    const response = await fetch(`${JIRA_URL}/issue/${issueKey}`, {
        headers: {
            Authorization: `Bearer ${token.access_token}`
        }
    })

    if(!response.ok) {
        console.log("Error: ",response.status,response.statusText)
        throw new Error("JiraProxy is not reachable")
    }

    return await response.json() as IssueDetails;
}

type IssueDetails = {
    id: string;
    key: string;
    fields: {
        summary: string;
        status: {
            name: string;
        };
        assignee: {
            displayName: string;
            emailAddress: string;
        } | null;
        reporter: {
            displayName: string;
            emailAddress: string;
        };
        created: string;
        updated: string;
        resolved: string | null;
    }
}